const express = require("express");
const { auth } = require("express-openid-connect");
const { DBSQLClient } = require("@databricks/sql");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));

// Auth0 login configuration
app.use(
  auth({
    authRequired: true,
    auth0Logout: true,
    secret: process.env.SECRET,
    baseURL: process.env.BASE_URL,
    clientID: process.env.CLIENT_ID,
    issuerBaseURL: process.env.ISSUER_BASE_URL,
  }),
);

const T = "workspace.wms";

// ---------- Role handling (Global & Unified) ----------
const MANAGERS = (process.env.MANAGER_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Apply role check globally across ALL requests (pages and API routes)
app.use((req, res, next) => {
  const user = req.oidc.user || {};
  const email = (user.email || "").toLowerCase();
  req.role = MANAGERS.includes(email) ? "manager" : "worker";
  req.employee = email || user.name || "unknown";
  next();
});

const managerOnly = (req, res, next) =>
  req.role === "manager" ? next() : res.status(403).json({ error: "Managers only" });

// Protected HTML page route
app.get("/manager.html", managerOnly, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "html", "manager.html"));
});

// The frontend calls this to learn who is logged in
app.get("/api/me", (req, res) => {
  res.json({ name: req.oidc.user.name || req.employee, email: req.employee, role: req.role });
});

// ---------- Databricks helper (one reused connection) ----------
let client = null;
let session = null;

async function getSession() {
  if (session) return session;
  client = new DBSQLClient();
  await client.connect({
    host: process.env.DATABRICKS_HOST,
    path: process.env.DATABRICKS_HTTP_PATH,
    token: process.env.DATABRICKS_TOKEN,
  });
  session = await client.openSession();
  return session;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// True Mutex Lock to guarantee absolute 1-by-1 query serialization across the app
let mutex = Promise.resolve();

function lock(fn) {
  let release;
  const nextMutex = new Promise((resolve) => {
    release = resolve;
  });
  const currentMutex = mutex;
  mutex = nextMutex;

  return currentMutex.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

async function rawQuery(statement, params = {}) {
  try {
    const s = await getSession();
    const op = await s.executeStatement(statement, {
      namedParameters: params,
      runAsync: true,
    });
    const rows = await op.fetchAll();
    await op.close();

    // Give Delta Lake a brief settling pause after any write operation
    if (/^\s*(UPDATE|INSERT|MERGE|DELETE)/i.test(statement)) {
      await sleep(500);
    }
    return rows;
  } catch (err) {
    if (!/CONCURRENT|DELTA_CONCURRENT|ConcurrentAppendException/i.test(err.message || "")) {
      session = null;
      client = null;
    }
    throw err;
  }
}

async function withRetry(statement, params) {
  const maxRetries = 6;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await rawQuery(statement, params);
    } catch (err) {
      const isConflict = /CONCURRENT|DELTA_CONCURRENT|ConcurrentAppendException/i.test(err.message || "");
      if (!isConflict) throw err;

      if (attempt === maxRetries - 1) {
        throw new Error(
          `Transaction failed after ${maxRetries} retries due to concurrent table updates. Please try again.`,
        );
      }

      // Add randomized jitter to prevent thundering herd conflicts
      const jitter = Math.random() * 300;
      const delay = Math.min(400 * Math.pow(2, attempt) + jitter, 6000);
      console.warn(`[Delta Conflict] Attempt ${attempt + 1} failed. Retrying in ${Math.round(delay)}ms...`);
      await sleep(delay);
    }
  }
}

function query(statement, params = {}) {
  return lock(() => withRetry(statement, params));
}

let locCache = null;
async function getLocations() {
  if (!locCache) locCache = await query(`SELECT * FROM ${T}.locations ORDER BY map_row, map_col`);
  return locCache;
}
async function locationExists(code) {
  return (await getLocations()).some((l) => l.location_code === code);
}

// Wrap routes so errors return JSON instead of crashing
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

// ---------- Image validation helper ----------
const validImage = (s) =>
  !s ||
  (typeof s === "string" &&
    s.length < 300000 &&
    (/^data:image\/(jpeg|png|webp);base64,/.test(s) || /^https:\/\//.test(s)));

// ---------- Audit log (append-only: INSERT only) ----------
function logEvent(req, sku, action, fromLoc, toLoc, qty) {
  return query(
    `INSERT INTO ${T}.audit_log
       (event_time, employee_id, role, sku_id, action_type, from_location, to_location, quantity)
     VALUES (current_timestamp(), :emp, :role, :sku, :action,
             NULLIF(:fromLoc, ''), NULLIF(:toLoc, ''), NULLIF(:qty, -1))`,
    {
      emp: req.employee,
      role: req.role,
      sku: sku,
      action: action,
      fromLoc: fromLoc || "",
      toLoc: toLoc || "",
      qty: qty === undefined ? -1 : Number(qty),
    },
  );
}

// ---------- Routes ----------

// Health check: confirms the Databricks connection works
app.get(
  "/api/health",
  wrap(async (req, res) => {
    const rows = await query(`SELECT count(*) AS shelves FROM ${T}.locations`);
    res.json({ ok: true, shelves: Number(rows[0].shelves) });
  }),
);

// All shelves (the frontend builds the CSS grid map from this)
app.get(
  "/api/locations",
  wrap(async (req, res) => {
    res.json(await query(`SELECT * FROM ${T}.locations ORDER BY map_row, map_col`));
  }),
);

// 1. Get all items with combined locations and computed status for the UI
app.get(
  "/api/items",
  wrap(async (req, res) => {
    const items = await query(`SELECT * FROM ${T}.inventory ORDER BY name`);
    const locRows = await query(
      `SELECT il.*, l.label FROM ${T}.inventory_locations il
       JOIN ${T}.locations l ON l.location_code = il.location_code
       WHERE il.qty_stowed > 0`,
    );

    const locMap = new Map();
    locRows.forEach((r) => {
      if (!locMap.has(r.sku_id)) locMap.set(r.sku_id, []);
      locMap.get(r.sku_id).push({
        location_code: r.location_code,
        label: r.label,
        qty_stowed: Number(r.qty_stowed),
      });
    });

    const result = items.map((i) => {
      const locations = locMap.get(i.sku_id) || [];
      const totalStowed = locations.reduce((sum, l) => sum + l.qty_stowed, 0);
      const computedStatus =
        totalStowed > 0 ? "STOWED" : Number(i.qty_in_transit || 0) > 0 ? "IN_TRANSIT" : "DISPATCHED";

      return {
        ...i,
        qty_stowed: totalStowed,
        locations,
        status: computedStatus,
        label: locations.length ? locations.map((l) => l.label).join(", ") : null,
      };
    });

    res.json(result);
  }),
);

// 3. Scan a SHELF barcode: shows shelf details plus items stowed on it
app.get(
  "/api/shelf/:barcode",
  wrap(async (req, res) => {
    const locs = await getLocations();
    const loc = locs.find((l) => l.barcode === req.params.barcode || l.location_code === req.params.barcode);
    if (!loc) return res.status(404).json({ error: "Unknown shelf" });

    const rawItems = await query(
      `SELECT i.sku_id, i.barcode, i.name, i.description, i.image_url, i.qty_in_transit, il.qty_stowed
       FROM ${T}.inventory_locations il
       JOIN ${T}.inventory i ON i.sku_id = il.sku_id
       WHERE il.location_code = :c AND il.qty_stowed > 0`,
      { c: loc.location_code },
    );

    const items = rawItems.map((i) => ({
      ...i,
      status: Number(i.qty_stowed) > 0 ? "STOWED" : "IN_TRANSIT",
    }));

    res.json({ location: loc, items });
  }),
);

// 2. Scan an ITEM barcode: returns SKU details, global counts, and stowed locations
app.get(
  "/api/scan/:barcode",
  wrap(async (req, res) => {
    const items = await query(`SELECT * FROM ${T}.inventory WHERE barcode = :b OR sku_id = :b LIMIT 1`, {
      b: req.params.barcode,
    });
    if (!items.length) return res.status(404).json({ error: "Unknown barcode" });
    const base = items[0];

    const locRows = await query(
      `SELECT il.*, l.label FROM ${T}.inventory_locations il
       JOIN ${T}.locations l ON l.location_code = il.location_code
       WHERE il.sku_id = :sku AND il.qty_stowed > 0`,
      { sku: base.sku_id },
    );

    const locations = locRows.map((r) => ({
      location_code: r.location_code,
      label: r.label,
      qty_stowed: Number(r.qty_stowed),
    }));

    const totalStowed = locations.reduce((sum, l) => sum + l.qty_stowed, 0);

    const responseItem = {
      sku_id: base.sku_id,
      barcode: base.barcode,
      name: base.name,
      description: base.description,
      image_url: base.image_url,
      qty_stowed: totalStowed,
      qty_in_transit: Number(base.qty_in_transit || 0),
      qty_dispatched: Number(base.qty_dispatched || 0),
      locations: locations,
      label: locations.length ? locations[0].label : null,
      location_code: locations.length ? locations[0].location_code : null,
    };

    await logEvent(req, base.sku_id, "SCAN", "", "");
    res.json(responseItem);
  }),
);

// Manager: register a new item (system generates SKU + barcode, or accepts custom barcode)
app.post(
  "/api/items",
  managerOnly,
  wrap(async (req, res) => {
    const { name, description, location, image, barcode } = req.body;
    const quantity = parseInt(req.body.quantity, 10);
    if (!name || !location) return res.status(400).json({ error: "name and location are required" });
    if (!Number.isInteger(quantity) || quantity < 0)
      return res.status(400).json({ error: "Quantity must be 0 or more" });
    if (!validImage(image)) return res.status(400).json({ error: "Invalid image" });
    if (!(await locationExists(location))) return res.status(400).json({ error: "Unknown location" });

    const sku = "SKU-" + Math.floor(100000 + Math.random() * 900000);
    const finalBarcode = (barcode || "").trim() || sku;

    const existing = await query(`SELECT sku_id FROM ${T}.inventory WHERE barcode = :b LIMIT 1`, { b: finalBarcode });
    if (existing.length) {
      return res.status(400).json({ error: "Barcode already exists in the system" });
    }

    await query(
      `INSERT INTO ${T}.inventory
         (sku_id, barcode, name, description, updated_at, updated_by, qty_in_transit, qty_dispatched, image_url)
       VALUES (:sku, :barcode, :itemName, :descr, current_timestamp(), :emp, 0, 0, NULLIF(:img, ''))`,
      {
        sku,
        barcode: finalBarcode,
        itemName: name,
        descr: description || "",
        emp: req.employee,
        img: image || "",
      },
    );

    if (quantity > 0) {
      await query(
        `INSERT INTO ${T}.inventory_locations (sku_id, location_code, qty_stowed, updated_at)
         VALUES (:sku, :loc, :qty, current_timestamp())`,
        { sku, loc: location, qty: quantity },
      );
    }

    await logEvent(req, sku, "REGISTER", "", location, quantity);
    res.json({ sku_id: sku, barcode: finalBarcode, location });
  }),
);

// Manager: set or replace the picture
app.post(
  "/api/items/:barcode/image",
  managerOnly,
  wrap(async (req, res) => {
    const { image } = req.body;
    if (!image || !validImage(image)) return res.status(400).json({ error: "Invalid image" });
    await query(
      `UPDATE ${T}.inventory SET image_url = :img, updated_at = current_timestamp(), updated_by = :emp
       WHERE barcode = :b`,
      { img: image, emp: req.employee, b: req.params.barcode },
    );
    res.json({ ok: true });
  }),
);

// 4. Status update (IN_TRANSIT / STOWED / DISPATCHED)
app.post(
  "/api/items/:barcode/status",
  wrap(async (req, res) => {
    const { status, location } = req.body;
    const n = parseInt(req.body.amount, 10);
    const actions = { STOWED: "STOW", IN_TRANSIT: "RECEIVE", DISPATCHED: "DISPATCH" };

    if (!actions[status]) return res.status(400).json({ error: "Invalid status" });
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "Pick an amount of 1 or more" });

    const items = await query(`SELECT * FROM ${T}.inventory WHERE barcode = :b OR sku_id = :b LIMIT 1`, {
      b: req.params.barcode,
    });
    if (!items.length) return res.status(404).json({ error: "Unknown barcode" });
    const base = items[0];
    const skuId = base.sku_id;

    if (status === "IN_TRANSIT") {
      const newInTransit = Number(base.qty_in_transit || 0) + n;
      await query(
        `UPDATE ${T}.inventory SET qty_in_transit = :t, updated_at = current_timestamp(), updated_by = :emp WHERE sku_id = :sku`,
        { t: newInTransit, emp: req.employee, sku: skuId },
      );
    } else if (status === "STOWED") {
      const currentInTransit = Number(base.qty_in_transit || 0);
      if (n > currentInTransit) {
        return res
          .status(400)
          .json({ error: `Cannot stow ${n} units. Only ${currentInTransit} available in-transit.` });
      }
      if (!location || !(await locationExists(location))) {
        return res.status(400).json({ error: "Valid target location is required for stowing" });
      }

      const newInTransit = currentInTransit - n;
      await query(
        `UPDATE ${T}.inventory SET qty_in_transit = :t, updated_at = current_timestamp(), updated_by = :emp WHERE sku_id = :sku`,
        { t: newInTransit, emp: req.employee, sku: skuId },
      );

      await query(
        `MERGE INTO ${T}.inventory_locations AS target
         USING (SELECT :sku AS sku_id, :loc AS location_code) AS source
         ON target.sku_id = source.sku_id AND target.location_code = source.location_code
         WHEN MATCHED THEN UPDATE SET qty_stowed = qty_stowed + :n, updated_at = current_timestamp()
         WHEN NOT MATCHED THEN INSERT (sku_id, location_code, qty_stowed, updated_at) VALUES (:sku, :loc, :n, current_timestamp())`,
        { sku: skuId, loc: location, n: n },
      );
    } else if (status === "DISPATCHED") {
      if (!location) {
        return res.status(400).json({ error: "Please select a location to dispatch from" });
      }

      const locRows = await query(
        `SELECT qty_stowed FROM ${T}.inventory_locations WHERE sku_id = :sku AND location_code = :loc`,
        { sku: skuId, loc: location },
      );
      const currentStowed = locRows.length ? Number(locRows[0].qty_stowed || 0) : 0;

      if (n > currentStowed) {
        return res.status(400).json({ error: `Only ${currentStowed} units stowed at ${location}` });
      }

      const newStowed = currentStowed - n;
      const newDispatched = Number(base.qty_dispatched || 0) + n;

      await query(
        `UPDATE ${T}.inventory SET qty_dispatched = :disp, updated_at = current_timestamp(), updated_by = :emp WHERE sku_id = :sku`,
        { disp: newDispatched, emp: req.employee, sku: skuId },
      );

      if (newStowed === 0) {
        await query(`DELETE FROM ${T}.inventory_locations WHERE sku_id = :sku AND location_code = :loc`, {
          sku: skuId,
          loc: location,
        });
      } else {
        await query(
          `UPDATE ${T}.inventory_locations SET qty_stowed = :s, updated_at = current_timestamp() WHERE sku_id = :sku AND location_code = :loc`,
          { s: newStowed, sku: skuId, loc: location },
        );
      }
    }

    logEvent(req, skuId, actions[status], location, location, n).catch(() => {});
    res.json({ ok: true });
  }),
);

// Manager: audit history (optional ?sku=SKU-123456)
app.get(
  "/api/audit",
  managerOnly,
  wrap(async (req, res) => {
    const sku = req.query.sku || "";
    const rows = await query(
      `SELECT CAST(a.event_id AS STRING) AS event_id,
            CAST(a.event_time AS STRING) AS event_time,
            a.employee_id, a.role, a.sku_id, i.name AS item_name,
            a.action_type, a.from_location, a.to_location, a.quantity,
            lf.label AS from_label, lt.label AS to_label
     FROM ${T}.audit_log a
     LEFT JOIN ${T}.inventory i ON i.sku_id = a.sku_id
     LEFT JOIN ${T}.locations lf ON lf.location_code = a.from_location
     LEFT JOIN ${T}.locations lt ON lt.location_code = a.to_location
     WHERE (:sku = '' OR a.sku_id = :sku)
     ORDER BY a.event_time DESC
     LIMIT 100`,
      { sku: sku },
    );
    res.json(rows);
  }),
);

// ---------- Static Assets ----------
app.use(express.static(path.join(__dirname, "public")));
app.use("/src", express.static(path.join(__dirname, "public", "src")));
app.use(express.static(path.join(__dirname, "public", "html")));

const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`Running on http://localhost:${port}`));

// Manager: register a new item with optional custom barcode
app.post(
  "/api/items",
  managerOnly,
  wrap(async (req, res) => {
    const { name, description, location, image, barcode } = req.body;
    const quantity = parseInt(req.body.quantity, 10);

    if (!name || !location) return res.status(400).json({ error: "name and location are required" });
    if (!Number.isInteger(quantity) || quantity < 0)
      return res.status(400).json({ error: "Quantity must be 0 or more" });
    if (!validImage(image)) return res.status(400).json({ error: "Invalid image" });
    if (!(await locationExists(location))) return res.status(400).json({ error: "Unknown location" });

    const sku = "SKU-" + Math.floor(100000 + Math.random() * 900000);
    const finalBarcode = (barcode || "").trim() || sku;

    // Check if custom barcode already exists
    const existing = await query(`SELECT sku_id FROM ${T}.inventory WHERE barcode = :b LIMIT 1`, { b: finalBarcode });
    if (existing.length) {
      return res.status(400).json({ error: "Barcode already exists in the system" });
    }

    // 1. Insert master record
    await query(
      `INSERT INTO ${T}.inventory
         (sku_id, barcode, name, description, updated_at, updated_by, qty_in_transit, qty_dispatched, image_url)
       VALUES (:sku, :barcode, :itemName, :descr, current_timestamp(), :emp, 0, 0, NULLIF(:img, ''))`,
      {
        sku,
        barcode: finalBarcode,
        itemName: name,
        descr: description || "",
        emp: req.employee,
        img: image || "",
      },
    );

    // 2. Insert initial stowed quantity if provided
    if (quantity > 0) {
      await query(
        `INSERT INTO ${T}.inventory_locations (sku_id, location_code, qty_stowed, updated_at)
         VALUES (:sku, :loc, :qty, current_timestamp())`,
        { sku, loc: location, qty: quantity },
      );
    }

    await logEvent(req, sku, "REGISTER", "", location, quantity);
    res.json({ sku_id: sku, barcode: finalBarcode, location });
  }),
);

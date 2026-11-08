const express = require("express");
const { auth } = require("express-openid-connect");
const { DBSQLClient } = require("@databricks/sql");

const app = express();
app.use(express.json({ limit: "2mb" }));
const validImage = (s) =>
  !s ||
  (typeof s === "string" &&
    s.length < 300000 &&
    (/^data:image\/(jpeg|png|webp);base64,/.test(s) || /^https:\/\//.test(s)));

// Auth0 login. authRequired: true protects the pages AND the API.
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

async function rawQuery(statement, params = {}) {
  try {
    const s = await getSession();
    const op = await s.executeStatement(statement, {
      namedParameters: params,
      runAsync: true,
    });
    const rows = await op.fetchAll();
    await op.close();
    return rows;
  } catch (err) {
    if (!/CONCURRENT/i.test(err.message || "")) {
      session = null;
      client = null;
    }
    throw err;
  }
}

let writeQueue = Promise.resolve();
const isWrite = (s) => /^\s*(UPDATE|INSERT|MERGE|DELETE)/i.test(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(statement, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rawQuery(statement, params);
    } catch (err) {
      const conflict = /CONCURRENT|DELTA_CONCURRENT/i.test(err.message || "");
      if (!conflict || attempt >= 4) throw err;
      await sleep(150 * (attempt + 1)); // wait a little, then try again
    }
  }
}

function query(statement, params = {}) {
  if (!isWrite(statement)) return withRetry(statement, params); // reads run freely
  const p = writeQueue.then(() => withRetry(statement, params));
  writeQueue = p.catch(() => {}); // one write at a time
  return p;
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

// ---------- Role handling (from the verified Auth0 login) ----------
const MANAGERS = (process.env.MANAGER_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

app.use("/api", (req, res, next) => {
  const user = req.oidc.user || {};
  const email = (user.email || "").toLowerCase();
  req.role = MANAGERS.includes(email) ? "manager" : "worker";
  req.employee = email || user.name || "unknown";
  next();
});

// The frontend calls this to learn who is logged in
app.get("/api/me", (req, res) => {
  res.json({ name: req.oidc.user.name || req.employee, email: req.employee, role: req.role });
});
const managerOnly = (req, res, next) =>
  req.role === "manager" ? next() : res.status(403).json({ error: "Managers only" });
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

// All items, joined with their current shelf
// All items, grouped by SKU with all stowed locations combined
app.get(
  "/api/items",
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT i.*, l.label, l.map_row, l.map_col
       FROM ${T}.inventory i
       LEFT JOIN ${T}.locations l ON l.location_code = i.location_code
       ORDER BY i.name`,
    );

    const itemMap = new Map();
    rows.forEach((r) => {
      if (!itemMap.has(r.sku_id)) {
        itemMap.set(r.sku_id, {
          ...r,
          locations: [],
        });
      }
      const item = itemMap.get(r.sku_id);
      if (r.location_code && Number(r.qty_stowed) > 0) {
        item.locations.push({
          location_code: r.location_code,
          label: r.label,
          qty_stowed: Number(r.qty_stowed),
        });
      }
    });

    res.json(Array.from(itemMap.values()));
  }),
);

// Scan an ITEM barcode: returns SKU details, global counts, and all active locations
app.get(
  "/api/scan/:barcode",
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT i.*, l.label, l.map_row, l.map_col
       FROM ${T}.inventory i
       LEFT JOIN ${T}.locations l ON l.location_code = i.location_code
       WHERE i.barcode = :b OR i.sku_id = :b`,
      { b: req.params.barcode },
    );
    if (!rows.length) return res.status(404).json({ error: "Unknown barcode" });

    const base = rows[0];
    const locations = [];
    let totalStowed = 0;

    rows.forEach((r) => {
      if (r.location_code && Number(r.qty_stowed) > 0) {
        locations.push({
          location_code: r.location_code,
          label: r.label,
          qty_stowed: Number(r.qty_stowed),
        });
        totalStowed += Number(r.qty_stowed);
      }
    });

    const responseItem = {
      sku_id: base.sku_id,
      barcode: base.barcode,
      name: base.name,
      description: base.description,
      image_url: base.image_url,
      status: base.status,
      qty_stowed: totalStowed,
      qty_in_transit: Number(base.qty_in_transit || 0),
      qty_dispatched: Number(base.qty_dispatched || 0),
      locations: locations,
      location_code: base.location_code,
      label: base.label,
    };

    await logEvent(req, base.sku_id, "SCAN", base.location_code, base.location_code);
    res.json(responseItem);
  }),
);

// Scan a SHELF barcode: shows the shelf plus every item on it
app.get(
  "/api/shelf/:barcode",
  wrap(async (req, res) => {
    const locs = await getLocations();
    const loc = locs.find((l) => l.barcode === req.params.barcode || l.location_code === req.params.barcode);
    if (!loc) return res.status(404).json({ error: "Unknown shelf" });
    const items = await query(
      `SELECT sku_id, barcode, name, description, status, quantity, qty_stowed, qty_in_transit, image_url
     FROM ${T}.inventory WHERE location_code = :c AND COALESCE(qty_stowed, 0) > 0`,
      { c: loc.location_code },
    );
    res.json({ location: loc, items });
  }),
);

// Manager: register a new item (system generates SKU + barcode)
app.post(
  "/api/items",
  managerOnly,
  wrap(async (req, res) => {
    const { name, description, location, image } = req.body;
    const quantity = parseInt(req.body.quantity, 10);
    if (!name || !location) return res.status(400).json({ error: "name and location are required" });
    if (!Number.isInteger(quantity) || quantity < 0)
      return res.status(400).json({ error: "Quantity must be 0 or more" });
    if (!validImage(image)) return res.status(400).json({ error: "Invalid image" });
    if (!(await locationExists(location))) return res.status(400).json({ error: "Unknown location" });

    const sku = "SKU-" + Math.floor(100000 + Math.random() * 900000);
    await query(
      `INSERT INTO ${T}.inventory
         (sku_id, barcode, name, description, status, location_code, assigned_location,
          updated_at, updated_by, quantity, qty_stowed, qty_in_transit, qty_dispatched, image_url)
       VALUES (:sku, :sku, :itemName, :descr, 'STOWED', :loc, :loc,
               current_timestamp(), :emp, :qty, :qty, 0, 0, NULLIF(:img, ''))`,
      {
        sku,
        itemName: name,
        descr: description || "",
        loc: location,
        emp: req.employee,
        qty: quantity,
        img: image || "",
      },
    );
    await logEvent(req, sku, "REGISTER", "", location, quantity);
    res.json({ sku_id: sku, barcode: sku, location });
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

// Worker or manager: change status (STOWED / IN_TRANSIT / DISPATCHED)
// Worker or manager: change status (STOWED / IN_TRANSIT / DISPATCHED)
// Scan an ITEM barcode: returns SKU details, global counts, and all active locations
app.get(
  "/api/scan/:barcode",
  wrap(async (req, res) => {
    const match = await query(`SELECT sku_id FROM ${T}.inventory WHERE barcode = :b OR sku_id = :b LIMIT 1`, {
      b: req.params.barcode,
    });
    if (!match.length) return res.status(404).json({ error: "Unknown barcode" });
    const skuId = match.script ? match[0].sku_id : match[0].sku_id;

    // Get base item info and all location rows for this SKU
    const rows = await query(
      `SELECT i.*, l.label, l.map_row, l.map_col
       FROM ${T}.inventory i
       LEFT JOIN ${T}.locations l ON l.location_code = i.location_code
       WHERE i.sku_id = :sku`,
      { sku: skuId },
    );
    if (!rows.length) return res.status(404).json({ error: "Unknown item" });

    const base = rows[0];
    // Aggregate multi-location stowed quantities and total in-transit / dispatched
    const locations = rows
      .filter((r) => r.location_code && Number(r.qty_stowed) > 0)
      .map((r) => ({
        location_code: r.location_code,
        label: r.label,
        qty_stowed: Number(r.qty_stowed),
      }));

    const responseItem = {
      sku_id: base.sku_id,
      barcode: base.barcode,
      name: base.name,
      description: base.description,
      image_url: base.image_url,
      qty_in_transit: Number(base.qty_in_transit || 0),
      qty_dispatched: Number(base.qty_dispatched || 0),
      locations: locations,
    };

    await logEvent(req, base.sku_id, "SCAN", base.location_code, base.location_code);
    res.json(responseItem);
  }),
);

// Worker or manager: change status adhering to new logistics rules
app.post(
  "/api/items/:barcode/status",
  wrap(async (req, res) => {
    const { status, location } = req.body;
    const n = parseInt(req.body.amount, 10);
    const actions = { STOWED: "STOW", IN_TRANSIT: "RECEIVE", DISPATCHED: "DISPATCH" };

    if (!actions[status]) return res.status(400).json({ error: "Invalid status" });
    if (!Number.isInteger(n) || n < 1 || n > 10000)
      return res.status(400).json({ error: "Pick an amount of 1 or more" });

    // Fetch all rows for this SKU
    const rows = await query(`SELECT * FROM ${T}.inventory WHERE barcode = :b OR sku_id = :b`, {
      b: req.params.barcode,
    });
    if (!rows.length) return res.status(404).json({ error: "Unknown barcode" });

    const base = rows[0];
    let globalInTransit = Number(base.qty_in_transit || 0);
    let globalDispatched = Number(base.qty_dispatched || 0);

    if (status === "IN_TRANSIT") {
      // Adding new incoming stock to the warehouse
      globalInTransit += n;
      await query(
        `UPDATE ${T}.inventory SET qty_in_transit = :t, updated_at = current_timestamp(), updated_by = :emp WHERE sku_id = :sku`,
        { t: globalInTransit, emp: req.employee, sku: base.sku_id },
      );
    } else if (status === "STOWED") {
      // Rule 1: Stowing draws from In-Transit (cannot go below 0)
      if (n > globalInTransit) {
        return res.status(400).json({ error: `Cannot stow ${n} units. Only ${globalInTransit} available in-transit.` });
      }
      if (!location || !(await locationExists(location))) {
        return res.status(400).json({ error: "Valid target location is required for stowing" });
      }

      globalInTransit -= n;

      // Check if a row already exists for this SKU at the target location
      const locRow = rows.find((r) => r.location_code === location);
      if (locRow) {
        const newStowed = Number(locRow.qty_stowed || 0) + n;
        await query(
          `UPDATE ${T}.inventory SET qty_stowed = :s, qty_in_transit = :t, updated_at = current_timestamp(), updated_by = :emp WHERE sku_id = :sku AND location_code = :loc`,
          { s: newStowed, t: globalInTransit, emp: req.employee, sku: base.sku_id, loc: location },
        );
      } else {
        // Create new row for this location
        await query(
          `INSERT INTO ${T}.inventory (sku_id, barcode, name, description, status, location_code, assigned_location, qty_stowed, qty_in_transit, qty_dispatched, image_url, updated_at, updated_by)
           VALUES (:sku, :barcode, :name, :desc, 'STOWED', :loc, :loc, :stowed, :t, :disp, :img, current_timestamp(), :emp)`,
          {
            sku: base.sku_id,
            barcode: base.barcode,
            name: base.name,
            desc: base.description || "",
            loc: location,
            stowed: n,
            t: globalInTransit,
            disp: globalDispatched,
            img: base.image_url || "",
            emp: req.employee,
          },
        );
      }
    } else if (status === "DISPATCHED") {
      // Rule 2: Dispatching pulls strictly from STOWED stock at the selected location
      if (!location) {
        return res.status(400).json({ error: "Please select a location to dispatch from" });
      }
      const locRow = rows.find((r) => r.location_code === location);
      const currentStowed = locRow ? Number(locRow.qty_stowed || 0) : 0;

      if (n > currentStowed) {
        return res.status(400).json({ error: `Only ${currentStowed} units stowed at ${location}` });
      }

      const newStowed = currentStowed - n;
      globalDispatched += n;

      await query(
        `UPDATE ${T}.inventory SET qty_stowed = :s, qty_dispatched = :disp, updated_at = current_timestamp(), updated_by = :emp WHERE sku_id = :sku AND location_code = :loc`,
        { s: newStowed, disp: globalDispatched, emp: req.employee, sku: base.sku_id, loc: location },
      );
    }

    logEvent(req, base.sku_id, actions[status], location, location, n).catch(() => {});
    res.json({ ok: true });
  }),
);
// ... rest of response handling

// Manager: reassign an item's home bin
app.patch(
  "/api/items/:barcode/location",
  managerOnly,
  wrap(async (req, res) => {
    const { location } = req.body;
    if (!location) return res.status(400).json({ error: "location is required" });
    if (!(await locationExists(location))) {
      return res.status(400).json({ error: "Unknown location" });
    }
    const rows = await query(`SELECT * FROM ${T}.inventory WHERE barcode = :b`, { b: req.params.barcode });
    if (!rows.length) return res.status(404).json({ error: "Unknown barcode" });
    const item = rows[0];

    await query(
      `UPDATE ${T}.inventory
     SET assigned_location = :loc,
         location_code = CASE WHEN status = 'STOWED' THEN :loc ELSE location_code END,
         updated_at = current_timestamp(), updated_by = :emp
     WHERE barcode = :b`,
      { loc: location, emp: req.employee, b: req.params.barcode },
    );
    await logEvent(req, item.sku_id, "REASSIGN", item.assigned_location, location);
    res.json({ ok: true });
  }),
);

// Manager: audit history (optional ?sku=SKU-123456), with readable shelf names
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

const path = require("path");
app.use(express.static(path.join(__dirname, "public")));
app.use("/src", express.static(path.join(__dirname, "public", "src")));
app.use(express.static(path.join(__dirname, "public", "html")));

const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`Running on http://localhost:${port}`));

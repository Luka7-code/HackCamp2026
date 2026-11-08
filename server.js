const express = require("express");
const { auth } = require("express-openid-connect");
const { DBSQLClient } = require("@databricks/sql");

const app = express();
app.use(express.json());

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

async function query(statement, params = {}) {
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
    session = null; // force a fresh connection next time
    client = null;
    throw err;
  }
}

async function locationExists(code) {
  const rows = await query(`SELECT location_code FROM ${T}.locations WHERE location_code = :c`, { c: code });
  return rows.length > 0;
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
function logEvent(req, sku, action, fromLoc, toLoc) {
  return query(
    `INSERT INTO ${T}.audit_log
       (event_time, employee_id, role, sku_id, action_type, from_location, to_location)
     VALUES (current_timestamp(), :emp, :role, :sku, :action,
             NULLIF(:fromLoc, ''), NULLIF(:toLoc, ''))`,
    {
      emp: req.employee,
      role: req.role,
      sku: sku,
      action: action,
      fromLoc: fromLoc || "",
      toLoc: toLoc || "",
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
app.get(
  "/api/items",
  wrap(async (req, res) => {
    res.json(
      await query(
        `SELECT i.*, l.label, l.map_row, l.map_col
     FROM ${T}.inventory i
     LEFT JOIN ${T}.locations l ON l.location_code = i.location_code
     ORDER BY i.name`,
      ),
    );
  }),
);

// Scan an ITEM barcode: look it up, log a SCAN event
app.get(
  "/api/scan/:barcode",
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT i.*, l.label, l.map_row, l.map_col
     FROM ${T}.inventory i
     LEFT JOIN ${T}.locations l ON l.location_code = i.location_code
     WHERE i.barcode = :b`,
      { b: req.params.barcode },
    );
    if (!rows.length) return res.status(404).json({ error: "Unknown barcode" });
    const item = rows[0];
    await logEvent(req, item.sku_id, "SCAN", item.location_code, item.location_code);
    res.json(item);
  }),
);

// Scan a SHELF barcode: shows the shelf plus every item on it
app.get(
  "/api/shelf/:barcode",
  wrap(async (req, res) => {
    const locs = await query(`SELECT * FROM ${T}.locations WHERE barcode = :b OR location_code = :b`, {
      b: req.params.barcode,
    });
    if (!locs.length) return res.status(404).json({ error: "Unknown shelf" });
    const items = await query(
      `SELECT sku_id, barcode, name, description, status
     FROM ${T}.inventory WHERE location_code = :c`,
      { c: locs[0].location_code },
    );
    res.json({ location: locs[0], items });
  }),
);

// Manager: register a new item (system generates SKU + barcode)
app.post(
  "/api/items",
  managerOnly,
  wrap(async (req, res) => {
    const { name, description, location } = req.body;
    if (!name || !location) {
      return res.status(400).json({ error: "name and location are required" });
    }
    if (!(await locationExists(location))) {
      return res.status(400).json({ error: "Unknown location" });
    }
    const sku = "SKU-" + Math.floor(100000 + Math.random() * 900000);
    await query(
      `INSERT INTO ${T}.inventory
       (sku_id, barcode, name, description, status, location_code,
        assigned_location, updated_at, updated_by)
     VALUES (:sku, :sku, :itemName, :descr, 'STOWED', :loc, :loc,
             current_timestamp(), :emp)`,
      { sku: sku, itemName: name, descr: description || "", loc: location, emp: req.employee },
    );
    await logEvent(req, sku, "REGISTER", "", location);
    res.json({ sku_id: sku, barcode: sku, location });
  }),
);

// Worker or manager: change status (STOWED / IN_TRANSIT / DISPATCHED)
app.post(
  "/api/items/:barcode/status",
  wrap(async (req, res) => {
    const { status, location } = req.body;
    const actions = { STOWED: "STOW", IN_TRANSIT: "PICK", DISPATCHED: "DISPATCH" };
    if (!actions[status]) return res.status(400).json({ error: "Invalid status" });
    if (location && !(await locationExists(location))) {
      return res.status(400).json({ error: "Unknown location" });
    }

    const rows = await query(`SELECT * FROM ${T}.inventory WHERE barcode = :b`, { b: req.params.barcode });
    if (!rows.length) return res.status(404).json({ error: "Unknown barcode" });
    const item = rows[0];

    // Stowing puts it on a shelf; other statuses take it off the map
    const newLoc = status === "STOWED" ? location || item.assigned_location : "";

    await query(
      `UPDATE ${T}.inventory
     SET status = :newStatus, location_code = NULLIF(:loc, ''),
         updated_at = current_timestamp(), updated_by = :emp
     WHERE barcode = :b`,
      { newStatus: status, loc: newLoc || "", emp: req.employee, b: req.params.barcode },
    );
    await logEvent(req, item.sku_id, actions[status], item.location_code, newLoc);
    res.json({ ok: true, status, location_code: newLoc || null });
  }),
);

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
            a.action_type, a.from_location, a.to_location,
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

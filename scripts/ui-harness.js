/**
 * Dev-only UI harness: serves the existing frontend plus the predictive API
 * without Auth0, and auto-opens the Predictive AI tab for screenshot testing.
 *
 *   node --env-file=.env scripts/ui-harness.js
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const { DBSQLClient } = require("@databricks/sql");
const { createPredictiveRouter } = require("../lib/predictive/routes");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

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
    const active = await getSession();
    const op = await active.executeStatement(statement, { namedParameters: params, runAsync: true });
    const rows = await op.fetchAll();
    await op.close();
    return rows;
  } catch (err) {
    session = null;
    client = null;
    throw err;
  }
}

const managerOnly = (req, res, next) =>
  req.role === "manager" ? next() : res.status(403).json({ error: "Managers only" });

const app = express();
app.use(express.json());
app.use("/api", (req, res, next) => {
  req.role = "manager";
  req.employee = "ui-harness";
  next();
});

app.get("/api/me", (req, res) => res.json({ name: "UI Harness", email: "harness@example.com", role: "manager" }));
app.get("/api/locations", async (req, res, next) => {
  try {
    res.json(await query("SELECT * FROM workspace.wms.locations ORDER BY map_row, map_col"));
  } catch (err) {
    next(err);
  }
});
app.get("/api/items", async (req, res, next) => {
  try {
    res.json(
      await query(
        `SELECT i.sku_id, i.barcode, i.name, i.description, i.image_url, i.qty_in_transit,
                il.qty_stowed, l.location_code, l.label
         FROM workspace.wms.inventory i
         LEFT JOIN workspace.wms.inventory_locations il ON il.sku_id = i.sku_id AND il.qty_stowed > 0
         LEFT JOIN workspace.wms.locations l ON l.location_code = il.location_code
         ORDER BY i.name`,
      ),
    );
  } catch (err) {
    next(err);
  }
});

app.use("/api/predictive", createPredictiveRouter({ query, managerOnly }));

app.get("/", (req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC, "html", "index.html"), "utf8");
  const inject = `
    <script>
      window.addEventListener("error", (event) => {
        const banner = document.createElement("div");
        banner.textContent = "JS ERROR: " + event.message;
        banner.style.cssText = "position:fixed;top:0;left:0;right:0;background:#d64545;color:#fff;padding:8px;z-index:99999;font:14px system-ui";
        document.body.appendChild(banner);
      });
      window.addEventListener("unhandledrejection", (event) => {
        const banner = document.createElement("div");
        banner.textContent = "PROMISE ERROR: " + (event.reason && event.reason.message ? event.reason.message : event.reason);
        banner.style.cssText = "position:fixed;top:0;left:0;right:0;background:#d64545;color:#fff;padding:8px;z-index:99999;font:14px system-ui";
        document.body.appendChild(banner);
      });
      setTimeout(() => {
        const button = document.querySelector('[data-tab="predictive"]');
        if (button) button.click();
      }, 500);
    </script>`;
  res.type("html").send(html.replace("</body>", `${inject}</body>`));
});

app.use(express.static(PUBLIC));
app.use("/src", express.static(path.join(PUBLIC, "src")));
app.use(express.static(path.join(PUBLIC, "html")));

const port = process.env.UI_HARNESS_PORT || 8098;
app.listen(port, () => console.log(`UI harness on http://localhost:${port}`));

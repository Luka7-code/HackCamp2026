/**
 * Dev-only UI harness: serves the frontend plus the predictive and procurement
 * APIs without Auth0, and auto-opens the Procurement tab.
 *
 *   node --env-file=.env scripts/procurement-harness.js
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const { DBSQLClient } = require("@databricks/sql");
const { createPredictiveRouter } = require("../lib/predictive/routes");
const { createProcurementRouter } = require("../lib/procurement/routes");

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
  req.employee = "procurement-harness";
  next();
});

app.get("/api/me", (req, res) =>
  res.json({ name: "Procurement Harness", email: "harness@example.com", role: "manager" }),
);
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
        `SELECT i.*, l.label, l.map_row, l.map_col
         FROM workspace.wms.inventory i
         LEFT JOIN workspace.wms.locations l ON l.location_code = i.location_code
         ORDER BY i.name`,
      ),
    );
  } catch (err) {
    next(err);
  }
});

app.use("/api/predictive", createPredictiveRouter({ query, managerOnly }));
app.use("/api/procurement", createProcurementRouter({ query, managerOnly }));

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
        const button = document.querySelector('button[data-tab="procurement"]');
        if (button) button.click();
      }, 500);
      setTimeout(() => {
        if (new URLSearchParams(location.search).get("open") === "1") {
          const button = document.querySelector('#procPending button[data-act="open"], #procPOs button[data-act="open"]');
          if (button) button.click();
        }
      }, 3500);
    </script>`;
  res.type("html").send(html.replace("</body>", `${inject}</body>`));
});

app.use(express.static(PUBLIC));
app.use("/src", express.static(path.join(PUBLIC, "src")));

const port = process.env.PROCUREMENT_HARNESS_PORT || 8097;
app.listen(port, () => console.log(`Procurement harness on http://localhost:${port}`));

/**
 * Dev-only harness: mounts the predictive router without Auth0 so the new API
 * can be exercised locally. Not used by the production server.
 *
 *   node --env-file=.env scripts/predictive-harness.js
 */
const express = require("express");
const { DBSQLClient } = require("@databricks/sql");
const { createPredictiveRouter } = require("../lib/predictive/routes");

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
  req.employee = "harness";
  next();
});
app.use("/api/predictive", createPredictiveRouter({ query, managerOnly }));

const port = process.env.HARNESS_PORT || 8099;
app.listen(port, () => console.log(`Predictive harness on http://localhost:${port}`));

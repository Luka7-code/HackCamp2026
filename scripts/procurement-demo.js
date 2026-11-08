/**
 * CLI procurement demo. Runs the detection pass directly against Databricks.
 *
 *   node --env-file=.env scripts/procurement-demo.js
 *   node --env-file=.env scripts/procurement-demo.js --sku SKU-123456 --quantity 10
 */
const { DBSQLClient } = require("@databricks/sql");
const { loadConfig } = require("../lib/procurement/config");
const { createProcurementServices } = require("../lib/procurement/services");

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

function readArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] || null;
}

(async () => {
  const config = loadConfig(process.env);
  const services = createProcurementServices({ query, config });
  const sku = readArg("sku");

  if (sku) {
    const quantity = Number(readArg("quantity")) || undefined;
    const result = await services.orchestrator.createPORequest({
      sku_id: sku,
      quantity,
      actor: "procurement-demo",
    });
    console.log(result.duplicate ? "Existing active order reused:" : "Order created:");
    console.log(JSON.stringify(result.po, null, 2));
  } else {
    console.log("Running detection pass...");
    const result = await services.orchestrator.detect({
      actor: "procurement-demo",
      actorType: "CLI",
      limit: 20,
    });
    console.log(JSON.stringify(result, null, 2));
  }

  const orders = await services.store.listPOs({ limit: 20 });
  console.table(
    orders.map((po) => ({
      Order: po.po_number,
      SKU: po.sku_id,
      Supplier: po.supplier_name,
      Qty: po.quantity,
      Total: po.total_cost,
      Status: po.status,
    })),
  );

  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

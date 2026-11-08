/**
 * Export the current warehouse inventory to a small JSON file consumed by the
 * Python ML pipeline (app SKU -> dataset pattern mapping).
 *
 * Usage: npm run ml:export   (or node --env-file=.env scripts/export-inventory.js)
 */
const fs = require("fs");
const path = require("path");
const { DBSQLClient } = require("@databricks/sql");

const OUT = path.join(__dirname, "..", "ml", "data", "processed", "app_inventory.json");

async function main() {
  const client = new DBSQLClient();
  await client.connect({
    host: process.env.DATABRICKS_HOST,
    path: process.env.DATABRICKS_HTTP_PATH,
    token: process.env.DATABRICKS_TOKEN,
  });
  const session = await client.openSession();
  try {
    const op = await session.executeStatement(
      `SELECT sku_id, barcode, name, description, status, location_code, assigned_location
       FROM workspace.wms.inventory
       ORDER BY sku_id`,
      { runAsync: true },
    );
    const rows = await op.fetchAll();
    await op.close();

    const bySku = new Map();
    for (const row of rows) {
      const item = bySku.get(row.sku_id) || {
        sku_id: row.sku_id,
        barcode: row.barcode,
        name: row.name,
        description: row.description,
        status: row.status,
        location_code: row.location_code,
        assigned_location: row.assigned_location,
        on_hand: 0,
        stowed: 0,
      };
      if (row.status !== "DISPATCHED") item.on_hand += 1;
      if (row.status === "STOWED") item.stowed += 1;
      bySku.set(row.sku_id, item);
    }

    const payload = {
      exported_at: new Date().toISOString(),
      source: "workspace.wms.inventory",
      items: [...bySku.values()],
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
    console.log(`Exported ${payload.items.length} SKUs to ${OUT}`);
  } finally {
    await session.close();
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

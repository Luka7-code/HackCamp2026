const express = require("express");
const { DBSQLClient } = require("@databricks/sql");

const app = express();
app.use(express.json());

async function query(statement, params = []) {
  const client = new DBSQLClient();
  await client.connect({
    host: process.env.DATABRICKS_HOST,
    path: process.env.DATABRICKS_HTTP_PATH,
    token: process.env.DATABRICKS_TOKEN,
  });
  const session = await client.openSession();
  try {
    const op = await session.executeStatement(statement, {
      namedParameters: params,
      runAsync: true,
    });
    const rows = await op.fetchAll();
    await op.close();
    return rows;
  } finally {
    await session.close();
    await client.close();
  }
}

app.get("api/search", async (req, res) => {
  try {
    const rows = await query(
      `SELECT i.name, i.description, s.quantity,
            l.label, l.map_x, l.map_y
        FROM workspace.inventory.items i
        JOIN workspace.inventory.stock s ON s.item_barcode = i.barcode
       JOIN workspace.inventory.locations l ON l.barcode = s.location_barcode
       WHERE lower(i.name) LIKE lower(:pattern)`,
      { pattern: `%${req.query.q || ""}%` },
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

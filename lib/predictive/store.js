"use strict";

const crypto = require("crypto");
const artifacts = require("./artifacts");
const engine = require("./engine");
const { addDays, evaluate, fillSeries, forecast, mean, round, todayUtc } = require("./models");

const T = "workspace.wms";
const CACHE_TTL_MS = 5 * 60 * 1000;
const ACTUAL_MIN_DAYS = 14;
const ACTUAL_MIN_EVENTS = 20;

const DEMAND_PROFILE = [0.45, 0.03, 0.35, 0.012, 0.25, 0.008, 0.18, 0.02, 0.55, 0.006];
const DEFAULT_LEAD_TIMES = [3, 5, 7, 10, 14];

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${T}.ml_dataset_registry (
     dataset_id STRING, display_name STRING, source_url STRING, license STRING,
     rows_processed BIGINT, series_count BIGINT, date_min STRING, date_max STRING,
     stockout_rate DOUBLE, promo_rate DOUBLE, notes STRING, registered_at TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.ml_dataset_files (
     dataset_id STRING, stage STRING, file_name STRING, bytes BIGINT,
     rows_processed BIGINT, series_count BIGINT, date_min STRING, date_max STRING,
     source_url STRING, license STRING, registered_at TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.ml_model_runs (
     run_id STRING, dataset_id STRING, model_name STRING, horizon_days INT,
     mae DOUBLE, wape DOUBLE, n_series BIGINT, trained_at TIMESTAMP,
     params_json STRING, notes STRING
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.ml_demand_history (
     sku_id STRING, demand_date DATE, units_demand DOUBLE, source STRING,
     pattern_id STRING, dataset_id STRING, created_at TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.ml_inventory_snapshot (
     snapshot_id STRING, snapshot_time TIMESTAMP, sku_id STRING, name STRING,
     status STRING, location_code STRING, on_hand INT, source STRING
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.ml_stockout_events (
     event_id STRING, pattern_id STRING, dataset_id STRING, event_date DATE,
     stockout_flag INT, sku_id STRING, source STRING, created_at TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.ml_forecasts (
     run_id STRING, generated_at TIMESTAMP, sku_id STRING, horizon_days INT,
     forecast_date DATE, predicted_units DOUBLE, model_name STRING,
     data_source STRING, dataset_id STRING
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.ml_restock_recommendations (
     run_id STRING, generated_at TIMESTAMP, sku_id STRING, on_hand INT,
     avg_daily_demand DOUBLE, lead_time_days INT, safety_stock_days INT,
     reorder_point INT, recommended_qty INT, risk_level STRING,
     days_to_stockout INT, overstock BOOLEAN, reason STRING, scenario STRING
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.ml_restock_reviews (
     review_id STRING, run_id STRING, sku_id STRING, recommended_qty INT,
     approved_qty INT, decision STRING, note STRING, decided_by STRING, decided_at TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.ml_product_mapping (
     sku_id STRING, pattern_id STRING, dataset_id STRING, dataset_series_id STRING,
     dataset_product_id STRING, dataset_store_id STRING, scale_factor DOUBLE,
     is_demo BOOLEAN, created_at TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.ml_patterns (
     pattern_id STRING, dataset_id STRING, series_id STRING, product_id STRING,
     store_id STRING, category STRING, mean_units DOUBLE, cv DOUBLE,
     stockout_days INT, promo_days INT, created_at TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.ml_pattern_points (
     pattern_id STRING, point_date DATE, units DOUBLE, stockout INT, promo INT
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.ml_product_settings (
     sku_id STRING, supplier_name STRING, lead_time_days INT, safety_stock_days INT,
     min_order_qty INT, case_pack INT, unit_cost DOUBLE, overstock_days INT,
     settings_source STRING, updated_at TIMESTAMP, updated_by STRING
   )`,
];

// ---------- SQL helpers ----------

function sqlStr(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNum(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "NULL";
  return String(Number(value));
}

function sqlBool(value) {
  return value ? "TRUE" : "FALSE";
}

function chunk(array, size) {
  const out = [];
  for (let index = 0; index < array.length; index += size) out.push(array.slice(index, index + size));
  return out;
}

async function batchInsert(query, table, columns, rows, batchSize = 100) {
  for (const batch of chunk(rows, batchSize)) {
    const values = batch
      .map((row) => `(${row.map((value) => (value && value.raw ? value.raw : value)).join(", ")})`)
      .join(", ");
    if (!values) continue;
    await query(`INSERT INTO ${T}.${table} (${columns.join(", ")}) VALUES ${values}`);
  }
}

function raw(value) {
  return { raw: value };
}

function hashIndex(text, modulo) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return modulo > 0 ? hash % modulo : 0;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toDateString(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function parseTimestamp(value) {
  if (!value) return null;
  const text = String(value);
  const iso = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// ---------- store ----------

function createStore(query) {
  let schemaReady = false;
  let cache = null;

  async function ensureSchema() {
    if (schemaReady) return;
    for (const statement of DDL) {
      await query(statement);
    }
    schemaReady = true;
  }

  async function loadInventory() {
    const rows = await query(
      `SELECT i.sku_id, i.barcode, i.name, i.description,
              COALESCE(i.qty_in_transit, 0) AS qty_in_transit,
              COALESCE(SUM(il.qty_stowed), 0) AS qty_stowed,
              MAX(il.location_code) AS location_code
       FROM ${T}.inventory i
       LEFT JOIN ${T}.inventory_locations il
         ON il.sku_id = i.sku_id AND il.qty_stowed > 0
       GROUP BY i.sku_id, i.barcode, i.name, i.description, i.qty_in_transit
       ORDER BY i.name`,
    );
    return rows.map((row) => {
      const stowed = Number(row.qty_stowed) || 0;
      const inTransit = Number(row.qty_in_transit) || 0;
      return {
        sku_id: row.sku_id,
        barcode: row.barcode,
        name: row.name,
        description: row.description,
        status: stowed > 0 ? "STOWED" : "IN_TRANSIT",
        location_code: row.location_code || null,
        assigned_location: row.location_code || null,
        on_hand: stowed + inTransit,
      };
    });
  }

  async function loadActualDemand() {
    const rows = await query(
      `SELECT sku_id, CAST(CAST(event_time AS DATE) AS STRING) AS demand_date, COUNT(*) AS units
       FROM ${T}.audit_log
       WHERE action_type = 'DISPATCH' AND event_time >= date_sub(current_date(), 120)
       GROUP BY sku_id, CAST(event_time AS DATE)`,
    );
    const dates = new Set();
    let events = 0;
    let first = null;
    let last = null;
    for (const row of rows) {
      const date = toDateString(row.demand_date);
      dates.add(date);
      events += Number(row.units) || 0;
      if (!first || date < first) first = date;
      if (!last || date > last) last = date;
    }
    return {
      rows,
      stats: { events, days: dates.size, first, last },
    };
  }

  async function loadSettings(products) {
    const rows = await query(`SELECT * FROM ${T}.ml_product_settings`);
    const settings = {};
    for (const row of rows) {
      settings[row.sku_id] = {
        sku_id: row.sku_id,
        supplier_name: row.supplier_name,
        lead_time_days: Number(row.lead_time_days),
        safety_stock_days: Number(row.safety_stock_days),
        min_order_qty: Number(row.min_order_qty),
        case_pack: Number(row.case_pack),
        unit_cost: row.unit_cost == null ? null : Number(row.unit_cost),
        overstock_days: Number(row.overstock_days),
        settings_source: row.settings_source,
      };
    }

    const missing = [];
    products.forEach((product, index) => {
      if (settings[product.sku_id]) return;
      const settingsRow = {
        sku_id: product.sku_id,
        supplier_name: "Primary supplier",
        lead_time_days: DEFAULT_LEAD_TIMES[index % DEFAULT_LEAD_TIMES.length],
        safety_stock_days: 5,
        min_order_qty: 1,
        case_pack: 1,
        unit_cost: null,
        overstock_days: 60,
        settings_source: "DEFAULT",
      };
      settings[product.sku_id] = settingsRow;
      missing.push([
        sqlStr(settingsRow.sku_id),
        sqlStr(settingsRow.supplier_name),
        sqlNum(settingsRow.lead_time_days),
        sqlNum(settingsRow.safety_stock_days),
        sqlNum(settingsRow.min_order_qty),
        sqlNum(settingsRow.case_pack),
        "NULL",
        sqlNum(settingsRow.overstock_days),
        sqlStr(settingsRow.settings_source),
        raw("current_timestamp()"),
        sqlStr("system"),
      ]);
    });
    if (missing.length) {
      await batchInsert(
        query,
        "ml_product_settings",
        [
          "sku_id",
          "supplier_name",
          "lead_time_days",
          "safety_stock_days",
          "min_order_qty",
          "case_pack",
          "unit_cost",
          "overstock_days",
          "settings_source",
          "updated_at",
          "updated_by",
        ],
        missing,
      );
    }
    return settings;
  }

  function patternMapping(pattern, scaleFactor, target) {
    return {
      pattern_id: pattern.pattern_id,
      dataset: pattern.dataset,
      dataset_series_id: pattern.series_id,
      dataset_product_id: pattern.product_id,
      dataset_store_id: pattern.store_id,
      category: pattern.category,
      scale_factor: round(scaleFactor, 6),
      target_daily_demand: target,
      is_demo: true,
    };
  }

  function syntheticSeries(product, index, endDate) {
    const random = seededRandom(hashIndex(product.sku_id, 1_000_000) + 17);
    const base = DEMAND_PROFILE[index % DEMAND_PROFILE.length];
    const points = [];
    for (let day = 89; day >= 0; day -= 1) {
      const date = addDays(endDate, -day);
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      const weekly = dow === 0 || dow === 6 ? 1.25 : dow === 1 ? 0.85 : 1;
      const noise = 0.65 + random() * 0.7;
      points.push({ date, units: round(Math.max(0, base * weekly * noise), 3) });
    }
    return points;
  }

  function buildSample(products, patternArtifact, appArtifact) {
    const patterns = patternArtifact && Array.isArray(patternArtifact.patterns) ? patternArtifact.patterns : [];
    const appBySku = new Map(
      (appArtifact && Array.isArray(appArtifact.skus) ? appArtifact.skus : []).map((item) => [item.sku_id, item]),
    );
    const endDate = addDays(todayUtc(), -1);
    const series = {};
    const mapping = {};
    let usedDataset = false;

    products.forEach((product, index) => {
      const appItem = appBySku.get(product.sku_id);
      if (appItem && Array.isArray(appItem.history_units) && appItem.history_units.length) {
        const units = appItem.history_units.slice(-90).map((value) => Math.max(0, Number(value) || 0));
        while (units.length < 90) units.unshift(0);
        series[product.sku_id] = units.map((value, offset) => ({
          date: addDays(endDate, offset - 89),
          units: value,
        }));
        mapping[product.sku_id] = {
          pattern_id: appItem.pattern_id,
          dataset: appItem.dataset,
          dataset_series_id: appItem.dataset_series_id,
          dataset_product_id: appItem.dataset_product_id,
          dataset_store_id: appItem.dataset_store_id,
          category: appItem.category,
          scale_factor: appItem.scale_factor,
          target_daily_demand: appItem.target_daily_demand,
          is_demo: true,
        };
        usedDataset = true;
        return;
      }

      if (patterns.length) {
        const pattern = patterns[(index * 5 + 3) % patterns.length];
        const values = pattern.units.slice(-90).map(Number);
        const patternMean = Math.max(mean(values), 0.000001);
        const target = DEMAND_PROFILE[index % DEMAND_PROFILE.length];
        const scale = target / patternMean;
        series[product.sku_id] = values.map((value, offset) => ({
          date: addDays(endDate, offset - values.length + 1),
          units: Math.max(0, round(value * scale, 4)),
        }));
        mapping[product.sku_id] = patternMapping(pattern, scale, target);
        usedDataset = true;
        return;
      }

      series[product.sku_id] = syntheticSeries(product, index, endDate);
    });

    return {
      source: usedDataset ? "SAMPLE_DATASET" : "SAMPLE_SYNTHETIC",
      series,
      mapping,
    };
  }

  function buildActualSeries(products, actualRows) {
    const endDate = addDays(todayUtc(), -1);
    const bySku = new Map();
    for (const row of actualRows) {
      const points = bySku.get(row.sku_id) || [];
      points.push({ date: toDateString(row.demand_date), units: Number(row.units) || 0 });
      bySku.set(row.sku_id, points);
    }
    const series = {};
    for (const product of products) {
      series[product.sku_id] = fillSeries(bySku.get(product.sku_id) || [], endDate, 90);
    }
    return series;
  }

  function buildForecasts(products, series, mapping, dataSource, appArtifact) {
    const appBySku = new Map(
      (appArtifact && Array.isArray(appArtifact.skus) ? appArtifact.skus : []).map((item) => [item.sku_id, item]),
    );
    const result = {};
    for (const product of products) {
      const points = series[product.sku_id];
      if (!points || !points.length) continue;
      const appItem = dataSource === "SAMPLE_DATASET" ? appBySku.get(product.sku_id) : null;

      if (appItem && Array.isArray(appItem.forecast_units) && appItem.forecast_units.length) {
        const base = appItem.forecast_units.map((value, index) => ({
          date: addDays(todayUtc(), index),
          units: Math.max(0, Number(value) || 0),
        }));
        const avg = mean(base.map((point) => point.units));
        const daily = base.slice();
        for (let index = base.length; index < 90; index += 1) {
          daily.push({ date: addDays(todayUtc(), index), units: avg });
        }
        result[product.sku_id] = {
          model: {
            name: appItem.model_name || `xgboost_${appItem.dataset}`,
            label:
              appItem.model_label ||
              (String(appItem.model_name || "").startsWith("xgboost")
                ? `XGBoost (${appItem.dataset} dataset)`
                : `Baseline (${appItem.dataset} dataset)`),
          },
          daily,
          data_source: dataSource,
          mapping: mapping[product.sku_id] || null,
          backtest: appItem.backtest || null,
        };
      } else {
        const output = forecast(points, 90);
        result[product.sku_id] = {
          model: output.model,
          daily: output.daily,
          data_source: dataSource,
          mapping: mapping[product.sku_id] || null,
          backtest: evaluate(points, 14),
        };
      }
    }
    return result;
  }

  async function ensureRegistry() {
    const report = artifacts.loadDatasetReport();
    const metrics = artifacts.loadMetrics();
    const manifest = artifacts.loadManifest();

    const filesCount = await query(`SELECT count(*) AS c FROM ${T}.ml_dataset_files`);
    if (Number(filesCount[0].c) === 0 && (report || manifest)) {
      const rows = [];
      for (const file of manifest?.files || []) {
        rows.push([
          sqlStr(file.dataset),
          sqlStr("RAW"),
          sqlStr(String(file.path || "").split("/").pop()),
          sqlNum(file.bytes),
          "NULL",
          "NULL",
          "NULL",
          "NULL",
          sqlStr(file.official_source || file.url),
          sqlStr(file.license),
          raw("current_timestamp()"),
        ]);
      }
      for (const [datasetId, dataset] of Object.entries(report?.datasets || {})) {
        const samples = [
          { file: `${datasetId}.parquet`, sample: dataset.train_sample },
          { file: `${datasetId}_eval.parquet`, sample: dataset.eval_sample },
        ];
        for (const { file, sample } of samples) {
          if (!sample) continue;
          rows.push([
            sqlStr(datasetId),
            sqlStr("PROCESSED"),
            sqlStr(file),
            "NULL",
            sqlNum(sample.rows),
            sqlNum(sample.series),
            sqlStr(sample.date_min),
            sqlStr(sample.date_max),
            sqlStr(dataset.source_url),
            sqlStr(dataset.license),
            raw("current_timestamp()"),
          ]);
        }
      }
      if (rows.length) {
        await batchInsert(
          query,
          "ml_dataset_files",
          ["dataset_id", "stage", "file_name", "bytes", "rows_processed", "series_count", "date_min", "date_max", "source_url", "license", "registered_at"],
          rows,
        );
      }
    }

    const registryCount = await query(`SELECT count(*) AS c FROM ${T}.ml_dataset_registry`);
    if (Number(registryCount[0].c) === 0 && report) {
      const rows = Object.entries(report.datasets || {}).map(([datasetId, dataset]) => {
        const sample = dataset.train_sample || {};
        return [
          sqlStr(datasetId),
          sqlStr(dataset.display_name),
          sqlStr(dataset.source_url),
          sqlStr(dataset.license),
          sqlNum(sample.rows),
          sqlNum(sample.series),
          sqlStr(sample.date_min),
          sqlStr(sample.date_max),
          sample.stockout_rate == null ? "NULL" : sqlNum(sample.stockout_rate),
          sample.promo_rate == null ? "NULL" : sqlNum(sample.promo_rate),
          sqlStr(dataset.notes),
          raw("current_timestamp()"),
        ];
      });
      await batchInsert(
        query,
        "ml_dataset_registry",
        [
          "dataset_id",
          "display_name",
          "source_url",
          "license",
          "rows_processed",
          "series_count",
          "date_min",
          "date_max",
          "stockout_rate",
          "promo_rate",
          "notes",
          "registered_at",
        ],
        rows,
      );
    }

    const modelCount = await query(`SELECT count(*) AS c FROM ${T}.ml_model_runs`);
    if (Number(modelCount[0].c) === 0 && metrics) {
      const rows = [];
      for (const [datasetId, result] of Object.entries(metrics.datasets || {})) {
        for (const modelName of ["moving_average", "seasonal_naive", "xgboost"]) {
          for (const horizon of [7, 14, 30]) {
            const metric = (result.holdout || {})[modelName]?.[String(horizon)] || {};
            rows.push([
              sqlStr(`${datasetId}:${modelName}:${horizon}`),
              sqlStr(datasetId),
              sqlStr(modelName),
              sqlNum(horizon),
              metric.mae == null ? "NULL" : sqlNum(metric.mae),
              metric.wape == null ? "NULL" : sqlNum(metric.wape),
              sqlNum(metric.n_series),
              raw("current_timestamp()"),
              sqlStr(JSON.stringify(result.model?.params || {})),
              sqlStr(`holdout; trained ${result.trained_at || ""}`),
            ]);
          }
        }
      }
      await batchInsert(
        query,
        "ml_model_runs",
        ["run_id", "dataset_id", "model_name", "horizon_days", "mae", "wape", "n_series", "trained_at", "params_json", "notes"],
        rows,
      );
    }
  }

  async function ensurePatterns() {
    const patternArtifact = artifacts.loadPatterns();
    if (!patternArtifact || !Array.isArray(patternArtifact.patterns) || !patternArtifact.patterns.length) return;

    const patternCount = await query(`SELECT count(*) AS c FROM ${T}.ml_patterns`);
    if (Number(patternCount[0].c) === 0) {
      const patternRows = patternArtifact.patterns.map((pattern) => [
        sqlStr(pattern.pattern_id),
        sqlStr(pattern.dataset),
        sqlStr(pattern.series_id),
        sqlStr(pattern.product_id),
        sqlStr(pattern.store_id),
        sqlStr(pattern.category),
        sqlNum(pattern.mean_units),
        pattern.cv == null ? "NULL" : sqlNum(pattern.cv),
        sqlNum(pattern.stockout_days),
        sqlNum(pattern.promo_days),
        raw("current_timestamp()"),
      ]);
      await batchInsert(
        query,
        "ml_patterns",
        ["pattern_id", "dataset_id", "series_id", "product_id", "store_id", "category", "mean_units", "cv", "stockout_days", "promo_days", "created_at"],
        patternRows,
      );
    }

    const pointCount = await query(`SELECT count(*) AS c FROM ${T}.ml_pattern_points`);
    if (Number(pointCount[0].c) === 0) {
      const pointRows = [];
      for (const pattern of patternArtifact.patterns) {
        const dates = pattern.dates || [];
        pattern.units.forEach((value, index) => {
          pointRows.push([
            sqlStr(pattern.pattern_id),
            sqlStr(dates[index]),
            sqlNum(value),
            pattern.stockout && pattern.stockout[index] != null ? sqlNum(pattern.stockout[index]) : "NULL",
            pattern.promo && pattern.promo[index] != null ? sqlNum(pattern.promo[index]) : "NULL",
          ]);
        });
      }
      await batchInsert(query, "ml_pattern_points", ["pattern_id", "point_date", "units", "stockout", "promo"], pointRows, 100);
    }

    const stockoutCount = await query(`SELECT count(*) AS c FROM ${T}.ml_stockout_events`);
    if (Number(stockoutCount[0].c) === 0) {
      await query(
        `INSERT INTO ${T}.ml_stockout_events
           (event_id, pattern_id, dataset_id, event_date, stockout_flag, sku_id, source, created_at)
         SELECT concat(pt.pattern_id, ':', CAST(pt.point_date AS STRING)), pt.pattern_id,
                p.dataset_id, pt.point_date, 1, NULL, 'DATASET_LABEL', current_timestamp()
         FROM ${T}.ml_pattern_points pt
         JOIN ${T}.ml_patterns p ON p.pattern_id = pt.pattern_id
         WHERE pt.stockout = 1`,
      );
    }
  }

  async function ensureInventorySnapshot(products) {
    const latest = await query(`SELECT CAST(max(snapshot_time) AS STRING) AS ts FROM ${T}.ml_inventory_snapshot`);
    const timestamp = latest[0] && latest[0].ts ? parseTimestamp(latest[0].ts) : null;
    if (timestamp && Date.now() - timestamp.getTime() < 60 * 60 * 1000) return;
    const rows = products.map((product) => [
      sqlStr(crypto.randomUUID()),
      raw("current_timestamp()"),
      sqlStr(product.sku_id),
      sqlStr(product.name),
      sqlStr(product.status),
      sqlStr(product.location_code),
      sqlNum(product.on_hand),
      sqlStr("INVENTORY"),
    ]);
    await batchInsert(
      query,
      "ml_inventory_snapshot",
      ["snapshot_id", "snapshot_time", "sku_id", "name", "status", "location_code", "on_hand", "source"],
      rows,
    );
  }

  async function ensureDemandHistory(dataSource, products, series, mapping) {
    const sourceValues = "('SAMPLE_DATASET', 'SAMPLE_SYNTHETIC')";
    if (dataSource === "ACTUAL") {
      const existing = await query(
        `SELECT CAST(max(demand_date) AS STRING) AS max_date, count(*) AS c
         FROM ${T}.ml_demand_history WHERE source = 'ACTUAL'`,
      );
      const maxDate = toDateString(existing[0]?.max_date);
      if (Number(existing[0]?.c || 0) >= 60 && maxDate && maxDate >= addDays(todayUtc(), -2)) return;
      await query(`DELETE FROM ${T}.ml_demand_history WHERE source = 'ACTUAL'`);
      const rows = [];
      for (const product of products) {
        for (const point of series[product.sku_id] || []) {
          rows.push([
            sqlStr(product.sku_id),
            sqlStr(point.date),
            sqlNum(point.units),
            sqlStr("ACTUAL"),
            "NULL",
            "NULL",
            raw("current_timestamp()"),
          ]);
        }
      }
      await batchInsert(
        query,
        "ml_demand_history",
        ["sku_id", "demand_date", "units_demand", "source", "pattern_id", "dataset_id", "created_at"],
        rows,
      );
      return;
    }

    const existing = await query(
      `SELECT sku_id, source, CAST(max(demand_date) AS STRING) AS max_date, count(*) AS c
       FROM ${T}.ml_demand_history WHERE source IN ${sourceValues} GROUP BY sku_id, source`,
    );
    const today = todayUtc();
    const fresh = products.every((product) => {
      const row = existing.find((item) => item.sku_id === product.sku_id && item.source === dataSource);
      if (!row) return false;
      const maxDate = toDateString(row.max_date);
      return Number(row.c) >= 60 && maxDate && maxDate >= addDays(today, -2);
    });
    if (fresh) return;

    await query(`DELETE FROM ${T}.ml_demand_history WHERE source IN ${sourceValues}`);
    const rows = [];
    for (const product of products) {
      const mappingItem = mapping[product.sku_id];
      for (const point of series[product.sku_id] || []) {
        rows.push([
          sqlStr(product.sku_id),
          sqlStr(point.date),
          sqlNum(point.units),
          sqlStr(dataSource),
          sqlStr(mappingItem?.pattern_id || null),
          sqlStr(mappingItem?.dataset || null),
          raw("current_timestamp()"),
        ]);
      }
    }
    await batchInsert(
      query,
      "ml_demand_history",
      ["sku_id", "demand_date", "units_demand", "source", "pattern_id", "dataset_id", "created_at"],
      rows,
    );
  }

  async function ensureMapping(mapping) {
    const entries = Object.entries(mapping);
    await query(`DELETE FROM ${T}.ml_product_mapping WHERE is_demo = TRUE`);
    if (!entries.length) return;
    const rows = entries.map(([skuId, item]) => [
      sqlStr(skuId),
      sqlStr(item.pattern_id),
      sqlStr(item.dataset),
      sqlStr(item.dataset_series_id),
      sqlStr(item.dataset_product_id),
      sqlStr(item.dataset_store_id),
      sqlNum(item.scale_factor),
      sqlBool(item.is_demo),
      raw("current_timestamp()"),
    ]);
    await batchInsert(
      query,
      "ml_product_mapping",
      ["sku_id", "pattern_id", "dataset_id", "dataset_series_id", "dataset_product_id", "dataset_store_id", "scale_factor", "is_demo", "created_at"],
      rows,
    );
  }

  async function getContext({ refresh = false } = {}) {
    if (!refresh && cache && cache.expires > Date.now()) return cache.value;
    await ensureSchema();

    const products = await loadInventory();
    const actual = await loadActualDemand();
    const useActual = actual.stats.days >= ACTUAL_MIN_DAYS && actual.stats.events >= ACTUAL_MIN_EVENTS;
    const dataSource = useActual ? "ACTUAL" : null;

    const settings = await loadSettings(products);
    const patternArtifact = artifacts.loadPatterns();
    const appArtifact = artifacts.loadAppForecasts();

    let series;
    let mapping;
    let source;
    if (useActual) {
      series = buildActualSeries(products, actual.rows);
      mapping = {};
      source = "ACTUAL";
    } else {
      const sample = buildSample(products, patternArtifact, appArtifact);
      series = sample.series;
      mapping = sample.mapping;
      source = sample.source;
    }

    await ensureRegistry();
    await ensurePatterns();
    await ensureInventorySnapshot(products);
    await ensureDemandHistory(source, products, series, mapping);
    await ensureMapping(mapping);

    const forecasts = buildForecasts(products, series, mapping, source, appArtifact);
    const context = {
      generated_at: new Date().toISOString(),
      data_source: source,
      actual_stats: actual.stats,
      products,
      settings,
      series,
      mapping,
      forecasts,
      patterns: patternArtifact?.patterns || [],
      app_forecasts: appArtifact,
    };
    cache = { value: context, expires: Date.now() + CACHE_TTL_MS };
    return context;
  }

  async function getDashboard({ refresh = false } = {}) {
    const context = await getContext({ refresh });
    const analysis = engine.buildAnalysis({
      products: context.products,
      settings: context.settings,
      forecasts: context.forecasts,
    });
    const forecastRows = context.products
      .filter((product) => context.forecasts[product.sku_id])
      .map((product) => {
        const row = analysis.rows.find((candidate) => candidate.sku_id === product.sku_id);
        return {
          sku_id: product.sku_id,
          name: product.name,
          on_hand: product.on_hand,
          forecast_7d: row?.forecast_7d ?? null,
          forecast_14d: row?.forecast_14d ?? null,
          forecast_30d: row?.forecast_30d ?? null,
          avg_daily_demand: row?.avg_daily_demand ?? null,
          risk_level: row?.risk_level ?? null,
          days_to_stockout: row?.days_to_stockout ?? null,
          recommended_qty: row?.recommended_qty ?? null,
          overstock: row?.overstock ?? false,
        };
      });

    return {
      generated_at: context.generated_at,
      summary: analysis.summary,
      forecasts: forecastRows,
      stockouts: analysis.rows.filter((row) => row.at_risk),
      restock: analysis.rows.filter((row) => row.recommended_qty > 0 || row.at_risk),
      overstock: analysis.rows.filter((row) => row.overstock),
      all: analysis.rows,
    };
  }

  async function getForecast(sku, horizon = 30) {
    const context = await getContext();
    const product = context.products.find((item) => item.sku_id === sku);
    const item = context.forecasts[sku];
    if (!product || !item) return null;
    const daily = item.daily.slice(0, horizon);
    const history = (context.series[sku] || []).slice(-42);
    const total = (days) => round(item.daily.slice(0, days).reduce((sum, point) => sum + point.units, 0), 2);
    return {
      sku_id: sku,
      name: product.name,
      on_hand: product.on_hand,
      horizon_days: horizon,
      history,
      forecast: daily,
      totals: { d7: total(7), d14: total(14), d30: total(30) },
      generated_at: context.generated_at,
    };
  }

  async function getStockouts() {
    const dashboard = await getDashboard();
    return dashboard.stockouts;
  }

  async function getRestock() {
    const dashboard = await getDashboard();
    return dashboard.restock;
  }

  async function getOverstock() {
    const dashboard = await getDashboard();
    return dashboard.overstock;
  }

  async function simulate(modifiers = {}) {
    const context = await getContext();
    const demandChange = Math.max(-90, Math.min(200, Number(modifiers.demand_change_pct) || 0));
    const leadDelta = Math.max(-30, Math.min(60, Number(modifiers.lead_time_delta_days) || 0));
    const result = engine.simulate({
      products: context.products,
      settings: context.settings,
      forecasts: context.forecasts,
      modifiers: {
        demand_multiplier: 1 + demandChange / 100,
        lead_time_delta_days: leadDelta,
      },
    });
    return {
      generated_at: context.generated_at,
      scenario: {
        demand_change_pct: demandChange,
        lead_time_delta_days: leadDelta,
      },
      ...result,
    };
  }

  async function runSnapshot(employee) {
    const context = await getContext();
    const dashboard = await getDashboard();
    const runId = crypto.randomUUID();
    const generatedAt = new Date().toISOString();

    const forecastRows = [];
    for (const item of dashboard.forecasts) {
      const forecastItem = context.forecasts[item.sku_id];
      if (!forecastItem) continue;
      forecastItem.daily.slice(0, 30).forEach((point, index) => {
        forecastRows.push([
          sqlStr(runId),
          raw("current_timestamp()"),
          sqlStr(item.sku_id),
          sqlNum(index + 1),
          sqlStr(point.date),
          sqlNum(round(point.units, 4)),
          sqlStr(forecastItem.model?.name || null),
          sqlStr(forecastItem.data_source),
          sqlStr(forecastItem.mapping?.dataset || null),
        ]);
      });
    }
    await batchInsert(
      query,
      "ml_forecasts",
      ["run_id", "generated_at", "sku_id", "horizon_days", "forecast_date", "predicted_units", "model_name", "data_source", "dataset_id"],
      forecastRows,
      50,
    );

    const recommendationRows = dashboard.all.map((row) => [
      sqlStr(runId),
      raw("current_timestamp()"),
      sqlStr(row.sku_id),
      sqlNum(row.on_hand),
      sqlNum(row.avg_daily_demand),
      sqlNum(row.lead_time_days),
      sqlNum(row.safety_stock_days),
      sqlNum(row.reorder_point),
      sqlNum(row.recommended_qty),
      sqlStr(row.risk_level),
      row.days_to_stockout == null ? "NULL" : sqlNum(row.days_to_stockout),
      sqlBool(row.overstock),
      sqlStr(row.reason),
      sqlStr("baseline"),
    ]);
    await batchInsert(
      query,
      "ml_restock_recommendations",
      ["run_id", "generated_at", "sku_id", "on_hand", "avg_daily_demand", "lead_time_days", "safety_stock_days", "reorder_point", "recommended_qty", "risk_level", "days_to_stockout", "overstock", "reason", "scenario"],
      recommendationRows,
    );

    return {
      run_id: runId,
      generated_at: generatedAt,
      forecast_rows: forecastRows.length,
      recommendation_rows: recommendationRows.length,
      requested_by: employee || null,
    };
  }

  async function saveReview(payload, employee) {
    const sku = String(payload.sku_id || "").trim();
    const decision = String(payload.decision || "").toUpperCase();
    if (!sku) throw badRequest("sku_id is required");
    if (!["APPROVED", "DISMISSED"].includes(decision)) throw badRequest("decision must be APPROVED or DISMISSED");
    const product = await query(`SELECT sku_id FROM ${T}.inventory WHERE sku_id = :sku LIMIT 1`, { sku });
    if (!product.length) throw badRequest("Unknown SKU");

    const reviewId = crypto.randomUUID();
    const recommended = Number(payload.recommended_qty) || 0;
    const approved =
      decision === "APPROVED"
        ? Math.max(0, Math.round(payload.approved_qty === undefined ? recommended : Number(payload.approved_qty) || 0))
        : 0;
    await query(
      `INSERT INTO ${T}.ml_restock_reviews
         (review_id, run_id, sku_id, recommended_qty, approved_qty, decision, note, decided_by, decided_at)
       VALUES (:reviewId, :runId, :sku, :recommended, :approved, :decision, :note, :employee, current_timestamp())`,
      {
        reviewId,
        runId: payload.run_id || "",
        sku,
        recommended,
        approved,
        decision,
        note: payload.note || "",
        employee: employee || "unknown",
      },
    );
    return { review_id: reviewId, sku_id: sku, decision, approved_qty: approved };
  }

  async function listReviews(limit = 50) {
    const safeLimit = Math.max(1, Math.min(200, Math.round(Number(limit) || 50)));
    return query(
      `SELECT CAST(review_id AS STRING) AS review_id, CAST(run_id AS STRING) AS run_id,
              sku_id, recommended_qty, approved_qty, decision, note, decided_by,
              CAST(decided_at AS STRING) AS decided_at
       FROM ${T}.ml_restock_reviews ORDER BY decided_at DESC LIMIT ${safeLimit}`,
    );
  }

  async function updateSettings(sku, patch, employee) {
    const sets = [];
    const params = { sku, employee: employee || "unknown" };
    const numeric = (name, min, max) => {
      if (patch[name] === undefined) return;
      const value = Math.round(Number(patch[name]));
      if (!Number.isFinite(value) || value < min || value > max) {
        throw badRequest(`${name} must be between ${min} and ${max}`);
      }
      sets.push(`${name} = :${name}`);
      params[name] = value;
    };
    numeric("lead_time_days", 0, 120);
    numeric("safety_stock_days", 0, 90);
    numeric("min_order_qty", 1, 10000);
    numeric("case_pack", 1, 10000);
    numeric("overstock_days", 1, 365);
    if (!sets.length) throw badRequest("No editable settings supplied");

    await query(
      `UPDATE ${T}.ml_product_settings
       SET ${sets.join(", ")}, settings_source = 'MANAGER',
           updated_at = current_timestamp(), updated_by = :employee
       WHERE sku_id = :sku`,
      params,
    );
    cache = null;
    const context = await getContext({ refresh: true });
    return context.settings[sku];
  }

  async function reloadMl() {
    await ensureSchema();
    for (const table of [
      "ml_pattern_points",
      "ml_stockout_events",
      "ml_patterns",
      "ml_product_mapping",
      "ml_dataset_registry",
      "ml_dataset_files",
      "ml_model_runs",
    ]) {
      await query(`DELETE FROM ${T}.${table}`);
    }
    await query(`DELETE FROM ${T}.ml_demand_history`);
    cache = null;
    return getContext({ refresh: true });
  }

  return {
    ensureSchema,
    getContext,
    getDashboard,
    getForecast,
    getStockouts,
    getRestock,
    getOverstock,
    simulate,
    runSnapshot,
    saveReview,
    listReviews,
    updateSettings,
    reloadMl,
    refresh: () => {
      cache = null;
      return getContext({ refresh: true });
    },
  };
}

module.exports = { createStore };

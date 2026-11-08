"use strict";

const { addDays, mean, round, todayUtc } = require("./models");

const REVIEW_PERIOD_DAYS = 30;
const RISK_ORDER = { OUT: 0, CRITICAL: 1, WARNING: 2, NO_DEMAND: 3, OK: 4 };

const DEFAULT_SETTINGS = {
  lead_time_days: 7,
  safety_stock_days: 5,
  min_order_qty: 1,
  case_pack: 1,
  overstock_days: 60,
  settings_source: "DEFAULT",
};

function normalizeSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  return {
    lead_time_days: Math.max(0, Number(merged.lead_time_days) || 0),
    safety_stock_days: Math.max(0, Number(merged.safety_stock_days) || 0),
    min_order_qty: Math.max(1, Math.round(Number(merged.min_order_qty) || 1)),
    case_pack: Math.max(1, Math.round(Number(merged.case_pack) || 1)),
    overstock_days: Math.max(1, Math.round(Number(merged.overstock_days) || 60)),
    settings_source: merged.settings_source || "DEFAULT",
    supplier_name: merged.supplier_name || null,
    unit_cost: merged.unit_cost == null ? null : Number(merged.unit_cost),
  };
}

function daysToStockout(daily, onHand) {
  if (onHand <= 0) return 0;
  let cumulative = 0;
  for (let index = 0; index < daily.length; index += 1) {
    cumulative += daily[index].units;
    if (cumulative >= onHand) return index + 1;
  }
  return null;
}

function recommendationFor(row) {
  const days = row.days_to_stockout;
  if (row.risk_level === "OUT") {
    return `Stock is exhausted. Reorder ${row.recommended_qty} units immediately.`;
  }
  if (row.risk_level === "CRITICAL") {
    return `Stock covers about ${days} day(s) but the supplier lead time is ${row.lead_time_days} days. Reorder ${row.recommended_qty} units now.`;
  }
  if (row.risk_level === "WARNING") {
    return `Stock covers about ${days} day(s), inside the safety window (lead time ${row.lead_time_days} + ${row.safety_stock_days} safety days). Plan a reorder of ${row.recommended_qty} units.`;
  }
  if (row.overstock) {
    const supply =
      row.days_of_supply === null
        ? "No predicted demand"
        : `About ${row.days_of_supply} days of supply`;
    return `${supply} against ${row.forecast_30d} predicted units over 30 days. Pause replenishment and consider a promotion or transfer.`;
  }
  if (row.risk_level === "NO_DEMAND") {
    return "No predicted demand; no reorder recommended.";
  }
  if (row.days_of_supply === null) {
    return "No action needed.";
  }
  return `No action needed; stock covers about ${row.days_of_supply} days.`;
}

function analyzeProduct(product, settings, forecastEntry, modifiers) {
  const demandMultiplier = modifiers.demand_multiplier || 1;
  const leadDelta = modifiers.lead_time_delta_days || 0;
  const daily = forecastEntry.daily.map((point) => ({
    date: point.date,
    units: Math.max(0, point.units * demandMultiplier),
  }));

  const onHand = Math.max(0, Math.round(Number(product.on_hand) || 0));
  const avgDaily = mean(daily.slice(0, 30).map((point) => point.units));
  const leadTime = Math.max(0, settings.lead_time_days + leadDelta);
  const safetyStockUnits = Math.ceil(avgDaily * settings.safety_stock_days);
  const reorderPoint = Math.ceil(avgDaily * leadTime + safetyStockUnits);
  const targetLevel = Math.ceil(avgDaily * (leadTime + REVIEW_PERIOD_DAYS) + safetyStockUnits);
  const rawRecommended = Math.max(0, targetLevel - onHand);
  const recommendedQty =
    rawRecommended > 0
      ? Math.max(settings.min_order_qty, Math.ceil(rawRecommended / settings.case_pack) * settings.case_pack)
      : 0;

  const days = daysToStockout(daily, onHand);
  let riskLevel = "OK";
  if (onHand <= 0) {
    riskLevel = avgDaily > 0 ? "OUT" : "NO_DEMAND";
  } else if (days !== null && days <= leadTime) {
    riskLevel = "CRITICAL";
  } else if (days !== null && days <= leadTime + settings.safety_stock_days) {
    riskLevel = "WARNING";
  }

  const daysOfSupply = avgDaily > 0 ? round(onHand / avgDaily, 1) : null;
  const overstock =
    onHand > 0 &&
    (avgDaily === 0 || (daysOfSupply !== null && daysOfSupply > settings.overstock_days));
  const excessUnits = overstock
    ? Math.max(0, onHand - Math.ceil(avgDaily * settings.overstock_days))
    : 0;

  const row = {
    sku_id: product.sku_id,
    name: product.name,
    status: product.status || null,
    location_code: product.location_code || null,
    on_hand: onHand,
    avg_daily_demand: round(avgDaily, 3),
    forecast_7d: round(daily.slice(0, 7).reduce((sum, point) => sum + point.units, 0), 2),
    forecast_14d: round(daily.slice(0, 14).reduce((sum, point) => sum + point.units, 0), 2),
    forecast_30d: round(daily.slice(0, 30).reduce((sum, point) => sum + point.units, 0), 2),
    lead_time_days: leadTime,
    base_lead_time_days: settings.lead_time_days,
    lead_time_delta_days: leadDelta,
    safety_stock_days: settings.safety_stock_days,
    safety_stock_units: safetyStockUnits,
    overstock_days: settings.overstock_days,
    min_order_qty: settings.min_order_qty,
    case_pack: settings.case_pack,
    reorder_point: reorderPoint,
    target_level: targetLevel,
    recommended_qty: recommendedQty,
    days_to_stockout: days,
    stockout_date: days === null ? null : days === 0 ? todayUtc() : addDays(todayUtc(), days),
    risk_level: riskLevel,
    at_risk: riskLevel === "OUT" || riskLevel === "CRITICAL" || riskLevel === "WARNING",
    overstock,
    days_of_supply: daysOfSupply,
    excess_units: excessUnits,
    settings_source: settings.settings_source,
    supplier_name: settings.supplier_name,
  };
  row.recommendation = recommendationFor(row);
  row.reason = `Predicted demand ${row.avg_daily_demand}/day; on hand ${onHand}; lead time ${leadTime}d; safety stock ${safetyStockUnits} units; reorder point ${reorderPoint}.`;
  return row;
}

function buildAnalysis({ products, settings, forecasts, modifiers = {} }) {
  const rows = [];
  for (const product of products) {
    const forecastEntry = forecasts[product.sku_id];
    if (!forecastEntry || !forecastEntry.daily || !forecastEntry.daily.length) continue;
    const productSettings = normalizeSettings(settings[product.sku_id]);
    rows.push(analyzeProduct(product, productSettings, forecastEntry, modifiers));
  }
  rows.sort((a, b) => {
    const riskDiff = (RISK_ORDER[a.risk_level] ?? 9) - (RISK_ORDER[b.risk_level] ?? 9);
    if (riskDiff !== 0) return riskDiff;
    const aDays = a.days_to_stockout === null ? Infinity : a.days_to_stockout;
    const bDays = b.days_to_stockout === null ? Infinity : b.days_to_stockout;
    return aDays - bDays;
  });

  const summary = {
    skus: rows.length,
    at_risk: rows.filter((row) => row.at_risk).length,
    out: rows.filter((row) => row.risk_level === "OUT").length,
    critical: rows.filter((row) => row.risk_level === "CRITICAL").length,
    warning: rows.filter((row) => row.risk_level === "WARNING").length,
    overstock: rows.filter((row) => row.overstock).length,
    recommended_units: rows.reduce((sum, row) => sum + row.recommended_qty, 0),
  };
  return { rows, summary };
}

function simulate({ products, settings, forecasts, modifiers = {} }) {
  const baseline = buildAnalysis({ products, settings, forecasts, modifiers: {} });
  const scenario = buildAnalysis({ products, settings, forecasts, modifiers });
  const baselineBySku = new Map(baseline.rows.map((row) => [row.sku_id, row]));
  const changes = scenario.rows.map((row) => {
    const before = baselineBySku.get(row.sku_id);
    return {
      sku_id: row.sku_id,
      name: row.name,
      risk_before: before ? before.risk_level : null,
      risk_after: row.risk_level,
      days_before: before ? before.days_to_stockout : null,
      days_after: row.days_to_stockout,
      recommended_before: before ? before.recommended_qty : null,
      recommended_after: row.recommended_qty,
      on_hand: row.on_hand,
      overstock: row.overstock,
    };
  });
  return {
    baseline_summary: baseline.summary,
    scenario_summary: scenario.summary,
    delta: {
      at_risk: scenario.summary.at_risk - baseline.summary.at_risk,
      critical: scenario.summary.critical - baseline.summary.critical,
      recommended_units: scenario.summary.recommended_units - baseline.summary.recommended_units,
      overstock: scenario.summary.overstock - baseline.summary.overstock,
    },
    rows: scenario.rows,
    changes,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  REVIEW_PERIOD_DAYS,
  buildAnalysis,
  normalizeSettings,
  simulate,
};

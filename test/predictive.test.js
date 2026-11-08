"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { addDays, chooseModel, evaluate, fillSeries, forecast } = require("../lib/predictive/models");
const { buildAnalysis, normalizeSettings, simulate } = require("../lib/predictive/engine");

function makeSeries(days, valueForDay) {
  const start = "2026-01-01";
  return Array.from({ length: days }, (_, index) => ({
    date: addDays(start, index),
    units: valueForDay(index, addDays(start, index)),
  }));
}

function forecastEntry(dailyUnits = 1) {
  const daily = makeSeries(90, () => dailyUnits);
  return { daily, data_source: "TEST", model: { name: "test", label: "Test" } };
}

test("fillSeries zero-fills missing dates", () => {
  const series = fillSeries([{ date: "2026-01-03", units: 2 }], "2026-01-05", 5);
  assert.deepEqual(
    series.map((point) => point.units),
    [0, 0, 2, 0, 0],
  );
  assert.equal(series[0].date, "2026-01-01");
  assert.equal(series[4].date, "2026-01-05");
});

test("moving-average forecast is flat for a constant series", () => {
  const series = makeSeries(60, () => 2);
  const output = forecast(series, 30, "moving_average");
  assert.equal(output.total, 60);
  assert.ok(output.daily.every((point) => point.units === 2));
});

test("seasonal model gives weekends a higher factor", () => {
  const series = makeSeries(90, (index, date) => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    return dow === 0 || dow === 6 ? 4 : 1;
  });
  const output = forecast(series, 14, "seasonal_trend");
  const weekends = output.daily.filter((point) => {
    const dow = new Date(`${point.date}T00:00:00Z`).getUTCDay();
    return dow === 0 || dow === 6;
  });
  const weekdays = output.daily.filter((point) => {
    const dow = new Date(`${point.date}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6;
  });
  assert.ok(weekends.length > 0 && weekdays.length > 0);
  assert.ok(Math.min(...weekends.map((point) => point.units)) > Math.max(...weekdays.map((point) => point.units)));
});

test("evaluate reports zero error for a constant series", () => {
  const series = makeSeries(60, () => 3);
  const result = evaluate(series, 14, "moving_average");
  assert.equal(result.mae, 0);
  assert.equal(result.wape, 0);
});

test("model selection uses seasonal trend for long non-zero history", () => {
  const series = makeSeries(90, () => 1);
  assert.equal(chooseModel(series).name, "seasonal_trend");
  assert.equal(chooseModel(makeSeries(10, () => 1)).name, "moving_average");
});

test("normalizeSettings applies defaults", () => {
  const settings = normalizeSettings();
  assert.equal(settings.lead_time_days, 7);
  assert.equal(settings.safety_stock_days, 5);
  assert.equal(settings.case_pack, 1);
  assert.equal(settings.settings_source, "DEFAULT");
});

test("engine flags a product that runs out inside the lead time", () => {
  const analysis = buildAnalysis({
    products: [{ sku_id: "A", name: "A", on_hand: 5 }],
    settings: { A: { lead_time_days: 7, safety_stock_days: 2 } },
    forecasts: { A: forecastEntry(1) },
  });
  const row = analysis.rows[0];
  assert.equal(row.days_to_stockout, 5);
  assert.equal(row.risk_level, "CRITICAL");
  assert.equal(row.recommended_qty, 34);
  assert.equal(row.reorder_point, 9);
});

test("engine detects overstock with low demand", () => {
  const analysis = buildAnalysis({
    products: [{ sku_id: "B", name: "B", on_hand: 100 }],
    settings: { B: { lead_time_days: 3, safety_stock_days: 5, overstock_days: 60 } },
    forecasts: { B: forecastEntry(0.1) },
  });
  const row = analysis.rows[0];
  assert.equal(row.overstock, true);
  assert.ok(row.days_of_supply > 60);
  assert.equal(row.recommended_qty, 0);
});

test("engine flags a single unit with very low demand as overstock", () => {
  const analysis = buildAnalysis({
    products: [{ sku_id: "D", name: "D", on_hand: 1 }],
    settings: { D: { lead_time_days: 7, safety_stock_days: 5, overstock_days: 60 } },
    forecasts: { D: forecastEntry(0.001) },
  });
  assert.equal(analysis.rows[0].overstock, true);
});

test("simulation raises recommended units when demand increases", () => {
  const products = [{ sku_id: "C", name: "C", on_hand: 5 }];
  const settings = { C: { lead_time_days: 7, safety_stock_days: 2 } };
  const forecasts = { C: forecastEntry(1) };
  const result = simulate({
    products,
    settings,
    forecasts,
    modifiers: { demand_multiplier: 1.3, lead_time_delta_days: 0 },
  });
  assert.ok(result.scenario_summary.recommended_units > result.baseline_summary.recommended_units);
  assert.equal(result.changes[0].sku_id, "C");
});

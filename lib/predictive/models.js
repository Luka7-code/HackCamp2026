"use strict";

// Daily series are arrays of { date: "YYYY-MM-DD", units: number }, oldest first.

const DAY_MS = 24 * 60 * 60 * 1000;

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  return Math.round((new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / DAY_MS);
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fillSeries(points, endDate, days) {
  const byDate = new Map(points.map((point) => [point.date, Number(point.units) || 0]));
  const start = addDays(endDate, -(days - 1));
  return Array.from({ length: days }, (_, index) => {
    const date = addDays(start, index);
    return { date, units: byDate.get(date) || 0 };
  });
}

// ---------- models ----------

function movingAverageForecast(series, horizon) {
  const base = mean(series.slice(-14).map((point) => point.units));
  const lastDate = series.length ? series[series.length - 1].date : addDays(todayUtc(), -1);
  return Array.from({ length: horizon }, (_, index) => ({
    date: addDays(lastDate, index + 1),
    units: base,
  }));
}

function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (index - xMean) * (values[index] - yMean);
    denominator += (index - xMean) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function seasonalTrendForecast(series, horizon) {
  const recent = series.slice(-56);
  const base = mean(series.slice(-28).map((point) => point.units));
  const slope = Math.max(-0.05 * base, Math.min(0.05 * base, linearSlope(recent.map((p) => p.units)) * 0.5));

  const overall = mean(recent.map((point) => point.units));
  const byDow = Array.from({ length: 7 }, () => []);
  for (const point of recent) {
    const dow = new Date(`${point.date}T00:00:00Z`).getUTCDay();
    byDow[dow].push(point.units);
  }
  const factors = byDow.map((values) => {
    if (!values.length || overall <= 0) return 1;
    const raw = mean(values) / overall;
    return Math.min(1.8, Math.max(0.5, 0.7 * raw + 0.3));
  });

  const lastDate = series.length ? series[series.length - 1].date : addDays(todayUtc(), -1);
  return Array.from({ length: horizon }, (_, index) => {
    const date = addDays(lastDate, index + 1);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const trended = Math.max(0, base + slope * (index + 1));
    return { date, units: Math.max(0, trended * factors[dow]) };
  });
}

const MODELS = {
  moving_average: {
    name: "moving_average",
    label: "14-day moving average",
    forecast: movingAverageForecast,
  },
  seasonal_trend: {
    name: "seasonal_trend",
    label: "Seasonal trend (day-of-week + trend)",
    forecast: seasonalTrendForecast,
  },
};

function chooseModel(series) {
  const nonZero = series.filter((point) => point.units > 0).length;
  if (series.length >= 60 && nonZero >= 21) return MODELS.seasonal_trend;
  return MODELS.moving_average;
}

function forecast(series, horizon = 30, modelName = null) {
  const model = modelName ? MODELS[modelName] : chooseModel(series);
  if (!model) throw new Error(`Unknown model: ${modelName}`);
  const daily = model.forecast(series, horizon);
  const total = daily.reduce((sum, point) => sum + point.units, 0);
  return {
    model: { name: model.name, label: model.label },
    daily,
    total: round(total, 2),
  };
}

function evaluate(series, holdout = 14, modelName = null) {
  if (series.length < holdout + 14) {
    return { model: null, mae: null, wape: null, n_days: 0 };
  }
  const train = series.slice(0, -holdout);
  const test = series.slice(-holdout);
  const model = modelName ? MODELS[modelName] : chooseModel(train);
  const predictions = model.forecast(train, test.length);
  let absoluteError = 0;
  let actualSum = 0;
  let errorSum = 0;
  for (let index = 0; index < test.length; index += 1) {
    const error = Math.abs(predictions[index].units - test[index].units);
    absoluteError += error;
    errorSum += error;
    actualSum += test[index].units;
  }
  return {
    model: { name: model.name, label: model.label },
    mae: round(absoluteError / test.length, 3),
    wape: actualSum > 0 ? round(errorSum / actualSum, 3) : null,
    n_days: test.length,
  };
}

module.exports = {
  MODELS,
  addDays,
  chooseModel,
  daysBetween,
  evaluate,
  fillSeries,
  forecast,
  mean,
  round,
  std,
  todayUtc,
};

"use strict";

const fs = require("fs");
const path = require("path");

const ARTIFACT_DIR = path.join(__dirname, "..", "..", "ml", "artifacts");
const cache = new Map();

function load(name) {
  const file = path.join(ARTIFACT_DIR, name);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    cache.set(file, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch (err) {
    console.error(`Could not parse ML artifact ${file}:`, err.message);
    return null;
  }
}

module.exports = {
  artifactDir: ARTIFACT_DIR,
  loadAppForecasts: () => load("app_forecasts.json"),
  loadDatasetReport: () => load("dataset_report.json"),
  loadManifest: () => load("dataset_manifest.json"),
  loadMetrics: () => load("metrics.json"),
  loadPatterns: () => load("demand_patterns.json"),
};

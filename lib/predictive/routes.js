"use strict";

const express = require("express");
const { createStore } = require("./store");

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function createPredictiveRouter({ query, managerOnly }) {
  const router = express.Router();
  const store = createStore(query);
  const requireManager =
    managerOnly ||
    ((req, res, next) => (req.role === "manager" ? next() : res.status(403).json({ error: "Managers only" })));

  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(err);
      res.status(err.status || 500).json({ error: err.message });
    });

  router.get(
    "/dashboard",
    wrap(async (req, res) => {
      res.json(await store.getDashboard({ refresh: req.query.refresh === "1" }));
    }),
  );

  router.get(
    "/forecast",
    wrap(async (req, res) => {
      const dashboard = await store.getDashboard();
      res.json(dashboard.forecasts);
    }),
  );

  router.get(
    "/forecast/:sku",
    wrap(async (req, res) => {
      const horizon = Math.max(1, Math.min(90, Number(req.query.horizon) || 30));
      const result = await store.getForecast(req.params.sku, horizon);
      if (!result) return res.status(404).json({ error: "Unknown SKU" });
      res.json(result);
    }),
  );

  router.get(
    "/stockouts",
    wrap(async (req, res) => {
      res.json(await store.getStockouts());
    }),
  );

  router.get(
    "/restock",
    wrap(async (req, res) => {
      res.json(await store.getRestock());
    }),
  );

  router.get(
    "/overstock",
    wrap(async (req, res) => {
      res.json(await store.getOverstock());
    }),
  );

  router.post(
    "/simulate",
    wrap(async (req, res) => {
      const { demand_change_pct, lead_time_delta_days } = req.body || {};
      if (demand_change_pct !== undefined && !Number.isFinite(Number(demand_change_pct))) {
        throw badRequest("demand_change_pct must be a number");
      }
      if (lead_time_delta_days !== undefined && !Number.isFinite(Number(lead_time_delta_days))) {
        throw badRequest("lead_time_delta_days must be a number");
      }
      res.json(await store.simulate({ demand_change_pct, lead_time_delta_days }));
    }),
  );

  router.post(
    "/run",
    requireManager,
    wrap(async (req, res) => {
      res.json(await store.runSnapshot(req.employee));
    }),
  );

  router.post(
    "/restock/review",
    requireManager,
    wrap(async (req, res) => {
      res.json(await store.saveReview(req.body || {}, req.employee));
    }),
  );

  router.get(
    "/restock/reviews",
    requireManager,
    wrap(async (req, res) => {
      res.json(await store.listReviews(req.query.limit));
    }),
  );

  router.patch(
    "/settings/:sku",
    requireManager,
    wrap(async (req, res) => {
      res.json(await store.updateSettings(req.params.sku, req.body || {}, req.employee));
    }),
  );

  router.post(
    "/refresh",
    requireManager,
    wrap(async (req, res) => {
      if (req.query.reload_ml === "1") await store.reloadMl();
      res.json(await store.getDashboard({ refresh: true }));
    }),
  );

  return router;
}

module.exports = { createPredictiveRouter };

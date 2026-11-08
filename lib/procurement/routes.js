"use strict";

const express = require("express");
const { loadConfig } = require("./config");
const { createProcurementServices } = require("./services");
const { TRANSITIONS, computeTotal, httpError } = require("./validation");

const SUPPLIER_INTENT_TEXT = {
  CONFIRM: "CONFIRM",
  DECLINE: "DECLINE",
  BACKORDER: "BACKORDER",
  PRICE_CHANGED: "PRICE CHANGED",
  DELAYED: "DELAYED",
};

function createProcurementRouter({ query, managerOnly, config = loadConfig(process.env) }) {
  const router = express.Router();
  const services = createProcurementServices({ query, config });
  const { store, orchestrator } = services;

  const requireManager =
    managerOnly ||
    ((req, res, next) => (req.role === "manager" ? next() : res.status(403).json({ error: "Managers only" })));

  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(err);
      res.status(err.status || 500).json({ error: err.message, code: err.code || "INTERNAL" });
    });

  router.use((req, res, next) => {
    if (!config.enabled) {
      return res.status(503).json({ error: "Procurement is disabled.", code: "PROCUREMENT_DISABLED" });
    }
    next();
  });
  router.use(requireManager);

  // ---------- overview ----------

  router.get(
    "/summary",
    wrap(async (req, res) => {
      res.json(await orchestrator.summary());
    }),
  );

  router.get(
    "/settings",
    wrap(async (req, res) => {
      res.json({
        settings: await orchestrator.getSettings(),
        absolute_max_amount: config.absoluteMaxAmount,
        email_configured: services.email.configured,
        gemini_configured: services.gemini.enabled,
      });
    }),
  );

  router.patch(
    "/settings",
    wrap(async (req, res) => {
      const settings = await store.updateSettings(req.body || {}, req.employee, config.defaults);
      res.json({ settings, absolute_max_amount: config.absoluteMaxAmount });
    }),
  );

  // ---------- suppliers ----------

  router.get(
    "/suppliers",
    wrap(async (req, res) => {
      res.json(await store.listSuppliers());
    }),
  );

  router.post(
    "/suppliers",
    wrap(async (req, res) => {
      res.status(201).json(await store.createSupplier(req.body || {}, req.employee));
    }),
  );

  router.patch(
    "/suppliers/:id",
    wrap(async (req, res) => {
      res.json(await store.updateSupplier(req.params.id, req.body || {}, req.employee));
    }),
  );

  // ---------- products ----------

  router.get(
    "/products",
    wrap(async (req, res) => {
      res.json(await orchestrator.products());
    }),
  );

  router.patch(
    "/products/:sku",
    wrap(async (req, res) => {
      const product = await store.upsertProductProcurement(req.params.sku, req.body || {}, req.employee);
      if (!product) throw httpError(404, "UNKNOWN_SKU", "Unknown SKU.");
      res.json(product);
    }),
  );

  // ---------- recommendations and automation ----------

  router.get(
    "/recommendations",
    wrap(async (req, res) => {
      res.json(await orchestrator.recommendations());
    }),
  );

  router.post(
    "/run",
    wrap(async (req, res) => {
      const body = req.body || {};
      const result = await orchestrator.detect({
        actor: req.employee,
        actorType: "HUMAN",
        limit: body.limit,
        idempotencyKey: body.idempotency_key || req.get("Idempotency-Key"),
      });
      res.json(result);
    }),
  );

  // ---------- purchase orders ----------

  router.get(
    "/purchase-orders",
    wrap(async (req, res) => {
      res.json(
        await store.listPOs({
          status: req.query.status,
          sku_id: req.query.sku_id,
          limit: req.query.limit,
        }),
      );
    }),
  );

  router.post(
    "/purchase-orders",
    wrap(async (req, res) => {
      const body = req.body || {};
      const result = await orchestrator.createPORequest({
        ...body,
        actor: req.employee,
        idempotency_key: body.idempotency_key || req.get("Idempotency-Key"),
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    }),
  );

  router.get(
    "/purchase-orders/:id",
    wrap(async (req, res) => {
      const po = await store.getPO(req.params.id);
      if (!po) throw httpError(404, "PO_NOT_FOUND", "Order not found.");
      const [logs, emails] = await Promise.all([
        store.listLogs(po.po_id, 100),
        store.listEmails({ poId: po.po_id, limit: 100 }),
      ]);
      res.json({ po, logs, emails, allowed_transitions: TRANSITIONS[po.status] || [] });
    }),
  );

  router.patch(
    "/purchase-orders/:id",
    wrap(async (req, res) => {
      const po = await store.getPO(req.params.id);
      if (!po) throw httpError(404, "PO_NOT_FOUND", "Order not found.");
      if (!["PENDING_APPROVAL", "NEEDS_HUMAN_REVIEW"].includes(po.status)) {
        throw httpError(409, "INVALID_TRANSITION", `Order is ${po.status} and cannot be edited.`);
      }

      const body = req.body || {};
      const patch = {};

      if (body.quantity !== undefined) {
        const quantity = Math.round(Number(body.quantity));
        if (!Number.isInteger(quantity) || quantity <= 0) {
          throw httpError(400, "INVALID_QUANTITY", "Quantity must be a positive whole number.");
        }
        patch.quantity = quantity;
      }
      if (body.unit_cost !== undefined) {
        if (body.unit_cost === "" || body.unit_cost === null) {
          patch.unit_cost = null;
        } else {
          const unitCost = Number(body.unit_cost);
          if (!Number.isFinite(unitCost) || unitCost < 0) {
            throw httpError(400, "INVALID_UNIT_COST", "unit_cost must be a non-negative number.");
          }
          patch.unit_cost = unitCost;
        }
      }
      if (body.supplier_id !== undefined) {
        const supplier = body.supplier_id ? await store.getSupplier(body.supplier_id) : null;
        if (body.supplier_id && !supplier) throw httpError(400, "UNKNOWN_SUPPLIER", "Unknown supplier_id.");
        patch.supplier_id = supplier ? supplier.supplier_id : null;
        patch.supplier_name = supplier ? supplier.name : "";
        patch.supplier_email = supplier ? supplier.email : "";
      }
      if (body.destination_location !== undefined) {
        patch.destination_location = String(body.destination_location || "");
      }
      if (body.expected_delivery_date !== undefined) {
        patch.expected_delivery_date = body.expected_delivery_date || null;
      }
      if (body.notes !== undefined) patch.notes = String(body.notes || "");

      const nextQuantity = patch.quantity !== undefined ? patch.quantity : po.quantity;
      const nextUnitCost = patch.unit_cost !== undefined ? patch.unit_cost : po.unit_cost;
      patch.total_cost = computeTotal(nextQuantity, nextUnitCost);

      const updated = await store.updatePO(po.po_id, patch, req.employee);
      await store.addLog({
        po_id: po.po_id,
        sku_id: po.sku_id,
        event_type: "PO_UPDATED",
        from_status: po.status,
        to_status: po.status,
        actor: req.employee,
        actor_type: "HUMAN",
        message: "Order edited before approval.",
        details: patch,
      });
      res.json({ po: updated });
    }),
  );

  router.post(
    "/purchase-orders/:id/evaluate",
    wrap(async (req, res) => {
      res.json(await orchestrator.evaluate({ poId: req.params.id, actor: req.employee }));
    }),
  );

  router.post(
    "/purchase-orders/:id/approve",
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(
        await orchestrator.approve({
          poId: req.params.id,
          approvedQuantity: body.approved_quantity,
          note: body.note,
          overrideBudget: Boolean(body.override_budget),
          actor: req.employee,
        }),
      );
    }),
  );

  router.post(
    "/purchase-orders/:id/reject",
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(
        await orchestrator.reject({
          poId: req.params.id,
          reason: body.reason || body.note,
          actor: req.employee,
        }),
      );
    }),
  );

  router.post(
    "/purchase-orders/:id/send",
    wrap(async (req, res) => {
      res.json(await orchestrator.send({ poId: req.params.id, actor: req.employee }));
    }),
  );

  router.post(
    "/purchase-orders/:id/supplier-response",
    wrap(async (req, res) => {
      const body = req.body || {};
      const po = await store.getPO(req.params.id);
      if (!po) throw httpError(404, "PO_NOT_FOUND", "Order not found.");

      const intent = String(body.intent || "").toUpperCase();
      const text = body.body || SUPPLIER_INTENT_TEXT[intent] || "";
      const fromEmail = body.from_email || (intent ? po.supplier_email : "");

      res.json(
        await orchestrator.processSupplierResponse({
          poId: req.params.id,
          fromEmail,
          subject: body.subject || `Re: ${po.po_number}`,
          body: text,
          actor: req.employee,
        }),
      );
    }),
  );

  router.post(
    "/purchase-orders/:id/receive",
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(
        await orchestrator.receive({
          poId: req.params.id,
          receivedQuantity: body.received_quantity,
          locationCode: body.location_code,
          note: body.note,
          actor: req.employee,
        }),
      );
    }),
  );

  router.post(
    "/purchase-orders/:id/cancel",
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(
        await orchestrator.cancel({
          poId: req.params.id,
          reason: body.reason || body.note,
          actor: req.employee,
        }),
      );
    }),
  );

  // ---------- logs ----------

  router.get(
    "/emails",
    wrap(async (req, res) => {
      res.json(await store.listEmails({ poId: req.query.po_id, limit: req.query.limit }));
    }),
  );

  router.get(
    "/logs",
    wrap(async (req, res) => {
      res.json(await store.listLogs(req.query.po_id, req.query.limit));
    }),
  );

  return router;
}

module.exports = { createProcurementRouter };

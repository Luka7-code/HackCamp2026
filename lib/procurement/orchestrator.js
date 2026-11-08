"use strict";

const crypto = require("crypto");
const {
  checkFinancialCaps,
  classifySupplierReply,
  computeTotal,
  decideApproval,
  formatPoNumber,
  httpError,
  round,
  sanitizeText,
} = require("./validation");
const { buildPoEmail } = require("./templates");

const RISK_ORDER = { OUT: 0, CRITICAL: 1, WARNING: 2, OK: 3, NO_DEMAND: 4 };
const REVIEW_STATUSES = ["PENDING_APPROVAL", "NEEDS_HUMAN_REVIEW"];
const TERMINAL_STATUSES = ["RECEIVED", "REJECTED", "CANCELLED"];

function createProcurementOrchestrator({ store, predictiveStore, config, gemini, email, now = () => new Date() }) {
  function defaults() {
    return config.defaults;
  }

  function getSettings() {
    return store.getSettings(defaults());
  }

  function pickSupplier(product, recommendation, suppliers) {
    if (product && product.supplier_id) {
      const linked = suppliers.find((supplier) => supplier.supplier_id === product.supplier_id);
      if (linked && linked.active) return linked;
    }
    const name = String((product && product.supplier_name) || (recommendation && recommendation.supplier_name) || "")
      .trim()
      .toLowerCase();
    if (name) {
      const byName = suppliers.find(
        (supplier) => supplier.active && String(supplier.name || "").trim().toLowerCase() === name,
      );
      if (byName) return byName;
    }
    return null;
  }

  async function loadRecommendation(skuId) {
    const dashboard = await predictiveStore.getDashboard();
    const row = (dashboard.all || []).find((item) => item.sku_id === skuId);
    if (!row) throw httpError(404, "UNKNOWN_SKU", "Unknown SKU in the inventory forecast.");
    return row;
  }

  async function buildPOFromRecommendation(recommendation, supplier, product, actor, idempotencyKey, settings) {
    const quantity = Number(recommendation.recommended_qty);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw httpError(400, "INVALID_QUANTITY", "Recommended quantity must be a positive whole number.");
    }

    const unitCost = product && product.unit_cost != null ? Number(product.unit_cost) : null;
    const totalCost = computeTotal(quantity, unitCost);
    const poId = crypto.randomUUID();
    const poNumber = formatPoNumber(now(), crypto.randomBytes(3).toString("hex").toUpperCase());

    return store.createPO({
      po_id: poId,
      po_number: poNumber,
      sku_id: recommendation.sku_id,
      sku_name: recommendation.name || "",
      supplier_id: supplier ? supplier.supplier_id : null,
      supplier_name: supplier ? supplier.name : recommendation.supplier_name || "",
      supplier_email: supplier ? supplier.email : "",
      quantity,
      approved_quantity: null,
      unit_cost: unitCost,
      total_cost: totalCost,
      currency: settings.currency || config.defaultCurrency,
      status: "PENDING_APPROVAL",
      approval_mode: settings.approval_mode,
      recommendation_run_id: recommendation.run_id || "",
      idempotency_key: idempotencyKey || "",
      expected_delivery_date: null,
      destination_location: (product && product.default_destination_location) || "",
      notes: "",
      created_by: actor || "system",
    });
  }

  async function refreshMissingTerms(po, actor) {
    if (po.supplier_email && po.unit_cost != null) return po;

    const product = await store.getProductProcurement(po.sku_id);
    const suppliers = await store.listSuppliers();
    const supplier = pickSupplier(product, po, suppliers);
    const patch = {};

    if (!po.supplier_email && supplier) {
      patch.supplier_id = supplier.supplier_id;
      patch.supplier_name = supplier.name;
      patch.supplier_email = supplier.email;
    }
    if (po.unit_cost == null && product && product.unit_cost != null) {
      patch.unit_cost = product.unit_cost;
      patch.total_cost = computeTotal(po.quantity, product.unit_cost);
    }

    if (!Object.keys(patch).length) return po;

    const updated = await store.updatePO(po.po_id, patch, actor || "system");
    await store.addLog({
      po_id: po.po_id,
      sku_id: po.sku_id,
      event_type: "PO_TERMS_REFRESHED",
      from_status: po.status,
      to_status: po.status,
      actor: actor || "system",
      actor_type: "SYSTEM",
      message: "Filled missing supplier/cost from the current product configuration.",
      details: patch,
    });
    return updated;
  }

  async function detect({ actor, actorType = "SYSTEM", limit = 20, idempotencyKey } = {}) {
    const cached = await store.getIdempotentResponse(idempotencyKey, "run");
    if (cached) return cached;

    const dashboard = await predictiveStore.getDashboard();
    const settings = await getSettings();
    const suppliers = await store.listSuppliers();
    const requestedLimit = Math.max(1, Math.min(50, Math.round(Number(limit) || 20)));
    const candidates = (dashboard.restock || [])
      .filter((row) => Number(row.recommended_qty) > 0)
      .sort((a, b) => (RISK_ORDER[a.risk_level] ?? 9) - (RISK_ORDER[b.risk_level] ?? 9))
      .slice(0, requestedLimit);

    const created = [];
    let duplicates = 0;
    let skipped = 0;

    for (const recommendation of candidates) {
      const active = await store.findActivePO(recommendation.sku_id);
      if (active) {
        duplicates += 1;
        continue;
      }

      const product = await store.getProductProcurement(recommendation.sku_id);
      const supplier = pickSupplier(product, recommendation, suppliers);
      if (!supplier || !product || product.unit_cost == null) {
        skipped += 1;
        await store.addLog({
          po_id: "",
          sku_id: recommendation.sku_id,
          event_type: "PO_SKIPPED",
          actor: actor || "automation",
          actor_type: actorType,
          message: "No supplier or unit cost configured for this SKU.",
        });
        continue;
      }
      try {
        const po = await buildPOFromRecommendation(
          recommendation,
          supplier,
          product,
          actor || "automation",
          null,
          settings,
        );
        await store.addLog({
          po_id: po.po_id,
          sku_id: po.sku_id,
          event_type: "PO_CREATED",
          from_status: "",
          to_status: "PENDING_APPROVAL",
          actor: actor || "automation",
          actor_type: actorType,
          message: `Created from restock recommendation (${recommendation.risk_level}).`,
        });
        created.push(po);
      } catch (error) {
        skipped += 1;
        await store.addLog({
          po_id: "",
          sku_id: recommendation.sku_id,
          event_type: "PO_SKIPPED",
          actor: actor || "automation",
          actor_type: actorType,
          message: error.message,
        });
      }
    }

    if (settings.approval_mode === "GEMINI") {
      for (const po of created) {
        try {
          await evaluate({ poId: po.po_id, actor: actor || "automation", actorType: "GEMINI" });
        } catch (error) {
          await store.addLog({
            po_id: po.po_id,
            sku_id: po.sku_id,
            event_type: "AUTO_EVALUATION_FAILED",
            actor: actor || "automation",
            actor_type: actorType,
            message: error.message,
          });
        }
      }
    }

    for (let index = 0; index < created.length; index += 1) {
      const fresh = await store.getPO(created[index].po_id);
      if (fresh) created[index] = fresh;
    }

    const result = {
      run_at: now().toISOString(),
      created: created.length,
      duplicates,
      skipped,
      purchase_orders: created.map((po) => ({ po_id: po.po_id, sku_id: po.sku_id, status: po.status })),
    };
    await store.saveIdempotentResponse(idempotencyKey, "run", null, result);
    return result;
  }

  async function createPORequest({
    sku_id: skuId,
    quantity,
    supplier_id: supplierId,
    unit_cost: unitCostInput,
    destination_location: destination,
    expected_delivery_date: deliveryDate,
    notes,
    idempotency_key: idempotencyKey,
    actor,
  }) {
    const cached = await store.getIdempotentResponse(idempotencyKey, "create");
    if (cached) return cached;

    if (!skuId) throw httpError(400, "SKU_REQUIRED", "sku_id is required.");
    const recommendation = await loadRecommendation(skuId);
    const settings = await getSettings();
    const suppliers = await store.listSuppliers();
    const product = await store.getProductProcurement(skuId);

    let supplier = null;
    if (supplierId) {
      supplier = await store.getSupplier(supplierId);
      if (!supplier) throw httpError(400, "UNKNOWN_SUPPLIER", "Unknown supplier_id.");
    } else {
      supplier = pickSupplier(product, recommendation, suppliers);
    }

    const finalQuantity =
      quantity === undefined || quantity === null || quantity === ""
        ? Number(recommendation.recommended_qty)
        : Math.round(Number(quantity));
    if (!Number.isInteger(finalQuantity) || finalQuantity <= 0) {
      throw httpError(400, "INVALID_QUANTITY", "Quantity must be a positive whole number.");
    }

    const unitCost =
      unitCostInput !== undefined
        ? Number(unitCostInput)
        : product && product.unit_cost != null
          ? Number(product.unit_cost)
          : null;
    if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) {
      throw httpError(400, "INVALID_UNIT_COST", "unit_cost must be a non-negative number.");
    }

    const duplicate = await store.findActivePO(skuId);
    if (duplicate) {
      const payload = { po: duplicate, duplicate: true };
      await store.saveIdempotentResponse(idempotencyKey, "create", duplicate.po_id, payload);
      return payload;
    }

    const poId = crypto.randomUUID();
    const poNumber = formatPoNumber(now(), crypto.randomBytes(3).toString("hex").toUpperCase());
    const po = await store.createPO({
      po_id: poId,
      po_number: poNumber,
      sku_id: skuId,
      sku_name: recommendation.name || "",
      supplier_id: supplier ? supplier.supplier_id : null,
      supplier_name: supplier ? supplier.name : recommendation.supplier_name || "",
      supplier_email: supplier ? supplier.email : "",
      quantity: finalQuantity,
      approved_quantity: null,
      unit_cost: unitCost,
      total_cost: computeTotal(finalQuantity, unitCost),
      currency: settings.currency || config.defaultCurrency,
      status: "PENDING_APPROVAL",
      approval_mode: settings.approval_mode,
      recommendation_run_id: recommendation.run_id || "",
      idempotency_key: idempotencyKey || "",
      expected_delivery_date: deliveryDate || null,
      destination_location: destination || (product && product.default_destination_location) || "",
      notes: notes || "",
      created_by: actor || "manager",
    });

    await store.addLog({
      po_id: po.po_id,
      sku_id: po.sku_id,
      event_type: "PO_CREATED",
      from_status: "",
      to_status: "PENDING_APPROVAL",
      actor: actor || "manager",
      actor_type: "HUMAN",
      message: "Created by manager.",
    });

    const payload = { po, duplicate: false };
    await store.saveIdempotentResponse(idempotencyKey, "create", po.po_id, payload);
    return payload;
  }

  async function evaluate({ poId, actor, actorType = "GEMINI" }) {
    let po = await store.getPO(poId);
    if (!po) throw httpError(404, "PO_NOT_FOUND", "Order not found.");
    if (!REVIEW_STATUSES.includes(po.status)) {
      throw httpError(409, "INVALID_TRANSITION", `Order is ${po.status} and cannot be evaluated.`);
    }
    po = await refreshMissingTerms(po, actor);

    const settings = await getSettings();
    const monthlySpend = await store.getMonthlySpend();
    const budgetRemaining = round(Number(settings.monthly_budget) - monthlySpend);

    const issues = checkFinancialCaps({
      quantity: po.quantity,
      unitCost: po.unit_cost,
      totalCost: po.total_cost,
      supplierEmail: po.supplier_email,
      settings,
      absoluteMaxAmount: config.absoluteMaxAmount,
      budgetRemaining,
    });

    let geminiResult = null;
    const hardCap = issues.some((issue) => issue.code === "ABSOLUTE_CAP_EXCEEDED");
    if (settings.approval_mode === "GEMINI" && !hardCap) {
      geminiResult = await gemini.evaluatePO({
        po,
        settings,
        absoluteMaxAmount: config.absoluteMaxAmount,
        budgetRemaining,
      });
    }

    const decision = decideApproval({
      mode: settings.approval_mode,
      gemini: geminiResult,
      issues,
      totalCost: po.total_cost,
      settings,
    });

    const updated = await store.transitionPO(
      poId,
      REVIEW_STATUSES,
      decision.outcome,
      {
        approval_reason: decision.reason,
        validation_json: JSON.stringify(issues),
        gemini_decision: geminiResult ? geminiResult.decision : null,
        gemini_risk_level: geminiResult ? geminiResult.risk_level : null,
        gemini_reason: geminiResult ? geminiResult.reason : null,
        gemini_response_json: geminiResult && geminiResult.raw ? geminiResult.raw : null,
        actor_type: actorType,
        message: decision.reason,
      },
      actor || "automation",
      decision.outcome === "APPROVED" ? "PO_APPROVED" : decision.outcome === "REJECTED" ? "PO_REJECTED" : "PO_NEEDS_REVIEW",
      { issues, gemini: geminiResult ? { decision: geminiResult.decision, risk_level: geminiResult.risk_level } : null },
    );

    let sent = null;
    if (decision.outcome === "APPROVED" && settings.auto_send_email) {
      try {
        sent = await send({ poId, actor: actor || "automation", actorType: "SYSTEM" });
      } catch (error) {
        await store.addLog({
          po_id: poId,
          sku_id: updated.sku_id,
          event_type: "AUTO_SEND_FAILED",
          actor: actor || "automation",
          actor_type: "SYSTEM",
          message: error.message,
        });
      }
    }

    return { po: sent ? sent.po : updated, decision, issues, gemini: geminiResult };
  }

  async function approve({ poId, approvedQuantity, note, overrideBudget = false, actor }) {
    let po = await store.getPO(poId);
    if (!po) throw httpError(404, "PO_NOT_FOUND", "Order not found.");
    if (!REVIEW_STATUSES.includes(po.status)) {
      throw httpError(409, "INVALID_TRANSITION", `Order is ${po.status} and cannot be approved.`);
    }
    po = await refreshMissingTerms(po, actor);

    const quantity =
      approvedQuantity === undefined || approvedQuantity === null || approvedQuantity === ""
        ? po.quantity
        : Math.round(Number(approvedQuantity));
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw httpError(422, "INVALID_QUANTITY", "Approved quantity must be a positive whole number.");
    }

    const totalCost = computeTotal(quantity, po.unit_cost);
    const settings = await getSettings();
    const monthlySpend = await store.getMonthlySpend();
    const budgetRemaining = round(Number(settings.monthly_budget) - monthlySpend);

    const issues = checkFinancialCaps({
      quantity,
      unitCost: po.unit_cost,
      totalCost,
      supplierEmail: po.supplier_email,
      settings,
      absoluteMaxAmount: config.absoluteMaxAmount,
      budgetRemaining,
    });

    const hardCap = issues.find((issue) => issue.code === "ABSOLUTE_CAP_EXCEEDED");
    if (hardCap) throw httpError(422, hardCap.code, hardCap.message);

    const budgetIssue = issues.find((issue) => issue.code === "BUDGET_EXCEEDED");
    if (budgetIssue && !overrideBudget) throw httpError(422, budgetIssue.code, budgetIssue.message);

    const blocking = issues.find((issue) => issue.code !== "BUDGET_EXCEEDED");
    if (blocking) throw httpError(422, blocking.code, blocking.message);

    const updated = await store.transitionPO(
      poId,
      REVIEW_STATUSES,
      "APPROVED",
      {
        approved_quantity: quantity,
        quantity,
        total_cost: totalCost,
        approved_by: actor || "manager",
        approved_at: "__NOW__",
        approval_mode: settings.approval_mode,
        approval_reason: note || "Approved by manager",
        actor_type: "HUMAN",
        message: budgetIssue ? `${note || "Approved"} (budget override)` : note || "",
      },
      actor || "manager",
      "PO_APPROVED",
      { override_budget: Boolean(budgetIssue && overrideBudget), issues },
    );

    let sent = null;
    if (settings.auto_send_email) {
      try {
        sent = await send({ poId, actor: actor || "manager", actorType: "SYSTEM" });
      } catch (error) {
        await store.addLog({
          po_id: poId,
          sku_id: updated.sku_id,
          event_type: "AUTO_SEND_FAILED",
          actor: actor || "manager",
          actor_type: "SYSTEM",
          message: error.message,
        });
      }
    }

    return { po: sent ? sent.po : updated, issues };
  }

  async function reject({ poId, reason, actor }) {
    const po = await store.getPO(poId);
    if (!po) throw httpError(404, "PO_NOT_FOUND", "Order not found.");
    if (!REVIEW_STATUSES.includes(po.status)) {
      throw httpError(409, "INVALID_TRANSITION", `Order is ${po.status} and cannot be rejected.`);
    }

    const updated = await store.transitionPO(
      poId,
      REVIEW_STATUSES,
      "REJECTED",
      {
        rejected_by: actor || "manager",
        rejected_at: "__NOW__",
        approval_reason: reason || "Rejected by manager",
        actor_type: "HUMAN",
        message: reason || "",
      },
      actor || "manager",
      "PO_REJECTED",
    );
    return { po: updated };
  }

  async function send({ poId, actor, actorType = "HUMAN" }) {
    const po = await store.getPO(poId);
    if (!po) throw httpError(404, "PO_NOT_FOUND", "Order not found.");
    if (po.status === "ORDER_SENT") return { po, already_sent: true };
    if (po.status !== "APPROVED") {
      throw httpError(409, "INVALID_TRANSITION", `Order is ${po.status} and cannot be emailed.`);
    }

    const supplier = po.supplier_id ? await store.getSupplier(po.supplier_id) : null;
    const message = buildPoEmail({ po, supplier, config });

    let result;
    try {
      result = await email.send({
        to: po.supplier_email,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: config.email.replyTo,
      });
    } catch (error) {
      await store.recordOutboundEmail({
        poId,
        fromEmail: config.email.from,
        toEmail: po.supplier_email,
        subject: message.subject,
        bodyText: message.text,
        status: "FAILED",
        errorMessage: error.message,
      });
      await store.addLog({
        po_id: poId,
        sku_id: po.sku_id,
        event_type: "EMAIL_FAILED",
        actor: actor || "manager",
        actor_type: actorType,
        message: error.message,
      });
      throw httpError(error.status || 502, error.code || "EMAIL_SEND_FAILED", error.message);
    }

    const messageId = await store.recordOutboundEmail({
      poId,
      providerMessageId: result.messageId,
      fromEmail: config.email.from,
      toEmail: po.supplier_email,
      subject: message.subject,
      bodyText: message.text,
      status: "SENT",
    });

    const updated = await store.transitionPO(
      poId,
      ["APPROVED"],
      "ORDER_SENT",
      {
        email_status: "SENT",
        email_message_id: messageId,
        actor_type: actorType,
        message: `Email sent to ${po.supplier_email}.`,
      },
      actor || "manager",
      "PO_SENT",
      { provider_message_id: result.messageId },
    );

    return { po: updated, already_sent: false, provider_message_id: result.messageId };
  }

  async function processSupplierResponse({ poId, fromEmail, subject, body, actor }) {
    const po = await store.getPO(poId);
    if (!po) throw httpError(404, "PO_NOT_FOUND", "Order not found.");
    if (TERMINAL_STATUSES.includes(po.status)) {
      throw httpError(409, "INVALID_TRANSITION", `Order is ${po.status}; supplier replies are closed.`);
    }

    const text = sanitizeText(body, 32000);
    const classification = classifySupplierReply(text);
    const sender = String(fromEmail || "").trim().toLowerCase();
    const expected = String(po.supplier_email || "").trim().toLowerCase();
    const senderMatches = Boolean(sender && expected && sender === expected);

    const messageId = await store.recordInboundEmail({
      poId,
      fromEmail: sender,
      toEmail: config.email.from,
      subject: sanitizeText(subject, 200),
      bodyText: text,
      status: "RECORDED",
      rawPayload: "",
    });

    const patch = {
      supplier_response_text: text,
      supplier_response_intent: classification.intent,
    };

    let updated;
    if (!senderMatches) {
      updated = await store.transitionPO(
        poId,
        ["ORDER_SENT", "APPROVED", "ORDER_CONFIRMED", "IN_TRANSIT"],
        "NEEDS_HUMAN_REVIEW",
        {
          ...patch,
          approval_reason: "Supplier reply came from an unregistered sender.",
          actor_type: "SUPPLIER",
          message: `Sender ${sender || "(missing)"} does not match ${expected || "(missing)"}.`,
        },
        "supplier",
        "SUPPLIER_SENDER_MISMATCH",
      );
      return { po: updated, message_id: messageId, intent: classification.intent, sender_match: false };
    }

    if (classification.intent === "CONFIRM") {
      if (po.status === "ORDER_SENT") {
        updated = await store.transitionPO(
          poId,
          ["ORDER_SENT"],
          "ORDER_CONFIRMED",
          {
            ...patch,
            supplier_confirmed_at: "__NOW__",
            actor_type: "SUPPLIER",
            message: "Supplier confirmed the order.",
          },
          "supplier",
          "SUPPLIER_CONFIRMED",
        );
      } else {
        await store.addLog({
          po_id: poId,
          sku_id: po.sku_id,
          event_type: "SUPPLIER_CONFIRMATION_DUPLICATE",
          actor: "supplier",
          actor_type: "SUPPLIER",
          message: "Confirmation received after the order was already confirmed.",
        });
        updated = await store.updatePO(poId, patch, "supplier");
      }
      return { po: updated, message_id: messageId, intent: classification.intent, sender_match: true };
    }

    updated = await store.transitionPO(
      poId,
      ["ORDER_SENT", "APPROVED", "ORDER_CONFIRMED", "IN_TRANSIT"],
      "NEEDS_HUMAN_REVIEW",
      {
        ...patch,
        approval_reason: `Supplier reply classified as ${classification.intent}.`,
        actor_type: "SUPPLIER",
        message: "Supplier reply requires human review.",
      },
      "supplier",
      "SUPPLIER_RESPONSE_REVIEW",
    );
    return { po: updated, message_id: messageId, intent: classification.intent, sender_match: true };
  }

  async function receive({ poId, receivedQuantity, locationCode, note, actor }) {
    const po = await store.getPO(poId);
    if (!po) throw httpError(404, "PO_NOT_FOUND", "Order not found.");
    if (po.status === "RECEIVED") return { po, already_received: true };
    if (!["ORDER_CONFIRMED", "IN_TRANSIT"].includes(po.status)) {
      throw httpError(409, "INVALID_TRANSITION", `Order is ${po.status} and cannot be received.`);
    }
    if (!locationCode) throw httpError(400, "LOCATION_REQUIRED", "location_code is required.");
    if (!(await store.locationExists(locationCode))) throw httpError(400, "UNKNOWN_LOCATION", "Unknown location.");

    const ordered = Number(po.approved_quantity || po.quantity);
    const quantity =
      receivedQuantity === undefined || receivedQuantity === null || receivedQuantity === ""
        ? ordered
        : Math.round(Number(receivedQuantity));
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw httpError(400, "INVALID_QUANTITY", "received_quantity must be a positive whole number.");
    }
    if (quantity !== ordered) {
      throw httpError(400, "PARTIAL_RECEIPT_UNSUPPORTED", "received_quantity must equal the ordered quantity.");
    }

    const updated = await store.transitionPO(
      poId,
      ["ORDER_CONFIRMED", "IN_TRANSIT"],
      "RECEIVED",
      {
        received_quantity: quantity,
        received_at: "__NOW__",
        received_by: actor || "manager",
        receipt_location: locationCode,
        notes: note || po.notes || "",
        actor_type: "HUMAN",
        message: `Received ${quantity} units at ${locationCode}. Stock is added manually.`,
      },
      actor || "manager",
      "PO_RECEIVED",
      { location_code: locationCode, quantity },
    );

    return { po: updated, already_received: false };
  }

  async function cancel({ poId, reason, actor }) {
    const po = await store.getPO(poId);
    if (!po) throw httpError(404, "PO_NOT_FOUND", "Order not found.");
    if (TERMINAL_STATUSES.includes(po.status)) {
      throw httpError(409, "INVALID_TRANSITION", `Order is already ${po.status}.`);
    }
    const updated = await store.transitionPO(
      poId,
      ["DRAFT", "PENDING_APPROVAL", "NEEDS_HUMAN_REVIEW", "APPROVED", "ORDER_SENT", "ORDER_CONFIRMED", "IN_TRANSIT"],
      "CANCELLED",
      {
        cancel_reason: reason || "Cancelled by manager",
        actor_type: "HUMAN",
        message: reason || "",
      },
      actor || "manager",
      "PO_CANCELLED",
    );
    return { po: updated };
  }

  async function recommendations() {
    const dashboard = await predictiveStore.getDashboard();
    const suppliers = await store.listSuppliers();
    const rows = [];

    for (const recommendation of dashboard.restock || []) {
      const product = await store.getProductProcurement(recommendation.sku_id);
      const supplier = pickSupplier(product, recommendation, suppliers);
      const active = await store.findActivePO(recommendation.sku_id);
      rows.push({
        ...recommendation,
        supplier_id: supplier ? supplier.supplier_id : null,
        supplier_name: supplier ? supplier.name : recommendation.supplier_name || null,
        supplier_email: supplier ? supplier.email : null,
        unit_cost: product && product.unit_cost != null ? product.unit_cost : null,
        destination_location: (product && product.default_destination_location) || null,
        active_po_id: active ? active.po_id : null,
        active_po_status: active ? active.status : null,
      });
    }
    return rows;
  }

  async function products() {
    const dashboard = await predictiveStore.getDashboard();
    const suppliers = await store.listSuppliers();
    const rows = [];

    for (const recommendation of dashboard.all || []) {
      const product = await store.getProductProcurement(recommendation.sku_id);
      const supplier = pickSupplier(product, recommendation, suppliers);
      const active = await store.findActivePO(recommendation.sku_id);
      rows.push({
        sku_id: recommendation.sku_id,
        name: recommendation.name,
        on_hand: recommendation.on_hand,
        risk_level: recommendation.risk_level,
        recommended_qty: recommendation.recommended_qty,
        supplier_id: supplier ? supplier.supplier_id : null,
        supplier_name: supplier ? supplier.name : product?.supplier_name || recommendation.supplier_name || null,
        supplier_email: supplier ? supplier.email : null,
        unit_cost: product && product.unit_cost != null ? product.unit_cost : null,
        destination_location: (product && product.default_destination_location) || null,
        active_po_id: active ? active.po_id : null,
        active_po_status: active ? active.status : null,
      });
    }
    return rows;
  }

  async function summary() {
    const [settings, summaryRow] = await Promise.all([getSettings(), store.getSummary()]);
    return { ...summaryRow, settings, email_configured: email.configured, gemini_configured: gemini.enabled };
  }

  return {
    getSettings,
    detect,
    createPORequest,
    evaluate,
    approve,
    reject,
    send,
    processSupplierResponse,
    receive,
    cancel,
    recommendations,
    products,
    summary,
  };
}

module.exports = { createProcurementOrchestrator, REVIEW_STATUSES, TERMINAL_STATUSES };

"use strict";

const crypto = require("crypto");
const { ACTIVE_STATUSES, ALL_STATUSES, httpError, isValidEmail } = require("./validation");

const T = "workspace.wms";

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${T}.suppliers (
     supplier_id STRING, name STRING, email STRING, contact_name STRING, phone STRING,
     lead_time_days INT, active BOOLEAN, notes STRING,
     created_at TIMESTAMP, updated_at TIMESTAMP, updated_by STRING
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.purchase_orders (
     po_id STRING, po_number STRING, sku_id STRING, sku_name STRING,
     supplier_id STRING, supplier_name STRING, supplier_email STRING,
     quantity INT, approved_quantity INT, unit_cost DOUBLE, total_cost DOUBLE, currency STRING,
     status STRING, approval_mode STRING, approval_reason STRING,
     approved_by STRING, approved_at TIMESTAMP, rejected_by STRING, rejected_at TIMESTAMP,
     gemini_decision STRING, gemini_risk_level STRING, gemini_reason STRING,
     gemini_response_json STRING, validation_json STRING,
     recommendation_run_id STRING, idempotency_key STRING,
     email_status STRING, email_message_id STRING,
     supplier_response_text STRING, supplier_response_intent STRING,
     supplier_confirmed_at TIMESTAMP, expected_delivery_date DATE,
     destination_location STRING,
     received_quantity INT, received_at TIMESTAMP, received_by STRING, receipt_location STRING,
     cancel_reason STRING, notes STRING,
     created_at TIMESTAMP, created_by STRING, updated_at TIMESTAMP, updated_by STRING
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.procurement_logs (
     log_id STRING, po_id STRING, sku_id STRING, event_type STRING,
     from_status STRING, to_status STRING,
     actor STRING, actor_type STRING, message STRING, details_json STRING, created_at TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.supplier_email_messages (
     message_id STRING, po_id STRING, direction STRING, transport STRING,
     provider_message_id STRING, from_email STRING, to_email STRING,
     subject STRING, body_text STRING, status STRING, error_message STRING,
     raw_payload STRING, created_at TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.procurement_settings (
     settings_id STRING, approval_mode STRING,
     max_auto_approve_amount DOUBLE, human_threshold_amount DOUBLE,
     monthly_budget DOUBLE, max_po_quantity INT,
     auto_send_email BOOLEAN, currency STRING, updated_at TIMESTAMP, updated_by STRING
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.procurement_product_config (
     sku_id STRING, supplier_id STRING, default_destination_location STRING,
     updated_at TIMESTAMP, updated_by STRING
   )`,
  `CREATE TABLE IF NOT EXISTS ${T}.procurement_idempotency (
     idempotency_key STRING, scope STRING, po_id STRING, response_json STRING, created_at TIMESTAMP
   )`,
];

const PO_EDITABLE = [
  "quantity",
  "approved_quantity",
  "unit_cost",
  "total_cost",
  "supplier_id",
  "supplier_name",
  "supplier_email",
  "destination_location",
  "expected_delivery_date",
  "notes",
  "approval_reason",
  "supplier_response_text",
  "supplier_response_intent",
];

const PO_PATCHABLE = [
  ...PO_EDITABLE,
  "approval_mode",
  "approved_by",
  "approved_at",
  "rejected_by",
  "rejected_at",
  "gemini_decision",
  "gemini_risk_level",
  "gemini_reason",
  "gemini_response_json",
  "validation_json",
  "email_status",
  "email_message_id",
  "supplier_confirmed_at",
  "received_quantity",
  "received_at",
  "received_by",
  "receipt_location",
  "cancel_reason",
];

const SUPPLIER_FIELDS = ["name", "email", "contact_name", "phone", "lead_time_days", "active", "notes"];

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function safeLimit(value, fallback = 100, max = 500) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const iso = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function toDateOnly(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBool(value) {
  return value === true || value === 1 || value === "true" || value === "TRUE";
}

function normalizePO(row) {
  if (!row) return null;
  return {
    ...row,
    quantity: Number(row.quantity) || 0,
    approved_quantity: toNumberOrNull(row.approved_quantity),
    unit_cost: toNumberOrNull(row.unit_cost),
    total_cost: toNumberOrNull(row.total_cost),
    received_quantity: toNumberOrNull(row.received_quantity),
    expected_delivery_date: toDateOnly(row.expected_delivery_date),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    approved_at: toIso(row.approved_at),
    rejected_at: toIso(row.rejected_at),
    supplier_confirmed_at: toIso(row.supplier_confirmed_at),
    received_at: toIso(row.received_at),
  };
}

function normalizeSupplier(row) {
  if (!row) return null;
  return {
    ...row,
    lead_time_days: toNumberOrNull(row.lead_time_days),
    active: row.active == null ? true : toBool(row.active),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function normalizeSettings(row) {
  return {
    settings_id: row.settings_id || "default",
    approval_mode: String(row.approval_mode || "HUMAN").toUpperCase(),
    max_auto_approve_amount: toNumberOrNull(row.max_auto_approve_amount) ?? 500,
    monthly_budget: toNumberOrNull(row.monthly_budget) ?? 10000,
    max_po_quantity: toNumberOrNull(row.max_po_quantity) ?? 1000,
    auto_send_email: toBool(row.auto_send_email),
    currency: row.currency || "USD",
    updated_at: toIso(row.updated_at),
    updated_by: row.updated_by || null,
  };
}

function createProcurementStore(query) {
  let schemaReady = false;

  async function ensureSchema() {
    if (schemaReady) return;
    for (const statement of DDL) await query(statement);
    schemaReady = true;
  }

  // ---------- suppliers ----------

  async function listSuppliers() {
    await ensureSchema();
    const rows = await query(`SELECT * FROM ${T}.suppliers ORDER BY name`);
    return rows.map(normalizeSupplier);
  }

  async function getSupplier(supplierId) {
    await ensureSchema();
    const rows = await query(`SELECT * FROM ${T}.suppliers WHERE supplier_id = :id LIMIT 1`, { id: supplierId });
    return rows.length ? normalizeSupplier(rows[0]) : null;
  }

  async function createSupplier(payload, actor) {
    await ensureSchema();
    const name = String(payload.name || "").trim();
    const email = String(payload.email || "").trim();
    if (!name) throw httpError(400, "INVALID_SUPPLIER", "Supplier name is required.");
    if (!isValidEmail(email)) throw httpError(400, "INVALID_SUPPLIER_EMAIL", "A valid supplier email is required.");

    const supplierId = `SUP-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    await query(
      `INSERT INTO ${T}.suppliers
         (supplier_id, name, email, contact_name, phone, lead_time_days, active, notes,
          created_at, updated_at, updated_by)
       VALUES (:id, :name, :email, :contact, :phone, :lead, :active, :notes,
               current_timestamp(), current_timestamp(), :actor)`,
      {
        id: supplierId,
        name,
        email,
        contact: String(payload.contact_name || ""),
        phone: String(payload.phone || ""),
        lead: Number.isFinite(Number(payload.lead_time_days)) ? Math.round(Number(payload.lead_time_days)) : 7,
        active: payload.active === false ? false : true,
        notes: String(payload.notes || ""),
        actor: actor || "unknown",
      },
    );
    return getSupplier(supplierId);
  }

  async function updateSupplier(supplierId, patch, actor) {
    await ensureSchema();
    const current = await getSupplier(supplierId);
    if (!current) throw httpError(404, "SUPPLIER_NOT_FOUND", "Supplier not found.");

    const sets = [];
    const params = { id: supplierId, actor: actor || "unknown" };
    for (const field of SUPPLIER_FIELDS) {
      if (patch[field] === undefined) continue;
      if (field === "email" && !isValidEmail(patch[field])) {
        throw httpError(400, "INVALID_SUPPLIER_EMAIL", "A valid supplier email is required.");
      }
      if (field === "name" && !String(patch[field] || "").trim()) {
        throw httpError(400, "INVALID_SUPPLIER", "Supplier name is required.");
      }
      sets.push(`${field} = :${field}`);
      params[field] = field === "lead_time_days" ? Math.round(Number(patch[field])) : patch[field];
    }
    if (!sets.length) throw httpError(400, "NO_CHANGES", "No editable supplier fields supplied.");

    await query(
      `UPDATE ${T}.suppliers SET ${sets.join(", ")}, updated_at = current_timestamp(), updated_by = :actor
       WHERE supplier_id = :id`,
      params,
    );
    return getSupplier(supplierId);
  }

  // ---------- product configuration ----------

  async function getProductProcurement(sku) {
    await ensureSchema();
    const rows = await query(
      `SELECT s.sku_id, s.supplier_name, s.unit_cost, s.lead_time_days,
              c.supplier_id, c.default_destination_location,
              sup.name AS supplier_display_name, sup.email AS supplier_email,
              sup.active AS supplier_active
       FROM ${T}.ml_product_settings s
       LEFT JOIN ${T}.procurement_product_config c ON c.sku_id = s.sku_id
       LEFT JOIN ${T}.suppliers sup ON sup.supplier_id = c.supplier_id
       WHERE s.sku_id = :sku LIMIT 1`,
      { sku },
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      sku_id: row.sku_id,
      supplier_name: row.supplier_name || null,
      unit_cost: toNumberOrNull(row.unit_cost),
      lead_time_days: toNumberOrNull(row.lead_time_days),
      supplier_id: row.supplier_id || null,
      default_destination_location: row.default_destination_location || null,
      supplier_display_name: row.supplier_display_name || null,
      supplier_email: row.supplier_email || null,
      supplier_active: row.supplier_active == null ? null : toBool(row.supplier_active),
    };
  }

  async function upsertProductProcurement(sku, patch, actor) {
    await ensureSchema();
    const employee = actor || "unknown";

    if (patch.unit_cost !== undefined) {
      const cost = Number(patch.unit_cost);
      if (!Number.isFinite(cost) || cost < 0) {
        throw httpError(400, "INVALID_UNIT_COST", "unit_cost must be a non-negative number.");
      }
      const existing = await query(`SELECT sku_id FROM ${T}.ml_product_settings WHERE sku_id = :sku LIMIT 1`, { sku });
      if (existing.length) {
        await query(
          `UPDATE ${T}.ml_product_settings
           SET unit_cost = :cost, settings_source = 'MANAGER',
               updated_at = current_timestamp(), updated_by = :actor
           WHERE sku_id = :sku`,
          { cost, sku, actor: employee },
        );
      } else {
        await query(
          `INSERT INTO ${T}.ml_product_settings
             (sku_id, supplier_name, lead_time_days, safety_stock_days, min_order_qty, case_pack,
              unit_cost, overstock_days, settings_source, updated_at, updated_by)
           VALUES (:sku, 'Primary supplier', 7, 5, 1, 1, :cost, 60, 'MANAGER',
                   current_timestamp(), :actor)`,
          { sku, cost, actor: employee },
        );
      }
    }

    const configFields = [];
    const configParams = { sku, actor: employee };
    if (patch.supplier_id !== undefined) {
      const supplierId = patch.supplier_id ? String(patch.supplier_id) : null;
      if (supplierId) {
        const supplier = await getSupplier(supplierId);
        if (!supplier) throw httpError(400, "UNKNOWN_SUPPLIER", "Unknown supplier_id.");
      }
      configFields.push("supplier_id = :supplier_id");
      configParams.supplier_id = supplierId;
    }
    if (patch.default_destination_location !== undefined) {
      configFields.push("default_destination_location = :destination");
      configParams.destination = String(patch.default_destination_location || "");
    }

    if (configFields.length) {
      const existing = await query(`SELECT sku_id FROM ${T}.procurement_product_config WHERE sku_id = :sku LIMIT 1`, {
        sku,
      });
      if (existing.length) {
        await query(
          `UPDATE ${T}.procurement_product_config
           SET ${configFields.join(", ")}, updated_at = current_timestamp(), updated_by = :actor
           WHERE sku_id = :sku`,
          configParams,
        );
      } else {
        await query(
          `INSERT INTO ${T}.procurement_product_config
             (sku_id, supplier_id, default_destination_location, updated_at, updated_by)
           VALUES (:sku, :supplier_id, :destination, current_timestamp(), :actor)`,
          {
            sku,
            supplier_id: configParams.supplier_id ?? null,
            destination: configParams.destination ?? "",
            actor: employee,
          },
        );
      }
    }

    return getProductProcurement(sku);
  }

  // ---------- settings ----------

  async function getSettings(fallback = {}) {
    await ensureSchema();
    const rows = await query(`SELECT * FROM ${T}.procurement_settings WHERE settings_id = 'default' LIMIT 1`);
    if (rows.length) return normalizeSettings(rows[0]);

    const defaults = {
      approval_mode: fallback.approval_mode || "HUMAN",
      max_auto_approve_amount: Number(fallback.max_auto_approve_amount) || 500,
      monthly_budget: Number(fallback.monthly_budget) || 10000,
      max_po_quantity: Number(fallback.max_po_quantity) || 1000,
      auto_send_email: Boolean(fallback.auto_send_email),
      currency: fallback.currency || "USD",
    };

    await query(
      `INSERT INTO ${T}.procurement_settings
         (settings_id, approval_mode, max_auto_approve_amount, human_threshold_amount,
          monthly_budget, max_po_quantity, auto_send_email, currency, updated_at, updated_by)
       VALUES ('default', :mode, :auto, :threshold, :budget, :qty, :send, :currency,
               current_timestamp(), 'system')`,
      {
        mode: defaults.approval_mode,
        auto: defaults.max_auto_approve_amount,
        threshold: defaults.max_auto_approve_amount,
        budget: defaults.monthly_budget,
        qty: defaults.max_po_quantity,
        send: defaults.auto_send_email,
        currency: defaults.currency,
      },
    );

    return normalizeSettings({ settings_id: "default", ...defaults });
  }

  async function updateSettings(patch, actor, fallback = {}) {
    const current = await getSettings(fallback);
    const next = { ...current };

    if (patch.approval_mode !== undefined) {
      const mode = String(patch.approval_mode).toUpperCase();
      if (!["HUMAN", "GEMINI"].includes(mode)) {
        throw httpError(400, "INVALID_APPROVAL_MODE", "approval_mode must be HUMAN or GEMINI.");
      }
      next.approval_mode = mode;
    }

    const numeric = [
      ["max_auto_approve_amount", 0, 1e9],
      ["monthly_budget", 0, 1e9],
      ["max_po_quantity", 1, 100000],
    ];
    for (const [field, min, max] of numeric) {
      if (patch[field] === undefined) continue;
      const value = Number(patch[field]);
      if (!Number.isFinite(value) || value < min || value > max) {
        throw httpError(400, "INVALID_SETTING", `${field} must be between ${min} and ${max}.`);
      }
      next[field] = field === "max_po_quantity" ? Math.round(value) : value;
    }

    if (patch.auto_send_email !== undefined) next.auto_send_email = Boolean(patch.auto_send_email);
    if (patch.currency !== undefined) {
      const currency = String(patch.currency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw httpError(400, "INVALID_CURRENCY", "currency must be a 3-letter code.");
      next.currency = currency;
    }

    await query(
      `UPDATE ${T}.procurement_settings
       SET approval_mode = :mode, max_auto_approve_amount = :auto,
           human_threshold_amount = :threshold, monthly_budget = :budget,
           max_po_quantity = :qty, auto_send_email = :send, currency = :currency,
           updated_at = current_timestamp(), updated_by = :actor
       WHERE settings_id = 'default'`,
      {
        mode: next.approval_mode,
        auto: next.max_auto_approve_amount,
        threshold: next.max_auto_approve_amount,
        budget: next.monthly_budget,
        qty: next.max_po_quantity,
        send: next.auto_send_email,
        currency: next.currency,
        actor: actor || "unknown",
      },
    );

    return getSettings(fallback);
  }

  // ---------- purchase orders ----------

  async function findActivePO(sku) {
    await ensureSchema();
    const statuses = ACTIVE_STATUSES.map((status) => `'${status}'`).join(", ");
    const rows = await query(
      `SELECT * FROM ${T}.purchase_orders
       WHERE sku_id = :sku AND status IN (${statuses})
       ORDER BY created_at DESC LIMIT 1`,
      { sku },
    );
    return rows.length ? normalizePO(rows[0]) : null;
  }

  async function getPO(poId) {
    await ensureSchema();
    const rows = await query(`SELECT * FROM ${T}.purchase_orders WHERE po_id = :id LIMIT 1`, { id: poId });
    return rows.length ? normalizePO(rows[0]) : null;
  }

  async function listPOs({ status, sku_id, limit } = {}) {
    await ensureSchema();
    const clauses = [];
    const params = {};
    if (status) {
      const normalized = String(status).toUpperCase();
      if (!ALL_STATUSES.includes(normalized)) throw httpError(400, "INVALID_STATUS", "Unknown order status.");
      clauses.push("status = :status");
      params.status = normalized;
    }
    if (sku_id) {
      clauses.push("sku_id = :sku");
      params.sku = String(sku_id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await query(
      `SELECT * FROM ${T}.purchase_orders ${where} ORDER BY created_at DESC LIMIT ${safeLimit(limit)}`,
      params,
    );
    return rows.map(normalizePO);
  }

  async function createPO(po) {
    await ensureSchema();
    await query(
      `INSERT INTO ${T}.purchase_orders
         (po_id, po_number, sku_id, sku_name, supplier_id, supplier_name, supplier_email,
          quantity, approved_quantity, unit_cost, total_cost, currency, status,
          approval_mode, approval_reason, recommendation_run_id, idempotency_key,
          expected_delivery_date, destination_location, notes,
          created_at, created_by, updated_at, updated_by)
       VALUES
         (:po_id, :po_number, :sku_id, :sku_name, :supplier_id, :supplier_name, :supplier_email,
          :quantity, :approved_quantity, :unit_cost, :total_cost, :currency, :status,
          :approval_mode, :approval_reason, :recommendation_run_id, :idempotency_key,
          :expected_delivery_date, :destination_location, :notes,
          current_timestamp(), :created_by, current_timestamp(), :updated_by)`,
      {
        po_id: po.po_id,
        po_number: po.po_number,
        sku_id: po.sku_id,
        sku_name: po.sku_name || "",
        supplier_id: po.supplier_id || null,
        supplier_name: po.supplier_name || "",
        supplier_email: po.supplier_email || "",
        quantity: po.quantity,
        approved_quantity: po.approved_quantity ?? null,
        unit_cost: po.unit_cost ?? null,
        total_cost: po.total_cost ?? null,
        currency: po.currency || "USD",
        status: po.status || "PENDING_APPROVAL",
        approval_mode: po.approval_mode || "HUMAN",
        approval_reason: po.approval_reason || "",
        recommendation_run_id: po.recommendation_run_id || "",
        idempotency_key: po.idempotency_key || "",
        expected_delivery_date: po.expected_delivery_date || null,
        destination_location: po.destination_location || "",
        notes: po.notes || "",
        created_by: po.created_by || "system",
        updated_by: po.updated_by || po.created_by || "system",
      },
    );
    return getPO(po.po_id);
  }

  async function updatePO(poId, patch, actor) {
    const before = await getPO(poId);
    if (!before) throw httpError(404, "PO_NOT_FOUND", "Order not found.");

    const sets = [];
    const params = { id: poId, actor: actor || "unknown" };
    for (const field of PO_EDITABLE) {
      if (patch[field] === undefined) continue;
      sets.push(`${field} = :${field}`);
      params[field] = patch[field];
    }
    if (!sets.length) return before;

    await query(
      `UPDATE ${T}.purchase_orders
       SET ${sets.join(", ")}, updated_at = current_timestamp(), updated_by = :actor
       WHERE po_id = :id`,
      params,
    );
    return getPO(poId);
  }

  async function transitionPO(poId, allowedFrom, toStatus, patch, actor, eventType, details) {
    const before = await getPO(poId);
    if (!before) throw httpError(404, "PO_NOT_FOUND", "Order not found.");

    const target = String(toStatus).toUpperCase();
    if (!ALL_STATUSES.includes(target)) throw httpError(400, "INVALID_STATUS", "Unknown target status.");

    const fromStatuses = allowedFrom
      .map((status) => String(status).toUpperCase())
      .filter((status) => ALL_STATUSES.includes(status));
    if (!fromStatuses.includes(String(before.status).toUpperCase())) {
      throw httpError(409, "INVALID_TRANSITION", `Order is ${before.status}, cannot move to ${target}.`);
    }

    const sets = ["status = :to_status"];
    const params = { id: poId, actor: actor || "unknown", to_status: target };
    const applied = new Set();
    for (const field of PO_PATCHABLE) {
      if (applied.has(field) || patch[field] === undefined) continue;
      applied.add(field);
      if (patch[field] === "__NOW__") {
        sets.push(`${field} = current_timestamp()`);
      } else {
        sets.push(`${field} = :${field}`);
        params[field] = patch[field];
      }
    }
    sets.push("updated_at = current_timestamp()", "updated_by = :actor");

    const placeholders = fromStatuses.map((status) => `'${status}'`).join(", ");
    await query(
      `UPDATE ${T}.purchase_orders SET ${sets.join(", ")}
       WHERE po_id = :id AND status IN (${placeholders})`,
      params,
    );

    const after = await getPO(poId);
    if (!after || String(after.status).toUpperCase() !== target) {
      throw httpError(409, "TRANSITION_RACE", "Order changed while it was being updated. Reload and try again.");
    }

    await addLog({
      po_id: poId,
      sku_id: after.sku_id,
      event_type: eventType || `STATUS_${target}`,
      from_status: before.status,
      to_status: target,
      actor: actor || "unknown",
      actor_type: patch.actor_type || "HUMAN",
      message: patch.message || "",
      details: details || null,
    });

    return after;
  }

  async function addLog({
    po_id,
    sku_id,
    event_type,
    from_status,
    to_status,
    actor,
    actor_type,
    message,
    details,
  }) {
    await ensureSchema();
    await query(
      `INSERT INTO ${T}.procurement_logs
         (log_id, po_id, sku_id, event_type, from_status, to_status, actor, actor_type,
          message, details_json, created_at)
       VALUES (:id, :po, :sku, :event, :from, :to, :actor, :actor_type,
               :message, :details, current_timestamp())`,
      {
        id: crypto.randomUUID(),
        po: po_id || "",
        sku: sku_id || "",
        event: event_type || "",
        from: from_status || "",
        to: to_status || "",
        actor: actor || "system",
        actor_type: actor_type || "SYSTEM",
        message: message || "",
        details: details ? JSON.stringify(details) : "",
      },
    );
  }

  async function listLogs(poId, limit) {
    await ensureSchema();
    const rows = poId
      ? await query(
          `SELECT * FROM ${T}.procurement_logs WHERE po_id = :po ORDER BY created_at DESC LIMIT ${safeLimit(limit)}`,
          { po: poId },
        )
      : await query(`SELECT * FROM ${T}.procurement_logs ORDER BY created_at DESC LIMIT ${safeLimit(limit)}`);
    return rows.map((row) => ({
      ...row,
      created_at: toIso(row.created_at),
    }));
  }

  async function getMonthlySpend() {
    await ensureSchema();
    const rows = await query(
      `SELECT COALESCE(SUM(total_cost), 0) AS spend
       FROM ${T}.purchase_orders
       WHERE created_at >= date_trunc('MONTH', current_timestamp())
         AND status IN ('APPROVED', 'ORDER_SENT', 'ORDER_CONFIRMED', 'IN_TRANSIT', 'RECEIVED')`,
    );
    return Number(rows[0]?.spend || 0);
  }

  async function getSummary() {
    await ensureSchema();
    const rows = await query(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(total_cost), 0) AS amount
       FROM ${T}.purchase_orders GROUP BY status`,
    );
    const byStatus = {};
    let pendingCost = 0;
    for (const row of rows) {
      const status = String(row.status || "").toUpperCase();
      const count = Number(row.count) || 0;
      const amount = Number(row.amount) || 0;
      byStatus[status] = { count, amount: round(amount) };
      if (["PENDING_APPROVAL", "NEEDS_HUMAN_REVIEW", "APPROVED", "ORDER_SENT", "ORDER_CONFIRMED", "IN_TRANSIT"].includes(status)) {
        pendingCost += amount;
      }
    }
    return {
      by_status: byStatus,
      pending_approvals: (byStatus.PENDING_APPROVAL?.count || 0) + (byStatus.NEEDS_HUMAN_REVIEW?.count || 0),
      awaiting_supplier: byStatus.ORDER_SENT?.count || 0,
      in_transit: byStatus.IN_TRANSIT?.count || 0,
      received: byStatus.RECEIVED?.count || 0,
      pending_cost: round(pendingCost),
    };
  }

  // ---------- idempotency ----------

  async function getIdempotentResponse(idempotencyKey, scope) {
    if (!idempotencyKey) return null;
    await ensureSchema();
    const rows = await query(
      `SELECT response_json FROM ${T}.procurement_idempotency
       WHERE idempotency_key = :key AND scope = :scope LIMIT 1`,
      { key: idempotencyKey, scope },
    );
    if (!rows.length) return null;
    try {
      return JSON.parse(rows[0].response_json);
    } catch {
      return null;
    }
  }

  async function saveIdempotentResponse(idempotencyKey, scope, poId, response) {
    if (!idempotencyKey) return;
    await ensureSchema();
    await query(
      `INSERT INTO ${T}.procurement_idempotency
         (idempotency_key, scope, po_id, response_json, created_at)
       VALUES (:key, :scope, :po, :response, current_timestamp())`,
      {
        key: idempotencyKey,
        scope,
        po: poId || "",
        response: JSON.stringify(response),
      },
    );
  }

  // ---------- email messages ----------

  async function recordOutboundEmail({
    poId,
    providerMessageId,
    fromEmail,
    toEmail,
    subject,
    bodyText,
    status,
    errorMessage,
    transport,
  }) {
    await ensureSchema();
    const messageId = crypto.randomUUID();
    await query(
      `INSERT INTO ${T}.supplier_email_messages
         (message_id, po_id, direction, transport, provider_message_id, from_email, to_email,
          subject, body_text, status, error_message, raw_payload, created_at)
       VALUES (:id, :po, 'OUTBOUND', :transport, :provider, :from, :to,
               :subject, :body, :status, :error, '', current_timestamp())`,
      {
        id: messageId,
        po: poId,
        transport: transport || "gmail_smtp",
        provider: providerMessageId || "",
        from: fromEmail || "",
        to: toEmail || "",
        subject: subject || "",
        body: bodyText || "",
        status: status || "SENT",
        error: errorMessage || "",
      },
    );
    return messageId;
  }

  async function recordInboundEmail({ poId, fromEmail, toEmail, subject, bodyText, status, rawPayload }) {
    await ensureSchema();
    const messageId = crypto.randomUUID();
    await query(
      `INSERT INTO ${T}.supplier_email_messages
         (message_id, po_id, direction, transport, provider_message_id, from_email, to_email,
          subject, body_text, status, error_message, raw_payload, created_at)
       VALUES (:id, :po, 'INBOUND', 'manual', '', :from, :to,
               :subject, :body, :status, '', :raw, current_timestamp())`,
      {
        id: messageId,
        po: poId,
        from: fromEmail || "",
        to: toEmail || "",
        subject: subject || "",
        body: bodyText || "",
        status: status || "RECORDED",
        raw: rawPayload || "",
      },
    );
    return messageId;
  }

  async function listEmails({ poId, limit } = {}) {
    await ensureSchema();
    const rows = poId
      ? await query(
          `SELECT * FROM ${T}.supplier_email_messages WHERE po_id = :po ORDER BY created_at DESC LIMIT ${safeLimit(limit)}`,
          { po: poId },
        )
      : await query(`SELECT * FROM ${T}.supplier_email_messages ORDER BY created_at DESC LIMIT ${safeLimit(limit)}`);
    return rows.map((row) => ({ ...row, created_at: toIso(row.created_at) }));
  }

  async function locationExists(code) {
    const rows = await query(`SELECT location_code FROM ${T}.locations WHERE location_code = :c`, { c: code });
    return rows.length > 0;
  }

  return {
    ensureSchema,
    listSuppliers,
    getSupplier,
    createSupplier,
    updateSupplier,
    getProductProcurement,
    upsertProductProcurement,
    getSettings,
    updateSettings,
    findActivePO,
    getPO,
    listPOs,
    createPO,
    updatePO,
    transitionPO,
    addLog,
    listLogs,
    getMonthlySpend,
    getSummary,
    getIdempotentResponse,
    saveIdempotentResponse,
    recordOutboundEmail,
    recordInboundEmail,
    listEmails,
    locationExists,
  };
}

module.exports = { createProcurementStore, DDL };

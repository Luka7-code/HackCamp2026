"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProcurementOrchestrator } = require("../lib/procurement/orchestrator");

const ACTIVE = ["PENDING_APPROVAL", "NEEDS_HUMAN_REVIEW", "APPROVED", "ORDER_SENT", "ORDER_CONFIRMED", "IN_TRANSIT"];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeStore({ settings, product } = {}) {
  const pos = new Map();
  const logs = [];
  const emails = [];
  const idem = new Map();
  const suppliers = [
    { supplier_id: "SUP-1", name: "Demo Supplier", email: "supplier@example.com", active: true, lead_time_days: 3 },
  ];
  const productConfig = product === undefined ? {
    sku_id: "SKU-1",
    supplier_id: "SUP-1",
    supplier_name: "Demo Supplier",
    supplier_email: "supplier@example.com",
    unit_cost: 10,
    default_destination_location: "A-01",
  } : product;
  let settingsState = {
    settings_id: "default",
    approval_mode: "GEMINI",
    max_auto_approve_amount: 500,
    monthly_budget: 10000,
    max_po_quantity: 1000,
    auto_send_email: false,
    currency: "USD",
    ...(settings || {}),
  };
  let spend = 0;

  return {
    pos,
    logs,
    emails,
    settingsState: () => settingsState,
    setSettings: (patch) => {
      settingsState = { ...settingsState, ...patch };
    },
    setSpend: (value) => {
      spend = value;
    },
    async ensureSchema() {},
    async getSettings() {
      return { ...settingsState };
    },
    async updateSettings() {
      return { ...settingsState };
    },
    async getMonthlySpend() {
      return spend;
    },
    async listSuppliers() {
      return clone(suppliers);
    },
    async getSupplier(id) {
      return clone(suppliers.find((supplier) => supplier.supplier_id === id) || null);
    },
    async findActivePO(sku) {
      return (
        clone([...pos.values()].find((po) => po.sku_id === sku && ACTIVE.includes(po.status))) || null
      );
    },
    async getProductProcurement() {
      return clone(productConfig);
    },
    async upsertProductProcurement() {
      return clone(productConfig);
    },
    async createPO(po) {
      const record = {
        approved_quantity: null,
        unit_cost: null,
        total_cost: null,
        currency: "USD",
        status: "PENDING_APPROVAL",
        approval_mode: "HUMAN",
        approval_reason: "",
        supplier_id: null,
        supplier_name: "",
        supplier_email: "",
        destination_location: "",
        expected_delivery_date: null,
        notes: "",
        created_at: new Date().toISOString(),
        ...po,
      };
      pos.set(record.po_id, record);
      return clone(record);
    },
    async getPO(id) {
      return clone(pos.get(id) || null);
    },
    async listPOs({ status } = {}) {
      return clone([...pos.values()].filter((po) => !status || po.status === status));
    },
    async updatePO(id, patch) {
      const po = pos.get(id);
      if (!po) return null;
      Object.assign(po, patch);
      return clone(po);
    },
    async transitionPO(id, allowedFrom, toStatus, patch, actor, eventType) {
      const po = pos.get(id);
      if (!po) {
        const error = new Error("Order not found.");
        error.status = 404;
        throw error;
      }
      if (!allowedFrom.includes(po.status)) {
        const error = new Error(`Cannot move from ${po.status}.`);
        error.status = 409;
        throw error;
      }
      const clean = {};
      for (const [key, value] of Object.entries(patch || {})) {
        if (key === "actor_type" || key === "message") continue;
        clean[key] = value === "__NOW__" ? new Date().toISOString() : value;
      }
      Object.assign(po, clean, { status: toStatus });
      logs.push({
        po_id: id,
        sku_id: po.sku_id,
        event_type: eventType,
        from_status: allowedFrom[0],
        to_status: toStatus,
        actor,
      });
      return clone(po);
    },
    async addLog(entry) {
      logs.push(entry);
    },
    async listLogs() {
      return clone(logs);
    },
    async getSummary() {
      const byStatus = {};
      for (const po of pos.values()) {
        byStatus[po.status] = (byStatus[po.status] || 0) + 1;
      }
      return { by_status: byStatus, pending_approvals: 0, awaiting_supplier: 0, in_transit: 0, received: 0, pending_cost: 0 };
    },
    async getIdempotentResponse(key) {
      return key && idem.has(key) ? clone(idem.get(key)) : null;
    },
    async saveIdempotentResponse(key, scope, poId, response) {
      if (key) idem.set(key, clone(response));
    },
    async recordOutboundEmail(entry) {
      const id = `mail-${emails.length + 1}`;
      emails.push({ id, direction: "OUTBOUND", ...entry });
      return id;
    },
    async recordInboundEmail(entry) {
      const id = `mail-${emails.length + 1}`;
      emails.push({ id, direction: "INBOUND", ...entry });
      return id;
    },
    async listEmails() {
      return clone(emails);
    },
    async locationExists(code) {
      return code === "A-01";
    },
  };
}

function makeWorld({ settings, geminiResult, product } = {}) {
  const store = makeStore({ settings, product });
  const predictiveStore = {
    async getDashboard() {
      return {
        generated_at: "2026-11-08T00:00:00Z",
        all: [
          { sku_id: "SKU-1", name: "Wireless Mouse", on_hand: 2, recommended_qty: 5, risk_level: "CRITICAL", supplier_name: "Demo Supplier" },
          { sku_id: "SKU-2", name: "Keyboard", on_hand: 4, recommended_qty: 3, risk_level: "WARNING", supplier_name: "Demo Supplier" },
        ],
        restock: [
          { sku_id: "SKU-1", name: "Wireless Mouse", on_hand: 2, recommended_qty: 5, risk_level: "CRITICAL", supplier_name: "Demo Supplier" },
          { sku_id: "SKU-2", name: "Keyboard", on_hand: 4, recommended_qty: 3, risk_level: "WARNING", supplier_name: "Demo Supplier" },
        ],
      };
    },
  };
  const gemini = {
    enabled: true,
    async evaluatePO() {
      return geminiResult || { decision: "APPROVE", risk_level: "LOW", reason: "Within policy.", failed: false };
    },
  };
  const email = {
    configured: true,
    async send() {
      return { messageId: "<test@example.com>" };
    },
  };
  const config = {
    absoluteMaxAmount: 5000,
    defaultCurrency: "USD",
    companyName: "Test Warehouse",
    defaults: {
      approval_mode: "GEMINI",
      max_auto_approve_amount: 500,
      monthly_budget: 10000,
      max_po_quantity: 1000,
      auto_send_email: false,
      currency: "USD",
    },
    gemini: { apiKey: "test" },
    email: { from: "buyer@example.com", replyTo: "buyer@example.com" },
  };
  const orchestrator = createProcurementOrchestrator({
    store,
    predictiveStore,
    config,
    gemini,
    email,
    now: () => new Date("2026-11-08T00:00:00Z"),
  });
  return { store, predictiveStore, gemini, email, config, orchestrator };
}

function seed(world, overrides) {
  const po = {
    po_id: overrides.po_id || `po-${world.store.pos.size + 1}`,
    po_number: `ORD-20261108-${String(world.store.pos.size + 1).padStart(6, "0")}`,
    sku_id: "SKU-1",
    sku_name: "Wireless Mouse",
    supplier_id: "SUP-1",
    supplier_name: "Demo Supplier",
    supplier_email: "supplier@example.com",
    quantity: 5,
    unit_cost: 10,
    total_cost: 50,
    currency: "USD",
    status: "PENDING_APPROVAL",
    approval_mode: "GEMINI",
    ...overrides,
  };
  world.store.pos.set(po.po_id, po);
  return po;
}

test("detect creates an order and skips SKUs with an active order", async () => {
  const world = makeWorld({ settings: { approval_mode: "HUMAN" } });
  seed(world, { sku_id: "SKU-2", status: "APPROVED", po_id: "existing" });

  const result = await world.orchestrator.detect({ actor: "manager" });

  assert.equal(result.created, 1);
  assert.equal(result.duplicates, 1);
  const created = [...world.store.pos.values()].find((po) => po.sku_id === "SKU-1");
  assert.equal(created.status, "PENDING_APPROVAL");
  assert.equal(created.quantity, 5);
  assert.equal(created.total_cost, 50);
});

test("detect creates review orders when supplier or unit cost is missing", async () => {
  const world = makeWorld({ settings: { approval_mode: "HUMAN" }, product: null });

  const result = await world.orchestrator.detect({ actor: "manager" });

  assert.equal(result.created, 2);
  assert.equal(result.needs_review, 2);
  assert.equal(result.skipped, 0);
  const created = [...world.store.pos.values()];
  assert.equal(created.length, 2);
  for (const po of created) assert.equal(po.status, "NEEDS_HUMAN_REVIEW");
});

test("evaluate auto-approves a low-risk order within limits", async () => {
  const world = makeWorld();
  seed(world, { po_id: "po-a" });

  const result = await world.orchestrator.evaluate({ poId: "po-a", actor: "manager" });

  assert.equal(result.decision.outcome, "APPROVED");
  assert.equal(result.po.status, "APPROVED");
  assert.equal(world.store.logs.some((log) => log.event_type === "PO_APPROVED"), true);
});

test("evaluate escalates above the auto-approval threshold", async () => {
  const world = makeWorld();
  seed(world, { po_id: "po-b", quantity: 100, total_cost: 1000 });

  const result = await world.orchestrator.evaluate({ poId: "po-b", actor: "manager" });

  assert.equal(result.decision.outcome, "NEEDS_HUMAN_REVIEW");
  assert.equal(result.po.status, "NEEDS_HUMAN_REVIEW");
});

test("evaluate fails safe when Gemini is unavailable", async () => {
  const world = makeWorld({ geminiResult: { failed: true, decision: "NEEDS_HUMAN_REVIEW", risk_level: "HIGH", reason: "GEMINI_TIMEOUT" } });
  seed(world, { po_id: "po-c" });

  const result = await world.orchestrator.evaluate({ poId: "po-c", actor: "manager" });

  assert.equal(result.decision.outcome, "NEEDS_HUMAN_REVIEW");
  assert.equal(result.po.gemini_decision, "NEEDS_HUMAN_REVIEW");
});

test("approve refuses to exceed the absolute hard cap", async () => {
  const world = makeWorld();
  world.config.absoluteMaxAmount = 40;
  seed(world, { po_id: "po-d", quantity: 5, unit_cost: 10, total_cost: 50 });

  await assert.rejects(
    world.orchestrator.approve({ poId: "po-d", actor: "manager" }),
    (error) => error.status === 422 && error.code === "ABSOLUTE_CAP_EXCEEDED",
  );
  assert.equal(world.store.pos.get("po-d").status, "PENDING_APPROVAL");
});

test("approve enforces the budget unless explicitly overridden", async () => {
  const world = makeWorld({ settings: { monthly_budget: 40 } });
  seed(world, { po_id: "po-e" });

  await assert.rejects(
    world.orchestrator.approve({ poId: "po-e", actor: "manager" }),
    (error) => error.status === 422 && error.code === "BUDGET_EXCEEDED",
  );

  const result = await world.orchestrator.approve({ poId: "po-e", actor: "manager", overrideBudget: true });
  assert.equal(result.po.status, "APPROVED");
  assert.equal(result.po.approved_quantity, 5);
});

test("send transitions once and is idempotent", async () => {
  const world = makeWorld();
  seed(world, { po_id: "po-f", status: "APPROVED" });

  const first = await world.orchestrator.send({ poId: "po-f", actor: "manager" });
  assert.equal(first.po.status, "ORDER_SENT");
  assert.equal(world.store.emails.filter((mail) => mail.direction === "OUTBOUND").length, 1);

  const second = await world.orchestrator.send({ poId: "po-f", actor: "manager" });
  assert.equal(second.already_sent, true);
  assert.equal(world.store.emails.filter((mail) => mail.direction === "OUTBOUND").length, 1);
});

test("supplier confirmation moves the order to confirmed", async () => {
  const world = makeWorld();
  seed(world, { po_id: "po-g", status: "ORDER_SENT" });

  const result = await world.orchestrator.processSupplierResponse({
    poId: "po-g",
    fromEmail: "supplier@example.com",
    subject: "Re: Order",
    body: "We confirm this order.",
    actor: "manager",
  });

  assert.equal(result.sender_match, true);
  assert.equal(result.intent, "CONFIRM");
  assert.equal(result.po.status, "ORDER_CONFIRMED");
});

test("supplier decline and sender mismatch go to human review", async () => {
  const world = makeWorld();
  seed(world, { po_id: "po-h", status: "ORDER_SENT" });

  const declined = await world.orchestrator.processSupplierResponse({
    poId: "po-h",
    fromEmail: "supplier@example.com",
    subject: "Re: Order",
    body: "Sorry, we cannot fulfil this order.",
    actor: "manager",
  });
  assert.equal(declined.po.status, "NEEDS_HUMAN_REVIEW");

  seed(world, { po_id: "po-i", status: "ORDER_SENT" });
  const spoofed = await world.orchestrator.processSupplierResponse({
    poId: "po-i",
    fromEmail: "attacker@example.com",
    subject: "Re: Order",
    body: "We confirm this order.",
    actor: "manager",
  });
  assert.equal(spoofed.sender_match, false);
  assert.equal(spoofed.po.status, "NEEDS_HUMAN_REVIEW");
});

test("receive records the receipt once and does not touch inventory", async () => {
  const world = makeWorld();
  seed(world, { po_id: "po-j", status: "ORDER_CONFIRMED", approved_quantity: 5 });
  assert.equal(world.store.inventoryWrites, undefined);

  const first = await world.orchestrator.receive({
    poId: "po-j",
    receivedQuantity: 5,
    locationCode: "A-01",
    actor: "manager",
  });
  assert.equal(first.po.status, "RECEIVED");
  assert.equal(first.po.received_quantity, 5);
  assert.equal(world.store.inventoryWrites, undefined);

  const second = await world.orchestrator.receive({
    poId: "po-j",
    receivedQuantity: 5,
    locationCode: "A-01",
    actor: "manager",
  });
  assert.equal(second.already_received, true);
});

test("receive rejects a mismatched quantity", async () => {
  const world = makeWorld();
  seed(world, { po_id: "po-k", status: "IN_TRANSIT", approved_quantity: 5 });

  await assert.rejects(
    world.orchestrator.receive({ poId: "po-k", receivedQuantity: 3, locationCode: "A-01", actor: "manager" }),
    (error) => error.status === 400 && error.code === "PARTIAL_RECEIPT_UNSUPPORTED",
  );
});

test("createPORequest is duplicate-aware", async () => {
  const world = makeWorld();
  seed(world, { po_id: "existing", sku_id: "SKU-1", status: "APPROVED" });

  const result = await world.orchestrator.createPORequest({ sku_id: "SKU-1", actor: "manager" });

  assert.equal(result.duplicate, true);
  assert.equal(result.po.po_id, "existing");
});

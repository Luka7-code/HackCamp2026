"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canTransition,
  checkFinancialCaps,
  classifySupplierReply,
  computeTotal,
  decideApproval,
  extractPoReference,
  formatPoNumber,
  isActiveStatus,
  isValidEmail,
  parseGeminiJson,
  sanitizeHeaderValue,
  validateGeminiDecision,
} = require("../lib/procurement/validation");

test("computeTotal rounds money and rejects invalid input", () => {
  assert.equal(computeTotal(3, 12.345), 37.04);
  assert.equal(computeTotal(10, 0.1), 1);
  assert.equal(computeTotal(0, 10), null);
  assert.equal(computeTotal(2, null), null);
  assert.equal(computeTotal("x", 10), null);
});

test("canTransition allows the documented status paths", () => {
  assert.equal(canTransition("PENDING_APPROVAL", "APPROVED"), true);
  assert.equal(canTransition("PENDING_APPROVAL", "REJECTED"), true);
  assert.equal(canTransition("APPROVED", "ORDER_SENT"), true);
  assert.equal(canTransition("ORDER_SENT", "ORDER_CONFIRMED"), true);
  assert.equal(canTransition("ORDER_CONFIRMED", "RECEIVED"), true);
  assert.equal(canTransition("IN_TRANSIT", "NEEDS_HUMAN_REVIEW"), true);
  assert.equal(canTransition("RECEIVED", "ORDER_SENT"), false);
  assert.equal(canTransition("CANCELLED", "APPROVED"), false);
  assert.equal(canTransition("REJECTED", "APPROVED"), false);
});

test("isActiveStatus separates open and terminal orders", () => {
  assert.equal(isActiveStatus("APPROVED"), true);
  assert.equal(isActiveStatus("ORDER_SENT"), true);
  assert.equal(isActiveStatus("RECEIVED"), false);
  assert.equal(isActiveStatus("CANCELLED"), false);
});

test("checkFinancialCaps reports every blocking issue", () => {
  const issues = checkFinancialCaps({
    quantity: 100,
    unitCost: null,
    totalCost: null,
    supplierEmail: "",
    settings: { max_po_quantity: 50 },
    absoluteMaxAmount: 1000,
    budgetRemaining: 500,
  });
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes("MAX_QUANTITY_EXCEEDED"));
  assert.ok(codes.includes("MISSING_UNIT_COST"));
  assert.ok(codes.includes("NO_SUPPLIER_EMAIL"));
  assert.ok(codes.includes("INVALID_TOTAL"));
});

test("checkFinancialCaps flags the hard cap and budget", () => {
  const issues = checkFinancialCaps({
    quantity: 10,
    unitCost: 100,
    totalCost: 1000,
    supplierEmail: "sup@example.com",
    settings: { max_po_quantity: 100 },
    absoluteMaxAmount: 500,
    budgetRemaining: 200,
  });
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes("ABSOLUTE_CAP_EXCEEDED"));
  assert.ok(codes.includes("BUDGET_EXCEEDED"));
});

test("decideApproval never auto-approves above the hard cap", () => {
  const decision = decideApproval({
    mode: "GEMINI",
    gemini: { decision: "APPROVE", risk_level: "LOW", reason: "ok" },
    issues: [{ code: "ABSOLUTE_CAP_EXCEEDED", message: "too much" }],
    totalCost: 1000,
    settings: { max_auto_approve_amount: 5000 },
  });
  assert.equal(decision.outcome, "REJECTED");
});

test("decideApproval escalates human mode and missing data", () => {
  assert.equal(
    decideApproval({ mode: "HUMAN", issues: [], totalCost: 10, settings: {} }).outcome,
    "NEEDS_HUMAN_REVIEW",
  );
  assert.equal(
    decideApproval({
      mode: "GEMINI",
      gemini: { decision: "APPROVE", risk_level: "LOW", reason: "ok" },
      issues: [{ code: "MISSING_UNIT_COST", message: "no cost" }],
      totalCost: null,
      settings: {},
    }).outcome,
    "NEEDS_HUMAN_REVIEW",
  );
});

test("decideApproval auto-approves only within limits and low risk", () => {
  const base = {
    mode: "GEMINI",
    gemini: { decision: "APPROVE", risk_level: "LOW", reason: "fine" },
    issues: [],
    totalCost: 100,
    settings: { max_auto_approve_amount: 500 },
  };
  assert.equal(decideApproval(base).outcome, "APPROVED");
  assert.equal(decideApproval({ ...base, totalCost: 600 }).outcome, "NEEDS_HUMAN_REVIEW");
  assert.equal(
    decideApproval({ ...base, gemini: { decision: "APPROVE", risk_level: "MEDIUM", reason: "hmm" } }).outcome,
    "NEEDS_HUMAN_REVIEW",
  );
  assert.equal(
    decideApproval({ ...base, gemini: { decision: "REJECT", risk_level: "HIGH", reason: "no" } }).outcome,
    "REJECTED",
  );
  assert.equal(
    decideApproval({ ...base, gemini: { failed: true, reason: "GEMINI_TIMEOUT" } }).outcome,
    "NEEDS_HUMAN_REVIEW",
  );
});

test("parseGeminiJson handles plain, fenced and noisy output", () => {
  assert.deepEqual(parseGeminiJson('{"decision":"APPROVE","reason":"ok","risk_level":"LOW"}'), {
    decision: "APPROVE",
    reason: "ok",
    risk_level: "LOW",
  });
  assert.equal(
    parseGeminiJson('```json\n{"decision":"REJECT"}\n```').decision,
    "REJECT",
  );
  assert.equal(parseGeminiJson('Here you go: {"decision":"APPROVE"} thanks').decision, "APPROVE");
  assert.throws(() => parseGeminiJson("not json"));
});

test("validateGeminiDecision enforces the strict schema", () => {
  assert.deepEqual(
    validateGeminiDecision({ decision: "approve", reason: "ok", risk_level: "low" }),
    { decision: "APPROVE", reason: "ok", risk_level: "LOW" },
  );
  assert.throws(() => validateGeminiDecision({ decision: "MAYBE", reason: "x", risk_level: "LOW" }));
  assert.throws(() => validateGeminiDecision({ decision: "APPROVE", reason: "x", risk_level: "LOW", extra: 1 }));
  assert.throws(() => validateGeminiDecision({ decision: "APPROVE", reason: "", risk_level: "LOW" }));
});

test("classifySupplierReply checks refusal before confirmation", () => {
  assert.equal(classifySupplierReply("We cannot confirm this order.").intent, "DECLINE");
  assert.equal(classifySupplierReply("Confirmed, thank you.").intent, "CONFIRM");
  assert.equal(classifySupplierReply("This item is on backorder.").intent, "BACKORDER");
  assert.equal(classifySupplierReply("The price has changed to 15.").intent, "PRICE_CHANGED");
  assert.equal(classifySupplierReply("Delivery will be delayed by 3 days.").intent, "DELAYED");
  assert.equal(classifySupplierReply("Sure, yes").intent, "CONFIRM");
  assert.equal(classifySupplierReply("").intent, "UNKNOWN");
  assert.equal(classifySupplierReply("> cannot confirm\nWe confirm").intent, "CONFIRM");
});

test("order reference and number helpers", () => {
  assert.equal(extractPoReference("Re: Order ORD-20261108-AB12CD"), "ORD-20261108-AB12CD");
  assert.equal(extractPoReference("legacy reference PO-20261108-AB12CD"), "PO-20261108-AB12CD");
  assert.equal(extractPoReference("nothing here"), null);
  assert.equal(formatPoNumber(new Date("2026-11-08T00:00:00Z"), "ab12cd"), "ORD-20261108-AB12CD");
});

test("header and email sanitizers", () => {
  assert.equal(sanitizeHeaderValue("Hello\r\nBcc: evil@example.com"), "Hello Bcc: evil@example.com");
  assert.equal(isValidEmail("supplier@example.com"), true);
  assert.equal(isValidEmail("not-an-email"), false);
  assert.equal(isValidEmail(""), false);
});

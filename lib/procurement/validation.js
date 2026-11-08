"use strict";

const ALL_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "NEEDS_HUMAN_REVIEW",
  "APPROVED",
  "REJECTED",
  "ORDER_SENT",
  "ORDER_CONFIRMED",
  "IN_TRANSIT",
  "RECEIVED",
  "CANCELLED",
];

const ACTIVE_STATUSES = [
  "PENDING_APPROVAL",
  "NEEDS_HUMAN_REVIEW",
  "APPROVED",
  "ORDER_SENT",
  "ORDER_CONFIRMED",
  "IN_TRANSIT",
];

const TRANSITIONS = {
  DRAFT: ["PENDING_APPROVAL", "NEEDS_HUMAN_REVIEW", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "NEEDS_HUMAN_REVIEW", "CANCELLED"],
  NEEDS_HUMAN_REVIEW: ["PENDING_APPROVAL", "APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["ORDER_SENT", "NEEDS_HUMAN_REVIEW", "CANCELLED"],
  ORDER_SENT: ["ORDER_CONFIRMED", "IN_TRANSIT", "NEEDS_HUMAN_REVIEW", "CANCELLED"],
  ORDER_CONFIRMED: ["IN_TRANSIT", "RECEIVED", "NEEDS_HUMAN_REVIEW", "CANCELLED"],
  IN_TRANSIT: ["RECEIVED", "NEEDS_HUMAN_REVIEW", "CANCELLED"],
  RECEIVED: [],
  REJECTED: [],
  CANCELLED: [],
};

const GEMINI_DECISIONS = new Set(["APPROVE", "REJECT", "NEEDS_HUMAN_REVIEW"]);
const RISK_LEVELS = new Set(["LOW", "MEDIUM", "HIGH"]);

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function computeTotal(quantity, unitCost) {
  const qty = Number(quantity);
  const cost = Number(unitCost);
  if (!Number.isFinite(qty) || !Number.isFinite(cost) || qty <= 0 || cost <= 0) return null;
  return round(qty * cost, 2);
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(String(status || "").toUpperCase());
}

function canTransition(from, to) {
  const source = String(from || "").toUpperCase();
  const target = String(to || "").toUpperCase();
  return (TRANSITIONS[source] || []).includes(target);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw httpError(409, "INVALID_TRANSITION", `Cannot move order from ${from} to ${to}.`);
  }
}

function isValidEmail(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

function sanitizeText(value, maxLength = 32000) {
  const text = String(value == null ? "" : value)
    .replace(/\u0000/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeHeaderValue(value, maxLength = 200) {
  return sanitizeText(String(value || "").replace(/[\r\n]+/g, " "), maxLength);
}

function checkFinancialCaps({
  quantity,
  unitCost,
  totalCost,
  supplierEmail,
  settings = {},
  absoluteMaxAmount,
  budgetRemaining,
}) {
  const issues = [];
  const qty = Number(quantity);
  const maxQty = Number(settings.max_po_quantity) || 1000;

  if (!Number.isInteger(qty) || qty <= 0) {
    issues.push({ code: "INVALID_QUANTITY", message: "Quantity must be a positive whole number." });
  } else if (qty > maxQty) {
    issues.push({ code: "MAX_QUANTITY_EXCEEDED", message: `Quantity exceeds the maximum of ${maxQty}.` });
  }

  if (!Number.isFinite(Number(unitCost)) || Number(unitCost) <= 0) {
    issues.push({ code: "MISSING_UNIT_COST", message: "Unit cost is missing or invalid." });
  }

  if (!isValidEmail(supplierEmail)) {
    issues.push({ code: "NO_SUPPLIER_EMAIL", message: "Supplier email is missing or invalid." });
  }

  if (totalCost == null || !Number.isFinite(Number(totalCost))) {
    issues.push({ code: "INVALID_TOTAL", message: "Total cost could not be calculated." });
    return issues;
  }

  const absolute = Number(absoluteMaxAmount);
  if (Number.isFinite(absolute) && Number(totalCost) > absolute) {
    issues.push({
      code: "ABSOLUTE_CAP_EXCEEDED",
      message: `Total ${totalCost} exceeds the hard cap of ${absolute}.`,
    });
  }

  const budget = Number(budgetRemaining);
  if (Number.isFinite(budget) && Number(totalCost) > budget) {
    issues.push({
      code: "BUDGET_EXCEEDED",
      message: `Total ${totalCost} exceeds the remaining budget of ${round(budget)}.`,
    });
  }

  return issues;
}

function decideApproval({ mode, gemini, issues = [], totalCost, settings = {} }) {
  const hardReject = issues.find((issue) => issue.code === "ABSOLUTE_CAP_EXCEEDED");
  if (hardReject) return { outcome: "REJECTED", reason: hardReject.message };

  const review = issues.find((issue) =>
    ["MISSING_UNIT_COST", "NO_SUPPLIER_EMAIL", "BUDGET_EXCEEDED", "MAX_QUANTITY_EXCEEDED", "INVALID_QUANTITY", "INVALID_TOTAL"].includes(
      issue.code,
    ),
  );
  if (review) return { outcome: "NEEDS_HUMAN_REVIEW", reason: review.message };

  const approvalMode = String(mode || "HUMAN").toUpperCase();
  if (approvalMode !== "GEMINI") {
    return { outcome: "NEEDS_HUMAN_REVIEW", reason: "Human approval mode is enabled." };
  }

  if (!gemini || gemini.failed) {
    return { outcome: "NEEDS_HUMAN_REVIEW", reason: gemini?.reason || "Gemini evaluation unavailable." };
  }

  if (gemini.decision === "REJECT") {
    return { outcome: "REJECTED", reason: gemini.reason || "Gemini rejected the order." };
  }

  if (gemini.decision !== "APPROVE") {
    return { outcome: "NEEDS_HUMAN_REVIEW", reason: gemini.reason || "Gemini requested human review." };
  }

  if (gemini.risk_level !== "LOW") {
    return {
      outcome: "NEEDS_HUMAN_REVIEW",
      reason: `Gemini rated risk ${gemini.risk_level}: ${gemini.reason}`,
    };
  }

  const autoLimit = Number(settings.max_auto_approve_amount) || 0;
  if (Number(totalCost) > autoLimit) {
    return {
      outcome: "NEEDS_HUMAN_REVIEW",
      reason: `Total ${totalCost} is above the automatic approval limit of ${round(autoLimit)}.`,
    };
  }

  return { outcome: "APPROVED", reason: gemini.reason || "Approved by Gemini within configured limits." };
}

function parseGeminiJson(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw httpError(502, "GEMINI_INVALID_RESPONSE", "Gemini returned an empty response.");
  }

  let cleaned = text.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) cleaned = fenced[1].trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw httpError(502, "GEMINI_INVALID_RESPONSE", "Gemini did not return a JSON object.");
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw httpError(502, "GEMINI_INVALID_RESPONSE", "Gemini returned malformed JSON.");
  }
}

function validateGeminiDecision(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(502, "GEMINI_INVALID_RESPONSE", "Gemini decision must be an object.");
  }

  const extra = Object.keys(payload).filter((key) => !["decision", "reason", "risk_level"].includes(key));
  if (extra.length) {
    throw httpError(502, "GEMINI_INVALID_RESPONSE", `Unexpected Gemini fields: ${extra.join(", ")}.`);
  }

  const decision = String(payload.decision || "").toUpperCase();
  const risk = String(payload.risk_level || "").toUpperCase();
  const reason = sanitizeText(payload.reason, 500);

  if (!GEMINI_DECISIONS.has(decision)) {
    throw httpError(502, "GEMINI_INVALID_RESPONSE", "Gemini decision value is invalid.");
  }
  if (!RISK_LEVELS.has(risk)) {
    throw httpError(502, "GEMINI_INVALID_RESPONSE", "Gemini risk level is invalid.");
  }
  if (!reason) {
    throw httpError(502, "GEMINI_INVALID_RESPONSE", "Gemini reason is missing.");
  }

  return { decision, reason, risk_level: risk };
}

function classifySupplierReply(text) {
  const normalized = String(text || "")
    .slice(0, 32000)
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!normalized) return { intent: "UNKNOWN", confidence: "LOW" };

  if (/\b(decline|declined|reject|rejected|cannot|can't|can not|unable|not able|out of stock|do not|won't|will not)\b/.test(normalized)) {
    return { intent: "DECLINE", confidence: "HIGH" };
  }
  if (/\b(backorder|back order|back-ordered|partial shipment|partial delivery)\b/.test(normalized)) {
    return { intent: "BACKORDER", confidence: "HIGH" };
  }
  if (/\b(price (has )?(changed|increase|increased|different)|new price|updated price|cost (has )?(changed|increase|increased))\b/.test(normalized)) {
    return { intent: "PRICE_CHANGED", confidence: "HIGH" };
  }
  if (/\b(delay|delayed|postpone|postponed|ship later|shipping later)\b/.test(normalized)) {
    return { intent: "DELAYED", confidence: "HIGH" };
  }
  if (/\b(confirm|confirmed|accept|accepted|proceed|approved|agree|yes)\b/.test(normalized) || /^\s*(ok|okay|sure)\b/.test(normalized)) {
    return { intent: "CONFIRM", confidence: "HIGH" };
  }

  return { intent: "UNKNOWN", confidence: "LOW" };
}

function extractPoReference(text) {
  const match = String(text || "").match(/(?:PO|ORD)-\d{8}-[A-Z0-9]{6}/i);
  return match ? match[0].toUpperCase() : null;
}

function formatPoNumber(date, suffix) {
  const pad = (value) => String(value).padStart(2, "0");
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  return `ORD-${day}-${String(suffix || "").toUpperCase().slice(0, 6)}`;
}

module.exports = {
  ALL_STATUSES,
  ACTIVE_STATUSES,
  TRANSITIONS,
  httpError,
  round,
  computeTotal,
  isActiveStatus,
  canTransition,
  assertTransition,
  isValidEmail,
  sanitizeText,
  sanitizeHeaderValue,
  checkFinancialCaps,
  decideApproval,
  parseGeminiJson,
  validateGeminiDecision,
  classifySupplierReply,
  extractPoReference,
  formatPoNumber,
};

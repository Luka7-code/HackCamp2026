"use strict";

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig(env = process.env) {
  const gmailAddress = env.GMAIL_ADDRESS || env.SMTP_USER || "";
  const gmailPassword = env.GMAIL_PASSWORD || env.SMTP_PASS || "";
  const emailFrom = env.EMAIL_FROM || gmailAddress;

  return {
    enabled: env.PROCUREMENT_ENABLED !== "false",
    absoluteMaxAmount: numberOr(env.PROCUREMENT_ABSOLUTE_MAX_AMOUNT, 5000),
    defaultCurrency: env.PROCUREMENT_DEFAULT_CURRENCY || "USD",
    companyName: env.PROCUREMENT_COMPANY_NAME || "Warehouse WMS",
    defaults: {
      approval_mode: env.PROCUREMENT_APPROVAL_MODE === "GEMINI" ? "GEMINI" : "HUMAN",
      max_auto_approve_amount: numberOr(env.PROCUREMENT_MAX_AUTO_APPROVE_AMOUNT, 500),
      monthly_budget: numberOr(env.PROCUREMENT_MONTHLY_BUDGET, 10000),
      max_po_quantity: numberOr(env.PROCUREMENT_MAX_PO_QUANTITY, 1000),
      auto_send_email: env.PROCUREMENT_AUTO_SEND_EMAIL === "true",
      currency: env.PROCUREMENT_DEFAULT_CURRENCY || "USD",
    },
    gemini: {
      apiKey: env.GEMINI_API_KEY || "",
      model: env.GEMINI_MODEL || "gemini-3.1-flash-lite",
      timeoutMs: numberOr(env.GEMINI_TIMEOUT_MS, 8000),
      endpoint: env.GEMINI_ENDPOINT || "https://generativelanguage.googleapis.com/v1beta",
    },
    email: {
      host: env.SMTP_HOST || "smtp.gmail.com",
      port: numberOr(env.SMTP_PORT, 587),
      secure: env.SMTP_SECURE === "true",
      user: gmailAddress,
      pass: gmailPassword,
      from: emailFrom,
      replyTo: env.EMAIL_REPLY_TO || emailFrom,
    },
  };
}

module.exports = { loadConfig };

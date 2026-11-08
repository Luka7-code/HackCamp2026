"use strict";

const { sanitizeHeaderValue } = require("./validation");

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(value, currency) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(amount);
  } catch {
    return `${currency || "USD"} ${amount.toFixed(2)}`;
  }
}

function buildPoEmail({ po, supplier, config }) {
  const currency = po.currency || config.defaultCurrency || "USD";
  const contact = (supplier && (supplier.contact_name || supplier.name)) || po.supplier_name || "Supplier";
  const delivery = po.expected_delivery_date || "as soon as possible";
  const destination = po.destination_location || "warehouse receiving";
  const subject = sanitizeHeaderValue(
    `Order ${po.po_number} - ${po.quantity} x ${po.sku_name || po.sku_id}`,
  );

  const text = [
    `Hello ${contact},`,
    "",
    "Please confirm the following order:",
    "",
    `Order: ${po.po_number}`,
    `Reference: ${po.po_number}`,
    `SKU: ${po.sku_id} - ${po.sku_name || ""}`.trim(),
    `Quantity: ${po.quantity}`,
    `Unit cost: ${money(po.unit_cost, currency)}`,
    `Total: ${money(po.total_cost, currency)}`,
    `Requested delivery date: ${delivery}`,
    `Deliver to: ${destination}`,
    "",
    'Reply with "CONFIRM" to accept or "DECLINE" with a reason.',
    "Please do not change quantities, prices, payment details or bank details by email.",
    "",
    "Thank you,",
    config.companyName || "Warehouse WMS",
  ].join("\n");

  const html = [
    `<p>Hello ${esc(contact)},</p>`,
    "<p>Please confirm the following order:</p>",
    "<ul>",
    `<li><strong>Order:</strong> ${esc(po.po_number)}</li>`,
    `<li><strong>SKU:</strong> ${esc(po.sku_id)} - ${esc(po.sku_name || "")}</li>`,
    `<li><strong>Quantity:</strong> ${esc(po.quantity)}</li>`,
    `<li><strong>Unit cost:</strong> ${esc(money(po.unit_cost, currency))}</li>`,
    `<li><strong>Total:</strong> ${esc(money(po.total_cost, currency))}</li>`,
    `<li><strong>Requested delivery date:</strong> ${esc(delivery)}</li>`,
    `<li><strong>Deliver to:</strong> ${esc(destination)}</li>`,
    "</ul>",
    '<p>Reply with "CONFIRM" to accept or "DECLINE" with a reason. Please do not change quantities, prices, payment details or bank details by email.</p>',
    `<p>Thank you,<br />${esc(config.companyName || "Warehouse WMS")}</p>`,
  ].join("\n");

  return { subject, text, html };
}

module.exports = { buildPoEmail, esc, money };

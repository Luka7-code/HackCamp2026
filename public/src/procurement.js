(() => {
  "use strict";

  const $id = (id) => document.getElementById(id);
  const STATUSES = [
    "PENDING_APPROVAL",
    "NEEDS_HUMAN_REVIEW",
    "APPROVED",
    "ORDER_SENT",
    "ORDER_CONFIRMED",
    "IN_TRANSIT",
    "RECEIVED",
    "REJECTED",
    "CANCELLED",
  ];

  const state = {
    summary: null,
    pos: [],
    suppliers: [],
    products: [],
    settings: null,
    settingsMeta: null,
    emails: [],
    locations: [],
    detail: null,
    loadedAt: 0,
    statusFilter: "",
    search: "",
  };

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function notify(message, isError) {
    if (typeof window.toast === "function") window.toast(message, Boolean(isError));
    else if (isError) console.error(message);
    else console.log(message);
  }

  function money(value, currency) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "-";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || state.settings?.currency || "USD",
      }).format(amount);
    } catch {
      return `${currency || "USD"} ${amount.toFixed(2)}`;
    }
  }

  function fmtDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 19);
    return date.toLocaleString();
  }

  function label(status) {
    return String(status || "").replace(/_/g, " ");
  }

  function statusBadge(status) {
    const value = String(status || "").toUpperCase();
    return `<span class="po-badge po-${esc(value)}">${esc(label(value))}</span>`;
  }

  function table(headers, rows, emptyMessage) {
    if (!rows.length) return `<p class="pred-empty">${esc(emptyMessage)}</p>`;
    const head = headers
      .map((header) => `<th class="${header.num ? "num" : ""}">${esc(header.label)}</th>`)
      .join("");
    return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!response.ok) {
      const error = new Error((data && data.error) || "Request failed");
      error.code = data && data.code;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function loadAll(force = false) {
    if (!force && state.loadedAt && Date.now() - state.loadedAt < 60_000) return;
    try {
      const [summary, pos, suppliers, products, settingsPayload, emails, locations] = await Promise.all([
        api("/api/procurement/summary"),
        api("/api/procurement/purchase-orders?limit=200"),
        api("/api/procurement/suppliers"),
        api("/api/procurement/products"),
        api("/api/procurement/settings"),
        api("/api/procurement/emails?limit=100"),
        api("/api/locations"),
      ]);

      state.summary = summary;
      state.pos = pos || [];
      state.suppliers = suppliers || [];
      state.products = products || [];
      state.settings = settingsPayload.settings;
      state.settingsMeta = settingsPayload;
      state.emails = emails || [];
      state.locations = locations || [];
      state.loadedAt = Date.now();

      $id("procUpdated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
      $id("procNote").textContent = [
        `Approval mode: ${state.settings.approval_mode}.`,
        `Auto-approve up to ${money(state.settings.max_auto_approve_amount, state.settings.currency)}.`,
        `Hard cap ${money(state.settingsMeta.absolute_max_amount, state.settings.currency)}.`,
        state.settingsMeta.gemini_configured ? "Gemini connected." : "Gemini key not configured.",
        state.settingsMeta.email_configured ? "Gmail SMTP configured." : "Gmail SMTP not configured.",
      ].join(" ");

      renderAll();
    } catch (error) {
      notify(error.message, true);
      $id("procNote").textContent = error.message;
    }
  }

  function renderAll() {
    renderSummary();
    renderPending();
    renderPOs();
    renderSuppliers();
    renderSettings();
    renderProducts();
    renderEmails();
    if (state.detail) {
      const fresh = state.pos.find((po) => po.po_id === state.detail.po.po_id);
      if (fresh) renderActionPanel({ ...state.detail, po: fresh });
    }
  }

  function kpi(labelText, value, sub, modifier) {
    return `<div class="pred-kpi ${modifier || ""}">
      <span class="label">${esc(labelText)}</span>
      <span class="value">${esc(value)}</span>
      <span class="sub">${esc(sub)}</span>
    </div>`;
  }

  function renderSummary() {
    if (!state.summary) return;
    const summary = state.summary;
    const currency = state.settings?.currency;
    const cards = [];
    cards.push(kpi("Pending approvals", summary.pending_approvals || 0, "Waiting for a decision", "risk"));
    cards.push(kpi("Awaiting supplier", summary.awaiting_supplier || 0, "Order email sent", "recommend"));
    cards.push(kpi("In transit", summary.in_transit || 0, "Confirmed or shipping", ""));
    cards.push(kpi("Pending spend", money(summary.pending_cost || 0, currency), "Open orders", "overstock"));
    $id("procKpis").innerHTML = cards.join("");
  }

  function poActions(po) {
    const buttons = [`<button type="button" class="secondary" data-act="open" data-po="${esc(po.po_id)}">Open</button>`];
    if (["PENDING_APPROVAL", "NEEDS_HUMAN_REVIEW"].includes(po.status)) {
      buttons.push(`<button type="button" data-act="approve" data-po="${esc(po.po_id)}">Approve</button>`);
      buttons.push(`<button type="button" class="secondary" data-act="reject" data-po="${esc(po.po_id)}">Reject</button>`);
    }
    if (po.status === "APPROVED") {
      buttons.push(`<button type="button" data-act="send" data-po="${esc(po.po_id)}">Send email</button>`);
    }
    if (["ORDER_CONFIRMED", "IN_TRANSIT"].includes(po.status)) {
      buttons.push(`<button type="button" data-act="open" data-po="${esc(po.po_id)}">Receive</button>`);
    }
    return `<div class="proc-row-actions">${buttons.join("")}</div>`;
  }

  function renderPending() {
    const panel = $id("procPendingPanel");
    const pending = state.pos.filter((po) => ["PENDING_APPROVAL", "NEEDS_HUMAN_REVIEW"].includes(po.status));
    if (panel) panel.hidden = pending.length === 0;
    if (!pending.length) {
      $id("procPending").innerHTML = "";
      $id("procPendingCount").textContent = "";
      return;
    }

    $id("procPendingCount").textContent = `${pending.length} awaiting a decision`;
    const rows = pending.map(
      (po) => `<tr>
        <td>${esc(po.po_number)}<span class="sub">${esc(po.sku_id)}</span></td>
        <td>${esc(po.sku_name || "-")}</td>
        <td>${esc(po.supplier_name || "No supplier")}<span class="sub">${esc(po.supplier_email || "no email")}</span></td>
        <td class="num">${esc(po.quantity)}</td>
        <td class="num">${esc(money(po.total_cost, po.currency))}</td>
        <td>${statusBadge(po.status)}</td>
        <td>${poActions(po)}</td>
      </tr>`,
    );
    $id("procPending").innerHTML = table(
      [
        { label: "Order" },
        { label: "Product" },
        { label: "Supplier" },
        { label: "Qty", num: true },
        { label: "Total", num: true },
        { label: "Status" },
        { label: "" },
      ],
      rows,
      "Nothing waiting for approval.",
    );
  }

  function renderPOs() {
    const search = state.search.trim().toLowerCase();
    const rowsData = state.pos.filter((po) => {
      if (state.statusFilter && po.status !== state.statusFilter) return false;
      if (!search) return true;
      return [po.po_number, po.sku_id, po.sku_name, po.supplier_name, po.supplier_email]
        .join(" ")
        .toLowerCase()
        .includes(search);
    });

    $id("procPOCount").textContent = `${rowsData.length} shown · ${state.pos.length} total`;

    const rows = rowsData.map(
      (po) => `<tr>
        <td>${esc(po.po_number)}<span class="sub">${esc(fmtDate(po.created_at))}</span></td>
        <td>${esc(po.sku_name || "-")}<span class="sub">${esc(po.sku_id)}</span></td>
        <td>${esc(po.supplier_name || "-")}</td>
        <td class="num">${esc(po.quantity)}</td>
        <td class="num">${esc(money(po.total_cost, po.currency))}</td>
        <td>${statusBadge(po.status)}</td>
        <td>${esc(po.email_status || "-")}</td>
        <td>${esc(po.expected_delivery_date || "-")}</td>
        <td>${poActions(po)}</td>
      </tr>`,
    );

    $id("procPOs").innerHTML = table(
      [
        { label: "Order" },
        { label: "Product" },
        { label: "Supplier" },
        { label: "Qty", num: true },
        { label: "Total", num: true },
        { label: "Status" },
        { label: "Email" },
        { label: "Delivery" },
        { label: "" },
      ],
      rows,
      "No orders yet. Run automation or create one from a recommendation.",
    );
  }

  function renderSuppliers() {
    const rows = state.suppliers.map(
      (supplier) => `<tr>
        <td>${esc(supplier.name)}</td>
        <td>${esc(supplier.email)}</td>
        <td>${esc(supplier.contact_name || "-")}</td>
        <td class="num">${esc(supplier.lead_time_days ?? "-")}</td>
        <td>${supplier.active ? "Active" : "Inactive"}</td>
      </tr>`,
    );
    $id("procSuppliers").innerHTML = table(
      [{ label: "Name" }, { label: "Email" }, { label: "Contact" }, { label: "Lead days", num: true }, { label: "Status" }],
      rows,
      "No suppliers yet. Add one below.",
    );
  }

  function renderSettings() {
    if (!state.settings) return;
    const settings = state.settings;
    const meta = state.settingsMeta || {};
    $id("procSettings").innerHTML = `
      <div class="proc-setting-grid">
        <label>Approval mode
          <select id="procSetMode">
            <option value="HUMAN"${settings.approval_mode === "HUMAN" ? " selected" : ""}>Human approval</option>
            <option value="GEMINI"${settings.approval_mode === "GEMINI" ? " selected" : ""}>Gemini AI approval</option>
          </select>
        </label>
        <label>Auto-approve limit
          <input id="procSetAuto" type="number" min="0" step="0.01" value="${esc(settings.max_auto_approve_amount)}" />
        </label>
        <label>Monthly budget
          <input id="procSetBudget" type="number" min="0" step="0.01" value="${esc(settings.monthly_budget)}" />
        </label>
        <label>Max order quantity
          <input id="procSetQty" type="number" min="1" step="1" value="${esc(settings.max_po_quantity)}" />
        </label>
        <label>Currency
          <input id="procSetCurrency" maxlength="3" value="${esc(settings.currency)}" />
        </label>
        <label class="proc-check">
          <input id="procSetAutoSend" type="checkbox"${settings.auto_send_email ? " checked" : ""} />
          Send supplier email immediately after approval
        </label>
      </div>
      <div class="proc-actions">
        <button id="procSetSave" type="button">Save settings</button>
        <span class="hint">Hard cap ${esc(money(meta.absolute_max_amount, settings.currency))} is set by the server environment and cannot be edited here.</span>
      </div>`;
    $id("procSetSave").addEventListener("click", saveSettings);
  }

  async function saveSettings() {
    const button = $id("procSetSave");
    button.disabled = true;
    try {
      const payload = {
        approval_mode: $id("procSetMode").value,
        max_auto_approve_amount: Number($id("procSetAuto").value),
        monthly_budget: Number($id("procSetBudget").value),
        max_po_quantity: Number($id("procSetQty").value),
        currency: $id("procSetCurrency").value,
        auto_send_email: $id("procSetAutoSend").checked,
      };
      await api("/api/procurement/settings", { method: "PATCH", body: JSON.stringify(payload) });
      notify("Procurement settings saved");
      state.loadedAt = 0;
      await loadAll(true);
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  function supplierOptions(selected) {
    const options = ['<option value="">No supplier</option>'];
    for (const supplier of state.suppliers) {
      options.push(
        `<option value="${esc(supplier.supplier_id)}"${supplier.supplier_id === selected ? " selected" : ""}>${esc(
          supplier.name,
        )}</option>`,
      );
    }
    return options.join("");
  }

  function renderProducts() {
    const rows = state.products.slice(0, 100).map(
      (product) => `<tr>
        <td>${esc(product.name || "-")}<span class="sub">${esc(product.sku_id)}</span></td>
        <td class="num">${esc(product.on_hand ?? "-")}</td>
        <td>${esc(product.risk_level || "-")}</td>
        <td class="num">${esc(product.recommended_qty ?? "-")}</td>
        <td>
          <select data-product-supplier="${esc(product.sku_id)}">${supplierOptions(product.supplier_id)}</select>
        </td>
        <td class="num">
          <input data-product-cost="${esc(product.sku_id)}" type="number" min="0" step="0.01"
                 value="${product.unit_cost == null ? "" : esc(product.unit_cost)}" placeholder="cost" />
        </td>
        <td>
          <input data-product-dest="${esc(product.sku_id)}" value="${esc(product.destination_location || "")}"
                 placeholder="destination" />
        </td>
        <td>
          <button type="button" class="secondary" data-product-save="${esc(product.sku_id)}">Save</button>
        </td>
      </tr>`,
    );
    $id("procProducts").innerHTML = table(
      [
        { label: "Product" },
        { label: "On hand", num: true },
        { label: "Risk" },
        { label: "Recommended", num: true },
        { label: "Supplier" },
        { label: "Unit cost", num: true },
        { label: "Destination" },
        { label: "" },
      ],
      rows,
      "No products available.",
    );
  }

  function renderEmails() {
    const rows = state.emails.map(
      (message) => `<tr>
        <td>${esc(fmtDate(message.created_at))}</td>
        <td>${esc(message.direction)}</td>
        <td>${esc(message.from_email || "-")} → ${esc(message.to_email || "-")}</td>
        <td>${esc(message.subject || "-")}</td>
        <td>${esc(message.status || "-")}</td>
        <td><details><summary>View</summary><pre class="proc-email-body">${esc(
          (message.body_text || "").slice(0, 2000),
        )}</pre></details></td>
      </tr>`,
    );
    $id("procEmails").innerHTML = table(
      [
        { label: "When" },
        { label: "Direction" },
        { label: "From / To" },
        { label: "Subject" },
        { label: "Status" },
        { label: "Body" },
      ],
      rows,
      "No supplier emails yet.",
    );
  }

  async function openPO(poId) {
    try {
      const detail = await api(`/api/procurement/purchase-orders/${encodeURIComponent(poId)}`);
      state.detail = detail;
      renderActionPanel(detail);
      $id("procActionPanel").hidden = false;
      $id("procActionPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      notify(error.message, true);
    }
  }

  function renderActionPanel(detail) {
    const po = detail.po;
    const emails = detail.emails || [];

    const actions = [];
    if (["PENDING_APPROVAL", "NEEDS_HUMAN_REVIEW"].includes(po.status)) {
      actions.push('<button type="button" data-act="evaluate" data-po="' + esc(po.po_id) + '">Run AI evaluation</button>');
      actions.push('<button type="button" data-act="edit" data-po="' + esc(po.po_id) + '">Edit quantity</button>');
      actions.push('<button type="button" data-act="approve" data-po="' + esc(po.po_id) + '">Approve</button>');
      actions.push('<button type="button" class="secondary" data-act="reject" data-po="' + esc(po.po_id) + '">Reject</button>');
    }
    if (po.status === "APPROVED") {
      actions.push('<button type="button" data-act="send" data-po="' + esc(po.po_id) + '">Send supplier email</button>');
    }
    if (["ORDER_SENT", "ORDER_CONFIRMED", "IN_TRANSIT"].includes(po.status)) {
      actions.push('<button type="button" data-act="reply" data-po="' + esc(po.po_id) + '">Record supplier reply</button>');
    }
    if (["ORDER_CONFIRMED", "IN_TRANSIT"].includes(po.status)) {
      actions.push('<button type="button" data-act="receive" data-po="' + esc(po.po_id) + '">Confirm receipt</button>');
    }
    if (!["RECEIVED", "REJECTED", "CANCELLED"].includes(po.status)) {
      actions.push('<button type="button" class="danger" data-act="cancel" data-po="' + esc(po.po_id) + '">Cancel</button>');
    }
    actions.push('<button type="button" class="secondary" data-act="close">Close</button>');

    const locationOptions = state.locations
      .map(
        (location) =>
          `<option value="${esc(location.location_code)}"${
            location.location_code === po.destination_location ? " selected" : ""
          }>${esc(location.label || location.location_code)}</option>`,
      )
      .join("");

    const emailRows = emails.map(
      (message) => `<tr>
        <td>${esc(fmtDate(message.created_at))}</td>
        <td>${esc(message.direction)}</td>
        <td>${esc(message.subject || "-")}</td>
        <td>${esc(message.status || "-")}</td>
        <td><pre class="proc-email-body">${esc((message.body_text || "").slice(0, 1200))}</pre></td>
      </tr>`,
    );

    $id("procActionPanel").innerHTML = `
      <div class="pred-panel-head">
        <div>
          <h3>${esc(po.po_number)} ${statusBadge(po.status)}</h3>
          <p class="hint">${esc(po.sku_name || "-")} · ${esc(po.sku_id)} · ${esc(po.supplier_name || "no supplier")}</p>
        </div>
        <span class="hint">Created ${esc(fmtDate(po.created_at))}</span>
      </div>

      <div class="proc-detail-grid">
        <div><span class="label">Quantity</span><strong>${esc(po.quantity)}</strong></div>
        <div><span class="label">Unit cost</span><strong>${esc(money(po.unit_cost, po.currency))}</strong></div>
        <div><span class="label">Total</span><strong>${esc(money(po.total_cost, po.currency))}</strong></div>
        <div><span class="label">Supplier email</span><strong>${esc(po.supplier_email || "-")}</strong></div>
        <div><span class="label">Destination</span><strong>${esc(po.destination_location || "-")}</strong></div>
        <div><span class="label">Approval mode</span><strong>${esc(po.approval_mode || "-")}</strong></div>
        <div><span class="label">Gemini decision</span><strong>${esc(po.gemini_decision || "-")}</strong></div>
        <div><span class="label">Risk level</span><strong>${esc(po.gemini_risk_level || "-")}</strong></div>
      </div>
      <p class="hint">${esc(po.approval_reason || "")} ${esc(po.gemini_reason || "")}</p>

      <div class="proc-actions">${actions.join("")}</div>

      <div id="procActionForm"></div>

      <h4>Email log</h4>
      <div class="scroll">${table(
        [{ label: "When" }, { label: "Dir" }, { label: "Subject" }, { label: "Status" }, { label: "Body" }],
        emailRows,
        "No emails for this order.",
      )}</div>
      <div id="procActionHint" class="hint"></div>
      ${locationOptions ? "" : ""}
    `;

    state.actionLocationOptions = locationOptions;
    state.actionPo = po;
  }

  function showActionForm(kind) {
    const po = state.actionPo;
    if (!po) return;
    const form = $id("procActionForm");
    if (!form) return;

    if (kind === "edit") {
      form.innerHTML = `
        <div class="proc-form">
          <label>Quantity <input id="procEditQty" type="number" min="1" step="1" value="${esc(po.quantity)}" /></label>
          <label>Unit cost <input id="procEditCost" type="number" min="0" step="0.01" value="${esc(po.unit_cost ?? "")}" /></label>
          <label>Supplier <select id="procEditSupplier">${supplierOptions(po.supplier_id)}</select></label>
          <label>Destination <input id="procEditDest" value="${esc(po.destination_location || "")}" /></label>
          <button type="button" data-act="save-edit" data-po="${esc(po.po_id)}">Save changes</button>
        </div>`;
    } else if (kind === "reply") {
      form.innerHTML = `
        <div class="proc-form">
          <label>From email <input id="procReplyFrom" type="email" value="${esc(po.supplier_email || "")}" /></label>
          <label>Subject <input id="procReplySubject" value="Re: ${esc(po.po_number)}" /></label>
          <label>Supplier reply <textarea id="procReplyBody" rows="4" placeholder="Paste the supplier email here..."></textarea></label>
          <div class="proc-actions">
            <button type="button" data-act="submit-reply" data-po="${esc(po.po_id)}">Save reply</button>
            <button type="button" class="secondary" data-act="quick-confirm" data-po="${esc(po.po_id)}">Quick confirm</button>
            <button type="button" class="secondary" data-act="quick-decline" data-po="${esc(po.po_id)}">Quick decline</button>
          </div>
        </div>`;
    } else if (kind === "receive") {
      form.innerHTML = `
        <div class="proc-form">
          <label>Received quantity
            <input id="procReceiveQty" type="number" min="1" step="1" value="${esc(po.approved_quantity || po.quantity)}" />
          </label>
          <label>Location
            <select id="procReceiveLoc">${state.actionLocationOptions || '<option value="">No locations</option>'}</select>
          </label>
          <label>Note <input id="procReceiveNote" placeholder="Optional" /></label>
          <div class="proc-actions">
            <button type="button" data-act="submit-receive" data-po="${esc(po.po_id)}">Confirm receipt</button>
          </div>
          <p class="hint">Confirming receipt does not change stock. Add the received units with the Register item tab.</p>
        </div>`;
    } else if (kind === "reject") {
      form.innerHTML = `
        <div class="proc-form">
          <label>Reason <input id="procRejectReason" placeholder="Why is this order rejected?" /></label>
          <button type="button" class="danger" data-act="submit-reject" data-po="${esc(po.po_id)}">Reject order</button>
        </div>`;
    } else {
      form.innerHTML = "";
    }
  }

  async function perform(button, fn) {
    if (button) button.disabled = true;
    try {
      await fn();
    } catch (error) {
      notify(error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function refreshAfterAction(poId) {
    state.loadedAt = 0;
    await loadAll(true);
    if (poId) await openPO(poId);
  }

  function wireActions() {
    const panel = $id("procActionPanel");
    const pending = $id("procPending");
    const pos = $id("procPOs");

    async function handle(event) {
      const button = event.target.closest("button[data-act]");
      if (!button) return;
      const act = button.dataset.act;
      const poId = button.dataset.po;
      event.preventDefault();

      if (act === "open") return openPO(poId);
      if (act === "close") {
        $id("procActionPanel").hidden = true;
        state.detail = null;
        return;
      }
      if (act === "edit") return showActionForm("edit");
      if (act === "reply") return showActionForm("reply");
      if (act === "receive") return showActionForm("receive");

      if (act === "approve") {
        return perform(button, async () => {
          const body = {
            approved_quantity: state.actionPo && state.actionPo.po_id === poId ? state.actionPo.quantity : undefined,
            note: "Approved from manager dashboard",
          };
          await api(`/api/procurement/purchase-orders/${encodeURIComponent(poId)}/approve`, {
            method: "POST",
            body: JSON.stringify(body),
          });
          notify("Order approved");
          await refreshAfterAction(poId);
        });
      }

      if (act === "reject") {
        return showActionForm("reject");
      }

      if (act === "submit-reject") {
        const reason = $id("procRejectReason") ? $id("procRejectReason").value : "";
        return perform(button, async () => {
          await api(`/api/procurement/purchase-orders/${encodeURIComponent(poId)}/reject`, {
            method: "POST",
            body: JSON.stringify({ reason }),
          });
          notify("Order rejected");
          await refreshAfterAction(poId);
        });
      }

      if (act === "evaluate") {
        return perform(button, async () => {
          const result = await api(`/api/procurement/purchase-orders/${encodeURIComponent(poId)}/evaluate`, {
            method: "POST",
            body: JSON.stringify({}),
          });
          notify(
            `AI evaluation: ${result.decision ? result.decision.outcome : result.po.status}` +
              (result.decision && result.decision.reason ? ` — ${result.decision.reason}` : ""),
            result.decision && result.decision.outcome === "NEEDS_HUMAN_REVIEW",
          );
          await refreshAfterAction(poId);
        });
      }

      if (act === "send") {
        return perform(button, async () => {
          const result = await api(`/api/procurement/purchase-orders/${encodeURIComponent(poId)}/send`, {
            method: "POST",
            body: JSON.stringify({}),
          });
          notify(result.already_sent ? "Email was already sent" : "Supplier email sent");
          await refreshAfterAction(poId);
        });
      }

      if (act === "submit-reply") {
        const body = {
          from_email: $id("procReplyFrom") ? $id("procReplyFrom").value : "",
          subject: $id("procReplySubject") ? $id("procReplySubject").value : "",
          body: $id("procReplyBody") ? $id("procReplyBody").value : "",
        };
        return perform(button, async () => {
          const result = await api(`/api/procurement/purchase-orders/${encodeURIComponent(poId)}/supplier-response`, {
            method: "POST",
            body: JSON.stringify(body),
          });
          notify(result.sender_match === false ? "Reply saved — sender mismatch, needs review" : `Reply saved: ${result.intent}`);
          await refreshAfterAction(poId);
        });
      }

      if (act === "quick-confirm" || act === "quick-decline") {
        const intent = act === "quick-confirm" ? "CONFIRM" : "DECLINE";
        return perform(button, async () => {
          await api(`/api/procurement/purchase-orders/${encodeURIComponent(poId)}/supplier-response`, {
            method: "POST",
            body: JSON.stringify({ intent }),
          });
          notify(intent === "CONFIRM" ? "Supplier confirmation recorded" : "Supplier decline recorded");
          await refreshAfterAction(poId);
        });
      }

      if (act === "submit-receive") {
        const body = {
          received_quantity: Number($id("procReceiveQty").value),
          location_code: $id("procReceiveLoc").value,
          note: $id("procReceiveNote").value,
        };
        return perform(button, async () => {
          const result = await api(`/api/procurement/purchase-orders/${encodeURIComponent(poId)}/receive`, {
            method: "POST",
            body: JSON.stringify(body),
          });
          notify(
            result.already_received
              ? "This order was already received"
              : "Receipt recorded. Add the units from the Register item tab.",
          );
          await refreshAfterAction(poId);
          const hint = $id("procActionHint");
          if (hint) {
            hint.innerHTML =
              'Receipt recorded. Stock is unchanged — <button type="button" class="link-btn" data-act="goto-register">open Register item</button> to add the received units.';
          }
        });
      }

      if (act === "goto-register") {
        if (typeof window.showTab === "function") window.showTab("register");
        const nameField = $id("newName");
        if (nameField && state.actionPo) nameField.value = state.actionPo.sku_name || "";
        return;
      }

      if (act === "cancel") {
        return perform(button, async () => {
          await api(`/api/procurement/purchase-orders/${encodeURIComponent(poId)}/cancel`, {
            method: "POST",
            body: JSON.stringify({ reason: "Cancelled from manager dashboard" }),
          });
          notify("Order cancelled");
          await refreshAfterAction(poId);
        });
      }

      if (act === "save-edit") {
        const supplier = $id("procEditSupplier");
        const body = {
          quantity: Number($id("procEditQty").value),
          unit_cost: Number($id("procEditCost").value),
          supplier_id: supplier && supplier.value ? supplier.value : null,
          destination_location: $id("procEditDest").value,
        };
        return perform(button, async () => {
          await api(`/api/procurement/purchase-orders/${encodeURIComponent(poId)}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          });
          notify("Order updated");
          await refreshAfterAction(poId);
        });
      }
    }

    panel.addEventListener("click", handle);
    pending.addEventListener("click", handle);
    pos.addEventListener("click", handle);

    // product save
    $id("procProducts").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-product-save]");
      if (!button) return;
      const sku = button.dataset.productSave;
      const supplier = document.querySelector(`[data-product-supplier="${CSS.escape(sku)}"]`);
      const cost = document.querySelector(`[data-product-cost="${CSS.escape(sku)}"]`);
      const dest = document.querySelector(`[data-product-dest="${CSS.escape(sku)}"]`);
      perform(button, async () => {
        await api(`/api/procurement/products/${encodeURIComponent(sku)}`, {
          method: "PATCH",
          body: JSON.stringify({
            supplier_id: supplier && supplier.value ? supplier.value : null,
            unit_cost: cost && cost.value !== "" ? Number(cost.value) : undefined,
            default_destination_location: dest ? dest.value : "",
          }),
        });
        notify("Product procurement settings saved");
        state.loadedAt = 0;
        await loadAll(true);
      });
    });
  }

  function wireControls() {
    const filter = $id("procStatusFilter");
    filter.innerHTML =
      '<option value="">All statuses</option>' +
      STATUSES.map((status) => `<option value="${status}">${label(status)}</option>`).join("");
    filter.addEventListener("change", () => {
      state.statusFilter = filter.value;
      renderPOs();
    });

    const search = $id("procSearch");
    search.addEventListener("input", () => {
      state.search = search.value;
      renderPOs();
    });

    $id("procRefreshBtn").addEventListener("click", () => loadAll(true));

    $id("procRunBtn").addEventListener("click", async () => {
      const button = $id("procRunBtn");
      button.disabled = true;
      $id("procRunNote").textContent = "Scanning restock recommendations...";
      try {
        const result = await api("/api/procurement/run", {
          method: "POST",
          body: JSON.stringify({ limit: 20 }),
        });
        const parts = [`Created ${result.created} order(s)`];
        if (result.needs_review) parts.push(`${result.needs_review} need product setup`);
        if (result.duplicates) parts.push(`${result.duplicates} duplicate(s) skipped`);
        if (result.skipped) parts.push(`${result.skipped} skipped`);
        $id("procRunNote").textContent = `${parts.join(" · ")}.`;
        notify(
          result.created
            ? `Automation run created ${result.created} order(s)`
            : "No orders created — no SKUs need restocking right now",
        );
        state.loadedAt = 0;
        await loadAll(true);
      } catch (error) {
        $id("procRunNote").textContent = error.message;
        notify(error.message, true);
      } finally {
        button.disabled = false;
      }
    });

    $id("supAddBtn").addEventListener("click", async () => {
      const button = $id("supAddBtn");
      button.disabled = true;
      try {
        await api("/api/procurement/suppliers", {
          method: "POST",
          body: JSON.stringify({
            name: $id("supName").value,
            email: $id("supEmail").value,
            contact_name: $id("supContact").value,
            lead_time_days: Number($id("supLead").value),
          }),
        });
        $id("supName").value = "";
        $id("supEmail").value = "";
        $id("supContact").value = "";
        notify("Supplier added");
        state.loadedAt = 0;
        await loadAll(true);
      } catch (error) {
        notify(error.message, true);
      } finally {
        button.disabled = false;
      }
    });
  }

  function init() {
    wireActions();
    wireControls();

    // index.html's bottom-nav toggle calls this when the panel opens.
    window.loadProcurement = () => loadAll(true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

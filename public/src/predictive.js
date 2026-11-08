/* Predictive AI dashboard. Loaded only for the manager-only tab. */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    dashboard: null,
    sku: null,
    horizon: 30,
    chart: null,
    loading: false,
    loadedAt: 0,
    showTable: false,
    chartToken: 0,
  };

  const NEUTRAL_NOTE =
    "Forecasts combine recent demand history, current inventory, supplier lead times and safety stock.";

  const COLORS = {
    blue: "#2a78d6",
    orange: "#eb6834",
    ink: "#1d2433",
    ink2: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    surface: "#ffffff",
  };

  const RISK_LABELS = {
    OUT: "⛔ Out",
    CRITICAL: "⚠ Critical",
    WARNING: "▲ Warning",
    OK: "● OK",
    NO_DEMAND: "— No demand",
  };

  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (char) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  function fmt(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return Number(value).toLocaleString(undefined, {
      maximumFractionDigits: digits,
      minimumFractionDigits: 0,
    });
  }

  function fmtInt(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function setChartStatus(text, busy = false) {
    const element = $("predChartStatus");
    element.innerHTML = text ? `${busy ? '<span class="spinner"></span>' : ""}${esc(text)}` : "";
  }

  function notify(message, isError = false) {
    if (typeof window.toast === "function") window.toast(message, isError);
    else if (isError) console.error(message);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json" },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function riskBadge(level) {
    const label = RISK_LABELS[level] || level;
    return `<span class="risk-badge risk-${esc(level)}">${esc(label)}</span>`;
  }

  function kpi(label, value, sub, className = "") {
    return `<div class="pred-kpi ${className}">
      <span class="label">${esc(label)}</span>
      <span class="value">${value}</span>
      <span class="sub">${sub}</span>
    </div>`;
  }

  function table(headers, rows, emptyMessage) {
    if (!rows.length) return `<p class="pred-empty">${esc(emptyMessage)}</p>`;
    const head = headers
      .map((header) => `<th class="${header.num ? "num" : ""}">${esc(header.label)}</th>`)
      .join("");
    return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
  }

  // ---------- load ----------

  async function loadDashboard(force = false) {
    if (state.loading) return;
    state.loading = true;
    $("predNote").className = "pred-note";
    $("predNote").textContent = "Refreshing forecasts…";
    try {
      const data = await api(`/api/predictive/dashboard${force ? "?refresh=1" : ""}`);
      state.dashboard = data;
      state.loadedAt = Date.now();
      $("predNote").className = "pred-note";
      $("predNote").textContent = NEUTRAL_NOTE;
      renderDashboard(data);
      if (!state.sku || !data.forecasts.some((item) => item.sku_id === state.sku)) {
        state.sku = data.forecasts[0] ? data.forecasts[0].sku_id : null;
      }
      renderSkuOptions(data.forecasts);
      await loadForecast();
    } catch (err) {
      $("predNote").className = "pred-note note-error";
      $("predNote").textContent = `Could not load forecasts: ${err.message}`;
      notify(err.message, true);
    } finally {
      state.loading = false;
    }
  }

  function renderDashboard(data) {
    $("predUpdated").textContent = data.generated_at ? `Updated ${formatTime(data.generated_at)}` : "";

    const summary = data.summary;
    $("predSummary").innerHTML = [
      kpi("SKUs analysed", fmtInt(summary.skus), "current warehouse inventory"),
      kpi(
        "At risk",
        fmtInt(summary.at_risk),
        `${fmtInt(summary.critical)} critical · ${fmtInt(summary.warning)} warning · ${fmtInt(summary.out)} out`,
        "risk",
      ),
      kpi(
        "Recommended reorder",
        `${fmtInt(summary.recommended_units)} <small>units</small>`,
        "review before ordering",
        "recommend",
      ),
      kpi("Overstock", fmtInt(summary.overstock), "low demand vs. stock", "overstock"),
      kpi("Forecast horizon", "30 days", "7 / 14 / 30-day views"),
    ].join("");

    renderStockouts(data.stockouts, summary);
    renderOverstock(data.overstock);
    renderRestock(data.restock);
    renderSettings(data.all);
  }

  function renderStockouts(rows, summary) {
    $("predRiskCount").textContent = `${rows.length} flagged · ${summary.critical} critical, ${summary.warning} warning`;
    const body = rows.map(
      (row) => `<tr title="${esc(row.recommendation)}">
        <td>${esc(row.name)}<span class="sub">${esc(row.sku_id)}</span></td>
        <td class="num">${fmtInt(row.on_hand)}</td>
        <td class="num">${fmt(row.avg_daily_demand)}</td>
        <td class="num">${row.days_to_stockout === null ? "—" : fmtInt(row.days_to_stockout)}</td>
        <td>${esc(row.stockout_date || "—")}</td>
        <td class="num">${fmtInt(row.lead_time_days)}d</td>
        <td>${riskBadge(row.risk_level)}</td>
      </tr>`,
    );
    $("predStockouts").innerHTML = table(
      [
        { label: "Product" },
        { label: "On hand", num: true },
        { label: "Demand/day", num: true },
        { label: "Days left", num: true },
        { label: "Stockout date" },
        { label: "Lead time", num: true },
        { label: "Risk" },
      ],
      body,
      "No products are at risk of running out.",
    );
  }

  function renderOverstock(rows) {
    $("predOverCount").textContent = `${rows.length} product(s) flagged`;
    const body = rows.map(
      (row) => `<tr>
        <td>${esc(row.name)}<span class="sub">${esc(row.sku_id)}</span></td>
        <td class="num">${fmtInt(row.on_hand)}</td>
        <td class="num">${fmt(row.avg_daily_demand)}</td>
        <td class="num">${row.days_of_supply === null ? "—" : fmt(row.days_of_supply)}</td>
        <td class="num">${fmt(row.forecast_30d)}</td>
        <td>${esc(row.recommendation)}</td>
      </tr>`,
    );
    $("predOverstock").innerHTML = table(
      [
        { label: "Product" },
        { label: "On hand", num: true },
        { label: "Demand/day", num: true },
        { label: "Days of supply", num: true },
        { label: "30d forecast", num: true },
        { label: "Suggestion" },
      ],
      body,
      "No overstock detected.",
    );
  }

  function renderRestock(rows) {
    const body = rows.map(
      (row) => `<tr title="${esc(row.recommendation)}">
        <td>${esc(row.name)}<span class="sub">${esc(row.sku_id)}</span></td>
        <td class="num">${fmtInt(row.on_hand)}</td>
        <td class="num">${fmtInt(row.reorder_point)}</td>
        <td class="num"><strong>${fmtInt(row.recommended_qty)}</strong></td>
        <td class="num">${fmtInt(row.lead_time_days)}d</td>
        <td class="num">${fmtInt(row.safety_stock_units)}</td>
        <td>${riskBadge(row.risk_level)}</td>
        <td>
          <button type="button" data-review="APPROVED" data-sku="${esc(row.sku_id)}" data-qty="${row.recommended_qty}">Approve</button>
          <button type="button" class="secondary" data-review="DISMISSED" data-sku="${esc(row.sku_id)}" data-qty="${row.recommended_qty}">Dismiss</button>
        </td>
      </tr>`,
    );
    $("predRestock").innerHTML = table(
      [
        { label: "Product" },
        { label: "On hand", num: true },
        { label: "Reorder point", num: true },
        { label: "Recommended", num: true },
        { label: "Lead time", num: true },
        { label: "Safety stock", num: true },
        { label: "Risk" },
        { label: "Manager review" },
      ],
      body,
      "No restocking recommendations right now.",
    );
  }

  function renderSettings(rows) {
    const body = rows.map(
      (row) => `<tr data-sku="${esc(row.sku_id)}">
        <td>${esc(row.name)}<span class="sub">${esc(row.sku_id)}</span></td>
        <td>${esc(row.supplier_name || "—")}</td>
        <td><input type="number" data-field="lead_time_days" value="${row.lead_time_days}" min="0" max="120" step="1" aria-label="Lead time days for ${esc(row.name)}" /></td>
        <td><input type="number" data-field="safety_stock_days" value="${row.safety_stock_days}" min="0" max="90" step="1" aria-label="Safety stock days for ${esc(row.name)}" /></td>
        <td><input type="number" data-field="overstock_days" value="${row.overstock_days}" min="1" max="365" step="1" aria-label="Overstock days for ${esc(row.name)}" /></td>
        <td><span class="source-tag ${row.settings_source === "MANAGER" ? "manager" : ""}">${row.settings_source === "MANAGER" ? "Manager" : "Default"}</span></td>
        <td><button type="button" class="secondary" data-save-settings="${esc(row.sku_id)}">Save</button></td>
      </tr>`,
    );
    $("predSettings").innerHTML = `<table class="settings-table"><thead><tr>
      <th>Product</th><th>Supplier</th><th>Lead time (days)</th><th>Safety stock (days)</th><th>Overstock (days)</th><th>Source</th><th></th>
    </tr></thead><tbody>${body.join("")}</tbody></table>`;
  }

  // ---------- forecast ----------

  function renderSkuOptions(forecasts) {
    const select = $("predSku");
    select.innerHTML = forecasts
      .map(
        (item) =>
          `<option value="${esc(item.sku_id)}" ${item.sku_id === state.sku ? "selected" : ""}>${esc(item.name)} (${esc(item.sku_id)})</option>`,
      )
      .join("");
  }

  async function loadForecast() {
    if (!state.sku) return;
    try {
      const data = await api(
        `/api/predictive/forecast/${encodeURIComponent(state.sku)}?horizon=${state.horizon}`,
      );
      renderForecast(data);
    } catch (err) {
      notify(err.message, true);
    }
  }

  function renderForecast(data) {
    const forecast = data.forecast || [];
    const average = forecast.length
      ? forecast.reduce((sum, point) => sum + point.units, 0) / forecast.length
      : 0;
    $("predMetrics").innerHTML = [
      `<span>Average demand <strong>${fmt(average)}</strong> units/day</span>`,
      `<span>Next 7 days <strong>${fmt(data.totals.d7)}</strong> units</span>`,
      `<span>Next 14 days <strong>${fmt(data.totals.d14)}</strong> units</span>`,
      `<span>Next 30 days <strong>${fmt(data.totals.d30)}</strong> units</span>`,
      `<span>On hand <strong>${fmtInt(data.on_hand)}</strong></span>`,
    ].join("");

    renderForecastTable(data);
    renderChart(data);
  }

  function renderChart(data) {
    const canvas = $("predChart");
    state.chartToken += 1;
    const token = state.chartToken;

    if (typeof Chart === "undefined") {
      canvas.hidden = true;
      $("predTableWrap").hidden = false;
      state.showTable = true;
      $("predTableBtn").textContent = "Hide data table";
      setChartStatus("Chart library unavailable — showing data table");
      return;
    }
    canvas.hidden = false;

    const history = data.history || [];
    const forecast = data.forecast || [];
    if (!history.length || !forecast.length) {
      setChartStatus("No forecast data");
      return;
    }

    const labels = [...history.map((point) => point.date), ...forecast.map((point) => point.date)];
    const historyData = [...history.map((point) => point.units), ...forecast.map(() => null)];
    const forecastValues = forecast.map((point) => point.units);
    const startIndex = history.length - 1;
    const bridgeValue = history[startIndex].units;
    const yMax = Math.max(...historyData.filter((value) => value !== null), ...forecastValues, 1) * 1.1;

    if (state.chart) state.chart.destroy();

    const divider = {
      id: "forecastDivider",
      afterDraw(chart) {
        const x = chart.scales.x.getPixelForValue(history.length - 0.5);
        const { top, bottom } = chart.chartArea;
        const context = chart.ctx;
        context.save();
        context.strokeStyle = COLORS.axis;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x, top);
        context.lineTo(x, bottom);
        context.stroke();
        context.fillStyle = COLORS.muted;
        context.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
        context.fillText("Forecast", x + 6, top + 12);
        context.restore();
      },
    };

    const leading = {
      id: "forecastLeading",
      afterDatasetsDraw(chart) {
        const index = chart.$revealIndex;
        if (index === null || index === undefined) return;
        const x = chart.scales.x.getPixelForValue(index);
        const { top, bottom } = chart.chartArea;
        const context = chart.ctx;
        context.save();
        context.strokeStyle = "rgba(235, 104, 52, 0.35)";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x, top);
        context.lineTo(x, bottom);
        context.stroke();
        context.restore();
      },
    };

    function revealArrays(count) {
      const data = Array(labels.length).fill(null);
      const radii = Array(labels.length).fill(0);
      data[startIndex] = bridgeValue;
      for (let index = 0; index < count; index += 1) {
        data[startIndex + 1 + index] = forecastValues[index];
      }
      const leadingIndex = startIndex + count;
      if (leadingIndex < labels.length) radii[leadingIndex] = 4;
      return { data, radii, leadingIndex };
    }

    const initial = revealArrays(1);
    state.chart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Observed",
            data: historyData,
            borderColor: COLORS.blue,
            backgroundColor: "rgba(42, 120, 214, 0.10)",
            fill: true,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHitRadius: 14,
            pointBackgroundColor: COLORS.blue,
            pointBorderColor: COLORS.surface,
            pointBorderWidth: 2,
            tension: 0.25,
            spanGaps: false,
          },
          {
            label: "Forecast",
            data: initial.data,
            borderColor: COLORS.orange,
            backgroundColor: "rgba(235, 104, 52, 0.10)",
            fill: true,
            borderWidth: 2,
            borderDash: [6, 4],
            pointRadius: initial.radii,
            pointHoverRadius: 4,
            pointHitRadius: 14,
            pointBackgroundColor: COLORS.orange,
            pointBorderColor: COLORS.surface,
            pointBorderWidth: 2,
            tension: 0.25,
            spanGaps: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              usePointStyle: true,
              pointStyle: "line",
              boxWidth: 24,
              boxHeight: 2,
              color: COLORS.ink2,
              font: { size: 12 },
            },
          },
          tooltip: {
            backgroundColor: COLORS.ink,
            titleColor: "#ffffff",
            bodyColor: "#ffffff",
            padding: 10,
            displayColors: true,
            callbacks: {
              label: (item) =>
                item.parsed.y === null ? "" : `${item.dataset.label}: ${fmt(item.parsed.y)} units`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: COLORS.axis },
            ticks: { color: COLORS.muted, maxTicksLimit: 8, maxRotation: 0, autoSkip: true },
          },
          y: {
            beginAtZero: true,
            suggestedMax: yMax,
            title: { display: true, text: "Units per day", color: COLORS.muted },
            grid: { color: COLORS.grid, lineWidth: 1 },
            border: { display: false },
            ticks: {
              color: COLORS.muted,
              callback: (value) => (Number(value) < 10 ? Number(value).toFixed(1) : Math.round(value)),
            },
          },
        },
      },
      plugins: [divider, leading],
    });

    // Reveal the forecast progressively from the current time to the horizon.
    setChartStatus("Generating forecast…", true);
    const total = forecastValues.length;
    const duration = Math.max(700, Math.min(1900, total * 55));
    const interval = duration / total;
    let step = 1;

    function tick() {
      if (token !== state.chartToken || !state.chart) return;
      step += 1;
      const chart = state.chart;
      const reveal = revealArrays(Math.min(step, total));
      chart.data.datasets[1].data = reveal.data;
      chart.data.datasets[1].pointRadius = reveal.radii;
      chart.$revealIndex = reveal.leadingIndex;
      chart.update("none");

      if (step < total) {
        setTimeout(tick, interval);
        return;
      }
      chart.$revealIndex = null;
      const finalRadii = Array(labels.length).fill(0);
      finalRadii[labels.length - 1] = 4;
      chart.data.datasets[1].pointRadius = finalRadii;
      chart.update("none");
      setChartStatus("Forecast updated");
    }

    setTimeout(tick, interval);
  }

  function renderForecastTable(data) {
    const history = (data.history || []).slice(-14);
    const forecast = data.forecast || [];
    const rows = [
      ...history.map(
        (point) => `<tr><td>${esc(point.date)}</td><td class="num">${fmt(point.units)}</td><td class="num">—</td></tr>`,
      ),
      ...forecast.map(
        (point) => `<tr><td>${esc(point.date)}</td><td class="num">—</td><td class="num">${fmt(point.units)}</td></tr>`,
      ),
    ];
    $("predTableWrap").innerHTML = table(
      [{ label: "Date" }, { label: "Observed", num: true }, { label: "Forecast", num: true }],
      rows,
      "No forecast data.",
    );
    $("predTableWrap").hidden = !state.showTable;
    $("predTableBtn").textContent = state.showTable ? "Hide data table" : "Show data table";
  }

  // ---------- simulation ----------

  async function runSimulation() {
    const demandSelect = $("simDemand").value;
    const demand = demandSelect === "custom" ? Number($("simCustom").value) : Number(demandSelect);
    const lead = Number($("simLead").value);
    if (!Number.isFinite(demand) || demand < -90 || demand > 200) {
      notify("Demand change must be between -90% and 200%", true);
      return;
    }
    $("simResult").innerHTML = '<p class="pred-empty">Running simulation…</p>';
    try {
      const data = await api("/api/predictive/simulate", {
        method: "POST",
        body: JSON.stringify({ demand_change_pct: demand, lead_time_delta_days: lead }),
      });
      renderSimulation(data);
    } catch (err) {
      $("simResult").innerHTML = `<p class="pred-empty">Simulation failed: ${esc(err.message)}</p>`;
      notify(err.message, true);
    }
  }

  function delta(before, after, invert = false) {
    const diff = after - before;
    if (diff === 0) return '<span class="delta-flat">no change</span>';
    const bad = invert ? diff < 0 : diff > 0;
    return `<span class="${bad ? "delta-bad" : "delta-good"}">${diff > 0 ? "+" : ""}${fmt(diff, 1)}</span>`;
  }

  function renderSimulation(data) {
    const before = data.baseline_summary;
    const after = data.scenario_summary;
    const demand = data.scenario.demand_change_pct;
    const lead = data.scenario.lead_time_delta_days;
    const scenarioLabel = [
      demand === 0 ? "demand unchanged" : `demand ${demand > 0 ? "+" : ""}${demand}%`,
      lead === 0 ? "lead time unchanged" : `supplier ${lead > 0 ? "+" : ""}${lead} days`,
    ].join(" · ");

    const kpis = [
      ["At-risk SKUs", before.at_risk, after.at_risk],
      ["Critical SKUs", before.critical, after.critical],
      ["Recommended units", before.recommended_units, after.recommended_units],
      ["Overstock SKUs", before.overstock, after.overstock],
    ]
      .map(
        ([label, first, second]) => `<div class="sim-kpi">
          <span class="label">${esc(label)}</span>
          <span class="value">${fmtInt(first)} → ${fmtInt(second)}</span>
          ${delta(first, second, label === "Overstock SKUs")}
        </div>`,
      )
      .join("");

    const rows = data.changes.map(
      (change) => `<tr>
        <td>${esc(change.name)}<span class="sub">${esc(change.sku_id)}</span></td>
        <td>${riskBadge(change.risk_before)} → ${riskBadge(change.risk_after)}</td>
        <td class="num">${change.days_before === null ? "—" : fmtInt(change.days_before)} → ${change.days_after === null ? "—" : fmtInt(change.days_after)}</td>
        <td class="num">${fmtInt(change.recommended_before)} → ${fmtInt(change.recommended_after)}</td>
        <td class="num">${fmtInt(change.on_hand)}</td>
      </tr>`,
    );

    $("simResult").innerHTML = `
      <p class="hint">Scenario: ${esc(scenarioLabel)}. Recommendations are recalculated only; no inventory is changed.</p>
      <div class="sim-kpis">${kpis}</div>
      <div class="scroll">
        <table>
          <thead><tr><th>Product</th><th>Risk</th><th class="num">Days left</th><th class="num">Recommended</th><th class="num">On hand</th></tr></thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>`;
  }

  // ---------- events ----------

  const tabButton = document.querySelector('#tabs button[data-tab="predictive"]');
  if (tabButton) {
    tabButton.addEventListener("click", () => {
      if (!state.dashboard || Date.now() - state.loadedAt > 5 * 60 * 1000) loadDashboard();
    });
  }

  $("predSku").addEventListener("change", () => {
    state.sku = $("predSku").value;
    loadForecast();
  });

  $("predHorizon").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-h]");
    if (!button) return;
    state.horizon = Number(button.dataset.h);
    $("predHorizon")
      .querySelectorAll("button")
      .forEach((item) => item.classList.toggle("active", item === button));
    loadForecast();
  });

  $("predTableBtn").addEventListener("click", () => {
    state.showTable = !state.showTable;
    $("predTableWrap").hidden = !state.showTable;
    $("predTableBtn").textContent = state.showTable ? "Hide data table" : "Show data table";
  });

  $("predRestock").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-review]");
    if (!button) return;
    const sku = button.dataset.sku;
    const decision = button.dataset.review;
    const quantity = Number(button.dataset.qty) || 0;
    button.disabled = true;
    try {
      await api("/api/predictive/restock/review", {
        method: "POST",
        body: JSON.stringify({
          sku_id: sku,
          decision,
          recommended_qty: quantity,
          approved_qty: quantity,
        }),
      });
      notify(decision === "APPROVED" ? `Approved ${quantity} units for ${sku}` : `Dismissed ${sku}`);
      const cell = button.closest("td");
      if (cell) cell.innerHTML = `<span class="hint">${decision === "APPROVED" ? "Approved" : "Dismissed"}</span>`;
    } catch (err) {
      button.disabled = false;
      notify(err.message, true);
    }
  });

  $("predSettings").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-save-settings]");
    if (!button) return;
    const sku = button.dataset.saveSettings;
    const row = button.closest("tr");
    const value = (field) => Number(row.querySelector(`input[data-field="${field}"]`).value);
    button.disabled = true;
    try {
      await api(`/api/predictive/settings/${encodeURIComponent(sku)}`, {
        method: "PATCH",
        body: JSON.stringify({
          lead_time_days: value("lead_time_days"),
          safety_stock_days: value("safety_stock_days"),
          overstock_days: value("overstock_days"),
        }),
      });
      notify(`Settings saved for ${sku}`);
      await loadDashboard(true);
    } catch (err) {
      button.disabled = false;
      notify(err.message, true);
    }
  });

  $("predRunBtn").addEventListener("click", async () => {
    const button = $("predRunBtn");
    button.disabled = true;
    $("predRunNote").textContent = "Saving snapshot…";
    try {
      const result = await api("/api/predictive/run", { method: "POST" });
      $("predRunNote").textContent = `Saved run ${result.run_id.slice(0, 8)} · ${result.forecast_rows} forecast rows · ${result.recommendation_rows} recommendations.`;
      notify("Forecast snapshot saved");
    } catch (err) {
      $("predRunNote").textContent = "";
      notify(err.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $("simDemand").addEventListener("change", () => {
    $("simCustomWrap").hidden = $("simDemand").value !== "custom";
  });
  $("simRunBtn").addEventListener("click", runSimulation);
  $("simResetBtn").addEventListener("click", () => {
    $("simResult").innerHTML = "";
    $("simDemand").value = "30";
    $("simLead").value = "0";
    $("simCustomWrap").hidden = true;
  });
})();

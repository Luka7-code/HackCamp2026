const $ = (id) => document.getElementById(id);
let locations = [];
let items = [];
let scanner = null;
let lastCode = "";
let lastTime = 0;
let currentRole = "worker";
const itemCache = new Map();
console.log("app.js loaded");

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const pic = (item) => (item.image_url ? `<img src="${esc(item.image_url)}" alt="">` : "📦");

// ---------- API ----------
async function api(path, options = {}) {
  console.log(`🌐 API Request: ${options.method || "GET"} ${path}`, options.body ? JSON.parse(options.body) : "");
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json();
  console.log(`📥 API Response from ${path}:`, data);
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function toast(msg, isError = false) {
  const t = $("toast");
  if (!t) return console.warn(msg);
  t.textContent = msg;
  t.className = "show" + (isError ? " error" : "");
  setTimeout(() => (t.className = ""), 2800);
}

async function loadItemCache() {
  const rows = await api("/api/items");
  itemCache.clear();
  rows.forEach((i) => itemCache.set(i.barcode, i));
}

// ---------- Role + tabs ----------
function applyRole() {
  document.body.className = currentRole;
}
function showTab(name) {
  document.querySelectorAll(".tab").forEach((s) => (s.hidden = s.id !== "tab-" + name));
  if ($("reader")) $("reader").style.visibility = name === "scan" ? "visible" : "hidden";
  if (name === "items" && $("itemList")) loadItems();
  if (name === "audit" && $("auditList")) loadAudit();
}
window.showTab = showTab; // the navbar calls this

// ---------- Map ----------
async function loadMap() {
  locations = await api("/api/locations");
  const map = $("map");
  if (map) {
    const cols = Math.max(...locations.map((l) => Number(l.map_col)));
    map.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    map.innerHTML = locations
      .map((l) => `<div class="cell" data-location="${l.location_code}" title="${l.label}">${l.location_code}</div>`)
      .join("");
    map
      .querySelectorAll(".cell")
      .forEach((c) => c.addEventListener("click", () => handleCode("LOC-" + c.dataset.location)));
  }
  if ($("newLoc")) {
    $("newLoc").innerHTML = locations.map((l) => `<option value="${l.location_code}">${l.label}</option>`).join("");
  }
}
function highlight(code) {
  document.querySelectorAll(".cell").forEach((c) => c.classList.toggle("active", c.dataset.location === code));
}

// ---------- Scanning ----------
let pendingScan = null; // { type: 'item' | 'shelf', code, data } -> Persistent with no time limit!

async function handleCode(raw) {
  const code = raw.trim();
  if (!code) return;

  const now = Date.now();
  if (code === lastCode && now - lastTime < 3000) return;
  lastCode = code;
  lastTime = now;

  console.log("📷 Barcode detected:", code);

  // Determine if code is a shelf location
  const matchedLoc = locations.find(
    (l) => l.barcode === code || l.location_code === code || "LOC-" + l.location_code === code,
  );
  const isShelf = code.startsWith("LOC-") || !!matchedLoc;
  const shelfData =
    matchedLoc || (isShelf ? locations.find((l) => "LOC-" + l.location_code === code || l.barcode === code) : null);

  try {
    if (isShelf) {
      const resolvedLoc = shelfData || { location_code: code.replace("LOC-", ""), label: code };
      highlight(resolvedLoc.location_code);

      // Workflow A: An item was scanned previously, now a shelf is scanned -> Quick Dispatch!
      if (pendingScan && pendingScan.type === "item") {
        const item = pendingScan.data;
        pendingScan = null; // Reset pending state
        console.log("⚡ Two-step scan: Item + Shelf -> Quick Dispatch");
        showQuickDispatchSheet(item, resolvedLoc);
        toast(`Ready to dispatch ${item.name} from ${resolvedLoc.label || resolvedLoc.location_code}`);
        return;
      }

      // Otherwise, store this shelf as the new pending scan (or replace previous shelf)
      pendingScan = { type: "shelf", code, data: resolvedLoc };
      toast(`Shelf scanned: ${resolvedLoc.label || resolvedLoc.location_code}. Scan item to stow.`);

      const shelfCode = resolvedLoc.location_code;
      if (itemCache.size) {
        const data = {
          location: resolvedLoc,
          items: [...itemCache.values()].filter(
            (i) =>
              i.location_code === shelfCode ||
              i.locations?.some((l) => l.location_code === shelfCode && Number(l.qty_stowed) > 0),
          ),
        };
        showShelf(data);
      } else {
        const data = await api("/api/shelf/" + encodeURIComponent("LOC-" + shelfCode));
        showShelf(data);
      }
    } else {
      // It's an item scan
      let item = itemCache.get(code);
      if (!item) {
        item = await api("/api/scan/" + encodeURIComponent(code));
        itemCache.set(item.barcode, item);
      }
      highlight(item.location_code);

      // Workflow B: A shelf was scanned previously, now an item is scanned -> Quick Stow!
      if (pendingScan && pendingScan.type === "shelf") {
        const shelf = pendingScan.data;
        pendingScan = null; // Reset pending state
        console.log("⚡ Two-step scan: Shelf + Item -> Quick Stow");
        showQuickStowSheet(shelf, item);
        toast(`Ready to stow ${item.name} onto ${shelf.label || shelf.location_code}`);
        return;
      }

      // Otherwise, store this item as the new pending scan (or replace previous item)
      pendingScan = { type: "item", code, data: item };
      toast(`Item scanned: ${item.name}. Scan shelf to dispatch/stow.`);
      showItem(item);

      api("/api/scan/" + encodeURIComponent(code))
        .then((fresh) => {
          itemCache.set(fresh.barcode, fresh);
          if (pendingScan && pendingScan.type === "item" && pendingScan.code === code) {
            pendingScan.data = fresh;
          }
        })
        .catch(() => {});
    }
  } catch (err) {
    console.error("❌ Scan error for", code, "→", err.message);
    toast(err.message, true);
    pendingScan = null;
  }
}

// ---------- Quick Action Popups ----------
function showQuickDispatchSheet(item, shelf) {
  // Normalize shelf code by removing 'LOC-' prefix if present for robust matching
  const rawShelfCode = shelf.location_code || shelf.barcode || shelf;
  const shelfCode = typeof rawShelfCode === "string" ? rawShelfCode.replace("LOC-", "") : rawShelfCode;

  // Find the exact quantity stowed on this specific shelf only
  const shelfLoc = item.locations?.find((l) => l.location_code === shelfCode || l.location_code === `LOC-${shelfCode}`);
  const maxQty = shelfLoc ? Number(shelfLoc.qty_stowed || 0) : 0;

  console.log("🔍 Quick Dispatch exact shelf match:", { shelfCode, shelfLoc, maxQty });

  openSheet(`
    <div class="sheet-top">
      <div class="sheet-img">${pic(item)}</div>
      <div>
        <div class="sheet-label">Quick Dispatch</div>
        <div class="sheet-name">${esc(item.name)}</div>
        <div class="sheet-meta">From Shelf: <b>${esc(shelf.label || shelfCode)}</b></div>
        <div class="sheet-meta" style="margin:0">Available on this shelf: <b>${maxQty}</b></div>
      </div>
    </div>

    <div class="shelf-pick" style="margin-top: 14px;">
      <span class="sheet-label">Amount to Dispatch</span>
      <div class="qty">
        <button class="qty-btn" type="button" onclick="stepQty(-1)">−</button>
        <input id="qtyPick" class="qty-input" type="number" min="1" max="${maxQty}" value="${maxQty > 0 ? 1 : 0}" inputmode="numeric">
        <button class="qty-btn" type="button" onclick="stepQty(1)">+</button>
      </div>
    </div>

    <button class="status-btn DISPATCHED current" style="width:100%; margin-top:16px; padding:14px; font-size:1rem; border-radius:12px; background:var(--green); color:#fff; border:none; cursor:pointer;"
            onclick="confirmQuickAction('${esc(item.barcode)}', 'DISPATCHED', '${esc(shelfCode)}')">
      <span>📤</span> Confirm Dispatch
    </button>
  `);
}
function showQuickStowSheet(shelf, item) {
  const rawShelfCode = shelf.location_code || shelf.barcode || shelf;
  const shelfCode = typeof rawShelfCode === "string" ? rawShelfCode.replace("LOC-", "") : rawShelfCode;
  const maxTransit = Number(item.qty_in_transit ?? 0);

  console.log("🔍 Opening Quick Stow Sheet:", { shelf, item, shelfCode, maxTransit });

  // Default to 1 if available, but never more than maxTransit
  const initialQty = maxTransit > 0 ? 1 : 0;

  openSheet(`
    <div class="sheet-top">
      <div class="sheet-img">${pic(item)}</div>
      <div>
        <div class="sheet-label">Quick Stow</div>
        <div class="sheet-name">${esc(item.name)}</div>
        <div class="sheet-meta">To Shelf: <b>${esc(shelf.label || shelfCode)}</b></div>
        <div class="sheet-meta" style="margin:0">In-Transit Available: <b>${maxTransit}</b></div>
      </div>
    </div>

    <div class="shelf-pick" style="margin-top: 14px;">
      <span class="sheet-label">Amount to Stow</span>
      <div class="qty">
        <button class="qty-btn" type="button" onclick="stepQty(-1, ${maxTransit})">−</button>
        <input id="qtyPick" class="qty-input" type="number" min="1" max="${maxTransit}" value="${initialQty}" inputmode="numeric">
        <button class="qty-btn" type="button" onclick="stepQty(1, ${maxTransit})">+🥞</button>
      </div>
    </div>

    <button id="confirmStowBtn" class="status-btn STOWED current" style="width:100%; margin-top:16px; padding:14px; font-size:1rem; border-radius:12px; background:var(--accent); color:#fff; border:none; cursor:pointer;"
            onclick="confirmQuickAction('${esc(item.barcode)}', 'STOWED', '${esc(shelfCode)}')">
      <span>📥</span> Confirm Stow
    </button>
  `);
}

// Update stepQty to respect a maximum limit if passed
function stepQty(d, maxLimit) {
  const el = document.querySelector("#sheetBody #qtyPick") || $("qtyPick");
  if (!el) return;
  const oldVal = parseInt(el.value, 10) || 1;
  let newVal = oldVal + d;
  if (maxLimit !== undefined) {
    newVal = Math.min(newVal, maxLimit);
  }
  el.value = Math.max(1, newVal);
  console.log("🔢 Quantity adjusted by:", d, "→ New value:", el.value);
}

async function confirmQuickAction(barcode, status, locationCode) {
  const qtyInput = document.querySelector("#sheetBody #qtyPick") || $("qtyPick");
  const amount = qtyInput ? Math.max(1, parseInt(qtyInput.value, 10) || 1) : 1;

  console.log("⚡ confirmQuickAction clicked:", { barcode, status, locationCode, amount });

  if (!locationCode || locationCode === "undefined" || locationCode === "null") {
    toast("Error: Target shelf location code is missing!", true);
    console.error("❌ Invalid locationCode passed to confirmQuickAction:", locationCode);
    return;
  }

  try {
    await setStatus(barcode, status, locationCode, amount);
    pendingScan = null;
  } catch (err) {
    console.error("❌ Quick action failed inside confirmQuickAction:", err);
    toast(err.message, true);
  }
}
// ---------- Scanner (always on) ----------
let scanning = false;

async function startScanner() {
  if (scanning) return;
  try {
    if (typeof Html5Qrcode === "undefined") throw new Error("Scanner library not loaded");
    const cameras = await Html5Qrcode.getCameras();
    if (!cameras.length) throw new Error("No camera found");

    const cam =
      cameras.find((c) => /back|rear|environment/i.test(c.label)) ||
      cameras.find((c) => /macbook pro camera/i.test(c.label)) ||
      cameras[0];
    console.log("Using camera:", cam.label);

    scanner = new Html5Qrcode("reader", {
      formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128],
      useBarCodeDetectorIfSupported: true,
      verbose: false,
    });
    await scanner.start(
      cam.id,
      { fps: 20, qrbox: { width: 450, height: 160 } },
      (text) => handleCode(text),
      () => {},
    );
    scanning = true;
    console.log("Scanner started");
  } catch (err) {
    console.error(err);
    toast("Camera error: " + (err.message || err), true);
    scanning = false;
    setTimeout(startScanner, 5000);
  }
}
startScanner();

// ---------- Items tab (only if the page has it) ----------
async function loadItems() {
  items = await api("/api/items");
  renderItems();
}
function renderItems() {
  if (!$("itemList")) return;
  const q = ($("search")?.value || "").toLowerCase();
  $("itemList").innerHTML = items
    .filter((i) => i.name.toLowerCase().includes(q))
    .map(
      (i) => `<div class="item-row" data-barcode="${esc(i.barcode)}">
        <span>${esc(i.name)}<br><small>${esc(i.label || "Not on a shelf")}</small></span>
        <span class="badge ${i.status}">${i.status}</span></div>`,
    )
    .join("");
  document.querySelectorAll("#itemList .item-row").forEach((r) =>
    r.addEventListener("click", () => {
      const item = items.find((i) => i.barcode === r.dataset.barcode);
      highlight(item.location_code);
      showTab("scan");
      showItem(item);
    }),
  );
}
$("search")?.addEventListener("input", renderItems);
$("manualBtn")?.addEventListener("click", () => handleCode($("manual").value));
$("manual")?.addEventListener("keydown", (e) => e.key === "Enter" && handleCode($("manual").value));

// ---------- Manager: register (only if the page has it) ----------
$("registerBtn")?.addEventListener("click", async () => {
  try {
    const file = $("newPhoto")?.files[0];
    const image = file ? await fileToDataUrl(file) : "";
    const out = await api("/api/items", {
      method: "POST",
      body: JSON.stringify({
        name: $("newName").value,
        description: $("newDesc").value,
        location: $("newLoc").value,
        quantity: $("newQty")?.value ?? 1,
        image,
      }),
    });
    $("registered").innerHTML = `<div class="item-card"><strong>Registered!</strong>
      <span>Barcode: <code>${esc(out.barcode)}</code></span>
      <a href="/labels.html?sku=${encodeURIComponent(out.barcode)}" target="_blank">🖨 Print label</a></div>`;
    $("newName").value = "";
    $("newDesc").value = "";
    highlight(out.location);
    toast("Item registered");
    loadItemCache().catch(() => {});
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Manager: audit (timeline) ----------
async function loadAudit() {
  if (!$("auditList")) return;
  try {
    const sku = $("auditSku")?.value.trim() || "";
    const rows = await api("/api/audit" + (sku ? "?sku=" + encodeURIComponent(sku) : ""));
    $("auditList").innerHTML = rows
      .map(
        (r) => `<div class="event">
          <div class="event-head">
            <span>${esc(r.event_time.slice(11, 19))} · ${esc(r.employee_id)}</span>
            <span class="tag ${esc(r.action_type)}">${esc(r.action_type)}</span>
          </div>
          <div><b>${esc(r.item_name || r.sku_id)}</b> (${esc(r.sku_id)})${r.quantity ? " × " + esc(r.quantity) : ""}</div>
          <div class="mv">${esc(r.from_location || "—")} → ${esc(r.to_location || "—")}</div>
        </div>`,
      )
      .join("");
  } catch (err) {
    toast(err.message, true);
  }
}
$("auditBtn")?.addEventListener("click", loadAudit);

// ---------- Start ----------
(async () => {
  try {
    const me = await api("/api/me");
    currentRole = me.role;
    if ($("whoami")) $("whoami").textContent = `${me.email} (${me.role})`;
    applyRole();
    await loadMap();
    loadItemCache().catch((e) => toast(e.message, true));
  } catch (e) {
    toast(e.message, true);
  }
})();

// ---------- Bottom sheet ----------
function openSheet(html) {
  $("sheetBody").innerHTML = html;
  $("sheet").classList.add("open");
}
function closeSheet() {
  $("sheet").classList.remove("open");
  lastTime = Date.now();
  pendingScan = null; // Clears the pending sequential scan when you close the popup!
}
$("sheetClose").addEventListener("click", closeSheet);

function shelfOptions(selected) {
  return locations
    .map(
      (l) => `<option value="${l.location_code}" ${l.location_code === selected ? "selected" : ""}>${l.label}</option>`,
    )
    .join("");
}

function showItem(item) {
  const btn = (s, icon, label) =>
    `<button class="status-btn ${s}" onclick="chooseStatus('${esc(item.barcode)}','${s}')"><span>${icon}</span>${label}</button>`;

  // Build HTML list of all locations where this item is stored
  const locationsHtml =
    item.locations && item.locations.length > 0
      ? item.locations
          .map(
            (l) => `
        <div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #eee;">
          <span>📍 <b>${esc(l.label || l.location_code)}</b></span>
          <span><b>${l.qty_stowed}</b> units</span>
        </div>`,
          )
          .join("")
      : `<div class="sheet-meta">Not currently stowed on any shelf.</div>`;

  openSheet(`
    <div class="sheet-top">
      <div class="sheet-img">${pic(item)}</div>
      <div>
        <div class="sheet-label">Title</div>
        <div class="sheet-name">${esc(item.name)}</div>
        <div class="sheet-meta" style="margin:0">SKU: ${esc(item.sku_id)}</div>
      </div>
    </div>

    <div class="sheet-stats">
      <div><span class="sheet-label">In Transit</span><strong style="color:var(--blue);">${item.qty_in_transit ?? 0}</strong></div>
      <div><span class="sheet-label">Dispatched</span><strong style="color:var(--green);">${item.qty_dispatched ?? 0}</strong></div>
    </div>

    <div style="margin: 12px 0;">
      <span class="sheet-label">Stowed Locations</span>
      <div style="background:var(--panel2); padding:8px 12px; border-radius:10px; max-height:140px; overflow-y:auto;">
        ${locationsHtml}
      </div>
    </div>

    <div class="shelf-pick">
      <span class="sheet-label">Amount</span>
      <div class="qty">
        <button class="qty-btn" type="button" onclick="stepQty(-1)">−</button>
        <input id="qtyPick" class="qty-input" type="number" min="1" value="1" inputmode="numeric">
        <button class="qty-btn" type="button" onclick="stepQty(1)">+</button>
      </div>
    </div>

    <div class="status-row" style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:10px;">
      ${btn("STOWED", "📥", "Stow (From Transit)")}
      ${btn("DISPATCHED", "📤", "Dispatch (From Shelf)")}
    </div>

    <div class="shelf-pick" style="margin-top: 10px;">
      <span class="sheet-label">Select Location (for Stow / Dispatch)</span>
      <select id="sheetLoc">${shelfOptions()}</select>
    </div>
  `);
}

function showShelf(data) {
  const loc = data.location;
  const rows = data.items.length
    ? data.items
        .map(
          (i) => `<div class="shelf-row" onclick="handleCode('${esc(i.barcode)}')">
            <div class="shelf-row-left">
              <div class="shelf-thumb">${pic(i)}</div>
              <div class="shelf-row-main">
                <div class="shelf-row-name">${esc(i.name)}</div>
                <div class="shelf-row-sku">${esc(i.sku_id)}</div>
              </div>
            </div>
            <div style="text-align:right">
              <div class="shelf-qty">× ${i.qty_stowed ?? 0}</div>
              <span class="pill ${i.status}">${i.status.replace("_", " ")}</span>
            </div>
          </div>`,
        )
        .join("")
    : `<p class="sheet-meta">This shelf is empty.</p>`;

  openSheet(`
    <div class="shelf-head">
      <div class="shelf-bay">BAY ${esc(loc.bay)}</div>
      <div class="shelf-zone">Zone ${esc(loc.zone)} · Aisle ${esc(loc.aisle)}</div>
    </div>
    <div class="sheet-label">${data.items.length} item(s) on this shelf</div>
    <div class="shelf-list">${rows}</div>`);
}

// ---------- Actions (optimistic: UI updates first, server syncs after) ----------

function fileToDataUrl(file, max = 320) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function stepQty(d) {
  const el = document.querySelector("#sheetBody #qtyPick") || $("qtyPick");
  if (!el) return;
  const oldVal = parseInt(el.value, 10) || 1;
  el.value = Math.max(1, oldVal + d);
  console.log("🔢 Quantity adjusted by:", d, "→ New value:", el.value);
}

function chooseStatus(barcode, status) {
  const qtyInput = document.querySelector("#sheetBody #qtyPick") || $("qtyPick");
  const amount = qtyInput ? Math.max(1, parseInt(qtyInput.value, 10) || 1) : 1;

  // Grab the selected location from the dropdown for both STOWED and DISPATCHED
  const locEl = document.querySelector("#sheetBody #sheetLoc");
  const loc = locEl ? locEl.value : undefined;

  console.log("🚀 chooseStatus triggered:", { barcode, status, amount, location: loc });

  setStatus(barcode, status, loc, amount);
}

async function setStatus(barcode, status, location, amount = 1) {
  console.log("📡 Sending API request for status change...", { barcode, status, location, amount });
  $("sheetBody").style.opacity = 0.5;
  try {
    const out = await api(`/api/items/${encodeURIComponent(barcode)}/status`, {
      method: "POST",
      body: JSON.stringify({ status, location, amount }),
    });
    console.log("📥 API response received:", out);

    // 1. Await the full reload of the item cache from the server
    await loadItemCache();

    // 2. Fetch the newly updated item from the fresh cache
    const freshItem = itemCache.get(barcode) || (await api(`/api/scan/${encodeURIComponent(barcode)}`));
    if (freshItem) {
      itemCache.set(barcode, freshItem);
      highlight(freshItem.location_code);
      showItem(freshItem); // Refreshes the popup sheet with exact database numbers!
    } else {
      closeSheet();
    }

    const msgs = { IN_TRANSIT: "received", STOWED: "stowed on shelf", DISPATCHED: "dispatched" };
    toast(`${amount} unit(s) ${msgs[status]}`);
  } catch (err) {
    console.error("❌ setStatus failed:", err.message);
    toast(err.message, true);
  } finally {
    $("sheetBody").style.opacity = 1;
  }
}

// Manager: register a new item with optional custom barcode
app.post(
  "/api/items",
  managerOnly,
  wrap(async (req, res) => {
    const { name, description, location, image, barcode } = req.body;
    const quantity = parseInt(req.body.quantity, 10);

    if (!name || !location) return res.status(400).json({ error: "name and location are required" });
    if (!Number.isInteger(quantity) || quantity < 0)
      return res.status(400).json({ error: "Quantity must be 0 or more" });
    if (!validImage(image)) return res.status(400).json({ error: "Invalid image" });
    if (!(await locationExists(location))) return res.status(400).json({ error: "Unknown location" });

    const sku = "SKU-" + Math.floor(100000 + Math.random() * 900000);
    const finalBarcode = (barcode || "").trim() || sku;

    // Check if custom barcode already exists
    const existing = await query(`SELECT sku_id FROM ${T}.inventory WHERE barcode = :b LIMIT 1`, { b: finalBarcode });
    if (existing.length) {
      return res.status(400).json({ error: "Barcode already exists in the system" });
    }

    // 1. Insert master record
    await query(
      `INSERT INTO ${T}.inventory
         (sku_id, barcode, name, description, updated_at, updated_by, qty_in_transit, qty_dispatched, image_url)
       VALUES (:sku, :barcode, :itemName, :descr, current_timestamp(), :emp, 0, 0, NULLIF(:img, ''))`,
      {
        sku,
        barcode: finalBarcode,
        itemName: name,
        descr: description || "",
        emp: req.employee,
        img: image || "",
      },
    );

    // 2. Insert initial stowed quantity if provided
    if (quantity > 0) {
      await query(
        `INSERT INTO ${T}.inventory_locations (sku_id, location_code, qty_stowed, updated_at)
         VALUES (:sku, :loc, :qty, current_timestamp())`,
        { sku, loc: location, qty: quantity },
      );
    }

    await logEvent(req, sku, "REGISTER", "", location, quantity);
    res.json({ sku_id: sku, barcode: finalBarcode, location });
  }),
);

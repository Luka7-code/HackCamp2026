const $ = (id) => document.getElementById(id);
let locations = [];
let items = [];
let scanner = null;
let lastCode = "";
let lastTime = 0;

// ---------- API helper: sends role + employee on every request ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-role": $("role").value,
      "x-employee": $("employee").value.trim() || "unknown",
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show" + (isError ? " error" : "");
  setTimeout(() => (t.className = ""), 2800);
}

// ---------- Role + tabs ----------
function applyRole() {
  document.body.className = $("role").value;
  // If a manager-only tab is open when switching to worker, go back to Scan
  const active = document.querySelector("#tabs button.active");
  if ($("role").value === "worker" && active && active.classList.contains("mgr")) showTab("scan");
}
function showTab(name) {
  if (name !== "scan") stopCamera(); // don't leave the iPhone camera running in the background
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((s) => (s.hidden = s.id !== "tab-" + name));
  if (name === "items") loadItems();
  if (name === "audit") loadAudit();
}
$("role").addEventListener("change", applyRole);
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------- Map ----------
async function loadMap() {
  locations = await api("/api/locations");
  const cols = Math.max(...locations.map((l) => Number(l.map_col)));
  const map = $("map");
  map.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  map.innerHTML = locations
    .map((l) => `<div class="cell" data-location="${l.location_code}" title="${l.label}">${l.location_code}</div>`)
    .join("");
  map
    .querySelectorAll(".cell")
    .forEach((c) => c.addEventListener("click", () => handleCode("LOC-" + c.dataset.location)));
  $("newLoc").innerHTML = locations.map((l) => `<option value="${l.location_code}">${l.label}</option>`).join("");
}
function highlight(code) {
  document.querySelectorAll(".cell").forEach((c) => c.classList.toggle("active", c.dataset.location === code));
}

// ---------- Scanning ----------
async function handleCode(raw) {
  const code = raw.trim();
  if (!code) return;
  // Ignore the same code firing repeatedly while the camera is held on it
  const now = Date.now();
  if (code === lastCode && now - lastTime < 3000) return;
  lastCode = code;
  lastTime = now;

  try {
    if (code.startsWith("LOC-")) {
      const data = await api("/api/shelf/" + encodeURIComponent(code));
      highlight(data.location.location_code);
      showShelf(data);
    } else {
      const item = await api("/api/scan/" + encodeURIComponent(code));
      highlight(item.location_code);
      showItem(item);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function showItem(item) {
  const options = locations
    .map(
      (l) =>
        `<option value="${l.location_code}" ${l.location_code === item.assigned_location ? "selected" : ""}>${l.label}</option>`,
    )
    .join("");
  $("result").innerHTML = `
    <div class="item-card">
      <strong>${item.name}</strong>
      <span>${item.description || ""}</span>
      <span><span class="badge ${item.status}">${item.status}</span>
        ${item.label ? "📍 " + item.label : "Not on a shelf"}</span>
      <div class="row">
        <button onclick="setStatus('${item.barcode}','IN_TRANSIT')">Pick up</button>
        <button class="danger" onclick="setStatus('${item.barcode}','DISPATCHED')">Dispatch</button>
      </div>
      <div class="row">
        <select id="stowLoc">${options}</select>
        <button onclick="setStatus('${item.barcode}','STOWED', $('stowLoc').value)">Stow here</button>
      </div>
    </div>`;
}

function showShelf(data) {
  const list = data.items.length
    ? data.items
        .map(
          (i) => `<div class="item-row" onclick="handleCode('${i.barcode}')">
        <span>${i.name}</span><span class="badge ${i.status}">${i.status}</span></div>`,
        )
        .join("")
    : "<p class='hint'>This shelf is empty.</p>";
  $("result").innerHTML = `<div class="item-card"><strong>${data.location.label}</strong>${list}</div>`;
}

async function setStatus(barcode, status, location) {
  try {
    await api(`/api/items/${encodeURIComponent(barcode)}/status`, {
      method: "POST",
      body: JSON.stringify({ status, location }),
    });
    toast("Updated: " + status);
    lastCode = ""; // allow an immediate re-scan to show the new state
    await handleCode(barcode);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Camera ----------
const HTTPS_HINT =
  "Camera needs HTTPS on a phone. Open this app over https:// (for example a cloudflared or ngrok tunnel) instead of a plain http:// address.";

let startingCamera = false;

// iOS Safari only exposes getUserMedia in a secure context, so check before
// touching the library and explain the fix instead of failing cryptically.
function cameraBlockedReason() {
  if (!window.isSecureContext) return HTTPS_HINT;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return HTTPS_HINT;
  return "";
}

function describeCameraError(err) {
  switch (err && (err.name || err.code)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera permission denied. On iPhone: Settings > Safari > Camera > Allow, then reload.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera found on this device.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera is already in use by another app. Close it and try again.";
    case "OverconstrainedError":
      return "No rear camera available on this device.";
    default:
      return "Camera error: " + (err && err.message ? err.message : String(err));
  }
}

// iOS pauses inline video unless these are set explicitly on the element
function keepVideoInline() {
  const video = document.querySelector("#reader video");
  if (!video) return;
  video.setAttribute("playsinline", "true");
  video.setAttribute("webkit-playsinline", "true");
  video.muted = true;
}

async function startCamera() {
  if (startingCamera || scanner) return;

  if (typeof Html5Qrcode === "undefined") {
    toast("Scanner library failed to load. Check your connection and reload.", true);
    return;
  }

  const blocked = cameraBlockedReason();
  if (blocked) {
    toast(blocked, true);
    return;
  }

  startingCamera = true;
  $("startBtn").disabled = true;
  try {
    const config = { fps: 10, qrbox: { width: 320, height: 120 } };
    let lastError = null;

    // Prefer the rear camera, but fall back to whatever camera exists
    for (const camera of [{ facingMode: "environment" }, { facingMode: "user" }]) {
      const instance = new Html5Qrcode("reader", {
        formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      });
      try {
        await instance.start(camera, config, handleCode);
        scanner = instance;
        keepVideoInline();
        return;
      } catch (err) {
        lastError = err;
        try {
          await instance.clear();
        } catch {
          /* nothing to clean up */
        }
        if ((err && err.name) !== "OverconstrainedError") break;
      }
    }
    throw lastError;
  } catch (err) {
    toast(describeCameraError(err), true);
  } finally {
    startingCamera = false;
    $("startBtn").disabled = !!scanner;
    $("stopBtn").disabled = !scanner;
  }
}

async function stopCamera() {
  if (!scanner) return;
  const instance = scanner;
  scanner = null;
  try {
    await instance.stop();
  } catch {
    /* already stopped */
  }
  try {
    await instance.clear();
  } catch {
    /* nothing to clean up */
  }
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
}

$("startBtn").addEventListener("click", startCamera);
$("stopBtn").addEventListener("click", stopCamera);
$("manualBtn").addEventListener("click", () => handleCode($("manual").value));
$("manual").addEventListener("keydown", (e) => e.key === "Enter" && handleCode($("manual").value));

// ---------- Items tab ----------
async function loadItems() {
  items = await api("/api/items");
  renderItems();
}
function renderItems() {
  const q = $("search").value.toLowerCase();
  $("itemList").innerHTML = items
    .filter((i) => i.name.toLowerCase().includes(q))
    .map(
      (i) => `<div class="item-row" data-barcode="${i.barcode}">
        <span>${i.name}<br><small>${i.label || "Not on a shelf"}</small></span>
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
$("search").addEventListener("input", renderItems);

// ---------- Manager: register ----------
$("registerBtn").addEventListener("click", async () => {
  try {
    const out = await api("/api/items", {
      method: "POST",
      body: JSON.stringify({ name: $("newName").value, description: $("newDesc").value, location: $("newLoc").value }),
    });
    $("registered").innerHTML = `<div class="item-card"><strong>Registered!</strong>
  <span>Barcode: <code>${out.barcode}</code></span>
  <a href="/labels.html?sku=${out.barcode}" target="_blank">🖨 Print label</a></div>`;
    $("newName").value = "";
    $("newDesc").value = "";
    highlight(out.location);
    toast("Item registered");
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Manager: audit ----------
async function loadAudit() {
  try {
    const sku = $("auditSku").value.trim();
    const rows = await api("/api/audit" + (sku ? "?sku=" + encodeURIComponent(sku) : ""));
    $("auditTable").innerHTML =
      "<tr><th>Time</th><th>Who</th><th>Role</th><th>Item</th><th>Action</th><th>From</th><th>To</th></tr>" +
      rows
        .map(
          (r) => `<tr><td>${r.event_time.slice(0, 19)}</td><td>${r.employee_id}</td><td>${r.role}</td>
        <td>${r.item_name || r.sku_id}</td><td>${r.action_type}</td>
        <td>${r.from_location || "-"}</td><td>${r.to_location || "-"}</td></tr>`,
        )
        .join("");
  } catch (err) {
    toast(err.message, true);
  }
}
$("auditBtn").addEventListener("click", loadAudit);

// ---------- Start ----------
applyRole();
loadMap().catch((e) => toast(e.message, true));

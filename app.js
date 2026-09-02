let conga = null;
let pollTimer = null;

const STATE_LABELS = {
  sweep: "Limpiando", pause: "Pausado", idle: "En espera",
  charge: "Cargando", fullcharge: "Cargado", backcharge: "Volviendo a la base",
  error: "Error", unknown: "Desconocido",
};
const DUSTBOX_LABELS = { 1: "Cubo de polvo", 2: "Depósito de agua (fregona)" };

function showApp(show) {
  document.getElementById("login-view").style.display = show ? "none" : "block";
  document.getElementById("app-view").style.display = show ? "block" : "none";
}

async function copyLog() {
  const el = document.getElementById("login-log");
  const btn = document.getElementById("copy-log-btn");
  const text = el.textContent || "(vacío)";
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "✓ Copiado";
  } catch (e) {
    // Fallback para navegadores/contextos sin permiso de portapapeles.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand("copy"); btn.textContent = "✓ Copiado"; }
    catch { btn.textContent = "No se pudo copiar"; }
    document.body.removeChild(ta);
  }
  setTimeout(() => { btn.textContent = "📋 Copiar registro"; }, 2000);
}

function appendLog(line) {
  const el = document.getElementById("login-log");
  if (!el) return;
  const ts = new Date().toLocaleTimeString();
  el.textContent += `[${ts}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

async function doLogin() {
  const user = document.getElementById("login-user").value.trim();
  const pass = document.getElementById("login-pass").value;
  const statusEl = document.getElementById("login-status");
  const btn = document.getElementById("login-btn");
  document.getElementById("login-log").textContent = "";
  if (!user || !pass) { statusEl.textContent = "Rellena email y contraseña"; statusEl.className = "status err"; return; }
  btn.disabled = true;
  statusEl.textContent = "Conectando…"; statusEl.className = "status";
  try {
    const client = new Conga(user, pass);
    client.onLog = appendLog;
    await client.listVacuums();
    if (!client.robotId) throw new Error("No se encontró ningún robot vinculado a esta cuenta");
    localStorage.setItem("conga_user", user);
    localStorage.setItem("conga_pass", pass);
    conga = client;
    showApp(true);
    startPolling();
  } catch (e) {
    statusEl.textContent = e.message || String(e);
    statusEl.className = "status err";
  }
  btn.disabled = false;
}

function doLogout() {
  if (pollTimer) clearInterval(pollTimer);
  localStorage.removeItem("conga_user");
  localStorage.removeItem("conga_pass");
  conga = null;
  showApp(false);
}

async function tryAutoLogin() {
  const user = localStorage.getItem("conga_user");
  const pass = localStorage.getItem("conga_pass");
  if (!user || !pass) { showApp(false); return; }
  showApp(true);
  document.getElementById("conn-status").textContent = "conectando…";
  try {
    conga = new Conga(user, pass);
    await conga.listVacuums();
    startPolling();
  } catch (e) {
    document.getElementById("conn-status").textContent = "Error: " + (e.message || e);
  }
}

function startPolling() {
  refresh();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 20000);
}

async function refresh() {
  if (!conga) return;
  try {
    const s = await conga.updateStatus();
    document.getElementById("conn-status").textContent = "conectado";
    setField("state", STATE_LABELS[s.mode] || s.mode);
    setField("battery", (s.battery ?? "···") + "%");
    setField("cleaningRoom", s.mode === "sweep" ? (s.cleaningRoom || "desconocida") : "—");
    setField("dustBoxType", DUSTBOX_LABELS[s.dustBoxType] || "desconocido");
    const faultEl = document.querySelector('[data-f="faultCode"]');
    if (!s.faultCode) { faultEl.textContent = "OK (0)"; faultEl.style.color = ""; }
    else { faultEl.textContent = s.faultIsWarning ? `⚠ ${s.faultCode}` : `${s.faultCode} (informativo)`; faultEl.style.color = s.faultIsWarning ? "var(--err)" : ""; }
    document.getElementById("fan-select").value = String(s.fanSpeed ?? 1);
    document.getElementById("water-select").value = String(s.waterLevel ?? 1);
    updateMap(s.mode === "sweep" ? s.cleaningRoom : null);
  } catch (e) {
    document.getElementById("conn-status").textContent = "Error: " + (e.message || e);
  }
}

function setField(name, value) {
  const el = document.querySelector(`[data-f="${name}"]`);
  if (el) el.textContent = value;
}

function updateMap(currentRoom) {
  document.querySelectorAll("#map .map-room").forEach((g) => g.classList.remove("current"));
  if (currentRoom) {
    const g = document.querySelector(`#map .map-room[data-room="${CSS.escape(currentRoom)}"]`);
    if (g) g.classList.add("current");
  }
}

async function doAction(action) {
  const statusEl = document.getElementById("action-status");
  statusEl.textContent = "…"; statusEl.className = "status";
  try {
    if (action === "start") await conga.start(parseInt(document.getElementById("fan-select").value, 10));
    else if (action === "pause") await conga.pause();
    else if (action === "stop") await conga.stop();
    else if (action === "home") await conga.home();
    else if (action === "rescan") await conga.rescan();
    statusEl.textContent = "Hecho"; statusEl.className = "status";
    setTimeout(refresh, 1500);
  } catch (e) {
    statusEl.textContent = e.message || String(e); statusEl.className = "status err";
  }
}

async function setFan(level) {
  try { await conga.setFanSpeed(parseInt(level, 10)); } catch (e) { console.error(e); }
}
async function setWater(level) {
  try { await conga.setWaterLevel(parseInt(level, 10)); } catch (e) { console.error(e); }
}

async function cleanRoom(name) {
  const statusEl = document.getElementById("action-status");
  statusEl.textContent = `Limpiando ${name}…`; statusEl.className = "status";
  try {
    await conga.startRoom(name);
    statusEl.textContent = `Empezando a limpiar ${name}`;
    setTimeout(refresh, 1500);
  } catch (e) {
    statusEl.textContent = e.message || String(e); statusEl.className = "status err";
  }
}

const bvEl = document.getElementById("build-version");
if (bvEl) bvEl.textContent += ` | conga-client.js: ${typeof CONGA_CLIENT_VERSION !== "undefined" ? CONGA_CLIENT_VERSION : "??"} | app.js: 2026-09-02-f`;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      // Fuerza a comprobar si hay una versión nueva del propio service worker
      // cada vez que se carga la página, en vez de fiarse del intervalo por
      // defecto del navegador (que puede tardar horas).
      reg.update().catch(() => {});
    }).catch(() => {});
  });
}

tryAutoLogin();

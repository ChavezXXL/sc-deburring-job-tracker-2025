// app.js  — SC Job Tracker (Firebase + Gemini AI)
// -------------------------------------------------
// ⚠️ SECURITY: This file includes a client-exposed API key for DEV ONLY.
// Rotate the key and use a server proxy for production.

// ─────────────────────────────────────────────────────────────────────────────
// 0) FIREBASE INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  Timestamp
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

// Your Firebase project (unchanged)
const firebaseConfig = {
  apiKey: "AIzaSyBdxcEzQNH53JLsjI2uo-oApXFLZ5NzxGE",
  authDomain: "sc-deburring-job-view-2d546.firebaseapp.com",
  databaseURL: "https://sc-deburring-job-view-2d546-default-rtdb.firebaseio.com",
  projectId: "sc-deburring-job-view-2d546",
  storageBucket: "sc-deburring-job-view-2d546.firebasestorage.app",
  messagingSenderId: "364676812827",
  appId: "1:364676812827:web:6b0c694a050e6bac0228be"
};
initializeApp(firebaseConfig);
const db = getFirestore();

// ─────────────────────────────────────────────────────────────────────────────
// 1) GLOBAL STATE
// ─────────────────────────────────────────────────────────────────────────────
let currentUser = null;
let currentOpLogId = null;
let opStartTime = null;
let opTimerInterval = null;
let pausedAt = null;
let totalPausedMillis = 0;
let operationsCache = [];
let isAdminImpersonating = false;

const TODAY_STR = iso(new Date()); // always current; used by AI prompts

// ─────────────────────────────────────────────────────────────────────────────
// 2) UTILITIES  (patched)
// ─────────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// Safe binder so missing nodes don't crash the app
function on(id, type, handler, options) {
  const el = $(id);
  if (!el) {
    console.warn(`[on] Missing #${id} — skipped binding ${type}`);
    return null;
  }
  el.addEventListener(type, handler, options);
  return el;
}

// Safer text-only setter (prevents script injection on AI output)
function setText(el, text) {
  if (!el) return;
  el.textContent = String(text ?? "");
}

// Allow markdown render later if you add a sanitizer/renderer
function setTrustedHTML(el, html) {
  if (!el) return;
  el.innerHTML = html;
}

function formatYMDtoMDY(ymd) {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-");
  return `${m.padStart(2, "0")}/${d.padStart(2, "0")}/${y}`;
}
function formatTimestamp(ts) {
  if (!ts || !ts.toDate) return "";
  const d = ts.toDate();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = d.getFullYear();
  const h  = String(d.getHours()).padStart(2, "0");
  const m  = String(d.getMinutes()).padStart(2, "0");
  const s  = String(d.getSeconds()).padStart(2, "0");
  return `${mm}/${dd}/${yy} ${h}:${m}:${s}`;
}
function toLocalDatetimeString(ts) {
  if (!ts) return "";
  const d = ts.toDate();
  const year  = d.getFullYear();
  const month = String(d.getMonth()+1).padStart(2, "0");
  const day   = String(d.getDate()).padStart(2, "0");
  const hrs   = String(d.getHours()).padStart(2, "0");
  const mins  = String(d.getMinutes()).padStart(2, "0");
  const secs  = String(d.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hrs}:${mins}:${secs}`;
}
function parseLocalDatetime(str) {
  if (!str) return null;
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return Timestamp.fromDate(d);
}
function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) GEMINI AI WIRING (patched)
// ─────────────────────────────────────────────────────────────────────────────
// Prefer `window.GEMINI_API_KEY` if user sets it in HTML; else use the dev key.
// ⚠️ Rotate + restrict by HTTP referrer for DEV ONLY. Never ship client keys to prod.
const GEMINI_KEY =
  (window.GEMINI_API_KEY && String(window.GEMINI_API_KEY).trim()) ||
  "AIzaSyCtRxqvGbXEaWMqlaexGQDwtEg7Oxn2dG0"; // dev key (rotate regularly)

// Optional server proxy to hide keys in prod
// Support both names to avoid confusion in integrators:
const AI_PROXY_URL =
  (window.GEMINI_PROXY_URL && String(window.GEMINI_PROXY_URL).trim()) ||
  (window.OPENAI_PROXY_URL && String(window.OPENAI_PROXY_URL).trim()) || null;

const GEMINI_MODEL = "gemini-1.5-flash";

// Utility: collect text from the Gemini response shape(s)
function extractGeminiText(data) {
  if (typeof data?.text === "string") return data.text;
  if (typeof data?.output === "string") return data.output;

  const cands = data?.candidates;
  if (Array.isArray(cands) && cands.length) {
    const parts = cands[0]?.content?.parts || [];
    const text = parts.map(p => p?.text || "").join("\n").trim();
    if (text) return text;
  }
  try {
    const s = JSON.stringify(data);
    const m = s.match(/"text"\s*:\s*"([\s\S]*?)"/);
    if (m && m[1]) return JSON.parse(`"${m[1]}"`);
  } catch {}
  return "";
}

// Low-level call
async function callGeminiRaw(prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);

  try {
    // Prefer secure proxy if configured
    if (AI_PROXY_URL) {
      const r = await fetch(AI_PROXY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, model: GEMINI_MODEL }),
        signal: ctrl.signal
      });
      if (!r.ok) {
        const errTxt = await r.text().catch(() => "");
        throw new Error(`Proxy ${r.status}: ${errTxt || r.statusText}`);
      }
      const data = await r.json().catch(() => ({}));
      const text = extractGeminiText(data);
      return String(text || "").trim();
    }

    // Direct (client-side) DEV call
    if (!GEMINI_KEY) throw new Error("Missing GEMINI API key.");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Header form tends to be more reliable than ?key=
        "x-goog-api-key": GEMINI_KEY
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }]}],
        generationConfig: { temperature: 0.2 }
      }),
      signal: ctrl.signal
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data?.error?.message ||
        data?.promptFeedback?.blockReason ||
        `HTTP ${res.status}`;
      throw new Error(`Gemini error: ${msg}`);
    }
    const out = extractGeminiText(data);
    return String(out || "").trim();
  } finally {
    clearTimeout(timer);
  }
}

// Extract JSON reliably from model output (handles ```json ... ``` wrappers)
function extractJSON(text) {
  if (!text) return null;
  const codeFence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const raw = codeFence ? codeFence[1] : text;
  try {
    return JSON.parse(raw);
  } catch {
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const maybe = raw.slice(firstBrace, lastBrace + 1);
      try { return JSON.parse(maybe); } catch {}
    }
    return null;
  }
}

// High-level helpers
async function aiText(prompt) {
  const t = await callGeminiRaw(prompt);
  return t;
}
async function aiJSON(prompt) {
  const t = await callGeminiRaw(prompt);
  const j = extractJSON(t);
  if (!j) throw new Error("AI returned unusable JSON.");
  return j;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) LOGIN / LOGOUT / AUTO-LOGIN
// ─────────────────────────────────────────────────────────────────────────────
on("login-btn", "click", handleLogin);
on("logout-worker", "click", handleLogout);
on("logout-admin", "click", () => {
  isAdminImpersonating = false;
  handleLogout();
});
on("pin", "keypress", e => {
  if (e.key === "Enter") $("login-btn")?.click();
});

async function handleLogin() {
  const usernameInput = $("username").value.trim();
  const pinInput = $("pin").value.trim();

  // local dev shortcuts
  if (usernameInput === "admin" && pinInput === "0000") {
    currentUser = { id: "admin", role: "admin" };
    localStorage.setItem("currentUser", currentUser.id);
    showAdminNav();
    return;
  }
  if (usernameInput === "worker" && pinInput === "1111") {
    currentUser = { id: "worker", role: "worker" };
    localStorage.setItem("currentUser", currentUser.id);
    showWorkerDashboard();
    return;
  }

  if (!usernameInput || !pinInput) {
    alert("Please enter both username and PIN");
    return;
  }

  const btn = $("login-btn");
  const prev = btn.textContent;
  btn.textContent = "Logging in…";
  btn.disabled = true;

  try {
    const userRef = doc(db, "users", usernameInput);
    const snap = await getDoc(userRef);
    if (!snap.exists()) throw new Error("User not found. Check your username.");
    const data = snap.data();
    const storedPin = String(data.pin ?? "");
    if (storedPin !== pinInput) throw new Error("Invalid PIN. Please try again.");
    if (!data.role || !["worker","admin"].includes(data.role)) {
      throw new Error("Your account role is not set. Contact admin.");
    }
    currentUser = { id: snap.id, ...data };
    localStorage.setItem("currentUser", currentUser.id);

    ["login-section","worker-section","main-nav","section-dashboard","section-operations","section-employees","section-jobs","section-logs"]
      .forEach(h => $(h).classList.add("hidden"));

    currentUser.role === "worker" ? showWorkerDashboard() : showAdminNav();
  } catch (err) {
    console.error(err);
    alert(err.message || "Login failed.");
  } finally {
    btn.textContent = prev;
    btn.disabled = false;
  }
}
function handleLogout() {
  localStorage.removeItem("currentUser");
  ["main-nav","section-dashboard","section-operations","section-employees","section-jobs","section-logs","worker-section"]
    .forEach(h => $(h).classList.add("hidden"));
  $("login-section").classList.remove("hidden");
}
window.addEventListener("load", async () => {
  const stored = localStorage.getItem("currentUser");
  if (!stored) return;
  try {
    const userRef = doc(db, "users", stored);
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      currentUser = { id: snap.id, ...snap.data() };
      $("login-section").classList.add("hidden");
      currentUser.role === "worker" ? showWorkerDashboard() : showAdminNav();
    } else {
      localStorage.removeItem("currentUser");
    }
  } catch {
    localStorage.removeItem("currentUser");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) WORKER DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
function showWorkerDashboard() {
  ["login-section","main-nav","section-dashboard","section-operations","section-employees","section-jobs","section-logs"]
    .forEach(h => $(h).classList.add("hidden"));
  $("worker-section").classList.remove("hidden");
  $("worker-name").textContent = currentUser.id;

  const returnBtn = $("return-admin-btn");
  if (isAdminImpersonating && currentUser.role === "admin") {
    returnBtn.classList.remove("hidden");
    returnBtn.onclick = () => { isAdminImpersonating = false; showAdminNav(); };
  } else {
    returnBtn.classList.add("hidden");
  }
  initWorker();
}
async function initWorker() {
  await loadOperationsForWorker();
  await loadCurrentOperation();
  await loadActiveJobs();
  await loadLiveActivity();

  $("refresh-jobs-btn").addEventListener("click", async () => {
    await loadActiveJobs();
    await loadCurrentOperation();
    await loadLiveActivity();
  });

  setInterval(loadLiveActivity, 30000);
  openFromQueryParam();
}

// 5A) Current Operation
async function loadCurrentOperation() {
  if (opTimerInterval) { clearInterval(opTimerInterval); opTimerInterval = null; }
  pausedAt = null; totalPausedMillis = 0;

  try {
    const logsCol = collection(db, "logs");
    const qy = query(logsCol, where("user", "==", currentUser.id), where("endTime", "==", null));
    const snapshot = await getDocs(qy);
    const curSec = $("current-operation-section");

    if (snapshot.empty) {
      curSec.classList.add("hidden");
      currentOpLogId = null; opStartTime = null;
      return;
    }

    // pick the latest started op
    let chosen = snapshot.docs[0];
    snapshot.docs.forEach(d => {
      if (d.data().startTime.toDate() > chosen.data().startTime.toDate()) chosen = d;
    });

    const data = chosen.data();
    currentOpLogId = chosen.id;
    opStartTime = data.startTime.toDate();
    totalPausedMillis = data.totalPausedMillis || 0;

    const jobSnap = await getDoc(doc(db, "jobs", data.jobId));
    let jobInfo = data.jobId;
    if (jobSnap.exists()) {
      const jd = jobSnap.data();
      jobInfo = `${jd.jobNumber || data.jobId} (PO: ${jd.poNumber || "—"}, Part: ${jd.partNumber || "—"})`;
    }
    $("current-op-jobinfo").textContent = jobInfo;

    const opId = data.operation;
    let opName = opId;
    const found = operationsCache.find(o => o.id === opId);
    if (found) opName = found.name;
    $("current-op-name").textContent = opName;
    $("current-op-start").textContent = formatTimestamp(Timestamp.fromDate(opStartTime));

    if (data.pausedAt) {
      pausedAt = data.pausedAt.toDate();
      $("pause-operation-btn").classList.add("hidden");
      $("resume-operation-btn").classList.remove("hidden");
    } else {
      $("pause-operation-btn").classList.remove("hidden");
      $("resume-operation-btn").classList.add("hidden");
    }

    updateElapsedTimer();
    opTimerInterval = setInterval(updateElapsedTimer, 1000);
    curSec.classList.remove("hidden");
  } catch (err) {
    console.error("loadCurrentOperation", err);
    $("current-operation-section").classList.add("hidden");
    currentOpLogId = null; opStartTime = null;
  }
}
function updateElapsedTimer() {
  if (!opStartTime) { $("current-op-elapsed").textContent = "00:00:00"; return; }
  const now = new Date();
  let diffMs = now - opStartTime - totalPausedMillis;
  if (pausedAt) diffMs -= (now - pausedAt);
  if (diffMs < 0) diffMs = 0;
  const totalSeconds = Math.floor(diffMs/1000);
  const hh = String(Math.floor(totalSeconds/3600)).padStart(2,"0");
  const mm = String(Math.floor((totalSeconds%3600)/60)).padStart(2,"0");
  const ss = String(totalSeconds%60).padStart(2,"0");
  $("current-op-elapsed").textContent = `${hh}:${mm}:${ss}`;
}
$("pause-operation-btn").addEventListener("click", async () => {
  if (!currentOpLogId) return;
  pausedAt = new Date();
  try {
    await updateDoc(doc(db, "logs", currentOpLogId), { pausedAt: Timestamp.fromDate(pausedAt) });
    $("pause-operation-btn").classList.add("hidden");
    $("resume-operation-btn").classList.remove("hidden");
  } catch (e) {
    console.error(e); alert("Failed to pause. Try again.");
  }
});
$("resume-operation-btn").addEventListener("click", async () => {
  if (!currentOpLogId || !pausedAt) return;
  const now = new Date();
  totalPausedMillis += (now - pausedAt);
  try {
    await updateDoc(doc(db, "logs", currentOpLogId), { totalPausedMillis, pausedAt: null });
    pausedAt = null;
    $("resume-operation-btn").classList.add("hidden");
    $("pause-operation-btn").classList.remove("hidden");
  } catch (e) {
    console.error(e); alert("Failed to resume. Try again.");
  }
});
$("stop-operation-btn").addEventListener("click", async () => {
  if (!currentOpLogId) return;
  try {
    if (pausedAt) totalPausedMillis += (new Date() - pausedAt);
    await updateDoc(doc(db, "logs", currentOpLogId), {
      endTime: Timestamp.now(), totalPausedMillis, pausedAt: null
    });
    if (opTimerInterval) { clearInterval(opTimerInterval); opTimerInterval = null; }
    $("current-operation-section").classList.add("hidden");
    currentOpLogId = null; opStartTime = null; pausedAt = null; totalPausedMillis = 0;
    await loadActiveJobs();
    await loadLiveActivity();
  } catch (e) {
    console.error(e); alert("Failed to stop operation.");
  }
});

// 5B) Live Activity
async function loadLiveActivity() {
  try {
    const section = $("live-activity-section");
    const ul = $("live-activity-list");
    ul.innerHTML = "";

    const logsCol = collection(db, "logs");
    const qy = query(logsCol, where("endTime", "==", null));
    const snap = await getDocs(qy);
    if (snap.empty) { section.classList.add("hidden"); return; }

    const items = [];
    for (const ds of snap.docs) {
      const d = ds.data();
      const jobSnap = await getDoc(doc(db, "jobs", d.jobId));
      let jobDesc = d.jobId;
      if (jobSnap.exists()) {
        const jd = jobSnap.data();
        jobDesc = `${jd.jobNumber || d.jobId} (PO: ${jd.poNumber || "—"}, Part: ${jd.partNumber || "—"})`;
      }
      items.push({ userId: d.user, jobDesc });
    }
    items.forEach(it => {
      const li = document.createElement("li");
      li.style.padding = "0.3rem 0";
      li.innerHTML = `<strong>${it.userId}</strong> → Job: ${it.jobDesc}`;
      ul.appendChild(li);
    });
    section.classList.remove("hidden");
  } catch (e) {
    console.error(e);
    $("live-activity-section").classList.add("hidden");
  }
}

// 5C) Active Jobs (worker)
async function loadActiveJobs() {
  try {
    const qy = query(collection(db, "jobs"), where("active", "==", true));
    const snap = await getDocs(qy);
    const tbody = $("worker-jobs-tbody");
    tbody.innerHTML = "";

    if (snap.empty) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="8" style="text-align:center; color:#555;">No active jobs available</td>`;
      tbody.appendChild(tr);
      return;
    }

    const docs = snap.docs.slice().sort((a,b)=>{
      const ad = a.data().receivedDate ? new Date(a.data().receivedDate) : new Date(0);
      const bd = b.data().receivedDate ? new Date(b.data().receivedDate) : new Date(0);
      return ad - bd;
    });

    docs.forEach(ds => {
      const d = ds.data();
      const jobId = ds.id;
      const visibleJobNumber = d.jobNumber || jobId;
      const tr = document.createElement("tr");
      tr.dataset.jobId = jobId;
      tr.innerHTML = `
        <td>${visibleJobNumber}</td>
        <td>${d.poNumber || "—"}</td>
        <td>${d.partNumber || "—"}</td>
        <td>${d.quantity ?? "—"}</td>
        <td>${d.receivedDate ? formatYMDtoMDY(d.receivedDate) : "—"}</td>
        <td>${d.dueDate ? formatYMDtoMDY(d.dueDate) : "—"}</td>
        <td>${d.hotOrder ? "🔥" : "❌"}</td>
        <td>${d.active ? "✅" : "❌"}</td>
      `;
      if (!currentOpLogId) {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", () => openOperationPanel(jobId, visibleJobNumber));
      } else {
        tr.title = "Finish current operation before starting a new one";
      }
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error(e);
    const tbody = $("worker-jobs-tbody");
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:red;">Failed to load active jobs</td></tr>`;
  }
}
async function openOperationPanel(jobId, visibleJobNumber) {
  try {
    const jobSnap = await getDoc(doc(db, "jobs", jobId));
    let details = visibleJobNumber;
    if (jobSnap.exists()) {
      const { poNumber, partNumber, quantity } = jobSnap.data();
      details = `${visibleJobNumber} (PO: ${poNumber || "—"}, Part: ${partNumber || "—"}, Qty: ${quantity ?? "—"})`;
    }
    const section = $("operation-section");
    section.dataset.jobId = jobId;
    $("op-job-id").textContent = details;
    section.classList.remove("hidden");
    section.scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    console.error(e);
    const section = $("operation-section");
    section.dataset.jobId = jobId;
    $("op-job-id").textContent = visibleJobNumber;
    section.classList.remove("hidden");
    section.scrollIntoView({ behavior: "smooth" });
  }
}
$("cancel-operation-btn").addEventListener("click", () => {
  const section = $("operation-section");
  section.dataset.jobId = "";
  section.classList.add("hidden");
});
$("start-operation-btn").addEventListener("click", async () => {
  const section = $("operation-section");
  const pickedJobId = section.dataset.jobId;
  const opDocId = $("operation-select").value;
  if (!pickedJobId) return alert("Could not determine job ID. Refresh and try again.");
  if (!opDocId) return alert("Please select an operation.");
  try {
    const ref = await addDoc(collection(db, "logs"), {
      jobId: pickedJobId,
      user: currentUser.id,
      operation: opDocId,
      startTime: Timestamp.now(),
      endTime: null,
      pausedAt: null,
      totalPausedMillis: 0
    });
    currentOpLogId = ref.id;
    opStartTime = new Date(); pausedAt = null; totalPausedMillis = 0;
    section.dataset.jobId = ""; section.classList.add("hidden");
    await loadCurrentOperation();
    await loadActiveJobs();
    await loadLiveActivity();
  } catch (e) { console.error(e); alert("Failed to start operation."); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) ADMIN NAV + TABS
// ─────────────────────────────────────────────────────────────────────────────
function showAdminNav() {
  ["login-section","worker-section"].forEach(h => $(h).classList.add("hidden"));
  $("main-nav").classList.remove("hidden");
  $("admin-name").textContent = currentUser.id;

  $("tab-dashboard").onclick = showDashboardTab;
  $("tab-operations").onclick = showOperationsTab;
  $("tab-employees").onclick = showEmployeesTab;
  $("tab-jobs").onclick = showJobsTab;
  $("tab-logs").onclick = showLogsTab;

  $("view-worker-dashboard-btn").onclick = () => {
    isAdminImpersonating = true;
    showWorkerDashboard();
  };

  showDashboardTab();
}
function hideAllAdminSections() {
  ["section-dashboard","section-operations","section-employees","section-jobs","section-logs"]
    .forEach(h => $(h).classList.add("hidden"));
}
function showDashboardTab() { hideAllAdminSections(); $("section-dashboard").classList.remove("hidden"); loadAdminMetrics(); }
function showOperationsTab() { hideAllAdminSections(); $("section-operations").classList.remove("hidden"); loadOperationsList(); }
function showEmployeesTab() { hideAllAdminSections(); $("section-employees").classList.remove("hidden"); loadEmployeesList(); }
function showJobsTab() { hideAllAdminSections(); $("section-jobs").classList.remove("hidden"); loadJobsList(); }
function showLogsTab() { hideAllAdminSections(); $("section-logs").classList.remove("hidden"); loadLogs(); }

// ─────────────────────────────────────────────────────────────────────────────
// 7) OPERATIONS MANAGEMENT (updated: reorder + default)
// ─────────────────────────────────────────────────────────────────────────────
async function loadOperationsList() {
  try {
    const snap = await getDocs(collection(db, "operations"));
    const tbody = $("operations-table-body");
    if (!tbody) return; // guard
    tbody.innerHTML = "";
    operationsCache = [];

    const ops = snap.docs.map(ds => {
      const op = ds.data();
      return {
        id: ds.id,
        name: op.name || ds.id,
        sortOrder: typeof op.sortOrder === "number" ? op.sortOrder : 999999,
        isDefault: !!op.isDefault
      };
    }).sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));

    if (!ops.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="2">No operations found</td>`;
      tbody.appendChild(tr);
      return;
    }

    ops.forEach(op => {
      const tr = document.createElement("tr");
      tr.dataset.opId = op.id;
      tr.innerHTML = `
        <td style="width:65%">
          <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
          <strong>${op.name}</strong>
          ${op.isDefault ? '<span class="ml-1 muted">(default)</span>' : ''}
        </td>
        <td style="text-align:right; white-space:nowrap;">
          <label class="ml-1" style="font-weight:600;">
            <input type="radio" name="default-op" ${op.isDefault ? "checked" : ""} onclick="setDefaultOperation('${op.id}')">
            Default
          </label>
          <button class="btn btn-danger btn-sm ml-1" onclick="deleteOperation('${op.id}')">Delete</button>
        </td>`;
      tbody.appendChild(tr);
      operationsCache.push(op);
    });

    enableOpReorder(); // make rows draggable & persist order on drop
  } catch (e) {
    console.error(e);
    $("operations-table-body").innerHTML =
      `<tr><td colspan="2" style="color:red;">Failed to load operations</td></tr>`;
  }
}

async function createOperation() {
  const name = $("new-op-name").value.trim();
  if (!name) return alert("Operation name cannot be empty");
  if (operationsCache.find(o => o.name.toLowerCase() === name.toLowerCase())) {
    return alert(`${name} already exists`);
  }
  try {
    const sortOrder = (operationsCache?.length || 0) + 1;
    await addDoc(collection(db, "operations"), { name, sortOrder, isDefault: false });
    $("new-op-name").value = "";
    await loadOperationsList();
    alert(`Operation "${name}" added`);
  } catch (e) {
    console.error(e);
    alert("Failed to create operation");
  }
}
$("create-op-btn").addEventListener("click", createOperation);

window.deleteOperation = async function (opId) {
  if (!confirm("Delete this operation?")) return;
  try {
    await deleteDoc(doc(db, "operations", opId));
    await loadOperationsList();
  } catch (e) {
    console.error(e);
    alert("Failed to delete operation");
  }
};

// ——— Drag & drop ordering ——————————————————————————————————————
function enableOpReorder() {
  const tbody = $("operations-table-body");
  if (!tbody) return;
  let dragSrc = null;

  tbody.querySelectorAll("tr").forEach(row => {
    row.draggable = true;

    row.addEventListener("dragstart", e => {
      dragSrc = row;
      row.classList.add("dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", row.dataset.opId || ""); } catch {}
      }
    });

    row.addEventListener("dragover", e => {
      e.preventDefault();
      const after = getDragAfterElement(tbody, e.clientY);
      if (!after) tbody.appendChild(dragSrc);
      else tbody.insertBefore(dragSrc, after);
    });

    row.addEventListener("dragend", async () => {
      row.classList.remove("dragging");
      await persistOperationOrder(tbody);
    });
  });
}

function getDragAfterElement(container, mouseY) {
  const els = Array.from(container.querySelectorAll("tr:not(.dragging)"));
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const el of els) {
    const box = el.getBoundingClientRect();
    const offset = mouseY - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: el };
    }
  }
  return closest.element;
}

async function persistOperationOrder(tbody) {
  const rows = Array.from(tbody.querySelectorAll("tr"));
  try {
    await Promise.all(rows.map((row, idx) => {
      const id = row.dataset.opId;
      if (!id) return Promise.resolve();
      return updateDoc(doc(db, "operations", id), { sortOrder: idx + 1 });
    }));
    // Keep cache in sync
    operationsCache.forEach(op => {
      const pos = rows.findIndex(r => r.dataset.opId === op.id);
      if (pos >= 0) op.sortOrder = pos + 1;
    });
  } catch (e) {
    console.error("persistOperationOrder", e);
    alert("Failed to save new order.");
  }
}

// ——— Default operation ————————————————————————————————————————
window.setDefaultOperation = async function (opId) {
  try {
    const snap = await getDocs(collection(db, "operations"));
    await Promise.all(snap.docs.map(ds =>
      updateDoc(doc(db, "operations", ds.id), { isDefault: ds.id === opId })
    ));
    await loadOperationsList();
  } catch (e) {
    console.error(e);
    alert("Failed to set default operation.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 8) EMPLOYEE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
async function createEmployee() {
  const username = $("new-emp-username").value.trim();
  const pin = $("new-emp-pin").value.trim();
  const role = $("new-emp-role").value;
  if (!username || !pin) return alert("Please enter both username and PIN");
  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) return alert("PIN must be exactly 4 digits");
  try {
    await setDoc(doc(db, "users", username), { pin, role });
    $("new-emp-username").value = ""; $("new-emp-pin").value = ""; $("new-emp-role").value = "worker";
    loadEmployeesList(); alert("Employee created successfully");
  } catch (e) { console.error(e); alert("Error creating employee"); }
}
$("create-emp-btn").addEventListener("click", createEmployee);

async function loadEmployeesList() {
  try {
    const snap = await getDocs(collection(db, "users"));
    const tbody = $("employees-table-body");
    tbody.innerHTML = "";
    snap.forEach(ds => {
      const data = ds.data();
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${ds.id}</td>
        <td>${data.role}</td>
        <td>
          <button class="action-btn edit" onclick="editEmployee('${ds.id}', '${data.role}')">Edit</button>
          <button class="action-btn delete" onclick="deleteEmployee('${ds.id}')">Delete</button>
        </td>`;
      tbody.appendChild(tr);
    });
    if (snap.empty) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="3">No employees found</td>`;
      tbody.appendChild(tr);
    }
  } catch (e) { console.error(e); }
}
window.deleteEmployee = async function (username) {
  if (username === currentUser.id) return alert("Cannot delete your own account");
  if (!confirm(`Delete employee '${username}'?`)) return;
  try { await deleteDoc(doc(db, "users", username)); loadEmployeesList(); }
  catch (e) { console.error(e); alert("Error deleting employee"); }
};
window.editEmployee = async function (username, currentRole) {
  const newRole = prompt(`Enter new role for '${username}' (worker/admin):`, currentRole);
  if (!newRole || !["worker","admin"].includes(newRole)) return alert("Invalid role");
  try { await updateDoc(doc(db, "users", username), { role: newRole }); loadEmployeesList(); }
  catch (e) { console.error(e); alert("Error updating employee"); }
};

// ─────────────────────────────────────────────────────────────────────────────
// 9) JOB MANAGEMENT (Create / Search / Render / Edit / Delete / Complete)
// ─────────────────────────────────────────────────────────────────────────────
$("search-jobs-btn").addEventListener("click", searchJobs);
$("clear-jobs-btn").addEventListener("click", () => {
  $("search-po-input").value = "";
  $("search-part-input").value = "";
  $("search-date-from").value = "";
  $("search-date-to").value = "";
  loadJobsList();
});
$("create-job-btn").addEventListener("click", createJob);

async function searchJobs() {
  const poValue   = $("search-po-input").value.trim().toLowerCase();
  const partValue = $("search-part-input").value.trim().toLowerCase();
  const dateFrom  = $("search-date-from").value;
  const dateTo    = $("search-date-to").value;

  try {
    const snap = await getDocs(collection(db, "jobs"));
    const activeJobs = [], completedJobs = [];
    snap.docs.forEach(ds => {
      const data = ds.data();
      (data.active ? activeJobs : completedJobs).push({ id: ds.id, data });
    });
    renderActiveJobsSimple(activeJobs, { poValue, partValue, dateFrom, dateTo });
    renderCompletedJobsGrouped(completedJobs, { poValue, partValue, dateFrom, dateTo });
  } catch (e) { console.error("searchJobs", e); }
}

async function createJob() {
  try {
    const po     = $("new-job-po").value.trim();
    const jobNum = $("new-job-num").value.trim();
    const part   = $("new-job-part").value.trim();
    const qtyRaw = $("new-job-qty").value;
    const rec    = $("new-job-rec").value;
    const due    = $("new-job-due").value;
    const hot    = $("new-job-hot").checked;
    const activeFlag = $("new-job-active").checked;
    const notes  = ($("new-job-notes")?.value || "").trim();
    const summary = ($("new-job-summary")?.value || "").trim();

    // NEW: parse Estimated Hours
    const estStr = ($("new-job-est")?.value || "").trim();
    let estimatedHours = null;
    if (estStr !== "") {
      const n = Number(estStr.replace(/,/g, "."));
      if (!Number.isFinite(n) || n < 0) {
        alert("Estimated hours must be a non-negative number, e.g. 8 or 8.5.");
        return;
      }
      estimatedHours = n;
    }

    if (!po || !jobNum || !part || qtyRaw === "" || !due || !rec) {
      alert("Please fill all required fields: PO, Job #, Part #, Qty, Received, Due.");
      return;
    }
    const qty = parseInt(qtyRaw, 10);
    if (isNaN(qty)) return alert("Quantity must be a valid number.");

    const newJobData = {
      poNumber:     po,
      jobNumber:    jobNum,
      partNumber:   part,
      quantity:     qty,
      receivedDate: rec,
      dueDate:      due,
      hotOrder:     hot,
      active:       activeFlag,
      title:        `${po} – ${jobNum}`,
      notes,
      summary,

      // NEW: persist estimate
      estimatedHours,           // preferred
      hoursEstimate: estimatedHours, // (optional legacy alias)

      createdAt:    Timestamp.now()
    };

    await addDoc(collection(db, "jobs"), newJobData);

    // clear form (include est field)
    ["new-job-po","new-job-num","new-job-part","new-job-qty","new-job-rec","new-job-due","new-job-notes","new-job-summary","new-job-est"]
      .forEach(id => { const el = $(id); if (el) el.value = ""; });
    $("new-job-hot").checked = false;
    $("new-job-active").checked = true;

    loadJobsList();
    alert("Job created successfully");
  } catch (e) {
    console.error("CREATE JOB ERROR:", e);
    alert(`Error creating job:\n${e.message}`);
  }
}

async function loadJobsList() {
  try {
    const snap = await getDocs(collection(db, "jobs"));
    const activeJobs = [], completedJobs = [];
    snap.docs.forEach(ds => (ds.data().active ? activeJobs : completedJobs).push({ id: ds.id, data: ds.data() }));
    renderActiveJobsSimple(activeJobs, { poValue:"", partValue:"", dateFrom:"", dateTo:"" });
    renderCompletedJobsGrouped(completedJobs, { poValue:"", partValue:"", dateFrom:"", dateTo:"" });
  } catch (e) { console.error("loadJobsList", e); }
}

function renderActiveJobsSimple(activeJobsArray, { poValue, partValue, dateFrom, dateTo }) {
  const container = $("active-jobs-container");
  container.innerHTML = "";

  const filtered = activeJobsArray.filter(({ data }) => {
    const poMatch   = !poValue   || (data.poNumber   || "").toLowerCase().includes(poValue);
    const partMatch = !partValue || (data.partNumber || "").toLowerCase().includes(partValue);
    const rec = data.receivedDate || "";
    let dateMatch = true;
    if (dateFrom && (!rec || rec < dateFrom)) dateMatch = false;
    if (dateTo   && (!rec || rec > dateTo))   dateMatch = false;
    return poMatch && partMatch && dateMatch;
  });

  if (!filtered.length) {
    const p = document.createElement("p");
    p.textContent = "No active jobs to display.";
    p.style.color = "#555";
    container.appendChild(p);
    return;
  }

  const table = document.createElement("table");
  table.className = "table";
  table.style.margin = "0.5rem 0";
  table.innerHTML = `
  <thead>
    <tr>
      <th>Job ID</th><th>PO</th><th>Part #</th><th>Qty</th>
      <th>Received</th><th>Due</th><th>Hot</th><th>QR</th><th>Notes</th><th>Summary</th><th>Actions</th>
    </tr>
  </thead>`;
  const tbody = document.createElement("tbody");

  filtered.sort((a,b)=>{
    const aRec = a.data.receivedDate || "";
    const bRec = b.data.receivedDate || "";
    if (aRec > bRec) return -1;
    if (aRec < bRec) return 1;
    return a.id.localeCompare(b.id);
  });

  filtered.forEach(({ id: jobId, data }) => {
    const receivedFormatted = data.receivedDate ? formatYMDtoMDY(data.receivedDate) : "";
    const dueFormatted = data.dueDate ? formatYMDtoMDY(data.dueDate) : "";
    const hotText = data.hotOrder ? "🔥" : "❌";
    const visibleJobNum = data.jobNumber || jobId;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${visibleJobNum}</td>
      <td>${data.poNumber || ""}</td>
      <td>${data.partNumber || ""}</td>
      <td>${data.quantity ?? ""}</td>
      <td>${receivedFormatted}</td>
      <td>${dueFormatted}</td>
      <td>${hotText}</td>
      <td class="qr-cell">
        <canvas id="qr-${jobId}"></canvas><br/>
        <button onclick="printQRCode('${jobId}')" class="btn btn-secondary btn-sm">Print QR</button>
      </td>
      <td>${data.notes ? `<span class="muted">${data.notes}</span>` : "—"}</td>
      <td>${data.summary ? data.summary : "<span class='muted'>—</span>"}</td>
      <td>
        <button class="action-btn delete" onclick="deleteJob('${jobId}')">Delete</button>
        <button class="btn btn-warning btn-sm ml-1" onclick="editJob('${jobId}')">Edit</button>
        <button class="btn btn-success btn-sm ml-1" onclick="markJobCompleted('${jobId}')">Complete</button>
      </td>`;
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);

  // Render QR canvases (guarded)
  filtered.forEach(({ id: jobId }) => {
    const canvas = document.getElementById(`qr-${jobId}`);
    if (!canvas) return;

    // Guard: avoid hard crash if QRious isn't loaded
    if (typeof QRious === "undefined") {
      console.warn("QRious not loaded — skipping QR render");
      return;
    }

    const jobUrl = `${window.location.origin}${window.location.pathname}?jobId=${encodeURIComponent(jobId)}`;

    // Draw QR into the canvas
    new QRious({ element: canvas, value: jobUrl, size: 100 });

    // Make it clickable to open the job directly
    canvas.style.cursor = "pointer";
    canvas.addEventListener("click", () => {
      window.location.href = jobUrl;
    });
  });
}

function renderCompletedJobsGrouped(completedJobsArray, { poValue, partValue, dateFrom, dateTo }) {
  const filtered = completedJobsArray.filter(({ data }) => {
    const poMatch   = !poValue   || (data.poNumber   || "").toLowerCase().includes(poValue);
    const partMatch = !partValue || (data.partNumber || "").toLowerCase().includes(partValue);
    const rec = data.receivedDate || "";
    let dateMatch = true;
    if (dateFrom && (!rec || rec < dateFrom)) dateMatch = false;
    if (dateTo   && (!rec || rec > dateTo))   dateMatch = false;
    return poMatch && partMatch && dateMatch;
  });

  const container = $("completed-jobs-container");
  container.innerHTML = "";
  if (!filtered.length) {
    const p = document.createElement("p");
    p.textContent = "No completed jobs to display.";
    p.style.color = "#555";
    container.appendChild(p);
    return;
  }

  const grouped = {};
  filtered.forEach(({ id, data }) => {
    const rec = data.receivedDate || "";
    let year = "Unknown Year", monthName = "Unknown Month";
    if (/^\d{4}-\d{2}-\d{2}$/.test(rec)) {
      const [yy, mm] = rec.split("-");
      year = yy;
      monthName = [
        "January","February","March","April","May","June","July","August","September","October","November","December"
      ][parseInt(mm,10)-1];
    }
    grouped[year] ||= {};
    grouped[year][monthName] ||= [];
    grouped[year][monthName].push({ id, data });
  });

  const years = Object.keys(grouped)
    .filter(y => y !== "Unknown Year").map(Number).sort((a,b)=>b-a).map(String);
  if (grouped["Unknown Year"]) years.push("Unknown Year");

  years.forEach(yr => {
    const detY = document.createElement("details");
    detY.style.marginBottom = "1rem";
    const sumY = document.createElement("summary");
    sumY.innerHTML = `<strong>${yr}</strong>`;
    sumY.style.fontSize = "1.2rem";
    detY.appendChild(sumY);

    const months = grouped[yr];
    const order = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    Object.keys(months).sort((a,b)=>a==="Unknown Month"?1:b==="Unknown Month"?-1:order.indexOf(a)-order.indexOf(b))
      .forEach(mn => {
        const detM = document.createElement("details");
        detM.style.margin = "0.75rem 0 0.75rem 1.5rem";
        const sumM = document.createElement("summary");
        sumM.textContent = `${mn} ${yr}`;
        sumM.style.fontSize = "1.1rem";
        detM.appendChild(sumM);

        const table = document.createElement("table");
        table.className = "table";
        table.innerHTML = `
  <thead><tr>
    ${isGroupDeleteMode ? '<th>Select</th>' : ''}
    <th>User</th><th>Operation</th><th>Duration</th><th>Paused</th><th>Start Time</th><th>End Time</th><th>Edit</th><th>Delete</th>
  </tr></thead>`;
        const tb = document.createElement("tbody");

        months[mn].sort((a,b)=>{
          const aRec = a.data.receivedDate || "";
          const bRec = b.data.receivedDate || "";
          if (aRec>bRec) return -1;
          if (aRec<bRec) return 1;
          return a.id.localeCompare(b.id);
        }).forEach(({ id: jobId, data }) => {
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td>${data.jobNumber || jobId}</td>
            <td>${data.poNumber}</td>
            <td>${data.partNumber}</td>
            <td>${data.quantity}</td>
            <td>${data.receivedDate ? formatYMDtoMDY(data.receivedDate) : ""}</td>
            <td>${data.dueDate ? formatYMDtoMDY(data.dueDate) : ""}</td>
            <td>${data.hotOrder ? "🔥" : "❌"}</td>
            <td>${data.notes ? `<span class="muted">${data.notes}</span>` : "—"}</td>
            <td>${data.summary ? data.summary : "<span class='muted'>—</span>"}</td>
            <td>
              <button class="action-btn delete" onclick="deleteJob('${jobId}')">Delete</button>
              <button class="btn btn-warning btn-sm ml-1" onclick="editJob('${jobId}')">Edit</button>
              <button class="btn btn-success btn-sm ml-1" onclick="markJobCompleted('${jobId}')">Complete</button>
            </td>`;
          tb.appendChild(tr);
        });

        table.appendChild(tb);
        detM.appendChild(table);
        detY.appendChild(detM);
      });

    container.appendChild(detY);
  });
}

window.deleteJob = async function (jobId) {
  if (!confirm(`Delete job '${jobId}'?`)) return;
  try { await deleteDoc(doc(db, "jobs", jobId)); loadJobsList(); }
  catch (e) { console.error(e); alert("Error deleting job"); }
};
window.editJob = async function (jobId) {
  try {
    const ref = doc(db, "jobs", jobId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return alert("Job not found");
    const d = snap.data();

    const po     = prompt("PO Number:", d.poNumber);
    const jobN   = prompt("Job Number:", d.jobNumber);
    const part   = prompt("Part Number:", d.partNumber);
    const qtyRaw = prompt("Quantity:", d.quantity);
    const rec    = prompt("Received Date (YYYY-MM-DD):", d.receivedDate);
    const due    = prompt("Due Date (YYYY-MM-DD):", d.dueDate);
    const hot    = confirm("Mark as Hot Order?");
    const activeFlag = confirm("Keep job Active?");
    const notes  = prompt("Notes (free text):", d.notes || "") ?? (d.notes || "");
    const summary= prompt("Summary (one sentence):", d.summary || "") ?? (d.summary || "");

    // NEW: Estimated Hours (blank to clear)
    const estRaw = prompt("Estimated Hours (e.g., 8.5) — leave blank to clear:", d.estimatedHours ?? "");
    let estVal = null;
    if (estRaw !== null) {
      const t = estRaw.trim();
      if (t !== "") {
        const n = Number(t.replace(/,/g, "."));
        if (!Number.isFinite(n) || n < 0) return alert("Estimated Hours must be a non-negative number.");
        estVal = n;
      }
    }

    if (!po || !jobN || !part || !qtyRaw || !rec || !due) return alert("Invalid input.");
    const qty = parseInt(qtyRaw,10); if (isNaN(qty)) return alert("Quantity must be a number.");

    const update = {
      poNumber: po, jobNumber: jobN, partNumber: part, quantity: qty,
      receivedDate: rec, dueDate: due, hotOrder: hot, active: activeFlag,
      notes, summary, title: `${po} – ${jobN}`,
      // NEW: if user canceled the prompt we don't touch it; otherwise set (possibly null to clear)
      ...(estRaw !== null ? { estimatedHours: estVal, hoursEstimate: estVal } : {})
    };

    await updateDoc(ref, update);
    loadJobsList();
  } catch (e) { console.error(e); alert("Error editing job"); }
};

window.markJobCompleted = async function (jobId) {
  try {
    await updateDoc(doc(db, "jobs", jobId), { active: false });
    await addDoc(collection(db, "logs"), {
      jobId, user: currentUser.id, operation: "COMPLETED_JOB",
      startTime: Timestamp.now(), endTime: Timestamp.now(),
      pausedAt: null, totalPausedMillis: 0
    });
    loadJobsList();
  } catch (e) { console.error(e); alert("Failed to mark job as completed"); }
};

// ─────────────────────────────────────────────────────────────────────────────
// 10) PRINT QR — Always 1 Page (auto-scale to fit, no info lost)
// ─────────────────────────────────────────────────────────────────────────────
window.printQRCode = async function (jobId) {
  try {
    // 1) Fetch job
    const jobRef = doc(db, "jobs", jobId);
    const jobSnap = await getDoc(jobRef);
    if (!jobSnap.exists()) return alert("Job not found");
    const d = jobSnap.data();

    // 2) Compute total logged hours for this job (completed entries)
    let totalHours = 0;
    try {
      const logsSnap = await getDocs(query(collection(db, "logs"), where("jobId", "==", jobId)));
      logsSnap.docs.forEach(ds => {
        const e = ds.data();
        if (e.startTime && e.endTime) {
          const dur = e.endTime.toDate() - e.startTime.toDate() - (e.totalPausedMillis || 0);
          if (dur > 0) totalHours += dur / 3600000;
        }
      });
    } catch (err) {
      console.warn("Could not compute total hours:", err);
    }
    const totalHoursStr = totalHours.toFixed(2);

    // 3) Fields (keep everything visible)
    const po     = d.poNumber || "";
    const jobNum = d.jobNumber || "";
    const part   = d.partNumber || "";
    const qty    = d.quantity ?? "";
    const rec    = d.receivedDate ? formatYMDtoMDY(d.receivedDate) : "";
    const due    = d.dueDate ? formatYMDtoMDY(d.dueDate) : "";
    const notes  = (d.notes || "").trim();
    const summary = (d.summary || "").trim();
    const title  = d.title || jobId;
    const isHot  = !!d.hotOrder;
    const isActive = d.active !== false; // default true if missing

    // Estimated hours (if stored on job)
    let estHours = null;
    if (d.estimatedHours != null) {
      const n = Number(d.estimatedHours);
      if (!Number.isNaN(n) && n >= 0) estHours = n;
    }
    const estHoursStr = estHours != null ? estHours.toFixed(2) : "—";
    const remainingStr = estHours != null ? (estHours - totalHours).toFixed(2) : "—";

    // Hours until due (to end of due date, local time)
    let hoursUntilDueStr = "—";
    if (d.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(d.dueDate)) {
      const [yy, mm, dd] = d.dueDate.split("-").map(Number);
      const dueEnd = new Date(yy, mm - 1, dd, 23, 59, 59, 999).getTime();
      const nowMs = Date.now();
      const diffHrs = (dueEnd - nowMs) / 3600000;
      hoursUntilDueStr = (diffHrs >= 0 ? diffHrs : Math.ceil(diffHrs)).toFixed(0);
    }

    // 4) Guard: QR lib
    if (typeof QRious === "undefined") {
      alert("QR generator not loaded on this page.");
      return;
    }

    // 5) Build high-res QR (kept crisp even when scaled)
    const qrPxs = 1100; // high resolution for print
    const qr = new QRious({
      value: `${window.location.origin}${window.location.pathname}?jobId=${encodeURIComponent(jobId)}`,
      size: qrPxs
    });
    const dataUrl = qr.toDataURL();

    // 6) Escaper
    const esc = s => String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

    // 7) Open print window & write content
    const w = window.open("", "_blank", "width=1100,height=1400,menubar=no,toolbar=no,location=no,status=no");
    if (!w) return alert("Popup blocked. Allow popups to print QR.");

    w.document.write(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>${esc(title)}</title>
  <style>
    @page { size: Letter; margin: 0.5in; }
    * { box-sizing: border-box; }
    html, body { margin:0; padding:0; background:#fff; color:#111; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Inter, "Helvetica Neue", Arial; }
    :root {
      --page-w: calc(8.5in - 1in);  /* inside left+right margins */
      --page-h: calc(11in - 1in);   /* inside top+bottom margins */
    }
    .wrap {
      width: var(--page-w);
      height: var(--page-h);
      margin: 0 auto;
      position: relative;
      overflow: hidden;            /* in case we scale down, avoid spill */
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      width: var(--page-w);
      max-width: var(--page-w);
      transform-origin: top center;  /* we will scale from top */
      /* visual style */
      text-align: center;
    }
    .title {
      font-size: 38px; font-weight: 900; letter-spacing: .2px; margin: 0 0 6px 0;
    }

    /* Stats row */
    .stats {
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 10px; margin: 8px 0 12px 0; padding: 0 4px;
    }
    .stat {
      border: 2px solid #111; border-radius: 12px; padding: 10px 12px;
    }
    .stat .label { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: #374151; }
    .stat .value { font-size: 28px; font-weight: 900; margin-top: 3px; color: #111827; }
    .stat .sub   { font-size: 12px; color: #6b7280; margin-top: 2px; }

    /* QR */
    .qr { margin: 6px auto 12px auto; }
    .qr img { width: 4.2in; height: 4.2in; display: block; margin: 0 auto; image-rendering: pixelated; }

    /* Two columns of details under QR */
    .details {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px; text-align: left;
      margin: 6px auto 0 auto; width: calc(var(--page-w) - 0.4in);
      font-size: 18px; line-height: 1.25;
    }
    .sec { border: 2px solid #111; border-radius: 12px; padding: 10px 12px; }
    .sec h4 { margin: 0 0 8px 0; font-size: 18px; }
    .kv { display: grid; grid-template-columns: 1.1fr 1.6fr; gap: 10px; margin: 6px 0; }
    .k { font-weight: 800; color: #111827; }
    .v { font-weight: 700; color: #111827; word-break: break-word; }

    .notes { text-align: left; }

    .footer {
      margin-top: 8px; font-size: 12px; color: #374151;
    }

    /* urgency colors for Hours Until Due */
    .danger { color: #b91c1c; }
    .warn   { color: #b45309; }
    .ok     { color: #065f46; }

    @media print {
      .card { box-shadow: none; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card" id="print-card">
      <div class="title">${esc(title)}</div>

      <div class="stats">
        <div class="stat">
          <div class="label">Hours Until Due</div>
          <div class="value" id="hours-until-due">${esc(hoursUntilDueStr)}</div>
          <div class="sub">to end of due date</div>
        </div>
        <div class="stat">
          <div class="label">Estimated Hours</div>
          <div class="value">${esc(estHoursStr)}</div>
          <div class="sub">planned effort</div>
        </div>
        <div class="stat">
          <div class="label">Total Hours</div>
          <div class="value">${esc(totalHoursStr)}</div>
          <div class="sub">logged so far</div>
        </div>
        <div class="stat">
          <div class="label">Remaining</div>
          <div class="value">${esc(remainingStr)}</div>
          <div class="sub">Est − Logged</div>
        </div>
      </div>

      <div class="qr">
        <img src="${dataUrl}" alt="QR Code"/>
      </div>

      <div class="details">
        <div class="sec">
          <h4>Job Details</h4>
          <div class="kv"><div class="k">PO Number</div><div class="v">${esc(po)}</div></div>
          <div class="kv"><div class="k">Job #</div><div class="v">${esc(jobNum)}</div></div>
          <div class="kv"><div class="k">Part #</div><div class="v">${esc(part)}</div></div>
          <div class="kv"><div class="k">Quantity</div><div class="v">${esc(qty)}</div></div>
          <div class="kv"><div class="k">Received</div><div class="v">${esc(rec)}</div></div>
          <div class="kv"><div class="k">Due</div><div class="v">${esc(due)}</div></div>
          <div class="kv"><div class="k">Hot Order</div><div class="v">${isHot ? "Yes 🔥" : "No"}</div></div>
          <div class="kv"><div class="k">Status</div><div class="v">${isActive ? "Active" : "Completed"}</div></div>
        </div>

        <div class="sec notes">
          <h4>Summary & Notes</h4>
          ${summary ? `<div class="kv"><div class="k">Summary</div><div class="v">${esc(summary)}</div></div>` : ``}
          <div style="white-space:pre-wrap">${esc(notes || "—")}</div>
        </div>
      </div>

      <div class="footer">
        Generated ${esc(new Date().toLocaleString())}
      </div>
    </div>
  </div>

  <script>
    (function () {
      // Colorize Hours Until Due
      try {
        const el = document.getElementById("hours-until-due");
        if (el) {
          const val = parseInt(el.textContent.replace(/[^\\-\\d]/g, ""), 10);
          if (!isNaN(val)) {
            if (val < 0) { el.classList.add("danger"); el.textContent = \`Overdue \${Math.abs(val)}h\`; }
            else if (val <= 24) { el.classList.add("warn"); el.textContent = \`\${val}h\`; }
            else { el.classList.add("ok"); el.textContent = \`\${val}h\`; }
          }
        }
      } catch (e) {}

      // Auto-scale to guarantee 1-page fit (no content hiding)
      function scaleToFit() {
        try {
          const wrap = document.querySelector(".wrap");
          const card = document.getElementById("print-card");
          if (!wrap || !card) return;

          // available visual height inside margins (px)
          const avail = wrap.clientHeight;
          // actual content height (px)
          const need = card.scrollHeight;

          const scale = Math.min(1, avail / need);
          card.style.transform = \`scale(\${scale})\`;

          // Center vertically after scaling
          const used = need * scale;
          const offsetTop = Math.max(0, (avail - used) / 2);
          card.style.marginTop = offsetTop + "px";
        } catch (e) {}
      }

      // Run after images/fonts are ready
      window.addEventListener("load", () => {
        scaleToFit();
        // small double-check after layout settles
        setTimeout(scaleToFit, 50);
        setTimeout(() => { window.focus(); window.print(); window.close(); }, 300);
      });
    })();
  </script>
</body>
</html>
    `);
  } catch (e) {
    console.error(e);
    alert("Failed to print QR code.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 11) WORK LOGS (Search / Render / Edit / Delete)
// ─────────────────────────────────────────────────────────────────────────────
$("search-logs-btn").addEventListener("click", () => loadLogs());
$("clear-logs-btn").addEventListener("click", () => {
  $("search-logs-po").value       = "";
  $("search-logs-part").value     = "";
  $("search-logs-date-from").value= "";
  $("search-logs-date-to").value  = "";
  loadLogs();
});

let editingLogId = null;
let isGroupDeleteMode = false;
let selectedLogIds = new Set();
window.handleLogCheckboxChange = function (e) {
  const id = e.target.dataset.logId;
  if (e.target.checked) selectedLogIds.add(id); else selectedLogIds.delete(id);
};

async function loadLogs() {
  try {
    // Jobs map
    const jobsSnap = await getDocs(collection(db, "jobs"));
    const jobsMap = {};
    jobsSnap.docs.forEach(js => {
      const jd = js.data();
      jobsMap[js.id] = {
        po: jd.poNumber || "", part: jd.partNumber || "",
        title: jd.title || js.id, active: !!jd.active
      };
    });

    // Operations map
    const opsSnap = await getDocs(collection(db, "operations"));
    const operationsMap = {};
    opsSnap.docs.forEach(os => operationsMap[os.id] = os.data().name);
    operationsMap["COMPLETED_JOB"] = "Job Completed";

    // Filters
    const poFilter   = $("search-logs-po").value.trim().toLowerCase();
    const partFilter = $("search-logs-part").value.trim().toLowerCase();
    const dateFrom   = $("search-logs-date-from").value;
    const dateTo     = $("search-logs-date-to").value;

    // Logs
    const logsSnap = await getDocs(collection(db, "logs"));
    const activeJobLogs = [], completedJobLogs = [];
    logsSnap.docs.forEach(ds => {
      const entry = { ...ds.data(), id: ds.id };
      const jobId = entry.jobId;
      if (!jobsMap[jobId]) return;
      const jobData = jobsMap[jobId];

      const poMatch   = !poFilter   || jobData.po.toLowerCase().includes(poFilter);
      const partMatch = !partFilter || jobData.part.toLowerCase().includes(partFilter);
      let dateMatch = true;
      if (dateFrom) {
        const fromMillis = new Date(dateFrom).getTime();
        if (entry.startTime.toDate().getTime() < fromMillis) dateMatch = false;
      }
      if (dateTo) {
        const toMillis = new Date(dateTo).getTime() + 24*3600*1000 - 1;
        if (entry.startTime.toDate().getTime() > toMillis) dateMatch = false;
      }
      if (!(poMatch && partMatch && dateMatch)) return;

      (jobData.active ? activeJobLogs : completedJobLogs).push(entry);
    });

    renderActiveWorkLogs(activeJobLogs, operationsMap, jobsMap);
    renderCompletedWorkLogs(completedJobLogs, operationsMap, jobsMap);
  } catch (e) {
    console.error("loadLogs", e);
    $("logs-container").innerHTML = `<p style="color:red;">Failed to load work logs.</p>`;
  }
}

function renderActiveWorkLogs(entriesArray, operationsMap, jobsMap) {
  let ctn = $("active-logs-container");
  if (!ctn) {
    const h = document.createElement("h4"); h.className = "subheading"; h.textContent = "Active Work Logs";
    $("logs-container").appendChild(h);
    ctn = document.createElement("div"); ctn.id = "active-logs-container"; ctn.style.marginBottom = "2rem";
    $("logs-container").appendChild(ctn);
  }
  ctn.innerHTML = "";
  if (!entriesArray.length) {
    const p = document.createElement("p"); p.textContent = "No active work logs."; p.style.color = "#555";
    ctn.appendChild(p); return;
  }

  const byJob = {};
  entriesArray.forEach(e => { (byJob[e.jobId] ||= []).push(e); });

  Object.keys(byJob).sort((a,b)=>(jobsMap[a].title||a).localeCompare(jobsMap[b].title||b))
    .forEach(jobId => {
      const jobEntries = byJob[jobId].sort((a,b)=>a.startTime.toDate()-b.startTime.toDate());
      const h5 = document.createElement("h5"); h5.textContent = `Job: ${jobsMap[jobId].title}`; h5.style.margin="1rem 0 0.5rem";
      ctn.appendChild(h5);

      const table = document.createElement("table");
      table.className = "table"; table.style.fontSize = "0.9rem";
      table.innerHTML = `
  <thead><tr>
    ${isGroupDeleteMode ? '<th>Select</th>' : ''}
    <th>User</th><th>Operation</th><th>Duration</th><th>Paused</th><th>Start Time</th><th>End Time</th><th>Edit</th><th>Delete</th>
  </tr></thead>`;
      const tb = document.createElement("tbody");

      jobEntries.forEach(entry => {
        const paused = entry.totalPausedMillis||0;
        const pmH = String(Math.floor(paused/3600000)).padStart(2,"0");
        const pmM = String(Math.floor((paused%3600000)/60000)).padStart(2,"0");
        const pmS = String(Math.floor((paused%60000)/1000)).padStart(2,"0");
        const pausedText = `${pmH}:${pmM}:${pmS}`;
        let durationText = "In progress";
        if (entry.startTime && entry.endTime) {
          const durMs = entry.endTime.toDate() - entry.startTime.toDate() - paused;
          const h = String(Math.floor(durMs/3600000)).padStart(2,"0");
          const m = String(Math.floor((durMs%3600000)/60000)).padStart(2,"0");
          const s = String(Math.floor((durMs%60000)/1000)).padStart(2,"0");
          durationText = `${h}:${m}:${s}`;
        }
        const startStr = entry.startTime ? formatTimestamp(entry.startTime) : "-";
        const endStr   = entry.endTime   ? formatTimestamp(entry.endTime)   : "In progress";
        const opName   = operationsMap[entry.operation] || entry.operation;

        let checkboxCell = "";
        if (isGroupDeleteMode) {
          const checked = selectedLogIds.has(entry.id) ? "checked" : "";
          checkboxCell = `<td><input type="checkbox" class="log-checkbox" data-log-id="${entry.id}" ${checked} onchange="handleLogCheckboxChange(event)"></td>`;
        }
        const tr = document.createElement("tr");
        tr.innerHTML = `
          ${checkboxCell}
          <td>${entry.user}</td><td>${opName}</td><td>${durationText}</td><td>${pausedText}</td>
          <td>${startStr}</td><td>${endStr}</td>
          <td><button class="btn btn-warning btn-sm" onclick="editLogEntry('${entry.id}')">Edit</button></td>
          <td><button class="btn btn-danger btn-sm" onclick="deleteLogEntry('${entry.id}')">Delete</button></td>`;
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      ctn.appendChild(table);
    });
}

function renderCompletedWorkLogs(entriesArray, operationsMap, jobsMap) {
  let ctn = $("completed-logs-container");
  if (!ctn) {
    const h = document.createElement("h4"); h.className = "subheading"; h.textContent = "Completed Work Logs";
    $("logs-container").appendChild(h);
    ctn = document.createElement("div"); ctn.id = "completed-logs-container"; ctn.style.marginBottom = "2rem";
    $("logs-container").appendChild(ctn);
  }
  ctn.innerHTML = "";
  if (!entriesArray.length) {
    const p = document.createElement("p"); p.textContent = "No completed work logs."; p.style.color = "#555";
    ctn.appendChild(p); return;
  }

  const grouped = {};
  entriesArray.forEach(e => {
    const d = e.startTime.toDate();
    const year = d.getFullYear();
    const monthName = ["January","February","March","April","May","June","July","August","September","October","November","December"][d.getMonth()];
    grouped[year] ||= {}; grouped[year][monthName] ||= {}; (grouped[year][monthName][e.jobId] ||= []).push(e);
  });

  Object.keys(grouped).map(Number).sort((a,b)=>b-a).forEach(year => {
    const detY = document.createElement("details"); detY.style.marginBottom = "1rem";
    const sumY = document.createElement("summary"); sumY.innerHTML = `<strong>${year}</strong>`; sumY.style.fontSize="1.25rem";
    detY.appendChild(sumY);

    const months = grouped[year];
    const order = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    Object.keys(months).sort((a,b)=>order.indexOf(a)-order.indexOf(b)).forEach(mn => {
      const detM = document.createElement("details"); detM.style.margin = "0.75rem 0 0.75rem 1rem";
      const sumM = document.createElement("summary"); sumM.textContent = `${mn} ${year}`; sumM.style.fontSize="1.1rem";
      detM.appendChild(sumM);

      const jobsObj = months[mn];
      Object.keys(jobsObj).sort().forEach(jobId => {
        const entries = jobsObj[jobId].sort((a,b)=>a.startTime.toDate()-b.startTime.toDate());
        const jobTitle = jobsMap[jobId].title;
        let totalSeconds = 0;
        entries.forEach(e => {
          if (e.endTime) totalSeconds += Math.floor((e.endTime.toDate() - e.startTime.toDate() - (e.totalPausedMillis||0))/1000);
        });
        const th = String(Math.floor(totalSeconds/3600)).padStart(2,"0");
        const tm = String(Math.floor((totalSeconds%3600)/60)).padStart(2,"0");
        const ts = String(totalSeconds%60).padStart(2,"0");

        const jobSection = document.createElement("div"); jobSection.style.margin = "0 0 1.5rem 2rem";
        const jobHeader = document.createElement("h4"); jobHeader.textContent = `Job: ${jobTitle}  (Total Time: ${th}:${tm}:${ts})`; jobHeader.style.marginBottom="0.5rem";
        jobSection.appendChild(jobHeader);

        const table = document.createElement("table"); table.className = "table";
        table.innerHTML = `
          <thead><tr style="background:#eef7f1;">
            ${isGroupDeleteMode ? '<th>Select</th>' : ''}
            <th>User</th><th>Operation</th><th>Duration</th><th>Paused</th><th>Start Time</th><th>End Time</th><th>Edit</th><th>Delete</th>
          </tr></thead>`;
        const tb = document.createElement("tbody");

        entries.forEach(e => {
          const paused = e.totalPausedMillis||0;
          const pmH = String(Math.floor(paused/3600000)).padStart(2,"0");
          const pmM = String(Math.floor((paused%3600000)/60000)).padStart(2,"0");
          const pmS = String(Math.floor((paused%60000)/1000)).padStart(2,"0");
          const pausedText = `${pmH}:${pmM}:${pmS}`;
          let durationText = "In progress";
          if (e.endTime) {
            const dur = e.endTime.toDate()-e.startTime.toDate()-paused;
            const h = String(Math.floor(dur/3600000)).padStart(2,"0");
            const m = String(Math.floor((dur%3600000)/60000)).padStart(2,"0");
            const s = String(Math.floor((dur%3600000)%60000/1000)).padStart(2,"0");
            durationText = `${h}:${m}:${s}`;
          }
          const startStr = formatTimestamp(e.startTime);
          const endStr = e.endTime ? formatTimestamp(e.endTime) : "In progress";
          const opName = operationsMap[e.operation] || e.operation;

          let checkboxCell = "";
          if (isGroupDeleteMode) {
            const checked = selectedLogIds.has(e.id) ? "checked" : "";
            checkboxCell = `<td><input type="checkbox" class="log-checkbox" data-log-id="${e.id}" ${checked} onchange="handleLogCheckboxChange(event)"></td>`;
          }
          const tr = document.createElement("tr");
          tr.innerHTML = `
            ${checkboxCell}
            <td>${e.user}</td><td>${opName}</td><td>${durationText}</td><td>${pausedText}</td>
            <td>${startStr}</td><td>${endStr}</td>
            <td><button class="btn btn-warning btn-sm" onclick="editLogEntry('${e.id}')">Edit</button></td>
            <td><button class="btn btn-danger btn-sm" onclick="deleteLogEntry('${e.id}')">Delete</button></td>`;
          tb.appendChild(tr);
        });

        table.appendChild(tb);
        jobSection.appendChild(table);
        detM.appendChild(jobSection);
      });

      detY.appendChild(detM);
    });

    ctn.appendChild(detY);
  });
}

window.deleteLogEntry = async function (logId) {
  if (!confirm("Delete this log entry?")) return;
  try { await deleteDoc(doc(db, "logs", logId)); await loadLogs(); }
  catch (e) { console.error(e); alert("Failed to delete log entry."); }
};
window.editLogEntry = async function (logId) {
  try {
    const ref = doc(db, "logs", logId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return alert("Log entry not found.");
    const d = snap.data();
    $("edit-start-input").value = toLocalDatetimeString(d.startTime);
    $("edit-end-input").value   = d.endTime ? toLocalDatetimeString(d.endTime) : "";
    editingLogId = logId;
    $("edit-log-modal").classList.remove("hidden");
  } catch (e) { console.error(e); alert("Could not load log entry for editing."); }
};
$("save-log-btn").addEventListener("click", async () => {
  if (!editingLogId) return;
  try {
    const ref = doc(db, "logs", editingLogId);
    const newStartTs = parseLocalDatetime($("edit-start-input").value);
    const newEndTs   = parseLocalDatetime($("edit-end-input").value);
    if (!newStartTs) return alert("Provide a valid start time (YYYY-MM-DDThh:mm:ss).");
    await updateDoc(ref, { startTime: newStartTs, endTime: newEndTs });
    $("edit-log-modal").classList.add("hidden"); editingLogId = null; loadLogs();
  } catch (e) { console.error(e); alert("Failed to update log entry."); }
});
$("cancel-log-btn").addEventListener("click", () => {
  $("edit-log-modal").classList.add("hidden"); editingLogId = null;
});

// ─────────────────────────────────────────────────────────────────────────────
// 12) OPEN FROM ?jobId=… (QR jump)
// ─────────────────────────────────────────────────────────────────────────────
function openFromQueryParam() {
  const params = new URLSearchParams(window.location.search);
  const jumpedJobId = params.get("jobId");
  if (!jumpedJobId) return;
  document.querySelectorAll("#worker-jobs-tbody tr").forEach(row => {
    if (row.dataset.jobId === jumpedJobId) {
      row.click();
      history.replaceState(null, "", window.location.pathname);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 13) OPERATIONS FOR WORKER (dropdown)
// ─────────────────────────────────────────────────────────────────────────────
async function loadOperationsForWorker() {
  try {
    // Always refresh from DB so we get latest order/default
    const snap = await getDocs(collection(db, "operations"));
    operationsCache = [];
    snap.forEach(ds => {
      const d = ds.data();
      operationsCache.push({
        id: ds.id,
        name: d.name,
        sortOrder: typeof d.sortOrder === "number" ? d.sortOrder : 999999,
        isDefault: !!d.isDefault
      });
    });

    operationsCache.sort((a,b)=> (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));

    const select = $("operation-select");
    select.innerHTML = "";
    if (!operationsCache.length) {
      select.innerHTML = `<option disabled>No operations defined</option>`;
      select.disabled = true; return;
    }

    select.disabled = false;
    operationsCache.forEach(op => {
      const opt = document.createElement("option");
      opt.value = op.id; opt.textContent = op.name;
      select.appendChild(opt);
    });

    const def = operationsCache.find(o => o.isDefault) || operationsCache[0];
    if (def) select.value = def.id;
  } catch (e) {
    console.error(e);
    const select = $("operation-select");
    select.innerHTML = `<option disabled>Failed to load operations</option>`;
    select.disabled = true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 14) DASHBOARD METRICS & CHART
// ─────────────────────────────────────────────────────────────────────────────
async function loadAdminMetrics() {
  const logsSnap = await getDocs(collection(db, "logs"));
  const jobsSnap = await getDocs(collection(db, "jobs"));

  // Map jobs to received/completed for turnaround
  const jobMap = {};
  jobsSnap.docs.forEach(js => {
    const jd = js.data();
    jobMap[js.id] = { receivedDate: jd.receivedDate || null, completedTimestamp: null };
  });

  // Track latest completion per job
  logsSnap.docs.forEach(ls => {
    const d = ls.data();
    if (d.operation === "COMPLETED_JOB" && d.endTime && jobMap[d.jobId]) {
      const t = d.endTime.toDate().getTime();
      if (!jobMap[d.jobId].completedTimestamp || t > jobMap[d.jobId].completedTimestamp) {
        jobMap[d.jobId].completedTimestamp = t;
      }
    }
  });

  // Time windows
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayIndex = now.getDay();
  const mondayOffset = (dayIndex === 0 ? -6 : 1 - dayIndex);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  const startOfWeek = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate()).getTime();

  // Initialize metrics
  let hoursToday = 0, hoursWeek = 0;
  const dailyTotals = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek + i * 86400000);
    dailyTotals[`${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`] = 0;
  }

  // Aggregate durations
  logsSnap.docs.forEach(ls => {
    const e = ls.data();
    if (!e.startTime || !e.endTime) return;
    const s = e.startTime.toDate().getTime();
    const end = e.endTime.toDate().getTime();
    const paused = e.totalPausedMillis || 0;
    const durMs = end - s - paused;
    if (durMs <= 0) return;
    const durHrs = durMs / 3600000;

    if (s >= startOfToday) hoursToday += durHrs;
    if (s >= startOfWeek) {
      hoursWeek += durHrs;
      const d = new Date(s);
      const key = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
      if (dailyTotals[key] !== undefined) dailyTotals[key] += durHrs;
    }
  });

  // Write numeric metrics
  $("metric-hours-today").textContent = hoursToday.toFixed(2);
  $("metric-hours-week").textContent = hoursWeek.toFixed(2);

  // Average turnaround
  let totalTurnaroundMs = 0, countCompletedJobs = 0;
  Object.keys(jobMap).forEach(jobId => {
    const recStr = jobMap[jobId].receivedDate;
    const compTs = jobMap[jobId].completedTimestamp;
    if (recStr && compTs) {
      const [yy, mm, dd] = recStr.split("-");
      const recDate = new Date(parseInt(yy), parseInt(mm) - 1, parseInt(dd)).getTime();
      if (compTs >= recDate) {
        totalTurnaroundMs += compTs - recDate;
        countCompletedJobs++;
      }
    }
  });
  const avgDays = countCompletedJobs ? (totalTurnaroundMs / 86400000 / countCompletedJobs).toFixed(1) : 0;
  $("metric-turnaround").textContent = countCompletedJobs ? `${avgDays} day${avgDays !== "1.0" ? "s" : ""}` : "—";

  // Top operators this week
  const userTotals = {};
  logsSnap.docs.forEach(ls => {
    const e = ls.data();
    if (!e.startTime || !e.endTime) return;
    const s = e.startTime.toDate().getTime();
    if (s < startOfWeek) return;
    const end = e.endTime.toDate().getTime();
    const paused = e.totalPausedMillis || 0;
    const durHrs = (end - s - paused) / 3600000;
    if (durHrs <= 0) return;
    userTotals[e.user] = (userTotals[e.user] || 0) + durHrs;
  });
  const top = Object.entries(userTotals).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topList = $("metric-top-operators");
  topList.innerHTML = "";
  if (top.length) {
    top.forEach(([u, h]) => {
      const li = document.createElement("li");
      li.textContent = `${u} – ${h.toFixed(2)} hrs`;
      topList.appendChild(li);
    });
  } else {
    const li = document.createElement("li");
    li.textContent = "—";
    topList.appendChild(li);
  }

  // Chart render (guarded)
  const ctxEl = $("chart-hours-trend");
  if (!window.Chart || !ctxEl || !ctxEl.getContext) {
    console.warn("Chart.js or <canvas> not available — skipping chart render");
    // Metrics are already populated; just skip the chart.
  } else {
    const ctx = ctxEl.getContext("2d");
    const labels = Object.keys(dailyTotals);
    const dataArr = labels.map(lbl => parseFloat(dailyTotals[lbl].toFixed(2)));

    if (window.hoursTrendChart) window.hoursTrendChart.destroy();

    window.hoursTrendChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Hours Logged", data: dataArr, fill: true, tension: 0.3 }
        ]
      },
      options: {
        scales: {
          y: { beginAtZero: true, title: { display: true, text: "Hours" } },
          x: { title: { display: true, text: "Date" } }
        },
        responsive: true,
        maintainAspectRatio: false
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 15) AI FEATURES (Smart Paste, Clean Notes, Job Insights, Daily Brief,
//                 Conversational Search)
// ─────────────────────────────────────────────────────────────────────────────

// 15.1 Smart Paste (AI Ingestion Engine)
const btnAnalyzeJob = $("btn-smart-paste-analyze");
if (btnAnalyzeJob) {
  btnAnalyzeJob.addEventListener("click", async () => {
    const raw = ($("smart-paste-input")?.value || "").trim();
    if (!raw) return alert("Paste a client email/message first.");
    const prev = btnAnalyzeJob.textContent; btnAnalyzeJob.textContent = "✨ Analyzing…"; btnAnalyzeJob.disabled = true;
    try {
      const prompt = `
Act as an intelligent data entry assistant for a manufacturing company.
Extract fields from the text below. If not found, use null. Today's date is ${TODAY_STR}.
Return ONLY JSON. Dates must be YYYY-MM-DD.

Fields:
- poNumber (string)
- partNumber (string)
- quantity (integer)
- dueDate (YYYY-MM-DD)
- details (string)

Text:
"""
${raw}
"""

JSON format:
{
  "poNumber": "string",
  "partNumber": "string",
  "quantity": 0,
  "dueDate": "YYYY-MM-DD",
  "details": "string"
}`;
      const j = await aiJSON(prompt);

      // Fill form
      if (j.poNumber) $("new-job-po").value = j.poNumber;
      if (j.partNumber) $("new-job-part").value = j.partNumber;
      if (Number.isFinite(j.quantity)) $("new-job-qty").value = j.quantity;
      if (j.dueDate) $("new-job-due").value = j.dueDate;
      // notes & summary
      if (j.details) $("new-job-notes").value = j.details;

      // If job number pattern is present inside text (e.g., "Job J-1234"), try to guess
      if (!$("new-job-num").value) {
        const guess = (raw.match(/\bJ[-\s]?(\d{2,6})\b/i)?.[0] || "").replace(/\s+/g,"");
        if (guess) $("new-job-num").value = guess.toUpperCase();
      }

      alert("Fields populated from Smart Paste.");
    } catch (e) {
      console.error(e);
      alert("AI could not extract structured data. You can still paste and edit manually.");
    } finally {
      btnAnalyzeJob.textContent = prev; btnAnalyzeJob.disabled = false;
    }
  });
}

// 15.2 Clean Notes (rewrite notes concisely)
const btnCleanNotes = $("btn-clean-notes");
if (btnCleanNotes) {
  btnCleanNotes.addEventListener("click", async () => {
    const notes = ($("new-job-notes")?.value || "").trim();
    if (!notes) return alert("Enter some notes first.");
    const prev = btnCleanNotes.textContent; btnCleanNotes.textContent = "✨ Cleaning…"; btnCleanNotes.disabled = true;
    try {
      const prompt = `
Rewrite the following manufacturing job notes into concise, clear bullet points.
Keep technical terms. No preamble, no closing text—just the bullet points.

Notes:
"""
${notes}
"""`;
      const out = await aiText(prompt);
      $("new-job-notes").value = out.replace(/^```\w*\n?/,"").replace(/```$/,"").trim();
    } catch (e) {
      console.error(e); alert("AI error cleaning notes.");
    } finally {
      btnCleanNotes.textContent = prev; btnCleanNotes.disabled = false;
    }
  });
}

// 15.3 AI Job Summary (one-sentence work order) — already covered via "✨ Suggest Summary" button
const btnSuggestSummary = $("ai-suggest-summary-btn");
if (btnSuggestSummary) {
  btnSuggestSummary.addEventListener("click", async () => {
    const po = $("new-job-po").value.trim() || "—";
    const part = $("new-job-part").value.trim() || "—";
    const qty = $("new-job-qty").value || "—";
    const notes = ($("new-job-notes")?.value || "").trim() || "(none)";
    const prev = btnSuggestSummary.textContent; btnSuggestSummary.textContent = "✨ Generating…"; btnSuggestSummary.disabled = true;
    try {
      const prompt = `
Act as a senior floor manager for a high-precision deburring company. Write one clear, professional sentence.

Based on:
- PO Number: ${po}
- Part Number: ${part}
- Quantity: ${qty}
- Raw Notes: ${notes}

Return ONLY the sentence.`;
      const out = await aiText(prompt);
      $("new-job-summary").value = out.replace(/^```\w*\n?/,"").replace(/```$/,"").trim();
    } catch (e) {
      console.error(e); alert("AI error generating summary.");
    } finally {
      btnSuggestSummary.textContent = prev; btnSuggestSummary.disabled = false;
    }
  });
}

// 15.4 Job Insights (risks, missing info, due pressure, next steps)
const btnJobInsights = $("btn-job-insights");
if (btnJobInsights) {
  btnJobInsights.addEventListener("click", async () => {
    const po = $("new-job-po").value.trim();
    const job = $("new-job-num").value.trim();
    const part = $("new-job-part").value.trim();
    const qty = $("new-job-qty").value || "—";
    const rec = $("new-job-rec").value || "—";
    const due = $("new-job-due").value || "—";
    const hot = $("new-job-hot").checked ? "Yes" : "No";
    const notes = ($("new-job-notes")?.value || "").trim() || "(none)";
    const prev = btnJobInsights.textContent; btnJobInsights.textContent = "✨ Thinking…"; btnJobInsights.disabled = true;
    try {
      const prompt = `
You are a veteran shop-floor lead. Analyze this job and respond in tight markdown with sections:

**Risks & Watchouts** (bullets)
**Missing Info** (bullets)
**Time Pressure** (1-2 bullets; consider due date ${due}, TODAY=${TODAY_STR}, Hot=${hot})
**Recommended Op Sequence** (bullets; reference operations by name like Cut/Buff/Pack if applicable)

Job:
- PO: ${po}
- Job#: ${job}
- Part: ${part}
- Qty: ${qty}
- Received: ${rec}
- Due: ${due}
- Hot: ${hot}
- Notes: ${notes}

Only the markdown body.`;
      const out = await aiText(prompt);
      const box = $("job-insights-output");
if (box) { setText(box, out); box.classList.remove("hidden"); }
    } catch (e) {
      console.error(e); alert("AI error generating insights.");
    } finally {
      btnJobInsights.textContent = prev; btnJobInsights.disabled = false;
    }
  });
}

// 15.5 Daily Brief (dashboard)
const btnDailyBrief = $("btn-daily-briefing");
if (btnDailyBrief) {
  btnDailyBrief.addEventListener("click", async () => {
    const prev = btnDailyBrief.textContent; btnDailyBrief.textContent = "✨ Generating…"; btnDailyBrief.disabled = true;
    try {
      // reuse computed metrics from DOM
      const hoursToday = $("metric-hours-today").textContent || "0";
      const hoursWeek  = $("metric-hours-week").textContent || "0";
      const avgTurnaround = $("metric-turnaround").textContent || "—";
      const prompt = `
Act as an experienced and encouraging factory floor manager. Write a brief, 2–3 sentence summary of the team's performance for the day. Be insightful and encouraging.

Here are today's key metrics:
- Total Hours Logged Today: ${hoursToday}
- Total Hours Logged This Week: ${hoursWeek}
- Average Job Turnaround: ${avgTurnaround}

Only the 2–3 sentence briefing.`;
      const out = await aiText(prompt);
      const box = $("daily-briefing-output");
      if (box) { box.innerText = out.replace(/^```\w*\n?/,"").replace(/```$/,"").trim(); box.classList.remove("hidden"); }
    } catch (e) {
      console.error(e); alert("AI error generating briefing.");
    } finally {
      btnDailyBrief.textContent = prev; btnDailyBrief.disabled = false;
    }
  });
}

// 15.6 Conversational Search & Analytics (Text → Filters → Results)
const btnAIQuery = $("btn-ai-query");
if (btnAIQuery) {
  btnAIQuery.addEventListener("click", async () => {
    const qtext = ($("ai-query-input")?.value || "").trim();
    if (!qtext) return alert("Type a question.");
    const prev = btnAIQuery.textContent; btnAIQuery.textContent = "✨ Parsing…"; btnAIQuery.disabled = true;
    try {
      const prompt = `
Act as a database query generator. Convert the user's question into filters JSON.
Today's date is ${TODAY_STR}. Return ONLY JSON.

Available fields:
poNumber (string), partNumber (string), user (string), operation (string),
startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), status ('active'|'completed'), isHotOrder (boolean).

Question:
"""
${qtext}
"""

Return only the JSON with ONLY fields the user implies.`;
      const filters = await aiJSON(prompt);

      // Fetch data
      const jobsSnap = await getDocs(collection(db, "jobs"));
      const logsSnap = await getDocs(collection(db, "logs"));

      const jobs = jobsSnap.docs.map(ds => ({ id: ds.id, ...ds.data() }));
      const logs = logsSnap.docs.map(ds => ({ id: ds.id, ...ds.data() }));

      // Apply filters
      const startMs = filters.startDate ? new Date(filters.startDate).getTime() : null;
      const endMs   = filters.endDate   ? (new Date(filters.endDate).getTime()+24*3600*1000-1) : null;

      // Build job index
      const jobById = {}; jobs.forEach(j => jobById[j.id] = j);

      let filteredLogs = logs.slice();
      if (filters.user)       filteredLogs = filteredLogs.filter(l => (l.user||"").toLowerCase() === filters.user.toLowerCase());
      if (filters.operation)  filteredLogs = filteredLogs.filter(l => (l.operation||"").toLowerCase() === filters.operation.toLowerCase());
      if (startMs)            filteredLogs = filteredLogs.filter(l => l.startTime && l.startTime.toDate().getTime() >= startMs);
      if (endMs)              filteredLogs = filteredLogs.filter(l => l.startTime && l.startTime.toDate().getTime() <= endMs);

      // Keep logs whose job matches PO/Part/status/hot
      filteredLogs = filteredLogs.filter(l => {
        const j = jobById[l.jobId]; if (!j) return false;
        if (filters.poNumber && (j.poNumber||"").toLowerCase() !== filters.poNumber.toLowerCase()) return false;
        if (filters.partNumber && (j.partNumber||"").toLowerCase() !== filters.partNumber.toLowerCase()) return false;
        if (typeof filters.isHotOrder === "boolean" && !!j.hotOrder !== filters.isHotOrder) return false;
        if (filters.status === "active" && !j.active) return false;
        if (filters.status === "completed" && j.active) return false;
        return true;
      });

      // Summaries
      const totalHours = filteredLogs.reduce((acc, l) => {
        if (!l.startTime || !l.endTime) return acc;
        const dur = l.endTime.toDate() - l.startTime.toDate() - (l.totalPausedMillis||0);
        return dur > 0 ? acc + dur/3600000 : acc;
      }, 0);

      const byOperation = {};
      filteredLogs.forEach(l => {
        const key = (l.operation || "UNKNOWN");
        byOperation[key] = (byOperation[key] || 0) + (l.endTime && l.startTime ? (l.endTime.toDate()-l.startTime.toDate()-(l.totalPausedMillis||0))/3600000 : 0);
      });

      const byJob = {};
      filteredLogs.forEach(l => {
        const j = jobById[l.jobId];
        const jobTitle = j ? (j.title || j.jobNumber || l.jobId) : l.jobId;
        byJob[jobTitle] = (byJob[jobTitle] || 0) + (l.endTime && l.startTime ? (l.endTime.toDate()-l.startTime.toDate()-(l.totalPausedMillis||0))/3600000 : 0);
      });

      // Render results
      const out = $("ai-query-output");
      out.innerHTML = `
        <div class="subsection" style="margin-top:0.75rem;">
          <h4 class="subheading">AI Filters</h4>
          <pre style="white-space:pre-wrap;background:#f6f8fa;padding:0.75rem;border-radius:6px;border:1px solid #e5e7eb;">${JSON.stringify(filters, null, 2)}</pre>
          <h4 class="subheading">Summary</h4>
          <p><strong>Matching logs:</strong> ${filteredLogs.length}</p>
          <p><strong>Total hours:</strong> ${totalHours.toFixed(2)}</p>
          <details open style="margin-top:0.5rem;">
            <summary><strong>Hours by Operation</strong></summary>
            <pre style="white-space:pre-wrap;background:#f6f8fa;padding:0.75rem;border-radius:6px;border:1px solid #e5e7eb;">${JSON.stringify(Object.fromEntries(Object.entries(byOperation).map(([k,v])=>[k, Number(v.toFixed(2))])), null, 2)}</pre>
          </details>
          <details style="margin-top:0.5rem;">
            <summary><strong>Hours by Job</strong></summary>
            <pre style="white-space:pre-wrap;background:#f6f8fa;padding:0.75rem;border-radius:6px;border:1px solid #e5e7eb;">${JSON.stringify(Object.fromEntries(Object.entries(byJob).map(([k,v])=>[k, Number(v.toFixed(2))])), null, 2)}</pre>
          </details>
        </div>`;
      out.classList.remove("hidden");
    } catch (e) {
      console.error(e);
      alert("AI query failed. Try rephrasing your question.");
    } finally {
      btnAIQuery.textContent = prev; btnAIQuery.disabled = false;
    }
  });
}

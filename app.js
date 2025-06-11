// app.js

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

/* =====================================================
   0) FIREBASE INITIALIZATION
   ===================================================== */
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

let currentUser = null;
let currentOpLogId = null;
let opStartTime = null;
let opTimerInterval = null;
let pausedAt = null;
let totalPausedMillis = 0;
let operationsCache = [];
let isAdminImpersonating = false;

/* =====================================================
   1) UTILITY: FORMAT DATES → MM/DD/YYYY
   ===================================================== */
function formatYMDtoMDY(ymd) {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-");
  return `${m.padStart(2, "0")}/${d.padStart(2, "0")}/${y}`;
}

function formatTimestamp(ts) {
  if (!ts || !ts.toDate) return "";
  const d = ts.toDate();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day   = String(d.getDate()).padStart(2, "0");
  const year  = d.getFullYear();
  const hh    = String(d.getHours()).padStart(2, "0");
  const mm    = String(d.getMinutes()).padStart(2, "0");
  const ss    = String(d.getSeconds()).padStart(2, "0");
  return `${month}/${day}/${year} ${hh}:${mm}:${ss}`;
}

/* =====================================================
   2) LOGIN LOGIC
   ===================================================== */
document.getElementById("login-btn").addEventListener("click", async () => {
  const usernameInput = document.getElementById("username").value.trim();
  const pinInput = document.getElementById("pin").value.trim();

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
  const loginBtn = document.getElementById("login-btn");
  const originalText = loginBtn.textContent;
  loginBtn.textContent = "Logging in…";
  loginBtn.disabled = true;

  try {
    const userRef = doc(db, "users", usernameInput);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      throw new Error("User not found. Check your username.");
    }
    const userData = userSnap.data();
    if (
      !userData.role ||
      (userData.role !== "worker" && userData.role !== "admin")
    ) {
      throw new Error("Your account role is not set. Contact admin.");
    }
    const storedPin = String(userData.pin || "");
    if (storedPin !== pinInput) {
      throw new Error("Invalid PIN. Please try again.");
    }

    currentUser = { id: userSnap.id, ...userSnap.data() };
    localStorage.setItem("currentUser", currentUser.id);

    // Hide all sections
    ["login-section", "worker-section", "main-nav",
     "section-dashboard", "section-operations",
     "section-employees", "section-jobs", "section-logs"]
      .forEach(id => document.getElementById(id).classList.add("hidden"));

    if (currentUser.role === "worker") {
      showWorkerDashboard();
    } else {
      showAdminNav();
    }
  } catch (err) {
    console.error("Login error:", err);
    alert(err.message);
  } finally {
    loginBtn.textContent = originalText;
    loginBtn.disabled = false;
  }
});

/* =====================================================
   3) AUTO-LOGIN ("Remember Me")
   ===================================================== */
window.addEventListener("load", async () => {
  const stored = localStorage.getItem("currentUser");
  if (stored) {
    try {
      const userRef = doc(db, "users", stored);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        currentUser = { id: userSnap.id, ...userSnap.data() };
        document.getElementById("login-section").classList.add("hidden");
        if (currentUser.role === "worker") {
          showWorkerDashboard();
        } else {
          showAdminNav();
        }
      } else {
        localStorage.removeItem("currentUser");
      }
    } catch (error) {
      console.error("Auto-login error:", error);
      localStorage.removeItem("currentUser");
    }
  }
});

/* =====================================================
   4) LOGOUT LOGIC
   ===================================================== */
document.getElementById("logout-worker").addEventListener("click", () => {
  localStorage.removeItem("currentUser");
  document.getElementById("worker-section").classList.add("hidden");
  document.getElementById("login-section").classList.remove("hidden");
});
document.getElementById("logout-admin").addEventListener("click", () => {
  localStorage.removeItem("currentUser");
  isAdminImpersonating = false;
  ["main-nav","section-dashboard","section-operations",
   "section-employees","section-jobs","section-logs","worker-section"]
    .forEach(id => document.getElementById(id).classList.add("hidden"));
  document.getElementById("login-section").classList.remove("hidden");
});

/* =====================================================
   5) WORKER DASHBOARD
   ===================================================== */
function showWorkerDashboard() {
  ["login-section","main-nav",
   "section-dashboard","section-operations",
   "section-employees","section-jobs","section-logs"]
    .forEach(id => document.getElementById(id).classList.add("hidden"));

  document.getElementById("worker-section").classList.remove("hidden");
  document.getElementById("worker-name").textContent = currentUser.id;

  const returnBtn = document.getElementById("return-admin-btn");
  if (isAdminImpersonating && currentUser.role === "admin") {
    returnBtn.classList.remove("hidden");
    returnBtn.onclick = () => {
      isAdminImpersonating = false;
      showAdminNav();
    };
  } else {
    returnBtn.classList.add("hidden");
  }

  initWorker();
}

async function initWorker() {
  await loadCurrentOperation();
  await loadActiveJobs();
  await loadOperationsForWorker();
  await loadLiveActivity();

  document
    .getElementById("refresh-jobs-btn")
    .addEventListener("click", async () => {
      await loadActiveJobs();
      await loadCurrentOperation();
      await loadLiveActivity();
    });

  setInterval(loadLiveActivity, 30000);
  openFromQueryParam();
}

/* ——————————————————————————————————————————————————————————————————————
   5A) CURRENT OPERATION PANEL (Worker)
—————————————————————————————————————————————————————————————————————— */
async function loadCurrentOperation() {
  if (opTimerInterval) {
    clearInterval(opTimerInterval);
    opTimerInterval = null;
  }
  pausedAt = null;
  totalPausedMillis = 0;

  try {
    const logsCol = collection(db, "logs");
    const q = query(
      logsCol,
      where("user", "==", currentUser.id),
      where("endTime", "==", null)
    );
    const snapshot = await getDocs(q);

    const curSec = document.getElementById("current-operation-section");
    if (snapshot.empty) {
      curSec.classList.add("hidden");
      currentOpLogId = null;
      opStartTime = null;
      return;
    }

    let chosenDoc = snapshot.docs[0];
    snapshot.docs.forEach(docSnap => {
      if (docSnap.data().startTime.toDate() >
          chosenDoc.data().startTime.toDate()) {
        chosenDoc = docSnap;
      }
    });

    const data = chosenDoc.data();
    currentOpLogId = chosenDoc.id;
    opStartTime = data.startTime.toDate();
    totalPausedMillis = data.totalPausedMillis || 0;

    const jobSnap = await getDoc(doc(db, "jobs", data.jobId));
    let jobInfo = data.jobId;
    if (jobSnap.exists()) {
      const jd = jobSnap.data();
      jobInfo = `${jd.jobNumber || data.jobId} (PO: ${jd.poNumber}, Part: ${jd.partNumber})`;
    }
    document.getElementById("current-op-jobinfo").textContent = jobInfo;

    const opId = data.operation;
    let opName = opId;
    const foundOp = operationsCache.find(o => o.id === opId);
    if (foundOp) opName = foundOp.name;
    document.getElementById("current-op-name").textContent = opName;

    document.getElementById("current-op-start").textContent =
      formatTimestamp(Timestamp.fromDate(opStartTime));

    if (data.pausedAt) {
      pausedAt = data.pausedAt.toDate();
      document.getElementById("pause-operation-btn").classList.add("hidden");
      document.getElementById("resume-operation-btn").classList.remove("hidden");
    } else {
      document.getElementById("pause-operation-btn").classList.remove("hidden");
      document.getElementById("resume-operation-btn").classList.add("hidden");
    }

    updateElapsedTimer();
    opTimerInterval = setInterval(updateElapsedTimer, 1000);
    curSec.classList.remove("hidden");
  } catch (error) {
    console.error("Error loading current operation:", error);
    document.getElementById("current-operation-section").classList.add("hidden");
    currentOpLogId = null;
    opStartTime = null;
  }
}

function updateElapsedTimer() {
  if (!opStartTime) {
    document.getElementById("current-op-elapsed").textContent = "00:00:00";
    return;
  }
  const now = new Date();
  let diffMs = now - opStartTime - totalPausedMillis;
  if (pausedAt) {
    diffMs -= (now - pausedAt);
  }
  if (diffMs < 0) diffMs = 0;
  const totalSeconds = Math.floor(diffMs / 1000);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const hh = String(hrs).padStart(2, "0");
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  document.getElementById("current-op-elapsed").textContent = `${hh}:${mm}:${ss}`;
}

document
  .getElementById("pause-operation-btn")
  .addEventListener("click", async () => {
    if (!currentOpLogId) return;
    pausedAt = new Date();
    try {
      await updateDoc(doc(db, "logs", currentOpLogId), {
        pausedAt: Timestamp.fromDate(pausedAt)
      });
      document.getElementById("pause-operation-btn").classList.add("hidden");
      document.getElementById("resume-operation-btn").classList.remove("hidden");
    } catch (err) {
      console.error("Error pausing operation:", err);
      alert("Failed to pause. Please try again.");
    }
  });

document
  .getElementById("resume-operation-btn")
  .addEventListener("click", async () => {
    if (!currentOpLogId || !pausedAt) return;
    const now = new Date();
    const pausedInterval = now - pausedAt;
    totalPausedMillis += pausedInterval;
    try {
      await updateDoc(doc(db, "logs", currentOpLogId), {
        totalPausedMillis,
        pausedAt: null
      });
      pausedAt = null;
      document.getElementById("resume-operation-btn").classList.add("hidden");
      document.getElementById("pause-operation-btn").classList.remove("hidden");
    } catch (err) {
      console.error("Error resuming operation:", err);
      alert("Failed to resume. Please try again.");
    }
  });

document
  .getElementById("stop-operation-btn")
  .addEventListener("click", async () => {
    if (!currentOpLogId) return;
    try {
      if (pausedAt) {
        const now = new Date();
        totalPausedMillis += (now - pausedAt);
      }
      await updateDoc(doc(db, "logs", currentOpLogId), {
        endTime: Timestamp.now(),
        totalPausedMillis,
        pausedAt: null
      });
      if (opTimerInterval) {
        clearInterval(opTimerInterval);
        opTimerInterval = null;
      }
      document.getElementById("current-operation-section").classList.add("hidden");
      currentOpLogId = null;
      opStartTime = null;
      pausedAt = null;
      totalPausedMillis = 0;
      await loadActiveJobs();
      await loadLiveActivity();
    } catch (err) {
      console.error("Error stopping operation:", err);
      alert("Failed to stop operation. Please try again.");
    }
  });

/* ——————————————————————————————————————————————————————————————————————
   5B) LIVE ACTIVITY PANEL (Worker)
—————————————————————————————————————————————————————————————————————— */
async function loadLiveActivity() {
  try {
    const liveSection = document.getElementById("live-activity-section");
    const ul = document.getElementById("live-activity-list");
    ul.innerHTML = "";

    const logsCol = collection(db, "logs");
    const q = query(logsCol, where("endTime", "==", null));
    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      liveSection.classList.add("hidden");
      return;
    }

    const items = [];
    for (const docSnap of snapshot.docs) {
      const data = docSnap.data();
      const userId = data.user;
      const jobId = data.jobId;
      const jobSnap = await getDoc(doc(db, "jobs", jobId));
      let jobDesc = jobId;
      if (jobSnap.exists()) {
        const jd = jobSnap.data();
        jobDesc = `${jd.jobNumber} (PO: ${jd.poNumber}, Part: ${jd.partNumber})`;
      }
      items.push({ userId, jobDesc });
    }

    items.forEach(item => {
      const li = document.createElement("li");
      li.style.padding = "0.3rem 0";
      li.innerHTML = `<strong>${item.userId}</strong> → Job: ${item.jobDesc}`;
      ul.appendChild(li);
    });
    liveSection.classList.remove("hidden");
  } catch (err) {
    console.error("Error loading live activity:", err);
    document.getElementById("live-activity-section").classList.add("hidden");
  }
}

/* ——————————————————————————————————————————————————————————————————————
   5C) LOAD ACTIVE JOBS (Worker)
   —————————————————————————————————————————————————————————————————————— */
async function loadActiveJobs() {
  try {
    const jobsCol = collection(db, "jobs");
    const q = query(jobsCol, where("active", "==", true));
    const snapshot = await getDocs(q);

    const tbody = document.getElementById("worker-jobs-tbody");
    tbody.innerHTML = "";

    if (snapshot.empty) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td colspan="8" style="text-align:center; color:#555;">
          No active jobs available
        </td>`;
      tbody.appendChild(tr);
      return;
    }

    const docsArray = snapshot.docs.slice();
    docsArray.sort((aDoc, bDoc) => {
      const ad = aDoc.data().receivedDate
        ? new Date(aDoc.data().receivedDate)
        : new Date(0);
      const bd = bDoc.data().receivedDate
        ? new Date(bDoc.data().receivedDate)
        : new Date(0);
      return ad - bd;
    });

    docsArray.forEach(docSnap => {
      const data = docSnap.data();
      const jobId = docSnap.id;
      const receivedFormatted = data.receivedDate
        ? formatYMDtoMDY(data.receivedDate)
        : "—";
      const dueFormatted = data.dueDate
        ? formatYMDtoMDY(data.dueDate)
        : "—";
      const hotText = data.hotOrder ? "🔥" : "❌";
      const activeText = data.active ? "✅" : "❌";

      const visibleJobNumber = data.jobNumber || jobId;

      const tr = document.createElement("tr");
      tr.dataset.jobId = jobId;
      tr.innerHTML = `
        <td>${visibleJobNumber}</td>
        <td>${data.poNumber || "—"}</td>
        <td>${data.partNumber || "—"}</td>
        <td>${data.quantity != null ? data.quantity : "—"}</td>
        <td>${receivedFormatted}</td>
        <td>${dueFormatted}</td>
        <td>${hotText}</td>
        <td>${activeText}</td>
      `;

      if (!currentOpLogId) {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", () => {
          openOperationPanel(jobId, visibleJobNumber);
        });
      } else {
        tr.title = "Finish current operation before starting a new one";
      }

      tbody.appendChild(tr);
    });
  } catch (error) {
    console.error("Error loading active jobs:", error);
    const tbody = document.getElementById("worker-jobs-tbody");
    tbody.innerHTML = "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td colspan="8" style="text-align:center; color:red;">
        Failed to load active jobs
      </td>`;
    tbody.appendChild(tr);
  }
}

/**
 * Enhanced Start Operation panel opener.
 */
async function openOperationPanel(jobId, visibleJobNumber) {
  try {
    // Fetch full job details
    const jobRef = doc(db, "jobs", jobId);
    const jobSnap = await getDoc(jobRef);

    let details = visibleJobNumber;
    if (jobSnap.exists()) {
      const { poNumber, partNumber, quantity } = jobSnap.data();
      details = `${visibleJobNumber} (PO: ${poNumber || "—"}, Part: ${partNumber || "—"}, Qty: ${quantity != null ? quantity : "—"})`;
    }

    document.getElementById("op-job-id").textContent = details;
  } catch (err) {
    console.error("Error fetching job details:", err);
    // Fallback to just job number
    document.getElementById("op-job-id").textContent = visibleJobNumber;
  }

  const section = document.getElementById("operation-section");
  section.classList.remove("hidden");
  section.scrollIntoView({ behavior: "smooth" });
}

document
  .getElementById("cancel-operation-btn")
  .addEventListener("click", () => {
    document.getElementById("operation-section").classList.add("hidden");
  });

document
  .getElementById("start-operation-btn")
  .addEventListener("click", async () => {
    const visibleJobNumber = document.getElementById("op-job-id").textContent;
    let pickedJobId = null;
    document.querySelectorAll("#worker-jobs-tbody tr").forEach(row => {
      const textJobNum = row.cells[0]?.textContent.trim();
      if (textJobNum === visibleJobNumber) {
        pickedJobId = row.dataset.jobId;
      }
    });
    if (!pickedJobId) {
      alert("Could not determine job ID. Please refresh and try again.");
      return;
    }

    const opDocId = document.getElementById("operation-select").value;
    if (!opDocId) {
      alert("Please select an operation.");
      return;
    }

    try {
      const docRef = await addDoc(collection(db, "logs"), {
        jobId: pickedJobId,
        user: currentUser.id,
        operation: opDocId,
        startTime: Timestamp.now(),
        endTime: null,
        pausedAt: null,
        totalPausedMillis: 0
      });
      currentOpLogId = docRef.id;
      opStartTime = new Date();
      pausedAt = null;
      totalPausedMillis = 0;
      document.getElementById("operation-section").classList.add("hidden");
      await loadCurrentOperation();
      await loadActiveJobs();
      await loadLiveActivity();
    } catch (err) {
      console.error("Error logging operation:", err);
      alert("Failed to start operation. Please try again.");
    }
  });

/* =====================================================
   6) ADMIN NAV + TAB SWITCHING
   ===================================================== */
function showAdminNav() {
  ["login-section","worker-section"].forEach(id =>
    document.getElementById(id).classList.add("hidden")
  );
  document.getElementById("main-nav").classList.remove("hidden");
  document.getElementById("admin-name").textContent = currentUser.id;

  document
    .getElementById("tab-dashboard")
    .addEventListener("click", showDashboardTab);
  document
    .getElementById("tab-operations")
    .addEventListener("click", showOperationsTab);
  document
    .getElementById("tab-employees")
    .addEventListener("click", showEmployeesTab);
  document.getElementById("tab-jobs").addEventListener("click", showJobsTab);
  document.getElementById("tab-logs").addEventListener("click", showLogsTab);

  document
    .getElementById("view-worker-dashboard-btn")
    .addEventListener("click", () => {
      isAdminImpersonating = true;
      showWorkerDashboard();
    });

  showDashboardTab();
}

function hideAllAdminSections() {
  ["section-dashboard","section-operations",
   "section-employees","section-jobs","section-logs"]
    .forEach(id => document.getElementById(id).classList.add("hidden"));
}
function showDashboardTab() {
  hideAllAdminSections();
  document.getElementById("section-dashboard").classList.remove("hidden");
  loadAdminMetrics();
}
function showOperationsTab() {
  hideAllAdminSections();
  document.getElementById("section-operations").classList.remove("hidden");
  loadOperationsList();
}
function showEmployeesTab() {
  hideAllAdminSections();
  document.getElementById("section-employees").classList.remove("hidden");
  loadEmployeesList();
}
function showJobsTab() {
  hideAllAdminSections();
  document.getElementById("section-jobs").classList.remove("hidden");
  loadJobsList();
}
function showLogsTab() {
  hideAllAdminSections();
  document.getElementById("section-logs").classList.remove("hidden");
  loadLogs();
}

/* =====================================================
   7) OPERATIONS MANAGEMENT (Add / Delete)
   ===================================================== */
async function loadOperationsList() {
  try {
    const opsCol = collection(db, "operations");
    const snapshot = await getDocs(opsCol);

    const tbody = document.getElementById("operations-table-body");
    tbody.innerHTML = "";
    operationsCache = [];

    snapshot.forEach(docSnap => {
      const opId = docSnap.id;
      const opData = docSnap.data();
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${opData.name}</td>
        <td>
          <button class="action-btn delete" onclick="deleteOperation('${opId}')">Delete</button>
        </td>`;
      tbody.appendChild(tr);
      operationsCache.push({ id: opId, name: opData.name });
    });

    if (snapshot.empty) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="2">No operations found</td>`;
      tbody.appendChild(tr);
    }
  } catch (error) {
    console.error("Error loading operations:", error);
    const tbody = document.getElementById("operations-table-body");
    tbody.innerHTML = `<tr><td colspan="2" style="color:red;">Failed to load operations</td></tr>`;
  }
}

async function createOperation() {
  const nameInput = document.getElementById("new-op-name").value.trim();
  if (!nameInput) {
    alert("Operation name cannot be empty");
    return;
  }
  const duplicate = operationsCache.find(
    o => o.name.toLowerCase() === nameInput.toLowerCase()
  );
  if (duplicate) {
    alert(`${nameInput} already exists`);
    return;
  }

  try {
    await addDoc(collection(db, "operations"), { name: nameInput });
    document.getElementById("new-op-name").value = "";
    await loadOperationsList();
    alert(`Operation "${nameInput}" added`);
  } catch (error) {
    console.error("Error creating operation:", error);
    alert("Failed to create operation");
  }
}
document.getElementById("create-op-btn").addEventListener("click", createOperation);

window.deleteOperation = async function (opId) {
  if (!confirm("Delete this operation?")) return;
  try {
    await deleteDoc(doc(db, "operations", opId));
    await loadOperationsList();
  } catch (error) {
    console.error("Error deleting operation:", error);
    alert("Failed to delete operation");
  }
};

/* =====================================================
   8) EMPLOYEE MANAGEMENT
   ===================================================== */
async function createEmployee() {
  const username = document.getElementById("new-emp-username").value.trim();
  const pin = document.getElementById("new-emp-pin").value.trim();
  const role = document.getElementById("new-emp-role").value;

  if (!username || !pin) {
    alert("Please enter both username and PIN");
    return;
  }
  if (pin.length !== 4 || !/^[0-9]+$/.test(pin)) {
    alert("PIN must be exactly 4 digits");
    return;
  }

  try {
    await setDoc(doc(db, "users", username), { pin, role });
    document.getElementById("new-emp-username").value = "";
    document.getElementById("new-emp-pin").value = "";
    document.getElementById("new-emp-role").value = "worker";
    loadEmployeesList();
    alert("Employee created successfully");
  } catch (error) {
    console.error("Error creating employee:", error);
    alert("Error creating employee");
  }
}
document.getElementById("create-emp-btn").addEventListener("click", createEmployee);

async function loadEmployeesList() {
  try {
    const usersCol = collection(db, "users");
    const snapshot = await getDocs(usersCol);
    const tbody = document.getElementById("employees-table-body");
    tbody.innerHTML = "";

    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${docSnap.id}</td>
        <td>${data.role}</td>
        <td>
          <button class="action-btn edit" onclick="editEmployee('${docSnap.id}', '${data.role}')">Edit</button>
          <button class="action-btn delete" onclick="deleteEmployee('${docSnap.id}')">Delete</button>
        </td>`;
      tbody.appendChild(tr);
    });

    if (snapshot.empty) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="3">No employees found</td>`;
      tbody.appendChild(tr);
    }
  } catch (error) {
    console.error("Error loading employees:", error);
  }
}

window.deleteEmployee = async function (username) {
  if (username === currentUser.id) {
    alert("Cannot delete your own account");
    return;
  }
  if (!confirm(`Delete employee '${username}'?`)) return;
  try {
    await deleteDoc(doc(db, "users", username));
    loadEmployeesList();
  } catch (error) {
    console.error("Error deleting employee:", error);
    alert("Error deleting employee");
  }
};

window.editEmployee = async function (username, currentRole) {
  const newRole = prompt(
    `Enter new role for '${username}' (worker/admin):`,
    currentRole
  );
  if (!newRole || (newRole !== "worker" && newRole !== "admin")) {
    alert("Invalid role");
    return;
  }
  try {
    await updateDoc(doc(db, "users", username), { role: newRole });
    loadEmployeesList();
  } catch (error) {
    console.error("Error updating employee:", error);
    alert("Error updating employee");
  }
};

/* =====================================================
   9) JOB MANAGEMENT – Active vs Completed + QR
   ===================================================== */
document.getElementById("search-jobs-btn").addEventListener("click", async () => {
  const poValue   = document.getElementById("search-po-input").value.trim().toLowerCase();
  // FIXED: Removed the undefined search-job-input element
  const partValue = document.getElementById("search-part-input").value.trim().toLowerCase();
  const dateFrom  = document.getElementById("search-date-from").value;
  const dateTo    = document.getElementById("search-date-to").value;

  try {
    const jobsCol = collection(db, "jobs");
    const snapshot = await getDocs(jobsCol);

    const activeJobs = [];
    const completedJobs = [];
    snapshot.docs.forEach(docSnap => {
      const data = docSnap.data();
      if (data.active) {
        activeJobs.push({ id: docSnap.id, data });
      } else {
        completedJobs.push({ id: docSnap.id, data });
      }
    });

    renderActiveJobsSimple(activeJobs, { poValue, partValue, dateFrom, dateTo });
    renderCompletedJobsGrouped(completedJobs, { poValue, partValue, dateFrom, dateTo });
  } catch (err) {
    console.error("Search jobs error:", err);
  }
});

document.getElementById("clear-jobs-btn")
  .addEventListener("click", () => {
    document.getElementById("search-po-input").value = "";
    document.getElementById("search-part-input").value = "";
    document.getElementById("search-date-from").value = "";
    document.getElementById("search-date-to").value = "";
    loadJobsList();
  });

async function createJob() {
  try {
    const po     = document.getElementById("new-job-po").value.trim();
    const jobNum = document.getElementById("new-job-num").value.trim();
    const part   = document.getElementById("new-job-part").value.trim();
    const qtyRaw = document.getElementById("new-job-qty").value;
    const rec    = document.getElementById("new-job-rec").value;
    const due    = document.getElementById("new-job-due").value;
    const hot    = document.getElementById("new-job-hot").checked;
    const activeFlag = document.getElementById("new-job-active").checked;

    if (!po || !jobNum || !part || qtyRaw === "" || !due || !rec) {
      alert("Please fill all required fields: PO, Job #, Part #, Qty, Received, Due.");
      return;
    }
    const qty = parseInt(qtyRaw, 10);
    if (isNaN(qty)) {
      alert("Quantity must be a valid number.");
      return;
    }

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
      createdAt:    Timestamp.now()
    };

    await addDoc(collection(db, "jobs"), newJobData);

    ["new-job-po","new-job-num","new-job-part","new-job-qty","new-job-rec","new-job-due"]
      .forEach(id => document.getElementById(id).value = "");
    document.getElementById("new-job-hot").checked = false;
    document.getElementById("new-job-active").checked = true;

    loadJobsList();
    alert("Job created successfully");
  } catch (error) {
    console.error("CREATE JOB ERROR:", error);
    alert(`Error creating job:\n${error.message}`);
  }
}
document.getElementById("create-job-btn").addEventListener("click", createJob);

async function loadJobsList() {
  try {
    const jobsCol = collection(db, "jobs");
    const snapshot = await getDocs(jobsCol);

    const activeJobs = [];
    const completedJobs = [];
    snapshot.docs.forEach(docSnap => {
      const data = docSnap.data();
      if (data.active) {
        activeJobs.push({ id: docSnap.id, data });
      } else {
        completedJobs.push({ id: docSnap.id, data });
      }
    });

    renderActiveJobsSimple(activeJobs, { poValue: "", partValue: "", dateFrom: "", dateTo: "" });
    renderCompletedJobsGrouped(completedJobs, { poValue: "", partValue: "", dateFrom: "", dateTo: "" });
  } catch (error) {
    console.error("Error loading jobs:", error);
  }
}

/**
 * Render Active Jobs in one simple table (no year/month grouping).
 * Filters by PO/Part/ReceivedDate (inclusive).
 */
function renderActiveJobsSimple(activeJobsArray, { poValue, partValue, dateFrom, dateTo }) {
  const container = document.getElementById("active-jobs-container");
  container.innerHTML = "";

  const filtered = activeJobsArray.filter(({ id, data }) => {
    const poMatch   = !poValue   || (data.poNumber   || "").toLowerCase().includes(poValue);
    const partMatch = !partValue || (data.partNumber || "").toLowerCase().includes(partValue);

    const rec = data.receivedDate || "";
    let dateMatch = true;
    if (dateFrom && (!rec || rec < dateFrom)) dateMatch = false;
    if (dateTo   && (!rec || rec > dateTo))   dateMatch = false;

    return poMatch && partMatch && dateMatch;
  });

  if (filtered.length === 0) {
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
      <tr style="background:#eef7f1;">
        <th>Job ID</th>
        <th>PO</th>
        <th>Part #</th>
        <th>Qty</th>
        <th>Received</th>
        <th>Due</th>
        <th>Hot</th>
        <th>QR</th>
        <th>Actions</th>
      </tr>
    </thead>`;
  const tbody = document.createElement("tbody");

  filtered.sort((a, b) => {
    const aRec = a.data.receivedDate || "";
    const bRec = b.data.receivedDate || "";
    if (aRec > bRec) return -1;
    if (aRec < bRec) return 1;
    return a.id.localeCompare(b.id);
  });

  filtered.forEach(({ id: jobId, data }) => {
    const receivedFormatted = data.receivedDate
      ? formatYMDtoMDY(data.receivedDate)
      : "";
    const dueFormatted = data.dueDate
      ? formatYMDtoMDY(data.dueDate)
      : "";
    const hotText = data.hotOrder ? "🔥" : "❌";

    const visibleJobNum = data.jobNumber || jobId;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${visibleJobNum}</td>
      <td>${data.poNumber}</td>
      <td>${data.partNumber}</td>
      <td>${data.quantity}</td>
      <td>${receivedFormatted}</td>
      <td>${dueFormatted}</td>
      <td>${hotText}</td>
      <td class="qr-cell">
        <canvas id="qr-${jobId}"></canvas><br/>
        <button onclick="printQRCode('${jobId}')" class="btn btn-secondary btn-sm">
          Print QR
        </button>
      </td>
      <td>
        <button class="action-btn delete" onclick="deleteJob('${jobId}')">Delete</button>
        <button class="btn btn-warning btn-sm ml-1" onclick="editJob('${jobId}')">Edit</button>
        <button class="btn btn-success btn-sm ml-1" onclick="markJobCompleted('${jobId}')">Complete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);

  filtered.forEach(({ id: jobId }) => {
    const qrCanvas = document.getElementById(`qr-${jobId}`);
    if (!qrCanvas) return;
    const jobUrl = `${window.location.origin}${window.location.pathname}?jobId=${encodeURIComponent(jobId)}`;
    new QRious({
      element: qrCanvas,
      value: jobUrl,
      size: 100
    });
    qrCanvas.style.cursor = "pointer";
    qrCanvas.addEventListener("click", () => {
      window.location.href = jobUrl;
    });
  });
}

/**
 * Render Completed Jobs grouped by year → month.
 */
function renderCompletedJobsGrouped(completedJobsArray, { poValue, partValue, dateFrom, dateTo }) {
  const filtered = completedJobsArray.filter(({ id, data }) => {
    const poMatch   = !poValue   || (data.poNumber   || "").toLowerCase().includes(poValue);
    const partMatch = !partValue || (data.partNumber || "").toLowerCase().includes(partValue);
    const rec = data.receivedDate || "";
    let dateMatch = true;
    if (dateFrom && (!rec || rec < dateFrom)) dateMatch = false;
    if (dateTo   && (!rec || rec > dateTo))   dateMatch = false;
    return poMatch && partMatch && dateMatch;
  });

  const container = document.getElementById("completed-jobs-container");
  container.innerHTML = "";

  if (filtered.length === 0) {
    const p = document.createElement("p");
    p.textContent = "No completed jobs to display.";
    p.style.color = "#555";
    container.appendChild(p);
    return;
  }

  const grouped = {};
  filtered.forEach(({ id: jobId, data }) => {
    const rec = data.receivedDate || "";
    let year = "Unknown Year", monthName = "Unknown Month";
    if (/^\d{4}-\d{2}-\d{2}$/.test(rec)) {
      const [yy, mm] = rec.split("-");
      year = yy;
      monthName = [
        "January","February","March","April","May","June",
        "July","August","September","October","November","December"
      ][parseInt(mm,10)-1];
    }
    grouped[year] = grouped[year] || {};
    grouped[year][monthName] = grouped[year][monthName] || [];
    grouped[year][monthName].push({ id: jobId, data });
  });

  const sortedYears = Object.keys(grouped)
    .filter(y => y !== "Unknown Year")
    .map(Number).sort((a,b)=>b-a).map(String);
  if (grouped["Unknown Year"]) sortedYears.push("Unknown Year");

  sortedYears.forEach(yearKey => {
    const yearDetails = document.createElement("details");
    yearDetails.style.marginBottom = "1rem";
    const yearSummary = document.createElement("summary");
    yearSummary.innerHTML = `<strong>${yearKey}</strong>`;
    yearSummary.style.fontSize = "1.2rem";
    yearDetails.appendChild(yearSummary);

    const monthsObj = grouped[yearKey];
    const monthOrder = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December"
    ];
    Object.keys(monthsObj)
      .sort((a,b) =>
        a==="Unknown Month"?1:b==="Unknown Month"?-1:
        monthOrder.indexOf(a)-monthOrder.indexOf(b)
      )
      .forEach(monthName => {
        const monthDetails = document.createElement("details");
        monthDetails.style.margin = "0.75rem 0 0.75rem 1.5rem";
        const monthSummary = document.createElement("summary");
        monthSummary.textContent = `${monthName} ${yearKey}`;
        monthSummary.style.fontSize = "1.1rem";
        monthDetails.appendChild(monthSummary);

        const table = document.createElement("table");
        table.className = "table";
        table.innerHTML = `
          <thead>
            <tr style="background:#f7f7f7;">
              <th>Job ID</th><th>PO</th><th>Part #</th><th>Qty</th>
              <th>Received</th><th>Due</th><th>Hot</th><th>Actions</th>
            </tr>
          </thead>`;
        const tbody2 = document.createElement("tbody");

        monthsObj[monthName]
          .sort((a,b)=> {
            const aRec = a.data.receivedDate||"";
            const bRec = b.data.receivedDate||"";
            if (aRec>bRec) return -1;
            if (aRec<bRec) return 1;
            return a.id.localeCompare(b.id);
          })
          .forEach(({ id: jobId, data }) => {
            const receivedFormatted = data.receivedDate?formatYMDtoMDY(data.receivedDate):"";
            const dueFormatted = data.dueDate?formatYMDtoMDY(data.dueDate):"";
            const hotText = data.hotOrder?"🔥":"❌";
            const visibleJobNum = data.jobNumber||jobId;
            const tr = document.createElement("tr");
            tr.innerHTML = `
              <td>${visibleJobNum}</td>
              <td>${data.poNumber}</td>
              <td>${data.partNumber}</td>
              <td>${data.quantity}</td>
              <td>${receivedFormatted}</td>
              <td>${dueFormatted}</td>
              <td>${hotText}</td>
              <td>
                <button class="action-btn delete" onclick="deleteJob('${jobId}')">Delete</button>
                <button class="btn btn-warning btn-sm ml-1" onclick="editJob('${jobId}')">Edit</button>
                <button class="btn btn-success btn-sm ml-1" onclick="markJobCompleted('${jobId}')">Complete</button>
              </td>
            `;
            tbody2.appendChild(tr);
          });

        table.appendChild(tbody2);
        monthDetails.appendChild(table);
        yearDetails.appendChild(monthDetails);
      });

    container.appendChild(yearDetails);
  });
}

window.deleteJob = async function (jobId) {
  if (!confirm(`Delete job '${jobId}'?`)) return;
  try {
    await deleteDoc(doc(db, "jobs", jobId));
    loadJobsList();
  } catch (error) {
    console.error("Error deleting job:", error);
    alert("Error deleting job");
  }
};

window.editJob = async function (jobId) {
  try {
    const jobRef = doc(db, "jobs", jobId);
    const jobSnap = await getDoc(jobRef);
    if (!jobSnap.exists()) {
      alert("Job not found");
      return;
    }
    const data = jobSnap.data();

    const po = prompt("PO Number:", data.poNumber);
    const jobNum = prompt("Job Number:", data.jobNumber);
    const part = prompt("Part Number:", data.partNumber);
    const qtyRaw = prompt("Quantity:", data.quantity);
    const rec = prompt("Received Date (YYYY-MM-DD):", data.receivedDate);
    const due = prompt("Due Date (YYYY-MM-DD):", data.dueDate);
    const hot = confirm("Mark as Hot Order?");
    const activeFlag = confirm("Keep job Active?");

    if (!po || !jobNum || !part || !qtyRaw || !rec || !due) {
      alert("Invalid input. Operation canceled.");
      return;
    }
    const qty = parseInt(qtyRaw, 10);
    if (isNaN(qty)) {
      alert("Quantity must be a number.");
      return;
    }

    await updateDoc(jobRef, {
      poNumber:     po,
      jobNumber:    jobNum,
      partNumber:   part,
      quantity:     qty,
      receivedDate: rec,
      dueDate:      due,
      hotOrder:     hot,
      active:       activeFlag,
      title:        `${po} – ${jobNum}`
    });
    loadJobsList();
  } catch (error) {
    console.error("Error editing job:", error);
    alert("Error editing job");
  }
};

window.markJobCompleted = async function (jobId) {
  try {
    await updateDoc(doc(db, "jobs", jobId), { active: false });
    await addDoc(collection(db, "logs"), {
      jobId,
      user: currentUser.id,
      operation: "COMPLETED_JOB",
      startTime: Timestamp.now(),
      endTime: Timestamp.now(),
      pausedAt: null,
      totalPausedMillis: 0
    });
    loadJobsList();
  } catch (err) {
    console.error("Error marking job completed:", err);
    alert("Failed to mark job as completed");
  }
};

/* =====================================================
   10) PRINT QR CODE
   ===================================================== */
window.printQRCode = async function (jobId) {
  try {
    const jobSnap = await getDoc(doc(db, "jobs", jobId));
    if (!jobSnap.exists()) {
      alert("Job not found");
      return;
    }
    const data = jobSnap.data();
    const po = data.poNumber || "";
    const jobNum = data.jobNumber || "";
    const part = data.partNumber || "";
    const qty = data.quantity != null ? data.quantity : "";
    const rec = formatYMDtoMDY(data.receivedDate || "");
    const due = formatYMDtoMDY(data.dueDate || "");
    const title = data.title || jobId;

    const jobUrl = `${window.location.origin}${window.location.pathname}?jobId=${encodeURIComponent(jobId)}`;
    const qr = new QRious({ value: jobUrl, size: 300 });
    const dataUrl = qr.toDataURL();

    const printWindow = window.open(
      "",
      "_blank",
      "width=600,height=850,menubar=no,toolbar=no,location=no,status=no"
    );
    if (!printWindow) {
      alert("Popup blocked. Please allow popups to print the QR code.");
      return;
    }

    printWindow.document.write(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>Print Job QR</title>
        <style>
          html, body {
            margin: 0; padding: 0;
            width: 100%; height: 100%;
          }
          body {
            font-family: sans-serif;
            text-align: center;
            margin: 0;
          }
          .job-details {
            margin-top: 20px;
            font-size: 1.5rem;
            line-height: 1.4;
          }
          .job-details p {
            margin: 0.4rem 0;
          }
          .qr-img {
            width: 300px;
            height: 300px;
            margin-top: 40px;
          }
          @page {
            size: A4 portrait;
            margin: 0.5cm;
          }
        </style>
      </head>
      <body>
        <div class="job-details printable-area">
          <p><strong>${title}</strong></p>
          <p>PO: ${po}</p>
          <p>Job #: ${jobNum}</p>
          <p>Part: ${part}</p>
          <p>Qty: ${qty}</p>
          <p>Received: ${rec}</p>
          <p>Due: ${due}</p>
        </div>
        <div class="printable-area">
          <img class="qr-img" src="${dataUrl}" alt="QR Code" />
        </div>
        <script>
          window.onload = () => {
            setTimeout(() => {
              window.focus();
              window.print();
              window.close();
            }, 200);
          };
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("Error printing QR:", err);
    alert("Failed to print QR code.");
  }
};

/* =====================================================
   11) WORK LOGS
   ===================================================== */
document.getElementById("search-logs-btn").addEventListener("click", () => {
  loadLogs();
});
document.getElementById("clear-logs-btn").addEventListener("click", () => {
  document.getElementById("search-logs-po").value       = "";
  document.getElementById("search-logs-part").value     = "";
  document.getElementById("search-logs-date-from").value= "";
  document.getElementById("search-logs-date-to").value  = "";
  loadLogs();
});

let editingLogId = null;
let isGroupDeleteMode = false;
let selectedLogIds = new Set();

/**
 * Keep track of which logs are checked in group-delete mode.
 */
function handleLogCheckboxChange(event) {
  const logId = event.target.dataset.logId;
  if (event.target.checked) {
    selectedLogIds.add(logId);
  } else {
    selectedLogIds.delete(logId);
  }
}

// Expose it so inline onchange="handleLogCheckboxChange(event)" will find it
window.handleLogCheckboxChange = handleLogCheckboxChange;

async function loadLogs() {
  try {
    const jobsCol = collection(db, "jobs");
    const jobsSnap = await getDocs(jobsCol);
    const jobsMap = {};
    jobsSnap.docs.forEach(js => {
      const jd = js.data();
      jobsMap[js.id] = {
        po:     jd.poNumber    || "",
        part:   jd.partNumber  || "",
        title:  jd.title       || js.id,
        active: jd.active      || false
      };
    });

    const opsCol = collection(db, "operations");
    const opsSnap = await getDocs(opsCol);
    const operationsMap = {};
    opsSnap.docs.forEach(os => {
      operationsMap[os.id] = os.data().name;
    });
    operationsMap["COMPLETED_JOB"] = "Job Completed";

    const poFilter   = document.getElementById("search-logs-po").value.trim().toLowerCase();
    const partFilter = document.getElementById("search-logs-part").value.trim().toLowerCase();
    const dateFrom   = document.getElementById("search-logs-date-from").value;
    const dateTo     = document.getElementById("search-logs-date-to").value;

    const logsCol = collection(db, "logs");
    const logsSnap = await getDocs(logsCol);

    const activeJobLogs    = [];
    const completedJobLogs = [];

    logsSnap.docs.forEach(docSnap => {
      const entry = { ...docSnap.data(), id: docSnap.id };
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

      if (jobsMap[jobId].active) {
        activeJobLogs.push(entry);
      } else {
        completedJobLogs.push(entry);
      }
    });

    renderActiveWorkLogs(activeJobLogs, operationsMap, jobsMap);
    renderCompletedWorkLogs(completedJobLogs, operationsMap, jobsMap);
  } catch (error) {
    console.error("Error loading logs:", error);
    const container = document.getElementById("logs-container");
    container.innerHTML = `<p style="color:red;">Failed to load work logs.</p>`;
  }
}

function renderActiveWorkLogs(entriesArray, operationsMap, jobsMap) {
  let activeDiv = document.getElementById("active-logs-container");
  if (!activeDiv) {
    const heading = document.createElement("h4");
    heading.className = "subheading";
    heading.textContent = "Active Work Logs";
    document.getElementById("logs-container").appendChild(heading);
    activeDiv = document.createElement("div");
    activeDiv.id = "active-logs-container";
    activeDiv.style.marginBottom = "2rem";
    document.getElementById("logs-container").appendChild(activeDiv);
  }
  activeDiv.innerHTML = "";

  if (entriesArray.length === 0) {
    const p = document.createElement("p");
    p.textContent = "No active work logs.";
    p.style.color = "#555";
    activeDiv.appendChild(p);
    return;
  }

  const byJob = {};
  entriesArray.forEach(entry => {
    byJob[entry.jobId] = byJob[entry.jobId] || [];
    byJob[entry.jobId].push(entry);
  });

  Object.keys(byJob)
    .sort((a,b) => (jobsMap[a].title || a).localeCompare(jobsMap[b].title || b))
    .forEach(jobId => {
      const jobEntries = byJob[jobId];
      const jobTitle = jobsMap[jobId].title;
      const h5 = document.createElement("h5");
      h5.textContent = `Job: ${jobTitle}`;
      h5.style.margin = "1rem 0 0.5rem 0";
      activeDiv.appendChild(h5);

      jobEntries.sort((a,b) => a.startTime.toDate() - b.startTime.toDate());

      const table = document.createElement("table");
      table.className = "table";
      table.style.fontSize = "0.9rem";
      
      const tableHeaders = `
        <thead>
          <tr style="background:#eef7f1;">
            ${isGroupDeleteMode ? '<th>Select</th>' : ''}
            <th>User</th><th>Operation</th><th>Duration</th>
            <th>Paused</th><th>Start Time</th><th>End Time</th>
            <th>Edit</th><th>Delete</th>
          </tr>
        </thead>`;
      table.innerHTML = tableHeaders;
      const tbody = document.createElement("tbody");

      jobEntries.forEach(entry => {
        const pausedMillis = entry.totalPausedMillis || 0;
        const pmH = String(Math.floor(pausedMillis/3600000)).padStart(2,"0");
        const pmM = String(Math.floor((pausedMillis%3600000)/60000)).padStart(2,"0");
        const pmS = String(Math.floor((pausedMillis%60000)/1000)).padStart(2,"0");
        const pausedText = `${pmH}:${pmM}:${pmS}`;

        let durationText = "In progress";
        if (entry.startTime && entry.endTime) {
          const durMs = entry.endTime.toDate() - entry.startTime.toDate() - pausedMillis;
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
          const isChecked = selectedLogIds.has(entry.id) ? "checked" : "";
          checkboxCell = `<td><input type="checkbox" class="log-checkbox" data-log-id="${entry.id}" ${isChecked} onchange="handleLogCheckboxChange(event)"></td>`;
        }

        const tr = document.createElement("tr");
        tr.innerHTML = `
          ${checkboxCell}
          <td>${entry.user}</td>
          <td>${opName}</td>
          <td>${durationText}</td>
          <td>${pausedText}</td>
          <td>${startStr}</td>
          <td>${endStr}</td>
          <td><button class="btn btn-warning btn-sm" onclick="editLogEntry('${entry.id}')">Edit</button></td>
          <td><button class="btn btn-danger btn-sm" onclick="deleteLogEntry('${entry.id}')">Delete</button></td>
        `;
        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      activeDiv.appendChild(table);
    });
}

function renderCompletedWorkLogs(entriesArray, operationsMap, jobsMap) {
  let completedDiv = document.getElementById("completed-logs-container");
  if (!completedDiv) {
    const heading = document.createElement("h4");
    heading.className = "subheading";
    heading.textContent = "Completed Work Logs";
    document.getElementById("logs-container").appendChild(heading);
    completedDiv = document.createElement("div");
    completedDiv.id = "completed-logs-container";
    completedDiv.style.marginBottom = "2rem";
    document.getElementById("logs-container").appendChild(completedDiv);
  }
  completedDiv.innerHTML = "";

  if (entriesArray.length === 0) {
    const p = document.createElement("p");
    p.textContent = "No completed work logs.";
    p.style.color = "#555";
    completedDiv.appendChild(p);
    return;
  }

  const grouped = {};
  entriesArray.forEach(entry => {
    const d = entry.startTime.toDate();
    const year = d.getFullYear();
    const monthName = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December"
    ][d.getMonth()];
    grouped[year] = grouped[year] || {};
    grouped[year][monthName] = grouped[year][monthName] || {};
    grouped[year][monthName][entry.jobId] = grouped[year][monthName][entry.jobId] || [];
    grouped[year][monthName][entry.jobId].push(entry);
  });

  Object.keys(grouped)
    .map(Number).sort((a,b)=>b-a)
    .forEach(year => {
      const yearDetails = document.createElement("details");
      yearDetails.style.marginBottom = "1rem";
      const yearSummary = document.createElement("summary");
      yearSummary.innerHTML = `<strong>${year}</strong>`;
      yearSummary.style.fontSize = "1.25rem";
      yearDetails.appendChild(yearSummary);

      const monthsObj = grouped[year];
      Object.keys(monthsObj)
        .sort((a,b)=>["January","February","March","April","May","June",
                      "July","August","September","October","November","December"]
                     .indexOf(a)
                   - ["January","February","March","April","May","June",
                      "July","August","September","October","November","December"]
                     .indexOf(b))
        .forEach(monthName => {
          const monthDetails = document.createElement("details");
          monthDetails.style.margin = "0.75rem 0 0.75rem 1rem";
          const monthSummary = document.createElement("summary");
          monthSummary.textContent = `${monthName} ${year}`;
          monthSummary.style.fontSize = "1.1rem";
          monthDetails.appendChild(monthSummary);

          const jobsObj = monthsObj[monthName];
          Object.keys(jobsObj).sort().forEach(jobId => {
            const entries = jobsObj[jobId];
            const jobTitle = jobsMap[jobId].title;
            let totalSeconds = 0;
            entries.forEach(entry => {
              if (entry.endTime) {
                totalSeconds += Math.floor((entry.endTime.toDate()
                  - entry.startTime.toDate()
                  - (entry.totalPausedMillis||0)) /1000);
              }
            });
            const th = String(Math.floor(totalSeconds/3600000)).padStart(2,"0");
            const tm = String(Math.floor((totalSeconds%3600000)/60000)).padStart(2,"0");
            const ts = String(totalSeconds%60).padStart(2,"0");
            const totalDisplay = `${th}:${tm}:${ts}`;

            const jobSection = document.createElement("div");
            jobSection.style.margin = "0 0 1.5rem 2rem";
            const jobHeader = document.createElement("h4");
            jobHeader.textContent = `Job: ${jobTitle}  (Total Time: ${totalDisplay})`;
            jobHeader.style.marginBottom = "0.5rem";
            jobSection.appendChild(jobHeader);

            const table = document.createElement("table");
            table.className = "table";
            
            const tableHeaders = `
              <thead>
                <tr style="background:#eef7f1;">
                  ${isGroupDeleteMode ? '<th>Select</th>' : ''}
                  <th>User</th><th>Operation</th><th>Duration</th>
                  <th>Paused</th><th>Start Time</th><th>End Time</th>
                  <th>Edit</th><th>Delete</th>
                </tr>
              </thead>`;
            table.innerHTML = tableHeaders;
            const tb = document.createElement("tbody");

            entries.sort((a,b)=>a.startTime.toDate()-b.startTime.toDate())
              .forEach(entry => {
                const paused = entry.totalPausedMillis||0;
                const pmH = String(Math.floor(paused/3600000)).padStart(2,"0");
                const pmM = String(Math.floor((paused%3600000)/60000)).padStart(2,"0");
                const pmS = String(Math.floor((paused%60000)/1000)).padStart(2,"0");
                const pausedText = `${pmH}:${pmM}:${pmS}`;

                let durationText = "In progress";
                if (entry.endTime) {
                  const dur = entry.endTime.toDate()
                    - entry.startTime.toDate() - paused;
                  const h = String(Math.floor(dur/3600000)).padStart(2,"0");
                  const m = String(Math.floor((dur%3600000)/60000)).padStart(2,"0");
                  const s = String(Math.floor((dur%60000)/1000)).padStart(2,"0");
                  durationText = `${h}:${m}:${s}`;
                }
                const startStr = formatTimestamp(entry.startTime);
                const endStr   = entry.endTime?formatTimestamp(entry.endTime):"In progress";
                const opName   = operationsMap[entry.operation]||entry.operation;

                let checkboxCell = "";
                if (isGroupDeleteMode) {
                  const isChecked = selectedLogIds.has(entry.id) ? "checked" : "";
                  checkboxCell = `<td><input type="checkbox" class="log-checkbox" data-log-id="${entry.id}" ${isChecked} onchange="handleLogCheckboxChange(event)"></td>`;
                }

                const logTr = document.createElement("tr");
                logTr.innerHTML = `
                  ${checkboxCell}
                  <td>${entry.user}</td>
                  <td>${opName}</td>
                  <td>${durationText}</td>
                  <td>${pausedText}</td>
                  <td>${startStr}</td>
                  <td>${endStr}</td>
                  <td><button class="btn btn-warning btn-sm" onclick="editLogEntry('${entry.id}')">Edit</button></td>
                  <td><button class="btn btn-danger btn-sm" onclick="deleteLogEntry('${entry.id}')">Delete</button></td>
                `;
                tb.appendChild(logTr);
              });

            table.appendChild(tb);
            jobSection.appendChild(table);
            monthDetails.appendChild(jobSection);
          });

          yearDetails.appendChild(monthDetails);
        });

      completedDiv.appendChild(yearDetails);
    });
}

// Delete a single log entry
window.deleteLogEntry = async function(logId) {
  if (!confirm("Delete this log entry?")) return;
  try {
    await deleteDoc(doc(db, "logs", logId));
    await loadLogs();
  } catch (err) {
    console.error("Error deleting log:", err);
    alert("Failed to delete log entry.");
  }
};

// Edit a single log entry
window.editLogEntry = async function(logId) {
  try {
    const logRef = doc(db, "logs", logId);
    const logSnap = await getDoc(logRef);
    if (!logSnap.exists()) {
      alert("Log entry not found.");
      return;
    }
    const data = logSnap.data();

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

    document.getElementById("edit-start-input").value = toLocalDatetimeString(data.startTime);
    document.getElementById("edit-end-input").value   = data.endTime ? toLocalDatetimeString(data.endTime) : "";
    editingLogId = logId;
    document.getElementById("edit-log-modal").classList.remove("hidden");
  } catch (err) {
    console.error("Error fetching log for edit:", err);
    alert("Could not load log entry for editing.");
  }
};

document.getElementById("save-log-btn").addEventListener("click", async () => {
  if (!editingLogId) return;
  try {
    const logRef = doc(db, "logs", editingLogId);
    const newStartStr = document.getElementById("edit-start-input").value;
    const newEndStr   = document.getElementById("edit-end-input").value;

    function parseLocalDatetime(str) {
      if (!str) return null;
      const d = new Date(str);
      if (isNaN(d.getTime())) return null;
      return Timestamp.fromDate(d);
    }

    const newStartTs = parseLocalDatetime(newStartStr);
    const newEndTs   = parseLocalDatetime(newEndStr);
    if (!newStartTs) {
      alert("Please provide a valid start time (YYYY-MM-DDThh:mm:ss).");
      return;
    }

    await updateDoc(logRef, {
      startTime: newStartTs,
      endTime:   newEndTs
    });

    document.getElementById("edit-log-modal").classList.add("hidden");
    editingLogId = null;
    loadLogs();
  } catch (err) {
    console.error("Error saving log edit:", err);
    alert("Failed to update log entry.");
  }
});

document.getElementById("cancel-log-btn").addEventListener("click", () => {
  document.getElementById("edit-log-modal").classList.add("hidden");
  editingLogId = null;
});

/* =====================================================
   12) OPEN FROM ?jobId=… (if user scanned QR directly)
   ===================================================== */
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

/* =====================================================
   13) OPERATIONS FOR WORKER
   ===================================================== */
async function loadOperationsForWorker() {
  try {
    if (!operationsCache.length) {
      const opsCol = collection(db, "operations");
      const snapshot = await getDocs(opsCol);
      snapshot.forEach(docSnap => {
        operationsCache.push({ id: docSnap.id, name: docSnap.data().name });
      });
    }
    const select = document.getElementById("operation-select");
    select.innerHTML = "";
    if (!operationsCache.length) {
      select.innerHTML = `<option disabled>No operations defined</option>`;
      select.disabled = true;
      return;
    }
    select.disabled = false;
    operationsCache.forEach(op => {
      const opt = document.createElement("option");
      opt.value = op.id;
      opt.textContent = op.name;
      select.appendChild(opt);
    });
  } catch (error) {
    console.error("Error loading operations for worker:", error);
    const select = document.getElementById("operation-select");
    select.innerHTML = `<option disabled>Failed to load operations</option>`;
    select.disabled = true;
  }
}

/* =====================================================
   14) DASHBOARD METRICS & CHART
   ===================================================== */
async function loadAdminMetrics() {
  const logsSnap = await getDocs(collection(db, "logs"));
  const jobsSnap = await getDocs(collection(db, "jobs"));

  const jobMap = {};
  jobsSnap.docs.forEach(js => {
    const jd = js.data();
    jobMap[js.id] = { receivedDate: jd.receivedDate || null, completedTimestamp: null };
  });

  logsSnap.docs.forEach(ls => {
    const d = ls.data();
    if (d.operation === "COMPLETED_JOB" && d.endTime && jobMap[d.jobId]) {
      const t = d.endTime.toDate().getTime();
      if (!jobMap[d.jobId].completedTimestamp || t > jobMap[d.jobId].completedTimestamp) {
        jobMap[d.jobId].completedTimestamp = t;
      }
    }
  });

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayIndex = now.getDay();
  const mondayOffset = (dayIndex === 0 ? -6 : 1 - dayIndex);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  const startOfWeek = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate()).getTime();

  let hoursToday = 0, hoursWeek = 0;
  const dailyTotals = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek + i*86400000);
    dailyTotals[`${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`] = 0;
  }

  logsSnap.docs.forEach(ls => {
    const entry = ls.data();
    if (!entry.startTime || !entry.endTime) return;
    const s = entry.startTime.toDate().getTime();
    const e = entry.endTime.toDate().getTime();
    const paused = entry.totalPausedMillis || 0;
    const durMs = e - s - paused;
    if (durMs <= 0) return;
    const durHrs = durMs / 3600000;

    if (s >= startOfToday) hoursToday += durHrs;
    if (s >= startOfWeek) {
      hoursWeek += durHrs;
      const d = new Date(s);
      const key = `${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
      if (dailyTotals[key] !== undefined) dailyTotals[key] += durHrs;
    }
  });

  document.getElementById("metric-hours-today").textContent = hoursToday.toFixed(2);
  document.getElementById("metric-hours-week").textContent = hoursWeek.toFixed(2);

  let totalTurnaroundMs = 0, countCompletedJobs = 0;
  Object.keys(jobMap).forEach(jobId => {
    const recStr = jobMap[jobId].receivedDate;
    const compTs = jobMap[jobId].completedTimestamp;
    if (recStr && compTs) {
      const [yy,mm,dd] = recStr.split("-");
      const recDate = new Date(parseInt(yy), parseInt(mm)-1, parseInt(dd)).getTime();
      if (compTs >= recDate) {
        totalTurnaroundMs += compTs - recDate;
        countCompletedJobs++;
      }
    }
  });
  const avgDays = countCompletedJobs
    ? (totalTurnaroundMs/86400000/countCompletedJobs).toFixed(1)
    : 0;
  document.getElementById("metric-turnaround").textContent =
    countCompletedJobs
      ? `${avgDays} day${avgDays!=="1.0"?"s":""}`
      : "—";

  const userTotals = {};
  logsSnap.docs.forEach(ls => {
    const entry = ls.data();
    if (!entry.startTime || !entry.endTime) return;
    const s = entry.startTime.toDate().getTime();
    if (s < startOfWeek) return;
    const e = entry.endTime.toDate().getTime();
    const paused = entry.totalPausedMillis || 0;
    const durHrs = (e - s - paused) / 3600000;
    if (durHrs <= 0) return;
    userTotals[entry.user] = (userTotals[entry.user]||0) + durHrs;
  });
  const topOperators = Object.entries(userTotals)
    .sort((a,b)=>b[1]-a[1]).slice(0,3);

  const topList = document.getElementById("metric-top-operators");
  topList.innerHTML = "";
  if (topOperators.length) {
    topOperators.forEach(([user,hrs]) => {
      const li = document.createElement("li");
      li.textContent = `${user} – ${hrs.toFixed(2)} hrs`;
      topList.appendChild(li);
    });
  } else {
    const li = document.createElement("li");
    li.textContent = "—";
    topList.appendChild(li);
  }

  const ctx = document.getElementById("chart-hours-trend").getContext("2d");
  const labels = Object.keys(dailyTotals);
  const dataArr = labels.map(lbl => parseFloat(dailyTotals[lbl].toFixed(2)));
  if (window.hoursTrendChart) window.hoursTrendChart.destroy();
  window.hoursTrendChart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [{ label: "Hours Logged", data: dataArr, fill: true, tension: 0.3 }] },
    options: {
      scales: {
        y: { beginAtZero: true, title:{ display:true, text:"Hours" } },
        x: { title:{ display:true, text:"Date" } }
      },
      responsive: true,
      maintainAspectRatio: false
    }
  });
}

/* =====================================================
   15) ENTER KEY ON PIN → TRIGGER LOGIN
   ===================================================== */
document.getElementById("pin").addEventListener("keypress", e => {
  if (e.key === "Enter") document.getElementById("login-btn").click();
});

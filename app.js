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
let operationsCache = []; // Will hold { id, name }
let isPaused = false;
let pauseSegments = []; 
// pauseSegments will store objects of the form { pauseStart: Date, pauseEnd: Date|null }

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
  const day = String(d.getDate()).padStart(2, "0");
  const year = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${month}/${day}/${year} ${hh}:${mm}:${ss}`;
}

/* =====================================================
   2) LOGIN LOGIC
   ===================================================== */
document.getElementById("login-btn").addEventListener("click", async () => {
  const usernameInput = document.getElementById("username").value.trim();
  const pinInput = document.getElementById("pin").value.trim();

  // ===== Dummy Accounts for Quick Testing =====
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
  // ============================================

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

    currentUser = { id: userSnap.id, ...userData };
    localStorage.setItem("currentUser", currentUser.id);

    // Hide all possible sections, then show only the one we need:
    document.getElementById("login-section").classList.add("hidden");
    document.getElementById("worker-section").classList.add("hidden");
    document.getElementById("main-nav").classList.add("hidden");
    document.getElementById("section-operations").classList.add("hidden");
    document.getElementById("section-employees").classList.add("hidden");
    document.getElementById("section-jobs").classList.add("hidden");
    document.getElementById("section-logs").classList.add("hidden");

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
   3) AUTO-LOGIN (“Remember Me”)
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
  document.getElementById("main-nav").classList.add("hidden");
  document.getElementById("section-operations").classList.add("hidden");
  document.getElementById("section-employees").classList.add("hidden");
  document.getElementById("section-jobs").classList.add("hidden");
  document.getElementById("section-logs").classList.add("hidden");
  document.getElementById("login-section").classList.remove("hidden");
});

/* =====================================================
   5) WORKER DASHBOARD
   ===================================================== */
function showWorkerDashboard() {
  // Hide the others:
  document.getElementById("login-section").classList.add("hidden");
  document.getElementById("main-nav").classList.add("hidden");
  document.getElementById("section-operations").classList.add("hidden");
  document.getElementById("section-employees").classList.add("hidden");
  document.getElementById("section-jobs").classList.add("hidden");
  document.getElementById("section-logs").classList.add("hidden");

  // Show worker section and greet:
  document.getElementById("worker-section").classList.remove("hidden");
  document.getElementById("worker-name").textContent = currentUser.id;

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

  // Refresh “Live Activity” every 30 seconds
  setInterval(loadLiveActivity, 30000);

  // If the page was opened via a ?jobId=... link, auto‐open it
  await loadActiveJobs();
  openFromQueryParam();
}

/* ——————————————————————————————————————————————————————————————————————
   5A) CURRENT OPERATION PANEL (Worker) + Pause/Resume
—————————————————————————————————————————————————————————————————————— */
async function loadCurrentOperation() {
  // Clear any previous timer
  if (opTimerInterval) {
    clearInterval(opTimerInterval);
    opTimerInterval = null;
  }

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
      isPaused = false;
      pauseSegments = [];
      return;
    }

    // Find the most recent open log
    let chosenDoc = snapshot.docs[0];
    snapshot.docs.forEach((docSnap) => {
      const a = docSnap.data().startTime.toDate();
      const b = chosenDoc.data().startTime.toDate();
      if (a > b) chosenDoc = docSnap;
    });

    const data = chosenDoc.data();
    currentOpLogId = chosenDoc.id;
    opStartTime = data.startTime.toDate();
    pauseSegments = data.pauseSegments || [];
    isPaused = data.isPaused || false;

    // Show “Job info”
    const jobSnap = await getDoc(doc(db, "jobs", data.jobId));
    let jobInfo = data.jobId;
    if (jobSnap.exists()) {
      const jd = jobSnap.data();
      jobInfo = `${jd.jobNumber || data.jobId} (PO: ${jd.poNumber}, Part: ${jd.partNumber})`;
    }
    document.getElementById("current-op-jobinfo").textContent = jobInfo;

    // Show operation name
    const opId = data.operation;
    let opName = opId;
    const foundOp = operationsCache.find((o) => o.id === opId);
    if (foundOp) opName = foundOp.name;
    document.getElementById("current-op-name").textContent = opName;

    // Show start time as MM/DD/YYYY hh:mm:ss
    const startStr = formatTimestamp(Timestamp.fromDate(opStartTime));
    document.getElementById("current-op-start").textContent = startStr;

    // Show or hide Pause/Resume buttons
    updatePauseResumeUI();

    // Start updating elapsed timer
    updateElapsedTimer();
    opTimerInterval = setInterval(updateElapsedTimer, 1000);
    curSec.classList.remove("hidden");
  } catch (error) {
    console.error("Error loading current operation:", error);
    document.getElementById("current-operation-section").classList.add("hidden");
    currentOpLogId = null;
    opStartTime = null;
    isPaused = false;
    pauseSegments = [];
  }
}

function calculateTotalPaused() {
  // Sum up all (pauseEnd - pauseStart) intervals in milliseconds
  return pauseSegments.reduce((acc, seg) => {
    if (seg.pauseEnd) {
      return acc + (seg.pauseEnd.toDate().getTime() - seg.pauseStart.toDate().getTime());
    }
    return acc;
  }, 0);
}

function updateElapsedTimer() {
  if (!opStartTime) {
    document.getElementById("current-op-elapsed").textContent = "00:00:00";
    return;
  }
  const now = new Date();
  // If currently paused, we don’t advance the clock; show the last frozen elapsed time
  let diffMs = now.getTime() - opStartTime.getTime(); // total elapsed including pauses
  const totalPausedMs = calculateTotalPaused();
  let activeMs = diffMs - totalPausedMs;
  if (isPaused) {
    // If paused, effectively freeze 'activeMs' at the moment of pauseStart
    const lastPause = pauseSegments[pauseSegments.length - 1];
    if (lastPause && lastPause.pauseStart && !lastPause.pauseEnd) {
      activeMs = lastPause.pauseStart.toDate().getTime() - opStartTime.getTime() - (calculateTotalPaused() - 0);
    }
  }
  if (activeMs < 0) activeMs = 0;

  const totalSeconds = Math.floor(activeMs / 1000);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const hh = String(hrs).padStart(2, "0");
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  document.getElementById("current-op-elapsed").textContent = `${hh}:${mm}:${ss}`;

  // If paused, display “Paused” text somewhere (optional styling)
  if (isPaused) {
    document.getElementById("current-op-elapsed").classList.add("paused-text");
  } else {
    document.getElementById("current-op-elapsed").classList.remove("paused-text");
  }
}

function updatePauseResumeUI() {
  const pauseBtn = document.getElementById("pause-operation-btn");
  const resumeBtn = document.getElementById("resume-operation-btn");
  if (isPaused) {
    pauseBtn.classList.add("hidden");
    resumeBtn.classList.remove("hidden");
  } else {
    pauseBtn.classList.remove("hidden");
    resumeBtn.classList.add("hidden");
  }
}

document.getElementById("pause-operation-btn").addEventListener("click", async () => {
  if (!currentOpLogId || isPaused) return;
  try {
    const nowTs = Timestamp.now();
    // Add a new pause segment with pauseStart = now, pauseEnd = null
    pauseSegments.push({ pauseStart: nowTs, pauseEnd: null });

    // Update Firestore: set isPaused = true and update pauseSegments array
    await updateDoc(doc(db, "logs", currentOpLogId), {
      isPaused: true,
      pauseSegments: pauseSegments
    });
    isPaused = true;
    updatePauseResumeUI();
  } catch (err) {
    console.error("Error pausing operation:", err);
    alert("Failed to pause. Please try again.");
  }
});

document.getElementById("resume-operation-btn").addEventListener("click", async () => {
  if (!currentOpLogId || !isPaused) return;
  try {
    const nowTs = Timestamp.now();
    // Set pauseEnd for the last pause segment
    const lastIndex = pauseSegments.length - 1;
    pauseSegments[lastIndex].pauseEnd = nowTs;

    // Update Firestore: set isPaused = false and updated pauseSegments
    await updateDoc(doc(db, "logs", currentOpLogId), {
      isPaused: false,
      pauseSegments: pauseSegments
    });
    isPaused = false;
    updatePauseResumeUI();
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
      // If currently paused, close out that last segment
      if (isPaused) {
        const nowTs = Timestamp.now();
        const lastIndex = pauseSegments.length - 1;
        pauseSegments[lastIndex].pauseEnd = nowTs;
      }

      // Update Firestore: set endTime and ensure pauseSegments are current
      await updateDoc(doc(db, "logs", currentOpLogId), {
        endTime: Timestamp.now(),
        isPaused: false,
        pauseSegments: pauseSegments
      });

      if (opTimerInterval) {
        clearInterval(opTimerInterval);
        opTimerInterval = null;
      }
      isPaused = false;
      pauseSegments = [];
      document.getElementById("current-operation-section").classList.add("hidden");
      currentOpLogId = null;
      opStartTime = null;

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

    items.forEach((item) => {
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
        </td>
      `;
      tbody.appendChild(tr);
      return;
    }

    // Sort by receivedDate ascending
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

    docsArray.forEach((docSnap) => {
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
        tr.title = "Finish (or resume) current operation before starting a new one";
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
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function openOperationPanel(jobId, visibleJobNumber) {
  document.getElementById("op-job-id").textContent = visibleJobNumber;
  document.getElementById("operation-section").classList.remove("hidden");
  document
    .getElementById("operation-section")
    .scrollIntoView({ behavior: "smooth" });
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
    document.querySelectorAll("#worker-jobs-tbody tr").forEach((row) => {
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
        isPaused: false,
        pauseSegments: []
      });
      currentOpLogId = docRef.id;
      opStartTime = new Date();
      isPaused = false;
      pauseSegments = [];

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
  document.getElementById("login-section").classList.add("hidden");
  document.getElementById("worker-section").classList.add("hidden");

  document.getElementById("main-nav").classList.remove("hidden");
  document.getElementById("admin-name").textContent = currentUser.id;

  document
    .getElementById("tab-operations")
    .addEventListener("click", showOperationsTab);
  document
    .getElementById("tab-employees")
    .addEventListener("click", showEmployeesTab);
  document.getElementById("tab-jobs").addEventListener("click", showJobsTab);
  document.getElementById("tab-logs").addEventListener("click", showLogsTab);

  // Default to the Operations tab
  showOperationsTab();
}

function hideAllAdminSections() {
  document.getElementById("section-operations").classList.add("hidden");
  document.getElementById("section-employees").classList.add("hidden");
  document.getElementById("section-jobs").classList.add("hidden");
  document.getElementById("section-logs").classList.add("hidden");
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

    snapshot.forEach((docSnap) => {
      const opId = docSnap.id;
      const opData = docSnap.data();
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${opData.name}</td>
        <td>
          <button class="action-btn delete" onclick="deleteOperation('${opId}')">Delete</button>
        </td>
      `;
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

  // Avoid duplicates
  const duplicate = operationsCache.find(
    (o) => o.name.toLowerCase() === nameInput.toLowerCase()
  );
  if (duplicate) {
    alert(`“${nameInput}” already exists`);
    return;
  }

  try {
    await addDoc(collection(db, "operations"), { name: nameInput });
    document.getElementById("new-op-name").value = "";
    await loadOperationsList();
    alert(`Operation “${nameInput}” added`);
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

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${docSnap.id}</td>
        <td>${data.role}</td>
        <td>
          <button class="action-btn edit" onclick="editEmployee('${docSnap.id}', '${data.role}')">Edit</button>
          <button class="action-btn delete" onclick="deleteEmployee('${docSnap.id}')">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    if (snapshot.empty) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td colspan=\"3\">No employees found</td>";
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
  const newRole = prompt(`Enter new role for '${username}' (worker/admin):`, currentRole);
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
  const partValue = document.getElementById("search-part-input").value.trim().toLowerCase();
  const dateFrom  = document.getElementById("search-date-from").value; // YYYY-MM-DD
  const dateTo    = document.getElementById("search-date-to").value;   // YYYY-MM-DD

  try {
    const jobsCol = collection(db, "jobs");
    const snapshot = await getDocs(jobsCol);

    // Split into active vs completed arrays
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

    // Render filtered active/completed
    renderActiveJobsSimple(activeJobs, { poValue, partValue, dateFrom, dateTo });
    renderCompletedJobsGrouped(completedJobs, { poValue, partValue, dateFrom, dateTo });
  } catch (err) {
    console.error("Search jobs error:", err);
  }
});

document.getElementById("clear-jobs-btn").addEventListener("click", () => {
  document.getElementById("search-po-input").value       = "";
  document.getElementById("search-part-input").value     = "";
  document.getElementById("search-date-from").value      = "";
  document.getElementById("search-date-to").value        = "";
  loadJobsList();
});

async function createJob() {
  try {
    const po     = document.getElementById("new-job-po").value.trim();
    const jobNum = document.getElementById("new-job-num").value.trim();
    const part   = document.getElementById("new-job-part").value.trim();
    const qtyRaw = document.getElementById("new-job-qty").value;
    const rec    = document.getElementById("new-job-rec").value; // "YYYY-MM-DD"
    const due    = document.getElementById("new-job-due").value; // "YYYY-MM-DD"
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
      receivedDate: rec,           // "YYYY-MM-DD"
      dueDate:      due,           // "YYYY-MM-DD"
      hotOrder:     hot,
      active:       activeFlag,
      title:        `${po} – ${jobNum}`,
      createdAt:    Timestamp.now()
    };

    await addDoc(collection(db, "jobs"), newJobData);

    ["new-job-po","new-job-num","new-job-part","new-job-qty","new-job-rec","new-job-due"].forEach(id => {
      document.getElementById(id).value = "";
    });
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

    // Split into active vs completed arrays
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

    // Render unfiltered (pass empty filters)
    renderActiveJobsSimple(activeJobs, { poValue: "", partValue: "", dateFrom: "", dateTo: "" });
    renderCompletedJobsGrouped(completedJobs, { poValue: "", partValue: "", dateFrom: "", dateTo: "" });
  } catch (error) {
    console.error("Error loading jobs:", error);
  }
}

/**
 * Render Active Jobs in one simple table (no year/month grouping).
 * Filters by PO/Part/ReceivedDate (inclusive).
 *
 * Now includes a “QR” column (canvas + Print QR button) for each job.
 */
function renderActiveJobsSimple(activeJobsArray, { poValue, partValue, dateFrom, dateTo }) {
  const container = document.getElementById("active-jobs-container");
  container.innerHTML = "";

  // Apply filters
  const filtered = activeJobsArray.filter(({ id, data }) => {
    // PO/Part text filters
    const poMatch   = !poValue   || (data.poNumber   || "").toLowerCase().includes(poValue);
    const partMatch = !partValue || (data.partNumber || "").toLowerCase().includes(partValue);

    // Received date filtering
    const rec = data.receivedDate || ""; // "YYYY-MM-DD"
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

  // Build a table
  const table = document.createElement("table");
  table.className = "table";
  table.style.margin = "0.5rem 0";
  table.innerHTML = `
    <thead>
      <tr style="background:#eef7f1;">
        <th>Job ID</th>
        <th>PO</th>
        <th>Job #</th>
        <th>Part #</th>
        <th>Qty</th>
        <th>Received</th>
        <th>Due</th>
        <th>Hot</th>
        <th>QR</th>
        <th>Actions</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement("tbody");

  // Sort by receivedDate descending (most recent first)
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

    // Each row now has a <canvas id="qr-<jobId>"></canvas> and a Print QR button
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${visibleJobNum}</td>
      <td>${data.poNumber}</td>
      <td>${data.jobNumber}</td>
      <td>${data.partNumber}</td>
      <td>${data.quantity}</td>
      <td>${receivedFormatted}</td>
      <td>${dueFormatted}</td>
      <td>${hotText}</td>

      <!-- QR column: canvas + Print button -->
      <td class="qr-cell">
        <canvas id="qr-${jobId}"></canvas><br/>
        <button onclick="printQRCode('${jobId}')" class="btn btn-secondary mt-1 btn-sm">
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

  // Finally, instantiate QRious for each <canvas>
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
 * Render Completed Jobs grouped by year → month → simple list (similar to work logs).
 * Filters by PO/Part/ReceivedDate (inclusive).
 */
function renderCompletedJobsGrouped(completedJobsArray, { poValue, partValue, dateFrom, dateTo }) {
  // 1) Filter first
  const filtered = completedJobsArray.filter(({ id, data }) => {
    // PO/Part text filters
    const poMatch   = !poValue   || (data.poNumber   || "").toLowerCase().includes(poValue);
    const partMatch = !partValue || (data.partNumber || "").toLowerCase().includes(partValue);

    // Received date filtering
    const rec = data.receivedDate || ""; // "YYYY-MM-DD"
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

  // 2) Group by year → month
  const grouped = {}; 
  filtered.forEach(({ id: jobId, data }) => {
    const rec = data.receivedDate || ""; // "YYYY-MM-DD"
    let year = "Unknown Year";
    let monthName = "Unknown Month";

    if (rec && /^\d{4}-\d{2}-\d{2}$/.test(rec)) {
      const [yy, mm, dd] = rec.split("-");
      year = yy;
      const monthIdx = parseInt(mm, 10) - 1;
      const monthNames = [
        "January","February","March","April","May","June",
        "July","August","September","October","November","December"
      ];
      monthName = monthNames[monthIdx] || `Month ${mm}`;
    }

    if (!grouped[year]) grouped[year] = {};
    if (!grouped[year][monthName]) grouped[year][monthName] = [];
    grouped[year][monthName].push({ id: jobId, data });
  });

  // 3) Render each year as <details><summary>
  const sortedYears = Object.keys(grouped)
    .filter((y) => y !== "Unknown Year")
    .map(Number)
    .sort((a, b) => b - a)
    .map(String);
  if (grouped["Unknown Year"]) sortedYears.push("Unknown Year");

  sortedYears.forEach((yearKey) => {
    const yearDetails = document.createElement("details");
    yearDetails.open = false; // collapsed by default
    yearDetails.style.marginBottom = "1rem";

    const yearSummary = document.createElement("summary");
    yearSummary.innerHTML = `<strong>${yearKey}</strong>`;
    yearSummary.style.fontSize = "1.2rem";
    yearSummary.style.margin = "0.4rem 0";
    yearDetails.appendChild(yearSummary);

    const monthsObj = grouped[yearKey];
    const monthOrder = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December"
    ];
    const sortedMonths = Object.keys(monthsObj).sort((a, b) => {
      if (a === "Unknown Month") return 1;
      if (b === "Unknown Month") return -1;
      return monthOrder.indexOf(a) - monthOrder.indexOf(b);
    });

    sortedMonths.forEach((monthName) => {
      const monthDetails = document.createElement("details");
      monthDetails.style.marginLeft = "1rem";
      monthDetails.open = false; // collapsed by default
      monthDetails.style.marginBottom = "0.75rem";

      const monthSummary = document.createElement("summary");
      monthSummary.textContent = `${monthName} ${yearKey}`;
      monthSummary.style.fontSize = "1.1rem";
      monthSummary.style.margin = "0.3rem 0";
      monthDetails.appendChild(monthSummary);

      // Build a simple table for this month’s completed jobs
      const table = document.createElement("table");
      table.className = "table";
      table.style.margin = "0.5rem 0";
      table.innerHTML = `
        <thead>
          <tr style="background:#f7f7f7;">
            <th>Job ID</th><th>PO</th><th>Job #</th><th>Part #</th><th>Qty</th>
            <th>Received</th><th>Due</th><th>Hot</th><th>Actions</th>
          </tr>
        </thead>
      `;
      const tbody = document.createElement("tbody");

      // Sort this month’s jobs by receivedDate descending
      monthsObj[monthName]
        .sort((a, b) => {
          const aRec = a.data.receivedDate || "";
          const bRec = b.data.receivedDate || "";
          if (aRec > bRec) return -1;
          if (aRec < bRec) return 1;
          return a.id.localeCompare(b.id);
        })
        .forEach(({ id: jobId, data }) => {
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
            <td>${data.jobNumber}</td>
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
          tbody.appendChild(tr);
        });

      table.appendChild(tbody);
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
      jobId: jobId,
      user: currentUser.id,
      operation: "COMPLETED_JOB",
      startTime: Timestamp.now(),
      endTime: Timestamp.now()
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
            height: 100%; width: 100%;
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

// ────────────────────────────────────────────────────────────────────────────────
// 11) WORK LOGS (Split: Active → grouped per job; Completed → year/month accordions; plus Edit via modal)
// ────────────────────────────────────────────────────────────────────────────────
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

// Keep track of which log is currently being edited
let editingLogId = null;

async function loadLogs() {
  try {
    // 1) Fetch all jobs to build jobId → { po, part, title, activeFlag }
    const jobsCol = collection(db, "jobs");
    const jobsSnap = await getDocs(jobsCol);
    const jobsMap = {};
    jobsSnap.docs.forEach((js) => {
      const jd = js.data();
      jobsMap[js.id] = {
        po:     jd.poNumber    || "",
        part:   jd.partNumber  || "",
        title:  jd.title       || js.id,
        active: jd.active      || false
      };
    });

    // 2) Build opId → opName map
    const opsCol = collection(db, "operations");
    const opsSnap = await getDocs(opsCol);
    const operationsMap = {};
    opsSnap.docs.forEach((os) => {
      operationsMap[os.id] = os.data().name;
    });
    operationsMap["COMPLETED_JOB"] = "Job Completed";

    // 3) Grab filter inputs
    const poFilter   = document.getElementById("search-logs-po").value.trim().toLowerCase();
    const partFilter = document.getElementById("search-logs-part").value.trim().toLowerCase();
    const dateFrom   = document.getElementById("search-logs-date-from").value;
    const dateTo     = document.getElementById("search-logs-date-to").value;

    // 4) Fetch all logs
    const logsCol = collection(db, "logs");
    const logsSnap = await getDocs(logsCol);

    // 5) Split logs into arrays: activeJobLogs vs completedJobLogs
    const activeJobLogs    = [];
    const completedJobLogs = [];

    logsSnap.docs.forEach((docSnap) => {
      const entry = docSnap.data();
      entry.id = docSnap.id;
      const jobId = entry.jobId;
      if (!jobsMap[jobId]) return; // skip if job was deleted

      // PO/Part filter: look at parent job’s PO/Part
      const jobData = jobsMap[jobId];
      const poMatch   = !poFilter   || jobData.po.toLowerCase().includes(poFilter);
      const partMatch = !partFilter || jobData.part.toLowerCase().includes(partFilter);

      // Date filter on entry.startTime
      let dateMatch = true;
      if (dateFrom) {
        const fromMillis = new Date(dateFrom).getTime();
        const logStart   = entry.startTime.toDate().getTime();
        if (logStart < fromMillis) dateMatch = false;
      }
      if (dateTo) {
        // include entire “dateTo” day
        const toMillis = new Date(dateTo).getTime() + 24*3600*1000 - 1;
        const logStart = entry.startTime.toDate().getTime();
        if (logStart > toMillis) dateMatch = false;
      }
      if (!(poMatch && partMatch && dateMatch)) return;

      // classify by job’s active flag
      if (jobsMap[jobId].active) {
        activeJobLogs.push(entry);
      } else {
        completedJobLogs.push(entry);
      }
    });

    // 6) Render Active Work Logs grouped by job
    renderActiveWorkLogs(activeJobLogs, operationsMap, jobsMap);

    // 7) Render Completed Work Logs as year/month accordions
    renderCompletedWorkLogs(completedJobLogs, operationsMap, jobsMap);

  } catch (error) {
    console.error("Error loading logs:", error);
    const container = document.getElementById("logs-container");
    container.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = "Failed to load work logs.";
    p.style.color = "red";
    container.appendChild(p);
  }
}

function renderActiveWorkLogs(entriesArray, operationsMap, jobsMap) {
  // Ensure there's a container for active logs
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

  // Group by jobId → [entries]
  const byJob = {};
  entriesArray.forEach((entry) => {
    if (!byJob[entry.jobId]) byJob[entry.jobId] = [];
    byJob[entry.jobId].push(entry);
  });

  // Sort jobs by jobTitle alphabetically
  const jobIds = Object.keys(byJob).sort((a, b) => {
    const titleA = (jobsMap[a]?.title || a).toLowerCase();
    const titleB = (jobsMap[b]?.title || b).toLowerCase();
    return titleA.localeCompare(titleB);
  });

  // For each job, render a sub‐heading + table of its entries
  jobIds.forEach((jobId) => {
    const jobEntries = byJob[jobId];
    const jobData = jobsMap[jobId] || {};
    const jobTitle = jobData.title;

    // Sub‐heading for this job
    const h5 = document.createElement("h5");
    h5.textContent = `Job: ${jobTitle}`;
    h5.style.marginTop = "1rem";
    h5.style.marginBottom = "0.5rem";
    activeDiv.appendChild(h5);

    // Sort this job’s entries by startTime ascending
    jobEntries.sort((a, b) => {
      return a.startTime.toDate() - b.startTime.toDate();
    });

    // Build table for this job
    const table = document.createElement("table");
    table.className = "table";
    table.style.fontSize = "0.9rem";
    table.innerHTML = `
      <thead>
        <tr style="background:#eef7f1;">
          <th>User</th><th>Operation</th><th>Duration</th>
          <th>Start Time</th><th>End Time</th><th>Edit</th><th>Delete</th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement("tbody");

    jobEntries.forEach((entry) => {
      // Compute duration
      let durationText = "In progress";
      if (entry.startTime && entry.endTime) {
        const s = entry.startTime.toDate();
        const e = entry.endTime.toDate();
        const diffSec = Math.floor((e - s) / 1000);
        const h = Math.floor(diffSec / 3600);
        const m = Math.floor((diffSec % 3600) / 60);
        const s2 = diffSec % 60;
        durationText =
          String(h).padStart(2, "0") + ":" +
          String(m).padStart(2, "0") + ":" +
          String(s2).padStart(2, "0");
      }
      const startStr = entry.startTime ? formatTimestamp(entry.startTime) : "-";
      const endStr   = entry.endTime   ? formatTimestamp(entry.endTime)   : "In progress";
      const opName   = operationsMap[entry.operation] || entry.operation;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${entry.user}</td>
        <td>${opName}</td>
        <td>${durationText}</td>
        <td>${startStr}</td>
        <td>${endStr}</td>
        <td><button class="btn btn-warning btn-sm" id="edit-log-${entry.id}">Edit</button></td>
        <td><button class="btn btn-danger btn-sm" id="del-log-${entry.id}">Delete</button></td>
      `;
      tbody.appendChild(tr);

      // Hook up Edit button
      setTimeout(() => {
        const editBtn = document.getElementById(`edit-log-${entry.id}`);
        if (editBtn) {
          editBtn.addEventListener("click", () => editLogEntry(entry.id));
        }
      }, 0);

      // Hook up Delete button
      setTimeout(() => {
        const delBtn = document.getElementById(`del-log-${entry.id}`);
        if (delBtn) {
          delBtn.addEventListener("click", () => deleteLogEntry(entry.id));
        }
      }, 0);
    });

    table.appendChild(tbody);
    activeDiv.appendChild(table);
  });
}

function renderCompletedWorkLogs(entriesArray, operationsMap, jobsMap) {
  // Ensure there's a container for completed logs
  let completedDiv = document.getElementById("completed-logs-container");
  if (!completedDiv) {
    const heading2 = document.createElement("h4");
    heading2.className = "subheading";
    heading2.textContent = "Completed Work Logs";
    document.getElementById("logs-container").appendChild(heading2);

    completedDiv = document.createElement("div");
    completedDiv.id = "completed-logs-container";
    completedDiv.style.marginBottom = "2rem";
    document.getElementById("logs-container").appendChild(completedDiv);
  }
  completedDiv.innerHTML = "";

  if (entriesArray.length === 0) {
    const p2 = document.createElement("p");
    p2.textContent = "No completed work logs.";
    p2.style.color = "#555";
    completedDiv.appendChild(p2);
    return;
  }

  // 1) Group by year → month → jobId → [entries]
  const grouped = {};
  entriesArray.forEach((entry) => {
    const jobId = entry.jobId;
    const d = entry.startTime.toDate();
    const year = d.getFullYear();
    const monthIndex = d.getMonth(); // 0-based
    const monthNames = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December"
    ];
    const monthName = monthNames[monthIndex];

    if (!grouped[year])               grouped[year] = {};
    if (!grouped[year][monthName])    grouped[year][monthName] = {};
    if (!grouped[year][monthName][jobId]) grouped[year][monthName][jobId] = [];
    grouped[year][monthName][jobId].push(entry);
  });

  // 2) Sort years descending
  const sortedYears = Object.keys(grouped)
    .map(Number)
    .sort((a, b) => b - a);

  sortedYears.forEach((year) => {
    const yearDetails = document.createElement("details");
    yearDetails.open = false;
    yearDetails.style.marginBottom = "1rem";

    const yearSummary = document.createElement("summary");
    yearSummary.innerHTML = `<strong>${year}</strong>`;
    yearSummary.style.fontSize = "1.25rem";
    yearSummary.style.marginBottom = "0.5rem";
    yearDetails.appendChild(yearSummary);

    const monthsObj = grouped[year];
    const monthOrder = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December"
    ];
    const sortedMonths = Object.keys(monthsObj).sort(
      (a, b) => monthOrder.indexOf(a) - monthOrder.indexOf(b)
    );

    sortedMonths.forEach((monthName) => {
      const monthDetails = document.createElement("details");
      monthDetails.style.marginLeft = "1rem";
      monthDetails.open = false;
      monthDetails.style.marginBottom = "0.75rem";

      const monthSummary = document.createElement("summary");
      monthSummary.textContent = `${monthName} ${year}`;
      monthSummary.style.fontSize = "1.1rem";
      monthSummary.style.margin = "0.4rem 0";
      monthDetails.appendChild(monthSummary);

      const jobsObj = monthsObj[monthName];
      const sortedJobIds = Object.keys(jobsObj).sort();

      sortedJobIds.forEach((jobId) => {
        const entries = jobsObj[jobId];
        const jobData = jobsMap[jobId] || {};
        const jobTitle = jobData.title;

        // Compute total time for all entries of this job
        let totalSeconds = 0;
        entries.forEach((entry) => {
          const s = entry.startTime.toDate();
          const e = entry.endTime ? entry.endTime.toDate() : null;
          if (s && e) {
            totalSeconds += Math.floor((e - s) / 1000);
          }
        });
        const th = Math.floor(totalSeconds / 3600);
        const tm = Math.floor((totalSeconds % 3600) / 60);
        const ts = totalSeconds % 60;
        const totalDisplay =
          String(th).padStart(2, "0") + ":" +
          String(tm).padStart(2, "0") + ":" +
          String(ts).padStart(2, "0");

        const jobSection = document.createElement("div");
        jobSection.className = "job-logs";
        jobSection.style.marginLeft = "2rem";
        jobSection.style.marginBottom = "1.5rem";

        const jobHeader = document.createElement("h4");
        jobHeader.textContent = `Job: ${jobTitle}  (Total Time: ${totalDisplay})`;
        jobHeader.style.marginBottom = "0.5rem";
        jobSection.appendChild(jobHeader);

        const table = document.createElement("table");
        table.className = "table";
        table.style.fontSize = "0.9rem";
        table.innerHTML = `
          <thead>
            <tr style="background:#eef7f1;">
              <th>User</th><th>Operation</th><th>Duration</th>
              <th>Start Time</th><th>End Time</th><th>Edit</th><th>Delete</th>
            </tr>
          </thead>
        `;
        const tb = document.createElement("tbody");

        // Sort entries by startTime ascending
        entries.sort((a, b) => {
          return a.startTime.toDate() - b.startTime.toDate();
        });

        entries.forEach((entry) => {
          let durationText = "In progress";
          if (entry.startTime && entry.endTime) {
            const s = entry.startTime.toDate();
            const e = entry.endTime.toDate();
            const diffSec = Math.floor((e - s) / 1000);
            const h = Math.floor(diffSec / 3600);
            const m = Math.floor((diffSec % 3600) / 60);
            const s2 = diffSec % 60;
            durationText =
              String(h).padStart(2, "0") + ":" +
              String(m).padStart(2, "0") + ":" +
              String(s2).padStart(2, "0");
          }
          const startStr = entry.startTime ? formatTimestamp(entry.startTime) : "-";
          const endStr   = entry.endTime   ? formatTimestamp(entry.endTime)   : "In progress";
          const opName   = operationsMap[entry.operation] || entry.operation;

          const logTr = document.createElement("tr");
          logTr.innerHTML = `
            <td>${entry.user}</td>
            <td>${opName}</td>
            <td>${durationText}</td>
            <td>${startStr}</td>
            <td>${endStr}</td>
            <td><button class="btn btn-warning btn-sm" id="edit-log-${entry.id}">Edit</button></td>
            <td><button class="btn btn-danger btn-sm" id="del-log-${entry.id}">Delete</button></td>
          `;
          tb.appendChild(logTr);

          // Hook up Edit button
          setTimeout(() => {
            const editBtn = document.getElementById(`edit-log-${entry.id}`);
            if (editBtn) {
              editBtn.addEventListener("click", () => editLogEntry(entry.id));
            }
          }, 0);

          // Hook up Delete button
          setTimeout(() => {
            const delBtn = document.getElementById(`del-log-${entry.id}`);
            if (delBtn) {
              delBtn.addEventListener("click", () => deleteLogEntry(entry.id));
            }
          }, 0);
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

async function deleteLogEntry(logId) {
  if (!confirm("Delete this log entry?")) return;
  try {
    await deleteDoc(doc(db, "logs", logId));
    loadLogs();
  } catch (err) {
    console.error("Error deleting log:", err);
    alert("Failed to delete log entry.");
  }
}

/* =====================================================
   11b) EDIT LOG ENTRY (both startTime & endTime via modal)
   ===================================================== */
async function editLogEntry(logId) {
  try {
    // 1) Fetch the existing log
    const logRef = doc(db, "logs", logId);
    const logSnap = await getDoc(logRef);
    if (!logSnap.exists()) {
      alert("Log entry not found.");
      return;
    }
    const data = logSnap.data();

    // 2) Convert Firestore Timestamp → HTML datetime-local format (YYYY-MM-DDTHH:MM:SS)
    function toLocalDatetimeString(ts) {
      if (!ts) return "";
      const d = ts.toDate();
      const year  = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day   = String(d.getDate()).padStart(2, "0");
      const hrs   = String(d.getHours()).padStart(2, "0");
      const mins  = String(d.getMinutes()).padStart(2, "0");
      const secs  = String(d.getSeconds()).padStart(2, "0");
      return `${year}-${month}-${day}T${hrs}:${mins}:${secs}`;
    }

    const startVal = toLocalDatetimeString(data.startTime);
    const endVal   = data.endTime ? toLocalDatetimeString(data.endTime) : "";

    // 3) Populate modal inputs
    document.getElementById("edit-start-input").value = startVal;
    document.getElementById("edit-end-input").value   = endVal;
    editingLogId = logId;

    // 4) Show modal
    const modal = document.getElementById("edit-log-modal");
    modal.classList.remove("hidden");

  } catch (err) {
    console.error("Error fetching log for edit:", err);
    alert("Could not load log entry for editing.");
  }
}

// 5) “Save” button listener
document.getElementById("save-log-btn").addEventListener("click", async () => {
  if (!editingLogId) return;
  try {
    const logRef = doc(db, "logs", editingLogId);

    // Read both inputs
    const newStartStr = document.getElementById("edit-start-input").value;
    const newEndStr   = document.getElementById("edit-end-input").value;

    // Helper to convert HTML datetime-local (YYYY-MM-DDTHH:mm:ss) → Firestore Timestamp
    function parseLocalDatetime(str) {
      if (!str) return null;
      // `new Date(str)` works for “YYYY-MM-DDTHH:mm:ss”
      const d = new Date(str);
      if (isNaN(d.getTime())) return null;
      return Timestamp.fromDate(d);
    }

    const newStartTs = parseLocalDatetime(newStartStr);
    const newEndTs   = parseLocalDatetime(newEndStr);

    // If start is invalid or empty, warn
    if (!newStartTs) {
      alert("Please provide a valid start time (YYYY-MM-DDThh:mm:ss).");
      return;
    }

    // Update Firestore with both fields
    await updateDoc(logRef, {
      startTime: newStartTs,
      endTime:   newEndTs  // if newEndTs is null, this sets endTime → null in Firestore
    });

    // 6) Close modal + clear editingLogId + refresh table
    document.getElementById("edit-log-modal").classList.add("hidden");
    editingLogId = null;
    loadLogs();

  } catch (err) {
    console.error("Error saving log edit:", err);
    alert("Failed to update log entry.");
  }
});

// 7) “Cancel” button listener
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
  const rows = document.querySelectorAll("#worker-jobs-tbody tr");
  for (const row of rows) {
    if (row.dataset.jobId === jumpedJobId) {
      row.click();
      history.replaceState(null, "", window.location.pathname);
      return;
    }
  }
}

/* =====================================================
   13) OPERATIONS FOR WORKER (populate <select>)
   ===================================================== */
async function loadOperationsForWorker() {
  try {
    if (!operationsCache.length) {
      const opsCol = collection(db, "operations");
      const snapshot = await getDocs(opsCol);
      operationsCache = [];
      snapshot.forEach((docSnap) => {
        operationsCache.push({ id: docSnap.id, name: docSnap.data().name });
      });
    }
    const select = document.getElementById("operation-select");
    select.innerHTML = "";
    if (operationsCache.length === 0) {
      select.innerHTML = `<option disabled>No operations defined</option>`;
      select.disabled = true;
      return;
    }
    select.disabled = false;
    operationsCache.forEach((op) => {
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
   14) ENTER KEY ON PIN → TRIGGER LOGIN
   ===================================================== */
document.getElementById("pin").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    document.getElementById("login-btn").click();
  }
});

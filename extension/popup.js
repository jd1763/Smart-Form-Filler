/***********************
 * POPUP — MATCHER + FILLER (Week-5 kept) + Week-6 multi-resume + UI polish
 ***********************/
const DEBUG = true;
const log = (...a) => DEBUG && console.log("[popup]", ...a);
const err = (...a) => console.error("[popup]", ...a);

// Mutable base; background.js is the single source of truth.
let BACKEND_BASE =
  (typeof localStorage !== "undefined" && localStorage.getItem("backend_base")) ||
  "http://127.0.0.1:5000";

function setBackendBase(base) {
  if (typeof base === "string" && base.startsWith("http")) {
    BACKEND_BASE = base;
    try { localStorage.setItem("backend_base", base); } catch (_) {}
  }
}

// Track backend availability so we don't keep hammering it if it's down
let BACKEND_AVAILABLE = null; // null = unknown, true = up, false = down

// Track which logical backend version the user prefers ("v1" or "v2")
let BACKEND_VERSION_PREF = "v1";

// Load the last selected backend from chrome.storage.sync
async function loadBackendPreference() {
  try {
    const { backendPref } = await chrome.storage.sync.get("backendPref");
    if (backendPref === "v2" || backendPref === "v1") {
      BACKEND_VERSION_PREF = backendPref;
    }
  } catch {
    // ignore
  }
}

// Save the selected backend into chrome.storage.sync
function saveBackendPreference(pref) {
  const normalized = pref === "v2" ? "v2" : "v1";
  BACKEND_VERSION_PREF = normalized;
  try {
    chrome.storage.sync.set({ backendPref: normalized });
  } catch (_) {
    // ignore
  }
}

// Simple pill UI helper
function updateBackendPillUI(pref) {
  const v1 = document.getElementById("backendV1Pill");
  const v2 = document.getElementById("backendV2Pill");
  if (!v1 || !v2) return;

  v1.classList.toggle("active", pref === "v1");
  v2.classList.toggle("active", pref === "v2");
}

// Optional inline status under the toggle (if you have an element for it)
function setBackendToggleMessage(msg) {
  const el = document.getElementById("backendToggleMessage");
  if (!el) return;
  el.textContent = msg || "";
  el.style.display = msg ? "block" : "none";
}

// ------------------------------
// Backend version + port helpers
// ------------------------------

// Each backend has its own pool of ports so they never fight over a busy port:
//   - Flask (v1)  : 5000–5004 locally, 8000 via Docker
//   - FastAPI (v2): 6000–6004 locally, 8001 via Docker
const V1_LOCAL_PORTS = [5000, 5001, 5002, 5003, 5004];
const V2_LOCAL_PORTS = [6000, 6001, 6002, 6003, 6004];
const V1_DOCKER_PORT = 8000;
const V2_DOCKER_PORT = 8001;

// Last selected backend version (persisted between popup opens)
let CURRENT_BACKEND =
  (typeof localStorage !== "undefined" && localStorage.getItem("backendPreference")) || "v1";

// Popup-level auth state (v2 only). We use this to prevent the popup from
// calling match/resume endpoints while signed out (which can cause resolver fallback to v1).
let POPUP_IS_AUTHENTICATED = false;

function isV2SignedOut() {
  return CURRENT_BACKEND === "v2" && !POPUP_IS_AUTHENTICATED;
}

function resetMatchCardToEmptySignedOutV2() {
  const matchCard = document.getElementById("matchCard");

  // Keep the Job Match card visible so the V1/V2 toggle stays accessible
  if (matchCard) matchCard.style.display = "";

  // Ensure the gauge SVG is visible (some earlier patches hid it)
  try {
    const svg = matchCard?.querySelector("svg");
    if (svg) svg.style.display = "";
  } catch {}

  // Reset gauge to the same defaults as popup.html (track visible, arc empty, score is —)
  const arc = document.getElementById("arc");
  if (arc) {
    arc.setAttribute("stroke-dasharray", "0,100");
    arc.setAttribute("stroke", "#111");
  }

  const scoreNum = document.getElementById("scoreNum");
  if (scoreNum) scoreNum.textContent = "—";

  const jdHint2 = document.getElementById("jdHint2");
  if (jdHint2) jdHint2.textContent = "Sign in to see match";

  const matchStatus = document.getElementById("matchStatus");
  if (matchStatus) matchStatus.textContent = "";

  // Keep all four skill boxes present, but empty/neutral placeholders
  const putDashChip = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = "";
    const s = document.createElement("span");
    s.className = "chip";
    s.textContent = "—";
    el.appendChild(s);
  };

  putDashChip("matchedReq");
  putDashChip("matchedPref");
  putDashChip("missingReq");
  putDashChip("missingPref");
}

// Force the popup into the correct logged-out v2 experience.
// This must be called immediately after logout AND whenever auth.me says unauthenticated.
function resetSignedOutV2UI() {
  if (!isV2SignedOut()) return;

  // Keep Job Match card visible + fully rendered (circle + sections), but empty
  resetMatchCardToEmptySignedOutV2();

  // Hide cards that should NOT appear while signed out in v2
  const suggestorCard = document.getElementById("resumeSuggestorCard");
  const noResumesCard = document.getElementById("noResumesCard");
  if (suggestorCard) suggestorCard.style.display = "none";
  if (noResumesCard) noResumesCard.style.display = "none";

  // Apply Helper: keep the card but remove resume picker + disable actions
  const applyCard = document.getElementById("applyCard");
  const controls = document.getElementById("controls");
  const fillBtn = document.getElementById("fillForm");
  const tryBtn = document.getElementById("tryAgain");
  if (applyCard) applyCard.style.display = "";
  if (controls) controls.style.display = "none";
  if (fillBtn) fillBtn.disabled = true;
  if (tryBtn) tryBtn.style.display = "none";

  // Hide the dynamically injected inline resume picker (created in ensureInlineResumePicker)
  const inlineHost = document.getElementById("resumeInlineHost");
  if (inlineHost) inlineHost.style.display = "none";

  // Clear resume suggestor labels if present (prevents sticky text)
  try {
    const chosenResume = document.getElementById("chosenResume");
    const chosenScore = document.getElementById("chosenScore");
    const selectedResume = document.getElementById("selectedResume");
    const selectedScore = document.getElementById("selectedScore");
    const resumeSelect = document.getElementById("resumeSelect");
    if (chosenResume) chosenResume.textContent = "";
    if (chosenScore) chosenScore.textContent = "";
    if (selectedResume) selectedResume.textContent = "";
    if (selectedScore) selectedScore.textContent = "";
    if (resumeSelect) resumeSelect.innerHTML = "";
  } catch {}
}

// Map a base URL (http://127.0.0.1:PORT) back to v1 or v2
function inferBackendFromBase(base) {
  if (typeof base !== "string") return null;
  try {
    const u = new URL(base);
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    if (V1_LOCAL_PORTS.includes(port) || port === V1_DOCKER_PORT) return "v1";
    if (V2_LOCAL_PORTS.includes(port) || port === V2_DOCKER_PORT) return "v2";
  } catch (_) {
    // ignore malformed URLs
  }
  return null;
}

// Update CURRENT_BACKEND + save + refresh pill UI
function setCurrentBackend(pref) {
  const normalized = pref === "v2" ? "v2" : pref === "v1" ? "v1" : null;

  // IMPORTANT: if pref is missing/invalid, do nothing.
  // This prevents clobbering the saved backendPref back to v1 on every popup open.
  if (!normalized) return;

  CURRENT_BACKEND = normalized;

  // Keep localStorage for the popup UI (optional)
  try {
    localStorage.setItem("backendPreference", normalized);
  } catch (_) {
    // ignore
  }

  // Keep background.js in sync (single source of truth)
  try {
    chrome.storage.sync.set({ backendPref: normalized });
  } catch (_) {
    // ignore
  }

  setBackendPillUI(normalized);
}

// Visual pill state: which side is active
function setBackendPillUI(pref) {
  const v1El = document.getElementById("backendV1Pill");
  const v2El = document.getElementById("backendV2Pill");
  if (!v1El || !v2El) return;

  v1El.classList.toggle("active", pref === "v1");
  v2El.classList.toggle("active", pref === "v2");
}

// Small info message directly under the toggle
function setBackendInfoMessage(msg) {
  const infoEl = document.getElementById("backendInfoMessage");
  if (!infoEl) return;

  if (msg) {
    infoEl.textContent = msg;
    infoEl.style.display = "";
  } else {
    infoEl.textContent = "";
    infoEl.style.display = "none";
  }
}

// Probe both backends at once via background.js (single source of truth).
async function getMultiBackendStatus() {
  try {
    // force reprobe AND probeBoth so background fills v1/v2 fields
    const st = await queryBackendStatus(true, true);

    const v1 = (st && st.v1) ? st.v1 : {};
    const v2 = (st && st.v2) ? st.v2 : {};

    return {
      v1Ok:  !!v1.up,
      v2Ok:  !!v2.up,
      v1Base: v1.base || null,
      v2Base: v2.base || null,
    };
  } catch (e) {
    err("[popup] getMultiBackendStatus failed:", e);
    return { v1Ok: false, v2Ok: false, v1Base: null, v2Base: null };
  }
}

function _unwrapProfilePayload(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (raw.profile && typeof raw.profile === "object") return raw.profile;
  if (raw.data && raw.data.profile && typeof raw.data.profile === "object") return raw.data.profile;
  return raw;
}

// Read JWT from chrome storage (same key as background.js)
async function getAccessTokenPopup() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["sff_access_token"], (result) => {
      resolve(result?.sff_access_token || null);
    });
  });
}

// Minimal backend helper: single base, no health checks, no failover
async function fetchWithFailover(path, opts) {
  const baseDefaults = {
    cache: "no-store",
    credentials: "omit",
    headers: Object.assign(
      { "Accept": "application/json" },
      (opts && opts.headers) || {}
    ),
  };

  const finalOpts = Object.assign({}, baseDefaults, opts || {});

  // IMPORTANT: attach JWT ONLY in v2 mode (v1 must be local/no-accounts)
  try {
    if (CURRENT_BACKEND === "v2") {
      const token = await getAccessTokenPopup();
      if (token && finalOpts.headers && !finalOpts.headers["Authorization"]) {
        finalOpts.headers["Authorization"] = `Bearer ${token}`;
      }
    }
  } catch (_) {}

  let resp;
  try {
    resp = await fetch(`${BACKEND_BASE}${path}`, finalOpts);
  } catch (e) {
    const err = new Error(`network-failed: ${e && e.message}`);
    err.kind = "network";
    throw err;
  }

  if (!resp.ok) {
    let bodyText = "";
    try { bodyText = await resp.text(); } catch (_) {}
    const err = new Error(`http-${resp.status}${bodyText ? `: ${bodyText}` : ""}`);
    err.kind = "http";
    err.status = resp.status;
    err.body = bodyText;
    throw err;
  }

  return resp;
}

// Ask background.js for backend base + health so everything uses the same port.
// probeBoth=true makes background probe v1+v2 (used for "retry connection" UI).
async function queryBackendStatus(forceReprobe = false, probeBoth = false) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        {
          action: "getBackendStatus",
          forceReprobe: !!forceReprobe,
          probeBoth: !!probeBoth,
        },
        (resp) => {
          if (!resp || resp.success === false) {
            log("[popup] getBackendStatus failed:", resp && resp.error);
            resolve({
              ok: false,
              base: BACKEND_BASE,
              lastChecked: Date.now(),
            });
            return;
          }
          if (resp.base) setBackendBase(resp.base);
          log("[popup] getBackendStatus:", resp.ok, "base:", resp.base, "pref:", resp.pref);
          resolve(resp);
        }
      );
    } catch (e) {
      err("[popup] getBackendStatus sendMessage error:", e);
      resolve({
        ok: false,
        base: BACKEND_BASE,
        lastChecked: Date.now(),
      });
    }
  });
}

// Health check: delegate to background.getBackendStatus, but fall back to a direct /health probe
async function ensureBackendHealthy(forceReprobe = false) {
  // Fast path: we already know it's up and caller didn't force a re-probe.
  if (!forceReprobe && BACKEND_AVAILABLE === true) {
    log("[popup] ensureBackendHealthy: using cached OK");
    return true;
  }

  try {
    // Ask background first (single source of truth for which port/base to use)
    const st = await queryBackendStatus(forceReprobe);

    let ok   = false;
    let base = st && st.base ? st.base : BACKEND_BASE;

    // 1) Prefer the explicit ok flag if background provided it
    if (st && typeof st.ok === "boolean") {
      ok = st.ok;
    }

    // 2) If ok is still false but we DO have a base, try a direct /health probe ourselves.
    if (!ok && base) {
      try {
        const r = await fetch(`${base}/health?t=${Date.now()}`, {
          cache: "no-store",
          credentials: "omit",
        });
        log(
          "[popup] direct /health probe:",
          base,
          "status=",
          r && r.status,
          "ok=",
          r && r.ok
        );
        if (r && r.ok) {
          ok = true;
        }
      } catch (probeErr) {
        log(
          "[popup] direct /health probe failed:",
          probeErr && probeErr.message
        );
      }
    }

    // 3) Update globals + base URL
    BACKEND_AVAILABLE = ok;

    if (base && base !== BACKEND_BASE) {
      setBackendBase(base);
    }

    log("[popup] ensureBackendHealthy: final ok =", ok, "base =", BACKEND_BASE);
    return ok;
  } catch (e) {
    BACKEND_AVAILABLE = false;
    err("[popup] ensureBackendHealthy error:", e);
    return false;
  }
}

// --- global shims so legacy pieces don't crash ---
if (typeof window.getActiveTab === "undefined") {
  window.getActiveTab = async function () {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t || null;
  };
}
if (typeof window.sendToTab === "undefined") {
  window.sendToTab = function (tabId, payload) {
    return new Promise(res =>
      chrome.tabs.sendMessage(tabId, payload, r => res(r))
    );
  };
}

// Classify whether we can/should inject on this URL (popup-only guard)
function classifyPageUrl(urlRaw){
  const url = String(urlRaw || "");
  const lower = url.toLowerCase();

  const withId = (pfx) => lower.startsWith(`${pfx}${chrome.runtime?.id || ""}`);

  // Hard no: browser/extension internals
  if (lower.startsWith("chrome://") || lower.startsWith("edge://") || lower.startsWith("about:") || lower.startsWith("view-source:")) {
    return { ok:false, reason:"internal", msg:"❌ This is a browser internal page. Open a normal website tab." };
  }
  if (lower.startsWith("chrome-extension://")) {
    // If it's our own extension page (e.g., profile.html), be explicit
    if (withId("chrome-extension://")) {
      return { ok:false, reason:"extension_self", msg:"❌ This is the extension page (profile/settings). Open a job form tab to fill." };
    }
    return { ok:false, reason:"extension_other", msg:"❌ This is an extension page. Open a normal website tab." };
  }

  // PDFs often run in a viewer we can’t inject into
  if (/\.(pdf)(\?|#|$)/i.test(lower) || /\/pdfviewer\//i.test(lower) || /\/pdfjs\//i.test(lower)) {
    return { ok:false, reason:"pdf", msg:"❌ This looks like a PDF viewer. Open an HTML application form." };
  }

  // about:blank or data URLs
  if (lower === "" || lower === "about:blank" || lower.startsWith("data:")) {
    return { ok:false, reason:"blank", msg:"❌ No active page to fill. Navigate to a form first." };
  }

  return { ok:true };
}

// Safe wrapper around your ensureContent — never throws, returns {ok, reason, err}
async function ensureContentSafe(tabId){
  try {
    const ok = await ensureContent(tabId);
    return { ok: !!ok };
  } catch (e) {
    const msg = e && (e.message || String(e)) || "unknown";
    if (/Cannot access contents of url/i.test(msg)) return { ok:false, reason:"injectionDenied", err:msg };
    if (/Receiving end does not exist/i.test(msg))   return { ok:false, reason:"notReachable", err:msg };
    return { ok:false, reason:"unknown", err:msg };
  }
}

// Safe wrapper for sendToFrame — returns null on runtime errors
async function sendToFrameSafe(tabId, frameId, payload){
  try {
    return await sendToFrame(tabId, frameId, payload);
  } catch (e) {
    console.warn("[popup] sendToFrameSafe error:", e);
    return null;
  }
}

// ========= DIAGNOSTICS PANEL =========
let DIAG; // root <div> we render into

function ensureDiagPanel() {
  if (DIAG && document.body.contains(DIAG)) return DIAG;
  DIAG = document.createElement("div");
  DIAG.id = "sffDiag";
  DIAG.style.cssText = `
    margin-top: 8px; padding: 8px; border: 1px solid #ddd; border-radius: 8px;
    max-height: 220px; overflow: auto; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    background: #fafafa;
  `;
  const h = document.createElement("div");
  h.textContent = "Diagnostics";
  h.style.cssText = "font-weight:600;margin-bottom:6px;";
  DIAG.appendChild(h);
  const pre = document.createElement("pre");
  pre.id = "sffDiagPre";
  pre.style.cssText = "white-space:pre-wrap;margin:0;";
  DIAG.appendChild(pre);
  const host = document.getElementById("resultsBox") || document.body;
  host.appendChild(DIAG);
  return DIAG;
}

function setLoading(visible, msg){
  const overlay = document.getElementById("loadingView");
  const label   = document.getElementById("loadingMsg");
  if (overlay) overlay.style.display = visible ? "flex" : "none";
  if (label && msg) label.textContent = msg;
}

function initTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = {
    main:  document.getElementById("tab-main"),
    debug: document.getElementById("tab-debug"),
  };
  const show = (key) => {
    panels.main.style.display  = key === "main"  ? "" : "none";
    panels.debug.style.display = key === "debug" ? "" : "none";
  };
  tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      tabs.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      show(btn.dataset.tab);
    });
  });
  // default
  show("main");
}

function showDiag(obj){
  ensureDiagPanel();
  const pre = document.getElementById("sffDiagPre");
  try {
    pre.textContent = JSON.stringify(obj, null, 2);
  } catch {
    pre.textContent = String(obj);
  }
}

function diagError(step, message, extra={}) {
  const e = new Error(`[${step}] ${message}`);
  e.step = step;
  e.extra = extra;
  log("DIAG ERROR", step, message, extra);
  throw e;
}

let _errTimer = null;

function _getAuthErrorEl() {
  // Support both ids, and also support legacy code that references authError
  return (
    window.authErrorMsg ||
    window.authError ||
    document.getElementById("authErrorMsg") ||
    document.getElementById("authError")
  );
}

function flashError(msg, ms = 2500) {
  const el = _getAuthErrorEl();
  if (!el) return;

  el.textContent = msg;
  el.style.opacity = 1;

  if (_errTimer) clearTimeout(_errTimer);
  _errTimer = setTimeout(() => {
    el.style.opacity = 0.7; // subtle fade
  }, ms);
}

async function setAuthError(text) {
  const el = _getAuthErrorEl();
  if (el) el.textContent = text || "";
}

async function storeAccessToken(token) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ sff_access_token: token }, () => resolve());
  });
}

// Uses your existing multi-backend probing
async function getV2BaseOrNull() {
  try {
    const status = await getMultiBackendStatus();
    // adjust if your status key name differs
    return status?.v2Base || status?.v2?.base || status?.v2?.baseUrl || null;
  } catch (e) {
    console.error("[popup] getMultiBackendStatus failed:", e);
    return null;
  }
}

/* ===================== MATCHER CONFIG ===================== */
const MATCH_ROUTE = "/match";

// Skills whitelist is loaded from skill_terms.txt so popup/profile/dashboard stay in sync.
let SKILL_WORDS = null;
let _skillWordsPromise = null;

function _canonSkillTerm(raw) {
  let t = String(raw || "").trim().toLowerCase();
  if (!t || t.startsWith("#")) return "";

  const compact = t.replace(/\s+/g, "");
  if (compact === "c++") return "cpp";
  if (compact === "c#") return "csharp";
  if (compact === ".net") return "dotnet";

  // Keep phrases as-is (we still support phrase detection elsewhere)
  return t.replace(/\s+/g, " ");
}

async function ensureSkillWordsLoaded() {
  if (SKILL_WORDS) return SKILL_WORDS;
  if (_skillWordsPromise) return _skillWordsPromise;

  _skillWordsPromise = (async () => {
    const url = chrome.runtime.getURL("skill_terms.txt");
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`[popup] failed to load skill_terms.txt (${resp.status})`);

    const text = await resp.text();
    const set = new Set();

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const asIs = line.toLowerCase();
      set.add(asIs);

      const canon = _canonSkillTerm(asIs);
      if (canon) set.add(canon);
    }

    // hard guarantees (even if someone edits the file)
    set.add("git");

    SKILL_WORDS = set;
    return SKILL_WORDS;
  })();

  return _skillWordsPromise;
}

// === skill aliases (keep minimal) ===
const SFF_SKILL_ALIASES = Object.assign(Object.create(null), {
  "github": "git",
  "git": "git",
  "react.js": "reactjs",
  "next.js": "nextjs",
  "node.js": "nodejs",
  "js": "javascript",
  "ts": "typescript",
  "k8s": "kubernetes",
});

// small normalizer used only here
function sffNormSkillToken(s) {
  let t = String(s || "").toLowerCase().trim();

  // trim junk punctuation at ends BUT keep tech chars like + # . / -
  t = t.replace(/^[^a-z0-9.+#/-]+|[^a-z0-9.+#/-]+$/g, "");

  const compact = t.replace(/\s+/g, "");

  // canonicalize common language tokens
  if (compact === "c++") return "cpp";
  if (compact === "c#") return "csharp";
  if (compact === ".net") return "dotnet";

  return SFF_SKILL_ALIASES[compact] || compact;
}

function sffCollectSkills(text) {
  const toks = (String(text || "").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || [])
    .map(sffNormSkillToken);

  const out = new Set();
  for (const tk of toks) {
    if (tk && SKILL_WORDS.has(tk)) out.add(tk);
  }
  return out; // Set of canonical skill tokens present in text
}

// ================= BUCKETS / RENDERING =================
(async function BucketUI() {
  await ensureSkillWordsLoaded();
  // --- DOM refs
  const detectedToggle   = document.getElementById("detectedToggle");
  const detectedFieldsEl = document.getElementById("detectedFields");
  const detectedListEl   = document.getElementById("detectedList");
  const detectedHintEl   = document.getElementById("detectedHint");

  const filledToggle     = document.getElementById("filledToggle");
  const filledFieldsEl   = document.getElementById("filledFields");

  const notFilledToggle  = document.getElementById("notFilledToggle");
  const notFilledFieldsEl= document.getElementById("notFilledFields");

  const statusEl         = document.getElementById("status");
  const btnFill          = document.getElementById("fillForm");
  const btnTryAgain      = document.getElementById("tryAgain");

  // ---------- header helpers (no auto-open; just reflect current state) ----------
  function setHeaderWithCount(hdrEl, panelEl, base, count) {
    hdrEl.dataset.base  = base;
    hdrEl.dataset.count = String(count);
    const open = panelEl.style.display !== "none";
    hdrEl.textContent = `${open ? "▼" : "▶"} ${base}${Number.isFinite(count) ? ` (${count})` : ""}`;
  }
  function refreshAllCounts({ detectedCount, filledCount, nonFilledCount }) {
    setHeaderWithCount(detectedToggle,  detectedFieldsEl,  "Detected Fields",    detectedCount);
    setHeaderWithCount(filledToggle,    filledFieldsEl,    "Filled Fields",      filledCount);
    setHeaderWithCount(notFilledToggle, notFilledFieldsEl, "Non-Filled Fields",  nonFilledCount);
  }

// ---------- tiny render helpers ----------
const $item = (label, meta) => {
  const row = document.createElement("div");
  row.className = "row";               // same row style as the dropdowns

  const name = document.createElement("span");
  name.className = "field-name";       // bullet + ellipsis handled in CSS
  const text = label || "(unknown)";
  name.textContent = text;
  name.title = text;
  row.appendChild(name);

  if (meta) {
    const m = document.createElement("span");
    m.className = "field-meta";        // right-side compact meta (used for Non-Filled)
    m.textContent = meta;
    row.appendChild(m);
  }
  return row;
};

function renderSimpleList(container, items, metaForItem = () => "") {
  container.innerHTML = "";
  (items || []).forEach(it =>
    container.appendChild($item(it.label || it.key || "(unknown)", metaForItem(it)))
  );
  if (!items || !items.length) container.appendChild($item("— none —"));
}

// Accept both shapes, map to {key?,label,confidence}
function normalizeDetectedShape(resp) {
  const arr = Array.isArray(resp?.detected) ? resp.detected : [];
  return arr.map(x => ({
    key:   x.key || x.prediction || x.name || null,
    // prefer canonical labelText, then explicit label, then id/name; never placeholder
    label: x.labelText || x.label || x.id || x.name || "(Unknown)",
    confidence: "N/A"
  }));
}

  // ---------- tab + messaging helpers ----------
async function getActiveTab(){
  return new Promise(res=>{
    chrome.tabs.query({active:true,currentWindow:true},tabs=>res(tabs?.[0]||null));
    });
  }

  async function ask(tabId, payload) {
    try { return await chrome.tabs.sendMessage(tabId, payload); }
    catch { return null; }
  }

  function sendToTab(tabId, payload) {
    return new Promise(res => {
      chrome.tabs.sendMessage(tabId, payload, (resp) => {
        if (chrome.runtime.lastError) return res({ ok:false, error: chrome.runtime.lastError.message });
        res(resp || { ok:false });
      });
    });
  }
  
  // Run the Key Skills pass in the best frame (handles iframes)
async function runKeySkillsPass(tabId){
  try{
    if (!await ensureContent(tabId)) return { ok:false, error:"content unreachable" };
    const frameId = await getBestFrame(tabId);
    const resp = await sendToFrame(tabId, frameId, { action: "EXT_CHECK_KEY_SKILLS" });

    // Recheck consent checkboxes after skills pass
    await runConsentBroadcast(tabId);

    log("[popup] key-skills:", resp);
    return resp || { ok:false };
  }catch(e){
    err("[popup] key-skills error:", e);
    return { ok:false, error:String(e) };
  }
}

// --------- detection + seeding ----------
async function detectAndSeed() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    // clear UI
    renderDetected(detectedListEl, []);
    if (typeof refreshAllCounts === "function") {
      refreshAllCounts({ detectedCount: 0, filledCount: 0, nonFilledCount: 0 });
    }
    detectedHintEl.textContent = "No active tab.";
    return { detected: [], pageKey: "" };
  }

  detectedHintEl.textContent = "Scanning page for fields…";

  // Ensure content is injected
  if (!await ensureContent(tab.id)) {
    renderDetected(detectedListEl, []);
    if (typeof refreshAllCounts === "function") {
      refreshAllCounts({ detectedCount: 0, filledCount: 0, nonFilledCount: 0 });
    }
    detectedHintEl.textContent = "Couldn’t reach the page. Try again on a form.";
    return { detected: [], pageKey: "" };
  }

  // Ask the best frame to detect fields — exactly like detectDebug
  const frameId = await getBestFrame(tab.id);
  let resp = await sendToFrame(tab.id, frameId, { action: "EXT_DETECT_FIELDS" });
  if (!resp || !resp.ok) {
    resp = await sendToFrame(tab.id, frameId, { action: "EXT_DETECT_FIELDS_SIMPLE" });
  }

  const raw = Array.isArray(resp?.detected) ? resp.detected : [];
  // Build the Detected list from labelText only (same as detectDebug/predict)
  const detected = raw
  .map(d => ({
    key: d.prediction || d.name || d.id || null,
    label: (d.labelText || "").trim(),   // authoritative label
    selector: d.selector || null          // needed to tie to the page snapshot
  }))
  .filter(x => x.label);

  // Store once so other flows can reuse
  window.SFF_DETECTED = detected.slice();

  // Render Detected only (no filled/non-filled yet)
  renderDetected(detectedListEl, detected);
  detectedHintEl.textContent = `${detected.length} fields found`;

  // Update header counts safely (don’t touch missing globals)
  if (typeof refreshAllCounts === "function") {
    refreshAllCounts({
      detectedCount: detected.length,
      filledCount: 0,
      nonFilledCount: 0
    });
  }

  return { detected };
}

// === Build Filled / Non-Filled from the current page snapshot (confidence N/A) ===
async function rescanFilledNonFilledFromPage() {
  try {
    const tab = await (window.getActiveTab ? window.getActiveTab() : (async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      return t || null;
    })());
    if (!tab?.id) return;

    // Ensure content is injected; get best frame (even if unused here)
    if (typeof ensureContent === "function") {
      const ok = await ensureContent(tab.id);
      if (!ok) return;
    }
    const frameId = (typeof getBestFrame === "function") ? await getBestFrame(tab.id) : 0;

    // Ask content which fields are currently filled vs not filled
    const snap = await new Promise(res =>
      chrome.tabs.sendMessage(tab.id, { action: "EXT_SNAPSHOT_BUCKETS" }, r => res(r || {}))
    );

    const filledRaw    = Array.isArray(snap?.filled)    ? snap.filled    : [];
    const notFilledRaw = Array.isArray(snap?.notFilled) ? snap.notFilled : [];

    // Build a selector -> detectorLabel map from our Detected box
    const det = Array.isArray(window.SFF_DETECTED) ? window.SFF_DETECTED : [];
    const labelBySel = new Map(det.filter(d => d.selector).map(d => [d.selector, d.label]));

    // Load confidence cache from last fill
    const { sffConfCache } = await chrome.storage.local.get("sffConfCache");
    const confCache = sffConfCache || {};
    const pickConf = (rec) => {
      const v =
        (rec?.selector && confCache.bySelector?.[rec.selector]) ??
        (rec?.key      && confCache.byKey?.[rec.key]) ??
        (rec?.label    && confCache.byLabel?.[rec.label]);
      return (v == null ? "N/A" : v); // number in [0..1] or "N/A"
    };
    // Always show the detector's label when we have a selector match
    const toRow = (rec) => {
      const label = (rec?.selector && labelBySel.get(rec.selector)) || rec?.label || "(Unknown)";
      const row = {
        key: rec.key || null,
        label,
        confidence: pickConf(rec)
      };
      if (typeof rec.value !== "undefined") row.value = rec.value;
      return row;
    };

    const filled    = filledRaw.map(toRow);
    const nonFilled = notFilledRaw.map(toRow);

    // Render
    renderFieldList(filledFieldsEl, filled,    { title: "Filled",     mode: "filled"    });
    renderFieldList(notFilledFieldsEl, nonFilled, { title: "Non-Filled", mode: "nonfilled" });
    // Ensure "Not filled" styling stays consistent
    if (typeof forceNonFilledBadges === "function") {
      forceNonFilledBadges(notFilledFieldsEl);
    }

    // Header counts (Detected from detector; buckets from snapshot)
    if (typeof refreshAllCounts === "function") {
      refreshAllCounts({
        detectedCount: det.length,
        filledCount: filled.length,
        nonFilledCount: nonFilled.length
      });
    }
  } catch (e) {
    console.error("[popup] rescanFilledNonFilledFromPage error:", e);
  }
}

// Minimal rescan: refresh Detected from the page, nothing else.
window.rescanNow = async function() {
  try {
    return await detectAndSeed();
  } catch (e) {
    console.error("[popup] rescanNow error:", e);
    return { detected: [] };
  }
};

// Ensure Non-Filled cards show the same layout as Filled:
// - red "Not filled" badge next to label
// - chip text "Confidence N/A"
// - meter at 0%
function ensureNotFilledBadges(container){
  if (!container) return;

  container.querySelectorAll('.field-item').forEach(card => {
    // 1) Badge next to label
    const labelEl = card.querySelector('.label');
    let badge = card.querySelector('.badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'badge badge-red';
      if (labelEl) labelEl.insertAdjacentElement('afterend', badge);
      else card.insertAdjacentElement('afterbegin', badge);
    }
    badge.textContent = 'Not filled';
    badge.classList.add('badge-red');

    // 2) Confidence chip text
    const chip = card.querySelector('.chip');
    if (chip) chip.textContent = 'Confidence N/A';

    // 3) Meter width → 0%
    const meterFill =
      card.querySelector('.meter > span') ||
      card.querySelector('.meter .bar') ||
      card.querySelector('.meter .fill');
    if (meterFill) meterFill.style.width = '0%';
  });
}

  function splitBucketsByReport(detected, report) {
    const filled = Array.isArray(report?.filled) ? report.filled.map(f => ({
      key: f.key || null,
      label: f.label || "(Unknown)",
      confidence: (f.confidence ?? "—"),
      value: f.value
    })) : [];
    const filledKeys = new Set(filled.map(f => f.key || f.label));
    const nonFilled = detected.filter(d => !filledKeys.has(d.key || d.label));
    return { filled, nonFilled };
  }

  function renderBuckets(detected, reportOrNull) {
    // Re-resolve bucket containers locally so this function never depends on outer scope
    const filledFieldsEl     = document.getElementById("filledFields");
    const notFilledFieldsEl  = document.getElementById("notFilledFields");
    if (!filledFieldsEl || !notFilledFieldsEl) return;

    if (!reportOrNull) {
      renderFieldList(filledFieldsEl, [], { title: "Filled", mode: "filled" });
      const nonFilledInit = detected.map(d => ({ key: d.key || null, label: d.label, confidence: "N/A" }));
      renderFieldList(notFilledFieldsEl, nonFilledInit, { title: "Non-Filled", mode: "nonfilled" });
      forceNonFilledBadges(notFilledFieldsEl);
      return;
    }
  
    // Merge confidences we may have for nonfilled
    const confMap = new Map();
    if (Array.isArray(reportOrNull.notFilled)) {
      for (const nf of reportOrNull.notFilled) {
        const k = nf?.key || nf?.label;
        if (k != null && "confidence" in nf) confMap.set(k, nf.confidence);
      }
    }
  
    const rawFilled = Array.isArray(reportOrNull.filled) ? reportOrNull.filled.map(f => ({
      key: f.key || null,
      label: f.label || "(Unknown)",
      confidence: (parseConfidence(f.confidence) ?? "N/A"), // preserve numeric if present
      value: f.value,
      inputType: f.inputType,
      type: f.type,
      kind: f.kind,
      status: f.status,
      changed: f.changed,
      didSet: f.didSet
    })) : [];    
  
    const filled = rawFilled.filter(isTrulyFilled);
    const movedBack = rawFilled.filter(f => !isTrulyFilled(f)).map(f => ({
      key: f.key || null,
      label: f.label || "(Unknown)",
      confidence: (parseConfidence(f.confidence) ?? "N/A")
    }));    
  
    const filledKeys = new Set(filled.map(f => f.key || f.label));
    const nonFilled = detected
      .filter(d => !filledKeys.has(d.key || d.label))
      .map(d => {
        const c = confMap.get(d.key || d.label);
        return {
          key: d.key || null,
          label: d.label,
          confidence: (parseConfidence(c) ?? "N/A")
        };
      })      
      .concat(movedBack);
  
    renderFieldList(filledFieldsEl, filled,     { title: "Filled",     mode: "filled" });
    renderFieldList(notFilledFieldsEl, nonFilled, { title: "Non-Filled", mode: "nonfilled" });
    forceNonFilledBadges(notFilledFieldsEl);
    
    refreshAllCounts({    
      detectedCount: detected.length,
      filledCount:   filled.length,
      nonFilledCount: nonFilled.length
    });
  }  

  // ---------- toggles (click only; no persist, no auto-open) ----------
  function wireToggles() {
    // live counters coming from the UI that's currently rendered
    function currentCounts() {
      const detectedCount =
        (Array.isArray(window.SFF_DETECTED) && window.SFF_DETECTED.length) ||
        (document.getElementById("detectedList")?.querySelectorAll(".field-item").length || 0);
      const filledCount =
        (document.getElementById("filledFields")?.querySelectorAll(".field-item").length || 0);
      const nonFilledCount =
        (document.getElementById("notFilledFields")?.querySelectorAll(".field-item").length || 0);
      return { detectedCount, filledCount, nonFilledCount };
    }
  
    function setHeader(hdrEl, panelEl, base, count) {
      const open = panelEl.style.display !== "none";
      hdrEl.dataset.base  = base;
      hdrEl.dataset.count = String(count);
      hdrEl.textContent   = `${open ? "▼" : "▶"} ${base} (${count})`;
    }
  
    const toggles = [
      { hdr: document.getElementById("detectedToggle"),  panel: document.getElementById("detectedFields"),  base: "Detected Fields" },
      { hdr: document.getElementById("filledToggle"),    panel: document.getElementById("filledFields"),    base: "Filled Fields" },
      { hdr: document.getElementById("notFilledToggle"), panel: document.getElementById("notFilledFields"), base: "Non-Filled Fields" },
    ].filter(x => x.hdr && x.panel);
  
    toggles.forEach(({hdr, panel, base}) => {
      hdr.addEventListener("click", () => {
        const open = panel.style.display !== "none";
        panel.style.display = open ? "none" : "block";
        const { detectedCount, filledCount, nonFilledCount } = currentCounts();
        const n = base.startsWith("Detected") ? detectedCount
                : base.startsWith("Filled")   ? filledCount
                : nonFilledCount;
        setHeader(hdr, panel, base, n);
      });
    });
  
    // initial paint
    const { detectedCount, filledCount, nonFilledCount } = currentCounts();
    toggles.forEach(({hdr, panel, base}) => {
      const n = base.startsWith("Detected") ? detectedCount
              : base.startsWith("Filled")   ? filledCount
              : nonFilledCount;
      setHeader(hdr, panel, base, n);
    });
  }  
  wireToggles();

  // ---------- INIT (fresh every open; no cache restore) ----------
  const { detected } = await detectAndSeed();
  statusEl.textContent = "Ready…";
  btnTryAgain.style.display = "none";
  await rescanFilledNonFilledFromPage();

// ---------- fill button ----------
btnFill?.addEventListener("click", async (evt) => {
  // Guard: if the selected backend is down, show message under buttons and STOP other handlers.
  if (BACKEND_AVAILABLE === false) {
    evt?.preventDefault();
    evt?.stopImmediatePropagation();
    showBackendButtonsWarning();
    return;
  }
  // If we don't know yet, force a quick health check once
  if (BACKEND_AVAILABLE === null) {
    const ok = await ensureBackendHealthy(true);
    if (!ok) {
      evt?.preventDefault();
      evt?.stopImmediatePropagation();
      showBackendButtonsWarning();
      return;
    }
  }

  // --- capture matched skills for the SELECTED resume used to APPLY (not suggestor) ---
  try {
      // 1) get selected resume text (from the UI where the user picked it)
      const getSelectedResumeText = () => {
        // selected card pattern
        const card = document.querySelector('.resume-card.selected [data-resume-text], .resume-card.is-active [data-resume-text]');
        if (card) return (card.textContent || card.value || "").trim();

        // select dropdown pattern
        const dd = document.querySelector('#resumeSelect, select[name="resume"], select[data-role="resume"]');
        if (dd && dd.value) {
          const opt = dd.options[dd.selectedIndex];
          if (opt && opt.textContent) return opt.textContent.trim();
        }

        // textarea / preview pattern
        const ta = document.querySelector('#resumeText, textarea[name="resumeText"], .resume-preview, #resume-preview');
        if (ta) return (ta.textContent || ta.value || "").trim();

        return "";
      };

      // 2) get job description text if available (helps if we re-match)
      const getJobText = () => {
        const el = document.querySelector('#jobDescription, textarea[name="jobDescription"], #jd, .jd-text');
        return el ? (el.value || el.textContent || "").trim() : "";
      };

      const resumeText = getSelectedResumeText();
      const jobText    = getJobText();

      // 3) compute match for THIS resume (if computeMatch exists). Otherwise, fall back to existing buckets on screen.
      let required = [], preferred = [];
      if (typeof computeMatch === "function" && resumeText) {
        const m = computeMatch(resumeText, jobText);
        if (Array.isArray(m?.required))  required  = m.required;
        if (Array.isArray(m?.preferred)) preferred = m.preferred;
      }
      if (!required.length || !preferred.length) {
      // fallback: scrape visible lists from the popup UI (NEW: chip containers)
      const reqDom = Array.from(
        document.querySelectorAll('#matchedReq .chip, #skills-required li, #skillsRequired li, .bucket.skills .required li')
      ).map(el => el.textContent.trim()).filter(Boolean);

      const prefDom = Array.from(
        document.querySelectorAll('#matchedPref .chip, #skills-preferred li, #skillsPreferred li, .bucket.skills .preferred li')
      ).map(el => el.textContent.trim()).filter(Boolean);

      if (!required.length)  required  = reqDom;
      if (!preferred.length) preferred = prefDom;

      }

      // 4) write to storage and await completion so content.js can read immediately
      await new Promise(res => chrome.storage.local.set(
        { matchedSkills: { required, preferred } },
        () => res()
      ));
      console.log("[popup] matchedSkills (selected resume) saved:", { required: required.length, preferred: preferred.length });
    } catch (e) {
      console.warn("[popup] matchedSkills(save) failed:", e);
    }
    // --- end capture ---

    try {
      // Use the single, unified fill pipeline so skills/education/experience logic is consistent.
      await fillUsingPredictPipeline({ silent: true });
    
      // === prevent over-add and fill experiences ===
      const tab = await getActiveTab();
      if (tab?.id) {
        // 1) Load the profile so the content script knows the exact experience target
        let prof = {};
        try {
          prof = await getProfileFromBackend(); // already defined in this file
        } catch (_) {
          prof = {};
        }
            
        // 2) Ensure content + target the best frame
        await ensureContent(tab.id);
        const frameId = await getBestFrame(tab.id);

        // 3) Now actually fill the Experience (and Education) blocks
        const { lastResumeId } = await chrome.storage.local.get("lastResumeId");
        await sendToFrame(tab.id, frameId, {
          action: "EXT_FILL_FIELDS",
          items: (typeof SFF_DETECTED !== "undefined" && Array.isArray(SFF_DETECTED)) ? SFF_DETECTED : [],
          profile: prof,
          resumeId: lastResumeId || null
        });

        // 5) Settle, rescan counts for the popup, and run key-skills pass
        await new Promise(r => setTimeout(r, 180));
        await rescanNow();
        await runKeySkillsPass(tab.id);
        await rescanFilledNonFilledFromPage();
      }
    } catch (e) {
      statusEl.textContent = "❌ " + (e.message || e);
    }    
  });

  btnTryAgain?.addEventListener("click", async () => { btnFill?.click(); });
})();


/* ===================== UI HANDLES (Matcher) ===================== */
const elsM = { arc:null, scoreNum:null, hint:null, status:null };

function gaugeColor(pct){
  // red → orange → yellow → yellowish green → green
  if (pct >= 85) return "#16a34a"; // green
  if (pct >= 70) return "#84cc16"; // yellowish green
  if (pct >= 55) return "#eab308"; // yellow
  if (pct >= 40) return "#f97316"; // orange
  return "#ef4444";                // red
}

function setArc(percent){
  const p = Math.max(0, Math.min(100, Math.round(percent||0)));
  if (elsM.arc) {
    elsM.arc.setAttribute("stroke-dasharray", `${p},100`);
    elsM.arc.setAttribute("stroke", gaugeColor(p));
  }
  if (elsM.scoreNum) elsM.scoreNum.textContent = `${p}%`;
}

/* ===================== CHIP RENDERING (side-by-side + fallback) ===================== */
function chip(txt, bad=false){
  const s=document.createElement("span");
  s.className=`chip ${bad?"bad":""}`;
  s.textContent=txt;
  return s;
}
function clear(el){ if(el) el.innerHTML=""; }
function renderChipList(container, arr, bad=false){
  if (!container) return;
  clear(container);
  (arr.length ? arr : ["None"]).forEach(s => container.appendChild(chip(s, bad)));
}
function renderBucketsIntoUI(buckets){
  // New side-by-side containers
  const elMatchedReq  = document.getElementById("matchedReq");
  const elMatchedPref = document.getElementById("matchedPref");
  const elMissingReq  = document.getElementById("missingReq");
  const elMissingPref = document.getElementById("missingPref");
  const haveNewBoxes = elMatchedReq && elMatchedPref && elMissingReq && elMissingPref;

  if (haveNewBoxes) {
    renderChipList(elMatchedReq,  buckets.matchedReq,  false);
    renderChipList(elMatchedPref, buckets.matchedPref, false);
    renderChipList(elMissingReq,  buckets.missReq,     true);
    renderChipList(elMissingPref, buckets.missPref,    true);
    return;
  }

  // ---- Fallback to old single-column containers (Week-5 HTML) ----
  const elsMatched = document.getElementById("matchedSkills");
  const elsMissing = document.getElementById("missingSkills");

  if (elsMatched) {
    clear(elsMatched);
    const hReq = document.createElement("div"); hReq.className="subhead"; hReq.textContent="Required";
    const boxReq = document.createElement("div"); boxReq.className="chips";
    buckets.matchedReq.forEach(s=>boxReq.appendChild(chip(s)));
    const hPref = document.createElement("div"); hPref.className="subhead"; hPref.textContent="Preferred";
    const boxPref = document.createElement("div"); boxPref.className="chips";
    buckets.matchedPref.forEach(s=>boxPref.appendChild(chip(s)));
    elsMatched.append(hReq, boxReq, hPref, boxPref);
  }

  if (elsMissing) {
    clear(elsMissing);
    const hReq = document.createElement("div"); hReq.className="subhead"; hReq.textContent="Required";
    const boxReq = document.createElement("div"); boxReq.className="chips";
    (buckets.missReq.length? buckets.missReq:["None"]).forEach(s=>boxReq.appendChild(chip(s,true)));
    const hPref = document.createElement("div"); hPref.className="subhead"; hPref.textContent="Preferred";
    const boxPref = document.createElement("div"); boxPref.className="chips";
    (buckets.missPref.length? buckets.missPref:["None"]).forEach(s=>boxPref.appendChild(chip(s,true)));
    elsMissing.append(hReq, boxReq, hPref, boxPref);
  }
}

/* ===================== TEXT / SKILLS HELPERS ===================== */
function tokenize(text){
  return (text||"").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g)||[];
}

/* ===== Extract Required / Preferred from JD (sentence-scoped preferred) =====
   - Required = all skills mentioned anywhere in the JD.
   - Preferred = ONLY the skills in sentences that contain a preferred keyword
                 (or the explicit "Preferred:" span). We DO NOT take the whole paragraph.
   - Final: required = allSkills - preferred.
*/
function extractImportance(jdText) {
  const jd = String(jdText || "");

  // Canonical skill collector
  function sffCollectSkills(text) {
    const T = String(text || "").toLowerCase();
  
    // Token hits → canonical
    const toks = (T.match(/[a-z][a-z0-9+./-]{1,}/g) || []).map(sffNormSkillToken);
    const out = new Set();
    for (const tk of toks) if (tk && SKILL_WORDS.has(tk)) out.add(tk);
  
    // Phrase hits → add canonical tokens
    if (/\bunit[\s-]?testing\b/.test(T)) out.add("unit_testing");
    if (/\bdata[\s-]?model(ing|s)\b/.test(T)) out.add("data_modeling");
  
    // Common AWS subservices explicitly
    if (/\bamazon s3\b|\bs3\b/.test(T)) out.add("s3");
    if (/\biam\b/.test(T)) out.add("iam");
    if (/\beks\b/.test(T)) out.add("eks");
    if (/\becs\b/.test(T)) out.add("ecs");
  
    return out;
  }  
  
  // 1) All skills anywhere → base Required candidates
  const allSkills = sffCollectSkills(jd);

  // 2) Preferred from explicit inline "Preferred:" span
  const preferred = new Set();
  const lower = jd.toLowerCase();
  const inlinePrefMatch = lower.match(/\b(preferred|nice[-\s]?to[-\s]?have|bonus|plus)\s*:\s*([^\n\.]+)/i);
  if (inlinePrefMatch) {
    const originalTail = jd.slice(inlinePrefMatch.index + inlinePrefMatch[0].length - inlinePrefMatch[2].length);
    // originalTail should be the same text as capture group 2 in original casing
    for (const k of sffCollectSkills(inlinePrefMatch[2])) preferred.add(k);
  }

  // 3) Also capture sentence-scoped preferred (no colon form, e.g., "Nice to have experience with ...")
  const prefRx = /\b(preferred|nice[-\s]?to[-\s]?have|bonus|plus)\b/i;
  // Split into sentences conservatively (., ?, !, or newlines)
  const sentences = jd.split(/(?<=[.!?])\s+|\n+/);
  for (const sent of sentences) {
    if (prefRx.test(sent)) {
      for (const k of sffCollectSkills(sent)) preferred.add(k);
    }
  }

  // 4) Finalize buckets: Required = All - Preferred
  const required = new Set([...allSkills].filter(k => !preferred.has(k)));

  return { requiredKeys: required, preferredKeys: preferred };
}

/* ===================== RESPONSE NORMALIZATION & BUCKETS ===================== */
function normalizeMatchResponse(res, jdText){
  // score 0..1 or 0..100 → 0..100
  let s = Number(res?.similarity_score ?? res?.score ?? 0);
  const scorePct = Math.max(0, Math.min(100, Math.round(s > 1 ? s : (s*100))));

  // flatten missing: ["aws", ...] or [["aws",0.31], ...] → lower → canonical
  const rawMissing = Array.isArray(res?.missing_keywords ?? res?.missing_skills)
    ? (res.missing_keywords ?? res.missing_skills)
    : [];
  const flat = rawMissing.map(m => Array.isArray(m) ? String(m[0]) : String(m));

  // JD tokens → canonical set (aliases applied)
  const jdCanonSet = new Set(
    ((jdText||"").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || [])
      .map(sffNormSkillToken)
      .filter(t => t && SKILL_WORDS.has(t))
  );

  // Keep only canonical skills that are in whitelist AND actually mentioned (canon) in the JD
  const missingCanon = flat
    .map(x => sffNormSkillToken(String(x).toLowerCase().trim()))
    .filter(t => t && SKILL_WORDS.has(t) && jdCanonSet.has(t));

  const missingClean = Array.from(new Set(missingCanon));
  return { scorePct, missingClean };
}

function extractImportanceFromSections(jdText) {
  const jd = String(jdText || "");
  const lines = jd.split(/\r?\n/);

  // Headings + synonyms
  const REQ_HDRS  = [
    /basic qualifications/i, /minimum qualifications/i,
    /requirements?\b/i, /required qualifications/i,
    /must[-\s]?have/i, /required skills?\b/i, /^required\b/i
  ];
  const PREF_HDRS = [
    /preferred qualifications/i, /nice[-\s]?to[-\s]?have/i,
    /\bbonus\b/i, /\bplus\b/i, /preferred skills?\b/i, /^preferred\b/i
  ];

  let mode = null; // "req" | "pref" | null
  const reqBuf = [];
  const prefBuf = [];

  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line) continue;

    // Handle inline labels on the same line, e.g.
    // "Required skills: Python, Java. Preferred: AWS, Docker."
    if (/(required[^:]*:)|(preferred[^:]*:)/i.test(line)) {
      const reqMatch  = line.match(/required[^:]*:\s*([^.;]+)/i);
      const prefMatch = line.match(/preferred[^:]*:\s*([^.;]+)/i);
      if (reqMatch)  reqBuf.push(reqMatch[1]);
      if (prefMatch) prefBuf.push(prefMatch[1]);
      continue;
    }

    // Switch mode when we hit a heading
    if (REQ_HDRS.some(rx => rx.test(line)))  { mode = "req";  continue; }
    if (PREF_HDRS.some(rx => rx.test(line))) { mode = "pref"; continue; }

    // New generic heading → stop capturing
    if (/^\s*[A-Z][A-Za-z0-9\s]{0,40}:?\s*$/.test(line)
        && !REQ_HDRS.concat(PREF_HDRS).some(rx => rx.test(line))) {
      mode = null;
      continue;
    }

    if (mode === "req")  reqBuf.push(line);
    if (mode === "pref") prefBuf.push(line);
  }

  const reqText  = reqBuf.join("\n");
  const prefText = prefBuf.join("\n");

  const requiredKeys  = sffCollectSkills(reqText);
  const preferredKeys = sffCollectSkills(prefText);

  return { requiredKeys, preferredKeys, found: (reqText.length + prefText.length) > 0 };
}

function computeBucketsFromJDAndMissing(jdText, missingClean){
  // Canonical JD skill set
  const jdCanonSet = new Set(
    ((jdText||"").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || [])
      .map(sffNormSkillToken)
      .filter(t => t && SKILL_WORDS.has(t))
  );

  // Prefer strict section-based parsing; fallback to sentence-scoped if not found
  let { requiredKeys, preferredKeys, found } = extractImportanceFromSections(jdText || "");
  if (!found) {
    ({ requiredKeys, preferredKeys } = extractImportance(jdText || ""));
  }

  const reqCanon = new Set(
    Array.from(requiredKeys || [])
      .map(k => sffNormSkillToken(String(k)))
      .filter(t => t && SKILL_WORDS.has(t))
  );
  const prefCanon = new Set(
    Array.from(preferredKeys || [])
      .map(k => sffNormSkillToken(String(k)))
      .filter(t => t && SKILL_WORDS.has(t))
  );

  // Intersect with JD canon set so only skills that actually appear in the JD remain
  const required = new Set([...reqCanon].filter(t => jdCanonSet.has(t)));
  const preferred = new Set([...prefCanon].filter(t => jdCanonSet.has(t) && !required.has(t)));

  // Canonical missing set (so "github" vs "git" can match)
  const missSet = new Set((missingClean||[]).map(x => sffNormSkillToken(String(x))));

  // Matched / Missing per bucket
  const matchedReq  = [...required].filter(k => !missSet.has(k));
  const missReq     = [...required].filter(k =>  missSet.has(k));
  const matchedPref = [...preferred].filter(k => !missSet.has(k));
  const missPref    = [...preferred].filter(k =>  missSet.has(k));

  return { matchedReq, matchedPref, missReq, missPref };
}

// ================= DISPLAY SCORE (uses the same buckets the UI shows) =================
function computeDisplayScore({ jdText, missing }) {
  const buckets = computeBucketsFromJDAndMissing(jdText || "", (missing || []));

  const reqMatched  = (buckets.matchedReq  || []).length;
  const reqMissing  = (buckets.missReq     || []).length;
  const prefMatched = (buckets.matchedPref || []).length;
  const prefMissing = (buckets.missPref    || []).length;

  const reqTotal  = reqMatched + reqMissing;
  const prefTotal = prefMatched + prefMissing;

  if (reqTotal <= 0) return 0; // nothing to score

  const reqFrac = reqMatched / reqTotal;

  // If no preferred in JD → full 100 goes to requirements
  if (prefTotal === 0) {
    return Math.round(100 * reqFrac);
  }

  const prefFrac = prefMatched / prefTotal;

  // 80/20 split
  const score = (80 * reqFrac) + (20 * prefFrac);
  return Math.round(score);
}

/* ===================== API CALLS ===================== */
async function callMethod(method, job_text, resume_id) {
  const r = await fetchWithFailover(MATCH_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resume_id, job_description: job_text, method })
  });
  return r.json();
}

async function callBoth(job_text, resume_id){
  const [t, e] = await Promise.allSettled([
    callMethod("tfidf", job_text, resume_id),
    callMethod("embedding", job_text, resume_id)
  ]);
  const resT = t.status==="fulfilled" ? t.value : null;
  const resE = e.status==="fulfilled" ? e.value : null;
  if (!resT && !resE) throw new Error("Both matcher methods failed");
  return { tfidf: resT, embedding: resE };
}

/* ===================== CONTENT HELPERS ===================== */
function showNoResumesCard() {
  const card = document.getElementById("noResumesCard");
  const fillBtn = document.getElementById("fillForm");
  if (card) card.style.display = "block";

  // Fill Form stays enabled (auth is the only gate). We just show a warning.
  if (fillBtn) {
    fillBtn.title = "Upload a resume for best results (optional)";
  }
}

function hideNoResumesCard() {
  const card = document.getElementById("noResumesCard");
  const fillBtn = document.getElementById("fillForm");
  if (card) card.style.display = "none";
  if (fillBtn) { fillBtn.title = ""; }
}

function inferMimeFromFilename(filename = "") {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx"))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "";
}

// Timed warning message under the Apply Helper buttons when backend is down
let backendButtonsMsgTimer = null;

function clearBackendButtonsWarning() {
  const msgEl = document.getElementById("backendButtonsMessage");
  if (!msgEl) return;

  if (backendButtonsMsgTimer) {
    clearTimeout(backendButtonsMsgTimer);
    backendButtonsMsgTimer = null;
  }
  msgEl.textContent = "";
  msgEl.style.display = "none";
}

function showBackendButtonsWarning() {
  const msgEl = document.getElementById("backendButtonsMessage");
  if (!msgEl) return;

  // clear any previous timer
  if (backendButtonsMsgTimer) {
    clearTimeout(backendButtonsMsgTimer);
    backendButtonsMsgTimer = null;
  }

  // Message under the buttons
  msgEl.innerHTML =
    '⚠ Selected backend is offline. Use the toggle above to switch to a running version.' +
    ' <button id="backendButtonsRetry" class="btn" style="margin-left:4px;">Retry</button>';
  msgEl.style.display = "block";

  const retryInline = document.getElementById("backendButtonsRetry");
  if (retryInline) {
    retryInline.addEventListener(
      "click",
      async () => {
        retryInline.disabled = true;

        // Force a fresh probe of the selected backend
        const ok = await ensureBackendHealthy(true);
        if (ok) {
          clearBackendButtonsWarning();
          try {
            await preloadAndRestore();
            await autoMatch();
          } catch (e) {
            err("[popup] error after inline retry:", e);
          }
        } else {
          retryInline.disabled = false;
        }
      },
      { once: true }
    );
  }

  backendButtonsMsgTimer = setTimeout(() => {
    clearBackendButtonsWarning();
  }, 6000);
}

const isSupportedUrl = (u)=> /^https?:\/\//i.test(u)||/^file:\/\//i.test(u);
async function pingAny(tabId){
  return new Promise(res=>{
    chrome.tabs.sendMessage(tabId,{action:"ping"},pong=>{
      if(!chrome.runtime.lastError && pong && pong.ok) return res(true);
      res(false);
    });
  });
}

async function ensureContent(tabId){
  // 0) Read the tab url to see if we should even try injecting
  let url = "";
  try {
    const t = await chrome.tabs.get(tabId);
    url = t?.url || "";
  } catch {}

  const cls = (typeof classifyPageUrl === "function") ? classifyPageUrl(url) : { ok:true };
  if (!cls.ok) {
    // Don’t attempt injection on browser internals / extension pages / PDFs / blanks
    log("[popup] ensureContent: skip injection on", cls.reason, url);
    return false;
  }

  // 1) If content is already alive, we’re good
  if (await pingAny(tabId)) return true;

  // 2) Try to inject scripts (helpers first, then content)
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["helpers.js", "content.js"]
    });
  } catch (e) {
    const msg = e?.message || String(e);
    // These are expected when pages are not injectible; don’t treat as errors
    if (/Cannot access contents of url/i.test(msg) ||
        /extensions cannot inject into/i.test(msg)) {
      log("[popup] ensureContent: injection denied on", url, ":", msg);
      return false;
    }
    // Other unexpected errors — keep as errors
    err("inject helpers/content:", msg);
    return false;
  }

  // 3) One final ping to confirm
  return await pingAny(tabId);
}

async function getBestFrame(tabId){
  let frames=[];
  try{ frames = await chrome.webNavigation.getAllFrames({tabId}); }
  catch{ frames=[{frameId:0}]; }
  const scores = await Promise.all(frames.map(f=>new Promise(resolve=>{
    chrome.tabs.sendMessage(tabId,{action:"probe"},{frameId:f.frameId},resp=>{
      if(chrome.runtime.lastError||!resp||resp.ok!==true) return resolve({frameId:f.frameId,inputs:0});
      resolve({frameId:f.frameId,inputs:Number(resp.inputs)||0});
    });
  })));
  const best = scores.reduce((a,s)=> s.inputs>(a?.inputs||0)?s:a, null);
  return (best && best.inputs>0)? best.frameId : 0;
}
function sendToFrame(tabId, frameId, msg){
  return new Promise(resolve=>{
    chrome.tabs.sendMessage(tabId,msg,{frameId},resp=>{
      if(chrome.runtime.lastError) return resolve(null);
      resolve(resp);
    });
  });
}
async function sendToAllFrames(tabId, payload) {
  // Try to enumerate frames; fall back to top frame if API is unavailable
  let frames = [];
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {}
  if (!frames?.length) {
    const one = await sendToFrame(tabId, 0, payload);
    return [one];
  }
  const results = [];
  for (const f of frames) {
    const resp = await sendToFrame(tabId, f.frameId, payload);
    if (resp) results.push(resp);
  }
  return results;
}
async function runConsentBroadcast(tabId) {
  if (!await ensureContent(tabId)) return { ok:false, error:"content unreachable" };
  const resps = await sendToAllFrames(tabId, { action: "EXT_CHECK_CONSENT" });
  // merge results
  const merged = (resps || []).reduce((acc, r) => ({
    ok: acc.ok && (r?.ok !== false),
    tried: acc.tried + (r?.tried || 0),
    checked: acc.checked + (r?.checked || 0),
    total: acc.total + (r?.total || 0),
  }), { ok:true, tried:0, checked:0, total:0 });
  return merged;
}
// Send a specific list of predicted key skills; content will intersect with resume's matched skills
async function runPredictedKeySkillsPass(tabId, skills){
  try{
    if (!await ensureContent(tabId)) return { ok:false, error:"content unreachable" };
    const frameId = await getBestFrame(tabId);
    const unique = Array.from(new Set((skills||[]).map(s=>String(s).trim()).filter(Boolean)));
    const resp = await sendToFrame(tabId, frameId, {
      action: "EXT_CHECK_PREDICTED_KEY_SKILLS",
      skills: unique
    });
    log("[popup] predicted key-skills:", resp);
    return resp || { ok:false };
  }catch(e){
    err("[popup] predicted key-skills error:", e);
    return { ok:false, error:String(e) };
  }
}
async function getJobDescription(){
  const tab = await getActiveTab();
  if(!tab || !isSupportedUrl(tab.url||"")) return { jd:"", note:"no active http(s)/file tab" };
  if(!await ensureContent(tab.id)) return { jd:"", note:"content not reachable" };
  const frameId = await getBestFrame(tab.id);
  const res = await sendToFrame(tab.id, frameId, { action:"EXT_GET_JOB_DESC" });
  if(res && res.ok && res.jd) return { jd: res.jd, note: "detected from page" };
  return { jd:"", note:"no JD found" };
}

/* ===================== RESUME STORAGE ===================== */
async function loadAllResumesFromBackend(){
  // Never load resumes in v2 while signed out (prevents resolver fallback to v1 local).
  if (isV2SignedOut()) return [];

  // If we've already decided the backend is down, don't even try again
  if (BACKEND_AVAILABLE === false) {
    return [];
  }

  try {
    const r = await fetchWithFailover("/resumes");
    const data = await r.json();

    BACKEND_AVAILABLE = true; // mark as healthy

    return (data.items || []).map(it => ({
      id:        it.id,
      name:      it.original_name,
      createdAt: it.created_at
    }));
  } catch (e) {
    // 403 means "forbidden" (usually v2 signed out). Do NOT mark backend offline.
    if (e.status === 403) {
      BACKEND_AVAILABLE = true;

      const statusEl = document.getElementById("status");
      if (statusEl) {
        statusEl.textContent =
          (CURRENT_BACKEND === "v2")
            ? "Sign in to load your resumes."
            : "Resume list unavailable (403).";
      }
      return [];
    }

    // Network failures: treat as unavailable
    if (e.kind === "network" || e.status === 0) {
      BACKEND_AVAILABLE = false;

      const statusEl = document.getElementById("status");
      if (statusEl) {
        statusEl.textContent =
          "Smart Form Filler API is offline or unavailable. " +
          "Start the backend if you want resume matching.";
      }

      // Quietly fall back to "no resumes" (and no noisy console error)
      console.warn("[popup] backend /resumes unavailable:", e.message || e);
      return [];
    }

    // Other unexpected HTTP errors: log once but still don't blow up the UI
    console.error("[popup] backend /resumes error:", e);

    const statusEl = document.getElementById("status");
    if (statusEl) {
      statusEl.textContent =
        "❌ Error talking to Smart Form Filler API. See console for details.";
    }

    return [];
  }
}

async function getLastResumeId(){
  return (await chrome.storage.local.get("lastResumeId")).lastResumeId || null;
}
async function setLastResumeId(id){
  try{ await chrome.storage.local.set({ lastResumeId:id }); }catch{}
}
function fmtDateTime(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "2-digit"
    });
  } catch {
    return "unknown date";
  }
}

// helpers to set month/year pairs
function setMonthYearPair(label, monthStr, yearStr, root=document) {
  const monthEl = [...root.querySelectorAll('select, input')].find(e => /start\s*month/i.test(getLabelText(e)));
  const yearEl  = [...root.querySelectorAll('select, input')].find(e => /start\s*year/i.test(getLabelText(e)));
  if (monthEl && monthStr) setSelectValueSmart(monthEl, monthStr);      // accepts 2, 02, Feb, February
  if (yearEl  && yearStr)  setSelectValueSmart(yearEl,  yearStr);
}
function setEndMonthYearPair(monthStr, yearStr, root=document) {
  const monthEl = [...root.querySelectorAll('select, input')].find(e => /end\s*month/i.test(getLabelText(e)));
  const yearEl  = [...root.querySelectorAll('select, input')].find(e => /end\s*year/i.test(getLabelText(e)));
  if (monthEl && monthStr) setSelectValueSmart(monthEl, monthStr);
  if (yearEl  && yearStr)  setSelectValueSmart(yearEl,  yearStr);
}

// Persist selected resume, fetch keyword skills, mirror to backend profile, and cache locally.
async function setSelectedResumeById(resumeId, resumeName){
  try {
    // 1) Get skills for this resume
    const r = await fetchWithFailover(`/skills/by_resume`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ resumeId })
    });    
    const j = await r.json();
    const skills = Array.isArray(j.skills) ? j.skills : [];
    const name   = resumeName || j.name || String(resumeId) || "";

    // 2) Cache locally so popup/content can use immediately
    await chrome.storage.local.set({
      lastResumeId: resumeId,
      selectedResume: { id: resumeId, name, skills }
    });

    // 3) Read current profile first, then PATCH the full merged object
    //    (v2 can error on partial PATCH shapes; full merge is safest for v1 + v2)
    let currentProfile = null;
    try {
      const pr = await fetchWithFailover(`/profile`);
      currentProfile = await pr.json();
    } catch (_) {
      console.warn("[popup] GET /profile failed; skip PATCH to avoid corrupting profile.json");
      console.log("[popup] Cached selection locally only.");
      return;
    }

    if (!currentProfile || typeof currentProfile !== "object") currentProfile = {};

    // 4) Merge selection into the existing profile and PATCH the full object
    currentProfile.selectedResumeId = String(resumeId || "");
    currentProfile.selectedResumeName = String(name || "");
    currentProfile.selectedResumeSkills = Array.from(new Set(skills)).sort();

    await fetchWithFailover(`/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentProfile)
    });

    console.log("[popup] selectedResume updated with skills:", resumeId, skills.length);
  } catch (e) {
    console.error("[popup] setSelectedResumeById failed:", e);
  }
}

/* ============= INLINE RESUME PICKER IN FILLER CARD (always visible) ============= */
function ensureInlineResumePicker(resumes){
  // In v2 signed-out, do not show the resume picker at all.
  if (isV2SignedOut()) {
    const host = document.getElementById("resumeInlineHost");
    if (host) host.style.display = "none";
    return;
  }  
  const controls = document.getElementById("controls");
  if (!controls) return;
  let host = document.getElementById("resumeInlineHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "resumeInlineHost";
    host.style.display = "flex";
    host.style.flexDirection = "column";
    host.style.gap = "6px";
    host.style.width = "100%";
    host.style.margin = "4px 0 2px 0";
    const title = document.createElement("div");
    title.textContent = "Resume";
    title.style.fontSize = "12px";
    title.style.color = "#6b7280";
    const sel = document.createElement("select");
    sel.id = "resumeInline";
    sel.style.width = "100%";
    sel.style.padding = "6px";
    sel.style.border = "1px solid #e5e7eb";
    sel.style.borderRadius = "6px";
    const hint = document.createElement("div");
    hint.id = "resumeInlineHint";
    hint.className = "muted";
    hint.textContent = "Defaults to your last choice.";
    controls.parentNode.insertBefore(host, controls);
    host.appendChild(title);
    host.appendChild(sel);
    host.appendChild(hint);
  }
  const sel = document.getElementById("resumeInline");
  if (!sel) return;
  sel.innerHTML = "";
  resumes.forEach(r=>{
    const o = document.createElement("option");
    o.value = r.id || r.name;
    o.textContent = r.name || r.id || "(untitled)";
    sel.appendChild(o);
  });
  (async () => {
    const lastId = await getLastResumeId();
    if (lastId && [...sel.options].some(o => o.value === lastId)) {
      sel.value = lastId;
    } else {
      sel.value = sel.options[0]?.value || "";
      await setLastResumeId(sel.value);
    }
  })();
  sel.addEventListener("change", async (e) => {
    const id = e.target.value;
    const name = e.target.options[e.target.selectedIndex]?.textContent || id || "";
    await setLastResumeId(id);
    if (!id) {
      await chrome.storage.local.set({
        lastResumeId: "",
        selectedResume: { id:"", name:"", skills:[] }
      });
      return;
    }
    await setSelectedResumeById(id, name);
  });

}

/* ===================== MATCHER: AUTO RUN ON OPEN (Week-6 multi-resume) ===================== */
async function autoMatch(){
  // Hook UI
  elsM.arc = document.getElementById("arc");
  elsM.scoreNum = document.getElementById("scoreNum");
  // FIX: your popup.html uses id="jdHint2"
  elsM.hint = document.getElementById("jdHint2"); 
  elsM.status = document.getElementById("matchStatus");
  const matchCard = document.getElementById("matchCard");
  const hideMatch = () => { if(matchCard) matchCard.style.display = "none"; };
  const showMatch = () => { if(matchCard) matchCard.style.display = ""; };

  // v2 signed-out: never match, never load resumes (prevents v1 fallback content).
  if (isV2SignedOut()) {
    hideMatch();
    const suggestor = document.getElementById("resumeSuggestorCard");
    if (suggestor) suggestor.style.display = "none";
    resetSignedOutV2UI();
    return;
  }
  
  // Default state
  setArc(0);
  if (elsM.hint) elsM.hint.textContent = "detecting…";
  if (elsM.status) elsM.status.textContent = "";

  // BACKEND HEALTH GATE: never hit /resumes if backend isn't healthy
  if (BACKEND_AVAILABLE === false) {
    hideMatch();
    showNoResumesCard();
    return;
  }
  if (BACKEND_AVAILABLE === null) {
    const ok = await ensureBackendHealthy();
    if (!ok) {
      hideMatch();
      showNoResumesCard();
      return;
    }
  }

  // Ensure resumes + inline picker (always visible)
  const resumes = await loadAllResumesFromBackend();
  if (!resumes.length){
    showNoResumesCard();
    // keep inline picker empty (if you show it at all)
    ensureInlineResumePicker([]);
    return;
  }
  hideNoResumesCard();
  ensureInlineResumePicker(resumes);

  // Read JD
  const { jd, note } = await getJobDescription();
  const jdTokens = Array.from(new Set((jd || "").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || []));
  const jdKeys = jdTokens.filter(w => SKILL_WORDS.has(w));
  const hasRealJD = (jd && jd.trim().length >= 180) && (jdKeys.length >= 2);

  if (!hasRealJD) {
    hideMatch();
    // also hide resume suggestor
    const suggestor = document.getElementById("resumeSuggestorCard");
    if (suggestor) suggestor.style.display = "none";
    return;
  }

  showMatch();
  if (elsM.hint) elsM.hint.textContent = note || "detected from page";

  try {
    // For each resume → run both methods → normalize → compute display score → choose best
    let best = null;
    for (const r of resumes) {
      // IMPORTANT: pass resume_id (not text)
      const both = await callBoth(jd, r.id);
      const nT = both.tfidf ? normalizeMatchResponse(both.tfidf, jd) : null;
      const nE = both.embedding ? normalizeMatchResponse(both.embedding, jd) : null;

      const have = [nT?.scorePct, nE?.scorePct].filter(v => typeof v === "number");
      const apiBase = have.length ? Math.round(have.reduce((a,b)=>a+b,0)/have.length) : 0; // 0..100
      const missingUnion = Array.from(new Set([...(nT?.missingClean||[]), ...(nE?.missingClean||[])]));

      const dispScore = computeDisplayScore({
        apiBasePct: apiBase,
        jdText: jd,
        missing: missingUnion
      });

      if (!best || dispScore > best.score) {
        best = { resume: r, score: dispScore, missing: missingUnion, apiBase };
      }
    }

    if (!best) { hideMatch(); return; }

    // Render best score & buckets
    setArc(best.score);
    renderBucketsIntoUI(computeBucketsFromJDAndMissing(jd, best.missing || []));

    // FIX: backend resumes have createdAt (ISO string); fall back if missing
    if (elsM.status) {
      const when = best.resume.createdAt ? Date.parse(best.resume.createdAt) : Date.now();
      elsM.status.textContent = `Using: ${best.resume.name || best.resume.id} · uploaded ${fmtDateTime(when)}`;
    }

    // Resume Suggestor card dropdown
    const dd = document.getElementById("resumeSelect");
    const chosenEl   = document.getElementById("chosenResume");
    const chosenSc   = document.getElementById("chosenScore");
    const selectedEl = document.getElementById("selectedResume");
    const selectedSc = document.getElementById("selectedScore");
    const resumeStatusEl = document.getElementById("resumeStatus");

    if (dd) {
      dd.innerHTML = "";
      resumes.forEach(r => {
        const o = document.createElement("option");
        o.value = r.id;                                   // FIX: value = id
        o.textContent = r.name || r.id || "(untitled)";
        dd.appendChild(o);
      });

      dd.value = best.resume.id;
      const _bestPct = Math.max(0, Math.min(100, Number(best.score) || 0));

      if (chosenEl)   chosenEl.textContent   = best.resume.name || best.resume.id || "(untitled)";
      if (chosenSc)   chosenSc.textContent   = `Match: ${_bestPct}%`;
      if (selectedEl) selectedEl.textContent = best.resume.name || best.resume.id || "(untitled)";
      if (selectedSc) selectedSc.textContent = `Match: ${_bestPct}%`;
      if (resumeStatusEl) resumeStatusEl.textContent = "Suggested resume selected. Change to compare.";

      dd.addEventListener("change", async () => {
        const sel = resumes.find(r => r.id === dd.value); // FIX: match by id
        if (!sel) return;
        try {
          if (resumeStatusEl) resumeStatusEl.textContent = "Scoring selected resume…";

          // IMPORTANT: pass resume_id for selection too
          const both = await callBoth(jd, sel.id);
          const nT = both.tfidf     ? normalizeMatchResponse(both.tfidf, jd)     : null;
          const nE = both.embedding ? normalizeMatchResponse(both.embedding, jd) : null;

          const have = [nT?.scorePct, nE?.scorePct].filter(v => typeof v === "number");
          const apiBase = have.length ? Math.round(have.reduce((a,b)=>a+b,0)/have.length) : 0;
          const missingUnion = Array.from(new Set([...(nT?.missingClean||[]), ...(nE?.missingClean||[])]));

          const dispScore = computeDisplayScore({ apiBasePct: apiBase, jdText: jd, missing: missingUnion });
          setArc(dispScore);

          // Re-render side-by-side buckets for the selection
          renderBucketsIntoUI(computeBucketsFromJDAndMissing(jd, missingUnion));

          if (elsM.status) {
            const when = sel.createdAt ? Date.parse(sel.createdAt) : Date.now();
            elsM.status.textContent = `Using: ${sel.name || sel.id} · uploaded ${fmtDateTime(when)}`;
          }
          if (selectedEl)  selectedEl.textContent  = sel.name || sel.id || "(untitled)";
          const _selPct = Math.max(0, Math.min(100, Number(dispScore) || 0));
          if (selectedSc)  selectedSc.textContent  = `Match: ${_selPct}%`;
          if (resumeStatusEl) resumeStatusEl.textContent = "Done.";
          await setSelectedResumeById(sel.id, sel.name || sel.id);
        } catch (e) {
          console.error("[popup] resumeSelect error:", e);
          if (resumeStatusEl) resumeStatusEl.textContent = "Error scoring selection.";
        }
      });
    }
  } catch (e) {
    console.error("[popup] matcher error:", e);
    if (elsM.hint) elsM.hint.textContent = "Matcher unavailable";
    if (elsM.status) elsM.status.textContent = "Could not reach /match. Check API port and host_permissions.";
    setArc(0);
  }
}

/* ===================== FILLER (Week-5 kept) ===================== */
const statusEl = document.getElementById("status");
const filledBox = document.getElementById("filledFields");
const notFilledBox = document.getElementById("notFilledFields");
const filledToggle = document.getElementById("filledToggle");
const notFilledToggle = document.getElementById("notFilledToggle");
const detectedToggle = document.getElementById("detectedToggle");
const detectedBox    = document.getElementById("detectedFields");
const detectedHint   = document.getElementById("detectedHint");
const detectedList   = document.getElementById("detectedList");

// Catalog shown if page has none
const LOCAL_CATALOG = [
  { key: "fullName", label: "Full Name" },
  { key: "firstName", label: "First Name" },
  { key: "lastName", label: "Last Name" },
  { key: "gender", label: "Gender" },
  { key: "dob", label: "Date of Birth" },
  { key: "phoneNumber", label: "Phone Number" },
  { key: "email", label: "Email" },
  { key: "street", label: "Street" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "Zip" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "github", label: "GitHub" },
  { key: "education", label: "Education" },
  { key: "work_auth", label: "Work Authorization" },
  { key: "document", label: "Resume/Document Upload" }
];

// Per-page state keys
function pageKeyFromUrl(u){ try{ const x=new URL(u); return `${x.origin}${x.pathname}`; } catch{ return u||"unknown"; } }
function keyify(s){ return `sff:${s.replace(/[^a-z0-9]+/gi,"_")}`; }
function stateKeysFor(url){ const base=keyify(pageKeyFromUrl(url)); return { lastKey:`${base}:last`, toggKey:`${base}:toggles` }; }
async function loadState(url){ const {lastKey,toggKey}=stateKeysFor(url); const all=await chrome.storage.local.get([lastKey,toggKey]); return { last: all[lastKey]||null, toggles: all[toggKey]||null }; }
async function saveLast(url,lastObj){ const {lastKey}=stateKeysFor(url); await chrome.storage.local.set({ [lastKey]: lastObj }); }
async function saveToggles(url,tog){ const {toggKey}=stateKeysFor(url); await chrome.storage.local.set({ [toggKey]: tog }); }

// UI utilities
const setStatus = (msg) => {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
};

// --- flash status (auto-clear after a moment, then show an "after" message) ---
let _statusTimer = null;
function flashStatus(msg, ms = 2500, after = "") {
  const el = document.getElementById("status");
  if (!el) return;

  el.textContent = msg;

  if (_statusTimer) clearTimeout(_statusTimer);
  _statusTimer = setTimeout(() => {
    const el2 = document.getElementById("status");
    if (!el2) return;
    // Only replace if nobody changed the status in the meantime
    if (el2.textContent === msg && after) {
      el2.textContent = after;
    }
  }, ms);
}

// --- make Try Again match Fill Form (with graceful fallback) ---
function harmonizeTryAgainStyle() {
  const fill  = document.getElementById("fillForm");
  const retry = document.getElementById("tryAgain");
  if (!fill || !retry) return;

  // Copy classes if Fill Form has them
  if (fill.className) retry.className = fill.className;

  // Minimal pretty fallback if no shared classes exist
  if (!fill.className) {
    retry.style.cssText = [
      "display:inline-flex","align-items:center","gap:6px",
      "padding:8px 12px","border-radius:8px","border:1px solid #e5e7eb",
      "background:#111827","color:#fff","font-weight:600","cursor:pointer"
    ].join(";");
  }

  // Add a simple icon if none present
  if (!retry.dataset.styled) {
    retry.dataset.styled = "1";
    retry.innerHTML = `<span aria-hidden="true"></span><span>Try Again</span>`;
  }
}

function installToggle(headerEl, contentEl, initiallyOpen, onChange){
  const set=(open)=>{ contentEl.style.display=open?"block":"none";
    const title=headerEl.textContent.replace(/^[▶▼]\s*/,"");
    headerEl.textContent=(open?"▼ ":"▶ ")+title; onChange?.(open);
  };
  let open=initiallyOpen; set(open);
  headerEl.addEventListener("click",()=>{ open=!open; set(open); });
}

// Confidence helpers
const CONF_THRESH={ good:0.8, ok:0.5 };
function parseConfidence(c){
  // Returns a 0..1 number or null
  if (c == null || c === "N/A") return null;
  if (typeof c === "number") return c;                 // assume 0..1 or 0..100? handled below
  const s = String(c).trim();
  if (s.endsWith("%")) {                               // "14%" -> 0.14
    const n = parseFloat(s);
    return Number.isFinite(n) ? (n/100) : null;
  }
  const n = parseFloat(s);                              // "0.14" or "14"
  if (!Number.isFinite(n)) return null;
  return n > 1 ? (n/100) : n;                           // 14 -> 0.14 ; 0.14 -> 0.14
}
function fmtPct(x){
  const n = parseConfidence(x);
  return n == null ? null : Math.round(n * 100);        // -> integer percent or null
}
function confClass(conf){ if(conf==null||conf==="N/A") return "na"; if(conf>=CONF_THRESH.good) return "good"; if(conf>=CONF_THRESH.ok) return "ok"; return "low"; }

// --- helper: only count items that were actually set/checked as "filled"
function isTrulyFilled(f) {
  if (!f) return false;

  const hasExplicitFillFlag =
    f.status === "filled" || f.changed === true || f.didSet === true;

  const val = (f.value == null) ? "" : String(f.value).trim();
  const hasMeaningfulValue = !!val && val.toLowerCase() !== "unchecked";

  const t = (f.inputType || f.type || f.kind || "").toLowerCase();
  const isCheckboxLike = /checkbox|radio/.test(t) || f.kind === "checkbox";

  // checkboxes/radios must have been toggled; text-like fields can pass with a value
  return isCheckboxLike ? hasExplicitFillFlag : (hasExplicitFillFlag || hasMeaningfulValue);
}

// Render field cards (shared by Filled + Non-Filled)
function renderFieldList(container, items, { title = "", showSummary = true, mode } = {}) {
  container.innerHTML = "";

  // Summary row with average (numbers only)
  if (showSummary) {
    const n = items?.length || 0;
    let avg = null, count = 0;
    (items || []).forEach(it => {
      if (typeof it.confidence === "number") { avg = (avg || 0) + it.confidence; count++; }
    });
    if (count > 0) avg = Math.round((avg / count) * 100);
    const summary = document.createElement("div");
    summary.className = "list-summary";
    summary.innerHTML = `<div>${title}</div><div>${n} item${n!==1?"s":""}${avg!=null ? ` · avg ${avg}%` : ""}</div>`;
    container.appendChild(summary);
  }

  (items||[]).forEach((f)=>{
    const confNorm = parseConfidence(f.confidence);               // 0..1 or null
    const confPct  = fmtPct(f.confidence);                        // 0..100 int or null
    const cls      = confClass(confNorm != null ? confNorm : "N/A");
    const inFilledSection    = (mode === "filled");
    const inNonFilledSection = (mode === "nonfilled");
    const showAsFilled       = inFilledSection || (confPct != null && confPct > 0);
    
    const card=document.createElement("div"); card.className="field-item";
    const label=document.createElement("div"); label.className="label"; label.textContent=f.label;

    const badge=document.createElement("span"); 
    badge.className = "badge" + (showAsFilled ? "" : " na");
    // If we know the section, state it explicitly; otherwise fall back to confidence-based guess
    badge.textContent = inFilledSection
        ? "Filled"
        : inNonFilledSection
          ? "Not filled"
          : (showAsFilled ? "Filled" : "N/A");         // for Non-Filled we’ll fix this text after render
    label.appendChild(document.createTextNode(" "));
    label.appendChild(badge);
    
    const chipEl=document.createElement("div"); 
    chipEl.className="chip"; 
    chipEl.textContent = confPct != null ? `Confidence ${confPct}%` : "Confidence N/A";

    const meter=document.createElement("div"); 
    meter.className="meter"; 
    const bar=document.createElement("span"); 
    bar.className=cls; 
    bar.style.width = (confPct != null ? confPct : 0) + "%";       // keep real % if present
    meter.appendChild(bar);

    card.appendChild(label); 
    card.appendChild(chipEl); 
    card.appendChild(meter);

    if(f.value){ 
      const val=document.createElement("div"); 
      val.className="value"; 
      val.textContent=String(f.value); 
      card.appendChild(val); 
    }
    container.appendChild(card);
  });
}

function forceNonFilledBadges(container){
  if (!container) return;
  container.querySelectorAll('.field-item .label .badge').forEach(badge=>{
    badge.textContent = 'Not filled';
    badge.classList.add('na');
    badge.classList.remove('good','ok','low');
  });
}

function renderDetected(container, arr){
  if (!container) return;
  if (!Array.isArray(arr) || arr.length === 0) {
    container.innerHTML = `<div class="muted">None.</div>`;
    return;
  }
  container.innerHTML = arr.map(it => {
    const label = (it.label || it.key || "(unknown)").trim();
    // Same card shell as others, but label only (no chip/meter for Detected)
    return `
      <div class="field-item">
        <div class="label">${label}</div>
      </div>
    `;
  }).join("");
}

async function preloadAndRestore(){
  const tab = await getActiveTab();
  if (!tab) { setStatus("❌ No active tab."); return; }

  // v2 signed-out: do not preload resumes or restore UI state.
  if (isV2SignedOut()) {
    resetSignedOutV2UI();
    setStatus("Not signed in.");
    return;
  }  

  // BACKEND HEALTH GATE: don't even try /resumes if backend is down
  if (BACKEND_AVAILABLE === false) {
    return;
  }
  if (BACKEND_AVAILABLE === null) {
    const ok = await ensureBackendHealthy();
    if (!ok) return;
  }
  
  // Keep inline resume picker available
  const resumes = await loadAllResumesFromBackend();
  ensureInlineResumePicker(resumes);

  // Always fresh on popup open (BucketUI handles detection + seeding)
  setStatus("Ready.");

  // Reset Fill Form / Try Again buttons whenever we reload for a backend change
  const tryBtn = document.getElementById("tryAgain");
  const fillBtn = document.getElementById("fillForm");
  if (tryBtn) tryBtn.style.display = "none";
  if (fillBtn) fillBtn.style.display = "inline-block";

  // IMPORTANT: Do NOT touch Detected/Filled/Non-Filled lists or their headers here.
  // BucketUI (the IIFE at the top) handles detection, seeding, and counts.
}

async function renderResultsAndRemember(url, resp, statusText){
  const rawFilled   = Array.isArray(resp.filled) ? resp.filled.slice() : [];
  const trulyFilled = rawFilled.filter(isTrulyFilled);
  
  // Move-back items: keep their confidence (parse if string)
  const movedBack = rawFilled
    .filter(f => !isTrulyFilled(f))
    .map(f => ({
      key:   f.key || null,
      label: f.label || "(Unknown)",
      confidence: parseConfidence(f.confidence) ?? "N/A"   // preserve numeric if present
    }));
  
  const nonFilledBase = Array.isArray(resp.notFilled)
    ? resp.notFilled.map(({key,label,confidence}) => ({
        key, label,
        confidence: parseConfidence(confidence) ?? "N/A"    // preserve numeric if present
      }))
    : [];  

  const nonFilled = nonFilledBase.concat(movedBack);

  // Render
  trulyFilled.sort((a,b)=>(Number(a.confidence)||0)-(Number(b.confidence)||0));
  renderFieldList(filledBox,    trulyFilled, { title:"Filled",     mode:"filled"    });
  renderFieldList(notFilledBox, nonFilled,   { title:"Non-Filled", mode:"nonfilled" });
  forceNonFilledBadges(notFilledBox);
  if (statusText && /^✅/.test(statusText)) {
    flashStatus(statusText, 2600, " Ready.");
  } else {
    setStatus(statusText);
  }  
  
  // cache confidences so a later rescan can restore chip + meter
  try {
    const confCache = { bySelector: {}, byKey: {}, byLabel: {} };
    const add = (arr=[]) => arr.forEach(f => {
      const c = (typeof f.confidence === "number") ? f.confidence : parseConfidence(f.confidence);
      if (f?.selector) confCache.bySelector[f.selector] = c;
      if (f?.key)      confCache.byKey[f.key]           = c;
      const lbl = (f?.label || "").trim();
      if (lbl)         confCache.byLabel[lbl]           = c;
    });
    add(Array.isArray(resp.filled)    ? resp.filled    : []);
    add(Array.isArray(resp.notFilled) ? resp.notFilled : []);
    await chrome.storage.local.set({ sffConfCache: confCache });
  } catch (e) {
    console.warn("[popup] conf cache save failed:", e);
  }

  // Update headers (counts)
  try{
    const detectedCount =
      (Array.isArray(window.SFF_DETECTED) && window.SFF_DETECTED.length) ||
      (detectedList?.children?.length || 0) ||
      Number(resp?.inputs) ||
      (trulyFilled.length + nonFilled.length);

    if (detectedToggle && detectedBox) {
      const open = detectedBox.style.display !== "none";
      detectedToggle.dataset.base = "Detected Fields";
      detectedToggle.dataset.count = String(detectedCount);
      detectedToggle.textContent = `${open ? "▼" : "▶"} Detected Fields (${detectedCount})`;
    }
    if (filledToggle && filledBox) {
      const openF = filledBox.style.display !== "none";
      filledToggle.dataset.base = "Filled Fields";
      filledToggle.dataset.count = String(trulyFilled.length);
      filledToggle.textContent = `${openF ? "▼" : "▶"} Filled Fields (${trulyFilled.length})`;
    }
    if (notFilledToggle && notFilledBox) {
      const openNF = notFilledBox.style.display !== "none";
      notFilledToggle.dataset.base = "Non-Filled Fields";
      notFilledToggle.dataset.count = String(nonFilled.length);
      notFilledToggle.textContent = `${openNF ? "▼" : "▶"} Non-Filled Fields (${nonFilled.length})`;
    }
  }catch{}

  try{
    const low = trulyFilled.filter(f => typeof f.confidence==="number" && f.confidence<0.5).length;
    const summary = { timestamp:Date.now(), filledCount:trulyFilled.length||0, totalDetected:(resp?.inputs??0), lowConfidence:low };
    chrome.storage.local.set({ fillerRun: summary });
  }catch{}
}

/* ===================== INIT (backend-aware) ===================== */
document.addEventListener("DOMContentLoaded", () => {
  const matchCard      = document.getElementById("matchCard");
  const suggestorCard  = document.getElementById("resumeSuggestorCard");
  const statusEl       = document.getElementById("status");
  const retryBtn       = document.getElementById("retryConnectionBtn");
  const backendToggleMsg =
    document.getElementById("backendToggleMessage");
  
    // --- Auth UI elements (profile strip at top of popup) ---
    const authStatusLabel = document.getElementById("authStatusLabel");
    const authAvatar = document.getElementById("authAvatar");
    const authShowFormBtn = document.getElementById("authShowFormBtn");
    const authLogoutBtn = document.getElementById("authLogoutBtn");
    const authMenu = document.getElementById("authMenu");
    const authMenuProfileBtn = document.getElementById("authMenuProfileBtn");
    const authMenuLogoutBtn = document.getElementById("authMenuLogoutBtn");
    const authFormCard = document.getElementById("authFormCard");
    const authUsernameInput = document.getElementById("authUsername");
    const authEmailInput = document.getElementById("authEmail");
    const authFirstNameInput = document.getElementById("authFirstName");
    const authLastNameInput = document.getElementById("authLastName");
    const authRegisterFields = document.getElementById("authRegisterFields");
    const authConfirmPasswordField = document.getElementById("authConfirmPasswordField");
    const authPasswordInput = document.getElementById("authPassword");    
    const authPasswordConfirmInput = document.getElementById("authPasswordConfirm");
    const authShowPasswordBtn = document.getElementById("authShowPasswordBtn");
    const authShowPasswordConfirmBtn = document.getElementById("authShowPasswordConfirmBtn");
    const authLoginBtn = document.getElementById("authLoginBtn");
    const authCancelBtn = document.getElementById("authCancelBtn");
    const authErrorMsg =
    document.getElementById("authErrorMsg") || document.getElementById("authError");
  
    // Make it globally available so any legacy references don't crash
    window.authErrorMsg = authErrorMsg;
    window.authError = authErrorMsg;
    // --- Auth mode (login vs register) ---
    const authCardTitle = document.getElementById("authCardTitle");
    const authCardSubtitle = document.getElementById("authCardSubtitle");
    const authModeHelpText = document.getElementById("authModeHelpText");
    const authModeToggleBtn = document.getElementById("authModeToggleBtn");

    let AUTH_MODE = "login"; // "login" | "register"

    function setPasswordVisible(inputEl, btnEl, visible) {
      if (!inputEl || !btnEl) return;
      inputEl.type = visible ? "text" : "password";
      btnEl.textContent = visible ? "Hide" : "Show";
    }
    
    let _pwVisible = false;
    let _pwConfirmVisible = false;
    
    authShowPasswordBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      _pwVisible = !_pwVisible;
      setPasswordVisible(authPasswordInput, authShowPasswordBtn, _pwVisible);
    });
    
    authShowPasswordConfirmBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      _pwConfirmVisible = !_pwConfirmVisible;
      setPasswordVisible(authPasswordConfirmInput, authShowPasswordConfirmBtn, _pwConfirmVisible);
    });
    
    function renderAuthMode() {
      const isRegister = AUTH_MODE === "register";

      if (authCardTitle) authCardTitle.textContent = isRegister ? "Create your account" : "Sign in to Smart Form Filler";
      if (authCardSubtitle) authCardSubtitle.textContent = isRegister
        ? "Create an account to save your profile and resumes."
        : "Use the same account across jobs and browsers.";

      if (authLoginBtn) authLoginBtn.textContent = isRegister ? "Create account" : "Sign in";
      if (authModeHelpText) authModeHelpText.textContent = isRegister ? "Already have an account?" : "No account?";
      if (authModeToggleBtn) authModeToggleBtn.textContent = isRegister ? "Sign in" : "Create account";

      if (authErrorMsg) authErrorMsg.textContent = "";

      if (authRegisterFields) authRegisterFields.style.display = isRegister ? "" : "none";
      if (authConfirmPasswordField) authConfirmPasswordField.style.display = isRegister ? "" : "none";
      
      // Better autocomplete behavior
      if (authPasswordInput) authPasswordInput.autocomplete = isRegister ? "new-password" : "current-password";
      if (authPasswordConfirmInput) authPasswordConfirmInput.autocomplete = "new-password";
      
      // Reset confirm + visibility toggles when switching modes
      _pwVisible = false;
      _pwConfirmVisible = false;
      setPasswordVisible(authPasswordInput, authShowPasswordBtn, false);
      setPasswordVisible(authPasswordConfirmInput, authShowPasswordConfirmBtn, false);
      
      if (authPasswordConfirmInput) authPasswordConfirmInput.value = "";
    }

    authModeToggleBtn?.addEventListener("click", () => {
      AUTH_MODE = AUTH_MODE === "login" ? "register" : "login";
      renderAuthMode();
    });

    renderAuthMode();

    // --- Onboarding gate (Phase D) ---
    const onboardingGate = document.getElementById("onboardingGate");
    const onboardingGateText = document.getElementById("onboardingGateText");
    const completeSetupBtn = document.getElementById("completeSetupBtn");

    // Fill buttons to disable when onboarding is incomplete
    const fillFormBtn = document.getElementById("fillForm"); // main button
    const btnFillDebug = document.getElementById("btnFill"); // debug fill button

    function setFillButtonsEnabled(enabled, reason) {
      const title = enabled ? "" : (reason || "Complete setup first.");
      for (const btn of [fillFormBtn, btnFillDebug]) {
        if (!btn) continue;
        btn.disabled = !enabled;
        btn.title = title;
      }
    }

    function applyOnboardingGate(show, text = "") {
      if (!onboardingGate) return;
      onboardingGate.style.display = show ? "block" : "none";
      if (onboardingGateText) onboardingGateText.textContent = text || "";
      // IMPORTANT: do NOT disable Fill Form here anymore (auth is the only gate)
    }
    
    function refreshOnboardingGate() {
      // Only show warnings for v2
      if (CURRENT_BACKEND !== "v2") {
        applyOnboardingGate(false, "");
        return;
      }
    
      // Only gate for v2 is auth
      if (!_isAuthenticated) {
        applyOnboardingGate(true, "Sign in to use Fill Form.");
        setFillButtonsEnabled(false, "Sign in required");

        // IMPORTANT: never show "Complete setup" while signed out (it routes to dashboard)
        if (completeSetupBtn) completeSetupBtn.style.display = "none";

        return;
      }

      // Signed in v2: allow button (if you still want it)
      if (completeSetupBtn) completeSetupBtn.style.display = "";
    
      // Ask background for onboarding status (popup does NOT have callApi)
      chrome.runtime.sendMessage({ action: "onboarding.status" }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          // don’t block if something transient happens
          applyOnboardingGate(false, "");
          setFillButtonsEnabled(true, "");
          return;
        }
    
        // backend down is still a real blocker for v2 usage
        if (resp.backendUp === false) {
          applyOnboardingGate(true, "FastAPI v2 is not running. Start it or switch to v1.");
          setFillButtonsEnabled(false, "Backend v2 offline");
          return;
        }
    
        // profile/resume are warnings only (no blocking)
        const warnings = [];
        if (resp.hasResume === false) warnings.push("Upload a resume for best results (optional).");
        if (resp.hasProfile === false) warnings.push("Fill profile info for best results (optional).");
    
        if (warnings.length) applyOnboardingGate(true, `Optional: ${warnings.join(" ")}`);
        else applyOnboardingGate(false, "");
    
        setFillButtonsEnabled(true, "");
      });
    }    

    completeSetupBtn?.addEventListener("click", () => {
      // Open the Profile Dashboard (normal mode)
      const url = chrome.runtime.getURL("profile_dashboard.html");
      try {
        chrome.tabs.create({ url });
      } catch {
        window.open(url, "_blank");
      }
    });    
  
    // Ask background who we are (if token exists) and update UI
    function refreshAuthState() {
      // Return a Promise so callers can await “auth is known” before running preload/match.
      return new Promise((resolve) => {
        if (!chrome?.runtime?.sendMessage) {
          resolve();
          return;
        }
    
        // ===== v1 (Local / Legacy) =====
        if (CURRENT_BACKEND !== "v2") {
          POPUP_IS_AUTHENTICATED = true;
          _isAuthenticated = true;
    
          closeAuthMenu();
    
          if (authStatusLabel) authStatusLabel.textContent = "Local profile (stored on this computer)";
          if (authAvatar) {
            authAvatar.textContent = "L";
            authAvatar.style.display = "flex";
          }
    
          if (authShowFormBtn) authShowFormBtn.style.display = "none";
          if (authFormCard) authFormCard.style.display = "none";
          if (authLogoutBtn) authLogoutBtn.style.display = "none";
          if (authMenuLogoutBtn) authMenuLogoutBtn.style.display = "none";
          if (authMenuProfileBtn) authMenuProfileBtn.style.display = "";
    
          // In v1, show Apply controls (local mode)
          const controls = document.getElementById("controls");
          if (controls) controls.style.display = "flex";
          const inlineHost = document.getElementById("resumeInlineHost");
          if (inlineHost) inlineHost.style.display = "flex";
    
          refreshOnboardingGate();
          resolve();
          return;
        }
    
        // ===== v2 (Cloud / Modern) =====
        chrome.runtime.sendMessage({ action: "auth.me" }, (resp) => {
          if (!resp?.success || !resp.authenticated) {
            if (authStatusLabel) authStatusLabel.textContent = "Not signed in";
            if (authAvatar) authAvatar.style.display = "none";
          
            if (authShowFormBtn) authShowFormBtn.style.display = "inline-block";
            if (authFormCard) authFormCard.style.display = "none";
            if (authLogoutBtn) authLogoutBtn.style.display = "none";
          
            // Ensure logout menu item is available when signed in later
            if (authMenuLogoutBtn) authMenuLogoutBtn.style.display = "";
          
            _isAuthenticated = false;
            POPUP_IS_AUTHENTICATED = false;
          
            // ✅ Force the full “signed-out v2” UI, including an empty-but-complete matcher card
            resetSignedOutV2UI();
          
            closeAuthMenu();
            refreshOnboardingGate();
            return;
          }
              
          // Authenticated
          const user = resp.user || {};
          const label = user.username || user.email || "";
    
          if (authStatusLabel) {
            authStatusLabel.textContent = label ? `Signed in as ${label}` : "Signed in";
          }
    
          if (authAvatar) {
            const initial = (label || "?").trim().charAt(0).toUpperCase() || "?";
            authAvatar.textContent = initial;
            authAvatar.style.display = "flex";
          }
    
          if (authShowFormBtn) authShowFormBtn.style.display = "none";
          if (authFormCard) authFormCard.style.display = "none";
          if (authLogoutBtn) authLogoutBtn.style.display = "none";
          if (authMenuLogoutBtn) authMenuLogoutBtn.style.display = "";
    
          POPUP_IS_AUTHENTICATED = true;
          _isAuthenticated = true;
    
          // Re-enable Apply controls in v2 when signed in
          const controls = document.getElementById("controls");
          if (controls) controls.style.display = "flex";
          const inlineHost = document.getElementById("resumeInlineHost");
          if (inlineHost) inlineHost.style.display = "flex";
    
          closeAuthMenu();
          POPUP_IS_AUTHENTICATED = true;
          refreshOnboardingGate();
          resolve();
        });
      });
    }     
  
    // --- Avatar menu helpers ---
    let _isAuthenticated = false;

    // --- v2 signed-out gating for the main cards (Job Match / Suggestor / Apply Helper) ---
    function isV2SignedOut() {
      return CURRENT_BACKEND === "v2" && !_isAuthenticated;
    }

    function clearMainCardsUI() {
      try { setArc(0); } catch (e) {}
    
      // Job Match card
      const scoreNum = document.getElementById("scoreNum");
      const matchStatus = document.getElementById("matchStatus");
      const matchedReq = document.getElementById("matchedReq");
      const matchedPref = document.getElementById("matchedPref");
      const missingReq = document.getElementById("missingReq");
      const missingPref = document.getElementById("missingPref");
    
      if (scoreNum) scoreNum.textContent = "—";
      if (matchStatus) matchStatus.textContent = "";
    
      // These are chip containers (DIVs); clearing textContent is fine
      if (matchedReq) matchedReq.textContent = "";
      if (matchedPref) matchedPref.textContent = "";
      if (missingReq) missingReq.textContent = "";
      if (missingPref) missingPref.textContent = "";
    
      // Suggestor card
      const chosenResume = document.getElementById("chosenResume");
      const chosenScore = document.getElementById("chosenScore");
      const resumeSelect = document.getElementById("resumeSelect");
      const resumeStatus = document.getElementById("resumeStatus");
    
      if (chosenResume) chosenResume.textContent = "—";
      if (chosenScore) chosenScore.textContent = "Match: —";
      if (resumeStatus) resumeStatus.textContent = "—";
      if (resumeSelect) resumeSelect.innerHTML = "";
    }

    function applyAuthVisibility() {
      const matchCardEl = document.getElementById("matchCard");
      const suggestorCardEl = document.getElementById("resumeSuggestorCard");
      const noResumesCardEl = document.getElementById("noResumesCard");
    
      const controlsEl = document.getElementById("controls");
      const gateEl = document.getElementById("onboardingGate");
      const gateTextEl = document.getElementById("onboardingGateText");
      const gateBtnEl = document.getElementById("completeSetupBtn");
    
      const backendPills = document.getElementById("backendTogglePills");
      const jdHint2 = document.getElementById("jdHint2");
      const matchStatus = document.getElementById("matchStatus");
    
      // Helpers to hide the skill sections inside Job Match while keeping the card + pills
      const hideSkillSection = (chipContainerId) => {
        const chips = document.getElementById(chipContainerId);
        if (!chips) return;
    
        // Hide the row that contains required+preferred skill boxes
        const row = chips.closest(".row");
        if (row) row.style.display = "none";
    
        // Hide the header right above that row (“Matched skills” / “Missing skills”)
        const header = row?.previousElementSibling;
        if (header && header.classList.contains("muted")) header.style.display = "none";
      };
    
      const showSkillSection = (chipContainerId) => {
        const chips = document.getElementById(chipContainerId);
        if (!chips) return;
        const row = chips.closest(".row");
        if (row) row.style.display = "";
        const header = row?.previousElementSibling;
        if (header && header.classList.contains("muted")) header.style.display = "";
      };
    
      if (isV2SignedOut()) {
        // Keep Job Match card visible ONLY to preserve the V1/V2 toggle pills
        if (matchCardEl) matchCardEl.style.display = "";
        if (backendPills) backendPills.style.display = "flex";
    
        // Hide actual match UI content inside Job Match
        clearMainCardsUI();
    
        // Hide gauge svg (no score arc while signed out)
        const svg = matchCardEl?.querySelector("svg");
        if (svg) svg.style.display = "none";
    
        // Change hint text
        if (jdHint2) jdHint2.textContent = "Sign in to see Job Match";
        if (matchStatus) matchStatus.textContent = "";
    
        // Hide skill sections (both “Matched skills” + “Missing skills” blocks)
        hideSkillSection("matchedReq");
        hideSkillSection("missingReq");
    
        // Hide Suggestor + “No resumes” card entirely when signed out
        if (suggestorCardEl) suggestorCardEl.style.display = "none";
        if (noResumesCardEl) noResumesCardEl.style.display = "none";
    
        // Apply Helper: hide buttons, show sign-in message, hide Complete setup button
        if (controlsEl) controlsEl.style.display = "none";
    
        if (gateEl) {
          gateEl.style.display = "block";
          gateEl.dataset.authGate = "1";
        }
        if (gateTextEl) gateTextEl.textContent = "Sign in to use Fill Form.";
        if (gateBtnEl) gateBtnEl.style.display = "none";
    
        return;
      }
    
      // Signed in (or v1): restore normal visibility
      if (matchCardEl) matchCardEl.style.display = "";
      if (suggestorCardEl) suggestorCardEl.style.display = "";
      // noResumesCardEl is controlled elsewhere
    
      // Restore SVG + skill sections (Job Match)
      const svg = matchCardEl?.querySelector("svg");
      if (svg) svg.style.display = "";
      if (jdHint2 && jdHint2.textContent === "Sign in to see Job Match") {
        jdHint2.textContent = "auto-detected from page";
      }
      showSkillSection("matchedReq");
      showSkillSection("missingReq");
    
      if (controlsEl) controlsEl.style.display = "flex";
    
      // If we previously forced the auth gate, let refreshOnboardingGate decide now
      if (gateEl && gateEl.dataset.authGate === "1") {
        gateEl.style.display = "none";
        delete gateEl.dataset.authGate;
      }
    
      // Let onboarding logic decide whether this should appear (but default visible)
      if (gateBtnEl) gateBtnEl.style.display = "";
    }    

    function closeAuthMenu() {
      if (authMenu) authMenu.style.display = "none";
    }

    function toggleAuthMenu() {
      if (!_isAuthenticated || !authMenu) return;
      const open = authMenu.style.display === "block";
      authMenu.style.display = open ? "none" : "block";
    }

    // Close menu on outside click
    document.addEventListener("click", () => closeAuthMenu());

    // Prevent clicks inside the menu from closing it
    authMenu?.addEventListener("click", (e) => e.stopPropagation());

    // Avatar opens menu
    authAvatar?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleAuthMenu();
    });

    // Menu actions
    authMenuProfileBtn?.addEventListener("click", () => {
      closeAuthMenu();
      // Open React Profile Dashboard
      window.open(chrome.runtime.getURL("profile_dashboard.html"), "_blank");
    });

    // --- Auth buttons wiring ---
    // Show the inline login form
    authShowFormBtn?.addEventListener("click", () => {
      if (authFormCard) {
        authFormCard.style.display = "";
      }
      if (authErrorMsg) {
        authErrorMsg.textContent = "";
      }
      if (authPasswordInput) {
        authPasswordInput.value = "";
      }
    });
  
    // Cancel login form
    authCancelBtn?.addEventListener("click", () => {
      if (authFormCard) {
        authFormCard.style.display = "none";
      }
    });
  
    // Attempt login via background -> FastAPI v2
    authLoginBtn?.addEventListener("click", async () => {
      const username = (authUsernameInput?.value || "").trim();
      const password = authPasswordInput?.value || "";
    
      const isRegister = AUTH_MODE === "register";
      await setAuthError("");
    
      if (!username || !password) {
        await setAuthError("Enter username and password.");
        return;
      }
    
      if (!isRegister) {
        await setAuthError("Signing in…");
        chrome.runtime.sendMessage({ action: "auth.login", username, password }, (resp) => {
          if (chrome.runtime.lastError) {
            setAuthError("Auth error (FastAPI v2 may be offline).");
            return;
          }
          if (!resp?.success) {
            setAuthError(resp?.error || "Invalid username or password.");
            return;
          }
          if (authFormCard) authFormCard.style.display = "none";
          setAuthError("");
          
          // Force the popup UI to fully re-render (same as closing + reopening)
          // so any state initialized during popup boot doesn't stay stale.
          const hardReload = () => {
            try {
              window.location.reload();
            } catch {
              refreshAuthState();
            }
          };
          
          // Clear any cached user-scoped UI state so we don't show the previous user.
          try {
            chrome.storage.local.remove(
              ["lastResumeId", "selectedResume", "profile", "profileVersion"],
              hardReload
            );
          } catch {
            hardReload();
          }          
        });
        return;
      }

      // Register via background -> FastAPI v2 (no resume at signup)
      const confirmPassword = authPasswordConfirmInput?.value || "";
      const email = (authEmailInput?.value || "").trim();
      const firstName = (authFirstNameInput?.value || "").trim();
      const lastName = (authLastNameInput?.value || "").trim();

      if (!confirmPassword) {
        await setAuthError("Confirm your password.");
        return;
      }
      if (password !== confirmPassword) {
        await setAuthError("Passwords do not match.");
        return;
      }
      if (!firstName || !lastName || !email) {
        await setAuthError("Enter first name, last name, and email.");
        return;
      }

      await setAuthError("Creating account…");
      chrome.runtime.sendMessage(
        { action: "auth.register", username, password, confirmPassword, email, firstName, lastName },
        (resp) => {
          if (chrome.runtime.lastError) {
            setAuthError("Auth error (FastAPI v2 may be offline).");
            return;
          }
          if (!resp?.success) {
            setAuthError(resp?.error || "Registration failed.");
            return;
          }
          if (authFormCard) authFormCard.style.display = "none";
          setAuthError("");
          // After account creation, open the existing Profile Dashboard in setup mode
          const dashUrl = chrome.runtime.getURL("profile_dashboard.html")
          try {
            chrome.tabs.create({ url: dashUrl });
          } catch {
            window.open(dashUrl, "_blank");
          }
          refreshAuthState();
        }
      );
      return;
    });    
  
  // Logout: clear token via background
  function doLogout() {
    if (!chrome?.runtime?.sendMessage) return;

    chrome.runtime.sendMessage({ action: "auth.logout" }, async () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "[popup] auth.logout error:",
          chrome.runtime.lastError.message
        );
      }

      closeAuthMenu();

      if (authStatusLabel) authStatusLabel.textContent = "Not signed in";
      if (authAvatar) authAvatar.style.display = "none";
      if (authShowFormBtn) authShowFormBtn.style.display = "inline-block";
      if (authLogoutBtn) authLogoutBtn.style.display = "none";

      _isAuthenticated = false;
      POPUP_IS_AUTHENTICATED = false;
      resetSignedOutV2UI();
      applyOnboardingGate(false, "Sign in to use Fill Form.");

      // Clear any cached user-scoped UI state so we don't show the previous user.
      try {
        await chrome.storage.local.remove([
          "lastResumeId",
          "selectedResume",
          "profile",
          "profileVersion",
        ]);
      } catch {}

      // Force the popup UI to fully re-render (same as closing + reopening)
      try {
        window.location.reload();
      } catch {
        BACKEND_AVAILABLE = null;
        runInitialLoad();
      }
    });
  }

  authLogoutBtn?.addEventListener("click", doLogout);
  authMenuLogoutBtn?.addEventListener("click", () => {
    closeAuthMenu();
    doLogout();
  });

  // Helper to show "selected backend offline" under the toggle
  function showBackendOfflineMessage() {
    if (backendToggleMsg) {
      backendToggleMsg.textContent =
        "⚠ Selected backend is offline. Use the toggle above to switch to a running version.";
      backendToggleMsg.style.display = "block";
    } else if (statusEl) {
      // Fallback if the element somehow isn’t there
      statusEl.textContent =
        "⚠ Selected backend is offline. Use the toggle to switch to a running version.";
    }
  }

  // Optional: helper to clear that message when things are healthy
  function clearBackendOfflineMessage() {
    if (backendToggleMsg) {
      backendToggleMsg.textContent = "";
      backendToggleMsg.style.display = "none";
    }
  }

  // Backend version toggle elements (pills) — IDs must exist in popup.html
  const v1Pill  = document.getElementById("backendV1Pill");
  const v2Pill  = document.getElementById("backendV2Pill");

  // On open, reflect whatever backend the user last chose
  setBackendPillUI(CURRENT_BACKEND);
  setBackendInfoMessage("");

  // Handle clicks on the backend version pills
  async function handleBackendClick(target) {
    // If user re-clicks the already active side, do nothing
    if (target === CURRENT_BACKEND) return;

    // We only want Smart Form Filler to use the target backend if it's really up.
    // First, probe both v1 and v2 pools.
    let status;
    try {
      status = await getMultiBackendStatus();
    } catch (e) {
      err("[popup] getMultiBackendStatus error:", e);
      status = { v1Ok: false, v2Ok: false, v1Base: null, v2Base: null };
    }

    const { v1Ok, v2Ok, v1Base, v2Base } = status;
    const other = target === "v1" ? "v2" : "v1";

    const targetOk   = target === "v1" ? v1Ok   : v2Ok;
    const targetBase = target === "v1" ? v1Base : v2Base;
    const otherOk    = other  === "v1" ? v1Ok   : v2Ok;
    const otherBase  = other  === "v1" ? v1Base : v2Base;

    // CASE 1: Target backend is actually running → normal behavior + refresh cards
    if (targetOk && targetBase) {
      // Commit the new backend choice
      setCurrentBackend(target);
      setBackendBase(targetBase);
      setBackendInfoMessage("");

      // IMPORTANT: re-check auth against the newly selected backend
      await refreshAuthState();

      // If we switched to v2 but we’re signed out, show logged-out v2 UI and stop.
      if (isV2SignedOut()) {
        if (statusEl) statusEl.textContent = "Not signed in.";
        resetSignedOutV2UI();
        return;
      }

      if (statusEl) {
        statusEl.textContent = "🔄 Refreshing with backend " + target.toUpperCase() + "…";
      }

      try {
        await preloadAndRestore();
        await autoMatch();
        if (statusEl) statusEl.textContent = "✅ Connected to Smart Form Filler API.";
      } catch (e) {
        err("[popup] error after backend switch:", e);
        if (statusEl) statusEl.textContent = "❌ Error after switching backend. See console for details.";
      }
      return;
    }

    // CASE 2: Target is down, but the OTHER backend is up
    if (!targetOk && otherOk) {
      const msg =
        target === "v2"
          ? "Backend v2 is not running, but v1 is. Switch back to v1 to use Smart Form Filler."
          : "Backend v1 is not running, but v2 is. Switch back to v2 to use Smart Form Filler.";

      // Show the small info message under the toggle
      setBackendInfoMessage(msg);

      // Snap the pill back to the healthy backend; do NOT talk to the target backend at all
      setCurrentBackend(other);
      if (otherBase) {
        setBackendBase(otherBase);
      }
      // IMPORTANT: no loading overlay in this case
      return;
    }

    // CASE 3: Both v1 and v2 are down
    if (!v1Ok && !v2Ok) {
      // Clear any inline info — we’ll show the big overlay instead
      setBackendInfoMessage("");

      if (statusEl) {
        statusEl.textContent =
          "❌ Could not reach any backend. Start Flask (v1) or FastAPI (v2), then click “Retry connection”.";
      }

      setLoading(
        true,
        "Both backends appear to be offline. Start Flask (v1) or FastAPI (v2), then click “Retry connection”."
      );

      if (retryBtn) {
        retryBtn.style.display = "";
        retryBtn.disabled = false;
      }

      BACKEND_AVAILABLE = false;
      return;
    }

    // Fallback: shouldn't really hit here, but don't explode if we do
    setBackendInfoMessage(
      "⚠️ Could not confirm backend status. Please try again."
    );
  }

  // Wire the click handlers if the pills exist in the DOM
  if (v1Pill) {
    v1Pill.addEventListener("click", () => handleBackendClick("v1"));
  }
  if (v2Pill) {
    v2Pill.addEventListener("click", () => handleBackendClick("v2"));
  }

  async function runInitialLoad() {
    // Always start with the loading overlay hidden until we decide otherwise
    setLoading(true);
  
    const ok = await ensureBackendHealthy();
    
    // AUTH GATE (v2): don't show/restore main cards until we know auth.me
    if (CURRENT_BACKEND === "v2") {
      await refreshAuthState();
      if (isV2SignedOut()) {
        // Logged-out v2 experience: hide/clear main cards and stop here.
        setLoading(false);
        setBackendInfoMessage("");
        clearBackendOfflineMessage();
        clearBackendButtonsWarning();
        if (retryBtn) {
          retryBtn.style.display = "none";
          retryBtn.disabled = false;
        }
        if (statusEl) statusEl.textContent = "Not signed in.";
        applyAuthVisibility();
        return;
      }
    }
  
    // If selected backend is not ok, we may still have another backend alive (e.g. v1 is up when user selected v2).
    if (!ok) {
      // keep the loading overlay visible in this error state
      setLoading(true);
  
      if (retryBtn) {
        retryBtn.style.display = "inline-block";
        retryBtn.disabled = false;
      }
  
      // Still show status message (and remember: in v2 signed-out we hide cards anyway via applyAuthVisibility)
      if (statusEl) {
        statusEl.textContent = "❌ Backend not reachable. Start it and click Retry.";
      }
  
      applyAuthVisibility();
      return;
    }
  
    // Backend is healthy. Normal path.
    setLoading(false);
    setBackendInfoMessage("");
    clearBackendOfflineMessage();
    clearBackendButtonsWarning();
  
    if (statusEl) {
      statusEl.textContent = "✅ Connected to Smart Form Filler API.";
    }
  
    // Show cards only when allowed (v2 signed-out must stay hidden)
    applyAuthVisibility();
    if (!isV2SignedOut()) {
      if (matchCard)     matchCard.style.display = "";
      if (suggestorCard) suggestorCard.style.display = "";
      hideNoResumesCard();
    }
  
    // In v2, we must know auth status before we preload/match.
    await refreshAuthState();
    if (isV2SignedOut()) {
      if (statusEl) statusEl.textContent = "Not signed in.";
      resetSignedOutV2UI();
      return;
    }
  
    try {
      await preloadAndRestore();
      await autoMatch();
    } catch (e) {
      console.warn("[popup] preload/match error:", e);
    }
  }  

  // Optional: “Retry connection” button
  if (retryBtn) {
    retryBtn.addEventListener("click", async () => {
      if (retryBtn) retryBtn.disabled = true;
    
      // Make sure the loading overlay is visible while retrying
      setLoading(true);
    
      if (statusEl) {
        statusEl.textContent = "⏳ Retrying connection to backend…";
      }
    
      const ok = await ensureBackendHealthy();
    
      if (!ok) {
        // Still broken → keep overlay and leave Retry visible/enabled
        setLoading(true);
    
        if (statusEl) {
          statusEl.textContent = "❌ Still cannot reach backend. Start it and try again.";
        }
    
        if (retryBtn) {
          retryBtn.style.display = "inline-block";
          retryBtn.disabled = false;
        }
    
        applyAuthVisibility();
        return;
      }
    
      // Now online — hide overlay and restore the normal UI
      setLoading(false);
      setBackendInfoMessage("");
      clearBackendOfflineMessage();
      clearBackendButtonsWarning();
    
      // Ensure auth is up-to-date before showing anything
      await refreshAuthState();
      applyAuthVisibility();
    
      if (statusEl) {
        statusEl.textContent = "✅ Connected to Smart Form Filler API.";
      }
    
      if (!isV2SignedOut()) {
        if (matchCard)     matchCard.style.display = "";
        if (suggestorCard) suggestorCard.style.display = "";
        hideNoResumesCard();
      }
    
      if (retryBtn) {
        retryBtn.style.display = "none";
        retryBtn.disabled = false;
      }
    
      // IMPORTANT: don't restore/match when v2 is signed out
      if (isV2SignedOut()) {
        return;
      }
    
      try {
        await preloadAndRestore();
        await autoMatch();
      } catch (e) {
        console.warn("[popup] preload/match error:", e);
      }
    });    
  }

  // Kick things off once DOM is ready
  (async () => {
    // Restore the last selected backend toggle.
    // Source of truth: chrome.storage.sync backendPref (so background.js matches).
    // Fallback: localStorage backendPreference (older installs).
    let pref = "v1";

    try {
      const st = await chrome.storage.sync.get("backendPref");
      if (st?.backendPref === "v1" || st?.backendPref === "v2") {
        pref = st.backendPref;
      }
    } catch (_) {}

    if (pref !== "v1" && pref !== "v2") {
      try {
        const ls = localStorage.getItem("backendPreference");
        if (ls === "v1" || ls === "v2") pref = ls;
      } catch (_) {}
    }

    setCurrentBackend(pref);

    // Always refresh auth before we load anything (prevents v2 signed-out -> v1-looking UI).
    await refreshAuthState();

    // Normal boot sequence (runInitialLoad already blocks preload/match when v2 signed out).
    await runInitialLoad();
  })();
});

// Buttons
document.getElementById("manageProfileBtn")?.addEventListener(
  "click",
  async (evt) => {
    if (BACKEND_AVAILABLE === false) {
      evt.preventDefault();
      showBackendButtonsWarning();
      return;
    }
    if (BACKEND_AVAILABLE === null) {
      const ok = await ensureBackendHealthy(true);
      if (!ok) {
        evt.preventDefault();
        showBackendButtonsWarning();
        return;
      }
    }

    // open the profile editor page
    const url = chrome.runtime.getURL("profile.html");
    window.open(url, "_blank");
  }
);
document.getElementById("manageResumesBtn")?.addEventListener(
  "click",
  async (evt) => {
    if (BACKEND_AVAILABLE === false) {
      evt.preventDefault();
      showBackendButtonsWarning();
      return;
    }
    if (BACKEND_AVAILABLE === null) {
      const ok = await ensureBackendHealthy(true);
      if (!ok) {
        evt.preventDefault();
        showBackendButtonsWarning();
        return;
      }
    }

    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL("resumes.html"));
    }
  }
);
document.getElementById("uploadResumeCTA")?.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("resumes.html"));
});

// disable Debug tab UI (non-destructive)
(function hideDebugTabNow(){
  try {
    const btn  = document.querySelector('[data-tab="debug"], #tab-debug, .tab-debug');
    const pane = document.querySelector('#panel-debug, [data-panel="debug"], .panel-debug');
    if (btn)  btn.remove();
    if (pane) pane.remove();

    // If the now-removed tab was active, switch to the first available tab
    const activeGone = !document.querySelector('.tab-button.active');
    if (activeGone) {
      const first = document.querySelector('[data-tab]:not([data-tab="debug"]), .tab-button:not(#tab-debug)');
      first?.click?.();
    }
  } catch(_) {}
})();


/* ========== Unified Debug Output helpers (one-box) ========== */
function _dbgBox(){ return document.getElementById("debugOutput"); }
function _esc(s){ return String(s ?? "").replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])); }
function _kv(pairs){
  return `<div class="kv">${
    pairs.map(([k,v])=>`<div class="key">${_esc(k)}</div><div class="val">${v}</div>`).join("")
  }</div>`;
}
function showDebug(title, html){
  const box = _dbgBox();
  if (!box) return;
  box.innerHTML = `<h4>${_esc(title)}</h4>${html || ""}`;
}

// ====== STEP 1 DETECTOR UI (popup.js) ======
function popupLog(...a){ console.log("[popup][detect]", ...a); }
function popupErr(...a){ console.error("[popup][detect]", ...a); }

async function getActiveTabSimple(){
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

// Avoid clobbering the 3-arg sendToFrame(tabId, frameId, msg) used by the matcher.
async function sendToFrameSimple(tabId, action){
  return await chrome.tabs.sendMessage(tabId, { action });
}

// Debug-only renderer (renamed to avoid shadowing main)
function renderDetectedDebug(list, withPred = false) {
  const sel = document.getElementById("detectedSelect");
  const det = document.getElementById("detectedDetails");
  const count = document.getElementById("detectCount");
  if (!sel || !det || !count) return;

  sel.innerHTML = "";
  det.textContent = "";

  (list || []).forEach((d, i) => {
    // robust fallbacks for label/how
    const label = d.label || d.labelText || d.placeholder || d.name || d.id || "(no label)";
    const how   = d.detectedBy || "derived";
    const suffix = (withPred && d.prediction)
      ? ` → ${d.prediction} (${(d.confidence ?? 0).toFixed(3)})`
      : "";
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${label}  —  [${how}]${suffix}`;
    sel.appendChild(opt);
  });

  count.textContent = `${(list || []).length} detected`;

  sel.onchange = () => {
    const idx = Number(sel.value);
    const d = (list || [])[idx];
    if (!d) { det.textContent = ""; return; }
    const details = {
      labelText: d.label || d.labelText || d.placeholder || d.name || d.id || null,
      detectedBy: d.detectedBy,
      tagName: d.tagName,
      inputType: d.inputType,
      id: d.id,
      name: d.name,
      placeholder: d.placeholder,
      selector: d.selector,
      prediction: d.prediction ?? null,
      confidence: d.confidence ?? null
    };
    det.textContent = JSON.stringify(details, null, 2);
  };

  if ((list || []).length) {
    sel.selectedIndex = 0;
    sel.onchange();
  }
}

async function withActiveTab(fn) {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs && tabs[0];
      resolve(fn(tab));
    });
  });
}

async function refreshDetectUI(tabId) {
  try {
    if (!tabId) return;

    const filledFieldsEl    = document.getElementById("filledFields");
    const notFilledFieldsEl = document.getElementById("notFilledFields");
    const detectedListEl    = document.getElementById("detectedList");
    if (!detectedListEl || !filledFieldsEl || !notFilledFieldsEl) return;

    // Small delay if the page just changed (keeps it stable)
    await new Promise(r => setTimeout(r, 120));

    // --- Reachability guard: if no content script, show friendly UI and bail ---
    const reachable = await chrome.tabs.sendMessage(tabId, { action: "ping" }).catch(() => null);
    if (!reachable || !reachable.ok) {
      const det = document.getElementById("detectedDetails");
      if (det) det.textContent = "Couldn’t reach the page. Try again on a form.";
      renderDetectedDebug([], false);
      renderFieldList(filledFieldsEl, [],    { title: "Filled",     mode: "filled" });
      renderFieldList(notFilledFieldsEl, [], { title: "Non-Filled", mode: "nonfilled" });
      forceNonFilledBadges(notFilledFieldsEl);
      return; // stop: do not attempt any other messages
    }

    // 1) Ask for a fresh snapshot (guard against failures too)
    const snap = await chrome.tabs.sendMessage(tabId, { action: "EXT_PAGE_SNAPSHOT" }).catch(() => null);
    if (!snap) {
      const det = document.getElementById("detectedDetails");
      if (det) det.textContent = "Couldn’t reach the page. Try again on a form.";
      renderDetectedDebug([], false);
      renderFieldList(filledFieldsEl, [],    { title: "Filled",     mode: "filled" });
      renderFieldList(notFilledFieldsEl, [], { title: "Non-Filled", mode: "nonfilled" });
      forceNonFilledBadges(notFilledFieldsEl);
      return;
    }

    // 2) Render in the debug-style “Detected” box only
    renderDetectedDebug(snap?.items || [], false);

    // 3) Paint Filled/Non-Filled strictly from the current page snapshot (labels from detector)
    const snapBuckets = await sendToTab(tabId, { action: "EXT_SNAPSHOT_BUCKETS" }).catch(() => null);
    const filledRaw    = Array.isArray(snapBuckets?.filled)    ? snapBuckets.filled    : [];
    const notFilledRaw = Array.isArray(snapBuckets?.notFilled) ? snapBuckets.notFilled : [];

    // Build label maps from the detector snapshot
    const rows = Array.isArray(snap?.items) ? snap.items : [];
    const labelBySelector = new Map(
      rows.map(r => [ r.selector, (r.labelText || r.groupLabel || r.label || "").trim() ])
    );
    const labelByName = new Map(
      rows
        .filter(r => /^(radio|checkbox)$/i.test(r.inputType || r.type || ""))
        .map(r => [ r.name, (r.labelText || r.groupLabel || r.label || "").trim() ])
    );

    // Prefer detector's label; for radios/checkboxes, fall back to group name
    const pickLabel = (rec) =>
    (rec && labelBySelector.get(rec.selector)) ||
    rec.label || "(Unknown)";  

    // Normalize Filled (show value; confidence N/A for now)
    const filled = filledRaw.map(f => ({
      key: f.key || null,
      label: pickLabel(f),
      confidence: "N/A",
      value: f.value
    }));

    // Normalize Non-Filled (label from detector; N/A confidence)
    const nonFilled = notFilledRaw.map(nf => ({
      key: nf.key || null,
      label: pickLabel(nf),
      confidence: "N/A"
    }));

    renderFieldList(filledFieldsEl,    filled,    { title: "Filled",     mode: "filled" });
    renderFieldList(notFilledFieldsEl, nonFilled, { title: "Non-Filled", mode: "nonfilled" });
    forceNonFilledBadges(notFilledFieldsEl);

  } catch (e) {
    console.error("[popup][detect] refreshDetectUI failed:", e);
  }
}

renderDetectedDebug(window.SFF_DETECTED, false);

// --- tiny helpers to persist per-page prediction map (label -> {key, confidence}) ---
function pageKeyFromUrl(u){ try{ const x=new URL(u); return `${x.origin}${x.pathname}`; } catch{ return u||"unknown"; } }
function _predKeyFor(url){ return `sff:${pageKeyFromUrl(url)}:predMap`; }
async function _savePredMap(url, mapObj){
  try{ await chrome.storage.local.set({ [_predKeyFor(url)]: mapObj }); }catch{}
}
async function _loadPredMap(url){
  try{
    const k = _predKeyFor(url);
    const g = await chrome.storage.local.get(k);
    return g[k] || {};
  }catch{ return {}; }
}

// --- Main: snapshot page + get confidences + render buckets ---
async function rescanBuckets(){
  const tab = await (window.getActiveTab ? window.getActiveTab() : getActiveTabSimple());
  if (!tab?.id) return;

  // Ensure content and pick the best frame
  try { if (typeof ensureContent === "function") { const ok = await ensureContent(tab.id); if (!ok) return; } } catch {}
  const frameId = (typeof getBestFrame === "function") ? await getBestFrame(tab.id) : 0;

  // 1) Detect with predictions for current labels (confidence source)
  const predResp = await new Promise(res =>
    chrome.tabs.sendMessage(tab.id, { action: "EXT_DETECT_FIELDS_WITH_PREDICTIONS" }, r => res(r))
  );
  const predItems = Array.isArray(predResp?.items) ? predResp.items : [];

  // Build { label -> { key, confidence } } for quick joins later
  const predMap = {};
  for (const it of predItems) {
    const label = String(it.labelText || it.label || it.placeholder || it.name || it.id || "").trim();
    if (!label) continue;
    predMap[label] = {
      key: it.prediction ?? null,
      confidence: (typeof it.confidence === "number" ? it.confidence : null)
    };
  }
  await _savePredMap(tab.url || "", predMap);

  // 2) DOM snapshot: which fields are actually filled right now?
  const snap = await new Promise(res =>
    chrome.tabs.sendMessage(tab.id, { action: "EXT_SNAPSHOT_BUCKETS" }, r => res(r))
  );
  const filledSnap    = Array.isArray(snap?.filled) ? snap.filled : [];
  const notFilledSnap = Array.isArray(snap?.notFilled) ? snap.notFilled : [];

  // 3) Build the Detected list from the prediction pass (label-only for that panel)
  const detected = predItems
    .map(d => ({ key: d.prediction || d.name || d.id || null, label: String(d.labelText || d.label || d.name || d.id || "").trim() }))
    .filter(x => x.label);

  window.SFF_DETECTED = detected.slice(); // single source of truth for Detected panel

  // 4) Assemble a "report-like" object so we can reuse your existing renderers
  //    Attach confidences from predMap by label; missing → "N/A"
  const pickConf = (label) => {
    const m = predMap[label];
    if (!m || m.confidence == null) return "N/A";
    return m.confidence; // keep numeric 0..1 — your parseConfidence handles it
  };
  const pickKey = (label) => (predMap[label]?.key ?? null);

  const report = {
    filled: filledSnap.map(f => ({
      key:       pickKey(f.label),
      label:     f.label,
      confidence: pickConf(f.label),
      value:     f.value,
      inputType: f.inputType,
      status:    f.status || "filled",
      didSet:    !!f.didSet
    })),
    notFilled: notFilledSnap.map(nf => ({
      key:       pickKey(nf.label),
      label:     nf.label,
      confidence: pickConf(nf.label)
    }))
  };

  // 5) Render into the three buckets using your normal path
  if (typeof renderBuckets === "function") {
    renderBuckets(detected, report);
  } else {
    const filledFieldsEl    = document.getElementById("filledFields");
    const notFilledFieldsEl = document.getElementById("notFilledFields");
    if (!filledFieldsEl || !notFilledFieldsEl) return;

    // minimal fallback: seed non-filled and fill-filled lists (uses your card renderer)
    renderFieldList(filledFieldsEl, report.filled, { title: "Filled", mode: "filled" });
    renderFieldList(notFilledFieldsEl, report.notFilled, { title: "Non-Filled", mode: "nonfilled" });
    forceNonFilledBadges(notFilledFieldsEl);
  }
}

// --- Replace the internals of rescanNow to call our new pipeline ---
async function rescanNow() {
  const tab = await (window.getActiveTab ? window.getActiveTab() : getActiveTabSimple());
  if (tab?.id) await rescanBuckets();
}
window.rescanNow = rescanNow;

// Also refresh once when popup opens so the initial numbers are right
document.addEventListener('DOMContentLoaded', async () => {
  const t = await getActiveTabSimple();
  if (t?.id) refreshDetectUI(t.id);

  document.getElementById('rescanBtn')?.addEventListener('click', async () => {
    const t2 = await getActiveTabSimple();
    if (t2?.id) refreshDetectUI(t2.id);
  });
});



// Debug-only detector (renamed to avoid shadowing main)
async function runDetectorDebug() {
  const tab = await getActiveTab();
  if (!tab) throw new Error("No active tab");

  const probe = await chrome.tabs.sendMessage(tab.id, { action: "probe" }).catch(() => null);
  if (!probe || !probe.ok) throw new Error("Content script not reachable. Make sure helpers/content are injected.");

  const resp = await chrome.tabs.sendMessage(tab.id, { action: "EXT_DETECT_FIELDS" }).catch(() => null);
  if (!resp || !resp.ok || !Array.isArray(resp.detected)) throw new Error("Detector failed in content script");

  SFF_DETECTED = resp.detected.slice(); // cache
  renderDetectedDebug(SFF_DETECTED);
  console.log("[popup][predict] Detected", SFF_DETECTED.length, "fields");
  return SFF_DETECTED;
}

// DEBUG: Detect → populate select + details + detectCount
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnDetect");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      await runDetectorDebug(); // this renders into #detectedSelect/#detectedDetails and updates #detectCount
    } catch (e) {
      const det = document.getElementById("detectedDetails");
      if (det) det.textContent = `Error: ${e.message || e}`;
    }
  });
});

// DEBUG: Predict → annotate options with predictions and update #predictCount
document.getElementById("btnPredict")?.addEventListener("click", async () => {
  try {
    if (!SFF_DETECTED?.length) await runDetectorDebug();
    await predictForDetected(); // updates #predictCount and augments the select text with predictions
  } catch (e) {
    const det = document.getElementById("detectedDetails");
    if (det) det.textContent = `Prediction Error: ${e.message || e}`;
  }
});

// DEBUG: Fill (original outputs) → uses background fillDetected and prints summary/report
document.getElementById("btnFill")?.addEventListener("click", async () => {
  try {
    if (!SFF_DETECTED?.length) await runDetectorDebug();
    if (!SFF_DETECTED[0]?.prediction) await predictForDetected();

    const profile = await getProfileFromBackend();
    const { lastResumeId } = await chrome.storage.local.get("lastResumeId");

    const resp = await new Promise(res => {
      chrome.runtime.sendMessage(
        { action:"fillDetected", items:SFF_DETECTED, profile, resumeId: lastResumeId || null },
        r => res(r)
      );
    });
    if (!resp?.success) throw new Error(resp?.error || "Fill failed");
    // Render into #fillSummary and #fillReport (already defined in file)
    renderFillReport(resp.report || []);
  } catch (e) {
    const pre = document.getElementById("fillReport");
    const sum = document.getElementById("fillSummary");
    if (sum) sum.textContent = "fill failed";
    if (pre) pre.textContent = String(e);
    console.error("[popup][fill] error:", e);
  }
});

// ====== STEP 2 PREDICTOR UI (popup.js) ======
let SFF_DETECTED = []; // cache from Step 1

// Override detector renderer to keep cache
async function runDetector(){
  const tab = await getActiveTab();
  if (!tab) throw new Error("No active tab");
  // If you require injection, call your ensureContent(tab.id) here.

  const probe = await chrome.tabs.sendMessage(tab.id, { action: "probe" }).catch(()=>null);
  if (!probe || !probe.ok) throw new Error("Content script not reachable. Make sure helpers/content are injected.");

  const resp = await chrome.tabs.sendMessage(tab.id, { action: "EXT_DETECT_FIELDS" }).catch(()=>null);
  if (!resp || !resp.ok || !Array.isArray(resp.detected)) throw new Error("Detector failed in content script");

  SFF_DETECTED = resp.detected.slice(); // cache
  renderDetectedDebug(SFF_DETECTED);    // ← use the debug renderer  
  console.log("[popup][predict] Detected", SFF_DETECTED.length, "fields");
  return SFF_DETECTED;
}

// Call background → /predict
async function predictForDetected(){
  const labels = SFF_DETECTED.map(d => (d.labelText || d.label || "").toString().trim());
  const resp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "predictLabels", labels }, (r) => resolve(r));
  });

  if (!resp || !resp.success) throw new Error(`Prediction failed: ${resp?.error || "no response"}`);

  // Attach predictions to cached detected rows by index
  const results = Array.isArray(resp.results) ? resp.results : [];
  (SFF_DETECTED || []).forEach((d, i) => {
    const r = results[i] || {};
    d.prediction = r.prediction ?? null;
    d.confidence = typeof r.confidence === "number" ? r.confidence : null;
  });

  renderDetectedDebug(SFF_DETECTED, /*withPred*/ true);
  const pc = document.getElementById("predictCount");
  if (pc) pc.textContent = `${results.filter(r => r && r.prediction).length}/${results.length} predicted`;
  console.log("[popup][predict] Predictions", results);
  return SFF_DETECTED;
}

// Unified filler used by both tabs.
// silent=true  → updates status + the Filled / Non-Filled lists only
// silent=false → also prints the detailed debug report
async function fillUsingPredictPipeline({ silent = true } = {}) {
  // detect + predict if not done
  if (!SFF_DETECTED?.length) await runDetectorDebug();
  if (!SFF_DETECTED[0]?.prediction) await predictForDetected();  

  const profile = await getProfileFromBackend();
  const { lastResumeId } = await chrome.storage.local.get("lastResumeId");
  const resp = await new Promise(res => {
    chrome.runtime.sendMessage(
      { action: "fillDetected", items: SFF_DETECTED, profile, resumeId: lastResumeId || null },
      r => res(r)
    );
  });
  if (!resp?.success) throw new Error(resp?.error || "Fill failed");

  // Debug detailed report if requested
  if (!silent) {
    renderFillReport(resp.report || []);
  }

  // Build the summary shape expected by renderResultsAndRemember()
  const filled = (resp.report || [])
    .filter(r => r.status === "filled")
    .map(r => ({
      label: r.label,
      value: r.valuePreview || r.value || "",
      confidence: typeof r.confidence === "number" ? r.confidence : 1
    }));

  const nonFilled = (resp.report || [])
    .filter(r => r.status !== "filled")
    .map(r => ({
      key: r.prediction || r.label,
      label: r.label,
      confidence: parseConfidence(r.confidence) ?? "N/A"
    }));  

  const tab = await getActiveTab();
  const url = tab?.url || "";
  const totalInputs = (resp.inputs ?? SFF_DETECTED.length) || 0;

  renderResultsAndRemember(url, { filled, notFilled: nonFilled, inputs: totalInputs, ok: true }, "✅ Form filled! You can try again.");

  // Toggle Main buttons appropriately
  const fillBtn = document.getElementById("fillForm");
  const tryBtn = document.getElementById("tryAgain");
  if (fillBtn && tryBtn) {
    const hasAny = filled.length > 0;
    fillBtn.style.display = hasAny ? "none" : "inline-block";
    tryBtn.style.display  = hasAny ? "inline-block" : "none";
  }

  // === After a successful fill, flip on the Key Skills ===
  try {
    const tab = await getActiveTab();
    if (tab?.id) {
      // Collect labels predicted as key_skill from SFF_DETECTED
      const predictedKeySkills = (Array.isArray(SFF_DETECTED) ? SFF_DETECTED : [])
        .filter(d => String(d?.prediction || "").toLowerCase() === "key_skill")
        .map(d => (d.labelText || d.label || "").toString().trim())
        .filter(Boolean);

      if (predictedKeySkills.length) {
        await runPredictedKeySkillsPass(tab.id, predictedKeySkills);
      } else {
        // Fallback: generic "use matchedSkills only" pass
        await runKeySkillsPass(tab.id);
      }
    }
  } catch (e) {
    err("[popup] key-skills pass failed:", e);
  }

  return resp;
}

async function getProfileFromBackend() {
  const resp = await new Promise(res => chrome.runtime.sendMessage({ action:"getProfile" }, r => res(r)));
  if (!resp?.success) throw new Error(resp?.error || "Profile fetch failed");
  return resp.profile || {};
}

// Treat unchecked/empty boxes as skipped for the debug report
function _deriveReportStatus(r){
  const t = String(r?.inputType || r?.type || r?.kind || "").toLowerCase();
  const isBox = /checkbox|radio/.test(t) || r?.kind === "checkbox";
  const vraw = r?.valuePreview ?? r?.value ?? "";
  const v = String(vraw).trim().toLowerCase();

  const looksUnchecked = (v === "" || v === "unchecked" || v === "false" || v === "off" || v === "0" || v === "no");

  // For boxes/radios, if we didn’t toggle them on, call it skipped.
  if (isBox && looksUnchecked) return "skipped";

  // Defensive: if backend said "filled" but value is clearly unchecked/empty, show "skipped".
  if ((r?.status === "filled") && looksUnchecked) return "skipped";

  return r?.status || "skipped";
}

function renderFillReport(report) {
  const pre = document.getElementById("fillReport");
  const sum = document.getElementById("fillSummary");
  if (!pre || !sum) return;

  // derive status per row so "unchecked" never counts as filled
  const rows = (report || []).map(r => {
    const status = _deriveReportStatus(r);
    const conf   = (typeof r.confidence === "number") ? ` @${r.confidence.toFixed(3)}` : "";
    const val    = (r.valuePreview != null) ? ` = "${r.valuePreview}"` : (r.value != null ? ` = "${r.value}"` : "");
    const why    = r.reason ? ` — ${r.reason}` : "";
    return { status, line: `• ${r.label} → ${r.prediction}${conf}${val} [${status}]${why}` };
  });

  const filledCount  = rows.filter(x => x.status === "filled").length;
  const skippedCount = rows.length - filledCount;

  sum.textContent = `${filledCount} filled, ${skippedCount} skipped`;
  pre.textContent = rows.map(x => x.line).join("\n");
}

// Wire the new button
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnPredict");
  if (btn) {
    btn.addEventListener("click", async () => {
      try {
        if (!SFF_DETECTED.length) await runDetectorDebug();
        await predictForDetected();
        await new Promise(r => setTimeout(r, 120));
        await rescanNow();
      } catch (e) {
        console.error("[popup][predict] error:", e);
        const det = document.getElementById("detectedDetails");
        if (det) det.textContent = `Prediction Error: ${e.message || e}`;
      }
    });
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnFill");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      const resp = await fillUsingPredictPipeline({ silent: false }); // also renders the debug report
      if (!resp?.success) throw new Error(resp?.error || "Fill failed");
      
      const tab2 = await getActiveTab();
      if (tab2?.id) {
        // wait a tick so newly inserted rows are in the DOM
        await new Promise(r => setTimeout(r, 120));
        await rescanNow();
      
        // (optional) re-check skills if you show that panel
        await sendToTab(tab2.id, { action: "EXT_CHECK_KEY_SKILLS" });
      }      
    } catch (e) {
      const pre = document.getElementById("fillReport");
      const sum = document.getElementById("fillSummary");
      if (sum) sum.textContent = "fill failed";
      if (pre) pre.textContent = String(e);
      console.error("[popup][fill] error:", e);
    }
  });
});
// --- DEBUG / SELF-TEST SWITCHES ---
const TEST_MODE  = true;   // enables bg.selftest route
const FAKE_MODEL = false;  // deterministic predictions instead of calling Flask

// ===================== Backend base resolver (v1 vs v2) =====================
// v1 = Flask (legacy api.py)
// v2 = FastAPI (new matcher service)

// Track last-known status for both backends + selected preference.
let BACKEND_STATUS = {
  ok: null,       // is the SELECTED backend up?
  base: null,     // base URL for the SELECTED backend (e.g. http://127.0.0.1:5000)
  pref: "v1",     // "v1" | "v2"
  v1: { up: null, base: null },
  v2: { up: null, base: null },
  lastChecked: 0, // Date.now()
};

// Ports each backend might listen on in local dev.
// v1 (Flask api.py): 5000–5004; Docker maps to 8000
// v2 (FastAPI app):  6000–6004; Docker maps to 8001
const V1_PORT_CANDIDATES = [8000, 5000, 5001, 5002, 5003, 5004];
const V2_PORT_CANDIDATES = [8001, 6000, 6001, 6002, 6003, 6004];

// === Auth token helpers ===

// Get JWT from chrome storage
function getAccessToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["sff_access_token"], (result) => {
      resolve(result.sff_access_token || null);
    });
  });
}

// Save JWT to chrome storage
function setAccessToken(token) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ sff_access_token: token }, () => {
      resolve();
    });
  });
}

// Clear JWT (on logout or 401)
function clearAccessToken() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(["sff_access_token"], () => {
      resolve();
    });
  });
}

async function patchProfileV2(base, token, patch) {
  const r = await fetch(`${base}/profile`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(patch || {}),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    const err = new Error(`Profile patch failed (${r.status}): ${t || "unknown error"}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function uploadResumeV2(base, token, resume) {
  const bytes = new Uint8Array(resume.arrayBuffer);
  const blob = new Blob([bytes], {
    type: resume.mime || "application/pdf"
  });

  const fd = new FormData();
  fd.append("file", blob, resume.filename || "resume.pdf");

  const r = await fetch(`${base}/resumes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    const err = new Error(`Resume upload failed (${r.status}): ${t || "unknown error"}`);
    err.status = r.status;
    throw err;
  }

  const data = await r.json();
  const item = data?.item || {};
  return { id: item.id, original_name: item.original_name };
}


async function getResumeSkillsV2(base, token, resumeId) {
  const r = await fetch(`${base}/skills/by_resume`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ resumeId }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    const err = new Error(`Skills extraction failed (${r.status}): ${t || "unknown error"}`);
    err.status = r.status;
    throw err;
  }

  return r.json(); // { id, name, skills }
}


// Call FastAPI v2 /auth/login and return { token, user }
async function loginUserWithV2(username, password) {
  let base = null;

  try {
    const status = await getBackendStatus(true, true);
    if (status?.v2?.up && status.v2.base) base = status.v2.base;
  } catch (e) {
    console.warn("[bg] loginUserWithV2: getBackendStatus failed:", e);
  }

  if (!base) {
    const err = new Error("FastAPI v2 backend is not running. Start it to sign in.");
    err.status = 503;
    throw err;
  }

  const resp = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!resp.ok) {
    let detail = "Login failed";
    try {
      const data = await resp.json();
      if (data?.detail) {
        const d = data.detail;
        if (typeof d === "string") detail = d;
        else if (Array.isArray(d) && d[0]?.msg) detail = d[0].msg;
        else if (typeof d === "object" && d.msg) detail = d.msg;
        else detail = JSON.stringify(d);
      }
    } catch {}
    const err = new Error(detail);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  const token = data.access_token;
  const user = data.user || null;

  await setAccessToken(token);
  return { token, user, base };
}

// Call FastAPI v2 /auth/register and return { token, user }
async function registerUserWithV2({ username, password, email, firstName, lastName }) {
  let base = null;

  try {
    const status = await getBackendStatus(true, true);
    if (status?.v2?.up && status.v2.base) base = status.v2.base;
  } catch (e) {
    console.warn("[bg] registerUserWithV2: getBackendStatus failed:", e);
  }

  if (!base) {
    const err = new Error("FastAPI v2 backend is not running. Start it to create an account.");
    err.status = 503;
    throw err;
  }

  const resp = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, email, firstName, lastName }),
  });

  if (!resp.ok) {
    let detail = "Registration failed";
    try {
      const data = await resp.json();
      if (data?.detail) {
        const d = data.detail;
        if (typeof d === "string") detail = d;
        else if (Array.isArray(d) && d[0]?.msg) detail = d[0].msg;
        else if (typeof d === "object" && d.msg) detail = d.msg;
        else detail = JSON.stringify(d);
      }
    } catch {}
    const err = new Error(detail);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  const token = data.access_token;
  const user = data.user || null;

  await setAccessToken(token);
  return { token, user, base };
}

async function selectResumeOnProfile({ base, token, resumeItem, skills }) {
  if (!resumeItem?.id) return;

  // Get current profile (you’ve already standardized on “patch full object” elsewhere)
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  let currentProfile = {};
  try {
    const pr = await fetch(`${base}/profile`, { headers: { Authorization: `Bearer ${token}` } });
    if (pr.ok) currentProfile = await pr.json();
  } catch {}

  currentProfile.selectedResumeId = String(resumeItem.id);
  currentProfile.selectedResumeName = String(resumeItem.original_name || "");
  currentProfile.selectedResumeSkills = Array.from(new Set(skills || [])).sort();

  const patch = await fetch(`${base}/profile`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(currentProfile),
  });

  if (!patch.ok) {
    const pj = await patch.json().catch(() => ({}));
    throw new Error(pj?.detail || pj?.error || `Profile patch failed (${patch.status})`);
  }
}

async function getSkillsByResumeId({ base, token, resumeId }) {
  const r = await fetch(`${base}/skills/by_resume?resume_id=${encodeURIComponent(resumeId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data?.detail || data?.error || `Skill extraction failed (${r.status})`;
    throw new Error(detail);
  }
  return Array.isArray(data?.skills) ? data.skills : [];
}

// Minimum profile completeness check for Phase D
function isProfileComplete(profile) {
  // Some callers may accidentally wrap as { profile: { ... } }
  const p0 = (profile && profile.profile) ? profile.profile : (profile || {});
  const personal = p0.personal || {};
  const first = (personal.firstName || "").trim();
  const last = (personal.lastName || "").trim();
  const email = (personal.email || personal.emailAddress || "").trim();
  return Boolean(first && last && email);
}

// If the profile is missing an email, fall back to the signed-in account email
// from /auth/me so onboarding + Fill Form don't get stuck.
async function hydrateProfileEmailFromAuth(base, token, profileObj) {
  try {
    if (!base || !token || !profileObj || typeof profileObj !== "object") return profileObj;

    const p0 = (profileObj.profile && typeof profileObj.profile === "object")
      ? profileObj.profile
      : profileObj;

    p0.personal = p0.personal || {};
    const current = (p0.personal.email || p0.personal.emailAddress || "").trim();
    if (current) return profileObj;

    const r = await fetch(`${base}/auth/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      credentials: "omit",
    });
    if (!r.ok) return profileObj;

    const me = await r.json();
    const authEmail = (me && me.email ? String(me.email) : "").trim();
    if (authEmail) p0.personal.email = authEmail;
  } catch {
    // ignore
  }
  return profileObj;
}

function flattenProfileToUserData(profile) {
  const p = (profile && profile.profile) ? profile.profile : (profile || {});
  const personal = p.personal || {};
  const address = p.address || {};
  const links = p.links || {};

  const firstName = (personal.firstName || "").trim();
  const lastName = (personal.lastName || "").trim();

  return {
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(" "),
    email: (personal.email || personal.emailAddress || "").trim(),
    phoneNumber: (personal.phoneNumber || personal.phone || "").trim(),
    dob: (personal.dob || "").trim(),

    street: (address.street || "").trim(),
    city: (address.city || "").trim(),
    state: (address.state || "").trim(),
    zip: (address.zip || "").trim(),
    country: (address.country || "").trim(),

    linkedin: (links.linkedin || "").trim(),
    github: (links.github || "").trim(),
    website: (links.website || "").trim(),
  };
}

// Probe a base URL by hitting /health. Only 2xx counts as "alive".
async function probe(base, timeoutMs = 2500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    console.log("[bg] probe /health ->", base);
    const r = await fetch(`${base}/health?t=${Date.now()}`, {
      signal: ctl.signal,
      cache: "no-store",
      credentials: "omit",
    });
    console.log("[bg] probe result:", base, "ok:", r.ok, "status:", r.status);
    return !!r && r.ok;
  } catch (e) {
    console.warn("[bg] probe failed:", base, e && e.message);
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Probe a list of ports for one backend (v1 or v2).
// We try both 127.0.0.1 and localhost so we don't depend on which
async function probeBackendOnPorts(ports) {
  const hosts = ["http://127.0.0.1", "http://localhost"];

  for (const host of hosts) {
    for (const port of ports) {
      const base = `${host}:${port}`;
      if (await probe(base)) {
        return { up: true, base };
      }
    }
  }
  return { up: false, base: null };
}


// Read last selected backend from storage (popup writes this)
async function loadBackendPref() {
  try {
    const { backendPref } = await chrome.storage.sync.get("backendPref");
    if (backendPref === "v2") return "v2";
    return "v1";
  } catch (e) {
    console.warn("[bg] loadBackendPref failed, defaulting to v1:", e && e.message);
    return "v1";
  }
}

// Only use JWT in v2 mode. In v1 (Local Legacy), ignore stored JWT so we don't route to v2.
async function getTokenForSelectedMode() {
  const pref = await loadBackendPref();
  if (pref !== "v2") return null;
  return await getAccessToken();
}

// Compute + cache status for v1 and v2, and for the SELECTED backend.
// By default, we ONLY probe the selected backend to avoid noisy /health calls on the other backend.
// Pass probeBoth=true when you specifically need both (auth/login/register/auth.me).
async function getBackendStatus(force = false, probeBoth = false) {
  const now = Date.now();

  // Use cache if recent, but refresh `pref` from storage in case popup changed it
  if (!force && BACKEND_STATUS.ok !== null && (now - BACKEND_STATUS.lastChecked) < 5000) {
    BACKEND_STATUS.pref = await loadBackendPref();
    const sel = BACKEND_STATUS.pref === "v2" ? BACKEND_STATUS.v2 : BACKEND_STATUS.v1;
    BACKEND_STATUS.ok = !!sel.up;
    BACKEND_STATUS.base = sel.base;
    return BACKEND_STATUS;
  }

  const pref = await loadBackendPref();

  // Probe ONLY what we need
  let v1 = BACKEND_STATUS.v1 || { up: null, base: null };
  let v2 = BACKEND_STATUS.v2 || { up: null, base: null };

  if (probeBoth) {
    v1 = await probeBackendOnPorts(V1_PORT_CANDIDATES);
    v2 = await probeBackendOnPorts(V2_PORT_CANDIDATES);
  } else {
    if (pref === "v2") {
      v2 = await probeBackendOnPorts(V2_PORT_CANDIDATES);
    } else {
      v1 = await probeBackendOnPorts(V1_PORT_CANDIDATES);
    }
  }

  const selected = pref === "v2" ? v2 : v1;

  BACKEND_STATUS = {
    ok: !!selected.up,
    base: selected.base,
    pref,
    v1,
    v2,
    lastChecked: now,
  };

  console.log("[bg] getBackendStatus:", BACKEND_STATUS, "probeBoth=", probeBoth);
  return BACKEND_STATUS;
}

// Resolve the base URL for the SELECTED backend (v1 or v2)
async function resolveAPIBase(force = false) {
  const st = await getBackendStatus(force, false); // selected only
  return st.base;
}

// If signed in, profile/resume endpoints MUST go to v2 so they stay user-scoped.
// v1 ignores JWT and would read/write the shared default profile/resumes.
async function resolveUserScopedBase(token, force = false) {
  if (!token) return await resolveAPIBase(force);
  const st = await getBackendStatus(force);
  return st?.v2?.up && st.v2.base ? st.v2.base : null;
}

// When a call fails, re-probe the currently selected backend.
// NOTE: this will NOT silently failover v2 -> v1 or vice versa.
async function reprobeAndSwap() {
  const base = await resolveAPIBase(true);
  if (!base) {
    throw new Error("No backend available after reprobe");
  }
  return base;
}

// --- Heuristics for fake predictions (dev only) ---
const FAKE_MAP = {
  "first": "first_name", "first name": "first_name", "firstname": "first_name", "fname": "first_name",
  "last": "last_name", "last name": "last_name", "lastname": "last_name", "lname": "last_name",
  "email": "email", "e-mail": "email", "email address": "email",
  "phone": "phone", "phone number": "phone",
  "street": "street", "address": "street", "address line 1": "street",
  "city": "city", "state": "state",
  "zip": "zip", "postal code": "zip", "postcode": "zip"
};
const toFakePred = (s) => {
  const k = (s || "").toString().trim().toLowerCase();
  for (const key of Object.keys(FAKE_MAP)) {
    if (k === key || k.startsWith(key)) return FAKE_MAP[key];
  }
  return null;
};

// --- Generic POST helper to the local API ---
async function callApi(path, payload) {
  let base = await resolveAPIBase();

  const token = await getTokenForSelectedMode();
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    return res.json();
  } catch (e) {
    base = await reprobeAndSwap(); // <— reprobe on error
    const res2 = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}),
    });
    if (!res2.ok) {
      throw new Error(`HTTP ${res2.status} on ${path} (after failover)`);
    }
    return res2.json();
  }
}

// --- Field-type batch predictor (for filler) ---
async function callPredictAPI(labels) {
  if (FAKE_MODEL) {
    return labels.map((lab) => {
      const p = toFakePred(lab);
      return { label: lab, prediction: p, confidence: p ? 0.95 : 0.0 };
    });
  }

  let base = await resolveAPIBase();

  const token = await getTokenForSelectedMode();
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(`${base}/predict_batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ labels }),
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  } catch (e) {
    base = await reprobeAndSwap(); // <— reprobe on error
    const res2 = await fetch(`${base}/predict_batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ labels }),
    });
    if (!res2.ok) {
      throw new Error(`API error ${res2.status} (after failover)`);
    }
    return res2.json();
  }
}

function canonicalize(pred) {
  if (!pred) return null;
  const lower = String(pred).trim().toLowerCase();
  const alias = {
    "first_name": "firstName",
    "firstname": "firstName",
    "last_name": "lastName",
    "lastname": "lastName",
    "phone": "phoneNumber",
    "mobile": "phoneNumber",
    "cellphone": "phoneNumber",
    "postal": "zip",
    "zipcode": "zip",
    "birth_date": "dob",
    "birthdate": "dob",
    "date_of_birth": "dob"
  };
  return alias[lower] || pred;
}


/* ===================== Seeding resumes (non-destructive) ===================== */
async function seedResumes() {
  try {
    const { resumes } = await chrome.storage.local.get("resumes");
    if (Array.isArray(resumes) && resumes.length) return; // already have something

    // Prefer Week-6 multi-resume seed if bundled
    const multi = [
      "data/resumes/jr_backend_strong.txt",
      "data/resumes/backend_java_good.txt",
      "data/resumes/data_etl_python.txt",
      "data/resumes/frontend_react.txt",
      "data/resumes/platform_aws_kafka.txt"
    ];
    const loaded = [];
    for (const path of multi) {
      try {
        const url = chrome.runtime.getURL(path);
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const text = (await resp.text()).trim();
        if (!text) continue;
        const name = path.split("/").pop().replace(".txt", "").replace(/_/g, " ");
        loaded.push({ id: crypto.randomUUID(), name, text, lastUpdated: Date.now() });
      } catch { /* ignore single file fail */ }
    }
    if (loaded.length) {
      await chrome.storage.local.set({ resumes: loaded });
      console.log("[bg] Seeded", loaded.length, "resumes into storage (Week-6)");
      return;
    }

    // Fall back to Week-5 single base resume
    try {
      const url = chrome.runtime.getURL("data/resumes/resume11_jorgeluis_done.txt");
      const resp = await fetch(url);
      if (resp.ok) {
        const text = (await resp.text()).trim();
        if (text) {
          const seed = [{
            id: crypto.randomUUID(),
            name: "Jorgeluis — Base Resume",
            text,
            lastUpdated: Date.now()
          }];
          await chrome.storage.local.set({ resumes: seed });
          console.log("[bg] Seeded default resume from data/resumes/resume11_jorgeluis_done.txt");
        }
      }
    } catch (e) {
      console.warn("[bg] No resume files bundled; seed skipped.");
    }
  } catch (e) {
    console.error("[bg] Resume seed failed:", e);
  }
}

/* ===================== User data seeding (Week-5) ===================== */
async function seedUserDataIfPresent() {
  async function tryLoad(path) {
    try {
      const res = await fetch(chrome.runtime.getURL(path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      await chrome.storage.local.set({ userData: data });
      console.log("=== userData loaded:", path, "===");
      return true;
    } catch {
      return false;
    }
  }
  const ok = (await tryLoad("data/userData.json")) || (await tryLoad("userData.json"));
  if (!ok) console.warn("=== No userData.json found (data/ or root). You can set it later. ===");
}

/* ===================== Lifecycle hooks ===================== */
chrome.runtime.onInstalled.addListener(async () => {
  await seedResumes();
  await seedUserDataIfPresent();
});

chrome.runtime.onStartup.addListener(async () => {
  await seedResumes();
});

/* ===================== Router ===================== */
/**
 * Supports both Week-5 "action" messages and Week-6 "type" messages.
 * - Week-5 (filler): getUserData, predictLabels, bg.selftest
 * - Week-6 (matcher): MATCH_SCORE, MATCH_DETAIL, SELECT_RESUME
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    // ===== Week-6 messages (type-based) =====
    if (msg?.type === "SELECT_RESUME") {
      // Optional: if your Flask app exposes a helper that returns best resume name/id
      // given a JD across what's in storage, you could forward here.
      // If not implemented on server, you can ignore this route.
      try {
        const out = await callApi("/select_resume", { job_description: msg.jobDescription });
        // Expect shape: { id?, name?, reason? } — forward as-is
        sendResponse(out);
      } catch (e) {
        sendResponse({ error: String(e) });
      }
      return;
    }

    if (msg?.type === "MATCH_DETAIL") {
      try {
        const method = msg.methodOverride || "tfidf";
        const out = await callApi("/match", {
          job_description: msg.jobDescription,
          resume: msg.resumeText,
          method
        });
        sendResponse(out);
      } catch (e) {
        sendResponse({ error: String(e) });
      }
      return;
    }    

    if (msg?.type === "MATCH_SCORE") {
      try {
        const out = await callApi("/match", {
          job_description: msg.jobDescription,
          resume: msg.resumeText,
          method: "tfidf" // keep lightweight for interactive dropdown compare
        });
        const score = Math.round(Math.max(0, Math.min(1, Number(out?.similarity_score || 0))) * 100);
        sendResponse({ score });
      } catch (e) {
        sendResponse({ error: String(e) });
      }
      return;
    }

    if (msg?.action === "getBackendStatus") {
      (async () => {
        try {
          const st = await getBackendStatus(!!msg.forceReprobe, !!msg.probeBoth);
          sendResponse({
            success: true,
            ok: !!st.ok,
            base: st.base || null,
            pref: st.pref === "v2" ? "v2" : "v1",
            v1: st.v1,
            v2: st.v2,
            lastChecked: st.lastChecked,
          });
        } catch (e) {
          sendResponse({ success: false, error: String(e) });
        }
      })();
      return true; // keep the message channel open
    }    
    
    // --- Auth helpers (FastAPI v2 only) ---
    if (msg?.action === "auth.login") {
      try {
        const { username, password } = msg;
        const { token, user, base } = await loginUserWithV2(username, password);
        sendResponse({ success: true, token, user, base });        
      } catch (e) {
        const status = e && e.status;
    
        // Expected user-facing errors (wrong email/password, bad input)
        if (status === 400 || status === 401 || status === 422) {
          console.warn("[bg] auth.login failed (user error):", e && e.message);
          sendResponse({
            success: false,
            error: e && e.message ? e.message : "Invalid email or password.",
          });
          return;
        }
    
        // Backend not running
        if (status === 503) {
          console.warn("[bg] auth.login failed (backend unavailable):", e && e.message);
          sendResponse({
            success: false,
            error: "FastAPI v2 backend is not running. Start it to sign in.",
          });
          return;
        }
    
        // Only log truly unexpected stuff as real errors
        console.error("[bg] auth.login failed (unexpected):", e);
        sendResponse({
          success: false,
          error: "Unexpected auth error. See console for details.",
        });
      }
      return;
    }    

    if (msg?.action === "auth.logout") {
      try {
        await clearAccessToken();
        sendResponse({ success: true });
      } catch (e) {
        console.error("[bg] auth.logout failed:", e);
        sendResponse({ success: false, error: String(e) });
      }
      return;
    } 

    if (msg?.action === "auth.register") {
      try {
        const { username, password, confirmPassword, email, firstName, lastName } = msg || {};
    
        if (!username || !password) {
          sendResponse({ success: false, error: "Username and password are required." });
          return;
        }
    
        if (!confirmPassword || password !== confirmPassword) {
          sendResponse({ success: false, error: "Passwords do not match." });
          return;
        }
    
        if (!firstName || !lastName || !email) {
          sendResponse({ success: false, error: "First name, last name, and email are required." });
          return;
        }
    
        // Create the user (FastAPI v2) and store JWT in chrome.storage.local
        const { token, user, base } = await registerUserWithV2({
          username,
          password,
          email,
          firstName,
          lastName,
        });
    
        // Seed /profile with the same values (resume upload happens later via resumes.js)
        try {
          await patchProfileV2(base, token, { personal: { firstName, lastName, email } });
        } catch (e) {
          console.warn("[bg] register: profile seed failed (non-fatal):", e);
        }
    
        sendResponse({ success: true, token, user, base });
      } catch (e) {
        console.error("[bg] auth.register failed:", e);
        sendResponse({
          success: false,
          error: e?.message || "Registration failed.",
        });
      }
      return;
    }    

    if (msg?.action === "auth.me") {
      try {
        const token = await getAccessToken();
        if (!token) {
          sendResponse({ success: false, authenticated: false });
          return;
        }
    
        // Always talk to v2 for auth using the probed port-pool
        let base = null;
        try {
          const status = await getBackendStatus(true, true);
          if (status?.v2?.up && status.v2.base) {
            base = status.v2.base;
          }
        } catch (e) {
          console.warn("[bg] getBackendStatus(v2) failed in auth.me:", e);
        }
    
        // If v2 isn't running, just report "not authenticated" with a hint
        if (!base) {
          sendResponse({
            success: false,
            authenticated: false,
            error: "FastAPI v2 backend is not running.",
          });
          return;
        }
    
        const resp = await fetch(`${base}/auth/me`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
    
        if (resp.status === 401) {
          // token expired/invalid
          await clearAccessToken();
          sendResponse({ success: false, authenticated: false });
          return;
        }
    
        if (!resp.ok) {
          console.error(
            "[bg] auth.me failed:",
            resp.status,
            await resp.text()
          );
          sendResponse({
            success: false,
            authenticated: false,
            error: `HTTP ${resp.status}`,
          });
          return;
        }
    
        const user = await resp.json();
        sendResponse({ success: true, authenticated: true, user });
      } catch (e) {
        console.error("[bg] auth.me error:", e);
        sendResponse({
          success: false,
          authenticated: false,
          error: String(e),
        });
      }
      return;
    }
    
    // Phase D: quick status check so popup can gate Fill Form until onboarding is done
    if (msg?.action === "onboarding.status") {
      try {
        const token = await getTokenForSelectedMode();
        if (!token) {
          sendResponse({ success: true, authenticated: false });
          return;
        }
    
        const st = await getBackendStatus(true);
        const base = st?.v2?.up ? st.v2.base : null;
    
        if (!base) {
          sendResponse({
            success: true,
            authenticated: true,
            backendUp: false,
            hasProfile: false,
            hasResume: false,
            needsOnboarding: true,
          });
          return;
        }
    
        const headers = { Authorization: `Bearer ${token}` };
    
        // profile
        let profile = {};
        try {
          const pr = await fetch(`${base}/profile`, { headers });
          if (pr.ok) profile = await pr.json();
          await hydrateProfileEmailFromAuth(base, token, profile);
        } catch {}
    
        // resumes
        let items = [];
        try {
          const rr = await fetch(`${base}/resumes`, { headers });
          if (rr.ok) {
            const rj = await rr.json();
            items = Array.isArray(rj.items) ? rj.items : [];
          }
        } catch {}
    
        const hasProfile = isProfileComplete(profile);
        const hasResume = items.length > 0;
        
        const missingProfileFields = [];
        if (!hasProfile) {
          const p0 = (profile && profile.profile) ? profile.profile : (profile || {});
          const personal = p0.personal || {};
          if (!String(personal.firstName || "").trim()) missingProfileFields.push("firstName");
          if (!String(personal.lastName || "").trim()) missingProfileFields.push("lastName");
          if (!String(personal.email || personal.emailAddress || "").trim()) missingProfileFields.push("email");
        }
        
        sendResponse({
          success: true,
          authenticated: true,
          backendUp: true,
          hasProfile,
          hasResume,
          needsOnboarding: !(hasProfile && hasResume),
          missingProfileFields,
        });        
      } catch (e) {
        console.warn("[bg] onboarding.status failed:", e);
        sendResponse({ success: false, error: String(e) });
      }
      return;
    }    

    if (msg?.action === "onboarding.saveProfile") {
      try {
        const token = await getAccessToken();
        if (!token) {
          sendResponse({ success: false, error: "Not signed in" });
          return;
        }

        const status = await getBackendStatus(true);
        const base = status?.v2?.up ? status.v2.base : null;
        if (!base) {
          sendResponse({ success: false, error: "FastAPI v2 backend is not running." });
          return;
        }

        const patch = msg?.profilePatch || msg?.profile || {};

        const resp = await fetch(`${base}/profile`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(patch),
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);

        const saved = await resp.json();
        sendResponse({ success: true, profile: saved });
      } catch (e) {
        console.error("[bg] onboarding.saveProfile failed:", e);
        sendResponse({ success: false, error: String(e) });
      }
      return;
    }

    // 1) Full profile fetch (nested JSON)
    if (msg?.action === "getProfile") {
      (async () => {
        const token = await getTokenForSelectedMode();
        const base = await resolveUserScopedBase(token, false);

        // Signed-in mode: v2 must be up (never hit v1 for user-scoped data).
        if (token && !base) {
          sendResponse({ success: false, error: "FastAPI v2 backend is not running." });
          return;
        }

        // Signed-in: fetch v2 profile (user-scoped)
        if (token) {
          try {
            const r = await fetch(`${base}/profile`, {
              method: "GET",
              headers: { "Authorization": `Bearer ${token}` },
              cache: "no-store",
              credentials: "omit",
            });
            if (!r.ok) throw new Error(`Profile HTTP ${r.status}`);

            const data = (await r.json()) || {};
            await hydrateProfileEmailFromAuth(base, token, data);

            sendResponse({ success: true, profile: data || {} });
            return;
          } catch (e) {
            sendResponse({ success: false, error: String(e) });
            return;
          }
        }

        // Signed-out: prefer the SELECTED backend profile first (so v1 saves show up),
        // then fall back to packaged profile.json for dev/no-backend mode.
        try {
          const base2 = await resolveAPIBase();
          const r = await fetch(`${base2}/profile`, {
            method: "GET",
            cache: "no-store",
            credentials: "omit",
          });
          if (r.ok) {
            const data = await r.json();
            sendResponse({ success: true, profile: data || {} });
            return;
          }
        } catch {}

        try {
          const url = chrome.runtime.getURL("backend/data/profile.json");
          const r = await fetch(url, { cache: "no-store" });
          if (!r.ok) throw new Error(`profile.json HTTP ${r.status}`);
          const data = await r.json();
          sendResponse({ success: true, profile: data || {} });
        } catch (e) {
          sendResponse({ success: false, error: String(e) });
        }
      })();
      return true; // async
    }

    // 2) Resume file fetch as base64 (by id)
    if (msg?.action === "getResumeFile") {
      const rid = msg?.id;
      if (!rid) { sendResponse({ ok:false, error:"missing resume id" }); return; }
    
      try {
        const token = await getTokenForSelectedMode();
        const base = await resolveUserScopedBase(token, false);
        if (token && !base) throw new Error("FastAPI v2 backend is not running.");        
        const headers = { "Cache-Control": "no-cache" };
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        }
    
        const r = await fetch(
          `${base}/resumes/${encodeURIComponent(rid)}/file?t=${Date.now()}`,
          {
            cache: "no-store",
            headers,
          }
        );
        if (!r.ok) throw new Error(`resume file HTTP ${r.status}`);
    
        const buf = await r.arrayBuffer();
    
        // Chunked base64 (encode) — prevents stack overflow on large files
        const bytes = new Uint8Array(buf);
        const chunkSize = 0x8000; // 32KB
        let binary = "";
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const sub = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, sub);
        }
        const b64 = btoa(binary);
    
        const cd = r.headers.get("Content-Disposition") || "";
        const nameMatch = cd.match(/filename\*?=(?:UTF-8''|")?([^";\n]+)/i);
        const name = nameMatch ? decodeURIComponent(nameMatch[1].replace(/^"+|"+$/g, "")) : "resume.pdf";
        const type = r.headers.get("Content-Type") || "application/pdf";
    
        sendResponse({ ok:true, base64:b64, name, type });
      } catch (e) {
        sendResponse({ ok:false, error:String(e) });
      }
      return;
    }    

    // 3) Existing relay to content, but now pass resumeId too
    if (msg?.action === "fillDetected") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab");
      const resp = await chrome.tabs.sendMessage(tab.id, {
        action: "EXT_FILL_FIELDS",
        items: msg.items || [],
        profile: msg.profile || {},
        resumeId: msg.resumeId || null
      }).catch(e => ({ ok:false, error:String(e) }));
      sendResponse({ success: !!resp?.ok, report: resp?.report || [], error: resp?.error });
      return;
    }

    // ===== Week-5 messages (action-based) =====
    if (msg?.action === "getUserData") {
      (async () => {
        const token = await getTokenForSelectedMode();
        const base = await resolveUserScopedBase(token, false);

        // Signed-in mode: v2 must be up (never hit v1 for user-scoped data).
        if (token && !base) {
          sendResponse({});
          return;
        }

        // Always try the live backend profile first
        try {
          const headers = { "Accept": "application/json" };
          if (token) headers["Authorization"] = `Bearer ${token}`;

          const res = await fetch(`${base}/profile`, {
            method: "GET",
            headers,
            cache: "no-store",
            credentials: "omit",
          });

          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          const profile = (await res.json()) || {};
          await hydrateProfileEmailFromAuth(base, token, profile);

          // Mirror to storage so content scripts can read it instantly
          try {
            await chrome.storage.local.set({
              userData: profile,
              profileVersion: Date.now(),
            });
          } catch {}

          // Return RAW profile object (content.js expects an object)
          sendResponse(profile || {});
          return;
        } catch (e) {
          // If we're signed in, do NOT fall back to cached (it might be v1/default data).
          if (token) {
            console.warn("[bg] getUserData: /profile failed in signed-in mode:", e && e.message);
            sendResponse({});
            return;
          }
          console.warn("[bg] getUserData: /profile failed, falling back to cached userData:", e && e.message);
        }

        // Signed-out fallback: cached copy (still return raw object)
        try {
          const { userData } = await chrome.storage.local.get("userData");
          sendResponse(userData || {});
        } catch {
          sendResponse({});
        }
      })();
      return true; // async
    }

    if (msg?.action === "predictLabels") {
      const labels = Array.isArray(msg.labels) ? msg.labels : [];
      let data = null;

      try {
        data = await callPredictAPI(labels);
      } catch (e) {
        data = null;
      }    

      // Normalize to an array of results aligned to `labels`
      // Accept either {results:[...]} or a raw array
      let results = [];
      if (Array.isArray(data)) {
        results = data;
      } else if (data && Array.isArray(data.results)) {
        results = data.results;
      } else {
        // Fallback: assume all nulls so UI still renders
        results = labels.map(() => ({ label: null, prediction: null, confidence: 0 }));
      }

      sendResponse({ success: true, results });
      return;
    }

    if (TEST_MODE && msg?.action === "bg.selftest") {
      const { userData } = await chrome.storage.local.get("userData");
      const labels = ["First Name", "Last Name", "Email", "Phone", "State", "Zip"];
      const preds = await callPredictAPI(labels);
      sendResponse({
        success: true,
        userDataLoaded: !!userData,
        predictionsSample: preds
      });
      return;
    }

    // If we got here, it didn't match any known route
    if (typeof msg?.action !== "undefined") {
      sendResponse({ success: false, error: "Unknown action" });
    } else {
      sendResponse({ error: "Unknown message" });
    }
  })().catch(e => sendResponse({ error: String(e) }));
  return true; // keep async channel open
});
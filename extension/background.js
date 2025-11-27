// --- DEBUG / SELF-TEST SWITCHES ---
const TEST_MODE  = true;   // enables bg.selftest route
const FAKE_MODEL = false;  // deterministic predictions instead of calling Flask

// ===================== Backend base resolver (Docker-first) =====================
// Prefer Docker (8000) when available, else local (5000).
let API_BASE_CACHE = null;

// Simple shared status cache so popup/content can see what background probed
let BACKEND_STATUS = {
  ok: null,        // true / false / null (unknown)
  base: null,      // last known base
  lastChecked: 0,  // Date.now()
};

// Ports the backend might listen on in local dev.
// api.py chooses a free one from this pool on startup.
const LOCAL_PORTS = [5000, 5001, 5002, 5003, 5004];

// Fixed host port used by Docker backend.
const DOCKER_PORT = 8000;


// Probe a base URL by hitting /health. Only 2xx counts as "alive".
async function probe(base, timeoutMs = 800) {
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

async function resolveAPIBase(force = false) {
  if (!force && API_BASE_CACHE) return API_BASE_CACHE;

  // 1) Prefer any local dev server in our known pool.
  for (const port of LOCAL_PORTS) {
    const base = `http://127.0.0.1:${port}`;
    if (await probe(base)) {
      API_BASE_CACHE = base;
      try { await chrome.storage.local.set({ backend_base: base }); } catch {}
      return base;
    }
  }

  // 2) Fallback to Docker container (fixed host port)
  const dockerBase = `http://127.0.0.1:${DOCKER_PORT}`;
  if (await probe(dockerBase)) {
    API_BASE_CACHE = dockerBase;
    try { await chrome.storage.local.set({ backend_base: dockerBase }); } catch {}
    return dockerBase;
  }

  // 3) Nothing listening: clear cache + stored base.
  API_BASE_CACHE = null;
  try { await chrome.storage.local.remove("backend_base"); } catch {}
  return null;
}

async function getBackendStatus(force = false) {
  const now = Date.now();

  if (!force && BACKEND_STATUS.ok !== null && (now - BACKEND_STATUS.lastChecked) < 5000) {
    return BACKEND_STATUS;
  }

  const base = await resolveAPIBase(force); // already probed
  const alive = !!base;

  BACKEND_STATUS = {
    ok: alive,
    base,
    lastChecked: now,
  };

  console.log("[bg] getBackendStatus:", BACKEND_STATUS);
  return BACKEND_STATUS;
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
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    return res.json();
  } catch (e) {
    base = await reprobeAndSwap();              // <— reprobe on error
    const res2 = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    if (!res2.ok) throw new Error(`HTTP ${res2.status} on ${path} (after failover)`);
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
  try {
    const res = await fetch(`${base}/predict_batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels })
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  } catch (e) {
    base = await reprobeAndSwap();              // <— reprobe on error
    const res2 = await fetch(`${base}/predict_batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels })
    });
    if (!res2.ok) throw new Error(`API error ${res2.status} (after failover)`);
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
      try {
        const st = await getBackendStatus(!!msg.forceReprobe);
        sendResponse({
          success: true,
          ok: !!st.ok,
          base: st.base,
          lastChecked: st.lastChecked,
        });
      } catch (e) {
        sendResponse({ success: false, error: String(e) });
      }
      return;
    }

    // 1) Full profile fetch (nested JSON)
    if (msg?.action === "getProfile") {
      (async () => {
        try {
          // Prefer the local packaged profile.json
          const url = chrome.runtime.getURL("backend/data/profile.json");
          const r = await fetch(url);
          if (!r.ok) throw new Error(`profile.json HTTP ${r.status}`);
          const data = await r.json();
          sendResponse({ success: true, profile: data || {} });
        } catch (e) {
          // Optional: fallback to API if local read fails
          try {
            const base = await resolveAPIBase();
            const r = await fetch(`${base}/profile`, { credentials: "include" });
            if (!r.ok) throw new Error(`Profile HTTP ${r.status}`);
            const data = await r.json();
            sendResponse({ success:true, profile:data || {} });
          } catch (e2) {
            sendResponse({ success:false, error:String(e2) });
          }          
        }
      })();
      return true; // async
    }    

    // 2) Resume file fetch as base64 (by id)
    if (msg?.action === "getResumeFile") {
      const rid = msg?.id;
      if (!rid) { sendResponse({ ok:false, error:"missing resume id" }); return; }
    
      try {
        const base = await resolveAPIBase();
        const r = await fetch(`${base}/resumes/${encodeURIComponent(rid)}/file?t=${Date.now()}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" }
        });        
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
      try {
        const base = await resolveAPIBase();
        const res = await fetch(`${base}/profile`, { credentials: "include" });
        let data = {};
        if (res.ok) {
          const raw = await res.json();
          // ---- Flatten nested profile into single-level userData for the filler ----
          const p = raw || {};
          const personal = p.personal || {};
          const address  = p.address  || {};
          const links    = p.links    || {};
          // Optional: first education/experience
          const edu0 = Array.isArray(p.education)  && p.education[0]  ? p.education[0]  : {};
          const exp0 = Array.isArray(p.experience) && p.experience[0] ? p.experience[0] : {};

          // cache flattened as fallback
          await chrome.storage.local.set({ userData: data });
          sendResponse({ success: true, userData: data });
          return;
        }

        // Fallback to cached flattened copy (if any)
        const { userData } = await chrome.storage.local.get("userData");
        sendResponse({ success: true, userData: userData || {} });
      } catch (e) {
        const { userData } = await chrome.storage.local.get("userData");
        sendResponse({ success: true, userData: userData || {} });
      }
      return;
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
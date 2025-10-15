
// --- DEBUG / SELF-TEST SWITCHES ---
const TEST_MODE  = true;   // enables bg.selftest route
const FAKE_MODEL = false;  // deterministic predictions instead of calling Flask

// --- Unified local API base (both endpoints live in one Flask app) ---
const API_BASE = "http://127.0.0.1:5000";

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
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.json();
}

// --- Field-type batch predictor (for filler) ---
async function callPredictAPI(labels) {
  if (FAKE_MODEL) {
    return labels.map((lab) => {
      const p = toFakePred(lab);
      return { label: lab, prediction: p, confidence: p ? 0.95 : 0.0 };
    });
  }
  const res = await fetch(`${API_BASE}/predict_batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels })
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
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

    // 1) Full profile fetch (nested JSON)
    if (msg?.action === "getProfile") {
      try {
        const r = await fetch(`${API_BASE}/profile`, { credentials: "include" });
        if (!r.ok) throw new Error(`Profile HTTP ${r.status}`);
        const data = await r.json();
        sendResponse({ success:true, profile:data || {} });
      } catch (e) {
        sendResponse({ success:false, error:String(e) });
      }
      return;
    }

    // 2) Resume file fetch as base64 (by id)
    if (msg?.action === "getResumeFile") {
      const rid = msg?.id;
      if (!rid) { sendResponse({ ok:false, error:"missing resume id" }); return; }
    
      try {
        const r = await fetch(`${API_BASE}/resumes/${encodeURIComponent(rid)}/file?t=${Date.now()}`, {
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
        const res = await fetch(`${API_BASE}/profile`, { credentials: "include" });
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

          data = {
            // core identity
            firstName:   personal.firstName || "",
            lastName:    personal.lastName  || "",
            fullName:    [personal.firstName, personal.lastName].filter(Boolean).join(" "),
            email:       personal.email     || "",
            phoneNumber: personal.phoneNumber || "",
            dob:         personal.dob       || "",
            gender:      personal.gender    || "",

            // address
            street:  address.street  || "",
            city:    address.city    || "",
            state:   address.state   || "",
            zip:     address.zip     || "",
            country: address.country || "",

            // links
            linkedin: links.linkedin || "",
            github:   links.github   || "",
            website:  links.website  || "",

            // simple employment/education fallbacks (many forms ask these)
            company:   exp0.company   || "",
            jobTitle:  exp0.jobTitle  || "",
            start_date: (exp0.startMonth && exp0.startYear) ? `${String(exp0.startMonth).padStart(2,"0")}/${exp0.startYear}` : "",
            end_date:   (exp0.endMonth   && exp0.endYear)   ? `${String(exp0.endMonth).padStart(2,"0")}/${exp0.endYear}`   : "",
          };

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
        const r = await fetch(`${API_BASE}/predict_batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ labels })
        });
        if (r.ok) data = await r.json();
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


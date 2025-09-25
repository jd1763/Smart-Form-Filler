// === background.js ===

// --- DEBUG / SELF-TEST SWITCHES ---
const TEST_MODE = true;       // enables bg.selftest route
const FAKE_MODEL = false;      // return deterministic predictions instead of calling Flask

// Map simple labels -> predictions for FAKE_MODEL
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

// One-time seed from bundled text file if no resumes exist
async function seedResumeFromFile() {
  try {
    const { resumes } = await chrome.storage.local.get("resumes");
    if (Array.isArray(resumes) && resumes.length) return; // already seeded

    const url = chrome.runtime.getURL("data/resumes/resume11_jorgeluis_done.txt");
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} -> ${resp.status}`);
    const text = (await resp.text()).trim();

    const seed = [{
      id: crypto.randomUUID(),
      name: "Jorgeluis — Base Resume",
      text,
      lastUpdated: Date.now()
    }];

    await chrome.storage.local.set({ resumes: seed });
    console.log("[bg] Seeded default resume from data/resumes/resume11_jorgeluis_done.txt");
  } catch (e) {
    console.error("[bg] Failed to seed resume from file:", e);
  }
}

// Call on install & on startup (harmless if already seeded)
chrome.runtime.onInstalled.addListener(() => { seedResumeFromFile(); });
chrome.runtime.onStartup.addListener(() => { seedResumeFromFile(); });


// Ensure action click opens the POPUP, not the side panel
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  }
});
chrome.runtime.onStartup.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  }
});

// === Load userData.json into extension storage when installed ===
chrome.runtime.onInstalled.addListener(async () => {
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
});

// === Helper: call Flask API for batch predictions (or fake) ===
async function callPredictAPI(labels) {
  if (FAKE_MODEL) {
    return labels.map((lab) => {
      const p = toFakePred(lab);
      return { label: lab, prediction: p, confidence: p ? 0.95 : 0.0 };
    });
  }

  const url = "http://127.0.0.1:5000/predict_batch";
  const body = JSON.stringify({ labels });

  console.log("[bg] calling Flask /predict_batch for", labels.length, "labels");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });

  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// === Message router ===
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      if (request.action === "getUserData") {
        const { userData } = await chrome.storage.local.get("userData");
        sendResponse({ success: true, userData: userData || {} });

      } else if (request.action === "predictLabels") {
        const { labels } = request;
        const data = await callPredictAPI(labels);
        sendResponse({ success: true, results: data });

      } else if (TEST_MODE && request.action === "bg.selftest") {
        const { userData } = await chrome.storage.local.get("userData");
        const labels = ["First Name", "Last Name", "Email", "Phone", "State", "Zip"];
        const preds = await callPredictAPI(labels);
        sendResponse({
          success: true,
          userDataLoaded: !!userData,
          predictionsSample: preds
        });

      } else {
        sendResponse({ success: false, error: "Unknown action" });
      }
    } catch (err) {
      console.error("[bg] background error:", err);
      sendResponse({ success: false, error: String(err) });
    }
  })();
  return true; // keep channel open for async sendResponse
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!chrome.sidePanel?.setOptions) return;
  if (info.status === "complete" && tab?.url && /^https?:|^file:/.test(tab.url)) {
    try {
      await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
    } catch {}
  }
});



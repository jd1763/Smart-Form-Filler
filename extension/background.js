// === Load userData.json into extension storage when installed ===
chrome.runtime.onInstalled.addListener(async () => {
  // Helper to try loading userData.json from a given path
  async function tryLoad(path) {
    try {
      // chrome.runtime.getURL makes sure we can read packaged files
      const res = await fetch(chrome.runtime.getURL(path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Parse JSON and store in chrome.storage.local
      const data = await res.json();
      await chrome.storage.local.set({ userData: data });

      console.log("=== userData loaded:", path, "===");
      return true;
    } catch (e) {
      // Fail silently so we can try other locations
      return false;
    }
  }

  // Try two possible file locations: data/userData.json -> fallback userData.json
  const ok = (await tryLoad("data/userData.json")) || (await tryLoad("userData.json"));

  if (!ok) {
    console.warn("=== No userData.json found (data/ or root). You can set it later. ===");
  }
});

// === Helper: call Flask API for batch predictions ===
// Sends labels to http://127.0.0.1:5000/predict_batch
// Returns predictions + confidence scores
async function callPredictAPI(labels) {
  const url = "http://127.0.0.1:5000/predict_batch";
  const body = JSON.stringify({ labels });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });

  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// === Message router ===
// Listens for messages from popup.js or content.js and responds accordingly
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      if (request.action === "getUserData") {
        // Return stored userData.json (email, name, etc.)
        const { userData } = await chrome.storage.local.get("userData");
        sendResponse({ success: true, userData: userData || {} });

      } else if (request.action === "predictLabels") {
        // Send labels to Flask API and return model predictions
        const { labels } = request;
        const data = await callPredictAPI(labels);

        // NOTE: Flask /predict_batch already returns an array, not wrapped in "results".
        // So we just pass it through as results.
        sendResponse({ success: true, results: data });

      } else {
        // Unknown action -> error
        sendResponse({ success: false, error: "Unknown action" });
      }

    } catch (err) {
      console.error("background.js error:", err);
      sendResponse({ success: false, error: String(err) });
    }
  })();

  return true; // keeps channel open for async sendResponse
});

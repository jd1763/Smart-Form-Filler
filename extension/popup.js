// Grab references to the button and status message in popup.html
const btn = document.getElementById("fillForm");
const status = document.getElementById("status");

// Small helper: disable the button and show a message
function disableButton(msg) {
  btn.disabled = true;
  status.textContent = msg;
}

// When popup opens, run this code
document.addEventListener("DOMContentLoaded", () => {
  // Step 1: Get the current active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs?.[0]?.id;
    if (!tabId) {
      disableButton("❌ No active tab.");
      return;
    }

    // Step 2: "Ping" the content script to see if it’s running on this page
    chrome.tabs.sendMessage(tabId, { action: "ping" }, (resp) => {
      if (chrome.runtime.lastError) {
        // If there’s no content script, show error in popup (don’t crash)
        disableButton("❌ This page is not supported.");
        console.warn("Ping failed:", chrome.runtime.lastError.message);
        return;
      }

      // Step 3: If ping worked, ask the content script if it sees form fields
      if (resp && resp.ok) {
        chrome.tabs.sendMessage(tabId, { action: "canFillProbe" }, (probe) => {
          if (probe && probe.hasForm === false) {
            status.textContent = "ℹ️ No form fields detected (you can still try).";
          } else {
            status.textContent = "Ready to fill.";
          }
        });
      } else {
        disableButton("❌ This page is not supported.");
      }
    });
  });
});

// Handle the "Fill Form" button click
btn.addEventListener("click", () => {
  if (btn.disabled) return; // Don’t do anything if button is disabled

  // Step 1: Get the active tab again
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    // Step 2: Tell the content script to actually fill the form
    chrome.tabs.sendMessage(tabs[0].id, { action: "fillFormSmart" }, (resp) => {
      if (chrome.runtime.lastError) {
        // If content script isn’t available, show error
        disableButton("❌ This page is not supported.");
        console.warn("Message failed:", chrome.runtime.lastError.message);
        return;
      }

      // Step 3: Handle response from content script
      if (!resp) {
        status.textContent = "❌ No response from content script.";
        return;
      }
      if (resp.ok) {
        status.textContent = "✅ Form filled!";
      } else if (resp.noForm) {
        status.textContent = "❌ No form detected on this page.";
      } else {
        status.textContent = "❌ Could not fill form.";
      }
    });
  });
});

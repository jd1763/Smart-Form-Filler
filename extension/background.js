chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getUserData") {
      fetch(chrome.runtime.getURL("userData.json"))
        .then((res) => res.json())
        .then((data) => sendResponse({ success: true, userData: data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // keeps the message channel open for async response
    }
  });
  
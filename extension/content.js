chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fillFormSmart") {
    console.log("Starting smart scan-fill...");

    chrome.runtime.sendMessage({ action: "getUserData" }, (response) => {
      if (!response.success) {
        console.error("Error loading userData.json:", response.error);
        return;
      }

      const userData = response.userData;
      const labels = Array.from(document.querySelectorAll("label"));
      const inputs = Array.from(document.querySelectorAll("input, select, textarea"));
      let delay = 0;

      // For address breakdowns
      const getAddressPart = (labelText) => {
        const lower = labelText.toLowerCase();
        if (lower.includes("street")) return userData.street || userData.address;
        if (lower.includes("city")) return userData.city;
        if (lower.includes("state")) return userData.state;
        if (lower.includes("zip")) return userData.zipcode || userData.zip;
        if (lower.includes("county")) return userData.county;
        return null;
      };

      inputs.forEach((input) => {
        const associatedLabel = labels.find(l => l.htmlFor === input.id)?.innerText || "";
        const attributes = [
          input.getAttribute("aria-label"),
          input.getAttribute("placeholder"),
          input.getAttribute("name"),
          input.id,
          associatedLabel
        ];

        const labelText = attributes.find(attr => typeof attr === "string") || "";

        // Try to match directly from userData keys
        const matchKey = Object.keys(userData).find(key =>
          attributes.some(attr => attr && attr.toLowerCase().includes(key.toLowerCase()))
        );

        // Try to infer address part
        const addressFill = getAddressPart(labelText);

        if (matchKey || addressFill) {
          setTimeout(() => {
            input.scrollIntoView({ behavior: "smooth", block: "center" });
            input.focus();
            input.style.border = "2px solid yellow";
            input.style.transition = "border 0.3s";

            const value = userData[matchKey] || addressFill || "";

            if (input.tagName === "SELECT") {
              for (const option of input.options) {
                if (option.text.toLowerCase().includes(value.toLowerCase())) {
                  input.value = option.value;
                  break;
                }
              }
            } else if (input.type === "checkbox" || input.type === "radio") {
              const labelMatch = labelText.toLowerCase();
              const userValue = (userData[matchKey] || "").toLowerCase();
              if (labelMatch.includes(userValue) || input.value.toLowerCase() === userValue) {
                input.checked = true;
              }
            } else {
              input.value = value;
            }

            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));

            console.log(`Filled "${matchKey || 'address'}": ${value}`);
          }, delay);
          delay += 350;
        }
      });

      sendResponse({ success: true });
    });

    return true; // Keeps sendResponse open
  }
});
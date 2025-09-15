// === CONFIG ===
const CONFIDENCE_THRESHOLD = 0.50; // If model confidence < 50%, highlight field
const LOW_CONF_CLASS = "ml-low-confidence"; // CSS class for low-confidence fields

// === STATE MAP (US) ===
// Two helper maps for dealing with states in forms.
// 1. STATE_TO_ABBR: "new jersey" -> "NJ"
// 2. ABBR_TO_STATE: "NJ" -> "New Jersey"
const STATE_TO_ABBR = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA","colorado":"CO","connecticut":"CT","delaware":"DE","district of columbia":"DC",
  "florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID","illinois":"IL","indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA",
  "maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN","mississippi":"MS","missouri":"MO","montana":"MT","nebraska":"NE",
  "nevada":"NV","new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK",
  "oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD","tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT",
  "virginia":"VA","washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY"
};
const ABBR_TO_STATE = Object.fromEntries(
  Object.entries(STATE_TO_ABBR).map(([k,v]) => [v, k.replace(/\b\w/g, c => c.toUpperCase())])
);

// === HELPER FUNCTIONS ===

// Normalize a string (trim, ensure string type)
function normalize(s){ return (s ?? "").toString().trim(); }
function lower(s){ return normalize(s).toLowerCase(); }

// Parse an address blob like "123 Main St, New York, NY 10001"
// -> returns { street, city, state, zip }
function parseAddressBlob(addr){
  const res = { street:"", city:"", state:"", zip:"" };
  const a = normalize(addr);
  if(!a) return res;

  const parts = a.split(",").map(p => p.trim());
  if(parts[0]) res.street = parts[0];
  if(parts[1]) res.city = parts[1];

  // Try to capture "State Zip"
  const stateZipMatch = a.match(/,\s*([A-Za-z]{2}|[A-Za-z ]+)\s*(\d{5})(-\d{4})?\b/);
  if(stateZipMatch){
    const rawState = lower(stateZipMatch[1]);
    res.state = STATE_TO_ABBR[rawState] || stateZipMatch[1].toUpperCase();
    res.zip = stateZipMatch[2];
  } else {
    // Otherwise, see if there’s a standalone state or zip
    const st = lower(parts[2] || "");
    if(st){
      res.state = STATE_TO_ABBR[st] || st.toUpperCase();
    }
    const zipM = a.match(/\b(\d{5})(-\d{4})?\b/);
    if(zipM) res.zip = zipM[1];
  }
  return res;
}

// Standardize state values (e.g. "new jersey" -> "NJ")
function normalizeStateValue(val){
  const v = lower(val);
  if(!v) return "";
  return STATE_TO_ABBR[v] || v.toUpperCase();
}

// Compare two strings ignoring punctuation/case (helps matching values in selects)
function sameNormalized(a,b){
  const na = lower(a).replace(/[^a-z0-9]/g,"");
  const nb = lower(b).replace(/[^a-z0-9]/g,"");
  return na===nb || na.includes(nb) || nb.includes(na);
}

// Build a “context string” around an input (label, placeholder, aria-label, etc.)
// This helps refine ML predictions (like deciding if "name" is first/last name).
function getContextString(inputEl, labelText){
  const bits = [
    labelText,
    inputEl.getAttribute("placeholder"),
    inputEl.getAttribute("aria-label"),
    inputEl.getAttribute("name"),
    inputEl.id
  ].filter(Boolean);
  return lower(bits.join(" "));
}

// Map ML class -> userData keys
function keysFor(pred){
  const map = {
    name: ["fullName","firstName lastName"],
    first_name: ["firstName"],
    last_name: ["lastName"],
    email: ["email"],
    phone: ["phoneNumber","phone"],
    street: ["street","address"],
    address: ["street","address"],
    city: ["city"],
    state: ["state"],
    zip: ["zip","zicode"],
    gender: ["gender"],
    dob: ["dob","dateOfBirth"],
    county: ["county"],
    linkedin: ["linkedin"],
    github: ["github"],
    title: ["jobTitle","job title"],
    checkbox: ["checkbox"],
    radio: ["radio"]
  };
  return map[pred] || [pred];
}

// Refine vague predictions using context
// e.g. "name" + label "First Name" -> first_name
function refinePrediction(pred, inputEl, labelText){
  const ctx = getContextString(inputEl, labelText);

  if(pred==="name"){
    if(ctx.includes("first")) return "first_name";
    if(ctx.includes("last")) return "last_name";
    if(ctx.includes("middle")) return "middle_name"; 
    return "name";
  }

  if(pred==="address" || pred==="street"){
    if(ctx.includes("state") || ctx.includes("province")) return "state";
    if(ctx.includes("city") || ctx.includes("town")) return "city";
    if(ctx.includes("zip") || ctx.includes("postal")) return "zip";
    if(ctx.includes("street") || ctx.includes("addr") || ctx.includes("line")) return "street";
    return pred;
  }

  if(pred==="zip" && (ctx.includes("postal") || ctx.includes("postcode"))) return "zip";

  return pred;
}

// Visually mark low-confidence fields so user knows to double-check
function highlightLowConfidence(el, confidence){
  el.classList.add(LOW_CONF_CLASS);
  el.title = `Low confidence: ${(confidence * 100).toFixed(1)}% — please double-check`;
}

// === Chrome messaging helpers ===
async function getUserData(){
  return new Promise((resolve)=>{
    chrome.runtime.sendMessage({ action:"getUserData" }, (resp)=>resolve(resp?.userData || {}));
  });
}

async function getPredictions(labels){
  return new Promise((resolve)=>{
    chrome.runtime.sendMessage({ action:"predictLabels", labels }, (resp)=>resolve(resp?.results || []));
  });
}

// Try to match <label> to its input field
function findInputForLabel(labelEl){
  const forId = labelEl.getAttribute("for");
  if(forId){
    const direct = document.getElementById(forId);
    if(direct) return direct;
  }
  const within = labelEl.querySelector("input, select, textarea");
  if(within) return within;
  let sib = labelEl.nextElementSibling;
  for(let i=0;i<3 && sib;i++,sib=sib.nextElementSibling){
    const found = sib.querySelector?.("input, select, textarea") || (sib.matches?.("input,select,textarea") ? sib : null);
    if(found) return found;
  }
  return null;
}

// Robustly set <select> value (works for state dropdowns, etc.)
function setSelectValue(selectEl, val){
  const targetAbbr = normalizeStateValue(val);
  const targetFull = ABBR_TO_STATE[targetAbbr] || val;

  // Try exact value/text
  for(const opt of Array.from(selectEl.options)){
    if(sameNormalized(opt.value, val) || sameNormalized(opt.textContent, val)) {
      selectEl.value = opt.value;
      return true;
    }
  }
  // Try state variants
  for(const opt of Array.from(selectEl.options)){
    const ov = normalize(opt.value);
    const ot = normalize(opt.textContent);
    if(sameNormalized(ov, targetAbbr) || sameNormalized(ot, targetAbbr) ||
       sameNormalized(ov, targetFull) || sameNormalized(ot, targetFull)){
      selectEl.value = opt.value;
      return true;
    }
  }
  return false;
}

// === MAIN LOGIC ===
async function scanAndFill(){
  const userData = await getUserData();
  const parsedFromBlob = parseAddressBlob(userData.address);

  // Step 1: Collect all label-input pairs (preferred), or just inputs if no labels
  const labelEls = Array.from(document.querySelectorAll("label")).filter(l => (l.innerText || "").trim().length > 0);
  let pairs = [];

  if(labelEls.length > 0){
    pairs = labelEls.map(l => ({
      labelEl: l,
      inputEl: findInputForLabel(l),
      labelText: (l.innerText || "").trim()
    })).filter(p => p.inputEl);
  } else {
    const inputs = Array.from(document.querySelectorAll("input, select, textarea"));
    pairs = inputs.map(inp => {
      const text = inp.getAttribute("placeholder") || inp.getAttribute("aria-label") || inp.getAttribute("name") || inp.id || "";
      return { labelEl: null, inputEl: inp, labelText: text.trim() };
    });
  }

  if(pairs.length === 0) return false;

  // Step 2: Ask API for predictions
  const results = await getPredictions(pairs.map(p => p.labelText));

  let filledAny = false;

  // Step 3: Try filling each field
  results.forEach((res, i) => {
    let { prediction, confidence } = res || {};
    const { inputEl, labelText } = pairs[i];
    if(!inputEl) return;

    prediction = refinePrediction(prediction, inputEl, labelText);
    const candidateKeys = keysFor(prediction);

    // Figure out what value to use from userData
    let val = undefined;
    if(prediction === "name"){
      val = userData.fullName || [userData.firstName, userData.lastName].filter(Boolean).join(" ").trim();
    } else if(prediction === "first_name"){
      val = userData.firstName;
    } else if(prediction === "last_name"){
      val = userData.lastName;
    } else if(prediction === "street"){
      val = userData.street || parsedFromBlob.street;
    } else if(prediction === "city"){
      val = userData.city || parsedFromBlob.city;
    } else if(prediction === "state"){
      val = userData.state ? normalizeStateValue(userData.state) : normalizeStateValue(parsedFromBlob.state);
    } else if(prediction === "zip"){
      val = userData.zip || userData.zicode || parsedFromBlob.zip;
    } else {
      // General lookup
      for(const k of candidateKeys){
        if(k.includes(" ")){ // e.g. "firstName lastName"
          const v = [userData.firstName, userData.lastName].filter(Boolean).join(" ").trim();
          if(v) { val = v; break; }
        } else if(userData[k]){
          val = userData[k];
          break;
        }
      }
    }

    if(!val) return;

    // Step 4: Actually fill the field
    const tag = inputEl.tagName.toLowerCase();
    const type = (inputEl.type || "").toLowerCase();
    let filled = false;

    if(tag === "select"){
      filled = setSelectValue(inputEl, val);
    } else if(type === "checkbox" || type === "radio"){
      if(val === true || String(val).toLowerCase() === "true"){
        inputEl.checked = true;
        filled = true;
      }
    } else {
      inputEl.value = val;
      filled = true;
    }

    // Fire input/change events so page scripts detect the change
    if(filled){
      inputEl.dispatchEvent(new Event("input", { bubbles:true }));
      inputEl.dispatchEvent(new Event("change", { bubbles:true }));

      // Highlight low-confidence predictions
      if(typeof confidence === "number" && confidence < CONFIDENCE_THRESHOLD){
        highlightLowConfidence(inputEl, confidence);
      }
      filledAny = true;
    }
  });

  return filledAny;
}

// --- Extension messaging: respond to popup.js ---
function hasFormishFields(){
  const labels = document.querySelectorAll("label");
  const inputs = document.querySelectorAll("input, select, textarea");
  return (labels.length > 0) || (inputs.length > 0);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if(request.action === "ping"){
    sendResponse({ ok:true });
    return;
  }
  if(request.action === "canFillProbe"){
    sendResponse({ hasForm: hasFormishFields() });
    return;
  }
  if(request.action === "fillFormSmart"){
    scanAndFill().then(filled => {
      if(filled) sendResponse({ ok:true });
      else sendResponse({ noForm:true });
    });
    return true; // keep channel open for async response
  }
});

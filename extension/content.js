(function () {
  const CONTENT_VERSION = "6.0.0";
  if (window.__SFF_CONTENT_VERSION__ === CONTENT_VERSION) {
    console.log("[content] already loaded (v" + CONTENT_VERSION + ") — skipping");
    return;
  }
  window.__SFF_CONTENT_VERSION__ = CONTENT_VERSION;

  console.log("[content] content.js injected v" + CONTENT_VERSION);

  // ---------- Catalog shown in popup ----------
  const ALL_FIELDS = {
    fullName: "Full Name",
    firstName: "First Name",
    lastName: "Last Name",
    gender: "Gender",
    dob: "Date of Birth",
    phoneNumber: "Phone Number",
    email: "Email",
    street: "Street",
    city: "City",
    state: "State",
    zip: "Zip",
    county: "County",
    linkedin: "LinkedIn",
    github: "GitHub",
    jobTitle: "Job Title",
    checkbox: "Checkbox",
    radio: "Radio",
    background_check: "Background Check Consent",
    company: "Company",
    demographics: "Demographics",
    document: "Resume/Document Upload",
    education: "Education",
    work_auth: "Work Authorization",
    referral_source: "Referral Source",
    role_description: "Role Description",
    social: "Social Profile",
    start_date: "Start Date",
    end_date: "End Date",
    terms_consent: "Terms Consent"
  };

  // ---------- ML → userData map ----------
  const MODEL_TO_USERDATA = {
    name: "fullName",
    first_name: "firstName",
    last_name: "lastName",
    email: "email",
    phone: "phoneNumber",
    phoneNumber: "phoneNumber",
    street: "street",
    address: "street",
    city: "city",
    state: "state",
    zip: "zip",
    postal: "zip",
    company: "company",
    job_title: "jobTitle",
    linkedin: "linkedin",
    github: "github",
    dob: "dob",
    birth_date: "dob",
    gender: "gender",
    fullName: "fullName",
    firstName: "firstName",
    lastName: "lastName"
  };

  // ---------- helpers ----------
  const lower = (s) => (s ?? "").toString().toLowerCase().trim();
  const norm  = (s) => lower(s).replace(/[^a-z0-9]/g, "");

  const STATE_TO_ABBR = {
    "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA","colorado":"CO","connecticut":"CT","delaware":"DE","district of columbia":"DC",
    "florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID","illinois":"IL","indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA",
    "maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN","mississippi":"MS","missouri":"MO","montana":"MT","nebraska":"NE",
    "nevada":"NV","new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK",
    "oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD","tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT",
    "virginia":"VA","washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY"
  };
  const ABBR_TO_STATE = Object.fromEntries(Object.entries(STATE_TO_ABBR).map(([k,v]) => [v, k.replace(/\b\w/g, c => c.toUpperCase())]));
  const toAbbr = (v) => STATE_TO_ABBR[lower(v)] || (v || "").toString().toUpperCase();
  const sameNormalized = (a,b) => { const A = norm(a), B = norm(b); return A===B || A.includes(B) || B.includes(A); };

  // ===== JD extraction =====
  const JD_SELECTORS = [
    "#jobDescriptionText",
    ".jobs-unified-description__content",
    ".jobs-description__content",
    "section.jobs-description__content",
    ".posting-contents",
    ".section.page-full-width .content .description",
    "[data-test='jobDescription']",
    ".job-description, article, main, [role='main']"
  ];

  function extractJD() {
    for (const sel of JD_SELECTORS) {
      const el = document.querySelector(sel);
      const text = (el?.innerText || el?.textContent || "").trim();
      if (text && text.length > 200) return text;
    }
    // fallback: largest text block
    const blocks = Array.from(document.querySelectorAll("main, article, section, div"));
    let best = "";
    for (const b of blocks) {
      const t = (b.innerText || "").trim();
      if (t.split(/\s+/).length > best.split(/\s+/).length) best = t;
    }
    return best.slice(0, 200000);
  }

  async function getFillerRunSummary() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["fillerRun"], (res) => resolve(res.fillerRun || null));
    });
  }

  // ---------- Event dispatch helpers ----------
  function fire(el, type) {
    try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch {}
  }
  function fireAll(el) {
    fire(el, "input");
    fire(el, "change");
    // Many frameworks (React/Vue) re-validate on blur
    if (typeof el.blur === "function") { try { el.blur(); } catch {} }
  }

  // ---------- Select helper (robust) ----------
  function setSelectValue(selectEl, rawVal){
    if (!selectEl) return false;
    const val = (rawVal ?? "").toString().trim();
    if (!val) return false;

    const abbr = toAbbr(val);
    const full = ABBR_TO_STATE[abbr] || val;
    const variants = [val, val.toUpperCase(), val.toLowerCase(), abbr, full].filter(Boolean);

    const nz = (s) => (s ?? "").toString().trim();
    const nrm = (s) => nz(s).toLowerCase().replace(/[^a-z0-9]/g, "");

    const commit = (idx) => {
      if (idx < 0) return false;
      selectEl.selectedIndex = idx;
      const opt = selectEl.options[idx];
      if (opt) opt.selected = true;
      fireAll(selectEl);
      return true;
    };

    // Pass 1: exact (value/text)
    for (let i = 0; i < selectEl.options.length; i++) {
      const o = selectEl.options[i];
      const ov = nz(o.value), ot = nz(o.textContent);
      if (variants.some(v => nz(v).toLowerCase() === ov.toLowerCase()
                           || nz(v).toLowerCase() === ot.toLowerCase())) return commit(i);
    }
    // Pass 2: loose normalized
    for (let i = 0; i < selectEl.options.length; i++) {
      const o = selectEl.options[i];
      const ovn = nrm(o.value), otn = nrm(o.textContent);
      if (variants.some(v => {
        const vn = nrm(v);
        return vn === ovn || vn === otn || ovn.includes(vn) || otn.includes(vn);
      })) return commit(i);
    }
    // Pass 3: explicit abbr/full
    const tryList = [abbr, full].filter(Boolean);
    for (let i = 0; i < selectEl.options.length; i++) {
      const o = selectEl.options[i];
      if (tryList.some(v => nrm(v) === nrm(o.value) || nrm(v) === nrm(o.textContent))) return commit(i);
    }
    return false;
  }

  // ---------- Label discovery (robust) ----------
  function labelTextFor(el){
    // 1) <label for=ID>
    if (el.id) {
      const forLab = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = forLab?.textContent?.trim();
      if (t) return t;
    }
    // 2) wrap <label> ... <input>
    let wrap = el.closest("label");
    if (wrap?.textContent?.trim()) return wrap.textContent.trim();

    // 3) common “row/group/field” containers
    const near = el.closest('[class*="row"], [class*="group"], [class*="field"], [class*="Form"], [role="group"]');
    if (near){
      const t = (near.querySelector('label')?.textContent
              || near.querySelector('.label, .field-label, [data-label]')?.textContent
              || near.getAttribute('aria-label')
              || "").trim();
      if (t) return t;
    }

    // 4) aria/placeholder/name/id as last resort
    return (el.getAttribute("aria-label")
      || el.getAttribute("placeholder")
      || el.getAttribute("name")
      || el.id
      || ""
    ).trim();
  }

  // ---------- Shadow DOM traversal ----------
  function collectFields(root=document){
    const out = [];
    const push = (el)=> {
      const tag = (el.tagName||"").toLowerCase();
      if (["input","textarea","select"].includes(tag) || el.isContentEditable) {
        const type = (el.type || "").toLowerCase();
        if (type === "hidden" || type === "password") return;
        out.push(el);
      }
    };
    const walk = (node) => {
      // regular DOM
      node.querySelectorAll("input, textarea, select, [contenteditable=''], [contenteditable='true']").forEach(push);
      // shadow roots
      node.querySelectorAll("*").forEach(n => { if (n.shadowRoot) walk(n.shadowRoot); });
    };
    walk(root);
    return out;
  }

  // ---------- Pair up inputs with labels (uses shadow DOM + robust labels) ----------
  function collectPairs() {
    const inputs = collectFields(document);
    return inputs.map((el) => ({ inputEl: el, labelText: labelTextFor(el) || "(unlabeled)" }));
  }

  // ---------- background messaging ----------
  async function getUserData() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "getUserData" }, (resp) => {
        if (!resp || resp.success === false) {
          console.error("[content] getUserData failed:", resp && resp.error);
          return resolve({});
        }
        resolve(resp.userData || {});
      });
    });
  }

  async function getPredictions(labels) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "predictLabels", labels }, (resp) => {
        if (!resp || resp.success === false) {
          console.warn("[content] predictLabels unavailable, using heuristics.");
          return resolve([]);
        }
        const arr = Array.isArray(resp.results) ? resp.results : [];
        resolve(arr);
      });
    });
  }

  // ---------- heuristic helpers ----------
  function context(inputEl, labelText){
    return [
      labelText,
      inputEl.getAttribute("placeholder"),
      inputEl.getAttribute("aria-label"),
      inputEl.getAttribute("name"),
      inputEl.id
    ].filter(Boolean).join(" ").toLowerCase();
  }
  function heuristicKey(inputEl, labelText){
    const c = context(inputEl, labelText);
    if (/first/.test(c)) return "firstName";
    if (/last|surname|family/.test(c)) return "lastName";
    if (/full.?name|applicant name|your name|name\b/.test(c)) return "fullName";
    if (/e-?mail|email address|contact email|work email|personal email/.test(c)) return "email";
    if (/phone|mobile|cell|telephone|contact number/.test(c)) return "phoneNumber";
    if (/\baddress line|street|addr(ess)?\b|line ?1\b/.test(c)) return "street";
    if (/\bcity|town\b/.test(c)) return "city";
    if (/\bstate|province|region\b/.test(c)) return "state";
    if (/\bzip|postal|postcode\b/.test(c)) return "zip";
    if (/linkedin/.test(c)) return "linkedin";
    if (/github|portfolio|site|website|url/.test(c)) return "github";
    if (/company|employer|organization|business|workplace/.test(c)) return "company";
    if (/job title|position|role|designation|title at|current position/.test(c)) return "jobTitle";
    if (/gender|sex\b/.test(c)) return "gender";
    if (/birth|dob|date of birth|birthday/.test(c)) return "dob";
    return null;
  }

  // ---------- set value robustly (inputs, selects, radios, checkboxes, contenteditable) ----------
  function setNodeValue(el, val){
    const tag = (el.tagName||"").toLowerCase();
    const type = (el.type || "").toLowerCase();

    try {
      if (tag === "select") {
        // try robust select matching, then fallback to raw value
        if (!setSelectValue(el, val)) { el.value = String(val); fireAll(el); }
        return true;
      }

      if (type === "checkbox") {
        const want = (val === true || String(val).toLowerCase() === "true");
        if (el.checked !== want) { el.checked = want; fireAll(el); }
        return true;
      }

      if (type === "radio") {
        // Try to find a sibling radio with matching label/value
        const name = el.getAttribute("name");
        if (name) {
          const group = el.ownerDocument.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
          for (const r of group) {
            const lt = labelTextFor(r);
            if (sameNormalized(lt, val) || sameNormalized(r.value, val)) {
              if (!r.checked) { r.checked = true; fireAll(r); }
              return true;
            }
          }
        }
        // fallback: set on the passed radio
        if (!el.checked) { el.checked = true; fireAll(el); }
        return true;
      }

      if (el.isContentEditable || el.getAttribute("contenteditable") === "" || el.getAttribute("contenteditable") === "true") {
        el.innerText = String(val);
        fireAll(el);
        return true;
      }

      // default text-like inputs/textarea
      el.value = String(val);
      fireAll(el);
      return true;
    } catch (e) {
      console.error("[content] setNodeValue error:", e);
      return false;
    }
  }

  // ---------- SELF-TEST: deterministic mapping without ML ----------
  function detectKeyByAttrs(inputEl) {
    const attrs = [
      inputEl.getAttribute("name"),
      inputEl.id,
      inputEl.getAttribute("placeholder"),
      inputEl.getAttribute("aria-label")
    ].filter(Boolean).map(x => x.toLowerCase());

    const has = (...needles) => attrs.some(a => needles.some(n => a.includes(n)));

    if (has("first")) return "firstName";
    if (has("last")) return "lastName";
    if (has("email")) return "email";
    if (has("phone", "tel")) return "phoneNumber";
    if (has("street", "address")) return "street";
    if (has("city", "town")) return "city";
    if (has("state", "province", "region")) return "state";
    if (has("zip", "postal", "postcode")) return "zip";
    return null;
  }

  function deterministicFill(userData, dryRun = true) {
    const inputs = collectFields(document);
    const filled = [];

    for (const el of inputs) {
      const key = detectKeyByAttrs(el);
      if (!key) continue;
      const val = userData?.[key];
      if (val == null || val === "") continue;

      if (!dryRun) setNodeValue(el, val);

      filled.push({ key, label: key, value: val, confidence: 0.99 });
    }
    return { inputs: inputs.length, filled };
  }

  // ---------- generic ML + heuristic filler ----------
  async function genericScanAndFill() {
    const userData = await getUserData();
    const pairs = collectPairs();
    const inputsCount = pairs.length;

    if (inputsCount === 0) {
      const notFilledAll = Object.entries(ALL_FIELDS).map(([k, label]) => ({ key: k, label }));
      return { ok: true, filled: [], notFilled: notFilledAll, inputs: 0 };
    }

    const labels = pairs.map((p) => p.labelText);
    let results = await getPredictions(labels);

    const mlEmpty = !Array.isArray(results) || results.length === 0;
    if (mlEmpty) results = labels.map(() => ({ prediction: null, confidence: 0 }));
    if (results.length !== pairs.length) {
      const normArr = [];
      for (let i = 0; i < pairs.length; i++) normArr[i] = results[i] || { prediction: null, confidence: 0 };
      results = normArr;
    }

    const filled = [];
    const seenKeys = new Set();

    results.forEach((res, i) => {
      const { inputEl, labelText } = pairs[i];
      let { prediction, confidence } = res || {};
      let mappedKey = MODEL_TO_USERDATA[prediction] || prediction;

      if (!mappedKey) {
        const guess = heuristicKey(inputEl, labelText);
        if (guess) { mappedKey = guess; confidence = confidence || 0.55; }
      }
      if (!mappedKey) return;

      const val = (userData || {})[mappedKey];
      if (val == null || val === "") return;

      try {
        const did = setNodeValue(inputEl, val);
        if (did) {
          filled.push({
            key: mappedKey,
            label: ALL_FIELDS[mappedKey] || labelText,
            value: val,
            confidence: typeof confidence === "number" ? +(confidence.toFixed(2)) : 0
          });
          seenKeys.add(mappedKey);
        }
      } catch (e) {
        console.error("[content] Error filling field:", { labelText, mappedKey, error: e });
      }
    });

    const notFilled = Object.entries(ALL_FIELDS)
      .filter(([k]) => !seenKeys.has(k))
      .map(([k, label]) => ({ key: k, label }));

    return { ok: true, filled, notFilled, inputs: inputsCount };
  }

  async function scanAndFill() {
    try {
      return await genericScanAndFill();
    } catch (e) {
      console.error("[content] scanAndFill fatal:", e);
      const notFilledAll = Object.entries(ALL_FIELDS).map(([k, label]) => ({ key: k, label }));
      return { ok: false, error: String(e), filled: [], notFilled: notFilledAll, inputs: 0 };
    }
  }

  // ---------- listener ----------
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    try {
      if (req.action === "ping") {
        sendResponse({ ok: true, v: CONTENT_VERSION }); return;
      }
      if (req.action === "probe") {
        const count = collectFields(document).length;
        sendResponse({ ok: true, inputs: count, v: CONTENT_VERSION }); return;
      }
      if (req.action === "getAllFieldCatalog") {
        const catalog = Object.entries(ALL_FIELDS).map(([key, label]) => ({ key, label }));
        sendResponse({ ok: true, catalog, v: CONTENT_VERSION }); return;
      }
      if (req.action === "content.selftest") {
        const dry = req?.dryRun !== false; // default true
        getUserData().then((ud) => {
          const result = deterministicFill(ud, dry);
          sendResponse({ ok: true, ...result, dryRun: dry });
        });
        return true;
      }
      if (req.action === "fillFormSmart") {
        scanAndFill().then(sendResponse);
        return true;
      }
      if (req.action === "EXT_GET_JOB_DESC") {
        const jd = extractJD();
        sendResponse({ ok: true, jd });
        return;
      }
      if (req.action === "EXT_GET_FILLER_SUMMARY") {
        getFillerRunSummary().then((summary) => sendResponse({ ok: true, summary }));
        return true;
      }
    } catch (e) {
      console.error("[content] listener error:", e);
      sendResponse({ ok: false, error: String(e) });
    }
  });
})();

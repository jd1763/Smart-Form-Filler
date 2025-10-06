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

  // === Week 8 ===
// ----- Month names + date formatting -----
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function fmtMonthYear(m, y, style="long"){
  if (!m && !y) return "";
  if (style === "MM/YYYY") {
    const mm = String(m||"").padStart(2,"0");
    return `${mm}/${y||""}`.trim();
  }
  const monthName = MONTHS[(Number(m)||0)-1] || "";
  return `${monthName} ${y||""}`.trim();
}

// ----- Try multiple values on either a select or input -----
function trySetSelectOrInput(el, values){
  for (const v of values){
    if (!v) continue;
    if (el.tagName.toLowerCase()==="select") {
      if (setSelectValue(el, v)) return true;        // your existing robust matcher
    } else {
      el.value = String(v);
      fireAll(el);
      return true;
    }
  }
  // If it's a select and nothing matched, fallback to closest option (token overlap)
  if (el.tagName.toLowerCase()==="select") {
    return trySelectClosest(el, values);
  }
  return false;
}

// ----- "Closest" select option by token overlap (lightweight fuzzy) -----
function normTokens(s){
  return String(s||"").toLowerCase().replace(/[^a-z0-9+./\s-]/g," ").split(/\s+/).filter(Boolean);
}
function overlapScore(a, b){
  const A = new Set(normTokens(a)), B = new Set(normTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.max(A.size, B.size);
}
function trySelectClosest(select, candidates){
  const opts = Array.from(select.options);
  let bestIdx = -1, bestScore = 0;
  for (let i=0;i<opts.length;i++){
    const text = opts[i].text || opts[i].value;
    for (const cand of candidates){
      const s = overlapScore(text, cand);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
  }
  if (bestIdx >= 0 && bestScore >= 0.5) {      // only pick if reasonably close
    select.selectedIndex = bestIdx;
    select.dispatchEvent(new Event("change", { bubbles:true }));
    return true;
  }
  return false;
}
  
  // === Simple profile-based filler (Week 7) ===
  // Lightweight helpers you can call with a structured profile object.
  function _setValue(el, val) {
    if (!el) return false;
    try {
      el.focus();
      el.value = String(val ?? "");
      fireAll(el);
      return true;
    } catch { return false; }
  }

  function _setSelect(select, value) {
    if (!select) return false;
    // Reuse robust select matching from setSelectValue
    return setSelectValue(select, value);
  }

  function _setCheckboxesByName(name, values) {
    const want = new Set((values || []).map(v => String(v).toLowerCase()));
    const boxes = document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`);
    let hit = false;
    boxes.forEach(b => {
      const val = String(b.value || "").toLowerCase();
      if (want.has(val) && !b.checked) { b.click(); hit = true; }
    });
    return hit;
  }

  // Try a few id/name candidates
  function _byIdOrName(...ids) {
    for (const id of ids) {
      const el = document.getElementById(id) || document.querySelector(`[name="${CSS.escape(id)}"]`);
      if (el) return el;
    }
    return null;
  }

  // Map of canonical profile keys → common id/name synonyms on forms
  const PROFILE_MAP = {
    firstName:  ["first_name_input","firstName","first_name","fname","first"],
    lastName:   ["last_name_input","lastName","last_name","lname","last","surname","family_name"],
    email:      ["email_input","email","emailAddress","contact_email"],
    phoneNumber:["phone_input","phone","mobile","tel","telephone"],
    linkedin:   ["linkedin_url","linkedin","profile_linkedin"],
    github:     ["github_url","github","portfolio","website","site","url"],

    // Address
    street:     ["addr_line1","address","address1","street","address_line1","line1"],
    city:       ["addr_city","city","town"],
    state:      ["addr_state","state","province","region","stateProvince"],
    zip:        ["addr_zip","zip","postal","postcode","postal_code"],
    country:    ["country_sel","country"],

    // Employment / education (examples)
    company:    ["company","employer","organization"],
    jobTitle:   ["job_title","title","position","role"],
    start_date: ["start_date","employment_start","start"],
    end_date:   ["end_date","employment_end","end"],

    // Radios / selects
    gender:     ["gender","sex"],
    dob:        ["dob","birth_date","date_of_birth"]
  };

  // Fill by direct key → element mapping
  function fillFromProfile(profile = {}) {
    let fills = 0;

    // Inputs & selects by PROFILE_MAP
    for (const [key, ids] of Object.entries(PROFILE_MAP)) {
      const val = profile[key];
      if (val == null || val === "") continue;

      const el = _byIdOrName(...ids);
      if (!el) continue;

      const tag = (el.tagName||"").toLowerCase();
      const type = (el.type || "").toLowerCase();

      if (tag === "select") {
        if (_setSelect(el, val)) fills++;
        continue;
      }

      if (type === "radio") {
        // choose by label/value match within group
        const name = el.getAttribute("name") || ids.find(Boolean);
        if (name) {
          const group = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
          for (const r of group) {
            const lt = labelTextFor(r);
            if (sameNormalized(lt, val) || sameNormalized(r.value, val)) {
              if (!r.checked) { r.checked = true; fireAll(r); fills++; }
              break;
            }
          }
        }
        continue;
      }

      if (type === "checkbox") {
        // If profile value is boolean, set this single box; if array, use name-based group set
        if (Array.isArray(val)) {
          const name = el.getAttribute("name");
          if (name) { if (_setCheckboxesByName(name, val)) fills++; }
        } else {
          const want = (val === true || String(val).toLowerCase() === "true");
          if (el.checked !== want) { el.checked = want; fireAll(el); fills++; }
        }
        continue;
      }

      if (el.isContentEditable || el.getAttribute("contenteditable") === "" || el.getAttribute("contenteditable") === "true") {
        el.innerText = String(val);
        fireAll(el);
        fills++;
        continue;
      }

      if (_setValue(el, val)) fills++;
    }

    // Example: skills checkboxes by shared name=skills
    if (Array.isArray(profile.skills) && profile.skills.length) {
      if (_setCheckboxesByName("skills", profile.skills)) fills++;
    }

    return fills;
  }

    // === Repeating group filler (education[], experience[]) ===
  // Strategy:
  //  1) Find groups/sections by common patterns (fieldset, section, data-section="education", etc.).
  //  2) For each found block, try to locate child controls via id/name/label synonyms.
  //  3) Fill items[i] into block i (up to min(blocks, items.length)).

  function queryGroupBlocks(hints) {
    // Try the most specific selectors first, then fall back.
    const sels = [
      ...hints.map(h => `[data-section="${h}"]`),
      ...hints.map(h => `[data-group="${h}"]`),
      ...hints.map(h => `section.${h}, .${h}-section, .${h}-block, .${h}-item`),
      ...hints.map(h => `fieldset.${h}, fieldset[data-type="${h}"]`),
      ...hints.map(h => `div.${h}, div.${h}-item, div.${h}-block`)
    ];
    const seen = new Set();
    const blocks = [];
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach(el => {
        if (!seen.has(el)) { seen.add(el); blocks.push(el); }
      });
      if (blocks.length) break; // keep first match set to avoid duplicates
    }
    // If nothing matched, fall back to generic repeaters:
    if (!blocks.length) {
      document.querySelectorAll("fieldset, section, .group, .repeater, .repeatable").forEach(el => {
        if (!seen.has(el)) { seen.add(el); blocks.push(el); }
      });
    }
    return blocks;
  }

  function findInBlock(block, idsOrNames) {
    for (const key of idsOrNames) {
      const el = block.querySelector(`#${CSS.escape(key)}`) ||
                 block.querySelector(`[name="${CSS.escape(key)}"]`);
      if (el) return el;
    }
    // Try label text within block
    for (const key of idsOrNames) {
      const lc = key.replace(/[_-]/g, " ").toLowerCase();
      const labeled = Array.from(block.querySelectorAll("label")).find(l => (l.innerText||"").trim().toLowerCase().includes(lc));
      if (labeled) {
        const forId = labeled.getAttribute("for");
        if (forId) {
          const byFor = block.querySelector(`#${CSS.escape(forId)}`);
          if (byFor) return byFor;
        }
        // nearest input/select/textarea
        const nearby = labeled.parentElement?.querySelector("input,select,textarea");
        if (nearby) return nearby;
      }
    }
    return null;
  }

  // Per-group field synonym maps
  const EDU_FIELD_MAP = {
    school:    ["school","university","college","institute","education_school"],
    degree:    ["degree","qualification"],
    field:     ["field","major","study","field_of_study"],
    startDate: ["start","start_date","education_start","from"],
    endDate:   ["end","end_date","education_end","to"],
    gpa:       ["gpa","grade","cgpa"]
  };  

  const EXP_FIELD_MAP = {
    company:    ["company","employer","organization","org","company_name"],
    jobTitle:   ["title","job_title","position","role"],
    startDate:  ["start","start_date","employment_start","from"],
    endDate:    ["end","end_date","employment_end","to"],
    description:["description","summary","role_description","responsibilities","duties"]
  };  

  function fillEducationArray(edus = []) {
    if (!Array.isArray(edus) || !edus.length) return 0;
    const blocks = queryGroupBlocks(["education","edu","school"]);
    let filled = 0;
  
    for (let i = 0; i < Math.min(blocks.length, edus.length); i++) {
      const b = blocks[i], item = edus[i];
  
      for (const [key, synonyms] of Object.entries(EDU_FIELD_MAP)) {
        const el = findInBlock(b, synonyms);
        if (!el) continue;
  
        // Degree: try short/long/both ("BS", "Bachelor of Science", "BS — Bachelor of Science")
        if (key === "degree") {
          const short = (item.degreeShort || "").trim();
          const long  = (item.degreeLong  || "").trim();
          const both1 = short && long ? `${short} — ${long}` : "";
          const both2 = short && long ? `${short} - ${long}`  : "";
          const candidates = [short, long, both1, both2].filter(Boolean);
          if (candidates.length && trySetSelectOrInput(el, candidates)) filled++;
          continue;
        }
  
        // Dates: prefer "Month YYYY", fallback "MM/YYYY"
        if (key === "startDate") {
          const vals = [
            fmtMonthYear(item.startMonth, item.startYear, "long"),
            fmtMonthYear(item.startMonth, item.startYear, "MM/YYYY")
          ];
          if (trySetSelectOrInput(el, vals)) filled++;
          continue;
        }
        if (key === "endDate") {
          const vals = [
            fmtMonthYear(item.endMonth, item.endYear, "long"),
            fmtMonthYear(item.endMonth, item.endYear, "MM/YYYY")
          ];
          if (trySetSelectOrInput(el, vals)) filled++;
          continue;
        }
  
        // Everything else
        const val = item[key];
        if (val != null) {
          if (el.tagName.toLowerCase() === "select") setSelectValue(el, val);
          else { el.value = String(val); fireAll(el); }
          filled++;
        }
      }
    }
    return filled;
  }  

  function fillExperienceArray(exps = []) {
    if (!Array.isArray(exps) || !exps.length) return 0;
    const blocks = queryGroupBlocks(["experience","exp","employment","work"]);
    let filled = 0;
  
    for (let i = 0; i < Math.min(blocks.length, exps.length); i++) {
      const b = blocks[i], item = exps[i];
  
      for (const [key, synonyms] of Object.entries(EXP_FIELD_MAP)) {
        const el = findInBlock(b, synonyms);
        if (!el) continue;
  
        if (key === "startDate") {
          const vals = [
            fmtMonthYear(item.startMonth, item.startYear, "long"),
            fmtMonthYear(item.startMonth, item.startYear, "MM/YYYY")
          ];
          if (trySetSelectOrInput(el, vals)) filled++;
          continue;
        }
        if (key === "endDate") {
          const vals = [
            fmtMonthYear(item.endMonth, item.endYear, "long"),
            fmtMonthYear(item.endMonth, item.endYear, "MM/YYYY")
          ];
          if (trySetSelectOrInput(el, vals)) filled++;
          continue;
        }
  
        let val = item[key];
        if (val != null) {
          if (el.tagName.toLowerCase() === "select") setSelectValue(el, val);
          else { el.value = String(val); fireAll(el); }
          filled++;
        }
      }
    }
    return filled;
  }
  
  // Wrap into the main profile filler: call these after the scalar fields
  function fillFromProfileWithArrays(profile = {}) {
    let total = 0;
    total += fillFromProfile(profile.personal || profile); // reuse singles (firstName, etc.)
    // address/links if your form uses single blocks (outside repeaters)
    const addr = profile.address || {};
    const links = profile.links || {};
    total += fillFromProfile({ ...addr, ...links });

    total += fillEducationArray(profile.education || []);
    total += fillExperienceArray(profile.experience || []);
    return total;
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
      if (req.action === "fillFormSmart") {
        scanAndFill().then(sendResponse);
        return true;
      }
      if (req.action === "EXT_GET_JOB_DESC") {
        const jd = extractJD();
        sendResponse({ ok: true, jd });
        return;
      }
      if (req.action === "EXT_FILL_FROM_PROFILE") {
        try {
          const profile = req?.profile || {};
          const count = fillFromProfileWithArrays(profile);
          sendResponse({ ok: true, filledCount: count });
        } catch (e) {
          console.error("[content] EXT_FILL_FROM_PROFILE error:", e);
          sendResponse({ ok: false, error: String(e) });
        }
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

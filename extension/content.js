(function () {
  const CONTENT_VERSION = "6.1.0";
  if (window.__SFF_CONTENT_VERSION__ === CONTENT_VERSION) {
    console.log("[content] already loaded (v" + CONTENT_VERSION + ") — skipping");
    return;
  }
  window.__SFF_CONTENT_VERSION__ = CONTENT_VERSION;

  // ---- bring helpers into local scope ----
  const H = window.H || window.SFFHelpers || {};
  const {
    lower, norm, sameNormalized, STATE_TO_ABBR, ABBR_TO_STATE = {}, toAbbr = (s) => s, normCountry = (s) => s,
    inferNamePartFromLabel, splitFullName, inferAddressPartFromLabel,
    resolveValueAndKey = (k, lbl, ud) => ({ value: (ud||{})[k] ?? "", key: k }),
    fmtMonthYear, scalarize,   toISODate = (s) => s,
    toISOMonth = (s) => s,
    normalizeToken, canonGender, normTokens, overlapScore
  } = H;

  // small degree aliases used by select smart matcher
  const DEGREE_ALIASES = {
    "bachelorofscience": ["bs", "b.s.", "b sc", "b.sc", "bachelor of science"],
    "bachelorofarts":    ["ba", "b.a.", "bachelor of arts"],
    "associateofscience":["as", "a.s.", "associate of science"],
    "associateofarts":   ["aa", "a.a.", "associate of arts"],
    "masterscience":     ["ms", "m.s.", "master of science", "msc", "m.sc"],
    "masterarts":        ["ma", "m.a.", "master of arts"]
  };
  const _nz   = v => (v ?? "").toString().trim();
  const _norm = s => _nz(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

  function chooseSelectOption(el, desired, extraSynonyms = []) {
    if (!el || el.tagName?.toLowerCase() !== "select") return false;
    const want = _norm(desired);
    const opts = Array.from(el.options || []).map((o,i)=>({
      i,
      text: _nz(o.textContent),
      value: _nz(o.value),
      ntext: _norm(o.textContent),
      nvalue: _norm(o.value)
    }));
  
    // exact normalized text/value
    let hit = opts.find(o => o.ntext === want || o.nvalue === want);
    if (hit) { el.selectedIndex = hit.i; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); return true; }
  
    // synonyms normalized
    for (const syn of extraSynonyms) {
      const ns = _norm(syn);
      hit = opts.find(o => o.ntext === ns || o.nvalue === ns);
      if (hit) { el.selectedIndex = hit.i; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); return true; }
    }
  
    // contains match
    hit = opts.find(o => o.ntext.includes(want) || o.nvalue.includes(want));
    if (hit) { el.selectedIndex = hit.i; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); return true; }
  
    return false;
  }

  function chooseRadio(elOrRoot, desired, extraSynonyms = []) {
    const root = elOrRoot.closest?.("form, fieldset, .form-group, .grid, .row") || document;
    const radios = root.querySelectorAll('input[type="radio"]');
    if (!radios.length) return false;
    const want = _norm(desired);
    const cand = new Set([desired, ...extraSynonyms].map(_norm));
  
    for (const r of radios) {
      // try value
      if (cand.has(_norm(r.value))) { r.click?.(); r.dispatchEvent(new Event("change",{bubbles:true})); return true; }
      // try associated label text
      const lab = root.querySelector(`label[for="${r.id}"]`) || r.closest("label");
      const ltxt = _nz(lab?.textContent || "");
      if (ltxt && (cand.has(_norm(ltxt)) || _norm(ltxt) === want)) { r.click?.(); r.dispatchEvent(new Event("change",{bubbles:true})); return true; }
    }
    // final pass: any label containing desired
    for (const r of radios) {
      const lab = root.querySelector(`label[for="${r.id}"]`) || r.closest("label");
      const ltxt = _nz(lab?.textContent || "");
      if (ltxt && (_norm(ltxt).includes(want))) { r.click?.(); r.dispatchEvent(new Event("change",{bubbles:true})); return true; }
    }
    return false;
  }
  
  console.log("[content] content.js injected v" + CONTENT_VERSION, "helpers:", H.HVER || "missing");

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
    fullName: "fullName",
    first_name: "firstName",
    firstName: "firstName",
    given_name: "firstName",
    last_name: "lastName",
    lastName: "lastName",
    surname: "lastName",
    family_name: "lastName",

    email: "email",
    email_address: "email",
    emailAddress: "email",
    contact_email: "email",
    work_email: "email",
    personal_email: "email",

    phone: "phoneNumber",
    phone_number: "phoneNumber",
    phoneNumber: "phoneNumber",
    mobile: "phoneNumber",
    cell: "phoneNumber",
    telephone: "phoneNumber",
    contact_number: "phoneNumber",

    street: "street",
    address: "street",
    address1: "street",
    address_line1: "street",
    address_line_1: "street",
    addr_line1: "street",
    line1: "street",

    city: "city",
    town: "city",
    state: "state",
    province: "state",
    region: "state",
    zip: "zip",
    postal: "zip",
    postal_code: "zip",
    postcode: "zip",
    country: "country",
    nation: "country",
    county: "county",

    linkedin: "linkedin",
    github: "github",
    portfolio: "github",
    website: "website",

    company: "company",
    employer: "company",
    job_title: "jobTitle",
    title: "jobTitle",

    dob: "dob",
    birth_date: "dob",
    gender: "gender"
  };

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
    const blocks = Array.from(document.querySelectorAll("main, article, section, div"));
    let best = "";
    for (const b of blocks) {
      const t = (b.innerText || "").trim();
      if (t.split(/\s+/).length > best.split(/\s+/).length) best = t;
    }
    return best.slice(0, 200000);
  }

// Find a button by visible text (for dynamic adders)
function findButtonByText(regex) {
  const cand = Array.from(document.querySelectorAll(
    'button, [role="button"], input[type="button"], input[type="submit"]'
  ));
  return cand.find(el => regex.test((el.textContent || el.value || "").trim().toLowerCase())) || null;
}

// Parse month/year string -> {month, year}
function _parseMY(raw) {
  const s = (raw || "").toString().trim();
  let m;
  if ((m = s.match(/^(\d{1,2})[\/\-](\d{4})$/)))      return { month: +m[1], year: +m[2] };           // 02/2021
  if ((m = s.match(/^(\d{4})-(\d{2})$/)))             return { month: +m[2], year: +m[1] };           // 2021-02
  if ((m = s.match(/^([A-Za-z]+)\s+(\d{4})$/))) {                                               // February 2021
    const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    const idx = months.indexOf(m[1].toLowerCase());
    if (idx >= 0) return { month: idx+1, year: +m[2] };
  }
  return null;
}

// Best-effort fuzzy set for month/year SELECTs
function setMonthSelect(el, my) {
  if (!el || el.tagName?.toLowerCase() !== "select" || !my) return false;
  const want = String(my.month);
  const want2 = want.padStart(2, "0");
  const monthName = ["January","February","March","April","May","June","July","August","September","October","November","December"][my.month-1] || "";

  const opts = Array.from(el.options || []).map((o,i)=>({
    i,
    text: (o.textContent || "").trim(),
    value: (o.value || "").trim()
  }));

  const tests = [
    o => o.value === want || o.value === want2,
    o => o.text === want || o.text === want2,
    o => o.text.toLowerCase() === monthName.toLowerCase(),
    o => o.text.toLowerCase().startsWith(monthName.slice(0,3).toLowerCase())
  ];

  for (const t of tests) {
    const hit = opts.find(t);
    if (hit) { el.selectedIndex = hit.i; el.dispatchEvent(new Event("change",{bubbles:true})); return true; }
  }
  return false;
}

function setYearSelect(el, my) {
  if (!el || el.tagName?.toLowerCase() !== "select" || !my) return false;
  const want = String(my.year);
  const opts = Array.from(el.options || []).map((o,i)=>({i, text:(o.textContent||"").trim(), value:(o.value||"").trim()}));
  const hit = opts.find(o => o.value === want) || opts.find(o => o.text === want);
  if (hit) { el.selectedIndex = hit.i; el.dispatchEvent(new Event("change",{bubbles:true})); return true; }
  return false;
}

  // ====== STEP 1 DETECTOR (content.js) ======
(function(){
  const SFF_NS = "SFF";

  function textClean(s) {
    return (s || "")
      .replace(/\s+/g, " ")
      .replace(/[ \t\r\n]+/g, " ")
      .trim();
  }

  function getLabelViaFor(el) {
    if (!el.id) return null;
    const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (!lab) return null;
    const txt = textClean(lab.textContent);
    if (!txt) return null;
    return { text: txt, reason: 'label[for]' };
  }

  function getLabelViaWrapper(el) {
    // <label><input ...> Name</label>
    const lab = el.closest('label');
    if (!lab) return null;
    const txt = textClean(lab.textContent);
    if (!txt) return null;
    return { text: txt, reason: 'label>input' };
  }

  function getLabelNearby(el) {
    // a) previous sibling <label>
    let n = el.previousElementSibling;
    if (n && n.tagName === 'LABEL') {
      const t = textClean(n.textContent);
      if (t) return { text: t, reason: 'sibling<label' };
    }
  
    // b) previous sibling text in common wrappers (div/p/strong/span)
    const sib = el.previousElementSibling;
    if (sib && /^(div|p|strong|span)$/i.test(sib.tagName)) {
      const t = textClean(sib.textContent);
      if (t) return { text: t, reason: 'sibling:text' };
    }
  
    // c) parent container’s first <label>
    let p = el.parentElement;
    if (p) {
      const lab = p.querySelector(':scope > label');
      if (lab) {
        const t = textClean(lab.textContent);
        if (t) return { text: t, reason: 'parent>label' };
      }
    }
  
    // d) look up a couple levels for a header-like element preceding the field
    let up = el.parentElement;
    for (let hops = 0; up && hops < 3; hops++, up = up.parentElement) {
      // sibling heading above
      const prev = up.previousElementSibling;
      if (prev && /^(h1|h2|h3|h4|h5|h6|p|div)$/i.test(prev.tagName)) {
        const t = textClean(prev.textContent);
        if (t) return { text: t, reason: 'header-above' };
      }
      // any child label in this block
      const lab = up.querySelector(':scope > label');
      if (lab) {
        const t = textClean(lab.textContent);
        if (t) return { text: t, reason: 'ancestor>label' };
      }
    }
  
    // e) aria-describedby
    const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (ids.length) {
      for (const id of ids) {
        const d = document.getElementById(id);
        if (d) {
          const t = textClean(d.textContent);
          if (t) return { text: t, reason: 'aria-describedby' };
        }
      }
    }
    return null;
  }  

  function getLabelFromAttrs(el) {
    const aria = textClean(el.getAttribute('aria-label'));
    if (aria) return { text: aria, reason: 'aria-label' };
    const ph = textClean(el.getAttribute('placeholder'));
    if (ph) return { text: ph, reason: 'placeholder' };
    const nm = textClean(el.getAttribute('name'));
    if (nm) return { text: nm, reason: 'name' };
    return null;
  }

  function getLabelFromUpload(el) {
    const t = tagOf(el);
    const ty = typeOf(el);
    if (!(t === 'input' && ty === 'file')) return null;
  
    const accept = (el.getAttribute('accept') || '').toLowerCase();
    const idnm = ((el.id || '') + ' ' + (el.name || '')).toLowerCase();
  
    const saysResume = /resume|cv/.test(idnm) || /pdf|doc/.test(accept);
    const saysDoc = /document|attachment|file|upload/.test(idnm) || /pdf|doc|docx/.test(accept);
  
    if (saysResume) return { text: 'Upload Resume', reason: 'file:accept|name' };
    if (saysDoc)    return { text: 'Supporting Document', reason: 'file:accept|name' };
  
    // If nothing explicit, still tag as a generic upload so it appears in the list
    return { text: 'Upload File', reason: 'file:generic' };
  }  

  function tagOf(el) {
    return (el.tagName || '').toLowerCase();
  }

  function typeOf(el) {
    return (el.getAttribute('type') || '').toLowerCase();
  }

  function cssPath(el) {
    // short readable selector for debugging
    if (!(el instanceof Element)) return '';
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      let part = el.nodeName.toLowerCase();
      if (el.id) { part += `#${el.id}`; parts.unshift(part); break; }
      let sib = el;
      let idx = 1;
      while ((sib = sib.previousElementSibling)) {
        if (sib.nodeName === el.nodeName) idx++;
      }
      part += `:nth-of-type(${idx})`;
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function isFillable(el) {
    const t = tagOf(el);
    const ty = typeOf(el);
  
    if (t === 'input') {
      // Exclude only things we truly never fill
      if (['button','submit','reset','image','hidden'].includes(ty)) return false;
      // Include file inputs (we'll detect them; filling is step 3)
      return true; // text, email, tel, date, radio, checkbox, file, etc.
    }
    if (t === 'textarea' || t === 'select') return true;
  
    return false;
  }  

  function hasKeyword(txt, words) {
    const s = (txt || "").toLowerCase();
    return words.some(w => s.includes(w));
  }
  
  function inferContextFromHeadings(el) {
    // look up to 3 ancestor blocks and their previous sibling headings
    let up = el.parentElement;
    for (let hops = 0; up && hops < 3; hops++, up = up.parentElement) {
      // direct heading above
      const prev = up.previousElementSibling;
      if (prev && /^(h1|h2|h3|h4|h5|h6|legend|p|div)$/i.test(prev.tagName)) {
        const t = (prev.textContent || "").trim();
        if (hasKeyword(t, ["education","school","university","college","degree","academic"])) return "education";
        if (hasKeyword(t, ["employment","experience","work history","work experience","job","career","position","employer","company"])) return "employment";
      }
      // fieldset legend
      const legend = up.querySelector(":scope > legend");
      if (legend) {
        const t = legend.textContent || "";
        if (hasKeyword(t, ["education","school","university","college","degree","academic"])) return "education";
        if (hasKeyword(t, ["employment","experience","work history","work experience","job","career","position","employer","company"])) return "employment";
      }
    }
    return null;
  }
  
  function inferContextFromSiblings(el) {
    // look in the closest block for sibling labels to hint the section
    const block = el.closest("form, section, fieldset, div");
    if (!block) return null;
    const text = (block.textContent || "").toLowerCase();
    const eduHit = /university|college|institute|degree|major|gpa|graduation/.test(text);
    const empHit = /company|employer|job title|position|employment|start date|end date|role/.test(text);
    if (eduHit && !empHit) return "education";
    if (empHit && !eduHit) return "employment";
    return null;
  }
  
  function inferContext(el) {
    return inferContextFromHeadings(el) || inferContextFromSiblings(el) || null;
  }  

  // make these available to code outside the IIFE
  window.SFF_inferContext = inferContext;
  window.SFF_getEducationIndexForElement = getEducationIndexForElement;

// Return a UNIQUE list of education row elements.
// Prefer #eduList .item (your test page), then fall back to generic detection.
function getEducationRows(root = document) {
  const out = [];
  const seen = new Set();
  const add = (el) => { if (el && !seen.has(el)) { seen.add(el); out.push(el); } };

  // 1) Ultimate test explicit container
  const listEl = root.querySelector('#eduList');
  if (listEl) {
    listEl.querySelectorAll('.item').forEach(add);
    return out;
  }

  // 2) Common section ids
  root.querySelectorAll('section#education .item, section#school .item').forEach(add);

  // 3) Other explicit markers
  root.querySelectorAll('[data-edu-item], .education-item, .edu-block').forEach(add);

  // 4) Heuristic: any container that has school/degree/field inputs
  root.querySelectorAll(
    '[data-k="school"], [name*="school"], [data-k="degreeShort"], [data-k="field"], [name*="field"]'
  ).forEach((el) => {
    const row =
      el.closest('.item, .row, .education, .fieldset, li, .grid, fieldset, section, .card') ||
      el.parentElement;
    add(row);
  });

  return out;
}

  // Determine which education entry this field belongs to (0-based)
  function getEducationIndexForElement(el) {
    try {
      if (!el || !document) return 0;
      const rows = detectAllFields(); // already defined above
      const schools = (rows || []).filter(r =>
        r && r.context === "education" &&
        /\b(university|college|institute|school)\b/i.test(r.labelText || "")
      );
      let idx = 0;
      for (const r of schools) {
        const n = r.selector ? document.querySelector(r.selector) : null;
        if (!n) continue;
        // count all school inputs that appear before (or are) this element
        const before = n.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING;
        if (before || n === el) idx++;
      }
      return Math.max(0, idx - 1);
    } catch (_) {
      return 0;
    }
  }

  function findGroupQuestion(el) {
    // 1) If inside a <fieldset>, prefer its <legend> — but ignore section-y legends
    const fs = el.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector(':scope > legend');
      const legendText = lg && lg.textContent ? lg.textContent.trim() : '';

      // Suppress section headers like “Skills”, “Key Skills”, “Skills & Highest Education”
      const lt = legendText.toLowerCase();
      const isSectionyLegend = /\bskills?\b/.test(lt); // add more phrases here if needed

      if (legendText && !isSectionyLegend) {
        return { text: legendText, reason: 'fieldset>legend' };
      }
    }
  
    // 2) Look upwards for a heading or strong label immediately above the group
    let up = el.closest('div, section, form') || el.parentElement;
    for (let hops = 0; up && hops < 3; hops++, up = up.parentElement) {
      const prev = up.previousElementSibling;
      if (prev && /^(h1|h2|h3|h4|h5|h6|p|div)$/i.test(prev.tagName)) {
        const t = (prev.textContent || '').trim();
        if (t) return { text: t, reason: 'header-above' };
      }
      const lab = up.querySelector(':scope > label');
      if (lab) {
        const t = (lab.textContent || '').trim();
        if (t) return { text: t, reason: 'ancestor>label' };
      }
    }
  
    // 3) As a fallback, if the radio/checkbox has aria-labelledby/aria-describedby referencing a question
    const ids = (el.getAttribute('aria-labelledby') || el.getAttribute('aria-describedby') || '')
                  .split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const n = document.getElementById(id);
      if (n) {
        const t = (n.textContent || '').trim();
        if (t) return { text: t, reason: 'aria-labeled' };
      }
    }
  
    return null; // unknown
  }
  
  function getOptionLabel(el) {
    // label that is directly tied to a single option (e.g., Yes / No)
    // via wrapper <label><input>Yes</label> or <label for=id>Yes</label>
    // We try wrapper first:
    const wrap = el.closest('label');
    if (wrap) {
      const t = (wrap.textContent || '').trim();
      if (t) return { text: t, reason: 'label>input' };
    }
    // then for=[id]
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) {
        const t = (lab.textContent || '').trim();
        if (t) return { text: t, reason: 'label[for]' };
      }
    }
    return null;
  }  

  function isQuestionyText(t) {
    const s = (t || "").trim().toLowerCase();
    if (!s) return false;
    // Heuristics: contains a question mark OR key “question words” common in forms
    return s.includes("?") || /authorized|sponsorship|sponsor|gender|ethnicity|veteran|consent|background|agree|terms|policy/.test(s);
  }
  
  function firstText(node) {
    return (node && (node.textContent || "").trim()) || "";
  }
  
  function prevSiblingQuestion(node, limit = 2) {
    let n = node;
    for (let i = 0; i < limit && n; i++) {
      n = n.previousElementSibling;
      if (!n) break;
      if (/^(h1|h2|h3|h4|h5|h6|p|div|label|strong|span)$/i.test(n.tagName)) {
        const txt = firstText(n);
        if (txt && isQuestionyText(txt)) return { text: txt, reason: "prev-sibling" };
      }
    }
    return null;
  }
  
  function getGroupRoot(el, type, name) {
    // Try to find the smallest ancestor that contains the full group for radios
    if (type === "radio" && name) {
      let root = el.closest("div, fieldset, section, form") || el.parentElement;
      let best = null;
      for (let hops = 0; root && hops < 5; hops++, root = root.parentElement) {
        const allSameName = root.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
        if (allSameName.length >= 2) { best = root; break; }
      }
      return best || el.closest("fieldset, div, section, form") || el.parentElement;
    }
    // For single checkboxes, the immediate label/parent container is usually enough
    return el.closest("label, div, fieldset, section, form") || el.parentElement;
  }
  
  function questionInsideContainer(container) {
    if (!container) return null;
    // 1) direct child heading/label before options
    const kids = Array.from(container.children);
    for (const k of kids) {
      if (/^(label|h1|h2|h3|h4|h5|h6|p|div|strong|span)$/i.test(k.tagName)) {
        const txt = firstText(k);
        if (txt && isQuestionyText(txt)) return { text: txt, reason: "container-child" };
      }
    }
    // 2) try a header immediately above the container
    const prev = prevSiblingQuestion(container, 2);
    if (prev) return prev;
  
    // 3) fieldset legend (least preferred but sometimes only source)
    const fs = container.closest("fieldset");
    if (fs) {
      const lg = fs.querySelector(":scope > legend");
      const t = firstText(lg);
      if (t) return { text: t, reason: "fieldset>legend" };
    }
    return null;
  }  

  function detectAllFields() {
    const nodes = Array.from(document.querySelectorAll('input, select, textarea'));
    const out = [];
    for (const el of nodes) {
      if (!isFillable(el)) continue;

      // group radios/checkboxes by name, but still show a single logical field
      const t = typeOf(el);
      if (["radio","checkbox"].includes(t)) {
        const nm = el.getAttribute("name") || "";
      
        // Ensure single entry per radio group (first by name)
        if (t === "radio" && nm) {
          const first = document.querySelector(`input[type="radio"][name="${CSS.escape(nm)}"]`);
          if (first !== el) continue; // skip duplicates
        }
      
        // Extract a specific option label (Yes / No / etc.)
        const opt = getOptionLabel(el); // {text, reason} or null
      
        // CHECKBOX: the label is usually the actual question ("I agree to a background check ...")
        if (t === "checkbox" && opt && opt.text && opt.text.trim().length > 3) {
          out.push({
            labelText: opt.text,          // <-- use the checkbox label as the question
            detectedBy: "checkbox-label",
            tagName: tagOf(el),
            inputType: t,
            id: el.id || "",
            name: nm || "",
            placeholder: el.placeholder || "",
            selector: cssPath(el),
            optionText: opt.text,         // still keep it; filler may not need it for checkbox
            group: nm || null
          });
          continue;
        }
      
        // RADIO (and fallback for checkbox if no decent label): prefer the nearest specific question,
        // not the generic fieldset legend.
        const root = getGroupRoot(el, t, nm);
        const q = questionInsideContainer(root) || prevSiblingQuestion(el, 3);
      
        // If nothing specific found, fall back to fieldset legend or aria labels
        let labelText = q ? q.text : "";
        let detectedBy = q ? q.reason : "none";
      
        if (!labelText) {
          const gq = findGroupQuestion(el); // your earlier helper (legend/aria)
          if (gq) { labelText = gq.text; detectedBy = gq.reason; }
        }
      
        // If still blank, last resort: use one option text so it's not empty
        if (!labelText && opt && opt.text) {
          labelText = opt.text;
          detectedBy = opt.reason || "option-fallback";
        }
      
        out.push({
          labelText,                 // <-- group question for prediction (e.g., "Are you authorized to work in the US?")
          detectedBy,                // how we got the question
          tagName: tagOf(el),
          inputType: t,
          id: el.id || '',
          name: nm || '',
          placeholder: el.placeholder || "",
          selector: cssPath(el),
          optionText: opt ? opt.text : "",    // <-- the option like "Yes" / "No" (we keep it for filling step)
          group: nm || null                    // group name to locate all options during filling
        });
        continue; // done for this group
      }      

      let lab =
      getLabelViaFor(el) ||
      getLabelViaWrapper(el) ||
      getLabelNearby(el) ||
      getLabelFromUpload(el) ||  
      getLabelFromAttrs(el);
    

      // If still nothing, we could skip; but for debugging show unnamed entries.
      const labelText = lab ? lab.text : '';
      const detectedBy = lab ? lab.reason : 'none';

      out.push({
        labelText,
        detectedBy,
        tagName: tagOf(el),
        inputType: typeOf(el) || (tagOf(el) === 'select' ? 'select' : (tagOf(el) === 'textarea' ? 'textarea' : 'text')),
        id: el.id || '',
        name: el.name || '',
        placeholder: el.placeholder || '',
        selector: cssPath(el),
        context: inferContext(el) 
      });
    }
    return out;
  }

  // Lightweight probe
  function probe() {
    const inputs = document.querySelectorAll('input, select, textarea').length;
    return { ok: true, inputs };
  }

  // message handler
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg && msg.action === 'probe') {
        sendResponse(probe());
        return; // no async
      }
      if (msg && msg.action === 'EXT_DETECT_FIELDS') {
        const detected = detectAllFields();
        sendResponse({ ok: true, detected });
        return; // no async
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    // Keep other listeners working
  });
})();


  async function getFillerRunSummary() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["fillerRun"], (res) => resolve(res.fillerRun || null));
    });
  }

  // ---------- Radio + label helpers (DOM) ----------
  function labelForId(doc, id) {
    if (!id) return "";
    const l = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
    return (l?.textContent || "").trim();
  }
  function wrappedLabel(el) {
    const w = el.closest("label");
    return (w?.textContent || "").trim();
  }
  function siblingText(el) {
    const sib = el.nextSibling;
    return (sib && sib.nodeType === Node.TEXT_NODE) ? sib.textContent.trim() : "";
  }
  function optionText(el) {
    return labelForId(el.ownerDocument, el.id)
        || wrappedLabel(el)
        || (el.getAttribute("aria-label") || "").trim()
        || siblingText(el)
        || (el.value || "").trim();
  }
  function matchRadioByValue(groupNodeList, desiredRaw) {
    const want = normalizeToken(desiredRaw);
    if (!want) return null;
    const wantCanon = canonGender(want);

    const candidates = Array.from(groupNodeList).map(r => {
      const txt = normalizeToken(optionText(r));
      const val = normalizeToken(r.value || "");
      return { r, txt, val, txtCanon: canonGender(txt), valCanon: canonGender(val) };
    });

    const tests = [
      (c) => c.valCanon === wantCanon,
      (c) => c.txtCanon === wantCanon,
      (c) => c.val === want || c.txt === want,
      (c) => c.txt.includes(want) || want.includes(c.txt),
    ];
    for (const t of tests) {
      const hit = candidates.find(t);
      if (hit) return hit.r;
    }
    return null;
  }

  function setRadioGroupByValue(anyRadioInGroup, want){
    const name = anyRadioInGroup.getAttribute("name");
    if (!name) return false;
    const group = anyRadioInGroup.ownerDocument.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
    const m = matchRadioByValue(group, want);
    if (m) { if (!m.checked) { m.checked = true; fireAll(m); } return true; }
    // fallback: check the first if nothing matches (avoid no-ops)
    const r0 = group[0];
    if (r0 && !r0.checked) { r0.checked = true; fireAll(r0); return true; }
    return false;
  }

  function setRadioByValue(containerOrDoc, name, rawVal) {
    const H = window.H || window.SFFHelpers || {};
    const nrm = H.norm || ((s)=> (s??"").toString().trim().toLowerCase().replace(/[^a-z0-9]/g,""));
    const wanted = nrm(rawVal);
    const root = containerOrDoc || document;
    const nodes = root.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
    for (const n of nodes) {
      const val = nrm(n.value || "");
      const labelText = nrm(n.closest("label")?.textContent || "");
      if (val === wanted || labelText === wanted) {
        n.checked = true;
        n.dispatchEvent(new Event("input",{bubbles:true}));
        n.dispatchEvent(new Event("change",{bubbles:true}));
        return true;
      }
    }
    return false;
  }

  function setRadioByLabel(groupNodes, wantedCandidates) {
    // groupNodes: radios sharing name OR NodeList you pass
    const H = window.H || window.SFFHelpers;
    const candid = (wantedCandidates || []).map(s => (s || "").toString().trim().toLowerCase());
    const radios = Array.from(groupNodes || []).filter(n => n && n.type === "radio");
    // Build mapping: radio -> labelText
    const pairs = radios.map(r => {
      const id = r.id;
      const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const text = (lab?.textContent || r.value || "").trim().toLowerCase();
      return { r, text };
    });
  
    // try exact token overlap
    for (const c of candid){
      for (const p of pairs){
        const ok = H.overlapScore ? H.overlapScore(p.text, c) >= 0.6
                                  : p.text.includes(c) || c.includes(p.text);
        if (ok) {
          p.r.click?.();
          p.r.checked = true;
          p.r.dispatchEvent(new Event("change", { bubbles: true }));
          p.r.dispatchEvent(new Event("input",  { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  }
  
  function setCheckbox(el, checked=true) {
    try {
      if (!el) return false;
      if (el.type !== "checkbox") return false;
      if (el.checked !== !!checked) {
        el.click?.(); // triggers listeners
        el.checked = !!checked;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input",  { bubbles: true }));
      }
      return true;
    } catch { return false; }
  }
  
  function setTextLike(el, value) {
    if (!el) return false;
    el.focus();
    el.value = (value ?? "").toString();
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    el.blur?.();
    return true;
  }

  // --- helpers for selects + month parsing ---
function toMonthNumber(m) {
  if (m == null) return "";
  if (/^\d+$/.test(String(m))) {
    const n = parseInt(m, 10);
    return (n >= 1 && n <= 12) ? String(n) : "";
  }
  const s = String(m).trim().toLowerCase();
  const names = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const idx = names.findIndex(n => n.startsWith(s) || s.startsWith(n.slice(0,3)));
  return idx >= 0 ? String(idx + 1) : "";
}

function setSelectValueLoose(sel, val) {
  if (!sel) return false;
  const wanted = String(val ?? "").trim();
  if (!wanted) return false;

  const commit = (opt) => {
    const idx = Array.prototype.indexOf.call(sel.options, opt);
    if (idx >= 0) sel.selectedIndex = idx;
    opt.selected = true;
    // keep value in sync for listeners that read .value directly
    try { sel.value = opt.value; } catch {}
    sel.dispatchEvent(new Event("input",  { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };

  // try by exact value
  for (const opt of sel.options) {
    if (String(opt.value) === wanted) return commit(opt);
  }
  // try by exact visible text
  for (const opt of sel.options) {
    const t = String(opt.textContent || "").trim();
    if (t.toLowerCase() === wanted.toLowerCase()) return commit(opt);
  }
  // try by startsWith on visible text
  for (const opt of sel.options) {
    const t = String(opt.textContent || "").trim().toLowerCase();
    if (t.startsWith(wanted.toLowerCase())) return commit(opt);
  }
  return false;
}

// find by [data-k], then name, then label text
function pickField(row, key, nameHints = [], labelHints = []) {
  // 1) data-k
  let el = row.querySelector(`[data-k="${key}"]`);
  if (el) return el;

  // 2) name contains any hint
  for (const h of nameHints) {
    el = row.querySelector(`[name*="${h}"], input[name*="${h}"], select[name*="${h}"], textarea[name*="${h}"]`);
    if (el) return el;
  }

  // 3) label text
  const labels = Array.from(row.querySelectorAll("label"));
  for (const lbl of labels) {
    const txt = (lbl.textContent || "").trim().toLowerCase();
    if (labelHints.some(h => txt.includes(h))) {
      // for/aria-labelledby
      const forId = lbl.getAttribute("for");
      if (forId) {
        const byFor = row.querySelector(`#${CSS.escape(forId)}`);
        if (byFor) return byFor;
      }
      // or the next control
      const ctl = lbl.parentElement?.querySelector("input,select,textarea");
      if (ctl) return ctl;
    }
  }

  return null;
}
  
  function setDateLike(el, value) {
    const H = window.H || window.SFFHelpers || {};
    const iso = H.toISODate ? H.toISODate(value) : null;
    if (!iso) return false;
    // some sites only react to valueAsDate
    try { el.value = iso; } catch(_) {}
    try { el.valueAsDate = new Date(iso); } catch(_) {}
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    return !!el.value;
  }
  
  function setMonthLike(el, value) {
    const H = window.H || window.SFFHelpers || {};
    const mv = H.toMonthValue ? H.toMonthValue(value) : null;
    if (!mv) return false;
    try { el.value = mv; } catch(_) {}
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    return !!el.value;
  }  

  // --- expose DOM setters to the global filler below ---
  window.SFFDom = Object.assign(window.SFFDom || {}, {
    setRadioByValue,
    setCheckbox,
    setTextLike,
    setDateLike,
    setMonthLike
  });

  // also export as loose globals for legacy calls
  window.setRadioByValue = setRadioByValue;
  window.setCheckbox     = setCheckbox;
  window.setTextLike     = setTextLike;
  window.setDateLike     = setDateLike;
  window.setMonthLike    = setMonthLike;


  // ---------- Events ----------
  function fire(el, type) {
    try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch {}
  }
  function fireAll(el) {
    fire(el, "input");
    fire(el, "change");
    if (typeof el.blur === "function") { try { el.blur(); } catch {} }
  }

  // --- robust user-like click (makes stubborn buttons respond) ---
  async function userLikeClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
    try { el.removeAttribute?.("disabled"); } catch {}
    try {
      const r = el.getBoundingClientRect();
      const x = r.left + Math.min(Math.max(1, r.width / 2), r.width - 1);
      const y = r.top  + Math.min(Math.max(1, r.height / 2), r.height - 1);
      const types = ["pointerover","pointerenter","mouseenter","mouseover","pointerdown","mousedown","focus","pointerup","mouseup","click"];
      for (const t of types) {
        el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, composed:true, view:window, clientX:x, clientY:y, button:0 }));
      }
      if (typeof el.click === "function") el.click(); // final nudge
      return true;
    } catch {
      try { if (typeof el.click === "function") { el.click(); return true; } } catch {}
    }
    return false;
  }

  // --- fallback DOM creators (used only if clicks don't add rows) ---
function createSimpleEduItem(idx = 0) {
  const wrap = document.createElement("div");
  wrap.className = "item";
  wrap.innerHTML = `
    <div class="grid">
      <div><label>School / University</label><input data-k="school" name="school" placeholder="University"></div>
      <div>
        <label>Degree</label>
        <select data-k="degreeShort" name="degree">
          <option value="">—</option>
          <option value="AS">A.S. — Associate of Science</option>
          <option value="AA">A.A. — Associate of Arts</option>
          <option value="BS">B.S. — Bachelor of Science</option>
          <option value="BA">B.A. — Bachelor of Arts</option>
          <option value="MS">M.S. — Master of Science</option>
          <option value="MA">M.A. — Master of Arts</option>
          <option value="MBA">MBA — Master of Business Administration</option>
          <option value="PhD">Ph.D. — Doctor of Philosophy</option>
        </select>
      </div>
      <div><label>Field of Study</label><input data-k="field" name="field_of_study" placeholder="Computer Science"></div>
      <div><label>GPA</label><input data-k="gpa" name="gpa" placeholder="3.8"></div>
    </div>
    <div class="grid">
      <div>
        <label>Start Month</label>
        <select data-k="startMonth"><option value="">—</option>${[..."JanFebMarAprMayJunJulAugSepOctNovDec".match(/.{1,3}/g)].map((m,i)=>`<option value="${i+1}">${["January","February","March","April","May","June","July","August","September","October","November","December"][i]}</option>`).join("")}</select>
      </div>
      <div>
        <label>Start Year</label>
        <select data-k="startYear"><option value="">—</option>${(() => { const ys=[]; const now=new Date().getFullYear()+1; for(let y=now;y>=1970;y--) ys.push(`<option>${y}</option>`); return ys.join(""); })()}</select>
      </div>
      <div>
        <label>End Month</label>
        <select data-k="endMonth"><option value="">—</option>${[..."JanFebMarAprMayJunJulAugSepOctNovDec".match(/.{1,3}/g)].map((m,i)=>`<option value="${i+1}">${["January","February","March","April","May","June","July","August","September","October","November","December"][i]}</option>`).join("")}</select>
      </div>
      <div>
        <label>End Year</label>
        <select data-k="endYear"><option value="">—</option>${(() => { const ys=[]; const now=new Date().getFullYear()+1; for(let y=now;y>=1970;y--) ys.push(`<option>${y}</option>`); return ys.join(""); })()}</select>
      </div>
    </div>
    <div class="actions"><button type="button" class="btn" data-del>Delete</button><span class="muted">Education #${idx+1}</span></div>
  `;
  return wrap;
}

  // ---------- File upload helpers ----------
async function fetchResumeFileAsFile(resumeId) {
  if (!resumeId) return { ok:false, reason:"no resume id" };
  const resp = await new Promise(res => chrome.runtime.sendMessage(
    { action: "getResumeFile", id: resumeId },
    r => res(r)
  ));
  if (!resp?.ok) return { ok:false, reason: resp?.error || "resume fetch failed" };

  // base64 → Uint8Array → Blob → File
  const b64 = resp.base64 || "";
  const len = b64.length;
  // decode in chunks to avoid stack issues
  const chunk = 0x8000;
  const bytes = [];
  for (let i = 0; i < len; i += chunk) {
    const slice = b64.slice(i, i + chunk);
    const arr = new Uint8Array(slice.length);
    for (let j = 0; j < slice.length; j++) arr[j] = slice.charCodeAt(j);
    bytes.push(arr);
  }
  const blob = new Blob(bytes, { type: resp.type || "application/pdf" });
  const file = new File([blob], resp.name || "resume.pdf", { type: resp.type || "application/pdf" });
  return { ok:true, file };
}

function setFileInputWithFile(el, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  el.files = dt.files;
  el.dispatchEvent(new Event("input",{bubbles:true}));
  el.dispatchEvent(new Event("change",{bubbles:true}));
  return true;
}

  // ---------- Select helper (DOM) ----------
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

    for (let i = 0; i < selectEl.options.length; i++) {
      const o = selectEl.options[i];
      const ov = nz(o.value), ot = nz(o.textContent);
      if (variants.some(v => nz(v).toLowerCase() === ov.toLowerCase()
                           || nz(v).toLowerCase() === ot.toLowerCase())) return commit(i);
    }
    for (let i = 0; i < selectEl.options.length; i++) {
      const o = selectEl.options[i];
      const ovn = nrm(o.value), otn = nrm(o.textContent);
      if (variants.some(v => {
        const vn = nrm(v);
        return vn === ovn || vn === otn || ovn.includes(vn) || otn.includes(vn);
      })) return commit(i);
    }
    const tryList = [abbr, full].filter(Boolean);
    for (let i = 0; i < selectEl.options.length; i++) {
      const o = selectEl.options[i];
      if (tryList.some(v => nrm(v) === nrm(o.value) || nrm(v) === nrm(o.textContent))) return commit(i);
    }
    return false;
  }

  function setSelectValueSmart(selectEl, rawVal, labelHint = "") {
    if (!selectEl) return false;
    const label = (labelHint || "").toLowerCase();
    const val = (rawVal ?? "").toString().trim();
    if (!val) return false;
  
    let candidates = [val];

    // Month/Year dropdowns fed with a combined "MM/YYYY" or similar
    if (/\bmonth\b/.test(label) || /\b(start|begin).*month\b/.test(label) || /\bend.*month\b/.test(label)) {
      const my = _parseMY(val);
      if (my) return setMonthSelect(selectEl, my);
    }
    if (/\byear\b/.test(label) || /\b(start|begin).*year\b/.test(label) || /\bend.*year\b/.test(label)) {
      const my = _parseMY(val);
      if (my) return setYearSelect(selectEl, my);
    }

    // Years-of-Experience select like: 0 / 1 / 2 / 3+
    if (/years? of (professional )?experience|^\s*yoe\s*$/.test(label)) {
      const n = parseInt(val, 10);
      if (!isNaN(n)) {
        candidates = [String(n)];
        if (n >= 3) candidates.unshift("3+");  // helps match "3+"
      }
    }

  
    if (/\b(state|province|region)\b/.test(label)) {
      candidates = (window.H && H.buildStateCandidates) ? H.buildStateCandidates(val) : [val];
    } else if (/\b(ethnicity|race)\b/.test(label)) {
      candidates = (window.H && H.buildEthnicityCandidates) ? H.buildEthnicityCandidates(val) : [val];
    } else if (/veteran/.test(label)) {
      candidates = (window.H && H.buildVeteranCandidates) ? H.buildVeteranCandidates(val) : [val];
    } else if (/background|consent|terms|agree/.test(label)) {
      candidates = (window.H && H.buildYesNoCandidates) ? H.buildYesNoCandidates(val) : [val];
    } else if (/\bdegree\b/.test(label)) {
      candidates = (window.H && H.buildDegreeCandidates) ? H.buildDegreeCandidates(val) : [val];
    }
  
    const idx = (window.H && H.matchOptionIndex) ? H.matchOptionIndex(selectEl, candidates) : -1;
    if (idx < 0) return false;
  
    // try to set it
    selectEl.selectedIndex = idx;
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  
    // verify we actually landed on a candidate
    const opt = selectEl.options[selectEl.selectedIndex];
    const chosenText = (opt?.textContent || "").trim();
    const chosenValue = (opt?.value || "").trim();
    const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const candsN = candidates.map(norm);
    const ok =
      candsN.includes(norm(chosenText)) ||
      candsN.includes(norm(chosenValue));
  
    if (!ok) {
      // undo: leave selection unchanged if mismatch
      return false;
    }
    return true;
  }
  
  // expose for bottom-of-file helpers that live outside the IIFE
  window.setSelectValueSmart = setSelectValueSmart;
  window.SFFDom = Object.assign(window.SFFDom || {}, { setSelectValueSmart });

// === Years-of-Experience select setter (handles "3", "3+ yrs", "3–5 years", etc.)
function setYearsExperienceSelect(select, raw) {
  if (!select) return false;
  const s = String(raw ?? "").trim();
  if (!s) return false;

  const n = parseInt(s, 10);
  const opts = Array.from(select.options).map(o => ({
    el: o,
    v: (o.value || "").toLowerCase().trim(),
    t: (o.textContent || "").toLowerCase().trim()
  }));

  const cands = [];
  if (!isNaN(n)) {
    cands.push(
      String(n), `${n}+`, `${n} years`, `${n}+ years`, `${n} year`,
      `${n}yrs`, `${n}+ yrs`, `${n} - ${n+1} years`, `${n}-${n+1}`, `${n}–${n+1}`
    );
  }
  cands.push(s.toLowerCase());

  for (const c of cands) {
    const hit = opts.find(o => o.v === c) || opts.find(o => o.t === c);
    if (hit) { select.value = hit.el.value; select.dispatchEvent(new Event("change", {bubbles:true})); return true; }
  }
  if (!isNaN(n)) {
    const hit2 = opts.find(o => /\d/.test(o.t) && o.t.includes(String(n)));
    if (hit2) { select.value = hit2.el.value; select.dispatchEvent(new Event("change", {bubbles:true})); return true; }
  }
  return setSelectValueSmart(select, isNaN(n) ? s : String(n));
}

  // Accepts 2, "02", "Feb", "February" and matches by option value OR text.
  function setMonthValueSmart(select, raw) {
    if (!select) return false;
    const s = String(raw ?? "").trim();
    if (!s) return false;

    const months = [
      "january","february","march","april","may","june",
      "july","august","september","october","november","december"
    ];

    const candidates = [];

    // numeric forms: 2, "2", "02"
    if (/^\d{1,2}$/.test(s)) {
      const n = String(parseInt(s, 10));             // "2"
      const n2 = n.padStart(2, "0");                  // "02"
      const idx = Math.max(1, Math.min(12, parseInt(n,10)));
      candidates.push(n, n2, months[idx-1]);          // "2", "02", "february"
    } else {
      // text forms: "Feb", "February"
      const lo = s.toLowerCase();
      const fullIdx = months.indexOf(lo);
      const abbrIdx = fullIdx >= 0 ? fullIdx : months.findIndex(m => m.startsWith(lo.slice(0,3)));
      if (abbrIdx >= 0) {
        const n = String(abbrIdx + 1);
        candidates.push(months[abbrIdx], n, n.padStart(2, "0")); // "february", "2", "02"
      } else {
        candidates.push(lo);
      }
    }

    // Try value exact, text exact, then startsWith on text
    const opts = Array.from(select.options).map(o => ({
      el: o,
      v: (o.value || "").toLowerCase().trim(),
      t: (o.textContent || "").toLowerCase().trim()
    }));

    for (const c of candidates) {
      const cc = String(c).toLowerCase();
      let hit = opts.find(o => o.v === cc) ||
                opts.find(o => o.t === cc) ||
                opts.find(o => o.t.startsWith(cc));
      if (hit) {
        select.value = hit.el.value;
        select.selectedIndex = Array.from(select.options).indexOf(hit.el);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  // ---------- Labels + DOM traversal ----------
  function labelTextFor(el){
    if (el.id) {
      const forLab = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = forLab?.textContent?.trim();
      if (t) return t;
    }
    let wrap = el.closest("label");
    if (wrap?.textContent?.trim()) return wrap.textContent.trim();

    const near = el.closest('[class*="row"], [class*="group"], [class*="field"], [class*="Form"], [role="group"]');
    if (near){
      const t = (near.querySelector('label')?.textContent
              || near.querySelector('.label, .field-label, [data-label]')?.textContent
              || near.getAttribute('aria-label')
              || "").trim();
      if (t) return t;
    }
    return (el.getAttribute("aria-label")
      || el.getAttribute("placeholder")
      || el.getAttribute("name")
      || el.id
      || ""
    ).trim();
  }

// normalize for skill matching: lowercase + strip non-alphanumerics
function normSkill(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
// label fallback for checkboxes
function labelForCheckbox(box) {
  if (!box) return "";
  const id = box.getAttribute("id");
  if (id) {
    const lab = document.querySelector(`label[for="${id}"]`);
    if (lab && lab.textContent) return lab.textContent.trim();
  }
  const aria = box.getAttribute("aria-label");
  if (aria) return aria.trim();
  const sib = (box.nextSibling && box.nextSibling.textContent || "").trim();
  if (sib) return sib;
  const wrap = box.closest(".field, .row, .item, .form-group, div");
  const guess = wrap?.querySelector("label")?.textContent?.trim();
  return guess || "";
}

// === Voluntary Self-ID / Demographics filler (reads profile.eligibility) ===
async function fillVoluntarySelfID(profile, root = document) {
  try {
    const H = window.SFFHelpers || {};
    const selects = Array.from(root.querySelectorAll("select"));

    // Pull from eligibility; keep graceful fallbacks
    const eg = profile?.eligibility || {};
    const disability     = eg.disability     ?? profile?.disability     ?? "";
    const lgbtq          = eg.lgbtq          ?? profile?.lgbtq          ?? "";
    const veteran        = eg.veteran        ?? profile?.veteran        ?? "";
    const ethnicity      = eg.ethnicity      ?? profile?.ethnicity      ?? "";
    const race           = eg.race           ?? profile?.race           ?? "";
    let   hispanicLatinx = eg.hispanicLatinx ?? profile?.hispanicLatinx ?? "";

    // Inference: if ethnicity is Hispanic/Latinx and the yes/no question is blank → Yes
    if (!hispanicLatinx && /hispanic|latinx|latino/i.test(String(ethnicity || ""))) {
      hispanicLatinx = "Yes";
    }

    // Helper: get label text for a control
    const lblFor = (el) => (typeof labelTextFor === "function" ? labelTextFor(el) : el?.closest("label")?.textContent || "");

    // Helper to set by label regex with a candidate list/builder
    const setBy = (rx, candidates) => {
      for (const sel of selects) {
        const lbl = (lblFor(sel) || "").trim();
        if (!lbl) continue;
        if (rx.test(lbl)) {
          const cands = (typeof candidates === "function") ? candidates() : (candidates || []);
          if (!cands.length) continue;

          // strongest match via helper
          const idx = (H.matchOptionIndex ? H.matchOptionIndex(sel, cands) : -1);
          if (idx >= 0) {
            sel.selectedIndex = idx;
            sel.dispatchEvent(new Event("input",  { bubbles: true }));
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }
          // loose fallback: try setSelectValueSmart per candidate
          if (typeof setSelectValueSmart === "function") {
            for (const c of cands) {
              if (setSelectValueSmart(sel, c, lbl)) return true;
            }
          }
        }
      }
      return false;
    };

    // Fill the six questions (match by wording on your test page)
    setBy(/\bdisab/i,             () => H.buildDisabilityCandidates?.(disability) || []);
    setBy(/\blgbtq/i,             () => H.buildLGBTQCandidates?.(lgbtq) || []);
    setBy(/\bveteran/i,           () => H.buildVeteranCandidates?.(veteran) || []);
    setBy(/\bethnic/i,            () => H.buildEthnicityCandidates?.(ethnicity) || []);
    setBy(/\brace\b/i,            () => H.buildRaceCandidates?.(race) || []);
    setBy(/hispanic.*latinx/i,    () => H.buildYesNoCandidates?.(hispanicLatinx) || []);

  } catch (e) {
    console.warn("[filler] fillVoluntarySelfID error:", e);
  }
}

// expose for pipeline + manual test
window.fillVoluntarySelfID = fillVoluntarySelfID;

// Optional: quick test hook you can send from popup
chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
  if (msg?.action === "EXT_FILL_DEMOGRAPHICS") {
    fillVoluntarySelfID(msg.profile || {}).then(() => sendResponse({ ok: true })).catch(err => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }
});

// Fill Key Skills (from matched resume ONLY) + set Highest Education / YOE
async function fillSkillsAndScalars(profile) {
  try {
    // Highest Education & YOE as you already do (left intact)
    const he  = (profile.highestEducation || profile.educationHighest || "").toString().trim();
    const yoe = (profile.yearsOfExperience || profile.meta?.yearsOfExperience || "").toString().trim();

    document.querySelectorAll("select").forEach(sel => {
      const lbl = (labelTextFor(sel) || "").toLowerCase();
      const squished = lbl.replace(/\s+/g,"");
      if (/(highest|top).*(education|degree)|education.*level|level.*education|degree.*level/.test(lbl)) {
        const norm = (window.H?.normalizeDegreeLabel?.(he) || he);
        if (norm) setSelectValueSmart(sel, norm);
      } else if (/years.*(professional)?.*experience|overall.*experience|total.*experience|^yoe$/.test(lbl)
                 || /yearsofprofessionalexperience|yearsofexperience|yoe/.test(squished)) {
        if (yoe) setYearsExperienceSelect(sel, yoe);
      }
    });

    // Load matched skills saved by popup for the SELECTED resume
    const { matchedSkills } = await new Promise(res =>
      chrome.storage.local.get(["matchedSkills"], res)
    );
    const req  = Array.isArray(matchedSkills?.required)  ? matchedSkills.required  : [];
    const pref = Array.isArray(matchedSkills?.preferred) ? matchedSkills.preferred : [];
    const normSet = new Set([...req, ...pref].map(normSkill).filter(Boolean));
    if (!normSet.size) {
      console.log("[filler] No matchedSkills in storage; skipping Key Skills.");
      return;
    }

    // Scope to "Key Skills" / "Skills & Highest Education" section if present
    const skillsSection =
      Array.from(document.querySelectorAll("section, fieldset, .card, .group, .item, .row, .form-section"))
        .find(sec => /key\s*skills|skills\s*&\s*highest\s*education|\bskills\b/i.test(sec.textContent || ""));
    const scope = skillsSection || document;

    // Grab all checkboxes within the Skills section (don't assume name="skills")
    const boxes = Array.from(scope.querySelectorAll('input[type="checkbox"]'));

    for (const box of boxes) {
      // Derive the human-visible label next to the checkbox, with fallbacks
      const raw =
        (box.value ||
        box.getAttribute("aria-label") ||
        labelForCheckbox(box) || ""   // uses the helper above
        ).trim();

      const key = normSkill(raw);      // lower + strip non-alphanumerics
      if (key && normSet.has(key)) {
        if (!box.checked) {
          box.checked = true;
          // Fire both events to satisfy custom listeners
          box.dispatchEvent(new Event("input",  { bubbles: true }));
          box.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    }
  } catch (e) {
    console.warn("[filler] fillSkillsAndScalars:", e);
  }
}



// Ensure the correct number of education rows exist, then fill them STRICTLY one-by-one.
// Uses ONLY existing helpers: ensureEducationRowsEduOnly + fillEducationBlocksFromProfile.
async function ensureAndFillEducation(profile, root = document) {
  const eduArr = Array.isArray(profile?.education) ? profile.education : [];
  if (!eduArr.length) return;

  const listEl  = root.querySelector('#eduList') || root;
  const itemSel = listEl.id === 'eduList' ? '.item' : '[data-edu-item], .education-item, .edu-block, .item';

  // add rows up to target (uses your existing click logic)
  await ensureEducationRowsEduOnly(profile, root);

  // strict loop: wait for i+1 rows, then fill slice(0, i+1); repeat
  for (let i = 0; i < eduArr.length; i++) {
    // wait until DOM shows at least i+1 rows
    let tries = 0;
    while (tries++ < 20) {
      const count = listEl.querySelectorAll(itemSel).length;
      if (count >= i + 1) break;
      await new Promise(r => setTimeout(r, 50));
    }

    // fill ONLY up to current index (so row i gets populated now)
    const partial = Object.assign({}, profile, { education: eduArr.slice(0, i + 1) });
    fillEducationBlocksFromProfile(partial, root);

    // verify row i has any value; if not, retry once after a paint
    const rows = listEl.querySelectorAll(itemSel);
    const rowI = rows[i];
    if (rowI) {
      const anyFilled = Array.from(rowI.querySelectorAll('input,select,textarea'))
        .some(el => el.tagName === 'SELECT' ? !!el.value : !!(el.value || '').trim());
      if (!anyFilled) {
        await new Promise(r => requestAnimationFrame(r));
        fillEducationBlocksFromProfile(partial, root);
      }
    }
  }
}
// make globally callable from other closures / listeners
window.ensureAndFillEducation = ensureAndFillEducation;


// Click “+ Add Education” until the total rows === profile.education.length (no overshoot)
async function ensureEducationRowsEduOnly(profile, root = document) {
  try {
    const eduArr = Array.isArray(profile?.education) ? profile.education : [];
    if (!eduArr.length) return;

    const listEl   = root.querySelector('#eduList'); // present on your test
    const countNow = () => (listEl ? listEl.querySelectorAll('.item').length : getEducationRows(root).length);
    const target   = eduArr.length;

    // If we already have enough rows, we're done.
    if (countNow() >= target) return;

    // Find the add button (explicit first, then text/aria)
    const addBtn =
      root.querySelector('#addEdu') ||
      root.querySelector('#addEducation') ||
      root.querySelector('.add-education') ||
      root.querySelector('[data-add="education"]') ||
      root.querySelector('[data-action="add-education"]') ||
      Array.from(root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')).find((b) => {
        const t = ((b.textContent || b.value || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
        return /^(\+?\s*)?add\b/.test(t) && /(education|school|university|college|degree)/.test(t);
      });

    if (!addBtn) {
      console.warn('[filler] ensureEducationRowsEduOnly: no "Add Education" button found');
      return;
    }

    // Click ONLY until rows === target. We re-check after each click, so we never overshoot.
    // Also, we wait for the DOM to actually mount a new row before deciding to click again.
    let guard = 0;
    while (countNow() < target && guard < 20) {
      const before = countNow();

      // Prefer dispatching a normal click; your test attaches addEventListener('click', ...)
      if (typeof addBtn.click === 'function') addBtn.click();

      // wait until a new item shows up (up to ~800ms)
      let grew = false;
      for (let tries = 0; tries < 8; tries++) {
        await new Promise((r) => setTimeout(r, 100));
        if (countNow() > before) { grew = true; break; }
      }

      // If it didn't grow, break (avoid blind extra clicks)
      if (!grew) break;

      guard++;
    }

    // Final small settle so the new row is fully rendered before filling
    for (let tries = 0; tries < 5; tries++) {
      if (countNow() >= target) break;
      await new Promise((r) => setTimeout(r, 80));
    }
  } catch (e) {
    console.warn('[filler] ensureEducationRowsEduOnly error', e);
  }
}
// make callable from any closure
window.ensureEducationRowsEduOnly = ensureEducationRowsEduOnly;

// =========================== EXPERIENCE HELPERS (multi-block) ===========================

// Parse "YYYY-MM-DD" | "MM/YYYY" | "YYYY" → { m, y } where m is 1..12 or null
function parseMonthYearLoose(s) {
  const t = String(s || "").trim();
  if (!t) return { m: null, y: null };

  // YYYY-MM-DD
  let m = null, y = null;
  let m1 = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m1) { y = +m1[1]; m = +m1[2]; return { m, y }; }

  // MM/YYYY or M/YYYY
  let m2 = t.match(/^(\d{1,2})[/-](\d{4})$/);
  if (m2) { m = +m2[1]; y = +m2[2]; return { m, y }; }

  // YYYY
  let m3 = t.match(/^(\d{4})$/);
  if (m3) { y = +m3[1]; return { m: null, y }; }

  // Month names
  const months = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12
  };
  const lower = t.toLowerCase();
  for (const k of Object.keys(months)) {
    if (lower.includes(k)) {
      // look for year
      const yHit = lower.match(/(19|20)\d{2}/);
      return { m: months[k], y: yHit ? +yHit[0] : null };
    }
  }
  return { m: null, y: null };
}

/*** ================== EXPERIENCE (mirrors EDUCATION) ================== ***/
// 1) Find the "+ Add Experience" button — same strategy as education
function findAddExperienceButton(root = document) {
  return (
    root.querySelector('#addExp') ||
    root.querySelector('#addExperience') ||
    root.querySelector('#addEmployment') ||
    root.querySelector('.add-experience') ||
    root.querySelector('[data-add="experience"]') ||
    root.querySelector('[data-action="add-experience"]') ||
    root.querySelector('button[aria-label*="add experience" i]') ||
    root.querySelector('[role="button"][aria-label*="add experience" i]') ||
    // fallback by visible text (education does this too)
    Array.from(root.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]'))
      .find(el => /\badd\s+(experience|employment|work)\b/i.test(
        (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim()
      )) ||
    null
  );
}

// 2) Single click rhythm — identical to clickAddEducationOnce
async function clickAddExperienceOnce(root = document) {
  const countNow = () => (typeof getExperienceRows === "function" ? getExperienceRows(root).length : 0);
  const before = countNow();

  const btn = findAddExperienceButton(root);
  if (!btn) return { ok:false, error:"no_button", before, after: before };

  if (typeof userLikeClick === "function") {
    await userLikeClick(btn);
  } else if (typeof btn.click === "function") {
    btn.click();
  }

  // wait for DOM to grow by exactly one row (education does this wait-loop)
  let after = before;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 100));
    after = countNow();
    if (after > before) break;
  }
  return { ok:true, clicked:true, grew: after > before, before, after };
}

// 3) Ensure + Fill orchestrator — line-for-line like ensureAndFillEducation
async function ensureAndFillExperience(profile, root = document) {
  const exps  = Array.isArray(profile?.experience) ? profile.experience : [];
  if(!exps.length);

  // mirror the edu selectors
  const listEl  = root.querySelector('#expList') || root;
  const itemSel = (listEl.id === 'expList')
    ? '.item'
    : '[data-exp-item], .experience-item, .employment-item, .work-item, .exp-block, .employment-block, .work-block, .experience-row, .item';

  // add rows up to target (uses your existing click logic)
  await ensureExperienceRowsExpOnly(profile, root);

  // strict loop: wait for i+1 rows, then fill slice(0, i+1); repeat
  for (let i = 0; i < exps.length; i++) {
    // wait until DOM shows at least i+1 rows
    let tries = 0;
    while (tries++ < 20) {
      const count = listEl.querySelectorAll(itemSel).length;
      if (count >= i + 1) break;
      await new Promise(r => setTimeout(r, 50));
    }

    // fill ONLY up to current index (so row i gets populated now)
    const partial = Object.assign({}, profile, { experience: exps.slice(0, i + 1) });
    fillExperienceBlocksFromProfile(partial, root);

    // verify row i has any value; if not, retry once after a paint
    const rows = listEl.querySelectorAll(itemSel);
    const rowI = rows[i];
    if (rowI) {
      const anyFilled = Array.from(rowI.querySelectorAll('input,select,textarea'))
        .some(el => el.tagName === 'SELECT' ? !!el.value : !!(el.value || '').trim());
      if (!anyFilled) {
        await new Promise(r => requestAnimationFrame(r));
        fillExperienceBlocksFromProfile(partial, root);
      }
    }
  }
}
window.ensureAndFillExperience = ensureAndFillExperience;


async function ensureExperienceRowsExpOnly(profile, root = document) {
  try {
    const exps = Array.isArray(profile?.experience) ? profile.experience : [];
    if (!exps.length) return;

    const listEl   = root.querySelector('#expList'); // present on your test
    const countNow = () => (listEl ? listEl.querySelectorAll('.item').length : getEducationRows(root).length);
    const target   = exps.length;

    if (countNow() >= target) return;

    // Find the add button (explicit first, then text/aria)
    const addBtn =
    root.querySelector('#addExp') ||
    root.querySelector('#addExperience') ||
    root.querySelector('.add-experience') ||
    root.querySelector('[data-add="experience"]') ||
    root.querySelector('[data-action="add-experience"]') ||
    Array.from(root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')).find((b) => {
      const t = ((b.textContent || b.value || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
      return /^(\+?\s*)?add\b/.test(t) && /(company|position|location|role)/.test(t);
    });

    if (!addBtn) {
      console.warn('[filler] ensureEducationRowsEduOnly: no "Add Experience" button found');
      return;
    }

    let guard = 0;
    while (countNow() < target && guard < 20) {
      const before = countNow();

      // Prefer dispatching a normal click; your test attaches addEventListener('click', ...)
      if (typeof addBtn.click === 'function') addBtn.click();

      // wait until a new item shows up (up to ~800ms)
      let grew = false;
      for (let tries = 0; tries < 8; tries++) {
        await new Promise((r) => setTimeout(r, 100));
        if (countNow() > before) { grew = true; break; }
      }

      // If it didn't grow, break (avoid blind extra clicks)
      if (!grew) break;

      guard++;
    }

    // small settle so the last row is fully mounted
    for (let i = 0; i < 5; i++) {
      if (countNow() >= target) break;
      await new Promise(r => setTimeout(r, 80));
    }
  } catch (e) {
    console.warn("[filler] ensureExperienceRowsExpOnly error", e);
  }
}
window.ensureExperienceRowsExpOnly = ensureExperienceRowsExpOnly;


// Return a list of container elements, each representing one experience block
function getExperienceRows(root = document) {
  const rows = [];

  // 1) Ultimate Test explicit list
  rows.push(...Array.from(root.querySelectorAll('#expList .item, [data-exp-item]')));

  // 2) Common explicit wrappers (without any ellipses)
  rows.push(...Array.from(root.querySelectorAll(
    '[data-section="experience"], [data-section="employment"], .experience-block, .employment-block, .work-block'
  )));

  // 3) Fallback: group by nearest fieldset/card that contains a Company or Job Title label
  if (!rows.length) {
    const groups = new Set();
    root.querySelectorAll('label').forEach(lbl => {
      const txt = (lbl.textContent || "").trim().toLowerCase();
      if (/company|employer|organization|job\s*title|position|role/.test(txt)) {
        const node = lbl.closest('fieldset, .card, .row, .block, .item, section, .group, .container, .form-row') || lbl.parentElement;
        if (node) groups.add(node);
      }
    });
    rows.push(...groups);
  }

  return rows;
}

function setStartMonthYearIn(row, dateStr) {
  const { m, y } = parseMonthYearLoose(dateStr);
  // find selects/inputs by label text
  const startMonthEl = [...row.querySelectorAll('select, input')].find(e => /start\s*month/i.test(labelTextFor(e)));
  const startYearEl  = [...row.querySelectorAll('select, input')].find(e => /start\s*year/i.test(labelTextFor(e)));
  if (startMonthEl && m != null) (setMonthValueSmart(startMonthEl, String(m)) || setSelectValueSmart(startMonthEl, String(m)));
  if (startYearEl  && y != null) setSelectValueSmart(startYearEl,  String(y));
}

function setEndMonthYearIn(row, dateStr) {
  const { m, y } = parseMonthYearLoose(dateStr);
  const endMonthEl = [...row.querySelectorAll('select, input')].find(e => /end\s*month/i.test(labelTextFor(e)));
  const endYearEl  = [...row.querySelectorAll('select, input')].find(e => /end\s*year/i.test(labelTextFor(e)));
  if (endMonthEl && m != null) (setMonthValueSmart(endMonthEl, String(m)) || setSelectValueSmart(endMonthEl, String(m)));
  if (endYearEl  && y != null) setSelectValueSmart(endYearEl,  String(y));
}

// Fill each experience block from profile.experience[i]
async function fillExperienceBlocksFromProfile(profile, root = document) {
  const exps = Array.isArray(profile?.experience) ? profile.experience : [];
  if (!exps.length) return;

  const rows = getExperienceRows(root);
  for (let i = 0; i < Math.min(rows.length, exps.length); i++) {
    const row = rows[i];
    const e   = exps[i] || {};

    // Company / Employer
    const companyEl =
      row.querySelector('[data-k="company"]') ||
      row.querySelector('[name*="company" i]') ||
      null;
    if (companyEl) setTextLike(companyEl, e.company || e.employer || "");
    else setByLabelTextIn(row, /(company|employer|organization)/i, e.company || e.employer || "");

    // Job Title / Position
    const jobEl =
      row.querySelector('[data-k="jobTitle"]') ||
      row.querySelector('[name*="job" i], [name*="title" i], [name*="position" i]') ||
      null;
    if (jobEl) setTextLike(jobEl, e.jobTitle || e.job_title || e.title || "");
    else setByLabelTextIn(row, /(job\s*title|position|role)/i, e.jobTitle || e.job_title || e.title || "");

    // Location (optional)
    const locEl =
      row.querySelector('[data-k="location"]') ||
      row.querySelector('[name*="location" i], [name*="city" i], [name*="town" i]') ||
      null;
    if (locEl) setTextLike(locEl, e.location || "");
    else setByLabelTextIn(row, /(location|city|town)/i, e.location || "");

    // Description / Responsibilities
    const descEl =
      row.querySelector('[data-k="description"], [data-k="roleDescription"]') ||
      row.querySelector('[name*="description" i], [name*="responsibil" i]') ||
      null;
    if (descEl) setTextLike(descEl, e.description || e.role_description || e.roleDescription || "");
    else setByLabelTextIn(row, /(description|responsibilit)/i, e.description || e.role_description || e.roleDescription || "");

    // Dates (prefer data-k selectors inside the block)
    const sMonth = row.querySelector('select[data-k="startMonth"]') ||
                   [...row.querySelectorAll('select')].find(el => /start\s*month/i.test(labelTextFor(el)));
    const sYear  = row.querySelector('select[data-k="startYear"]')  ||
                   [...row.querySelectorAll('select')].find(el => /start\s*year/i.test(labelTextFor(el)));
    const eMonth = row.querySelector('select[data-k="endMonth"]')   ||
                   [...row.querySelectorAll('select')].find(el => /end\s*month/i.test(labelTextFor(el)));
    const eYear  = row.querySelector('select[data-k="endYear"]')    ||
                   [...row.querySelectorAll('select')].find(el => /end\s*year/i.test(labelTextFor(el)));

    // support split or combined forms from profile.json
    if (e.startMonth || e.startYear) {
      if (sMonth) setMonthValueSmart(sMonth, String(e.startMonth));
      if (sYear)  setSelectValueSmart(sYear,  String(e.startYear));
    } else if (e.start_date) {
      setStartMonthYearIn(row, e.start_date);
    }

    if (e.endMonth || e.endYear) {
      if (eMonth) setMonthValueSmart(eMonth, String(e.endMonth));
      if (eYear)  setSelectValueSmart(eYear,  String(e.endYear));
    } else if (e.end_date) {
      setEndMonthYearIn(row, e.end_date);
    }
  }
}

window.fillExperienceBlocksFromProfile = fillExperienceBlocksFromProfile;

// Set a text/select/textarea within a given container by label regex
function setByLabelTextIn(container, rx, value) {
  if (value == null || value === "") return false;

  // Try direct label → control mapping
  const targets = [...container.querySelectorAll('input, textarea, select')];
  for (const el of targets) {
    const lab = labelTextFor(el) || "";
    if (rx.test(lab)) {
      if (el.tagName === "SELECT") setSelectValueSmart(el, value);
      else setTextLike(el, value);
      return true;
    }
  }
  return false;
}

// === Fill Education rows from profile.education using data-k / name / label fallbacks ===
function fillEducationBlocksFromProfile(profile, root = document) {
  try {
    const eduArr = Array.isArray(profile?.education) ? profile.education : [];
    if (!eduArr.length) return;

    // your getEducationRows already updated earlier
    const rows = (typeof getEducationRows === "function") ? getEducationRows(root) : Array.from(root.querySelectorAll("#eduList .item, [data-edu-item], .education-item, .edu-block"));
    const n = Math.min(rows.length, eduArr.length);

    for (let i = 0; i < n; i++) {
      const row  = rows[i];
      const data = eduArr[i] || {};

      // school
      {
        const el = pickField(row, "school", ["school","university","college"], ["school","university","college"]);
        if (el) setTextLike(el, data.school ?? data.institution ?? "");
      }

      // degreeShort (normalize common long names to short codes)
      {
        let val = data.degreeShort || data.degree || "";
        const norm = String(val).toLowerCase().replace(/\./g,"").trim();
        if (!val) {
          val = "";
        } else if (/(associate.*science|^as$)/.test(norm)) {
          val = "AS";
        } else if (/(associate.*arts|^aa$)/.test(norm)) {
          val = "AA";
        } else if (/(bachelor.*science|^bs$|^bsc$)/.test(norm)) {
          val = "BS";
        } else if (/(bachelor.*arts|^ba$)/.test(norm)) {
          val = "BA";
        } else if (/(master.*science|^ms$|^msc$)/.test(norm)) {
          val = "MS";
        } else if (/(master.*arts|^ma$)/.test(norm)) {
          val = "MA";
        } else if (/(mba)/.test(norm)) {
          val = "MBA";
        } else if (/(phd|doctor.*philosophy)/.test(norm)) {
          val = "PhD";
        }
        const sel = pickField(row, "degreeShort", ["degree"], ["degree"]);
        if (sel && sel.tagName === "SELECT") {
          setSelectValueLoose(sel, val);
        } else if (sel) {
          setTextLike(sel, val);
        }
      }

      // field
      {
        const el = pickField(row, "field", ["field","major"], ["field","major"]);
        if (el) setTextLike(el, data.field ?? data.major ?? "");
      }

      // gpa
      {
        const el = pickField(row, "gpa", ["gpa"], ["gpa"]);
        if (el) setTextLike(el, data.gpa ?? "");
      }

    // start month/year (use smart month setter so Feb/February/2 all work)
    {
      const mRaw = data.startMonth ?? data.start_month ?? data.start_m ?? "";
      const yRaw = data.startYear  ?? data.start_year  ?? data.startY   ?? "";
      const mEl = pickField(row, "startMonth", ["startMonth","start_month","fromMonth"], ["start","month"]);
      const yEl = pickField(row, "startYear",  ["startYear","start_year","fromYear"],   ["start","year"]);

      if (mEl) {
        if (mEl.tagName === "SELECT") {
          if (!setMonthValueSmart(mEl, String(mRaw))) {
            setSelectValueSmart?.(mEl, String(mRaw), "Start Month") || setSelectValueLoose(mEl, String(mRaw));
          }
        } else {
          setTextLike(mEl, String(mRaw));
        }
      }
      if (yEl) {
        if (yEl.tagName === "SELECT") {
          // SMART → LOOSE fallback (covers options without value="")
          setSelectValueSmart?.(yEl, String(yRaw), "Start Year") || setSelectValueLoose(yEl, String(yRaw));
        } else {
          setTextLike(yEl, String(yRaw));
        }
      }
    }

    // end month/year (use smart month setter)
    {
      const mRaw = data.endMonth ?? data.end_month ?? data.end_m ?? "";
      const yRaw = data.endYear  ?? data.end_year  ?? data.endY   ?? "";
      const mEl = pickField(row, "endMonth", ["endMonth","end_month","toMonth"], ["end","month"]);
      const yEl = pickField(row, "endYear",  ["endYear","end_year","toYear"],   ["end","year"]);

      if (mEl) {
        if (mEl.tagName === "SELECT") {
          if (!setMonthValueSmart(mEl, String(mRaw))) {
            setSelectValueSmart?.(mEl, String(mRaw), "End Month") || setSelectValueLoose(mEl, String(mRaw));
          }
        } else {
          setTextLike(mEl, String(mRaw));
        }
      }
      if (yEl) {
        if (yEl.tagName === "SELECT") {
          // SMART → LOOSE fallback (covers options without value="")
          setSelectValueSmart?.(yEl, String(yRaw), "End Year") || setSelectValueLoose(yEl, String(yRaw));
        } else {
          setTextLike(yEl, String(yRaw));
        }
      }
    }
    }
  } catch (e) {
    console.warn("[filler] fillEducationBlocksFromProfile error", e);
  }
}

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
      node.querySelectorAll("input, textarea, select, [contenteditable=''], [contenteditable='true']").forEach(push);
      node.querySelectorAll("*").forEach(n => { if (n.shadowRoot) walk(n.shadowRoot); });
    };
    walk(root);
    return out;
  }

  function collectPairs() {
    const inputs = collectFields(document);
    return inputs.map((el) => ({ inputEl: el, labelText: labelTextFor(el) || "(unlabeled)" }));
  }

  // ---------- Heuristics (lightweight mapping) ----------
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

// ---------- Value setter (DOM) ----------
function setNodeValue(el, val, labelText = ""){
  const tag = (el.tagName||"").toLowerCase();
  const itype = (el.type || "").toLowerCase();

  try {
    if (tag === "select") {
      // Only report success if a real option was matched & selected
      const ok = setSelectValueSmart(el, val, labelText || "");
      return !!ok;  // <- no fallback write; let the caller mark it as [skipped]
    }

    if (itype === "file") return false;

    if (itype === "checkbox") {
      const want = (val === true || String(val).toLowerCase() === "true" || String(val).toLowerCase() === "yes");
      if (el.checked !== want) { el.checked = want; fireAll(el); }
      return true;
    }

    if (itype === "radio") {
      const ok = setRadioGroupByValue(el, val);
      if (ok) return true;
      if (!el.checked) { el.checked = true; fireAll(el); }
      return true;
    }

    if (el.isContentEditable || el.getAttribute("contenteditable") === "" || el.getAttribute("contenteditable") === "true") {
      el.innerText = scalarize(val);
      fireAll(el);
      return true;
    }

    let out = scalarize(val);
    if (itype === "date") out = toISODate(out);
    else if (itype === "month") {
      const iso = toISODate(out);
      out = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.slice(0,7) : toISOMonth(out);
    }
    el.value = String(out);
    fireAll(el);
    return true;
  } catch (e) {
    console.error("[content] setNodeValue error:", e);
    return false;
  }
}

  // ---------- Detect-only ----------
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

  function detectFieldsOnPage() {
    const pairs = collectPairs();
    const seen = new Set();
    const detected = [];
    for (const { inputEl, labelText } of pairs) {
      const guess = heuristicKey(inputEl, labelText) || detectKeyByAttrs(inputEl);
      if (!guess) continue;
      const key = MODEL_TO_USERDATA[guess] || guess;
      if (seen.has(key)) continue;
      seen.add(key);
      detected.push({ key, label: ALL_FIELDS?.[key] || labelText || key, confidence: "N/A" });
    }
    return { ok: true, inputs: pairs.length, detected };
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
/* ================= NORMALIZED PREDICTIONS ================= */

function _normalizeKey(k) {
  if (!k) return null;
  const s = String(k).trim();

  // Common snake->camel and alias fixes used in tests
  const lower = s.toLowerCase();
  const alias = {
    first_name: "firstName",
    firstname: "firstName",
    last_name: "lastName",
    lastname: "lastName",
    phone: "phoneNumber",
    mobile: "phoneNumber",
    cellphone: "phoneNumber",
    postal: "zip",
    zipcode: "zip",
    birth_date: "dob",
    birthdate: "dob",
    date_of_birth: "dob",
  }[lower];
  if (alias) return alias;

  // Keep camelCase if it's already that way
  return s;
}

/* === KEY SKILLS HELPER BLOCK (content.js) === */
function sffNormSkill(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, "").trim(); // only lower + remove spaces
}

function sffGetCheckboxNodes(root = document) {
  const pairs = [];

  // Common pattern: <label> <input type="checkbox"> Skill </label>
  const labels = Array.from(root.querySelectorAll("label"));
  for (const lab of labels) {
    const input =
      lab.querySelector('input[type="checkbox"]') ||
      (lab.htmlFor ? root.getElementById(lab.htmlFor) : null);

    if (input && input.type === "checkbox") {
      const raw = lab.textContent || lab.innerText || "";
      const txt = raw.replace(/\s+/g, " ").trim();
      pairs.push({ input, label: txt });
    }
  }

  // Standalone checkboxes with aria-label/name (rare but safe)
  const lone = root.querySelectorAll(
    'input[type="checkbox"][aria-label], input[type="checkbox"][name]'
  );
  for (const inp of lone) {
    const has = pairs.some(p => p.input === inp);
    if (!has) {
      const txt = inp.getAttribute("aria-label") || inp.name || "";
      if (txt) pairs.push({ input: inp, label: txt });
    }
  }
  return pairs;
}

function sffSetCheckbox(el, on = true) {
  try {
    const target = !!on;
    if (!!el.checked === target) return false;
    el.checked = target;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

async function sffCheckKeySkills(predictedList) {
  const norm = sffNormSkill;

  // if provided, only consider these page labels (already predicted as key_skill)
  const predictedSet = new Set((predictedList || []).map(norm).filter(Boolean));

  // read the skills that were saved from the SELECTED resume (popup saves this)
  const { matchedSkills } = await chrome.storage.local.get("matchedSkills");
  const req = new Set((matchedSkills?.required || []).map(norm).filter(Boolean));
  const pref = new Set((matchedSkills?.preferred || []).map(norm).filter(Boolean));
  const resumeSet = new Set([...req, ...pref]); // all skills from the selected resume

  // scan page checkboxes + labels
  const pairs = sffGetCheckboxNodes();
  let checked = 0, candidates = 0;
  const details = [];

  for (const { input, label } of pairs) {
    const lx = norm(label);
    if (!lx) continue;

    // If we were given a predicted list, only touch those
    const isPredicted = predictedSet.size ? predictedSet.has(lx) : true;
    if (!isPredicted) continue;

    candidates++;
    const shouldCheck = resumeSet.has(lx);
    const did = shouldCheck ? sffSetCheckbox(input, true) : false;
    if (did) checked++;
    details.push({ label, normalized: lx, matched: shouldCheck, did });
  }

  return { ok: true, found: pairs.length, candidates, checked, details };
}

// === Key Skills helpers ===
function sffNormSkillToken(s) {
  let t = (s || "").toString().toLowerCase().trim();
  t = t.replace(/\s+/g, "");
  // keep + . # then normalize special cases
  t = t.replace(/[^a-z0-9+.#]/g, "");
  t = t
    .replace(/^c\+\+$/,"cpp")
    .replace(/^c#$/,"csharp")
    .replace(/^\.net$/,"dotnet")
    .replace(/^node\.?js$/,"nodejs")
    .replace(/^react\.?js$/,"react")
    .replace(/^next\.?js$/,"nextjs")
    .replace(/^express\.?js$/,"express")
    .replace(/^k8s$/,"kubernetes");
  return t.replace(/[^a-z0-9]/g,"");
}

function deriveCheckboxLabel(input) {
  // Prefer associated <label>, then aria-label, then value/text
  const lab = (input.id && document.querySelector(`label[for="${input.id}"]`)) || input.closest("label");
  const aria = input.getAttribute("aria-label");
  const txt = (lab?.textContent || aria || input.value || input.textContent || "").trim();
  return txt;
}

function findSkillsRoot() {
  // Prefer a section whose heading includes “Key Skills” or “Skills” (not “Education”)
  const containers = Array.from(document.querySelectorAll("section, fieldset, form, div"));
  for (const sec of containers) {
    const head = sec.querySelector("h1,h2,h3,h4,h5,h6,legend,.section-title,.header");
    const t = (head?.textContent || "").toLowerCase();
    if ((/\bkey\s*skills\b/.test(t) || /\bskills\b/.test(t)) && !/\beducation\b/.test(t)) {
      return sec;
    }
  }
  return document.body; // fallback
}

function pickSkillCheckboxes(root) {
  const inputs = Array.from(root.querySelectorAll('input[type="checkbox"]'));
  const roles  = Array.from(root.querySelectorAll('[role="checkbox"]'));
  return { inputs, roles };
}

async function getMatchedSkillsFromStorage() {
  const data = await new Promise(res => chrome.storage.local.get(["matchedSkills"], res));
  const ms = data?.matchedSkills || {};
  const req = Array.isArray(ms.required)  ? ms.required  : [];
  const pref= Array.isArray(ms.preferred) ? ms.preferred : [];
  return { req, pref };
}

async function checkKeySkillsFromSelectedResume() {
  // 1) Get resume matched skills from storage
  const data = await new Promise(res => chrome.storage.local.get(["matchedSkills"], res));
  const ms = data?.matchedSkills || {};
  const union = new Set([...(ms.required||[]), ...(ms.preferred||[])].map(sffNormSkillToken));
  if (!union.size) return { ok:false, reason:"no matchedSkills", checked:0, tried:0, total:0 };

  // 2) Find boxes
  const root = findSkillsRoot();
  const { inputs, roles } = pickSkillCheckboxes(root);

  let checked = 0, tried = 0;

  // native inputs
  for (const box of inputs) {
    const key = sffNormSkillToken(deriveCheckboxLabel(box));
    if (!key || !union.has(key)) continue;
    tried++;
    if (!box.checked) {
      box.click?.();
      if (!box.checked) {
        box.checked = true;
        box.dispatchEvent(new Event("input",  { bubbles: true }));
        box.dispatchEvent(new Event("change", { bubbles: true }));
        const lbl = (box.id && document.querySelector(`label[for="${box.id}"]`)) || box.closest("label");
        lbl?.click?.();
      }
    }
    if (box.checked) checked++;
  }

  // role="checkbox" custom widgets
  for (const el of roles) {
    const key = sffNormSkillToken((el.getAttribute("aria-label") || el.textContent || "").trim());
    if (!key || !union.has(key)) continue;
    tried++;
    const before = (el.getAttribute("aria-checked") || "").toLowerCase() === "true";
    if (!before) {
      el.click?.();
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const after = (el.getAttribute("aria-checked") || "").toLowerCase() === "true";
    if (after) checked++;
  }

  return { ok:true, checked, tried, total: inputs.length + roles.length };
}

// Prevent double-registering skills listeners (popup reloads/ reinjections)
if (!window.__SFF_SKILLS_LISTENERS__) {
  window.__SFF_SKILLS_LISTENERS__ = true;

  // ---- put BOTH skills listeners inside this block only once ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "EXT_CHECK_KEY_SKILLS") {
      checkKeySkillsFromSelectedResume()
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ ok:false, error:String(e) }));
      return true;
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "EXT_CHECK_PREDICTED_KEY_SKILLS") {
      (async () => {
        const data = await new Promise(res => chrome.storage.local.get(["matchedSkills"], res));
        const ms = data?.matchedSkills || {};
        const resumeSet = new Set([...(ms.required||[]), ...(ms.preferred||[])].map(sffNormSkillToken));
        const predicted = Array.isArray(msg.skills) ? msg.skills : [];
        const wanted = new Set(predicted.map(sffNormSkillToken).filter(t => resumeSet.has(t)));
        if (!wanted.size) return sendResponse({ ok:true, checked:0, tried:0, total:0 });

        const root = findSkillsRoot();
        const { inputs, roles } = pickSkillCheckboxes(root);
        let checked = 0, tried = 0;

        for (const box of inputs) {
          const key = sffNormSkillToken(deriveCheckboxLabel(box));
          if (!key || !wanted.has(key)) continue;
          tried++;
          if (!box.checked) {
            box.click?.();
            if (!box.checked) {
              box.checked = true;
              box.dispatchEvent(new Event("input",  { bubbles: true }));
              box.dispatchEvent(new Event("change", { bubbles: true }));
              const lbl = (box.id && document.querySelector(`label[for="${box.id}"]`)) || box.closest("label");
              lbl?.click?.();
            }
          }
          if (box.checked) checked++;
        }
        for (const el of roles) {
          const key = sffNormSkillToken((el.getAttribute("aria-label") || el.textContent || "").trim());
          if (!key || !wanted.has(key)) continue;
          tried++;
          const before = (el.getAttribute("aria-checked") || "").toLowerCase() === "true";
          if (!before) {
            el.click?.();
            el.dispatchEvent(new Event("input",  { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
          const after = (el.getAttribute("aria-checked") || "").toLowerCase() === "true";
          if (after) checked++;
        }
        sendResponse({ ok:true, checked, tried, total: inputs.length + roles.length });
      })();
      return true;
    }
  });
}

// Predicted key skills → intersect with resume skills, then check
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action !== "EXT_CHECK_PREDICTED_KEY_SKILLS") return;
  (async () => {
    // 1) union of resume skills
    const data = await new Promise(res => chrome.storage.local.get(["matchedSkills"], res));
    const ms = data?.matchedSkills || {};
    const resumeSet = new Set([...(ms.required||[]), ...(ms.preferred||[])].map(sffNormSkillToken));

    // 2) filter predicted by intersection
    const predicted = Array.isArray(msg.skills) ? msg.skills : [];
    const wanted = new Set(predicted.map(sffNormSkillToken).filter(t => resumeSet.has(t)));
    if (!wanted.size) return sendResponse({ ok:true, checked:0, tried:0, total:0 });

    // 3) find + click
    const root = findSkillsRoot();
    const { inputs, roles } = pickSkillCheckboxes(root);

    let checked = 0, tried = 0;

    for (const box of inputs) {
      const key = sffNormSkillToken(deriveCheckboxLabel(box));
      if (!key || !wanted.has(key)) continue;
      tried++;
      if (!box.checked) {
        box.click?.();
        if (!box.checked) {
          box.checked = true;
          box.dispatchEvent(new Event("input",  { bubbles: true }));
          box.dispatchEvent(new Event("change", { bubbles: true }));
          const lbl = (box.id && document.querySelector(`label[for="${box.id}"]`)) || box.closest("label");
          lbl?.click?.();
        }
      }
      if (box.checked) checked++;
    }

    for (const el of roles) {
      const key = sffNormSkillToken((el.getAttribute("aria-label") || el.textContent || "").trim());
      if (!key || !wanted.has(key)) continue;
      tried++;
      const before = (el.getAttribute("aria-checked") || "").toLowerCase() === "true";
      if (!before) {
        el.click?.();
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const after = (el.getAttribute("aria-checked") || "").toLowerCase() === "true";
      if (after) checked++;
    }

    sendResponse({ ok:true, checked, tried, total: inputs.length + roles.length });
  })();
  return true; // async
});

function _pickTopKeyFromAny(x) {
  // Accept: string | {prediction, confidence} | {topk:[...]} | null
  if (!x) return { prediction: null, confidence: 0 };

  // string
  if (typeof x === "string") {
    return { prediction: _normalizeKey(x), confidence: 0.66 };
  }

  // explicit {prediction, ...}
  if (x && typeof x === "object" && ("prediction" in x)) {
    const conf = typeof x.confidence === "number" ? x.confidence : 0.66;
    return { prediction: _normalizeKey(x.prediction), confidence: conf };
  }

  // { topk: [...] } where items can be string OR {label/ prediction, score/confidence}
  if (x && typeof x === "object" && Array.isArray(x.topk) && x.topk.length) {
    const first = x.topk[0];
    if (typeof first === "string") {
      return { prediction: _normalizeKey(first), confidence: 0.66 };
    }
    if (first && typeof first === "object") {
      const cand =
        first.prediction ?? first.label ?? first.key ?? first.name ?? null;
      const conf = first.confidence ?? first.score ?? 0.66;
      return { prediction: _normalizeKey(cand), confidence: Number(conf) || 0.66 };
    }
  }

  return { prediction: null, confidence: 0 };
}

async function getPredictions(labels) {
  // Always return array of {prediction, confidence} aligned to labels length.
  // 1) Try background script (your existing flow)
  const tryBg = () =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { action: "predictLabels", labels: Array.from(labels || []) }, // ← action, not type
        (resp) => resolve(resp && resp.results ? resp.results : null)
      );
    } catch {
      resolve(null);
    }
  });

window.getPredictions = getPredictions;

  // 2) Optional direct fetch fallback (if you run a local API). Safe no-op if unreachable.
  const tryFetch = async () => {
    try {
      const r = await fetch("http://127.0.0.1:5000/api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: Array.from(labels || []) }),
        credentials: "include",
      });
      if (!r.ok) return null;
      const j = await r.json();
      // Unified endpoint returns {results:[...]} — normalize to array
      if (Array.isArray(j)) return j;
      if (j && Array.isArray(j.results)) return j.results;
      return null;
    } catch {
      return null;
    }
  };  

  let raw = await tryBg();
  if (!raw) raw = await tryFetch();
  if (!raw || !Array.isArray(raw)) {
    // graceful empty
    return (labels || []).map(() => ({ prediction: null, confidence: 0 }));
  }

  // Normalize, keeping alignment with labels
  const out = (labels || []).map((_, i) => _pickTopKeyFromAny(raw[i]));
  // Final safety: ensure shape
  return out.map((r) => ({
    prediction: r && typeof r.prediction === "string" ? r.prediction : null,
    confidence: typeof r?.confidence === "number" ? r.confidence : 0,
  }));
}
/* =============== END NORMALIZED PREDICTIONS =============== */


  // ---------- main filler ----------
  async function genericScanAndFill() {
    const userData = await getUserData();
    const p = userData || {};
    const personal = p.personal || p;
    const address  = p.address  || {};
    const links    = p.links    || {};
    const exp0 = Array.isArray(p.experience) && p.experience[0] ? p.experience[0] : {};
    const flatUser = {
      firstName: personal.firstName || "",
      lastName:  personal.lastName  || "",
      fullName:  [personal.firstName, personal.lastName].filter(Boolean).join(" ") || personal.fullName || "",
      email:     personal.email     || "",
      phoneNumber: personal.phoneNumber || "",
      dob:       personal.dob       || "",
      gender:    personal.gender    || "",
      street:    address.street  || "",
      city:      address.city    || "",
      state:     address.state   || "",
      zip:       address.zip     || "",
      country:   address.country || "",
      linkedin:  links.linkedin || "",
      github:    links.github   || links.portfolio || "",
      website:   links.website  || "",
      company:   exp0.company   || "",
      jobTitle:  exp0.jobTitle  || "",
      start_date: (exp0.startMonth && exp0.startYear) ? `${String(exp0.startMonth).padStart(2,"0")}/${exp0.startYear}` : "",
      end_date:   (exp0.endMonth   && exp0.endYear)   ? `${String(exp0.endMonth).padStart(2,"0")}/${exp0.endYear}`   : "",
    };

    // Get the full profile (arrays!) so we know how many educations to add
    const fullProfile = await new Promise(res => {
      try {
        chrome.runtime.sendMessage({ action: "getProfile" }, (resp) => res((resp && resp.profile) || {}));
      } catch {
        res({});
      }
    });

    // Click “+ Add Education” enough times to reveal all edu blocks,
    // then wait a tick so new inputs are in the DOM BEFORE we scan fields.
    await ensureAndFillEducation(fullProfile, document);
    
    // Experience: mirror education orchestrator
    if (typeof ensureAndFillExperience === "function") {
      await ensureAndFillExperience(fullProfile, document);
    } else if (typeof ensureExperienceRowsExpOnly === "function") {
      await ensureExperienceRowsExpOnly(fullProfile, document);
      await fillExperienceBlocksFromProfile(fullProfile, document);
    } else {
      // final fallback to legacy helpers
      if (typeof ensureExperienceRows === "function") {
        await ensureExperienceRows(fullProfile, document);
      }
      await fillExperienceBlocksFromProfile(fullProfile, document);
    }   
        
    await fillSkillsAndScalars(fullProfile);

    const pairs = collectPairs();
    if (!pairs.length) {
      const notFilledAll = Object.entries(ALL_FIELDS).map(([k, label]) => ({ key: k, label }));
      return { ok: true, filled: [], notFilled: notFilledAll, inputs: 0 };
    }

    const labels = pairs.map((p) => p.labelText);
    let results = await getPredictions(labels);
    if (!Array.isArray(results) || !results.length) results = labels.map(() => ({ prediction: null, confidence: 0 }));
    if (results.length !== pairs.length) {
      results = pairs.map((_, i) => results[i] || { prediction: null, confidence: 0 });
    }

    const filled = [];
    const seenKeys = new Set();

    // opportunistic gender set (radio)
    try {
      if (!seenKeys.has("gender")) {
        const desired = (flatUser && (flatUser.gender || flatUser.Gender)) || "";
        if (desired) {
          const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
            .filter(r => (r.getAttribute("name") || "").toLowerCase().includes("gender"));
          if (radios.length && setRadioGroupByValue(radios[0], desired)) {
            filled.push({ key: "gender", label: "Gender", value: desired, confidence: 0.9 });
            seenKeys.add("gender");
          }
        }
      }
    } catch {}

    // ML pass
    results.forEach((res, i) => {
      const { inputEl, labelText } = pairs[i];
      let { prediction, confidence } = res || {};
      let mappedKey = MODEL_TO_USERDATA[prediction] || prediction;

      if (!mappedKey) {
        const guess = heuristicKey(inputEl, labelText);
        if (guess) { mappedKey = guess; confidence = confidence || 0.55; }
      }
      if (!mappedKey) return;

      const { value: val, key: creditKey } = resolveValueAndKey(mappedKey, labelText, flatUser);
      if (!val) return;

      if (creditKey === "city" && /\d/.test(val)) return;
      if (creditKey === "zip"  && !/^\d{3,10}(-\d{4})?$/.test(val)) return;

      try {
        const did = setNodeValue(inputEl, val, labelText || "");
        if (did) {
          filled.push({
            key: creditKey,
            label: ALL_FIELDS[creditKey] || labelText,
            value: val,
            confidence: typeof confidence === "number" ? +(confidence.toFixed(2)) : 0
          });
          seenKeys.add(creditKey);
        }
      } catch (e) {
        console.error("[content] Error filling field:", { labelText, mappedKey, error: e });
      }
    });

    const notFilled = Object.entries(ALL_FIELDS)
      .filter(([k]) => !seenKeys.has(k))
      .map(([k, label]) => ({ key: k, label }));

    return { ok: true, filled, notFilled, inputs: pairs.length };
  }

  async function scanAndFill() {
    try { return await genericScanAndFill(); }
    catch (e) {
      console.error("[content] scanAndFill fatal:", e);
      const notFilledAll = Object.entries(ALL_FIELDS).map(([k, label]) => ({ key: k, label }));
      return { ok: false, error: String(e), filled: [], notFilled: notFilledAll, inputs: 0 };
    }
  }

  function detectFields() {
    const pairs = collectPairs();
    const inputsCount = pairs.length;
    if (!inputsCount) return { ok: true, inputs: 0, detected: [] };
    const seen = new Set();
    const detected = [];
    for (const { inputEl, labelText } of pairs) {
      const guess = heuristicKey(inputEl, labelText) || detectKeyByAttrs(inputEl);
      if (!guess) continue;
      const mapped = MODEL_TO_USERDATA[guess] || guess;
      if (seen.has(mapped)) continue;
      seen.add(mapped);
      detected.push({ key: mapped, label: ALL_FIELDS[mapped] || labelText || mapped });
    }
    return { ok: true, inputs: inputsCount, detected };
  }

async function _sffDetectFieldsCore() {
  // Use your existing detector. Examples:
  // const res = await detectAllInputsOnPage();  // <-- your function
  // return Array.isArray(res) ? res : (res?.detected || []);
  // If you already have an EXT_DETECT_FIELDS handler that assembles the array,
  // just reuse its core routine here.

  // Minimal fallback skeleton (replace with your real detector):
  const nodes = Array.from(document.querySelectorAll('input, select, textarea'));
  return nodes.map(n => ({
    labelText: (n.labels && n.labels[0]?.innerText) || n.placeholder || n.name || n.id || n.tagName,
    inputType: n.type || n.tagName.toLowerCase(),
    name: n.name || null,
    id: n.id || null,
    selector: null, // you may already compute this in your detector
    detectedBy: "content",
  }));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.action === "EXT_DETECT_FIELDS_WITH_PREDICTIONS") {
    (async () => {
      try {
        // 1) detect
        const detected = await _sffDetectFieldsCore();

        // 2) ask background for predictions (index-aligned)
        const labels = detected.map(d => String(
          d.labelText || d.label || d.placeholder || d.name || d.id || ""
        ).trim());

        const pred = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: "predictLabels", labels }, (r) => resolve(r));
        });

        const results = (pred && pred.success && Array.isArray(pred.results))
          ? pred.results
          : [];

        // 3) attach predictions to detected rows
        const items = detected.map((d, i) => {
          const r = results[i] || {};
          return Object.assign({}, d, {
            prediction: r.prediction ?? null,
            confidence: (typeof r.confidence === "number" ? r.confidence : null)
          });
        });

        const predictedCount = results.filter(r => r && r.prediction).length;
        sendResponse({
          ok: true,
          detected: items.length,
          predicted: predictedCount,
          items
        });
      } catch (e) {
        console.error("[content] EXT_DETECT_FIELDS_WITH_PREDICTIONS failed:", e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // keep the message channel open for async sendResponse
  }

  // (keep your other handlers here)
});


  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    try {
      if (req.action === "ping") { sendResponse({ ok: true, v: CONTENT_VERSION }); return; }
      if (req.action === "probe") {
        const count = collectFields(document).length;
        sendResponse({ ok: true, inputs: count, v: CONTENT_VERSION }); return;
      }
      if (req.action === "getAllFieldCatalog") {
        const catalog = Object.entries(ALL_FIELDS).map(([key, label]) => ({ key, label }));
        sendResponse({ ok: true, catalog, v: CONTENT_VERSION }); return;
      }
      // === Add these cases in content.js message handler ===
      if (req.action === "EXT_DETECT_FIELDS_SIMPLE") {
        try {
          // Uses the built-in detectFieldsOnPage(), which already returns N/A confidence
          const r = detectFieldsOnPage(); // { ok, inputs, detected:[{key,label,confidence:"N/A"}] }
          sendResponse(r);
        } catch (e) {
          sendResponse({ ok:false, error:String(e), detected:[] });
        }
        return; // no async
      }

      if (req.action === "EXT_CHECK_FORM_EMPTY") {
        try {
          const inputs = collectFields(document);
          const isEmpty = inputs.every(el => {
            const tag = (el.tagName || "").toLowerCase();
            const type = (el.type || "").toLowerCase();
            if (tag === "select") {
              // empty when no value or selectedIndex <= 0 on typical placeholder selects
              return !el.value || el.selectedIndex <= 0;
            }
            if (type === "checkbox" || type === "radio") return !el.checked;
            const v = (el.value ?? "").toString().trim();
            if (!v && el.isContentEditable) {
              return !(el.textContent || "").trim();
            }
            return !v;
          });
          sendResponse({ ok:true, empty:isEmpty });
        } catch (e) {
          sendResponse({ ok:false, error:String(e), empty:true });
        }
        return; // no async
      }
      // renamed to avoid clobbering the rich detector above
      if (req.action === "EXT_DETECT_FIELDS_KEYS") { sendResponse(detectFields()); return; }
      if (req.action === "fillFormSmart") { genericScanAndFill().then(sendResponse); return true; }
      if (req.action === "EXT_GET_JOB_DESC") { sendResponse({ ok: true, jd: extractJD() }); return; }
      if (req.action === "EXT_GET_FILLER_SUMMARY") { getFillerRunSummary().then((summary)=>sendResponse({ ok:true, summary })); return true; }
    } catch (e) {
      console.error("[content] listener error:", e);
      sendResponse({ ok: false, error: String(e) });
    }
  });
})();

function parseMonthYear(raw) {
  const s = (raw || "").toString().trim();
  // MM/YYYY
  let m = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (m) return { month: Number(m[1]), year: Number(m[2]) };

  // Month YYYY (any case)
  m = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    const idx = months.indexOf(m[1].toLowerCase());
    if (idx >= 0) return { month: idx + 1, year: Number(m[2]) };
  }

  // YYYY-MM
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) return { month: Number(m[2]), year: Number(m[1]) };

  return null;
}

// Try to find sibling selects for month/year in the same row/container
function findPeerMonthYearSelects(anchor) {
  const root = anchor.closest(".row, .grid, .form-group, .form-row, fieldset, form") || anchor.parentElement || document;
  const selects = Array.from(root.querySelectorAll("select"));
  const score = (el) => {
    const idn = `${(el.name||"")} ${(el.id||"")}`.toLowerCase();
    const lab = (() => {
      if (el.id) {
        const labEl = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (labEl) return labEl.textContent || "";
      }
      const clos = el.closest("label");
      return clos ? (clos.textContent || "") : "";
    })().toLowerCase();
    const text = `${idn} ${lab}`;
    return {
      month: /month|mm\b/.test(text),
      year:  /year|yyyy\b/.test(text)
    };
  };

  let monthSel = null, yearSel = null;
  for (const el of selects) {
    const sc = score(el);
    if (sc.month && !monthSel) monthSel = el;
    if (sc.year  && !yearSel)  yearSel  = el;
  }
  // As a fallback, if we only have two selects in the same group, assume [0]=month, [1]=year
  if ((!monthSel || !yearSel) && selects.length === 2) {
    monthSel ||= selects[0]; yearSel ||= selects[1];
  }
  return { monthSel, yearSel };
}

function trySetMonthYearGroup(selectEl, rawVal, labelText = "") {
  const my = parseMonthYear(rawVal);
  if (!my) return false;
  const { monthSel, yearSel } = findPeerMonthYearSelects(selectEl);
  if (!monthSel && !yearSel) return false;

  let ok = false;
  if (monthSel) ok = setSelectValueSmart(monthSel, String(my.month), labelText || "") || ok;
  if (yearSel)  ok = setSelectValueSmart(yearSel,  String(my.year),  labelText || "") || ok;
  return ok;
}

function getDOBValue(p) {
  const dob = p?.birth_date;
  if (!dob) return null;
  if (Array.isArray(dob) && dob.length >= 3) {
    const [y,m,d] = dob;
    return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }
  return dob; // assume already "YYYY-MM-DD" or similar
}

function getMonthValueFromList(v) {
  if (Array.isArray(v) && v.length >= 2) {
    const [y,m] = v;
    return `${y}-${String(m).padStart(2,"0")}`;
  }
  return v; // "02/2021" or "2021-02" will be normalized by setMonthLike
}

function pickValueForFeature(feature, profile) {
  // ... your existing switch/case
  switch (feature) {
    case "birth_date": return getDOBValue(profile);
    case "start_date": return getMonthValueFromList(profile?.employment?.current?.start || profile?.start_date);
    case "end_date":   return getMonthValueFromList(profile?.employment?.current?.end   || profile?.end_date);

    case "address":    return profile?.address_line_1 || profile?.address;
    case "city":       return profile?.city;
    case "state":      return profile?.state;   // "NJ" or "New Jersey" – both supported
    case "zip":        return profile?.zip || profile?.postal_code;
    case "country":    return profile?.country || null;
    case "county":     return profile?.county || null;            // NEW
    case "portfolio":  return profile?.portfolio || profile?.website || profile?.github || null; // fill that GitHub box
    // demographics fallbacks
    case "gender":     return profile?.gender || null;
    case "ethnicity":  return profile?.ethnicity || null;
    case "gender_id":  return profile?.gender_identity || null;
    case "veteran":    return profile?.veteran_status || null;
  }
  return null;
}

function setInputValue(el, value, labelText = "") {
  if (!el) return false;
  const tag  = (el.tagName || "").toLowerCase();
  const type = (el.type || "").toLowerCase();

  if (tag === "select")   return setSelectValueSmart(el, value, labelText || "");
  if (tag === "textarea") return setTextLike(el, value);

  if (tag === "input") {
    if (type === "radio")    return setRadioByValue(el.ownerDocument || document, el.name, value);
    if (type === "checkbox") return setCheckbox(el, !!value && `${value}`.toLowerCase() !== "unchecked");
    if (type === "date")     return setDateLike(el, value);
    if (type === "month")    return setMonthLike(el, value);
    return setTextLike(el, value);
  }
  return false;
}

function chooseRadioByValue(name, want) {
  if (!name) return { ok:false, reason:"no group name" };
  const radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`));
  if (!radios.length) return { ok:false, reason:"no radios found" };
  const target = String(want || "").trim().toLowerCase();

  for (const r of radios) {
    const lab = document.querySelector(`label[for="${CSS.escape(r.id || "")}"]`) || r.closest("label");
    const txt = (lab && lab.textContent || "").trim().toLowerCase();
    if (txt && target && (txt === target || txt.includes(target))) { r.click(); return { ok:true }; }
  }
  for (const r of radios) if ((r.value || "").toLowerCase() === target) { r.click(); return { ok:true }; }
  return { ok:false, reason:"no matching option" };
}

function setCheckboxByBool(el, on) {
  if (!el) return { ok:false, reason:"no element" };
  if (el.type !== "checkbox") return { ok:false, reason:"not checkbox" };
  if (!!el.checked !== !!on) el.click();
  return { ok:true };
}

function fmtMMYYYY(m, y) {
  if (!m || !y) return null;
  const mm = String(m).padStart(2,"0");
  return `${mm}/${y}`;
}

async function setComboOrTextNear(el, value) {
  const H = window.H || window.SFFHelpers || {};
  const root = el.closest(".form-group, .row, .grid, fieldset, form") || el.parentElement || el.ownerDocument;

  // ARIA combobox
  const combo = root.querySelector('[role="combobox"], input[role="combobox"]');
  if (combo) {
    combo.focus();
    combo.value = value;
    combo.dispatchEvent(new Event("input", { bubbles:true }));
    combo.dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", bubbles:true }));
    combo.dispatchEvent(new Event("change", { bubbles:true }));
    combo.blur?.();
    return true;
  }
  // Plain text input nearby
  const text = root.querySelector('input[type="text"], input:not([type]), textarea, [contenteditable="true"]');
  if (text) {
    text.focus();
    if ("value" in text) text.value = value; else text.textContent = value;
    text.dispatchEvent(new Event("input", { bubbles:true }));
    text.dispatchEvent(new Event("change", { bubbles:true }));
    text.blur?.();
    return true;
  }
  return false;
}

function valueFromProfile(row, profile) {
  const label = (row.labelText || "").toLowerCase();
  const pred  = row.prediction;
  const elNode = row.selector ? document.querySelector(row.selector) : null;
  const ctx = row.context || (elNode
    ? (window.SFF_inferContext ? window.SFF_inferContext(elNode) : null)
    : null);
  const edList = Array.isArray(profile.education)  ? profile.education  : [];
  const exList = Array.isArray(profile.experience) ? profile.experience : [];
  const edIdx = window.SFF_getEducationIndexForElement
    ? window.SFF_getEducationIndexForElement(elNode)
    : 0;

  // Pick the correct edu entry for this field; fall back to first
  const edX = edList[edIdx] || edList[0] || {};
  const ex0 = exList[0]     || {};

  // tolerate both root-level and nested shapes
  const p  = profile.personal || {};
  const l  = profile.links || {};
  const a  = profile.address || {};
  const ed = (profile.education  || [])[0] || {};
  const ex = (profile.experience || [])[0] || {};

  // Merge eligibility + root-style fallbacks
  const el = Object.assign(
    {},
    profile.eligibility || {},
    {
      authUS:           profile?.eligibility?.authUS           ?? profile.authUS,
      sponsorship:      profile?.eligibility?.sponsorship      ?? profile.sponsorship,
      background_check: profile?.eligibility?.background_check ?? profile.background_check,
      terms_consent:    profile?.eligibility?.terms_consent    ?? profile.terms_consent,
      veteran_status:   profile?.eligibility?.veteran_status   ?? profile.veteran ?? profile?.eligibility?.veteran,
      ethnicity:        profile?.eligibility?.ethnicity        ?? profile.ethnicity
    }
  );

  const d  = Object.assign({}, profile.demographics || {}, {
    ethnicity:     el.ethnicity,
    veteranStatus: el.veteran_status
  });

  // robust Yes/No normalizer
  const yn = (v) => {
    if (typeof v === "boolean") return v ? "Yes" : "No";
    const s = String(v ?? "").trim();
    if (!s) return null;
    if (/^(y|yes|true|1)$/i.test(s)) return "Yes";
    if (/^(n|no|false|0)$/i.test(s)) return "No";
    return s; // pass-through pre-phrased values
  };

  // ---- Name / contact
  if (pred === "name") {
    if (/first/.test(label)) return p.firstName || null;
    if (/(last|surname|family)/.test(label)) return p.lastName || null;
    return `${p.firstName || ""} ${p.lastName || ""}`.trim() || null;
  }
  if (pred === "email")      return p.email || null;
  if (pred === "phone")      return p.phoneNumber || null;
  if (pred === "birth_date") return p.dob || null;

  // ---- Social / websites
  if (pred === "linkedin" || /linkedin/.test(label)) return l.linkedin || null;
  if (pred === "github"   || /github/.test(label))   return l.github || l.website || null;
  if (pred === "social" || /portfolio|website|personal website|personal site/.test(label)) {
    return l.website || l.portfolio || l.github || l.linkedin || null;
  }

  // ---- Employment / education
  if (pred === "company")          return ex.company || null;
  if (pred === "job_title")        return ex.jobTitle || null;
  if (pred === "role_description") return ex.description || ex.roleDescription || null;

  // Model class → Highest Education
  if (pred === "highest_education") {
    return (profile.highestEducation || profile.educationHighest || "") || null;
  }

  // Model class → Years of (Professional) Experience
  if (pred === "years_of_experience") {
    return (profile.yearsOfExperience || profile.meta?.yearsOfExperience || "") || null;
  }

  const fmtMMYYYY = (m, y) => (m && y) ? `${String(m).padStart(2,"0")}/${y}` : null;

  if (pred === "start_date") {
    const eduStart = fmtMMYYYY(edX.startMonth, edX.startYear);
    const jobStart = fmtMMYYYY(ex0.startMonth, ex0.startYear);
    if (ctx === "education")  return eduStart || jobStart;
    if (ctx === "employment") return jobStart || eduStart;
    // default bias to education to avoid mis-filling edu dates from employment
    return eduStart || jobStart;
  }

  if (pred === "end_date") {
    const eduEnd = fmtMMYYYY(edX.endMonth, edX.endYear);
    const jobEnd = fmtMMYYYY(ex0.endMonth, ex0.endYear);
    if (ctx === "education")  return eduEnd || jobEnd;
    if (ctx === "employment") return jobEnd || eduEnd;
    return eduEnd || jobEnd;
  }

  // ---- Education details (degree / school / major / graduation year)
  if (pred === "education") {
    // Highest Degree (supports selects and text)
    if (/\bdegree\b/.test(label)) {
      const deg = edX.degreeLong || edX.degreeShort || "";
      if (!deg) return null;
      return (window.H && H.normalizeDegreeLabel) ? H.normalizeDegreeLabel(deg) : deg;
    }
    // University / College / Institute / School
    if (/\b(university|college|institute|school)\b/.test(label)) {
      return edX.school || null;
    }
    // Field of Study / Major / Discipline / Concentration
    if (/\b(field|major|study|discipline|concentration)\b/.test(label)) {
      return edX.field || null;
    }
    // GPA
    if (/\bgpa\b/.test(label)) {
      return edX.gpa || null;
    }
    // Year of Graduation / Graduation Year
    if (/\b(grad|graduation|year)\b/.test(label)) {
      return edX.endYear || edX.graduationYear || null;
    }
    return null;
  }
  
  // ---- Address routing (label FIRST, then street fallback)
  if (pred === "address") {
    if (/\bcity\b|\btown\b|\bmunicipality\b|\blocality\b|\bsuburb\b/.test(label)) return a.city || null;
    if (/\bstate\b|\bprovince\b|\bregion\b|\bprefecture\b|\bcanton\b|\bshire\b|\bward\b|\btehsil\b|\btaluk\b/.test(label)) return a.state || null;
    if (/\bzip\b|\bpostal\b|\bpostcode\b/.test(label)) return a.zip || null;
    if (/\bcountry\b|\bnation\b/.test(label)) return a.country || null;
    if (/\bcounty\b/.test(label)) return a.county || null;
    if (/street|address line|permanent address|mailing address|^address\b/.test(label)) return a.street || null;
    return null;
  }
  if (pred === "city")    return a.city || null;
  if (pred === "state")   return a.state || null;
  if (pred === "zip")     return a.zip || null;
  if (pred === "country") return a.country || null;

  // ===== Eligibility / consents / demographics =====
  if (pred === "work_auth") {
    // disambiguate by label
    if (/sponsor|sponsorship/.test(label))                            return yn(el.sponsorship); // "Will you require sponsorship?"
    if (/authorized|authorised|work in the (u\.?s\.?|united states)/i.test(label)) return yn(el.authUS);     // "Are you authorized to work in the US?"
    return null;
  }

  if (pred === "background_check" || /background.*check/.test(label)) return yn(el.background_check ?? "Yes"); // default agree if missing
  if (pred === "terms_consent"    || /terms|privacy|consent/.test(label)) return yn(el.terms_consent ?? "Yes"); // default agree if missing

  if (pred === "demographics" && /veteran/.test(label)) {
    const v = d.veteranStatus ?? el.veteran ?? null;
    if (v == null) return null;
    const s = String(v).toLowerCase();
    if (/^(y|yes|true|1)|\bveteran\b/.test(s)) return "Veteran";
    if (/^(n|no|false|0)|\bnot\b/.test(s))     return "Not a Veteran";
    if (/prefer|decline/.test(s))              return "Prefer not to say";
    return v;
  }

  if (pred === "demographics" && /\b(ethnicity|race)\b/.test(label)) {
    const e = d.ethnicity;
    if (!e) return null;
    const s = String(e).toLowerCase();
    if (/hispanic|latinx|latino|latina/.test(s)) return "Hispanic or Latino";
    if (/not.*hispanic/.test(s))                 return "Not Hispanic or Latino";
    if (/prefer.*not.*say|decline/.test(s))      return "Prefer not to say";
    return e;
  }

  if (pred === "demographics" && /gender identity/.test(label)) return d.genderIdentity || p.gender || null;
  if (pred === "demographics" && /\bgender\b/.test(label))      return d.gender || p.gender || null;

  // Intentionally manual
  if (pred === "referral_source") return null;

  return null;
}

async function fillDetected(items, profile, resumeId) {
  const report = [];
  for (const row of items || []) {
    const el = row.node || (row.selector ? document.querySelector(row.selector) : null);
    const pred = row.prediction;
    const label = row.labelText || "";

    if (!el) {
      report.push({ label, prediction: pred, confidence: row.confidence, status:"skipped", reason:"element not found" });
      continue;
    }

    // handle file inputs (resume upload)
    if (el.tagName.toLowerCase() === "input" && (el.type || "").toLowerCase() === "file") {
      if (pred !== "document") {
        report.push({ label, prediction: pred, confidence: row.confidence, status:"skipped", reason:"not a document field" });
        continue;
      }

      // Intentionally skip cover letter / additional docs (per spec)
      const lbl = (label || "").toLowerCase();
      if (/\bcover\s*letter\b|\badditional\s*information\b/.test(lbl)) {
        report.push({ label, prediction: pred, confidence: row.confidence, status:"skipped", reason:"cover letter intentionally skipped" });
        continue;
      }

      const rid = resumeId || (await chrome.storage.local.get("lastResumeId")).lastResumeId || null;
      if (!rid) {
        report.push({ label, prediction: pred, confidence: row.confidence, status:"skipped", reason:"no resume selected" });
        continue;
      }

      try {
        // ask background for the resume file
        const blobResp = await new Promise(res =>
          chrome.runtime.sendMessage({ action:"getResumeFile", id: rid }, r => res(r))
        );
        if (!blobResp?.ok) throw new Error(blobResp?.error || "resume fetch failed");

        const bytes = Uint8Array.from(atob(blobResp.base64), c => c.charCodeAt(0));
        const file  = new File([bytes], blobResp.name || "resume.pdf", { type: blobResp.type || "application/pdf" });

        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;

        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));

        report.push({ label, prediction: pred, confidence: row.confidence, status:"filled", valuePreview: file.name });
      } catch (e) {
        report.push({ label, prediction: pred, confidence: row.confidence, status:"skipped", reason: String(e) });
      }
      continue;
    }


    // radios
    if ((el.type || "").toLowerCase() === "radio") {
      const desired = valueFromProfile(row, profile);
      if (!desired) { report.push({ label, prediction: pred, confidence: row.confidence, status:"skipped", reason:"no profile value" }); continue; }
      const res = chooseRadioByValue(row.name, desired);
      report.push({ label, prediction: pred, confidence: row.confidence, status: res.ok?"filled":"skipped", reason: res.ok?"":res.reason, valuePreview: desired });
      continue;
    }

    // checkboxes
    if ((el.type || "").toLowerCase() === "checkbox") {
      const desired = valueFromProfile(row, profile);
      if (desired == null) { report.push({ label, prediction: pred, confidence: row.confidence, status:"skipped", reason:"no profile value" }); continue; }
      const wantOn = (typeof desired === "boolean") ? desired : /^y(es)?$/i.test(String(desired));
      const res = setCheckboxByBool(el, wantOn);
      report.push({ label, prediction: pred, confidence: row.confidence, status: res.ok?"filled":"skipped", reason: res.ok?"":res.reason, valuePreview: wantOn ? "checked" : "unchecked" });
      continue;
    }

    // text/select/textarea
    const value = valueFromProfile(row, profile);
    if (!value) {
      report.push({ label, prediction: pred, confidence: row.confidence, status:"skipped", reason:"no profile value" });
      continue;
    }
    const ok = setInputValue(el, String(value), label || "");
    report.push({ label, prediction: pred, confidence: row.confidence, status: ok?"filled":"skipped", reason: ok?"":"set value failed", valuePreview: String(value) });
  }
  return report;
}

// ---- Small waits for DOM to settle ----
function waitFrame() {
  return new Promise(r => requestAnimationFrame(() => r()));
}
function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}
async function waitDomSettle() {
  // 2 rafs + short timeout helps when frameworks insert inputs async
  await waitFrame(); await waitFrame(); await wait(20);
}

// === SAFE WRAPPER (always returns aligned [{prediction, confidence}, ...]) ===
async function getPredictionsSafe(labels) {
  try {
    const labs = Array.from(labels || []);
    // Use the global one. Do NOT reference a bare getPredictions here.
    const gp = (typeof window.getPredictions === "function") ? window.getPredictions : null;
    if (!gp) {
      // last-resort background call
      const reply = await new Promise(res => {
        chrome.runtime.sendMessage({ action: "predictLabels", labels: labs }, r => res(r));
      });
      const ok = reply && Array.isArray(reply.results);
      const arr = ok ? reply.results : [];
      return labs.map((_, i) => arr[i] || { prediction: null, confidence: 0 });
    }
    const out = await gp(labs);
    if (!Array.isArray(out)) return labs.map(() => ({ prediction: null, confidence: 0 }));
    return labs.map((_, i) => out[i] || { prediction: null, confidence: 0 });
  } catch (e) {
    console.warn("[content] getPredictionsSafe error:", e);
    return (labels || []).map(() => ({ prediction: null, confidence: 0 }));
  }
}

window.getPredictionsSafe = getPredictionsSafe;

// ---- One full pass: detect → predict → fill ----
async function runFullDetectFill(profile, resumeId = null) {
  try {
    await waitDomSettle();

    const detected = (typeof detectAllFields === "function") ? detectAllFields() : [];
    const labels   = detected.map(r => r.labelText || "");
    const preds    = await getPredictionsSafe(labels);

    const items = detected.map((row, i) => {
      const pr = preds[i] || { prediction: null, confidence: 0 };
      return {
        ...row,
        prediction: pr.prediction ?? null,
        confidence: (typeof pr.confidence === "number") ? pr.confidence : 0
      };
    });

    // Your existing centralized filler
    return await fillDetected(items, profile, resumeId);
  } catch (e) {
    console.warn("[content] runFullDetectFill failed:", e);
    return [];
  }
}

// expose for any caller (popup, other helpers, observers)
window.runFullDetectFill = runFullDetectFill;


chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.action === "EXT_FILL_FIELDS") {
        const profile = msg.profile || {};
      
        // 1) Education: ensure rows exist and fill them (handles wait + retry)
        try {
          if (typeof ensureAndFillEducation === "function") {
            await ensureAndFillEducation(profile, document);
          } else if (typeof window.ensureAndFillEducation === "function") {
            await window.ensureAndFillEducation(profile, document);
          } else {
            // fallback to older two-step if orchestrator is unavailable
            if (typeof ensureEducationRowsEduOnly === "function") {
              await ensureEducationRowsEduOnly(profile, document);
            } else if (typeof window.ensureEducationRowsEduOnly === "function") {
              await window.ensureEducationRowsEduOnly(profile, document);
            }
            await new Promise(r => setTimeout(r, 120));
            if (typeof fillEducationBlocksFromProfile === "function") {
              await fillEducationBlocksFromProfile(profile, document);
            } else if (typeof window.fillEducationBlocksFromProfile === "function") {
              await window.fillEducationBlocksFromProfile(profile, document);
            }
          }

          // Experience — mirror education orchestrator (single caller)
          try {
            await ensureAndFillExperience(profile, document);
          } catch (e) {
            console.warn("[content] ensureAndFillExperience failed:", e);
          }    
          
          await fillVoluntarySelfID(profile);

        } catch (e) {
          console.warn("[content] add/fill edu/exp failed:", e);
        }    
        // 1) Initial pass with whatever the popup already had
        const report1 = await fillDetected(msg.items || [], profile, msg.resumeId || null);

        // 3) Final catch-all pass to scoop up any late-bound inputs
        const report3 = await runFullDetectFill(profile, msg.resumeId || null);

        // 4) Merge reports (dedupe by label+prediction+status)
        const seen = new Set();
        const merged = [];
        for (const r of [...(report1||[]), ...(report3||[])]) {
          const key = `${r.label ?? ""}::${r.prediction ?? ""}::${r.status ?? ""}`;
          if (!seen.has(key)) { seen.add(key); merged.push(r); }
        }

        // --- Build a fresh detect+predict snapshot AFTER adding/filling rows ---
        const detectedNow = (typeof detectAllFields === "function") ? detectAllFields() : [];
        const labelsNow   = detectedNow.map(r => r.labelText || "");
        const predsNow    = await getPredictionsSafe(labelsNow);

        // annotate detections with predictions for the popup
        const annotated = detectedNow.map((row, i) => ({
          ...row,
          prediction: (predsNow[i] && predsNow[i].prediction) || null,
          confidence: (predsNow[i] && typeof predsNow[i].confidence === "number") ? predsNow[i].confidence : 0
        }));
        const predictedCount = annotated.filter(a => !!a.prediction).length;

        // return both: the fill report + the *live* detection summary
        sendResponse({
          ok: true,
          report: merged,
          detectSummary: {
            detected: annotated.length,
            predicted: predictedCount,
            items: annotated
          }
        });
        return;
      }      
    } catch (e) {
      sendResponse({ ok:false, error:String(e) });
    }
  })();
  return true;
});

// --- Simple, real detector for popup's Detected Fields ---
(function(){
  function isFillCandidate(el){
    if (!el || el.disabled) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (!["input","select","textarea"].includes(tag)) return false;
    if (tag === "input") {
      const t = (el.type || "").toLowerCase();
      if (["hidden","submit","button","reset","image","file"].includes(t)) return false;
    }
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  function labelFor(el){
    // <label for="">
    if (el.labels && el.labels.length) {
      const s = (el.labels[0].innerText || el.labels[0].textContent || "").trim();
      if (s) return s;
    }
    // aria-label
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    // placeholder
    const ph = (el.getAttribute("placeholder") || "").trim();
    if (ph) return ph;
    // nearest text before it
    let n = el;
    for (let i=0;i<4 && n;i++){
      n = n.previousElementSibling;
      if (!n) break;
      const txt = (n.innerText || n.textContent || "").trim();
      if (txt) return txt;
    }
    // fallback name/id
    return el.name || el.id || "(unlabeled)";
  }

  function cssPath(el){
    try {
      if (!(el instanceof Element)) return "";
      const parts = [];
      while (el && el.nodeType === 1 && parts.length < 6) {
        let sel = el.nodeName.toLowerCase();
        if (el.id) { sel += `#${el.id}`; parts.unshift(sel); break; }
        let sib = el, i = 1;
        while (sib = sib.previousElementSibling) if (sib.nodeName === el.nodeName) i++;
        sel += `:nth-of-type(${i})`;
        parts.unshift(sel);
        el = el.parentElement;
      }
      return parts.join(" > ");
    } catch { return ""; }
  }

  function collect(){
    const out = [];
    document.querySelectorAll("input, select, textarea").forEach(el => {
      if (!isFillCandidate(el)) return;
      out.push({
        label: labelFor(el),
        name: el.name || null,
        id: el.id || null,
        selector: cssPath(el)
      });
    });
    return out;
  }

  // probe + empty-check for popup's restore logic
  function isFormEmpty(){
    const els = Array.from(document.querySelectorAll("input, select, textarea")).filter(isFillCandidate);
    return els.every(el => {
      const tag = el.tagName.toLowerCase();
      if (tag === "select") return !el.value;
      if (tag === "textarea") return !el.value?.trim();
      if (tag === "input") {
        const t = (el.type || "").toLowerCase();
        if (t === "checkbox" || t === "radio") return !el.checked;
        return !el.value?.trim();
      }
      return true;
    });
  }

  // only add listeners if not already wired elsewhere
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action === "EXT_DETECT_FIELDS_SIMPLE") {
      try { sendResponse({ ok:true, detected: collect() }); } catch (e) { sendResponse({ ok:false, error:String(e) }); }
      return true;
    }
    if (msg?.action === "EXT_CHECK_FORM_EMPTY") {
      try { sendResponse({ ok:true, empty: isFormEmpty() }); } catch (e) { sendResponse({ ok:false, error:String(e) }); }
      return true;
    }
    if (msg?.action === "probe") {
      try { sendResponse({ ok:true, inputs: collect().length }); } catch { sendResponse({ ok:false, inputs:0 }); }
      return true;
    }
  });
})();


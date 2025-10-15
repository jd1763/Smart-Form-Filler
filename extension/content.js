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

  function findGroupQuestion(el) {
    // 1) If inside a <fieldset>, prefer its <legend>
    const fs = el.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector(':scope > legend');
      const legendText = lg && lg.textContent ? lg.textContent.trim() : '';
      if (legendText) return { text: legendText, reason: 'fieldset>legend' };
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

  function setSelectValueSmart(sel, value, labelHint="") {
    const H = window.H || window.SFFHelpers;
    if (!sel || sel.tagName !== "SELECT") return false;
    if (value == null || value === "") return false; // honor "no default" policy
  
    let candidates = [String(value)];
  
    // State & Country by label hint or select id/name
    const l = (labelHint || "").toLowerCase() + " " + (sel.id||"") + " " + (sel.name||"");
    if (/\b(state|province|region)\b/.test(l)) {
      candidates = H.buildStateCandidates ? H.buildStateCandidates(value) : [value];
    } else if (/\bcountry|nation\b/.test(l)) {
      candidates = H.buildCountryCandidates ? H.buildCountryCandidates(value) : [value];
    } else if (/\bdegree|highest\b/.test(l)) {
      candidates = H.buildDegreeCandidates ? H.buildDegreeCandidates(value) : [value];
    }
  
    // Ethnicity
    if (/\bethnicity\b/.test(l)) {
      candidates = H.buildEthnicityCandidates ? H.buildEthnicityCandidates(value) : [value];
    }
  
    // Veteran
    if (/\bveteran\b/.test(l)) {
      candidates = H.buildVeteranCandidates ? H.buildVeteranCandidates(value) : [value];
    }
  
    // Terms/Consent/Background → checkbox selects appear sometimes as <select>
    if (/\b(terms|privacy|consent|background)\b/.test(l)) {
      candidates = ["Yes", "I Agree", "Agree", "I Consent", "Consented", "Accept"];
    }
  
    const idx = H.matchOptionIndex ? H.matchOptionIndex(sel, candidates) : -1;
    if (idx >= 0) {
      sel.selectedIndex = idx;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      sel.dispatchEvent(new Event("input",  { bubbles: true }));
      return true;
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
  function setNodeValue(el, val){
    const tag = (el.tagName||"").toLowerCase();
    const itype = (el.type || "").toLowerCase();

    try {
      if (tag === "select") {
        if (!setSelectValueSmart(el, val)) { el.value = String(scalarize(val)); fireAll(el); }
        return true;
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
        const did = setNodeValue(inputEl, val);
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
      if (req.action === "EXT_DETECT_FIELDS") { sendResponse(detectFields()); return; }
      if (req.action === "fillFormSmart") { genericScanAndFill().then(sendResponse); return true; }
      if (req.action === "EXT_GET_JOB_DESC") { sendResponse({ ok: true, jd: extractJD() }); return; }
      if (req.action === "EXT_GET_FILLER_SUMMARY") { getFillerRunSummary().then((summary)=>sendResponse({ ok:true, summary })); return true; }
    } catch (e) {
      console.error("[content] listener error:", e);
      sendResponse({ ok: false, error: String(e) });
    }
  });
})();

// ===== FILLER =====
function setSelectValueSmart(selectEl, rawVal) {
  if (!selectEl) return false;
  const _nz  = (v) => (v ?? "").toString().trim();
  const _nrm = (v) => _nz(v).toLowerCase().replace(/[^a-z0-9]/g, "");

  const val = _nz(rawVal);
  if (!val) return false;

  // Build candidates (raw + case variants)
  const candidates = [val, val.toUpperCase(), val.toLowerCase()];

  // Degree aliases
  const valN = _nrm(val);
  if (typeof DEGREE_ALIASES === "object" && DEGREE_ALIASES[valN]) {
    candidates.push(...DEGREE_ALIASES[valN]);
  }

  // Heuristics based on the select's name/id
  const nameId   = _nrm(`${selectEl.name} ${selectEl.id}`);
  const isStatey = /state|province|region/.test(nameId);
  const isCountry= /country|nation/.test(nameId);

  // Use helpers if present
  const H = window.H || window.SFFHelpers || {};
  const toAbbr       = H.toAbbr       || ((s)=>s);
  const ABBR_TO_STATE= H.ABBR_TO_STATE|| {};
  const normCountry  = H.normCountry  || ((s)=>s);

  // State: add abbr↔full variants
  if (isStatey) {
    // If a full name was provided, add its abbreviation
    const tryAbbr = toAbbr(val);
    if (tryAbbr && tryAbbr !== val) candidates.push(tryAbbr);

    // If a two-letter abbr was provided, add the full state name
    if (/^[A-Z]{2}$/i.test(val)) {
      const full = ABBR_TO_STATE[val.toUpperCase()];
      if (full) candidates.push(full);
    }
  }

  // Country: normalize common variants
  if (isCountry) {
    const nc = normCountry(val);
    if (nc && nc !== val) candidates.push(nc);
    // Add a couple of frequent spellings just in case
    if (/^us$/i.test(val)) candidates.push("United States", "USA", "U.S.");
    if (/^u\.?s\.?a\.?$/i.test(val)) candidates.push("United States");
  }

  // Prepare options snapshot
  const opts = Array.from(selectEl.options || []).map((o, idx) => ({
    idx,
    text:  _nz(o.textContent),
    value: _nz(o.value),
    textN: _nrm(o.textContent),
    valueN: _nrm(o.value)
  }));

  // 1) direct case-insensitive exact
  for (const c of candidates) {
    const cL = c.toLowerCase();
    const hit = opts.find(o => o.text.toLowerCase() === cL || o.value.toLowerCase() === cL);
    if (hit) { selectEl.selectedIndex = hit.idx; selectEl.dispatchEvent(new Event("change", {bubbles:true})); return true; }
  }
  // 2) normalized exact
  for (const c of candidates.map(_nrm)) {
    const hit = opts.find(o => o.textN === c || o.valueN === c);
    if (hit) { selectEl.selectedIndex = hit.idx; selectEl.dispatchEvent(new Event("change", {bubbles:true})); return true; }
  }
  // 3) normalized “contains” (covers things like “United States (US)”)
  for (const c of candidates.map(_nrm)) {
    const hit = opts.find(o => o.textN.includes(c) || o.valueN.includes(c));
    if (hit) { selectEl.selectedIndex = hit.idx; selectEl.dispatchEvent(new Event("change", {bubbles:true})); return true; }
  }

  return false;
}

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

function trySetMonthYearGroup(selectEl, rawVal) {
  const my = parseMonthYear(rawVal);
  if (!my) return false;
  const { monthSel, yearSel } = findPeerMonthYearSelects(selectEl);
  if (!monthSel && !yearSel) return false;

  let ok = false;
  if (monthSel) ok = setSelectValueSmart(monthSel, String(my.month)) || ok;
  if (yearSel)  ok = setSelectValueSmart(yearSel,  String(my.year))  || ok;
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

function setInputValue(el, value) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  const type = (el.type || "").toLowerCase();

  if (tag === "select") return setSelectValueSmart(el, value);
  if (tag === "textarea") return setTextLike(el, value);

  if (tag === "input") {
    if (type === "radio")   return setRadioByValue(el.ownerDocument || document, el.name, value);
    if (type === "checkbox")return setCheckbox(el, !!value && `${value}`.toLowerCase() !== "unchecked");

    if (type === "date")    return setDateLike(el, value);
    if (type === "month")   return setMonthLike(el, value);

    // text-like
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

  const p  = profile.personal || {};
  const l  = profile.links || {};
  const a  = profile.address || {};
  const ed = (profile.education || [])[0] || {};
  const ex = (profile.experience || [])[0] || {};
  const d  = profile?.demographics || {};


  if (pred === "name") {
    if (/first/.test(label)) return p.firstName || null;
    if (/(last|surname|family)/.test(label)) return p.lastName || null;
    return `${p.firstName || ""} ${p.lastName || ""}`.trim() || null;
  }
  if (pred === "email") return p.email || null;
  if (pred === "phone") return p.phoneNumber || null;
  if (pred === "birth_date") return p.dob || null;

  // Social / LinkedIn / Portfolio / GitHub — choose the *right* link per field
  if (pred === "linkedin" || /linkedin/.test(label)) {
    const l = profile?.links || {};
    return l.linkedin || null;
  }
  if (pred === "github" || /github/.test(label)) {
    const l = profile?.links || {};
    return l.github || l.website || null;
  }
  // Generic "social" or Portfolio/Website buckets → prefer portfolio/website first, then GitHub, then LinkedIn
  if (pred === "social" || /portfolio|website|personal website|personal site/.test(label)) {
    const l = profile?.links || {};
    return l.website || l.portfolio || l.github || l.linkedin || null;
  }

  if (pred === "company") return ex.company || null;
  if (pred === "job_title") return ex.jobTitle || null;
  if (pred === "role_description") return ex.description || ex.roleDescription || null;

  if (pred === "education") {
    if (/degree/.test(label)) {
      const raw = ed.degreeLong || ed.degreeShort || null;
      if (!raw) return null;
      return (window.H?.normalizeDegreeLabel ? window.H.normalizeDegreeLabel(raw) : raw);
    }
    if (/school|university|college|institute/.test(label)) return ed.school || null;
    if (/field|major|concentration/.test(label)) return ed.field || null;
    if (/gpa/.test(label)) return ed.gpa || null;
    if (/graduation|year/.test(label)) return ed.endYear || null;
    return null;
  }

  if (pred === "address") {
    if (/mailing address/.test(label)) return a.street || null;
    if (/permanent address/.test(label)) return a.street || null;
    if (/street|address line/.test(label)) return a.street || null;
    if (/city|town|municipality|locality|suburb/.test(label)) return a.city || null;
    if (/state|province|region|prefecture|canton|shire|ward|tehsil|taluk/.test(label)) return a.state || null;
    if (/zip|postal|postcode/.test(label)) return a.zip || null;
    if (/\bcounty\b/.test(label)) return a.county || null;
    if (/country|nation/.test(label)) return a.country || null;
    return null; // county not in profile by default
  }

  // Demographics group (no defaults — skip if unknown)
  if (pred === "demographics") {
    if (/gender identity|gender/.test(label)) return d.genderIdentity || p.gender || null;
    if (/ethnicity|race/.test(label))         return d.ethnicity || null;
    if (/veteran/.test(label))                return d.veteranStatus || null;
    return null;
  }

  if (pred === "start_date") {
    const scope = row.scope || row.context || "";
    if (scope === "education") return fmtMMYYYY(ed.startMonth, ed.startYear);
    return fmtMMYYYY(ex.startMonth, ex.startYear) || fmtMMYYYY(ed.startMonth, ed.startYear);
  }
  if (pred === "end_date") {
    const scope = row.scope || row.context || "";
    if (scope === "education") return fmtMMYYYY(ed.endMonth, ed.endYear);
    return fmtMMYYYY(ex.endMonth, ex.endYear) || fmtMMYYYY(ed.endMonth, ed.endYear);
  }

  // ===== Eligibility & Compliance values (NO DEFAULTS) =====

  // Work authorization ("Are you authorized to work in the US?")
  if (pred === "work_auth" && /authorized|work in the (us|united states)/i.test(label)) {
    const v = profile?.eligibility?.authUS ?? profile?.personal?.workAuth ?? null; // boolean or "Yes"/"No"
    if (v == null) return null;
    return (typeof v === "boolean") ? (v ? "Yes" : "No") : v;
  }

  // Sponsorship ("Will you now or in the future require sponsorship?")
  if (pred === "work_auth" && /sponsor|sponsorship/i.test(label)) {
    const v = profile?.eligibility?.needSponsorship ?? profile?.personal?.needSponsorship ?? null;
    if (v == null) return null;
    return (typeof v === "boolean") ? (v ? "Yes" : "No") : v;
  }

  // Background check consent
  if (pred === "background_check") {
    const v = profile?.eligibility?.backgroundCheck ?? null; // boolean or "Yes"/"No"
    return v ?? null;
  }

  // Terms consent
  if (pred === "terms_consent") {
    const v = profile?.eligibility?.termsConsent ?? null; // boolean or "Yes"/"No"
    return v ?? null;
  }

  // Ethnicity (string; e.g., "Hispanic or Latino", "White", "Prefer not to say")
  if (pred === "demographics" && /ethnicity/i.test(label)) {
    return profile?.demographics?.ethnicity ?? null;
  }

  // Gender Identity (already working; keep)
  if (pred === "demographics" && /gender identity|gender\b/i.test(label)) {
    return profile?.demographics?.genderIdentity ?? profile?.personal?.gender ?? null;
  }

  // Veteran Status (string or yes/no phrasing)
  if (pred === "demographics" && /veteran/i.test(label)) {
    return profile?.demographics?.veteranStatus ?? null; // e.g., "I am not a veteran"
  }

  // Referral — ALWAYS skip (user chooses)
  if (pred === "referral_source") {
    return null;
  }
  return null;
}

async function fillDetected(items, profile, resumeId) {
  const report = [];
  for (const row of items || []) {
    const el = row.selector ? document.querySelector(row.selector) : null;
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
    const ok = setInputValue(el, String(value));
    report.push({ label, prediction: pred, confidence: row.confidence, status: ok?"filled":"skipped", reason: ok?"":"set value failed", valuePreview: String(value) });
  }
  return report;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.action === "EXT_FILL_FIELDS") {
        const report = await fillDetected(msg.items || [], msg.profile || {}, msg.resumeId || null);
        sendResponse({ ok:true, report });
        return;
      }      
    } catch (e) {
      sendResponse({ ok:false, error:String(e) });
    }
  })();
  return true;
});

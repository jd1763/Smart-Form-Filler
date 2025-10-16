/***********************
 * POPUP — MATCHER + FILLER (Week-5 kept) + Week-6 multi-resume + UI polish
 ***********************/
const DEBUG = true;
const log = (...a) => DEBUG && console.log("[popup]", ...a);
const err = (...a) => console.error("[popup]", ...a);

// ========= DIAGNOSTICS PANEL =========
let DIAG; // root <div> we render into

function ensureDiagPanel() {
  if (DIAG && document.body.contains(DIAG)) return DIAG;
  DIAG = document.createElement("div");
  DIAG.id = "sffDiag";
  DIAG.style.cssText = `
    margin-top: 8px; padding: 8px; border: 1px solid #ddd; border-radius: 8px;
    max-height: 220px; overflow: auto; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    background: #fafafa;
  `;
  const h = document.createElement("div");
  h.textContent = "Diagnostics";
  h.style.cssText = "font-weight:600;margin-bottom:6px;";
  DIAG.appendChild(h);
  const pre = document.createElement("pre");
  pre.id = "sffDiagPre";
  pre.style.cssText = "white-space:pre-wrap;margin:0;";
  DIAG.appendChild(pre);
  const host = document.getElementById("resultsBox") || document.body;
  host.appendChild(DIAG);
  return DIAG;
}

function initTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = {
    main:  document.getElementById("tab-main"),
    debug: document.getElementById("tab-debug"),
  };
  const show = (key) => {
    panels.main.style.display  = key === "main"  ? "" : "none";
    panels.debug.style.display = key === "debug" ? "" : "none";
  };
  tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      tabs.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      show(btn.dataset.tab);
    });
  });
  // default
  show("main");
}

function showDiag(obj){
  ensureDiagPanel();
  const pre = document.getElementById("sffDiagPre");
  try {
    pre.textContent = JSON.stringify(obj, null, 2);
  } catch {
    pre.textContent = String(obj);
  }
}

function diagError(step, message, extra={}) {
  const e = new Error(`[${step}] ${message}`);
  e.step = step;
  e.extra = extra;
  log("DIAG ERROR", step, message, extra);
  throw e;
}

/* ===================== MATCHER CONFIG ===================== */
const MATCH_API_BASE = "http://127.0.0.1:5000"; // api.py host/port
const RESUME_API_BASE = MATCH_API_BASE; 
const MATCH_ROUTE = "/match";

// Tight whitelist so “missing skills” stays clean
const SKILL_WORDS = new Set([
  "python","java","c++","c","r","sql","mysql","postgres","mongodb","redis",
  "aws","gcp","azure","docker","kubernetes","k8s","terraform","linux",
  "spark","hadoop","airflow","pandas","numpy","scikit-learn","sklearn",
  "react","node","javascript","typescript","graphql","rest","grpc",
  "kafka","snowflake","databricks","tableau","git","ci","cd","tomcat",
  "android","gradle","junit","eclipse","intellij","vscode","jsp","html","css",
  "unit_testing","unittest","pytest","data_modeling",
  "s3","iam","eks","ecs","cloud","unix","bash","shell","unit testing", "unit test"
]);

// === skill aliases (keep minimal) ===
const SFF_SKILL_ALIASES = Object.assign(Object.create(null), {
  "github": "git",
  "git": "git",
});

// small normalizer used only here
function sffNormSkillToken(s) {
  const t = String(s || "").toLowerCase().trim()
    .replace(/(^[^a-z0-9]+|[^a-z0-9]+$)/g, ""); // trim punctuation at ends
  return SFF_SKILL_ALIASES[t] || t;
}

// make sure 'git' is in the canonical vocab
if (typeof SKILL_WORDS === "undefined") {
  window.SKILL_WORDS = new Set(["git"]);
} else {
  SKILL_WORDS.add("git");
}

function sffCollectSkills(text) {
  const toks = (String(text || "").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || [])
    .map(sffNormSkillToken);

  const out = new Set();
  for (const tk of toks) {
    if (tk && SKILL_WORDS.has(tk)) out.add(tk);
  }
  return out; // Set of canonical skill tokens present in text
}

// ================= BUCKETS / RENDERING =================
(async function BucketUI() {
  // --- DOM refs
  const detectedToggle   = document.getElementById("detectedToggle");
  const detectedFieldsEl = document.getElementById("detectedFields");
  const detectedListEl   = document.getElementById("detectedList");
  const detectedHintEl   = document.getElementById("detectedHint");

  const filledToggle     = document.getElementById("filledToggle");
  const filledFieldsEl   = document.getElementById("filledFields");

  const notFilledToggle  = document.getElementById("notFilledToggle");
  const notFilledFieldsEl= document.getElementById("notFilledFields");

  const statusEl         = document.getElementById("status");
  const btnFill          = document.getElementById("fillForm");
  const btnTryAgain      = document.getElementById("tryAgain");

  // ---------- header helpers (no auto-open; just reflect current state) ----------
  function setHeaderWithCount(hdrEl, panelEl, base, count) {
    hdrEl.dataset.base  = base;
    hdrEl.dataset.count = String(count);
    const open = panelEl.style.display !== "none";
    hdrEl.textContent = `${open ? "▼" : "▶"} ${base}${Number.isFinite(count) ? ` (${count})` : ""}`;
  }
  function refreshAllCounts({ detectedCount, filledCount, nonFilledCount }) {
    setHeaderWithCount(detectedToggle,  detectedFieldsEl,  "Detected Fields",    detectedCount);
    setHeaderWithCount(filledToggle,    filledFieldsEl,    "Filled Fields",      filledCount);
    setHeaderWithCount(notFilledToggle, notFilledFieldsEl, "Non-Filled Fields",  nonFilledCount);
  }

// ---------- tiny render helpers ----------
const $item = (label, meta) => {
  const row = document.createElement("div");
  row.className = "row";               // same row style as the dropdowns

  const name = document.createElement("span");
  name.className = "field-name";       // bullet + ellipsis handled in CSS
  const text = label || "(unknown)";
  name.textContent = text;
  name.title = text;
  row.appendChild(name);

  if (meta) {
    const m = document.createElement("span");
    m.className = "field-meta";        // right-side compact meta (used for Non-Filled)
    m.textContent = meta;
    row.appendChild(m);
  }
  return row;
};

function renderSimpleList(container, items, metaForItem = () => "") {
  container.innerHTML = "";
  (items || []).forEach(it =>
    container.appendChild($item(it.label || it.key || "(unknown)", metaForItem(it)))
  );
  if (!items || !items.length) container.appendChild($item("— none —"));
}

// Accept both shapes, map to {key?,label,confidence}
function normalizeDetectedShape(resp) {
  const arr = Array.isArray(resp?.detected) ? resp.detected : [];
  return arr.map(x => ({
    key:   x.key || x.prediction || x.name || null,
    label: x.label || x.labelText || x.placeholder || x.name || x.id || "(Unknown)",
    confidence: "N/A"  // not shown in Detected; only for Non-Filled meta
  }));
}

  // ---------- tab + messaging helpers ----------
  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
    return tab;
  }
  async function ask(tabId, payload) {
    try { return await chrome.tabs.sendMessage(tabId, payload); }
    catch { return null; }
  }

// --------- detection + seeding ----------
async function detectAndSeed() {
  const tab = await getActiveTab();
  if (!tab?.id) return { detected: [], pageKey: "" };

  detectedHintEl.textContent = "Scanning page for fields…";

  // Ensure content scripts are injected BEFORE we ask the page (fixes first-open issue)
  // Uses helpers already defined elsewhere in this file.
  if (!await ensureContent(tab.id)) {
    detectedHintEl.textContent = "Couldn’t reach the page. Try again on a form.";
    renderSimpleList(detectedListEl, []);
    refreshAllCounts({ detectedCount: 0, filledCount: 0, nonFilledCount: 0 });
    return { detected: [], pageKey: "" };
  }

  const frameId = await getBestFrame(tab.id);       // pick frame with most inputs
  let resp = await sendToFrame(tab.id, frameId, { action: "EXT_DETECT_FIELDS" });
  if (!resp || !resp.ok) {
    resp = await sendToFrame(tab.id, frameId, { action: "EXT_DETECT_FIELDS_SIMPLE" });
  }

  const detected = normalizeDetectedShape(resp || { detected: [] });

  // Detected = label-only cards (no chip/meter)
  renderDetected(detectedListEl, detected);

  // Filled = empty, but keep the same card style
  renderFieldList(filledFieldsEl, [], { title: "Filled", mode: "filled" });

  // Non-Filled = same card layout as Filled, with N/A confidence and 0% meter
  const nonFilledInit = detected.map(d => ({
    key: d.key || null,
    label: d.label,
    confidence: "N/A"
  }));
  renderFieldList(notFilledFieldsEl, nonFilledInit, { title: "Non-Filled", mode: "nonfilled" });
  forceNonFilledBadges(notFilledFieldsEl);
  
  // counts
  refreshAllCounts({
    detectedCount: detected.length,
    filledCount:   0,
    nonFilledCount: detected.length
  });

  detectedHintEl.textContent = `${detected.length} fields found`;

  return { detected};
}

// Ensure Non-Filled cards show the same layout as Filled:
// - red "Not filled" badge next to label
// - chip text "Confidence N/A"
// - meter at 0%
function ensureNotFilledBadges(container){
  if (!container) return;

  container.querySelectorAll('.field-item').forEach(card => {
    // 1) Badge next to label
    const labelEl = card.querySelector('.label');
    let badge = card.querySelector('.badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'badge badge-red';
      if (labelEl) labelEl.insertAdjacentElement('afterend', badge);
      else card.insertAdjacentElement('afterbegin', badge);
    }
    badge.textContent = 'Not filled';
    badge.classList.add('badge-red');

    // 2) Confidence chip text
    const chip = card.querySelector('.chip');
    if (chip) chip.textContent = 'Confidence N/A';

    // 3) Meter width → 0%
    const meterFill =
      card.querySelector('.meter > span') ||
      card.querySelector('.meter .bar') ||
      card.querySelector('.meter .fill');
    if (meterFill) meterFill.style.width = '0%';
  });
}

  function splitBucketsByReport(detected, report) {
    const filled = Array.isArray(report?.filled) ? report.filled.map(f => ({
      key: f.key || null,
      label: f.label || "(Unknown)",
      confidence: (f.confidence ?? "—"),
      value: f.value
    })) : [];
    const filledKeys = new Set(filled.map(f => f.key || f.label));
    const nonFilled = detected.filter(d => !filledKeys.has(d.key || d.label));
    return { filled, nonFilled };
  }

  function renderBuckets(detected, reportOrNull) {
    if (!reportOrNull) {
      renderFieldList(filledFieldsEl, [], { title: "Filled", mode: "filled" });
      const nonFilledInit = detected.map(d => ({ key: d.key || null, label: d.label, confidence: "N/A" }));
      renderFieldList(notFilledFieldsEl, nonFilledInit, { title: "Non-Filled", mode: "nonfilled" });
      forceNonFilledBadges(notFilledFieldsEl);
      refreshAllCounts({ detectedCount: detected.length, filledCount: 0, nonFilledCount: detected.length });
      return;
    }
  
    // Merge confidences we may have for nonfilled
    const confMap = new Map();
    if (Array.isArray(reportOrNull.notFilled)) {
      for (const nf of reportOrNull.notFilled) {
        const k = nf?.key || nf?.label;
        if (k != null && "confidence" in nf) confMap.set(k, nf.confidence);
      }
    }
  
    const rawFilled = Array.isArray(reportOrNull.filled) ? reportOrNull.filled.map(f => ({
      key: f.key || null,
      label: f.label || "(Unknown)",
      confidence: (parseConfidence(f.confidence) ?? "N/A"), // preserve numeric if present
      value: f.value,
      inputType: f.inputType,
      type: f.type,
      kind: f.kind,
      status: f.status,
      changed: f.changed,
      didSet: f.didSet
    })) : [];    
  
    const filled = rawFilled.filter(isTrulyFilled);
    const movedBack = rawFilled.filter(f => !isTrulyFilled(f)).map(f => ({
      key: f.key || null,
      label: f.label || "(Unknown)",
      confidence: (parseConfidence(f.confidence) ?? "N/A")
    }));    
  
    const filledKeys = new Set(filled.map(f => f.key || f.label));
    const nonFilled = detected
      .filter(d => !filledKeys.has(d.key || d.label))
      .map(d => {
        const c = confMap.get(d.key || d.label);
        return {
          key: d.key || null,
          label: d.label,
          confidence: (parseConfidence(c) ?? "N/A")
        };
      })      
      .concat(movedBack);
  
    renderFieldList(filledFieldsEl, filled,     { title: "Filled",     mode: "filled" });
    renderFieldList(notFilledFieldsEl, nonFilled, { title: "Non-Filled", mode: "nonfilled" });
    forceNonFilledBadges(notFilledFieldsEl);
    
    refreshAllCounts({    
      detectedCount: detected.length,
      filledCount:   filled.length,
      nonFilledCount: nonFilled.length
    });
  }  

  // ---------- toggles (click only; no persist, no auto-open) ----------
  function wireToggles() {
    const makeToggle = (hdrEl, panelEl) => {
      hdrEl.addEventListener("click", () => {
        const open = panelEl.style.display !== "none";
        panelEl.style.display = open ? "none" : "block";
        const base  = hdrEl.dataset.base  || hdrEl.textContent.replace(/^[▶▼]\s*/, "");
        const count = hdrEl.dataset.count || "";
        hdrEl.textContent = `${open ? "▶" : "▼"} ${base}${count ? ` (${count})` : ""}`;
      });
    };
    makeToggle(detectedToggle,  detectedFieldsEl);
    makeToggle(filledToggle,    filledFieldsEl);
    makeToggle(notFilledToggle, notFilledFieldsEl);
  }
  wireToggles();

  // ---------- INIT (fresh every open; no cache restore) ----------
  const { detected } = await detectAndSeed();
  statusEl.textContent = "Ready…";
  btnTryAgain.style.display = "none";

  // ---------- fill button ----------
  btnFill?.addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    statusEl.textContent = "Filling…";
  
    const r = await ask(tab.id, { action: "fillFormSmart" });
  
    if (!r?.ok) {
      statusEl.textContent = r?.error ? `❌ Fill failed — ${r.error}` : "❌ Fill failed.";
      return;
    }
  
    // 🚫 No form found → do nothing else
    const inputs = Number(r.inputs || 0);
    if (!inputs) {
      statusEl.textContent = "❌ No form detected on this page.";
      btnTryAgain.style.display = "none";
      return;
    }
  
    // Proceed as usual
    renderBuckets(detected, r);
    const summary = `🪄 Form already filled`;
  
    btnTryAgain.style.display = "inline-block";
    statusEl.textContent = summary + " — Run again?";
  });  

  btnTryAgain?.addEventListener("click", async () => { btnFill?.click(); });
})();


/* ===================== UI HANDLES (Matcher) ===================== */
const elsM = { arc:null, scoreNum:null, hint:null, status:null };

function gaugeColor(pct){
  // red → orange → yellow → yellowish green → green
  if (pct >= 85) return "#16a34a"; // green
  if (pct >= 70) return "#84cc16"; // yellowish green
  if (pct >= 55) return "#eab308"; // yellow
  if (pct >= 40) return "#f97316"; // orange
  return "#ef4444";                // red
}

function setArc(percent){
  const p = Math.max(0, Math.min(100, Math.round(percent||0)));
  if (elsM.arc) {
    elsM.arc.setAttribute("stroke-dasharray", `${p},100`);
    elsM.arc.setAttribute("stroke", gaugeColor(p));
  }
  if (elsM.scoreNum) elsM.scoreNum.textContent = `${p}%`;
}

/* ===================== CHIP RENDERING (side-by-side + fallback) ===================== */
function chip(txt, bad=false){
  const s=document.createElement("span");
  s.className=`chip ${bad?"bad":""}`;
  s.textContent=txt;
  return s;
}
function clear(el){ if(el) el.innerHTML=""; }
function renderChipList(container, arr, bad=false){
  if (!container) return;
  clear(container);
  (arr.length ? arr : ["None"]).forEach(s => container.appendChild(chip(s, bad)));
}
function renderBucketsIntoUI(buckets){
  // New side-by-side containers
  const elMatchedReq  = document.getElementById("matchedReq");
  const elMatchedPref = document.getElementById("matchedPref");
  const elMissingReq  = document.getElementById("missingReq");
  const elMissingPref = document.getElementById("missingPref");
  const haveNewBoxes = elMatchedReq && elMatchedPref && elMissingReq && elMissingPref;

  if (haveNewBoxes) {
    renderChipList(elMatchedReq,  buckets.matchedReq,  false);
    renderChipList(elMatchedPref, buckets.matchedPref, false);
    renderChipList(elMissingReq,  buckets.missReq,     true);
    renderChipList(elMissingPref, buckets.missPref,    true);
    return;
  }

  // ---- Fallback to old single-column containers (Week-5 HTML) ----
  const elsMatched = document.getElementById("matchedSkills");
  const elsMissing = document.getElementById("missingSkills");

  if (elsMatched) {
    clear(elsMatched);
    const hReq = document.createElement("div"); hReq.className="subhead"; hReq.textContent="Required";
    const boxReq = document.createElement("div"); boxReq.className="chips";
    buckets.matchedReq.forEach(s=>boxReq.appendChild(chip(s)));
    const hPref = document.createElement("div"); hPref.className="subhead"; hPref.textContent="Preferred";
    const boxPref = document.createElement("div"); boxPref.className="chips";
    buckets.matchedPref.forEach(s=>boxPref.appendChild(chip(s)));
    elsMatched.append(hReq, boxReq, hPref, boxPref);
  }

  if (elsMissing) {
    clear(elsMissing);
    const hReq = document.createElement("div"); hReq.className="subhead"; hReq.textContent="Required";
    const boxReq = document.createElement("div"); boxReq.className="chips";
    (buckets.missReq.length? buckets.missReq:["None"]).forEach(s=>boxReq.appendChild(chip(s,true)));
    const hPref = document.createElement("div"); hPref.className="subhead"; hPref.textContent="Preferred";
    const boxPref = document.createElement("div"); boxPref.className="chips";
    (buckets.missPref.length? buckets.missPref:["None"]).forEach(s=>boxPref.appendChild(chip(s,true)));
    elsMissing.append(hReq, boxReq, hPref, boxPref);
  }
}

/* ===================== TEXT / SKILLS HELPERS ===================== */
function tokenize(text){
  return (text||"").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g)||[];
}

/* ===== Extract Required / Preferred from JD (sentence-scoped preferred) =====
   - Required = all skills mentioned anywhere in the JD.
   - Preferred = ONLY the skills in sentences that contain a preferred keyword
                 (or the explicit "Preferred:" span). We DO NOT take the whole paragraph.
   - Final: required = allSkills - preferred.
*/
function extractImportance(jdText) {
  const jd = String(jdText || "");

  // Canonical skill collector
  function sffCollectSkills(text) {
    const T = String(text || "").toLowerCase();
  
    // Token hits → canonical
    const toks = (T.match(/[a-z][a-z0-9+./-]{1,}/g) || []).map(sffNormSkillToken);
    const out = new Set();
    for (const tk of toks) if (tk && SKILL_WORDS.has(tk)) out.add(tk);
  
    // Phrase hits → add canonical tokens
    if (/\bunit[\s-]?testing\b/.test(T)) out.add("unit_testing");
    if (/\bdata[\s-]?model(ing|s)\b/.test(T)) out.add("data_modeling");
  
    // Common AWS subservices explicitly
    if (/\bamazon s3\b|\bs3\b/.test(T)) out.add("s3");
    if (/\biam\b/.test(T)) out.add("iam");
    if (/\beks\b/.test(T)) out.add("eks");
    if (/\becs\b/.test(T)) out.add("ecs");
  
    return out;
  }  
  
  // 1) All skills anywhere → base Required candidates
  const allSkills = sffCollectSkills(jd);

  // 2) Preferred from explicit inline "Preferred:" span
  const preferred = new Set();
  const lower = jd.toLowerCase();
  const inlinePrefMatch = lower.match(/\b(preferred|nice[-\s]?to[-\s]?have|bonus|plus)\s*:\s*([^\n\.]+)/i);
  if (inlinePrefMatch) {
    const originalTail = jd.slice(inlinePrefMatch.index + inlinePrefMatch[0].length - inlinePrefMatch[2].length);
    // originalTail should be the same text as capture group 2 in original casing
    for (const k of sffCollectSkills(inlinePrefMatch[2])) preferred.add(k);
  }

  // 3) Also capture sentence-scoped preferred (no colon form, e.g., "Nice to have experience with ...")
  const prefRx = /\b(preferred|nice[-\s]?to[-\s]?have|bonus|plus)\b/i;
  // Split into sentences conservatively (., ?, !, or newlines)
  const sentences = jd.split(/(?<=[.!?])\s+|\n+/);
  for (const sent of sentences) {
    if (prefRx.test(sent)) {
      for (const k of sffCollectSkills(sent)) preferred.add(k);
    }
  }

  // 4) Finalize buckets: Required = All - Preferred
  const required = new Set([...allSkills].filter(k => !preferred.has(k)));

  return { requiredKeys: required, preferredKeys: preferred };
}

/* ===================== RESPONSE NORMALIZATION & BUCKETS ===================== */
function normalizeMatchResponse(res, jdText){
  // score 0..1 or 0..100 → 0..100
  let s = Number(res?.similarity_score ?? res?.score ?? 0);
  const scorePct = Math.max(0, Math.min(100, Math.round(s > 1 ? s : (s*100))));

  // flatten missing: ["aws", ...] or [["aws",0.31], ...] → lower → canonical
  const rawMissing = Array.isArray(res?.missing_keywords ?? res?.missing_skills)
    ? (res.missing_keywords ?? res.missing_skills)
    : [];
  const flat = rawMissing.map(m => Array.isArray(m) ? String(m[0]) : String(m));

  // JD tokens → canonical set (aliases applied)
  const jdCanonSet = new Set(
    ((jdText||"").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || [])
      .map(sffNormSkillToken)
      .filter(t => t && SKILL_WORDS.has(t))
  );

  // Keep only canonical skills that are in whitelist AND actually mentioned (canon) in the JD
  const missingCanon = flat
    .map(x => sffNormSkillToken(String(x).toLowerCase().trim()))
    .filter(t => t && SKILL_WORDS.has(t) && jdCanonSet.has(t));

  const missingClean = Array.from(new Set(missingCanon));
  return { scorePct, missingClean };
}

function extractImportanceFromSections(jdText) {
  const jd = String(jdText || "");
  const lines = jd.split(/\r?\n/);

  // Headings + synonyms
  const REQ_HDRS  = [
    /basic qualifications/i, /minimum qualifications/i,
    /requirements?\b/i, /required qualifications/i,
    /must[-\s]?have/i, /required skills?\b/i, /^required\b/i
  ];
  const PREF_HDRS = [
    /preferred qualifications/i, /nice[-\s]?to[-\s]?have/i,
    /\bbonus\b/i, /\bplus\b/i, /preferred skills?\b/i, /^preferred\b/i
  ];

  let mode = null; // "req" | "pref" | null
  const reqBuf = [];
  const prefBuf = [];

  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line) continue;

    // Handle inline labels on the same line, e.g.
    // "Required skills: Python, Java. Preferred: AWS, Docker."
    if (/(required[^:]*:)|(preferred[^:]*:)/i.test(line)) {
      const reqMatch  = line.match(/required[^:]*:\s*([^.;]+)/i);
      const prefMatch = line.match(/preferred[^:]*:\s*([^.;]+)/i);
      if (reqMatch)  reqBuf.push(reqMatch[1]);
      if (prefMatch) prefBuf.push(prefMatch[1]);
      continue;
    }

    // Switch mode when we hit a heading
    if (REQ_HDRS.some(rx => rx.test(line)))  { mode = "req";  continue; }
    if (PREF_HDRS.some(rx => rx.test(line))) { mode = "pref"; continue; }

    // New generic heading → stop capturing
    if (/^\s*[A-Z][A-Za-z0-9\s]{0,40}:?\s*$/.test(line)
        && !REQ_HDRS.concat(PREF_HDRS).some(rx => rx.test(line))) {
      mode = null;
      continue;
    }

    if (mode === "req")  reqBuf.push(line);
    if (mode === "pref") prefBuf.push(line);
  }

  const reqText  = reqBuf.join("\n");
  const prefText = prefBuf.join("\n");

  const requiredKeys  = sffCollectSkills(reqText);
  const preferredKeys = sffCollectSkills(prefText);

  return { requiredKeys, preferredKeys, found: (reqText.length + prefText.length) > 0 };
}

function computeBucketsFromJDAndMissing(jdText, missingClean){
  // Canonical JD skill set
  const jdCanonSet = new Set(
    ((jdText||"").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || [])
      .map(sffNormSkillToken)
      .filter(t => t && SKILL_WORDS.has(t))
  );

  // Prefer strict section-based parsing; fallback to sentence-scoped if not found
  let { requiredKeys, preferredKeys, found } = extractImportanceFromSections(jdText || "");
  if (!found) {
    ({ requiredKeys, preferredKeys } = extractImportance(jdText || ""));
  }

  const reqCanon = new Set(
    Array.from(requiredKeys || [])
      .map(k => sffNormSkillToken(String(k)))
      .filter(t => t && SKILL_WORDS.has(t))
  );
  const prefCanon = new Set(
    Array.from(preferredKeys || [])
      .map(k => sffNormSkillToken(String(k)))
      .filter(t => t && SKILL_WORDS.has(t))
  );

  // Intersect with JD canon set so only skills that actually appear in the JD remain
  const required = new Set([...reqCanon].filter(t => jdCanonSet.has(t)));
  const preferred = new Set([...prefCanon].filter(t => jdCanonSet.has(t) && !required.has(t)));

  // Canonical missing set (so "github" vs "git" can match)
  const missSet = new Set((missingClean||[]).map(x => sffNormSkillToken(String(x))));

  // Matched / Missing per bucket
  const matchedReq  = [...required].filter(k => !missSet.has(k));
  const missReq     = [...required].filter(k =>  missSet.has(k));
  const matchedPref = [...preferred].filter(k => !missSet.has(k));
  const missPref    = [...preferred].filter(k =>  missSet.has(k));

  return { matchedReq, matchedPref, missReq, missPref };
}

// ================= DISPLAY SCORE (uses the same buckets the UI shows) =================
function computeDisplayScore({ jdText, missing }) {
  const buckets = computeBucketsFromJDAndMissing(jdText || "", (missing || []));

  const reqMatched  = (buckets.matchedReq  || []).length;
  const reqMissing  = (buckets.missReq     || []).length;
  const prefMatched = (buckets.matchedPref || []).length;
  const prefMissing = (buckets.missPref    || []).length;

  const reqTotal  = reqMatched + reqMissing;
  const prefTotal = prefMatched + prefMissing;

  if (reqTotal <= 0) return 0; // nothing to score

  const reqFrac = reqMatched / reqTotal;

  // If no preferred in JD → full 100 goes to requirements
  if (prefTotal === 0) {
    return Math.round(100 * reqFrac);
  }

  const prefFrac = prefMatched / prefTotal;

  // 90/10 split
  const score = (90 * reqFrac) + (10 * prefFrac);
  return Math.round(score);
}

/* ===================== API CALLS ===================== */
async function callMethod(method, job_text, resume_id) {
  const r = await fetch(MATCH_API_BASE + MATCH_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resume_id, job_description: job_text, method })
  });
  if (!r.ok) throw new Error(`match ${method} ${r.status}`);
  return r.json();
}
async function callBoth(job_text, resume_id){
  const [t, e] = await Promise.allSettled([
    callMethod("tfidf", job_text, resume_id),
    callMethod("embedding", job_text, resume_id)
  ]);
  const resT = t.status==="fulfilled" ? t.value : null;
  const resE = e.status==="fulfilled" ? e.value : null;
  if (!resT && !resE) throw new Error("Both matcher methods failed");
  return { tfidf: resT, embedding: resE };
}

/* ===================== CONTENT HELPERS ===================== */
function showNoResumesCard() {
  const card = document.getElementById("noResumesCard");
  const matchCard = document.getElementById("matchCard");
  const suggestor = document.getElementById("resumeSuggestorCard");
  const fillBtn = document.getElementById("fillForm");
  if (card) card.style.display = "";
  if (matchCard) matchCard.style.display = "none";
  if (suggestor) suggestor.style.display = "none";
  if (fillBtn) { fillBtn.disabled = true; fillBtn.title = "Upload a resume first"; }
}

function hideNoResumesCard() {
  const card = document.getElementById("noResumesCard");
  const fillBtn = document.getElementById("fillForm");
  if (card) card.style.display = "none";
  if (fillBtn) { fillBtn.disabled = false; fillBtn.title = ""; }
}

async function getActiveTab(){
  return new Promise(res=>{
    chrome.tabs.query({active:true,currentWindow:true},tabs=>res(tabs?.[0]||null));
  });
}
const isSupportedUrl = (u)=> /^https?:\/\//i.test(u)||/^file:\/\//i.test(u);
async function pingAny(tabId){
  return new Promise(res=>{
    chrome.tabs.sendMessage(tabId,{action:"ping"},pong=>{
      if(!chrome.runtime.lastError && pong && pong.ok) return res(true);
      res(false);
    });
  });
}
async function ensureContent(tabId){
  if (await pingAny(tabId)) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["helpers.js", "content.js"]  // ← helpers first, then content
    });
  } catch (e) {
    err("inject helpers/content:", e.message || e);
    return false;
  }
  return await pingAny(tabId);
}

async function getBestFrame(tabId){
  let frames=[];
  try{ frames = await chrome.webNavigation.getAllFrames({tabId}); }
  catch{ frames=[{frameId:0}]; }
  const scores = await Promise.all(frames.map(f=>new Promise(resolve=>{
    chrome.tabs.sendMessage(tabId,{action:"probe"},{frameId:f.frameId},resp=>{
      if(chrome.runtime.lastError||!resp||resp.ok!==true) return resolve({frameId:f.frameId,inputs:0});
      resolve({frameId:f.frameId,inputs:Number(resp.inputs)||0});
    });
  })));
  const best = scores.reduce((a,s)=> s.inputs>(a?.inputs||0)?s:a, null);
  return (best && best.inputs>0)? best.frameId : 0;
}
function sendToFrame(tabId, frameId, msg){
  return new Promise(resolve=>{
    chrome.tabs.sendMessage(tabId,msg,{frameId},resp=>{
      if(chrome.runtime.lastError) return resolve(null);
      resolve(resp);
    });
  });
}
async function getJobDescription(){
  const tab = await getActiveTab();
  if(!tab || !isSupportedUrl(tab.url||"")) return { jd:"", note:"no active http(s)/file tab" };
  if(!await ensureContent(tab.id)) return { jd:"", note:"content not reachable" };
  const frameId = await getBestFrame(tab.id);
  const res = await sendToFrame(tab.id, frameId, { action:"EXT_GET_JOB_DESC" });
  if(res && res.ok && res.jd) return { jd: res.jd, note: "detected from page" };
  return { jd:"", note:"no JD found" };
}

/* ===================== RESUME STORAGE ===================== */
async function loadAllResumesFromBackend(){
  try{
    const r = await fetch(`${RESUME_API_BASE}/resumes`);
    const data = await r.json();
    // Return minimal objects used by the UI
    return (data.items||[]).map(it => ({
      id: it.id,
      name: it.original_name,
      // we don’t need text; /match will read by id
      createdAt: it.created_at
    }));
  }catch(e){
    console.error("[popup] backend /resumes error:", e);
    return [];
  }
}
async function getLastResumeId(){
  return (await chrome.storage.local.get("lastResumeId")).lastResumeId || null;
}
async function setLastResumeId(id){
  try{ await chrome.storage.local.set({ lastResumeId:id }); }catch{}
}
function fmtDateTime(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "2-digit"
    });
  } catch {
    return "unknown date";
  }
}

// helpers to set month/year pairs
function setMonthYearPair(label, monthStr, yearStr, root=document) {
  const monthEl = [...root.querySelectorAll('select, input')].find(e => /start\s*month/i.test(getLabelText(e)));
  const yearEl  = [...root.querySelectorAll('select, input')].find(e => /start\s*year/i.test(getLabelText(e)));
  if (monthEl && monthStr) setSelectValueSmart(monthEl, monthStr);      // accepts 2, 02, Feb, February
  if (yearEl  && yearStr)  setSelectValueSmart(yearEl,  yearStr);
}
function setEndMonthYearPair(monthStr, yearStr, root=document) {
  const monthEl = [...root.querySelectorAll('select, input')].find(e => /end\s*month/i.test(getLabelText(e)));
  const yearEl  = [...root.querySelectorAll('select, input')].find(e => /end\s*year/i.test(getLabelText(e)));
  if (monthEl && monthStr) setSelectValueSmart(monthEl, monthStr);
  if (yearEl  && yearStr)  setSelectValueSmart(yearEl,  yearStr);
}


/* ============= INLINE RESUME PICKER IN FILLER CARD (always visible) ============= */
function ensureInlineResumePicker(resumes){
  const controls = document.getElementById("controls");
  if (!controls) return;
  let host = document.getElementById("resumeInlineHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "resumeInlineHost";
    host.style.display = "flex";
    host.style.flexDirection = "column";
    host.style.gap = "6px";
    host.style.width = "100%";
    host.style.margin = "4px 0 2px 0";
    const title = document.createElement("div");
    title.textContent = "Resume";
    title.style.fontSize = "12px";
    title.style.color = "#6b7280";
    const sel = document.createElement("select");
    sel.id = "resumeInline";
    sel.style.width = "100%";
    sel.style.padding = "6px";
    sel.style.border = "1px solid #e5e7eb";
    sel.style.borderRadius = "6px";
    const hint = document.createElement("div");
    hint.id = "resumeInlineHint";
    hint.className = "muted";
    hint.textContent = "Defaults to your last choice.";
    controls.parentNode.insertBefore(host, controls);
    host.appendChild(title);
    host.appendChild(sel);
    host.appendChild(hint);
  }
  const sel = document.getElementById("resumeInline");
  if (!sel) return;
  sel.innerHTML = "";
  resumes.forEach(r=>{
    const o = document.createElement("option");
    o.value = r.id || r.name;
    o.textContent = r.name || r.id || "(untitled)";
    sel.appendChild(o);
  });
  (async () => {
    const lastId = await getLastResumeId();
    if (lastId && [...sel.options].some(o => o.value === lastId)) {
      sel.value = lastId;
    } else {
      sel.value = sel.options[0]?.value || "";
      await setLastResumeId(sel.value);
    }
  })();
  sel.onchange = () => { setLastResumeId(sel.value); };
}

/* ===================== MATCHER: AUTO RUN ON OPEN (Week-6 multi-resume) ===================== */
async function autoMatch(){
  // Hook UI
  elsM.arc = document.getElementById("arc");
  elsM.scoreNum = document.getElementById("scoreNum");
  // FIX: your popup.html uses id="jdHint2"
  elsM.hint = document.getElementById("jdHint2"); 
  elsM.status = document.getElementById("matchStatus");
  const matchCard = document.getElementById("matchCard");
  const hideMatch = () => { if(matchCard) matchCard.style.display = "none"; };
  const showMatch = () => { if(matchCard) matchCard.style.display = ""; };

  // Default state
  setArc(0);
  if (elsM.hint) elsM.hint.textContent = "detecting…";
  if (elsM.status) elsM.status.textContent = "";

  // Ensure resumes + inline picker (always visible)
  const resumes = await loadAllResumesFromBackend();
  if (!resumes.length){
    showNoResumesCard();
    // keep inline picker empty (if you show it at all)
    ensureInlineResumePicker([]);
    return;
  }
  hideNoResumesCard();
  ensureInlineResumePicker(resumes);

  // Read JD
  const { jd, note } = await getJobDescription();
  const jdTokens = Array.from(new Set((jd || "").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || []));
  const jdKeys = jdTokens.filter(w => SKILL_WORDS.has(w));
  const hasRealJD = (jd && jd.trim().length >= 180) && (jdKeys.length >= 2);

  if (!hasRealJD) {
    hideMatch();
    // also hide resume suggestor
    const suggestor = document.getElementById("resumeSuggestorCard");
    if (suggestor) suggestor.style.display = "none";
    return;
  }

  showMatch();
  if (elsM.hint) elsM.hint.textContent = note || "detected from page";

  try {
    // For each resume → run both methods → normalize → compute display score → choose best
    let best = null;
    for (const r of resumes) {
      // IMPORTANT: pass resume_id (not text)
      const both = await callBoth(jd, r.id);
      const nT = both.tfidf ? normalizeMatchResponse(both.tfidf, jd) : null;
      const nE = both.embedding ? normalizeMatchResponse(both.embedding, jd) : null;

      const have = [nT?.scorePct, nE?.scorePct].filter(v => typeof v === "number");
      const apiBase = have.length ? Math.round(have.reduce((a,b)=>a+b,0)/have.length) : 0; // 0..100
      const missingUnion = Array.from(new Set([...(nT?.missingClean||[]), ...(nE?.missingClean||[])]));

      const dispScore = computeDisplayScore({
        apiBasePct: apiBase,
        jdText: jd,
        missing: missingUnion
      });

      if (!best || dispScore > best.score) {
        best = { resume: r, score: dispScore, missing: missingUnion, apiBase };
      }
    }

    if (!best) { hideMatch(); return; }

    // Render best score & buckets
    setArc(best.score);
    renderBucketsIntoUI(computeBucketsFromJDAndMissing(jd, best.missing || []));

    // FIX: backend resumes have createdAt (ISO string); fall back if missing
    if (elsM.status) {
      const when = best.resume.createdAt ? Date.parse(best.resume.createdAt) : Date.now();
      elsM.status.textContent = `Using: ${best.resume.name || best.resume.id} · uploaded ${fmtDateTime(when)}`;
    }

    // Resume Suggestor card dropdown
    const dd = document.getElementById("resumeSelect");
    const chosenEl   = document.getElementById("chosenResume");
    const chosenSc   = document.getElementById("chosenScore");
    const selectedEl = document.getElementById("selectedResume");
    const selectedSc = document.getElementById("selectedScore");
    const resumeStatusEl = document.getElementById("resumeStatus");

    if (dd) {
      dd.innerHTML = "";
      resumes.forEach(r => {
        const o = document.createElement("option");
        o.value = r.id;                                   // FIX: value = id
        o.textContent = r.name || r.id || "(untitled)";
        dd.appendChild(o);
      });

      dd.value = best.resume.id;
      const _bestPct = Math.max(0, Math.min(100, Number(best.score) || 0));

      if (chosenEl)   chosenEl.textContent   = best.resume.name || best.resume.id || "(untitled)";
      if (chosenSc)   chosenSc.textContent   = `Match: ${_bestPct}%`;
      if (selectedEl) selectedEl.textContent = best.resume.name || best.resume.id || "(untitled)";
      if (selectedSc) selectedSc.textContent = `Match: ${_bestPct}%`;
      if (resumeStatusEl) resumeStatusEl.textContent = "Suggested resume selected. Change to compare.";

      dd.addEventListener("change", async () => {
        const sel = resumes.find(r => r.id === dd.value); // FIX: match by id
        if (!sel) return;
        try {
          if (resumeStatusEl) resumeStatusEl.textContent = "Scoring selected resume…";

          // IMPORTANT: pass resume_id for selection too
          const both = await callBoth(jd, sel.id);
          const nT = both.tfidf     ? normalizeMatchResponse(both.tfidf, jd)     : null;
          const nE = both.embedding ? normalizeMatchResponse(both.embedding, jd) : null;

          const have = [nT?.scorePct, nE?.scorePct].filter(v => typeof v === "number");
          const apiBase = have.length ? Math.round(have.reduce((a,b)=>a+b,0)/have.length) : 0;
          const missingUnion = Array.from(new Set([...(nT?.missingClean||[]), ...(nE?.missingClean||[])]));

          const dispScore = computeDisplayScore({ apiBasePct: apiBase, jdText: jd, missing: missingUnion });
          setArc(dispScore);

          // Re-render side-by-side buckets for the selection
          renderBucketsIntoUI(computeBucketsFromJDAndMissing(jd, missingUnion));

          if (elsM.status) {
            const when = sel.createdAt ? Date.parse(sel.createdAt) : Date.now();
            elsM.status.textContent = `Using: ${sel.name || sel.id} · uploaded ${fmtDateTime(when)}`;
          }
          if (selectedEl)  selectedEl.textContent  = sel.name || sel.id || "(untitled)";
          const _selPct = Math.max(0, Math.min(100, Number(dispScore) || 0));
          if (selectedSc)  selectedSc.textContent  = `Match: ${_selPct}%`;
          if (resumeStatusEl) resumeStatusEl.textContent = "Done.";
        } catch (e) {
          console.error("[popup] resumeSelect error:", e);
          if (resumeStatusEl) resumeStatusEl.textContent = "Error scoring selection.";
        }
      });
    }
  } catch (e) {
    console.error("[popup] matcher error:", e);
    if (elsM.hint) elsM.hint.textContent = "Matcher unavailable";
    if (elsM.status) elsM.status.textContent = "Could not reach /match. Check API port and host_permissions.";
    setArc(0);
  }
}

/* ===================== FILLER (Week-5 kept) ===================== */
const statusEl = document.getElementById("status");
const filledBox = document.getElementById("filledFields");
const notFilledBox = document.getElementById("notFilledFields");
const filledToggle = document.getElementById("filledToggle");
const notFilledToggle = document.getElementById("notFilledToggle");
const detectedToggle = document.getElementById("detectedToggle");
const detectedBox    = document.getElementById("detectedFields");
const detectedHint   = document.getElementById("detectedHint");
const detectedList   = document.getElementById("detectedList");

// Catalog shown if page has none
const LOCAL_CATALOG = [
  { key: "fullName", label: "Full Name" },
  { key: "firstName", label: "First Name" },
  { key: "lastName", label: "Last Name" },
  { key: "gender", label: "Gender" },
  { key: "dob", label: "Date of Birth" },
  { key: "phoneNumber", label: "Phone Number" },
  { key: "email", label: "Email" },
  { key: "street", label: "Street" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "Zip" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "github", label: "GitHub" },
  { key: "education", label: "Education" },
  { key: "work_auth", label: "Work Authorization" },
  { key: "document", label: "Resume/Document Upload" }
];

// Per-page state keys
function pageKeyFromUrl(u){ try{ const x=new URL(u); return `${x.origin}${x.pathname}`; } catch{ return u||"unknown"; } }
function keyify(s){ return `sff:${s.replace(/[^a-z0-9]+/gi,"_")}`; }
function stateKeysFor(url){ const base=keyify(pageKeyFromUrl(url)); return { lastKey:`${base}:last`, toggKey:`${base}:toggles` }; }
async function loadState(url){ const {lastKey,toggKey}=stateKeysFor(url); const all=await chrome.storage.local.get([lastKey,toggKey]); return { last: all[lastKey]||null, toggles: all[toggKey]||null }; }
async function saveLast(url,lastObj){ const {lastKey}=stateKeysFor(url); await chrome.storage.local.set({ [lastKey]: lastObj }); }
async function saveToggles(url,tog){ const {toggKey}=stateKeysFor(url); await chrome.storage.local.set({ [toggKey]: tog }); }

// UI utilities
const setStatus = (msg)=> (statusEl && (statusEl.textContent=msg));
function installToggle(headerEl, contentEl, initiallyOpen, onChange){
  const set=(open)=>{ contentEl.style.display=open?"block":"none";
    const title=headerEl.textContent.replace(/^[▶▼]\s*/,"");
    headerEl.textContent=(open?"▼ ":"▶ ")+title; onChange?.(open);
  };
  let open=initiallyOpen; set(open);
  headerEl.addEventListener("click",()=>{ open=!open; set(open); });
}

// Confidence helpers
const CONF_THRESH={ good:0.8, ok:0.5 };
function parseConfidence(c){
  // Returns a 0..1 number or null
  if (c == null || c === "N/A") return null;
  if (typeof c === "number") return c;                 // assume 0..1 or 0..100? handled below
  const s = String(c).trim();
  if (s.endsWith("%")) {                               // "14%" -> 0.14
    const n = parseFloat(s);
    return Number.isFinite(n) ? (n/100) : null;
  }
  const n = parseFloat(s);                              // "0.14" or "14"
  if (!Number.isFinite(n)) return null;
  return n > 1 ? (n/100) : n;                           // 14 -> 0.14 ; 0.14 -> 0.14
}
function fmtPct(x){
  const n = parseConfidence(x);
  return n == null ? null : Math.round(n * 100);        // -> integer percent or null
}
function confClass(conf){ if(conf==null||conf==="N/A") return "na"; if(conf>=CONF_THRESH.good) return "good"; if(conf>=CONF_THRESH.ok) return "ok"; return "low"; }

// --- helper: only count items that were actually set/checked as "filled"
function isTrulyFilled(f) {
  if (!f) return false;

  const hasExplicitFillFlag =
    f.status === "filled" || f.changed === true || f.didSet === true;

  const val = (f.value == null) ? "" : String(f.value).trim();
  const hasMeaningfulValue = !!val && val.toLowerCase() !== "unchecked";

  const t = (f.inputType || f.type || f.kind || "").toLowerCase();
  const isCheckboxLike = /checkbox|radio/.test(t) || f.kind === "checkbox";

  // checkboxes/radios must have been toggled; text-like fields can pass with a value
  return isCheckboxLike ? hasExplicitFillFlag : (hasExplicitFillFlag || hasMeaningfulValue);
}

// Render field cards (shared by Filled + Non-Filled)
function renderFieldList(container, items, { title = "", showSummary = true, mode } = {}) {
  container.innerHTML = "";

  // Summary row with average (numbers only)
  if (showSummary) {
    const n = items?.length || 0;
    let avg = null, count = 0;
    (items || []).forEach(it => {
      if (typeof it.confidence === "number") { avg = (avg || 0) + it.confidence; count++; }
    });
    if (count > 0) avg = Math.round((avg / count) * 100);
    const summary = document.createElement("div");
    summary.className = "list-summary";
    summary.innerHTML = `<div>${title}</div><div>${n} item${n!==1?"s":""}${avg!=null ? ` · avg ${avg}%` : ""}</div>`;
    container.appendChild(summary);
  }

  (items||[]).forEach((f)=>{
    const confNorm = parseConfidence(f.confidence);               // 0..1 or null
    const confPct  = fmtPct(f.confidence);                        // 0..100 int or null
    const cls      = confClass(confNorm != null ? confNorm : "N/A");
    const isFilled = confPct != null && confPct > 0;              // renderer-only; we will override the badge for Non-Filled

    const card=document.createElement("div"); card.className="field-item";
    const label=document.createElement("div"); label.className="label"; label.textContent=f.label;

    const badge=document.createElement("span"); 
    badge.className = "badge" + (isFilled ? "" : " na");
    badge.textContent = isFilled ? "Filled" : "N/A";               // for Non-Filled we’ll fix this text after render
    label.appendChild(badge);

    const chipEl=document.createElement("div"); 
    chipEl.className="chip"; 
    chipEl.textContent = confPct != null ? `Confidence ${confPct}%` : "Confidence N/A";

    const meter=document.createElement("div"); 
    meter.className="meter"; 
    const bar=document.createElement("span"); 
    bar.className=cls; 
    bar.style.width = (confPct != null ? confPct : 0) + "%";       // keep real % if present
    meter.appendChild(bar);

    card.appendChild(label); 
    card.appendChild(chipEl); 
    card.appendChild(meter);

    if(f.value){ 
      const val=document.createElement("div"); 
      val.className="value"; 
      val.textContent=String(f.value); 
      card.appendChild(val); 
    }
    container.appendChild(card);
  });
}

function forceNonFilledBadges(container){
  if (!container) return;
  container.querySelectorAll('.field-item .label .badge').forEach(badge=>{
    badge.textContent = 'Not filled';
    badge.classList.add('na');
    badge.classList.remove('good','ok','low');
  });
}

function renderDetected(container, arr){
  if (!container) return;
  if (!Array.isArray(arr) || arr.length === 0) {
    container.innerHTML = `<div class="muted">None.</div>`;
    return;
  }
  container.innerHTML = arr.map(it => {
    const label = (it.label || it.key || "(unknown)").trim();
    // Same card shell as others, but label only (no chip/meter for Detected)
    return `
      <div class="field-item">
        <div class="label">${label}</div>
      </div>
    `;
  }).join("");
}

async function preloadAndRestore(){
  const tab = await getActiveTab();
  if (!tab) { setStatus("❌ No active tab."); return; }

  // Keep inline resume picker available
  const resumes = await loadAllResumesFromBackend();
  ensureInlineResumePicker(resumes);

  // Always fresh on popup open (BucketUI handles detection + seeding)
  setStatus("Ready.");
  const tryBtn = document.getElementById("tryAgain");
  if (tryBtn) tryBtn.style.display = "none";

  // IMPORTANT: Do NOT touch Detected/Filled/Non-Filled lists or their headers here.
  // BucketUI (the IIFE at the top) handles detection, seeding, and counts.
}

function renderResultsAndRemember(url, resp, statusText){
  const rawFilled   = Array.isArray(resp.filled) ? resp.filled.slice() : [];
  const trulyFilled = rawFilled.filter(isTrulyFilled);
  
  // Move-back items: keep their confidence (parse if string)
  const movedBack = rawFilled
    .filter(f => !isTrulyFilled(f))
    .map(f => ({
      key:   f.key || null,
      label: f.label || "(Unknown)",
      confidence: parseConfidence(f.confidence) ?? "N/A"   // preserve numeric if present
    }));
  
  const nonFilledBase = Array.isArray(resp.notFilled)
    ? resp.notFilled.map(({key,label,confidence}) => ({
        key, label,
        confidence: parseConfidence(confidence) ?? "N/A"    // preserve numeric if present
      }))
    : [];  

  const nonFilled = nonFilledBase.concat(movedBack);

  // Render
  trulyFilled.sort((a,b)=>(Number(a.confidence)||0)-(Number(b.confidence)||0));
  renderFieldList(filledBox,    trulyFilled, { title:"Filled",     mode:"filled"    });
  renderFieldList(notFilledBox, nonFilled,   { title:"Non-Filled", mode:"nonfilled" });
  forceNonFilledBadges(notFilledBox);
  setStatus(statusText);

  // Update headers (counts)
  try{
    const detectedCount =
      (Array.isArray(window.SFF_DETECTED) && window.SFF_DETECTED.length) ||
      (detectedList?.children?.length || 0) ||
      Number(resp?.inputs) ||
      (trulyFilled.length + nonFilled.length);

    if (detectedToggle && detectedBox) {
      const open = detectedBox.style.display !== "none";
      detectedToggle.dataset.base = "Detected Fields";
      detectedToggle.dataset.count = String(detectedCount);
      detectedToggle.textContent = `${open ? "▼" : "▶"} Detected Fields (${detectedCount})`;
    }
    if (filledToggle && filledBox) {
      const openF = filledBox.style.display !== "none";
      filledToggle.dataset.base = "Filled Fields";
      filledToggle.dataset.count = String(trulyFilled.length);
      filledToggle.textContent = `${openF ? "▼" : "▶"} Filled Fields (${trulyFilled.length})`;
    }
    if (notFilledToggle && notFilledBox) {
      const openNF = notFilledBox.style.display !== "none";
      notFilledToggle.dataset.base = "Non-Filled Fields";
      notFilledToggle.dataset.count = String(nonFilled.length);
      notFilledToggle.textContent = `${openNF ? "▼" : "▶"} Non-Filled Fields (${nonFilled.length})`;
    }
  }catch{}

  try{
    const low = trulyFilled.filter(f => typeof f.confidence==="number" && f.confidence<0.5).length;
    const summary = { timestamp:Date.now(), filledCount:trulyFilled.length||0, totalDetected:(resp?.inputs??0), lowConfidence:low };
    chrome.storage.local.set({ fillerRun: summary });
  }catch{}
}

async function runFill(){
  const tab = await getActiveTab();
  if(!tab) return setStatus("❌ No active tab.");
  const url = tab.url||"";
  if(!isSupportedUrl(url)) return setStatus("❌ This page type can’t be filled.");
  if(!await ensureContent(tab.id)) return setStatus("❌ Could not reach content script.");
  const frameId = await getBestFrame(tab.id);
  const resp = await sendToFrame(tab.id, frameId, { action:"fillFormSmart" });
  if(!resp) return setStatus("❌ No response from content script.");

  let statusText = "Ready.";
  if(resp.ok && typeof resp.inputs==="number"){
    if(resp.inputs===0) statusText="❌ No form detected on this page.";
    else if(Array.isArray(resp.filled) && resp.filled.length===0) statusText="ℹ️ Form found, but 0 fields matched your data.";
    else statusText="✅ Form filled! You can try again.";
  }else if(resp.ok===false && resp.error){
    statusText="❌ Error: "+resp.error;
  }else{
    statusText="ℹ️ Unexpected response (see console).";
  }

  renderResultsAndRemember(url, resp, statusText);

  const filled = Array.isArray(resp.filled)? resp.filled : [];
  const fillBtn = document.getElementById("fillForm");
  const tryBtn = document.getElementById("tryAgain");
  if (fillBtn && tryBtn) {
    fillBtn.style.display = filled.length ? "none" : "inline-block";
    tryBtn.style.display = filled.length ? "inline-block" : "none";
  }
}

/* ===================== INIT ===================== */
document.addEventListener("DOMContentLoaded", async () => {
  initTabs();
  try { await preloadAndRestore(); } catch(e){ err(e); }
  autoMatch(); // run matcher immediately
});

// Buttons
document.getElementById("fillForm")?.addEventListener("click", async () => {
  try { await fillUsingPredictPipeline({ silent: true }); }
  catch (e) { setStatus("❌ " + (e.message || e)); }
});
document.getElementById("tryAgain")?.addEventListener("click", async () => {
  try { await fillUsingPredictPipeline({ silent: true }); }
  catch (e) { setStatus("❌ " + (e.message || e)); }
});
document.getElementById("manageProfileBtn")?.addEventListener("click", () => {
  // open the profile editor page
  const url = chrome.runtime.getURL("profile.html");
  window.open(url, "_blank");
});
document.getElementById("manageResumesBtn")?.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("resumes.html"));
});
document.getElementById("uploadResumeCTA")?.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("resumes.html"));
});

/* ========== Unified Debug Output helpers (one-box) ========== */
function _dbgBox(){ return document.getElementById("debugOutput"); }
function _esc(s){ return String(s ?? "").replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])); }
function _kv(pairs){
  return `<div class="kv">${
    pairs.map(([k,v])=>`<div class="key">${_esc(k)}</div><div class="val">${v}</div>`).join("")
  }</div>`;
}
function showDebug(title, html){
  const box = _dbgBox();
  if (!box) return;
  box.innerHTML = `<h4>${_esc(title)}</h4>${html || ""}`;
}

// ====== STEP 1 DETECTOR UI (popup.js) ======
function popupLog(...a){ console.log("[popup][detect]", ...a); }
function popupErr(...a){ console.error("[popup][detect]", ...a); }

async function getActiveTabSimple(){
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

// Avoid clobbering the 3-arg sendToFrame(tabId, frameId, msg) used by the matcher.
async function sendToFrameSimple(tabId, action){
  return await chrome.tabs.sendMessage(tabId, { action });
}

// Debug-only renderer (renamed to avoid shadowing main)
function renderDetectedDebug(list, withPred = false) {
  const sel = document.getElementById("detectedSelect");
  const det = document.getElementById("detectedDetails");
  const count = document.getElementById("detectCount");
  if (!sel || !det || !count) return;

  sel.innerHTML = "";
  det.textContent = "";

  (list || []).forEach((d, i) => {
    // robust fallbacks for label/how
    const label = d.label || d.labelText || d.placeholder || d.name || d.id || "(no label)";
    const how   = d.detectedBy || "derived";
    const suffix = (withPred && d.prediction)
      ? ` → ${d.prediction} (${(d.confidence ?? 0).toFixed(3)})`
      : "";
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${label}  —  [${how}]${suffix}`;
    sel.appendChild(opt);
  });

  count.textContent = `${(list || []).length} detected`;

  sel.onchange = () => {
    const idx = Number(sel.value);
    const d = (list || [])[idx];
    if (!d) { det.textContent = ""; return; }
    const details = {
      labelText: d.label || d.labelText || d.placeholder || d.name || d.id || null,
      detectedBy: d.detectedBy,
      tagName: d.tagName,
      inputType: d.inputType,
      id: d.id,
      name: d.name,
      placeholder: d.placeholder,
      selector: d.selector,
      prediction: d.prediction ?? null,
      confidence: d.confidence ?? null
    };
    det.textContent = JSON.stringify(details, null, 2);
  };

  if ((list || []).length) {
    sel.selectedIndex = 0;
    sel.onchange();
  }
}

// Debug-only detector (renamed to avoid shadowing main)
async function runDetectorDebug() {
  const tab = await getActiveTab();
  if (!tab) throw new Error("No active tab");

  const probe = await chrome.tabs.sendMessage(tab.id, { action: "probe" }).catch(() => null);
  if (!probe || !probe.ok) throw new Error("Content script not reachable. Make sure helpers/content are injected.");

  const resp = await chrome.tabs.sendMessage(tab.id, { action: "EXT_DETECT_FIELDS" }).catch(() => null);
  if (!resp || !resp.ok || !Array.isArray(resp.detected)) throw new Error("Detector failed in content script");

  SFF_DETECTED = resp.detected.slice(); // cache
  renderDetectedDebug(SFF_DETECTED);
  console.log("[popup][predict] Detected", SFF_DETECTED.length, "fields");
  return SFF_DETECTED;
}

// DEBUG: Detect → populate select + details + detectCount
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnDetect");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      await runDetectorDebug(); // this renders into #detectedSelect/#detectedDetails and updates #detectCount
    } catch (e) {
      const det = document.getElementById("detectedDetails");
      if (det) det.textContent = `Error: ${e.message || e}`;
    }
  });
});


// DEBUG: Predict → annotate options with predictions and update #predictCount
document.getElementById("btnPredict")?.addEventListener("click", async () => {
  try {
    if (!SFF_DETECTED?.length) await runDetectorDebug();
    await predictForDetected(); // updates #predictCount and augments the select text with predictions
  } catch (e) {
    const det = document.getElementById("detectedDetails");
    if (det) det.textContent = `Prediction Error: ${e.message || e}`;
  }
});

// DEBUG: Fill (original outputs) → uses background fillDetected and prints summary/report
document.getElementById("btnFill")?.addEventListener("click", async () => {
  try {
    if (!SFF_DETECTED?.length) await runDetectorDebug();
    if (!SFF_DETECTED[0]?.prediction) await predictForDetected();

    const profile = await getProfileFromBackend();
    const { lastResumeId } = await chrome.storage.local.get("lastResumeId");

    const resp = await new Promise(res => {
      chrome.runtime.sendMessage(
        { action:"fillDetected", items:SFF_DETECTED, profile, resumeId: lastResumeId || null },
        r => res(r)
      );
    });
    if (!resp?.success) throw new Error(resp?.error || "Fill failed");
    // Render into #fillSummary and #fillReport (already defined in file)
    renderFillReport(resp.report || []);
  } catch (e) {
    const pre = document.getElementById("fillReport");
    const sum = document.getElementById("fillSummary");
    if (sum) sum.textContent = "fill failed";
    if (pre) pre.textContent = String(e);
    console.error("[popup][fill] error:", e);
  }
});

// ====== STEP 2 PREDICTOR UI (popup.js) ======
let SFF_DETECTED = []; // cache from Step 1

// Override detector renderer to keep cache
async function runDetector(){
  const tab = await getActiveTab();
  if (!tab) throw new Error("No active tab");
  // If you require injection, call your ensureContent(tab.id) here.

  const probe = await chrome.tabs.sendMessage(tab.id, { action: "probe" }).catch(()=>null);
  if (!probe || !probe.ok) throw new Error("Content script not reachable. Make sure helpers/content are injected.");

  const resp = await chrome.tabs.sendMessage(tab.id, { action: "EXT_DETECT_FIELDS" }).catch(()=>null);
  if (!resp || !resp.ok || !Array.isArray(resp.detected)) throw new Error("Detector failed in content script");

  SFF_DETECTED = resp.detected.slice(); // cache
  renderDetectedDebug(SFF_DETECTED);    // ← use the debug renderer  
  console.log("[popup][predict] Detected", SFF_DETECTED.length, "fields");
  return SFF_DETECTED;
}

// Call background → /predict
async function predictForDetected(){
  const labels = SFF_DETECTED.map(d => (d.labelText || d.label || "").toString().trim());
  const resp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "predictLabels", labels }, (r) => resolve(r));
  });

  if (!resp || !resp.success) throw new Error(`Prediction failed: ${resp?.error || "no response"}`);

  // Attach predictions to cached detected rows by index
  const results = Array.isArray(resp.results) ? resp.results : [];
  (SFF_DETECTED || []).forEach((d, i) => {
    const r = results[i] || {};
    d.prediction = r.prediction ?? null;
    d.confidence = typeof r.confidence === "number" ? r.confidence : null;
  });

  renderDetectedDebug(SFF_DETECTED, /*withPred*/ true);
  const pc = document.getElementById("predictCount");
  if (pc) pc.textContent = `${results.filter(r => r && r.prediction).length}/${results.length} predicted`;
  console.log("[popup][predict] Predictions", results);
  return SFF_DETECTED;
}

// Unified filler used by both tabs.
// silent=true  → updates status + the Filled / Non-Filled lists only
// silent=false → also prints the detailed debug report
async function fillUsingPredictPipeline({ silent = true } = {}) {
  // detect + predict if not done
  if (!SFF_DETECTED?.length) await runDetectorDebug();
  if (!SFF_DETECTED[0]?.prediction) await predictForDetected();  

  const profile = await getProfileFromBackend();
  const { lastResumeId } = await chrome.storage.local.get("lastResumeId");
  const resp = await new Promise(res => {
    chrome.runtime.sendMessage(
      { action: "fillDetected", items: SFF_DETECTED, profile, resumeId: lastResumeId || null },
      r => res(r)
    );
  });
  if (!resp?.success) throw new Error(resp?.error || "Fill failed");

  // Debug detailed report if requested
  if (!silent) {
    renderFillReport(resp.report || []);
  }

  // Build the summary shape expected by renderResultsAndRemember()
  const filled = (resp.report || [])
    .filter(r => r.status === "filled")
    .map(r => ({
      label: r.label,
      value: r.valuePreview || r.value || "",
      confidence: typeof r.confidence === "number" ? r.confidence : 1
    }));

  const nonFilled = (resp.report || [])
    .filter(r => r.status !== "filled")
    .map(r => ({
      key: r.prediction || r.label,
      label: r.label,
      confidence: parseConfidence(r.confidence) ?? "N/A"
    }));  

  const tab = await getActiveTab();
  const url = tab?.url || "";
  const totalInputs = (resp.inputs ?? SFF_DETECTED.length) || 0;

  renderResultsAndRemember(url, { filled, notFilled: nonFilled, inputs: totalInputs, ok: true }, "✅ Form filled! You can try again.");

  // Toggle Main buttons appropriately
  const fillBtn = document.getElementById("fillForm");
  const tryBtn = document.getElementById("tryAgain");
  if (fillBtn && tryBtn) {
    const hasAny = filled.length > 0;
    fillBtn.style.display = hasAny ? "none" : "inline-block";
    tryBtn.style.display  = hasAny ? "inline-block" : "none";
  }

  return resp;
}

async function getProfileFromBackend() {
  const resp = await new Promise(res => chrome.runtime.sendMessage({ action:"getProfile" }, r => res(r)));
  if (!resp?.success) throw new Error(resp?.error || "Profile fetch failed");
  return resp.profile || {};
}

// Treat unchecked/empty boxes as skipped for the debug report
function _deriveReportStatus(r){
  const t = String(r?.inputType || r?.type || r?.kind || "").toLowerCase();
  const isBox = /checkbox|radio/.test(t) || r?.kind === "checkbox";
  const vraw = r?.valuePreview ?? r?.value ?? "";
  const v = String(vraw).trim().toLowerCase();

  const looksUnchecked = (v === "" || v === "unchecked" || v === "false" || v === "off" || v === "0" || v === "no");

  // For boxes/radios, if we didn’t toggle them on, call it skipped.
  if (isBox && looksUnchecked) return "skipped";

  // Defensive: if backend said "filled" but value is clearly unchecked/empty, show "skipped".
  if ((r?.status === "filled") && looksUnchecked) return "skipped";

  return r?.status || "skipped";
}

function renderFillReport(report) {
  const pre = document.getElementById("fillReport");
  const sum = document.getElementById("fillSummary");
  if (!pre || !sum) return;

  // derive status per row so "unchecked" never counts as filled
  const rows = (report || []).map(r => {
    const status = _deriveReportStatus(r);
    const conf   = (typeof r.confidence === "number") ? ` @${r.confidence.toFixed(3)}` : "";
    const val    = (r.valuePreview != null) ? ` = "${r.valuePreview}"` : (r.value != null ? ` = "${r.value}"` : "");
    const why    = r.reason ? ` — ${r.reason}` : "";
    return { status, line: `• ${r.label} → ${r.prediction}${conf}${val} [${status}]${why}` };
  });

  const filledCount  = rows.filter(x => x.status === "filled").length;
  const skippedCount = rows.length - filledCount;

  sum.textContent = `${filledCount} filled, ${skippedCount} skipped`;
  pre.textContent = rows.map(x => x.line).join("\n");
}

// popup.js — add at bottom (after function definitions)
document.addEventListener("DOMContentLoaded", () => {
  try { initTabs(); } catch {}
  try { /* seeds lists + buttons */ preloadAndRestore(); } catch {}
  try { /* runs JD detection + scoring + suggestor */ autoMatch(); } catch (e) { console.error(e); }
});

// Wire the new button
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnPredict");
  if (btn) {
    btn.addEventListener("click", async () => {
      try {
        if (!SFF_DETECTED.length) await runDetectorDebug();
        await predictForDetected();
      } catch (e) {
        console.error("[popup][predict] error:", e);
        const det = document.getElementById("detectedDetails");
        if (det) det.textContent = `Prediction Error: ${e.message || e}`;
      }
    });
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnFill");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      const resp = await fillUsingPredictPipeline({ silent: false }); // also renders the debug report
      if (!resp?.success) throw new Error(resp?.error || "Fill failed");
    } catch (e) {
      const pre = document.getElementById("fillReport");
      const sum = document.getElementById("fillSummary");
      if (sum) sum.textContent = "fill failed";
      if (pre) pre.textContent = String(e);
      console.error("[popup][fill] error:", e);
    }
  });
});


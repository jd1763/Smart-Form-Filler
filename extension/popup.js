/***********************
 * POPUP — MATCHER + FILLER (Week-5 kept) + Week-6 multi-resume + UI polish
 ***********************/
const DEBUG = true;
const log = (...a) => DEBUG && console.log("[popup]", ...a);
const err = (...a) => console.error("[popup]", ...a);

/* ===================== MATCHER CONFIG ===================== */
const MATCH_API_BASE = "http://127.0.0.1:5000"; // api.py host/port
const MATCH_ROUTE = "/match";

// Tight whitelist so “missing skills” stays clean
const SKILL_WORDS = new Set([
  "python","java","c++","c","r","sql","mysql","postgres","mongodb","redis",
  "aws","gcp","azure","docker","kubernetes","k8s","terraform","linux",
  "spark","hadoop","airflow","pandas","numpy","scikit-learn","sklearn",
  "react","node","javascript","typescript","graphql","rest","grpc",
  "kafka","snowflake","databricks","tableau","git","ci","cd","tomcat",
  "android","gradle","junit","eclipse","intellij","vscode","jsp","html","css"
]);

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
function extractImportance(jdText) {
  const jd = (jdText || "").toLowerCase();
  const reqMatch  = jd.match(/(?:required|must[-\s]?have|requirements?)[:\-—]\s*([\s\S]{0,500})/i);
  const prefMatch = jd.match(/(?:preferred|nice[-\s]?to[-\s]?have)[:\-—]\s*([\s\S]{0,500})/i);
  const tokens = (s) => (s || "").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || [];
  const toSkillSet = (arr) => {
    const set = new Set();
    arr.forEach(t => { if (SKILL_WORDS.has(t)) set.add(t); });
    return set;
  };
  return {
    requiredKeys: toSkillSet(tokens(reqMatch?.[1] || "")),
    preferredKeys: toSkillSet(tokens(prefMatch?.[1] || "")),
  };
}

/* ===================== RESPONSE NORMALIZATION & BUCKETS ===================== */
function normalizeMatchResponse(res, jdText){
  // score 0..1 or 0..100 → 0..100
  let s = Number(res?.similarity_score ?? res?.score ?? 0);
  const scorePct = Math.max(0, Math.min(100, Math.round(s > 1 ? s : (s*100))));

  // flatten missing: ["aws", ...] or [["aws",0.31], ...]
  const rawMissing = Array.isArray(res?.missing_keywords ?? res?.missing_skills) ? (res.missing_keywords ?? res.missing_skills) : [];
  const flat = rawMissing.map(m => Array.isArray(m) ? String(m[0]) : String(m))
                         .map(x => x.toLowerCase().trim());

  // keep only real JD skills (whitelist ∩ actually in JD)
  const jdTokens = new Set((jdText||"").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || []);
  const missingClean = [...new Set(flat.filter(x => SKILL_WORDS.has(x) && jdTokens.has(x)))];

  return { scorePct, missingClean };
}

function computeBucketsFromJDAndMissing(jdText, missingClean){
  const toks   = (jdText||"").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || [];
  const jdKeys = toks.filter(w => SKILL_WORDS.has(w));
  const jdSet  = new Set(jdKeys);
  const missSet = new Set((missingClean||[]).map(x=>String(x).toLowerCase()));

  // Headings
  let { requiredKeys, preferredKeys } = extractImportance(jdText||"");

  // ---- Fallbacks (handle unlabeled JDs) ----
  if ((!requiredKeys || requiredKeys.size === 0) && (!preferredKeys || preferredKeys.size === 0)) {
    requiredKeys  = new Set(jdSet);
    preferredKeys = new Set();
  } else if (requiredKeys.size === 0 && preferredKeys.size > 0) {
    requiredKeys = new Set([...jdSet].filter(k => !preferredKeys.has(k)));
  } else {
    requiredKeys  = new Set([...requiredKeys].filter(k => jdSet.has(k)));
    preferredKeys = new Set([...preferredKeys].filter(k => jdSet.has(k) && !requiredKeys.has(k)));
  }

  // Matched / Missing per bucket
  const matchedReq  = [...requiredKeys].filter(k => !missSet.has(k));
  const matchedPref = [...preferredKeys].filter(k => !missSet.has(k));
  const missReq     = [...requiredKeys].filter(k =>  missSet.has(k));
  const missPref    = [...preferredKeys].filter(k =>  missSet.has(k));

  return { matchedReq, matchedPref, missReq, missPref };
}

/* ===================== DISPLAY SCORE (required-first; “Other” removed) ===================== */
function computeDisplayScore({ apiBasePct, jdText, missing }) {
  // Perfect if nothing is missing at all
  if ((missing||[]).length === 0) return 100;

  // Tokenize JD & build sets
  const toks   = Array.from(new Set((jdText || "").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || []));
  const jdKeys = toks.filter(w => SKILL_WORDS.has(w));
  const jdSet  = new Set(jdKeys);
  const missSet = new Set((missing||[]).map(m => String(Array.isArray(m)? m[0]: m).toLowerCase()));

  // Headings + robust fallbacks
  let { requiredKeys, preferredKeys } = extractImportance(jdText);
  if ((!requiredKeys || requiredKeys.size === 0) && (!preferredKeys || preferredKeys.size === 0)) {
    requiredKeys = new Set(jdSet);
    preferredKeys = new Set();
  } else if (requiredKeys.size === 0 && preferredKeys.size > 0) {
    requiredKeys = new Set([...jdSet].filter(k => !preferredKeys.has(k)));
  } else {
    requiredKeys = new Set([...requiredKeys].filter(k => jdSet.has(k)));
    preferredKeys = new Set([...preferredKeys].filter(k => jdSet.has(k) && !requiredKeys.has(k)));
  }

  // Matched / Missing
  const matchedReq  = [...requiredKeys].filter(k => !missSet.has(k));
  const matchedPref = [...preferredKeys].filter(k => !missSet.has(k));
  const missReq     = [...requiredKeys].filter(k =>  missSet.has(k));
  const missPref    = [...preferredKeys].filter(k =>  missSet.has(k));

  // === Coverage / Boost (NO "Other")
  // Preferred matches get a slight ≥ boost than Required (per your request)
  const bReq  = 1.00;
  const bPref = 1.08;

  const boostNum   = (bReq*matchedReq.length) + (bPref*matchedPref.length);
  const boostDenom = (bReq*requiredKeys.size) + (bPref*preferredKeys.size);
  let coverageBoost = boostDenom ? (boostNum / boostDenom) : 0; // 0..1
  coverageBoost = Math.min(1, Math.max(0, Math.pow(coverageBoost, 0.92)));

  // Blend with API similarity (slightly forgiving)
  const W_API=0.42, W_COV=0.58;
  const base = W_API * (apiBasePct||0) + W_COV * (coverageBoost*100);

  // === Penalties: preferred lighter than required
  const sevReq   = requiredKeys.size  ? (missReq.length  / requiredKeys.size)  : 0;
  const sevPref  = preferredKeys.size ? (missPref.length / preferredKeys.size) : 0;
  const penReq   = Math.pow(sevReq,  1.12) * 24;
  const penPref  = Math.pow(sevPref, 1.02) *  6;
  let score = Math.round(base - (penReq + penPref));

  // === Floors (avoid zeros on partial matches)
  const coverageFloor   = Math.round((coverageBoost * 100) * 0.68);
  const prefSignalFloor = matchedPref.length > 0 ? 16 : 0; // bump if any preferred matched
  score = Math.max(score, coverageFloor, prefSignalFloor);

  // === Caps when Required missing
  if (missReq.length >= 2)      score = Math.min(score, 74);
  else if (missReq.length >= 1) score = Math.min(score, 84);

  // Guardrail when coverage is tiny
  if (coverageBoost < 0.06) score = Math.min(score, Math.round(coverageBoost * 100) + 6);

  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ===================== API CALLS ===================== */
async function callMethod(method, job_text, resume_text) {
  const r = await fetch(MATCH_API_BASE + MATCH_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resume: resume_text, job_description: job_text, method })
  });
  if (!r.ok) throw new Error(`match ${method} ${r.status}`);
  return r.json();
}
async function callBoth(job_text, resume_text){
  const [t, e] = await Promise.allSettled([
    callMethod("tfidf", job_text, resume_text),
    callMethod("embedding", job_text, resume_text)
  ]);
  const resT = t.status==="fulfilled" ? t.value : null;
  const resE = e.status==="fulfilled" ? e.value : null;
  if (!resT && !resE) throw new Error("Both matcher methods failed");
  return { tfidf: resT, embedding: resE };
}

/* ===================== CONTENT HELPERS ===================== */
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
  if(await pingAny(tabId)) return true;
  try{
    await chrome.scripting.executeScript({ target:{tabId, allFrames:true}, files:["content.js"] });
  }catch(e){ err("inject content.js:", e.message||e); return false; }
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
async function ensureSeededResume(){
  const { resumes } = await chrome.storage.local.get("resumes");
  if (Array.isArray(resumes) && resumes.some(r => (r.text||"").trim().length)) return;
  try{
    const url = chrome.runtime.getURL("data/resumes/resume11_jorgeluis_done.txt");
    const resp = await fetch(url);
    if(resp.ok){
      const text=(await resp.text()).trim();
      if(text){
        const seed=[{ id:crypto.randomUUID(), name:"Jorgeluis — Base Resume", text, lastUpdated:Date.now() }];
        await chrome.storage.local.set({ resumes: seed });
        log("Seeded resume from data/resumes/resume11_jorgeluis_done.txt");
      }
    }
  }catch(e){ err("resume seed:", e); }
}
async function loadAllResumes(){
  const resumes = (await chrome.storage.local.get("resumes")).resumes || [];
  return resumes.filter(r => (r.text||"").trim());
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
  elsM.hint = document.getElementById("matchHint");
  elsM.status = document.getElementById("matchStatus");
  const matchCard = document.getElementById("matchCard");
  const hideMatch = () => { if(matchCard) matchCard.style.display = "none"; };
  const showMatch = () => { if(matchCard) matchCard.style.display = ""; };

  // Default state
  setArc(0);
  if (elsM.hint) elsM.hint.textContent = "detecting…";
  if (elsM.status) elsM.status.textContent = "";

  // Ensure resumes + inline picker (always visible)
  await ensureSeededResume();
  const resumes = await loadAllResumes();
  if (!resumes.length){ hideMatch(); ensureInlineResumePicker([]); return; }
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
      const both = await callBoth(jd, r.text);
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

    if (elsM.status) {
      elsM.status.textContent = `Using: ${best.resume.name || best.resume.id} · added ${fmtDateTime(best.resume.lastUpdated||Date.now())}`;
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
        o.value = r.id || r.name;
        o.textContent = r.name || r.id || "(untitled)";
        dd.appendChild(o);
      });

      dd.value = best.resume.id || best.resume.name || dd.options[0]?.value || "";
      const _bestPct = Math.max(0, Math.min(100, Number(best.score) || 0));

      if (chosenEl)   chosenEl.textContent   = best.resume.name || best.resume.id || "(untitled)";
      if (chosenSc)   chosenSc.textContent   = `Match: ${_bestPct}%`;
      if (selectedEl) selectedEl.textContent = best.resume.name || best.resume.id || "(untitled)";
      if (selectedSc) selectedSc.textContent = `Match: ${_bestPct}%`;
      if (resumeStatusEl) resumeStatusEl.textContent = "Suggested resume selected. Change to compare.";

      dd.addEventListener("change", async () => {
        const sel = resumes.find(r => (r.id||r.name) === dd.value);
        if (!sel) return;
        try {
          if (resumeStatusEl) resumeStatusEl.textContent = "Scoring selected resume…";

          const both = await callBoth(jd, sel.text);
          const nT = both.tfidf     ? normalizeMatchResponse(both.tfidf, jd)     : null;
          const nE = both.embedding ? normalizeMatchResponse(both.embedding, jd) : null;

          const have = [nT?.scorePct, nE?.scorePct].filter(v => typeof v === "number");
          const apiBase = have.length ? Math.round(have.reduce((a,b)=>a+b,0)/have.length) : 0;
          const missingUnion = Array.from(new Set([...(nT?.missingClean||[]), ...(nE?.missingClean||[])]));

          const dispScore = computeDisplayScore({ apiBasePct: apiBase, jdText: jd, missing: missingUnion });
          setArc(dispScore);

          // Re-render side-by-side buckets for the selection
          renderBucketsIntoUI(computeBucketsFromJDAndMissing(jd, missingUnion));

          if (elsM.status) elsM.status.textContent = `Using: ${sel.name || sel.id} · added ${fmtDateTime(sel.lastUpdated||Date.now())}`;
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
const $ = (id) => document.getElementById(id);

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
const fmtPct = (x)=> (typeof x==="number"? Math.round(x*100) : null);
function confClass(conf){ if(conf==null||conf==="N/A") return "na"; if(conf>=CONF_THRESH.good) return "good"; if(conf>=CONF_THRESH.ok) return "ok"; return "low"; }

// Render field cards
function renderFieldList(container, items, { title="", showSummary=true } = {}){
  container.innerHTML="";
  if(showSummary){
    const n=items?.length||0;
    let avg=null,count=0;
    (items||[]).forEach(it=>{ if(typeof it.confidence==="number"){ avg=(avg||0)+it.confidence; count++; } });
    if(count>0) avg=Math.round((avg/count)*100);
    const summary=document.createElement("div");
    summary.className="list-summary";
    summary.innerHTML=`<div>${title}</div><div>${n} item${n!==1?"s":""}${avg!=null?` · avg ${avg}%`:""}</div>`;
    container.appendChild(summary);
  }
  (items||[]).forEach((f)=>{
    const confPct=f.confidence==="N/A"? null : fmtPct(f.confidence);
    const cls=confClass(f.confidence);
    const isFilled = confPct!=null && confPct>0;
    const card=document.createElement("div"); card.className="field-item";
    const label=document.createElement("div"); label.className="label"; label.textContent=f.label;
    const badge=document.createElement("span"); badge.className="badge"+(isFilled?"":" na"); badge.textContent=isFilled?"Filled":"N/A"; label.appendChild(badge);
    const chipEl=document.createElement("div"); chipEl.className="chip"; chipEl.textContent=confPct!=null?`Confidence ${confPct}%`:"Confidence N/A";
    const meter=document.createElement("div"); meter.className="meter"; const bar=document.createElement("span"); bar.className=cls; bar.style.width=(confPct!=null?confPct:0)+"%"; meter.appendChild(bar);
    card.appendChild(label); card.appendChild(chipEl); card.appendChild(meter);
    if(f.value){ const val=document.createElement("div"); val.className="value"; val.textContent=String(f.value); card.appendChild(val); }
    container.appendChild(card);
  });
}

// Filler orchestration
async function preloadAndRestore(){
  const tab = await getActiveTab();
  if(!tab){ setStatus("❌ No active tab."); return; }
  const url = tab.url||"";

  // Inline resume picker (always show)
  await ensureSeededResume();
  const resumes = await loadAllResumes();
  ensureInlineResumePicker(resumes);

  // toggles + last results
  let filledOpen=false, notFilledOpen=false;
  const { last, toggles } = await loadState(url);
  if(toggles){ filledOpen=!!toggles.filledOpen; notFilledOpen=!!toggles.notFilledOpen; }
  installToggle(filledToggle, filledBox, filledOpen, (open)=>{ saveToggles(url,{filledOpen:open, notFilledOpen}).catch(()=>{}); filledOpen=open; });
  installToggle(notFilledToggle, notFilledBox, notFilledOpen, (open)=>{ saveToggles(url,{filledOpen, notFilledOpen:open}).catch(()=>{}); notFilledOpen=open; });

  if(last){
    const when = new Date(last.ts).toLocaleString();
    renderFieldList(filledBox, last.filled||[], { title:"Filled" });
    renderFieldList(notFilledBox, last.nonFilled||LOCAL_CATALOG.map(({key,label})=>({key,label,confidence:"N/A"})), { title:"Non-Filled" });
    setStatus(last.status? `${last.status} (last: ${when})` : `Last run: ${when}`);
  }else{
    renderFieldList(notFilledBox, LOCAL_CATALOG.map(({key,label})=>({key,label,confidence:"N/A"})), { title:"Non-Filled" });
    setStatus("Ready.");
  }

  // Optional: pull catalog from content
  if(isSupportedUrl(url) && await ensureContent(tab.id)){
    const frameId = await getBestFrame(tab.id);
    const resp = await sendToFrame(tab.id, frameId, { action:"getAllFieldCatalog" });
    if(resp && resp.ok && Array.isArray(resp.catalog) && (!last || !(last.nonFilled?.length))){
      const nonFilled = resp.catalog.map(({key,label})=>({key,label,confidence:"N/A"}));
      renderFieldList(notFilledBox, nonFilled, { title:"Non-Filled" });
    }
  }
}

function renderResultsAndRemember(url, resp, statusText){
  const filled = Array.isArray(resp.filled)? resp.filled.slice() : [];
  const nonFilled = Array.isArray(resp.notFilled)
    ? resp.notFilled.map(({key,label})=>({key,label,confidence:"N/A"}))
    : LOCAL_CATALOG.filter(({key})=> !filled.some(f=>f.key===key))
        .map(({key,label})=>({key,label,confidence:"N/A"}));

  filled.sort((a,b)=>(Number(a.confidence)||0)-(Number(b.confidence)||0));
  renderFieldList(filledBox, filled, { title:"Filled" });
  renderFieldList(notFilledBox, nonFilled, { title:"Non-Filled" });
  setStatus(statusText);

  try{
    const low = (Array.isArray(filled)? filled.filter(f=> typeof f.confidence==="number" && f.confidence<0.5).length : 0);
    const summary = { timestamp:Date.now(), filledCount:filled.length||0, totalDetected:(resp?.inputs??0), lowConfidence:low };
    chrome.storage.local.set({ fillerRun: summary });
  }catch{}

  saveLast(url, { ts:Date.now(), status:statusText, filled, nonFilled }).catch(()=>{});
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
  try { await preloadAndRestore(); } catch(e){ err(e); }
  autoMatch(); // run matcher immediately
});

// Buttons
document.getElementById("fillForm")?.addEventListener("click", runFill);
document.getElementById("tryAgain")?.addEventListener("click", runFill);

// Optional: open side panel if you still keep it
document.getElementById("openMatcher")?.addEventListener("click", () => {
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
      if (!tab?.id) throw new Error("No active tab");
      if (chrome.sidePanel?.setOptions) await chrome.sidePanel.setOptions({ tabId:tab.id, path:"sidepanel.html", enabled:true });
      if (chrome.sidePanel?.open) await chrome.sidePanel.open({ tabId:tab.id });
    } catch (e) { console.error("open side panel:", e); }
  })();
});

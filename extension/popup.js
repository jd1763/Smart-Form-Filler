/***********************
 * POPUP — MATCHER + FILLER (all-in-one)
 ***********************/
const DEBUG = true;
const log = (...a) => DEBUG && console.log("[popup]", ...a);
const err = (...a) => console.error("[popup]", ...a);

/* ===================== MATCHER ===================== */
const MATCH_API_BASE = "http://127.0.0.1:5001";
const MATCH_ROUTE = "/match";

// Tight skill whitelist to keep “missing skills” clean
const SKILL_WORDS = new Set([
  "python","java","c++","c","r","sql","mysql","postgres","mongodb","redis",
  "aws","gcp","azure","docker","kubernetes","k8s","terraform","linux",
  "spark","hadoop","airflow","pandas","numpy","scikit-learn","sklearn",
  "react","node","javascript","typescript","graphql","rest","grpc",
  "kafka","snowflake","databricks","tableau","git","ci","cd","tomcat",
  "android","gradle","junit","eclipse","intellij","vscode","jsp","html","css"
]);

// UI handles
const elsM = {
  arc: null, scoreNum: null, matched: null, missing: null, hint: null, status: null
};
function gaugeColor(pct){ if(pct>=80) return "#16a34a"; if(pct>=60) return "#22c55e"; if(pct>=40) return "#65a30d"; return "#ef4444"; }
function setArc(percent){
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  elsM.arc.setAttribute("stroke-dasharray", `${p},100`);
  elsM.arc.setAttribute("stroke", gaugeColor(p));
  elsM.scoreNum.textContent = `${p}%`;
}
function chip(txt, bad=false){ const s=document.createElement("span"); s.className=`chip ${bad?"bad":""}`; s.textContent=txt; return s; }
function tokenize(text){
  return (text||"").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g)||[];
}
function jdSkillKeys(text){
  const out=[]; const toks=new Set(tokenize(text));
  SKILL_WORDS.forEach(k => { if(toks.has(k)) out.push(k); });
  return out;
}
function normalizeResponse(res){
  const scorePct = Math.round((res?.similarity_score||0)*100);
  const missing = Array.isArray(res?.missing_keywords)
    ? res.missing_keywords.map(p => Array.isArray(p)? String(p[0]) : String(p))
    : [];
  // keep only real skills
  const cleanMissing = missing.filter(m => SKILL_WORDS.has(m.toLowerCase()));
  return { score: scorePct, missing_skills: cleanMissing };
}
// Try both methods and return both normalized results
async function callBoth(job_text, resume_text){
  const payload = (method)=> fetch(MATCH_API_BASE + MATCH_ROUTE, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ resume: resume_text, job_description: job_text, method })
  }).then(r=> { if(!r.ok) throw new Error(String(r.status)); return r.json(); });

  const [t, e] = await Promise.allSettled([
    payload("tfidf"), payload("embedding")
  ]);
  const resT = t.status==="fulfilled" ? normalizeResponse(t.value) : null;
  const resE = e.status==="fulfilled" ? normalizeResponse(e.value) : null;
  if (!resT && !resE) throw new Error("Both matcher methods failed");
  return { tfidf: resT, embedding: resE };
}

/* ===================== CONTENT/JD HELPERS ===================== */
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
async function loadPrimaryResume(){
  const resumes = (await chrome.storage.local.get("resumes")).resumes || [];
  return resumes.find(r => (r.text||"").trim()) || resumes[0] || null;
}

/* ===================== AUTO MATCH ON OPEN ===================== */
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
// Pull "Required" and "Preferred" blocks and intersect with SKILL_WORDS
function extractImportance(jdText) {
  const jd = (jdText || "").toLowerCase();

  // crude but robust block grabs
  const reqMatch = jd.match(/(?:required|must[-\s]?have|requirements?)[:\-—]\s*([\s\S]{0,400})/i);
  const prefMatch = jd.match(/(?:preferred|nice[-\s]?to[-\s]?have)[:\-—]\s*([\s\S]{0,400})/i);

  const tokens = (s) => (s || "").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || [];
  const toSkillSet = (arr) => {
    const set = new Set();
    arr.forEach(t => { if (SKILL_WORDS.has(t)) set.add(t); });
    return set;
  };

  const reqTokens = tokens(reqMatch?.[1] || "");
  const prefTokens = tokens(prefMatch?.[1] || "");
  return {
    requiredKeys: toSkillSet(reqTokens),     // Set<string>
    preferredKeys: toSkillSet(prefTokens)    // Set<string>
  };
}
async function autoMatch(){
  // Hook UI
  elsM.arc = document.getElementById("arc");
  elsM.scoreNum = document.getElementById("scoreNum");
  elsM.matched = document.getElementById("matchedSkills");
  elsM.missing = document.getElementById("missingSkills");
  elsM.hint = document.getElementById("matchHint");
  elsM.status = document.getElementById("matchStatus");

  const matchCard = document.getElementById("matchCard");
  const hideMatch = () => { matchCard.style.display = "none"; };
  const showMatch = () => { matchCard.style.display = ""; };

  // Default state
  setArc(0);
  elsM.matched.innerHTML = "";
  elsM.missing.innerHTML = "";
  elsM.hint.textContent = "detecting…";
  elsM.status.textContent = "";

  // Ensure resume exists (seed if needed)
  await ensureSeededResume();
  const resume = await loadPrimaryResume();
  if(!resume || !(resume.text||"").trim()){
    hideMatch();
    return;
  }

  // Read JD
  const { jd, note } = await getJobDescription();
  // Basic JD sanity: needs some length and at least 2 skill keywords detected
  const jdTokens = Array.from(new Set((jd || "").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || []));
  const jdKeys = jdTokens.filter(w => SKILL_WORDS.has(w));
  const hasRealJD = (jd && jd.trim().length >= 180) && (jdKeys.length >= 2);

  if (!hasRealJD) {
    // No real posting detected → hide the card entirely
    const matchCard = document.getElementById("matchCard");
    matchCard.style.display = "none";
    return;
  }

  if (!jd || !jd.trim()) {
    // No JD: don’t show the match box at all (as you suggested)
    hideMatch();
    return;
  }
  showMatch();
  elsM.hint.textContent = note || "detected from page";

  try {
    // --- Run both methods (we already validated JD earlier) ---
    const both = await callBoth(jd, resume.text);
    const sT = both.tfidf?.score ?? null;
    const sE = both.embedding?.score ?? null;

    // Use a modestly conservative model base: average, but bias away from spikes
    const have = [sT, sE].filter(v => typeof v === "number");
    const apiBase = have.length ? Math.round(have.reduce((a,b)=>a+b,0)/have.length) : 0; // 0..100

    // JD tokens & skill keys (you likely already computed jdKeys earlier; safe to re-derive)
    const toks   = Array.from(new Set((jd || "").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || []));
    const jdKeys = toks.filter(w => SKILL_WORDS.has(w));

    // Importance buckets
    const { requiredKeys, preferredKeys } = extractImportance(jd);
    const reqSet  = new Set([...requiredKeys].filter(k => jdKeys.includes(k)));
    const prefSet = new Set([...preferredKeys].filter(k => !reqSet.has(k) && jdKeys.includes(k)));
    const othSet  = new Set(jdKeys.filter(k => !reqSet.has(k) && !prefSet.has(k)));

    // Missing union (across methods)
    const missing = Array.from(new Set([
      ...(both.tfidf?.missing_skills || []),
      ...(both.embedding?.missing_skills || [])
    ]));
    const missSet = new Set(missing);

    // Matched per bucket
    const matchedReq  = [...reqSet].filter(k => !missSet.has(k));
    const matchedPref = [...prefSet].filter(k => !missSet.has(k));
    const matchedOth  = [...othSet].filter(k => !missSet.has(k));

    // ---- Weighted coverage (required >> other > preferred) ----
    const wReq = 3.0, wOth = 1.5, wPref = 0.5; // tune here
    const num   = (wReq * matchedReq.length) + (wOth * matchedOth.length) + (wPref * matchedPref.length);
    const denom = (wReq * reqSet.size)      + (wOth * othSet.size)      + (wPref * prefSet.size);
    const coverageW = denom ? (num / denom) : 0; // 0..1 weighted coverage

    // Severity per bucket
    const missReq  = [...reqSet].filter(k => missSet.has(k));
    const missPref = [...prefSet].filter(k => missSet.has(k));
    const sevReq   = reqSet.size  ? (missReq.length  / reqSet.size)  : 0; // 0..1
    const sevPref  = prefSet.size ? (missPref.length / prefSet.size) : 0; // 0..1

    // ---- Blend model + weighted coverage ----
    const W_API = 0.45;  // model similarity contribution
    const W_COV = 0.55;  // visible, weighted coverage contribution
    let score = Math.round(W_API * apiBase + W_COV * (coverageW * 100));

    // ---- Penalties (required hurts more; preferred gentle) ----
    const penReq  = Math.round(Math.pow(sevReq,  1.20) * 28); // up to ~28 off
    const penPref = Math.round(Math.pow(sevPref, 1.05) *  10); // up to  ~10 off
    score = Math.max(0, score - penReq - penPref);

    // ---- Caps (soft when only preferred missing; stronger if required missing) ----
    const preferredMissingCount = missPref.length;

    // 1) Required missing = strict caps
    if (missReq.length >= 2) {
      score = Math.min(score, 65);
    } else if (missReq.length >= 1) {
      score = Math.min(score, 75);
    } else {
      // 2) No required missing → cap based on preferred gaps
      if (preferredMissingCount >= 3) {
        score = Math.min(score, 80);   // lots of preferred missing → can't look like an A
      } else if (preferredMissingCount === 2) {
        score = Math.min(score, 85);
      } else if (preferredMissingCount === 1) {
        score = Math.min(score, 88);
      }
    }

    // 3) If anything is missing at all, never look “perfect”
    if (missing.length > 0) {
      score = Math.min(score, 92);
    }

    // 4) If weighted coverage is weak, keep a sanity ceiling
    if (coverageW < 0.50) {
      score = Math.min(score, Math.round(coverageW * 100) + 12);
    }

    // ---- Render gauge & chips ----
    setArc(score);
    elsM.matched.innerHTML = "";
    const matchedAll = [...new Set([...matchedReq, ...matchedOth, ...matchedPref])];
    (matchedAll.length ? matchedAll : ["None"]).forEach(s => elsM.matched.appendChild(chip(s)));

    elsM.missing.innerHTML = "";
    (missing.length ? missing : ["None"]).forEach(s => elsM.missing.appendChild(chip(s, true)));

    // Footer — name + date+time (no method)
    elsM.status.textContent = `Using: ${resume.name} · added ${fmtDateTime(resume.lastUpdated)}`;
  } catch (e) {
    console.error("[popup] matcher error:", e);
    // If API is down, hide the match box so the filler UI remains clean
    hideMatch();
  }
}

/* ===================== FILLER ===================== */
const btn = document.getElementById("fillForm");
const tryBtn = document.getElementById("tryAgain");
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
const setStatus = (msg)=> (statusEl.textContent=msg);
function installToggle(headerEl, contentEl, initiallyOpen, onChange){
  const set=(open)=>{ contentEl.style.display=open?"block":"none"; const title=headerEl.textContent.replace(/^[▶▼]\s*/,""); headerEl.textContent=(open?"▼ ":"▶ ")+title; onChange?.(open); };
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

  // brief summary for side uses
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
  document.getElementById("fillForm").style.display = filled.length ? "none" : "inline-block";
  document.getElementById("tryAgain").style.display = filled.length ? "inline-block" : "none";
}

/* ===================== INIT ===================== */
document.addEventListener("DOMContentLoaded", async () => {
  try { await preloadAndRestore(); } catch(e){ err(e); }
  autoMatch(); // run matcher immediately (no button)
});

// Buttons
document.getElementById("fillForm").addEventListener("click", runFill);
document.getElementById("tryAgain").addEventListener("click", runFill);

// Optional: open the side panel if you still keep it
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

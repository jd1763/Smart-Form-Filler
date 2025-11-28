let BACKEND_BASE = localStorage.getItem("backend_base") || "http://127.0.0.1:5000";
let API_BASE = BACKEND_BASE;

// Prefer Docker (8000) if /resumes responds with JSON; else local (5000)
(async function preferDockerOnProfilePage(){
  const candidates = ["http://127.0.0.1:8000", "http://127.0.0.1:5000"];
  for (const base of candidates) {
    try {
      const r = await fetch(`${base}/resumes?t=${Date.now()}`, {
        credentials: "omit",
        headers: { "Accept": "application/json" },
        cache: "no-store"
      });
      if (r.ok) {
        BACKEND_BASE = base;
        API_BASE = base;
        try { localStorage.setItem("backend_base", base); } catch {}
        break;
      }
    } catch {}
  }
})();

async function _probe(base, timeoutMs = 900) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/resumes?t=${Date.now()}`, {
      signal: ctl.signal,
      credentials: "omit",
      headers: { "Accept": "application/json" },
      cache: "no-store"
    });
    return r.ok;
  } catch { return false; }
  finally { clearTimeout(t); }
}

async function _failoverBase() {
  const order = ["http://127.0.0.1:8000", "http://127.0.0.1:5000"];
  for (const b of order) if (await _probe(b)) return b;
  return "http://127.0.0.1:5000";
}
async function fetchWithFailoverP(path, opts) {
  const baseHeaders = Object.assign({ "Accept": "application/json" }, (opts && opts.headers) || {});
  opts = Object.assign({ credentials: "omit", cache: "no-store", headers: baseHeaders }, opts || {});
  const method = (opts.method || "GET").toUpperCase();

  try {
    const r = await fetch(`${BACKEND_BASE}${path}`, opts);
    if (r.ok) return r;

    if (r.status === 403 && method === "GET") {
      const r0 = await fetch(`${BACKEND_BASE}${path}`, Object.assign({}, opts, { credentials: "omit" }));
      if (r0.ok) return r0;
    }
    throw new Error(`HTTP ${r.status}`);
  } catch {
    BACKEND_BASE = await _failoverBase();
    API_BASE = BACKEND_BASE;
    try { localStorage.setItem("backend_base", BACKEND_BASE); } catch {}

    const r2 = await fetch(`${BACKEND_BASE}${path}`, opts);
    if (r2.ok) return r2;

    if (r2.status === 403 && method === "GET") {
      const r3 = await fetch(`${BACKEND_BASE}${path}`, Object.assign({}, opts, { credentials: "omit" }));
      if (r3.ok) return r3;
    }
    throw new Error(`HTTP ${r2.status} (after failover)`);
  }
}

const $ = id => document.getElementById(id);
const statusEl = $("status");

// light canonicalization + whitelist (keep in sync with popup/content)
const _ALIASES = { "c++":"cpp","c#":"csharp",".net":"dotnet","node.js":"nodejs","react.js":"react","next.js":"nextjs","express.js":"express","k8s":"kubernetes","js":"javascript","ts":"typescript" };
const _WHITELIST = new Set([
  "python","java","c","cpp","csharp","go","golang","rust","kotlin","swift",
  "javascript","typescript","html","css","sql","mysql","postgres","postgresql","sqlite","oracle","mongodb","redis",
  "react","nextjs","angular","vue","node","nodejs","express","django","flask","fastapi","spring","springboot","aspnet","dotnet","rails","laravel",
  "pandas","numpy","scikit-learn","sklearn","tensorflow","pytorch","keras","xgboost","spark","hadoop","kafka","airflow",
  "aws","azure","gcp","docker","kubernetes","terraform","ansible","jenkins","github","gitlab","cicd","rest","graphql","grpc","linux","bash","powershell",
  "bigquery","snowflake","databricks","tableau","postman","jira","confluence","s3","iam","eks","ecs"
]);
function _normTok(s){
  let t = String(s||"").toLowerCase().trim().replace(/(^[^a-z0-9]+|[^a-z0-9]+$)/g,"");
  return _ALIASES[t] || t;
}
function _extractSkillsFromText(text){
  const toks = (String(text||"").toLowerCase().match(/[a-z][a-z0-9+.#/-]{1,}/g) || []).map(_normTok);
  const out = new Set();
  for (const tk of toks) if (tk && _WHITELIST.has(tk)) out.add(tk);
  return Array.from(out).sort();
}
async function _getProfile(){
  try {
    const r = await fetchWithFailoverP(`/profile`);
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}

async function _saveProfileSelected({ id, name, skills }){
  const patch = {
    selectedResumeId: String(id || ""),
    selectedResumeName: String(name || ""),
    selectedResumeSkills: Array.from(new Set(skills || [])).sort()
  };
  try {
    await fetchWithFailoverP(`/profile`, {
      method: "PATCH",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(patch)
    });    
  } catch (e) {
    console.warn("[profile] PATCH /profile failed", e);
  }
  // mirror to local storage so popup/content can read instantly (optional)
  try { await chrome.storage.local.set({ selectedResume: { id, name, skills: patch.selectedResumeSkills } }); } catch {}
}
async function _listResumes(){
  try {
    const r = await fetchWithFailoverP(`/resumes`);
    const js = r.ok ? await r.json() : {};    
    const items = Array.isArray(js.items) ? js.items : [];
    return items.map(it => ({ id: String(it.id), name: it.original_name || it.name || it.filename || String(it.id) }));
  } catch (e) {
    console.warn("[profile] GET /resumes failed:", e); return [];
  }
}

async function _getResumeText(id){
  const safePick = (obj) => (obj?.plain_text || obj?.text || obj?.content || "");

  const tryJson = async (path, pickFn) => {
    try {
      const r = await fetchWithFailoverP(path);
      if (!r.ok) return "";
      const js = await r.json();
      return pickFn(js) || "";
    } catch {
      return "";
    }
  };

  // 1) Smart Form Filler canonical endpoint: /resumes/<id>/text (matches api.py)
  let text = await tryJson(
    `/resumes/${encodeURIComponent(id)}/text`,
    (js) => js?.text || js?.plain_text || js?.content || ""
  );
  if (text) return text;

  // 2) Legacy single-item endpoints (keep for future FastAPI or other backends)
  text = await tryJson(`/resume?id=${encodeURIComponent(id)}`, safePick);
  if (text) return text;

  text = await tryJson(
    `/resume_text?id=${encodeURIComponent(id)}`,
    (js) => js?.text || js?.plain_text || js?.content || ""
  );
  if (text) return text;

  // 3) Fallback: POST /resume_text { id }
  try {
    const r = await fetchWithFailoverP(`/resume_text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    if (r.ok) {
      const js = await r.json();
      text = js?.text || js?.plain_text || js?.content || "";
      if (text) return text;
    }
  } catch {
    // ignore
  }

  // 4) Last resort: /resumes list (in this backend it won't have text, but we keep it for compatibility)
  const items = await tryJson(`/resumes`, (js) =>
    Array.isArray(js?.items) ? js.items : []
  );
  if (Array.isArray(items) && items.length) {
    const it = items.find((x) => String(x.id) === String(id));
    if (it) {
      text = it.plain_text || it.text || it.content || "";
      if (text) return text;
    }
  }

  // Nothing worked
  return "";
}

async function initProfileResumeDropdown(profileData = {}) {
  const sel  = document.getElementById("profileResumeSelect");
  const meta = document.getElementById("profileResumeMeta");
  if (!sel) return;

  const items = await _listResumes();  // /resumes
  sel.innerHTML = `<option value="">—</option>` + items.map(r => `<option value="${r.id}">${r.name}</option>`).join("");

  // Prefer what's in profile.json; if empty, use popup’s last selection
  let savedId = profileData?.selectedResumeId ? String(profileData.selectedResumeId) : "";
  try {
    const { lastResumeId, selectedResume } = await chrome.storage.local.get(["lastResumeId", "selectedResume"]);
    if (!savedId) savedId = lastResumeId || selectedResume?.id || "";
  } catch {}

  if (savedId && items.some(r => r.id === savedId)) sel.value = savedId;

  const applyMeta = () => {
    const opt = items.find(r => r.id === sel.value);
    if (meta) meta.textContent = opt ? opt.name : "";
  };
  applyMeta();

  // Only prepare a pending selection; actual save happens on Save button
  sel.addEventListener("change", async () => {
    const id = sel.value;
    const name = sel.options[sel.selectedIndex]?.textContent || id || "";
    if (!id) {
      window._pendingResume = { id: "", name: "", skills: [] };
      if (meta) meta.textContent = "";
      return;
    }

    // 1) get resume text
    const text = await _getResumeText(id);

    // 2) compute skills LOCALLY (no backend call → no 403)
    const skills = _extractAllSkillsFromText(text);

    // 3) stash pending (not saved until user clicks Save)
    window._pendingResume = { id, name, skills };

    // 4) UI hint
    if (meta) meta.textContent = `${name} (pending — click Save)`;
  });
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const YEARS = (()=>{ const y=[]; const now=new Date().getFullYear()+1; for(let k=now;k>=1970;k--) y.push(k); return y; })();
// Degree catalog used by the dropdown (value = short code)
const DEGREE_OPTIONS = [
    { short: "AS",  long: "Associate of Science",           label: "A.S. — Associate of Science" },
    { short: "AA",  long: "Associate of Arts",              label: "A.A. — Associate of Arts" },
    { short: "BS",  long: "Bachelor of Science",            label: "B.S. — Bachelor of Science" },
    { short: "BA",  long: "Bachelor of Arts",               label: "B.A. — Bachelor of Arts" },
    { short: "MS",  long: "Master of Science",              label: "M.S. — Master of Science" },
    { short: "MA",  long: "Master of Arts",                 label: "M.A. — Master of Arts" },
    { short: "MBA", long: "Master of Business Administration", label: "MBA — Master of Business Administration" },
    { short: "PhD", long: "Doctor of Philosophy",           label: "Ph.D. — Doctor of Philosophy" }
  ];
  const DEGREE_MAP = Object.fromEntries(DEGREE_OPTIONS.map(d => [d.short, d.long]));
  // Rank degrees so we can infer "highest"
  const DEGREE_RANK = {
    "High School": 0, "Certificate": 1, "Diploma": 1,
    "Associate's": 2, "Bachelor's": 3, "Master's": 4, "MBA": 4, "Doctorate": 5
  };

  /* ==== Selected Resume → Skills (helpers) ==== */
  function _normSkillToken(s){
    let t = String(s||"").toLowerCase().trim();
    t = t.replace(/\s+/g,"");
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
  // very light extractor of "all skills" from resume text; whitelist helps avoid junk tokens
function _extractAllSkillsFromText(text){
  const raw = String(text||"");
  const tokens = raw.match(/[A-Za-z][A-Za-z0-9+.#/-]{1,}/g) || [];
  const WHITELIST = new Set([
    // langs
    "python","java","c","cpp","csharp","go","golang","rust","kotlin","swift",
    "typescript","javascript","ts","js","sql","mysql","postgres","postgresql","sqlite","oracle",
    // web
    "html","css","react","reactjs","nextjs","angular","vue","node","nodejs","express",
    // backends
    "django","flask","fastapi","spring","springboot","aspnet","dotnet","rails","laravel",
    // data/ml
    "pandas","numpy","scikit-learn","sklearn","tensorflow","pytorch","keras","xgboost","spark","hadoop","kafka","airflow",
    // devops/cloud
    "aws","azure","gcp","docker","kubernetes","k8s","terraform","ansible","jenkins","github","gitlab","cicd",
    // api/arch/tools
    "rest","graphql","grpc","microservices","linux","bash","powershell","jira","confluence","postman","redis","mongodb","bigquery"
  ]);
  const out = new Set();
  for (const tok of tokens) {
    const n = _normSkillToken(tok);
    if (n && WHITELIST.has(n)) out.add(n);
  }
  // expand common aliases to canonical forms
  if (out.has("ts")) { out.delete("ts"); out.add("typescript"); }
  if (out.has("js")) { out.delete("js"); out.add("javascript"); }
  return Array.from(out).sort();
}

  function _tokenizeSkills(text){
    const toks = (String(text||"").toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || []);
    // a light vocab to avoid collecting random words (keep in sync with popup’s list as needed)
    const WHITELIST = new Set([
      "python","java","c","c++","c#","go","golang","rust","kotlin","swift",
      "javascript","typescript","html","css","sql","mysql","postgresql","postgres","sqlite","oracle",
      "mongodb","redis","kafka","spark","airflow","hadoop",
      "pandas","numpy","scikit-learn","sklearn","tensorflow","pytorch","keras","xgboost",
      "react","react.js","next.js","angular","vue","node","node.js","express","express.js",
      "django","flask","fastapi","spring","springboot","asp.net",".net",".netcore","rails","laravel",
      "docker","kubernetes","k8s","terraform","ansible","jenkins","github","gitlab","git","cicd","ci/cd",
      "graphql","grpc","rest","microservices","linux","bash","powershell","jira","confluence","postman",
      "aws","azure","gcp","s3","ec2","lambda","rds","eks","ecs","cloudformation","cdk","cloudwatch",
      "bigquery","firebase","vercel","netlify","heroku","nginx","apache","redux","rxjs","vite","webpack"
    ]);
    const out = new Set();
    for (const raw of toks){
      const canon = _normSkillToken(raw);
      if (!canon) continue;
      // accept plain “ts” → “typescript” and “js” → “javascript”
      const alias = canon === "ts" ? "typescript" : (canon === "js" ? "javascript" : canon);
      if (WHITELIST.has(alias)) out.add(alias);
    }
    return Array.from(out).sort();
  }

  /* ==== Selected Resume → Skills (UI wiring) ==== */
  const profileMatched = { required: [], preferred: [] };

  function renderProfileSkillChips(){
    const mkChip = (txt, bad=false) => {
      const s = document.createElement("span");
      s.className = "chip";
      if (bad) s.classList.add("bad");
      s.textContent = txt;
      return s;
    };
    const reqBox  = document.getElementById("profileMatchedReq");
    const prefBox = document.getElementById("profileMatchedPref");
    if (reqBox){ reqBox.innerHTML=""; (profileMatched.required.length? profileMatched.required:["None"]).forEach(s => reqBox.appendChild(mkChip(s))); }
    if (prefBox){ prefBox.innerHTML=""; (profileMatched.preferred.length? profileMatched.preferred:["None"]).forEach(s => prefBox.appendChild(mkChip(s))); }
  }

  document.getElementById("profileExtractSkills")?.addEventListener("click", ()=>{
    const status = document.getElementById("profileSkillsStatus");
    const txt = document.getElementById("profileResumeText")?.value || "";
    const skills = _tokenizeSkills(txt);
    // Put them in both buckets (your content script unions them)
    profileMatched.required  = skills.slice();
    profileMatched.preferred = skills.slice();
    renderProfileSkillChips();
    status.textContent = `Found ${skills.length} skills`;
    // mirror into chrome.storage for the content-script checker
    chrome.storage.local.set({ matchedSkills: { required: profileMatched.required, preferred: profileMatched.preferred } }, ()=>{});
  });

  // Normalize "BS", "BSc", "Bachelor of Science" → "Bachelor's", etc.
  function normalizeDegreeLabel(x){
    const s = String(x || "").toLowerCase();
    if (!s) return "";
    if (/high\s*school/.test(s)) return "High School";
    if (/certificate|cert\b/.test(s)) return "Certificate";
    if (/diploma/.test(s)) return "Diploma";
    if (/associate|^as$|^aa$/.test(s)) return "Associate's";
    if (/bachelor|^bs$|^ba$|b\.?s\.?|b\.?a\.?/.test(s)) return "Bachelor's";
    if (/master|^ms$|^ma$|m\.?s\.?|m\.?a\.?/.test(s)) return "Master's";
    if (/mba/.test(s)) return "MBA";
    if (/phd|doctor|d\.?phil/.test(s)) return "Doctorate";
    return "";
  }

  // Highest from education[] using local normalizer
  function highestFromEducation(arr = []) {
    const labels = arr
      .map(e => normalizeDegreeLabel(e.degreeLong || e.degreeShort || e.degree || ""))
      .filter(Boolean);
    return labels.sort((a,b) => (DEGREE_RANK[b]||0) - (DEGREE_RANK[a]||0))[0] || "";
  }


  // Helper: pick dropdown value from existing item
  function resolveDegreeValue(item = {}) {
    // Prefer explicit short
    if (item.degreeShort && DEGREE_MAP[item.degreeShort]) return item.degreeShort;
    // Infer from long name
    if (item.degreeLong) {
      const hit = DEGREE_OPTIONS.find(d => d.long.toLowerCase() === String(item.degreeLong).toLowerCase());
      if (hit) return hit.short;
    }
    // Legacy single-string `degree`
    if (item.degree) {
      const s = String(item.degree).trim();
      const byShort = DEGREE_OPTIONS.find(d => d.short.toLowerCase() === s.toLowerCase());
      if (byShort) return byShort.short;
      const byLong = DEGREE_OPTIONS.find(d => d.long.toLowerCase() === s.toLowerCase());
      if (byLong) return byLong.short;
    }
    return ""; // none selected
  }
  
function setStatus(s){ statusEl.textContent = s; }

let _statusTimer = null;
function flashStatus(text, ms = 2500){
  if (!statusEl) return;
  statusEl.textContent = text;
  if (_statusTimer) clearTimeout(_statusTimer);
  _statusTimer = setTimeout(() => {
    // only clear if unchanged (so errors or newer messages persist)
    if (statusEl.textContent === text) statusEl.textContent = "";
  }, ms);
}

/* ---------- helpers to render repeating rows ---------- */
function monthYearRow(prefix, item={}){
    const camel = (s)=> s.charAt(0).toLowerCase()+s.slice(1); // Start -> start
    const keyM = `${camel(prefix)}Month`;  // startMonth / endMonth
    const keyY = `${camel(prefix)}Year`;   // startYear  / endYear
  
    const wrap = document.createElement("div");
    wrap.className = "grid";
    wrap.style.marginTop = "6px";
    wrap.innerHTML = `
      <div>
        <label>${prefix} Month</label>
        <select data-k="${keyM}"></select>
      </div>
      <div>
        <label>${prefix} Year</label>
        <select data-k="${keyY}"></select>
      </div>
    `;
    const mSel = wrap.querySelector(`[data-k="${keyM}"]`);
    const ySel = wrap.querySelector(`[data-k="${keyY}"]`);
    mSel.innerHTML = `<option value="">—</option>` + MONTHS.map((m,i)=>`<option value="${i+1}">${m}</option>`).join("");
    ySel.innerHTML = `<option value="">—</option>` + YEARS.map(y=>`<option>${y}</option>`).join("");
  
    // preselect if present
    if (item[keyM]) mSel.value = String(item[keyM]);
    if (item[keyY]) ySel.value = String(item[keyY]);
    return wrap;
  }  

  // --- Guard month/year pairs inside a container (e.g., an Education or Experience row)
  function wireDateBounds(scope){
    const sM = scope.querySelector('[data-k="startMonth"]');
    const sY = scope.querySelector('[data-k="startYear"]');
    const eM = scope.querySelector('[data-k="endMonth"]');
    const eY = scope.querySelector('[data-k="endYear"]');
    if (!sM || !sY || !eM || !eY) return;

    const refresh = () => {
      const sm = parseInt(sM.value || "0", 10) || 0;
      const sy = parseInt(sY.value || "0", 10) || 0;
      const em = parseInt(eM.value || "0", 10) || 0;
      const ey = parseInt(eY.value || "0", 10) || 0;

      // clear any previous disables
      [...sY.options].forEach(o => o.disabled = false);
      [...sM.options].forEach(o => o.disabled = false);
      [...eY.options].forEach(o => o.disabled = false);
      [...eM.options].forEach(o => o.disabled = false);

      // If END picked first → limit START to <= END (year), and months <= endMonth when same year
      if (ey) {
        [...sY.options].forEach(o => {
          const y = parseInt(o.value || "0", 10) || 0;
          if (y && y > ey) o.disabled = true;
        });
        if (em) {
          // only when same-year or start-year not chosen yet
          if (!sy || sy === ey) {
            [...sM.options].forEach(o => {
              const m = parseInt(o.value || "0", 10) || 0;
              if (m && m > em) o.disabled = true;
            });
          }
        }
      }

      // If START picked first → limit END to >= START (year), and months >= startMonth when same year
      if (sy) {
        [...eY.options].forEach(o => {
          const y = parseInt(o.value || "0", 10) || 0;
          if (y && y < sy) o.disabled = true;
        });
        if (sm) {
          if (!ey || ey === sy) {
            [...eM.options].forEach(o => {
              const m = parseInt(o.value || "0", 10) || 0;
              if (m && m < sm) o.disabled = true;
            });
          }
        }
      }

      // If a now-disabled value is selected, clear it so the user sees the constraint
      if (sY.selectedOptions[0]?.disabled) sY.value = "";
      if (sM.selectedOptions[0]?.disabled) sM.value = "";
      if (eY.selectedOptions[0]?.disabled) eY.value = "";
      if (eM.selectedOptions[0]?.disabled) eM.value = "";
    };

    [sM, sY, eM, eY].forEach(el => el.addEventListener("change", refresh));
    refresh();
  }

  function eduItemView(item = {}, idx) {
    const wrap = document.createElement("div");
    wrap.className = "item";
    const degVal = resolveDegreeValue(item); // "BS", "BA", ...
  
    // Build degree options HTML
    const optsHtml = ['<option value="">—</option>']
      .concat(DEGREE_OPTIONS.map(d => `<option value="${d.short}">${d.label}</option>`))
      .join("");
  
    wrap.innerHTML = `
      <div class="grid">
        <div><label>School</label><input data-k="school" value="${item.school || ""}"></div>
  
        <div>
          <label>Degree</label>
          <select data-k="degreeCombo">${optsHtml}</select>
        </div>
  
        <div><label>Field</label><input data-k="field" value="${item.field || ""}"></div>
        <div><label>GPA</label><input data-k="gpa" value="${item.gpa || ""}"></div>
      </div>
    `;
  
    // Month/Year rows
    const dates = document.createElement("div");
    dates.appendChild(monthYearRow("Start", item));

    // Build a normal "End" row, then rename labels to "End / Expected Graduation"
    const endRow = monthYearRow("End", item);
    const labs = endRow.querySelectorAll("label");
    if (labs[0]) labs[0].textContent = "End / Expected Graduation Month";
    if (labs[1]) labs[1].textContent = "End / Expected Graduation Year";
    dates.appendChild(endRow);

    wrap.appendChild(dates);

    // Guard: keep Start <= End and End >= Start
    wireDateBounds(dates);
  
    // preselect degree
    const sel = wrap.querySelector('[data-k="degreeCombo"]');
    if (degVal) sel.value = degVal;
  
    // footer
    const row = document.createElement("div");
    row.className = "row"; row.style.marginTop = "8px";
    row.innerHTML = `<button class="btn" data-del>Delete</button><span class="muted">Education #${idx + 1}</span>`;
    wrap.appendChild(row);
  
    return wrap;
  }  

  function expItemView(item = {}, idx){
    const wrap = document.createElement("div");
    wrap.className = "item";
    wrap.innerHTML = `
      <div class="grid">
        <div><label>Company</label><input data-k="company" value="${item.company||""}"></div>
        <div><label>Job Title</label><input data-k="jobTitle" value="${item.jobTitle||""}"></div>
        <div class="full"><label>Description</label><textarea data-k="description">${item.description||""}</textarea></div>
      </div>
    `;
  
    // Month/Year rows
    const dates = document.createElement("div");
    dates.appendChild(monthYearRow("Start", item));
    dates.appendChild(monthYearRow("End",   item));
    wrap.appendChild(dates);

    // Guard: keep Start <= End and End >= Start
    wireDateBounds(dates);
      
    // "Currently work here" checkbox
    const cur = document.createElement("div");
    cur.className = "row";
    cur.style.marginTop = "6px";
    cur.innerHTML = `
      <label class="row" style="gap:6px; align-items:center;">
        <input type="checkbox" data-k="isCurrent">
        <span>Currently work here</span>
      </label>
    `;
    wrap.appendChild(cur);
  
    // Wire up disable/enable of End selectors
    const curBox     = cur.querySelector('[data-k="isCurrent"]');
    const endMonthEl = dates.querySelector('[data-k="endMonth"]');
    const endYearEl  = dates.querySelector('[data-k="endYear"]');
  
    if (item.isCurrent === true) curBox.checked = true;
  
    const applyDisable = () => {
      const on = !!curBox.checked;
      if (endMonthEl) endMonthEl.disabled = on;
      if (endYearEl)  endYearEl.disabled  = on;
    };
    applyDisable();
    curBox.addEventListener("change", applyDisable);
  
    // Footer
    const row = document.createElement("div");
    row.className = "row"; row.style.marginTop = "8px";
    row.innerHTML = `<button class="btn" data-del>Delete</button><span class="muted">Experience #${idx+1}</span>`;
    wrap.appendChild(row);
    return wrap;
  }  

function renderArray(container, arr, itemView){
  container.innerHTML = "";
  arr.forEach((item, idx) => {
    const row = itemView(item, idx);
    row.querySelector("[data-del]")?.addEventListener("click", ()=>{
      arr.splice(idx,1);
      renderArray(container, arr, itemView);
    });
    container.appendChild(row);
  });
}

/* ---------- load / save ---------- */
async function load(){
    let data = {};
    try {
      const r = await fetchWithFailoverP("/profile");
      if (r.ok) data = await r.json();
    } catch (e) {
      console.warn("[profile] backend /profile error:", e);
    }
  
    // ---- render into the form (unchanged) ----
    $("firstName").value = data?.personal?.firstName || "";
    $("lastName").value  = data?.personal?.lastName  || "";
    $("email").value     = data?.personal?.email     || "";
    $("phoneNumber").value = data?.personal?.phoneNumber || "";
    $("dob").value       = data?.personal?.dob       || "";
    $("gender").value    = data?.personal?.gender    || "";
  
    $("street").value  = data?.address?.street  || "";
    $("city").value    = data?.address?.city    || "";
    $("county").value  = data?.address?.county  || "";   
    $("state").value   = data?.address?.state   || "";
    $("zip").value     = data?.address?.zip     || "";
    $("country").value = data?.address?.country || "";
  
    $("linkedin").value = data?.links?.linkedin || "";
    $("github").value   = data?.links?.github   || "";
    $("website").value  = data?.links?.website  || "";
  
    const radioCheck = (name, val) => {
      if (!val) return;
      const el = document.querySelector(`input[name="${name}"][value="${val}"]`);
      if (el) {
        el.checked = true;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    radioCheck("authUS", data?.eligibility?.authUS);
    radioCheck("authCA", data?.eligibility?.authCA);
    radioCheck("authUK", data?.eligibility?.authUK);
    radioCheck("sponsorship", data?.eligibility?.sponsorship);
  
    $("disability").value = data?.eligibility?.disability || "";
    $("lgbtq").value      = data?.eligibility?.lgbtq || "";
    $("veteran").value    = data?.eligibility?.veteran || "";
    $("ethnicity").value  = data?.eligibility?.ethnicity || "";
    $("race").value           = data?.eligibility?.race || "";
    $("hispanicLatinx").value = data?.eligibility?.hispanicLatinx || "";
    $("yearsOfExperience").value = (data?.yearsOfExperience || data?.meta?.yearsOfExperience || "");
    // Highest Education (prefer saved, otherwise infer from education[])
    const he = data?.highestEducation || highestFromEducation(Array.isArray(data?.education) ? data.education : []);
    const heSel = document.getElementById("highestEducation");
    if (heSel) heSel.value = he;

    window._edu = Array.isArray(data.education) ? data.education.slice() : [];
    window._exp = Array.isArray(data.experience) ? data.experience.slice() : [];
    renderArray($("eduList"), window._edu, eduItemView);
    renderArray($("expList"), window._exp, expItemView);

    setStatus("Loaded from backend.");
    await initProfileResumeDropdown(data);
    window._loadedProfile = data;
  }  
  
  

function collectMain(){
  const radioVal = name => (document.querySelector(`input[name="${name}"]:checked`)?.value || "");
  return {
    personal: {
      firstName: $("firstName").value.trim(),
      lastName: $("lastName").value.trim(),
      email: $("email").value.trim(),
      phoneNumber: $("phoneNumber").value.trim(),
      dob: $("dob").value.trim(),                        // YYYY-MM-DD from <input type=date>
      gender: $("gender").value.trim()
    },
    address: {
      street: $("street").value.trim(),
      city: $("city").value.trim(),
      county: $("county").value.trim(),     
      state: $("state").value.trim(),
      zip: $("zip").value.trim(),
      country: $("country").value.trim()
    },    
    links: {
      linkedin: $("linkedin").value.trim(),
      github: $("github").value.trim(),
      website: $("website").value.trim()
    },
    eligibility: {
      authUS: radioVal("authUS"),
      authCA: radioVal("authCA"),
      authUK: radioVal("authUK"),
      sponsorship: radioVal("sponsorship"),
      disability: $("disability").value.trim(),
      lgbtq: $("lgbtq").value.trim(),
      veteran: $("veteran").value.trim(),
      ethnicity: $("ethnicity").value.trim(),
      race: $("race").value.trim(),                       
      hispanicLatinx: $("hispanicLatinx").value.trim()    
    },
    highestEducation: (document.getElementById("highestEducation")?.value || "").trim(),
    yearsOfExperience: (document.getElementById("yearsOfExperience")?.value || "").trim(),
  };
}

$("addEdu").addEventListener("click", () => {
    (window._edu ||= []).push({
      school: "", field: "", gpa: "",
      // degree stored via degreeCombo on UI; short/long computed when saving
      startMonth: "", startYear: "", endMonth: "", endYear: ""
    });
    renderArray($("eduList"), window._edu, eduItemView);
  });  
  
$("addExp").addEventListener("click", ()=>{
    (window._exp ||= []).push({
      company:"", jobTitle:"", description:"",
      startMonth:"", startYear:"", endMonth:"", endYear:"",
      isCurrent: false
    });
    renderArray($("expList"), window._exp, expItemView);
    });  

    $("save").addEventListener("click", async ()=>{
      const out = collectMain();
    
      // Ensure these exist at the top level (used by filler)
      out.yearsOfExperience = (document.getElementById("yearsOfExperience")?.value || "").trim();
      out.highestEducation  = (document.getElementById("highestEducation")?.value || "").trim();
    
      // ===== education array =====
      out.education = [];
      $("eduList").querySelectorAll(".item").forEach(item => {
        const g = {};
        // Collect all simple fields with data-k
        item.querySelectorAll("[data-k]").forEach(inp => {
          const k = inp.getAttribute("data-k");
          let v = (inp.value || "").trim();
          // We don't keep degreeCombo in the final object; we'll map it to short/long below
          if (k !== "degreeCombo") g[k] = v;
        });
    
        // Pull degree selection and map to short/long
        const degShort = (item.querySelector('[data-k="degreeCombo"]')?.value || "").trim();
        if (degShort) {
          g.degreeShort = degShort;
          g.degreeLong  = DEGREE_MAP[degShort] || "";
        } else {
          g.degreeShort = "";
          g.degreeLong  = "";
        }
    
        out.education.push(g);
      });
    
      // ===== experience array =====
      out.experience = [];
      $("expList").querySelectorAll(".item").forEach(item=>{
        const g = {};
        item.querySelectorAll("[data-k]").forEach(inp=>{
          const k = inp.getAttribute("data-k");
          let v;
          if (inp.type === "checkbox") {
            v = !!inp.checked;                 
          } else {
            v = (inp.value || "").trim();
          }
          g[k] = v;
        });

        out.experience.push(g);
      });

    
      // ===== Selected Resume (compute skills locally) =====
      const sel    = document.getElementById("profileResumeSelect");
      const loaded = (window._loadedProfile || {});
      let   sr     = window._pendingResume; // if user changed during this session

      // If no pending but a UI selection exists, use it
      if (!sr && sel && sel.value) {
        const name = sel.options[sel.selectedIndex]?.textContent || sel.value;
        sr = { id: sel.value, name, skills: [] }; // skills will be computed below
      }

      // If still nothing, fall back to what profile had
      if (!sr && loaded?.selectedResumeId) {
        sr = {
          id: String(loaded.selectedResumeId),
          name: loaded.selectedResumeName || "",
          skills: Array.isArray(loaded.selectedResumeSkills)
            ? loaded.selectedResumeSkills
            : []
        };
      }

      // Compute skills if we have an id (purely local → no /skills/* calls)
      if (sr && sr.id) {
        if (!Array.isArray(sr.skills) || !sr.skills.length) {
          try {
            const textRes = await _getResumeText(sr.id);
            sr.skills = _extractAllSkillsFromText(textRes);
          } catch (e) {
            console.warn("[profile] skills compute failed (local):", e);
            sr.skills = Array.isArray(sr.skills) ? sr.skills : [];
          }
        }
      }
    
      if (sr) {
        out.selectedResumeId     = String(sr.id || "");
        out.selectedResumeName   = String(sr.name || "");
        out.selectedResumeSkills = Array.from(new Set(sr.skills || [])).sort();
        try {
          await chrome.storage.local.set({
            lastResumeId: out.selectedResumeId,
            selectedResume: {
              id: out.selectedResumeId,
              name: out.selectedResumeName,
              skills: out.selectedResumeSkills
            }
          });
        } catch {}
      } else {
        // Explicitly clear if nothing is selected
        out.selectedResumeId = "";
        out.selectedResumeName = "";
        out.selectedResumeSkills = [];
        try {
          await chrome.storage.local.set({
            lastResumeId: "",
            selectedResume: { id:"", name:"", skills:[] }
          });
        } catch {}
      }
    
      // ===== remove matchedSkills from payload =====
      if (out.matchedSkills) delete out.matchedSkills;
    
      // ===== Save to backend (/profile) — MERGE, don't replace =====
      try{
        const r = await fetchWithFailoverP(`/profile`, {
          method: "PATCH",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify(out)
        });        
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setStatus("Saved to backend!");
        flashStatus("Saved to backend.", 1500);

        // === mirror the entire updated profile to storage and broadcast ===
        try {
          // `out` is the profile you just constructed & PATCHed above
          await chrome.storage.local.set({
            userData: out,
            profileVersion: Date.now()
          });
          // tell all extension pages & content scripts the profile is fresh
          chrome.runtime.sendMessage({
            type: "SFF_PROFILE_UPDATED",
            profile: out,
            ts: Date.now()
          });
          console.log("[profile] broadcasted SFF_PROFILE_UPDATED and mirrored userData");
        } catch (e) {
          console.warn("[profile] failed to mirror/broadcast updated profile:", e);
        }
        window._pendingResume = null; // clear pending after successful save
      }catch(e){
        console.error(e);
        setStatus("Save failed (backend).");
      }
    });    

document.addEventListener("DOMContentLoaded", () => {
  load().catch(err => console.warn("[profile] load() failed:", err));
});
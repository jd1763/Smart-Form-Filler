// ===============================
// Option A: Background is resolver
// profile.js must NOT probe ports.
// ===============================

let BACKEND_BASE = null;
let CURRENT_PREF = "v1";
let LAST_RESOLVE_TS = 0;

function bgGetBackendStatus(forceReprobe = false) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { action: "getBackendStatus", forceReprobe: !!forceReprobe },
        (res) => resolve(res || null)
      );
    } catch {
      resolve(null);
    }
  });
}

async function ensureBackendResolved(force = false) {
  const now = Date.now();
  if (!force && BACKEND_BASE && (now - LAST_RESOLVE_TS) < 5000) {
    return { ok: true, base: BACKEND_BASE, pref: CURRENT_PREF };
  }

  const res = await bgGetBackendStatus(force);
  if (!res || !res.success) {
    BACKEND_BASE = null;
    CURRENT_PREF = "v1";
    LAST_RESOLVE_TS = now;
    return { ok: false, base: null, pref: "v1" };
  }

  CURRENT_PREF = res.pref === "v2" ? "v2" : "v1";
  BACKEND_BASE = res.base ? String(res.base).replace(/\/+$/, "") : null;
  LAST_RESOLVE_TS = now;

  // optional: keep for debugging only; not used for routing
  if (BACKEND_BASE) {
    try { localStorage.setItem("backend_base", BACKEND_BASE); } catch {}
  }

  return { ok: !!res.ok, base: BACKEND_BASE, pref: CURRENT_PREF };
}

async function getAccessTokenP() {
  // token may exist, but we only use it when CURRENT_PREF === "v2"
  try {
    const r = await chrome.storage.local.get(["sff_access_token"]);
    return r.sff_access_token || null;
  } catch {
    return await new Promise((resolve) => {
      try {
        chrome.storage.local.get(["sff_access_token"], (r) => resolve((r && r.sff_access_token) || null));
      } catch {
        resolve(null);
      }
    });
  }
}

async function getTokenIfV2() {
  if (CURRENT_PREF !== "v2") return null;
  return await getAccessTokenP();
}

async function fetchWithFailoverP(path, opts) {
  const sel = await ensureBackendResolved(false);
  if (!sel.base) throw new Error(`No backend base available (pref=${sel.pref}). Start the backend.`);

  const token = sel.pref === "v2" ? await getTokenIfV2() : null;

  const mergedHeaders = Object.assign({ "Accept": "application/json" }, (opts && opts.headers) || {});
  if (token && !mergedHeaders["Authorization"]) mergedHeaders["Authorization"] = `Bearer ${token}`;

  const finalOpts = Object.assign({ credentials: "omit", cache: "no-store" }, opts || {});
  finalOpts.headers = mergedHeaders;

  try {
    const r = await fetch(`${sel.base}${path}`, finalOpts);
    if (r.ok) return r;
    throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    // retry once after forcing background to re-probe ports
    const sel2 = await ensureBackendResolved(true);
    if (!sel2.base) throw e;

    const token2 = sel2.pref === "v2" ? await getTokenIfV2() : null;
    const mergedHeaders2 = Object.assign({ "Accept": "application/json" }, (opts && opts.headers) || {});
    if (token2 && !mergedHeaders2["Authorization"]) mergedHeaders2["Authorization"] = `Bearer ${token2}`;

    const finalOpts2 = Object.assign({ credentials: "omit", cache: "no-store" }, opts || {});
    finalOpts2.headers = mergedHeaders2;

    const r2 = await fetch(`${sel2.base}${path}`, finalOpts2);
    if (r2.ok) return r2;
    throw new Error(`HTTP ${r2.status} (after reprobe)`);
  }
}

const $ = id => document.getElementById(id);
const statusEl = $("status");

// ===== Skills extraction (shared) =====
// Uses skills_whitelist.js + skill_terms.txt (single source of truth)
async function _skillsFromTextShared(text) {
  try {
    if (window.SkillsWhitelist && typeof window.SkillsWhitelist.extractFromText === "function") {
      return await window.SkillsWhitelist.extractFromText(text || "");
    }
  } catch (e) {
    console.warn("[profile] SkillsWhitelist.extractFromText failed:", e);
  }
  return [];
}

async function _getProfile(){
  try {
    const r = await fetchWithFailoverP(`/profile`);
    const raw = r.ok ? await r.json() : {};

    if (raw && typeof raw === "object") {
      if (raw.profile && typeof raw.profile === "object") return raw.profile;
      if (raw.data && raw.data.profile && typeof raw.data.profile === "object") return raw.data.profile;

      // also accept { data: { ...actual profile... } }
      if (raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)) return raw.data;
    }

    return raw || {};
  } catch {
    return {};
  }
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
    const js = r.ok ? await r.json() : null;

    const arr =
      Array.isArray(js) ? js :
      Array.isArray(js?.items) ? js.items :
      Array.isArray(js?.resumes) ? js.resumes :
      Array.isArray(js?.files) ? js.files :
      [];

    const extractName = (v) => {
      if (!v) return "";
      const s = String(v);
      const noQuery = s.split("?")[0];
      return noQuery.split("/").pop().split("\\").pop() || s;
    };

    return arr
      .map((it) => {
        if (typeof it === "string") {
          const id = it;
          return { id: String(id), name: extractName(it) || String(id) };
        }
        const id = String(it?.id || it?.resume_id || it?.resumeId || it?.uuid || it?.path || it?.file_path || "").trim();
        if (!id) return null;
        const rawName = it?.original_name || it?.originalName || it?.name || it?.filename || it?.path || it?.file_path || id;
        return { id, name: extractName(rawName) || id };
      })
      .filter(Boolean);
  } catch (e) {
    console.warn("[profile] _listResumes failed:", e);
    return [];
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
    const skills = await _skillsFromTextShared(text);

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

  document.getElementById("profileExtractSkills")?.addEventListener("click", async ()=>{
    const status = document.getElementById("profileSkillsStatus");
    const txt = document.getElementById("profileResumeText")?.value || "";
  
    const skills = await _skillsFromTextShared(txt);
  
    // Put them in both buckets (your content script unions them)
    profileMatched.required  = skills.slice();
    profileMatched.preferred = skills.slice();
    renderProfileSkillChips();
  
    if (status) status.textContent = `Found ${skills.length} skills`;
  
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

  function _normalizeYearsOfExperience(v) {
    const s = String(v ?? "").trim();
    if (!s) return "";
    // support old stored "10+" and always store numeric-ish strings
    return s.endsWith("+") ? s.slice(0, -1) : s;
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
        <div>
          <label>GPA</label>
          <input
            type="number"
            min="0"
            max="4"
            step="0.01"
            inputmode="decimal"
            data-k="gpa"
            value="${item.gpa || ""}"
          >
        </div>      
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
  // Always resolve base first so status text can be accurate
  const sel = await ensureBackendResolved(true);

  // Use the unwrapping helper so v1/v2 response shapes both work
  const data = await _getProfile();

  // ---- render into the form ----
  $("firstName").value = data?.personal?.firstName || "";
  $("lastName").value  = data?.personal?.lastName  || "";
  $("email").value     = data?.personal?.email     || "";

  // If the profile doesn't have an email yet, prefill from signed-in account (/auth/me)
  // ONLY when current backend mode is v2.
  try {
    if (sel.pref === "v2" && !$("email").value.trim()) {
      const token = await getTokenIfV2();
      if (token) {
        const meR = await fetchWithFailoverP("/auth/me");
        if (meR.ok) {
          const me = await meR.json();
          const authEmail = (me && me.email ? String(me.email) : "").trim();
          if (authEmail) $("email").value = authEmail;
        }
      }
    }
  } catch {}

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

  const yoRaw = (data?.yearsOfExperience ?? data?.meta?.yearsOfExperience ?? "");
  $("yearsOfExperience").value = _normalizeYearsOfExperience(yoRaw);

  // Highest Education (prefer saved, otherwise infer from education[])
  const he = data?.highestEducation || highestFromEducation(Array.isArray(data?.education) ? data.education : []);
  const heSel = document.getElementById("highestEducation");
  if (heSel) heSel.value = he;

  window._edu = Array.isArray(data.education) ? data.education.slice() : [];
  window._exp = Array.isArray(data.experience) ? data.experience.slice() : [];
  renderArray($("eduList"), window._edu, eduItemView);
  renderArray($("expList"), window._exp, expItemView);

  // status includes pref + base so we can PROVE what backend we read
  setStatus(`Loaded from ${sel.pref} @ ${sel.base || "(no base)"}`);
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
    yearsOfExperience: _normalizeYearsOfExperience(document.getElementById("yearsOfExperience")?.value || ""),
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
      out.yearsOfExperience = _normalizeYearsOfExperience(document.getElementById("yearsOfExperience")?.value || "");
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
            sr.skills = await _skillsFromTextShared(textRes);
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
            profile: out,
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

    document.addEventListener("DOMContentLoaded", async () => {
      try { await ensureBackendResolved(true); } catch {}
      load().catch(err => console.warn("[profile] load() failed:", err));
    });
    
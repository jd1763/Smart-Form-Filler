const BACKEND_BASE = localStorage.getItem("backend_base") || "http://127.0.0.1:5000";
const $ = id => document.getElementById(id);
const statusEl = $("status");
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
    dates.appendChild(monthYearRow("End", item));
    wrap.appendChild(dates);
  
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

function expItemView(item={}, idx){
  const wrap = document.createElement("div");
  wrap.className = "item";
  wrap.innerHTML = `
    <div class="grid">
      <div><label>Company</label><input data-k="company" value="${item.company||""}"></div>
      <div><label>Job Title</label><input data-k="jobTitle" value="${item.jobTitle||""}"></div>
      <div class="full"><label>Description</label><textarea data-k="description">${item.description||""}</textarea></div>
    </div>
  `;
  const dates = document.createElement("div");
  dates.appendChild(monthYearRow("Start", item));
  dates.appendChild(monthYearRow("End",   item));
  wrap.appendChild(dates);

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
      const r = await fetch(`${BACKEND_BASE}/profile`);
      if (r.ok) data = await r.json();
    } catch (e) {
      console.warn("[profile] backend /profile error:", e);
    }
  
    // Seed from packaged JSON only if backend returned empty
    if (!data || Object.keys(data).length === 0) {
      try {
        const url = chrome.runtime.getURL("data/userData.json"); // extension/data/userData.json (read-only)
        const resp = await fetch(url);
        data = await resp.json();
        // seed backend so next loads are from server
        await fetch(`${BACKEND_BASE}/profile`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data)
        });
        console.log("[profile] Seeded backend /profile from packaged JSON.");
      } catch (e) {
        console.warn("[profile] Could not seed default profile:", e);
        data = {};
      }
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
  
    const radioCheck = (name, val) => val && document.querySelector(`input[name="${name}"][value="${val}"]`)?.setAttribute("checked","checked");
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
  
    window._edu = Array.isArray(data.education) ? data.education.slice() : [];
    window._exp = Array.isArray(data.experience) ? data.experience.slice() : [];
    renderArray($("eduList"), window._edu, eduItemView);
    renderArray($("expList"), window._exp, expItemView);
  
    setStatus("Loaded from backend.");
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
    }    
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
      startMonth:"", startYear:"", endMonth:"", endYear:""
    });
    renderArray($("expList"), window._exp, expItemView);
    });  

$("save").addEventListener("click", async ()=>{
    const out = collectMain();
  
    // education array
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
        g.degreeLong = DEGREE_MAP[degShort] || "";
    } else {
        g.degreeShort = "";
        g.degreeLong  = "";
    }

    out.education.push(g);
    });

    // experience array
    out.experience = [];
    $("expList").querySelectorAll(".item").forEach(item=>{
    const g = {};
    item.querySelectorAll("[data-k]").forEach(inp=>{
        const k = inp.getAttribute("data-k");
        g[k] = (inp.value || "").trim();
    });
    out.experience.push(g);
    });

    try{
      const r = await fetch(`${BACKEND_BASE}/profile`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(out)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus("Saved to backend!");
    }catch(e){
      console.error(e);
      setStatus("Save failed (backend).");
    }
  });  

// boot
load().catch(e=> setStatus("Load error: "+e));

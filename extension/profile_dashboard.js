/* global React, ReactDOM */
const h = React.createElement;

// ===============================
// Background is resolver
// profile_dashboard.js must NOT probe ports.
// ===============================
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
  
  async function getAccessTokenPD() {
    try {
      const r = await chrome.storage.local.get(["sff_access_token"]);
      return r.sff_access_token || null;
    } catch {
      return null;
    }
  }
  
  // apiFetch that always uses (base,pref) returned by background.
  async function apiFetchPD(base, pref, path, opts = {}) {
    const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    if (pref === "v2") {
      const token = await getAccessTokenPD();
      if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
    }
    const finalOpts = Object.assign({ credentials: "omit", cache: "no-store" }, opts, { headers });
    return fetch(`${base}${path}`, finalOpts);
  }  

function normalizeResumes(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.resumes)) return payload.resumes;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && Array.isArray(payload.data.resumes)) return payload.data.resumes;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.files)) return payload.files;
  return [];
}

function unwrapProfilePayload(payload) {
    if (!payload || typeof payload !== "object") return {};
    // Some backends wrap as { profile: {...} } or { data: { profile: {...} } }
    if (payload.profile && typeof payload.profile === "object") return payload.profile;
    if (payload.data && payload.data.profile && typeof payload.data.profile === "object") return payload.data.profile;
    return payload;
  }  

function extractFileName(v) {
  if (!v) return "";
  const s = String(v);
  const noQuery = s.split("?")[0];
  const last = noQuery.split("/").pop().split("\\").pop();
  return last || s;
}

function resumeIdOf(r) {
    if (typeof r === "string") return r; // v1 may return ["./data/resume.pdf", ...]
    return (
      r?.id ||
      r?.resume_id ||
      r?.resumeId ||
      r?.uuid ||
      r?.resumeUUID ||
      r?.resumeUuid ||
      r?.path ||
      r?.file_path ||
      ""
    );
  }  

  function resumeLabelOf(r) {
    if (typeof r === "string") return extractFileName(r);
  
    const raw =
      r?.originalName ||
      r?.original_name ||
      r?.original_filename ||
      r?.fileName ||
      r?.filename ||
      r?.name ||
      r?.displayName ||
      r?.display_name ||
      r?.title ||
      r?.path ||
      r?.file_path ||
      r?.url ||
      r?.location ||
      "";
  
    return (
      extractFileName(raw) ||
      (resumeIdOf(r) ? `Resume ${String(resumeIdOf(r)).slice(0, 8)}` : "Resume")
    );
  }  

function initialFromProfile(profile) {
  const email = profile?.personal?.email || profile?.personal?.emailAddress || "";
  const fn = profile?.personal?.firstName || "";
  const ln = profile?.personal?.lastName || "";
  const ch = (fn || ln || email || "?").trim().charAt(0).toUpperCase();
  return ch || "?";
}

function _isFilled(v) {
    // Treat 0 and false as valid “answered”
    if (v === 0) return true;
    if (v === false) return true;
    const s = String(v ?? "").trim();
    return s.length > 0;
  }
  
  function computeDashboardCompletion(profile, resumes) {
    const p = profile || {};
    const personal = p.personal || {};
    const email = personal.email || personal.emailAddress;
    const address = p.address || {};
    const elig = p.eligibility || {};
    const links = p.links || {};
  
    // “All personal questions” (Personal + Address + Years of Experience)
    const personalFields = [
      personal.firstName,
      personal.lastName,
      email,
      personal.phoneNumber,
      personal.dob,
      personal.gender,
      p.yearsOfExperience,
  
      address.street,
      address.city,
      address.county,
      address.state,
      address.zip,
      address.country,
    ];
  
    // “All eligibility questions” (matches the UI in this file)
    const eligibilityFields = [
      elig.authUS,
      elig.authCA,
      elig.authUK,
      elig.sponsorship,
      elig.disability,
      elig.lgbtq,
      elig.veteran,
      elig.race,
      elig.hispanicLatinx,
      elig.ethnicity,
    ];
  
    const personalFilled = personalFields.filter(_isFilled).length;
    const eligFilled = eligibilityFields.filter(_isFilled).length;
  
    const hasResume = Array.isArray(resumes) && resumes.length > 0;
    const hasExperience = Array.isArray(p.experience) && p.experience.length > 0;
    const hasEducation = Array.isArray(p.education) && p.education.length > 0;
  
    // Per-section %
    const personalPct = Math.round(100 * (personalFilled / Math.max(1, personalFields.length)));
    const eligibilityPct = Math.round(100 * (eligFilled / Math.max(1, eligibilityFields.length)));
    const resumePct = hasResume ? 100 : 0;
    const experiencePct = hasExperience ? 100 : 0;
    const educationPct = hasEducation ? 100 : 0;
  
    // Links are informational (not required for 100%)
    const linksFields = [links.linkedin, links.github, links.website];
    const linksFilled = linksFields.filter(_isFilled).length;
    const linksPct = Math.round(100 * (linksFilled / Math.max(1, linksFields.length)));
  
    // Overall %
    const overallFields = [
      personalPct === 100,
      eligibilityPct === 100,
      hasResume,
      hasExperience,
      hasEducation,
    ];
    const overallFilled = overallFields.filter(Boolean).length;
    const overallPct = Math.round(100 * (overallFilled / Math.max(1, overallFields.length)));
  
    return {
      overallPct,
      personalPct,
      eligibilityPct,
      resumePct,
      experiencePct,
      educationPct,
      linksPct,
    };
  }  

// Month helpers (month picker -> stored as {startMonth,startYear,endMonth,endYear})
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function ymToParts(ym) {
  // ym is "YYYY-MM" from <input type="month">
  const s = String(ym || "").trim();
  if (!s || !s.includes("-")) return { year: "", month: "" };
  const [y, m] = s.split("-");
  const year = (y && /^\d{4}$/.test(y)) ? y : "";
  const month = (m && /^\d{2}$/.test(m)) ? String(parseInt(m, 10) || "") : "";
  return { year, month };
}

function partsToYM(year, month) {
  const y = String(year || "").trim();
  const m = String(month || "").trim();
  if (!y || !m) return "";
  const mm = String(parseInt(m, 10)).padStart(2, "0");
  return `${y}-${mm}`;
}

function fmtMonthYear(month, year) {
  const m = parseInt(month || "0", 10);
  const y = String(year || "").trim();
  if (!m || !y) return "";
  return `${MONTHS_SHORT[m - 1]} ${y}`;
}

function fmtRange(sm, sy, em, ey, isCurrent) {
  const start = fmtMonthYear(sm, sy);
  const end = isCurrent ? "Present" : fmtMonthYear(em, ey);
  if (!start && !end) return "";
  if (!start) return end;
  if (!end) return start;
  return `${start} — ${end}`;
}

function yoeForUi(v) {
    const s = String(v ?? "").trim();
    if (!s) return "";
    // profile.js uses "10+" in a <select>, dashboard uses a numeric input.
    if (s === "10+") return "10";
    return s;
}
  
  function yoeForStorage(v) {
    const s = String(v ?? "").trim();
    if (!s) return "";
  
    // If user types a number >= 10, store "10+" so profile.js can display it.
    const n = parseInt(s, 10);
    if (!Number.isNaN(n)) {
      if (n >= 10) return "10+";
      if (n >= 0) return String(n);
    }
  
    // Allow already-normalized value
    if (s === "10+") return "10+";
    return s;
}  

function ymKey(year, month) {
    const y = parseInt(year || "0", 10);
    const m = parseInt(month || "0", 10);
    if (!y || !m) return null;
    return (y * 100) + m; // e.g. 202501
  }

  function ensureStartBeforeEnd(item) {
    // Mutates a shallow copy pattern (caller should clone first)
    const sk = ymKey(item.startYear, item.startMonth);
    const ek = ymKey(item.endYear, item.endMonth);
    if (sk && ek && sk > ek) {
      // Clamp end to start (production-friendly “prevent invalid order”)
      item.endYear = item.startYear;
      item.endMonth = item.startMonth;
    }
    return item;
}  

// Degree options (matches Edit My Answers style)
const DEGREE_OPTIONS = [
  { short: "",   label: "—" },
  { short: "HS", label: "High School (HS)" },
  { short: "AA", label: "Associate (AA)" },
  { short: "AS", label: "Associate (AS)" },
  { short: "BA", label: "Bachelor (BA)" },
  { short: "BS", label: "Bachelor (BS)" },
  { short: "MA", label: "Master (MA)" },
  { short: "MS", label: "Master (MS)" },
  { short: "MBA",label: "MBA" },
  { short: "PhD",label: "PhD" },
  { short: "Other", label: "Other" },
];

const DEGREE_MAP = {
  HS: "High School",
  AA: "Associate of Arts",
  AS: "Associate of Science",
  BA: "Bachelor of Arts",
  BS: "Bachelor of Science",
  MA: "Master of Arts",
  MS: "Master of Science",
  MBA: "Master of Business Administration",
  PhD: "Doctor of Philosophy",
  Other: "Other",
};

// Highest Education (matches Edit My Answers values)
const HIGHEST_EDU_OPTIONS = [
    "",
    "High School",
    "Certificate",
    "Diploma",
    "Associate's",
    "Bachelor's",
    "Master's",
    "MBA",
    "Doctorate",
  ];
  
  function deriveHighestEducationFromEducation(eduArr) {
    const rank = {
      "High School": 1,
      "Certificate": 2,
      "Diploma": 2,
      "Associate's": 3,
      "Bachelor's": 4,
      "Master's": 5,
      "MBA": 5,
      "Doctorate": 6,
    };
  
    const shortToHighest = {
      HS: "High School",
      AA: "Associate's",
      AS: "Associate's",
      BA: "Bachelor's",
      BS: "Bachelor's",
      MA: "Master's",
      MS: "Master's",
      MBA: "MBA",
      PhD: "Doctorate",
    };
  
    let best = "";
    let bestScore = 0;
  
    const arr = Array.isArray(eduArr) ? eduArr : [];
    for (const raw of arr) {
      const it = normEduItem(raw);
      let he = "";
  
      const ds = String(it.degreeShort || "").trim();
      if (ds && shortToHighest[ds]) he = shortToHighest[ds];
  
      // Fallback: infer from long string if present
      if (!he) {
        const dl = String(it.degreeLong || "").toLowerCase();
        if (dl.includes("doctor")) he = "Doctorate";
        else if (dl.includes("mba")) he = "MBA";
        else if (dl.includes("master")) he = "Master's";
        else if (dl.includes("bachelor")) he = "Bachelor's";
        else if (dl.includes("associate")) he = "Associate's";
        else if (dl.includes("diploma")) he = "Diploma";
        else if (dl.includes("certificate")) he = "Certificate";
        else if (dl.includes("high school") || dl.includes("highschool")) he = "High School";
      }
  
      const s = rank[he] || 0;
      if (s > bestScore) {
        bestScore = s;
        best = he;
      }
    }
  
    return best;
  }  

// Normalize exp/edu from whatever shape is already stored
function normExpItem(it = {}) {
  return {
    company: it.company || it.employer || "",
    jobTitle: it.jobTitle || it.title || it.role || it.position || "",
    description: it.description || "",
    startMonth: it.startMonth || "",
    startYear: it.startYear || "",
    endMonth: it.endMonth || "",
    endYear: it.endYear || "",
    isCurrent: !!it.isCurrent,
  };
}

function normEduItem(it = {}) {
  const degreeShort = it.degreeShort || it.degree || it.degreeCode || "";
  return {
    school: it.school || it.institution || "",
    field: it.field || it.major || "",
    gpa: (it.gpa ?? "").toString(),
    degreeShort: degreeShort,
    degreeLong: it.degreeLong || (DEGREE_MAP[degreeShort] || ""),
    startMonth: it.startMonth || "",
    startYear: it.startYear || "",
    endMonth: it.endMonth || "",
    endYear: it.endYear || "",
  };
}

function viewBox(label, value) {
    const txt = (value === null || value === undefined) ? "" : String(value);
    const clean = txt.trim();
  
    return h("div", { className: "field" },
      h("label", null, label),
      h("div", {
        style: {
          marginTop: 6,
          fontSize: 14,
          fontWeight: 600,
          color: "#111827",
          lineHeight: "18px",
          wordBreak: "break-word"
        }
      }, clean || "—")
    );
}  

function radioYesNo(key, labelText, value, onChange, disabled) {
    const yesChecked = value === "Yes";
    const noChecked = value === "No";
  
    return h("div", { className: "field" },
      h("label", null, labelText),
      h("div", { style: { display: "flex", gap: 14, paddingTop: 4 } },
        h("label", { style: { display: "flex", gap: 6, alignItems: "center", cursor: disabled ? "default" : "pointer" } },
          h("input", {
            type: "radio",
            name: `elig_${key}`,
            checked: yesChecked,
            disabled,
            onChange: () => onChange("Yes"),
          }),
          "Yes"
        ),
        h("label", { style: { display: "flex", gap: 6, alignItems: "center", cursor: disabled ? "default" : "pointer" } },
          h("input", {
            type: "radio",
            name: `elig_${key}`,
            checked: noChecked,
            disabled,
            onChange: () => onChange("No"),
          }),
          "No"
        )
      )
    );
  }
  
  function selectField(key, labelText, value, options, onChange, disabled) {
    return h("div", { className: "field" },
      h("label", null, labelText),
      h("select", {
        value: value || "",
        disabled,
        onChange: (e) => onChange(e.target.value),
      },
        h("option", { value: "" }, "—"),
        ...(options || []).map((opt) => h("option", { key: String(opt), value: String(opt) }, String(opt)))
      )
    );
  }  

function App() {
    const [mode, setMode] = React.useState("v1"); // "v1" | "v2"
    const [base, setBase] = React.useState(null);    
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState("");

  const [section, setSection] = React.useState(() => {
    try {
      const started = sessionStorage.getItem("sff_profile_dash_started") === "1";
      if (started) return localStorage.getItem("sff_profile_dash_section") || "personal";
      return "personal";
    } catch {
      return "personal";
    }
  });  

  const [profile, setProfile] = React.useState({});
  const [resumes, setResumes] = React.useState([]);

  // Personal edit (personal + address)
  const [editingPersonal, setEditingPersonal] = React.useState(false);
  const [draftPersonal, setDraftPersonal] = React.useState({});
  const [draftAddress, setDraftAddress] = React.useState({});
  // Root fields (not inside personal/address)
  const [draftYearsOfExperience, setDraftYearsOfExperience] = React.useState("");

  // Links edit
  const [editingLinks, setEditingLinks] = React.useState(false);
  const [draftLinks, setDraftLinks] = React.useState({});

  // Eligibility edit
  const [editingEligibility, setEditingEligibility] = React.useState(false);
  const [draftEligibility, setDraftEligibility] = React.useState({});

  // Experience edit
  const [editingExperience, setEditingExperience] = React.useState(false);
  const [draftExperience, setDraftExperience] = React.useState([]);

  // Education edit
  const [editingEducation, setEditingEducation] = React.useState(false);
  const [draftEducation, setDraftEducation] = React.useState([]);
  const [draftHighestEducation, setDraftHighestEducation] = React.useState("");

  // Resume upload flow
  const [pendingResumeFile, setPendingResumeFile] = React.useState(null);
  const [uploadingResume, setUploadingResume] = React.useState(false);
  const [deletingResumeId, setDeletingResumeId] = React.useState("");

  // Debounce refresh when popup changes selection
  const refreshTimerRef = React.useRef(null);

  async function loadAll(b, pref) {
    setErr("");
    const pr = await apiFetchPD(b, pref, "/profile", { method: "GET" });
    if (!pr.ok) throw new Error(`GET /profile ${pr.status}`);
    const pjson = await pr.json();
  
    const rr = await apiFetchPD(b, pref, "/resumes", { method: "GET" });
    if (!rr.ok) throw new Error(`GET /resumes ${rr.status}`);
    const rjson = await rr.json();
  
    const prof = unwrapProfilePayload((pjson && typeof pjson === "object") ? pjson : {});
    const res = normalizeResumes(rjson);
  
    setProfile(prof);
    setResumes(res);
  
    setDraftPersonal(prof.personal ? { ...prof.personal } : {});
    setDraftAddress(prof.address ? { ...prof.address } : {});
    setDraftYearsOfExperience(yoeForUi(prof.yearsOfExperience || ""));
  
    setDraftLinks(prof.links ? { ...prof.links } : {});
    setDraftEligibility(prof.eligibility ? { ...prof.eligibility } : {});
    setDraftExperience(Array.isArray(prof.experience) ? prof.experience.map(normExpItem) : []);
  
    const eduArr = Array.isArray(prof.education) ? prof.education : [];
    setDraftEducation(eduArr.map(normEduItem));
  
    const derivedHE = deriveHighestEducationFromEducation(eduArr);
    setDraftHighestEducation(prof.highestEducation || derivedHE || "");
  
    return { prof, res };
  }  

  async function patchFullProfile(nextProfile) {
    const r = await apiFetchPD(base, mode, "/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextProfile),
    });
    if (!r.ok) throw new Error(`PATCH /profile ${r.status}`);
    const raw = await r.json();
    return unwrapProfilePayload(raw);
  }  

  async function savePersonal() {
    if (!base) return;
    setErr("");
    try {
        const next = Object.assign({}, profile || {});
        next.personal = Object.assign({}, next.personal || {}, draftPersonal || {});
        next.address  = Object.assign({}, next.address  || {}, draftAddress  || {});
        next.yearsOfExperience = yoeForStorage(draftYearsOfExperience);
        
        const saved = await patchFullProfile(next);
        setProfile(saved || next);
        
        setDraftPersonal((saved && saved.personal) ? { ...saved.personal } : { ...draftPersonal });
        setDraftAddress((saved && saved.address) ? { ...saved.address } : { ...draftAddress });
        const savedYOE = (saved && (saved.yearsOfExperience !== undefined)) ? (saved.yearsOfExperience || "") : (next.yearsOfExperience || "");
        setDraftYearsOfExperience(yoeForUi(savedYOE));
        
        setEditingPersonal(false);        
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  async function saveLinks() {
    if (!base) return;
    setErr("");
    try {
      const next = Object.assign({}, profile || {});
      next.links = Object.assign({}, next.links || {}, draftLinks || {});
      const saved = await patchFullProfile(next);
      setProfile(saved || next);
      setDraftLinks((saved && saved.links) ? { ...saved.links } : { ...draftLinks });
      setEditingLinks(false);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  async function saveEligibility() {
    if (!base) return;
    setErr("");
    try {
      const next = Object.assign({}, profile || {});
      next.eligibility = Object.assign({}, next.eligibility || {}, draftEligibility || {});
      const saved = await patchFullProfile(next);
      setProfile(saved || next);
      setDraftEligibility((saved && saved.eligibility) ? { ...saved.eligibility } : { ...draftEligibility });
      setEditingEligibility(false);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  async function saveExperience() {
    if (!base) return;
    setErr("");
    try {
      const next = Object.assign({}, profile || {});
      next.experience = (draftExperience || []).map(normExpItem);
      const saved = await patchFullProfile(next);
      setProfile(saved || next);
      setDraftExperience(Array.isArray((saved || next).experience) ? (saved || next).experience.map(normExpItem) : []);
      setEditingExperience(false);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  async function saveEducation() {
    if (!base) return;
    setErr("");
    try {
      const next = Object.assign({}, profile || {});
      next.education = (draftEducation || []).map(normEduItem);
      next.highestEducation = String(draftHighestEducation || "").trim();
      const saved = await patchFullProfile(next);
      setProfile(saved || next);
      setDraftEducation(Array.isArray((saved || next).education) ? (saved || next).education.map(normEduItem) : []);
      setDraftHighestEducation((saved && saved.highestEducation !== undefined) ? (saved.highestEducation || "") : (next.highestEducation || ""));
      setEditingEducation(false);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  async function uploadResume(file) {
    if (!base || !file) return;
      
    if ((resumes?.length || 0) >= 5) {
      setErr("Resume limit reached (5). Remove one before uploading another.");
      return;
    }
  
    const wasFirstResume = (resumes?.length || 0) === 0;
    const hadSelectedBefore = !!String(profile?.selectedResumeId || "").trim();
  
    setErr("");
    setUploadingResume(true);
  
    try {
      const fd = new FormData();
      fd.append("file", file);
  
      const r = await apiFetchPD(base, mode, "/resumes", { method: "POST", body: fd });
      if (!r.ok) throw new Error(`POST /resumes ${r.status}`);
  
      // Try to read the uploaded resume back from response (supports multiple shapes)
      let uploaded = null;
      try {
        const ct = String(r.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("application/json")) {
          const js = await r.json();
          uploaded = js?.resume || js?.item || js;
        }
      } catch (_) {}
  
      // Reload profile + resume list
      await loadAll(base, mode);
  
      // ✅ Auto-select only when this was the first resume uploaded (or no selection existed yet)
      // (This matches your “only/first resume” rule.)
      if (wasFirstResume && !hadSelectedBefore) {
        const rid = String(resumeIdOf(uploaded) || "").trim();
        if (rid) {
          await selectResume(uploaded);
        }
      }
  
      setSection("resume");
      try { localStorage.setItem("sff_profile_dash_section", "resume"); } catch {}
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setUploadingResume(false);
      setPendingResumeFile(null);
    }
  }  

  async function selectResume(r) {
    if (!base || !r) return;
    setErr("");
    try {
      const next = Object.assign({}, profile || {});
      const rid = String(resumeIdOf(r) || "");
      const name = String(resumeLabelOf(r) || "");

      next.selectedResumeId = rid;
      next.selectedResumeName = name;
      
      // Always compute from resume text (dashboard resume list doesn't include skills)
      next.selectedResumeSkills = await computeSkillsForResumeId(rid);      

      const saved = await patchFullProfile(next);
      const finalProf = saved || next;

      setProfile(finalProf);

      // Mirror selection so popup updates immediately
      try {
        const skillsRaw = Array.isArray(finalProf?.selectedResumeSkills) ? finalProf.selectedResumeSkills : [];
        const skills = Array.from(new Set(skillsRaw || [])).sort();        

        await chrome.storage.local.set({
          lastResumeId: rid,
          selectedResume: { id: rid, name, skills }
        });

        try { chrome.runtime.sendMessage({ action: "profile.updated" }); } catch (_) {}
      } catch (_) {}

      await loadAll(base, mode);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  async function deleteResume(r) {
    if (!base || !r) return;
    
    const rid = String(resumeIdOf(r) || "").trim();
    if (!rid) return;

    const name = resumeLabelOf(r);
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;

    setErr("");
    setDeletingResumeId(rid);

    try {
      const wasSelected = String(profile?.selectedResumeId || "") === rid;

      const del = await apiFetchPD(base, mode, `/resumes/${encodeURIComponent(rid)}`, {
        method: "DELETE",
      });      

      if (!del.ok) {
        let msg = `Delete failed (${del.status})`;
        try {
          const js = await del.json();
          msg = js?.detail || js?.error || msg;
        } catch {}
        throw new Error(msg);
      }

      // refresh dashboard state from backend
      const fresh = await loadAll(base, mode);
      const res = fresh?.res || [];

      // If the deleted resume was selected, repair selection
      if (wasSelected) {
        if (res.length > 0) {
          // select first remaining
          await selectResume(res[0]);
        } else {
          // no resumes left → clear selection everywhere
          const next = Object.assign({}, fresh?.prof || profile || {});
          next.selectedResumeId = "";
          next.selectedResumeName = "";
          next.selectedResumeSkills = [];

          const saved = await patchFullProfile(next);
          setProfile(saved || next);

          try {
            await chrome.storage.local.set({
              lastResumeId: "",
              selectedResume: { id: "", name: "", skills: [] },
            });
            try { chrome.runtime.sendMessage({ action: "profile.updated" }); } catch (_) {}
          } catch (_) {}
        }
      }
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setDeletingResumeId("");
    }
  }

  async function getResumeText(b, pref, resumeId) {
    const r = await apiFetchPD(b, pref, `/resumes/${encodeURIComponent(resumeId)}/text`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  
    const ct = String(r.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      const js = await r.json();
      return js?.text || js?.plain_text || js?.content || "";
    }
    return await r.text();
  }  
  
  async function computeSkillsForResumeId(resumeId) {
    if (!resumeId) return [];
    try {
        const txt = await getResumeText(base, mode, resumeId);
        if (window.SkillsWhitelist && typeof window.SkillsWhitelist.extractFromText === "function") {
        return await window.SkillsWhitelist.extractFromText(txt || "");
      }
    } catch (e) {
      console.warn("[dashboard] computeSkillsForResumeId failed:", e);
    }
    return [];
  }  

// Initial mount: load selected backend from background (Option A)
React.useEffect(() => {
    let alive = true;
  
    (async () => {
      setLoading(true);
      setErr("");
  
      const st = await bgGetBackendStatus(true);
      if (!alive) return;
  
      if (!st || !st.success || !st.base) {
        setErr("Backend not reachable for selected mode. Start the correct backend.");
        setLoading(false);
        return;
      }
  
      const pref = (st.pref === "v2") ? "v2" : "v1";
      const b = String(st.base).replace(/\/+$/, "");
  
      setMode(pref);
      setBase(b);
  
      await loadAll(b, pref);
  
      if (!alive) return;
      setLoading(false);
    })().catch((e) => {
      if (!alive) return;
      setErr(String(e?.message || e));
      setLoading(false);
    });
  
    return () => { alive = false; };
  }, []);  

  // Sync: if popup changes selected resume, reflect here
  React.useEffect(() => {
    if (!base) return;  
    
    function onChanged(changes, area) {
      if (area !== "local") return;

      const changedSelection = !!changes.lastResumeId || !!changes.selectedResume;
      if (!changedSelection) return;

      const newId =
        (changes.lastResumeId && changes.lastResumeId.newValue) ||
        (changes.selectedResume && changes.selectedResume.newValue && changes.selectedResume.newValue.id) ||
        "";

      const newName =
        (changes.selectedResume && changes.selectedResume.newValue && changes.selectedResume.newValue.name) ||
        "";

        setProfile((prev) => {
            const p = Object.assign({}, prev || {});
            if (newId) p.selectedResumeId = String(newId);
            if (newName) p.selectedResumeName = String(newName);
            
            // also sync skills when popup changes resume
            const newSkills =
            (changes.selectedResume && changes.selectedResume.newValue && changes.selectedResume.newValue.skills) || null;
          
            if (Array.isArray(newSkills) && newSkills.length) {
                p.selectedResumeSkills = newSkills;
            } else if (newId) {
                // if popup didn't provide skills, compute them here and persist
                (async () => {
                const computed = await computeSkillsForResumeId(String(newId));
            
                setProfile((prev2) => {
                    const cur = Object.assign({}, prev2 || {});
                    if (String(cur.selectedResumeId || "") !== String(newId)) return prev2;
                    cur.selectedResumeSkills = computed;
                    return cur;
                });
            
                // persist so popup/dashboard stay consistent
                try {
                    await patchFullProfile({
                    selectedResumeId: String(newId),
                    selectedResumeName: String(newName || ""),
                    selectedResumeSkills: computed
                    });
                } catch (_) {}
            
                try {
                    const got = await chrome.storage.local.get(["selectedResume"]);
                    const sr = got.selectedResume || {};
                    if (String(sr.id || "") === String(newId)) {
                    await chrome.storage.local.set({
                        selectedResume: { id: String(newId), name: String(newName || sr.name || ""), skills: computed },
                        lastResumeId: String(newId)
                    });
                    }
                } catch (_) {}
                })();
            }            
            return p;
            });          

      try { clearTimeout(refreshTimerRef.current); } catch {}
      refreshTimerRef.current = setTimeout(() => {
        loadAll(base, mode).catch(() => {});
    }, 200);
    }

    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      try { chrome.storage.onChanged.removeListener(onChanged); } catch {}
    };
  }, [base, mode]);

  const navItems = [
    ["personal", "Personal"],
    ["resume", "Resume"],
    ["links", "Links"],
    ["experience", "Experience"],
    ["education", "Education"],
    ["eligibility", "Eligibility"],
  ];

  // Overall + per-section completion
  const completion = React.useMemo(
    () => computeDashboardCompletion(profile, resumes),
    [profile, resumes]
  );
  
  const overallPct = completion.overallPct;
  const complete = overallPct === 100;
  
  const perSectionPct = {
    personal: completion.personalPct,
    resume: completion.resumePct,
    links: completion.linksPct,
    experience: completion.experiencePct,
    education: completion.educationPct,
    eligibility: completion.eligibilityPct,
  };  
  
  // Back/Next across the normal nav order
  const sectionIndex = Math.max(0, navItems.findIndex(([k]) => k === section));
  const canBack = sectionIndex > 0;
  const canNext = sectionIndex < navItems.length - 1;
  
  function goPrev() {
    if (!canBack) return;
    goSection(navItems[sectionIndex - 1][0]);
  }
  
  function goNext() {
    if (!canNext) return;
    goSection(navItems[sectionIndex + 1][0]);
  }
  
  const avatarLetter = initialFromProfile(profile);
  const email = profile?.personal?.email || "";
  const fn = profile?.personal?.firstName || "";
  const ln = profile?.personal?.lastName || "";
  const selectedName = extractFileName(profile?.selectedResumeName || "");

  function goSection(key) {
    setSection(key);
    try { localStorage.setItem("sff_profile_dash_section", key); } catch {}
  }  

  function openEditMyAnswers() {
    window.open(chrome.runtime.getURL("profile.html"), "_blank");
  }
  function openManageResumes() {
    window.open(chrome.runtime.getURL("resumes.html"), "_blank");
  }

  // Experience/Education summaries
  const exp = Array.isArray(profile?.experience) ? profile.experience : [];
  const edu = Array.isArray(profile?.education) ? profile.education : [];
  const derivedHighestEducation = deriveHighestEducationFromEducation(edu);
  const highestEducationDisplay = (profile?.highestEducation || derivedHighestEducation || "").trim();

  return h("div", { className: "shell" },
    h("div", { className: "sidebar" },
      h("div", { className: "brand" }, "Smart Form Filler — Profile"),
      navItems.map(([key, label]) => {
        const pct = perSectionPct?.[key] ?? 0;
        return h("button", {
          key,
          className: `navbtn ${section === key ? "active" : ""}`,
          onClick: () => goSection(key),
          type: "button",
          style: { display: "flex", alignItems: "center", justifyContent: "space-between" },
        },
          h("span", null, label),
          h("span", { className: "tiny muted" }, `${pct}%`)
        );
      }),      

      h("div", { className: "sidebarCard" },
        h("div", { className: "muted" }, "Quick links"),
        h("div", { className: "linkrow" },
          h("button", { className: "btn", onClick: openEditMyAnswers, type: "button" }, "Edit My Answers"),
          h("button", { className: "btn", onClick: openManageResumes, type: "button" }, "Manage Resumes")
        )
      )
    ),

    h("div", { className: "content" },
      loading && h("div", { className: "card" }, "Loading…"),
      (!loading && err) && h("div", { className: "card" }, h("div", { className: "muted" }, err)),

      (!loading && !err) && h("div", null,

        // Header card
        h("div", { className: "card" },
          h("div", { className: "row", style: { alignItems: "center" } },
            h("div", { className: "avatar" }, avatarLetter),
            h("div", null,
              h("div", { style: { fontWeight: 900, fontSize: 16 } }, (fn || ln) ? `${fn} ${ln}`.trim() : "Your profile"),
              h("div", { className: "muted" }, email || "—"),
              selectedName ? h("div", { className: "tiny", style: { marginTop: 4 } }, `Selected resume: ${selectedName}`) : null
            ),
            h("div", { style: { marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" } },
                h("span", { className: "pill" }, complete ? "Setup: 100% ✅" : `Setup: ${overallPct}%`),
                h("div", { style: { display: "flex", gap: 8 } },
                h("button", { className: "btn", disabled: !canBack, onClick: goPrev, type: "button" }, "Back"),
                h("button", { className: "btn primary", disabled: !canNext, onClick: goNext, type: "button" }, "Next")
                )
            )          
          )
        ),

        // PERSONAL (view-first + includes address)
        section === "personal" && h("div", { className: "card" },
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
            h("div", { style: { fontWeight: 900 } }, "Personal"),
            !editingPersonal
            ? h("button", {
                className: "btn",
                onClick: () => {
                  setDraftPersonal(profile?.personal ? { ...profile.personal } : {});
                  setDraftAddress(profile?.address ? { ...profile.address } : {});
                  setDraftYearsOfExperience(yoeForUi(profile?.yearsOfExperience || ""));
                  setEditingPersonal(true);
                },
                type: "button"
              }, "Edit")              
            : h("div", { style: { display: "flex", gap: 10 } },
                h("button", {
                    className: "btn",
                    onClick: () => {
                        setDraftPersonal(profile?.personal ? { ...profile.personal } : {});
                        setDraftAddress(profile?.address ? { ...profile.address } : {});
                        setDraftYearsOfExperience(yoeForUi(profile?.yearsOfExperience || ""));
                        setEditingPersonal(false);                        
                    },
                    type: "button"
                }, "Cancel"),
                h("button", { className: "btn primary", onClick: savePersonal, type: "button" }, "Save")
                )
        ),

        // Personal core
        !editingPersonal
            ? h("div", { className: "row", style: { marginTop: 12 } },
                viewBox("First name", profile?.personal?.firstName),
                viewBox("Last name", profile?.personal?.lastName),
                viewBox("Email", profile?.personal?.email),
                viewBox("Phone", profile?.personal?.phoneNumber),
                viewBox("Date of Birth", profile?.personal?.dob),
                viewBox("Gender", profile?.personal?.gender),
                viewBox("Years of Professional Experience", profile?.yearsOfExperience),
            )
            : h("div", { className: "row", style: { marginTop: 12 } },
                h("div", { className: "field" },
                h("label", null, "First name"),
                h("input", {
                    value: draftPersonal.firstName || "",
                    onChange: (e) => setDraftPersonal(Object.assign({}, draftPersonal, { firstName: e.target.value })),
                })
                ),
                h("div", { className: "field" },
                h("label", null, "Last name"),
                h("input", {
                    value: draftPersonal.lastName || "",
                    onChange: (e) => setDraftPersonal(Object.assign({}, draftPersonal, { lastName: e.target.value })),
                })
                ),
                h("div", { className: "field" },
                h("label", null, "Email"),
                h("input", {
                  type: "email",
                  value: draftPersonal.email || "",
                  onChange: (e) =>
                    setDraftPersonal(Object.assign({}, draftPersonal, { email: e.target.value })),
                })
                ),
              
                h("div", { className: "field" },
                h("label", null, "Phone"),
                h("input", {
                    value: draftPersonal.phoneNumber || "",
                    onChange: (e) => setDraftPersonal(Object.assign({}, draftPersonal, { phoneNumber: e.target.value })),
                })
                ),
                h("div", { className: "field" },
                h("label", null, "Years of Professional Experience"),
                h("input", {
                    type: "number",
                    min: 0,
                    max: 50,
                    step: "1",
                    value: draftYearsOfExperience || "",
                    onChange: (e) => setDraftYearsOfExperience(e.target.value),
                })
                ),
                h("div", { className: "field" },
                h("label", null, "Date of Birth"),
                h("input", {
                    type: "date",
                    value: draftPersonal.dob || "",
                    onChange: (e) => setDraftPersonal(Object.assign({}, draftPersonal, { dob: e.target.value })),
                })
                ),
                h("div", { className: "field" },
                h("label", null, "Gender"),
                h("select", {
                    value: draftPersonal.gender || "",
                    onChange: (e) => setDraftPersonal(Object.assign({}, draftPersonal, { gender: e.target.value })),
                },
                    h("option", { value: "" }, "—"),
                    h("option", null, "Male"),
                    h("option", null, "Female"),
                    h("option", null, "Non-Binary"),
                    h("option", null, "Prefer not to say"),
                )
                ),
            ),

        h("div", { className: "divider" }),
        h("div", { style: { fontWeight: 900, marginBottom: 8 } }, "Address"),

        !editingPersonal
            ? h("div", { className: "row" },
                viewBox("Street", profile?.address?.street),
                viewBox("City", profile?.address?.city),
                viewBox("County", profile?.address?.county),
                viewBox("State / Province", profile?.address?.state),
                viewBox("Zip / Postal", profile?.address?.zip),
                viewBox("Country", profile?.address?.country),
            )
            : h("div", { className: "row" },
                h("div", { className: "field" },
                h("label", null, "Street"),
                h("input", {
                    value: draftAddress.street || "",
                    onChange: (e) => setDraftAddress(Object.assign({}, draftAddress, { street: e.target.value })),
                })
                ),
                h("div", { className: "field" },
                h("label", null, "City"),
                h("input", {
                    value: draftAddress.city || "",
                    onChange: (e) => setDraftAddress(Object.assign({}, draftAddress, { city: e.target.value })),
                })
                ),
                h("div", { className: "field" },
                h("label", null, "County"),
                h("input", {
                    value: draftAddress.county || "",
                    onChange: (e) => setDraftAddress(Object.assign({}, draftAddress, { county: e.target.value })),
                })
                ),
                h("div", { className: "field" },
                h("label", null, "State / Province"),
                h("input", {
                    value: draftAddress.state || "",
                    onChange: (e) => setDraftAddress(Object.assign({}, draftAddress, { state: e.target.value })),
                })
                ),
                h("div", { className: "field" },
                h("label", null, "Zip / Postal"),
                h("input", {
                    value: draftAddress.zip || "",
                    onChange: (e) => setDraftAddress(Object.assign({}, draftAddress, { zip: e.target.value })),
                })
                ),
                h("div", { className: "field" },
                h("label", null, "Country"),
                h("input", {
                    value: draftAddress.country || "",
                    onChange: (e) => setDraftAddress(Object.assign({}, draftAddress, { country: e.target.value })),
                })
                ),
            )
        ),

        // RESUME
        section === "resume" && h("div", { className: "card" },
          h("div", { style: { fontWeight: 900, marginBottom: 8 } }, "Resumes"),
          h("div", { className: "muted" }, "Upload/select your preferred resume."),
          h("div", { className: "divider" }),

          h("div", { className: "row", style: { alignItems: "center" } },
            h("input", {
              type: "file",
              accept: ".pdf,.doc,.docx",
              onChange: (e) => setPendingResumeFile(e.target.files && e.target.files[0]),
            })
          ),

          h("div", { style: { marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
            h("div", { className: "muted" },
              (resumes?.length || 0) >= 5
                ? "Resume limit reached (5)."
                : pendingResumeFile
                  ? `Selected: ${pendingResumeFile.name}`
                  : "Choose a file to upload."
            ),
            h("button", {
              className: "btn primary",
              disabled: uploadingResume || !pendingResumeFile || (resumes?.length || 0) >= 5,
              onClick: () => uploadResume(pendingResumeFile),
              type: "button",
            }, uploadingResume ? "Uploading..." : "Upload")
          ),

        // Selected resume skills (if available)
        (() => {
            let skills = Array.isArray(profile?.selectedResumeSkills) ? profile.selectedResumeSkills : [];
            skills = (skills || []).filter(Boolean);

            // Fallback to profile-selected skills if the resume list has none
            if (!skills || skills.length === 0) {
              const fromProfile = Array.isArray(profile?.selectedResumeSkills) ? profile.selectedResumeSkills : [];
              skills = fromProfile;
            }            
        
            if (!skills || skills.length === 0) {
                return h("div", { style: { marginTop: 12 } },
                  h("div", { className: "muted" }, "Skills (from selected resume): —")
                );
            }
        
            return h("div", { style: { marginTop: 12 } },
            h("div", { className: "muted", style: { marginBottom: 8 } }, "Skills (from selected resume)"),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
                skills.slice(0, 40).map((s) =>
                h("span", {
                    key: String(s),
                    style: {
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: "1px solid #e5e7eb",
                    background: "#f9fafb",
                    fontSize: 12,
                    color: "#111827"
                    }
                }, String(s))
                )
            ),
            skills.length > 40 ? h("div", { className: "tiny", style: { marginTop: 8 } }, `+ ${skills.length - 40} more`) : null
            );
        })(),  

          h("div", { style: { marginTop: 14 } },
            (resumes.length === 0)
              ? h("div", { className: "muted" }, "No resumes yet.")
              : resumes.map((r, idx) => {
                  const rid = String(resumeIdOf(r) || `#${idx+1}`);
                  const name = resumeLabelOf(r);
                  const selected =
                    (!!profile?.selectedResumeId && String(profile.selectedResumeId) === String(rid)) ||
                    (!!profile?.selectedResumeName && extractFileName(profile.selectedResumeName) === extractFileName(name));

                  return h("div", { key: `${rid}-${idx}`, className: "resItem" },
                    h("div", null,
                      h("div", { style: { fontWeight: 900 } }, name),
                      h("div", { className: "muted" }, selected ? "Selected" : "Click Select to use this resume")
                    ),
                    h("div", { style: { display: "flex", gap: 10 } },
                    
                    h("button", {
                      className: `btn ${selected ? "primary" : ""}`,
                      onClick: () => selectResume(r),
                      type: "button",
                      disabled: uploadingResume || deletingResumeId === rid,
                    }, selected ? "Selected" : "Select"),
                  
                    h("button", {
                      className: "btn",
                      onClick: () => deleteResume(r),
                      type: "button",
                      disabled: uploadingResume || deletingResumeId === rid,
                    }, deletingResumeId === rid ? "Deleting…" : "Delete")
                  )                  
                  );
                })
          )
        ),

        // LINKS (2.1)
        section === "links" && h("div", { className: "card" },
          h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
            h("div", { style: { fontWeight: 900 } }, "Links"),
            !editingLinks
              ? h("button", { className: "btn", onClick: () => setEditingLinks(true), type: "button" }, "Edit")
              : h("div", { style: { display: "flex", gap: 10 } },
                  h("button", {
                    className: "btn",
                    onClick: () => { setDraftLinks(profile?.links ? { ...profile.links } : {}); setEditingLinks(false); },
                    type: "button"
                  }, "Cancel"),
                  h("button", { className: "btn primary", onClick: saveLinks, type: "button" }, "Save")
                )
          ),

          h("div", { className: "row", style: { marginTop: 12 } },
            h("div", { className: "field" },
              h("label", null, "LinkedIn"),
              editingLinks
              ? h("input", {
                  value: draftLinks.linkedin || "",
                  onChange: (e) => setDraftLinks(Object.assign({}, draftLinks, { linkedin: e.target.value })),
                  placeholder: "https://linkedin.com/in/…"
                })
              : viewBox(" ", profile?.links?.linkedin)            
            ),
            h("div", { className: "field" },
              h("label", null, "GitHub"),
              editingLinks
              ? h("input", {
                  value: draftLinks.github || "",
                  onChange: (e) => setDraftLinks(Object.assign({}, draftLinks, { github: e.target.value })),
                  placeholder: "https://github.com/…"
                })
              : viewBox(" ", profile?.links?.github)            
            ),
            h("div", { className: "field" },
              h("label", null, "Website"),
              editingLinks
              ? h("input", {
                  value: draftLinks.website || "",
                  onChange: (e) => setDraftLinks(Object.assign({}, draftLinks, { website: e.target.value })),
                  placeholder: "https://…"
                })
              : viewBox(" ", profile?.links?.website)            
            )
          )
        ),

        // ELIGIBILITY (view-first; matches Edit My Answers)
        section === "eligibility" && h("div", { className: "card" },
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
            h("div", { style: { fontWeight: 900 } }, "Eligibility & Voluntary Self-ID"),
            !editingEligibility
            ? h("button", { className: "btn", onClick: () => setEditingEligibility(true), type: "button" }, "Edit")
            : h("div", { style: { display: "flex", gap: 10 } },
                h("button", {
                    className: "btn",
                    onClick: () => { setDraftEligibility(profile?.eligibility ? { ...profile.eligibility } : {}); setEditingEligibility(false); },
                    type: "button"
                }, "Cancel"),
                h("button", { className: "btn primary", onClick: saveEligibility, type: "button" }, "Save")
                )
        ),

        !editingEligibility
            ? h("div", { className: "row", style: { marginTop: 12 } },
                viewBox("Authorized to work in the US?", profile?.eligibility?.authUS),
                viewBox("Authorized to work in Canada?", profile?.eligibility?.authCA),
                viewBox("Authorized to work in the United Kingdom?", profile?.eligibility?.authUK),
                viewBox("Will you now or in the future require sponsorship?", profile?.eligibility?.sponsorship),
                viewBox("Disability", profile?.eligibility?.disability),
                viewBox("Do you identify as LGBTQ+?", profile?.eligibility?.lgbtq),
                viewBox("Veteran Status", profile?.eligibility?.veteran),
                viewBox("Race", profile?.eligibility?.race),
                viewBox("Are you Hispanic or of Latinx descent?", profile?.eligibility?.hispanicLatinx),
                viewBox("Ethnicity", profile?.eligibility?.ethnicity),
            )
            : h("div", { className: "row", style: { marginTop: 12 } },
                radioYesNo(
                "authUS",
                "Authorized to work in the US?",
                draftEligibility.authUS || "",
                (v) => setDraftEligibility(Object.assign({}, draftEligibility, { authUS: v })),
                false
                ),
                radioYesNo(
                "authCA",
                "Authorized to work in Canada?",
                draftEligibility.authCA || "",
                (v) => setDraftEligibility(Object.assign({}, draftEligibility, { authCA: v })),
                false
                ),
                radioYesNo(
                "authUK",
                "Authorized to work in the United Kingdom?",
                draftEligibility.authUK || "",
                (v) => setDraftEligibility(Object.assign({}, draftEligibility, { authUK: v })),
                false
                ),
                radioYesNo(
                "sponsorship",
                "Will you now or in the future require sponsorship?",
                draftEligibility.sponsorship || "",
                (v) => setDraftEligibility(Object.assign({}, draftEligibility, { sponsorship: v })),
                false
                ),

                selectField(
                "disability",
                "Disability",
                draftEligibility.disability || "",
                ["Yes", "No", "Decline to state"],
                (v) => setDraftEligibility(Object.assign({}, draftEligibility, { disability: v })),
                false
                ),
                selectField(
                "lgbtq",
                "Do you identify as LGBTQ+?",
                draftEligibility.lgbtq || "",
                ["Yes", "No", "Decline to state"],
                (v) => setDraftEligibility(Object.assign({}, draftEligibility, { lgbtq: v })),
                false
                ),
                selectField(
                "veteran",
                "Veteran Status",
                draftEligibility.veteran || "",
                ["Yes", "No", "Decline to state"],
                (v) => setDraftEligibility(Object.assign({}, draftEligibility, { veteran: v })),
                false
                ),

                selectField(
                "race",
                "Race",
                draftEligibility.race || "",
                [
                    "American Indian or Alaska Native",
                    "Asian",
                    "Black",
                    "Native Hawaiian or Other Pacific Islander",
                    "White",
                    "Two or More Races",
                    "Other / Prefer to self-describe",
                    "Decline to state"
                ],
                (v) => setDraftEligibility(Object.assign({}, draftEligibility, { race: v })),
                false
                ),
                selectField(
                "hispanicLatinx",
                "Are you Hispanic or of Latinx descent?",
                draftEligibility.hispanicLatinx || "",
                ["Yes", "No", "Prefer not to answer"],
                (v) => setDraftEligibility(Object.assign({}, draftEligibility, { hispanicLatinx: v })),
                false
                ),
                selectField(
                "ethnicity",
                "Ethnicity",
                draftEligibility.ethnicity || "",
                [
                    "Hispanic/Latinx",
                    "Black or African American",
                    "White",
                    "Asian",
                    "American Indian or Alaska Native",
                    "Native Hawaiian or Other Pacific Islander",
                    "Two or More Races",
                    "Decline to state"
                ],
                (v) => setDraftEligibility(Object.assign({}, draftEligibility, { ethnicity: v })),
                false
                )
            )
        ),

        // EXPERIENCE
        section === "experience" && h("div", { className: "card" },
          h("div", { style: { display:"flex", alignItems:"center", justifyContent:"space-between" } },
            h("div", { style: { fontWeight: 900 } }, "Experience"),
            !editingExperience
              ? h("button", {
                  className: "btn",
                  onClick: () => {
                    const items = Array.isArray(profile?.experience) ? profile.experience.map(normExpItem) : [];
                    setDraftExperience(items);
                    setEditingExperience(true);
                  },
                  type:"button"
                }, "Edit")
              : h("div", { style:{ display:"flex", gap:10 } },
                  h("button", {
                    className:"btn",
                    onClick: () => {
                      const items = Array.isArray(profile?.experience) ? profile.experience.map(normExpItem) : [];
                      setDraftExperience(items);
                      setEditingExperience(false);
                    },
                    type:"button"
                  }, "Cancel"),
                  h("button", { className:"btn primary", onClick: saveExperience, type:"button" }, "Save")
                )
          ),

          !editingExperience && (
            (Array.isArray(profile?.experience) && profile.experience.length)
              ? h("div", { style:{ marginTop:12 } },
                  profile.experience.map((raw, idx) => {
                    const it = normExpItem(raw);
                    return h("div", { key: `exp-${idx}`, className:"card", style:{ background:"#f9fafb", borderColor:"#e5e7eb" } },
                        h("div", { style:{ fontWeight:800 } }, it.jobTitle || "Job Title —"),
                        h("div", { className:"tiny" }, it.company ? `Company: ${it.company}` : "Company: —"),
                        h("div", { className:"tiny" }, fmtRange(it.startMonth, it.startYear, it.endMonth, it.endYear, it.isCurrent) ? `Dates: ${fmtRange(it.startMonth, it.startYear, it.endMonth, it.endYear, it.isCurrent)}` : "Dates: —"),
                        h("div", { style:{ marginTop: 8, whiteSpace: "pre-wrap", fontSize: 13, color:"#111827" } },
                        it.description ? it.description : "Description: —"
                        ),                    
                    );
                  })
                )
              : h("div", { className:"muted", style:{ marginTop:10 } }, "No experience items yet.")
          ),

          editingExperience && h("div", { style:{ marginTop:12 } },
            h("button", {
              className:"btn",
              onClick: () => setDraftExperience([...(draftExperience||[]), normExpItem({})]),
              type:"button"
            }, "+ Add experience"),

            (draftExperience || []).map((it, idx) => {
              const startYM = partsToYM(it.startYear, it.startMonth);
              const endYM = partsToYM(it.endYear, it.endMonth);

              return h("div", { key:`exp-edit-${idx}`, className:"card", style:{ background:"#f9fafb", borderColor:"#e5e7eb", marginTop:12 } },
                h("div", { className:"row" },
                  h("div", { className:"field" },
                    h("label", null, "Company"),
                    h("input", {
                      value: it.company || "",
                      onChange: (e) => {
                        const next = [...draftExperience];
                        next[idx] = Object.assign({}, next[idx], { company: e.target.value });
                        setDraftExperience(next);
                      }
                    })
                  ),
                  h("div", { className:"field" },
                    h("label", null, "Job Title"),
                    h("input", {
                      value: it.jobTitle || "",
                      onChange: (e) => {
                        const next = [...draftExperience];
                        next[idx] = Object.assign({}, next[idx], { jobTitle: e.target.value });
                        setDraftExperience(next);
                      }
                    })
                  )
                ),

                h("div", { className:"row", style:{ marginTop:10 } },
                  h("div", { className:"field" },
                    h("label", null, "Start (Month/Year)"),
                    h("input", {
                        type: "month",
                        value: startYM,
                        max: (!it.isCurrent && endYM) ? endYM : undefined,
                        onChange: (e) => {
                          const { year, month } = ymToParts(e.target.value);
                          const next = [...draftExperience];
                      
                          const updated = Object.assign({}, next[idx], { startYear: year, startMonth: month });
                          if (!updated.isCurrent) ensureStartBeforeEnd(updated);
                      
                          next[idx] = updated;
                          setDraftExperience(next);
                        }
                      })                      
                  ),
                  h("div", { className:"field" },
                    h("label", null, "End (Month/Year)"),
                    h("input", {
                        type: "month",
                        value: endYM,
                        min: startYM || undefined,
                        disabled: !!it.isCurrent,
                        onChange: (e) => {
                          const { year, month } = ymToParts(e.target.value);
                          const next = [...draftExperience];
                      
                          const updated = Object.assign({}, next[idx], { endYear: year, endMonth: month });
                          ensureStartBeforeEnd(updated);
                      
                          next[idx] = updated;
                          setDraftExperience(next);
                        }
                      })                      
                  ),
                  h("div", { className:"field" },
                    h("label", null, "Currently work here"),
                    h("div", null,
                      h("input", {
                        type:"checkbox",
                        checked: !!it.isCurrent,
                        onChange: (e) => {
                          const checked = !!e.target.checked;
                          const next = [...draftExperience];
                          next[idx] = Object.assign({}, next[idx], checked ? {
                            isCurrent: true,
                            endYear: "",
                            endMonth: ""
                          } : { isCurrent: false });
                          setDraftExperience(next);
                        }
                      })
                    )
                  )
                ),

                h("div", { className:"field", style:{ marginTop:10 } },
                  h("label", null, "Description"),
                  h("textarea", {
                    value: it.description || "",
                    onChange: (e) => {
                      const next = [...draftExperience];
                      next[idx] = Object.assign({}, next[idx], { description: e.target.value });
                      setDraftExperience(next);
                    }
                  })
                ),

                h("div", { style:{ marginTop:10, display:"flex", justifyContent:"space-between", alignItems:"center" } },
                  h("div", { className:"tiny" }, `Item #${idx+1}`),
                  h("button", {
                    className:"btn",
                    onClick: () => {
                      const next = [...draftExperience];
                      next.splice(idx, 1);
                      setDraftExperience(next);
                    },
                    type:"button"
                  }, "Delete")
                )
              );
            })
          )
        ),

        // EDUCATION
        section === "education" && h("div", { className: "card" },
          h("div", { style: { display:"flex", alignItems:"center", justifyContent:"space-between" } },
            h("div", { style: { fontWeight: 900 } }, "Education"),
            !editingEducation
              ? h("button", {
                  className:"btn",
                  onClick: () => {
                    const items = Array.isArray(profile?.education) ? profile.education.map(normEduItem) : [];
                    setDraftEducation(items);
                    setDraftHighestEducation(profile?.highestEducation || derivedHighestEducation || "");
                    setEditingEducation(true);
                  },                  
                  type:"button"
                }, "Edit")
              : h("div", { style:{ display:"flex", gap:10 } },
                  h("button", {
                    className:"btn",
                    onClick: () => {
                      const items = Array.isArray(profile?.education) ? profile.education.map(normEduItem) : [];
                      setDraftEducation(items);
                      setDraftHighestEducation(profile?.highestEducation || derivedHighestEducation || "");
                      setEditingEducation(false);
                    },
                    type:"button"
                  }, "Cancel"),
                  h("button", { className:"btn primary", onClick: saveEducation, type:"button" }, "Save")
                )
          ),

        // Highest Education
        (!editingEducation) && h("div", { className: "tiny", style: { marginTop: 6 } },
        `Highest Education: ${highestEducationDisplay || "—"}`
        ),

        // Only show the dropdown when editing
        editingEducation && h("div", { className: "row", style: { marginTop: 12 } },
        h("div", { className: "field", style: { maxWidth: 360 } },
            h("label", null, "Highest Education"),
            h("select", {
            value: draftHighestEducation || "",
            onChange: (e) => setDraftHighestEducation(e.target.value),
            },
            ...HIGHEST_EDU_OPTIONS.map((opt) =>
                h("option", { key: `he-${opt || "blank"}`, value: opt }, opt || "—")
            )
            )
        )
        ),

          !editingEducation && (
            (Array.isArray(profile?.education) && profile.education.length)
              ? h("div", { style:{ marginTop:12 } },
                  profile.education.map((raw, idx) => {
                    const it = normEduItem(raw);
                    const degree = it.degreeShort ? `${it.degreeLong || DEGREE_MAP[it.degreeShort] || it.degreeShort} (${it.degreeShort})` : "";
                    return h("div", { key:`edu-${idx}`, className:"card", style:{ background:"#f9fafb", borderColor:"#e5e7eb" } },
                        h("div", { style:{ fontWeight:800 } }, it.school || "School —"),
                        h("div", { className:"tiny" }, degree ? `Degree: ${degree}` : "Degree: —"),
                        h("div", { className:"tiny" }, it.field ? `Field: ${it.field}` : "Field: —"),
                        h("div", { className:"tiny" }, fmtRange(it.startMonth, it.startYear, it.endMonth, it.endYear, false) ? `Dates: ${fmtRange(it.startMonth, it.startYear, it.endMonth, it.endYear, false)}` : "Dates: —"),
                        h("div", { className:"tiny" }, (it.gpa !== "" && it.gpa !== null && it.gpa !== undefined) ? `GPA: ${it.gpa}` : "GPA: —"),                    
                    );
                  })
                )
              : h("div", { className:"muted", style:{ marginTop:10 } }, "No education items yet.")
          ),

          editingEducation && h("div", { style:{ marginTop:12 } },
            h("button", {
              className:"btn",
              onClick: () => setDraftEducation([...(draftEducation||[]), normEduItem({})]),
              type:"button"
            }, "+ Add education"),

            (draftEducation || []).map((it, idx) => {
              const startYM = partsToYM(it.startYear, it.startMonth);
              const endYM = partsToYM(it.endYear, it.endMonth);

              return h("div", { key:`edu-edit-${idx}`, className:"card", style:{ background:"#f9fafb", borderColor:"#e5e7eb", marginTop:12 } },
                h("div", { className:"row" },
                  h("div", { className:"field" },
                    h("label", null, "School"),
                    h("input", {
                      value: it.school || "",
                      onChange: (e) => {
                        const next = [...draftEducation];
                        next[idx] = Object.assign({}, next[idx], { school: e.target.value });
                        setDraftEducation(next);
                      }
                    })
                  ),
                  h("div", { className:"field" },
                    h("label", null, "Degree"),
                    h("select", {
                      value: it.degreeShort || "",
                      onChange: (e) => {
                        const v = e.target.value;
                        const next = [...draftEducation];
                        next[idx] = Object.assign({}, next[idx], {
                          degreeShort: v,
                          degreeLong: DEGREE_MAP[v] || ""
                        });
                        setDraftEducation(next);
                      }
                    },
                      DEGREE_OPTIONS.map((d) =>
                        h("option", { key:`deg-${d.short||"none"}`, value:d.short }, d.label)
                      )
                    )
                  )
                ),

                h("div", { className:"row", style:{ marginTop:10 } },
                  h("div", { className:"field" },
                    h("label", null, "Field of study"),
                    h("input", {
                      value: it.field || "",
                      onChange: (e) => {
                        const next = [...draftEducation];
                        next[idx] = Object.assign({}, next[idx], { field: e.target.value });
                        setDraftEducation(next);
                      }
                    })
                  ),
                  h("div", { className:"field" },
                    h("label", null, "GPA (0.0–4.0)"),
                    h("input", {
                      type: "number",
                      min: 0,
                      max: 4,
                      step: "0.01",
                      value: it.gpa || "",
                      onChange: (e) => {
                        const next = [...draftEducation];
                        next[idx] = Object.assign({}, next[idx], { gpa: e.target.value });
                        setDraftEducation(next);
                      }
                    })
                  )
                ),

                h("div", { className:"row", style:{ marginTop:10 } },
                  h("div", { className:"field" },
                    h("label", null, "Start (Month/Year)"),
                    h("input", {
                        type: "month",
                        value: startYM,
                        max: endYM || undefined,
                        onChange: (e) => {
                          const { year, month } = ymToParts(e.target.value);
                          const next = [...draftEducation];
                      
                          const updated = Object.assign({}, next[idx], { startYear: year, startMonth: month });
                          ensureStartBeforeEnd(updated);
                      
                          next[idx] = updated;
                          setDraftEducation(next);
                        }
                      })                      
                  ),
                  h("div", { className:"field" },
                    h("label", null, "End / Expected Graduation (Month/Year)"),
                    h("input", {
                        type: "month",
                        value: endYM,
                        min: startYM || undefined,
                        onChange: (e) => {
                          const { year, month } = ymToParts(e.target.value);
                          const next = [...draftEducation];
                      
                          const updated = Object.assign({}, next[idx], { endYear: year, endMonth: month });
                          ensureStartBeforeEnd(updated);
                      
                          next[idx] = updated;
                          setDraftEducation(next);
                        }
                      })                      
                  )
                ),

                h("div", { style:{ marginTop:10, display:"flex", justifyContent:"space-between", alignItems:"center" } },
                  h("div", { className:"tiny" }, `Item #${idx+1}`),
                  h("button", {
                    className:"btn",
                    onClick: () => {
                      const next = [...draftEducation];
                      next.splice(idx, 1);
                      setDraftEducation(next);
                    },
                    type:"button"
                  }, "Delete")
                )
              );
            })
          )
        )
      )
    )
  );
}

// Render safely
const rootEl = document.getElementById("root");
if (!rootEl) {
  console.error("[profile_dashboard] Missing #root element");
} else if (typeof React === "undefined") {
  rootEl.textContent = "React failed to load (check vendor/react*.js path).";
} else if (typeof ReactDOM === "undefined") {
  rootEl.textContent = "ReactDOM failed to load (check vendor/react-dom*.js path).";
} else if (typeof ReactDOM.createRoot === "function") {
  ReactDOM.createRoot(rootEl).render(h(App));
} else if (typeof ReactDOM.render === "function") {
  ReactDOM.render(h(App), rootEl);
} else {
  rootEl.textContent = "ReactDOM loaded but no render method found.";
}

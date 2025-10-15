// helpers.js — Smart Form Filler shared, pure helpers (no DOM here)
(function(){
    const HVER = "1.0.0";
  
    // ----- string utils -----
    const lower = (s) => (s ?? "").toString().toLowerCase().trim();
    const norm  = (s) => lower(s).replace(/[^a-z0-9]/g, "");
    const sameNormalized = (a,b) => { const A = norm(a), B = norm(b); return A===B || A.includes(B) || B.includes(A); };
  
    // ----- state / country helpers -----
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
  
    function normCountry(v) {
      const s = (v || "").toString().trim().toLowerCase();
      if (!s) return "";
      if (["us","usa","u.s.","u.s.a.","united states","united states of america","america"].includes(s)) return "United States";
      if (s.length === 2) return s.toUpperCase();
      return s.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  
    // ----- name & address inference (label-aware; pure) -----
    function inferNamePartFromLabel(labelText = "") {
      const t = (labelText || "").toLowerCase();
      if (/\b(first|given)\b/.test(t)) return "firstName";
      if (/\b(last|surname|family)\b/.test(t)) return "lastName";
      return null;
    }
    function splitFullName(full = "") {
      const s = String(full || "").trim().replace(/\s+/g, " ");
      if (!s) return { firstName: "", lastName: "" };
      const parts = s.split(" ");
      if (parts.length === 1) return { firstName: parts[0], lastName: "" };
      return { firstName: parts[0], lastName: parts[parts.length - 1] };
    }
    function inferAddressPartFromLabel(labelText = "") {
      const t = (labelText || "").toLowerCase();
      if (/(street address|address\s*line\s*1|address\s*line\s*one|\baddress\b|\bline\s*1\b|\baddr(?:ess)?\b)/i.test(t)) return "street";
      if (/\bcity\s*\/\s*town\b|\bcity\b|\btown\b/.test(t)) return "city";
      if (/\bstate\s*\/\s*province\s*\/\s*region\b|\bstate\b|\bprovince\b|\bregion\b/.test(t)) return "state";
      if (/\bzip\s*\/\s*postal\s*code\s*\/\s*postcode\b|\bpostal\s*code\b|\bpostcode\b|\bzip\b/.test(t)) return "zip";
      if (/\bcountry\s*\/\s*nation\b|\bcountry\b|\bnation\b/.test(t)) return "country";
      if (/\bcounty\b/.test(t)) return "county";
      return null;
    }
  
    function resolveValueAndKey(mappedKey, labelText, userData) {
      const ud = userData || {};
      const wantName = inferNamePartFromLabel(labelText);
      const wantAddr = inferAddressPartFromLabel(labelText);
      const addrKeys = new Set(["street", "city", "state", "zip", "country", "county"]);
  
      if (mappedKey === "firstName" || wantName === "firstName") {
        const v = ud.firstName || (ud.fullName && splitFullName(ud.fullName).firstName) || "";
        return { value: v, key: "firstName" };
      }
      if (mappedKey === "lastName" || wantName === "lastName") {
        const v = ud.lastName || (ud.fullName && splitFullName(ud.fullName).lastName) || "";
        return { value: v, key: "lastName" };
      }
      if (mappedKey === "fullName" && wantName) {
        const { firstName, lastName } = splitFullName(ud.fullName || "");
        return { value: wantName === "firstName" ? firstName : lastName, key: wantName };
      }
  
      // Address: let the label decide first (City/State/Zip/Country), then mappedKey as fallback
      if (wantAddr) {
        let v = ud[wantAddr] ?? "";
        if (wantAddr === "country") v = normCountry(v);
        return { value: v, key: wantAddr };
      }
      if (addrKeys.has(mappedKey)) {
        let v = ud[mappedKey] ?? "";
        if (mappedKey === "country") v = normCountry(v);
        return { value: v, key: mappedKey };
      }

      return { value: ud[mappedKey] ?? "", key: mappedKey };
    }
  
    // ----- date/month & value normalization (pure) -----
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
    function scalarize(v) {
      if (v == null) return "";
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
      if (Array.isArray(v)) return v.map(x => scalarize(x)).filter(Boolean).join(", ");
      const namey = v?.name || v?.school || v?.university || v?.college || v?.text || v?.title;
      if (namey) return String(namey);
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    function toISODate(any) {
      // Accept: "YYYY-MM-DD" (pass-through), "MM/DD/YYYY", "DD/MM/YYYY", "YYYY/MM/DD", "MM/YYYY", "YYYY"
      if (!any) return "";
      const s = String(any).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // already ISO
    
      // MM/DD/YYYY
      let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (m) {
        const mm = String(m[1]).padStart(2, "0");
        const dd = String(m[2]).padStart(2, "0");
        const yyyy = m[3];
        return `${yyyy}-${mm}-${dd}`;
      }
      // DD/MM/YYYY
      m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (m) {
        // ambiguity handled above — this fallback keeps as-is; if you want strict locale, add a flag
      }
      // YYYY/MM/DD or YYYY-MM-DD (missing handled by first check)
      m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
      if (m) {
        const yyyy = m[1];
        const mm = String(m[2]).padStart(2, "0");
        const dd = String(m[3]).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
      }
      // MM/YYYY -> pick day 01
      m = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
      if (m) {
        const mm = String(m[1]).padStart(2, "0");
        const yyyy = m[2];
        return `${yyyy}-${mm}-01`;
      }
      // YYYY -> Jan 01
      if (/^\d{4}$/.test(s)) return `${s}-01-01`;
    
      // Fallback: try Date()
      const d = new Date(s);
      if (!isNaN(d)) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
      }
      return "";
    }

    // ===== Helpers for date/month normalization =====
    function toISOMonth(any) {
      // Accept: "MM/YYYY", "YYYY-MM", "YYYY/MM", Date-like
      if (!any) return "";
      const s = String(any).trim();
      // Already ISO YYYY-MM
      if (/^\d{4}-\d{2}$/.test(s)) return s;
      // MM/YYYY -> YYYY-MM
      const m1 = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
      if (m1) {
        const mm = String(m1[1]).padStart(2, "0");
        const yyyy = m1[2];
        return `${yyyy}-${mm}`;
      }
      // YYYY/MM -> YYYY-MM
      const m2 = s.match(/^(\d{4})[\/\-](\d{1,2})$/);
      if (m2) {
        const yyyy = m2[1];
        const mm = String(m2[2]).padStart(2, "0");
        return `${yyyy}-${mm}`;
      }
      // YYYY only -> YYYY-01
      if (/^\d{4}$/.test(s)) return `${s}-01`;
      // Fallback: try Date()
      const d = new Date(s);
      if (!isNaN(d)) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        return `${yyyy}-${mm}`;
      }
      return "";
    }
  
    // ----- token / radio normalization (pure) -----
    function normalizeToken(s) {
      return (s || "").toString().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
    function canonGender(w) {
      if (/^(m|male)\b/.test(w)) return "male";
      if (/^(f|female)\b/.test(w)) return "female";
      if (/non ?binary|nonbinary/.test(w)) return "non_binary";
      if (/prefer.*not.*say|prefer not/.test(w)) return "prefer_not";
      if (/other|decline/.test(w)) return "other";
      return w;
    }
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
  
    // expose
    window.SFFHelpers = {
      HVER,
      // strings/state
      lower, norm, sameNormalized, STATE_TO_ABBR, ABBR_TO_STATE, toAbbr, normCountry,
      // name/address
      inferNamePartFromLabel, splitFullName, inferAddressPartFromLabel, resolveValueAndKey,
      // dates
      fmtMonthYear, scalarize, toISODate, toISOMonth,
      // tokens
      normalizeToken, canonGender, normTokens, overlapScore
    };
  })();
  
  window.H = window.SFFHelpers; // optional alias so content.js can always find helpers

 // ===== helpers.js additions =====
window.SFFHelpers = window.SFFHelpers || {};
(function(H){
  const norm = (s) => (s ?? "").toString().trim().toLowerCase().replace(/[\s\-_'"().]/g, "");
  H.norm = norm;

  // Degrees: map many ways → canonical label that appears in most selects
  const DEGREE_ALIASES = {
    bachelors: ["Bachelor's","Bachelors","Bachelor of Science","BS","B.S.","Bachelor of Arts","BA","B.A."],
    masters:   ["Master's","Masters","MS","M.S.","MSc","MA","M.A."],
    phd:       ["PhD","Ph.D.","Doctorate","Doctor of Philosophy"]
  };
  H.DEGREE_CANONICAL = {
    [norm("Bachelor of Science")]: "Bachelor's",
    [norm("Bachelor of Arts")]: "Bachelor's",
    [norm("Bachelors")]: "Bachelor's",
    [norm("BS")]: "Bachelor's",
    [norm("B.S.")]: "Bachelor's",
    [norm("BA")]: "Bachelor's",
    [norm("B.A.")]: "Bachelor's",
    [norm("Master of Science")]: "Master's",
    [norm("Master of Arts")]: "Master's",
    [norm("MS")]: "Master's",
    [norm("M.S.")]: "Master's",
    [norm("MA")]: "Master's",
    [norm("M.A.")]: "Master's",
    [norm("PhD")]: "PhD",
    [norm("Ph.D.")]: "PhD",
  };
  H.DEGREE_ALIASES = DEGREE_ALIASES;

  // States
  const ABBR_TO_STATE = {
    "AL":"Alabama","AK":"Alaska","AZ":"Arizona","AR":"Arkansas","CA":"California","CO":"Colorado",
    "CT":"Connecticut","DE":"Delaware","FL":"Florida","GA":"Georgia","HI":"Hawaii","ID":"Idaho",
    "IL":"Illinois","IN":"Indiana","IA":"Iowa","KS":"Kansas","KY":"Kentucky","LA":"Louisiana",
    "ME":"Maine","MD":"Maryland","MA":"Massachusetts","MI":"Michigan","MN":"Minnesota","MS":"Mississippi",
    "MO":"Missouri","MT":"Montana","NE":"Nebraska","NV":"Nevada","NH":"New Hampshire","NJ":"New Jersey",
    "NM":"New Mexico","NY":"New York","NC":"North Carolina","ND":"North Dakota","OH":"Ohio","OK":"Oklahoma",
    "OR":"Oregon","PA":"Pennsylvania","RI":"Rhode Island","SC":"South Carolina","SD":"South Dakota",
    "TN":"Tennessee","TX":"Texas","UT":"Utah","VT":"Vermont","VA":"Virginia","WA":"Washington",
    "WV":"West Virginia","WI":"Wisconsin","WY":"Wyoming","DC":"District of Columbia"
  };
  H.ABBR_TO_STATE = ABBR_TO_STATE;
  H.toAbbr = (full) => {
    const n = norm(full).replace(/usa?$/, "unitedstates");
    for (const [abbr, name] of Object.entries(ABBR_TO_STATE)) {
      if (norm(name) === n) return abbr;
    }
    return full;
  };

  // Countries
  H.normCountry = (s) => {
    const n = norm(s);
    if (n === "us" || n === "usa" || n === "u.s." || n === "unitedstates") return "United States";
    return s;
  };

  // Dates
  H.toISODate = (v) => {
    // accepts "2002-08-20", "08/20/2002", "20-08-2002"
    const s = (v ?? "").toString().trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    let m;
    if ((m = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/))) {
      const [_, mm, dd, yy] = m;
      return `${yy}-${mm}-${dd}`;
    }
    if ((m = s.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/))) {
      const [_, yy, mm, dd] = m;
      return `${yy}-${mm}-${dd}`;
    }
    return null;
  };

  H.toMonthValue = (v) => {
    // "02/2021", "February 2021", "2021-02" -> "2021-02"
    const s = (v ?? "").toString().trim();
    let m;
    if ((m = s.match(/^(\d{1,2})[\/\-](\d{4})$/))) {
      const [_, mm, yy] = m;
      return `${yy}-${String(mm).padStart(2,"0")}`;
    }
    if ((m = s.match(/^(\d{4})-(\d{2})$/))) return s;
    if ((m = s.match(/^([A-Za-z]+)\s+(\d{4})$/))) {
      const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
      const idx = months.indexOf(m[1].toLowerCase());
      if (idx >= 0) return `${m[2]}-${String(idx+1).padStart(2,"0")}`;
    }
    return null;
  };

  // Referral normalization (maps popular sources to typical select options)
  H.normReferral = (s) => {
    const n = norm(s);
    if (n.includes("linkedin")) return "Job Board";
    if (n.includes("indeed") || n.includes("glassdoor") || n.includes("ziprecruiter")) return "Job Board";
    if (n.includes("careerfair")) return "Career Fair";
    if (n.includes("recruiter")) return "Recruiter";
    if (n.includes("company")) return "Company Website";
    return s;
  };


})(window.SFFHelpers);

// === SFF normalizers & maps ===
window.SFFHelpers = window.SFFHelpers || {};
(function(H){
  const norm = (s) => (s ?? "").toString().trim().toLowerCase().replace(/[\s\-_'"().]/g,"");
  H.norm = H.norm || norm;

  // Degree canonicalization: map variants → select-friendly label
  H.DEGREE_CANONICAL = Object.assign(H.DEGREE_CANONICAL || {}, {
    [norm("Bachelor of Science")]: "Bachelor's",
    [norm("Bachelor of Arts")]: "Bachelor's",
    [norm("BS")]: "Bachelor's", [norm("B.S.")]: "Bachelor's",
    [norm("BA")]: "Bachelor's", [norm("B.A.")]: "Bachelor's",
    [norm("Master of Science")]: "Master's",
    [norm("Master of Arts")]: "Master's",
    [norm("MS")]: "Master's", [norm("M.S.")]: "Master's",
    [norm("MA")]: "Master's", [norm("M.A.")]: "Master's",
    [norm("PhD")]: "PhD", [norm("Ph.D.")]: "PhD"
  });

  // Referral mapping (platform → typical select option)
  H.normReferral = H.normReferral || function(s){
    const n = norm(s);
    if (n.includes("linkedin") || n.includes("indeed") || n.includes("glassdoor") || n.includes("ziprecruiter")) return "Job Board";
    if (n.includes("careerfair")) return "Career Fair";
    if (n.includes("recruiter"))  return "Recruiter";
    if (n.includes("company"))    return "Company Website";
    return s;
  };

  // State + Country helpers
  H.ABBR_TO_STATE = H.ABBR_TO_STATE || {
    "AL":"Alabama","AK":"Alaska","AZ":"Arizona","AR":"Arkansas","CA":"California","CO":"Colorado","CT":"Connecticut","DE":"Delaware","FL":"Florida","GA":"Georgia","HI":"Hawaii","ID":"Idaho","IL":"Illinois","IN":"Indiana","IA":"Iowa","KS":"Kansas","KY":"Kentucky","LA":"Louisiana","ME":"Maine","MD":"Maryland","MA":"Massachusetts","MI":"Michigan","MN":"Minnesota","MS":"Mississippi","MO":"Missouri","MT":"Montana","NE":"Nebraska","NV":"Nevada","NH":"New Hampshire","NJ":"New Jersey","NM":"New Mexico","NY":"New York","NC":"North Carolina","ND":"North Dakota","OH":"Ohio","OK":"Oklahoma","OR":"Oregon","PA":"Pennsylvania","RI":"Rhode Island","SC":"South Carolina","SD":"South Dakota","TN":"Tennessee","TX":"Texas","UT":"Utah","VT":"Vermont","VA":"Virginia","WA":"Washington","WV":"West Virginia","WI":"Wisconsin","WY":"Wyoming","DC":"District of Columbia"
  };
  H.toAbbr = H.toAbbr || function(full){
    const n = norm(full).replace(/usa?$/,"unitedstates");
    for (const [abbr, name] of Object.entries(H.ABBR_TO_STATE)) {
      if (norm(name) === n) return abbr;
    }
    return full;
  };
  H.normCountry = H.normCountry || function(s){
    const n = norm(s);
    if (n === "us" || n === "usa" || n === "u.s." || n === "unitedstates") return "United States";
    return s;
  };

  // Date helpers
  H.toISODate = H.toISODate || function(v){
    const s = (v ?? "").toString().trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    let m;
    if ((m = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/))) return `${m[3]}-${m[1]}-${m[2]}`;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return s;
    return null;
  };
  H.toMonthValue = H.toMonthValue || function(v){
    const s = (v ?? "").toString().trim();
    let m;
    if ((m = s.match(/^(\d{1,2})[\/\-](\d{4})$/))) return `${m[2]}-${String(m[1]).padStart(2,"0")}`;
    if ((m = s.match(/^(\d{4})-(\d{2})$/))) return s;
    if ((m = s.match(/^([A-Za-z]+)\s+(\d{4})$/))) {
      const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
      const idx = months.indexOf(m[1].toLowerCase());
      if (idx >= 0) return `${m[2]}-${String(idx+1).padStart(2,"0")}`;
    }
    return null;
  };
})(window.SFFHelpers);

// normalize degree label on options (strip trailing "degree")
window.SFFHelpers = window.SFFHelpers || {};
(function(H){
  H.normalizeDegreeLabel = function (s){
    const t = (s ?? "").toString().trim();
    return t.replace(/\bdegree\b\.?$/i, "").trim(); // "Bachelor's Degree" -> "Bachelor's"
  };
})(window.SFFHelpers);

// ==== Degree + referral canonicalizers (exported on H) ====
(function () {
  const H = (window.H = window.H || (window.SFFHelpers = window.SFFHelpers || {}));

  // map normalized tokens → canonical label used to match <select> options broadly
  const DEGREE_CANONICAL = {
    // bachelor's
    "bachelor": "Bachelor's",
    "bachelors": "Bachelor's",
    "bsc": "Bachelor's",
    "bs": "Bachelor's",
    "b.s": "Bachelor's",
    "bachelorofscience": "Bachelor's",
    "ba": "Bachelor's",
    "b.a": "Bachelor's",
    "bachelorofarts": "Bachelor's",

    // master's
    "master": "Master's",
    "masters": "Master's",
    "msc": "Master's",
    "ms": "Master's",
    "m.s": "Master's",
    "ma": "Master's",
    "m.a": "Master's",
    "masterofscience": "Master's",
    "masterofarts": "Master's",

    // doctorate
    "phd": "Doctorate",
    "ph.d": "Doctorate",
    "doctor": "Doctorate",
    "doctorate": "Doctorate",
    "dphil": "Doctorate",

    // associates
    "associate": "Associate's",
    "associates": "Associate's",
    "associateofscience": "Associate's",
    "associateofarts": "Associate's",
    "aa": "Associate's",
    "a.a": "Associate's",
    "as": "Associate's",
    "a.s": "Associate's",

    // high school / diploma
    "highschool": "High School",
    "hs": "High School",
    "ged": "High School",
    "diploma": "Diploma",
    "certificate": "Certificate"
  };

  function _n(s) {
    return (s ?? "").toString().trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // Normalize any degree-ish string into canonical buckets above
  H.normalizeDegreeLabel = function normalizeDegreeLabel(s) {
    const k = _n(s);
    if (!k) return s;
    // try direct hit
    if (DEGREE_CANONICAL[k]) return DEGREE_CANONICAL[k];

    // heuristics for common long forms
    if (/bachelor/.test(k)) return "Bachelor's";
    if (/master/.test(k)) return "Master's";
    if (/(phd|doctor)/.test(k)) return "Doctorate";
    if (/(associate|aa|as)\b/.test(k)) return "Associate's";
    if (/(highschool|ged)/.test(k)) return "High School";
    if (/diploma/.test(k)) return "Diploma";
    if (/certificate/.test(k)) return "Certificate";

    return s;
  };

  // expose table for content.js setSelectValueSmart (it looks for H.DEGREE_CANONICAL)
  H.DEGREE_CANONICAL = DEGREE_CANONICAL;

  // Referral normalizer — return a list of candidates to try, without forcing a default
  H.normReferral = function normReferral(val) {
    const s = (val ?? "").toString().trim().toLowerCase();
    if (!s) return null; // IMPORTANT: let filler skip when profile has no value
    if (s.includes("linkedin")) return ["LinkedIn"];
    if (s.includes("indeed")) return ["Indeed"];
    if (s.includes("handshake")) return ["Handshake"];
    if (s.includes("glassdoor")) return ["Glassdoor"];
    if (s.includes("internal")) return ["Internal Referral","Referral","Employee Referral"];
    if (s.includes("friend") || s.includes("referr")) return ["Referral","Employee Referral","Friend"];
    if (s.includes("web") || s.includes("site")) return ["Company Website","Website"];
    return [s.replace(/\b\w/g, c => c.toUpperCase())]; // e.g., "other" → "Other"
  };

  // Country short-hands
  H.normCountry = function normCountry(s) {
    const t = (s ?? "").toString().trim();
    if (!t) return t;
    const k = _n(t);
    if (k === "us" || k === "usa" || k === "u.s.a" || k === "u.s") return "United States";
    return t;
  };
})();

// ===== SFF robust option helpers (append to end of helpers.js) =====
(function () {
  const H = window.H = window.H || window.SFFHelpers || {};

  const _n = (s) => (s ?? "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const _toks = (s) => (s ?? "").toString().toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);

  // Build candidate labels for US states (handles "NJ", "New Jersey", "NJ - New Jersey", etc.)
  H.buildStateCandidates = function buildStateCandidates(input) {
    const raw = (input ?? "").toString().trim();
    if (!raw) return [];
    const abbr = /^[A-Z]{2}$/.test(raw) ? raw : (H.toAbbr ? H.toAbbr(raw) : raw);
    const full = (H.ABBR_TO_STATE && H.ABBR_TO_STATE[abbr]) || raw;
    const both = `${abbr} - ${full}`;
    const both2 = `${full} - ${abbr}`;
    return Array.from(new Set([abbr, full, both, both2]));
  };

  // Country candidates (US variants)
  H.buildCountryCandidates = function buildCountryCandidates(input) {
    const c = H.normCountry ? H.normCountry(input) : (input || "");
    if (_n(c) === "unitedstates") {
      return ["United States", "US", "USA", "U.S.", "U.S.A."];
    }
    return [c];
  };

  // Degree candidates (map many → canonical your selects usually use)
  H.buildDegreeCandidates = function buildDegreeCandidates(val) {
    const canon = H.normalizeDegreeLabel ? H.normalizeDegreeLabel(val) : val;
    const k = _n(canon);
    const out = new Set([canon]);
    if (k.includes("bachelor")) { out.add("Bachelor's"); out.add("Bachelors"); out.add("BS"); out.add("BA"); }
    if (k.includes("master"))   { out.add("Master's"); out.add("MS"); out.add("MA"); }
    if (k.includes("doctor") || k.includes("phd")) { out.add("Doctorate"); out.add("PhD"); }
    if (k.includes("associate")) { out.add("Associate's"); out.add("AS"); out.add("AA"); }
    return Array.from(out);
  };

  // Ethnicity candidates (handles many wordings)
  H.buildEthnicityCandidates = function buildEthnicityCandidates(val) {
    const s = (val ?? "").toString().trim();
    if (!s) return [];
    const k = _n(s);
    if (k.includes("hispanic") || k.includes("latino") || k.includes("latinx")) {
      return ["Hispanic or Latino", "Hispanic/Latino", "Hispanic or Latinx", "Latino", "Latinx"];
    }
    if (k.includes("twoormore") || k.includes("two") && k.includes("more") && k.includes("race")) {
      return ["Two or more races", "Two or More Races", "2 or More Races"];
    }
    // generic: try capitalized original + normalized
    return [s, s.replace(/\b\w/g, c => c.toUpperCase())];
  };

  // Veteran candidates
  H.buildVeteranCandidates = function buildVeteranCandidates(val) {
    const s = (val ?? "").toString().trim().toLowerCase();
    if (!s) return [];
    if (/^no\b|^not\b|^non\b/.test(s)) return ["No", "Not a Veteran", "I am not a veteran"];
    if (/^yes\b/.test(s)) return ["Yes", "Veteran"];
    if (/prefer.*not/.test(s) || /decline/.test(s)) return ["Prefer not to say", "Prefer Not to Say", "Decline to Answer"];
    return [s.replace(/\b\w/g, c => c.toUpperCase())];
  };

  // Canonical yes/no for radios
  H.canonYesNo = function canonYesNo(val) {
    const s = (val ?? "").toString().trim().toLowerCase();
    if (!s) return null;
    if (/^y|^true|authorized|consent|agree|accept/.test(s)) return "Yes";
    if (/^n|^false|not|decline|disagree/.test(s)) return "No";
    return s.replace(/\b\w/g, c => c.toUpperCase());
  };

  // Find best matching option index given candidates (by tokens + normalized containment)
  H.matchOptionIndex = function matchOptionIndex(selectEl, candidates) {
    if (!selectEl || !selectEl.options || !candidates?.length) return -1;
    const opts = Array.from(selectEl.options || []);
    const normOpts = opts.map(o => ({
      text: o.textContent?.trim() || o.label || o.value || "",
      n: _n(o.textContent?.trim() || o.label || o.value || "")
    }));

    const candList = candidates.map(c => ({ raw: c, n: _n(c), toks: _toks(c) }));

    // pass 1: exact normalized match
    for (let i=0;i<normOpts.length;i++){
      for (const c of candList) if (normOpts[i].n === c.n) return i;
    }
    // pass 2: candidate tokens subset of option tokens
    for (let i=0;i<normOpts.length;i++){
      const ot = _toks(normOpts[i].text);
      for (const c of candList){
        if (c.toks.length && c.toks.every(t => ot.includes(t))) return i;
      }
    }
    // pass 3: contains normalized (one side)
    for (let i=0;i<normOpts.length;i++){
      for (const c of candList) {
        if (normOpts[i].n.includes(c.n) || c.n.includes(normOpts[i].n)) return i;
      }
    }
    return -1;
  };
})();

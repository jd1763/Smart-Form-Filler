/* global chrome */
(function () {
    const ALIASES = {
      "c sharp": "csharp",
      "c#": "csharp",
      "node.js": "nodejs",
      "react.js": "react",
      "vue.js": "vue",
      "next.js": "nextjs",
      ".net": "dotnet",
      ".net core": "dotnet",
      "asp.net": "aspnet",
      "asp.net core": "aspnet",
      "k8s": "kubernetes",
      "ci/cd": "cicd",
      "pub/sub": "pubsub",
      "no-sql": "nosql",
    };
  
    let _cache = null;
  
    function norm(s) {
      let t = String(s || "").toLowerCase().trim();
      if (!t) return "";
      if (ALIASES[t]) t = ALIASES[t];
      // normalize multiple spaces
      t = t.replace(/\s+/g, " ");
      return t;
    }
  
    async function loadTerms() {
      if (_cache) return _cache;
  
      const url = chrome.runtime.getURL("skill_terms.txt");
      const txt = await fetch(url, { cache: "no-store" }).then(r => r.text());
  
      const raw = txt
        .split("\n")
        .map(l => l.trim())
        .filter(l => l && !l.startsWith("#"))
        .map(norm);
  
      const single = new Set();
      const phrases = [];
      for (const term of raw) {
        if (!term) continue;
        if (term.includes(" ")) phrases.push(term);
        else single.add(term);
      }
  
      // longer phrases first to reduce partial overlaps
      phrases.sort((a, b) => b.length - a.length);
  
      _cache = { single, phrases };
      return _cache;
    }
  
    function extractFromTextSync(text, terms) {
      const out = new Set();
      const t = String(text || "").toLowerCase();
  
      // 1) token match for single-word terms
      // keep + and # for c++ / c#-ish tokens and dots for node.js-like tokens
      const tokens = t.match(/[a-z0-9][a-z0-9+.#/-]{0,}/g) || [];
      for (const tok of tokens) {
        const n = norm(tok);
        if (terms.single.has(n)) out.add(n);
      }
  
      // 2) phrase match for multi-word terms
      // simple includes with boundary-ish checks
      for (const ph of terms.phrases) {
        const idx = t.indexOf(ph);
        if (idx === -1) continue;
  
        // crude boundary check: char before/after should not be alnum
        const before = idx === 0 ? " " : t[idx - 1];
        const after = idx + ph.length >= t.length ? " " : t[idx + ph.length];
        const okBefore = !/[a-z0-9]/i.test(before);
        const okAfter = !/[a-z0-9]/i.test(after);
        if (okBefore && okAfter) out.add(ph);
      }
  
      return Array.from(out).sort();
    }
  
    async function extractFromText(text) {
      const terms = await loadTerms();
      return extractFromTextSync(text, terms);
    }
  
    async function computeSkillsFromResumeTextFetcher(fetchResumeTextFn) {
      const text = await fetchResumeTextFn();
      return extractFromText(text);
    }
  
    // Expose a single global
    window.SkillsWhitelist = {
      loadTerms,
      extractFromText,
      computeSkillsFromResumeTextFetcher,
    };
  })();
  
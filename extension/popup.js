/***********************
 * POPUP — MATCHER + FILLER (Week-5 kept) + Week-6 multi-resume + UI polish
 ***********************/
const DEBUG = true;
const log = (...a) => DEBUG && console.log("[popup]", ...a);
const err = (...a) => console.error("[popup]", ...a);

// Mutable base; background.js is the single source of truth.
let BACKEND_BASE =
  (typeof localStorage !== "undefined" && localStorage.getItem("backend_base")) ||
  "http://127.0.0.1:5000";

function setBackendBase(base) {
  if (typeof base === "string" && base.startsWith("http")) {
    BACKEND_BASE = base;
    try { localStorage.setItem("backend_base", base); } catch (_) {}
  }
}

// Track backend availability so we don't keep hammering it if it's down
let BACKEND_AVAILABLE = null; // null = unknown, true = up, false = down

// Minimal backend helper: single base, no health checks, no failover
async function fetchWithFailover(path, opts) {
  const baseDefaults = {
    cache: "no-store",
    credentials: "omit", // no cookies/sessions involved
    headers: Object.assign(
      { "Accept": "application/json" },
      (opts && opts.headers) || {}
    ),
  };
  const finalOpts = Object.assign({}, baseDefaults, opts || {});

  let resp;
  try {
    resp = await fetch(`${BACKEND_BASE}${path}`, finalOpts);
  } catch (e) {
    // True network error (backend not running / blocked)
    const err = new Error(`network-failed: ${e && e.message}`);
    err.kind = "network";
    throw err;
  }

  if (!resp.ok) {
    let bodyText = "";
    try {
      bodyText = await resp.text();
    } catch (_) {
      // ignore
    }
    const err = new Error(
      `http-${resp.status}${bodyText ? `: ${bodyText}` : ""}`
    );
    err.kind = "http";
    err.status = resp.status;
    err.body = bodyText;
    throw err;
  }

  return resp;
}

// Ask background.js for backend base + health so everything uses the same port.
async function queryBackendStatus(forceReprobe = false) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { action: "getBackendStatus", forceReprobe: !!forceReprobe },
        (resp) => {
          if (!resp || resp.success === false) {
            log("[popup] getBackendStatus failed:", resp && resp.error);
            resolve({
              ok: false,
              base: BACKEND_BASE,
              lastChecked: Date.now(),
            });
            return;
          }
          if (resp.base) {
            setBackendBase(resp.base);
          }
          log("[popup] getBackendStatus:", resp.ok, "base:", resp.base);
          resolve(resp);
        }
      );
    } catch (e) {
      err("[popup] getBackendStatus sendMessage error:", e);
      resolve({
        ok: false,
        base: BACKEND_BASE,
        lastChecked: Date.now(),
      });
    }
  });
}

// Health check: delegate to background.getBackendStatus (single source of truth)
async function ensureBackendHealthy(forceReprobe = false) {
  if (!forceReprobe && BACKEND_AVAILABLE === true) {
    log("[popup] ensureBackendHealthy/bg: using cached OK");
    return true;
  }

  try {
    const st = await queryBackendStatus(forceReprobe);
    const ok = !!st.ok;

    BACKEND_AVAILABLE = ok;
    if (st.base) {
      setBackendBase(st.base);
    }

    log(
      "[popup] ensureBackendHealthy/bg:",
      ok ? "UP" : "DOWN",
      "base:",
      BACKEND_BASE
    );
    return ok;
  } catch (e) {
    BACKEND_AVAILABLE = false;
    err("[popup] ensureBackendHealthy/bg error:", e);
    return false;
  }
}

// --- global shims so legacy pieces don't crash ---
if (typeof window.getActiveTab === "undefined") {
  window.getActiveTab = async function () {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t || null;
  };
}
if (typeof window.sendToTab === "undefined") {
  window.sendToTab = function (tabId, payload) {
    return new Promise(res =>
      chrome.tabs.sendMessage(tabId, payload, r => res(r))
    );
  };
}

// Classify whether we can/should inject on this URL (popup-only guard)
function classifyPageUrl(urlRaw){
  const url = String(urlRaw || "");
  const lower = url.toLowerCase();

  const withId = (pfx) => lower.startsWith(`${pfx}${chrome.runtime?.id || ""}`);

  // Hard no: browser/extension internals
  if (lower.startsWith("chrome://") || lower.startsWith("edge://") || lower.startsWith("about:") || lower.startsWith("view-source:")) {
    return { ok:false, reason:"internal", msg:"❌ This is a browser internal page. Open a normal website tab." };
  }
  if (lower.startsWith("chrome-extension://")) {
    // If it's our own extension page (e.g., profile.html), be explicit
    if (withId("chrome-extension://")) {
      return { ok:false, reason:"extension_self", msg:"❌ This is the extension page (profile/settings). Open a job form tab to fill." };
    }
    return { ok:false, reason:"extension_other", msg:"❌ This is an extension page. Open a normal website tab." };
  }

  // PDFs often run in a viewer we can’t inject into
  if (/\.(pdf)(\?|#|$)/i.test(lower) || /\/pdfviewer\//i.test(lower) || /\/pdfjs\//i.test(lower)) {
    return { ok:false, reason:"pdf", msg:"❌ This looks like a PDF viewer. Open an HTML application form." };
  }

  // about:blank or data URLs
  if (lower === "" || lower === "about:blank" || lower.startsWith("data:")) {
    return { ok:false, reason:"blank", msg:"❌ No active page to fill. Navigate to a form first." };
  }

  return { ok:true };
}

// Safe wrapper around your ensureContent — never throws, returns {ok, reason, err}
async function ensureContentSafe(tabId){
  try {
    const ok = await ensureContent(tabId);
    return { ok: !!ok };
  } catch (e) {
    const msg = e && (e.message || String(e)) || "unknown";
    if (/Cannot access contents of url/i.test(msg)) return { ok:false, reason:"injectionDenied", err:msg };
    if (/Receiving end does not exist/i.test(msg))   return { ok:false, reason:"notReachable", err:msg };
    return { ok:false, reason:"unknown", err:msg };
  }
}

// Safe wrapper for sendToFrame — returns null on runtime errors
async function sendToFrameSafe(tabId, frameId, payload){
  try {
    return await sendToFrame(tabId, frameId, payload);
  } catch (e) {
    console.warn("[popup] sendToFrameSafe error:", e);
    return null;
  }
}

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

function setLoading(visible, msg){
  const overlay = document.getElementById("loadingView");
  const label   = document.getElementById("loadingMsg");
  if (overlay) overlay.style.display = visible ? "flex" : "none";
  if (label && msg) label.textContent = msg;
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
const MATCH_ROUTE = "/match";

// Combined + expanded whitelist (mirrors SKILL_TERMS). Keep lowercase; your normalizer can map symbols.
const SKILL_WORDS = new Set([
  // Languages
  "python","java","javascript","typescript","c","c++","c#","c sharp","csharp",
  "go","golang","rust","scala","kotlin","swift","objective-c","ruby","php","perl",
  "r","dart","matlab","julia","sql","nosql","no-sql","bash","zsh","powershell",
  "html","css","scss","sass","less",

  // Frontend & Web
  "react","react.js","reactjs","redux","next.js","nextjs","angular","angularjs",
  "vue","vue.js","vuejs","svelte","sveltekit","tailwind","tailwindcss","bootstrap",
  "material ui","mui","chakra ui","three.js","d3","chart.js","storybook",
  "webpack","vite","rollup","babel","eslint","prettier",

  // Backend & APIs
  "node","node.js","nodejs","express","express.js","koa","nest","nest.js","nestjs",
  "fastify","hapi","django","flask","fastapi","tornado","pyramid",
  "spring","spring boot","spring mvc","hibernate","quarkus","micronaut",
  "asp.net","asp.net core",".net",".net core","dotnet","laravel","symfony",
  "codeigniter","rails","ruby on rails","phoenix","elixir","gin","fiber",
  "rest","rest api","graphql","grpc","soap","websocket","websockets",
  "openapi","swagger","asyncio",

  // Databases (SQL)
  "mysql","mariadb","postgres","postgresql","oracle","sql server","mssql","sqlite",
  "aurora","redshift","snowflake","bigquery","synapse","teradata",

  // Databases (NoSQL, search, cache, time series, graph)
  "mongodb","dynamodb","cassandra","couchdb","cosmos db","neo4j","arangodb","janusgraph",
  "hbase","elasticsearch","opensearch","solr","redis","memcached","influxdb",
  "timescaledb","prometheus","questdb",

  // Data formats & serialization
  "parquet","orc","avro","jsonl","protobuf","thrift","csv",

  // Data/ETL/Streaming/Orchestration
  "spark","hadoop","yarn","mapreduce","hive","pig","presto","trino","flink","beam",
  "airflow","luigi","prefect","dbt",
  "kafka","schema registry","ksql","pulsar","kinesis","pubsub","pub/sub",
  "eventbridge","sqs","sns","rabbitmq","activemq","nats","zeromq","celery","sidekiq",

  // DevOps / CI-CD / Build
  "git","github","gitlab","bitbucket","svn",
  "ci","cd","ci/cd","github actions","gitlab ci","circleci","jenkins","travis",
  "teamcity","bamboo","spinnaker","argo","argo cd","argo workflows",
  "nexus","jfrog","artifactory","sonarqube","coveralls","codecov",
  "maven","gradle","sbt","ant","make","cmake","nmake","poetry","pipenv","virtualenv","conda",
  "npm","yarn","pnpm","pip","twine","tox","ruff","flake8","black","isort","pylint","mypy",
  "pre-commit","shellcheck",

  // Containers / Orchestration / Networking
  "docker","docker compose","podman","kubernetes","k8s","helm","istio","linkerd",
  "traefik","haproxy","nginx","apache httpd","apache","caddy","envoy","consul","vault",
  "nomad","etcd","zookeeper",

  // Cloud (AWS)
  "aws","cloud","iam","ec2","s3","rds","aurora","efs","ecr","elb","alb","nlb","vpc",
  "route 53","cloudfront","cloudwatch","cloudtrail","lambda","api gateway",
  "step functions","eventbridge","sns","sqs","sagemaker","athena","glue","emr",
  "kinesis","eks","ecs","fargate","elastic beanstalk","batch","lightsail","secrets manager",
  "kms","opensearch",

  // Cloud (GCP)
  "gcp","compute engine","cloud storage","cloud sql","bigquery","spanner","firestore",
  "datastore","bigtable","pub/sub","dataflow","dataproc","composer","gke","cloud run",
  "cloud functions","vertex ai","cloud build","artifact registry","cloud logging",
  "cloud monitoring","memorystore","iam",

  // Cloud (Azure)
  "azure","vm","aks","app service","functions","cosmos db","sql database","blob storage",
  "event hubs","service bus","synapse","databricks","data factory","key vault","monitor",
  "devops","pipelines","container registry","application gateway",

  // Testing / QA
  "unit testing","unittest","pytest","nose","doctest","junit","testng","mockito","hamcrest",
  "kotest","spock","xunit","mstest","selenium","cypress","playwright","puppeteer",
  "robot framework","rest-assured","supertest","jest","mocha","chai","ava","vitest",
  "enzyme","jasmine","karma","postman","newman","locust","k6","gatling","jmeter","tdd","bdd",
  "property-based testing","hypothesis",

  // Mobile
  "android","android sdk","jetpack","jetpack compose","gradle","adb",
  "ios","swiftui","xcode","cocoapods",
  "react native","expo","flutter","ionic","cordova",

  // Analytics / Viz
  "matplotlib","seaborn","plotly","bokeh","altair","ggplot","tableau","looker","lookml",
  "power bi","superset","metabase","redash","grafana","kibana","quicksight",

  // ML / AI / MLOps
  "machine learning","ml","deep learning","dl","scikit-learn","sklearn","pandas","numpy",
  "scipy","xgboost","lightgbm","catboost","pytorch","tensorflow","tf","keras",
  "pytorch lightning","onnx","mlflow","huggingface","transformers","opencv","nltk","spacy",
  "gensim","fairseq","detectron","yolo","stable diffusion","prophet","statsmodels",
  "feature engineering","model deployment","model serving","onnxruntime","triton inference server",
  "kubeflow","seldon","bentoml","ray","ray serve","feast","tfx","vertex ai",

  // Observability / Logging
  "prometheus","loki","tempo","jaeger","zipkin","opentelemetry","elastic stack","elk",
  "logstash","fluentd","fluent-bit","datadog","new relic","splunk","sentry","rollbar","honeycomb",

  // Security & Auth
  "oauth","oauth2","openid connect","oidc","jwt","saml","mfa","sso","rbac","abac",
  "tls","ssl","https","ssh","bcrypt","argon2","pbkdf2","owasp","cors","csrf","rate limiting",
  "waf","zap","burp suite","keycloak","okta","auth0","cognito","kms","secrets manager","vault",

  // Architecture & CS topics
  "microservices","event-driven","domain-driven design","ddd","clean architecture",
  "hexagonal architecture","cqrs","event sourcing","message queues","caching","cache",
  "webhooks","serverless","monolith","soa","design patterns","data structures","algorithms",
  "oop","functional programming","concurrency","multithreading","async","synchronization",
  "transactions","acid","cap theorem","eventual consistency","distributed systems",

  // Workflow & misc tools
  "jira","confluence","notion","slack","microsoft teams","excel","gitflow","semver"
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
    // prefer canonical labelText, then explicit label, then id/name; never placeholder
    label: x.labelText || x.label || x.id || x.name || "(Unknown)",
    confidence: "N/A"
  }));
}

  // ---------- tab + messaging helpers ----------
async function getActiveTab(){
  return new Promise(res=>{
    chrome.tabs.query({active:true,currentWindow:true},tabs=>res(tabs?.[0]||null));
    });
  }

  async function ask(tabId, payload) {
    try { return await chrome.tabs.sendMessage(tabId, payload); }
    catch { return null; }
  }

  function sendToTab(tabId, payload) {
    return new Promise(res => {
      chrome.tabs.sendMessage(tabId, payload, (resp) => {
        if (chrome.runtime.lastError) return res({ ok:false, error: chrome.runtime.lastError.message });
        res(resp || { ok:false });
      });
    });
  }
  
  // Run the Key Skills pass in the best frame (handles iframes)
async function runKeySkillsPass(tabId){
  try{
    if (!await ensureContent(tabId)) return { ok:false, error:"content unreachable" };
    const frameId = await getBestFrame(tabId);
    const resp = await sendToFrame(tabId, frameId, { action: "EXT_CHECK_KEY_SKILLS" });

    // Recheck consent checkboxes after skills pass
    await runConsentBroadcast(tabId);

    log("[popup] key-skills:", resp);
    return resp || { ok:false };
  }catch(e){
    err("[popup] key-skills error:", e);
    return { ok:false, error:String(e) };
  }
}

// --------- detection + seeding ----------
async function detectAndSeed() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    // clear UI
    renderDetected(detectedListEl, []);
    if (typeof refreshAllCounts === "function") {
      refreshAllCounts({ detectedCount: 0, filledCount: 0, nonFilledCount: 0 });
    }
    detectedHintEl.textContent = "No active tab.";
    return { detected: [], pageKey: "" };
  }

  detectedHintEl.textContent = "Scanning page for fields…";

  // Ensure content is injected
  if (!await ensureContent(tab.id)) {
    renderDetected(detectedListEl, []);
    if (typeof refreshAllCounts === "function") {
      refreshAllCounts({ detectedCount: 0, filledCount: 0, nonFilledCount: 0 });
    }
    detectedHintEl.textContent = "Couldn’t reach the page. Try again on a form.";
    return { detected: [], pageKey: "" };
  }

  // Ask the best frame to detect fields — exactly like detectDebug
  const frameId = await getBestFrame(tab.id);
  let resp = await sendToFrame(tab.id, frameId, { action: "EXT_DETECT_FIELDS" });
  if (!resp || !resp.ok) {
    resp = await sendToFrame(tab.id, frameId, { action: "EXT_DETECT_FIELDS_SIMPLE" });
  }

  const raw = Array.isArray(resp?.detected) ? resp.detected : [];
  // Build the Detected list from labelText only (same as detectDebug/predict)
  const detected = raw
  .map(d => ({
    key: d.prediction || d.name || d.id || null,
    label: (d.labelText || "").trim(),   // authoritative label
    selector: d.selector || null          // needed to tie to the page snapshot
  }))
  .filter(x => x.label);

  // Store once so other flows can reuse
  window.SFF_DETECTED = detected.slice();

  // Render Detected only (no filled/non-filled yet)
  renderDetected(detectedListEl, detected);
  detectedHintEl.textContent = `${detected.length} fields found`;

  // Update header counts safely (don’t touch missing globals)
  if (typeof refreshAllCounts === "function") {
    refreshAllCounts({
      detectedCount: detected.length,
      filledCount: 0,
      nonFilledCount: 0
    });
  }

  return { detected };
}

// === Build Filled / Non-Filled from the current page snapshot (confidence N/A) ===
async function rescanFilledNonFilledFromPage() {
  try {
    const tab = await (window.getActiveTab ? window.getActiveTab() : (async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      return t || null;
    })());
    if (!tab?.id) return;

    // Ensure content is injected; get best frame (even if unused here)
    if (typeof ensureContent === "function") {
      const ok = await ensureContent(tab.id);
      if (!ok) return;
    }
    const frameId = (typeof getBestFrame === "function") ? await getBestFrame(tab.id) : 0;

    // Ask content which fields are currently filled vs not filled
    const snap = await new Promise(res =>
      chrome.tabs.sendMessage(tab.id, { action: "EXT_SNAPSHOT_BUCKETS" }, r => res(r || {}))
    );

    const filledRaw    = Array.isArray(snap?.filled)    ? snap.filled    : [];
    const notFilledRaw = Array.isArray(snap?.notFilled) ? snap.notFilled : [];

    // Build a selector -> detectorLabel map from our Detected box
    const det = Array.isArray(window.SFF_DETECTED) ? window.SFF_DETECTED : [];
    const labelBySel = new Map(det.filter(d => d.selector).map(d => [d.selector, d.label]));

    // Load confidence cache from last fill
    const { sffConfCache } = await chrome.storage.local.get("sffConfCache");
    const confCache = sffConfCache || {};
    const pickConf = (rec) => {
      const v =
        (rec?.selector && confCache.bySelector?.[rec.selector]) ??
        (rec?.key      && confCache.byKey?.[rec.key]) ??
        (rec?.label    && confCache.byLabel?.[rec.label]);
      return (v == null ? "N/A" : v); // number in [0..1] or "N/A"
    };
    // Always show the detector's label when we have a selector match
    const toRow = (rec) => {
      const label = (rec?.selector && labelBySel.get(rec.selector)) || rec?.label || "(Unknown)";
      const row = {
        key: rec.key || null,
        label,
        confidence: pickConf(rec)
      };
      if (typeof rec.value !== "undefined") row.value = rec.value;
      return row;
    };

    const filled    = filledRaw.map(toRow);
    const nonFilled = notFilledRaw.map(toRow);

    // Render
    renderFieldList(filledFieldsEl, filled,    { title: "Filled",     mode: "filled"    });
    renderFieldList(notFilledFieldsEl, nonFilled, { title: "Non-Filled", mode: "nonfilled" });
    // Ensure "Not filled" styling stays consistent
    if (typeof forceNonFilledBadges === "function") {
      forceNonFilledBadges(notFilledFieldsEl);
    }

    // Header counts (Detected from detector; buckets from snapshot)
    if (typeof refreshAllCounts === "function") {
      refreshAllCounts({
        detectedCount: det.length,
        filledCount: filled.length,
        nonFilledCount: nonFilled.length
      });
    }
  } catch (e) {
    console.error("[popup] rescanFilledNonFilledFromPage error:", e);
  }
}

// Minimal rescan: refresh Detected from the page, nothing else.
window.rescanNow = async function() {
  try {
    return await detectAndSeed();
  } catch (e) {
    console.error("[popup] rescanNow error:", e);
    return { detected: [] };
  }
};

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
    // Re-resolve bucket containers locally so this function never depends on outer scope
    const filledFieldsEl     = document.getElementById("filledFields");
    const notFilledFieldsEl  = document.getElementById("notFilledFields");
    if (!filledFieldsEl || !notFilledFieldsEl) return;

    if (!reportOrNull) {
      renderFieldList(filledFieldsEl, [], { title: "Filled", mode: "filled" });
      const nonFilledInit = detected.map(d => ({ key: d.key || null, label: d.label, confidence: "N/A" }));
      renderFieldList(notFilledFieldsEl, nonFilledInit, { title: "Non-Filled", mode: "nonfilled" });
      forceNonFilledBadges(notFilledFieldsEl);
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
    // live counters coming from the UI that's currently rendered
    function currentCounts() {
      const detectedCount =
        (Array.isArray(window.SFF_DETECTED) && window.SFF_DETECTED.length) ||
        (document.getElementById("detectedList")?.querySelectorAll(".field-item").length || 0);
      const filledCount =
        (document.getElementById("filledFields")?.querySelectorAll(".field-item").length || 0);
      const nonFilledCount =
        (document.getElementById("notFilledFields")?.querySelectorAll(".field-item").length || 0);
      return { detectedCount, filledCount, nonFilledCount };
    }
  
    function setHeader(hdrEl, panelEl, base, count) {
      const open = panelEl.style.display !== "none";
      hdrEl.dataset.base  = base;
      hdrEl.dataset.count = String(count);
      hdrEl.textContent   = `${open ? "▼" : "▶"} ${base} (${count})`;
    }
  
    const toggles = [
      { hdr: document.getElementById("detectedToggle"),  panel: document.getElementById("detectedFields"),  base: "Detected Fields" },
      { hdr: document.getElementById("filledToggle"),    panel: document.getElementById("filledFields"),    base: "Filled Fields" },
      { hdr: document.getElementById("notFilledToggle"), panel: document.getElementById("notFilledFields"), base: "Non-Filled Fields" },
    ].filter(x => x.hdr && x.panel);
  
    toggles.forEach(({hdr, panel, base}) => {
      hdr.addEventListener("click", () => {
        const open = panel.style.display !== "none";
        panel.style.display = open ? "none" : "block";
        const { detectedCount, filledCount, nonFilledCount } = currentCounts();
        const n = base.startsWith("Detected") ? detectedCount
                : base.startsWith("Filled")   ? filledCount
                : nonFilledCount;
        setHeader(hdr, panel, base, n);
      });
    });
  
    // initial paint
    const { detectedCount, filledCount, nonFilledCount } = currentCounts();
    toggles.forEach(({hdr, panel, base}) => {
      const n = base.startsWith("Detected") ? detectedCount
              : base.startsWith("Filled")   ? filledCount
              : nonFilledCount;
      setHeader(hdr, panel, base, n);
    });
  }  
  wireToggles();

  // ---------- INIT (fresh every open; no cache restore) ----------
  const { detected } = await detectAndSeed();
  statusEl.textContent = "Ready…";
  btnTryAgain.style.display = "none";
  await rescanFilledNonFilledFromPage();

  // ---------- fill button ----------
  btnFill?.addEventListener("click", async () => {
    // --- capture matched skills for the SELECTED resume used to APPLY (not suggestor) ---
    try {
      // 1) get selected resume text (from the UI where the user picked it)
      const getSelectedResumeText = () => {
        // selected card pattern
        const card = document.querySelector('.resume-card.selected [data-resume-text], .resume-card.is-active [data-resume-text]');
        if (card) return (card.textContent || card.value || "").trim();

        // select dropdown pattern
        const dd = document.querySelector('#resumeSelect, select[name="resume"], select[data-role="resume"]');
        if (dd && dd.value) {
          const opt = dd.options[dd.selectedIndex];
          if (opt && opt.textContent) return opt.textContent.trim();
        }

        // textarea / preview pattern
        const ta = document.querySelector('#resumeText, textarea[name="resumeText"], .resume-preview, #resume-preview');
        if (ta) return (ta.textContent || ta.value || "").trim();

        return "";
      };

      // 2) get job description text if available (helps if we re-match)
      const getJobText = () => {
        const el = document.querySelector('#jobDescription, textarea[name="jobDescription"], #jd, .jd-text');
        return el ? (el.value || el.textContent || "").trim() : "";
      };

      const resumeText = getSelectedResumeText();
      const jobText    = getJobText();

      // 3) compute match for THIS resume (if computeMatch exists). Otherwise, fall back to existing buckets on screen.
      let required = [], preferred = [];
      if (typeof computeMatch === "function" && resumeText) {
        const m = computeMatch(resumeText, jobText);
        if (Array.isArray(m?.required))  required  = m.required;
        if (Array.isArray(m?.preferred)) preferred = m.preferred;
      }
      if (!required.length || !preferred.length) {
      // fallback: scrape visible lists from the popup UI (NEW: chip containers)
      const reqDom = Array.from(
        document.querySelectorAll('#matchedReq .chip, #skills-required li, #skillsRequired li, .bucket.skills .required li')
      ).map(el => el.textContent.trim()).filter(Boolean);

      const prefDom = Array.from(
        document.querySelectorAll('#matchedPref .chip, #skills-preferred li, #skillsPreferred li, .bucket.skills .preferred li')
      ).map(el => el.textContent.trim()).filter(Boolean);

      if (!required.length)  required  = reqDom;
      if (!preferred.length) preferred = prefDom;

      }

      // 4) write to storage and await completion so content.js can read immediately
      await new Promise(res => chrome.storage.local.set(
        { matchedSkills: { required, preferred } },
        () => res()
      ));
      console.log("[popup] matchedSkills (selected resume) saved:", { required: required.length, preferred: preferred.length });
    } catch (e) {
      console.warn("[popup] matchedSkills(save) failed:", e);
    }
    // --- end capture ---

    try {
      // Use the single, unified fill pipeline so skills/education/experience logic is consistent.
      await fillUsingPredictPipeline({ silent: true });
    
      // === prevent over-add and fill experiences ===
      const tab = await getActiveTab();
      if (tab?.id) {
        // 1) Load the profile so the content script knows the exact experience target
        let prof = {};
        try {
          prof = await getProfileFromBackend(); // already defined in this file
        } catch (_) {
          prof = {};
        }
            
        // 2) Ensure content + target the best frame
        await ensureContent(tab.id);
        const frameId = await getBestFrame(tab.id);

        // 3) Now actually fill the Experience (and Education) blocks
        const { lastResumeId } = await chrome.storage.local.get("lastResumeId");
        await sendToFrame(tab.id, frameId, {
          action: "EXT_FILL_FIELDS",
          items: (typeof SFF_DETECTED !== "undefined" && Array.isArray(SFF_DETECTED)) ? SFF_DETECTED : [],
          profile: prof,
          resumeId: lastResumeId || null
        });

        // 5) Settle, rescan counts for the popup, and run key-skills pass
        await new Promise(r => setTimeout(r, 180));
        await rescanNow();
        await runKeySkillsPass(tab.id);
        await rescanFilledNonFilledFromPage();
      }
    } catch (e) {
      statusEl.textContent = "❌ " + (e.message || e);
    }    
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

  // 80/20 split
  const score = (80 * reqFrac) + (20 * prefFrac);
  return Math.round(score);
}

/* ===================== API CALLS ===================== */
async function callMethod(method, job_text, resume_id) {
  const r = await fetchWithFailover(MATCH_ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resume_id, job_description: job_text, method })
  });
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
  // 0) Read the tab url to see if we should even try injecting
  let url = "";
  try {
    const t = await chrome.tabs.get(tabId);
    url = t?.url || "";
  } catch {}

  const cls = (typeof classifyPageUrl === "function") ? classifyPageUrl(url) : { ok:true };
  if (!cls.ok) {
    // Don’t attempt injection on browser internals / extension pages / PDFs / blanks
    log("[popup] ensureContent: skip injection on", cls.reason, url);
    return false;
  }

  // 1) If content is already alive, we’re good
  if (await pingAny(tabId)) return true;

  // 2) Try to inject scripts (helpers first, then content)
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["helpers.js", "content.js"]
    });
  } catch (e) {
    const msg = e?.message || String(e);
    // These are expected when pages are not injectible; don’t treat as errors
    if (/Cannot access contents of url/i.test(msg) ||
        /extensions cannot inject into/i.test(msg)) {
      log("[popup] ensureContent: injection denied on", url, ":", msg);
      return false;
    }
    // Other unexpected errors — keep as errors
    err("inject helpers/content:", msg);
    return false;
  }

  // 3) One final ping to confirm
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
async function sendToAllFrames(tabId, payload) {
  // Try to enumerate frames; fall back to top frame if API is unavailable
  let frames = [];
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {}
  if (!frames?.length) {
    const one = await sendToFrame(tabId, 0, payload);
    return [one];
  }
  const results = [];
  for (const f of frames) {
    const resp = await sendToFrame(tabId, f.frameId, payload);
    if (resp) results.push(resp);
  }
  return results;
}
async function runConsentBroadcast(tabId) {
  if (!await ensureContent(tabId)) return { ok:false, error:"content unreachable" };
  const resps = await sendToAllFrames(tabId, { action: "EXT_CHECK_CONSENT" });
  // merge results
  const merged = (resps || []).reduce((acc, r) => ({
    ok: acc.ok && (r?.ok !== false),
    tried: acc.tried + (r?.tried || 0),
    checked: acc.checked + (r?.checked || 0),
    total: acc.total + (r?.total || 0),
  }), { ok:true, tried:0, checked:0, total:0 });
  return merged;
}
// Send a specific list of predicted key skills; content will intersect with resume's matched skills
async function runPredictedKeySkillsPass(tabId, skills){
  try{
    if (!await ensureContent(tabId)) return { ok:false, error:"content unreachable" };
    const frameId = await getBestFrame(tabId);
    const unique = Array.from(new Set((skills||[]).map(s=>String(s).trim()).filter(Boolean)));
    const resp = await sendToFrame(tabId, frameId, {
      action: "EXT_CHECK_PREDICTED_KEY_SKILLS",
      skills: unique
    });
    log("[popup] predicted key-skills:", resp);
    return resp || { ok:false };
  }catch(e){
    err("[popup] predicted key-skills error:", e);
    return { ok:false, error:String(e) };
  }
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
  // If we've already decided the backend is down, don't even try again
  if (BACKEND_AVAILABLE === false) {
    return [];
  }

  try {
    const r = await fetchWithFailover("/resumes");
    const data = await r.json();

    BACKEND_AVAILABLE = true; // mark as healthy

    return (data.items || []).map(it => ({
      id:        it.id,
      name:      it.original_name,
      createdAt: it.created_at
    }));
  } catch (e) {
    // If it's a network failure *or* a 403 from your backend, treat it as "unusable"
    if (e.kind === "network" || e.status === 403) {
      BACKEND_AVAILABLE = false;

      const statusEl = document.getElementById("status");
      if (statusEl) {
        statusEl.textContent =
          "Smart Form Filler API is offline or unavailable. " +
          "Start the backend if you want resume matching.";
      }

      // Quietly fall back to "no resumes" (and no noisy console error)
      console.warn("[popup] backend /resumes unavailable:", e.message || e);
      return [];
    }

    // Other unexpected HTTP errors: log once but still don't blow up the UI
    console.error("[popup] backend /resumes error:", e);

    const statusEl = document.getElementById("status");
    if (statusEl) {
      statusEl.textContent =
        "❌ Error talking to Smart Form Filler API. See console for details.";
    }

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

// Persist selected resume, fetch keyword skills, mirror to backend profile, and cache locally.
async function setSelectedResumeById(resumeId, resumeName){
  try {
    // 1) Get skills for this resume
    const r = await fetchWithFailover(`/skills/by_resume`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ resumeId })
    });    
    const j = await r.json();
    const skills = Array.isArray(j.skills) ? j.skills : [];
    const name   = resumeName || j.name || String(resumeId) || "";

    // 2) Cache locally so popup/content can use immediately
    await chrome.storage.local.set({
      lastResumeId: resumeId,
      selectedResume: { id: resumeId, name, skills }
    });

    // 3) Guard: only touch backend if it's reachable (prevents wipes if down/misconfigured)
    let backendOk = false;
    try {
      await fetchWithFailover(`/profile`);
      backendOk = true;
    } catch (_) {
      backendOk = false;
    }    
    if (!backendOk) {
      console.warn("[popup] GET /profile failed; skip PATCH to avoid corrupting profile.json");
      console.log("[popup] Cached selection locally only.");
      return; // ← do not PATCH if we can't read current profile
    }

    // 4) PATCH-merge only the selectedResume* fields (Step 2)
    const patch = {
      selectedResumeId: String(resumeId || ""),
      selectedResumeName: String(name || ""),
      selectedResumeSkills: Array.from(new Set(skills)).sort()
    };
    await fetchWithFailover(`/profile`, {
      method: "PATCH",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(patch)
    });    

    console.log("[popup] selectedResume updated with skills:", resumeId, skills.length);
  } catch (e) {
    console.error("[popup] setSelectedResumeById failed:", e);
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
  sel.addEventListener("change", async (e) => {
    const id = e.target.value;
    const name = e.target.options[e.target.selectedIndex]?.textContent || id || "";
    await setLastResumeId(id);
    if (!id) {
      await chrome.storage.local.set({
        lastResumeId: "",
        selectedResume: { id:"", name:"", skills:[] }
      });
      return;
    }
    await setSelectedResumeById(id, name);
  });

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

  // BACKEND HEALTH GATE: never hit /resumes if backend isn't healthy
  if (BACKEND_AVAILABLE === false) {
    hideMatch();
    showNoResumesCard();
    return;
  }
  if (BACKEND_AVAILABLE === null) {
    const ok = await ensureBackendHealthy();
    if (!ok) {
      hideMatch();
      showNoResumesCard();
      return;
    }
  }

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
          await setSelectedResumeById(sel.id, sel.name || sel.id);
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
const setStatus = (msg) => {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
};

// --- flash status (auto-clear after a moment, then show an "after" message) ---
let _statusTimer = null;
function flashStatus(msg, ms = 2500, after = "") {
  const el = document.getElementById("status");
  if (!el) return;

  el.textContent = msg;

  if (_statusTimer) clearTimeout(_statusTimer);
  _statusTimer = setTimeout(() => {
    const el2 = document.getElementById("status");
    if (!el2) return;
    // Only replace if nobody changed the status in the meantime
    if (el2.textContent === msg && after) {
      el2.textContent = after;
    }
  }, ms);
}

// --- make Try Again match Fill Form (with graceful fallback) ---
function harmonizeTryAgainStyle() {
  const fill  = document.getElementById("fillForm");
  const retry = document.getElementById("tryAgain");
  if (!fill || !retry) return;

  // Copy classes if Fill Form has them
  if (fill.className) retry.className = fill.className;

  // Minimal pretty fallback if no shared classes exist
  if (!fill.className) {
    retry.style.cssText = [
      "display:inline-flex","align-items:center","gap:6px",
      "padding:8px 12px","border-radius:8px","border:1px solid #e5e7eb",
      "background:#111827","color:#fff","font-weight:600","cursor:pointer"
    ].join(";");
  }

  // Add a simple icon if none present
  if (!retry.dataset.styled) {
    retry.dataset.styled = "1";
    retry.innerHTML = `<span aria-hidden="true"></span><span>Try Again</span>`;
  }
}

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
    const inFilledSection    = (mode === "filled");
    const inNonFilledSection = (mode === "nonfilled");
    const showAsFilled       = inFilledSection || (confPct != null && confPct > 0);
    
    const card=document.createElement("div"); card.className="field-item";
    const label=document.createElement("div"); label.className="label"; label.textContent=f.label;

    const badge=document.createElement("span"); 
    badge.className = "badge" + (showAsFilled ? "" : " na");
    // If we know the section, state it explicitly; otherwise fall back to confidence-based guess
    badge.textContent = inFilledSection
        ? "Filled"
        : inNonFilledSection
          ? "Not filled"
          : (showAsFilled ? "Filled" : "N/A");         // for Non-Filled we’ll fix this text after render
    label.appendChild(document.createTextNode(" "));
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

  // BACKEND HEALTH GATE: don't even try /resumes if backend is down
  if (BACKEND_AVAILABLE === false) {
    return;
  }
  if (BACKEND_AVAILABLE === null) {
    const ok = await ensureBackendHealthy();
    if (!ok) return;
  }
  
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

async function renderResultsAndRemember(url, resp, statusText){
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
  if (statusText && /^✅/.test(statusText)) {
    flashStatus(statusText, 2600, " Ready.");
  } else {
    setStatus(statusText);
  }  
  
  // cache confidences so a later rescan can restore chip + meter
  try {
    const confCache = { bySelector: {}, byKey: {}, byLabel: {} };
    const add = (arr=[]) => arr.forEach(f => {
      const c = (typeof f.confidence === "number") ? f.confidence : parseConfidence(f.confidence);
      if (f?.selector) confCache.bySelector[f.selector] = c;
      if (f?.key)      confCache.byKey[f.key]           = c;
      const lbl = (f?.label || "").trim();
      if (lbl)         confCache.byLabel[lbl]           = c;
    });
    add(Array.isArray(resp.filled)    ? resp.filled    : []);
    add(Array.isArray(resp.notFilled) ? resp.notFilled : []);
    await chrome.storage.local.set({ sffConfCache: confCache });
  } catch (e) {
    console.warn("[popup] conf cache save failed:", e);
  }

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
  if(!tab){ setStatus("❌ No active tab."); return; }

  const cls = classifyPageUrl(tab.url||"");
  if(!cls.ok){ setStatus(cls.msg); return; }

  // Try to ensure content script without throwing
  const ensured = await ensureContentSafe(tab.id);
  if(!ensured.ok){
    if (ensured.reason === "injectionDenied") {
      setStatus("❌ Could not inject on this page (blocked origin). Try another tab.");
      return;
    }
    if (ensured.reason === "notReachable") {
      setStatus("❌ Content script not reachable. Refresh the page and try again.");
      return;
    }
    setStatus("❌ Could not reach content script.");
    return;
  }

  // Frame resolution should not crash the UI
  let frameId = 0;
  try {
    frameId = await getBestFrame(tab.id);
  } catch (e) {
    console.warn("[popup] getBestFrame failed:", e);
    frameId = 0;
  }

  const resp = await sendToFrameSafe(tab.id, frameId, { action:"fillFormSmart" });
  if(!resp){ setStatus("❌ No response from content script."); return; }

  // Friendly outcomes
  if (resp.ok === true) {
    if (typeof resp.inputs === "number") {
      if (resp.inputs === 0) setStatus("❌ No form fields detected on this page.");
      else flashStatus("✅ Form filled! You can try again.", 2600);
      return;
    }
    flashStatus("✅ Done.", 2200, " Ready.");
    return;
  }  

  // Known structured error
  if (resp.ok === false && resp.error) {
    // Normalize a couple of common messages
    if (/no\s*fields/i.test(resp.error)) {
      setStatus("❌ No form fields detected on this page.");
      return;
    }
    if (/not\s*supported/i.test(resp.error)) {
      setStatus("❌ This page type can’t be filled.");
      return;
    }
    setStatus("❌ Error: " + resp.error);
    return;
  }

  setStatus("ℹ️ Unexpected response (see console).");
}

/* ===================== INIT (backend-aware) ===================== */
document.addEventListener("DOMContentLoaded", () => {
  const matchCard      = document.getElementById("matchCard");
  const suggestorCard  = document.getElementById("resumeSuggestorCard");
  const statusEl       = document.getElementById("status");
  const retryBtn       = document.getElementById("retryConnectionBtn");

  async function runInitialLoad() {
    // Always start with the full-screen loading overlay
    setLoading(true, "Connecting to API…");

    const ok = await ensureBackendHealthy();

    if (!ok) {
      log("[popup] backend appears offline on open");

      // Keep the overlay visible, but change the copy
      const label = document.getElementById("loadingMsg");
      if (label) {
        label.textContent =
          "❌ Could not reach API." +
          " Start the backend, then click “Retry connection”.";
      }

      // Show the retry button on the overlay
      if (retryBtn) {
        retryBtn.style.display = "";
        retryBtn.disabled = false;
      }

      // Optionally also update the inline status (behind the overlay)
      if (statusEl) {
        statusEl.textContent =
          "❌ Could not reach Smart Form Filler API on " + BACKEND_BASE + ".";
      }

      // Do NOT hide loadingView here and do NOT load resumes or show main UI.
      // The popup stays in "offline" overlay mode until the backend is healthy.
      return;
    }

    // Backend is healthy → hide overlay and show normal UI
    setLoading(false);

    if (retryBtn) {
      retryBtn.style.display = "none";
      retryBtn.disabled = false;
    }
    if (statusEl) {
      statusEl.textContent = "✅ Connected to Smart Form Filler API.";
    }
    if (matchCard)     matchCard.style.display = "";
    if (suggestorCard) suggestorCard.style.display = "";
    hideNoResumesCard();

    try {
      await preloadAndRestore();
      await autoMatch();
    } catch (e) {
      err("[popup] error on preload/autoMatch:", e);
      if (statusEl) {
        statusEl.textContent =
          "❌ Error while loading resumes or matching. See console for details.";
      }
    }
  }

  // Optional: “Retry connection” button
  if (retryBtn) {
    retryBtn.addEventListener("click", async () => {
      if (retryBtn.disabled) return;
  
      retryBtn.disabled = true;
  
      const label = document.getElementById("loadingMsg");
  
      // Show "re-connecting..." in both the overlay and status line
      if (label) {
        label.textContent = "Re-connecting to Smart Form Filler API…";
      }
      if (statusEl) {
        statusEl.textContent = "Re-connecting to Smart Form Filler API…";
      }
  
      // Make sure the loading overlay is visible during the check
      setLoading(true, "Re-connecting to API…");
  
      const ok = await ensureBackendHealthy(true); // force background to re-probe
  
      if (!ok) {
        // Still offline — keep overlay visible, just change the message
        retryBtn.disabled = false;
  
        if (label) {
          label.textContent =
            "❌ Still cannot reach Smart Form Filler API on " +
            BACKEND_BASE +
            ". Make sure it’s running, then click Retry connection again.";
        }
        if (statusEl) {
          statusEl.textContent =
            "❌ Still cannot reach Smart Form Filler API on " +
            BACKEND_BASE +
            ". Make sure it’s running, then try again.";
        }
  
        // IMPORTANT: do NOT call setLoading(false) here → overlay stays
        return;
      }
  
      // Now online — hide overlay and restore the normal UI
      setLoading(false);
  
      if (statusEl) {
        statusEl.textContent = "✅ Connected to Smart Form Filler API.";
      }
      if (matchCard)     matchCard.style.display = "";
      if (suggestorCard) suggestorCard.style.display = "";
      hideNoResumesCard();
  
      retryBtn.style.display = "none";
      retryBtn.disabled = false;
  
      try {
        await preloadAndRestore();
        await autoMatch();
      } catch (e) {
        err("[popup] error after reconnect:", e);
        if (statusEl) {
          statusEl.textContent =
            "❌ Error while loading resumes or matching after reconnect. See console for details.";
        }
      }
    });
  }
  // Kick things off once DOM is ready
  runInitialLoad();
});

// Buttons
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

// disable Debug tab UI (non-destructive)
(function hideDebugTabNow(){
  try {
    const btn  = document.querySelector('[data-tab="debug"], #tab-debug, .tab-debug');
    const pane = document.querySelector('#panel-debug, [data-panel="debug"], .panel-debug');
    if (btn)  btn.remove();
    if (pane) pane.remove();

    // If the now-removed tab was active, switch to the first available tab
    const activeGone = !document.querySelector('.tab-button.active');
    if (activeGone) {
      const first = document.querySelector('[data-tab]:not([data-tab="debug"]), .tab-button:not(#tab-debug)');
      first?.click?.();
    }
  } catch(_) {}
})();


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

async function withActiveTab(fn) {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs && tabs[0];
      resolve(fn(tab));
    });
  });
}

async function refreshDetectUI(tabId) {
  try {
    if (!tabId) return;

    const filledFieldsEl    = document.getElementById("filledFields");
    const notFilledFieldsEl = document.getElementById("notFilledFields");
    const detectedListEl    = document.getElementById("detectedList");
    if (!detectedListEl || !filledFieldsEl || !notFilledFieldsEl) return;

    // Small delay if the page just changed (keeps it stable)
    await new Promise(r => setTimeout(r, 120));

    // --- Reachability guard: if no content script, show friendly UI and bail ---
    const reachable = await chrome.tabs.sendMessage(tabId, { action: "ping" }).catch(() => null);
    if (!reachable || !reachable.ok) {
      const det = document.getElementById("detectedDetails");
      if (det) det.textContent = "Couldn’t reach the page. Try again on a form.";
      renderDetectedDebug([], false);
      renderFieldList(filledFieldsEl, [],    { title: "Filled",     mode: "filled" });
      renderFieldList(notFilledFieldsEl, [], { title: "Non-Filled", mode: "nonfilled" });
      forceNonFilledBadges(notFilledFieldsEl);
      return; // stop: do not attempt any other messages
    }

    // 1) Ask for a fresh snapshot (guard against failures too)
    const snap = await chrome.tabs.sendMessage(tabId, { action: "EXT_PAGE_SNAPSHOT" }).catch(() => null);
    if (!snap) {
      const det = document.getElementById("detectedDetails");
      if (det) det.textContent = "Couldn’t reach the page. Try again on a form.";
      renderDetectedDebug([], false);
      renderFieldList(filledFieldsEl, [],    { title: "Filled",     mode: "filled" });
      renderFieldList(notFilledFieldsEl, [], { title: "Non-Filled", mode: "nonfilled" });
      forceNonFilledBadges(notFilledFieldsEl);
      return;
    }

    // 2) Render in the debug-style “Detected” box only
    renderDetectedDebug(snap?.items || [], false);

    // 3) Paint Filled/Non-Filled strictly from the current page snapshot (labels from detector)
    const snapBuckets = await sendToTab(tabId, { action: "EXT_SNAPSHOT_BUCKETS" }).catch(() => null);
    const filledRaw    = Array.isArray(snapBuckets?.filled)    ? snapBuckets.filled    : [];
    const notFilledRaw = Array.isArray(snapBuckets?.notFilled) ? snapBuckets.notFilled : [];

    // Build label maps from the detector snapshot
    const rows = Array.isArray(snap?.items) ? snap.items : [];
    const labelBySelector = new Map(
      rows.map(r => [ r.selector, (r.labelText || r.groupLabel || r.label || "").trim() ])
    );
    const labelByName = new Map(
      rows
        .filter(r => /^(radio|checkbox)$/i.test(r.inputType || r.type || ""))
        .map(r => [ r.name, (r.labelText || r.groupLabel || r.label || "").trim() ])
    );

    // Prefer detector's label; for radios/checkboxes, fall back to group name
    const pickLabel = (rec) =>
    (rec && labelBySelector.get(rec.selector)) ||
    rec.label || "(Unknown)";  

    // Normalize Filled (show value; confidence N/A for now)
    const filled = filledRaw.map(f => ({
      key: f.key || null,
      label: pickLabel(f),
      confidence: "N/A",
      value: f.value
    }));

    // Normalize Non-Filled (label from detector; N/A confidence)
    const nonFilled = notFilledRaw.map(nf => ({
      key: nf.key || null,
      label: pickLabel(nf),
      confidence: "N/A"
    }));

    renderFieldList(filledFieldsEl,    filled,    { title: "Filled",     mode: "filled" });
    renderFieldList(notFilledFieldsEl, nonFilled, { title: "Non-Filled", mode: "nonfilled" });
    forceNonFilledBadges(notFilledFieldsEl);

  } catch (e) {
    console.error("[popup][detect] refreshDetectUI failed:", e);
  }
}

renderDetectedDebug(window.SFF_DETECTED, false);

// --- tiny helpers to persist per-page prediction map (label -> {key, confidence}) ---
function pageKeyFromUrl(u){ try{ const x=new URL(u); return `${x.origin}${x.pathname}`; } catch{ return u||"unknown"; } }
function _predKeyFor(url){ return `sff:${pageKeyFromUrl(url)}:predMap`; }
async function _savePredMap(url, mapObj){
  try{ await chrome.storage.local.set({ [_predKeyFor(url)]: mapObj }); }catch{}
}
async function _loadPredMap(url){
  try{
    const k = _predKeyFor(url);
    const g = await chrome.storage.local.get(k);
    return g[k] || {};
  }catch{ return {}; }
}

// --- Main: snapshot page + get confidences + render buckets ---
async function rescanBuckets(){
  const tab = await (window.getActiveTab ? window.getActiveTab() : getActiveTabSimple());
  if (!tab?.id) return;

  // Ensure content and pick the best frame
  try { if (typeof ensureContent === "function") { const ok = await ensureContent(tab.id); if (!ok) return; } } catch {}
  const frameId = (typeof getBestFrame === "function") ? await getBestFrame(tab.id) : 0;

  // 1) Detect with predictions for current labels (confidence source)
  const predResp = await new Promise(res =>
    chrome.tabs.sendMessage(tab.id, { action: "EXT_DETECT_FIELDS_WITH_PREDICTIONS" }, r => res(r))
  );
  const predItems = Array.isArray(predResp?.items) ? predResp.items : [];

  // Build { label -> { key, confidence } } for quick joins later
  const predMap = {};
  for (const it of predItems) {
    const label = String(it.labelText || it.label || it.placeholder || it.name || it.id || "").trim();
    if (!label) continue;
    predMap[label] = {
      key: it.prediction ?? null,
      confidence: (typeof it.confidence === "number" ? it.confidence : null)
    };
  }
  await _savePredMap(tab.url || "", predMap);

  // 2) DOM snapshot: which fields are actually filled right now?
  const snap = await new Promise(res =>
    chrome.tabs.sendMessage(tab.id, { action: "EXT_SNAPSHOT_BUCKETS" }, r => res(r))
  );
  const filledSnap    = Array.isArray(snap?.filled) ? snap.filled : [];
  const notFilledSnap = Array.isArray(snap?.notFilled) ? snap.notFilled : [];

  // 3) Build the Detected list from the prediction pass (label-only for that panel)
  const detected = predItems
    .map(d => ({ key: d.prediction || d.name || d.id || null, label: String(d.labelText || d.label || d.name || d.id || "").trim() }))
    .filter(x => x.label);

  window.SFF_DETECTED = detected.slice(); // single source of truth for Detected panel

  // 4) Assemble a "report-like" object so we can reuse your existing renderers
  //    Attach confidences from predMap by label; missing → "N/A"
  const pickConf = (label) => {
    const m = predMap[label];
    if (!m || m.confidence == null) return "N/A";
    return m.confidence; // keep numeric 0..1 — your parseConfidence handles it
  };
  const pickKey = (label) => (predMap[label]?.key ?? null);

  const report = {
    filled: filledSnap.map(f => ({
      key:       pickKey(f.label),
      label:     f.label,
      confidence: pickConf(f.label),
      value:     f.value,
      inputType: f.inputType,
      status:    f.status || "filled",
      didSet:    !!f.didSet
    })),
    notFilled: notFilledSnap.map(nf => ({
      key:       pickKey(nf.label),
      label:     nf.label,
      confidence: pickConf(nf.label)
    }))
  };

  // 5) Render into the three buckets using your normal path
  if (typeof renderBuckets === "function") {
    renderBuckets(detected, report);
  } else {
    const filledFieldsEl    = document.getElementById("filledFields");
    const notFilledFieldsEl = document.getElementById("notFilledFields");
    if (!filledFieldsEl || !notFilledFieldsEl) return;

    // minimal fallback: seed non-filled and fill-filled lists (uses your card renderer)
    renderFieldList(filledFieldsEl, report.filled, { title: "Filled", mode: "filled" });
    renderFieldList(notFilledFieldsEl, report.notFilled, { title: "Non-Filled", mode: "nonfilled" });
    forceNonFilledBadges(notFilledFieldsEl);
  }
}

// --- Replace the internals of rescanNow to call our new pipeline ---
async function rescanNow() {
  const tab = await (window.getActiveTab ? window.getActiveTab() : getActiveTabSimple());
  if (tab?.id) await rescanBuckets();
}
window.rescanNow = rescanNow;

// === Fill form button (no extra experience clicks) ===
document.getElementById("fillForm")?.addEventListener("click", async () => {
  await withActiveTab(async (tab) => {
    if (!tab?.id) return;
    // 1) Smart fill (adds what’s needed & fills it)
    await sendToTab(tab.id, { action: "fillFormSmart" });

    // 2) Small settle, then refresh popup counts
    await new Promise(r => setTimeout(r, 350));
    await rescanNow();    

    // 3) (optional) recheck key skills
    await sendToTab(tab.id, { action: "EXT_CHECK_KEY_SKILLS" });
  });
});

// Also refresh once when popup opens so the initial numbers are right
document.addEventListener('DOMContentLoaded', async () => {
  const t = await getActiveTabSimple();
  if (t?.id) refreshDetectUI(t.id);

  document.getElementById('rescanBtn')?.addEventListener('click', async () => {
    const t2 = await getActiveTabSimple();
    if (t2?.id) refreshDetectUI(t2.id);
  });
});



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

  // === After a successful fill, flip on the Key Skills ===
  try {
    const tab = await getActiveTab();
    if (tab?.id) {
      // Collect labels predicted as key_skill from SFF_DETECTED
      const predictedKeySkills = (Array.isArray(SFF_DETECTED) ? SFF_DETECTED : [])
        .filter(d => String(d?.prediction || "").toLowerCase() === "key_skill")
        .map(d => (d.labelText || d.label || "").toString().trim())
        .filter(Boolean);

      if (predictedKeySkills.length) {
        await runPredictedKeySkillsPass(tab.id, predictedKeySkills);
      } else {
        // Fallback: generic "use matchedSkills only" pass
        await runKeySkillsPass(tab.id);
      }
    }
  } catch (e) {
    err("[popup] key-skills pass failed:", e);
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

// Wire the new button
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnPredict");
  if (btn) {
    btn.addEventListener("click", async () => {
      try {
        if (!SFF_DETECTED.length) await runDetectorDebug();
        await predictForDetected();
        await new Promise(r => setTimeout(r, 120));
        await rescanNow();
      } catch (e) {
        console.error("[popup][predict] error:", e);
        const det = document.getElementById("detectedDetails");
        if (det) det.textContent = `Prediction Error: ${e.message || e}`;
      }
    });
  }
});

// Bind the Fill button after DOM is ready (supports new or old id)
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("fillForm")
  if (!btn) return;
  btn.addEventListener("click", runFill); // use the unified handler you already have
});


document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnFill");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      const resp = await fillUsingPredictPipeline({ silent: false }); // also renders the debug report
      if (!resp?.success) throw new Error(resp?.error || "Fill failed");
      
      const tab2 = await getActiveTab();
      if (tab2?.id) {
        // wait a tick so newly inserted rows are in the DOM
        await new Promise(r => setTimeout(r, 120));
        await rescanNow();
      
        // (optional) re-check skills if you show that panel
        await sendToTab(tab2.id, { action: "EXT_CHECK_KEY_SKILLS" });
      }      
    } catch (e) {
      const pre = document.getElementById("fillReport");
      const sum = document.getElementById("fillSummary");
      if (sum) sum.textContent = "fill failed";
      if (pre) pre.textContent = String(e);
      console.error("[popup][fill] error:", e);
    }
  });
});
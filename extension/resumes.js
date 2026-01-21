// ===============================
// Option A: Background is resolver
// resumes.js must NOT probe ports.
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

  if (BACKEND_BASE) {
    try { localStorage.setItem("backend_base", BACKEND_BASE); } catch {}
  }

  return { ok: !!res.ok, base: BACKEND_BASE, pref: CURRENT_PREF };
}

async function getAccessTokenR() {
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

async function getTokenIfV2R() {
  if (CURRENT_PREF !== "v2") return null;
  return await getAccessTokenR();
}

async function fetchWithFailoverR(path, opts) {
  const sel = await ensureBackendResolved(false);
  if (!sel.base) throw new Error(`No backend base available (pref=${sel.pref}). Start the backend.`);

  const token = sel.pref === "v2" ? await getTokenIfV2R() : null;

  const mergedHeaders = Object.assign({ "Accept": "application/json" }, (opts && opts.headers) || {});
  if (token && !mergedHeaders["Authorization"]) mergedHeaders["Authorization"] = `Bearer ${token}`;

  // IMPORTANT: don't force Content-Type for FormData
  const finalOpts = Object.assign({ credentials: "omit", cache: "no-store" }, opts || {});
  finalOpts.headers = mergedHeaders;

  try {
    const r = await fetch(`${sel.base}${path}`, finalOpts);
    if (r.ok) return r;
    throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    const sel2 = await ensureBackendResolved(true);
    if (!sel2.base) throw e;

    const token2 = sel2.pref === "v2" ? await getTokenIfV2R() : null;
    const mergedHeaders2 = Object.assign({ "Accept": "application/json" }, (opts && opts.headers) || {});
    if (token2 && !mergedHeaders2["Authorization"]) mergedHeaders2["Authorization"] = `Bearer ${token2}`;

    const finalOpts2 = Object.assign({ credentials: "omit", cache: "no-store" }, opts || {});
    finalOpts2.headers = mergedHeaders2;

    const r2 = await fetch(`${sel2.base}${path}`, finalOpts2);
    if (r2.ok) return r2;
    throw new Error(`HTTP ${r2.status} (after reprobe)`);
  }
}

const els = {
  tbody: document.getElementById("resumeTbody"),
  maxCount: document.getElementById("maxCount"),
  fileInput: document.getElementById("fileInput"),
  uploadBtn: document.getElementById("uploadBtn"),
  uploadHint: document.getElementById("uploadHint"),
};

let LIMIT = 5;
let current = [];

function fmtSize(bytes) {
  if (bytes == null) return "";
  const units = ["B","KB","MB","GB"];
  let i=0, n=bytes;
  while (n >= 1024 && i < units.length-1) { n/=1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

function extractFileNameR(v) {
  if (!v) return "";
  const s = String(v);
  const noQuery = s.split("?")[0];
  return noQuery.split("/").pop().split("\\").pop() || s;
}

function normalizeResumesPayloadR(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.resumes)) return payload.resumes;
  if (Array.isArray(payload.files)) return payload.files;
  if (Array.isArray(payload.results)) return payload.results;

  // Common wrappers
  if (payload.data && Array.isArray(payload.data)) return payload.data;
  if (payload.data && Array.isArray(payload.data.files)) return payload.data.files;
  if (payload.data && Array.isArray(payload.data.items)) return payload.data.items;
  if (payload.data && Array.isArray(payload.data.resumes)) return payload.data.resumes;

  return [];
}

function resumeIdR(r) {
  if (typeof r === "string") return r;
  return String(r?.id || r?.resume_id || r?.resumeId || r?.uuid || r?.path || r?.file_path || "").trim();
}

function resumeNameR(r) {
  if (typeof r === "string") return extractFileNameR(r);
  const raw = r?.original_name || r?.originalName || r?.name || r?.filename || r?.path || r?.file_path || "";
  return extractFileNameR(raw) || resumeIdR(r) || "Resume";
}

function resumeCreatedTextR(r) {
  if (!r || typeof r === "string") return "";
  const v = r?.created_at || r?.createdAt || r?.uploaded_at || r?.updated_at || "";
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().replace("T"," ").replace("Z","");
}

function resumeSizeBytesR(r) {
  if (!r || typeof r === "string") return null;
  return r?.size_bytes ?? r?.sizeBytes ?? r?.bytes ?? r?.size ?? null;
}

function row(resume) {
  const id = resumeIdR(resume);
  const name = resumeNameR(resume);
  const created = resumeCreatedTextR(resume);
  const size = resumeSizeBytesR(resume);

  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${name}</td>
    <td><span class="muted">${created || ""}</span></td>
    <td>${size == null ? "" : fmtSize(size)}</td>
    <td style="white-space:nowrap">
      <button class="btn btn-ghost" data-view="${id}">View PDF</button>
      <button class="btn btn-danger" data-del="${id}">Delete</button>
    </td>
  `;
  return tr;
}

async function refresh() {
  els.tbody.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;

  let sel = null;
  try {
    sel = await ensureBackendResolved(false);
    if (!sel.base) throw new Error("No backend base resolved.");

    const r = await fetchWithFailoverR(`/resumes`);
    const data = await r.json().catch(() => ({}));

    LIMIT = Number(data?.max || data?.limit || 5);
    els.maxCount.textContent = LIMIT;

    current = normalizeResumesPayloadR(data);

    if (!current.length) {
      els.tbody.innerHTML = `<tr><td colspan="4" class="muted">No resumes yet.</td></tr>`;
    } else {
      els.tbody.innerHTML = "";
      current.forEach(item => els.tbody.appendChild(row(item)));
    }

    // disable upload if at limit
    const atLimit = current.length >= LIMIT;
    els.uploadBtn.disabled = atLimit;
    els.fileInput.disabled = atLimit;
    els.uploadHint.textContent = atLimit ? "Limit reached — delete one to upload another." : "";
  } catch (e) {
    const baseTxt = (sel && sel.base) ? sel.base : (BACKEND_BASE || "(unknown)");
    els.tbody.innerHTML = `<tr><td colspan="4" class="muted">Error loading resumes. Backend: ${baseTxt}</td></tr>`;
    console.warn("[resumes] refresh failed:", e);
  }
}

els.tbody.addEventListener("click", async (ev) => {
  const viewId = ev.target?.dataset?.view;
  const delId = ev.target?.dataset?.del;
  if (viewId) {
    try {
      const r = await fetchWithFailoverR(`/resumes/${encodeURIComponent(viewId)}/file`, { method: "GET" });
      const blob = await r.blob();
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, "_blank");
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (e) {
      const sel = await ensureBackendResolved(false);
      if (sel.pref === "v2") {
        alert("Could not open resume file. Make sure you are signed in and v2 is running.");
      } else {
        alert("Could not open resume file. Make sure the v1 backend is running and the file exists in backend/data.");
      }
    }
  }  
  if (delId) {
    if (!confirm("Delete this resume? This cannot be undone.")) return;
  
    const r = await fetchWithFailoverR(`/resumes/${encodeURIComponent(delId)}`, { method: "DELETE" });
    if (!r.ok) { alert("Delete failed."); return; }
  
    // Refresh the table + internal `current` list first
    await refresh();
  
    // If the deleted one was selected, pick a fallback and mirror the popup's behavior
    try {
      // Read current profile to see what's selected
      const pr = await fetchWithFailoverR(`/profile`);
        if (pr.ok) {
          const profRaw = await pr.json();
          const prof = (profRaw && profRaw.profile) ? profRaw.profile : profRaw;
          const wasSelected = String(prof?.selectedResumeId || "") === String(delId);          
  
        if (wasSelected) {
          // pick first remaining resume as fallback (if any)
          const fallback = (current || []).find(r => String(resumeIdR(r)) !== String(delId));
  
          if (!fallback) {
            // no resumes left → clear selection in backend + local cache
            await fetchWithFailoverR(`/profile`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                selectedResumeId: "",
                selectedResumeName: "",
                selectedResumeSkills: []
              })
            });            
            try {
              await chrome.storage.local.set({
                lastResumeId: "",
                selectedResume: { id: "", name: "", skills: [] }
              });
            } catch (_) {}
          } else {
            // compute fallback id/name FIRST (works for object OR string)
            const fallbackId = resumeIdR(fallback);
            const fallbackName = resumeNameR(fallback);

            // fetch skills for the fallback (same approach popup.js uses)
            let skills = [];
            if (fallbackId) {
              try {
                const sr = await fetchWithFailoverR(`/skills/by_resume`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ resumeId: fallbackId })
                });
                const sj = await sr.json().catch(() => ({}));
                skills = Array.isArray(sj.skills) ? sj.skills : [];
              } catch (_) {}
            }

            const dedupSkills = Array.from(new Set(skills)).sort();
  
            // patch backend profile
            await fetchWithFailoverR(`/profile`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                selectedResumeId: String(fallbackId),
                selectedResumeName: fallbackName,
                selectedResumeSkills: dedupSkills
              })
            });
  
            // mirror to local cache so popup/content can use immediately
            try {
              await chrome.storage.local.set({
                lastResumeId: String(fallbackId),
                selectedResume: { id: String(fallbackId), name: fallbackName, skills: dedupSkills }
              });
            } catch (_) {}
          }
        }
      }
    } catch (e) {
      console.warn("[resumes] post-delete selection repair failed:", e);
    }
  }  
});

els.uploadBtn.addEventListener("click", async () => {
  const f = els.fileInput.files?.[0];
  if (!f) return alert("Choose a .pdf or .docx file.");

  const wasFirstResume = (current?.length || 0) === 0;

  const fd = new FormData();
  fd.append("file", f);

  els.uploadBtn.disabled = true;
  els.uploadBtn.textContent = "Uploading…";

  try {
    const r = await fetchWithFailoverR(`/resumes`, { method: "POST", body: fd });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      alert(data.error || "Upload failed.");
      return;
    }

    // ✅ Auto-select ONLY if this was the first resume in the account
    if (wasFirstResume) {
      try {
        const uploaded = data?.resume || data?.item || data || {};
        const newId = String(uploaded.id || uploaded.resumeId || "").trim();
        const newName =
          uploaded.original_name ||
          uploaded.name ||
          uploaded.filename ||
          f.name ||
          newId;

        if (newId) {
          // skills via backend (same pattern you already use elsewhere in this file)
          let skills = [];
          try {
            const sr = await fetchWithFailoverR(`/skills/by_resume`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ resumeId: newId })
            });
            const sj = await sr.json().catch(() => ({}));
            skills = Array.isArray(sj.skills) ? sj.skills : [];
          } catch (_) {}

          const dedupSkills = Array.from(new Set(skills || [])).sort();

          // Patch backend profile selection
          await fetchWithFailoverR(`/profile`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              selectedResumeId: newId,
              selectedResumeName: newName,
              selectedResumeSkills: dedupSkills
            })
          });

          // Mirror to storage so popup/dashboard update instantly
          try {
            await chrome.storage.local.set({
              lastResumeId: newId,
              selectedResume: { id: newId, name: newName, skills: dedupSkills }
            });
            try { chrome.runtime.sendMessage({ action: "profile.updated" }); } catch (_) {}
          } catch (_) {}
        }
      } catch (e) {
        console.warn("[resumes] auto-select first upload failed:", e);
      }
    }

    await refresh();
  } catch (e) {
    alert("Network error.");
  } finally {
    els.uploadBtn.disabled = false;
    els.uploadBtn.textContent = "Upload";
    els.fileInput.value = "";
  }
});

// Init: ask background for the selected base, then refresh.
(async function initResumesPage() {
  try {
    await ensureBackendResolved(true); // force a fresh resolve on page load
  } catch (_) {}
  await refresh();
})();

// ---- Configure your backend here (use env swap for prod) ----
const BACKEND_BASE = localStorage.getItem("backend_base") || "http://127.0.0.1:5000";

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

function row(resume) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${resume.original_name}</td>
    <td><span class="muted">${new Date(resume.created_at).toISOString().replace('T',' ').replace('Z','')}</span></td>
    <td>${fmtSize(resume.size_bytes)}</td>
    <td style="white-space:nowrap">
      <button class="btn btn-ghost" data-view="${resume.id}">View PDF</button>
      <button class="btn btn-danger" data-del="${resume.id}">Delete</button>
    </td>
  `;
  return tr;
}

async function refresh() {
  els.tbody.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;
  try {
    const r = await fetch(`${BACKEND_BASE}/resumes`);
    const data = await r.json();
    LIMIT = data.max || 5;
    els.maxCount.textContent = LIMIT;

    current = data.items || [];
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
    els.tbody.innerHTML = `<tr><td colspan="4" class="muted">Error loading. Check backend at ${BACKEND_BASE}.</td></tr>`;
  }
}

els.tbody.addEventListener("click", async (ev) => {
  const viewId = ev.target?.dataset?.view;
  const delId = ev.target?.dataset?.del;
  if (viewId) {
    // Open the original file (PDF/DOCX) in a new tab
    const url = `${BACKEND_BASE}/resumes/${viewId}/file`;
    window.open(url, "_blank");
  }
  if (delId) {
    if (!confirm("Delete this resume? This cannot be undone.")) return;
  
    const r = await fetch(`${BACKEND_BASE}/resumes/${delId}`, { method: "DELETE" });
    if (!r.ok) { alert("Delete failed."); return; }
  
    // Refresh the table + internal `current` list first
    await refresh();
  
    // If the deleted one was selected, pick a fallback and mirror the popup's behavior
    try {
      // Read current profile to see what's selected
      const pr = await fetch(`${BACKEND_BASE}/profile`);
      if (pr.ok) {
        const prof = await pr.json();
        const wasSelected = String(prof.selectedResumeId || "") === String(delId);
  
        if (wasSelected) {
          // pick first remaining resume as fallback (if any)
          const fallback = (current || []).find(r => String(r.id) !== String(delId));
  
          if (!fallback) {
            // no resumes left → clear selection in backend + local cache
            await fetch(`${BACKEND_BASE}/profile`, {
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
            // fetch skills for the fallback (same approach popup.js uses)
            let skills = [];
            try {
              const sr = await fetch(`${BACKEND_BASE}/skills/by_resume`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ resumeId: fallback.id })
              });
              const sj = await sr.json();
              skills = Array.isArray(sj.skills) ? sj.skills : [];
            } catch (_) {}
  
            const fallbackName = fallback.original_name || fallback.name || String(fallback.id);
            const dedupSkills  = Array.from(new Set(skills)).sort();
  
            // patch backend profile
            await fetch(`${BACKEND_BASE}/profile`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                selectedResumeId: String(fallback.id),
                selectedResumeName: fallbackName,
                selectedResumeSkills: dedupSkills
              })
            });
  
            // mirror to local cache so popup/content can use immediately
            try {
              await chrome.storage.local.set({
                lastResumeId: String(fallback.id),
                selectedResume: { id: String(fallback.id), name: fallbackName, skills: dedupSkills }
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
  const fd = new FormData();
  fd.append("file", f);
  els.uploadBtn.disabled = true;
  els.uploadBtn.textContent = "Uploading…";
  try {
    const r = await fetch(`${BACKEND_BASE}/resumes`, { method: "POST", body: fd });
    const data = await r.json();
    if (!r.ok) {
      alert(data.error || "Upload failed.");
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

// Init
refresh();

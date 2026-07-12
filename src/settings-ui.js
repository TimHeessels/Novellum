"use strict";

import { escapeHtml, formatRelativeTime } from "./model.js";
import {
  getGithubSettings, saveGithubSettings, testConnection, createRepoForVault,
  listOutbox, listConflicts, syncNow, resolveConflictKeepMine, resolveConflictUseTheirs,
  getLocalContentForConflict,
} from "./sync-engine.js";
import { getActiveBookId, exportDataAsJson, importDataFromJson } from "./persistence.js";
import { diffLines } from "./diff.js";
import { state } from "./state.js";

// Whether the setup guide is expanded — persists across re-renders within the session (but not
// across page loads) so a re-render triggered by e.g. "Create Repo" doesn't undo the user's toggle.
let guideOpenOverride = null;

export async function renderSettingsView(container, { onBack, notifyBookDataChanged }) {
  const [settings, outbox, conflicts] = await Promise.all([getGithubSettings(), listOutbox(), listConflicts()]);
  const isConfigured = !!(settings.token && settings.owner && settings.repo);
  const guideOpen = guideOpenOverride === null ? !isConfigured : guideOpenOverride;

  container.innerHTML = `
    <div class="settings-view">
      <div class="settings-header">
        <button class="tbtn" id="settingsBack">&lsaquo; Back to Manuscript</button>
        <h2>GitHub Sync Settings</h2>
      </div>

      <details class="settings-guide" id="settingsGuide" ${guideOpen ? "open" : ""}>
        <summary>How to connect GitHub (first-time setup)</summary>
        <ol>
          <li>Click <strong>Create a token on GitHub</strong> below. It opens GitHub with the right permissions pre-filled — sign in if asked, pick an expiration, then click <strong>Generate token</strong> at the bottom of that page.</li>
          <li>GitHub shows the new token once. Copy it there.</li>
          <li>Come back here, click <strong>Paste</strong> next to the token field, then <strong>Save</strong>.</li>
          <li>Fill in <strong>Owner</strong> (your GitHub username) and <strong>Repo</strong>. Click <strong>Create Repo</strong> if you don't have one yet, or <strong>Test Connection</strong> to check access to an existing one.</li>
          <li>Click <strong>Sync Now</strong>. The token stays saved on this device, so this is a one-time setup.</li>
        </ol>
      </details>

      <div class="settings-section">
        <div class="section-label">Personal Access Token</div>
        <a class="settings-link" target="_blank" rel="noopener"
           href="https://github.com/settings/tokens/new?scopes=repo&description=WriterTool">Create a token on GitHub &rarr;</a>
        <div class="token-row">
          <input type="password" id="settingsToken" placeholder="ghp_..." value="${escapeHtml(settings.token || "")}">
          <button class="tbtn" id="settingsTokenPaste" type="button">Paste</button>
          <button class="tbtn" id="settingsTokenShow" type="button">Show</button>
        </div>
      </div>

      <div class="settings-section settings-row">
        <div>
          <div class="section-label">Owner</div>
          <input type="text" id="settingsOwner" placeholder="your-github-username" value="${escapeHtml(settings.owner || "")}">
        </div>
        <div>
          <div class="section-label">Repo</div>
          <input type="text" id="settingsRepo" placeholder="writertool-vault" value="${escapeHtml(settings.repo || "")}">
        </div>
      </div>

      <div class="settings-actions-row">
        <button class="modal-btn done" id="settingsSave">Save</button>
        <button class="tbtn" id="settingsTest">Test Connection</button>
        <button class="tbtn" id="settingsCreateRepo">Create Repo</button>
      </div>
      <div id="settingsStatus" class="settings-status"></div>

      <div class="settings-section">
        <div class="section-label">Sync</div>
        <div>Last synced: ${settings.lastSyncedAt ? formatRelativeTime(settings.lastSyncedAt) : "Never"}</div>
        <div>Pending changes: ${outbox.length}</div>
        <button class="modal-btn done" id="settingsSyncNow" style="margin-top:8px">Sync Now</button>
        <div id="syncStatus" class="settings-status"></div>
      </div>

      ${conflicts.length > 0 ? renderConflictsSection(conflicts) : ""}

      <div class="settings-section">
        <div class="section-label">Manual Backup</div>
        <div class="settings-status" style="margin:0 0 8px">
          A local JSON snapshot of the current book — separate from GitHub sync, useful as a one-off backup.
        </div>
        <div class="settings-actions-row">
          <button class="tbtn" id="settingsExportJson">Export JSON</button>
          <button class="tbtn" id="settingsImportJson">Import JSON</button>
          <input type="file" id="settingsImportJsonFile" accept="application/json" style="display:none">
        </div>
      </div>
    </div>
  `;

  const readFields = () => ({
    token: document.getElementById("settingsToken").value.trim(),
    owner: document.getElementById("settingsOwner").value.trim(),
    repo: document.getElementById("settingsRepo").value.trim(),
  });

  function setStatus(id, msg, isError) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = msg;
      el.classList.toggle("error", !!isError);
    }
  }

  document.getElementById("settingsBack").onclick = onBack;

  document.getElementById("settingsGuide").addEventListener("toggle", (e) => {
    guideOpenOverride = e.target.open;
  });

  document.getElementById("settingsTokenPaste").onclick = async () => {
    const input = document.getElementById("settingsToken");
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) input.value = text;
      input.focus();
    } catch {
      // Clipboard read can be blocked (permissions, insecure context, etc.) — fall back to
      // letting the user paste manually rather than failing silently.
      input.focus();
      setStatus("settingsStatus", "Couldn't read the clipboard automatically — paste into the field with Ctrl+V instead.", true);
    }
  };

  document.getElementById("settingsTokenShow").onclick = (e) => {
    const input = document.getElementById("settingsToken");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    e.target.textContent = showing ? "Show" : "Hide";
  };

  document.getElementById("settingsSave").onclick = async () => {
    await saveGithubSettings(readFields());
    setStatus("settingsStatus", "Saved.", false);
  };

  document.getElementById("settingsTest").onclick = async () => {
    setStatus("settingsStatus", "Testing…", false);
    try {
      await saveGithubSettings(readFields());
      const result = await testConnection();
      if (!result.repoOk) {
        setStatus("settingsStatus", `Token OK (signed in as ${result.login}). Set an owner/repo and test again, or create a repo below.`, false);
      } else {
        setStatus("settingsStatus", `Connected as ${result.login}. Repo access OK (default branch: ${result.defaultBranch}).`, false);
      }
    } catch (err) {
      setStatus("settingsStatus", `Failed: ${err.message}`, true);
    }
  };

  document.getElementById("settingsCreateRepo").onclick = async () => {
    setStatus("settingsStatus", "Creating repo…", false);
    try {
      await saveGithubSettings(readFields());
      const desiredName = document.getElementById("settingsRepo").value.trim() || "writertool-vault";
      const { owner, repo } = await createRepoForVault(desiredName);
      // Re-render first (it rebuilds the whole view, wiping any message set beforehand),
      // then set the status message on the freshly-created element.
      await renderSettingsView(container, { onBack, notifyBookDataChanged });
      setStatus("settingsStatus", `Created ${owner}/${repo}.`, false);
    } catch (err) {
      setStatus("settingsStatus", `Failed: ${err.message}`, true);
    }
  };

  document.getElementById("settingsSyncNow").onclick = async () => {
    setStatus("syncStatus", "Syncing…", false);
    // Save whatever's currently in the fields first — otherwise a token typed but not yet
    // explicitly saved would be silently ignored in favor of the last-persisted value.
    await saveGithubSettings(readFields());
    const bookId = getActiveBookId();
    const { pushResult, pullResult } = await syncNow(bookId, { force: true });
    state.syncPauseReason = pushResult.paused ? pushResult.pauseReason : null;
    if (pullResult.pulled > 0 && notifyBookDataChanged) await notifyBookDataChanged(bookId);
    // Push and pull can both flag the same target as conflicting in one pass (e.g. a structural
    // push conflict gets rediscovered during reconciliation) — they'd double-count it if summed,
    // so re-read the actual conflict list rather than trusting each pass's own tally.
    const totalConflicts = (await listConflicts()).length;
    await renderSettingsView(container, { onBack, notifyBookDataChanged });
    if (pushResult.paused) {
      setStatus("syncStatus", `Paused: ${pushResult.pauseReason}`, true);
    } else {
      setStatus(
        "syncStatus",
        `Pushed ${pushResult.pushed} file(s), pulled ${pullResult.pulled} file(s), ${totalConflicts} conflict(s).`,
        totalConflicts > 0
      );
    }
  };

  document.getElementById("settingsExportJson").onclick = () => {
    const blob = new Blob([exportDataAsJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `writertool-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById("settingsImportJson").onclick = () => {
    document.getElementById("settingsImportJsonFile").click();
  };

  document.getElementById("settingsImportJsonFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await importDataFromJson(reader.result);
        const bookId = getActiveBookId();
        if (notifyBookDataChanged) await notifyBookDataChanged(bookId);
        setStatus("settingsStatus", "Import complete.", false);
      } catch (err) {
        setStatus("settingsStatus", `Import failed: ${err.message}`, true);
      } finally {
        e.target.value = "";
      }
    };
    reader.readAsText(file);
  };

  conflicts.forEach((c) => {
    const toggleBtn = document.getElementById(`toggleDiff-${c.key}`);
    if (toggleBtn) {
      toggleBtn.onclick = async () => {
        const diffEl = document.getElementById(`diff-${c.key}`);
        const isHidden = diffEl.style.display === "none";
        diffEl.style.display = isHidden ? "block" : "none";
        toggleBtn.textContent = isHidden ? "Hide Diff" : "View Diff";
        if (isHidden && !diffEl.dataset.loaded) {
          diffEl.dataset.loaded = "1";
          await loadDiffInto(diffEl, c);
        }
      };
    }
    const keepBtn = document.getElementById(`keepMine-${c.key}`);
    const theirsBtn = document.getElementById(`useTheirs-${c.key}`);
    if (keepBtn) {
      keepBtn.onclick = async () => {
        // "Keep Mine" only re-queues the push — actually push it now instead of leaving the
        // user to notice nothing happened and hit Sync Now again themselves.
        await resolveConflictKeepMine(c.key);
        const { pushResult } = await syncNow(null, { force: true });
        await renderSettingsView(container, { onBack, notifyBookDataChanged });
        setStatus("syncStatus", `Resolved. Pushed ${pushResult.pushed} file(s), ${pushResult.conflicts} conflict(s).`, pushResult.conflicts > 0);
      };
    }
    if (theirsBtn) {
      theirsBtn.onclick = async () => {
        await resolveConflictUseTheirs(c.key);
        // The accepted GitHub content only landed in IndexedDB — if this book is the one
        // currently open, the in-memory manuscript/UI must be refreshed too, or the next
        // local edit would silently overwrite the version we just accepted.
        if (notifyBookDataChanged) await notifyBookDataChanged(c.bookId);
        await renderSettingsView(container, { onBack, notifyBookDataChanged });
        setStatus("syncStatus", "Took GitHub's version.", false);
      };
    }
  });
}

function renderConflictsSection(conflicts) {
  const rows = conflicts
    .map(
      (c) => `
    <div class="conflict-row">
      <div class="conflict-row-head">
        <div>${escapeHtml(c.kind)} &mdash; ${escapeHtml(c.targetId)}</div>
        <div class="conflict-actions">
          <button class="tbtn" id="toggleDiff-${c.key}">View Diff</button>
          <button class="tbtn" id="keepMine-${c.key}">Keep Mine</button>
          <button class="tbtn" id="useTheirs-${c.key}">Use GitHub's</button>
        </div>
      </div>
      <div class="conflict-diff" id="diff-${c.key}" style="display:none"></div>
    </div>`
    )
    .join("");
  return `
    <div class="settings-section">
      <div class="section-label">Conflicts (${conflicts.length})</div>
      ${rows}
    </div>
  `;
}

/** Fetches the local version of a conflicting file and renders a line-by-line diff against
 *  the remote copy already captured on the conflict record, so "Keep Mine" / "Use GitHub's"
 *  isn't a blind guess. */
async function loadDiffInto(container, conflict) {
  container.innerHTML = `<div class="diff-loading">Loading diff&hellip;</div>`;
  const localContent = await getLocalContentForConflict(conflict);
  if (localContent === null) {
    container.innerHTML = `<div class="diff-empty">No local copy exists anymore — it may have been deleted since this conflict was detected.</div>`;
    return;
  }
  const rows = diffLines(conflict.remoteContent || "", localContent);
  const linesHtml = rows
    .map(({ type, text }) => {
      const marker = type === "add" ? "+" : type === "remove" ? "−" : " ";
      const safeText = escapeHtml(text);
      return `<div class="diff-line diff-${type}"><span class="diff-marker">${marker}</span><span class="diff-text">${safeText === "" ? "&nbsp;" : safeText}</span></div>`;
    })
    .join("");
  container.innerHTML = `
    <div class="diff-legend">
      <span class="diff-legend-item diff-legend-remove">&minus; GitHub's version</span>
      <span class="diff-legend-item diff-legend-add">+ Your local version (Keep Mine)</span>
    </div>
    <div class="diff-body">${linesHtml}</div>
  `;
}

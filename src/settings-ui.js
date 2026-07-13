"use strict";

import { escapeHtml, formatRelativeTime, markdownToScene } from "./model.js";
import {
  getGithubSettings, createRepoForVault, disconnectGithub,
  listOutbox, listConflicts, syncNow, resolveConflictKeepMine, resolveConflictUseTheirs,
  getLocalContentForConflict, connectExistingVaultRepo, listMyRepos, DEFAULT_VAULT_REPO_NAME,
} from "./sync-engine.js";
import { getActiveBookId, exportDataAsJson, importDataFromJson } from "./persistence.js";
import { diffLines, diffWords } from "./diff.js";
import { state } from "./state.js";
import { startGithubLogin } from "./github-oauth.js";

export async function renderSettingsView(container, callbacks) {
  const { onBack, notifyBookDataChanged, onSyncStatusChanged } = callbacks;
  const [settings, outbox, conflicts] = await Promise.all([getGithubSettings(), listOutbox(), listConflicts()]);
  const isConnected = !!(settings.token && settings.owner && settings.repo);

  container.innerHTML = `
    <div class="settings-view">
      <div class="settings-header">
        <button class="tbtn" id="settingsBack">&lsaquo; Back to Manuscript</button>
        <h2>GitHub Sync Settings</h2>
      </div>

      ${isConnected
        ? renderConnectedPhase(settings)
        : state.pendingOAuthVaultPick
          ? renderVaultPickPhase(state.pendingOAuthVaultPick)
          : renderSetupPhase()}

      ${isConnected ? `
        <div class="settings-section">
          <div class="section-label">Sync</div>
          <div>Last synced: ${settings.lastSyncedAt ? formatRelativeTime(settings.lastSyncedAt) : "Never"}</div>
          <div>Pending changes: ${outbox.length}</div>
          <button class="modal-btn done" id="settingsSyncNow" style="margin-top:8px">Sync Now</button>
          <div id="syncStatus" class="settings-status"></div>
        </div>

        ${conflicts.length > 0 ? renderConflictsSection(conflicts) : ""}
      ` : ""}

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

  function setStatus(id, msg, isError) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = msg;
      el.classList.toggle("error", !!isError);
    }
  }

  document.getElementById("settingsBack").onclick = onBack;

  // A "Sign in with GitHub" redirect may have just completed (see main.js) before this view's
  // first render — surface the result once here, then clear it so it doesn't reappear on the
  // next unrelated re-render.
  if (state.oauthLoginError) {
    setStatus("settingsStatus", state.oauthLoginError, true);
    state.oauthLoginError = null;
  }

  const oauthLoginBtn = document.getElementById("settingsOAuthLogin");
  if (oauthLoginBtn) {
    oauthLoginBtn.onclick = () => {
      oauthLoginBtn.disabled = true;
      oauthLoginBtn.textContent = "Redirecting to GitHub…";
      startGithubLogin();
    };
  }

  const createVaultBtn = document.getElementById("settingsCreateVault");
  if (createVaultBtn) {
    createVaultBtn.onclick = async () => {
      createVaultBtn.disabled = true;
      setStatus("settingsStatus", "Creating vault…", false);
      try {
        await createRepoForVault(DEFAULT_VAULT_REPO_NAME);
        state.pendingOAuthVaultPick = null;
        await renderSettingsView(container, callbacks);
      } catch (err) {
        createVaultBtn.disabled = false;
        setStatus("settingsStatus", `Failed: ${err.message}`, true);
      }
    };
  }

  const pickExistingBtn = document.getElementById("settingsPickExistingRepo");
  if (pickExistingBtn) {
    pickExistingBtn.onclick = async () => {
      pickExistingBtn.disabled = true;
      const holder = document.getElementById("settingsExistingRepoPicker");
      holder.style.display = "block";
      holder.innerHTML = `<div class="settings-status">Loading your repos&hellip;</div>`;
      let repos;
      try {
        repos = await listMyRepos();
      } catch (err) {
        holder.innerHTML = `<div class="settings-status error">Couldn't load repos: ${escapeHtml(err.message)}</div>`;
        return;
      }
      if (repos.length === 0) {
        holder.innerHTML = `<div class="settings-status">No repos found on this account.</div>`;
        return;
      }
      holder.innerHTML = `
        <select id="settingsExistingRepoSelect">
          ${repos
            .map((r) => `<option value="${escapeHtml(r.owner)}/${escapeHtml(r.repo)}">${escapeHtml(r.owner)}/${escapeHtml(r.repo)}${r.private ? "" : " (public)"}</option>`)
            .join("")}
        </select>
        <button class="modal-btn done" id="settingsConnectExisting" style="margin-left:8px">Connect</button>
      `;
      document.getElementById("settingsConnectExisting").onclick = async () => {
        const [owner, repo] = document.getElementById("settingsExistingRepoSelect").value.split("/");
        setStatus("settingsStatus", "Checking repo…", false);
        try {
          await connectExistingVaultRepo(owner, repo);
          state.pendingOAuthVaultPick = null;
          await renderSettingsView(container, callbacks);
        } catch (err) {
          setStatus("settingsStatus", `Failed: ${err.message}`, true);
        }
      };
    };
  }

  const syncNowBtn = document.getElementById("settingsSyncNow");
  if (syncNowBtn) {
    syncNowBtn.onclick = async () => {
      // The click handler itself is race-free (syncNow() serializes against the background
      // timer regardless), but without this a double-click still queues up a second, pointless
      // round trip before the first one's even rendered.
      syncNowBtn.disabled = true;
      setStatus("syncStatus", "Syncing…", false);
      const bookId = getActiveBookId();
      const { pushResult, pullResult } = await syncNow(bookId, { force: true });
      state.syncPauseReason = pushResult.paused ? pushResult.pauseReason : null;
      if (pullResult.pulled > 0 && notifyBookDataChanged) await notifyBookDataChanged(bookId);
      // Push and pull can both flag the same target as conflicting in one pass (e.g. a structural
      // push conflict gets rediscovered during reconciliation) — they'd double-count it if summed,
      // so re-read the actual conflict list rather than trusting each pass's own tally.
      const totalConflicts = (await listConflicts()).length;
      await renderSettingsView(container, callbacks);
      if (pushResult.paused) {
        setStatus("syncStatus", `Paused: ${pushResult.pauseReason}`, true);
      } else {
        setStatus(
          "syncStatus",
          `Pushed ${pushResult.pushed} file(s), pulled ${pullResult.pulled} file(s), ${totalConflicts} conflict(s).`,
          totalConflicts > 0
        );
      }
      if (onSyncStatusChanged) onSyncStatusChanged();
    };
  }

  const disconnectBtn = document.getElementById("settingsDisconnect");
  if (disconnectBtn) {
    disconnectBtn.onclick = () => {
      document.getElementById("disconnectConfirmRow").style.display = "block";
      disconnectBtn.style.display = "none";
    };
  }
  const disconnectCancelBtn = document.getElementById("settingsDisconnectCancel");
  if (disconnectCancelBtn) {
    disconnectCancelBtn.onclick = () => {
      document.getElementById("disconnectConfirmRow").style.display = "none";
      document.getElementById("settingsDisconnect").style.display = "";
    };
  }
  const disconnectConfirmBtn = document.getElementById("settingsDisconnectConfirm");
  if (disconnectConfirmBtn) {
    disconnectConfirmBtn.onclick = async () => {
      await disconnectGithub();
      await renderSettingsView(container, callbacks);
      setStatus("settingsStatus", "Disconnected. Sign in with GitHub again to reconnect.", false);
    };
  }

  document.getElementById("settingsExportJson").onclick = () => {
    const blob = new Blob([exportDataAsJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `novellum-export-${new Date().toISOString().slice(0, 10)}.json`;
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
        toggleBtn.textContent = isHidden ? "Hide Changes" : "View Changes";
        if (isHidden && !diffEl.dataset.loaded) {
          diffEl.dataset.loaded = "1";
          await loadSummaryInto(diffEl, c);
        }
      };
    }
    const keepBtn = document.getElementById(`keepMine-${c.key}`);
    const theirsBtn = document.getElementById(`useTheirs-${c.key}`);
    if (keepBtn) {
      keepBtn.onclick = async () => {
        // Give immediate feedback — resolving involves a network push, which can take a
        // moment, and clicking into silence reads as "did that even register?".
        keepBtn.disabled = true;
        if (theirsBtn) theirsBtn.disabled = true;
        keepBtn.textContent = "Resolving…";
        setStatus("syncStatus", "Resolving — pushing your version…", false);
        // "Keep Mine" only re-queues the push — actually push it now instead of leaving the
        // user to notice nothing happened and hit Sync Now again themselves.
        await resolveConflictKeepMine(c.key);
        const { pushResult } = await syncNow(null, { force: true });
        await renderSettingsView(container, callbacks);
        setStatus("syncStatus", `Resolved. Pushed ${pushResult.pushed} file(s), ${pushResult.conflicts} conflict(s).`, pushResult.conflicts > 0);
        if (onSyncStatusChanged) onSyncStatusChanged();
      };
    }
    if (theirsBtn) {
      theirsBtn.onclick = async () => {
        theirsBtn.disabled = true;
        if (keepBtn) keepBtn.disabled = true;
        theirsBtn.textContent = "Resolving…";
        setStatus("syncStatus", "Resolving — taking GitHub's version…", false);
        await resolveConflictUseTheirs(c.key);
        // The accepted GitHub content only landed in IndexedDB — if this book is the one
        // currently open, the in-memory manuscript/UI must be refreshed too, or the next
        // local edit would silently overwrite the version we just accepted.
        if (notifyBookDataChanged) await notifyBookDataChanged(c.bookId);
        await renderSettingsView(container, callbacks);
        setStatus("syncStatus", "Took GitHub's version.", false);
        if (onSyncStatusChanged) onSyncStatusChanged();
      };
    }
  });
}

/** Shown right after a "Sign in with GitHub" redirect when the account's default vault repo
 *  either doesn't exist yet or exists but failed the "is this actually a Novellum vault" check
 *  (state.pendingOAuthVaultPick, set in main.js) — an explicit choice instead of guessing. */
function renderVaultPickPhase({ login, blockedReason }) {
  const explanation = blockedReason
    ? escapeHtml(blockedReason)
    : `No <strong>${escapeHtml(DEFAULT_VAULT_REPO_NAME)}</strong> repo found for this account yet.`;
  return `
    <div class="settings-section">
      <div class="section-label">Choose your vault</div>
      <div class="settings-status" style="margin:0 0 10px">
        Signed in as <strong>${escapeHtml(login)}</strong>. ${explanation}
        Create a new vault, or connect an existing repository instead.
      </div>
      <div class="settings-actions-row">
        <button class="modal-btn done" id="settingsCreateVault">Create &ldquo;${escapeHtml(DEFAULT_VAULT_REPO_NAME)}&rdquo;</button>
        <button class="tbtn" id="settingsPickExistingRepo">Choose an existing repo&hellip;</button>
      </div>
      <div id="settingsExistingRepoPicker" style="display:none;margin-top:10px"></div>
      <div id="settingsStatus" class="settings-status"></div>
    </div>
  `;
}

/** Not-yet-connected phase: the only way to connect is "Sign in with GitHub" — it detects the
 *  account and finds/creates the vault repo automatically, so there's no token or repo name to
 *  fill in by hand. */
function renderSetupPhase() {
  return `
    <div class="settings-section">
      <div class="section-label">Connect GitHub</div>
      <div class="settings-status" style="margin:0 0 10px">
        Sign in with your GitHub account to sync your books!
      </div>
      <button class="modal-btn done" id="settingsOAuthLogin">Sign in with GitHub</button>
      <div id="settingsStatus" class="settings-status"></div>
    </div>
  `;
}

/** Connected phase: a clear "which repo" banner plus the one way out — Disconnect — instead
 *  of re-showing the raw token/owner/repo form (see settings-ui redesign: a fresh setup should
 *  never look ambiguous about whether a repo is already wired up). */
function renderConnectedPhase(settings) {
  return `
    <div class="settings-section">
      <div class="section-label">Repository</div>
      <div class="repo-connected">
        <span class="repo-connected-dot"></span>
        Connected to <strong>${escapeHtml(settings.owner)}/${escapeHtml(settings.repo)}</strong>
      </div>
      <div class="settings-actions-row" style="margin-top:10px">
        <button class="tbtn" id="settingsDisconnect">Disconnect&hellip;</button>
      </div>
      <div id="disconnectConfirmRow" class="settings-status" style="display:none">
        This clears the saved token, owner/repo, and sync history on this device — your manuscript
        itself is untouched. Use this to switch to a different GitHub account or repo.
        <div class="settings-actions-row" style="margin-top:8px">
          <button class="modal-btn delete" id="settingsDisconnectConfirm">Yes, Disconnect</button>
          <button class="tbtn" id="settingsDisconnectCancel">Cancel</button>
        </div>
      </div>
      <div id="settingsStatus" class="settings-status"></div>
    </div>
  `;
}

/** Best-effort human label for a conflict row's header. The remote copy is already sitting on
 *  the conflict record (captured when the conflict was detected), so a scene's title can be
 *  read synchronously — no extra IndexedDB round trip needed just to render the list. */
function conflictTitle(c) {
  if (c.kind === "scene" && c.remoteContent) {
    try {
      const title = markdownToScene(c.remoteContent).title;
      if (title) return title;
    } catch {
      // Fall through to the generic label below if the stored remote copy doesn't parse.
    }
  }
  if (c.kind === "manifest") return "Manuscript structure";
  if (c.kind === "bible") return "Story bible";
  return "Scene";
}

function renderConflictsSection(conflicts) {
  const rows = conflicts
    .map(
      (c) => `
    <div class="conflict-row">
      <div class="conflict-row-head">
        <div>${escapeHtml(conflictTitle(c))}</div>
        <div class="conflict-actions">
          <button class="tbtn" id="toggleDiff-${c.key}">View Changes</button>
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

/** Inline "track changes" rendering of one changed field: the two versions rejoined into a
 *  single flow of text, with GitHub's removed words struck through and your added words
 *  underlined — reads like a word-processor's tracked-changes view rather than a code diff. */
function wordDiffHtml(oldText, newText) {
  if (oldText === newText) return escapeHtml(oldText || "");
  return diffWords(oldText, newText)
    .map(({ type, text }) => {
      const safe = escapeHtml(text);
      if (type === "add") return `<span class="worddiff-add">${safe}</span>`;
      if (type === "remove") return `<span class="worddiff-remove">${safe}</span>`;
      return safe;
    })
    .join("");
}

/** Compact +/- rendering for a changed list (to-dos, bible entries, chapters) where individual
 *  entries were added or removed rather than edited word-by-word. */
function listDiffHtml(removedItems, addedItems) {
  const removed = removedItems.map((t) => `<div class="conflict-list-line worddiff-remove-line">&minus; ${escapeHtml(t)}</div>`);
  const added = addedItems.map((t) => `<div class="conflict-list-line worddiff-add-line">+ ${escapeHtml(t)}</div>`);
  return [...removed, ...added].join("");
}

/** Strips a scene body's rich-text HTML down to plain text for diffing purposes — good enough to
 *  show which words changed; formatting-only edits (e.g. bold) won't show up here, which is the
 *  point (see "Show raw file diff" for the byte-exact view). */
function htmlToPlainText(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return div.textContent || "";
}

function summarizeScene(remoteRaw, localRaw) {
  const theirs = markdownToScene(remoteRaw);
  const mine = markdownToScene(localRaw);
  const fields = [];
  if (mine.title !== theirs.title) {
    fields.push({ label: "Title", html: wordDiffHtml(theirs.title, mine.title) });
  }
  if (mine.summary !== theirs.summary) {
    fields.push({ label: "Summary", html: wordDiffHtml(theirs.summary, mine.summary) });
  }
  const mineText = htmlToPlainText(mine.text);
  const theirsText = htmlToPlainText(theirs.text);
  if (mineText !== theirsText) {
    fields.push({ label: "Scene text", html: wordDiffHtml(theirsText, mineText), prose: true });
  }
  const mineTodos = mine.todos || [];
  const theirsTodos = theirs.todos || [];
  if (JSON.stringify(mineTodos) !== JSON.stringify(theirsTodos)) {
    fields.push({
      label: "To-dos",
      html: listDiffHtml(theirsTodos.filter((t) => !mineTodos.includes(t)), mineTodos.filter((t) => !theirsTodos.includes(t))),
    });
  }
  return fields;
}

function summarizeManifest(remoteRaw, localRaw) {
  const theirs = JSON.parse(remoteRaw);
  const mine = JSON.parse(localRaw);
  const fields = [];
  if (mine.title !== theirs.title) {
    fields.push({ label: "Book title", html: wordDiffHtml(theirs.title, mine.title) });
  }

  const theirsCh = theirs.chapters || [];
  const mineCh = mine.chapters || [];
  const theirsById = new Map(theirsCh.map((ch) => [ch.id, ch]));
  const mineById = new Map(mineCh.map((ch) => [ch.id, ch]));

  const addedChapters = mineCh.filter((ch) => !theirsById.has(ch.id)).map((ch) => ch.title);
  const removedChapters = theirsCh.filter((ch) => !mineById.has(ch.id)).map((ch) => ch.title);
  if (addedChapters.length || removedChapters.length) {
    fields.push({ label: "Chapters added/removed", html: listDiffHtml(removedChapters, addedChapters) });
  }

  const renamed = mineCh.filter((ch) => theirsById.has(ch.id) && theirsById.get(ch.id).title !== ch.title);
  if (renamed.length) {
    fields.push({
      label: "Chapters renamed",
      html: renamed.map((ch) => `<div class="conflict-list-line">${wordDiffHtml(theirsById.get(ch.id).title, ch.title)}</div>`).join(""),
    });
  }

  const commonIds = mineCh.map((ch) => ch.id).filter((id) => theirsById.has(id));
  const theirsOrder = theirsCh.map((ch) => ch.id).filter((id) => mineById.has(id));
  const mineOrder = mineCh.map((ch) => ch.id).filter((id) => theirsById.has(id));
  if (JSON.stringify(theirsOrder) !== JSON.stringify(mineOrder)) {
    fields.push({ label: "Chapter order", html: "Chapters were reordered." });
  }

  let movedSceneRefs = 0;
  for (const id of commonIds) {
    const theirsScenes = new Set(theirsById.get(id).sceneIds || []);
    const mineScenes = new Set(mineById.get(id).sceneIds || []);
    for (const sid of mineScenes) if (!theirsScenes.has(sid)) movedSceneRefs += 1;
    for (const sid of theirsScenes) if (!mineScenes.has(sid)) movedSceneRefs += 1;
  }
  if (movedSceneRefs > 0) {
    fields.push({ label: "Scene placement", html: "Scenes were added, removed, or moved between chapters on one side." });
  }

  return fields;
}

function summarizeBible(remoteRaw, localRaw) {
  const theirs = JSON.parse(remoteRaw);
  const mine = JSON.parse(localRaw);
  const fields = [];
  const kinds = [["characters", "Characters"], ["locations", "Locations"], ["concepts", "Concepts"]];
  for (const [key, label] of kinds) {
    const theirsList = theirs[key] || [];
    const mineList = mine[key] || [];
    const theirsById = new Map(theirsList.map((x) => [x.id, x]));
    const mineById = new Map(mineList.map((x) => [x.id, x]));

    const added = mineList.filter((x) => !theirsById.has(x.id));
    const removed = theirsList.filter((x) => !mineById.has(x.id));
    const changed = mineList.filter((x) => {
      const t = theirsById.get(x.id);
      return t && (t.name !== x.name || t.desc !== x.desc);
    });
    if (!added.length && !removed.length && !changed.length) continue;

    const changedHtml = changed
      .map((x) => {
        const t = theirsById.get(x.id);
        const nameHtml = wordDiffHtml(t.name, x.name);
        const descHtml = t.desc !== x.desc ? `<div class="conflict-subline">${wordDiffHtml(t.desc, x.desc)}</div>` : "";
        return `<div class="conflict-list-line"><strong>${nameHtml}</strong>${descHtml}</div>`;
      })
      .join("");
    fields.push({
      label,
      html: listDiffHtml(removed.map((x) => x.name), added.map((x) => x.name)) + changedHtml,
    });
  }
  return fields;
}

function summarizeConflict(conflict, localRaw) {
  const remoteRaw = conflict.remoteContent || "";
  if (conflict.kind === "scene") return summarizeScene(remoteRaw, localRaw);
  if (conflict.kind === "manifest") return summarizeManifest(remoteRaw, localRaw);
  return summarizeBible(remoteRaw, localRaw);
}

/** Fetches the local version of a conflicting file and renders a cleaner, field-by-field summary
 *  against the remote copy already captured on the conflict record — what actually changed
 *  (title, summary, text, to-dos, ...) instead of a raw line-by-line file diff, which buries the
 *  real change under frontmatter noise (id/todos/updatedAt) and can flag a conflict as "changed"
 *  even when only a timestamp differs. The byte-exact raw diff is still one click away. */
async function loadSummaryInto(container, conflict) {
  container.innerHTML = `<div class="diff-loading">Loading&hellip;</div>`;
  const localContent = await getLocalContentForConflict(conflict);
  if (localContent === null) {
    container.innerHTML = `<div class="diff-empty">No local copy exists anymore — it may have been deleted since this conflict was detected.</div>`;
    return;
  }

  let fields;
  try {
    fields = summarizeConflict(conflict, localContent);
  } catch {
    fields = null;
  }

  const rawToggleHtml = `
    <button class="tbtn-inline" id="rawDiffToggle-${conflict.key}">Show raw file diff</button>
    <div class="conflict-diff" id="rawDiff-${conflict.key}" style="display:none"></div>
  `;

  if (!fields) {
    container.innerHTML = `<div class="diff-empty">Couldn't compare these versions automatically.</div>${rawToggleHtml}`;
  } else if (fields.length === 0) {
    container.innerHTML = `
      <div class="conflict-nochange">No meaningful differences — likely just sync bookkeeping (e.g. a timestamp). Either choice is safe to pick.</div>
      ${rawToggleHtml}
    `;
  } else {
    const fieldsHtml = fields
      .map(
        (f) => `
      <div class="conflict-field">
        <div class="conflict-field-label">${escapeHtml(f.label)}</div>
        <div class="conflict-field-body${f.prose ? " conflict-field-body-prose" : ""}">${f.html}</div>
      </div>`
      )
      .join("");
    container.innerHTML = `
      <div class="worddiff-legend">
        <span class="worddiff-legend-item"><span class="worddiff-remove">struck</span> = GitHub's version</span>
        <span class="worddiff-legend-item"><span class="worddiff-add">underlined</span> = yours (Keep Mine)</span>
      </div>
      ${fieldsHtml}
      ${rawToggleHtml}
    `;
  }

  const rawToggle = document.getElementById(`rawDiffToggle-${conflict.key}`);
  rawToggle.onclick = async () => {
    const rawEl = document.getElementById(`rawDiff-${conflict.key}`);
    const isHidden = rawEl.style.display === "none";
    rawEl.style.display = isHidden ? "block" : "none";
    rawToggle.textContent = isHidden ? "Hide raw file diff" : "Show raw file diff";
    if (isHidden && !rawEl.dataset.loaded) {
      rawEl.dataset.loaded = "1";
      loadDiffInto(rawEl, conflict, localContent);
    }
  };
}

/** Renders a line-by-line diff of the two raw files (frontmatter and all) — the byte-exact
 *  fallback behind "Show raw file diff" for whoever wants to see everything. */
function loadDiffInto(container, conflict, localContent) {
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

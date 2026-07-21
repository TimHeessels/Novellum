"use strict";

import { escapeHtml, formatRelativeTime, markdownToScene } from "./model.js";
import {
  getGithubSettings, disconnectGithub,
  listOutbox, listConflicts, pushChanges, pullChanges, resolveConflictKeepMine, resolveConflictUseTheirs,
  getLocalContentForConflict, connectToRepo, isUsableVaultRepo, resolveAllConflicts, withSyncLock,
  listBookHistory, isBookClean, previewRestore, restoreToCommit,
  previewPush, previewPull, checkRemoteChanges, setOutboxEntrySkipped, revertOutboxEntry,
} from "./sync-engine.js";
import { getActiveBookId, exportDataAsJson, importDataFromJson } from "./persistence.js";
import { diffLines, diffWords } from "./diff.js";
import { state } from "./state.js";
import { startGithubLogin } from "./github-oauth.js";

export async function renderSettingsView(container, callbacks, { justPushed = new Set() } = {}) {
  const { onBack, notifyBookDataChanged, onSyncStatusChanged } = callbacks;
  const [settings, outbox, conflicts] = await Promise.all([getGithubSettings(), listOutbox(), listConflicts()]);
  const isConnected = !!(settings.token && settings.owner && settings.repo);
  // Re-checked on every render (not just at connect time) so if someone later adds unrelated
  // content to the repo directly on GitHub, the warning shows up next time Settings is opened.
  // Fails open (assume usable) on error — this is an advisory nudge, not a security boundary, and
  // a transient network hiccup shouldn't scare someone with a false "wrong repo" warning.
  const vaultLooksUsable = isConnected
    ? await isUsableVaultRepo(settings.owner, settings.repo, settings.defaultBranch).catch(() => true)
    : true;

  const bookId = getActiveBookId();
  // Freshly re-checked every render, same reasoning as vaultLooksUsable above — cheap (a tree
  // fetch plus local sha comparisons, no blobs, see checkRemoteChanges) — and written straight
  // through to `state` so the topbar badge/pull banner reflect reality immediately rather than
  // waiting for main.js's 5-minute background poll to catch up (e.g. right after a pull below).
  let remoteChangeCount = 0;
  if (isConnected && bookId) {
    const remoteCheck = await checkRemoteChanges(bookId, justPushed).catch(() => ({ hasChanges: false, count: 0 }));
    remoteChangeCount = remoteCheck.count;
    state.hasRemoteChanges = remoteCheck.hasChanges;
    state.remoteChangeCount = remoteCheck.count;
  }

  const activeCount = outbox.filter((e) => !e.skipped).length;
  // Not-yet-connected accounts never see the tab bar (there's nothing to sync/browse yet), so
  // they always land on the plain setup flow regardless of whatever tab was last selected.
  const tab = isConnected ? state.settingsTab || "sync" : "sync";

  container.innerHTML = `
    <div class="settings-view">
      <div class="settings-header">
        <h2>GitHub Sync</h2>
        <button class="modal-close" id="settingsBack">&times;</button>
      </div>

      ${isConnected ? renderTabBar(tab, conflicts.length, activeCount, remoteChangeCount) : ""}

      ${isConnected ? `
        <div class="settings-tab-panel"${tab === "sync" ? "" : " hidden"}>
          <div id="syncStatus" class="settings-status"></div>
          ${conflicts.length > 0 ? renderConflictsSection(conflicts) : ""}
          ${outbox.length > 0 ? renderPushSection(outbox) : ""}
          ${remoteChangeCount > 0 ? renderPullSection(remoteChangeCount) : ""}
          ${conflicts.length === 0 && outbox.length === 0 && remoteChangeCount === 0
            ? `<div class="settings-status" style="margin-top:2px">You're all synced up.</div>`
            : ""}
        </div>

        <div class="settings-tab-panel"${tab === "history" ? "" : " hidden"}>
          <div class="settings-status" style="margin:0 0 14px">
            Every sync creates a commit — browse past versions of this book and restore one if
            something's missing.
          </div>
          <div id="historyPanel"></div>
        </div>

        <div class="settings-tab-panel"${tab === "settings" ? "" : " hidden"}>
          ${renderConnectedPhase(settings, vaultLooksUsable)}
          <div class="settings-section">
            <div class="section-label">Sync stats</div>
            <div>Last pushed: ${settings.lastPushedAt ? formatRelativeTime(settings.lastPushedAt) : "Never"}</div>
            <div>Last pulled: ${settings.lastPulledAt ? formatRelativeTime(settings.lastPulledAt) : "Never"}</div>
            <div id="pendingChangesStat">Pending changes: ${outbox.length}${outbox.some((e) => e.skipped) ? ` (${outbox.filter((e) => e.skipped).length} ignored)` : ""}</div>
          </div>
          ${renderManualBackupSection()}
        </div>
      ` : `
        ${state.pendingOAuthVaultPick
          ? renderVaultPickPhase(state.pendingOAuthVaultPick)
          : renderSetupPhase()}
        ${renderManualBackupSection()}
      `}
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

  // A "Connect GitHub" redirect may have just completed (see main.js) before this view's
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

  const connectGrantedBtn = document.getElementById("settingsConnectGrantedRepo");
  if (connectGrantedBtn) {
    connectGrantedBtn.onclick = async () => {
      const [owner, repo] = document.getElementById("settingsGrantedRepoSelect").value.split("/");
      connectGrantedBtn.disabled = true;
      setStatus("settingsStatus", "Connecting…", false);
      try {
        await connectToRepo(owner, repo);
        state.pendingOAuthVaultPick = null;
        // Push+pull right away instead of leaving a freshly-connected repo sitting at "Last
        // pushed/pulled: Never" until the user notices the topbar controls themselves — this is
        // the one deliberate exception to "nothing syncs without a click" (see main.js), since the
        // whole point of just connecting is to see what's already in the vault.
        setStatus("settingsStatus", "Connected. Syncing…", false);
        const bookId = getActiveBookId();
        // notifyBookDataChanged runs inside pullChanges's (and pushChanges's own pre-push pull)
        // onPulled hook, still holding the sync lock, so nothing else queued on it can land in the
        // gap and flush stale in-memory `data` over what this pull just wrote (see withSyncLock's
        // comment in sync-engine.js).
        const pushResult = await pushChanges({
          force: true,
          onPulled: (bookIds) => Promise.all(bookIds.map((id) => notifyBookDataChanged && notifyBookDataChanged(id))),
        });
        await pullChanges(bookId, {
          onPulled: () => notifyBookDataChanged && notifyBookDataChanged(bookId),
          justPushed: pushResult.pushedTargets,
        });
        state.syncPauseReason = pushResult.paused ? pushResult.pauseReason : null;
        await renderSettingsView(container, callbacks, { justPushed: pushResult.pushedTargets });
        if (onSyncStatusChanged) onSyncStatusChanged();
      } catch (err) {
        connectGrantedBtn.disabled = false;
        setStatus("settingsStatus", `Failed: ${err.message}`, true);
      }
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

  const exportJsonBtn = document.getElementById("settingsExportJson");
  if (exportJsonBtn) {
    exportJsonBtn.onclick = () => {
      const blob = new Blob([exportDataAsJson()], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `novellum-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    };
  }

  const importJsonBtn = document.getElementById("settingsImportJson");
  if (importJsonBtn) {
    importJsonBtn.onclick = () => {
      document.getElementById("settingsImportJsonFile").click();
    };
  }

  const importJsonFileInput = document.getElementById("settingsImportJsonFile");
  if (importJsonFileInput) {
    importJsonFileInput.onchange = async (e) => {
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
  }

  if (isConnected) {
    ["sync", "history", "settings"].forEach((name) => {
      const btn = document.getElementById(`settingsTab-${name}`);
      if (!btn) return;
      btn.onclick = () => {
        if (state.settingsTab === name) return;
        state.settingsTab = name;
        renderSettingsView(container, callbacks);
      };
    });

    if (tab === "history") {
      loadHistoryTab(document.getElementById("historyPanel"), bookId, container, callbacks);
    }
  }

  const resolveAllMineBtn = document.getElementById("resolveAllMine");
  const resolveAllTheirsBtn = document.getElementById("resolveAllTheirs");
  if (resolveAllMineBtn) {
    resolveAllMineBtn.onclick = async () => {
      resolveAllMineBtn.disabled = true;
      if (resolveAllTheirsBtn) resolveAllTheirsBtn.disabled = true;
      resolveAllMineBtn.textContent = "Resolving…";
      setStatus("syncStatus", "Resolving all — pushing your versions…", false);
      // Same "re-queue then actually push now" pattern as the single Keep Mine button — one
      // shared force-push covers every conflict just re-queued, rather than one push each.
      const { count } = await resolveAllConflicts("mine");
      const pushResult = await pushChanges({
        force: true,
        onPulled: (bookIds) => Promise.all(bookIds.map((id) => notifyBookDataChanged && notifyBookDataChanged(id))),
      });
      await renderSettingsView(container, callbacks, { justPushed: pushResult.pushedTargets });
      setStatus("syncStatus", `Resolved ${count} conflict(s). ${describePushResult(pushResult)}`, false);
      if (onSyncStatusChanged) onSyncStatusChanged();
    };
  }
  if (resolveAllTheirsBtn) {
    resolveAllTheirsBtn.onclick = async () => {
      resolveAllTheirsBtn.disabled = true;
      if (resolveAllMineBtn) resolveAllMineBtn.disabled = true;
      resolveAllTheirsBtn.textContent = "Resolving…";
      setStatus("syncStatus", "Resolving all — taking GitHub's versions…", false);
      // The resolve (which writes the accepted GitHub content straight to IndexedDB) and the
      // notifyBookDataChanged refresh (which catches the in-memory manuscript back up to it) run
      // inside withSyncLock together — otherwise a background auto-sync tick landing in that gap
      // would flush the still-stale in-memory `data` and clobber what was just written (see
      // withSyncLock's comment in sync-engine.js; this is the "scenes went missing after a pull"
      // failure mode).
      const { count, bookIds } = await withSyncLock(async () => {
        const result = await resolveAllConflicts("theirs");
        // notifyBookDataChanged no-ops for any bookId that isn't the currently open one, so it's
        // safe to call once per distinct book touched rather than figuring out which one matters.
        if (notifyBookDataChanged) {
          for (const bookId of result.bookIds) await notifyBookDataChanged(bookId);
        }
        return result;
      });
      await renderSettingsView(container, callbacks);
      setStatus("syncStatus", `Resolved ${count} conflict(s) using GitHub's versions.`, false);
      if (onSyncStatusChanged) onSyncStatusChanged();
    };
  }

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
        // user to notice nothing happened and hit the topbar Push button again themselves.
        await resolveConflictKeepMine(c.key);
        const pushResult = await pushChanges({
          force: true,
          onPulled: (bookIds) => Promise.all(bookIds.map((id) => notifyBookDataChanged && notifyBookDataChanged(id))),
        });
        await renderSettingsView(container, callbacks, { justPushed: pushResult.pushedTargets });
        setStatus("syncStatus", `Resolved. ${describePushResult(pushResult)}`, pushResult.conflicts > 0);
        if (onSyncStatusChanged) onSyncStatusChanged();
      };
    }
    if (theirsBtn) {
      theirsBtn.onclick = async () => {
        theirsBtn.disabled = true;
        if (keepBtn) keepBtn.disabled = true;
        theirsBtn.textContent = "Resolving…";
        setStatus("syncStatus", "Resolving — taking GitHub's version…", false);
        // Both steps run inside withSyncLock together — see the comment on the "Use GitHub's
        // (All)" handler above for why: without it, a background auto-sync tick landing between
        // them can flush stale in-memory `data` over the content just accepted here.
        await withSyncLock(async () => {
          await resolveConflictUseTheirs(c.key);
          // The accepted GitHub content only landed in IndexedDB — if this book is the one
          // currently open, the in-memory manuscript/UI must be refreshed too, or the next
          // local edit would silently overwrite the version we just accepted.
          if (notifyBookDataChanged) await notifyBookDataChanged(c.bookId);
        });
        await renderSettingsView(container, callbacks);
        setStatus("syncStatus", "Took GitHub's version.", false);
        if (onSyncStatusChanged) onSyncStatusChanged();
      };
    }
  });

  const pushPreviewPanel = document.getElementById("pushPreviewPanel");
  if (pushPreviewPanel) loadPushPreviewInto(pushPreviewPanel, notifyBookDataChanged);

  const pushNowBtn = document.getElementById("pushNowBtn");
  if (pushNowBtn) {
    pushNowBtn.onclick = async () => {
      pushNowBtn.disabled = true;
      pushNowBtn.textContent = "Pushing…";
      setStatus("syncStatus", "Pushing…", false);
      try {
        const pushResult = await pushChanges({
          force: true,
          onPulled: (bookIds) => Promise.all(bookIds.map((id) => notifyBookDataChanged && notifyBookDataChanged(id))),
        });
        await renderSettingsView(container, callbacks, { justPushed: pushResult.pushedTargets });
        setStatus(
          "syncStatus",
          describePushResult(pushResult),
          !!pushResult.paused || pushResult.conflicts > 0
        );
        if (onSyncStatusChanged) onSyncStatusChanged();
      } catch (err) {
        pushNowBtn.disabled = false;
        pushNowBtn.textContent = "Push Now";
        setStatus("syncStatus", `Push failed: ${err.message}`, true);
      }
    };
  }

  const pullPreviewPanel = document.getElementById("pullPreviewPanel");
  if (pullPreviewPanel) loadPullPreviewInto(pullPreviewPanel, bookId, justPushed);

  const pullNowBtn = document.getElementById("pullNowBtn");
  if (pullNowBtn) {
    pullNowBtn.onclick = async () => {
      pullNowBtn.disabled = true;
      pullNowBtn.textContent = "Pulling…";
      setStatus("syncStatus", "Pulling…", false);
      try {
        const result = await pullChanges(bookId, {
          onPulled: async () => {
            if (callbacks.notifyBookDataChanged) await callbacks.notifyBookDataChanged(bookId);
          },
        });
        // Re-check right away rather than trusting the pre-pull remoteChangeCount — a pull that
        // hit a conflict on one target leaves that target's "something's different" state
        // genuinely still true, and main.js's background poll won't catch up for up to 5 minutes.
        const recheck = await checkRemoteChanges(bookId).catch(() => ({ hasChanges: false, count: 0 }));
        state.hasRemoteChanges = recheck.hasChanges;
        state.remoteChangeCount = recheck.count;
        await renderSettingsView(container, callbacks);
        setStatus("syncStatus", `Pulled ${result.pulled} file(s), ${result.conflicts} conflict(s).`, result.conflicts > 0);
        if (onSyncStatusChanged) onSyncStatusChanged();
      } catch (err) {
        pullNowBtn.disabled = false;
        pullNowBtn.textContent = "Pull Now";
        setStatus("syncStatus", `Pull failed: ${err.message}`, true);
      }
    };
  }

}

/** Loads the History tab's commit list the moment it's opened — no separate "Browse History"
 *  click needed now that it's its own tab. Still gated on isBookClean first: history browsing
 *  needs an unambiguous "current" to diff against, and with a pending push or an unresolved
 *  conflict, is "current" the local edit or what's on GitHub? Re-checkable by switching tabs
 *  again once the pending state (visible on the Sync tab) is synced/resolved. */
async function loadHistoryTab(panel, bookId, container, callbacks) {
  if (!panel) return;
  panel.innerHTML = `<div class="diff-loading">Loading&hellip;</div>`;
  const clean = await isBookClean(bookId);
  if (!clean) {
    panel.innerHTML = `<div class="settings-status error">You have pending changes or unresolved conflicts for this book — sync or resolve those first on the Sync tab, then come back to browse history.</div>`;
    return;
  }
  await renderHistoryList(panel, bookId, container, callbacks, []);
}

/** Tab bar shown across the top of the connected view — Sync/History/Settings. The badge on Sync
 *  mirrors the topbar sync badge's own priority order (conflicts, then pending push, then pending
 *  pull — see refreshSyncStatusUI in ui.js) rather than summing all three, so the two numbers
 *  never tell conflicting stories. */
function renderTabBar(activeTab, conflictCount, pushPendingCount, pullPendingCount) {
  const syncBadgeCount = conflictCount || pushPendingCount || pullPendingCount;
  const tabs = [
    { id: "sync", label: "Sync", badge: syncBadgeCount > 0 ? syncBadgeCount : null },
    { id: "history", label: "History", badge: null },
    { id: "settings", label: "Settings", badge: null },
  ];
  return `
    <div class="settings-tabs">
      ${tabs
        .map(
          (t) => `
        <button class="settings-tab${t.id === activeTab ? " active" : ""}" id="settingsTab-${t.id}">
          ${t.label}${t.badge ? `<span class="settings-tab-badge">${t.badge}</span>` : ""}
        </button>`
        )
        .join("")}
    </div>
  `;
}

/** A local JSON snapshot of the current book — separate from GitHub sync, so it's offered
 *  regardless of connection state (unconnected setup flow, or the connected Settings tab). */
function renderManualBackupSection() {
  return `
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
  `;
}

/** Shown right after a "Connect GitHub" redirect when the install grant covered more than one
 *  repo (state.pendingOAuthVaultPick, set in main.js) — Novellum only tracks one vault at a time,
 *  so this is where the user picks which of the granted repos that should be. */
function renderVaultPickPhase({ repos }) {
  return `
    <div class="settings-section">
      <div class="section-label">Choose your vault</div>
      <div class="settings-status" style="margin:0 0 10px">
        GitHub granted access to ${repos.length} repositories. Choose which one Novellum should use
        as the manuscript vault.
      </div>
      <select id="settingsGrantedRepoSelect">
        ${repos
          .map((r) => `<option value="${escapeHtml(r.owner)}/${escapeHtml(r.repo)}">${escapeHtml(r.owner)}/${escapeHtml(r.repo)}${r.private ? "" : " (public)"}</option>`)
          .join("")}
      </select>
      <div class="settings-actions-row" style="margin-top:10px">
        <button class="modal-btn done" id="settingsConnectGrantedRepo">Connect</button>
      </div>
      <div id="settingsStatus" class="settings-status"></div>
    </div>
  `;
}

/** Not-yet-connected phase: the only way to connect is through GitHub's own install picker,
 *  reached via the Novellum GitHub App — the user chooses exactly which repo(s) to grant there,
 *  so there's no token, owner, or repo name to fill in here, and no broader access than that
 *  choice. Requires the repo to already exist (GitHub App tokens can't create repos), so this
 *  points the user at a plain "create a repo" link first if they don't have one yet. */
function renderSetupPhase() {
  return `
    <div class="settings-section">
      <div class="section-label">Connect GitHub</div>
      <div class="settings-status" style="margin:0 0 10px">
        If you don't already have a repo for your manuscript, <a class="settings-link" target="_blank"
        rel="noopener" href="https://github.com/new">create one on GitHub first &rarr;</a> (any name,
        private recommended). Then click below and select that repo when GitHub asks — Novellum only
        ever gets access to the repo(s) you explicitly choose there, nothing else on your account.
      </div>
      <button class="modal-btn done" id="settingsOAuthLogin">Connect GitHub</button>
      <div id="settingsStatus" class="settings-status"></div>
    </div>
  `;
}

/** Connected phase: a clear "which repo" banner plus the one way out — Disconnect — instead
 *  of re-showing the raw token/owner/repo form (see settings-ui redesign: a fresh setup should
 *  never look ambiguous about whether a repo is already wired up). Shows a non-blocking warning
 *  when the connected repo doesn't look like a usable vault (see isUsableVaultRepo) — the user
 *  already deliberately granted access to it in GitHub's own picker, so this nudges rather than
 *  blocks, pointing at GitHub's installation settings to fix it. */
function renderConnectedPhase(settings, vaultLooksUsable) {
  return `
    <div class="settings-section">
      <div class="section-label">Repository</div>
      <div class="repo-connected">
        <span class="repo-connected-dot"></span>
        Connected to <strong>${escapeHtml(settings.owner)}/${escapeHtml(settings.repo)}</strong>
      </div>
      ${vaultLooksUsable ? "" : `
        <div class="settings-status error" style="margin-top:8px">
          This repo already has other content and doesn't look like a Novellum vault — you may have
          selected the wrong one. <a class="settings-link" target="_blank" rel="noopener"
          href="https://github.com/settings/installations">Manage repository access on GitHub &rarr;</a>
          to grant a different repo, then Disconnect and reconnect below.
        </div>
      `}
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

/** Same idea as conflictTitle but works off an arbitrary raw string instead of a conflict record
 *  — used by the push-preview rows, which have no conflict object at all. */
function rawContentTitle(kind, raw) {
  if (kind === "scene" && raw) {
    try {
      const title = markdownToScene(raw).title;
      if (title) return title;
    } catch {
      // Fall through to the generic label below.
    }
  }
  if (kind === "manifest") return "Manuscript structure";
  if (kind === "bible") return "Story bible";
  return "Scene";
}

/** Shared status-line phrasing for every pushChanges() call site — folds in the (usually silent)
 *  pre-push pull step so "why did my manuscript just change?" has an answer right next to "Pushed
 *  N file(s)." rather than only being discoverable by noticing the pull banner disappeared. */
function describePushResult(pushResult) {
  const prePull = pushResult.prePull;
  const pullPart = prePull && (prePull.pulled > 0 || prePull.conflicts > 0)
    ? `Pulled ${prePull.pulled} file(s) first${prePull.conflicts > 0 ? ` (${prePull.conflicts} conflict(s))` : ""}. `
    : "";
  if (pushResult.paused) return `${pullPart}Couldn't push: ${pushResult.pauseReason}`;
  return `${pullPart}Pushed ${pushResult.pushed} file(s), ${pushResult.conflicts} conflict(s).`;
}

function renderPushSection(outbox) {
  const activeCount = outbox.filter((e) => !e.skipped).length;
  const ignoredCount = outbox.length - activeCount;
  return `
    <div class="settings-section">
      <div class="section-label" id="pushSectionLabel">Push (${activeCount} pending)</div>
      <div class="settings-status" style="margin:0 0 8px">
        Pulls anything new from GitHub first, then sends yours.
      </div>
      <div class="settings-status" id="pushIgnoredNote" style="margin:0 0 8px${ignoredCount > 0 ? "" : ";display:none"}">
        ${ignoredCount} change${ignoredCount === 1 ? "" : "s"} marked "Ignore" below — won't be sent until you include ${ignoredCount === 1 ? "it" : "them"} again.
      </div>
      <div class="settings-actions-row">
        <button class="modal-btn done" id="pushNowBtn"${activeCount === 0 ? " disabled" : ""}>Push Now</button>
      </div>
    </div>
    <div class="settings-section">
      <div class="section-label">Changes</div>
      <div id="pushPreviewPanel"></div>
    </div>
  `;
}

function renderPullSection(count) {
  return `
    <div class="settings-section">
      <div class="section-label">Pull (${count} pending)</div>
      <div class="settings-status" style="margin:0 0 8px">
        What pulling right now would bring in from GitHub for this book.
      </div>
      <div class="settings-actions-row">
        <button class="modal-btn done" id="pullNowBtn">Pull Now</button>
      </div>
      <div id="pullPreviewPanel" style="margin-top:14px"></div>
    </div>
  `;
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
      <div class="section-label" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <span>Conflicts (${conflicts.length})</span>
        ${conflicts.length > 1 ? `
          <div class="settings-actions-row">
            <button class="tbtn" id="resolveAllMine">Keep Mine (All)</button>
            <button class="tbtn" id="resolveAllTheirs">Use GitHub's (All)</button>
          </div>
        ` : ""}
      </div>
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
  if ((mine.author || "") !== (theirs.author || "")) {
    fields.push({ label: "Author", html: wordDiffHtml(theirs.author || "", mine.author || "") });
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
    const entriesEqual = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
    const changed = mineList.filter((x) => {
      const t = theirsById.get(x.id);
      return t && (t.name !== x.name || !entriesEqual(t.entries, x.entries));
    });
    if (!added.length && !removed.length && !changed.length) continue;

    const changedHtml = changed
      .map((x) => {
        const t = theirsById.get(x.id);
        const nameHtml = wordDiffHtml(t.name, x.name);
        const descHtml = !entriesEqual(t.entries, x.entries) ? `<div class="conflict-subline">Details changed</div>` : "";
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
 *  fallback behind "Show raw file diff" for whoever wants to see everything. `addLabel` lets
 *  callers outside conflict resolution (e.g. the push preview, where there's no "keep mine"
 *  decision to make) use wording that fits their own context. */
function loadDiffInto(container, conflict, localContent, addLabel = "+ Your local version (Keep Mine)") {
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
      <span class="diff-legend-item diff-legend-add">${addLabel}</span>
    </div>
    <div class="diff-body">${linesHtml}</div>
  `;
}

/* ---------------------------------------------------------------- */
/* Push / pull preview                                               */
/* ---------------------------------------------------------------- */

const PUSH_CHANGE_LABEL = {
  create: "New file — not yet on GitHub",
  delete: "Deleted locally — would remove this file from GitHub",
  noop: "Nothing to push (already absent on GitHub)",
  unchanged: "No content difference from GitHub's version",
  update: "Changed since last push",
};

/** Re-derives the push section's header (pending count, ignored note, Push Now enabled state) and
 *  the "Pending changes" stats line from the current outbox — called after an Ignore/Include
 *  toggle so those stay in sync without collapsing the (possibly expanded) preview panel via a
 *  full renderSettingsView re-render. No-ops for any element that isn't on the page (e.g. the
 *  stats line only exists while connected, which is always true here, but this stays defensive). */
async function refreshPushHeader() {
  const outbox = await listOutbox();
  const activeCount = outbox.filter((e) => !e.skipped).length;
  const ignoredCount = outbox.length - activeCount;

  const label = document.getElementById("pushSectionLabel");
  if (label) label.textContent = `Push (${activeCount} pending)`;

  const note = document.getElementById("pushIgnoredNote");
  if (note) {
    note.style.display = ignoredCount > 0 ? "" : "none";
    note.textContent = `${ignoredCount} change${ignoredCount === 1 ? "" : "s"} marked "Ignore" below — won't be sent until you include ${ignoredCount === 1 ? "it" : "them"} again.`;
  }

  const pushNowBtn = document.getElementById("pushNowBtn");
  if (pushNowBtn) pushNowBtn.disabled = activeCount === 0;

  const stat = document.getElementById("pendingChangesStat");
  if (stat) stat.textContent = `Pending changes: ${outbox.length}${ignoredCount > 0 ? ` (${ignoredCount} ignored)` : ""}`;
}

/** Revert is only offered where it's both meaningful and safe: GitHub already has a copy to fall
 *  back to ("update"/"delete", any kind), or — the common case the user actually wants this for —
 *  a scene that was created locally and never pushed at all, where "reverting" just means throwing
 *  the new scene away. Never offered for a brand-new manifest/bible ("create" on those kinds only
 *  happens before a book's very first sync), since there's nothing on GitHub to fall back to and
 *  discarding it would mean destroying the only copy of the book's structure. Also never offered
 *  for "unchanged"/"noop" — there's nothing to discard. */
function canRevertEntry(e) {
  if (e.changeType === "update" || e.changeType === "delete") return true;
  return e.changeType === "create" && e.kind === "scene";
}

/** Lazily loads and renders what pushing right now would actually send — one row per outbox
 *  entry (across every book, matching pushChanges's own scope), each with its own "View Changes"
 *  toggle, an "Ignore"/"Include in Push" toggle (setOutboxEntrySkipped), and — where meaningful —
 *  a "Revert" action (revertOutboxEntry) that discards the local change entirely instead of just
 *  hiding it. The "Push Now" button itself lives outside this panel (see renderPushSection) so it
 *  works whether or not the preview has been expanded. */
async function loadPushPreviewInto(panel, notifyBookDataChanged) {
  panel.innerHTML = `<div class="diff-loading">Loading&hellip;</div>`;
  const { entries } = await previewPush();

  if (entries.length === 0) {
    panel.innerHTML = `<div class="diff-empty">Nothing pending.</div>`;
    return;
  }

  const multiBook = new Set(entries.map((e) => e.bookId)).size > 1;
  const bookTitle = (id) => state.books.find((b) => b.id === id)?.title || id;

  const rowsHtml = entries
    .map((e) => {
      const showToggle = e.changeType !== "noop";
      const showRevert = canRevertEntry(e);
      const statusText = e.skipped
        ? `Ignored — won't be sent with this push`
        : `${PUSH_CHANGE_LABEL[e.changeType]}`;
      return `
    <div class="conflict-row"${e.skipped ? ' style="opacity:0.6"' : ""}>
      <div class="conflict-row-head">
        <div>
          ${escapeHtml(rawContentTitle(e.kind, e.localRaw || e.remoteRaw))}
          <div class="settings-status" style="margin:2px 0 0">
            ${escapeHtml(statusText)}${multiBook ? ` &middot; ${escapeHtml(bookTitle(e.bookId))}` : ""}
          </div>
        </div>
        <div class="conflict-actions" id="pushEntryActions-${e.key}">
          ${showToggle ? `<button class="tbtn" id="pushEntryToggle-${e.key}">View Changes</button>` : ""}
          ${showToggle ? `<button class="tbtn" id="pushEntrySkip-${e.key}">${e.skipped ? "Include in Push" : "Ignore"}</button>` : ""}
          ${showRevert ? `<button class="tbtn" id="pushEntryRevert-${e.key}">Revert</button>` : ""}
        </div>
      </div>
      ${showRevert ? `
      <div class="settings-status error" id="pushEntryRevertConfirm-${e.key}" style="display:none;margin-top:6px">
        Discard this local change and use GitHub's current version instead?
        ${e.changeType === "create" ? " This scene was never pushed — discarding it can't be undone." : ""}
        <div class="settings-actions-row" style="margin-top:6px">
          <button class="modal-btn done" id="pushEntryRevertYes-${e.key}">Yes, Revert</button>
          <button class="tbtn" id="pushEntryRevertCancel-${e.key}">Cancel</button>
        </div>
      </div>` : ""}
      ${showToggle ? `<div class="conflict-diff" id="pushEntryDiff-${e.key}" style="display:none"></div>` : ""}
    </div>`;
    })
    .join("");

  panel.innerHTML = rowsHtml;

  entries.forEach((e) => {
    const toggleBtn = document.getElementById(`pushEntryToggle-${e.key}`);
    if (toggleBtn) {
      toggleBtn.onclick = () => {
        const diffEl = document.getElementById(`pushEntryDiff-${e.key}`);
        const isHidden = diffEl.style.display === "none";
        diffEl.style.display = isHidden ? "block" : "none";
        toggleBtn.textContent = isHidden ? "Hide Changes" : "View Changes";
        if (isHidden && !diffEl.dataset.loaded) {
          diffEl.dataset.loaded = "1";
          loadPushEntryDiffInto(diffEl, e);
        }
      };
    }
    const skipBtn = document.getElementById(`pushEntrySkip-${e.key}`);
    if (skipBtn) {
      skipBtn.onclick = async () => {
        skipBtn.disabled = true;
        await setOutboxEntrySkipped(e.key, !e.skipped);
        await Promise.all([loadPushPreviewInto(panel, notifyBookDataChanged), refreshPushHeader()]);
      };
    }
    const revertBtn = document.getElementById(`pushEntryRevert-${e.key}`);
    const revertConfirm = document.getElementById(`pushEntryRevertConfirm-${e.key}`);
    const revertActions = document.getElementById(`pushEntryActions-${e.key}`);
    if (revertBtn) {
      revertBtn.onclick = () => {
        revertConfirm.style.display = "block";
        revertActions.style.display = "none";
      };
    }
    const revertCancelBtn = document.getElementById(`pushEntryRevertCancel-${e.key}`);
    if (revertCancelBtn) {
      revertCancelBtn.onclick = () => {
        revertConfirm.style.display = "none";
        revertActions.style.display = "";
      };
    }
    const revertYesBtn = document.getElementById(`pushEntryRevertYes-${e.key}`);
    if (revertYesBtn) {
      revertYesBtn.onclick = async () => {
        revertYesBtn.disabled = true;
        revertYesBtn.textContent = "Reverting…";
        // Same withSyncLock-wrapped "write + refresh in-memory data" pattern as conflict
        // resolution above — without it, a background auto-sync tick landing in the gap could
        // flush stale in-memory `data` over what revertOutboxEntry just wrote.
        await withSyncLock(async () => {
          await revertOutboxEntry(e.key);
          if (notifyBookDataChanged) await notifyBookDataChanged(e.bookId);
        });
        await Promise.all([loadPushPreviewInto(panel, notifyBookDataChanged), refreshPushHeader()]);
      };
    }
  });
}

/** Field-level diff for an "update" row — reuses summarizeConflict via a fake conflict-shaped
 *  object ({kind, remoteContent}), plus the same "Show raw file diff" fallback conflict rows use.
 *  For create/delete/unchanged rows there's no meaningful field diff (nothing on one side, or the
 *  two sides are identical) — just show the raw byte diff directly. */
function loadPushEntryDiffInto(diffEl, entry) {
  const fakeConflict = { kind: entry.kind, remoteContent: entry.remoteRaw };
  if (entry.changeType !== "update") {
    loadDiffInto(diffEl, fakeConflict, entry.localRaw || "", "+ Your local version (would be pushed)");
    return;
  }

  let fields;
  try {
    fields = summarizeConflict(fakeConflict, entry.localRaw);
  } catch {
    fields = null;
  }

  const rawToggleHtml = `
    <button class="tbtn-inline" id="pushRawDiffToggle-${entry.key}">Show raw file diff</button>
    <div class="conflict-diff" id="pushRawDiff-${entry.key}" style="display:none"></div>
  `;

  if (!fields || fields.length === 0) {
    diffEl.innerHTML = `<div class="conflict-nochange">No field-level differences detected.</div>${rawToggleHtml}`;
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
    diffEl.innerHTML = `
      <div class="worddiff-legend">
        <span class="worddiff-legend-item"><span class="worddiff-remove">struck</span> = GitHub's current version</span>
        <span class="worddiff-legend-item"><span class="worddiff-add">underlined</span> = your local version (would be pushed)</span>
      </div>
      ${fieldsHtml}
      ${rawToggleHtml}
    `;
  }

  const rawToggle = document.getElementById(`pushRawDiffToggle-${entry.key}`);
  rawToggle.onclick = () => {
    const rawEl = document.getElementById(`pushRawDiff-${entry.key}`);
    const isHidden = rawEl.style.display === "none";
    rawEl.style.display = isHidden ? "block" : "none";
    rawToggle.textContent = isHidden ? "Hide raw file diff" : "Show raw file diff";
    if (isHidden && !rawEl.dataset.loaded) {
      rawEl.dataset.loaded = "1";
      loadDiffInto(rawEl, fakeConflict, entry.localRaw || "", "+ Your local version (would be pushed)");
    }
  };
}

/** Lazily loads and renders what pulling right now would bring in for one book — same field-diff
 *  rendering (summarizeManifest/summarizeBible/summarizeScene) loadRestorePreviewInto uses for
 *  history, plus a warning on any target a pending local edit would turn into a conflict instead
 *  of a clean fast-forward. The "Pull Now" button lives outside this panel (see
 *  renderPullSection), same reasoning as the push preview above. */
async function loadPullPreviewInto(panel, bookId, justPushed = new Set()) {
  panel.innerHTML = `<div class="diff-loading">Loading&hellip;</div>`;
  let preview;
  try {
    preview = await previewPull(bookId, justPushed);
  } catch (err) {
    panel.innerHTML = `<div class="diff-empty">Couldn't load remote changes: ${escapeHtml(err.message)}</div>`;
    return;
  }
  if (preview.error) {
    panel.innerHTML = `<div class="diff-empty">Couldn't load remote changes: ${escapeHtml(preview.error)}</div>`;
    return;
  }

  const fieldHtml = (f) => `
    <div class="conflict-field">
      <div class="conflict-field-label">${escapeHtml(f.label)}</div>
      <div class="conflict-field-body${f.prose ? " conflict-field-body-prose" : ""}">${f.html}</div>
    </div>`;
  const dirtyNote = (label) =>
    `<div class="settings-status error" style="margin:0 0 6px">You have unpushed changes to ${label} — pulling would flag this as a conflict instead of applying automatically.</div>`;

  let manifestBlockHtml = "";
  if (preview.manifestChanged) {
    let fields = [];
    try {
      fields = summarizeManifest(preview.manifestRemoteRaw, preview.manifestCurrentRaw);
    } catch {
      fields = [];
    }
    manifestBlockHtml = (preview.manifestDirty ? dirtyNote("the manuscript structure") : "") + fields.map(fieldHtml).join("");
  }

  let bibleBlockHtml = "";
  if (preview.bibleChanged) {
    let fields = [];
    try {
      fields = summarizeBible(preview.bibleRemoteRaw, preview.bibleCurrentRaw);
    } catch {
      fields = [];
    }
    bibleBlockHtml = (preview.bibleDirty ? dirtyNote("the story bible") : "") + fields.map(fieldHtml).join("");
  }

  const addedScenes = preview.addedScenes || [];
  const removedScenes = preview.removedScenes || [];

  if (!manifestBlockHtml && !bibleBlockHtml && addedScenes.length === 0 && removedScenes.length === 0 && preview.changedScenes.length === 0) {
    panel.innerHTML = `<div class="conflict-nochange">No differences — pulling wouldn't change anything.</div>`;
    return;
  }

  const addedRowsHtml = addedScenes
    .map(
      (sc) => `
    <div class="conflict-row">
      <div class="conflict-row-head">
        <div>
          ${escapeHtml(sc.title)}
          <div class="settings-status" style="margin:2px 0 0">New on GitHub — not in your local copy yet, would be added</div>
        </div>
        <div class="conflict-actions"><button class="tbtn" id="pullPreviewAddedToggle-${sc.id}">View Content</button></div>
      </div>
      <div class="conflict-diff" id="pullPreviewAddedDiff-${sc.id}" style="display:none"></div>
    </div>`
    )
    .join("");

  const removedRowsHtml = removedScenes
    .map(
      (sc) => `
    <div class="conflict-row">
      <div class="conflict-row-head">
        <div>
          ${escapeHtml(sc.title)}
          <div class="settings-status" style="margin:2px 0 0">No longer in any chapter on GitHub — would disappear from your manuscript view (content stays safely stored)</div>
        </div>
      </div>
    </div>`
    )
    .join("");

  const sceneRowsHtml = preview.changedScenes
    .map((sc) => {
      let sceneFields = [];
      try {
        sceneFields = summarizeScene(sc.remoteRaw, sc.currentRaw);
      } catch {
        sceneFields = [];
      }
      const status = sc.dirty
        ? "You have unpushed changes here — pulling would create a conflict instead of applying automatically."
        : "Edited";
      const statusClass = sc.dirty ? "error" : "";
      const sceneFieldsHtml = sceneFields.map(fieldHtml).join("");
      return `
    <div class="conflict-row">
      <div class="conflict-row-head">
        <div>
          ${escapeHtml(sc.title)}
          <div class="settings-status ${statusClass}" style="margin:2px 0 0">${status}</div>
        </div>
        ${sceneFieldsHtml ? `<div class="conflict-actions"><button class="tbtn" id="pullPreviewSceneToggle-${sc.id}">View Changes</button></div>` : ""}
      </div>
      ${sceneFieldsHtml ? `<div class="conflict-diff" id="pullPreviewSceneDiff-${sc.id}" style="display:none">${sceneFieldsHtml}</div>` : ""}
    </div>`;
    })
    .join("");

  panel.innerHTML = `
    <div class="worddiff-legend">
      <span class="worddiff-legend-item"><span class="worddiff-remove">struck</span> = only on GitHub (would be pulled in)</span>
      <span class="worddiff-legend-item"><span class="worddiff-add">underlined</span> = only in your current version (replaced, unless flagged as a conflict below)</span>
    </div>
    ${manifestBlockHtml}
    ${bibleBlockHtml}
    ${addedScenes.length ? `<div class="conflict-field-label" style="margin-top:14px">Scenes added (${addedScenes.length})</div>${addedRowsHtml}` : ""}
    ${preview.changedScenes.length ? `<div class="conflict-field-label" style="margin-top:14px">Scenes edited (${preview.changedScenes.length})</div>${sceneRowsHtml}` : ""}
    ${removedScenes.length ? `<div class="conflict-field-label" style="margin-top:14px">Scenes removed (${removedScenes.length})</div>${removedRowsHtml}` : ""}
  `;

  addedScenes.forEach((sc) => {
    const toggleBtn = document.getElementById(`pullPreviewAddedToggle-${sc.id}`);
    if (!toggleBtn) return;
    toggleBtn.onclick = () => {
      const diffEl = document.getElementById(`pullPreviewAddedDiff-${sc.id}`);
      const isHidden = diffEl.style.display === "none";
      diffEl.style.display = isHidden ? "block" : "none";
      toggleBtn.textContent = isHidden ? "Hide Content" : "View Content";
      if (isHidden && !diffEl.dataset.loaded) {
        diffEl.dataset.loaded = "1";
        loadDiffInto(diffEl, { remoteContent: "" }, sc.remoteRaw || "", "+ New scene from GitHub");
      }
    };
  });

  preview.changedScenes.forEach((sc) => {
    const toggleBtn = document.getElementById(`pullPreviewSceneToggle-${sc.id}`);
    if (!toggleBtn) return;
    toggleBtn.onclick = () => {
      const sceneDiffEl = document.getElementById(`pullPreviewSceneDiff-${sc.id}`);
      const isHidden = sceneDiffEl.style.display === "none";
      sceneDiffEl.style.display = isHidden ? "block" : "none";
      toggleBtn.textContent = isHidden ? "Hide Changes" : "View Changes";
    };
  });
}

/* ---------------------------------------------------------------- */
/* History browsing & restore-to-a-point-in-time                     */
/* ---------------------------------------------------------------- */

const HISTORY_PAGE_SIZE = 25;

function commitFirstLine(message) {
  return (message || "").split("\n")[0];
}

/** Fetches one more page of commits, appends it to whatever's already loaded, and (re)renders the
 *  whole list — commit rows reuse the same .conflict-row shape as the conflicts section, each
 *  with its own lazy-loaded restore preview (loadRestorePreviewInto). */
async function renderHistoryList(panel, bookId, container, callbacks, loadedCommits, page = 1) {
  panel.innerHTML = `<div class="diff-loading">Loading&hellip;</div>`;
  let newCommits;
  try {
    newCommits = await listBookHistory(bookId, { page, perPage: HISTORY_PAGE_SIZE });
  } catch (err) {
    panel.innerHTML = `<div class="diff-empty">Couldn't load history: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const commits = [...loadedCommits, ...newCommits];
  if (commits.length === 0) {
    panel.innerHTML = `<div class="diff-empty">No history yet — sync at least once first.</div>`;
    return;
  }

  const rowsHtml = commits
    .map(
      (c) => `
    <div class="conflict-row">
      <div class="conflict-row-head">
        <div>
          ${escapeHtml(commitFirstLine(c.message))}
          <div class="settings-status" style="margin:2px 0 0">${formatRelativeTime(c.date)}</div>
        </div>
        <div class="conflict-actions">
          <button class="tbtn" id="historyPreview-${c.sha}">Preview</button>
        </div>
      </div>
      <div class="conflict-diff" id="historyDiff-${c.sha}" style="display:none"></div>
    </div>`
    )
    .join("");
  const hasMore = newCommits.length === HISTORY_PAGE_SIZE;
  panel.innerHTML = `
    ${rowsHtml}
    ${hasMore ? `<button class="tbtn" id="historyLoadMore" style="margin-top:8px">Load more</button>` : ""}
  `;

  commits.forEach((c) => {
    const previewBtn = document.getElementById(`historyPreview-${c.sha}`);
    previewBtn.onclick = async () => {
      const diffEl = document.getElementById(`historyDiff-${c.sha}`);
      const isHidden = diffEl.style.display === "none";
      diffEl.style.display = isHidden ? "block" : "none";
      previewBtn.textContent = isHidden ? "Hide Preview" : "Preview";
      if (isHidden && !diffEl.dataset.loaded) {
        diffEl.dataset.loaded = "1";
        await loadRestorePreviewInto(diffEl, bookId, c.sha, container, callbacks);
      }
    };
  });

  const loadMoreBtn = document.getElementById("historyLoadMore");
  if (loadMoreBtn) {
    loadMoreBtn.onclick = () => renderHistoryList(panel, bookId, container, callbacks, commits, page + 1);
  }
}

/** Lazily loads and renders the "current vs. this historical commit" diff for one commit row,
 *  reusing the exact same summarizeManifest/summarizeBible/summarizeScene field-diff rendering
 *  the conflicts section uses — the only new thing here is the legend wording (historical vs.
 *  current isn't "theirs vs. mine") and the restore confirm/action at the bottom. */
async function loadRestorePreviewInto(diffEl, bookId, commitSha, container, callbacks) {
  diffEl.innerHTML = `<div class="diff-loading">Loading&hellip;</div>`;
  let preview;
  try {
    preview = await previewRestore(bookId, commitSha);
  } catch (err) {
    diffEl.innerHTML = `<div class="diff-empty">${escapeHtml(err.message)}</div>`;
    return;
  }

  const fields = [];
  if (preview.manifestChanged) fields.push(...summarizeManifest(preview.manifestHistoricalRaw, preview.manifestCurrentRaw));
  if (preview.bibleChanged) fields.push(...summarizeBible(preview.bibleHistoricalRaw, preview.bibleCurrentRaw));

  if (fields.length === 0 && preview.changedScenes.length === 0) {
    diffEl.innerHTML = `<div class="conflict-nochange">No differences — this matches your current state.</div>`;
    return;
  }

  const fieldHtml = (f) => `
    <div class="conflict-field">
      <div class="conflict-field-label">${escapeHtml(f.label)}</div>
      <div class="conflict-field-body${f.prose ? " conflict-field-body-prose" : ""}">${f.html}</div>
    </div>`;

  const sceneRowsHtml = preview.changedScenes
    .map((sc) => {
      const hasFieldDiff = sc.currentRaw && sc.historicalRaw;
      let sceneFields = [];
      if (hasFieldDiff) {
        try { sceneFields = summarizeScene(sc.historicalRaw, sc.currentRaw); } catch { sceneFields = []; }
      }
      const status = !sc.currentRaw ? "Would be restored (currently missing)"
        : !sc.historicalRaw ? "Would be removed (added since this point)"
        : null;
      const sceneFieldsHtml = sceneFields.map(fieldHtml).join("");
      return `
    <div class="conflict-row">
      <div class="conflict-row-head">
        <div>
          ${escapeHtml(sc.title)}
          ${status ? `<div class="settings-status" style="margin:2px 0 0">${status}</div>` : ""}
        </div>
        ${sceneFieldsHtml ? `<div class="conflict-actions"><button class="tbtn" id="historySceneToggle-${sc.id}">View Changes</button></div>` : ""}
      </div>
      ${sceneFieldsHtml ? `<div class="conflict-diff" id="historySceneDiff-${sc.id}" style="display:none">${sceneFieldsHtml}</div>` : ""}
    </div>`;
    })
    .join("");

  diffEl.innerHTML = `
    <div class="worddiff-legend">
      <span class="worddiff-legend-item"><span class="worddiff-remove">struck</span> = only in this historical version (would come back)</span>
      <span class="worddiff-legend-item"><span class="worddiff-add">underlined</span> = only in your current version (would be replaced)</span>
    </div>
    ${fields.map(fieldHtml).join("")}
    ${preview.changedScenes.length ? `<div class="conflict-field-label" style="margin-top:14px">Scenes (${preview.changedScenes.length})</div>${sceneRowsHtml}` : ""}
    <div class="settings-actions-row" style="margin-top:14px">
      <button class="tbtn" id="historyRestoreToggle-${commitSha}">Restore This Version&hellip;</button>
    </div>
    <div id="historyRestoreConfirm-${commitSha}" class="settings-status" style="display:none;margin-top:8px">
      This replaces the current chapters, scenes, and story bible with the version shown above.
      Your current state isn't lost — it stays in history — but this overwrites what you see now
      and pushes a new commit.
      <div class="settings-actions-row" style="margin-top:8px">
        <button class="modal-btn done" id="historyRestoreDo-${commitSha}">Yes, Restore</button>
        <button class="tbtn" id="historyRestoreCancel-${commitSha}">Cancel</button>
      </div>
      <div id="historyRestoreError-${commitSha}" class="settings-status error"></div>
    </div>
  `;

  preview.changedScenes.forEach((sc) => {
    const toggleBtn = document.getElementById(`historySceneToggle-${sc.id}`);
    if (!toggleBtn) return;
    toggleBtn.onclick = () => {
      const sceneDiffEl = document.getElementById(`historySceneDiff-${sc.id}`);
      const isHidden = sceneDiffEl.style.display === "none";
      sceneDiffEl.style.display = isHidden ? "block" : "none";
      toggleBtn.textContent = isHidden ? "Hide Changes" : "View Changes";
    };
  });

  const restoreToggleBtn = document.getElementById(`historyRestoreToggle-${commitSha}`);
  const confirmRow = document.getElementById(`historyRestoreConfirm-${commitSha}`);
  restoreToggleBtn.onclick = () => {
    confirmRow.style.display = "block";
    restoreToggleBtn.style.display = "none";
  };
  document.getElementById(`historyRestoreCancel-${commitSha}`).onclick = () => {
    confirmRow.style.display = "none";
    restoreToggleBtn.style.display = "";
  };
  document.getElementById(`historyRestoreDo-${commitSha}`).onclick = async () => {
    const doBtn = document.getElementById(`historyRestoreDo-${commitSha}`);
    doBtn.disabled = true;
    doBtn.textContent = "Restoring…";
    try {
      // The restore write and the in-memory `data` refresh run inside withSyncLock together —
      // same reason as everywhere else in this file: a background auto-sync tick landing in the
      // gap between them would flush stale in-memory `data` over what restoreToCommit just wrote
      // (see withSyncLock's comment in sync-engine.js).
      await withSyncLock(async () => {
        await restoreToCommit(bookId, commitSha);
        if (callbacks.notifyBookDataChanged) await callbacks.notifyBookDataChanged(bookId);
      });
      // Separate, not-nested call — pushes the restored state forward as new commits.
      const pushResult = await pushChanges({
        force: true,
        onPulled: (bookIds) => Promise.all(bookIds.map((id) => callbacks.notifyBookDataChanged && callbacks.notifyBookDataChanged(id))),
      });
      // Jump back to the Sync tab so the outcome (syncStatus) actually has somewhere to render —
      // it lives there, not on History, and this is the same tab every other sync action reports to.
      state.settingsTab = "sync";
      await renderSettingsView(container, callbacks, { justPushed: pushResult.pushedTargets });
      const statusEl = document.getElementById("syncStatus");
      if (statusEl) {
        statusEl.textContent = `Restored. ${describePushResult(pushResult)}`;
        statusEl.classList.toggle("error", !!pushResult.paused);
      }
      if (callbacks.onSyncStatusChanged) callbacks.onSyncStatusChanged();
    } catch (err) {
      doBtn.disabled = false;
      doBtn.textContent = "Yes, Restore";
      const errEl = document.getElementById(`historyRestoreError-${commitSha}`);
      if (errEl) errEl.textContent = `Restore failed: ${err.message}`;
    }
  };
}

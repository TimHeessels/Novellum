"use strict";

import { initApp, render, refreshSyncStatusUI } from "./ui.js";
import { data, getSceneAndChapter } from "./model.js";
import { state } from "./state.js";
import { DEFAULT_BOOK_ID, listBooks, loadBook, setActiveBookId, persistNow, flushSaveNow, loadUiPrefs } from "./persistence.js";
import { ensureBookBootstrapped, syncNow, completeGithubAppLogin, withSyncLock } from "./sync-engine.js";
import { consumePendingOAuthResult } from "./github-oauth.js";

const AUTO_SYNC_INTERVAL_MS = 60000;
const EDITABLE_SELECTOR = '[contenteditable="true"]';
const RESTORABLE_VIEWS = ["scene", "chapter", "full", "overview", "settings"];

/** boot() failing (or any error before the UI mounts) previously left a blank/black page with
 *  nothing but the static <title> — no console access on most phones/tablets means that was
 *  effectively undiagnosable. Render the error on-screen instead so it's visible wherever it happens. */
function showFatalError(err) {
  console.error("Novellum: fatal boot error", err);
  const app = document.getElementById("app");
  if (!app) return;
  app.innerHTML = `
    <div style="height:100%;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif;">
      <div style="max-width:560px;color:#e8b4b4;">
        <div style="font-size:15px;font-weight:600;margin-bottom:8px;color:#f0d0d0;">Novellum failed to start</div>
        <div style="font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;opacity:.85;">${String(err?.stack || err?.message || err)}</div>
      </div>
    </div>`;
}

/** Finishes a "Connect GitHub" redirect if this page load is one — the token/installation/error
 *  worker.js left in the URL fragment after the user picked repos in GitHub's own install picker.
 *  Runs before anything else in boot() so the settings view (restored from uiPrefs, since that's
 *  where the user was when they clicked the button) already reflects the outcome by the time it
 *  first renders.
 *
 *  Auto-connects when the installation was granted exactly one repo (the expected case, since
 *  users are guided to select just their vault repo). If more than one was granted,
 *  state.pendingOAuthVaultPick holds the list for settings-ui.js to render as an explicit choice
 *  instead of guessing which one is "the" vault. */
async function consumeOAuthRedirectIfAny() {
  let result;
  try {
    result = consumePendingOAuthResult();
  } catch (err) {
    state.oauthLoginError = err.message;
    return;
  }
  if (!result) return;

  try {
    const outcome = await completeGithubAppLogin(result.token, result.installationId);
    if (outcome.needsPick) {
      state.pendingOAuthVaultPick = { repos: outcome.needsPick };
      state.view = "settings";
    }
  } catch (err) {
    state.oauthLoginError = `Signed in, but couldn't connect a repo: ${err.message}`;
  }
}

async function boot() {
  await consumeOAuthRedirectIfAny();
  const uiPrefs = loadUiPrefs();
  const existingBooks = await listBooks();
  let bookId;

  if (existingBooks.length === 0) {
    // First-ever run: seed IndexedDB from the built-in demo book (`data` in model.js as-is).
    bookId = DEFAULT_BOOK_ID;
    setActiveBookId(bookId);
    await persistNow();
  } else {
    // Reopen whichever book was last active, if it still exists — otherwise fall back to the
    // oldest one, same as before this preference existed.
    bookId = uiPrefs.activeBookId && existingBooks.some((b) => b.id === uiPrefs.activeBookId)
      ? uiPrefs.activeBookId
      : existingBooks[0].id;
    await loadBook(bookId);
    setActiveBookId(bookId);
  }

  await ensureBookBootstrapped(bookId);

  state.books = await listBooks();
  state.activeBookId = bookId;
  applyRestoredUiPrefs(uiPrefs);
  // Applied after uiPrefs, deliberately overriding a restored view: a just-completed OAuth
  // redirect needs the settings view open regardless of where the user was before leaving for
  // GitHub (normally the same "settings" spot uiPrefs already restored, but not guaranteed).
  if (state.pendingOAuthVaultPick || state.oauthLoginError) state.view = "settings";

  initApp();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushSaveNow();
  });
  window.addEventListener("pagehide", () => {
    flushSaveNow();
  });

  // Closing the tab only guarantees a local IndexedDB flush (above) — not a push to GitHub. If
  // there's anything still unpushed, warn before actually closing (the browser shows its own
  // generic "changes may not be saved" text; the message string here is ignored by modern
  // browsers but still required for the prompt to appear at all) and fire off a sync attempt in
  // the same tick. Kicking it off here rather than waiting for the visibilitychange handler in
  // startAutoSync() below gives it a head start: if the user gets the confirmation prompt, the
  // page stays alive for as long as that dialog is up, which is extra time for the push to
  // actually land before they decide. Not a guarantee — the browser can still tear the page down
  // without ever showing the prompt, or before an in-flight request finishes — just the best a
  // page-unload hook can do.
  window.addEventListener("beforeunload", (e) => {
    if (!state.syncConfigured || !state.hasPendingSync) return;
    runAutoSync();
    e.preventDefault();
    e.returnValue = "";
  });

  // Background, after the first paint: push+pull anything that changed since last time. This
  // doubles as the "is GitHub actually reachable" check on page load — `pushResult.pauseReason`
  // covers both "no token yet" and "token/repo present but the connection is failing". Also what
  // makes a fresh "Connect GitHub" feel instant — this fires right after boot, no separate
  // manual "Sync Now" click needed.
  //
  // The refresh runs inside syncNow's onPulled hook, still holding the sync lock, rather than
  // after this await returns — otherwise a background auto-sync tick could land in the gap and
  // flush the still-stale in-memory `data` over whatever this pull just wrote to IndexedDB.
  const { pushResult, pullResult } = await syncNow(bookId, {
    onPulled: () => (state.view === "settings" ? null : refreshActiveBookView(bookId)),
  });
  state.syncPauseReason = pushResult.paused ? pushResult.pauseReason : null;
  // If Settings happens to be the view showing (e.g. right after a fresh connect), refreshing
  // just the topbar badge below isn't enough — the panel's own "last synced"/pending/conflict
  // list only redraw when renderSettingsView actually re-runs, which a plain refreshSyncStatusUI()
  // doesn't trigger. render() re-renders whichever view is current, Settings included.
  if (state.view === "settings") {
    render();
  }
  refreshSyncStatusUI();

  startAutoSync();
}

/** Applies a saved "where you were" snapshot (src/persistence.js loadUiPrefs()) onto `state`
 *  after the book's own data has loaded — chapter/scene ids are only trustworthy once we can
 *  check them against the actual loaded content, since the book (or its content) may have
 *  changed since the snapshot was taken. Falls back to the book's first scene otherwise. */
function applyRestoredUiPrefs(prefs) {
  const { chapter: ch, scene: sc } = prefs.activeSceneId ? getSceneAndChapter(prefs.activeSceneId) : { chapter: null, scene: null };
  if (ch && sc && ch.id === prefs.activeChapterId) {
    state.activeChapterId = prefs.activeChapterId;
    state.activeSceneId = prefs.activeSceneId;
  } else {
    state.activeChapterId = data.chapters[0].id;
    state.activeSceneId = data.chapters[0].scenes[0].id;
  }

  if (RESTORABLE_VIEWS.includes(prefs.view)) state.view = prefs.view;
  if (typeof prefs.leftWidth === "number") state.leftWidth = prefs.leftWidth;
  if (typeof prefs.rightWidth === "number") state.rightWidth = prefs.rightWidth;
  if (typeof prefs.leftOpen === "boolean") state.leftOpen = prefs.leftOpen;
  if (typeof prefs.rightOpen === "boolean") state.rightOpen = prefs.rightOpen;
  if (prefs.leftTab === "manuscript" || prefs.leftTab === "bible") state.leftTab = prefs.leftTab;
  if (["characters", "locations", "concepts"].includes(prefs.bibleTab)) state.bibleTab = prefs.bibleTab;

  // Only meaningful if we're actually restoring into overview — otherwise leave the fresh
  // state.js defaults alone rather than trusting a stale snapshot from a different session.
  if (state.view === "overview") {
    state.viewBeforeOverview = RESTORABLE_VIEWS.includes(prefs.viewBeforeOverview) ? prefs.viewBeforeOverview : null;
    state.leftOpenBeforeOverview = typeof prefs.leftOpenBeforeOverview === "boolean" ? prefs.leftOpenBeforeOverview : true;
    state.rightOpenBeforeOverview = typeof prefs.rightOpenBeforeOverview === "boolean" ? prefs.rightOpenBeforeOverview : true;
  }
}

/** Refreshes `data`/state from IndexedDB and re-renders — but only if `bookId` is still the
 *  one currently open (the user may have switched books while this was in flight). */
async function refreshActiveBookView(bookId) {
  if (state.activeBookId !== bookId) return;
  await loadBook(bookId);
  if (!getSceneAndChapter(state.activeSceneId).scene) {
    state.activeChapterId = data.chapters[0]?.id;
    state.activeSceneId = data.chapters[0]?.scenes[0]?.id;
  }
  render();
}

function isActivelyEditing() {
  return !!document.activeElement?.matches?.(EDITABLE_SELECTOR);
}

let autoSyncInFlight = false;
let pendingViewRefresh = false;

/** Pushes local changes and pulls remote ones, on an interval and when the tab is hidden.
 *  Pushing never touches the DOM. Applying a pull does — so if the user is actively typing when
 *  one lands, the IndexedDB write still happens (nothing is lost) but the visible re-render is
 *  deferred until they leave the field, rather than yanking focus/cursor out from under them. */
async function runAutoSync() {
  if (autoSyncInFlight || !state.activeBookId) return;
  autoSyncInFlight = true;
  try {
    // The refresh (or the decision to defer it) runs inside syncNow's onPulled hook, still
    // holding the sync lock — see boot()'s sync above for why. Deferring here only skips the
    // *re-render* to protect the user's cursor; the deferred continuation on focusout below
    // re-acquires the lock itself when it actually runs.
    const { pushResult, pullResult } = await syncNow(state.activeBookId, {
      onPulled: async () => {
        if (state.view === "settings") return;
        if (isActivelyEditing()) {
          pendingViewRefresh = true;
        } else {
          await refreshActiveBookView(state.activeBookId);
        }
      },
    });
    state.syncPauseReason = pushResult.paused ? pushResult.pauseReason : null;
    // Settings has no cursor/focus to protect, so it's always safe to just re-render it directly
    // rather than going through the "is the user actively editing" deferral above (see main
    // boot()'s sync for why refreshSyncStatusUI() alone doesn't update the panel's own contents).
    if (state.view === "settings") {
      render();
    }
    refreshSyncStatusUI();
  } catch (err) {
    console.error("Novellum: background sync failed", err);
  } finally {
    autoSyncInFlight = false;
  }
}

function startAutoSync() {
  setInterval(runAutoSync, AUTO_SYNC_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) runAutoSync();
  });
  document.addEventListener("focusout", () => {
    if (!pendingViewRefresh) return;
    setTimeout(() => {
      if (pendingViewRefresh && !isActivelyEditing()) {
        pendingViewRefresh = false;
        // Re-acquires the lock for this deferred continuation too, so it can't run at the same
        // moment as another queued sync operation and race it the same way (see boot()'s sync).
        withSyncLock(() => refreshActiveBookView(state.activeBookId));
      }
    }, 0);
  });
}

boot().catch(showFatalError);

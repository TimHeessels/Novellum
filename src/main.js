"use strict";

import { initApp, refreshSyncStatusUI } from "./ui.js";
import { data, getSceneAndChapter } from "./model.js";
import { state } from "./state.js";
import { DEFAULT_BOOK_ID, listBooks, loadBook, setActiveBookId, persistNow, flushSaveNow, loadUiPrefs } from "./persistence.js";
import { ensureBookBootstrapped, checkRemoteChanges, completeGithubAppLogin } from "./sync-engine.js";
import { consumePendingOAuthResult } from "./github-oauth.js";

const REMOTE_CHECK_INTERVAL_MS = 5 * 60000;
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

  // Closing the tab only guarantees a local IndexedDB flush (above) — nothing pushes to GitHub
  // automatically anymore, so warn if there's anything still unpushed (the browser shows its own
  // generic "changes may not be saved" text; the message string here is ignored by modern browsers
  // but still required for the prompt to appear at all). Purely a warning — it's on the user to
  // hit Push first, same as leaving a regular git working copy with uncommitted changes.
  window.addEventListener("beforeunload", (e) => {
    if (!state.syncConfigured || !state.hasPendingSync) return;
    e.preventDefault();
    e.returnValue = "";
  });

  // Nothing pushes or pulls automatically — the topbar Push button and the "Pull latest" banner
  // are the only things that ever touch GitHub's write/read-and-apply APIs. This just primes their
  // initial state from whatever's already known locally (pending count, last push/pull time).
  refreshSyncStatusUI();

  startRemoteChangeChecks(bookId);
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
  if (typeof prefs.overviewHighlightTodos === "boolean") state.overviewHighlightTodos = prefs.overviewHighlightTodos;
  if (typeof prefs.overviewShowWordCounts === "boolean") state.overviewShowWordCounts = prefs.overviewShowWordCounts;
  if (typeof prefs.overviewChaptersOnly === "boolean") state.overviewChaptersOnly = prefs.overviewChaptersOnly;

  // Only meaningful if we're actually restoring into overview — otherwise leave the fresh
  // state.js defaults alone rather than trusting a stale snapshot from a different session.
  if (state.view === "overview") {
    state.viewBeforeOverview = RESTORABLE_VIEWS.includes(prefs.viewBeforeOverview) ? prefs.viewBeforeOverview : null;
    state.leftOpenBeforeOverview = typeof prefs.leftOpenBeforeOverview === "boolean" ? prefs.leftOpenBeforeOverview : true;
    state.rightOpenBeforeOverview = typeof prefs.rightOpenBeforeOverview === "boolean" ? prefs.rightOpenBeforeOverview : true;
  }
}

let remoteCheckInFlight = false;

/** Read-only: checks whether GitHub has anything newer than this device already knows about,
 *  purely to decide whether the "Pull latest" banner should show itself — never applies anything.
 *  Actually pulling still requires clicking that banner's button. */
async function refreshRemoteChangeCheck(bookId) {
  if (remoteCheckInFlight || !bookId) return;
  remoteCheckInFlight = true;
  try {
    const { hasChanges, count } = await checkRemoteChanges(bookId);
    state.hasRemoteChanges = hasChanges;
    state.remoteChangeCount = count;
    refreshSyncStatusUI();
  } catch (err) {
    console.error("Novellum: remote-change check failed", err);
  } finally {
    remoteCheckInFlight = false;
  }
}

function startRemoteChangeChecks(bookId) {
  refreshRemoteChangeCheck(bookId);
  setInterval(() => refreshRemoteChangeCheck(state.activeBookId), REMOTE_CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshRemoteChangeCheck(state.activeBookId);
  });
}

boot().catch(showFatalError);

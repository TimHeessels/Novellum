"use strict";

import { initApp, render, refreshSyncStatusUI } from "./ui.js";
import { data, getSceneAndChapter } from "./model.js";
import { state } from "./state.js";
import { DEFAULT_BOOK_ID, listBooks, loadBook, setActiveBookId, persistNow, flushSaveNow, loadUiPrefs } from "./persistence.js";
import { ensureBookBootstrapped, syncNow } from "./sync-engine.js";

const AUTO_SYNC_INTERVAL_MS = 60000;
const EDITABLE_SELECTOR = '[contenteditable="true"]';
const RESTORABLE_VIEWS = ["scene", "chapter", "full", "overview", "settings"];

/** boot() failing (or any error before the UI mounts) previously left a blank/black page with
 *  nothing but the static <title> — no console access on most phones/tablets means that was
 *  effectively undiagnosable. Render the error on-screen instead so it's visible wherever it happens. */
function showFatalError(err) {
  console.error("WriterTool: fatal boot error", err);
  const app = document.getElementById("app");
  if (!app) return;
  app.innerHTML = `
    <div style="height:100%;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif;">
      <div style="max-width:560px;color:#e8b4b4;">
        <div style="font-size:15px;font-weight:600;margin-bottom:8px;color:#f0d0d0;">WriterTool failed to start</div>
        <div style="font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;opacity:.85;">${String(err?.stack || err?.message || err)}</div>
      </div>
    </div>`;
}

async function boot() {
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

  initApp();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushSaveNow();
  });
  window.addEventListener("pagehide", () => {
    flushSaveNow();
  });

  // Background, after the first paint: push+pull anything that changed since last time. This
  // doubles as the "is GitHub actually reachable" check on page load — `pushResult.pauseReason`
  // covers both "no token yet" and "token/repo present but the connection is failing".
  const { pushResult, pullResult } = await syncNow(bookId);
  state.syncPauseReason = pushResult.paused ? pushResult.pauseReason : null;
  if (pullResult.pulled > 0) await refreshActiveBookView(bookId);
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
    const { pushResult, pullResult } = await syncNow(state.activeBookId);
    state.syncPauseReason = pushResult.paused ? pushResult.pauseReason : null;
    if (pullResult.pulled > 0) {
      if (isActivelyEditing()) {
        pendingViewRefresh = true;
      } else {
        await refreshActiveBookView(state.activeBookId);
      }
    }
    refreshSyncStatusUI();
  } catch (err) {
    console.error("WriterTool: background sync failed", err);
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
        refreshActiveBookView(state.activeBookId);
      }
    }, 0);
  });
}

boot().catch(showFatalError);

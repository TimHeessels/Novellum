"use strict";

/* ------------------------------------------------------------------------------------------- */
/* Mobile layout ("Novellum Mobile" design) — the phone-width UI.                               */
/*                                                                                               */
/* Both this chrome and the desktop chrome in ui.js are ALWAYS mounted and ALWAYS re-rendered    */
/* together — a CSS media query (styles.css, max-width:760px) is the only thing that decides     */
/* which one is actually visible. ui.js's renderTopbar/renderLeftPanel/renderCenter/             */
/* renderRightPanel/renderModal each call back into renderMobileApp() below after they run, so   */
/* almost every mutation (add/delete scene, todos, bible entries, book switching, split scene,   */
/* GitHub sync…) is the exact same code path as desktop — this module mostly just draws a        */
/* different view of the same `state`/`data`, reusing ui.js's action functions directly rather   */
/* than reimplementing them.                                                                     */
/*                                                                                               */
/* The one deliberate exception is refreshMobileSyncStatus(), used by ui.js's 20s background sync-*/
/* status timer: it must NOT rebuild the manuscript tab's contenteditable block (that would wipe  */
/* an in-progress cursor while someone is mid-sentence on their phone), so it only touches the    */
/* sync badge, never the tab content. Tapping the sync badge itself just opens Settings directly  */
/* (openSettings(), reused from ui.js) rather than showing an intermediate mobile-only summary.   */
/*                                                                                                */
/* A handful of small pieces below (bible-entry draft sync, new-book title, the Settings screen)  */
/* can't just reuse their desktop counterparts as-is: those either read fixed desktop element ids */
/* (which would collide, since both trees exist in the DOM at once) or — for Settings — rely on   */
/* document.getElementById internally, so only one of the two mounted copies may actually call    */
/* renderSettingsView at a time (isMobileViewport() below decides which). */
/* ------------------------------------------------------------------------------------------- */

import {
  data, getSceneAndChapter, getChapter, sceneLabel, chapterNumber,
  bibleArrayFor, bibleLabel, escapeHtml, uid, bookWordCount, chapterWordCount, sceneWordCount,
  formatRelativeTime, truncateWords,
} from "./model.js";
import { state } from "./state.js";
import { scheduleSave, getActiveBookId, loadBook } from "./persistence.js";
import { exportManuscript, exportEpub } from "./export.js";
import { renderSettingsView } from "./settings-ui.js";
import {
  render, markDirty, persistUiPrefs, refreshSyncStatusUI,
  addScene, addChapter, openScene, openChapter,
  requestDeleteScene, closeDeleteSceneConfirm, deleteScene,
  toggleTodo, deleteTodo, addTodo,
  switchToBook, handleCreateBook, handleDeleteBook, handleSaveBookDetails,
  openSettings, openBibleModal,
  importManuscriptMarkdown, bindManuscriptBlocks,
  closeSplitConfirm, performSplit, closeNewBookModal,
  handleSelectionScroll,
} from "./ui.js";

// Keep in sync with styles.css's `@media (max-width: 760px)` breakpoint — the only spot that
// genuinely needs to know which chrome is visible in JS (see the Settings id-collision note
// above); everything else is decided purely by CSS.
const MOBILE_BREAKPOINT = "(max-width: 760px)";
export function isMobileViewport() {
  return window.matchMedia(MOBILE_BREAKPOINT).matches;
}

let rootEl = null;
let elTopbar, elContent, elTabbar, elSheets;

// Sheet-local, non-persisted UI state — reset naturally each time its sheet opens/closes, so it
// doesn't need to live in state.js.
let navBookListOpen = false;
let navBookSectionOpen = false;

export function mountMobileApp(root) {
  rootEl = root;
  rootEl.innerHTML = `
    <div class="m-topbar" id="mTopbar"></div>
    <div class="m-content" id="mContent"></div>
    <div class="m-tabbar" id="mTabbar"></div>
    <div class="m-sheets" id="mSheets"></div>
  `;
  elTopbar = document.getElementById("mTopbar");
  elContent = document.getElementById("mContent");
  elTabbar = document.getElementById("mTabbar");
  elSheets = document.getElementById("mSheets");

  // handleSelectionScroll (ui.js) repositions the bold/italic/underline/strike floating toolbar
  // as its host panel scrolls — desktop wires it to centerPanelEl's own scroll event. #mContent
  // itself never scrolls (each tab's own child does — see styles.css), and the "scroll" event
  // doesn't bubble, so this listens in the capture phase to catch it from whichever descendant is
  // actually scrolling, regardless of which tab is active.
  elContent.addEventListener("scroll", handleSelectionScroll, true);

  window.matchMedia(MOBILE_BREAKPOINT).addEventListener("change", () => render());
}

// A single ui.js action (e.g. render()) fans out to this function once per desktop render
// wrapper — up to 5 times in a row, synchronously. That's harmless for the plain-HTML tabs, but
// the Settings screen render is async (renderSettingsView awaits GitHub/IndexedDB reads before
// wiring up #settingsBack etc. via document.getElementById) — five overlapping calls race, and an
// earlier call's container gets detached by a later one before its promise resolves, so its
// document.getElementById lookups return null. Coalescing every synchronous burst into a single
// microtask-deferred render fixes that race and the redundant work in one move; nothing here
// needs the DOM update to land synchronously (render() has nothing left to do afterward that
// depends on it).
let renderQueued = false;
export function renderMobileApp() {
  if (!rootEl) return;
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    renderTopbarInner();
    renderContentInner();
    renderTabbarInner();
    renderSheetsInner();
  });
}

/** Narrow refresh used by ui.js's 20s background sync-status timer — only the sync badge depends
 *  on sync status; never touches the tab content, so an in-progress edit in the manuscript tab is
 *  never disturbed by this ticking on its own. */
export function refreshMobileSyncStatus() {
  if (!rootEl) return;
  renderTopbarInner();
}

/* ---------------------------------------------------------------- */
/* Icons                                                             */
/* ---------------------------------------------------------------- */

const ICON_NAV = `<svg width="20" height="20" viewBox="0 0 20 20"><rect x="2" y="3" width="7" height="6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2" y="11" width="7" height="6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M11 6h7M11 14h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const ICON_FILTER = `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 2h10M3 6h6M5 10h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const ICON_TAB_MANUSCRIPT = `<svg width="19" height="19" viewBox="0 0 20 20"><path d="M3 3.5h6a2 2 0 012 2v11a2 2 0 00-2-1H3v-12z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M17 3.5h-6a2 2 0 00-2 2v11a2 2 0 012-1h6v-12z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
const ICON_TAB_BIBLE = `<svg width="19" height="19" viewBox="0 0 20 20"><rect x="3" y="2.5" width="14" height="15" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7 2.5v15M13 6h2M13 9h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const ICON_TAB_OVERVIEW = `<svg width="19" height="19" viewBox="0 0 20 20"><rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="11" y="2.5" width="6.5" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2.5" y="11" width="6.5" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="11" y="11" width="6.5" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;

/* ---------------------------------------------------------------- */
/* Helpers shared across tabs                                       */
/* ---------------------------------------------------------------- */

function flatScenes() {
  const flat = [];
  data.chapters.forEach((ch) => ch.scenes.forEach((sc) => flat.push({ chapterId: ch.id, sceneId: sc.id })));
  return flat;
}

function formatWordCount(n) {
  return n.toLocaleString();
}

function closeAllSheets() {
  state.mobileNavOpen = false;
  state.mobileOverviewFilterOpen = false;
}

/* ---------------------------------------------------------------- */
/* Top bar                                                           */
/* ---------------------------------------------------------------- */

function syncBadgeInfo() {
  const status = state.lastSyncStatus;
  if (!status) return { label: "…", dotColor: "var(--text-muted)", cls: "" };
  if (!status.configured) return { label: "Sync not set up", dotColor: "var(--text-muted)", cls: "" };
  if (status.conflictCount > 0) {
    return { label: `${status.conflictCount} conflict${status.conflictCount > 1 ? "s" : ""}`, dotColor: "var(--danger-text)", cls: "m-sync-conflict" };
  }
  if (state.syncPauseReason) return { label: "Sync error", dotColor: "var(--danger-text)", cls: "m-sync-conflict" };
  if (status.pendingCount > 0) return { label: `${status.pendingCount} to push`, dotColor: "var(--bg)", cls: "m-sync-pending" };
  if (state.remoteChangeCount > 0) return { label: `${state.remoteChangeCount} to pull`, dotColor: "var(--bg)", cls: "m-sync-pending" };
  const lastAt = [status.lastPushedAt, status.lastPulledAt].filter(Boolean).sort().pop();
  return { label: lastAt ? `Synced ${formatRelativeTime(lastAt)}` : "Not synced yet", dotColor: "var(--diff-add-text)", cls: "" };
}

function syncBadgeHtml() {
  const sync = syncBadgeInfo();
  return `
    <button class="m-sync-badge ${sync.cls}" id="mSyncBadgeBtn" title="Sync">
      <span class="m-sync-dot" style="background:${sync.dotColor}"></span>${escapeHtml(sync.label)}
    </button>`;
}

function wireSyncBadge() {
  const btn = document.getElementById("mSyncBadgeBtn");
  if (btn) btn.onclick = () => { closeAllSheets(); openSettings(); };
}

function renderTopbarInner() {
  if (!elTopbar) return;

  if (state.view === "settings") {
    elTopbar.innerHTML = `
      <button class="m-icon-btn" id="mSettingsBack" title="Back">&lsaquo;</button>
      <div class="m-topbar-title-single">Settings</div>
      <span class="m-topbar-spacer"></span>
    `;
    document.getElementById("mSettingsBack").onclick = () => { state.view = "scene"; render(); };
    return;
  }

  if (state.mobileTab === "bible") {
    elTopbar.innerHTML = `
      <div class="m-topbar-title-single">Story Bible</div>
      <span class="m-topbar-spacer"></span>
      ${syncBadgeHtml()}
    `;
    wireSyncBadge();
    return;
  }

  if (state.mobileTab === "overview") {
    const totalLine = overviewTotalsLine();
    elTopbar.innerHTML = `
      <div class="m-topbar-title-block">
        <div class="m-topbar-title-single">Overview</div>
        ${totalLine ? `<div class="m-topbar-subtitle">${totalLine}</div>` : ""}
      </div>
      <button class="m-filter-btn" id="mOverviewFilterBtn">${ICON_FILTER} Filter</button>
      ${syncBadgeHtml()}
    `;
    document.getElementById("mOverviewFilterBtn").onclick = () => {
      closeAllSheets();
      state.mobileOverviewFilterOpen = true;
      renderMobileApp();
    };
    wireSyncBadge();
    return;
  }

  // manuscript
  const { chapter: ch, scene: sc } = getSceneAndChapter(state.activeSceneId);
  elTopbar.innerHTML = `
    <button class="m-icon-btn" id="mNavOpenBtn" title="Book outline">${ICON_NAV}</button>
    <div class="m-topbar-title-block">
      <div class="m-topbar-chapter">${ch ? `${chapterNumber(ch)}. ${escapeHtml(ch.title)}` : "No chapter"}</div>
      <div class="m-topbar-scene">${sc ? escapeHtml(sc.title) : ""}</div>
    </div>
    ${syncBadgeHtml()}
  `;
  document.getElementById("mNavOpenBtn").onclick = () => {
    closeAllSheets();
    state.mobileNavOpen = true;
    renderMobileApp();
  };
  wireSyncBadge();
}

/* ---------------------------------------------------------------- */
/* Tab bar                                                           */
/* ---------------------------------------------------------------- */

function renderTabbarInner() {
  if (!elTabbar) return;
  if (state.view === "settings") {
    elTabbar.style.display = "none";
    return;
  }
  elTabbar.style.display = "";
  const tabs = [
    { key: "manuscript", label: "Manuscript", icon: ICON_TAB_MANUSCRIPT },
    { key: "bible", label: "Bible", icon: ICON_TAB_BIBLE },
    { key: "overview", label: "Overview", icon: ICON_TAB_OVERVIEW },
  ];
  elTabbar.innerHTML = tabs
    .map((t) => `
      <button class="m-tab ${state.mobileTab === t.key ? "active" : ""}" data-tab="${t.key}">
        <span class="m-tab-icon">${t.icon}</span>
        <span class="m-tab-label">${t.label}</span>
      </button>`)
    .join("");
  elTabbar.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.onclick = () => {
      state.mobileTab = btn.dataset.tab;
      closeAllSheets();
      persistUiPrefs();
      renderMobileApp();
    };
  });
}

/* ---------------------------------------------------------------- */
/* Content dispatcher                                                */
/* ---------------------------------------------------------------- */

function renderContentInner() {
  if (state.view === "settings") {
    // renderSettingsView reads/writes fixed element ids internally — only one of the two mounted
    // copies (desktop's centerPanel, this one) may actually call it at a time, or both would
    // collide on the same ids and event handlers would attach to whichever is first in the DOM
    // (always the hidden desktop one). See ui.js's renderCenterDesktop for the mirrored guard.
    if (!isMobileViewport()) { elContent.innerHTML = ""; return; }
    renderSettingsScreen(elContent);
    return;
  }
  if (state.mobileTab === "bible") { renderBibleTab(elContent); return; }
  if (state.mobileTab === "overview") { renderOverviewTab(elContent); return; }
  renderManuscriptTab(elContent);
}

function renderSettingsScreen(container) {
  container.innerHTML = `<div class="m-settings-wrap" id="mSettingsWrap"></div>`;
  renderSettingsView(document.getElementById("mSettingsWrap"), {
    onBack: () => { state.view = "scene"; render(); },
    notifyBookDataChanged: async (bookId) => {
      if (bookId !== state.activeBookId) return;
      await loadBook(bookId);
      render();
    },
    onSyncStatusChanged: refreshSyncStatusUI,
  });
}

/* ---------------------------------------------------------------- */
/* Manuscript tab                                                    */
/* ---------------------------------------------------------------- */

function overviewTotalsLine() {
  const parts = [];
  if (state.overviewShowWordCounts) parts.push(`${formatWordCount(bookWordCount())} words`);
  if (state.overviewHighlightTodos) {
    const todos = data.chapters.reduce((a, ch) => a + ch.scenes.reduce((b, sc) => b + sc.todos.filter((t) => !t.done).length, 0), 0);
    parts.push(`${todos} open to-do${todos === 1 ? "" : "s"}`);
  }
  return parts.join(" &middot; ");
}

function renderManuscriptTab(container) {
  const { chapter: ch, scene: sc } = getSceneAndChapter(state.activeSceneId);
  if (!sc) {
    container.innerHTML = `<div class="m-manuscript-scroll"><div class="no-scene" style="padding:18px">No scene selected.</div></div>`;
    return;
  }

  const flat = flatScenes();
  const curIdx = flat.findIndex((f) => f.sceneId === sc.id);
  const noPrev = curIdx <= 0;
  const noNext = curIdx === -1 || curIdx >= flat.length - 1;

  const todosHtml = sc.todos
    .map((t) => `
      <div class="todo-row ${t.done ? "done" : ""}">
        <span class="chk ${t.done ? "checked" : ""}" data-action="toggle" data-todo-id="${t.id}">${t.done ? "&#10003;" : ""}</span>
        <input class="m-todo-text" data-todo-id="${t.id}" value="${escapeHtml(t.text)}" placeholder="To-do…">
        <button class="todo-del" data-action="remove" data-todo-id="${t.id}">&times;</button>
      </div>`)
    .join("");

  container.innerHTML = `
    <div class="m-manuscript-scroll" id="mManuscriptScroll">
      ${manuscriptBlockHtml(sc)}
    </div>
    <div class="m-drawer">
      <button class="m-drawer-toggle" id="mDrawerToggle">
        <span>Summary &amp; To-do</span>
        <span class="m-drawer-chevron" style="transform:${state.mobileNotesCollapsed ? "rotate(180deg)" : "rotate(0deg)"}">&#9660;</span>
      </button>
      ${state.mobileNotesCollapsed ? "" : `
        <div class="m-drawer-body">
          <div class="m-drawer-field">
            <div class="section-label">Title</div>
            <input class="m-drawer-input" id="mSceneTitle" value="${escapeHtml(sc.title)}">
          </div>
          <div class="m-drawer-field">
            <div class="section-label">Summary</div>
            <textarea class="m-drawer-textarea" id="mSceneSummary" rows="3">${escapeHtml(sc.summary || "")}</textarea>
          </div>
          <div class="m-drawer-field">
            <div class="section-label">To-Do (${sc.todos.length})</div>
            <div class="m-drawer-todos">${todosHtml}</div>
            <button class="dashed-btn wide" id="mAddTodoBtn" style="margin-top:8px"><span>+</span><span>Add To-Do</span></button>
          </div>
          <button class="delete-scene-btn" id="mDeleteSceneBtn">Delete Scene</button>
        </div>
      `}
      <div class="m-drawer-actions">
        <button class="m-btn" id="mPrevScene" ${noPrev ? "disabled" : ""}>Previous Scene</button>
        <button class="m-btn" id="mNextScene" ${noNext ? "disabled" : ""}>Next Scene</button>
      </div>
    </div>
  `;

  // Re-bind the real manuscript editor (autosave/paste/formatting all shared with desktop).
  bindManuscriptBlocks(container.querySelector(".m-manuscript-scroll"));

  document.getElementById("mDrawerToggle").onclick = () => {
    state.mobileNotesCollapsed = !state.mobileNotesCollapsed;
    persistUiPrefs();
    renderManuscriptTab(elContent);
  };

  const titleEl = document.getElementById("mSceneTitle");
  if (titleEl) {
    titleEl.addEventListener("input", () => {
      sc.title = titleEl.value;
      scheduleSave();
      markDirty("scene", sc.id);
      const chapterLine = elTopbar.querySelector(".m-topbar-scene");
      if (chapterLine) chapterLine.textContent = sc.title;
    });
  }
  const summaryEl = document.getElementById("mSceneSummary");
  if (summaryEl) {
    summaryEl.addEventListener("input", () => {
      sc.summary = summaryEl.value;
      scheduleSave();
      markDirty("scene", sc.id);
    });
  }
  container.querySelectorAll(".m-todo-text").forEach((el) => {
    el.addEventListener("input", () => {
      const t = sc.todos.find((x) => x.id === el.dataset.todoId);
      if (!t) return;
      t.text = el.value;
      scheduleSave();
      markDirty("scene", sc.id);
    });
  });
  container.querySelectorAll('[data-action="toggle"]').forEach((el) => {
    el.onclick = () => toggleTodo(sc.id, el.dataset.todoId);
  });
  container.querySelectorAll('[data-action="remove"]').forEach((el) => {
    el.onclick = () => deleteTodo(sc.id, el.dataset.todoId);
  });
  const addTodoBtn = document.getElementById("mAddTodoBtn");
  if (addTodoBtn) {
    addTodoBtn.onclick = () => {
      addTodo(sc.id);
      requestAnimationFrame(() => {
        const inputs = document.querySelectorAll(".m-todo-text");
        const last = inputs[inputs.length - 1];
        if (last) last.focus();
      });
    };
  }

  const deleteSceneBtn = document.getElementById("mDeleteSceneBtn");
  if (deleteSceneBtn) deleteSceneBtn.onclick = () => requestDeleteScene(sc.id);

  document.getElementById("mPrevScene").onclick = () => {
    if (curIdx > 0) openScene(flat[curIdx - 1].chapterId, flat[curIdx - 1].sceneId);
  };
  document.getElementById("mNextScene").onclick = () => {
    if (curIdx >= 0 && curIdx < flat.length - 1) openScene(flat[curIdx + 1].chapterId, flat[curIdx + 1].sceneId);
  };
}

function manuscriptBlockHtml(sc) {
  return `<div class="manuscript-text" contenteditable="true" spellcheck="true" data-scene-id="${sc.id}" data-placeholder="Start writing here..."></div>`;
}

/* ---------------------------------------------------------------- */
/* Bible tab                                                         */
/* ---------------------------------------------------------------- */

const BIBLE_TABS = ["characters", "locations", "concepts"];
const BIBLE_TAB_LABEL = { characters: "Characters", locations: "Locations", concepts: "Concepts" };
const BIBLE_KIND = { characters: "character", locations: "location", concepts: "concept" };

function renderBibleTab(container) {
  const chipsHtml = BIBLE_TABS
    .map((t) => `<button class="m-bible-chip ${state.bibleTab === t ? "active" : ""}" data-bible-tab="${t}">${BIBLE_TAB_LABEL[t]}</button>`)
    .join("");

  const kind = BIBLE_KIND[state.bibleTab];
  const arr = bibleArrayFor(kind);
  const cardsHtml = arr
    .map((item) => {
      const entriesHtml = (item.entries || [])
        .filter((e) => e.title || e.text)
        .map(
          (e) => `
        <div class="m-bible-card-entry">
          ${e.title ? `<div class="m-bible-card-desc">${escapeHtml(e.title)}</div>` : ""}
          ${e.text ? `<div class="m-bible-card-snippet">${escapeHtml(truncateWords(e.text, 20))}</div>` : ""}
        </div>`
        )
        .join("");
      return `
        <div class="m-bible-card" data-bible-id="${item.id}">
          <div class="m-bible-card-name">${escapeHtml(item.name)}</div>
          ${entriesHtml}
        </div>`;
    })
    .join("");

  container.innerHTML = `
    <div class="m-bible-scroll">
      <div class="m-bible-chips">${chipsHtml}</div>
      <div class="m-bible-list">
        ${cardsHtml}
        <button class="dashed-btn wide" id="mNewBibleEntry"><span>+</span><span>Add ${bibleLabel(kind)}</span></button>
      </div>
    </div>
  `;

  container.querySelectorAll("[data-bible-tab]").forEach((el) => {
    el.onclick = () => {
      state.bibleTab = el.dataset.bibleTab;
      persistUiPrefs();
      renderBibleTab(elContent);
    };
  });
  container.querySelectorAll("[data-bible-id]").forEach((el) => {
    el.onclick = () => openBibleModal(kind, el.dataset.bibleId);
  });
  document.getElementById("mNewBibleEntry").onclick = () => openBibleModal(kind, null);
}

/* ---- Bible full-screen editor (mobile-scoped: see file header for why) ---- */

function mSyncBibleDraftFromDom() {
  if (!state.bibleEdit) return;
  const nameEl = document.getElementById("mBibleEditName");
  if (nameEl) state.bibleEdit.name = nameEl.value;
  const rows = elSheets.querySelectorAll(".m-bible-entry-row");
  state.bibleEdit.entries = Array.from(rows).map((row) => ({
    id: row.dataset.entryId,
    title: row.querySelector(".m-bible-entry-title").value,
    text: row.querySelector(".m-bible-entry-text").value,
  }));
}

function mAddBibleEntry() {
  mSyncBibleDraftFromDom();
  state.bibleEdit.entries.push({ id: uid("entry"), title: "", text: "" });
  renderSheetsInner();
  requestAnimationFrame(() => {
    const titles = elSheets.querySelectorAll(".m-bible-entry-title");
    const last = titles[titles.length - 1];
    if (last) last.focus();
  });
}

function mRemoveBibleEntry(entryId) {
  mSyncBibleDraftFromDom();
  state.bibleEdit.entries = state.bibleEdit.entries.filter((e) => e.id !== entryId);
  renderSheetsInner();
}

function mSaveBibleModal() {
  mSyncBibleDraftFromDom();
  const { kind, id, entries } = state.bibleEdit;
  const name = (state.bibleEdit.name || "Untitled").trim();
  const cleanEntries = entries
    .map((e) => ({ id: e.id, title: (e.title || "").trim(), text: (e.text || "").trim() }))
    .filter((e) => e.title || e.text);
  const arr = bibleArrayFor(kind);
  if (id) {
    const item = arr.find((x) => x.id === id);
    if (item) { item.name = name; item.entries = cleanEntries; }
  } else {
    arr.push({ id: uid(kind), name, entries: cleanEntries });
  }
  scheduleSave();
  markDirty("bible", getActiveBookId());
  state.bibleEdit = null;
  render();
}

function mDeleteBibleItem() {
  const { kind, id } = state.bibleEdit;
  if (!id) return;
  const arr = bibleArrayFor(kind);
  const idx = arr.findIndex((x) => x.id === id);
  if (idx !== -1) arr.splice(idx, 1);
  scheduleSave();
  markDirty("bible", getActiveBookId());
  state.bibleEdit = null;
  render();
}

function renderBibleEditorSheet(container) {
  const { kind, id, name, entries } = state.bibleEdit;
  const isNew = !id;
  const entryRowsHtml = entries
    .map((e) => `
      <div class="m-bible-entry-row" data-entry-id="${e.id}">
        <div class="m-bible-entry-head">
          <input type="text" class="m-bible-entry-title" placeholder="Title" value="${escapeHtml(e.title)}">
          <button class="bible-entry-del" data-entry-id="${e.id}" title="Remove entry">&times;</button>
        </div>
        <textarea class="m-bible-entry-text" placeholder="Description">${escapeHtml(e.text)}</textarea>
      </div>`)
    .join("");

  container.innerHTML = `
    <div class="m-fullscreen">
      <div class="m-fullscreen-header">
        <button class="m-btn-text" id="mBibleCancel">Cancel</button>
        <div class="m-topbar-title-single">${isNew ? "New" : "Edit"} ${bibleLabel(kind)}</div>
        <button class="m-btn-text-accent" id="mBibleSave">Save</button>
      </div>
      <div class="m-fullscreen-body">
        <div class="section-label">Name</div>
        <input type="text" id="mBibleEditName" class="m-drawer-input" value="${escapeHtml(name)}">
        <div class="section-label" style="margin-top:16px">Details</div>
        <div id="mBibleEntries">${entryRowsHtml}</div>
        <button class="dashed-btn wide" id="mAddBibleEntry" style="margin-top:4px"><span>+</span><span>Add Entry</span></button>
        ${!isNew ? `<button class="delete-scene-btn" id="mDeleteBibleEntry" style="margin-top:22px">Delete Entry</button>` : ""}
      </div>
    </div>
  `;

  document.getElementById("mBibleCancel").onclick = () => { state.bibleEdit = null; render(); };
  document.getElementById("mBibleSave").onclick = mSaveBibleModal;
  document.getElementById("mAddBibleEntry").onclick = mAddBibleEntry;
  container.querySelectorAll(".bible-entry-del").forEach((btn) => {
    btn.onclick = () => mRemoveBibleEntry(btn.dataset.entryId);
  });
  const delBtn = document.getElementById("mDeleteBibleEntry");
  if (delBtn) delBtn.onclick = mDeleteBibleItem;
}

/* ---------------------------------------------------------------- */
/* Overview tab                                                      */
/* ---------------------------------------------------------------- */

function renderOverviewTab(container) {
  if (!data.chapters.length) {
    container.innerHTML = `<div class="m-overview-scroll"><div class="no-scene" style="padding:18px">No chapters yet.</div></div>`;
    return;
  }

  const chaptersHtml = data.chapters
    .map((ch) => {
      const todoCount = ch.scenes.reduce((a, sc) => a + sc.todos.filter((t) => !t.done).length, 0);
      const dim = state.overviewHighlightTodos && todoCount === 0;
      const statusParts = [];
      if (state.overviewShowWordCounts) statusParts.push(`${formatWordCount(chapterWordCount(ch))} words`);
      const statusLine = statusParts.join(" &middot; ");

      const scenesHtml = state.overviewChaptersOnly ? "" : `
        <div class="m-overview-scenes">
          ${ch.scenes.map((sc) => {
            const sceneTodos = sc.todos.filter((t) => !t.done).length;
            const sceneDim = state.overviewHighlightTodos && sceneTodos === 0;
            return `
              <div class="m-overview-scene-row" style="opacity:${sceneDim ? "0.5" : "1"}" data-chapter-id="${ch.id}" data-scene-id="${sc.id}">
                <span class="m-overview-scene-title">${escapeHtml(sc.title)}</span>
                ${state.overviewShowWordCounts ? `<span class="m-overview-scene-wc">${sceneWordCount(sc)}w</span>` : ""}
              </div>`;
          }).join("")}
        </div>`;

      return `
        <div class="m-overview-chapter" style="opacity:${dim ? "0.5" : "1"}" data-chapter-id="${ch.id}">
          <div class="m-overview-chapter-head">
            <div class="m-overview-chapter-title">${chapterNumber(ch)}. ${escapeHtml(ch.title)}</div>
            ${state.overviewHighlightTodos && todoCount > 0 ? `<span class="m-overview-chip">${todoCount}</span>` : ""}
          </div>
          ${statusLine ? `<div class="m-overview-chapter-status">${statusLine}</div>` : ""}
          ${scenesHtml}
        </div>`;
    })
    .join("");

  container.innerHTML = `<div class="m-overview-scroll">${chaptersHtml}</div>`;

  container.querySelectorAll(".m-overview-chapter-title").forEach((el) => {
    el.onclick = () => openChapter(el.closest(".m-overview-chapter").dataset.chapterId);
  });
  container.querySelectorAll(".m-overview-scene-row").forEach((el) => {
    el.onclick = () => openScene(el.dataset.chapterId, el.dataset.sceneId);
  });
}

function renderOverviewFilterSheet(container) {
  const sw = (on) => `position:relative;display:inline-block;width:32px;height:20px;border-radius:999px;background:${on ? "var(--accent)" : "oklch(0.93 0.005 75)"};border:1px solid ${on ? "var(--accent)" : "oklch(0.82 0.005 75)"}`;
  const kn = (on) => `position:absolute;top:2px;left:${on ? "14px" : "2px"};width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35)`;

  container.innerHTML = `
    <div class="m-sheet-overlay" id="mFilterOverlay">
      <div class="m-sheet">
        <div class="m-sheet-header">
          <div class="m-sheet-title">Display</div>
          <button class="m-icon-btn" id="mFilterClose">&times;</button>
        </div>
        <div class="m-sheet-body">
          <div class="m-toggle-row" id="mToggleTodos">
            <span>Highlight scenes with to-dos</span>
            <span style="${sw(state.overviewHighlightTodos)}"><span style="${kn(state.overviewHighlightTodos)}"></span></span>
          </div>
          <div class="m-toggle-row" id="mToggleWordCounts">
            <span>Show word counts</span>
            <span style="${sw(state.overviewShowWordCounts)}"><span style="${kn(state.overviewShowWordCounts)}"></span></span>
          </div>
          <div class="m-toggle-row" id="mToggleChaptersOnly">
            <span>Chapters only</span>
            <span style="${sw(state.overviewChaptersOnly)}"><span style="${kn(state.overviewChaptersOnly)}"></span></span>
          </div>
        </div>
      </div>
    </div>
  `;

  const closeSheet = () => { state.mobileOverviewFilterOpen = false; renderMobileApp(); };
  document.getElementById("mFilterClose").onclick = closeSheet;
  document.getElementById("mFilterOverlay").addEventListener("mousedown", (e) => {
    if (e.target.id === "mFilterOverlay") closeSheet();
  });
  document.getElementById("mToggleTodos").onclick = () => {
    state.overviewHighlightTodos = !state.overviewHighlightTodos;
    persistUiPrefs();
    renderMobileApp();
  };
  document.getElementById("mToggleWordCounts").onclick = () => {
    state.overviewShowWordCounts = !state.overviewShowWordCounts;
    persistUiPrefs();
    renderMobileApp();
  };
  document.getElementById("mToggleChaptersOnly").onclick = () => {
    state.overviewChaptersOnly = !state.overviewChaptersOnly;
    persistUiPrefs();
    renderMobileApp();
  };
}

/* ---------------------------------------------------------------- */
/* Nav sheet ("Jump to scene" + book switcher + book details)        */
/* ---------------------------------------------------------------- */

function renderNavSheet(container) {
  const currentTitle = data.title || "Untitled Book";

  const bookListHtml = navBookListOpen
    ? `
      <div class="m-nav-book-list">
        ${state.books.map((b) => `<div class="m-nav-book-item ${b.id === state.activeBookId ? "active" : ""}" data-book-id="${b.id}">${escapeHtml(b.title)}</div>`).join("")}
        <div class="m-nav-book-item m-nav-book-new" id="mNavNewBook"><span>+</span><span>New Book</span></div>
      </div>`
    : "";

  const chaptersHtml = data.chapters
    .map((ch) => {
      const scenesHtml = ch.scenes
        .map((sc) => `
          <div class="m-nav-scene ${sc.id === state.activeSceneId ? "active" : ""}" data-chapter-id="${ch.id}" data-scene-id="${sc.id}">${escapeHtml(sceneLabel(ch, sc))}</div>`)
        .join("");
      return `
        <div class="m-nav-chapter-block">
          <div class="m-nav-chapter">
            <input class="m-nav-chapter-input" data-chapter-id="${ch.id}" value="${escapeHtml(`${chapterNumber(ch)}. ${ch.title}`)}">
          </div>
          ${scenesHtml}
        </div>`;
    })
    .join("");

  const bookSectionHtml = navBookSectionOpen ? `
    <div class="m-nav-book-section">
      <div class="section-label">Book Details</div>
      <input type="text" id="mBookTitleInput" placeholder="Untitled Book" class="m-drawer-input" value="${escapeHtml(data.title || "")}">
      <input type="text" id="mBookAuthorInput" placeholder="Author name" class="m-drawer-input" style="margin-top:8px" value="${escapeHtml(data.author || "")}">
      <button class="m-btn" id="mBookSaveBtn" style="margin-top:8px;width:100%">Save Details</button>
      <div id="mBookStatus" class="settings-status"></div>

      <div class="section-label" style="margin-top:18px">Export &amp; Import</div>
      <div class="settings-actions-row">
        <button class="tbtn" id="mExportPdf">Export as PDF</button>
        <button class="tbtn" id="mExportEpub">Export as EPUB</button>
        <button class="tbtn" id="mImportMd">Import from Markdown</button>
      </div>
      <input type="file" id="mImportMdFile" accept=".md,.markdown,text/markdown" style="display:none">
      <div id="mImportStatus" class="settings-status"></div>

      <div class="section-label" style="margin-top:18px">Danger Zone</div>
      <button class="tbtn" id="mDeleteBookBtn">Delete Book&hellip;</button>
      <div id="mDeleteBookConfirmRow" class="settings-status" style="display:none">
        This permanently deletes this book from this device. This cannot be undone.
        <div class="settings-actions-row" style="margin-top:8px">
          <button class="modal-btn delete" id="mDeleteBookConfirm">Yes, Delete Book</button>
          <button class="tbtn" id="mDeleteBookCancel">Cancel</button>
        </div>
      </div>
    </div>
  ` : "";

  container.innerHTML = `
    <div class="m-sheet-overlay" id="mNavOverlay">
      <div class="m-sheet m-sheet-tall">
        <div class="m-sheet-header">
          <div class="m-nav-book-row" id="mNavBookRow">
            <span class="m-sheet-title">${escapeHtml(currentTitle)}</span>
            <span class="m-nav-book-caret">&#9662;</span>
          </div>
          <button class="m-icon-btn" id="mNavClose">&times;</button>
        </div>
        ${bookListHtml}
        <div class="m-sheet-body">
          <div class="m-sheet-subtitle">Jump to scene</div>
          ${chaptersHtml}
          <div class="m-nav-add-row">
            <button class="dashed-btn" id="mAddScene"><span>+</span><span>Add Scene</span></button>
            <button class="dashed-btn" id="mAddChapter"><span>+</span><span>Add Chapter</span></button>
          </div>
          <button class="m-nav-book-section-toggle" id="mBookSectionToggle">${navBookSectionOpen ? "Hide" : "Show"} book details, export &amp; import &#9662;</button>
          ${bookSectionHtml}
        </div>
      </div>
    </div>
  `;

  const closeSheet = () => { state.mobileNavOpen = false; navBookListOpen = false; renderMobileApp(); };
  document.getElementById("mNavClose").onclick = closeSheet;
  document.getElementById("mNavOverlay").addEventListener("mousedown", (e) => {
    if (e.target.id === "mNavOverlay") closeSheet();
  });
  document.getElementById("mNavBookRow").onclick = () => {
    navBookListOpen = !navBookListOpen;
    renderNavSheet(elSheets);
  };
  container.querySelectorAll("[data-book-id]").forEach((el) => {
    el.onclick = () => { navBookListOpen = false; switchToBook(el.dataset.bookId); };
  });
  const newBookBtn = document.getElementById("mNavNewBook");
  if (newBookBtn) newBookBtn.onclick = () => { navBookListOpen = false; state.mobileNavOpen = false; state.newBookOpen = true; render(); };

  container.querySelectorAll(".m-nav-chapter-input").forEach((el) => {
    el.addEventListener("input", () => {
      const ch = getChapter(el.dataset.chapterId);
      if (!ch) return;
      // Strip a leading "N. " the user might retype — the number itself isn't editable state.
      ch.title = el.value.replace(/^\d+\.\s*/, "");
      scheduleSave();
      markDirty("manifest", getActiveBookId());
    });
  });
  container.querySelectorAll(".m-nav-scene").forEach((el) => {
    el.onclick = () => { state.mobileNavOpen = false; openScene(el.dataset.chapterId, el.dataset.sceneId); };
  });
  document.getElementById("mAddScene").onclick = () => { state.mobileNavOpen = false; addScene(); };
  document.getElementById("mAddChapter").onclick = () => { state.mobileNavOpen = false; addChapter(); };

  document.getElementById("mBookSectionToggle").onclick = () => {
    navBookSectionOpen = !navBookSectionOpen;
    renderNavSheet(elSheets);
  };

  const bookSaveBtn = document.getElementById("mBookSaveBtn");
  if (bookSaveBtn) {
    bookSaveBtn.onclick = () => {
      handleSaveBookDetails(document.getElementById("mBookTitleInput").value, document.getElementById("mBookAuthorInput").value);
      const status = document.getElementById("mBookStatus");
      if (status) status.textContent = "Saved.";
    };
  }
  const exportPdfBtn = document.getElementById("mExportPdf");
  if (exportPdfBtn) exportPdfBtn.onclick = () => exportManuscript(data);
  const exportEpubBtn = document.getElementById("mExportEpub");
  if (exportEpubBtn) exportEpubBtn.onclick = () => exportEpub(data);
  const importBtn = document.getElementById("mImportMd");
  const importFile = document.getElementById("mImportMdFile");
  if (importBtn && importFile) {
    importBtn.onclick = () => importFile.click();
    importFile.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        let message; let isError = false;
        try {
          const count = importManuscriptMarkdown(reader.result);
          message = `Imported ${count} chapter${count === 1 ? "" : "s"}.`;
        } catch (err) {
          message = `Import failed: ${err.message}`;
          isError = true;
        }
        // Leave the sheet open (unlike scene/chapter navigation) so the status message below the
        // button is actually visible — render() rebuilds this sheet fresh since mobileNavOpen and
        // navBookSectionOpen are both still true, then we grab the freshly-created status element.
        render();
        const statusEl = document.getElementById("mImportStatus");
        if (statusEl) { statusEl.textContent = message; statusEl.classList.toggle("error", isError); }
      };
      reader.readAsText(file);
    };
  }
  const deleteBookBtn = document.getElementById("mDeleteBookBtn");
  if (deleteBookBtn) {
    deleteBookBtn.onclick = () => {
      document.getElementById("mDeleteBookConfirmRow").style.display = "block";
      deleteBookBtn.style.display = "none";
    };
  }
  const deleteBookCancelBtn = document.getElementById("mDeleteBookCancel");
  if (deleteBookCancelBtn) {
    deleteBookCancelBtn.onclick = () => {
      document.getElementById("mDeleteBookConfirmRow").style.display = "none";
      document.getElementById("mDeleteBookBtn").style.display = "";
    };
  }
  const deleteBookConfirmBtn = document.getElementById("mDeleteBookConfirm");
  if (deleteBookConfirmBtn) deleteBookConfirmBtn.onclick = () => handleDeleteBook(state.activeBookId);
}

/* ---------------------------------------------------------------- */
/* Simple confirm sheets: delete scene / split scene / new book      */
/* ---------------------------------------------------------------- */

function renderDeleteSceneConfirmSheet(container) {
  const sceneId = state.deleteSceneConfirm;
  const { scene: sc } = getSceneAndChapter(sceneId);
  container.innerHTML = `
    <div class="m-sheet-overlay" id="mConfirmOverlay">
      <div class="m-sheet">
        <div class="m-sheet-header"><div class="m-sheet-title">Delete scene?</div></div>
        <div class="m-sheet-body">
          <p class="modal-copy">This will permanently delete <strong>${escapeHtml(sc ? sc.title : "this scene")}</strong>, including its text, summary, and to-dos. This can't be undone.</p>
          <div class="modal-actions">
            <button class="modal-btn cancel" id="mConfirmCancel">Cancel</button>
            <button class="modal-btn delete" id="mConfirmDelete">Delete Scene</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.getElementById("mConfirmCancel").onclick = closeDeleteSceneConfirm;
  document.getElementById("mConfirmOverlay").addEventListener("mousedown", (e) => {
    if (e.target.id === "mConfirmOverlay") closeDeleteSceneConfirm();
  });
  document.getElementById("mConfirmDelete").onclick = () => deleteScene(sceneId);
}

function renderSplitConfirmSheet(container) {
  const { chapterId, sceneId, beforeHtml, selectedHtml, afterHtml } = state.splitConfirm;
  container.innerHTML = `
    <div class="m-sheet-overlay" id="mSplitOverlay">
      <div class="m-sheet">
        <div class="m-sheet-header"><div class="m-sheet-title">Split into 3 scenes?</div></div>
        <div class="m-sheet-body">
          <p class="modal-copy">Your selection is in the middle of this scene's text. Splitting creates two new scenes — one for the selection, one for the text after it — while this scene keeps only the text before it.</p>
          <div class="modal-actions">
            <button class="modal-btn cancel" id="mSplitCancel">Cancel</button>
            <button class="modal-btn done" id="mSplitConfirm">Split into 3 Scenes</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.getElementById("mSplitCancel").onclick = closeSplitConfirm;
  document.getElementById("mSplitOverlay").addEventListener("mousedown", (e) => {
    if (e.target.id === "mSplitOverlay") closeSplitConfirm();
  });
  document.getElementById("mSplitConfirm").onclick = () => {
    state.splitConfirm = null;
    performSplit(chapterId, sceneId, beforeHtml, selectedHtml, afterHtml);
  };
}

function renderNewBookSheet(container) {
  container.innerHTML = `
    <div class="m-sheet-overlay" id="mNewBookOverlay">
      <div class="m-sheet">
        <div class="m-sheet-header"><div class="m-sheet-title">New Book</div></div>
        <div class="m-sheet-body">
          <div class="section-label">Title</div>
          <input type="text" id="mNewBookTitle" class="m-drawer-input" placeholder="Untitled Book">
          <div class="modal-actions" style="margin-top:16px">
            <button class="modal-btn cancel" id="mNewBookCancel">Cancel</button>
            <button class="modal-btn done" id="mNewBookConfirm">Create</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.getElementById("mNewBookCancel").onclick = closeNewBookModal;
  document.getElementById("mNewBookOverlay").addEventListener("mousedown", (e) => {
    if (e.target.id === "mNewBookOverlay") closeNewBookModal();
  });
  document.getElementById("mNewBookConfirm").onclick = () => handleCreateBook(document.getElementById("mNewBookTitle").value);
  document.getElementById("mNewBookTitle").focus();
}

/* ---------------------------------------------------------------- */
/* Sheet dispatcher                                                  */
/* ---------------------------------------------------------------- */

function renderSheetsInner() {
  if (!elSheets) return;

  if (state.bibleEdit) { renderBibleEditorSheet(elSheets); return; }
  if (state.deleteSceneConfirm) { renderDeleteSceneConfirmSheet(elSheets); return; }
  if (state.splitConfirm) { renderSplitConfirmSheet(elSheets); return; }
  if (state.newBookOpen) { renderNewBookSheet(elSheets); return; }
  if (state.mobileNavOpen) { renderNavSheet(elSheets); return; }
  if (state.mobileOverviewFilterOpen) { renderOverviewFilterSheet(elSheets); return; }

  elSheets.innerHTML = "";
}

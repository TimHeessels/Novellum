"use strict";

import {
  uid, escapeHtml, clamp, formatRelativeTime, wordCount, sanitizeFormattingHtml,
  data, scene, chapter,
  getSceneAndChapter, getChapter, sceneNumber, sceneLabel, chapterNumber, chapterLabel,
  bibleArrayFor, bibleLabel,
} from "./model.js";
import { state } from "./state.js";
import {
  scheduleSave,
  listBooks, loadBook, setActiveBookId, getActiveBookId, persistNow, flushSaveNow,
  saveUiPrefs, deleteBook,
} from "./persistence.js";
import { enqueueSync, ensureBookBootstrapped, getSyncStatus, pullChanges } from "./sync-engine.js";
import { renderSettingsView } from "./settings-ui.js";
import { renderOverviewView } from "./overview-ui.js";
import { exportManuscript, exportEpub } from "./export.js";
import { buildChaptersFromMarkdown } from "./import.js";

function markDirty(kind, targetId) {
  // Set synchronously, ahead of enqueueSync's own IndexedDB write actually landing — main.js's
  // beforeunload handler needs an immediately-current answer, and correctness only requires this
  // flag to ever be true when there's real pending work, not the reverse (refreshSyncStatusUI
  // below is what's allowed to clear it back to false, once it's actually confirmed empty).
  state.hasPendingSync = true;
  enqueueSync(kind, targetId).catch((err) => console.error("Novellum: outbox enqueue failed", err));
}

/* ---------------------------------------------------------------- */
/* Actions                                                            */
/* ---------------------------------------------------------------- */

/** Sets the active chapter/scene and remembers this scene as that chapter's "last selected"
 *  one, so navigating back to the chapter later (e.g. from full-manuscript view) restores it
 *  instead of always resetting to the chapter's first scene. */
function setActiveSceneState(chapterId, sceneId) {
  state.activeChapterId = chapterId;
  state.activeSceneId = sceneId;
  if (chapterId && sceneId) state.lastSceneByChapter[chapterId] = sceneId;
}

export function setActiveScene(chapterId, sceneId) {
  if (state.activeChapterId === chapterId && state.activeSceneId === sceneId) return;
  setActiveSceneState(chapterId, sceneId);
  renderLeftPanel();
  renderRightPanel();
  syncCenterActiveHighlight();
  syncFullChapterBanner();
  persistUiPrefs();
}

function syncCenterActiveHighlight() {
  centerPanelEl.querySelectorAll("[data-highlight-scene-id]").forEach((el) => {
    el.classList.toggle("active", el.dataset.highlightSceneId === state.activeSceneId);
  });
}

// Where a docked .scene-sticky actually renders, relative to centerPanelEl's own
// getBoundingClientRect().top. CSS position:sticky's `top` offset is measured from the
// scrolling container's *padding* edge, not its border edge — so scene-sticky's `top: 31px`
// (styles.css) lands 31px below .center-panel's own 44px top padding, i.e. at 75px from the
// container's outer edge, not 31px. Getting this wrong means a docked header's rect.top never
// satisfies the check at all, so scroll-spy silently keeps whatever the previous scene was.
// A couple of px of slack absorbs rounding so the handoff between two adjacent stuck headers
// doesn't flicker between them.
const CENTER_PANEL_TOP_PADDING = 44; // .center-panel's padding-top (styles.css)
const SCENE_STICKY_DOCK_Y = CENTER_PANEL_TOP_PADDING + 31 + 1;
let scrollSpyRaf = null;

// Set while a *deliberate* navigation (clicking a scene/chapter, a pull jumping to a scene,
// etc.) is programmatically scrolling the center panel via scrollElementToTop. That scroll can
// briefly land somewhere that doesn't reflect the newly-selected scene at all — e.g. a target
// near the end of a short document can't be scrolled all the way to its dock position, so
// scrollElementToTop's clamp-compensation overshoots and leaves some earlier scene's header
// docked instead. The scroll-spy must not "correct" the already-correct selection based on that
// transient position, so it's suppressed for the duration of any programmatic scroll and only
// re-armed once things have settled — genuine user scrolling (wheel/trackpad/scrollbar) is
// unaffected since it never touches this flag.
let suppressScrollSpy = false;

/** As the user scrolls the chapter/full manuscript view, the scene whose sticky header is
 *  currently docked at the top is "where you are" — mirror that into activeScene/activeChapter
 *  so the left sidebar tracks scroll position, not just clicks into scene text. Throttled to
 *  one check per animation frame; setActiveScene itself no-ops if the scene hasn't changed. */
function handleCenterScrollSpy() {
  if (suppressScrollSpy) return;
  if (state.view !== "chapter" && state.view !== "full") return;
  if (scrollSpyRaf !== null) return;
  scrollSpyRaf = requestAnimationFrame(() => {
    scrollSpyRaf = null;
    updateActiveSceneFromScroll();
  });
}

function updateActiveSceneFromScroll() {
  const stickies = centerPanelEl.querySelectorAll(".scene-sticky[data-highlight-scene-id]");
  if (!stickies.length) return;

  // Scrolled to (or within a hair of) the bottom: always treat the final scene as current, even
  // if it's short enough that its header never reaches the dock line — otherwise a short last
  // scene could never become selected no matter how far you scroll into it.
  const { scrollTop, scrollHeight, clientHeight } = centerPanelEl;
  if (scrollTop + clientHeight >= scrollHeight - 2) {
    const last = stickies[stickies.length - 1];
    const { chapter: ch, scene: sc } = getSceneAndChapter(last.dataset.highlightSceneId);
    if (sc) setActiveScene(ch.id, sc.id);
    return;
  }

  const containerTop = centerPanelEl.getBoundingClientRect().top;
  // Stacked sticky headers dock in document order: every header at-or-above the dock line
  // currently qualifies, and the last one (furthest down) is whichever is actually docked
  // right now — earlier ones have already been pushed out from under it by later content.
  let current = stickies[0];
  for (const el of stickies) {
    if (el.getBoundingClientRect().top - containerTop <= SCENE_STICKY_DOCK_Y) current = el;
  }
  const { chapter: ch, scene: sc } = getSceneAndChapter(current.dataset.highlightSceneId);
  if (sc) setActiveScene(ch.id, sc.id);
}

function syncSceneTitleDisplays(sceneId) {
  const { chapter: ch, scene: sc } = getSceneAndChapter(sceneId);
  if (!sc) return;
  const label = sceneLabel(ch, sc);

  const rowSpan = leftPanelEl.querySelector(`.scene-row[data-scene-id="${sceneId}"] span`);
  if (rowSpan) rowSpan.textContent = label;

  centerPanelEl.querySelectorAll(`[data-highlight-scene-id="${sceneId}"]`).forEach((el) => {
    if (el.classList.contains("scene-sticky")) {
      const col = el.querySelector(".col");
      if (col) col.textContent = label;
    } else if (el.classList.contains("scene-eyebrow")) {
      el.textContent = `${chapterLabel(ch).toUpperCase()}  ·  ${label.toUpperCase()}`;
    }
  });
}

/** Overview is a glanceable detour, not a persistent browsing mode: any click on a chapter/scene
 *  there immediately leaves it, landing back in whichever view (full/chapter/scene) was active
 *  before it was opened — falling back to "chapter" if that's missing or nonsensical. */
function resolveViewAfterOverview() {
  const valid = ["full", "chapter", "scene"];
  return valid.includes(state.viewBeforeOverview) ? state.viewBeforeOverview : "chapter";
}

/** Restores the sidebars to however they looked before overview forced them closed. Only call
 *  while state.view is still "overview", before it gets reassigned by the caller. */
function restorePanelsBeforeOverview() {
  state.leftOpen = state.leftOpenBeforeOverview;
  state.rightOpen = state.rightOpenBeforeOverview;
}

/** Selects a chapter and navigates to it — but never changes view mode (Scene/Chapter/Full is
 *  controlled solely by the topbar toggle now), so this just moves the selection and scrolls
 *  within whatever mode is already active. */
function openChapter(chapterId) {
  const ch = getChapter(chapterId);
  if (!ch) return;
  const leavingOverview = state.view === "overview";

  // Restore whichever scene was last selected in this chapter, so switching away and back
  // doesn't lose your place; only fall back to the first scene if we've never been here.
  const remembered = state.lastSceneByChapter[chapterId];
  const targetSceneId = remembered && ch.scenes.some((s) => s.id === remembered)
    ? remembered
    : (ch.scenes[0] ? ch.scenes[0].id : null);
  setActiveSceneState(chapterId, targetSceneId);

  if (leavingOverview) {
    state.view = resolveViewAfterOverview();
    restorePanelsBeforeOverview();
  }

  render();
  if (targetSceneId) focusSceneText(targetSceneId);
}

// `Element.scrollIntoView` computes its scroll delta from the target's *current* bounding rect.
// For `position: sticky` targets that's unreliable over a big jump: an element we've already
// scrolled past is still rendered "stuck" at its clamped position, so its rect looks like it's
// already near the top and the browser scrolls far too little (landing mid-document instead of
// at the target — e.g. jumping back to chapter 1 would undershoot and land around chapter 2).
// Resetting scrollTop to 0 first forces a clean, unclamped layout to measure the target's true
// offset from, then we jump straight to that offset in one synchronous step (no visible flash,
// since nothing repaints between the reset and the final scrollTop assignment).
function scrollElementToTop(el) {
  if (!el) return;
  // This can land at a scroll position that transiently docks a *different* header than `el`
  // (see the scrollSpy-suppression comment above `suppressScrollSpy`'s declaration) — the
  // scroll-spy must ignore the scroll events this triggers rather than "correct" an already-
  // correct selection based on them.
  suppressScrollSpy = true;
  centerPanelEl.scrollTop = 0;
  const containerTop = centerPanelEl.getBoundingClientRect().top;
  const naturalTop = el.getBoundingClientRect().top - containerTop;
  centerPanelEl.scrollTop = naturalTop;
  // If `el` has `position: sticky` with a positive `top` (e.g. scene-sticky's 32px), it can
  // clamp to that offset instead of landing flush at 0. The non-sticky content right after it
  // doesn't know about that clamp and lays out as if `el` sat at 0, so it ends up flowing
  // partly behind the header instead of below it. Re-measure and subtract the residual so the
  // header's actual rendered position and the following content agree.
  const residual = el.getBoundingClientRect().top - containerTop;
  if (residual !== 0) centerPanelEl.scrollTop -= residual;
  // A synchronous scrollTop write's "scroll" event is typically coalesced and dispatched on a
  // later animation frame rather than immediately — two nested rAFs comfortably outlast that
  // before the spy is re-armed for genuine user scrolling.
  requestAnimationFrame(() => requestAnimationFrame(() => { suppressScrollSpy = false; }));
}

/** Selects a scene and navigates to it — never changes view mode (see openChapter), just moves
 *  the selection and scrolls/focuses within whatever mode (Scene/Chapter/Full) is already active. */
function openScene(chapterId, sceneId) {
  const leavingOverview = state.view === "overview";
  setActiveSceneState(chapterId, sceneId);

  if (leavingOverview) {
    state.view = resolveViewAfterOverview();
    restorePanelsBeforeOverview();
  }

  render();
  focusSceneText(sceneId);
}

/** Switches Scene/Chapter/Full view mode — the topbar toggle's only job. Selection (which
 *  chapter/scene is active) is untouched; this just changes how much surrounding context is
 *  shown, then scrolls to keep the current selection in view. Doesn't steal focus/place the
 *  cursor — that's reserved for actually clicking a scene/chapter, not just changing zoom. */
function setViewMode(mode) {
  if (state.view === mode) return;
  const leavingOverview = state.view === "overview";
  state.view = mode;
  if (leavingOverview) restorePanelsBeforeOverview();
  render();
  if ((mode === "full" || mode === "chapter") && state.activeSceneId) {
    focusSceneText(state.activeSceneId, { focusText: false });
  }
}

function openOverview() {
  if (state.view !== "overview") {
    state.viewBeforeOverview = state.view;
    state.leftOpenBeforeOverview = state.leftOpen;
    state.rightOpenBeforeOverview = state.rightOpen;
    state.leftOpen = false;
    state.rightOpen = false;
  }
  state.view = "overview";
  render();
}

/** Re-opens the left sidebar from its collapsed state, on whichever tab was last active. If
 *  overview is currently showing, this also exits it — opening the manuscript tree while overview
 *  is still the center content would just show two overlapping ways to navigate at once. */
function openLeftFromCollapsed() {
  if (state.view === "overview") {
    state.view = resolveViewAfterOverview();
    state.rightOpen = state.rightOpenBeforeOverview;
  }
  state.leftOpen = true;
  render();
}

function toggleLeft() {
  state.leftOpen = !state.leftOpen;
  render();
}

function toggleRight() {
  state.rightOpen = !state.rightOpen;
  render();
}

function setLeftTab(tab) {
  state.leftTab = tab;
  renderLeftPanel();
  persistUiPrefs();
}

function setBibleTab(tab) {
  state.bibleTab = tab;
  renderLeftPanel();
  persistUiPrefs();
}

function addScene() {
  const ch = getChapter(state.activeChapterId) || data.chapters[data.chapters.length - 1];
  const sc = scene("Untitled Scene", "", "", []);
  ch.scenes.push(sc);
  scheduleSave();
  markDirty("scene", sc.id);
  markDirty("manifest", getActiveBookId());
  setActiveSceneState(ch.id, sc.id);
  if (state.view !== "chapter" && state.view !== "full") state.view = "scene";
  render();
  focusSceneText(sc.id);
}

function addChapter() {
  const ch = chapter("Untitled Chapter", [
    scene("Untitled Scene", "", "", []),
  ]);
  data.chapters.push(ch);
  scheduleSave();
  markDirty("scene", ch.scenes[0].id);
  markDirty("manifest", getActiveBookId());
  setActiveSceneState(ch.id, ch.scenes[0].id);
  state.view = "scene";
  render();
  focusSceneText(ch.scenes[0].id);
}

/** Replaces every chapter/scene in the current book with the contents of an imported manuscript
 *  markdown file — chapters split on "### Chapter" headings, scenes within each split further on
 *  "* * *" lines. Story bible entries are untouched. Returns the number of chapters imported;
 *  throws if the file had no "### Chapter" headings to import. */
function importManuscriptMarkdown(text) {
  const { title, chapters } = buildChaptersFromMarkdown(text);
  if (!chapters.length) {
    throw new Error('No chapters found — expected "### Chapter" headings under a "## Novel" section.');
  }

  // Scenes that existed before the import but aren't in the new set need their GitHub files
  // deleted too, or they'd linger there forever as orphans — enqueue them before the old
  // structure is gone.
  const newSceneIds = new Set(chapters.flatMap((ch) => ch.scenes.map((sc) => sc.id)));
  const removedSceneIds = data.chapters
    .flatMap((ch) => ch.scenes.map((sc) => sc.id))
    .filter((id) => !newSceneIds.has(id));

  if (title) data.title = title;
  data.chapters = chapters;
  scheduleSave();
  removedSceneIds.forEach((id) => markDirty("scene", id));
  chapters.forEach((ch) => ch.scenes.forEach((sc) => markDirty("scene", sc.id)));
  markDirty("manifest", getActiveBookId());

  const firstChapter = chapters[0];
  const firstScene = firstChapter.scenes[0] || null;
  state.lastSceneByChapter = {};
  setActiveSceneState(firstChapter.id, firstScene ? firstScene.id : null);
  state.view = "chapter";

  return chapters.length;
}

function handleImportMarkdownFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let message;
    let isError = false;
    try {
      const count = importManuscriptMarkdown(reader.result);
      message = `Imported ${count} chapter${count === 1 ? "" : "s"}.`;
    } catch (err) {
      message = `Import failed: ${err.message}`;
      isError = true;
    }
    // Re-render first — a structural change redraws the whole left panel (and center/right, since
    // the active scene may have changed) — then stamp the status message onto the fresh element.
    render();
    const statusEl = document.getElementById("importStatus");
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.classList.toggle("error", isError);
    }
  };
  reader.readAsText(file);
}

/** Scrolls a scene into view and, by default, places the cursor in its text — the latter is
 *  skipped for a bare view-mode switch (Scene/Chapter/Full toggle), where jumping into edit
 *  mode would be a surprising side effect of just changing zoom level. */
function focusSceneText(sceneId, { focusText = true } = {}) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`.manuscript-text[data-scene-id="${sceneId}"]`);
    if (el && focusText) el.focus();
    // Scroll to the scene's heading (scene-sticky/scene-eyebrow), not the text itself, so the
    // scene starts at the top of the viewport instead of the text being centered mid-scroll.
    const heading = centerPanelEl.querySelector(`[data-highlight-scene-id="${sceneId}"]`);
    scrollElementToTop(heading || el);
  });
}

function toggleTodo(sceneId, todoId) {
  const { scene: sc } = getSceneAndChapter(sceneId);
  if (!sc) return;
  const t = sc.todos.find((x) => x.id === todoId);
  if (t) t.done = !t.done;
  scheduleSave();
  markDirty("scene", sceneId);
  renderRightPanel();
}

function deleteTodo(sceneId, todoId) {
  const { scene: sc } = getSceneAndChapter(sceneId);
  if (!sc) return;
  sc.todos = sc.todos.filter((x) => x.id !== todoId);
  scheduleSave();
  markDirty("scene", sceneId);
  renderRightPanel();
}

function addTodo(sceneId) {
  const { scene: sc } = getSceneAndChapter(sceneId);
  if (!sc) return;
  const t = { id: uid("todo"), text: "", done: false };
  sc.todos.push(t);
  scheduleSave();
  markDirty("scene", sceneId);
  renderRightPanel();
  requestAnimationFrame(() => {
    const el = document.querySelector(`.todo-text[data-todo-id="${t.id}"]`);
    if (el) el.focus();
  });
}

function requestDeleteScene(sceneId) {
  state.deleteSceneConfirm = sceneId;
  renderModal();
}

function closeDeleteSceneConfirm() {
  state.deleteSceneConfirm = null;
  renderModal();
}

function deleteScene(sceneId) {
  const { chapter: ch, scene: sc } = getSceneAndChapter(sceneId);
  if (!ch || !sc) return;
  const idx = ch.scenes.indexOf(sc);
  ch.scenes.splice(idx, 1);
  scheduleSave();
  markDirty("scene", sc.id); // pushOne deletes the GitHub file once the local row is gone
  markDirty("manifest", getActiveBookId());
  state.deleteSceneConfirm = null;

  // Pick a sensible new active scene: the one that took this slot, else the one before it,
  // else fall back to hunting outward through neighboring chapters.
  let nextChapter = ch;
  let nextScene = ch.scenes[idx] || ch.scenes[idx - 1] || null;
  if (!nextScene) {
    const chIdx = data.chapters.indexOf(ch);
    for (let i = chIdx + 1; i < data.chapters.length && !nextScene; i++) {
      if (data.chapters[i].scenes[0]) { nextChapter = data.chapters[i]; nextScene = data.chapters[i].scenes[0]; }
    }
    for (let i = chIdx - 1; i >= 0 && !nextScene; i--) {
      if (data.chapters[i].scenes.length) { nextChapter = data.chapters[i]; nextScene = data.chapters[i].scenes[data.chapters[i].scenes.length - 1]; }
    }
  }
  setActiveSceneState(nextChapter.id, nextScene ? nextScene.id : null);
  render();
}

function openBibleModal(kind, id) {
  state.bibleEdit = { kind, id: id || null };
  renderModal();
}

function closeBibleModal() {
  state.bibleEdit = null;
  renderModal();
}

function saveBibleModal() {
  const { kind, id } = state.bibleEdit;
  const nameEl = document.getElementById("bibleEditName");
  const descEl = document.getElementById("bibleEditDesc");
  const name = (nameEl.value || "Untitled").trim();
  const desc = (descEl.value || "").trim();
  const arr = bibleArrayFor(kind);
  if (id) {
    const item = arr.find((x) => x.id === id);
    if (item) { item.name = name; item.desc = desc; }
  } else {
    arr.push({ id: uid(kind), name, desc });
  }
  scheduleSave();
  markDirty("bible", getActiveBookId());
  state.bibleEdit = null;
  renderModal();
  renderLeftPanel();
}

function deleteBibleItem() {
  const { kind, id } = state.bibleEdit;
  if (!id) return;
  const arr = bibleArrayFor(kind);
  const idx = arr.findIndex((x) => x.id === id);
  if (idx !== -1) arr.splice(idx, 1);
  scheduleSave();
  markDirty("bible", getActiveBookId());
  state.bibleEdit = null;
  renderModal();
  renderLeftPanel();
}

/* ---------------------------------------------------------------- */
/* Rendering                                                          */
/* ---------------------------------------------------------------- */

let app, topbarEl, leftPanelEl, leftHandleEl, centerPanelEl, rightHandleEl, rightPanelEl, modalRootEl;

/** Snapshots the parts of `state` that represent "where you are / how the panels look" — not
 *  manuscript content — to localStorage, so reloading the page returns you to the same spot. */
function persistUiPrefs() {
  saveUiPrefs({
    activeBookId: state.activeBookId,
    view: state.view,
    activeChapterId: state.activeChapterId,
    activeSceneId: state.activeSceneId,
    leftWidth: state.leftWidth,
    rightWidth: state.rightWidth,
    leftOpen: state.leftOpen,
    rightOpen: state.rightOpen,
    leftTab: state.leftTab,
    bibleTab: state.bibleTab,
    viewBeforeOverview: state.viewBeforeOverview,
    leftOpenBeforeOverview: state.leftOpenBeforeOverview,
    rightOpenBeforeOverview: state.rightOpenBeforeOverview,
  });
}

export function render() {
  renderTopbar();
  renderLeftPanel();
  renderCenter();
  renderRightPanel();
  renderModal();
  persistUiPrefs();
}

function openSettings() {
  state.bookSwitcherOpen = false;
  if (state.view === "overview") restorePanelsBeforeOverview();
  state.view = "settings";
  render();
}

const VIEW_MODE_ICON = {
  scene: `<svg viewBox="0 0 448 512" fill="currentColor"><path d="M288 64c0 17.7-14.3 32-32 32L32 96C14.3 96 0 81.7 0 64S14.3 32 32 32l224 0c17.7 0 32 14.3 32 32zm0 256c0 17.7-14.3 32-32 32L32 352c-17.7 0-32-14.3-32-32s14.3-32 32-32l224 0c17.7 0 32 14.3 32 32zM0 192c0-17.7 14.3-32 32-32l384 0c17.7 0 32 14.3 32 32s-14.3 32-32 32L32 224c-17.7 0-32-14.3-32-32zM448 448c0 17.7-14.3 32-32 32L32 480c-17.7 0-32-14.3-32-32s14.3-32 32-32l384 0c17.7 0 32 14.3 32 32z"/></svg>`,
  chapter: `<svg viewBox="0 0 512 512" fill="currentColor"><path d="M40 48C26.7 48 16 58.7 16 72l0 48c0 13.3 10.7 24 24 24l48 0c13.3 0 24-10.7 24-24l0-48c0-13.3-10.7-24-24-24L40 48zM192 64c-17.7 0-32 14.3-32 32s14.3 32 32 32l288 0c17.7 0 32-14.3 32-32s-14.3-32-32-32L192 64zm0 160c-17.7 0-32 14.3-32 32s14.3 32 32 32l288 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-288 0zm0 160c-17.7 0-32 14.3-32 32s14.3 32 32 32l288 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-288 0zM16 232l0 48c0 13.3 10.7 24 24 24l48 0c13.3 0 24-10.7 24-24l0-48c0-13.3-10.7-24-24-24l-48 0c-13.3 0-24 10.7-24 24zM40 368c-13.3 0-24 10.7-24 24l0 48c0 13.3 10.7 24 24 24l48 0c13.3 0 24-10.7 24-24l0-48c0-13.3-10.7-24-24-24l-48 0z"/></svg>`,
  full: `<svg viewBox="0 0 576 512" fill="currentColor"><path d="M249.6 471.5c10.8 3.8 22.4-4.1 22.4-15.5l0-377.4c0-4.2-1.6-8.4-5-11C247.4 52 202.4 32 144 32C93.5 32 46.3 45.3 18.1 56.1C6.8 60.5 0 71.7 0 83.8L0 454.1c0 11.9 12.8 20.2 24.1 16.5C55.6 460.1 105.5 448 144 448c33.9 0 79 14 105.6 23.5zm76.8 0C353 462 398.1 448 432 448c38.5 0 88.4 12.1 119.9 22.6c11.3 3.8 24.1-4.6 24.1-16.5l0-370.3c0-12.1-6.8-23.3-18.1-27.6C529.7 45.3 482.5 32 432 32c-58.4 0-103.4 20-123 35.6c-3.3 2.6-5 6.8-5 11L304 456c0 11.4 11.7 19.3 22.4 15.5z"/></svg>`,
  overview: `<svg viewBox="0 0 512 512" fill="currentColor"><path d="M64 32C28.7 32 0 60.7 0 96L0 416c0 35.3 28.7 64 64 64l384 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32zm88 64l0 64-88 0 0-64 88 0zm56 0l88 0 0 64-88 0 0-64zm240 0l0 64-88 0 0-64 88 0zM64 224l88 0 0 64-88 0 0-64zm232 0l0 64-88 0 0-64 88 0zm64 0l88 0 0 64-88 0 0-64zM152 352l0 64-88 0 0-64 88 0zm56 0l88 0 0 64-88 0 0-64zm240 0l0 64-88 0 0-64 88 0z"/></svg>`,
};
const VIEW_MODE_LABEL = { scene: "Current scene", chapter: "Current chapter", full: "Full manuscript", overview: "Overview" };

function renderTopbar() {
  const currentTitle = data.title || "Untitled Book";
  document.title = `${currentTitle} — Novellum`;
  topbarEl.innerHTML = `
    <div class="book-switcher">
      <button class="book-switcher-btn" id="bookSwitcherBtn">${escapeHtml(currentTitle)} <span class="caret">&#9662;</span></button>
      ${state.bookSwitcherOpen ? renderBookSwitcherPopover() : ""}
    </div>
    <div class="view-switcher">
      <div class="view-mode-toggle">
        ${["scene", "chapter", "full", "overview"]
          .map((mode) => {
            const active = state.view === mode;
            const id = mode === "overview" ? "topbarOverviewBtn" : `viewMode${mode[0].toUpperCase()}${mode.slice(1)}`;
            return `<button class="tbtn ${active ? "active" : ""}" id="${id}">${VIEW_MODE_ICON[mode]}<span class="tab-label">${VIEW_MODE_LABEL[mode]}</span></button>`;
          })
          .join("")}
      </div>
    </div>
    <div class="topbar-actions">
      <button class="sync-status-badge" id="syncStatusBadge" title="Open sync settings">&hellip;</button>
    </div>
  `;

  document.getElementById("viewModeScene").onclick = () => setViewMode("scene");
  document.getElementById("viewModeChapter").onclick = () => setViewMode("chapter");
  document.getElementById("viewModeFull").onclick = () => setViewMode("full");
  document.getElementById("topbarOverviewBtn").onclick = openOverview;

  document.getElementById("bookSwitcherBtn").onclick = (e) => {
    e.stopPropagation();
    toggleBookSwitcher();
  };
  topbarEl.querySelectorAll("[data-book-id]").forEach((el) => {
    el.onclick = () => switchToBook(el.dataset.bookId);
  });
  const newBookBtn = topbarEl.querySelector('[data-action="new-book"]');
  if (newBookBtn) {
    newBookBtn.onclick = () => {
      state.bookSwitcherOpen = false;
      state.newBookOpen = true;
      renderTopbar();
      renderModal();
    };
  }
  const openSettingsBtn = topbarEl.querySelector('[data-action="open-settings"]');
  if (openSettingsBtn) openSettingsBtn.onclick = openSettings;

  document.getElementById("syncStatusBadge").onclick = openSettings;
  refreshSyncStatusUI();
}

/** Updates the GitHub Settings badge and the conflict/setup/pull banners from current IndexedDB
 *  state. Called after every topbar render and on a timer, so it stays current between actions
 *  without needing a full app re-render. Pushing and pulling only ever happen from the Sync
 *  menu (settings-ui.js) now — this function and its banners are read-only status display. */
async function refreshSyncStatusUI() {
  const status = await getSyncStatus();
  state.hasPendingSync = status.pendingCount > 0;
  state.syncConfigured = status.configured;

  const badge = document.getElementById("syncStatusBadge");
  if (badge) {
    let label;
    if (!status.configured) label = "Sync not set up";
    else if (status.conflictCount > 0) label = `${status.conflictCount} conflict${status.conflictCount > 1 ? "s" : ""}`;
    else if (state.syncPauseReason) label = "Sync error";
    else if (status.pendingCount > 0) label = `Push ${status.pendingCount} change${status.pendingCount > 1 ? "s" : ""}`;
    else if (state.remoteChangeCount > 0) label = `Pull ${state.remoteChangeCount} change${state.remoteChangeCount > 1 ? "s" : ""}`;
    else {
      const lastAt = [status.lastPushedAt, status.lastPulledAt].filter(Boolean).sort().pop();
      label = lastAt ? `Synced ${formatRelativeTime(lastAt)}` : "Not synced yet";
    }
    badge.textContent = label;
    badge.classList.toggle("has-conflicts", status.conflictCount > 0);
  }

  const banner = document.getElementById("conflictBanner");
  if (banner) {
    if (status.conflictCount > 0) {
      const n = status.conflictCount;
      banner.style.display = "";
      banner.innerHTML = `<span>${n} sync conflict${n > 1 ? "s" : ""} need${n > 1 ? "" : "s"} your attention — nothing was overwritten automatically.</span>`;
    } else {
      banner.style.display = "none";
      banner.innerHTML = "";
    }
  }

  // Same shape as the conflict banner, but calmer (accent, not danger). Covers two cases that
  // both just need the user to look at Settings, neither of which has lost or overwritten any
  // work: sync was never configured, or it's configured but the last push/pull attempt couldn't
  // actually reach GitHub.
  const setupBanner = document.getElementById("setupBanner");
  if (setupBanner) {
    if (!status.configured || state.syncPauseReason) {
      const message = !status.configured
        ? "GitHub sync isn't set up — your work is only saved on this device for now."
        : `Couldn't reach GitHub: ${state.syncPauseReason}`;
      setupBanner.style.display = "";
      setupBanner.innerHTML = `<span>${escapeHtml(message)}</span>`;
    } else {
      setupBanner.style.display = "none";
      setupBanner.innerHTML = "";
    }
  }

  // Only ever shown from the read-only background check in main.js's refreshRemoteChangeCheck
  // (state.hasRemoteChanges) — never toggled by an actual pull, so it can't flicker based on this
  // device's own writes. Pulling itself only happens from the Sync menu.
  const pullBanner = document.getElementById("pullBanner");
  if (pullBanner) {
    if (status.configured && state.hasRemoteChanges) {
      pullBanner.style.display = "";
      pullBanner.innerHTML = `<span>New changes are available on GitHub — open Sync to pull.</span>`;
    } else {
      pullBanner.style.display = "none";
      pullBanner.innerHTML = "";
    }
  }
}

function renderBookSwitcherPopover() {
  const itemsHtml = state.books
    .map(
      (b) => `<div class="book-switcher-item ${b.id === state.activeBookId ? "active" : ""}" data-book-id="${b.id}">${escapeHtml(b.title)}</div>`
    )
    .join("");
  return `
    <div class="book-switcher-popover">
      ${itemsHtml}
      <div class="book-switcher-item new" data-action="new-book"><span>+</span><span>New Book</span></div>
      <div class="book-switcher-item settings" data-action="open-settings">Settings</div>
    </div>
  `;
}

function toggleBookSwitcher() {
  state.bookSwitcherOpen = !state.bookSwitcherOpen;
  renderTopbar();
  if (state.bookSwitcherOpen) {
    requestAnimationFrame(() => document.addEventListener("mousedown", closeBookSwitcherOnOutsideClick));
  }
}

function closeBookSwitcherOnOutsideClick(e) {
  const switcherEl = topbarEl.querySelector(".book-switcher");
  if (switcherEl && !switcherEl.contains(e.target)) {
    state.bookSwitcherOpen = false;
    document.removeEventListener("mousedown", closeBookSwitcherOnOutsideClick);
    renderTopbar();
  }
}

async function switchToBook(bookId) {
  if (bookId === state.activeBookId) {
    state.bookSwitcherOpen = false;
    renderTopbar();
    return;
  }
  await flushSaveNow();
  await loadBook(bookId);
  setActiveBookId(bookId);
  await ensureBookBootstrapped(bookId);
  state.activeBookId = bookId;
  state.lastSceneByChapter = {};
  setActiveSceneState(data.chapters[0].id, data.chapters[0].scenes[0].id);
  if (state.view === "overview") restorePanelsBeforeOverview();
  state.view = "scene";
  state.bookSwitcherOpen = false;
  render();

  // Show local content immediately (above), then pull anything newer from GitHub in the
  // background and refresh once — the whole point of switching books is to see this book's
  // latest state, so unlike everything else that's manual now, this one still pulls on its own.
  // The pull itself and the loadBook() that refreshes `data` from its results run inside
  // pullChanges's lock together — otherwise a concurrent push/pull elsewhere landing in the gap
  // between them would flush the still-stale in-memory `data` and clobber the scenes/chapters this
  // pull just wrote (see withSyncLock's comment in sync-engine.js).
  const result = await pullChanges(bookId, {
    onPulled: async () => {
      if (state.activeBookId === bookId) await loadBook(bookId);
    },
  });
  if (result.pulled > 0 && state.activeBookId === bookId) {
    if (!getSceneAndChapter(state.activeSceneId).scene) {
      setActiveSceneState(data.chapters[0]?.id, data.chapters[0]?.scenes[0]?.id);
    }
    render();
  }
}

function closeNewBookModal() {
  state.newBookOpen = false;
  renderModal();
}

async function handleCreateBook() {
  const titleEl = document.getElementById("newBookTitle");
  const title = (titleEl.value || "Untitled Book").trim();

  await flushSaveNow();
  const bookId = uid("book");
  data.title = title;
  data.chapters = [chapter("Chapter 1", [scene("Untitled Scene", "", "", [])])];
  data.characters = [];
  data.locations = [];
  data.concepts = [];
  setActiveBookId(bookId);
  await persistNow();
  await ensureBookBootstrapped(bookId);

  state.books = await listBooks();
  state.activeBookId = bookId;
  state.lastSceneByChapter = {};
  setActiveSceneState(data.chapters[0].id, data.chapters[0].scenes[0].id);
  if (state.view === "overview") restorePanelsBeforeOverview();
  state.view = "scene";
  state.newBookOpen = false;
  render();
  focusSceneText(data.chapters[0].scenes[0].id);
}

function handleRenameBook(newTitle) {
  const title = (newTitle || "").trim() || "Untitled Book";
  if (title === data.title) return;
  data.title = title;
  scheduleSave();
  markDirty("manifest", getActiveBookId());
  state.books = state.books.map((b) => (b.id === state.activeBookId ? { ...b, title } : b));
  render();
}

/** Deletes the given book entirely (local IndexedDB only — see persistence.js deleteBook) and
 *  lands on another existing book, or a freshly-seeded one if that was the last book left. */
async function handleDeleteBook(bookId) {
  await flushSaveNow();
  await deleteBook(bookId);
  const remainingBooks = await listBooks();

  if (remainingBooks.length === 0) {
    const newBookId = uid("book");
    data.title = "Untitled Book";
    data.chapters = [chapter("Chapter 1", [scene("Untitled Scene", "", "", [])])];
    data.characters = [];
    data.locations = [];
    data.concepts = [];
    setActiveBookId(newBookId);
    await persistNow();
    await ensureBookBootstrapped(newBookId);
    state.books = await listBooks();
    state.activeBookId = newBookId;
  } else {
    const nextBookId = remainingBooks[0].id;
    await loadBook(nextBookId);
    setActiveBookId(nextBookId);
    await ensureBookBootstrapped(nextBookId);
    state.books = remainingBooks;
    state.activeBookId = nextBookId;
  }

  state.lastSceneByChapter = {};
  setActiveSceneState(data.chapters[0].id, data.chapters[0].scenes[0].id);
  if (state.view === "overview") restorePanelsBeforeOverview();
  state.view = "scene";
  state.bookSwitcherOpen = false;
  render();
}

/* ---- Left panel ---- */

const LEFT_TAB_ICON = {
  manuscript: `<svg viewBox="0 0 384 512" fill="currentColor"><path d="M64 0C28.7 0 0 28.7 0 64L0 448c0 35.3 28.7 64 64 64l256 0c35.3 0 64-28.7 64-64l0-288-128 0c-17.7 0-32-14.3-32-32L224 0 64 0zM256 0l0 128 128 0L256 0zM112 256l160 0c8.8 0 16 7.2 16 16s-7.2 16-16 16l-160 0c-8.8 0-16-7.2-16-16s7.2-16 16-16zm0 64l160 0c8.8 0 16 7.2 16 16s-7.2 16-16 16l-160 0c-8.8 0-16-7.2-16-16s7.2-16 16-16zm0 64l160 0c8.8 0 16 7.2 16 16s-7.2 16-16 16l-160 0c-8.8 0-16-7.2-16-16s7.2-16 16-16z"/></svg>`,
  bible: `<svg viewBox="0 0 384 512" fill="currentColor"><path d="M0 48V487.7C0 501.1 10.9 512 24.3 512c5 0 9.9-1.5 14-4.4L192 400 345.7 507.6c4.1 2.9 9 4.4 14 4.4c13.4 0 24.3-10.9 24.3-24.3V48c0-26.5-21.5-48-48-48H48C21.5 0 0 21.5 0 48z"/></svg>`,
  book: `<svg viewBox="0 0 512 512" fill="currentColor"><path d="M495.9 166.6c3.2 8.7 .5 18.4-6.4 24.6l-43.3 39.4c1.1 8.3 1.7 16.8 1.7 25.4s-.6 17.1-1.7 25.4l43.3 39.4c6.9 6.2 9.6 15.9 6.4 24.6c-4.4 11.9-9.7 23.3-15.8 34.3l-4.7 8.1c-6.6 11-14 21.4-22.1 31.2c-5.9 7.2-15.7 9.6-24.5 6.8l-55.7-17.7c-13.4 10.3-28.2 18.9-44 25.4l-12.5 57.1c-2 9.1-9 16.3-18.2 17.8c-13.8 2.3-28 3.5-42.5 3.5s-28.7-1.2-42.5-3.5c-9.2-1.5-16.2-8.7-18.2-17.8l-12.5-57.1c-15.8-6.5-30.6-15.1-44-25.4L83.1 425.9c-8.8 2.8-18.6 .3-24.5-6.8c-8.1-9.8-15.5-20.2-22.1-31.2l-4.7-8.1c-6.1-11-11.4-22.4-15.8-34.3c-3.2-8.7-.5-18.4 6.4-24.6l43.3-39.4C64.6 273.1 64 264.6 64 256s.6-17.1 1.7-25.4L22.4 191.2c-6.9-6.2-9.6-15.9-6.4-24.6c4.4-11.9 9.7-23.3 15.8-34.3l4.7-8.1c6.6-11 14-21.4 22.1-31.2c5.9-7.2 15.7-9.6 24.5-6.8l55.7 17.7c13.4-10.3 28.2-18.9 44-25.4l12.5-57.1c2-9.1 9-16.3 18.2-17.8C227.3 1.2 241.5 0 256 0s28.7 1.2 42.5 3.5c9.2 1.5 16.2 8.7 18.2 17.8l12.5 57.1c15.8 6.5 30.6 15.1 44 25.4l55.7-17.7c8.8-2.8 18.6-.3 24.5 6.8c8.1 9.8 15.5 20.2 22.1 31.2l4.7 8.1c6.1 11 11.4 22.4 15.8 34.3zM256 336a80 80 0 1 0 0-160 80 80 0 1 0 0 160z"/></svg>`,
};
const LEFT_TAB_LABEL = { manuscript: "Manuscript layout", bible: "Story Bible", book: "Book settings" };

function renderLeftPanel() {
  if (state.view === "overview") {
    leftPanelEl.style.display = "none";
    leftHandleEl.style.display = "none";
    leftPanelEl.innerHTML = "";
    return;
  }
  leftPanelEl.style.display = "";

  if (!state.leftOpen) {
    leftPanelEl.style.width = "40px";
    leftPanelEl.style.padding = "16px 0 0";
    leftHandleEl.style.display = "none";
    leftPanelEl.innerHTML = `<button class="collapsed-tab left-collapsed" id="leftShow">&rsaquo; Book Details</button>`;
    document.getElementById("leftShow").onclick = openLeftFromCollapsed;
    return;
  }

  leftPanelEl.style.width = state.leftWidth + "px";
  leftPanelEl.style.padding = "16px 10px";
  leftHandleEl.style.display = "";

  let body = "";
  if (state.leftTab === "manuscript") {
    const bookTitleHtml = `<div class="book-tree-title">${escapeHtml(data.title || "Untitled Book")}</div>`;
    const chaptersHtml = data.chapters
      .map((ch) => {
        const isActiveChapter = ch.id === state.activeChapterId;
        const chapterActive = isActiveChapter ? "current" : "";
        const scenesHtml = ch.scenes
          .map((sc) => {
            const isActiveScene = sc.id === state.activeSceneId;
            const cls = isActiveScene ? "current" : "";
            return `<div class="scene-row ${cls}" data-chapter-id="${ch.id}" data-scene-id="${sc.id}"><span>${escapeHtml(sceneLabel(ch, sc))}</span></div>`;
          })
          .join("");
        return `<div class="chapter-block"><div class="chapter-name ${chapterActive}" data-chapter-id="${ch.id}">${escapeHtml(chapterLabel(ch))}</div>${scenesHtml}</div>`;
      })
      .join("");
    body = bookTitleHtml + chaptersHtml;
  } else if (state.leftTab === "bible") {
    const tabs = ["characters", "locations", "concepts"];
    const tabLabels = { characters: "Characters", locations: "Locations", concepts: "Concepts" };
    const tabsHtml = tabs
      .map((t) => `<button class="tbtn ${state.bibleTab === t ? "active" : ""}" data-bible-tab="${t}">${tabLabels[t]}</button>`)
      .join("");

    const kindMap = { characters: "character", locations: "location", concepts: "concept" };
    const kind = kindMap[state.bibleTab];
    const arr = bibleArrayFor(kind);
    const cardsHtml = arr
      .map(
        (item) => `
      <div class="bible-card" data-bible-kind="${kind}" data-bible-id="${item.id}">
        <div class="name">${escapeHtml(item.name)}</div>
        <div class="desc">${escapeHtml(item.desc)}</div>
        <span class="edit-icon">&#9998;</span>
      </div>`
      )
      .join("");

    body = `
      <div class="bible-tabs">${tabsHtml}</div>
      <div class="bible-list">
        ${cardsHtml}
        <button class="dashed-btn" data-action="add-bible" data-bible-kind="${kind}"><span>+</span><span>Add ${bibleLabel(kind)}</span></button>
      </div>
    `;
  } else {
    body = `
      <div class="book-tab">
        <div class="settings-section">
          <div class="section-label">Book Details</div>
          <div class="settings-actions-row">
            <input type="text" id="bookTitleInput" placeholder="Untitled Book" style="flex:1;min-width:160px;margin-top:0" value="${escapeHtml(data.title || "")}">
            <button class="modal-btn done" id="bookTitleSave">Save</button>
          </div>
          <div id="bookTitleStatus" class="settings-status"></div>
        </div>

        <div class="section-label" style="margin-top:24px">Export</div>
        <div class="settings-status" style="margin:0 0 10px">Download the full manuscript as a nicely formatted PDF.</div>
        <button class="tbtn" data-action="export-manuscript">Export PDF</button>
        <div class="settings-status" style="margin:10px 0 10px">Download the full manuscript as an EPUB e-book file.</div>
        <button class="tbtn" data-action="export-epub">Export EPUB</button>

        <div class="section-label" style="margin-top:24px">Import</div>
        <div class="settings-status" style="margin:0 0 10px">Import a manuscript from Markdown.</div>
        <button class="tbtn" data-action="import-manuscript">Import from Markdown</button>
        <input type="file" id="importMdFile" accept=".md,.markdown,text/markdown" style="display:none">
        <div id="importStatus" class="settings-status"></div>

        <div class="section-label" style="margin-top:24px">Danger Zone</div>
        <button class="tbtn" id="deleteBookBtn">Delete Book&hellip;</button>
        <div id="deleteBookConfirmRow" class="settings-status" style="display:none">
          This permanently deletes &ldquo;${escapeHtml(data.title || "Untitled Book")}&rdquo; — every chapter, scene, and
          story bible entry — from this device. If GitHub sync is set up, any files already pushed there are left
          untouched. This cannot be undone.
          <div class="settings-actions-row" style="margin-top:8px">
            <button class="modal-btn delete" id="deleteBookConfirm">Yes, Delete Book</button>
            <button class="tbtn" id="deleteBookCancel">Cancel</button>
          </div>
        </div>
      </div>
    `;
  }

  leftPanelEl.innerHTML = `
    <div class="left-head">
      <div class="left-tabs">
        ${["manuscript", "bible", "book"]
          .map((tab) => {
            const active = state.leftTab === tab;
            return `<button class="tbtn ${active ? "active" : ""}" data-left-tab="${tab}" title="${LEFT_TAB_LABEL[tab]}">${LEFT_TAB_ICON[tab]}${active ? `<span class="tab-label">${LEFT_TAB_LABEL[tab]}</span>` : ""}</button>`;
          })
          .join("")}
      </div>
      <button class="panel-collapse-btn" id="leftHide" title="Collapse panel">&lsaquo;</button>
    </div>
    ${body}
  `;

  document.getElementById("leftHide").onclick = toggleLeft;
  leftPanelEl.querySelectorAll("[data-left-tab]").forEach((el) => {
    el.onclick = () => setLeftTab(el.dataset.leftTab);
  });
  leftPanelEl.querySelectorAll("[data-bible-tab]").forEach((el) => {
    el.onclick = () => setBibleTab(el.dataset.bibleTab);
  });
  leftPanelEl.querySelectorAll(".scene-row").forEach((el) => {
    el.onclick = () => openScene(el.dataset.chapterId, el.dataset.sceneId);
  });
  leftPanelEl.querySelectorAll(".chapter-name").forEach((el) => {
    el.onclick = () => openChapter(el.dataset.chapterId);
  });
  leftPanelEl.querySelectorAll(".bible-card").forEach((el) => {
    el.onclick = () => openBibleModal(el.dataset.bibleKind, el.dataset.bibleId);
  });
  const addBibleBtn = leftPanelEl.querySelector('[data-action="add-bible"]');
  if (addBibleBtn) addBibleBtn.onclick = () => openBibleModal(addBibleBtn.dataset.bibleKind, null);
  const exportBtnEl = leftPanelEl.querySelector('[data-action="export-manuscript"]');
  if (exportBtnEl) exportBtnEl.onclick = () => exportManuscript(data);
  const exportEpubBtnEl = leftPanelEl.querySelector('[data-action="export-epub"]');
  if (exportEpubBtnEl) exportEpubBtnEl.onclick = () => exportEpub(data);
  const importBtnEl = leftPanelEl.querySelector('[data-action="import-manuscript"]');
  const importFileEl = document.getElementById("importMdFile");
  if (importBtnEl && importFileEl) {
    importBtnEl.onclick = () => importFileEl.click();
    importFileEl.onchange = handleImportMarkdownFile;
  }

  const bookTitleSaveBtn = document.getElementById("bookTitleSave");
  if (bookTitleSaveBtn) {
    bookTitleSaveBtn.onclick = () => {
      handleRenameBook(document.getElementById("bookTitleInput").value);
      const status = document.getElementById("bookTitleStatus");
      if (status) status.textContent = "Saved.";
    };
  }

  const deleteBookBtn = document.getElementById("deleteBookBtn");
  if (deleteBookBtn) {
    deleteBookBtn.onclick = () => {
      document.getElementById("deleteBookConfirmRow").style.display = "block";
      deleteBookBtn.style.display = "none";
    };
  }
  const deleteBookCancelBtn = document.getElementById("deleteBookCancel");
  if (deleteBookCancelBtn) {
    deleteBookCancelBtn.onclick = () => {
      document.getElementById("deleteBookConfirmRow").style.display = "none";
      document.getElementById("deleteBookBtn").style.display = "";
    };
  }
  const deleteBookConfirmBtn = document.getElementById("deleteBookConfirm");
  if (deleteBookConfirmBtn) {
    deleteBookConfirmBtn.onclick = () => handleDeleteBook(state.activeBookId);
  }
}

/* ---- Center panel ---- */

function manuscriptBlockHtml(sc) {
  return `<div class="manuscript-text" contenteditable="true" spellcheck="true" data-scene-id="${sc.id}" data-placeholder="Start writing here..."></div>`;
}

function updateManuscriptEmptyState(el) {
  el.classList.toggle("is-empty", el.textContent.trim() === "");
}

function bindManuscriptBlocks(root) {
  root.querySelectorAll(".manuscript-text[data-scene-id]").forEach((el) => {
    const { scene: sc } = getSceneAndChapter(el.dataset.sceneId);
    if (!sc) return;
    el.innerHTML = sanitizeFormattingHtml(sc.text);
    updateManuscriptEmptyState(el);
    el.addEventListener("input", () => {
      sc.text = sanitizeFormattingHtml(el.innerHTML);
      updateManuscriptEmptyState(el);
      scheduleSave();
      markDirty("scene", sc.id);
    });
    el.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text/plain");
      document.execCommand("insertText", false, text);
    });
    el.addEventListener("focus", () => {
      const { chapter: ch } = getSceneAndChapter(sc.id);
      setActiveScene(ch.id, sc.id);
    });
  });
}

/* ---- Selection toolbar (bold/italic/underline/strikethrough, word count, split) ---- */

let selectionToolbarEl;

function getManuscriptSelectionInfo() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const endEl = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
  const startBlock = startEl && startEl.closest(".manuscript-text[data-scene-id]");
  const endBlock = endEl && endEl.closest(".manuscript-text[data-scene-id]");
  if (!startBlock || !endBlock || startBlock !== endBlock) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const { chapter: ch, scene: sc } = getSceneAndChapter(startBlock.dataset.sceneId);
  if (!sc) return null;
  return { el: startBlock, chapter: ch, scene: sc, range, text };
}

/** Splits an element's live selection Range into the HTML/text that comes before it,
 *  the selection itself, and what comes after — all within that single element. */
function extractRangeParts(el, range) {
  const beforeRange = document.createRange();
  beforeRange.setStart(el, 0);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const beforeDiv = document.createElement("div");
  beforeDiv.appendChild(beforeRange.cloneContents());

  const afterRange = document.createRange();
  afterRange.setStart(range.endContainer, range.endOffset);
  afterRange.setEnd(el, el.childNodes.length);
  const afterDiv = document.createElement("div");
  afterDiv.appendChild(afterRange.cloneContents());

  const selectedDiv = document.createElement("div");
  selectedDiv.appendChild(range.cloneContents());

  return {
    beforeHtml: sanitizeFormattingHtml(beforeDiv.innerHTML),
    beforeText: beforeDiv.textContent,
    selectedHtml: sanitizeFormattingHtml(selectedDiv.innerHTML),
    selectedText: selectedDiv.textContent,
    afterHtml: sanitizeFormattingHtml(afterDiv.innerHTML),
    afterText: afterDiv.textContent,
  };
}

function applyFormatting(cmd) {
  const info = getManuscriptSelectionInfo();
  if (!info) return;
  document.execCommand(cmd);
  info.scene.text = sanitizeFormattingHtml(info.el.innerHTML);
  scheduleSave();
  markDirty("scene", info.scene.id);
  const refreshed = getManuscriptSelectionInfo();
  if (refreshed) showSelectionToolbar(refreshed);
  else hideSelectionToolbar();
}

function handleSplitClick() {
  const info = getManuscriptSelectionInfo();
  if (!info) return;
  const parts = extractRangeParts(info.el, info.range);
  if (!parts.selectedText.trim()) return;
  const hasBefore = !!parts.beforeText.trim();
  const hasAfter = !!parts.afterText.trim();
  if (!hasBefore && !hasAfter) return; // whole scene selected, nothing to split

  if (hasBefore && hasAfter) {
    // Genuinely in the middle — text survives on both sides, so this is a 3-way split.
    state.splitConfirm = {
      chapterId: info.chapter.id,
      sceneId: info.scene.id,
      beforeHtml: parts.beforeHtml,
      selectedHtml: parts.selectedHtml,
      afterHtml: parts.afterHtml,
    };
    hideSelectionToolbar();
    renderModal();
  } else if (hasAfter) {
    // Selection starts at the very beginning of the scene (nothing before it) — a clean 2-way
    // split, just like the "selection at the end" case below, but mirrored: this scene keeps
    // the selected (opening) text and the remainder becomes the new next scene.
    performSplit(info.chapter.id, info.scene.id, parts.selectedHtml, parts.afterHtml, null);
  } else {
    performSplit(info.chapter.id, info.scene.id, parts.beforeHtml, parts.selectedHtml, null);
  }
}

function performSplit(chapterId, sceneId, beforeHtml, selectedHtml, afterHtml) {
  const ch = getChapter(chapterId);
  const sc = ch && ch.scenes.find((s) => s.id === sceneId);
  if (!ch || !sc) return;

  sc.text = beforeHtml;
  const idx = ch.scenes.indexOf(sc);
  const newScenes = [scene("Untitled Scene", selectedHtml, "", [])];
  if (afterHtml !== null) newScenes.push(scene("Untitled Scene", afterHtml, "", []));
  ch.scenes.splice(idx + 1, 0, ...newScenes);

  scheduleSave();
  markDirty("scene", sc.id);
  newScenes.forEach((s) => markDirty("scene", s.id));
  markDirty("manifest", getActiveBookId());

  setActiveSceneState(ch.id, newScenes[0].id);
  hideSelectionToolbar();
  render();
  focusSceneText(newScenes[0].id);
}

function closeSplitConfirm() {
  state.splitConfirm = null;
  renderModal();
}

function positionSelectionToolbar(rect) {
  const tbRect = selectionToolbarEl.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tbRect.width / 2;
  left = clamp(left, 8, window.innerWidth - tbRect.width - 8);
  let top = rect.top - tbRect.height - 10;
  if (top < 8) top = rect.bottom + 10;
  selectionToolbarEl.style.left = left + "px";
  selectionToolbarEl.style.top = top + "px";
}

function showSelectionToolbar(info) {
  const rect = info.range.getBoundingClientRect();
  const parts = extractRangeParts(info.el, info.range);
  const words = wordCount(info.text);
  const canSplit = !!(parts.beforeText.trim() || parts.afterText.trim());

  selectionToolbarEl.innerHTML = `
    <button class="stbtn ${document.queryCommandState("bold") ? "active" : ""}" data-cmd="bold" title="Bold"><b>B</b></button>
    <button class="stbtn ${document.queryCommandState("italic") ? "active" : ""}" data-cmd="italic" title="Italic"><i>I</i></button>
    <button class="stbtn ${document.queryCommandState("underline") ? "active" : ""}" data-cmd="underline" title="Underline"><u>U</u></button>
    <button class="stbtn ${document.queryCommandState("strikeThrough") ? "active" : ""}" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
    <span class="st-divider"></span>
    <span class="st-wordcount">${words} word${words === 1 ? "" : "s"} selected</span>
    ${canSplit ? `<span class="st-divider"></span><button class="st-split-btn" data-action="split-scene">Split into next scene</button>` : ""}
  `;
  selectionToolbarEl.style.display = "flex";
  positionSelectionToolbar(rect);

  selectionToolbarEl.querySelectorAll(".stbtn").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => applyFormatting(btn.dataset.cmd));
  });
  const splitBtn = selectionToolbarEl.querySelector('[data-action="split-scene"]');
  if (splitBtn) {
    splitBtn.addEventListener("mousedown", (e) => e.preventDefault());
    splitBtn.addEventListener("click", handleSplitClick);
  }
}

function hideSelectionToolbar() {
  selectionToolbarEl.style.display = "none";
}

function handleSelectionChange() {
  const info = getManuscriptSelectionInfo();
  if (!info) { hideSelectionToolbar(); return; }
  showSelectionToolbar(info);
}

let selectionScrollRaf = null;

/** The toolbar is `position:fixed`, so its top/left are only ever set once, at show time, from
 *  the selection's viewport-relative rect (see positionSelectionToolbar) — scrolling the center
 *  panel moves the underlying text without moving the toolbar, leaving it hovering over the
 *  wrong line. Previously this was "solved" by hiding the toolbar on every scroll, but that also
 *  killed it the instant a long drag-select auto-scrolled the panel, making it impossible to
 *  select anything longer than a screenful. Reposition instead: the Range itself hasn't changed,
 *  only its rect (getBoundingClientRect is always live), so just re-read that and move the
 *  toolbar to match. Only hide if the selection is actually gone. rAF-throttled like the
 *  scroll-spy above — scroll fires far more often than a reposition needs to happen. */
function handleSelectionScroll() {
  if (selectionToolbarEl.style.display === "none") return;
  if (selectionScrollRaf !== null) return;
  selectionScrollRaf = requestAnimationFrame(() => {
    selectionScrollRaf = null;
    const info = getManuscriptSelectionInfo();
    if (!info) { hideSelectionToolbar(); return; }
    positionSelectionToolbar(info.range.getBoundingClientRect());
  });
}

function addChapterSceneButtons() {
  return `
    <div class="actions-row">
      <button class="dashed-btn" data-action="add-scene"><span>+</span><span>Add Scene</span></button>
      <button class="dashed-btn" data-action="add-chapter"><span>+</span><span>Add Chapter</span></button>
    </div>
  `;
}

function bindActionButtons(root) {
  const addSceneBtn = root.querySelector('[data-action="add-scene"]');
  if (addSceneBtn) addSceneBtn.onclick = addScene;
  const addChapterBtn = root.querySelector('[data-action="add-chapter"]');
  if (addChapterBtn) addChapterBtn.onclick = addChapter;
}

function chapterStickyInner(ch) {
  return `<span class="col"><span class="chapter-num">Chapter ${chapterNumber(ch)}</span><span class="chapter-title-text" contenteditable="true" data-chapter-id="${ch.id}"></span></span>`;
}

/** Full-manuscript mode's marker for "a new chapter starts here" — sits inline in the normal
 *  document flow (not sticky) right above that chapter's first scene, so scrolling past it is
 *  obviously a chapter break rather than just another scene. Editable via the same
 *  data-chapter-id/contenteditable wiring as chapterStickyInner (bindChapterStickyHeaders picks
 *  up any matching element), so renaming works here same as in Chapter mode. */
function chapterHeadingInlineHtml(ch) {
  return `<div class="chapter-heading-inline"><span class="chapter-num">Chapter ${chapterNumber(ch)}</span><span class="chapter-title-text" contenteditable="true" data-chapter-id="${ch.id}"></span></div>`;
}

/** Editable via the same data-chapter-id/contenteditable wiring as chapterStickyInner — the
 *  first chapter's inline heading is deliberately skipped (see chaptersHtml below), so this
 *  banner is the only place its title can be renamed while in Full-manuscript mode.
 *  syncFullChapterBanner guards against replacing this element's innerHTML while its title is
 *  focused, so typing here doesn't blow away the cursor mid-edit. */
function chapterBannerInner(ch) {
  return `<span class="col"><span class="chapter-num">Chapter ${chapterNumber(ch)}</span><span class="chapter-title-text" contenteditable="true" data-chapter-id="${ch.id}"></span></span>`;
}

/** Full-manuscript mode shows one persistent sticky banner for "whichever chapter you're
 *  currently reading" instead of stacking a .chapter-sticky per chapter, or repeating a heading
 *  inline at each chapter's own start:
 *  - Stacked sticky headers (one per chapter) hand off with a gap roughly equal to their own
 *    height — an unavoidable property of CSS position:sticky, not fixable with spacing tweaks.
 *  - A banner shown *alongside* a per-chapter inline heading duplicates "Chapter N" text
 *    whenever both are on-screen together, and toggling the banner's visibility to dodge that
 *    makes it stop being sticky right when you'd expect it least (see git history — tried both).
 *  One element, always visible, always stuck from the very first frame, sidesteps all of it:
 *  there's nothing for it to hand off to or duplicate, so its text just updates in place as
 *  state.activeChapterId changes. */
function syncFullChapterBanner() {
  if (state.view !== "full") return;
  const banner = document.getElementById("fullChapterBanner");
  const ch = getChapter(state.activeChapterId);
  if (!banner || !ch) return;
  // Don't clobber the banner's own title field while the user is typing in it — its "input"
  // listener (bindChapterStickyHeaders) calls back into this function on every keystroke.
  if (banner.contains(document.activeElement)) return;
  banner.innerHTML = chapterBannerInner(ch);
  bindChapterStickyHeaders(banner);
}

function syncChapterTitleDisplays(chapterId) {
  const ch = getChapter(chapterId);
  if (!ch) return;
  const nameEl = leftPanelEl.querySelector(`.chapter-name[data-chapter-id="${chapterId}"]`);
  if (nameEl) nameEl.textContent = chapterLabel(ch);
  if (state.activeChapterId === chapterId) syncFullChapterBanner();
}

/** Scrolls the left-panel manuscript tree so the current chapter/scene row is in view — used on
 *  initial load, where render() draws the tree at its default scroll position (top) regardless
 *  of which chapter/scene was actually restored as active. */
function scrollLeftPanelToCurrent() {
  const el = leftPanelEl.querySelector(".scene-row.current") || leftPanelEl.querySelector(".chapter-name.current");
  if (el) el.scrollIntoView({ block: "nearest" });
}

function bindChapterStickyHeaders(root) {
  root.querySelectorAll(".chapter-title-text[data-chapter-id]").forEach((el) => {
    const ch = getChapter(el.dataset.chapterId);
    if (!ch) return;
    el.textContent = ch.title;
    el.addEventListener("input", () => {
      ch.title = el.innerText;
      scheduleSave();
      markDirty("manifest", getActiveBookId());
      syncChapterTitleDisplays(ch.id);
    });
  });
}

function renderCenter() {
  if (state.view === "settings") {
    renderSettingsView(centerPanelEl, {
      onBack: () => { state.view = "scene"; render(); },
      notifyBookDataChanged: async (bookId) => {
        if (bookId !== state.activeBookId) return;
        await loadBook(bookId);
        renderLeftPanel();
        renderRightPanel();
      },
      // Lets settings-ui.js refresh the topbar badge/conflict banner the moment a conflict is
      // resolved or a manual sync finishes, instead of leaving the stale banner up until the
      // next 20s tick or a full re-render (e.g. navigating back to the manuscript).
      onSyncStatusChanged: refreshSyncStatusUI,
    });
    return;
  }

  if (state.view === "overview") {
    renderOverviewView(centerPanelEl, {
      onOpenChapter: openChapter,
      onOpenScene: openScene,
      highlightTodos: state.overviewHighlightTodos,
      onToggleHighlightTodos: () => {
        state.overviewHighlightTodos = !state.overviewHighlightTodos;
        renderCenter();
      },
    });
    return;
  }

  let html = "";

  if (state.view === "scene") {
    const { chapter: ch, scene: sc } = getSceneAndChapter(state.activeSceneId);
    if (sc) {
      html = `
        <div class="scene-eyebrow active" data-highlight-scene-id="${sc.id}">${escapeHtml(chapterLabel(ch).toUpperCase())} &nbsp;&middot;&nbsp; ${escapeHtml(sceneLabel(ch, sc).toUpperCase())}</div>
        ${manuscriptBlockHtml(sc)}
        ${addChapterSceneButtons()}
      `;
    } else {
      html = `<div class="no-scene">No scene selected.</div>${addChapterSceneButtons()}`;
    }
  } else if (state.view === "chapter") {
    const ch = getChapter(state.activeChapterId) || data.chapters[0];
    const scenesHtml = ch.scenes
      .map(
        (sc) => `
      <div class="scene-block">
        <div class="scene-sticky ${sc.id === state.activeSceneId ? "active" : ""}" data-highlight-scene-id="${sc.id}"><span class="col">${escapeHtml(sceneLabel(ch, sc))}</span></div>
        ${manuscriptBlockHtml(sc)}
      </div>`
      )
      .join("");
    html = `
      <div class="chapter-sticky">${chapterStickyInner(ch)}</div>
      ${scenesHtml}
      ${addChapterSceneButtons()}
    `;
  } else {
    // full — a persistent #fullChapterBanner (sticky) shows "whichever chapter you're
    // currently reading" per state.activeChapterId, updated on scroll (see
    // syncFullChapterBanner). Every chapter after the first also gets its own inline heading
    // (chapterHeadingInlineHtml), in normal flow, right above its first scene — that's what
    // makes a chapter break visible as you scroll past it. The first chapter skips it: the
    // banner already reads that chapter's name from the very top of the page, before any
    // scrolling, so a second copy right underneath it would just be a duplicate.
    const bannerChapter = getChapter(state.activeChapterId) || data.chapters[0];
    const chaptersHtml = data.chapters
      .map(
        (ch, i) => `
      <div class="chapter-group">
        ${i > 0 ? chapterHeadingInlineHtml(ch) : ""}
        ${ch.scenes
          .map(
            (sc) => `
          <div class="scene-block">
            <div class="scene-sticky ${sc.id === state.activeSceneId ? "active" : ""}" data-highlight-scene-id="${sc.id}"><span class="col">${escapeHtml(sceneLabel(ch, sc))}</span></div>
            ${manuscriptBlockHtml(sc)}
          </div>`
          )
          .join("")}
      </div>`
      )
      .join("");
    html = `
      <div class="doc-title">${escapeHtml(data.title || "Untitled Book")} — Full Manuscript</div>
      ${bannerChapter ? `<div class="chapter-sticky" id="fullChapterBanner">${chapterBannerInner(bannerChapter)}</div>` : ""}
      ${chaptersHtml}
      ${addChapterSceneButtons()}
    `;
  }

  centerPanelEl.innerHTML = html;
  bindManuscriptBlocks(centerPanelEl);
  bindChapterStickyHeaders(centerPanelEl);
  bindActionButtons(centerPanelEl);
}

/* ---- Right panel ---- */

function renderRightPanel() {
  if (state.view === "overview") {
    rightPanelEl.style.display = "none";
    rightHandleEl.style.display = "none";
    rightPanelEl.innerHTML = "";
    return;
  }
  rightPanelEl.style.display = "";

  if (!state.rightOpen) {
    rightPanelEl.style.width = "40px";
    rightPanelEl.style.padding = "16px 0 0";
    rightHandleEl.style.display = "none";
    rightPanelEl.innerHTML = `<button class="collapsed-tab" id="rightShow">&lsaquo; Scene Details</button>`;
    document.getElementById("rightShow").onclick = toggleRight;
    return;
  }

  rightPanelEl.style.width = state.rightWidth + "px";
  rightPanelEl.style.padding = "20px";
  rightHandleEl.style.display = "";

  const { chapter: ch, scene: sc } = getSceneAndChapter(state.activeSceneId);

  if (!sc) {
    rightPanelEl.innerHTML = `
      <div class="right-head">
        <button class="panel-collapse-btn" id="rightHide" title="Collapse panel">&rsaquo;</button>
        <span class="right-label">Scene Details</span>
      </div>
      <div class="no-scene">Click into a scene's text to see its details here.</div>
    `;
    document.getElementById("rightHide").onclick = toggleRight;
    return;
  }

  const todosHtml = sc.todos
    .map(
      (t) => `
    <div class="todo-row ${t.done ? "done" : ""}">
      <span class="chk ${t.done ? "checked" : ""}" data-action="toggle-todo" data-todo-id="${t.id}">${t.done ? "&#10003;" : ""}</span>
      <span class="todo-text" contenteditable="true" data-todo-id="${t.id}"></span>
      <button class="todo-del" data-action="delete-todo" data-todo-id="${t.id}">&times;</button>
    </div>`
    )
    .join("");

  rightPanelEl.innerHTML = `
    <div class="right-head">
      <button class="panel-collapse-btn" id="rightHide" title="Collapse panel">&rsaquo;</button>
      <span class="right-label">Chapter ${chapterNumber(ch)} - Scene ${sceneNumber(ch, sc)}</span>
    </div>
    <div class="summary-block">
      <div class="section-label">Title</div>
      <div class="summary-text" contenteditable="true" id="sceneTitleText"></div>
    </div>
    <div class="summary-block">
      <div class="section-label">Summary</div>
      <div class="summary-text" contenteditable="true" id="summaryText"></div>
    </div>
    <div class="section-label">To-Do</div>
    ${todosHtml}
    <button class="dashed-btn wide" id="addTodoBtn" style="margin-top:8px"><span>+</span><span>Add To-Do</span></button>
    <button class="delete-scene-btn" id="deleteSceneBtn">Delete Scene</button>
  `;

  document.getElementById("rightHide").onclick = toggleRight;

  const titleEl = document.getElementById("sceneTitleText");
  titleEl.textContent = sc.title;
  titleEl.addEventListener("input", () => {
    sc.title = titleEl.innerText;
    scheduleSave();
    markDirty("scene", sc.id);
    syncSceneTitleDisplays(sc.id);
  });

  const summaryEl = document.getElementById("summaryText");
  summaryEl.textContent = sc.summary;
  summaryEl.addEventListener("input", () => { sc.summary = summaryEl.innerText; scheduleSave(); markDirty("scene", sc.id); });

  rightPanelEl.querySelectorAll(".todo-text").forEach((el) => {
    const t = sc.todos.find((x) => x.id === el.dataset.todoId);
    if (!t) return;
    el.textContent = t.text;
    el.addEventListener("input", () => { t.text = el.innerText; scheduleSave(); markDirty("scene", sc.id); });
  });

  rightPanelEl.querySelectorAll('[data-action="toggle-todo"]').forEach((el) => {
    el.onclick = () => toggleTodo(sc.id, el.dataset.todoId);
  });
  rightPanelEl.querySelectorAll('[data-action="delete-todo"]').forEach((el) => {
    el.onclick = () => deleteTodo(sc.id, el.dataset.todoId);
  });
  document.getElementById("addTodoBtn").onclick = () => addTodo(sc.id);
  document.getElementById("deleteSceneBtn").onclick = () => requestDeleteScene(sc.id);
}

/* ---- Modal ---- */

function renderModal() {
  if (state.deleteSceneConfirm) {
    const sceneId = state.deleteSceneConfirm;
    const { scene: sc } = getSceneAndChapter(sceneId);
    modalRootEl.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal">
          <div class="modal-head">
            <span class="modal-title">Delete scene?</span>
            <button class="modal-close" id="modalClose">&times;</button>
          </div>
          <p class="modal-copy">This will permanently delete <strong>${escapeHtml(sc ? sc.title : "this scene")}</strong>, including its text, summary, and to-dos. This can't be undone.</p>
          <div class="modal-actions">
            <button class="modal-btn cancel" id="modalCancel">Cancel</button>
            <button class="modal-btn delete" id="modalConfirmDelete">Delete Scene</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById("modalClose").onclick = closeDeleteSceneConfirm;
    document.getElementById("modalCancel").onclick = closeDeleteSceneConfirm;
    document.getElementById("modalOverlay").addEventListener("mousedown", (e) => {
      if (e.target.id === "modalOverlay") closeDeleteSceneConfirm();
    });
    document.getElementById("modalConfirmDelete").onclick = () => deleteScene(sceneId);
    return;
  }

  if (state.splitConfirm) {
    const { chapterId, sceneId, beforeHtml, selectedHtml, afterHtml } = state.splitConfirm;
    modalRootEl.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal">
          <div class="modal-head">
            <span class="modal-title">Split into 3 scenes?</span>
            <button class="modal-close" id="modalClose">&times;</button>
          </div>
          <p class="modal-copy">Your selection is in the middle of this scene's text, so there's remaining text on both sides. Splitting will create <strong>two new scenes</strong> — one for the selected text and one for the text after it — while this scene keeps only the text before your selection.</p>
          <div class="modal-actions">
            <button class="modal-btn cancel" id="modalCancel">Cancel</button>
            <button class="modal-btn done" id="modalConfirmSplit">Split into 3 Scenes</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById("modalClose").onclick = closeSplitConfirm;
    document.getElementById("modalCancel").onclick = closeSplitConfirm;
    document.getElementById("modalOverlay").addEventListener("mousedown", (e) => {
      if (e.target.id === "modalOverlay") closeSplitConfirm();
    });
    document.getElementById("modalConfirmSplit").onclick = () => {
      state.splitConfirm = null;
      performSplit(chapterId, sceneId, beforeHtml, selectedHtml, afterHtml);
    };
    return;
  }

  if (state.newBookOpen) {
    modalRootEl.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal">
          <div class="modal-head">
            <span class="modal-title">New Book</span>
            <button class="modal-close" id="modalClose">&times;</button>
          </div>
          <label>Title</label>
          <input type="text" id="newBookTitle" placeholder="Untitled Book">
          <div class="modal-actions">
            <button class="modal-btn done" id="newBookCreate">Create</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById("modalClose").onclick = closeNewBookModal;
    document.getElementById("modalOverlay").addEventListener("mousedown", (e) => {
      if (e.target.id === "modalOverlay") closeNewBookModal();
    });
    document.getElementById("newBookCreate").onclick = handleCreateBook;
    document.getElementById("newBookTitle").focus();
    return;
  }

  if (!state.bibleEdit) {
    modalRootEl.innerHTML = "";
    return;
  }
  const { kind, id } = state.bibleEdit;
  const arr = bibleArrayFor(kind);
  const item = id ? arr.find((x) => x.id === id) : null;
  const label = bibleLabel(kind);

  modalRootEl.innerHTML = `
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal">
        <div class="modal-head">
          <span class="modal-title">${item ? "Edit" : "Add"} ${label}</span>
          <button class="modal-close" id="modalClose">&times;</button>
        </div>
        <label>Name</label>
        <input type="text" id="bibleEditName">
        <label>Description</label>
        <textarea id="bibleEditDesc"></textarea>
        <div class="modal-actions">
          ${item ? `<button class="modal-btn delete" id="modalDelete">Delete</button>` : ""}
          <button class="modal-btn done" id="modalDone">Done</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("bibleEditName").value = item ? item.name : "";
  document.getElementById("bibleEditDesc").value = item ? item.desc : "";

  document.getElementById("modalClose").onclick = closeBibleModal;
  document.getElementById("modalOverlay").addEventListener("mousedown", (e) => {
    if (e.target.id === "modalOverlay") closeBibleModal();
  });
  document.getElementById("modalDone").onclick = saveBibleModal;
  const delBtn = document.getElementById("modalDelete");
  if (delBtn) delBtn.onclick = deleteBibleItem;
}

/* ---------------------------------------------------------------- */
/* Panel resize dragging                                             */
/* ---------------------------------------------------------------- */

function setupResize(handleEl, panelEl, { side, min, max }) {
  handleEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handleEl.classList.add("dragging");
    const startRect = panelEl.getBoundingClientRect();
    document.body.style.userSelect = "none";

    function onMove(ev) {
      let width;
      if (side === "left") width = ev.clientX - startRect.left;
      else width = startRect.right - ev.clientX;
      width = clamp(width, min, max);
      panelEl.style.width = width + "px";
      if (side === "left") state.leftWidth = width;
      else state.rightWidth = width;
    }
    function onUp() {
      handleEl.classList.remove("dragging");
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      persistUiPrefs();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/* ---------------------------------------------------------------- */
/* Init                                                               */
/* ---------------------------------------------------------------- */

export function initApp() {
  app = document.getElementById("app");
  app.innerHTML = `
    <div class="topbar" id="topbar"></div>
    <div class="setup-banner" id="setupBanner" style="display:none"></div>
    <div class="conflict-banner" id="conflictBanner" style="display:none"></div>
    <div class="setup-banner" id="pullBanner" style="display:none"></div>
    <div class="main">
      <div class="left-panel" id="leftPanel"></div>
      <div class="resize-handle" id="leftHandle"><div class="resize-line"></div></div>
      <div class="center-panel" id="centerPanel"></div>
      <div class="resize-handle right" id="rightHandle"><div class="resize-line"></div></div>
      <div class="right-panel" id="rightPanel"></div>
    </div>
    <div id="modalRoot"></div>
    <div class="selection-toolbar" id="selectionToolbar" style="display:none"></div>
  `;

  topbarEl = document.getElementById("topbar");
  leftPanelEl = document.getElementById("leftPanel");
  leftHandleEl = document.getElementById("leftHandle");
  centerPanelEl = document.getElementById("centerPanel");
  rightHandleEl = document.getElementById("rightHandle");
  rightPanelEl = document.getElementById("rightPanel");
  modalRootEl = document.getElementById("modalRoot");
  selectionToolbarEl = document.getElementById("selectionToolbar");

  setupResize(leftHandleEl, leftPanelEl, { side: "left", min: 160, max: 420 });
  setupResize(rightHandleEl, rightPanelEl, { side: "right", min: 220, max: 460 });

  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* unsupported in some browsers, non-fatal */ }
  document.addEventListener("selectionchange", handleSelectionChange);
  centerPanelEl.addEventListener("scroll", handleSelectionScroll);
  centerPanelEl.addEventListener("scroll", handleCenterScrollSpy);

  render();
  // render() draws the center panel and left-panel tree at their default (top) scroll position —
  // neither knows to jump to the chapter/scene that was actually restored as active, so do that
  // explicitly here, same as setViewMode does when switching into Full/Chapter mode.
  if ((state.view === "full" || state.view === "chapter") && state.activeSceneId) {
    focusSceneText(state.activeSceneId, { focusText: false });
  }
  requestAnimationFrame(scrollLeftPanelToCurrent);

  // Keeps "Synced Xs/m/h ago" ticking and the conflict banner current between actions,
  // independent of the (much less frequent) actual background sync network calls.
  setInterval(refreshSyncStatusUI, 20000);
}

export { refreshSyncStatusUI };

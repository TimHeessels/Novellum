"use strict";

import { dbGet, dbGetAllByIndex, dbGetAll, dbPut, dbReplaceWhereIndex, dbDelete } from "./db.js";
import { data, getSceneAndChapter } from "./model.js";

export const DEFAULT_BOOK_ID = "book-default";

const SAVE_DEBOUNCE_MS = 800;
let saveTimer = null;
let activeBookId = null;

export function setActiveBookId(id) {
  activeBookId = id;
}

export function getActiveBookId() {
  return activeBookId;
}

/** All known books, oldest-created first (stable order for the switcher). */
export async function listBooks() {
  const books = await dbGetAll("books");
  return books.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

/** Loads one book's chapters/scenes/bible into the in-memory `data` object. Does not change activeBookId. */
export async function loadBook(bookId) {
  const [bookRow, chapters, scenes, bibleEntries] = await Promise.all([
    dbGet("books", bookId),
    dbGetAllByIndex("chapters", "bookId", bookId),
    dbGetAllByIndex("scenes", "bookId", bookId),
    dbGetAllByIndex("bibleEntries", "bookId", bookId),
  ]);
  data.title = bookRow ? bookRow.title : "Untitled Book";
  hydrateDataFromRows({ chapters, scenes, bibleEntries });
}

function hydrateBibleFromRows(bibleEntries) {
  const toBibleItem = (row) => ({ id: row.id, name: row.name, desc: row.desc });
  const byKind = (kind) =>
    bibleEntries.filter((b) => b.kind === kind).sort((a, b) => a.order - b.order).map(toBibleItem);

  data.characters = byKind("character");
  data.locations = byKind("location");
  data.concepts = byKind("concept");
}

function hydrateDataFromRows({ chapters, scenes, bibleEntries }) {
  const scenesByChapter = new Map();
  for (const sc of scenes.slice().sort((a, b) => a.order - b.order)) {
    if (!scenesByChapter.has(sc.chapterId)) scenesByChapter.set(sc.chapterId, []);
    scenesByChapter.get(sc.chapterId).push({
      id: sc.id, title: sc.title, text: sc.text, summary: sc.summary, todos: sc.todos,
    });
  }

  data.chapters = chapters
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((ch) => ({ id: ch.id, title: ch.title, scenes: scenesByChapter.get(ch.id) || [] }));

  hydrateBibleFromRows(bibleEntries);
}

/**
 * Applies a sync pull to `data` without disturbing anything the pull didn't actually touch.
 * loadBook() rebuilds the whole book from IndexedDB, which is fine right after a pull if nothing
 * else is happening — but a background auto-sync pull can land while the user is still actively
 * typing in some *other* scene, and that scene's latest keystrokes may only exist in `data` (the
 * 800ms save debounce hasn't flushed them to IndexedDB yet). A full loadBook() at that moment
 * would silently revert those unsaved keystrokes to whatever's in IndexedDB. Merging in just the
 * pulled targets (`"manifest:<bookId>" | "bible:<bookId>" | "scene:<id>"`, from
 * reconcileBook's `pulledTargets`) leaves every other scene's in-memory object untouched.
 */
export async function mergePulledIntoData(bookId, pulledTargets) {
  if (!pulledTargets || pulledTargets.size === 0) return;

  if (pulledTargets.has(`manifest:${bookId}`)) {
    // Chapter/scene structure (adds, deletes, reorders, brand-new scenes pulled in whole) is
    // rare and, unlike a same-scene content edit, can't be patched onto `data` piecemeal — it
    // has to be re-derived from the whole tree, so this one case still falls back to a full
    // reload.
    await loadBook(bookId);
    return;
  }

  if (pulledTargets.has(`bible:${bookId}`)) {
    const bibleEntries = await dbGetAllByIndex("bibleEntries", "bookId", bookId);
    hydrateBibleFromRows(bibleEntries);
  }

  for (const target of pulledTargets) {
    if (!target.startsWith("scene:")) continue;
    const sceneId = target.slice("scene:".length);
    const row = await dbGet("scenes", sceneId);
    const { scene: sc } = getSceneAndChapter(sceneId);
    if (!row || !sc) continue;
    sc.title = row.title;
    sc.text = row.text;
    sc.summary = row.summary;
    sc.todos = row.todos;
  }
}

async function flattenDataToRows(bookId) {
  const now = new Date().toISOString();
  const [existing, existingScenes] = await Promise.all([
    dbGet("books", bookId),
    dbGetAllByIndex("scenes", "bookId", bookId),
  ]);
  const bookRow = { id: bookId, title: data.title, createdAt: existing?.createdAt || now, updatedAt: now };

  const existingSceneById = new Map(existingScenes.map((s) => [s.id, s]));

  const chapterRows = data.chapters.map((ch, i) => ({
    id: ch.id, bookId, title: ch.title, order: i, updatedAt: now,
  }));

  // Note: no `remoteSha` here — that's sync-engine.js's bookkeeping, kept in its own "sceneSync"
  // store precisely so this full read-modify-write of "scenes" (on every debounced local save)
  // can never race with and clobber a sha a concurrent push just recorded. See db.js.
  const sceneRows = [];
  data.chapters.forEach((ch) => {
    ch.scenes.forEach((sc, i) => {
      const prev = existingSceneById.get(sc.id);
      // updatedAt is embedded in the pushed scene markdown (sceneToMarkdown), so it must only
      // change when this scene's own content actually changed — otherwise saving after editing
      // ANY scene in the book would bump every other scene's updatedAt too (this used to run
      // unconditionally on every save), producing a different file every push even when nothing
      // about that scene changed, which GitHub sees as a real conflict against its last-known sha.
      const contentChanged = !prev
        || prev.title !== sc.title
        || prev.summary !== sc.summary
        || prev.text !== sc.text
        || JSON.stringify(prev.todos) !== JSON.stringify(sc.todos);
      sceneRows.push({
        id: sc.id, bookId, chapterId: ch.id, order: i,
        title: sc.title, summary: sc.summary, text: sc.text, todos: sc.todos,
        updatedAt: contentChanged ? now : prev.updatedAt,
      });
    });
  });

  const bibleRows = [
    ...data.characters.map((c, i) => ({ ...c, bookId, kind: "character", order: i, updatedAt: now })),
    ...data.locations.map((c, i) => ({ ...c, bookId, kind: "location", order: i, updatedAt: now })),
    ...data.concepts.map((c, i) => ({ ...c, bookId, kind: "concept", order: i, updatedAt: now })),
  ];

  return { bookRow, chapterRows, sceneRows, bibleRows };
}

/** Writes the in-memory `data` snapshot for the active book to IndexedDB immediately (no debounce). */
export async function persistNow() {
  if (!activeBookId) return;
  const { bookRow, chapterRows, sceneRows, bibleRows } = await flattenDataToRows(activeBookId);
  await Promise.all([
    dbPut("books", bookRow),
    dbReplaceWhereIndex("chapters", "bookId", activeBookId, chapterRows),
    dbReplaceWhereIndex("scenes", "bookId", activeBookId, sceneRows),
    dbReplaceWhereIndex("bibleEntries", "bookId", activeBookId, bibleRows),
  ]);
}

/** Call after any mutation to `data`. Debounces so rapid typing doesn't hammer IndexedDB. */
export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow().catch((err) => console.error("Novellum: local save failed", err));
  }, SAVE_DEBOUNCE_MS);
}

/** Cancels any pending debounce and saves immediately — used on tab hide/close and before switching books. */
export function flushSaveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return persistNow().catch((err) => console.error("Novellum: flush save failed", err));
}

/** Permanently removes a book and everything under it (chapters, scenes, story bible, and all
 *  local sync bookkeeping) from IndexedDB. Local-only: any files already pushed to a connected
 *  GitHub repo are left as-is, same as this app never deletes a repo's history for you elsewhere. */
export async function deleteBook(bookId) {
  if (saveTimer && activeBookId === bookId) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const [outbox, conflicts] = await Promise.all([dbGetAll("outbox"), dbGetAll("conflicts")]);
  await Promise.all([
    dbDelete("books", bookId),
    dbDelete("manifestMeta", bookId),
    dbReplaceWhereIndex("chapters", "bookId", bookId, []),
    dbReplaceWhereIndex("scenes", "bookId", bookId, []),
    dbReplaceWhereIndex("bibleEntries", "bookId", bookId, []),
    dbReplaceWhereIndex("sceneSync", "bookId", bookId, []),
    ...outbox.filter((e) => e.bookId === bookId).map((e) => dbDelete("outbox", e.key)),
    ...conflicts.filter((c) => c.bookId === bookId).map((c) => dbDelete("conflicts", c.key)),
  ]);
  if (activeBookId === bookId) activeBookId = null;
}

/* ---------------------------------------------------------------- */
/* UI preferences (panel widths, last-viewed location) — this is    */
/* purely local browser state, not manuscript content, so it lives  */
/* in localStorage rather than IndexedDB: synchronous, and it has   */
/* no business syncing across devices via GitHub.                   */
/* ---------------------------------------------------------------- */

const UI_PREFS_KEY = "writertool:uiPrefs";

export function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveUiPrefs(prefs) {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable (private browsing, quota) — non-fatal, just don't persist.
  }
}

/* ---------------------------------------------------------------- */
/* Manual backup escape hatch                                       */
/* ---------------------------------------------------------------- */

export function exportDataAsJson() {
  return JSON.stringify(
    {
      title: data.title,
      chapters: data.chapters,
      characters: data.characters,
      locations: data.locations,
      concepts: data.concepts,
    },
    null,
    2
  );
}

export function importDataFromJson(jsonString) {
  const parsed = JSON.parse(jsonString);
  if (!parsed || !Array.isArray(parsed.chapters)) {
    throw new Error("Invalid Novellum export file.");
  }
  data.title = parsed.title || data.title;
  data.chapters = parsed.chapters;
  data.characters = parsed.characters || [];
  data.locations = parsed.locations || [];
  data.concepts = parsed.concepts || [];
  return persistNow();
}

"use strict";

import { data } from "./model.js";

export const state = {
  view: "scene", // 'scene' | 'chapter' | 'full' | 'settings' | 'overview'
  overviewHighlightTodos: false, // dims scene cards with no to-dos when on; resets to off on reload
  viewBeforeOverview: null, // view to restore to when navigating away from an overview click
  leftOpenBeforeOverview: true,
  rightOpenBeforeOverview: true,
  leftOpen: true,
  leftTab: "manuscript", // 'manuscript' | 'bible' | 'book'
  bibleTab: "characters", // 'characters' | 'locations' | 'concepts'
  leftWidth: 260,
  rightOpen: true,
  rightWidth: 290,
  activeChapterId: data.chapters[0].id,
  activeSceneId: data.chapters[0].scenes[0].id,
  lastSceneByChapter: { [data.chapters[0].id]: data.chapters[0].scenes[0].id }, // chapterId -> last-selected sceneId, used to restore context when navigating back to a chapter
  bibleEdit: null, // { kind: 'character'|'location'|'concept', id: string|null }
  activeBookId: null,
  books: [], // [{ id, title, createdAt, updatedAt }]
  bookSwitcherOpen: false,
  newBookOpen: false,
  splitConfirm: null, // { chapterId, sceneId, beforeHtml, selectedHtml, afterHtml }
  deleteSceneConfirm: null, // sceneId
  // Set from `pushResult.pauseReason` after the most recent manual Push click — covers both "no
  // token yet" and "token/repo present but the connection is actually failing" (bad token,
  // renamed/deleted repo, rate limit). Null once a push goes through.
  syncPauseReason: null,
  // Set once, right after a "Sign in with GitHub" redirect lands back on boot() — shown on the
  // settings view's next render, then cleared, rather than persisted.
  oauthLoginError: null,
  // Set after "Connect GitHub" when the install grant covered more than one repo: { repos }.
  // Settings renders this as an explicit "which one is the vault" prompt instead of guessing;
  // cleared once the user picks one.
  pendingOAuthVaultPick: null,
  // Cheap, synchronously-readable mirror of getSyncStatus()'s pendingCount/configured — kept in
  // sync by markDirty() (set true the instant an edit is queued) and refreshSyncStatusUI() (the
  // source of truth, corrects it either way). Exists because main.js's beforeunload handler needs
  // to decide whether to warn without being able to await an IndexedDB read at that point.
  hasPendingSync: false,
  syncConfigured: false,
  // Cached result of the latest read-only checkRemoteChanges() check (see main.js's
  // refreshRemoteChangeCheck, also refreshed by settings-ui.js right after a Settings-driven
  // pull) — drives the pull banner and the sync badge's "Pull N changes" label. Never set by an
  // actual pull directly, only by that check.
  hasRemoteChanges: false,
  remoteChangeCount: 0,
};

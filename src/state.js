"use strict";

import { data } from "./model.js";

export const state = {
  view: "scene", // 'scene' | 'chapter' | 'full' | 'settings' | 'overview'
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
  // Set from `pushResult.pauseReason` after the most recent sync attempt (boot, auto-sync, or a
  // manual Sync Now) — covers both "no token yet" and "token/repo present but the connection is
  // actually failing" (bad token, renamed/deleted repo, rate limit). Null once a sync goes through.
  syncPauseReason: null,
  // Set once, right after a "Sign in with GitHub" redirect lands back on boot() — shown on the
  // settings view's next render, then cleared, rather than persisted.
  oauthLoginError: null,
  // Set after sign-in when the account's default vault repo doesn't exist yet, or exists but
  // isn't a usable vault: { login, blockedReason }. blockedReason is null for "doesn't exist yet"
  // (nothing to explain) and a message for "exists but has other content". Settings renders this
  // as a create-or-choose prompt instead of guessing; cleared once the user resolves it.
  pendingOAuthVaultPick: null,
};

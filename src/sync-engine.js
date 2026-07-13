"use strict";

import { dbGet, dbPut, dbGetAll, dbGetAllByIndex, dbDelete, dbReplaceWhereIndex, dbReplaceAll } from "./db.js";
import { sceneToMarkdown, markdownToScene } from "./model.js";
import { getActiveBookId, flushSaveNow } from "./persistence.js";
import * as gh from "./github-client.js";

const SETTINGS_KEY = "github";

/* ---------------------------------------------------------------- */
/* Settings                                                          */
/* ---------------------------------------------------------------- */

export async function getGithubSettings() {
  return (
    (await dbGet("settings", SETTINGS_KEY)) || {
      token: "", owner: "", repo: "", defaultBranch: "", lastSyncedAt: null,
    }
  );
}

async function patchGithubSettings(patch) {
  const existing = await getGithubSettings();
  await dbPut("settings", { ...existing, key: SETTINGS_KEY, ...patch });
}

export async function saveGithubSettings({ token, owner, repo }) {
  await patchGithubSettings({ token, owner, repo });
}

/** Fully decouples this device from whatever repo it was connected to: clears the saved
 *  token/owner/repo plus every piece of repo-specific sync bookkeeping (shas, conflicts).
 *  The manuscript itself is untouched — reconnecting (to the same repo or a different one)
 *  re-bootstraps from scratch via ensureBookBootstrapped, same as a brand-new install. */
export async function disconnectGithub() {
  await dbPut("settings", {
    key: SETTINGS_KEY, token: "", owner: "", repo: "", defaultBranch: "", lastSyncedAt: null,
  });
  await Promise.all([
    dbReplaceAll("conflicts", []),
    dbReplaceAll("manifestMeta", []),
    dbReplaceAll("sceneSync", []),
  ]);
}

export async function testConnection() {
  const { token, owner, repo } = await getGithubSettings();
  if (!token) throw new Error("No token set.");
  const login = await gh.testToken(token);
  if (!owner || !repo) return { login, repoOk: false };
  const info = await gh.testRepoAccess(token, owner, repo);
  await patchGithubSettings({ defaultBranch: info.defaultBranch });
  return { login, repoOk: true, defaultBranch: info.defaultBranch };
}

export async function createRepoForVault(name) {
  const { token } = await getGithubSettings();
  if (!token) throw new Error("No token set.");
  const { owner, repo } = await gh.createRepo(token, name);
  const info = await gh.testRepoAccess(token, owner, repo);
  await patchGithubSettings({ owner, repo, defaultBranch: info.defaultBranch });
  return { owner, repo };
}

export const DEFAULT_VAULT_REPO_NAME = "novellum-vault";

// Root-level files GitHub (or a human) commonly adds to an otherwise-empty repo — safe to adopt
// as a fresh vault without asking, since there's nothing real to clobber.
const VAULT_SAFE_ROOT_ENTRIES = new Set(["readme.md", "license", "license.md", ".gitignore"]);

/** A repo is safe to sync a manuscript into if it's empty, only has the boilerplate above, or
 *  already has this app's own books/ folder (a previously-used vault) — anything else risks
 *  silently mixing manuscript files into an unrelated project. */
async function isUsableVaultRepo(token, owner, repo, defaultBranch) {
  const { tree } = await gh.getTree(token, owner, repo, defaultBranch);
  if (tree.length === 0) return true;
  if (tree.some((e) => e.path === "books" || e.path.startsWith("books/"))) return true;
  const rootEntries = tree.filter((e) => !e.path.includes("/"));
  return rootEntries.every((e) => VAULT_SAFE_ROOT_ENTRIES.has(e.path.toLowerCase()));
}

/** First step of "Sign in with GitHub": saves the token and identifies the account. Deliberately
 *  does not pick a repo — the settings UI decides next, based on whether this account's default
 *  vault already exists (see connectExistingVaultRepo / createRepoForVault). */
export async function beginOAuthLogin(token) {
  await patchGithubSettings({ token, owner: "", repo: "" });
  const login = await gh.testToken(token);
  return { login };
}

/** Connects to an existing repo as the vault, after confirming it's actually safe to sync a
 *  manuscript into. Throws the underlying GitHubError('notfound', ...) if the repo doesn't
 *  exist, or a plain Error with a user-facing message if it exists but isn't a usable vault. */
export async function connectExistingVaultRepo(owner, repo) {
  const { token } = await getGithubSettings();
  if (!token) throw new Error("No token set.");
  const info = await gh.testRepoAccess(token, owner, repo);
  if (!(await isUsableVaultRepo(token, owner, repo, info.defaultBranch))) {
    throw new Error(
      `${owner}/${repo} already has other content and doesn't look like a Novellum vault — ` +
      `pick an empty repo, or one with a "books" folder from a previous vault.`
    );
  }
  await patchGithubSettings({ owner, repo, defaultBranch: info.defaultBranch });
  return { owner, repo };
}

/** The signed-in account's own repos, for the "choose an existing repo" vault picker. */
export async function listMyRepos() {
  const { token } = await getGithubSettings();
  if (!token) throw new Error("No token set.");
  return gh.listUserRepos(token);
}

/* ---------------------------------------------------------------- */
/* Overall sync status (for the topbar badge / conflict banner)      */
/* ---------------------------------------------------------------- */

export async function getSyncStatus() {
  const settings = await getGithubSettings();
  const [outbox, conflicts] = await Promise.all([dbGetAll("outbox"), dbGetAll("conflicts")]);
  return {
    configured: !!(settings.token && settings.owner && settings.repo),
    lastSyncedAt: settings.lastSyncedAt || null,
    pendingCount: outbox.length,
    conflictCount: conflicts.length,
  };
}

/** Push then pull for one book, in one call — shared by the manual "Sync Now" button and the
 *  automatic background timer so they can't drift out of sync with each other's behavior. */
async function syncNowInner(bookId, { force = false } = {}) {
  // A scene deleted (or replaced by an import) moments ago might still be sitting in IndexedDB
  // if its debounced local save hasn't landed yet — pushOne would then see a live row and push
  // an update instead of the deletion. Flushing first guarantees the outbox is drained against
  // the same local state the user actually sees.
  await flushSaveNow();
  const pushResult = await drainOutbox(undefined, { force });
  const pullResult = bookId && !pushResult.paused ? await reconcileBook(bookId) : { pulled: 0, conflicts: 0 };
  if (!pushResult.paused) await patchGithubSettings({ lastSyncedAt: new Date().toISOString() });
  return { pushResult, pullResult };
}

// Every caller (the background timer, the manual "Sync Now" button, the boot-time sync) funnels
// through this same chain so two syncs can never run concurrently. Without it, two overlapping
// runs both flush the same in-memory `data` to IndexedDB from a stale read, then both try to
// push the same scene — the second push's expected sha is already stale by the time it lands,
// so GitHub rejects it as a conflict even though nothing actually differs but a timestamp.
let syncChain = Promise.resolve();
export function syncNow(bookId, opts) {
  const result = syncChain.then(() => syncNowInner(bookId, opts));
  // Swallow the error here so one failed sync doesn't wedge the chain for every sync after it —
  // the caller of *this* call still sees the rejection via `result`, which is returned untouched.
  syncChain = result.catch(() => {});
  return result;
}

/* ---------------------------------------------------------------- */
/* Outbox                                                            */
/* ---------------------------------------------------------------- */

function outboxKey(bookId, kind, targetId) {
  return `${bookId}:${kind}:${targetId}`;
}

/** Marks one scene/manifest/bible file as needing a push. Re-enqueuing the same target just refreshes it. */
export async function enqueueSync(kind, targetId, bookId = getActiveBookId()) {
  if (!bookId) return;
  const key = outboxKey(bookId, kind, targetId);
  await dbPut("outbox", {
    key, bookId, kind, targetId,
    enqueuedAt: new Date().toISOString(), attempts: 0, lastError: null, lastAttemptAt: null,
  });
}

export async function listOutbox() {
  return dbGetAll("outbox");
}

/**
 * Ensures a book that has never been pushed before gets its manifest, bible, and every
 * scene enqueued at least once. Without this, a book loaded from local seed data or created
 * before GitHub sync was ever configured would never get its existing content onto GitHub —
 * only *future* edits would enqueue anything. A no-op for books that have already synced once.
 */
export async function ensureBookBootstrapped(bookId) {
  const meta = await dbGet("manifestMeta", bookId);
  if (meta && meta.manifestSha) return;

  await enqueueSync("manifest", bookId, bookId);
  await enqueueSync("bible", bookId, bookId);
  const scenes = await dbGetAllByIndex("scenes", "bookId", bookId);
  for (const sc of scenes) {
    await enqueueSync("scene", sc.id, bookId);
  }
}

export async function listConflicts() {
  return dbGetAll("conflicts");
}

/** Rebuilds the local version of a conflicting file in the same serialized form it would be
 *  pushed as, so it can be diffed line-for-line against `conflict.remoteContent`. Returns null
 *  if the local record is gone entirely (e.g. a scene that's since been deleted). */
export async function getLocalContentForConflict(conflict) {
  const { bookId, kind, targetId } = conflict;
  if (kind === "scene") {
    const sceneRow = await dbGet("scenes", targetId);
    return sceneRow ? sceneToMarkdown(sceneRow) : null;
  }
  if (kind === "manifest") {
    const [bookRow, chapters, scenes] = await Promise.all([
      dbGet("books", bookId),
      dbGetAllByIndex("chapters", "bookId", bookId),
      dbGetAllByIndex("scenes", "bookId", bookId),
    ]);
    if (!bookRow) return null;
    return JSON.stringify(buildManifest(bookRow, chapters, scenes), null, 2);
  }
  if (kind === "bible") {
    const bibleEntries = await dbGetAllByIndex("bibleEntries", "bookId", bookId);
    return JSON.stringify(buildBible(bibleEntries), null, 2);
  }
  return null;
}

function backoffReady(entry) {
  if (!entry.lastAttemptAt) return true;
  const waitMs = Math.min(30000 * 2 ** (entry.attempts || 0), 15 * 60 * 1000);
  return Date.now() - new Date(entry.lastAttemptAt).getTime() >= waitMs;
}

function pathForEntry(entry) {
  if (entry.kind === "scene") return `books/${entry.bookId}/scenes/${entry.targetId}.md`;
  if (entry.kind === "manifest") return `books/${entry.bookId}/manifest.json`;
  return `books/${entry.bookId}/bible.json`;
}

function buildManifest(bookRow, chapters, scenes) {
  // No updatedAt field here on purpose: it's never read back by anything (see applyRemoteManifest
  // below), and stamping a fresh timestamp on every build meant pushing an otherwise-unchanged
  // manifest still produced a different file every time — causing the same kind of spurious
  // sha-mismatch conflict as the scene-row updatedAt bug this was found alongside.
  const sorted = chapters.slice().sort((a, b) => a.order - b.order);
  return {
    schemaVersion: 1,
    id: bookRow.id,
    title: bookRow.title,
    chapters: sorted.map((ch) => ({
      id: ch.id,
      title: ch.title,
      sceneIds: scenes
        .filter((s) => s.chapterId === ch.id)
        .sort((a, b) => a.order - b.order)
        .map((s) => s.id),
    })),
  };
}

function buildBible(bibleEntries) {
  const byKind = (kind) =>
    bibleEntries
      .filter((b) => b.kind === kind)
      .sort((a, b) => a.order - b.order)
      .map((b) => ({ id: b.id, name: b.name, desc: b.desc }));
  return { characters: byKind("character"), locations: byKind("location"), concepts: byKind("concept") };
}

async function pushOne(token, owner, repo, entry) {
  const { bookId, kind, targetId } = entry;

  if (kind === "scene") {
    const sceneRow = await dbGet("scenes", targetId);
    const path = pathForEntry(entry);
    if (!sceneRow) {
      // Deleted locally (directly, or replaced by an import) — remove its file on GitHub too,
      // rather than leaving an orphaned scene doc behind forever. Git history keeps the old
      // content recoverable if it's ever needed back.
      const remote = await gh.getFile(token, owner, repo, path);
      if (remote) await gh.deleteFile(token, owner, repo, path, `Delete scene: ${targetId}`, remote.sha);
      await dbDelete("sceneSync", targetId);
      return;
    }
    const content = sceneToMarkdown(sceneRow);
    const sync = await dbGet("sceneSync", targetId);
    const { sha } = await gh.putFile(token, owner, repo, path, content, `Update scene: ${sceneRow.title}`, sync?.remoteSha);
    // Written to its own store, never to "scenes" — a debounced local save (persistNow) fully
    // rewrites "scenes" from scratch on every edit, so recording the sha there would risk a
    // concurrent save clobbering it (or clobbering content with a stale pre-push snapshot).
    await dbPut("sceneSync", { id: targetId, bookId, remoteSha: sha });
    return;
  }

  if (kind === "manifest") {
    const [bookRow, chapters, scenes] = await Promise.all([
      dbGet("books", bookId),
      dbGetAllByIndex("chapters", "bookId", bookId),
      dbGetAllByIndex("scenes", "bookId", bookId),
    ]);
    const content = JSON.stringify(buildManifest(bookRow, chapters, scenes), null, 2);
    const path = pathForEntry(entry);
    const meta = (await dbGet("manifestMeta", bookId)) || { bookId };
    const { sha } = await gh.putFile(token, owner, repo, path, content, "Update manifest", meta.manifestSha);
    await dbPut("manifestMeta", { ...meta, bookId, manifestSha: sha });
    return;
  }

  if (kind === "bible") {
    const bibleEntries = await dbGetAllByIndex("bibleEntries", "bookId", bookId);
    const content = JSON.stringify(buildBible(bibleEntries), null, 2);
    const path = pathForEntry(entry);
    const meta = (await dbGet("manifestMeta", bookId)) || { bookId };
    const { sha } = await gh.putFile(token, owner, repo, path, content, "Update story bible", meta.bibleSha);
    await dbPut("manifestMeta", { ...meta, bookId, bibleSha: sha });
  }
}

async function recordConflict(token, owner, repo, entry) {
  const path = pathForEntry(entry);
  let remote = null;
  try {
    remote = await gh.getFile(token, owner, repo, path);
  } catch {
    // if fetching the remote copy also fails, still record the conflict without it
  }
  await dbPut("conflicts", {
    key: entry.key,
    bookId: entry.bookId,
    kind: entry.kind,
    targetId: entry.targetId,
    remoteSha: remote?.sha || null,
    remoteContent: remote?.content || null,
    detectedAt: new Date().toISOString(),
  });
}

/**
 * Drains the outbox, pushing each pending item to GitHub. Never overwrites a file whose sha
 * has moved. `force` bypasses each entry's retry backoff — used for a user-initiated "Sync
 * Now" click, where silently skipping a still-backed-off entry would look like nothing was
 * wrong (0 pushed, 0 conflicts) instead of surfacing the real error. Automatic background
 * sync should NOT pass force, so it keeps backing off a genuinely failing entry as intended.
 */
export async function drainOutbox(onProgress, { force = false } = {}) {
  const { token, owner, repo } = await getGithubSettings();
  if (!token || !owner || !repo) {
    // `paused: true` here too — this is just as much a "sync could not proceed" outcome as an
    // auth/rate-limit failure, and the caller only surfaces `pauseReason` when paused is true.
    return { pushed: 0, conflicts: 0, paused: true, pauseReason: "GitHub isn't configured yet (see Settings)." };
  }

  const entries = await dbGetAll("outbox");
  let pushed = 0;
  let conflicts = 0;
  let paused = false;
  let pauseReason = null;

  for (const entry of entries) {
    if (paused) break;
    if (!force && !backoffReady(entry)) continue;

    try {
      await pushOne(token, owner, repo, entry);
      await dbDelete("outbox", entry.key);
      pushed += 1;
      if (onProgress) onProgress({ type: "pushed", entry });
    } catch (err) {
      if (err.type === "conflict") {
        await recordConflict(token, owner, repo, entry);
        conflicts += 1;
      } else if (err.type === "auth" || err.type === "ratelimit") {
        paused = true;
        pauseReason = err.message;
      }
      const updated = {
        ...entry,
        attempts: (entry.attempts || 0) + 1,
        lastError: err.message,
        lastAttemptAt: new Date().toISOString(),
      };
      await dbPut("outbox", updated);
      if (onProgress) onProgress({ type: "error", entry: updated, error: err });
    }
  }

  return { pushed, conflicts, paused, pauseReason };
}

/* ---------------------------------------------------------------- */
/* Reconciliation (pull) — never silently clobbers local changes:    */
/* a target only ever fast-forwards from remote if it has no pending */
/* outbox entry; otherwise it becomes a conflict, same as on push.   */
/* ---------------------------------------------------------------- */

async function getBookRemoteTree(token, owner, repo, ref, bookId) {
  const { tree } = await gh.getTree(token, owner, repo, ref);
  const prefix = `books/${bookId}/`;
  return new Map(
    tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix)).map((e) => [e.path, e.sha])
  );
}

/** Adopts a remote manifest's chapter/scene structure locally, pulling in any scene that
 *  doesn't exist locally yet. Only call this for a book whose manifest isn't itself dirty. */
async function applyRemoteManifest(bookId, remoteManifest, remoteByPath, dirtyKeys, token, owner, repo) {
  const now = new Date().toISOString();
  const localScenes = await dbGetAllByIndex("scenes", "bookId", bookId);
  const localScenesById = new Map(localScenes.map((s) => [s.id, s]));

  const newChapterRows = [];
  for (const [chIndex, ch] of remoteManifest.chapters.entries()) {
    newChapterRows.push({ id: ch.id, bookId, title: ch.title, order: chIndex, updatedAt: now });

    for (const [scIndex, sceneId] of ch.sceneIds.entries()) {
      const existing = localScenesById.get(sceneId);
      if (existing) {
        // Already known locally — adopt remote's placement/order unless we have unpushed
        // edits to this specific scene, in which case its own content diff (handled by the
        // caller) decides whether it's a conflict; don't fight over its position here too.
        if (!dirtyKeys.has(`scene:${sceneId}`)) {
          await dbPut("scenes", { ...existing, chapterId: ch.id, order: scIndex });
        }
        continue;
      }
      // Exists remotely but not locally yet — e.g. created on another device. Pull it in full.
      const path = `books/${bookId}/scenes/${sceneId}.md`;
      const sha = remoteByPath.get(path);
      if (!sha) continue;
      const blob = await gh.getBlob(token, owner, repo, sha);
      const parsed = markdownToScene(blob.content);
      await dbPut("scenes", {
        id: sceneId, bookId, chapterId: ch.id, order: scIndex,
        title: parsed.title, summary: parsed.summary, text: parsed.text, todos: parsed.todos,
        updatedAt: parsed.updatedAt || now,
      });
      await dbPut("sceneSync", { id: sceneId, bookId, remoteSha: sha });
    }
  }

  await dbReplaceWhereIndex("chapters", "bookId", bookId, newChapterRows);
}

async function applyRemoteBible(bookId, remoteBible) {
  const now = new Date().toISOString();
  const rows = [
    ...(remoteBible.characters || []).map((c, i) => ({ ...c, bookId, kind: "character", order: i, updatedAt: now })),
    ...(remoteBible.locations || []).map((c, i) => ({ ...c, bookId, kind: "location", order: i, updatedAt: now })),
    ...(remoteBible.concepts || []).map((c, i) => ({ ...c, bookId, kind: "concept", order: i, updatedAt: now })),
  ];
  await dbReplaceWhereIndex("bibleEntries", "bookId", bookId, rows);
}

/**
 * Pulls remote changes for one book. For each of manifest/bible/scenes: if it changed on
 * GitHub and we have no pending local edit to it, fast-forward local state to match. If we
 * *do* have a pending local edit and remote also changed, record a conflict — same shape and
 * resolution path (Keep Mine / Use GitHub's) as a conflict discovered while pushing.
 */
export async function reconcileBook(bookId) {
  const { token, owner, repo, defaultBranch } = await getGithubSettings();
  if (!token || !owner || !repo) return { pulled: 0, conflicts: 0, skipped: true };

  const ref = defaultBranch || "main";
  let remoteByPath;
  try {
    remoteByPath = await getBookRemoteTree(token, owner, repo, ref, bookId);
  } catch (err) {
    return { pulled: 0, conflicts: 0, error: err.message };
  }

  const outbox = await dbGetAll("outbox");
  const dirtyKeys = new Set(
    outbox.filter((e) => e.bookId === bookId).map((e) => `${e.kind}:${e.targetId}`)
  );

  let pulled = 0;
  let conflicts = 0;
  const prefix = `books/${bookId}/`;

  const manifestSha = remoteByPath.get(`${prefix}manifest.json`);
  const meta = (await dbGet("manifestMeta", bookId)) || { bookId };
  if (manifestSha && manifestSha !== meta.manifestSha) {
    if (dirtyKeys.has(`manifest:${bookId}`)) {
      await recordConflict(token, owner, repo, { key: outboxKey(bookId, "manifest", bookId), bookId, kind: "manifest", targetId: bookId });
      conflicts += 1;
    } else {
      const blob = await gh.getBlob(token, owner, repo, manifestSha);
      await applyRemoteManifest(bookId, JSON.parse(blob.content), remoteByPath, dirtyKeys, token, owner, repo);
      await dbPut("manifestMeta", { ...meta, bookId, manifestSha });
      pulled += 1;
    }
  }

  const bibleSha = remoteByPath.get(`${prefix}bible.json`);
  const meta2 = (await dbGet("manifestMeta", bookId)) || { bookId };
  if (bibleSha && bibleSha !== meta2.bibleSha) {
    if (dirtyKeys.has(`bible:${bookId}`)) {
      await recordConflict(token, owner, repo, { key: outboxKey(bookId, "bible", bookId), bookId, kind: "bible", targetId: bookId });
      conflicts += 1;
    } else {
      const blob = await gh.getBlob(token, owner, repo, bibleSha);
      await applyRemoteBible(bookId, JSON.parse(blob.content));
      await dbPut("manifestMeta", { ...meta2, bookId, bibleSha });
      pulled += 1;
    }
  }

  // Scenes whose content changed remotely but whose existence/placement didn't (already
  // covered above via applyRemoteManifest for brand-new scenes).
  const [localScenes, sceneSyncRows] = await Promise.all([
    dbGetAllByIndex("scenes", "bookId", bookId),
    dbGetAllByIndex("sceneSync", "bookId", bookId),
  ]);
  const syncById = new Map(sceneSyncRows.map((s) => [s.id, s]));
  for (const sc of localScenes) {
    const path = `${prefix}scenes/${sc.id}.md`;
    const remoteSha = remoteByPath.get(path);
    const knownSha = syncById.get(sc.id)?.remoteSha;
    if (!remoteSha || remoteSha === knownSha) continue;
    if (dirtyKeys.has(`scene:${sc.id}`)) {
      await recordConflict(token, owner, repo, { key: outboxKey(bookId, "scene", sc.id), bookId, kind: "scene", targetId: sc.id });
      conflicts += 1;
    } else {
      const blob = await gh.getBlob(token, owner, repo, remoteSha);
      const parsed = markdownToScene(blob.content);
      await dbPut("scenes", { ...sc, ...parsed });
      await dbPut("sceneSync", { id: sc.id, bookId, remoteSha });
      pulled += 1;
    }
  }

  return { pulled, conflicts };
}

/* ---------------------------------------------------------------- */
/* Conflict resolution (minimal for now — full compare UI is later)  */
/* ---------------------------------------------------------------- */

/** Overwrite GitHub's copy with the local one, using the freshly-observed remote sha as the concurrency token. */
export async function resolveConflictKeepMine(key) {
  const conflict = await dbGet("conflicts", key);
  if (!conflict) return;

  if (conflict.kind === "scene") {
    const sceneRow = await dbGet("scenes", conflict.targetId);
    if (sceneRow) await dbPut("sceneSync", { id: conflict.targetId, bookId: conflict.bookId, remoteSha: conflict.remoteSha });
  } else {
    const meta = (await dbGet("manifestMeta", conflict.bookId)) || { bookId: conflict.bookId };
    if (conflict.kind === "manifest") meta.manifestSha = conflict.remoteSha;
    else meta.bibleSha = conflict.remoteSha;
    await dbPut("manifestMeta", meta);
  }

  await dbPut("outbox", {
    key, bookId: conflict.bookId, kind: conflict.kind, targetId: conflict.targetId,
    enqueuedAt: new Date().toISOString(), attempts: 0, lastError: null, lastAttemptAt: null,
  });
  await dbDelete("conflicts", key);
}

/** Take GitHub's version instead — discards the pending local edit for this specific target. */
export async function resolveConflictUseTheirs(key) {
  const conflict = await dbGet("conflicts", key);
  if (!conflict || !conflict.remoteContent) return;

  if (conflict.kind === "scene") {
    const parsed = markdownToScene(conflict.remoteContent);
    const existing = await dbGet("scenes", conflict.targetId);
    await dbPut("scenes", { ...existing, ...parsed });
    await dbPut("sceneSync", { id: conflict.targetId, bookId: conflict.bookId, remoteSha: conflict.remoteSha });
  } else if (conflict.kind === "bible") {
    await applyRemoteBible(conflict.bookId, JSON.parse(conflict.remoteContent));
    const meta = (await dbGet("manifestMeta", conflict.bookId)) || { bookId: conflict.bookId };
    await dbPut("manifestMeta", { ...meta, bibleSha: conflict.remoteSha });
  } else if (conflict.kind === "manifest") {
    const { token, owner, repo, defaultBranch } = await getGithubSettings();
    const remoteByPath = await getBookRemoteTree(token, owner, repo, defaultBranch || "main", conflict.bookId);
    await applyRemoteManifest(conflict.bookId, JSON.parse(conflict.remoteContent), remoteByPath, new Set(), token, owner, repo);
    const meta = (await dbGet("manifestMeta", conflict.bookId)) || { bookId: conflict.bookId };
    await dbPut("manifestMeta", { ...meta, manifestSha: conflict.remoteSha });
  }

  await dbDelete("outbox", key);
  await dbDelete("conflicts", key);
}

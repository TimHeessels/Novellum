"use strict";

import { dbGet, dbPut, dbGetAll, dbGetAllByIndex, dbDelete, dbReplaceWhereIndex, dbReplaceAll } from "./db.js";
import { sceneToMarkdown, markdownToScene, entriesFromLegacy } from "./model.js";
import { getActiveBookId, flushSaveNow } from "./persistence.js";
import * as gh from "./github-client.js";

const SETTINGS_KEY = "github";

/* ---------------------------------------------------------------- */
/* Settings                                                          */
/* ---------------------------------------------------------------- */

export async function getGithubSettings() {
  return (
    (await dbGet("settings", SETTINGS_KEY)) || {
      token: "", owner: "", repo: "", defaultBranch: "", lastPushedAt: null, lastPulledAt: null,
    }
  );
}

async function patchGithubSettings(patch) {
  const existing = await getGithubSettings();
  await dbPut("settings", { ...existing, key: SETTINGS_KEY, ...patch });
}

/** Fully decouples this device from whatever repo it was connected to: clears the saved
 *  token/owner/repo plus every piece of repo-specific sync bookkeeping (shas, conflicts).
 *  The manuscript itself is untouched — reconnecting (to the same repo or a different one)
 *  re-bootstraps from scratch via ensureBookBootstrapped, same as a brand-new install. */
export async function disconnectGithub() {
  await dbPut("settings", {
    key: SETTINGS_KEY, token: "", owner: "", repo: "", defaultBranch: "", lastPushedAt: null, lastPulledAt: null,
  });
  await Promise.all([
    dbReplaceAll("conflicts", []),
    dbReplaceAll("manifestMeta", []),
    dbReplaceAll("sceneSync", []),
  ]);
}

// Root-level files GitHub (or a human) commonly adds to an otherwise-empty repo — safe to treat
// as an empty vault without warning, since there's nothing real to clobber.
const VAULT_SAFE_ROOT_ENTRIES = new Set(["readme.md", "license", "license.md", ".gitignore"]);

/** A repo looks like a safe manuscript vault if it's empty, only has the boilerplate above, or
 *  already has this app's own books/ folder (a previously-used vault) — anything else suggests
 *  the wrong repo got selected in GitHub's install picker. This never blocks connecting (the user
 *  already made a deliberate choice in GitHub's own UI by this point) — callers use it to decide
 *  whether to show a "you may have picked the wrong repo" warning. */
export async function isUsableVaultRepo(owner, repo, defaultBranch) {
  const { token } = await getGithubSettings();
  const { tree } = await gh.getTree(token, owner, repo, defaultBranch);
  if (tree.length === 0) return true;
  if (tree.some((e) => e.path === "books" || e.path.startsWith("books/"))) return true;
  const rootEntries = tree.filter((e) => !e.path.includes("/"));
  return rootEntries.every((e) => VAULT_SAFE_ROOT_ENTRIES.has(e.path.toLowerCase()));
}

/** True only for a book that's exactly the untouched fresh-install seed (see `data` in
 *  model.js) — not merely one that's never synced, which could just as easily be a real book the
 *  user has been writing in on this device before ever connecting GitHub. */
async function isUntouchedPlaceholderBook(bookId) {
  const [bookRow, chapters, scenes] = await Promise.all([
    dbGet("books", bookId),
    dbGetAllByIndex("chapters", "bookId", bookId),
    dbGetAllByIndex("scenes", "bookId", bookId),
  ]);
  if (!bookRow || bookRow.title !== "Untitled Book") return false;
  if (chapters.length !== 1 || chapters[0].title !== "Chapter 1") return false;
  if (scenes.length !== 1) return false;
  const sc = scenes[0];
  return sc.title === "Untitled Scene" && !sc.summary && !sc.text && (!sc.todos || sc.todos.length === 0);
}

/** DEFAULT_BOOK_ID (persistence.js) is a fixed id shared by every fresh install, so the very
 *  first sync of a brand-new device and the vault a previously-set-up device already pushed under
 *  that same id can collide the moment GitHub gets connected. If this device's active book is
 *  still exactly the untouched placeholder seed, and the just-connected repo already has real
 *  content at that same path, pushing the placeholder would only conflict on manifest/bible and
 *  silently litter the vault with an orphaned scene file (it has a fresh random id, so GitHub
 *  sees it as brand new rather than conflicting, and nothing in the real manifest ever references
 *  it). Drop the placeholder's queued bootstrap instead — the next pull adopts the real remote
 *  content normally, same as any other never-synced device joining an existing vault. Never
 *  touches a book the user has actually started writing in; that still goes through the normal
 *  conflict flow so they get to choose. */
async function dropStaleBootstrapIfRemoteExists(token, owner, repo, bookId) {
  const meta = await dbGet("manifestMeta", bookId);
  if (meta && meta.manifestSha) return;
  if (!(await isUntouchedPlaceholderBook(bookId))) return;
  const remoteManifest = await gh.getFile(token, owner, repo, `books/${bookId}/manifest.json`).catch(() => null);
  if (!remoteManifest) return;
  const outbox = await dbGetAll("outbox");
  await Promise.all(outbox.filter((e) => e.bookId === bookId).map((e) => dbDelete("outbox", e.key)));
}

/** Connects to one of the repos this GitHub App installation was granted, saving it as the
 *  active vault. Doesn't run the usability check itself — see isUsableVaultRepo, which callers
 *  can re-run afterward to warn without blocking. */
export async function connectToRepo(owner, repo) {
  const { token } = await getGithubSettings();
  if (!token) throw new Error("No token set.");
  const info = await gh.testRepoAccess(token, owner, repo);

  // Locked from here on: patchGithubSettings below is the moment GitHub becomes "configured",
  // and a concurrently-running auto-sync tick could start draining the outbox right after —
  // including, for a never-synced device, the stale placeholder bootstrap entries
  // dropStaleBootstrapIfRemoteExists is about to clear. Without the lock, that auto-sync could
  // win the race and push them first, recreating the exact conflicts/orphan-file bug this exists
  // to prevent.
  return withSyncLock(async () => {
    await patchGithubSettings({ owner, repo, defaultBranch: info.defaultBranch });

    const bookId = getActiveBookId();
    if (bookId) await dropStaleBootstrapIfRemoteExists(token, owner, repo, bookId);

    return { owner, repo };
  });
}

/** Completes "Connect GitHub" right after the install-picker redirect: saves the token, then
 *  looks up exactly which repo(s) this installation was granted (never anything broader — that's
 *  enforced by GitHub itself, not by anything we do here). Returns { connected } if exactly one
 *  repo was granted (the common case — already saved as the active vault), or { needsPick } with
 *  the list if more than one was granted, for the settings UI to ask which one to use. Throws if
 *  zero repos were granted. */
export async function completeGithubAppLogin(token, installationId) {
  await patchGithubSettings({ token, owner: "", repo: "" });
  const repos = await gh.listInstallationRepos(token, installationId);
  if (repos.length === 0) {
    throw new Error("No repository access was granted — reinstall the GitHub App and select a repository.");
  }
  if (repos.length === 1) {
    const connected = await connectToRepo(repos[0].owner, repos[0].repo);
    return { connected };
  }
  return { needsPick: repos };
}

/* ---------------------------------------------------------------- */
/* Overall sync status (for the topbar badge / conflict banner)      */
/* ---------------------------------------------------------------- */

export async function getSyncStatus() {
  const settings = await getGithubSettings();
  const [outbox, conflicts] = await Promise.all([dbGetAll("outbox"), dbGetAll("conflicts")]);
  return {
    configured: !!(settings.token && settings.owner && settings.repo),
    lastPushedAt: settings.lastPushedAt || null,
    lastPulledAt: settings.lastPulledAt || null,
    // Excludes entries the user marked "Ignore" in the push preview — those sit in the outbox
    // indefinitely (until edited again or un-ignored) but shouldn't count toward "Push N changes",
    // since clicking that button won't actually send them. See setOutboxEntrySkipped.
    pendingCount: outbox.filter((e) => !e.skipped).length,
    conflictCount: conflicts.length,
  };
}

// Every caller — the manual Push button, the manual Pull banner, conflict resolution, history
// restore, and anything else below that touches a book's chapters/scenes rows from a pull —
// funnels through this same chain so two such operations can never run concurrently. Without it,
// e.g. a pull that writes freshly-fetched chapters/scenes to IndexedDB (reconcileBook /
// resolveConflictUseTheirs) could be clobbered by a concurrent push's flushSaveNow(), which does a
// blind full-table replace of "chapters"/"scenes" from the in-memory `data` object — and `data`
// won't reflect the pull's results until the caller has had a chance to loadBook() again. Callers
// that need that refresh to also be race-free (settings-ui.js's conflict resolution, ui.js's
// switchToBook) wrap their whole "write + refresh local `data`" sequence in withSyncLock too, so
// nothing else can land in between. Never call withSyncLock from inside a function that's already
// running inside one — the chain isn't reentrant and it will deadlock.
let syncChain = Promise.resolve();
export function withSyncLock(fn) {
  const result = syncChain.then(fn);
  // Swallow the error here so one failed operation doesn't wedge the chain for every operation
  // after it — the caller of *this* call still sees the rejection via `result`, which is returned
  // untouched.
  syncChain = result.catch(() => {});
  return result;
}

/** Pushes every pending outbox entry to GitHub — the only thing that ever creates commits. Only
 *  ever runs when something (a click) asks for it; nothing in this app calls this on a timer.
 *
 *  Pulls first, for every book that has anything pending — so a push doesn't need the user to have
 *  separately noticed and clicked Pull first, and doesn't need to fail into a conflict just because
 *  GitHub moved on in the meantime. This is safe by construction: reconcileBook only ever
 *  fast-forwards a target with no pending outbox entry, and defers to a conflict record (same as
 *  today) for anything genuinely contested — it can never silently clobber a local edit. Runs
 *  inside the same withSyncLock as the push itself (reconcileBook is called directly, not via
 *  pullChanges, since withSyncLock isn't reentrant). `onPulled`, if given, runs with the distinct
 *  bookIds that actually pulled something, so a caller can refresh in-memory `data` for whichever
 *  of those is the currently open book. */
export function pushChanges({ force = false, onPulled } = {}) {
  return withSyncLock(async () => {
    // A scene deleted (or replaced by an import) moments ago might still be sitting in IndexedDB
    // if its debounced local save hasn't landed yet — pushOne would then see a live row and push
    // an update instead of the deletion. Flushing first guarantees the outbox is drained against
    // the same local state the user actually sees.
    await flushSaveNow();

    const outboxBookIds = [...new Set((await dbGetAll("outbox")).map((e) => e.bookId))];
    let prePulled = 0;
    let prePullConflicts = 0;
    const prePullBookIds = [];
    for (const id of outboxBookIds) {
      const result = await reconcileBook(id);
      if (result.pulled > 0) prePullBookIds.push(id);
      prePulled += result.pulled;
      prePullConflicts += result.conflicts;
    }
    if (prePulled > 0) await patchGithubSettings({ lastPulledAt: new Date().toISOString() });
    if (onPulled && prePullBookIds.length > 0) await onPulled(prePullBookIds);

    const pushResult = await drainOutbox(undefined, { force });
    if (!pushResult.paused) await patchGithubSettings({ lastPushedAt: new Date().toISOString() });
    return { ...pushResult, prePull: { pulled: prePulled, conflicts: prePullConflicts, bookIds: prePullBookIds } };
  });
}

/** Pulls (applies) remote changes for one book. `onPulled`, if given, runs inside the same lock
 *  right after a pull that actually changed something (`pulled > 0`) — for callers that need to
 *  refresh the in-memory `data` object (or otherwise react) atomically with the pull, so nothing
 *  else queued on the lock can slip in between "IndexedDB updated" and "the refresh caught up to
 *  it" (see withSyncLock's comment above). Called with the pull's `pulledTargets` set, in case a
 *  caller wants to react to specifically what changed rather than reloading everything. */
export function pullChanges(bookId, { onPulled, justPushed = new Set() } = {}) {
  return withSyncLock(async () => {
    const pullResult = await reconcileBook(bookId, justPushed);
    if (!pullResult.skipped) await patchGithubSettings({ lastPulledAt: new Date().toISOString() });
    if (onPulled && pullResult.pulled > 0) await onPulled(pullResult.pulledTargets);
    return pullResult;
  });
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

/** Marks (or unmarks) an outbox entry so drainOutbox skips it — the "Ignore this change" action in
 *  the push preview, for something like a story-bible edit the user doesn't want sent yet. The
 *  entry stays in the outbox (still shows up as unsynced) rather than being deleted, so it isn't
 *  silently lost; it starts being pushed again either when explicitly un-ignored here, or the next
 *  time enqueueSync re-enqueues that same target (a fresh edit — dbPut there writes a plain new
 *  record with no `skipped` field, which is exactly the "this edit should go out" default). */
export async function setOutboxEntrySkipped(key, skipped) {
  const entry = await dbGet("outbox", key);
  if (!entry) return;
  await dbPut("outbox", { ...entry, skipped });
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
    author: bookRow.author || "",
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
      .map((b) => ({ id: b.id, name: b.name, entries: entriesFromLegacy(b) }));
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

/** The recursive git-trees endpoint reconcileBook uses to spot remote changes (getBookRemoteTree)
 *  can occasionally still lag a moment behind a commit that was just made — `justPushed` catches
 *  that within the same sync cycle, but if the lag outlasts a full cycle, the next reconcileBook
 *  can mistake its own recent push for a colliding remote change whenever the same target was
 *  edited again since. The Contents API (getFile) is authoritative for a single path and doesn't
 *  share that lag, so it's used here as a tie-breaker before ever declaring a real conflict. */
async function confirmRemoteSha(token, owner, repo, path, knownSha) {
  if (!knownSha) return false;
  const remote = await gh.getFile(token, owner, repo, path).catch(() => null);
  return !!remote && remote.sha === knownSha;
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
    return { pushed: 0, conflicts: 0, skipped: 0, paused: true, pauseReason: "GitHub isn't configured yet (see Settings).", pushedTargets: new Set() };
  }

  const entries = await dbGetAll("outbox");
  let pushed = 0;
  let conflicts = 0;
  let skipped = 0;
  let paused = false;
  let pauseReason = null;
  // Targets this call successfully pushed — callers that pull again shortly after a push (e.g.
  // settings-ui.js's "just connected a repo" flow) can pass this to reconcileBook as `justPushed`
  // so it skips re-deriving their state from a fresh tree fetch. GitHub's git data endpoints
  // (trees/blobs) can lag a moment behind a just-completed Contents API commit, and reconcileBook
  // has no way to tell that lag apart from a genuine concurrent remote change otherwise. We
  // already know the true post-push sha from the PUT response itself, so trust that instead.
  const pushedTargets = new Set();

  for (const entry of entries) {
    if (paused) break;
    // Unlike the backoff check below, `force` never overrides an explicit user "Ignore" — that's
    // a deliberate choice, not a transient failure to retry through.
    if (entry.skipped) {
      skipped += 1;
      continue;
    }
    if (!force && !backoffReady(entry)) continue;

    try {
      await pushOne(token, owner, repo, entry);
      // Only clear the entry if it's still the same one we just pushed — a keystroke can
      // re-enqueue this same key (enqueueSync isn't debounced) while the PUT above was in
      // flight. Deleting unconditionally would wipe out that fresher edit's dirty marker even
      // though its content was never actually sent, silently delaying it until something else
      // happens to touch this scene again.
      const current = await dbGet("outbox", entry.key);
      if (current && current.enqueuedAt === entry.enqueuedAt) {
        await dbDelete("outbox", entry.key);
      }
      pushed += 1;
      pushedTargets.add(`${entry.kind}:${entry.targetId}`);
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

  return { pushed, conflicts, skipped, paused, pauseReason, pushedTargets };
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
 *  doesn't exist locally yet. Only call this for a book whose manifest isn't itself dirty —
 *  every local structural change (move, reorder, delete, chapter rename) marks the manifest
 *  dirty too (see markDirty("manifest", ...) call sites in ui.js), so by the time a caller gets
 *  here there's guaranteed to be no pending local placement change for this to clobber. */
async function applyRemoteManifest(bookId, remoteManifest, remoteByPath, token, owner, repo) {
  const now = new Date().toISOString();
  const localScenes = await dbGetAllByIndex("scenes", "bookId", bookId);
  const localScenesById = new Map(localScenes.map((s) => [s.id, s]));

  // The manifest is also the only place a book's title/author travels between devices — push
  // (buildManifest) has always included them, but this adoption path used to only ever touch
  // chapters/scenes, so a title/author changed elsewhere never made it back down here.
  const bookRow = await dbGet("books", bookId);
  if (bookRow) {
    const titleChanged = remoteManifest.title && bookRow.title !== remoteManifest.title;
    const authorChanged = remoteManifest.author !== undefined && (bookRow.author || "") !== remoteManifest.author;
    if (titleChanged || authorChanged) {
      await dbPut("books", {
        ...bookRow,
        title: titleChanged ? remoteManifest.title : bookRow.title,
        author: authorChanged ? remoteManifest.author : bookRow.author,
        updatedAt: now,
      });
    }
  }

  const newChapterRows = [];
  for (const [chIndex, ch] of remoteManifest.chapters.entries()) {
    newChapterRows.push({ id: ch.id, bookId, title: ch.title, order: chIndex, updatedAt: now });

    for (const [scIndex, sceneId] of ch.sceneIds.entries()) {
      const existing = localScenesById.get(sceneId);
      if (existing) {
        // Always adopt remote's placement/order, even if this scene also has an unpushed
        // *content* edit (a separate concern the caller resolves independently via its own sha
        // diff) — chapters are about to be wholesale-replaced below, so skipping this used to
        // leave a content-dirty scene pointing at a chapterId that no longer existed, silently
        // orphaning it (invisible in the UI, though its content survived in IndexedDB) whenever
        // it had a pending content conflict at the same moment the manifest changed remotely.
        await dbPut("scenes", { ...existing, chapterId: ch.id, order: scIndex });
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
  const toRow = (kind) => (c, i) => ({
    id: c.id, name: c.name, entries: entriesFromLegacy(c), bookId, kind, order: i, updatedAt: now,
  });
  const rows = [
    ...(remoteBible.characters || []).map(toRow("character")),
    ...(remoteBible.locations || []).map(toRow("location")),
    ...(remoteBible.concepts || []).map(toRow("concept")),
  ];
  await dbReplaceWhereIndex("bibleEntries", "bookId", bookId, rows);
}

/**
 * Pulls remote changes for one book. For each of manifest/bible/scenes: if it changed on
 * GitHub and we have no pending local edit to it, fast-forward local state to match. If we
 * *do* have a pending local edit and remote also changed, record a conflict — same shape and
 * resolution path (Keep Mine / Use GitHub's) as a conflict discovered while pushing.
 *
 * `justPushed` (a `"kind:targetId"` Set, from drainOutbox's return value) marks targets this
 * same sync cycle already pushed successfully — skipped here even if the tree read below still
 * shows their pre-push sha, since that's GitHub's git data endpoints lagging the Contents API
 * commit we just made rather than a real independent remote change (see drainOutbox).
 */
export async function reconcileBook(bookId, justPushed = new Set()) {
  const { token, owner, repo, defaultBranch } = await getGithubSettings();
  if (!token || !owner || !repo) return { pulled: 0, conflicts: 0, pulledTargets: new Set(), skipped: true };

  const ref = defaultBranch || "main";
  let remoteByPath;
  try {
    remoteByPath = await getBookRemoteTree(token, owner, repo, ref, bookId);
  } catch (err) {
    return { pulled: 0, conflicts: 0, pulledTargets: new Set(), error: err.message };
  }

  const outbox = await dbGetAll("outbox");
  const dirtyKeys = new Set(
    outbox.filter((e) => e.bookId === bookId).map((e) => `${e.kind}:${e.targetId}`)
  );

  let pulled = 0;
  let conflicts = 0;
  // Which specific things actually changed, in case a caller wants to react to just these rather
  // than reloading everything.
  const pulledTargets = new Set();
  const prefix = `books/${bookId}/`;

  const manifestSha = remoteByPath.get(`${prefix}manifest.json`);
  const meta = (await dbGet("manifestMeta", bookId)) || { bookId };
  if (manifestSha && manifestSha !== meta.manifestSha && !justPushed.has(`manifest:${bookId}`)) {
    if (dirtyKeys.has(`manifest:${bookId}`)) {
      if (!(await confirmRemoteSha(token, owner, repo, `${prefix}manifest.json`, meta.manifestSha))) {
        await recordConflict(token, owner, repo, { key: outboxKey(bookId, "manifest", bookId), bookId, kind: "manifest", targetId: bookId });
        conflicts += 1;
      }
    } else {
      const blob = await gh.getBlob(token, owner, repo, manifestSha);
      await applyRemoteManifest(bookId, JSON.parse(blob.content), remoteByPath, token, owner, repo);
      await dbPut("manifestMeta", { ...meta, bookId, manifestSha });
      pulled += 1;
      pulledTargets.add(`manifest:${bookId}`);
    }
  }

  const bibleSha = remoteByPath.get(`${prefix}bible.json`);
  const meta2 = (await dbGet("manifestMeta", bookId)) || { bookId };
  if (bibleSha && bibleSha !== meta2.bibleSha && !justPushed.has(`bible:${bookId}`)) {
    if (dirtyKeys.has(`bible:${bookId}`)) {
      if (!(await confirmRemoteSha(token, owner, repo, `${prefix}bible.json`, meta2.bibleSha))) {
        await recordConflict(token, owner, repo, { key: outboxKey(bookId, "bible", bookId), bookId, kind: "bible", targetId: bookId });
        conflicts += 1;
      }
    } else {
      const blob = await gh.getBlob(token, owner, repo, bibleSha);
      await applyRemoteBible(bookId, JSON.parse(blob.content));
      await dbPut("manifestMeta", { ...meta2, bookId, bibleSha });
      pulled += 1;
      pulledTargets.add(`bible:${bookId}`);
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
    if (!remoteSha || remoteSha === knownSha || justPushed.has(`scene:${sc.id}`)) continue;
    if (dirtyKeys.has(`scene:${sc.id}`)) {
      if (!(await confirmRemoteSha(token, owner, repo, path, knownSha))) {
        await recordConflict(token, owner, repo, { key: outboxKey(bookId, "scene", sc.id), bookId, kind: "scene", targetId: sc.id });
        conflicts += 1;
      }
    } else {
      const blob = await gh.getBlob(token, owner, repo, remoteSha);
      const parsed = markdownToScene(blob.content);
      await dbPut("scenes", { ...sc, ...parsed });
      await dbPut("sceneSync", { id: sc.id, bookId, remoteSha });
      pulled += 1;
      pulledTargets.add(`scene:${sc.id}`);
    }
  }

  return { pulled, conflicts, pulledTargets };
}

/** Read-only check for whether GitHub has anything newer than what this device already knows
 *  about for this book — drives the pull banner/badge. Never writes anything locally and never
 *  resolves a conflict; pullChanges (reconcileBook) is what actually applies (or conflicts on)
 *  whatever this finds. Same cost/shape as a `git fetch` versus a `git pull` — a tree read and a
 *  handful of local sha comparisons, no blob downloads. Returns a `count` (how many of
 *  manifest/bible/scenes differ) alongside `hasChanges` so the topbar badge and the Settings Pull
 *  section can both show "how many" without any extra network calls — comparisons keep going
 *  instead of returning as soon as the first difference is found.
 *
 *  `justPushed` (a `"kind:targetId"` Set, e.g. from pushChanges's `pushedTargets`) excludes
 *  targets this same device just pushed successfully, same reasoning as reconcileBook's own
 *  `justPushed` — GitHub's git-trees endpoint (used below) can lag a moment behind a just-made
 *  Contents API commit, and without this, calling this right after a push (every caller does, to
 *  refresh the pull banner) would misreport the device's own just-pushed changes as incoming. */
export async function checkRemoteChanges(bookId, justPushed = new Set()) {
  if (!bookId) return { hasChanges: false, count: 0 };
  const { token, owner, repo, defaultBranch } = await getGithubSettings();
  if (!token || !owner || !repo) return { hasChanges: false, count: 0 };

  let remoteByPath;
  try {
    remoteByPath = await getBookRemoteTree(token, owner, repo, defaultBranch || "main", bookId);
  } catch {
    return { hasChanges: false, count: 0 };
  }

  const prefix = `books/${bookId}/`;
  const meta = (await dbGet("manifestMeta", bookId)) || {};
  let count = 0;
  if (
    remoteByPath.has(`${prefix}manifest.json`) &&
    remoteByPath.get(`${prefix}manifest.json`) !== meta.manifestSha &&
    !justPushed.has(`manifest:${bookId}`)
  ) {
    count += 1;
  }
  if (
    remoteByPath.has(`${prefix}bible.json`) &&
    remoteByPath.get(`${prefix}bible.json`) !== meta.bibleSha &&
    !justPushed.has(`bible:${bookId}`)
  ) {
    count += 1;
  }

  // Only scenes this device already knows about can be "changed remotely" independent of the
  // manifest — a scene the manifest doesn't yet reference would already have been caught by the
  // manifest-sha check above (that's how reconcileBook itself discovers brand-new scenes, via
  // applyRemoteManifest). Comparing every scenes/*.md path found in the tree instead — including
  // ones this device has never adopted, e.g. a leftover file no chapter's sceneIds actually lists
  // — would report "changed" forever, since nothing reconcileBook does ever touches those paths.
  const [localScenes, sceneSyncRows] = await Promise.all([
    dbGetAllByIndex("scenes", "bookId", bookId),
    dbGetAllByIndex("sceneSync", "bookId", bookId),
  ]);
  const syncById = new Map(sceneSyncRows.map((s) => [s.id, s]));
  for (const sc of localScenes) {
    const remoteSha = remoteByPath.get(`${prefix}scenes/${sc.id}.md`);
    if (remoteSha && remoteSha !== syncById.get(sc.id)?.remoteSha && !justPushed.has(`scene:${sc.id}`)) count += 1;
  }

  return { hasChanges: count > 0, count };
}

/**
 * Read-only preview of what pushing right now would send to GitHub — every current outbox entry
 * (all books, matching drainOutbox's own scope), paired with its local content
 * (getLocalContentForConflict — the same serialization pushOne would actually send) and its
 * current remote content (gh.getFile — null if the file doesn't exist on GitHub yet). Never
 * writes anything, never touches the outbox itself. Reads run in parallel since, unlike
 * drainOutbox's writes, there's no per-entry failure/retry bookkeeping to serialize around.
 */
export async function previewPush() {
  const { token, owner, repo } = await getGithubSettings();
  if (!token || !owner || !repo) return { entries: [] };

  const outbox = await dbGetAll("outbox");
  const entries = await Promise.all(
    outbox.map(async (entry) => {
      const path = pathForEntry(entry);
      const [localRaw, remote] = await Promise.all([
        getLocalContentForConflict(entry),
        gh.getFile(token, owner, repo, path).catch(() => null),
      ]);
      const remoteRaw = remote ? remote.content : null;

      let changeType;
      if (localRaw === null && remoteRaw === null) changeType = "noop";
      else if (localRaw === null) changeType = "delete";
      else if (remoteRaw === null) changeType = "create";
      else if (localRaw === remoteRaw) changeType = "unchanged";
      else changeType = "update";

      return {
        key: entry.key, bookId: entry.bookId, kind: entry.kind, targetId: entry.targetId, path,
        changeType, localRaw, remoteRaw, skipped: !!entry.skipped,
      };
    })
  );

  return { entries };
}

/**
 * Read-only preview of what pulling right now would bring in for one book — the read-only
 * sibling of reconcileBook. For manifest, bible, and every scene this device already knows about:
 * if the remote sha differs from what was last synced, fetch the remote blob and pair it with the
 * current local content. Flags `dirty: true` when a pending outbox entry means reconcileBook
 * would record a conflict for that target instead of fast-forwarding it.
 *
 * When the manifest changed, also diffs remote vs local chapter/sceneId lists to call out
 * individual scenes by title as `addedScenes` (exist remotely but not locally yet — reconcileBook
 * will adopt them in full) or `removedScenes` (referenced locally but no longer by any chapter on
 * GitHub — reconcileBook never deletes the local scene row, but it does drop out of every
 * chapter, i.e. out of the visible manuscript, once the manifest's chapters are adopted). This is
 * a best-effort itemization on top of summarizeManifest's own generic "Chapters added/removed" /
 * "Scene placement" fields, not a replacement for them (those still cover chapter-level and
 * within-existing-chapter moves).
 *
 * `justPushed` (a `"kind:targetId"` Set, e.g. from pushChanges's `pushedTargets`) excludes targets
 * this same device just pushed successfully — same lag reasoning as reconcileBook/
 * checkRemoteChanges above: GitHub's git-trees endpoint (used below) can still show a just-pushed
 * target's pre-push sha for a moment, which without this would preview the device's own
 * just-pushed edit as an incoming remote change.
 */
export async function previewPull(bookId, justPushed = new Set()) {
  const emptyShape = {
    manifestChanged: false, manifestDirty: false, manifestCurrentRaw: null, manifestRemoteRaw: null,
    bibleChanged: false, bibleDirty: false, bibleCurrentRaw: null, bibleRemoteRaw: null,
    addedScenes: [], removedScenes: [], changedScenes: [],
  };
  const { token, owner, repo, defaultBranch } = await getGithubSettings();
  if (!token || !owner || !repo) return { ...emptyShape, skipped: true };

  const ref = defaultBranch || "main";
  let remoteByPath;
  try {
    remoteByPath = await getBookRemoteTree(token, owner, repo, ref, bookId);
  } catch (err) {
    return { ...emptyShape, error: err.message };
  }

  const outbox = await dbGetAll("outbox");
  const dirtyKeys = new Set(outbox.filter((e) => e.bookId === bookId).map((e) => `${e.kind}:${e.targetId}`));
  const prefix = `books/${bookId}/`;
  const meta = (await dbGet("manifestMeta", bookId)) || {};

  // Fetched up front (not just for changedScenes below) since addedScenes/removedScenes also need
  // to know which scene ids already exist locally, matching applyRemoteManifest's own check.
  const [localScenes, sceneSyncRows] = await Promise.all([
    dbGetAllByIndex("scenes", "bookId", bookId),
    dbGetAllByIndex("sceneSync", "bookId", bookId),
  ]);
  const localScenesById = new Map(localScenes.map((sc) => [sc.id, sc]));
  const syncById = new Map(sceneSyncRows.map((s) => [s.id, s]));

  let manifestChanged = false, manifestDirty = false, manifestCurrentRaw = null, manifestRemoteRaw = null;
  let addedScenes = [], removedScenes = [];
  const manifestSha = remoteByPath.get(`${prefix}manifest.json`);
  if (manifestSha && manifestSha !== meta.manifestSha && !justPushed.has(`manifest:${bookId}`)) {
    manifestChanged = true;
    manifestDirty = dirtyKeys.has(`manifest:${bookId}`);
    [manifestCurrentRaw, manifestRemoteRaw] = await Promise.all([
      getLocalContentForConflict({ bookId, kind: "manifest", targetId: bookId }),
      gh.getBlob(token, owner, repo, manifestSha).then((b) => b.content),
    ]);

    try {
      const remoteManifest = JSON.parse(manifestRemoteRaw);
      const localManifest = JSON.parse(manifestCurrentRaw);
      const remoteSceneIds = new Set(remoteManifest.chapters.flatMap((ch) => ch.sceneIds || []));
      const localSceneIds = new Set(localManifest.chapters.flatMap((ch) => ch.sceneIds || []));

      const newIds = [...remoteSceneIds].filter((id) => !localScenesById.has(id));
      addedScenes = (
        await Promise.all(
          newIds.map(async (id) => {
            const sha = remoteByPath.get(`${prefix}scenes/${id}.md`);
            if (!sha) return null;
            const blob = await gh.getBlob(token, owner, repo, sha);
            const parsed = markdownToScene(blob.content);
            return { id, title: parsed.title || "Untitled scene", remoteRaw: blob.content };
          })
        )
      ).filter(Boolean);

      removedScenes = [...localSceneIds]
        .filter((id) => !remoteSceneIds.has(id) && localScenesById.has(id))
        .map((id) => ({ id, title: localScenesById.get(id).title || "Untitled scene" }));
    } catch {
      // Best-effort — if either manifest fails to parse, skip the itemized add/remove list;
      // summarizeManifest's generic fields (rendered separately) still cover the change.
    }
  }

  let bibleChanged = false, bibleDirty = false, bibleCurrentRaw = null, bibleRemoteRaw = null;
  const bibleSha = remoteByPath.get(`${prefix}bible.json`);
  if (bibleSha && bibleSha !== meta.bibleSha && !justPushed.has(`bible:${bookId}`)) {
    bibleChanged = true;
    bibleDirty = dirtyKeys.has(`bible:${bookId}`);
    [bibleCurrentRaw, bibleRemoteRaw] = await Promise.all([
      getLocalContentForConflict({ bookId, kind: "bible", targetId: bookId }),
      gh.getBlob(token, owner, repo, bibleSha).then((b) => b.content),
    ]);
  }

  // Scenes whose content changed remotely — only ones already local, matching reconcileBook's own
  // scope (addedScenes above covers the "not local yet" case).
  const toFetch = localScenes
    .map((sc) => ({ sc, remoteSha: remoteByPath.get(`${prefix}scenes/${sc.id}.md`), knownSha: syncById.get(sc.id)?.remoteSha }))
    .filter(({ sc, remoteSha, knownSha }) => remoteSha && remoteSha !== knownSha && !justPushed.has(`scene:${sc.id}`));

  const changedScenes = await Promise.all(
    toFetch.map(async ({ sc, remoteSha }) => {
      const [currentRaw, remoteRaw] = await Promise.all([
        getLocalContentForConflict({ bookId, kind: "scene", targetId: sc.id }),
        gh.getBlob(token, owner, repo, remoteSha).then((b) => b.content),
      ]);
      return { id: sc.id, title: sc.title, dirty: dirtyKeys.has(`scene:${sc.id}`), currentRaw, remoteRaw };
    })
  );

  return {
    manifestChanged, manifestDirty, manifestCurrentRaw, manifestRemoteRaw,
    bibleChanged, bibleDirty, bibleCurrentRaw, bibleRemoteRaw,
    addedScenes, removedScenes, changedScenes,
  };
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
    await applyRemoteManifest(conflict.bookId, JSON.parse(conflict.remoteContent), remoteByPath, token, owner, repo);
    const meta = (await dbGet("manifestMeta", conflict.bookId)) || { bookId: conflict.bookId };
    await dbPut("manifestMeta", { ...meta, manifestSha: conflict.remoteSha });
  }

  await dbDelete("outbox", key);
  await dbDelete("conflicts", key);
}

/**
 * Discards one pending local change and snaps that single object back to GitHub's current state —
 * the "Revert" action in the push preview, for something like a new scene the user decides they
 * don't want after all. Unlike Ignore (setOutboxEntrySkipped), this doesn't just hide the change;
 * it undoes it and clears the outbox entry.
 *
 * If GitHub has never seen this target (a brand-new scene that was never pushed), there's nothing
 * to revert *to* — the only sensible interpretation is to delete the local copy. For anything
 * GitHub does have a copy of, this applies that remote copy locally, same as resolveConflictUseTheirs
 * does for an already-detected conflict — the difference is this fetches the remote copy live
 * (there's no conflict record yet, since nothing collided) rather than reading a stashed one.
 */
export async function revertOutboxEntry(key) {
  const entry = await dbGet("outbox", key);
  if (!entry) return;
  const { bookId, kind, targetId } = entry;
  const { token, owner, repo, defaultBranch } = await getGithubSettings();
  const path = pathForEntry(entry);
  const remote = await gh.getFile(token, owner, repo, path);

  if (!remote) {
    // Never pushed — only a scene create is safe to just discard (manifest/bible always exist
    // once a book is bootstrapped, so this branch shouldn't be reachable for them in practice).
    if (kind === "scene") {
      await dbDelete("scenes", targetId);
      await dbDelete("sceneSync", targetId);
    }
  } else if (kind === "scene") {
    const existing = await dbGet("scenes", targetId);
    if (existing) {
      // Reverting an edit to a scene that's still here — overwrite with GitHub's content in place.
      await dbPut("scenes", { ...existing, ...markdownToScene(remote.content) });
    } else {
      // Reverting a local deletion — the scene row is gone, so its chapter/order has to come from
      // GitHub's current manifest (the local manifest no longer references it).
      const remoteByPath = await getBookRemoteTree(token, owner, repo, defaultBranch || "main", bookId);
      const manifestSha = remoteByPath.get(`books/${bookId}/manifest.json`);
      const remoteManifest = manifestSha ? JSON.parse((await gh.getBlob(token, owner, repo, manifestSha)).content) : null;
      const placement = remoteManifest?.chapters
        ?.flatMap((ch) => (ch.sceneIds || []).map((id, scIndex) => ({ id, chapterId: ch.id, order: scIndex })))
        .find((p) => p.id === targetId);
      if (placement) {
        await dbPut("scenes", {
          id: targetId, bookId, chapterId: placement.chapterId, order: placement.order,
          ...markdownToScene(remote.content),
        });
      }
    }
    await dbPut("sceneSync", { id: targetId, bookId, remoteSha: remote.sha });
  } else if (kind === "bible") {
    await applyRemoteBible(bookId, JSON.parse(remote.content));
    const meta = (await dbGet("manifestMeta", bookId)) || { bookId };
    await dbPut("manifestMeta", { ...meta, bibleSha: remote.sha });
  } else if (kind === "manifest") {
    const remoteByPath = await getBookRemoteTree(token, owner, repo, defaultBranch || "main", bookId);
    await applyRemoteManifest(bookId, JSON.parse(remote.content), remoteByPath, token, owner, repo);
    const meta = (await dbGet("manifestMeta", bookId)) || { bookId };
    await dbPut("manifestMeta", { ...meta, manifestSha: remote.sha });
  }

  await dbDelete("outbox", key);
}

/** Resolves every current conflict the same way — "mine" (resolveConflictKeepMine) or "theirs"
 *  (resolveConflictUseTheirs) for all of them — for clearing out a batch of conflicts (e.g. after
 *  reconnecting resets local sync bookkeeping and re-flags already-matching content, see
 *  disconnectGithub) without clicking through each one individually. Returns the distinct bookIds
 *  touched, so the caller knows whether the currently open book needs refreshing. */
export async function resolveAllConflicts(strategy) {
  const conflicts = await listConflicts();
  const bookIds = new Set();
  for (const c of conflicts) {
    if (strategy === "mine") await resolveConflictKeepMine(c.key);
    else await resolveConflictUseTheirs(c.key);
    bookIds.add(c.bookId);
  }
  return { count: conflicts.length, bookIds: [...bookIds] };
}

/* ---------------------------------------------------------------- */
/* History browsing & restore-to-a-point-in-time                     */
/* Every push is its own commit (see pushOne), so the connected repo */
/* already holds the full history of every scene/manifest/bible for  */
/* a book — this just exposes it: list past commits, preview what    */
/* differs from the current state, and restore by applying a past    */
/* snapshot locally and pushing it forward as new commits (nothing   */
/* in git history is rewritten or deleted).                          */
/* ---------------------------------------------------------------- */

/** Commits touching this book's folder, most recent first. */
export async function listBookHistory(bookId, { perPage = 25, page = 1 } = {}) {
  const { token, owner, repo, defaultBranch } = await getGithubSettings();
  if (!token || !owner || !repo) return [];
  return gh.listCommits(token, owner, repo, `books/${bookId}`, defaultBranch || "main", { perPage, page });
}

/** A book is only safe to browse/restore history for once it's fully synced — with a pending
 *  push or an unresolved conflict, "current" is ambiguous (the local edit, or what's on GitHub?),
 *  and a restore would either silently drop the pending edit or fight the conflict-resolution
 *  flow over the same target. */
export async function isBookClean(bookId) {
  const [outbox, conflicts] = await Promise.all([dbGetAll("outbox"), dbGetAll("conflicts")]);
  return !outbox.some((e) => e.bookId === bookId) && !conflicts.some((c) => c.bookId === bookId);
}

/** Diffs the book's current (fully-synced) state against a historical commit — the data source
 *  for the restore preview. Returns raw serialized strings in exactly the shape
 *  summarizeManifest/summarizeBible/summarizeScene (settings-ui.js) already expect, so the
 *  restore UI can reuse that diffing code unchanged. Only fetches blob content for paths that
 *  actually differ between the two trees (sha comparison itself needs no network call) or exist
 *  on just one side. */
export async function previewRestore(bookId, commitSha) {
  const { token, owner, repo, defaultBranch } = await getGithubSettings();
  const [historicalByPath, currentByPath] = await Promise.all([
    getBookRemoteTree(token, owner, repo, commitSha, bookId),
    getBookRemoteTree(token, owner, repo, defaultBranch || "main", bookId),
  ]);
  const prefix = `books/${bookId}/`;
  if (!historicalByPath.has(`${prefix}manifest.json`)) {
    throw new Error("This point in time predates this book having a saved structure — pick a later one.");
  }

  async function fetchIfChanged(path) {
    const historicalSha = historicalByPath.get(path);
    const currentSha = currentByPath.get(path);
    if (historicalSha === currentSha) return { changed: false, historicalRaw: null, currentRaw: null };
    const [historicalRaw, currentRaw] = await Promise.all([
      historicalSha ? gh.getBlob(token, owner, repo, historicalSha).then((b) => b.content) : null,
      currentSha ? gh.getBlob(token, owner, repo, currentSha).then((b) => b.content) : null,
    ]);
    return { changed: true, historicalRaw, currentRaw };
  }

  const manifestDiff = await fetchIfChanged(`${prefix}manifest.json`);
  const bibleDiff = await fetchIfChanged(`${prefix}bible.json`);

  const scenePathPrefix = `${prefix}scenes/`;
  const sceneIdFromPath = (path) => path.slice(scenePathPrefix.length, -".md".length);
  const scenePaths = [...new Set([...historicalByPath.keys(), ...currentByPath.keys()])].filter(
    (p) => p.startsWith(scenePathPrefix) && p.endsWith(".md")
  );

  const changedScenes = [];
  for (const path of scenePaths) {
    const diff = await fetchIfChanged(path);
    if (!diff.changed) continue;
    const title = (diff.currentRaw && markdownToScene(diff.currentRaw).title)
      || (diff.historicalRaw && markdownToScene(diff.historicalRaw).title)
      || "Untitled Scene";
    changedScenes.push({ id: sceneIdFromPath(path), title, currentRaw: diff.currentRaw, historicalRaw: diff.historicalRaw });
  }

  return {
    manifestChanged: manifestDiff.changed,
    manifestCurrentRaw: manifestDiff.currentRaw,
    manifestHistoricalRaw: manifestDiff.historicalRaw,
    bibleChanged: bibleDiff.changed,
    bibleCurrentRaw: bibleDiff.currentRaw,
    bibleHistoricalRaw: bibleDiff.historicalRaw,
    changedScenes,
  };
}

/**
 * Restores a book to how it looked at `commitSha`: applies that historical manifest/bible/scene
 * content to local state and marks it all dirty so the caller's next push sends it to GitHub as
 * new commits — a git-revert-style operation, nothing in history is rewritten or deleted. Only
 * writes to IndexedDB; like resolveConflictUseTheirs/reconcileBook, callers are responsible for
 * running this inside withSyncLock and refreshing in-memory `data` afterward.
 */
export async function restoreToCommit(bookId, commitSha) {
  if (!(await isBookClean(bookId))) {
    throw new Error("You have unsynced local changes — sync first before restoring.");
  }

  const { token, owner, repo } = await getGithubSettings();
  const historicalByPath = await getBookRemoteTree(token, owner, repo, commitSha, bookId);
  const prefix = `books/${bookId}/`;
  const manifestSha = historicalByPath.get(`${prefix}manifest.json`);
  if (!manifestSha) {
    throw new Error("This point in time predates this book having a saved structure — pick a later one.");
  }
  const manifest = JSON.parse((await gh.getBlob(token, owner, repo, manifestSha)).content);

  const bibleSha = historicalByPath.get(`${prefix}bible.json`);
  const bible = bibleSha
    ? JSON.parse((await gh.getBlob(token, owner, repo, bibleSha)).content)
    : { characters: [], locations: [], concepts: [] };

  const now = new Date().toISOString();
  const keptSceneIds = new Set(manifest.chapters.flatMap((ch) => ch.sceneIds));

  // Anything currently in this book but absent from the historical manifest is being restored
  // away — delete it locally and enqueue its remote deletion too (same mechanism deleteScene/
  // importManuscriptMarkdown in ui.js already use), so it doesn't linger as an orphaned file on
  // GitHub once this is pushed.
  const localScenes = await dbGetAllByIndex("scenes", "bookId", bookId);
  for (const sc of localScenes) {
    if (!keptSceneIds.has(sc.id)) {
      await dbDelete("scenes", sc.id);
      await enqueueSync("scene", sc.id, bookId);
    }
  }

  const newChapterRows = [];
  for (const [chIndex, ch] of manifest.chapters.entries()) {
    newChapterRows.push({ id: ch.id, bookId, title: ch.title, order: chIndex, updatedAt: now });
    for (const [scIndex, sceneId] of ch.sceneIds.entries()) {
      const sha = historicalByPath.get(`${prefix}scenes/${sceneId}.md`);
      if (!sha) continue;
      const parsed = markdownToScene((await gh.getBlob(token, owner, repo, sha)).content);
      await dbPut("scenes", {
        id: sceneId, bookId, chapterId: ch.id, order: scIndex,
        title: parsed.title, summary: parsed.summary, text: parsed.text, todos: parsed.todos,
        updatedAt: parsed.updatedAt || now,
      });
      await enqueueSync("scene", sceneId, bookId);
    }
  }
  await dbReplaceWhereIndex("chapters", "bookId", bookId, newChapterRows);
  await applyRemoteBible(bookId, bible);

  const bookRow = await dbGet("books", bookId);
  if (bookRow) {
    const titleChanged = manifest.title && bookRow.title !== manifest.title;
    const authorChanged = manifest.author !== undefined && (bookRow.author || "") !== manifest.author;
    if (titleChanged || authorChanged) {
      await dbPut("books", {
        ...bookRow,
        title: titleChanged ? manifest.title : bookRow.title,
        author: authorChanged ? manifest.author : bookRow.author,
        updatedAt: now,
      });
    }
  }

  await enqueueSync("manifest", bookId, bookId);
  await enqueueSync("bible", bookId, bookId);

  // Deliberately doesn't touch manifestMeta's shas: they still hold the pre-restore (current,
  // fully-synced) shas, which is exactly the right "expected sha" for the push this triggers — if
  // something else changed the remote in the meantime, that push naturally 409s into the ordinary
  // conflict flow instead of silently clobbering it.
}

"use strict";

/* ---------------------------------------------------------------- */
/* Minimal promise-based IndexedDB wrapper.                          */
/* Hand-rolled rather than pulling in a CDN library: this is the     */
/* core data-durability layer, so it shouldn't depend on a third-    */
/* party host being reachable to even boot the app.                 */
/* ---------------------------------------------------------------- */

const DB_NAME = "writertool";
const DB_VERSION = 3;

let dbPromise = null;

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      if (!db.objectStoreNames.contains("books")) {
        db.createObjectStore("books", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("chapters")) {
        const s = db.createObjectStore("chapters", { keyPath: "id" });
        s.createIndex("bookId", "bookId");
      }
      if (!db.objectStoreNames.contains("scenes")) {
        const s = db.createObjectStore("scenes", { keyPath: "id" });
        s.createIndex("bookId", "bookId");
        s.createIndex("chapterId", "chapterId");
      }
      if (!db.objectStoreNames.contains("bibleEntries")) {
        const s = db.createObjectStore("bibleEntries", { keyPath: "id" });
        s.createIndex("bookId", "bookId");
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("manifestMeta")) {
        db.createObjectStore("manifestMeta", { keyPath: "bookId" });
      }
      if (!db.objectStoreNames.contains("outbox")) {
        // key is a deterministic "bookId:kind:targetId" string, so re-enqueuing the
        // same target just overwrites the pending row instead of needing a lookup.
        db.createObjectStore("outbox", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("conflicts")) {
        db.createObjectStore("conflicts", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("sceneSync")) {
        const s = db.createObjectStore("sceneSync", { keyPath: "id" });
        s.createIndex("bookId", "bookId");
      }

      // v2 -> v3: `remoteSha` used to live embedded on each "scenes" row. persistNow does a
      // full read-modify-write of that whole store on every debounced local save, so a save
      // that read its snapshot just before a concurrent push finished — then wrote just after —
      // silently reverted the sha the push had just recorded (and, worse, could revert content
      // edits made mid-push too). Moving it into its own store that persistNow never touches
      // makes that race impossible by construction. Carry forward already-synced scenes' shas
      // so they don't look "changed remotely" and get needlessly re-conflicted post-upgrade.
      if (event.oldVersion > 0 && event.oldVersion < 3 && db.objectStoreNames.contains("scenes")) {
        const scenesStore = tx.objectStore("scenes");
        const sceneSyncStore = tx.objectStore("sceneSync");
        scenesStore.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          const row = cursor.value;
          if (row.remoteSha) {
            sceneSyncStore.put({ id: row.id, bookId: row.bookId, remoteSha: row.remoteSha });
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab opened this database at a newer version (e.g. after a code update).
      // Close our stale connection so that tab's upgrade can proceed instead of hanging blocked.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      console.warn(
        "Novellum: IndexedDB upgrade is blocked by another open tab of this app. " +
        "Close other tabs/windows running Novellum and reload this page."
      );
    };
  });
  return dbPromise;
}

export async function dbGetAll(storeName) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetAllByIndex(storeName, indexName, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).index(indexName).getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGet(storeName, key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbPut(storeName, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Clears the entire store and writes `values` in one transaction. */
export async function dbReplaceAll(storeName, values) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    store.clear();
    for (const v of values) store.put(v);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Deletes all rows matching `indexName === indexValue`, then writes `newValues` — one atomic transaction. */
export async function dbReplaceWhereIndex(storeName, indexName, indexValue, newValues) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const cursorReq = store.index(indexName).openCursor(IDBKeyRange.only(indexValue));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        for (const v of newValues) store.put(v);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbDelete(storeName, key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

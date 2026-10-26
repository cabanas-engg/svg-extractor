// Recent files and their sessions, kept in IndexedDB so a reload can reopen
// them. Bytes live in their own store: listing recents must not pull every PDF
// into memory.

const DB_NAME = 'svg-extractor';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('storage transaction aborted'));
  });
}

let dbPromise;
function db() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

export function idbStorage() {
  return {
    async list() {
      const database = await db();
      const tx = database.transaction('meta', 'readonly');
      const all = await requestToPromise(tx.objectStore('meta').getAll());
      await txDone(tx);
      return all
        .map(({ name, size, modified, assets }) => ({ name, size, modified, assets: assets ?? null }))
        .sort((a, b) => b.modified - a.modified)
        .slice(0, 20);
    },
    async getMeta(name) {
      const database = await db();
      const tx = database.transaction('meta', 'readonly');
      const row = await requestToPromise(tx.objectStore('meta').get(name));
      await txDone(tx);
      return row || null;
    },
    async getBytes(name) {
      const database = await db();
      const tx = database.transaction('blobs', 'readonly');
      const row = await requestToPromise(tx.objectStore('blobs').get(name));
      await txDone(tx);
      return row?.bytes || null;
    },
    async getSession(name) {
      const database = await db();
      const tx = database.transaction('sessions', 'readonly');
      const row = await requestToPromise(tx.objectStore('sessions').get(name));
      await txDone(tx);
      return row?.session || null;
    },
    async putFile(name, bytes, info) {
      const database = await db();
      const tx = database.transaction(['meta', 'blobs'], 'readwrite');
      tx.objectStore('meta').put({ ...info, name });
      tx.objectStore('blobs').put({ name, bytes });
      await txDone(tx);
    },
    async saveSession(name, session, assets) {
      const database = await db();
      const tx = database.transaction(['meta', 'sessions'], 'readwrite');
      const meta = await requestToPromise(tx.objectStore('meta').get(name));
      if (meta) tx.objectStore('meta').put({ ...meta, assets });
      const { stale, ...rest } = session;
      tx.objectStore('sessions').put({ name, session: rest });
      await txDone(tx);
    },
    async delete(name) {
      const database = await db();
      const tx = database.transaction(['meta', 'blobs', 'sessions'], 'readwrite');
      tx.objectStore('meta').delete(name);
      tx.objectStore('blobs').delete(name);
      tx.objectStore('sessions').delete(name);
      await txDone(tx);
    },
  };
}

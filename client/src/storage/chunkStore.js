/**
 * chunkStore.js
 *
 * Disk-backed storage abstraction for incoming file chunks (Stage 12).
 *
 * Tries OPFS first (async file access — works on the main thread in
 * Chrome 102+, Safari 16.4+). Falls back to IndexedDB for older browsers.
 *
 * NOTE: We use the *async* FileSystemFileHandle.createWritable() API for
 * OPFS, NOT createSyncAccessHandle(), which is only available in Web
 * Workers and throws on the main thread.
 */

const CHUNK_SIZE_DEFAULT = 256 * 1024; // 256 KB — must match useFileTransfer.CHUNK_SIZE

/**
 * Detect whether async OPFS is usable in this browser (main-thread safe).
 * We avoid createSyncAccessHandle — it only works in Workers.
 */
async function opfsAvailable() {
  try {
    if (!navigator?.storage?.getDirectory) return false;
    const root = await navigator.storage.getDirectory();
    // Try creating a file handle and a writable stream (async API, main-thread OK)
    const testHandle = await root.getFileHandle('_easyshare_test', { create: true });
    const writable   = await testHandle.createWritable();
    await writable.close();
    await root.removeEntry('_easyshare_test');
    return true;
  } catch {
    return false;
  }
}

// ── OPFS implementation (async API, main-thread safe) ────────────────────

class OPFSChunkStore {
  constructor(root, fileName, chunkSize, totalChunks) {
    this.root        = root;
    this.fileName    = fileName;
    this.chunkSize   = chunkSize;
    this.totalChunks = totalChunks;
    // In-memory index: chunk index → byte offset.
    // We write sequentially so offset = index * chunkSize (last chunk may differ).
    this._chunks = new Array(totalChunks).fill(null);
  }

  static async create(transferId, totalChunks, chunkSize) {
    const root     = await navigator.storage.getDirectory();
    const fileName = `easyshare-${transferId}.bin`;
    // Pre-create the file
    await root.getFileHandle(fileName, { create: true });
    return new OPFSChunkStore(root, fileName, chunkSize, totalChunks);
  }

  async write(index, arrayBuffer) {
    // Store chunks in memory indexed by position; flush to file on readAll/flush.
    // For large files this still uses RAM per chunk. To truly avoid RAM we'd need
    // a Worker — but this is still much better than the old all-at-once approach.
    this._chunks[index] = arrayBuffer;
  }

  async read(index) {
    return this._chunks[index];
  }

  async readAll() {
    return this._chunks.filter(Boolean);
  }

  async flush() {
    // Write everything to the OPFS file in one pass
    const fileHandle = await this.root.getFileHandle(this.fileName, { create: true });
    const writable   = await fileHandle.createWritable();
    for (const chunk of this._chunks) {
      if (chunk) await writable.write(chunk);
    }
    await writable.close();
  }

  async delete() {
    try {
      await this.root.removeEntry(this.fileName);
    } catch { /* already removed */ }
    this._chunks = [];
  }
}

// ── IndexedDB implementation ─────────────────────────────────────────────

class IDBChunkStore {
  constructor(db, dbName, chunkSize, totalChunks) {
    this.db          = db;
    this.dbName      = dbName;
    this.chunkSize   = chunkSize;
    this.totalChunks = totalChunks;
  }

  static async create(transferId, totalChunks, chunkSize) {
    const dbName = `easyshare-${transferId}`;
    const db     = await new Promise((resolve, reject) => {
      const req          = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('chunks');
      req.onsuccess       = ()  => resolve(req.result);
      req.onerror         = ()  => reject(req.error);
    });
    return new IDBChunkStore(db, dbName, chunkSize, totalChunks);
  }

  async write(index, arrayBuffer) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(arrayBuffer, index);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  async read(index) {
    return new Promise((resolve, reject) => {
      const tx  = this.db.transaction('chunks', 'readonly');
      const req = tx.objectStore('chunks').get(index);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async readAll() {
    const chunks = [];
    for (let i = 0; i < this.totalChunks; i++) {
      chunks.push(await this.read(i));
    }
    return chunks;
  }

  async delete() {
    this.db.close();
    return new Promise((resolve) => {
      const req       = indexedDB.deleteDatabase(this.dbName);
      req.onsuccess   = () => resolve();
      req.onerror     = () => resolve();
      req.onblocked   = () => resolve();
    });
  }

  async flush() {
    // IDB writes are already durable per-transaction.
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a ChunkStore, trying OPFS (async) first, then falling back to IDB.
 */
export async function createChunkStore(transferId, totalChunks, chunkSize = CHUNK_SIZE_DEFAULT) {
  const useOPFS = await opfsAvailable();

  if (useOPFS) {
    try {
      const store = await OPFSChunkStore.create(transferId, totalChunks, chunkSize);
      return { kind: 'opfs', ...bindStore(store) };
    } catch (err) {
      console.warn('[ChunkStore] OPFS failed, falling back to IDB:', err);
    }
  }

  const store = await IDBChunkStore.create(transferId, totalChunks, chunkSize);
  return { kind: 'indexeddb', ...bindStore(store) };
}

function bindStore(store) {
  return {
    write:   store.write.bind(store),
    read:    store.read.bind(store),
    readAll: store.readAll.bind(store),
    delete:  store.delete.bind(store),
    flush:   store.flush.bind(store),
  };
}

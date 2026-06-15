/**
 * chunkStore.js  —  Stage 12 (large-file fix)
 *
 * Two backends:
 *   OPFSChunkStore   — keeps a single FileSystemWritableFileStream open for
 *                      the lifetime of the transfer, writing each chunk to
 *                      disk immediately at the correct byte offset.
 *                      RAM usage: O(1) per chunk, not O(n).
 *   IDBChunkStore    — unchanged; IDB already persists per-transaction.
 *
 * The `read(index)` method on OPFS re-reads from disk so that
 * ReceiverPage can stream the download chunk-by-chunk without holding
 * everything in memory.
 */

const CHUNK_SIZE_DEFAULT = 256 * 1024; // must match useFileTransfer.CHUNK_SIZE

// ── OPFS availability check ──────────────────────────────────────────────────

async function opfsAvailable() {
  try {
    if (!navigator?.storage?.getDirectory) return false;
    const root = await navigator.storage.getDirectory();
    const testHandle = await root.getFileHandle('_easyshare_test', { create: true });
    const writable = await testHandle.createWritable();
    await writable.close();
    await root.removeEntry('_easyshare_test');
    return true;
  } catch {
    return false;
  }
}

// ── OPFS implementation ──────────────────────────────────────────────────────

class OPFSChunkStore {
  /**
   * @param {FileSystemDirectoryHandle} root
   * @param {FileSystemFileHandle}      fileHandle
   * @param {FileSystemWritableFileStream} writable  — kept open until flush()/delete()
   * @param {number} chunkSize
   * @param {number} totalChunks
   */
  constructor(root, fileHandle, writable, chunkSize, totalChunks) {
    this.root        = root;
    this.fileHandle  = fileHandle;
    this._writable   = writable;   // single stream, kept open
    this.chunkSize   = chunkSize;
    this.totalChunks = totalChunks;
    this._closed     = false;
  }

  static async create(transferId, totalChunks, chunkSize) {
    const root       = await navigator.storage.getDirectory();
    const fileName   = `easyshare-${transferId}.bin`;
    const fileHandle = await root.getFileHandle(fileName, { create: true });

    // Open once; we'll seek to the right offset for each chunk.
    // { keepExistingData: false } truncates any leftover from a previous attempt.
    const writable = await fileHandle.createWritable({ keepExistingData: false });

    return new OPFSChunkStore(root, fileHandle, writable, chunkSize, totalChunks);
  }

  /** Write chunk at its exact byte position — O(1) RAM. */
  async write(index, arrayBuffer) {
    if (this._closed) throw new Error('OPFSChunkStore: already closed');
    const offset = index * this.chunkSize;
    await this._writable.seek(offset);
    await this._writable.write(arrayBuffer);
  }

  /** Read one chunk back from disk for streaming download. */
  async read(index) {
    // We need a separate File read; the writable stream doesn't support reads.
    const file   = await this.fileHandle.getFile();
    const start  = index * this.chunkSize;
    const end    = Math.min(start + this.chunkSize, file.size);
    return file.slice(start, end).arrayBuffer();
  }

  /** Read all chunks sequentially — used by the Blob fallback path. */
  async readAll() {
    const file   = await this.fileHandle.getFile();
    const chunks = [];
    for (let i = 0; i < this.totalChunks; i++) {
      const start = i * this.chunkSize;
      const end   = Math.min(start + this.chunkSize, file.size);
      chunks.push(await file.slice(start, end).arrayBuffer());
    }
    return chunks;
  }

  /** Close the writable stream — must be called before read() or delete(). */
  async flush() {
    if (this._closed) return;
    this._closed = true;
    await this._writable.close();
  }

  async delete() {
    if (!this._closed) {
      try { await this._writable.close(); } catch { /* ignore */ }
      this._closed = true;
    }
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(this.fileHandle.name);
    } catch { /* already gone */ }
  }
}

// ── IndexedDB implementation (unchanged) ────────────────────────────────────

class IDBChunkStore {
  constructor(db, dbName, chunkSize, totalChunks) {
    this.db          = db;
    this.dbName      = dbName;
    this.chunkSize   = chunkSize;
    this.totalChunks = totalChunks;
  }

  static async create(transferId, totalChunks, chunkSize) {
    const dbName = `easyshare-${transferId}`;
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('chunks');
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
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

  async flush() {
    // IDB writes are durable per-transaction — nothing to do.
  }

  async delete() {
    this.db.close();
    return new Promise((resolve) => {
      const req     = indexedDB.deleteDatabase(this.dbName);
      req.onsuccess = () => resolve();
      req.onerror   = () => resolve();
      req.onblocked = () => resolve();
    });
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export async function createChunkStore(transferId, totalChunks, chunkSize = CHUNK_SIZE_DEFAULT) {
  if (await opfsAvailable()) {
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

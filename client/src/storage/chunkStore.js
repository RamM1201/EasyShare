/**
 * chunkStore.js
 *
 * Two backends:
 *   OPFSChunkStore   — keeps a single FileSystemWritableFileStream open for
 *                      the lifetime of the transfer, writing each chunk to
 *                      disk at the correct byte offset. RAM usage: O(1).
 *   IDBChunkStore    — IndexedDB fallback. Already persists per-transaction.
 *
 */

const CHUNK_SIZE_DEFAULT = 256 * 1024; // must match useFileTransfer.CHUNK_SIZE

// ── OPFS availability check ──────────────────────────────────────────────────

// Detect whether OPFS is available and writable.
async function opfsAvailable() {
  try {
    if (!navigator?.storage?.getDirectory) return false;
    const root       = await navigator.storage.getDirectory();
    const testHandle = await root.getFileHandle('_easyshare_test', { create: true });
    const writable   = await testHandle.createWritable();
    await writable.close();
    await root.removeEntry('_easyshare_test');
    return true;
  } catch {
    return false;
  }
}

// ── OPFS implementation ──────────────────────────────────────────────────────

class OPFSChunkStore {
  // Capture the writable file handle and transfer metadata.
  constructor(root, fileHandle, writable, chunkSize, totalChunks) {
    this.root        = root;
    this.fileHandle  = fileHandle;
    this._writable   = writable;
    this.chunkSize   = chunkSize;
    this.totalChunks = totalChunks;
    this._closed     = false;
    this._fileCache  = null; // cached File object after flush
  }

  // Create an OPFS-backed store for this transfer.
  static async create(transferId, totalChunks, chunkSize) {
    const root       = await navigator.storage.getDirectory();
    const fileName   = `easyshare-${transferId}.bin`;
    const fileHandle = await root.getFileHandle(fileName, { create: true });
    const writable   = await fileHandle.createWritable({ keepExistingData: false });
    return new OPFSChunkStore(root, fileHandle, writable, chunkSize, totalChunks);
  }

  // Write one chunk at its byte offset in the file.
  async write(index, arrayBuffer) {
    if (this._closed) throw new Error('OPFSChunkStore: already flushed — cannot write');
    const offset = index * this.chunkSize;
    await this._writable.seek(offset);
    await this._writable.write(arrayBuffer);
  }

  // Close the writable stream and cache the final File object.
  async flush() {
    if (this._closed) return;
    this._closed  = true;
    await this._writable.close();
    // Cache the File object so read() doesn't open it repeatedly
    this._fileCache = await this.fileHandle.getFile();
  }

  // Read one chunk from the finalized file.
  async read(index) {
    if (!this._closed) {
      throw new Error('OPFSChunkStore: flush() must be called before read()');
    }
    const file  = this._fileCache || (this._fileCache = await this.fileHandle.getFile());
    const start = index * this.chunkSize;
    const end   = Math.min(start + this.chunkSize, file.size);
    return file.slice(start, end).arrayBuffer();
  }

  // Read the finalized file back as ordered chunks.
  async readAll() {
    if (!this._closed) {
      throw new Error('OPFSChunkStore: flush() must be called before readAll()');
    }
    const file   = this._fileCache || (this._fileCache = await this.fileHandle.getFile());
    const chunks = [];
    for (let i = 0; i < this.totalChunks; i++) {
      const start = i * this.chunkSize;
      const end   = Math.min(start + this.chunkSize, file.size);
      chunks.push(await file.slice(start, end).arrayBuffer());
    }
    return chunks;
  }

  // Remove the stored file and release resources.
  async delete() {
    if (!this._closed) {
      try { await this._writable.close(); } catch { /* ignore */ }
      this._closed = true;
    }
    this._fileCache = null;
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(this.fileHandle.name);
    } catch { /* already gone */ }
  }
}

// ── IndexedDB implementation ─────────────────────────────────────────────────

class IDBChunkStore {
  // Keep the IndexedDB handle and transfer metadata.
  constructor(db, dbName, chunkSize, totalChunks) {
    this.db          = db;
    this.dbName      = dbName;
    this.chunkSize   = chunkSize;
    this.totalChunks = totalChunks;
  }

  // Create an IndexedDB-backed store for this transfer.
  static async create(transferId, totalChunks, chunkSize) {
    const dbName = `easyshare-${transferId}`;
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('chunks');
      req.onsuccess       = () => resolve(req.result);
      req.onerror         = () => reject(req.error);
    });
    return new IDBChunkStore(db, dbName, chunkSize, totalChunks);
  }

  // Store one chunk under its numeric index.
  async write(index, arrayBuffer) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(arrayBuffer, index);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  // Read one stored chunk by index.
  async read(index) {
    return new Promise((resolve, reject) => {
      const tx  = this.db.transaction('chunks', 'readonly');
      const req = tx.objectStore('chunks').get(index);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  // Read every chunk in order.
  async readAll() {
    const chunks = [];
    for (let i = 0; i < this.totalChunks; i++) {
      chunks.push(await this.read(i));
    }
    return chunks;
  }

  // IndexedDB writes are already durable per transaction.
  async flush() {}

  // Delete the database for this transfer.
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

// Create the best available chunk store backend.
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

// Bind store methods so callers can use a stable interface.
function bindStore(store) {
  return {
    write:   store.write.bind(store),
    read:    store.read.bind(store),
    readAll: store.readAll.bind(store),
    delete:  store.delete.bind(store),
    flush:   store.flush.bind(store),
  };
}

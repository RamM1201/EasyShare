/**
 * useFileTransfer.js
 *
 * KEY FIX (large-file hash mismatch):
 *
 * Root cause: handleMessage is async and was invoked concurrently for every
 * incoming DataChannel message event. With a 2.8 GB file (~11 200 chunks at
 * 256 KB) multiple processChunk() calls were in-flight simultaneously. This
 * caused two distinct bugs:
 *
 *  1. RACE on verifiedCountRef — the "all chunks done" guard fired while some
 *     store.write() promises were still pending, so flush()/read() ran before
 *     all bytes were written, producing a hash mismatch.
 *
 *  2. OPFS writable closed too early — OPFSChunkStore.read() calls flush()
 *     which closes the FileSystemWritableFileStream; any in-flight write()
 *     call arriving afterward silently failed or threw.
 *
 * Fix: a serial micro-queue (processQueue) guarantees that chunk processing
 * is strictly one-at-a-time. The DataChannel message handler enqueues work
 * and kicks the queue; the queue drains itself sequentially. This eliminates
 * both races with zero extra memory overhead.
 *
 * Everything else (incremental SHA-256, backpressure, OPFS/IDB store,
 * streaming download) is unchanged.
 *
 * ETA (added):
 *   Raw instantaneous speed is noisy. We smooth it with an exponential
 *   moving average (EMA) using α=0.15 — new samples have 15% weight,
 *   history has 85%. Samples are taken every 500 ms (unchanged). The
 *   raw speed is exposed as `transferSpeed` for the UI, while the
 *   smoothed speed is kept internally for `eta` (seconds remaining) and
 *   exported as `smoothedTransferSpeed` if callers need it.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { createChunkStore } from '../storage/chunkStore';

export const CHUNK_SIZE = 256 * 1024; // 256 KB

// ── Hashing helpers ──────────────────────────────────────────────────────────

/** SHA-256 of an ArrayBuffer → lowercase hex string */
async function sha256hex(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Incremental "running hash": H_n = SHA-256( H_{n-1}_bytes || chunk_bytes )
 *
 * Starts from a 32-byte zero seed, so H_0 = SHA-256(0x00…00 || chunk_0).
 * Both sender and receiver use this identically → consistent final value
 * without holding the whole file in RAM.
 */
async function updateRunningHash(prevHashHex, chunkBuffer) {
  const prevBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    prevBytes[i] = parseInt(prevHashHex.slice(i * 2, i * 2 + 2), 16);
  }
  const combined = new Uint8Array(32 + chunkBuffer.byteLength);
  combined.set(prevBytes, 0);
  combined.set(new Uint8Array(chunkBuffer), 32);
  return sha256hex(combined.buffer);
}

const INITIAL_HASH = '0'.repeat(64); // 32 zero bytes in hex

// ── Misc helpers ─────────────────────────────────────────────────────────────

function readSlice(file, start, end) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file slice'));
    reader.readAsArrayBuffer(file.slice(start, end));
  });
}

function waitForBufferDrain(dc, highWaterMark) {
  return new Promise((resolve) => {
    if (dc.bufferedAmount <= highWaterMark) { resolve(true); return; }
    const onLow   = () => { cleanup(); resolve(true); };
    const onClose = () => { cleanup(); resolve(false); };
    function cleanup() {
      dc.removeEventListener('bufferedamountlow', onLow);
      dc.removeEventListener('close', onClose);
      dc.removeEventListener('error', onClose);
    }
    dc.addEventListener('bufferedamountlow', onLow);
    dc.addEventListener('close', onClose);
    dc.addEventListener('error', onClose);
  });
}

// ── EMA speed smoothing ───────────────────────────────────────────────────────
//
// α = 0.15 → strong smoothing; new sample contributes 15%, history 85%.
// Raised slightly from a pure "last-interval" value so the ETA reacts
// to genuine speed changes within a few seconds rather than tens of seconds.
const EMA_ALPHA = 0.15;

// ── Hook ─────────────────────────────────────────────────────────────────────

export default function useFileTransfer({ dataChannel, role, file, transferId }) {
  const [status,           setStatus]           = useState('idle');
  const [progress,         setProgress]         = useState(0);
  const [bytesTransferred, setBytesTransferred] = useState(0);
  const [totalBytes,       setTotalBytes]       = useState(0);
  const [chunksReceived,   setChunksReceived]   = useState(0);
  const [totalChunks,      setTotalChunks]      = useState(0);
  const [receivedMetadata, setReceivedMetadata] = useState(null);
  const [receivedChunks]                        = useState(null); // always null
  const [chunkStore,       setChunkStore]       = useState(null);
  const [storageKind,      setStorageKind]      = useState(null);
  const [error,            setError]            = useState(null);
  const [transferSpeed,    setTransferSpeed]    = useState(0);
  const [smoothedTransferSpeed, setSmoothedTransferSpeed] = useState(0);
  // Smoothed ETA in seconds; null = not yet calculable
  const [eta,              setEta]              = useState(null);

  const lastSnapshotRef   = useRef({ bytes: 0, time: Date.now() });
  // EMA state: smoothedSpeed is bytes/sec
  const emaSpeedRef       = useRef(null); // null until first sample
  const metaRef           = useRef(null);
  const storeRef          = useRef(null);
  const isSendingRef      = useRef(false);
  const verifiedCountRef  = useRef(0);

  // ── Serial queue state (receiver) ─────────────────────────────────────
  const pendingItemsRef  = useRef([]);
  const queueRunningRef  = useRef(false);
  const preStoreQueueRef = useRef([]);

  const fileHashRef        = useRef(null);
  const finalizeCalledRef  = useRef(false);

  /**
   * updateSpeed — called after every progress update.
   *
  * Computes the instantaneous speed over the last snapshot interval
  * (≥ 500 ms), exposes it directly, feeds it into the EMA, then derives
  * eta from the smoothed speed and remaining bytes.
   *
   * @param {number} totalBytesNow  — cumulative bytes transferred so far
   * @param {number} fileSizeTotal  — total file size in bytes
   */
  const updateSpeed = useCallback((totalBytesNow, fileSizeTotal) => {
    const now = Date.now();
    const { bytes: prevBytes, time: prevTime } = lastSnapshotRef.current;
    const elapsed = now - prevTime; // ms

    if (elapsed < 500) return; // wait for a meaningful interval

    // Instantaneous speed for this interval (bytes/sec)
    const instantSpeed = Math.max(0, ((totalBytesNow - prevBytes) / elapsed) * 1000);
    lastSnapshotRef.current = { bytes: totalBytesNow, time: now };

    setTransferSpeed(instantSpeed);

    // Seed the EMA on first sample, otherwise blend
    const prevEma = emaSpeedRef.current;
    const smoothed = prevEma === null
      ? instantSpeed
      : EMA_ALPHA * instantSpeed + (1 - EMA_ALPHA) * prevEma;
    emaSpeedRef.current = smoothed;

    setSmoothedTransferSpeed(smoothed);

    // Derive ETA from smoothed speed
    if (smoothed > 0 && fileSizeTotal > 0) {
      const remaining = fileSizeTotal - totalBytesNow;
      setEta(remaining > 0 ? Math.ceil(remaining / smoothed) : 0);
    } else {
      setEta(null);
    }
  }, []);

  // ── SENDER ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (role !== 'sender' || !dataChannel || !file) return;

    const sendFile = async () => {
      if (isSendingRef.current) return;
      isSendingRef.current = true;

      dataChannel.bufferedAmountLowThreshold = 256 * 1024;
      const HIGH_WATER = 2 * 1024 * 1024;

      try {
        setStatus('transferring');
        setTotalBytes(file.size);
        lastSnapshotRef.current = { bytes: 0, time: Date.now() };
        emaSpeedRef.current = null;

        const numChunks = Math.ceil(file.size / CHUNK_SIZE);
        setTotalChunks(numChunks);

        const metadata = {
          type: 'metadata',
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          totalChunks: numChunks,
          chunkSize: CHUNK_SIZE,
          hashAlgo: 'incremental-sha256',
        };

        if (dataChannel.readyState !== 'open') {
          throw new Error('Connection lost while preparing the transfer.');
        }
        dataChannel.send(JSON.stringify(metadata));

        let bytesSent    = 0;
        let runningHash  = INITIAL_HASH;

        for (let i = 0; i < numChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end   = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = await readSlice(file, start, end);

          const chunkHash = await sha256hex(chunk);
          runningHash     = await updateRunningHash(runningHash, chunk);

          if (dataChannel.bufferedAmount > HIGH_WATER) {
            const ok = await waitForBufferDrain(dataChannel, HIGH_WATER / 2);
            if (!ok || dataChannel.readyState !== 'open') {
              throw new Error('Connection lost — receiver disconnected.');
            }
          }

          const header = JSON.stringify({ type: 'chunk', index: i, hash: chunkHash });
          try {
            dataChannel.send(header);
            dataChannel.send(chunk);
          } catch {
            throw new Error('Connection lost — receiver disconnected.');
          }

          bytesSent += chunk.byteLength;
          setBytesTransferred(bytesSent);
          setProgress(Math.round((bytesSent / file.size) * 100));
          updateSpeed(bytesSent, file.size);

          if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
        }

        if (dataChannel.readyState !== 'open') {
          throw new Error('Connection lost before sending file hash.');
        }
        dataChannel.send(JSON.stringify({ type: 'filehash', hash: runningHash }));

        setTransferSpeed(0);
        setSmoothedTransferSpeed(0);
        setEta(0);
        setStatus('done');
      } catch (err) {
        console.error('[FileTransfer] Send error:', err);
        setError(err.message || 'Transfer failed.');
        setStatus('error');
        setTransferSpeed(0);
        setSmoothedTransferSpeed(0);
        setEta(null);
      }
    };

    if (dataChannel.readyState === 'open') {
      sendFile();
    } else {
      dataChannel.addEventListener('open', sendFile, { once: true });
    }
  }, [dataChannel, role, file, updateSpeed]);

  // ── RECEIVER ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (role !== 'receiver' || !dataChannel) return;

    // Reset all receiver state
    verifiedCountRef.current  = 0;
    finalizeCalledRef.current = false;
    fileHashRef.current       = null;
    pendingItemsRef.current   = [];
    queueRunningRef.current   = false;
    preStoreQueueRef.current  = [];
    emaSpeedRef.current       = null;

    const doFileHashVerify = async () => {
      if (finalizeCalledRef.current) return;
      finalizeCalledRef.current = true;

      const meta  = metaRef.current;
      const store = storeRef.current;
      if (!meta || !store) return;

      if (store.flush) {
        try { await store.flush(); } catch { /* no-op */ }
      }

      try {
        let runningHash = INITIAL_HASH;
        for (let i = 0; i < meta.totalChunks; i++) {
          const chunk = await store.read(i);
          runningHash = await updateRunningHash(runningHash, chunk);
          if (i % 50 === 0) await new Promise((r) => setTimeout(r, 0));
        }

        if (runningHash !== fileHashRef.current) {
          setError('Full-file integrity check failed. The file may be corrupted.');
          setStatus('error');
          return;
        }
      } catch (err) {
        console.error('[FileTransfer] Full-file verification error:', err);
        setError('Failed to verify the completed file.');
        setStatus('error');
        return;
      }

      setProgress(100);
      setEta(0);
      setStatus('done');
    };

    const processChunkItem = async ({ header, binary }) => {
      const meta  = metaRef.current;
      const store = storeRef.current;
      if (!meta || !store) return;

      const idx   = header.index;
      const chunk = binary;

      const hash = await sha256hex(chunk);
      if (hash !== header.hash) {
        setError(`Chunk ${idx + 1} failed integrity check. File may be corrupted.`);
        setStatus('error');
        return;
      }

      try {
        await store.write(idx, chunk);
      } catch (err) {
        console.error('[FileTransfer] chunkStore write error:', err);
        setError('Failed to write chunk to local storage.');
        setStatus('error');
        return;
      }

      const verified   = ++verifiedCountRef.current;
      const bytesNow   = Math.min(verified * meta.chunkSize, meta.size);

      setChunksReceived(verified);
      setBytesTransferred(bytesNow);
      setProgress(Math.round((verified / meta.totalChunks) * 100));
      updateSpeed(bytesNow, meta.size);

      if (verified === meta.totalChunks) {
        setStatus('verifying');
        setTransferSpeed(0);
        setSmoothedTransferSpeed(0);
        setEta(null);
        if (fileHashRef.current !== null) {
          await doFileHashVerify();
        }
      }
    };

    const drainQueue = async () => {
      if (queueRunningRef.current) return;
      queueRunningRef.current = true;

      while (pendingItemsRef.current.length > 0) {
        const item = pendingItemsRef.current.shift();
        try {
          if (item.type === 'chunk') {
            await processChunkItem(item);
          } else if (item.type === 'filehash') {
            fileHashRef.current = item.hash;
            const meta = metaRef.current;
            if (meta && verifiedCountRef.current === meta.totalChunks) {
              await doFileHashVerify();
            }
          }
        } catch (err) {
          console.error('[FileTransfer] Queue processing error:', err);
          setError('Unexpected error during transfer.');
          setStatus('error');
        }
      }

      queueRunningRef.current = false;
    };

    let pendingChunkHeader = null;

    const handleMessage = (event) => {
      if (typeof event.data === 'string') {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'metadata') {
          metaRef.current = msg;
          setReceivedMetadata(msg);
          setTotalBytes(msg.size);
          setTotalChunks(msg.totalChunks);
          setStatus('transferring');
          lastSnapshotRef.current = { bytes: 0, time: Date.now() };
          emaSpeedRef.current = null;
          setTransferSpeed(0);
          setSmoothedTransferSpeed(0);

          const id = transferId || 'transfer';
          createChunkStore(id, msg.totalChunks, msg.chunkSize || CHUNK_SIZE)
            .then((store) => {
              storeRef.current = store;
              setChunkStore(store);
              setStorageKind(store.kind);

              const pre = preStoreQueueRef.current.splice(0);
              pendingItemsRef.current.push(...pre);
              drainQueue();
            })
            .catch((err) => {
              console.error('[FileTransfer] Store init error:', err);
              setError('Failed to initialise local storage for transfer.');
              setStatus('error');
            });
          return;
        }

        if (msg.type === 'chunk') {
          pendingChunkHeader = msg;
          return;
        }

        if (msg.type === 'filehash') {
          const item = { type: 'filehash', hash: msg.hash };
          if (!storeRef.current) {
            preStoreQueueRef.current.push(item);
          } else {
            pendingItemsRef.current.push(item);
            drainQueue();
          }
          return;
        }

        return;
      }

      if (!(event.data instanceof ArrayBuffer)) return;

      const header = pendingChunkHeader;
      pendingChunkHeader = null;
      if (!header) return;

      const item = { type: 'chunk', header, binary: event.data };

      if (!storeRef.current) {
        preStoreQueueRef.current.push(item);
      } else {
        pendingItemsRef.current.push(item);
        drainQueue();
      }
    };

    dataChannel.addEventListener('message', handleMessage);
    return () => dataChannel.removeEventListener('message', handleMessage);
  }, [dataChannel, role, updateSpeed, transferId]);

  return {
    status,
    progress,
    bytesTransferred,
    totalBytes,
    chunksReceived,
    totalChunks,
    receivedMetadata,
    receivedChunks,
    chunkStore,
    storageKind,
    error,
    transferSpeed,
    smoothedTransferSpeed,
    eta,
  };
}

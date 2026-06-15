/**
 * useFileTransfer.js  —  Stage 12 (large-file fix)
 *
 * Sender changes:
 *   - No longer accumulates allChunkBuffers[].  RAM usage is O(1) per chunk.
 *   - Full-file SHA-256 is computed incrementally using a running
 *     DigestStream shim (XOR-chained hashes).  Because SubtleCrypto has no
 *     streaming API, we use a well-known incremental approach: we maintain a
 *     running "combined hash" by hashing (prev_hash_bytes || chunk_bytes)
 *     after each chunk.  This is NOT the same value as hashing the whole
 *     file in one shot, so the receiver uses the same algorithm to verify.
 *
 *   ⚠  If you need byte-identical SHA-256 of the concatenated file you would
 *      need a Web Worker + WASM hash library (e.g. hash-wasm).  The
 *      incremental approach here gives equally strong tamper-detection with
 *      zero extra RAM on the sender.
 *
 * Receiver changes:
 *   - doFileHashVerify() reads chunks one at a time from the store and
 *     recomputes the same incremental hash instead of loading the whole
 *     file into a single ArrayBuffer.  RAM usage is O(1) per chunk.
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
 * Incremental "running hash":  H_n = SHA-256( H_{n-1}_bytes || chunk_bytes )
 *
 * Starts with a zero-filled 32-byte seed so the first step is effectively
 * SHA-256( 0x00…00 || chunk_0 ).
 *
 * Both sender and receiver use this function identically, so the final value
 * is always consistent without holding the full file in RAM.
 */
async function updateRunningHash(prevHashHex, chunkBuffer) {
  // Convert previous hex hash to bytes
  const prevBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    prevBytes[i] = parseInt(prevHashHex.slice(i * 2, i * 2 + 2), 16);
  }
  // Concatenate prev-hash bytes + chunk bytes
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
    const onLow = () => { cleanup(); resolve(true); };
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

// ── Hook ─────────────────────────────────────────────────────────────────────

export default function useFileTransfer({ dataChannel, role, file, transferId }) {
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [bytesTransferred, setBytesTransferred] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [chunksReceived, setChunksReceived] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [receivedMetadata, setReceivedMetadata] = useState(null);
  const [receivedChunks] = useState(null); // always null
  const [chunkStore, setChunkStore] = useState(null);
  const [storageKind, setStorageKind] = useState(null);
  const [error, setError] = useState(null);
  const [transferSpeed, setTransferSpeed] = useState(0);

  const lastSnapshotRef = useRef({ bytes: 0, time: Date.now() });
  const metaRef = useRef(null);
  const storeRef = useRef(null);
  const isSendingRef = useRef(false);
  const chunkIdxRef = useRef(0);
  const verifiedCountRef = useRef(0);
  const pendingChunksRef = useRef([]);

  const updateSpeed = useCallback((totalBytesNow) => {
    const now = Date.now();
    const { bytes: prevBytes, time: prevTime } = lastSnapshotRef.current;
    const elapsed = now - prevTime;
    if (elapsed >= 500) {
      setTransferSpeed(Math.max(0, ((totalBytesNow - prevBytes) / elapsed) * 1000));
      lastSnapshotRef.current = { bytes: totalBytesNow, time: now };
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

        const numChunks = Math.ceil(file.size / CHUNK_SIZE);
        setTotalChunks(numChunks);

        // Lightweight metadata — no upfront chunk hashes
        const metadata = {
          type: 'metadata',
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          totalChunks: numChunks,
          chunkSize: CHUNK_SIZE,
          hashAlgo: 'incremental-sha256', // signals receiver to use same algo
        };

        if (dataChannel.readyState !== 'open') {
          throw new Error('Connection lost while preparing the transfer.');
        }
        dataChannel.send(JSON.stringify(metadata));

        let bytesSent = 0;
        let runningHash = INITIAL_HASH; // incremental full-file hash — O(1) RAM

        for (let i = 0; i < numChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = await readSlice(file, start, end);

          // Per-chunk hash (for immediate tamper detection on the receiver)
          const chunkHash = await sha256hex(chunk);

          // Update running full-file hash — NO buffer accumulation
          runningHash = await updateRunningHash(runningHash, chunk);

          // Backpressure
          if (dataChannel.bufferedAmount > HIGH_WATER) {
            const ok = await waitForBufferDrain(dataChannel, HIGH_WATER / 2);
            if (!ok || dataChannel.readyState !== 'open') {
              throw new Error('Connection lost — receiver disconnected.');
            }
          }

          // Send header then binary
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
          updateSpeed(bytesSent);

          // Yield to event loop every 20 chunks
          if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
        }

        // Send incremental full-file hash as footer
        if (dataChannel.readyState !== 'open') {
          throw new Error('Connection lost before sending file hash.');
        }
        dataChannel.send(JSON.stringify({ type: 'filehash', hash: runningHash }));

        setTransferSpeed(0);
        setStatus('done');
      } catch (err) {
        console.error('[FileTransfer] Send error:', err);
        setError(err.message || 'Transfer failed.');
        setStatus('error');
        setTransferSpeed(0);
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

    chunkIdxRef.current = 0;
    verifiedCountRef.current = 0;
    pendingChunksRef.current = [];

    const processChunk = async (idx, chunk) => {
      const meta = metaRef.current;
      const store = storeRef.current;
      if (!meta || !store) return;

      try {
        await store.write(idx, chunk);
      } catch (err) {
        console.error('[FileTransfer] chunkStore write error:', err);
        setError('Failed to write chunk to local storage.');
        setStatus('error');
        return;
      }

      const verified = ++verifiedCountRef.current;
      const bytesNow = Math.min(verified * meta.chunkSize, meta.size);

      setChunksReceived(verified);
      setBytesTransferred(bytesNow);
      setProgress(Math.round((verified / meta.totalChunks) * 100));
      updateSpeed(bytesNow);

      if (verified === meta.totalChunks) {
        setStatus('verifying');
        setTransferSpeed(0);
        if (store.flush) {
          try { await store.flush(); } catch { /* no-op */ }
        }
        // If the filehash footer already arrived, verify now
        if (fileHashRef.current !== null) {
          await doFileHashVerify();
        }
      }
    };

    const fileHashRef = { current: null };
    const finalizeCalledRef = { current: false };

    /**
     * Verify full-file integrity using the same incremental SHA-256 as the
     * sender — reads one chunk at a time from the store, O(1) RAM.
     */
    const doFileHashVerify = async () => {
      if (finalizeCalledRef.current) return;
      finalizeCalledRef.current = true;

      const meta = metaRef.current;
      const store = storeRef.current;
      if (!meta || !store) return;

      try {
        let runningHash = INITIAL_HASH;
        for (let i = 0; i < meta.totalChunks; i++) {
          const chunk = await store.read(i);
          runningHash = await updateRunningHash(runningHash, chunk);
          if (i % 50 === 0) await new Promise(r => setTimeout(r, 0));
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
      setStatus('done');
    };

    let pendingChunkHeader = null;

    const handleMessage = async (event) => {
      // ── Text (metadata / chunk header / filehash) ──
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

          try {
            const id = transferId || 'transfer';
            const store = await createChunkStore(id, msg.totalChunks, msg.chunkSize || CHUNK_SIZE);
            storeRef.current = store;
            setChunkStore(store);
            setStorageKind(store.kind);

            // Drain any chunks that arrived before the store was ready
            const pending = pendingChunksRef.current.splice(0);
            for (const { idx, chunk } of pending) {
              await processChunk(idx, chunk);
            }
          } catch (err) {
            console.error('[FileTransfer] Store init error:', err);
            setError('Failed to initialize local storage for transfer.');
            setStatus('error');
          }
          return;
        }

        if (msg.type === 'chunk') {
          pendingChunkHeader = msg;
          return;
        }

        if (msg.type === 'filehash') {
          fileHashRef.current = msg.hash;
          const meta = metaRef.current;
          if (meta && verifiedCountRef.current === meta.totalChunks) {
            await doFileHashVerify();
          }
          return;
        }

        return;
      }

      // ── Binary (chunk payload) ──
      if (!(event.data instanceof ArrayBuffer)) return;

      const header = pendingChunkHeader;
      pendingChunkHeader = null;
      if (!header) return;

      const chunk = event.data;
      const idx = header.index;

      // Per-chunk integrity check
      const hash = await sha256hex(chunk);
      if (hash !== header.hash) {
        setError(`Chunk ${idx + 1} failed integrity check. File may be corrupted.`);
        setStatus('error');
        return;
      }

      if (!storeRef.current) {
        pendingChunksRef.current.push({ idx, chunk });
        return;
      }

      await processChunk(idx, chunk);
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
  };
}

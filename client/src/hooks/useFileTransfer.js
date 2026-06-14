// client/src/hooks/useFileTransfer.js
// Stage 6: Added SHA-256 chunk hashing (sender) and verification (receiver)

import { useState, useEffect, useRef, useCallback } from 'react';

export const CHUNK_SIZE = 16 * 1024; // 16 KB

// Helper: compute SHA-256 of an ArrayBuffer, return hex string
async function sha256Hex(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function useFileTransfer({ dataChannel, role, file }) {
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [bytesTransferred, setBytesTransferred] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [chunksReceived, setChunksReceived] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [receivedMetadata, setReceivedMetadata] = useState(null);
  const [receivedChunks, setReceivedChunks] = useState(null);
  const [error, setError] = useState(null);

  const receivedChunksRef = useRef([]);
  const metadataRef = useRef(null);
  const bytesRef = useRef(0);
  const pausedRef = useRef(false);
  const resumeRef = useRef(null);

  // ─── SENDER ────────────────────────────────────────────────────────────────
  const runSender = useCallback(async () => {
    if (!file || !dataChannel || dataChannel.readyState !== 'open') return;

    try {
      setStatus('transferring');
      setTotalBytes(file.size);

      const totalChunkCount = Math.ceil(file.size / CHUNK_SIZE);
      setTotalChunks(totalChunkCount);

      // --- Stage 6: compute full-file hash BEFORE chunking ---
      console.log('[fileTransfer] computing full-file hash…');
      const fullBuffer = await file.arrayBuffer();
      const fileHash = await sha256Hex(fullBuffer);

      // --- Stage 6: compute per-chunk hashes ---
      console.log('[fileTransfer] computing per-chunk hashes…');
      const chunkHashes = [];
      for (let i = 0; i < totalChunkCount; i++) {
        const start = i * CHUNK_SIZE;
        const chunk = file.slice(start, start + CHUNK_SIZE);
        const buf = await chunk.arrayBuffer();
        chunkHashes.push(await sha256Hex(buf));
      }

      // --- Send metadata (Stage 6 format) ---
      const metadata = {
        type: 'metadata',
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks: totalChunkCount,
        chunkSize: CHUNK_SIZE,
        chunkHashes,   // Stage 6
        fileHash,      // Stage 6
      };
      dataChannel.send(JSON.stringify(metadata));
      console.log('[fileTransfer] metadata sent (with hashes)');

      // --- Backpressure helper ---
      const waitForDrain = () =>
        new Promise(resolve => {
          resumeRef.current = resolve;
          pausedRef.current = true;
        });

      const onBufferedAmountLow = () => {
        if (pausedRef.current && resumeRef.current) {
          pausedRef.current = false;
          const resolve = resumeRef.current;
          resumeRef.current = null;
          resolve();
        }
      };
      dataChannel.addEventListener('bufferedamountlow', onBufferedAmountLow);

      // --- Chunk sending loop ---
      let bytesSent = 0;
      for (let i = 0; i < totalChunkCount; i++) {
        const start = i * CHUNK_SIZE;
        const buf = await file.slice(start, start + CHUNK_SIZE).arrayBuffer();

        if (dataChannel.bufferedAmount > dataChannel.bufferedAmountLowThreshold) {
          await waitForDrain();
        }

        dataChannel.send(buf);
        bytesSent += buf.byteLength;
        setBytesTransferred(bytesSent);
        setProgress(Math.round((bytesSent / file.size) * 100));

        await new Promise(r => setTimeout(r, 0));
      }

      dataChannel.removeEventListener('bufferedamountlow', onBufferedAmountLow);
      setStatus('done');
      setProgress(100);
      console.log('[fileTransfer] all chunks sent');
    } catch (err) {
      console.error('[fileTransfer] sender error', err);
      setError(err.message || 'Send error');
      setStatus('error');
    }
  }, [dataChannel, file]);

  // ─── RECEIVER ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!dataChannel || role !== 'receiver') return;

    let chunkIndex = 0;

    const onMessage = async (event) => {
      // First message: metadata
      if (metadataRef.current === null) {
        const meta = JSON.parse(event.data);
        metadataRef.current = meta;
        setReceivedMetadata(meta);
        setTotalBytes(meta.size);
        setTotalChunks(meta.totalChunks);
        receivedChunksRef.current = [];
        bytesRef.current = 0;
        chunkIndex = 0;
        setStatus('transferring');
        console.log('[fileTransfer] metadata received', meta);
        return;
      }

      // Subsequent messages: chunk ArrayBuffers
      const meta = metadataRef.current;
      const buf = event.data; // ArrayBuffer

      // --- Stage 6: verify chunk hash ---
      if (meta.chunkHashes) {
        const receivedHash = await sha256Hex(buf);
        const expectedHash = meta.chunkHashes[chunkIndex];
        if (receivedHash !== expectedHash) {
          const msg = `Chunk ${chunkIndex} hash mismatch — data corrupted`;
          console.error('[fileTransfer]', msg);
          setError(msg);
          setStatus('error');
          return;
        }
      }

      receivedChunksRef.current.push(buf);
      bytesRef.current += buf.byteLength;
      chunkIndex++;

      setBytesTransferred(bytesRef.current);
      setChunksReceived(receivedChunksRef.current.length);
      setProgress(Math.round((bytesRef.current / meta.size) * 100));

      if (receivedChunksRef.current.length >= meta.totalChunks) {
        console.log('[fileTransfer] all chunks received, verifying full-file hash…');
        setStatus('verifying'); // Stage 6: intermediate UI state

        // --- Stage 6: verify full-file hash ---
        if (meta.fileHash) {
          const blob = new Blob(receivedChunksRef.current, { type: meta.mimeType });
          const fullBuf = await blob.arrayBuffer();
          const computedHash = await sha256Hex(fullBuf);

          if (computedHash !== meta.fileHash) {
            const msg = 'Full-file hash mismatch — transfer corrupted';
            console.error('[fileTransfer]', msg);
            setError(msg);
            setStatus('error');
            return;
          }
          console.log('[fileTransfer] full-file hash verified ✓');
        }

        setReceivedChunks([...receivedChunksRef.current]);
        setStatus('done');
        setProgress(100);
      }
    };

    dataChannel.addEventListener('message', onMessage);
    return () => dataChannel.removeEventListener('message', onMessage);
  }, [dataChannel, role]);

  // ─── SENDER trigger ────────────────────────────────────────────────────────
  useEffect(() => {
    if (role === 'sender' && dataChannel && dataChannel.readyState === 'open') {
      runSender();
    }
  }, [role, dataChannel, runSender]);

  return {
    status,       // 'idle' | 'transferring' | 'verifying' | 'done' | 'error'
    progress,
    bytesTransferred,
    totalBytes,
    chunksReceived,
    totalChunks,
    receivedMetadata,
    receivedChunks,
    error,
  };
}

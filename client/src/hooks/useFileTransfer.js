// client/src/hooks/useFileTransfer.js
// Stage 8: Added transferSpeed (bytes/sec) + sender error handling on closed channel

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
  // Stage 8: transfer speed in bytes/sec
  const [transferSpeed, setTransferSpeed] = useState(0);

  const receivedChunksRef = useRef([]);
  const metadataRef = useRef(null);
  const bytesRef = useRef(0);
  const pausedRef = useRef(false);
  const resumeRef = useRef(null);

  // Stage 8: rolling speed snapshot ref
  const lastSnapshotRef = useRef({ bytes: 0, time: Date.now() });

  // Helper: update speed from a current byte count
  const updateSpeed = useCallback((currentBytes) => {
    const now = Date.now();
    const elapsed = (now - lastSnapshotRef.current.time) / 1000; // seconds
    if (elapsed >= 0.5) {
      const delta = currentBytes - lastSnapshotRef.current.bytes;
      setTransferSpeed(Math.round(delta / elapsed));
      lastSnapshotRef.current = { bytes: currentBytes, time: now };
    }
  }, []);

  // ─── SENDER ────────────────────────────────────────────────────────────────
  const runSender = useCallback(async () => {
    if (!file || !dataChannel || dataChannel.readyState !== 'open') return;

    try {
      setStatus('transferring');
      setTotalBytes(file.size);
      lastSnapshotRef.current = { bytes: 0, time: Date.now() };

      const totalChunkCount = Math.ceil(file.size / CHUNK_SIZE);
      setTotalChunks(totalChunkCount);

      // Stage 6: compute full-file hash BEFORE chunking
      console.log('[fileTransfer] computing full-file hash…');
      const fullBuffer = await file.arrayBuffer();
      const fileHash = await sha256Hex(fullBuffer);

      // Stage 6: compute per-chunk hashes
      console.log('[fileTransfer] computing per-chunk hashes…');
      const chunkHashes = [];
      for (let i = 0; i < totalChunkCount; i++) {
        const start = i * CHUNK_SIZE;
        const chunk = file.slice(start, start + CHUNK_SIZE);
        const buf = await chunk.arrayBuffer();
        chunkHashes.push(await sha256Hex(buf));
      }

      // Send metadata
      const metadata = {
        type: 'metadata',
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks: totalChunkCount,
        chunkSize: CHUNK_SIZE,
        chunkHashes,
        fileHash,
      };
      dataChannel.send(JSON.stringify(metadata));
      console.log('[fileTransfer] metadata sent (with hashes)');

      // Backpressure helper
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

      // Chunk sending loop
      let bytesSent = 0;
      for (let i = 0; i < totalChunkCount; i++) {
        // Stage 8: if channel closed mid-send, throw immediately
        if (dataChannel.readyState !== 'open') {
          throw new Error('Connection lost — receiver disconnected');
        }

        const start = i * CHUNK_SIZE;
        const buf = await file.slice(start, start + CHUNK_SIZE).arrayBuffer();

        if (dataChannel.bufferedAmount > dataChannel.bufferedAmountLowThreshold) {
          await waitForDrain();
        }

        // Stage 8: guard send inside try/catch to catch closed-channel throws
        try {
          dataChannel.send(buf);
        } catch (sendErr) {
          throw new Error('Connection lost — receiver disconnected');
        }

        bytesSent += buf.byteLength;
        setBytesTransferred(bytesSent);
        setProgress(Math.round((bytesSent / file.size) * 100));

        // Stage 8: update rolling speed
        updateSpeed(bytesSent);

        await new Promise(r => setTimeout(r, 0));
      }

      dataChannel.removeEventListener('bufferedamountlow', onBufferedAmountLow);
      setTransferSpeed(0);
      setStatus('done');
      setProgress(100);
      console.log('[fileTransfer] all chunks sent');
    } catch (err) {
      console.error('[fileTransfer] sender error', err);
      setError(err.message || 'Send error');
      setStatus('error');
      setTransferSpeed(0);
    }
  }, [dataChannel, file, updateSpeed]);

  // ─── RECEIVER ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!dataChannel || role !== 'receiver') return;

    let chunkIndex = 0;
    lastSnapshotRef.current = { bytes: 0, time: Date.now() };

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

      // Stage 6: verify chunk hash
      if (meta.chunkHashes) {
        const receivedHash = await sha256Hex(buf);
        const expectedHash = meta.chunkHashes[chunkIndex];
        if (receivedHash !== expectedHash) {
          const msg = `Chunk ${chunkIndex} hash mismatch — data corrupted`;
          console.error('[fileTransfer]', msg);
          setError(msg);
          setStatus('error');
          setTransferSpeed(0);
          return;
        }
      }

      receivedChunksRef.current.push(buf);
      bytesRef.current += buf.byteLength;
      chunkIndex++;

      setBytesTransferred(bytesRef.current);
      setChunksReceived(receivedChunksRef.current.length);
      setProgress(Math.round((bytesRef.current / meta.size) * 100));

      // Stage 8: update rolling speed for receiver
      updateSpeed(bytesRef.current);

      if (receivedChunksRef.current.length >= meta.totalChunks) {
        console.log('[fileTransfer] all chunks received, verifying full-file hash…');
        setStatus('verifying');
        setTransferSpeed(0);

        // Stage 6: verify full-file hash
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
    return () => {
      dataChannel.removeEventListener('message', onMessage);
      setTransferSpeed(0);
    };
  }, [dataChannel, role, updateSpeed]);

  // ─── SENDER trigger ────────────────────────────────────────────────────────
  useEffect(() => {
    if (role === 'sender' && dataChannel && dataChannel.readyState === 'open') {
      runSender();
    }
  }, [role, dataChannel, runSender]);

  return {
    status,           // 'idle' | 'transferring' | 'verifying' | 'done' | 'error'
    progress,
    bytesTransferred,
    totalBytes,
    chunksReceived,
    totalChunks,
    receivedMetadata,
    receivedChunks,
    error,
    transferSpeed,    // Stage 8: bytes/sec, 0 when idle/done
  };
}

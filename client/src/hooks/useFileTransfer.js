/**
 * useFileTransfer.js
 *
 * Handles chunked file sending (sender) and receiving (receiver) over a
 * WebRTC data channel, including SHA-256 chunk + full-file verification.
 *
 * Exported constants
 * ------------------
 * CHUNK_SIZE  - 16 KB per chunk (used by both sender and receiver).
 *
 * Returned state
 * --------------
 * status          : 'idle' | 'transferring' | 'verifying' | 'done' | 'error'
 * progress        : 0–100 (percentage)
 * bytesTransferred: number
 * totalBytes      : number
 * chunksReceived  : number
 * totalChunks     : number
 * receivedMetadata: metadata object from the first data-channel message, or null
 * receivedChunks  : ArrayBuffer[] snapshot when status === 'done'
 * error           : string | null
 * transferSpeed   : bytes/sec (updated at most every 500 ms; 0 when not transferring)
 */

import { useEffect, useRef, useState, useCallback } from 'react';

export const CHUNK_SIZE = 16 * 1024; // 16 KB

/** Convert an ArrayBuffer to a lowercase hex string. */
async function sha256hex(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Read a File as an ArrayBuffer. */
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = (e) => resolve(e.target.result);
    reader.onerror = ()  => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

export default function useFileTransfer({ dataChannel, role, file }) {
  const [status,           setStatus]           = useState('idle');
  const [progress,         setProgress]         = useState(0);
  const [bytesTransferred, setBytesTransferred] = useState(0);
  const [totalBytes,       setTotalBytes]       = useState(0);
  const [chunksReceived,   setChunksReceived]   = useState(0);
  const [totalChunks,      setTotalChunks]      = useState(0);
  const [receivedMetadata, setReceivedMetadata] = useState(null);
  const [receivedChunks,   setReceivedChunks]   = useState([]);
  const [error,            setError]            = useState(null);
  const [transferSpeed,    setTransferSpeed]    = useState(0);

  /** Snapshot ref so speed tracking closure doesn't go stale. */
  const lastSnapshotRef = useRef({ bytes: 0, time: Date.now() });
  const chunksBufferRef = useRef([]);  // accumulates chunks without triggering renders
  const metaRef         = useRef(null);

  // ── Speed tracking helper ──────────────────────────────────────────────
  const updateSpeed = useCallback((totalBytesNow) => {
    const now = Date.now();
    const { bytes: prevBytes, time: prevTime } = lastSnapshotRef.current;
    const elapsed = now - prevTime;

    if (elapsed >= 500) {
      const speed = ((totalBytesNow - prevBytes) / elapsed) * 1000;
      setTransferSpeed(Math.max(0, speed));
      lastSnapshotRef.current = { bytes: totalBytesNow, time: now };
    }
  }, []);

  // ── SENDER: hash + send when data channel opens ───────────────────────
  useEffect(() => {
    if (role !== 'sender' || !dataChannel || !file) return;

    const sendFile = async () => {
      try {
        setStatus('transferring');
        setTotalBytes(file.size);
        lastSnapshotRef.current = { bytes: 0, time: Date.now() };

        const buffer     = await readFileAsArrayBuffer(file);
        const numChunks  = Math.ceil(buffer.byteLength / CHUNK_SIZE);
        setTotalChunks(numChunks);

        // Hash every chunk and the full file in parallel with chunking
        const chunkArrays = [];
        for (let i = 0; i < numChunks; i++) {
          chunkArrays.push(buffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
        }

        const [chunkHashes, fileHash] = await Promise.all([
          Promise.all(chunkArrays.map(sha256hex)),
          sha256hex(buffer),
        ]);

        // Send metadata first
        const metadata = {
          type: 'metadata',
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          totalChunks: numChunks,
          chunkSize: CHUNK_SIZE,
          chunkHashes,
          fileHash,
        };
        dataChannel.send(JSON.stringify(metadata));

        // Send chunks with backpressure handling
        let bytesSent = 0;
        for (let i = 0; i < numChunks; i++) {
          const chunk = chunkArrays[i];

          // Wait for buffer to drain if it's too full
          if (dataChannel.bufferedAmount > 16 * 1024 * 1024) {
            await new Promise((resolve) => {
              dataChannel.onbufferedamountlow = () => {
                dataChannel.onbufferedamountlow = null;
                resolve();
              };
            });
          }

          try {
            dataChannel.send(chunk);
          } catch (err) {
            throw new Error('Connection lost — receiver disconnected');
          }

          bytesSent += chunk.byteLength;
          setBytesTransferred(bytesSent);
          setProgress(Math.round((bytesSent / file.size) * 100));
          updateSpeed(bytesSent);
        }

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

  // ── RECEIVER: listen for incoming messages ────────────────────────────
  useEffect(() => {
    if (role !== 'receiver' || !dataChannel) return;

    const handleMessage = async (event) => {
      // First message: JSON metadata
      if (typeof event.data === 'string') {
        try {
          const meta = JSON.parse(event.data);
          if (meta.type !== 'metadata') return;
          metaRef.current = meta;
          setReceivedMetadata(meta);
          setTotalBytes(meta.size);
          setTotalChunks(meta.totalChunks);
          setStatus('transferring');
          lastSnapshotRef.current = { bytes: 0, time: Date.now() };
        } catch {
          setError('Received malformed metadata.');
          setStatus('error');
        }
        return;
      }

      // Subsequent messages: raw ArrayBuffer chunks
      if (!(event.data instanceof ArrayBuffer)) return;

      const meta = metaRef.current;
      if (!meta) return;

      const chunk = event.data;
      const idx   = chunksBufferRef.current.length;

      // Verify chunk hash
      const hash = await sha256hex(chunk);
      if (hash !== meta.chunkHashes[idx]) {
        setError(`Chunk ${idx + 1} failed integrity check. File may be corrupted.`);
        setStatus('error');
        return;
      }

      chunksBufferRef.current.push(chunk);
      const received    = chunksBufferRef.current.length;
      const bytesNow    = received * meta.chunkSize;

      setChunksReceived(received);
      setBytesTransferred(Math.min(bytesNow, meta.size));
      setProgress(Math.round((received / meta.totalChunks) * 100));
      updateSpeed(bytesNow);

      if (received === meta.totalChunks) {
        setStatus('verifying');
        setTransferSpeed(0);

        // Full-file hash verification
        const fullBuffer = await new Blob(chunksBufferRef.current).arrayBuffer();
        const fullHash   = await sha256hex(fullBuffer);

        if (fullHash !== meta.fileHash) {
          setError('Full-file integrity check failed. The file may be corrupted.');
          setStatus('error');
          return;
        }

        // Snapshot chunks array for download
        setReceivedChunks([...chunksBufferRef.current]);
        setProgress(100);
        setStatus('done');
      }
    };

    dataChannel.addEventListener('message', handleMessage);
    return () => dataChannel.removeEventListener('message', handleMessage);
  }, [dataChannel, role, updateSpeed]);

  return {
    status,
    progress,
    bytesTransferred,
    totalBytes,
    chunksReceived,
    totalChunks,
    receivedMetadata,
    receivedChunks,
    error,
    transferSpeed,
  };
}

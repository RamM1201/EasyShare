/**
 * useFileTransfer — manages file chunking, sending, and receiving over the
 * WebRTC data channel established by useWebRTC.
 *
 * Stage 5 scope:
 *   - Sender: reads File in 16 KB chunks using Blob.slice() + arrayBuffer(),
 *     sends a JSON metadata message first, then sends raw ArrayBuffer chunks.
 *     Implements backpressure: pauses when bufferedAmount exceeds threshold
 *     and resumes on 'bufferedamountlow'.
 *   - Receiver: listens for onmessage events, distinguishes the metadata
 *     message (JSON string) from chunk data (ArrayBuffer), accumulates
 *     chunks in order with byte-count tracking.
 *
 * Stage 6 will add SHA-256 hashing per chunk and for the whole file.
 * Stage 7 will reassemble the chunk array into a Blob and trigger download.
 * Stage 8 will add progress UI and speed calculations (chunksReceived /
 * totalChunks and bytesReceived / totalBytes are already surfaced here).
 *
 * Metadata message format (sent as JSON string before any chunk):
 *   {
 *     type: 'metadata',
 *     name: string,      // file name
 *     size: number,      // total bytes
 *     mimeType: string,  // MIME type (may be '')
 *     totalChunks: number,
 *     chunkSize: number, // nominal chunk size in bytes (last chunk may be smaller)
 *   }
 *
 * Data messages: raw ArrayBuffer (one per chunk, in order).
 *
 * Usage:
 *   const { status, progress, chunksReceived, totalChunks, error } =
 *     useFileTransfer({ dataChannel, role, file });
 *
 *   `status` — 'idle' | 'transferring' | 'done' | 'error'
 *   `progress` — 0–100 (number)
 *   `bytesTransferred` — bytes sent or received so far
 *   `totalBytes` — total file size
 *   `chunksReceived` / `totalChunks` — useful for Stage 8 speed display
 *   `receivedMetadata` — the parsed metadata object (receiver side only, null until received)
 *   `receivedChunks` — accumulated ArrayBuffer array (receiver side; handed to Stage 7)
 *   `error` — human-readable error string or null
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// 16 KB chunks — well below the 64 KB bufferedAmountLowThreshold set in
// useWebRTC, leaving plenty of headroom before backpressure kicks in.
export const CHUNK_SIZE = 16 * 1024; // 16 KB

export function useFileTransfer({ dataChannel, role, file }) {
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [bytesTransferred, setBytesTransferred] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [chunksReceived, setChunksReceived] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [receivedMetadata, setReceivedMetadata] = useState(null);
  const [error, setError] = useState(null);

  // Mutable accumulator for received chunks — not stored in state to avoid
  // re-renders on every chunk; handed to Stage 7 when status === 'done'.
  const receivedChunksRef = useRef([]);
  // Keep a stable ref to receivedChunks so Stage 7 can read it after done.
  const [receivedChunksSnapshot, setReceivedChunksSnapshot] = useState(null);

  // Sender-side: track current chunk index and whether we're paused for
  // backpressure.
  const senderStateRef = useRef({
    chunkIndex: 0,
    totalChunks: 0,
    file: null,
    paused: false,
    cancelled: false,
  });

  // ── Sender: send next chunk (called repeatedly until done) ────────────
  const sendNextChunk = useCallback(async (dc, f, state) => {
    if (state.cancelled) return;

    const { chunkIndex, totalChunks: total } = state;

    if (chunkIndex >= total) {
      // All chunks sent.
      setStatus('done');
      setProgress(100);
      return;
    }

    // Check backpressure before sending.
    if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
      // Wait for bufferedamountlow event — handler will call sendNextChunk.
      state.paused = true;
      return;
    }

    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, f.size);
    const slice = f.slice(start, end);
    const buffer = await slice.arrayBuffer();

    if (state.cancelled) return;

    try {
      dc.send(buffer);
    } catch (err) {
      console.error('[fileTransfer] send error', err);
      setError('Send failed: ' + err.message);
      setStatus('error');
      return;
    }

    state.chunkIndex += 1;
    const bytesSent = Math.min(state.chunkIndex * CHUNK_SIZE, f.size);
    setBytesTransferred(bytesSent);
    setProgress(Math.round((state.chunkIndex / total) * 100));

    // Yield to the event loop between chunks so the UI can breathe and so
    // the backpressure check above has a chance to fire.
    setTimeout(() => sendNextChunk(dc, f, state), 0);
  }, []);

  // ── Effect: kick off transfer or set up receiver when channel opens ───
  useEffect(() => {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    if (role !== 'sender' && role !== 'receiver') return;

    let cancelled = false;

    if (role === 'sender') {
      if (!file) {
        setError('No file to send.');
        setStatus('error');
        return;
      }

      const totalChunksCount = Math.ceil(file.size / CHUNK_SIZE);

      // Send metadata first.
      const metadata = {
        type: 'metadata',
        name: file.name,
        size: file.size,
        mimeType: file.type || '',
        totalChunks: totalChunksCount,
        chunkSize: CHUNK_SIZE,
      };

      try {
        dataChannel.send(JSON.stringify(metadata));
      } catch (err) {
        setError('Failed to send metadata: ' + err.message);
        setStatus('error');
        return;
      }

      // Initialise sender state.
      const state = senderStateRef.current;
      state.chunkIndex = 0;
      state.totalChunks = totalChunksCount;
      state.file = file;
      state.paused = false;
      state.cancelled = false;

      setTotalBytes(file.size);
      setTotalChunks(totalChunksCount);
      setStatus('transferring');

      // Backpressure: resume sending when buffer drains.
      function onBufferedAmountLow() {
        if (state.cancelled) return;
        if (state.paused) {
          state.paused = false;
          sendNextChunk(dataChannel, file, state);
        }
      }
      dataChannel.addEventListener('bufferedamountlow', onBufferedAmountLow);

      // Start sending.
      sendNextChunk(dataChannel, file, state);

      return () => {
        cancelled = true;
        state.cancelled = true;
        dataChannel.removeEventListener('bufferedamountlow', onBufferedAmountLow);
      };
    }

    if (role === 'receiver') {
      // Reset accumulator for a fresh transfer.
      receivedChunksRef.current = [];
      let metadataReceived = false;
      let expectedTotal = 0;
      let bytesRx = 0;

      function onMessage(event) {
        if (cancelled) return;

        // First message is always the JSON metadata string.
        if (!metadataReceived) {
          try {
            const meta = JSON.parse(event.data);
            if (meta.type !== 'metadata') {
              throw new Error('Expected metadata message first');
            }
            metadataReceived = true;
            expectedTotal = meta.totalChunks;
            setReceivedMetadata(meta);
            setTotalBytes(meta.size);
            setTotalChunks(meta.totalChunks);
            setStatus('transferring');
            console.log('[fileTransfer] metadata received', meta);
          } catch (err) {
            console.error('[fileTransfer] bad metadata', err);
            setError('Received invalid metadata from sender.');
            setStatus('error');
          }
          return;
        }

        // Subsequent messages are ArrayBuffer chunks.
        const chunk =
          event.data instanceof ArrayBuffer
            ? event.data
            : event.data; // already ArrayBuffer in Chrome/Firefox

        receivedChunksRef.current.push(chunk);
        const received = receivedChunksRef.current.length;

        // Update byte count using the chunk's actual byte length.
        if (chunk && chunk.byteLength != null) {
          bytesRx += chunk.byteLength;
        }

        setBytesTransferred(bytesRx);
        setChunksReceived(received);
        setProgress(Math.round((received / expectedTotal) * 100));

        if (received >= expectedTotal) {
          // Snapshot the array so Stage 7 can read it from state.
          setReceivedChunksSnapshot([...receivedChunksRef.current]);
          setStatus('done');
          setProgress(100);
          console.log('[fileTransfer] all chunks received', received);
        }
      }

      dataChannel.addEventListener('message', onMessage);

      return () => {
        cancelled = true;
        dataChannel.removeEventListener('message', onMessage);
      };
    }
  }, [dataChannel, role, file, sendNextChunk]);

  return {
    status,
    progress,
    bytesTransferred,
    totalBytes,
    chunksReceived,
    totalChunks,
    receivedMetadata,
    receivedChunks: receivedChunksSnapshot,
    error,
  };
}

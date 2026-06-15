/**
 * ReceiverPage.jsx
 *
 * Rendered at /r/:roomId for both the sender (after room creation) and the
 * receiver (who opens the share link).
 *
 * - Sender:   joins the room as 'sender', waits for receiver, then sends the file.
 * - Receiver: joins the room as 'receiver', waits for the WebRTC data channel,
 *             then receives, verifies, and auto-downloads the file via a
 *             disk-backed chunk store (OPFS/IndexedDB, Stage 12).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import useSignalingSocket from '../hooks/useSignalingSocket';
import useWebRTC          from '../hooks/useWebRTC';
import useFileTransfer    from '../hooks/useFileTransfer';

/** Format bytes to a human-readable string. */
function formatBytes(bytes) {
  if (bytes < 1024)             return `${bytes} B`;
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format bytes/sec to MB/s or KB/s string. */
function formatSpeed(bps) {
  if (bps <= 0)          return '—';
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
}

// ── ConnectionBadge ──────────────────────────────────────────────────────────

const BADGE_CONFIG = {
  connecting:   { dot: 'bg-yellow-400 animate-pulse', text: 'text-yellow-300',  label: 'Connecting…'           },
  waiting:      { dot: 'bg-yellow-400 animate-pulse', text: 'text-yellow-300',  label: 'Waiting for peer…'     },
  connected:    { dot: 'bg-green-400',                text: 'text-green-300',   label: 'Connected'             },
  interrupted:  { dot: 'bg-orange-400',               text: 'text-orange-300',  label: 'Transfer interrupted'  },
  disconnected: { dot: 'bg-red-400',                  text: 'text-red-300',     label: 'Disconnected'          },
  error:        { dot: 'bg-red-400',                  text: 'text-red-300',     label: 'Error'                 },
  done:         { dot: 'bg-green-400',                text: 'text-green-300',   label: 'Transfer complete'     },
};

function ConnectionBadge({ status }) {
  const cfg = BADGE_CONFIG[status] ?? BADGE_CONFIG.connecting;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-800 border border-gray-700">
      <span className={`w-2 h-2 rounded-full ${cfg.dot}`} aria-hidden="true" />
      <span className={`text-xs font-medium ${cfg.text}`}>{cfg.label}</span>
    </span>
  );
}

// ── TransferProgress ─────────────────────────────────────────────────────────

function TransferProgress({ progress, bytesTransferred, totalBytes, speed, status }) {
  const isDone = status === 'done';
  return (
    <div className="space-y-2">
      {/* Bar */}
      <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
        <div
          className={[
            'h-2 rounded-full transition-all duration-300',
            isDone ? 'bg-green-500' : 'bg-indigo-500',
          ].join(' ')}
          style={{ width: `${progress}%` }}
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      {/* Stats row */}
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>
          {formatBytes(bytesTransferred)} / {formatBytes(totalBytes)}
        </span>
        <span className="flex items-center gap-2">
          {!isDone && status === 'transferring' && (
            <span className="text-indigo-300">{formatSpeed(speed)}</span>
          )}
          <span className="tabular-nums font-medium text-white">{progress}%</span>
        </span>
      </div>
    </div>
  );
}

// ── Streaming download helper ────────────────────────────────────────────

/**
 * Stream the assembled file from a chunkStore to disk.
 *
 * Tries `showSaveFilePicker` (Chrome/Edge — no full in-memory buffer,
 * native save dialog) first, then falls back to StreamSaver.js
 * (cross-browser, no user gesture required for files < ~4 GB), and
 * finally to a plain Blob download (works everywhere, but holds the
 * whole file in memory — acceptable as a last resort for smaller files).
 */
async function streamDownload(store, metadata, totalChunks) {
  const mimeType = metadata.mimeType || 'application/octet-stream';

  // Option A — File System Access API (Chrome/Edge)
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const fileHandle = await window.showSaveFilePicker({ suggestedName: metadata.name });
      const writable = await fileHandle.createWritable();
      for (let i = 0; i < totalChunks; i++) {
        const buf = await store.read(i);
        await writable.write(buf);
      }
      await writable.close();
      return;
    } catch (err) {
      // AbortError = user cancelled the save dialog; don't fall back in that case.
      if (err && err.name === 'AbortError') {
        throw err;
      }
      // Otherwise (e.g. not supported in this context) fall through.
    }
  }

  // Option B — StreamSaver.js (cross-browser)
  try {
    const { default: streamSaver } = await import('streamsaver');
    const writeStream = streamSaver.createWriteStream(metadata.name, {
      size: metadata.size,
    });
    const writer = writeStream.getWriter();
    for (let i = 0; i < totalChunks; i++) {
      const buf = await store.read(i);
      await writer.write(new Uint8Array(buf));
    }
    await writer.close();
    return;
  } catch (err) {
    console.warn('[ReceiverPage] StreamSaver unavailable, falling back to Blob download:', err);
  }

  // Option C — plain Blob fallback (loads the whole file into memory)
  const allChunks = await store.readAll();
  const blob = new Blob(allChunks, { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = metadata.name;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function ReceiverPage() {
  const { roomId }  = useParams();
  const location    = useLocation();
  const navigate    = useNavigate();
  const socketRef   = useSignalingSocket();

  // Determine role from router state (sender navigated here; receiver opens URL directly)
  const isSender    = location.state?.role === 'sender';
  const fileToSend  = location.state?.file ?? null;

  const [peerId,           setPeerId]           = useState(location.state?.peerId ?? null);
  const [joinError,        setJoinError]         = useState('');
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [copyLabel,        setCopyLabel]         = useState('Copy link');
  const [downloadPhase,    setDownloadPhase]    = useState('idle'); // 'idle' | 'writing' | 'cleaning' | 'done'

  const hasJoinedRef   = useRef(false);
  const downloadedRef  = useRef(false);

  const shareUrl = `${window.location.origin}/r/${roomId}`;

  // ── Join room (receiver only) ──────────────────────────────────────────
  useEffect(() => {
    if (isSender || hasJoinedRef.current) return;
    const socket = socketRef.current;
    if (!socket) return;
    hasJoinedRef.current = true;

    const onRoomJoined = ({ peerIds }) => {
      // peerIds[0] is the sender's socket ID
      if (peerIds.length > 0) setPeerId(peerIds[0]);
    };

    const onPeerJoined = ({ peerId: id }) => {
      setPeerId(id);
    };

    const onError = ({ message, reason }) => {
      if (reason === 'not-found') {
        setJoinError('Room not found. The link may have expired.');
      } else if (reason === 'full') {
        setJoinError('This room already has two participants.');
      } else {
        setJoinError(message || 'Could not join room.');
      }
    };

    socket.on('room-joined',  onRoomJoined);
    socket.on('peer-joined',  onPeerJoined);
    socket.on('signaling-error', onError);
    socket.emit('join-room', { roomId });

    return () => {
      hasJoinedRef.current = false;
      socket.off('room-joined',  onRoomJoined);
      socket.off('peer-joined',  onPeerJoined);
      socket.off('signaling-error', onError);
    };
  }, [isSender, roomId, socketRef]);

  // ── Sender: wait for peer then navigate (already on this page) ────────
  useEffect(() => {
    if (!isSender) return;
    const socket = socketRef.current;
    if (!socket) return;

    const onPeerJoined = ({ peerId: id }) => {
      setPeerId(id);
    };

    socket.on('peer-joined', onPeerJoined);
    return () => socket.off('peer-joined', onPeerJoined);
  }, [isSender, socketRef]);

  // ── WebRTC ─────────────────────────────────────────────────────────────
  const { dataChannel, connectionState, error: rtcError, peerLeft } =
    useWebRTC({
      socket: socketRef.current,
      role:   isSender ? 'sender' : 'receiver',
      peerId,
    });

  // ── File transfer ──────────────────────────────────────────────────────
  const {
    status,
    progress,
    bytesTransferred,
    totalBytes,
    transferSpeed,
    receivedMetadata,
    totalChunks,
    chunkStore,
    storageKind,
    error: transferError,
  } = useFileTransfer({
    dataChannel,
    role:  isSender ? 'sender' : 'receiver',
    file:  fileToSend,
    transferId: roomId,
  });

  // ── Derive connection badge status ────────────────────────────────────
  useEffect(() => {
    if (transferError || rtcError) {
      setConnectionStatus('error');
    } else if (status === 'done') {
      setConnectionStatus('done');
    } else if (peerLeft) {
      // handled separately below
    } else if (connectionState === 'connected') {
      setConnectionStatus('connected');
    } else if (connectionState === 'failed' || connectionState === 'disconnected') {
      setConnectionStatus('disconnected');
    } else if (peerId) {
      setConnectionStatus('connecting');
    } else {
      setConnectionStatus('waiting');
    }
  }, [connectionState, status, peerId, peerLeft, transferError, rtcError]);

  // ── Peer-left: handle all three disconnect scenarios ──────────────────
  useEffect(() => {
    if (!peerLeft) return;
    if (status === 'done') return;           // transfer already finished — ignore
    if (status === 'transferring' || status === 'verifying') {
      setConnectionStatus('interrupted');
    } else {
      setConnectionStatus('disconnected');
    }
  }, [peerLeft, status]);

  // ── Auto-download when done (receiver only) — streams from chunkStore ──
  useEffect(() => {
    if (isSender)                     return;
    if (status !== 'done')            return;
    if (downloadedRef.current)        return;
    if (!chunkStore)                  return;
    if (!receivedMetadata)            return;

    downloadedRef.current = true;

    (async () => {
      try {
        setDownloadPhase('writing');
        await streamDownload(chunkStore, receivedMetadata, totalChunks);
        setDownloadPhase('cleaning');
        await chunkStore.delete();
      } catch (err) {
        if (err && err.name === 'AbortError') {
          // User cancelled the save dialog — allow retry.
          downloadedRef.current = false;
          setDownloadPhase('idle');
          return;
        }
        console.error('[ReceiverPage] Download error:', err);
      } finally {
        if (downloadedRef.current) {
          setDownloadPhase('done');
        }
      }
    })();
  }, [isSender, status, chunkStore, receivedMetadata, totalChunks]);

  // ── Manual retry for save-dialog cancellation ─────────────────────────
  const handleRetryDownload = useCallback(() => {
    downloadedRef.current = false;
    setDownloadPhase('idle');
  }, []);

  // ── Copy share link ───────────────────────────────────────────────────
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopyLabel('Copied!');
      setTimeout(() => setCopyLabel('Copy link'), 2000);
    });
  }, [shareUrl]);

  // ── Derived display values ────────────────────────────────────────────
  const displayName = isSender
    ? (fileToSend?.name ?? 'File')
    : (receivedMetadata?.name ?? '—');

  const displaySize = isSender
    ? (fileToSend?.size != null ? formatBytes(fileToSend.size) : '—')
    : (receivedMetadata?.size != null ? formatBytes(receivedMetadata.size) : '—');

  const showProgress = status === 'transferring' || status === 'verifying' || status === 'done';

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4 py-12">

      {/* Logo */}
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-white tracking-tight">
          Easy<span className="text-indigo-400">Share</span>
        </h1>
      </div>

      {/* Join error (room not found / full) */}
      {joinError && (
        <div className="w-full max-w-md bg-red-950/50 border border-red-800 rounded-2xl p-5 mb-4 text-center">
          <p className="text-sm text-red-300 font-medium">⚠️ {joinError}</p>
          <button
            onClick={() => navigate('/')}
            className="mt-3 text-sm text-indigo-400 underline underline-offset-2 hover:text-indigo-300"
          >
            Back to home
          </button>
        </div>
      )}

      {/* Main card */}
      {!joinError && (
        <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden">

          {/* Card header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider font-medium">
                {isSender ? 'Sending' : 'Receiving'}
              </p>
              <p className="text-sm font-semibold text-white mt-0.5 break-all line-clamp-1" title={displayName}>
                {displayName}
              </p>
              {displaySize !== '—' && (
                <p className="text-xs text-gray-400">{displaySize}</p>
              )}
            </div>
            <ConnectionBadge status={connectionStatus} />
          </div>

          {/* Card body */}
          <div className="px-5 py-5 space-y-5">

            {/* Room ID */}
            <div className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-3">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider">Room</p>
                <p className="text-lg font-mono font-bold text-white tracking-widest">{roomId}</p>
              </div>
              <button
                onClick={handleCopy}
                className="text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-800 hover:border-indigo-600 rounded-lg px-3 py-1.5 transition-colors"
              >
                {copyLabel}
              </button>
            </div>

            {/* Sender: waiting for peer prompt */}
            {isSender && connectionStatus === 'waiting' && (
              <div className="text-center py-4 space-y-2">
                <p className="text-sm text-gray-300">Share this link with the recipient:</p>
                <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
                  <p className="flex-1 text-xs text-indigo-300 break-all font-mono">{shareUrl}</p>
                </div>
                <p className="text-xs text-gray-500">Waiting for them to connect…</p>
              </div>
            )}

            {/* Receiver: waiting for sender */}
            {!isSender && connectionStatus === 'waiting' && (
              <div className="text-center py-4">
                <div className="flex justify-center mb-3">
                  <PulseIcon />
                </div>
                <p className="text-sm text-gray-300">Waiting for the sender to connect…</p>
              </div>
            )}

            {/* Transfer progress */}
            {showProgress && (
              <TransferProgress
                progress={progress}
                bytesTransferred={bytesTransferred}
                totalBytes={totalBytes}
                speed={transferSpeed}
                status={status}
              />
            )}

            {/* Verifying state */}
            {status === 'verifying' && (
              <p className="text-xs text-center text-indigo-300 animate-pulse">
                Verifying file integrity…
              </p>
            )}

            {/* Writing phase — IDB fallback path can be slow enough to show */}
            {status === 'done' && !isSender && downloadPhase === 'writing' && (
              <p className="text-xs text-center text-indigo-300 animate-pulse">
                {storageKind === 'indexeddb'
                  ? 'Preparing your download (this may take a moment)…'
                  : 'Preparing your download…'}
              </p>
            )}

            {/* Cleanup phase */}
            {status === 'done' && !isSender && downloadPhase === 'cleaning' && (
              <p className="text-xs text-center text-gray-400 animate-pulse">
                Cleaning up temporary storage…
              </p>
            )}

            {/* Done: receiver */}
            {status === 'done' && !isSender && downloadPhase === 'done' && (
              <div className="bg-green-950/40 border border-green-800 rounded-xl p-4 text-center space-y-1">
                <p className="text-sm font-semibold text-green-300">✅ Transfer complete</p>
                <p className="text-xs text-green-400/80">
                  {receivedMetadata?.name} has been saved to your downloads.
                </p>
              </div>
            )}

            {/* Done but download was cancelled — offer retry */}
            {status === 'done' && !isSender && downloadPhase === 'idle' && downloadedRef.current === false && (
              <div className="bg-yellow-950/40 border border-yellow-800 rounded-xl p-4 text-center space-y-2">
                <p className="text-sm font-semibold text-yellow-300">Download not started</p>
                <p className="text-xs text-yellow-400/80">The save dialog was cancelled.</p>
                <button
                  onClick={handleRetryDownload}
                  className="text-xs text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
                >
                  Retry download
                </button>
              </div>
            )}

            {/* Done: sender */}
            {status === 'done' && isSender && (
              <div className="bg-green-950/40 border border-green-800 rounded-xl p-4 text-center">
                <p className="text-sm font-semibold text-green-300">✅ File sent successfully</p>
              </div>
            )}

            {/* Transfer error */}
            {(transferError || rtcError) && (
              <div className="bg-red-950/40 border border-red-800 rounded-xl p-4 space-y-2">
                <p className="text-sm font-semibold text-red-300">⚠️ Transfer error</p>
                <p className="text-xs text-red-400/80">{transferError || rtcError}</p>
              </div>
            )}

            {/* Disconnect: interrupted mid-transfer */}
            {connectionStatus === 'interrupted' && !transferError && (
              <div className="bg-orange-950/40 border border-orange-800 rounded-xl p-4 space-y-1">
                <p className="text-sm font-semibold text-orange-300">⚠️ Peer disconnected mid-transfer</p>
                <p className="text-xs text-orange-400/80">The file is incomplete and cannot be recovered.</p>
              </div>
            )}

            {/* Disconnect: before transfer started */}
            {connectionStatus === 'disconnected' && !transferError && status !== 'done' && (
              <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
                <p className="text-sm text-gray-300">🔴 Peer disconnected before the transfer started.</p>
              </div>
            )}

            {/* Back to home */}
            {(connectionStatus === 'disconnected'
              || connectionStatus === 'interrupted'
              || connectionStatus === 'error'
              || status === 'done') && (
              <button
                onClick={() => navigate('/')}
                className="w-full text-sm text-center text-indigo-400 hover:text-indigo-300 underline underline-offset-2 transition-colors"
              >
                ← Start a new transfer
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Animated pulse icon for "waiting" state. */
function PulseIcon() {
  return (
    <svg className="w-8 h-8 text-indigo-500 animate-pulse" fill="none" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 2" />
      <circle cx="12" cy="12" r="4"  fill="currentColor" />
    </svg>
  );
}

// client/src/pages/ReceiverPage.jsx
// Stage 8: Transfer speed, connection badge, hardened disconnect handling

import { useEffect, useRef, useState } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { useSignalingSocket } from '../hooks/useSignalingSocket';
import { useWebRTC } from '../hooks/useWebRTC';
import { useFileTransfer } from '../hooks/useFileTransfer';

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (!n) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(n) / Math.log(k));
  return `${(n / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// Stage 8: format bytes/sec → "X.X MB/s" or "X KB/s"
function fmtSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '—';
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${Math.round(bytesPerSec / 1024)} KB/s`;
}

// ── ConnectionBadge ───────────────────────────────────────────────────────────
// Stage 8: persistent header badge reflecting connection state
function ConnectionBadge({ connectionStatus }) {
  const configs = {
    connecting:    { dot: 'bg-yellow-400 animate-pulse', text: 'text-yellow-300', label: 'Connecting…' },
    waiting:       { dot: 'bg-yellow-400 animate-pulse', text: 'text-yellow-300', label: 'Waiting for peer…' },
    connected:     { dot: 'bg-green-400',                text: 'text-green-300',  label: 'Connected' },
    disconnected:  { dot: 'bg-red-500',                  text: 'text-red-400',    label: 'Disconnected' },
    interrupted:   { dot: 'bg-orange-500',               text: 'text-orange-400', label: 'Transfer interrupted' },
    error:         { dot: 'bg-red-500',                  text: 'text-red-400',    label: 'Error' },
  };
  const cfg = configs[connectionStatus] ?? configs.connecting;

  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800 border border-slate-700 text-xs font-medium ${cfg.text}`}>
      <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </div>
  );
}

// ── TransferProgress ──────────────────────────────────────────────────────────
function TransferProgress({ status, progress, bytesTransferred, totalBytes, chunksReceived, totalChunks, transferSpeed, error }) {
  if (status === 'error') {
    return (
      <div className="mt-4 p-4 bg-red-50 border border-red-300 rounded-lg text-red-700">
        <p className="font-semibold">❌ Integrity check failed</p>
        <p className="text-sm mt-1">{error}</p>
      </div>
    );
  }

  if (status === 'verifying') {
    return (
      <div className="mt-4 p-4 bg-yellow-50 border border-yellow-300 rounded-lg">
        <div className="flex items-center gap-2 text-yellow-700">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span className="font-medium">Verifying file integrity…</span>
        </div>
        <p className="text-xs text-yellow-600 mt-1">Computing SHA-256 hash of received file</p>
      </div>
    );
  }

  const isDone = status === 'done';

  return (
    <div className="mt-4">
      {/* Stage 8: top row — label + percentage + speed */}
      <div className="flex justify-between items-baseline text-sm text-gray-600 mb-1">
        <span>{isDone ? 'Complete' : 'Transferring…'}</span>
        <div className="flex items-baseline gap-3">
          {/* Stage 8: speed display */}
          {!isDone && (
            <span className="text-xs text-gray-400 font-mono">
              {fmtSpeed(transferSpeed)}
            </span>
          )}
          <span className="font-semibold">{progress}%</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-200 rounded-full h-2.5">
        <div
          className={`h-2.5 rounded-full transition-all duration-200 ${isDone ? 'bg-green-500' : 'bg-blue-500'}`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Stage 8: bottom row — bytes + chunk count */}
      <div className="flex justify-between text-xs text-gray-500 mt-1">
        <span>{fmtBytes(bytesTransferred)} / {fmtBytes(totalBytes)}</span>
        {chunksReceived > 0 && (
          <span>Chunks: {chunksReceived} / {totalChunks}</span>
        )}
      </div>
    </div>
  );
}

// ── ReceiverPage ──────────────────────────────────────────────────────────────
export default function ReceiverPage() {
  const { roomId } = useParams();
  const location = useLocation();
  const isSender = location.state?.role === 'sender';
  const fileFromState = location.state?.file ?? null;
  const peerIdFromState = location.state?.peerId ?? null;

  const socketRef = useSignalingSocket();
  const socket = socketRef.current;

  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [peerSocketId, setPeerSocketId] = useState(peerIdFromState);
  const [signalingError, setSignalingError] = useState(null);

  const role = isSender ? 'sender' : 'receiver';
  const fileRef = useRef(fileFromState);

  // Stage 7: guards auto-download against StrictMode double-invoke
  const downloadedRef = useRef(false);
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [downloadName, setDownloadName] = useState('');

  // ── Signaling ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    if (!isSender) {
      socket.emit('join-room', { roomId });
    }

    const onRoomJoined = ({ peerIds }) => {
      setPeerSocketId(peerIds[0]);
      setConnectionStatus('waiting');
    };
    const onPeerJoined = ({ peerId }) => setPeerSocketId(peerId);
    const onPeerLeft = () => {
      // Stage 8: connection status update happens in the main component body
      // based on transfer status — set to disconnected here as a fallback
      setConnectionStatus(prev =>
        prev === 'connected' ? 'disconnected' : prev
      );
    };
    const onSignalingError = ({ message }) => {
      setSignalingError(message);
      setConnectionStatus('error');
    };

    socket.on('room-joined', onRoomJoined);
    socket.on('peer-joined', onPeerJoined);
    socket.on('peer-left', onPeerLeft);
    socket.on('signaling-error', onSignalingError);

    return () => {
      socket.off('room-joined', onRoomJoined);
      socket.off('peer-joined', onPeerJoined);
      socket.off('peer-left', onPeerLeft);
      socket.off('signaling-error', onSignalingError);
    };
  }, [socket, isSender, roomId]);

  // ── WebRTC ────────────────────────────────────────────────────────────────
  // Stage 8: useWebRTC now accepts `socket` directly (not socketRef)
  // and exposes `peerLeft`
  const { dataChannel, connectionState, peerLeft } = useWebRTC({
    socket,
    role,
    peerId: peerSocketId,
  });

  useEffect(() => {
    if (connectionState === 'connected') setConnectionStatus('connected');
    else if (connectionState === 'failed' || connectionState === 'disconnected') {
      setConnectionStatus('disconnected');
    }
  }, [connectionState]);

  // ── File transfer ─────────────────────────────────────────────────────────
  const {
    status,
    progress,
    bytesTransferred,
    totalBytes,
    chunksReceived,
    totalChunks,
    receivedMetadata,
    receivedChunks,
    error,
    transferSpeed,  // Stage 8
  } = useFileTransfer({
    dataChannel,
    role,
    file: fileRef.current,
  });

  // ── Stage 8: handle peerLeft scenarios ────────────────────────────────────
  useEffect(() => {
    if (!peerLeft) return;

    if (status === 'transferring') {
      // Mid-transfer disconnect
      setConnectionStatus('interrupted');
    } else if (status === 'done') {
      // Transfer already finished — don't disrupt the success screen
    } else {
      // Before transfer started
      setConnectionStatus('disconnected');
    }
  }, [peerLeft, status]);

  // ── Stage 7: Auto-download ─────────────────────────────────────────────────
  useEffect(() => {
    if (isSender) return;
    if (status !== 'done') return;
    if (!receivedChunks || !receivedMetadata) return;
    if (downloadedRef.current) return;
    downloadedRef.current = true;

    const blob = new Blob(receivedChunks, {
      type: receivedMetadata.mimeType || 'application/octet-stream',
    });
    const fileName = receivedMetadata.name;

    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);
    setDownloadName(fileName);

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    console.log('[ReceiverPage] auto-download triggered:', fileName);
  }, [status, receivedChunks, receivedMetadata, isSender]);

  // Revoke Blob URL on unmount
  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-md">

        {/* Stage 8: header with title + connection badge */}
        <div className="flex items-start justify-between mb-2">
          <h1 className="text-2xl font-bold text-gray-800">
            {isSender ? '📤 Sending File' : '📥 Receiving File'}
          </h1>
          <ConnectionBadge connectionStatus={connectionStatus} />
        </div>

        <p className="text-sm text-gray-500 mb-6">
          Room: <span className="font-mono font-semibold">{roomId}</span>
        </p>

        {/* File info — sender */}
        {isSender && fileRef.current && (
          <div className="bg-gray-50 rounded-lg p-3 mb-4 text-sm text-gray-700">
            <p className="font-medium truncate">{fileRef.current.name}</p>
            <p className="text-gray-500">{fmtBytes(fileRef.current.size)}</p>
          </div>
        )}

        {/* File info — receiver (from metadata) */}
        {!isSender && receivedMetadata && (
          <div className="bg-gray-50 rounded-lg p-3 mb-4 text-sm text-gray-700">
            <p className="font-medium truncate">{receivedMetadata.name}</p>
            <p className="text-gray-500">{fmtBytes(receivedMetadata.size)}</p>
          </div>
        )}

        {/* Progress / verifying / error */}
        {['transferring', 'verifying', 'done', 'error'].includes(status) && (
          <TransferProgress
            status={status}
            progress={progress}
            bytesTransferred={bytesTransferred}
            totalBytes={totalBytes}
            chunksReceived={chunksReceived}
            totalChunks={totalChunks}
            transferSpeed={transferSpeed}
            error={error}
          />
        )}

        {/* Completion */}
        {status === 'done' && (
          <div className="mt-4 p-4 bg-green-50 border border-green-300 rounded-lg text-green-700">
            {isSender ? (
              <p className="font-semibold">✅ File sent successfully</p>
            ) : (
              <>
                <p className="font-semibold">✅ Transfer complete — ✓ Verified</p>
                <p className="text-sm mt-1">
                  {chunksReceived} chunks received &amp; SHA-256 verified.
                  Your download has started automatically.
                </p>
                {downloadUrl && (
                  <a
                    href={downloadUrl}
                    download={downloadName}
                    className="mt-3 inline-block px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
                  >
                    ⬇️ Download again
                  </a>
                )}
              </>
            )}
          </div>
        )}

        {/* Stage 8: sender error from closed channel */}
        {isSender && status === 'error' && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
            ❌ {error || 'Transfer failed.'}
          </div>
        )}

        {/* Stage 8: Disconnect scenarios — receiver side */}
        {!isSender && connectionStatus === 'interrupted' && status !== 'done' && (
          <div className="mt-4 p-3 bg-orange-50 border border-orange-200 rounded-lg text-orange-700 text-sm">
            <p className="font-semibold">⚠️ Peer disconnected mid-transfer.</p>
            <p className="mt-1">The file is incomplete and cannot be recovered.</p>
          </div>
        )}

        {!isSender && connectionStatus === 'disconnected' && status === 'idle' && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
            🔴 Peer disconnected before transfer started.
          </div>
        )}

        {/* Generic disconnected fallback (not mid-transfer, not idle) */}
        {connectionStatus === 'disconnected' && status !== 'done' && status !== 'idle' && connectionStatus !== 'interrupted' && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
            The other peer disconnected.
          </div>
        )}
      </div>
    </div>
  );
}

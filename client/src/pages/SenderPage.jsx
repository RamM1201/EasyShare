/**
 * SenderPage — the home/sender view.
 *
 * Flow:
 *  1. User drags a file (≤50 MB) onto the drop zone (or clicks to pick).
 *  2. We connect to the signaling server and emit 'create-room'.
 *  3. On 'room-created', we display a shareable link.
 *  4. We wait for 'peer-joined'. When it fires, we navigate to /r/:roomId
 *     and pass the file + peerId so Stage 4 can start the WebRTC handshake.
 *
 * Stage 3 does NOT initiate RTCPeerConnection — that's Stage 4. All this
 * page does is get a room ID and show the share link.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSignalingSocket } from '../hooks/useSignalingSocket';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// Human-readable file size
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SenderPage() {
  const navigate = useNavigate();
  const socketRef = useSignalingSocket();

  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  // Room state
  const [roomId, setRoomId] = useState(null);
  const [shareLink, setShareLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [waitingForPeer, setWaitingForPeer] = useState(false);
  const [signalingError, setSignalingError] = useState('');

  // File input ref for click-to-browse
  const inputRef = useRef(null);

  // ─── Socket listeners ───────────────────────────────────────────────
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    function onRoomCreated({ roomId: id }) {
      setRoomId(id);
      const link = `${window.location.origin}/r/${id}`;
      setShareLink(link);
      setWaitingForPeer(true);
      setSignalingError('');
    }

    function onPeerJoined({ peerId }) {
      // A receiver connected — hand off to the room page so Stage 4 can
      // open the RTCPeerConnection. We pass state via React Router so the
      // room page knows it is the sender.
      navigate(`/r/${roomId}`, {
        state: { role: 'sender', file, peerId },
      });
    }

    function onSignalingError({ message }) {
      setSignalingError(message);
      setWaitingForPeer(false);
    }

    socket.on('room-created', onRoomCreated);
    socket.on('peer-joined', onPeerJoined);
    socket.on('signaling-error', onSignalingError);

    return () => {
      socket.off('room-created', onRoomCreated);
      socket.off('peer-joined', onPeerJoined);
      socket.off('signaling-error', onSignalingError);
    };
  }, [socketRef, navigate, roomId, file]);

  // ─── File validation ─────────────────────────────────────────────────
  function validateAndSetFile(f) {
    setFileError('');
    if (!f) return;
    if (f.size > MAX_FILE_SIZE) {
      setFileError(
        `File is ${formatBytes(f.size)} — the limit is 50 MB. Pick a smaller file.`
      );
      return;
    }
    setFile(f);
  }

  // ─── Drag handlers ────────────────────────────────────────────────────
  const onDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files[0];
    validateAndSetFile(dropped);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onInputChange = (e) => {
    validateAndSetFile(e.target.files[0]);
  };

  // ─── Create room ──────────────────────────────────────────────────────
  function handleCreateRoom() {
    if (!file) return;
    const socket = socketRef.current;
    if (!socket) return;
    setSignalingError('');
    socket.emit('create-room');
  }

  // ─── Copy link ───────────────────────────────────────────────────────
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text
    }
  }

  // ─── Reset ────────────────────────────────────────────────────────────
  function handleReset() {
    setFile(null);
    setFileError('');
    setRoomId(null);
    setShareLink('');
    setWaitingForPeer(false);
    setSignalingError('');
    setCopied(false);
    if (inputRef.current) inputRef.current.value = '';
  }

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg space-y-8">

        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold tracking-tight text-white">
            Easy<span className="text-link">Share</span>
          </h1>
          <p className="text-slate-400 text-sm leading-relaxed">
            Drop a file. Share the link. The recipient downloads directly
            from your browser — no server ever sees your data.
          </p>
        </div>

        {/* ── Step 1: File picker ─────────────────────────────────── */}
        {!roomId && (
          <div className="space-y-4">
            {/* Drop zone */}
            <button
              type="button"
              onClick={() => !file && inputRef.current?.click()}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              aria-label="Drop zone — drag a file here or click to browse"
              className={[
                'w-full rounded-xl border-2 border-dashed px-6 py-12 text-center',
                'transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-link',
                isDragging
                  ? 'border-link bg-link/5'
                  : file
                  ? 'border-slate-700 bg-slate-900/60'
                  : 'border-slate-700 bg-slate-900/40 hover:border-slate-500 hover:bg-slate-900/60',
              ].join(' ')}
            >
              {file ? (
                <div className="space-y-2">
                  {/* File icon */}
                  <div className="mx-auto w-10 h-10 rounded-lg bg-link/10 flex items-center justify-center">
                    <svg
                      className="w-5 h-5 text-link"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                  </div>
                  <p className="text-white font-medium truncate max-w-xs mx-auto">
                    {file.name}
                  </p>
                  <p className="text-slate-400 text-xs">{formatBytes(file.size)}</p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReset();
                    }}
                    className="mt-1 text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2 transition-colors"
                  >
                    Choose a different file
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Upload icon */}
                  <div className="mx-auto w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center">
                    <svg
                      className="w-5 h-5 text-slate-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                      />
                    </svg>
                  </div>
                  <div>
                    <p className="text-slate-300 font-medium">
                      {isDragging ? 'Release to select' : 'Drag a file here'}
                    </p>
                    <p className="text-slate-500 text-xs mt-1">
                      or{' '}
                      <span className="text-link underline underline-offset-2">
                        browse your files
                      </span>{' '}
                      · up to 50 MB
                    </p>
                  </div>
                </div>
              )}
            </button>

            <input
              ref={inputRef}
              type="file"
              className="sr-only"
              onChange={onInputChange}
              tabIndex={-1}
            />

            {/* File size error */}
            {fileError && (
              <p role="alert" className="text-red-400 text-sm text-center">
                {fileError}
              </p>
            )}

            {/* Signaling / server error */}
            {signalingError && (
              <p role="alert" className="text-red-400 text-sm text-center">
                {signalingError}
              </p>
            )}

            {/* Create room button */}
            <button
              type="button"
              onClick={handleCreateRoom}
              disabled={!file}
              className={[
                'w-full rounded-lg py-3 px-6 font-semibold text-sm transition-all duration-150',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-link',
                file
                  ? 'bg-link text-slate-950 hover:bg-cyan-300 active:scale-[0.98]'
                  : 'bg-slate-800 text-slate-500 cursor-not-allowed',
              ].join(' ')}
            >
              {file ? 'Generate share link' : 'Drop a file first'}
            </button>
          </div>
        )}

        {/* ── Step 2: Share link + waiting state ──────────────────── */}
        {roomId && (
          <div className="space-y-6">
            {/* Share link card */}
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 space-y-4">
              <div className="flex items-center gap-2">
                {/* Pulsing green dot while waiting */}
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-link opacity-60" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-link" />
                </span>
                <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                  {waitingForPeer ? 'Waiting for receiver…' : 'Receiver connected!'}
                </span>
              </div>

              <div>
                <p className="text-xs text-slate-500 mb-1.5">Share this link</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-lg bg-slate-800 px-3 py-2.5 text-xs font-mono text-link truncate">
                    {shareLink}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopy}
                    aria-label="Copy share link"
                    className="shrink-0 rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2.5 text-xs font-medium text-slate-300 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-link"
                  >
                    {copied ? (
                      <span className="text-link">Copied!</span>
                    ) : (
                      'Copy'
                    )}
                  </button>
                </div>
              </div>

              {/* File info summary */}
              <div className="flex items-center gap-3 rounded-lg bg-slate-800/60 px-3 py-2.5">
                <svg
                  className="w-4 h-4 text-slate-500 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                <div className="min-w-0">
                  <p className="text-slate-300 text-xs font-medium truncate">{file?.name}</p>
                  <p className="text-slate-500 text-xs">{formatBytes(file?.size ?? 0)}</p>
                </div>
              </div>
            </div>

            {/* Room ID badge */}
            <div className="text-center">
              <p className="text-slate-500 text-xs">
                Room{' '}
                <span className="font-mono text-slate-300 tracking-widest">
                  {roomId}
                </span>
              </p>
            </div>

            {/* Cancel / start over */}
            <button
              type="button"
              onClick={handleReset}
              className="w-full rounded-lg py-2.5 px-6 text-sm text-slate-500 hover:text-slate-300 border border-slate-800 hover:border-slate-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-link"
            >
              Cancel and start over
            </button>
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-slate-600 text-xs">
          Files transfer directly between browsers. This server only coordinates the handshake.
        </p>
      </div>
    </div>
  );
}

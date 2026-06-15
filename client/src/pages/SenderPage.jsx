/**
 * SenderPage.jsx
 *
 * Home page — drag-and-drop file selection, room creation, and share-link display.
 * After creating a room the sender navigates to /r/:roomId with role='sender'.
 *
 * Stage 12: file size limit raised to 2 GB (large-file support via OPFS/IDB).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import useSignalingSocket from '../hooks/useSignalingSocket';

// Stage 12: raise to 2 GB — the UI will warn; actual limit is browser RAM/storage
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

/** Format bytes to a human-readable string. */
function formatBytes(bytes) {
  if (bytes < 1024)                   return `${bytes} B`;
  if (bytes < 1024 * 1024)           return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)   return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function SenderPage() {
  const navigate   = useNavigate();
  const socketRef  = useSignalingSocket();

  const [file,         setFile]         = useState(null);
  const [fileError,    setFileError]    = useState('');
  const [isDragging,   setIsDragging]   = useState(false);
  const [isCreating,   setIsCreating]   = useState(false);
  const [roomId,       setRoomId]       = useState('');
  const [copyLabel,    setCopyLabel]    = useState('Copy link');
  const [sigError,     setSigError]     = useState('');
  const fileInputRef   = useRef(null);

  const shareUrl = roomId
    ? `${window.location.origin}/r/${roomId}`
    : '';

  // ── Validate and set file ──────────────────────────────────────────────
  const pickFile = useCallback((f) => {
    setFileError('');
    if (!f) return;
    if (f.size > MAX_FILE_SIZE) {
      setFileError(`File is too large (${formatBytes(f.size)}). Maximum size is 2 GB.`);
      return;
    }
    setFile(f);
    setRoomId('');
    setSigError('');
  }, []);

  // ── Drag-and-drop handlers ─────────────────────────────────────────────
  const onDragOver  = (e) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = ()  => setIsDragging(false);
  const onDrop      = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) pickFile(dropped);
  };

  // ── Create room ────────────────────────────────────────────────────────
  const handleCreateRoom = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || !file) return;

    setIsCreating(true);
    setSigError('');

    const onRoomCreated = ({ roomId: id }) => {
      setRoomId(id);
      setIsCreating(false);
      navigate(`/r/${id}`, { state: { role: 'sender', file } });
    };

    const onError = ({ message }) => {
      setSigError(message || 'Could not create room. Please try again.');
      setIsCreating(false);
    };

    socket.once('room-created',    onRoomCreated);
    socket.once('signaling-error', onError);
    socket.emit('create-room');
  }, [socketRef, file, navigate]);

  // ── Copy link ──────────────────────────────────────────────────────────
  const handleCopy = useCallback(() => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopyLabel('Copied!');
      setTimeout(() => setCopyLabel('Copy link'), 2000);
    });
  }, [shareUrl]);

  // ── File icon based on MIME ────────────────────────────────────────────
  const fileIcon = file
    ? file.type.startsWith('image/') ? '🖼️'
    : file.type.startsWith('video/') ? '🎬'
    : file.type.startsWith('audio/') ? '🎵'
    : file.type === 'application/pdf' ? '📄'
    : '📦'
    : null;

  // ── Large-file advisory ────────────────────────────────────────────────
  const isLargeFile = file && file.size > 50 * 1024 * 1024;

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4 py-12">

      {/* ── Logo / Brand ───────────────────────────────────────────────── */}
      <div className="mb-10 text-center">
        <h1 className="text-4xl font-bold text-white tracking-tight">
          Easy<span className="text-indigo-400">Share</span>
        </h1>
        <p className="mt-2 text-sm text-gray-400">
          Direct browser-to-browser file transfer — no server, no storage, no sign-up.
        </p>
      </div>

      {/* ── Card ────────────────────────────────────────────────────────── */}
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl p-6 space-y-5">

        {/* Drop zone */}
        <button
          type="button"
          aria-label="Drop zone — click or drag a file here"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={[
            'w-full rounded-xl border-2 border-dashed transition-colors duration-150',
            'flex flex-col items-center justify-center gap-3 py-10 px-4 cursor-pointer',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
            isDragging
              ? 'border-indigo-400 bg-indigo-950/40'
              : file
              ? 'border-indigo-600 bg-indigo-950/20'
              : 'border-gray-700 bg-gray-800/50 hover:border-gray-500 hover:bg-gray-800',
          ].join(' ')}
        >
          {file ? (
            <>
              <span className="text-4xl">{fileIcon}</span>
              <div className="text-center">
                <p className="text-sm font-medium text-white break-all line-clamp-2">
                  {file.name}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{formatBytes(file.size)}</p>
              </div>
              <span className="text-xs text-indigo-400 underline underline-offset-2">
                Change file
              </span>
            </>
          ) : (
            <>
              <span className="text-4xl text-gray-600" aria-hidden="true">⬆️</span>
              <div className="text-center">
                <p className="text-sm text-gray-300">
                  <span className="font-medium text-white">Click to choose</span> or drag &amp; drop
                </p>
                <p className="text-xs text-gray-500 mt-1">Any file up to 2 GB</p>
              </div>
            </>
          )}
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          className="sr-only"
          aria-hidden="true"
          onChange={(e) => pickFile(e.target.files?.[0])}
        />

        {/* Large-file advisory */}
        {isLargeFile && !fileError && (
          <p className="text-xs text-yellow-400 flex items-center gap-1.5">
            <span aria-hidden="true">⚠️</span>
            Large file ({formatBytes(file.size)}) — both peers need to stay on the page until transfer completes.
          </p>
        )}

        {/* File validation error */}
        {fileError && (
          <p role="alert" className="text-sm text-red-400 flex items-center gap-1.5">
            <span aria-hidden="true">⚠️</span> {fileError}
          </p>
        )}

        {/* Signaling error */}
        {sigError && (
          <p role="alert" className="text-sm text-red-400 flex items-center gap-1.5">
            <span aria-hidden="true">⚠️</span> {sigError}
          </p>
        )}

        {/* Create room button */}
        <button
          type="button"
          onClick={handleCreateRoom}
          disabled={!file || isCreating}
          className={[
            'w-full rounded-xl py-3 px-4 text-sm font-semibold transition-all duration-150',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
            !file || isCreating
              ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white shadow-lg shadow-indigo-900/40',
          ].join(' ')}
        >
          {isCreating ? (
            <span className="flex items-center justify-center gap-2">
              <SpinnerIcon /> Creating room…
            </span>
          ) : (
            'Generate share link'
          )}
        </button>
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <p className="mt-8 text-xs text-gray-600 text-center max-w-xs">
        Your file goes directly to the recipient's browser over an encrypted WebRTC channel.
        Nothing is stored on any server.
      </p>
    </div>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="animate-spin h-4 w-4 text-white"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
    </svg>
  );
}

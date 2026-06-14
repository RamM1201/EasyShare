/**
 * ReceiverPage — the /r/:roomId view.
 *
 * This component serves a dual role depending on the React Router `state`
 * passed when navigating here:
 *
 *  • Sender lands here  (state.role === 'sender') after a peer joins.
 *    Stage 4 will read state.file and state.peerId to start the WebRTC
 *    offer. For now we render a "peer connected" waiting screen.
 *
 *  • Receiver lands here directly via the share link (no router state).
 *    We emit 'join-room' immediately on mount, then handle the responses.
 *
 * Stage 3 responsibilities:
 *   - join-room / room-joined / signaling-error handling
 *   - peer-left graceful disconnect message
 *   - Clear UI for every state: joining → connected → peer left → error
 *
 * Stage 4 will add the WebRTC layer on top of this scaffold.
 */

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useSignalingSocket } from '../hooks/useSignalingSocket';

export default function ReceiverPage() {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const socketRef = useSignalingSocket();

  // Determine our role from router state (set by SenderPage on peer-joined).
  const routerState = location.state || {};
  const isSender = routerState.role === 'sender';

  // State machine: 'joining' | 'connected' | 'peer-left' | 'error'
  const [phase, setPhase] = useState(isSender ? 'connected' : 'joining');
  const [errorMsg, setErrorMsg] = useState('');

  // For the sender role, Stage 4 will pull these from routerState.
  // We store them in refs so they're stable across renders.
  const fileRef = useRef(routerState.file ?? null);
  const peerIdRef = useRef(routerState.peerId ?? null);

  // ─── Socket listeners ──────────────────────────────────────────────
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    // ── Receiver path ────────────────────────────────────────────────
    if (!isSender) {
      // Join the room identified in the URL.
      socket.emit('join-room', { roomId });

      function onRoomJoined({ peerIds }) {
        // peerIds[0] is the sender's socket ID — Stage 4 sends the offer to them.
        peerIdRef.current = peerIds[0] ?? null;
        setPhase('connected');
      }

      function onSignalingError({ message }) {
        setErrorMsg(message);
        setPhase('error');
      }

      socket.on('room-joined', onRoomJoined);
      socket.on('signaling-error', onSignalingError);

      return () => {
        socket.off('room-joined', onRoomJoined);
        socket.off('signaling-error', onSignalingError);
      };
    }

    // ── Sender path (navigated here by SenderPage after peer-joined) ─
    // Nothing to do for signaling at this point. Stage 4 will emit the
    // WebRTC offer from here using peerIdRef.current.
  }, [socketRef, isSender, roomId]);

  // ─── peer-left (both roles) ────────────────────────────────────────
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    function onPeerLeft() {
      setPhase('peer-left');
    }

    socket.on('peer-left', onPeerLeft);
    return () => socket.off('peer-left', onPeerLeft);
  }, [socketRef]);

  // ─── Render helpers ───────────────────────────────────────────────
  function handleGoHome() {
    navigate('/');
  }

  // ─── Phase: joining ───────────────────────────────────────────────
  if (phase === 'joining') {
    return (
      <CenteredLayout>
        <StatusCard
          icon={<SpinnerIcon />}
          title="Connecting…"
          body={
            <>
              Joining room{' '}
              <span className="font-mono text-slate-300 tracking-widest">
                {roomId}
              </span>
            </>
          }
        />
      </CenteredLayout>
    );
  }

  // ─── Phase: error ─────────────────────────────────────────────────
  if (phase === 'error') {
    return (
      <CenteredLayout>
        <StatusCard
          icon={<ErrorIcon />}
          title="Couldn't join"
          body={errorMsg || 'Something went wrong. Check the link and try again.'}
          action={
            <button
              type="button"
              onClick={handleGoHome}
              className="w-full rounded-lg bg-link text-slate-950 py-2.5 px-6 text-sm font-semibold hover:bg-cyan-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-link"
            >
              Send a file instead
            </button>
          }
        />
      </CenteredLayout>
    );
  }

  // ─── Phase: peer-left ─────────────────────────────────────────────
  if (phase === 'peer-left') {
    return (
      <CenteredLayout>
        <StatusCard
          icon={<DisconnectIcon />}
          title="Connection lost"
          body="The other user disconnected. The transfer cannot continue."
          action={
            <button
              type="button"
              onClick={handleGoHome}
              className="w-full rounded-lg bg-link text-slate-950 py-2.5 px-6 text-sm font-semibold hover:bg-cyan-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-link"
            >
              Start a new transfer
            </button>
          }
        />
      </CenteredLayout>
    );
  }

  // ─── Phase: connected ─────────────────────────────────────────────
  // Both sender and receiver land here once both peers are in the room.
  // Stage 4 will mount the WebRTC + transfer UI on top of this.
  return (
    <CenteredLayout>
      <div className="w-full max-w-lg space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold tracking-tight text-white">
            Easy<span className="text-link">Share</span>
          </h1>
          <p className="text-slate-400 text-sm">
            {isSender
              ? 'Receiver connected. Ready to transfer.'
              : 'Connected to sender. Ready to receive.'}
          </p>
        </div>

        {/* Connection card */}
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
            </span>
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              Peers connected
            </span>
          </div>

          <div className="rounded-lg bg-slate-800/60 px-4 py-3 space-y-1">
            <p className="text-slate-500 text-xs">Room</p>
            <p className="font-mono text-slate-200 tracking-widest text-sm">
              {roomId}
            </p>
          </div>

          {/* Sender: show file details */}
          {isSender && fileRef.current && (
            <div className="flex items-center gap-3 rounded-lg bg-slate-800/60 px-4 py-3">
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
                <p className="text-slate-300 text-xs font-medium truncate">
                  {fileRef.current.name}
                </p>
                <p className="text-slate-500 text-xs">
                  {formatBytes(fileRef.current.size)}
                </p>
              </div>
            </div>
          )}

          {/* Stage 4 placeholder notice */}
          <div className="rounded-lg border border-dashed border-slate-700 px-4 py-3 text-center">
            <p className="text-slate-500 text-xs">
              {isSender
                ? '⚡ Stage 4 will begin the WebRTC transfer here.'
                : '⚡ Stage 4 will stream the file here once the sender initiates.'}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleGoHome}
          className="w-full rounded-lg py-2.5 px-6 text-sm text-slate-500 hover:text-slate-300 border border-slate-800 hover:border-slate-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-link"
        >
          Cancel transfer
        </button>
      </div>
    </CenteredLayout>
  );
}

// ─── Small utilities ──────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CenteredLayout({ children }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      {children}
    </div>
  );
}

function StatusCard({ icon, title, body, action }) {
  return (
    <div className="w-full max-w-sm space-y-6 text-center">
      <div className="mx-auto w-14 h-14 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center">
        {icon}
      </div>
      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-white">{title}</h2>
        <p className="text-slate-400 text-sm leading-relaxed">{body}</p>
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="w-6 h-6 text-link animate-spin"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"
      />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      className="w-6 h-6 text-red-400"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
      />
    </svg>
  );
}

function DisconnectIcon() {
  return (
    <svg
      className="w-6 h-6 text-slate-400"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
      />
    </svg>
  );
}

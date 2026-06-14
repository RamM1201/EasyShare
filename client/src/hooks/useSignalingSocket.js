/**
 * useSignalingSocket — shared Socket.io connection hook.
 *
 * Returns a stable socket instance that connects once on mount and
 * disconnects on unmount. Stage 4 (WebRTC) will consume the same socket
 * from this hook rather than creating a second connection.
 *
 * Usage:
 *   const socket = useSignalingSocket();
 *
 * The returned socket is the raw socket.io-client instance, so callers
 * can do socket.emit(...) and socket.on(...) directly.
 */

import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const SIGNALING_SERVER_URL =
  import.meta.env.VITE_SIGNALING_SERVER_URL || 'http://localhost:5000';

// Module-level singleton so every call to useSignalingSocket() in the
// same React tree shares exactly one socket connection.
let _socket = null;
let _refCount = 0;

function getSocket() {
  if (!_socket || _socket.disconnected) {
    _socket = io(SIGNALING_SERVER_URL, {
      // Reconnect automatically on transient network blips.
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });
  }
  return _socket;
}

export function useSignalingSocket() {
  const socketRef = useRef(null);

  useEffect(() => {
    const socket = getSocket();
    socketRef.current = socket;
    _refCount += 1;

    return () => {
      _refCount -= 1;
      // Only fully disconnect when no component is using the socket.
      if (_refCount === 0 && _socket) {
        _socket.disconnect();
        _socket = null;
      }
    };
  }, []);

  return socketRef;
}

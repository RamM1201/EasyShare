/**
 * useSignalingSocket — shared Socket.io connection hook.
 *
 * Returns a stable socketRef whose .current is the raw socket.io-client
 * instance. Connects once on first mount, disconnects when all consumers
 * unmount.
 *
 * Usage:
 *   const socketRef = useSignalingSocket();
 *   socketRef.current.emit('create-room');
 */

import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const SIGNALING_SERVER_URL =
  import.meta.env.VITE_SIGNALING_SERVER_URL || 'http://localhost:5000';

// Module-level singleton so every call to useSignalingSocket() in the
// same React tree shares exactly one socket connection.
let _socket = null;

function getSocket() {
  if (!_socket) {
    _socket = io(SIGNALING_SERVER_URL, {
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
    socketRef.current = getSocket();
  }, []);

  return socketRef;
}

// Default export so pages can do:
//   import useSignalingSocket from '../hooks/useSignalingSocket'
export default useSignalingSocket;

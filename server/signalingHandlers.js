/**
 * Socket.io event handlers implementing EasyShare's signaling protocol.
 *
 * See SIGNALING_PROTOCOL.md at the repo root for the full event/payload
 * reference (written for whoever builds the Stage 3/4 frontend).
 *
 * IMPORTANT: this server only relays signaling messages (WebRTC offers,
 * answers, and ICE candidates) between exactly two peers in a room. It
 * never inspects, stores, or forwards any file data — that travels
 * directly between browsers once the WebRTC data channel is open.
 */

import {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoomIdForSocket,
} from './rooms.js';

export function registerSignalingHandlers(io, socket) {
  // --- Create a new room -------------------------------------------------
  socket.on('create-room', () => {
    if (getRoomIdForSocket(socket.id)) {
      handleLeave(io, socket);
    }

    const roomId = createRoom(socket.id);
    socket.join(roomId);
    socket.emit('room-created', { roomId });
    console.log(`[room ${roomId}] created by ${socket.id}`);
  });

  // --- Join an existing room ---------------------------------------------
  socket.on('join-room', (payload) => {
    const roomId = payload && payload.roomId;

    if (!roomId || typeof roomId !== 'string') {
      socket.emit('signaling-error', {
        message: 'Invalid room ID.',
        reason: 'invalid-room-id',
      });
      return;
    }

    const result = joinRoom(roomId.toUpperCase(), socket.id);

    if (!result.ok) {
      const message =
        result.reason === 'full'
          ? 'This room already has two peers connected.'
          : 'Room not found. Check the link and try again.';
      socket.emit('signaling-error', { message, reason: result.reason });
      return;
    }

    socket.join(roomId.toUpperCase());

    socket.emit('room-joined', {
      roomId: roomId.toUpperCase(),
      peerIds: result.peerIds,
    });

    result.peerIds.forEach((peerId) => {
      io.to(peerId).emit('peer-joined', { peerId: socket.id });
    });

    console.log(`[room ${roomId.toUpperCase()}] ${socket.id} joined`);
  });

  // --- Relay WebRTC signaling data ---------------------------------------
  socket.on('signal', (payload) => {
    const { to, data } = payload || {};

    if (!to || data === undefined) {
      socket.emit('signaling-error', {
        message: 'Malformed signal payload.',
        reason: 'invalid-signal',
      });
      return;
    }

    io.to(to).emit('signal', { from: socket.id, data });
  });

  // --- Explicit leave / disconnect ----------------------------------------
  socket.on('leave-room', () => {
    handleLeave(io, socket);
  });

  socket.on('disconnect', () => {
    handleLeave(io, socket);
  });
}

/**
 * Shared cleanup for both explicit "leave-room" and socket disconnects.
 * Notifies any remaining peer in the room so the UI can show a
 * disconnection message (Stage 8).
 */
function handleLeave(io, socket) {
  const result = leaveRoom(socket.id);
  if (!result) return;

  socket.leave(result.roomId);

  result.remainingPeerIds.forEach((peerId) => {
    io.to(peerId).emit('peer-left', { peerId: socket.id });
  });

  console.log(`[room ${result.roomId}] ${socket.id} left`);
}

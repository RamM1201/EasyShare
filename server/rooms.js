/**
 * In-memory room state for the EasyShare signaling server.
 *
 * A "room" represents a single file-transfer session. For the MVP, a room
 * holds at most MAX_PEERS_PER_ROOM peers (the sender who created it, and
 * one receiver who joins via the share link). Supporting more peers per
 * room (mesh swarming) is a planned optional extension — see
 * PROJECT_ROADMAP.md, Stage 11.
 *
 * Room data lives only in memory. If the server restarts, all rooms are
 * lost — this is fine because rooms are short-lived signaling sessions,
 * not persistent data, and contain no file content.
 */

import { customAlphabet } from 'nanoid';

// Avoid visually ambiguous characters (0/O, 1/I/L) so room IDs are easy
// to read aloud or retype if needed.
const ROOM_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ROOM_ID_LENGTH = 6;
const generateRoomId = customAlphabet(ROOM_ID_ALPHABET, ROOM_ID_LENGTH);

export const MAX_PEERS_PER_ROOM = 2;

/** roomId -> { peers: Set<socketId>, createdAt: number } */
const rooms = new Map();

/** socketId -> roomId, for quick cleanup on disconnect */
const socketRoomMap = new Map();

/**
 * Create a new room and add the creating socket as its first peer.
 * Returns the generated room ID.
 */
export function createRoom(socketId) {
  let roomId = generateRoomId();
  while (rooms.has(roomId)) {
    roomId = generateRoomId();
  }

  rooms.set(roomId, {
    peers: new Set([socketId]),
    createdAt: Date.now(),
  });
  socketRoomMap.set(socketId, roomId);

  return roomId;
}

/** Look up a room by ID. Returns undefined if it doesn't exist. */
export function getRoom(roomId) {
  return rooms.get(roomId);
}

/** Look up which room (if any) a socket currently belongs to. */
export function getRoomIdForSocket(socketId) {
  return socketRoomMap.get(socketId);
}

/**
 * Attempt to add a socket to an existing room.
 *
 * Returns either:
 *   { ok: true, peerIds: string[] }            — existing peers in the room
 *   { ok: false, reason: 'not-found' | 'full' }
 */
export function joinRoom(roomId, socketId) {
  const room = rooms.get(roomId);

  if (!room) {
    return { ok: false, reason: 'not-found' };
  }

  if (room.peers.size >= MAX_PEERS_PER_ROOM) {
    return { ok: false, reason: 'full' };
  }

  const existingPeerIds = Array.from(room.peers);
  room.peers.add(socketId);
  socketRoomMap.set(socketId, roomId);

  return { ok: true, peerIds: existingPeerIds };
}

/**
 * Remove a socket from whatever room it's in (on disconnect or explicit
 * leave). Deletes the room entirely once it's empty.
 *
 * Returns { roomId, remainingPeerIds } or null if the socket wasn't in a
 * room.
 */
export function leaveRoom(socketId) {
  const roomId = socketRoomMap.get(socketId);
  if (!roomId) return null;

  socketRoomMap.delete(socketId);

  const room = rooms.get(roomId);
  if (!room) return null;

  room.peers.delete(socketId);
  const remainingPeerIds = Array.from(room.peers);

  if (room.peers.size === 0) {
    rooms.delete(roomId);
  }

  return { roomId, remainingPeerIds };
}

/** Number of currently active rooms — used by the /health endpoint. */
export function getRoomCount() {
  return rooms.size;
}

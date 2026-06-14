/**
 * EasyShare — Signaling Server
 * ------------------------------
 * This server's ONLY job is to help two browsers find each other and
 * exchange the WebRTC "offer/answer/ICE candidate" messages needed to
 * open a direct peer-to-peer connection. It never reads, stores, or
 * relays any actual file data — once the WebRTC data channel is open,
 * everything flows directly between browsers.
 *
 * - Room state management lives in ./rooms.js
 * - Socket.io event handlers live in ./signalingHandlers.js
 * - Full protocol reference: SIGNALING_PROTOCOL.md (repo root)
 */

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

import { registerSignalingHandlers } from './signalingHandlers.js';
import { getRoomCount } from './rooms.js';

const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

// --- REST endpoints -------------------------------------------------

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'EasyShare signaling server is running',
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    connectedClients: io.engine.clientsCount,
    activeRooms: getRoomCount(),
  });
});

// --- Socket.io connection handling -----------------------------------

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);
  registerSignalingHandlers(io, socket);
});

// --- Start server ------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(`EasyShare signaling server listening on port ${PORT}`);
});

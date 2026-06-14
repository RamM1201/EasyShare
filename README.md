# EasyShare

A lightweight, decentralised peer-to-peer file transfer app. Drop a file, share a link, and the recipient downloads it directly from your browser over a WebRTC data channel — no file data ever touches a server.

## Live Demo

> 🔗 **Coming in Stage 10** — deploy URLs will be added here after deployment.

---

## How it works

1. **Sender** drops a file and clicks "Generate share link." A Node.js + Socket.io **signaling server** creates a unique 6-character room ID and returns a shareable URL.
2. **Receiver** opens the link, which joins the same room. The signaling server relays WebRTC offer/answer/ICE candidate messages to complete the handshake.
3. Once both browsers are connected, the file is **streamed directly browser-to-browser** over an encrypted WebRTC data channel. No file data passes through the server.
4. The receiver verifies every 16 KB chunk (SHA-256) and the full file on completion, then triggers an automatic download.

The signaling server's only job is the initial handshake — it never reads, stores, or processes file content.

---

## Features

- **Drag-and-drop** file picker with 50 MB guard
- **Real-time progress** — transfer percentage, bytes transferred, and live speed (MB/s)
- **SHA-256 integrity** — each chunk and the full file are verified before download
- **Auto-download** on the receiver when transfer is complete
- **Graceful disconnect handling** — all three scenarios (before / mid / after transfer) show a clear message on both peers without freezing
- **Zero file data on the server** — the signaling server only carries WebRTC handshake messages

---

## Getting started (local development)

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9

### 1. Clone the repo

```bash
git clone https://github.com/your-username/easyshare.git
cd easyshare
```

### 2. Start the signaling server

```bash
cd server
npm install
npm run dev
```

The server listens at `http://localhost:5000` by default.

### 3. Start the frontend

```bash
cd client
npm install
npm run dev
```

The Vite dev server runs at `http://localhost:3000`.

### 4. Test a transfer

1. Open `http://localhost:3000`.
2. Drag a file (≤ 50 MB) onto the drop zone and click **Generate share link**.
3. Open the generated link in a second browser window or tab.
4. Both windows show **Connected**. The file starts transferring immediately.
5. The receiver gets an automatic download when the transfer completes.

---

## Environment variables

| Variable | Location | Default | Purpose |
|---|---|---|---|
| `VITE_SIGNALING_SERVER_URL` | `client/.env` | `http://localhost:5000` | WebSocket URL for the signaling server |
| `PORT` | `server/.env` | `5000` | Port the signaling server listens on |
| `CLIENT_ORIGIN` | `server/.env` | `http://localhost:3000` | Allowed CORS origin for Socket.io |

Create a `.env` file in each directory before running (or just rely on the defaults for local dev).

---

## Project structure

```
easyshare/
├── client/                          # React 18 + Vite + Tailwind CSS frontend
│   ├── src/
│   │   ├── hooks/
│   │   │   ├── useSignalingSocket.js  # Singleton Socket.io connection
│   │   │   ├── useWebRTC.js           # RTCPeerConnection lifecycle
│   │   │   └── useFileTransfer.js     # Chunking, hashing, send/receive logic
│   │   ├── pages/
│   │   │   ├── SenderPage.jsx         # Home — drag-drop + room creation
│   │   │   └── ReceiverPage.jsx       # /r/:roomId — transfer UI for both peers
│   │   ├── App.jsx                    # React Router setup
│   │   ├── main.jsx
│   │   └── index.css
│   ├── index.html
│   ├── vite.config.js
│   └── tailwind.config.js
└── server/                          # Node.js + Express + Socket.io signaling server
    ├── index.js                     # Express app + Socket.io bootstrap
    ├── rooms.js                     # In-memory room registry (max 2 peers)
    └── signalingHandlers.js         # Socket event handlers
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend framework | React 18 |
| Build tool | Vite |
| Styling | Tailwind CSS |
| Routing | React Router 6 |
| Real-time signaling | Socket.io (client + server) |
| P2P transport | WebRTC — raw `RTCPeerConnection` + `DataChannel` |
| Integrity verification | Web Crypto API (`SubtleCrypto.digest`, SHA-256) |
| Backend runtime | Node.js 18+ |
| Backend framework | Express |
| Module system | ES Modules (`"type": "module"`) on both sides |

---

## Architecture notes

- **No TURN server** — ICE uses Google STUN only (`stun.l.google.com:19302`). Peers on the same local network or with cooperative NATs connect directly. Strict symmetric NATs will fail (acceptable for MVP).
- **Chunk size** — 16 KB (`CHUNK_SIZE` in `useFileTransfer.js`). Smaller than the 64 KB DataChannel limit to keep per-chunk hashing fast.
- **Backpressure** — the sender checks `dataChannel.bufferedAmount` and awaits `bufferedamountlow` events to avoid overwhelming the DataChannel buffer.
- **Room capacity** — exactly 2 peers (`MAX_PEERS_PER_ROOM = 2` in `server/rooms.js`). Multi-peer swarming is a planned optional extension (Stage 11).
- **File size limit** — 50 MB for the MVP. Larger file support via OPFS/IndexedDB is Stage 12.

---

## Deployment

> 📋 **Coming in Stage 10.** Deployment instructions and live URLs will be added here.

Planned hosting:
- **Frontend** — Vercel or Netlify (static Vite build)
- **Backend** — Render or Railway (Node.js service)

---

## Roadmap

| Stage | Title | Status |
|---|---|---|
| 1 | Project scaffolding & architecture | ✅ Done |
| 2 | Signaling server (room logic) | ✅ Done |
| 3 | Room creation & join UI | ✅ Done |
| 4 | WebRTC peer connection setup | ✅ Done |
| 5 | File chunking & transfer | ✅ Done |
| 6 | Chunk verification (SHA-256) | ✅ Done |
| 7 | Reassembly & auto-download | ✅ Done |
| 8 | Progress UI & graceful disconnects | ✅ Done |
| 9 | Polish, testing, README | ✅ Done |
| 10 | Deployment | ⬜ Not started |
| 11 (opt) | Multi-peer mesh swarming | ⬜ Not started |
| 12 (opt) | Large file support (OPFS/IndexedDB) | ⬜ Not started |
| 13 (opt) | Zero-knowledge encryption | ⬜ Not started |
| 14 (opt) | Connection churn recovery | ⬜ Not started |

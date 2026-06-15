# EasyShare

A lightweight, decentralised peer-to-peer file transfer app. Drop a file, share a link, and the recipient downloads it directly from your browser over a WebRTC data channel — no file data ever touches a server.

Built for the **P2P Web Share — Direct Browser-to-Browser File Transfer** problem statement.

---

## How it works

1. **Sender** drops a file and clicks "Generate share link." A Node.js + Socket.io **signaling server** creates a unique 6-character room ID and returns a shareable URL.
2. **Receiver** opens the link, which joins the same room. The signaling server relays WebRTC offer/answer/ICE candidate messages to complete the handshake.
3. Once both browsers are connected, the file is **streamed directly browser-to-browser** over an encrypted WebRTC data channel. No file data passes through the server.
4. The receiver verifies every 256 KB chunk (SHA-256) and an incremental running hash of the full file, then triggers an automatic streaming download.

The signaling server's only job is the initial handshake — it never reads, stores, or processes file content.

---

## Features

### Core MVP
- **Drag-and-drop** file picker with room/link generation
- **Socket.io signaling** to coordinate WebRTC offer/answer/ICE exchange
- **Direct P2P transfer** over a WebRTC data channel, chunked via `FileReader`
- **Chunk-level SHA-256 verification** plus a full-file incremental hash check
- **Real-time progress UI** — percentage, bytes transferred, live speed (MB/s), and smoothed ETA
- **Graceful disconnect handling** — before, during, and after transfer, with clear UI states on both peers
- **Auto-download** on the receiver once the transfer is verified

### Implemented extensions
- **Large File Support (>500 MB)** — incoming chunks are written directly to disk using **OPFS** (Origin Private File System), with an **IndexedDB** fallback when OPFS isn't available. Downloads stream via the File System Access API or StreamSaver.js, avoiding full in-memory buffering. Current UI limit: **10 GB**.
- **Backpressure-aware sending** — the sender watches `dataChannel.bufferedAmount` and waits for `bufferedamountlow` before queuing more data.
- **Serial chunk processing queue** on the receiver to avoid race conditions when writing to OPFS/IndexedDB.

### Not yet implemented (optional extensions)
- Multi-peer mesh swarming
- Zero-knowledge (Web Crypto AES-GCM) encryption
- Connection churn recovery / resume-from-last-chunk

---

## Getting started (local development)

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9

### 1. Clone the repo

```bash
git clone https://github.com/RamM1201/EasyShare.git
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
2. Drag a file onto the drop zone and click **Generate share link**.
3. Open the generated link in a second browser window, tab, or device.
4. Both windows show **Connected**. The file starts transferring immediately.
5. The receiver gets an automatic (streamed) download when the transfer completes and verifies.

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
│   ├── public/
│   │   ├── mitm.html                  # StreamSaver.js helper (download streaming)
│   │   └── sw.js                      # StreamSaver.js service worker
│   ├── src/
│   │   ├── hooks/
│   │   │   ├── useSignalingSocket.js  # Singleton Socket.io connection
│   │   │   ├── useWebRTC.js           # RTCPeerConnection lifecycle
│   │   │   └── useFileTransfer.js     # Chunking, hashing, send/receive logic
│   │   ├── storage/
│   │   │   └── chunkStore.js          # OPFS / IndexedDB chunk storage backends
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
| Integrity verification | Web Crypto API (`SubtleCrypto.digest`, incremental SHA-256) |
| Local storage (large files) | Origin Private File System (OPFS) with IndexedDB fallback |
| Streaming download | File System Access API / StreamSaver.js / Blob fallback |
| Backend runtime | Node.js 18+ |
| Backend framework | Express |
| Module system | ES Modules (`"type": "module"`) on both sides |

---

## Architecture notes

- **No TURN server** — ICE uses Google STUN only (`stun.l.google.com:19302`, `stun1.l.google.com:19302`). Peers on the same local network or with cooperative NATs connect directly. Strict symmetric NATs may fail.
- **Chunk size** — 256 KB (`CHUNK_SIZE` in `useFileTransfer.js`).
- **Integrity** — each chunk is verified by SHA-256 on receipt; an incremental running hash of the whole file is verified against the sender's final hash before the download starts.
- **Backpressure** — the sender checks `dataChannel.bufferedAmount` and awaits `bufferedamountlow` events to avoid overwhelming the DataChannel buffer.
- **Room capacity** — exactly 2 peers (`MAX_PEERS_PER_ROOM = 2` in `server/rooms.js`).
- **File size limit** — up to 10 GB, backed by OPFS (or IndexedDB fallback) so files are never fully buffered in memory.
- **Serial processing** — incoming chunks on the receiver are processed through a strict one-at-a-time queue to avoid race conditions with OPFS writes.

---

## Deployment

>  **Frontend** - https://easy-share-hazel.vercel.app
>
>  **Backend**  - https://easy-share-hazel.vercel.app

Hosting:
- **Frontend** — Vercel
- **Backend** — Render

---

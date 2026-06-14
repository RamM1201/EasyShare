/**
 * useWebRTC.js
 *
 * Manages a single RTCPeerConnection for the lifetime of a room session.
 *
 * @param {Object} params
 * @param {import('socket.io-client').Socket} params.socket - Raw socket (socketRef.current), NOT the ref itself.
 * @param {'sender'|'receiver'} params.role  - Determines who creates the offer.
 * @param {string} params.peerId             - Socket ID of the remote peer.
 *
 * @returns {{
 *   dataChannel: RTCDataChannel|null,
 *   connectionState: string,
 *   iceConnectionState: string,
 *   error: string|null,
 *   peerLeft: boolean
 * }}
 */

import { useEffect, useRef, useState, useCallback } from 'react';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export default function useWebRTC({ socket, role, peerId }) {
  const pcRef = useRef(null);

  const [dataChannel, setDataChannel]           = useState(null);
  const [connectionState, setConnectionState]   = useState('new');
  const [iceConnectionState, setIceConnectionState] = useState('new');
  const [error, setError]                       = useState(null);
  const [peerLeft, setPeerLeft]                 = useState(false);

  /** Tear down the peer connection cleanly. */
  const closePC = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.ondatachannel = null;
      pcRef.current.close();
      pcRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!socket || !peerId) return;

    // ── Create RTCPeerConnection ──────────────────────────────────────────
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    // ── State change handlers ─────────────────────────────────────────────
    pc.onconnectionstatechange = () => {
      setConnectionState(pc.connectionState);
      if (pc.connectionState === 'failed') {
        setError('WebRTC connection failed. Try refreshing both tabs.');
      }
    };

    pc.oniceconnectionstatechange = () => {
      setIceConnectionState(pc.iceConnectionState);
    };

    // ── ICE candidates ────────────────────────────────────────────────────
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socket.emit('signal', {
          to: peerId,
          data: { type: 'ice-candidate', candidate },
        });
      }
    };

    // ── Data channel setup (sender creates, receiver receives) ────────────
    if (role === 'sender') {
      const dc = pc.createDataChannel('file-transfer');
      dc.binaryType = 'arraybuffer';  
      dc.bufferedAmountLowThreshold = 64 * 1024;
      setDataChannel(dc);

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          socket.emit('signal', {
            to: peerId,
            data: { type: 'offer', sdp: pc.localDescription },
          });
        })
        .catch((err) => {
          console.error('[WebRTC] Offer creation failed:', err);
          setError('Failed to create WebRTC offer.');
        });
    } else {
      // Receiver: data channel arrives via ondatachannel
      pc.ondatachannel = ({ channel }) => {
        channel.binaryType = 'arraybuffer';
        setDataChannel(channel);
      };
    }

    // ── Incoming signaling messages ───────────────────────────────────────
    const handleSignal = async ({ from, data }) => {
      if (from !== peerId) return;

      try {
        if (data.type === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', {
            to: peerId,
            data: { type: 'answer', sdp: pc.localDescription },
          });
        } else if (data.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } else if (data.type === 'ice-candidate') {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } catch (err) {
        console.error('[WebRTC] Signal handling error:', err);
        setError('WebRTC signaling error. Try refreshing.');
      }
    };

    socket.on('signal', handleSignal);

    // ── Peer-left: close the connection immediately ───────────────────────
    const handlePeerLeft = () => {
      setPeerLeft(true);
      closePC();
    };

    socket.on('peer-left', handlePeerLeft);

    // ── Cleanup ───────────────────────────────────────────────────────────
    return () => {
      socket.off('signal', handleSignal);
      socket.off('peer-left', handlePeerLeft);
      closePC();
    };
  }, [socket, role, peerId, closePC]);

  return { dataChannel, connectionState, iceConnectionState, error, peerLeft };
}

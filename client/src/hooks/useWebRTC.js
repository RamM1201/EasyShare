/**
 * useWebRTC — establishes an RTCPeerConnection + data channel between the
 * two peers in a room, using the signaling socket from
 * useSignalingSocket().
 *
 * Stage 8 additions:
 *   - Listen for `peer-left` on the socket and close + null the
 *     RTCPeerConnection immediately so no zombie connections linger.
 *   - Expose `peerLeft` boolean so ReceiverPage can distinguish a
 *     signaling-level disconnect from a WebRTC-level one.
 *
 * Usage:
 *   const { dataChannel, connectionState, iceConnectionState, error, peerLeft } =
 *     useWebRTC({ socket, role, peerId });
 */

import { useEffect, useRef, useState } from 'react';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const DATA_CHANNEL_LABEL = 'file-transfer';
const BUFFERED_AMOUNT_LOW_THRESHOLD = 64 * 1024; // 64 KB — used by Stage 5

export function useWebRTC({ socket, role, peerId }) {
  const [connectionState, setConnectionState] = useState('new');
  const [iceConnectionState, setIceConnectionState] = useState('new');
  const [dataChannel, setDataChannel] = useState(null);
  const [error, setError] = useState(null);
  // Stage 8: fires true when peer-left is received from signaling server
  const [peerLeft, setPeerLeft] = useState(false);

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const pendingCandidatesRef = useRef([]);

  // Helper: tear down the RTCPeerConnection cleanly
  const closePeerConnection = () => {
    if (dcRef.current) {
      try { dcRef.current.close(); } catch { /* ignore */ }
      dcRef.current = null;
    }
    if (pcRef.current) {
      try { pcRef.current.close(); } catch { /* ignore */ }
      pcRef.current = null;
    }
    setDataChannel(null);
  };

  useEffect(() => {
    if (!socket || !role || !peerId) return;

    let cancelled = false;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    // ── Shared setup: data channel wiring ─────────────────────────────
    function wireDataChannel(channel) {
      channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
      dcRef.current = channel;

      channel.addEventListener('open', () => {
        if (!cancelled) setDataChannel(channel);
      });

      channel.addEventListener('close', () => {
        if (!cancelled) setDataChannel(null);
      });

      channel.addEventListener('error', (e) => {
        console.error('[webrtc] data channel error', e);
        if (!cancelled) setError('Data channel error.');
      });
    }

    // ── Connection state tracking ─────────────────────────────────────
    pc.onconnectionstatechange = () => {
      if (cancelled) return;
      setConnectionState(pc.connectionState);
      if (pc.connectionState === 'failed') {
        setError('Connection failed. The peer may be unreachable.');
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (cancelled) return;
      setIceConnectionState(pc.iceConnectionState);
    };

    // ── ICE candidate exchange ────────────────────────────────────────
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', {
          to: peerId,
          data: { type: 'ice-candidate', candidate: event.candidate },
        });
      }
    };

    // ── Signal message handler ────────────────────────────────────────
    async function onSignal({ from, data }) {
      if (!data || from !== peerId) return;
      const currentPc = pcRef.current;
      if (!currentPc) return;

      try {
        switch (data.type) {
          case 'offer': {
            if (role !== 'receiver') return;
            await currentPc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            await flushPendingCandidates();
            const answer = await currentPc.createAnswer();
            await currentPc.setLocalDescription(answer);
            socket.emit('signal', {
              to: peerId,
              data: { type: 'answer', sdp: answer },
            });
            break;
          }
          case 'answer': {
            if (role !== 'sender') return;
            await currentPc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            await flushPendingCandidates();
            break;
          }
          case 'ice-candidate': {
            const candidate = new RTCIceCandidate(data.candidate);
            if (currentPc.remoteDescription && currentPc.remoteDescription.type) {
              await currentPc.addIceCandidate(candidate);
            } else {
              pendingCandidatesRef.current.push(candidate);
            }
            break;
          }
          default:
            break;
        }
      } catch (err) {
        console.error('[webrtc] signal handling error', err);
        if (!cancelled) setError('Failed to negotiate connection.');
      }
    }

    async function flushPendingCandidates() {
      const pending = pendingCandidatesRef.current;
      pendingCandidatesRef.current = [];
      for (const candidate of pending) {
        try {
          await pcRef.current?.addIceCandidate(candidate);
        } catch (err) {
          console.error('[webrtc] failed to add buffered ICE candidate', err);
        }
      }
    }

    // ── Stage 8: peer-left handler ────────────────────────────────────
    function onPeerLeft({ peerId: leftId }) {
      if (leftId !== peerId) return;
      console.log('[webrtc] peer-left received — closing RTCPeerConnection');
      closePeerConnection();
      if (!cancelled) setPeerLeft(true);
    }

    socket.on('signal', onSignal);
    socket.on('peer-left', onPeerLeft);

    // ── Role-specific kickoff ─────────────────────────────────────────
    if (role === 'sender') {
      const channel = pc.createDataChannel(DATA_CHANNEL_LABEL);
      wireDataChannel(channel);

      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('signal', {
            to: peerId,
            data: { type: 'offer', sdp: offer },
          });
        } catch (err) {
          console.error('[webrtc] failed to create offer', err);
          if (!cancelled) setError('Failed to start connection.');
        }
      })();
    } else if (role === 'receiver') {
      pc.ondatachannel = (event) => {
        wireDataChannel(event.channel);
      };
    }

    // ── Cleanup ────────────────────────────────────────────────────────
    return () => {
      cancelled = true;
      socket.off('signal', onSignal);
      socket.off('peer-left', onPeerLeft);
      closePeerConnection();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, role, peerId]);

  return { dataChannel, connectionState, iceConnectionState, error, peerLeft };
}

/**
 * useWebRTC — establishes an RTCPeerConnection + data channel between the
 * two peers in a room, using the signaling socket from
 * useSignalingSocket().
 *
 * Stage 4 scope:
 *   - Create RTCPeerConnection with public STUN servers.
 *   - Sender: create data channel 'file-transfer', create offer, send via
 *     `signal`.
 *   - Receiver: listen for `signal` offer, set remote description, create
 *     answer, send via `signal`; capture incoming data channel via
 *     `ondatachannel`.
 *   - Both: exchange ICE candidates via `signal`.
 *   - Surface connectionState / iceConnectionState for the UI.
 *   - Clean up (pc.close()) on unmount.
 *
 * Stage 5 will use the returned `dataChannel` to start sending/receiving
 * file data. Do NOT change the data channel label ('file-transfer') or
 * the bufferedAmountLowThreshold (64 KB) — both are part of the Stage 4/5
 * contract.
 *
 * Usage:
 *   const { dataChannel, connectionState, iceConnectionState, error } =
 *     useWebRTC({ socketRef, role, peerId });
 */

import { useEffect, useRef, useState } from 'react';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const DATA_CHANNEL_LABEL = 'file-transfer';
const BUFFERED_AMOUNT_LOW_THRESHOLD = 64 * 1024; // 64 KB — used by Stage 5

export function useWebRTC({ socketRef, role, peerId }) {
  const [connectionState, setConnectionState] = useState('new');
  const [iceConnectionState, setIceConnectionState] = useState('new');
  const [dataChannel, setDataChannel] = useState(null);
  const [error, setError] = useState(null);

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  // Buffer ICE candidates that arrive before remoteDescription is set.
  const pendingCandidatesRef = useRef([]);

  useEffect(() => {
    const socket = socketRef.current;

    // Wait until we have everything we need to start.
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

    // ── Signal message handler (shared for both roles) ────────────────
    async function onSignal({ from, data }) {
      if (!data || from !== peerId) return;

      try {
        switch (data.type) {
          case 'offer': {
            // Only the receiver should act on offers.
            if (role !== 'receiver') return;
            await pc.setRemoteDescription(
              new RTCSessionDescription(data.sdp)
            );
            await flushPendingCandidates();

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            socket.emit('signal', {
              to: peerId,
              data: { type: 'answer', sdp: answer },
            });
            break;
          }

          case 'answer': {
            // Only the sender should act on answers.
            if (role !== 'sender') return;
            await pc.setRemoteDescription(
              new RTCSessionDescription(data.sdp)
            );
            await flushPendingCandidates();
            break;
          }

          case 'ice-candidate': {
            const candidate = new RTCIceCandidate(data.candidate);
            if (pc.remoteDescription && pc.remoteDescription.type) {
              await pc.addIceCandidate(candidate);
            } else {
              // Remote description not set yet — buffer for later.
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
          await pc.addIceCandidate(candidate);
        } catch (err) {
          console.error('[webrtc] failed to add buffered ICE candidate', err);
        }
      }
    }

    socket.on('signal', onSignal);

    // ── Role-specific kickoff ─────────────────────────────────────────
    if (role === 'sender') {
      // Sender creates the data channel and the initial offer.
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
      // Receiver waits for the sender's data channel.
      pc.ondatachannel = (event) => {
        wireDataChannel(event.channel);
      };
    }

    // ── Cleanup ────────────────────────────────────────────────────────
    return () => {
      cancelled = true;
      socket.off('signal', onSignal);

      if (dcRef.current) {
        try {
          dcRef.current.close();
        } catch {
          // ignore
        }
        dcRef.current = null;
      }

      if (pcRef.current) {
        try {
          pcRef.current.close();
        } catch {
          // ignore
        }
        pcRef.current = null;
      }

      setDataChannel(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socketRef, role, peerId]);

  return { dataChannel, connectionState, iceConnectionState, error };
}

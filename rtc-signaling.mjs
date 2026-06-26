// Node-side WebRTC room handshake over a JSS-compatible signaling server, using
// node-datachannel (libdatachannel — the same WebRTC impl webtorrent ships).
// Returns an open DataChannel that relays a reliable, ordered byte stream — the
// transport the WebRTC bridge uses in place of a raw WebSocket.
//
// Non-trickle ICE: room/tracker signaling has no candidate-relay channel, so we
// wait for ICE gathering to finish and bundle the candidates into the SDP before
// sending it (exactly how the WebTorrent tracker protocol works).
import { WebSocket } from 'ws';
import nodeDataChannel from 'node-datachannel';

const DEFAULT_ICE = ['stun:stun.l.google.com:19302'];
let offerSeq = 0;

// Resolve once ICE gathering completes, returning the full local SDP (offer or
// answer) with candidates embedded.
function gatherComplete(pc) {
  return new Promise((resolve) => {
    if (pc.gatheringState() === 'complete') return resolve(pc.localDescription());
    pc.onGatheringStateChange((state) => { if (state === 'complete') resolve(pc.localDescription()); });
  });
}

// Active side: create the data channel + offer, announce it (retrying until a
// peer is in the room and answers), resolve with the open DataChannel.
export function connectAsOfferer({ signalUrl, room, iceServers = DEFAULT_ICE, label = 'bitcoin', timeoutMs = 20000, log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(signalUrl);
    const pc = new nodeDataChannel.PeerConnection('offerer', { iceServers });
    const dc = pc.createDataChannel(label);
    const offerId = 'o' + (offerSeq++);
    let settled = false, offerSdp = null, timer = null;
    const stop = () => { clearTimeout(to); clearInterval(timer); };
    const to = setTimeout(() => { if (!settled) { settled = true; stop(); try { pc.close(); } catch {} try { ws.close(); } catch {} reject(new Error('rtc connect timeout')); } }, timeoutMs);
    const announce = () => { if (offerSdp && ws.readyState === 1) ws.send(JSON.stringify({ type: 'announce', resource: room, offers: [{ sdp: offerSdp, offer_id: offerId }] })); };

    dc.onOpen(() => { if (settled) return; settled = true; stop(); resolve({ dc, pc, ws, close: () => { try { dc.close(); } catch {} try { pc.close(); } catch {} try { ws.close(); } catch {} } }); });
    ws.on('open', () => { log(`offerer joined room ${room}`); announce(); });
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'answer' && m.resource === room && m.offer_id === offerId && typeof m.sdp === 'string') {
        try { pc.setRemoteDescription(m.sdp, 'answer'); } catch (e) { log('setRemoteDescription(answer) failed: ' + e.message); }
      }
    });
    ws.on('error', (e) => { if (!settled) { settled = true; stop(); try { pc.close(); } catch {} reject(e); } });

    gatherComplete(pc).then((o) => { offerSdp = o.sdp; announce(); timer = setInterval(announce, 2500); });
  });
}

// Passive side: join the room and answer any offer. Calls onChannel(dc, {pc})
// for each established peer. De-dupes repeated offers (re-announce) by sender.
export function connectAsAnswerer({ signalUrl, room, iceServers = DEFAULT_ICE, onChannel, log = () => {} } = {}) {
  const ws = new WebSocket(signalUrl);
  const handled = new Set();
  ws.on('open', () => { log(`answerer joined room ${room}`); ws.send(JSON.stringify({ type: 'announce', resource: room, offers: [] })); });
  ws.on('message', async (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type !== 'offer' || m.resource !== room || typeof m.sdp !== 'string') return;
    const key = `${m.from}:${m.offer_id}`;
    if (handled.has(key)) return;            // duplicate re-announce of an offer we're already handling
    handled.add(key);
    const pc = new nodeDataChannel.PeerConnection('answerer', { iceServers });
    pc.onDataChannel((dc) => onChannel(dc, { pc }));
    pc.onStateChange((s) => { if (s === 'disconnected' || s === 'failed' || s === 'closed') { try { pc.close(); } catch {} } });
    try {
      pc.setRemoteDescription(m.sdp, 'offer');          // libdatachannel auto-creates the answer
      const answer = await gatherComplete(pc);
      ws.send(JSON.stringify({ type: 'answer', resource: room, to: m.from, offer_id: m.offer_id, sdp: answer.sdp }));
    } catch (e) { log('answer failed: ' + e.message); handled.delete(key); }
  });
  ws.on('error', (e) => log('signaling error: ' + e.message));
  return { ws, close: () => { try { ws.close(); } catch {} } };
}

// MeshPeer: a browser-to-browser Bitcoin peer in an N-peer mesh. Tabs join the
// same room on a signaling server (a JSS pod's /.webrtc) and connect DIRECTLY to
// EACH other tab over WebRTC data channels — no server in the data path — then
// speak real Bitcoin p2p messages. `send()` broadcasts to every connected peer.
//
// Join logic (verified node-side in test-mesh-npeer.mjs): on join, learn how many
// peers are already in the room and OFFER a connection to each; and always ANSWER
// any later joiner's offer. So an N-tab room forms a full mesh incrementally.
//
// Non-trickle ICE (room signaling has no candidate relay): gather candidates into
// the SDP before sending each offer/answer.
export class MeshPeer {
  constructor(engine, codec, { onMessage, onPeers, log } = {}) {
    this.engine = engine; this.codec = codec;
    this.onMessage = onMessage; this.onPeers = onPeers; this.log = log || (() => {});
    this.channels = new Set();     // open RTCDataChannels (one per connected peer)
    this.pcs = new Set();          // all RTCPeerConnections
    this.offerPCs = new Map();     // offer_id -> pc (offers we sent, awaiting answers)
    this.bufs = new WeakMap();     // per-channel receive reassembly buffer
    this.ws = null; this.joined = false;
  }

  // Resolves once we've joined the room (not when a peer connects — peers come and
  // go via onPeers). room defaults to the mesh's own room.
  connect(signalUrl, { room = 'c0ffeebabe123456', iceServers = [{ urls: 'stun:stun.l.google.com:19302' }], timeout = 25000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(signalUrl);
      let joinedOnce = false;
      const to = setTimeout(() => { if (!joinedOnce) reject(new Error('mesh signaling timeout')); }, timeout);

      const setupDC = (dc) => {
        dc.binaryType = 'arraybuffer';
        this.bufs.set(dc, new Uint8Array(0));
        dc.onopen = () => { this.channels.add(dc); this.onPeers?.(this.channels.size); };
        dc.onmessage = (ev) => this.#onData(dc, new Uint8Array(ev.data));
        dc.onclose = () => { this.channels.delete(dc); this.onPeers?.(this.channels.size); };
      };

      // We're a later joiner → offer a connection to each existing peer.
      const offerToExisting = async (count) => {
        const offers = [];
        for (let i = 0; i < count; i++) {
          const pc = new RTCPeerConnection({ iceServers }); this.pcs.add(pc);
          setupDC(pc.createDataChannel('mesh'));
          await pc.setLocalDescription(await pc.createOffer());
          await iceComplete(pc);
          const offer_id = 'o' + Math.random().toString(36).slice(2, 8) + i;
          this.offerPCs.set(offer_id, pc);
          offers.push({ sdp: pc.localDescription.sdp, offer_id });
        }
        if (offers.length && ws.readyState === 1) ws.send(JSON.stringify({ type: 'announce', resource: room, offers }));
      };

      // Someone (a later joiner) is offering us a connection → answer it.
      const answer = async (m) => {
        const pc = new RTCPeerConnection({ iceServers }); this.pcs.add(pc);
        pc.ondatachannel = (ev) => setupDC(ev.channel);
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await iceComplete(pc);
        ws.send(JSON.stringify({ type: 'answer', resource: room, to: m.from, offer_id: m.offer_id, sdp: pc.localDescription.sdp }));
      };

      ws.onopen = () => ws.send(JSON.stringify({ type: 'announce', resource: room, offers: [] }));  // join, learn the count
      ws.onmessage = async (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'resource-peers' && !this.joined) {
          this.joined = true; joinedOnce = true; clearTimeout(to); resolve(this);
          if (m.count > 0) offerToExisting(m.count).catch((e) => this.log('mesh offer failed: ' + e.message, 'warn'));
          else this.log('in the room — waiting for a peer (open this page in another tab)…');
        } else if (m.type === 'offer' && m.resource === room) {
          answer(m).catch((e) => this.log('mesh answer failed: ' + e.message, 'warn'));
        } else if (m.type === 'answer' && m.resource === room) {
          const pc = this.offerPCs.get(m.offer_id);
          if (pc && !pc.currentRemoteDescription) { try { await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); } catch {} }
        }
      };
      ws.onerror = () => { if (!joinedOnce) { clearTimeout(to); reject(new Error('mesh signaling error')); } };
    });
  }

  get peerCount() { return this.channels.size; }
  send(command, payload) { const bytes = this.engine.encodeMessage(command, payload); for (const dc of this.channels) if (dc.readyState === 'open') dc.send(bytes); }
  // Gossip: re-broadcast to every peer except the one it came from.
  forward(command, payload, exceptDc) { const bytes = this.engine.encodeMessage(command, payload); for (const dc of this.channels) if (dc !== exceptDc && dc.readyState === 'open') dc.send(bytes); }
  // Send to ONE neighbor (for gossip-mode demos: the mesh carries it onward).
  sendToOne(command, payload) { const bytes = this.engine.encodeMessage(command, payload); for (const dc of this.channels) if (dc.readyState === 'open') { dc.send(bytes); return; } }
  bufferedHigh(max) { for (const dc of this.channels) if (dc.bufferedAmount > max) return true; return false; }
  close() { for (const pc of this.pcs) { try { pc.close(); } catch {} } try { this.ws?.close(); } catch {} }

  #onData(dc, chunk) {
    const prev = this.bufs.get(dc) || new Uint8Array(0);
    const merged = new Uint8Array(prev.length + chunk.length);
    merged.set(prev); merged.set(chunk, prev.length);
    const { messages, consumed } = this.engine.decodeStream(merged);
    this.bufs.set(dc, merged.slice(consumed));
    for (const msg of messages) this.onMessage?.(msg, dc);
  }
}

function iceComplete(pc) {
  return new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    const c = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', c); res(); } };
    pc.addEventListener('icegatheringstatechange', c);
  });
}

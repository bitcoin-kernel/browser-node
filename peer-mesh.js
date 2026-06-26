// MeshPeer: a browser-to-browser Bitcoin peer. Two tabs join the same room on a
// signaling server (a JSS pod's /.webrtc) and connect DIRECTLY over a WebRTC data
// channel — no server in the data path — then speak real Bitcoin p2p messages
// (inv / getdata / block). This is the propagation transport: a tab can relay a
// block to another tab. Role is decided by join order: the peer already in the
// room answers; a later joiner offers (so two tabs pair up deterministically).
//
// Non-trickle ICE (room signaling has no candidate relay): gather candidates into
// the SDP before sending. Mirrors the proven node-side relay (rtc-signaling.mjs).
export class MeshPeer {
  constructor(engine, codec, { onOpen, onMessage, log } = {}) {
    this.engine = engine; this.codec = codec;
    this.onOpen = onOpen; this.onMessage = onMessage; this.log = log || (() => {});
    this.buf = new Uint8Array(0);
    this.dc = null; this.pc = null; this.ws = null; this.role = null;
  }

  connect(signalUrl, { room = 'b17c0192abad1deacafe', iceServers = [{ urls: 'stun:stun.l.google.com:19302' }], timeout = 25000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(signalUrl);
      const offerId = 'o' + Math.random().toString(36).slice(2);
      let settled = false, announceTimer = null, offerSdp = null;
      const stop = () => { clearTimeout(to); clearInterval(announceTimer); };
      const to = setTimeout(() => { if (!settled) { settled = true; stop(); reject(new Error('mesh connect timeout')); } }, timeout);

      const setupDC = (dc) => {
        this.dc = dc; dc.binaryType = 'arraybuffer';
        dc.onopen = () => { if (settled) return; settled = true; stop(); this.onOpen?.(this.role); resolve(this); };
        dc.onmessage = (ev) => this.#onData(new Uint8Array(ev.data));
        dc.onclose = () => this.log('mesh peer disconnected', 'warn');
      };

      // Later joiner → offerer: create the channel + offer, announce it.
      const becomeOfferer = async () => {
        this.role = 'offerer';
        const pc = this.pc = new RTCPeerConnection({ iceServers });
        setupDC(pc.createDataChannel('mesh'));
        await pc.setLocalDescription(await pc.createOffer());
        await iceComplete(pc);
        offerSdp = pc.localDescription.sdp;
        const announce = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'announce', resource: room, offers: [{ sdp: offerSdp, offer_id: offerId }] })); };
        announce(); announceTimer = setInterval(announce, 2500);
      };

      // Already in the room → answerer: answer an incoming offer.
      const answerOffer = async (m) => {
        this.role = 'answerer';
        const pc = this.pc = new RTCPeerConnection({ iceServers });
        pc.ondatachannel = (ev) => setupDC(ev.channel);
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await iceComplete(pc);
        ws.send(JSON.stringify({ type: 'answer', resource: room, to: m.from, offer_id: m.offer_id, sdp: pc.localDescription.sdp }));
      };

      ws.onopen = () => ws.send(JSON.stringify({ type: 'announce', resource: room, offers: [] }));  // join, learn who's here
      ws.onmessage = async (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'resource-peers' && this.role === null) {
          if (m.count > 0) becomeOfferer().catch((e) => { if (!settled) { settled = true; stop(); reject(e); } });
          else { this.role = 'waiting'; this.log('in the room — waiting for a peer to join (open this page in another tab)…'); }
        } else if (m.type === 'offer' && m.resource === room && this.role === 'waiting') {
          answerOffer(m).catch((e) => this.log('answer failed: ' + e.message, 'warn'));
        } else if (m.type === 'answer' && m.resource === room && m.offer_id === offerId && this.role === 'offerer' && this.pc && !this.pc.currentRemoteDescription) {
          try { await this.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); } catch {}
        }
      };
      ws.onerror = () => { if (!settled) { settled = true; stop(); reject(new Error('signaling error')); } };
    });
  }

  send(command, payload) { if (this.dc?.readyState === 'open') this.dc.send(this.engine.encodeMessage(command, payload)); }
  close() { try { this.dc?.close(); } catch {} try { this.pc?.close(); } catch {} try { this.ws?.close(); } catch {} }

  #onData(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    const { messages, consumed } = this.engine.decodeStream(merged);
    this.buf = merged.slice(consumed);
    for (const msg of messages) this.onMessage?.(msg);
  }
}

function iceComplete(pc) {
  return new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    const c = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', c); res(); } };
    pc.addEventListener('icegatheringstatechange', c);
  });
}

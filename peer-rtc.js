// RtcPeer: the browser transport for a Bitcoin p2p peer over WebRTC. A browser
// tab can't open raw TCP, so it connects to a WebRTC-to-TCP bridge (bridge-
// webrtc.mjs) that relays raw Bitcoin p2p bytes to a real peer. Unlike WsPeer
// (peer-ws.js), the bridge needs no reachable host:port or TLS cert — the two
// rendezvous in a room on a signaling server (e.g. a JSS pod's /.webrtc) and
// connect directly via NAT-traversed, DTLS-encrypted WebRTC.
//
// Identical public API and message flow to WsPeer — connect / send / waitFor /
// collect / close — so HeaderSync/validators run unchanged; only connect() does
// the WebRTC room handshake instead of opening a WebSocket. A reliable, ordered
// data channel carries the p2p byte stream, so the engine's encode/decode and
// the same #onData/#dispatch buffering are reused as-is.
//
// Room signaling has no ICE-candidate relay (see signaling-stub.mjs), so this
// gathers all candidates into the SDP before announcing (non-trickle ICE).
export class RtcPeer {
  constructor(engine, codec) {
    this.engine = engine;
    this.codec = codec;
    this.buf = new Uint8Array(0);
    this.waiters = [];
    this.listeners = [];
    this.closed = false;
  }

  // signalUrl: a signaling server, e.g. wss://melvincarvalho.com/.webrtc
  // room: a shared hex string ([a-f0-9]{8,128}); the bridge joins the same room.
  async connect(signalUrl, { room = 'b17c0192abad1deacafe', userAgent = '/bitcoin-kernel-node:0.0.0/',
                             connectTimeout = 20000, iceServers = [{ urls: 'stun:stun.l.google.com:19302' }] } = {}) {
    await this.#establish(signalUrl, room, iceServers, connectTimeout);
    this.send('version', this.engine.buildVersion({ userAgent }));
    await this.waitFor(['verack']);
    return this;
  }

  // Bring up the data channel as the offerer; resolves once it is open.
  #establish(signalUrl, room, iceServers, timeout) {
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(signalUrl);
      const pc = this.pc = new RTCPeerConnection({ iceServers });
      const dc = this.dc = pc.createDataChannel('bitcoin');
      dc.binaryType = 'arraybuffer';
      const offerId = 'o' + Math.random().toString(36).slice(2);
      let settled = false, offerSdp = null, timer = null;
      const stop = () => { clearTimeout(to); clearInterval(timer); };
      const to = setTimeout(() => { if (!settled) { settled = true; stop(); this.#fail(new Error('rtc connect timeout')); reject(new Error('rtc connect timeout')); } }, timeout);
      const announce = () => { if (offerSdp && ws.readyState === 1) ws.send(JSON.stringify({ type: 'announce', resource: room, offers: [{ sdp: offerSdp, offer_id: offerId }] })); };

      dc.onopen = () => { if (settled) return; settled = true; stop(); resolve(); };
      dc.onmessage = (ev) => this.#onData(new Uint8Array(ev.data));
      dc.onclose = () => this.#fail(new Error('peer closed'));
      pc.oniceconnectionstatechange = () => { if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) { if (!settled) { settled = true; stop(); reject(new Error('ice ' + pc.iceConnectionState)); } this.#fail(new Error('ice ' + pc.iceConnectionState)); } };

      ws.onopen = announce;
      ws.onmessage = async (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'answer' && m.resource === room && m.offer_id === offerId && m.sdp && !pc.currentRemoteDescription) {
          try { await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); } catch { /* stale/duplicate answer */ }
        }
      };
      ws.onerror = () => { if (!settled) { settled = true; stop(); reject(new Error('signaling error')); } };

      (async () => {
        await pc.setLocalDescription(await pc.createOffer());
        await this.#iceComplete(pc);
        offerSdp = pc.localDescription.sdp;
        announce();                              // first attempt…
        timer = setInterval(announce, 2500);     // …retry until the bridge is in the room
      })().catch((e) => { if (!settled) { settled = true; stop(); reject(e); } });
    });
  }

  #iceComplete(pc) {
    return new Promise((res) => {
      if (pc.iceGatheringState === 'complete') return res();
      const check = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); res(); } };
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  send(command, payload) { if (!this.closed && this.dc?.readyState === 'open') this.dc.send(this.engine.encodeMessage(command, payload)); }

  waitFor(commands, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const w = { commands, resolve, reject };
      w.timer = setTimeout(() => { this.#drop(w); reject(new Error('timeout waiting for ' + commands.join('/'))); }, timeoutMs);
      this.waiters.push(w);
    });
  }

  collect(command, count, { onItem, timeoutMs = 90000 } = {}) {
    return new Promise((resolve, reject) => {
      let n = 0;
      const out = onItem ? null : [];
      const done = () => { clearTimeout(timer); const i = this.listeners.indexOf(l); if (i >= 0) this.listeners.splice(i, 1); };
      const l = { command, fn: (msg) => { n++; if (onItem) { try { onItem(msg); } catch (e) { done(); reject(e); return; } } else out.push(msg); if (n >= count) { done(); resolve(onItem ? n : out); } } };
      const timer = setTimeout(() => { done(); reject(new Error(`collect timeout: ${n}/${count} ${command}`)); }, timeoutMs);
      l.cancel = () => { done(); reject(new Error('peer closed')); };
      this.listeners.push(l);
    });
  }

  close() { this.closed = true; try { this.dc?.close(); } catch {} try { this.pc?.close(); } catch {} try { this.ws?.close(); } catch {} }

  #onData(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const { messages, consumed } = this.engine.decodeStream(merged);
    this.buf = merged.slice(consumed);
    for (const msg of messages) this.#dispatch(msg);
  }

  #dispatch(msg) {
    if (msg.command === 'version') { this.peerVersion = msg.payload; this.send('verack'); return; }
    if (msg.command === 'ping') { this.send('pong', { nonce: msg.payload?.nonce ?? 0 }); return; }
    for (const l of this.listeners) { if (l.command === msg.command) { l.fn(msg); return; } }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].commands.includes(msg.command)) { const w = this.waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(msg); }
    }
  }

  #drop(w) { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); }

  #fail(err) {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(err); }
    for (const l of this.listeners.splice(0)) l.cancel?.();
  }
}

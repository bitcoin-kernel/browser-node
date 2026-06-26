// Minimal WebRTC signaling server — a wire-compatible subset of JavaScript Solid
// Server's content-addressed ("room") signaling (src/webrtc/index.js). Lets you
// develop the WebRTC bridge locally without running a full JSS pod; the exact
// same client code (peer-rtc.js / rtc-signaling.mjs) then works unchanged against
// a real pod at wss://your.pod/.webrtc.
//
// Room mode only (no WebID auth): peers `announce` a hex resource hash, the
// server assigns each a peerId and relays SDP offers/answers within the group.
// There is deliberately NO ICE-candidate relay — like JSS room mode and the
// WebTorrent tracker protocol, candidates must be bundled into the SDP
// (non-trickle). See docs/webrtc.md in the JSS repo.
//   node signaling-stub.mjs            # ws://localhost:9000/.webrtc
import { WebSocketServer } from 'ws';

const RESOURCE_HASH_RE = /^[a-fA-F0-9]{8,128}$/;
const MAX_OFFERS_PER_ANNOUNCE = 10;

export function startSignaling(port = 9000, { log = () => {} } = {}) {
  const wss = new WebSocketServer({ port });
  const resources = new Map();             // resourceHash -> Map<peerId, socket>
  const joined = new Map();                // socket -> Set<resourceHash>
  let nextPeerId = 1;

  const group = (hash) => { let g = resources.get(hash); if (!g) resources.set(hash, g = new Map()); return g; };

  wss.on('connection', (socket) => {
    const peerId = String(nextPeerId++);
    socket._peerId = peerId;
    joined.set(socket, new Set());

    socket.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'announce') {
        const hash = msg.resource;
        if (typeof hash !== 'string' || !RESOURCE_HASH_RE.test(hash)) {
          return socket.send(JSON.stringify({ type: 'error', message: 'Invalid resource hash' }));
        }
        const g = group(hash);
        const existing = [...g.entries()].filter(([id]) => id !== peerId);
        g.set(peerId, socket); joined.get(socket).add(hash);
        const offers = Array.isArray(msg.offers) ? msg.offers.slice(0, MAX_OFFERS_PER_ANNOUNCE) : [];
        for (let i = 0; i < offers.length && i < existing.length; i++) {
          const [, target] = existing[i];
          if (target.readyState !== 1 || typeof offers[i].sdp !== 'string') continue;
          target.send(JSON.stringify({ type: 'offer', resource: hash, from: peerId, offer_id: offers[i].offer_id ?? String(i), sdp: offers[i].sdp }));
        }
        socket.send(JSON.stringify({ type: 'resource-peers', resource: hash, count: g.size - 1 }));
        return;
      }

      if (msg.type === 'answer' && msg.resource) {
        const g = resources.get(msg.resource);
        const target = g?.get(msg.to);
        if (!target || target.readyState !== 1) return socket.send(JSON.stringify({ type: 'error', message: 'Peer not in resource group' }));
        const relay = { type: 'answer', resource: msg.resource, from: peerId };
        if (typeof msg.offer_id === 'string') relay.offer_id = msg.offer_id;
        if (typeof msg.sdp === 'string') relay.sdp = msg.sdp;
        return target.send(JSON.stringify(relay));
      }

      if (msg.type === 'leave' && msg.resource) {
        const g = resources.get(msg.resource); g?.delete(peerId); joined.get(socket)?.delete(msg.resource);
      }
    });

    socket.on('close', () => {
      for (const hash of joined.get(socket) ?? []) { const g = resources.get(hash); if (g) { g.delete(peerId); if (!g.size) resources.delete(hash); } }
      joined.delete(socket);
    });
    socket.on('error', () => {});
  });

  log(`signaling stub: ws://localhost:${port}/.webrtc (room mode, no auth)`);
  return { wss, close: () => new Promise((r) => wss.close(r)) };
}

// Run standalone when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 9000);
  startSignaling(port, { log: (m) => console.log(m) });
}

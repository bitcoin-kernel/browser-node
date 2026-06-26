// WebRTC-to-TCP bridge — the WebRTC counterpart of bridge.mjs. A browser tab
// can't open raw TCP, so it speaks the Bitcoin p2p protocol over a WebRTC data
// channel and this relays the raw frames to a real testnet4 peer. Same pure-
// transport role as bridge.mjs (it can't forge a header; the tab validates
// everything), but reachable from anywhere: NAT-traversable (STUN/ICE), DTLS-
// encrypted, no open inbound port, no TLS cert. Peers rendezvous in a room on a
// signaling server — e.g. a JavaScript Solid Server pod's wss://your.pod/.webrtc.
//
//   node signaling-stub.mjs                       # local signaling (dev)
//   node bridge-webrtc.mjs                         # joins the room, relays to a peer
//   SIGNAL_URL=wss://melvincarvalho.com/.webrtc PEER_HOST=<ip> node bridge-webrtc.mjs
import net from 'node:net';
import nodeDataChannel from 'node-datachannel';
import { connectAsAnswerer } from './rtc-signaling.mjs';

const MAX_DC = 200 * 1024;   // chunk TCP→DC below libdatachannel's max message size

// Relay one established data channel ↔ a fresh TCP connection to the peer.
function pipe(dc, pc, { peerHost, peerPort, log }) {
  const tcp = net.connect(peerPort, peerHost);
  const queue = [];
  const flush = () => { while (queue.length && dc.isOpen()) dc.sendMessageBinary(queue.shift()); };
  tcp.on('connect', () => log(`  tcp connected → ${peerHost}:${peerPort}`));
  tcp.on('data', (d) => { for (let i = 0; i < d.length; i += MAX_DC) queue.push(d.subarray(i, i + MAX_DC)); flush(); });
  dc.onOpen(flush);
  dc.onMessage((m) => tcp.write(Buffer.isBuffer(m) ? m : Buffer.from(m)));
  const close = () => { try { tcp.destroy(); } catch {} try { dc.close(); } catch {} try { pc.close(); } catch {} };
  tcp.on('close', close); tcp.on('error', (e) => { log('  tcp error: ' + e.message); close(); });
  dc.onClosed(close); dc.onError(() => close());
}

// peerHosts: an array of upstream testnet4 peers. Each browser data channel is
// dialed to a RANDOM one, so N tab connections reach up to N different peers —
// this is what lets the multi-peer broadcast actually fan out to the network.
// (peerHost, singular, is still accepted for backward compatibility.)
export function startBridge({ signalUrl, room, peerHost, peerHosts, peerPort, iceServers, log = () => {} } = {}) {
  const hosts = (peerHosts && peerHosts.length) ? peerHosts : [peerHost];
  log(`webrtc bridge: signaling ${signalUrl} · room ${room} → tcp ${hosts.length} peer(s) :${peerPort} ${hosts.length > 1 ? '(random per connection)' : '[' + hosts[0] + ']'}`);
  const sig = connectAsAnswerer({
    signalUrl, room, iceServers, log,
    onChannel: (dc, { pc }) => {
      const host = hosts[Math.floor(Math.random() * hosts.length)];
      log(`  peer connected via WebRTC — dialing testnet4 peer ${host}`);
      pipe(dc, pc, { peerHost: host, peerPort, log });
    },
  });
  return { close: () => sig.close() };
}

// Resolve the upstream peer list: PEER_HOSTS (comma list) > data/peers-testnet4.json > PEER_HOST.
async function resolveHosts() {
  if (process.env.PEER_HOSTS) return process.env.PEER_HOSTS.split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.PEER_HOST) return [process.env.PEER_HOST];
  try {
    const { readFile } = await import('node:fs/promises');
    const list = JSON.parse(await readFile(new URL('./data/peers-testnet4.json', import.meta.url), 'utf8'));
    if (Array.isArray(list.peers) && list.peers.length) return list.peers;
  } catch { /* fall through to localhost */ }
  return ['127.0.0.1'];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startBridge({
    signalUrl: process.env.SIGNAL_URL || 'ws://localhost:9000/.webrtc',
    room: process.env.ROOM || 'b17c0192abad1deacafe',
    peerHosts: await resolveHosts(),
    peerPort: Number(process.env.PEER_PORT || 48333),
    log: (m) => console.log(m),
  });
  process.on('SIGINT', () => { try { nodeDataChannel.cleanup(); } catch {} process.exit(0); });
}

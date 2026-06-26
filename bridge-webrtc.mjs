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

export function startBridge({ signalUrl, room, peerHost, peerPort, iceServers, log = () => {} } = {}) {
  log(`webrtc bridge: signaling ${signalUrl} · room ${room} → tcp ${peerHost}:${peerPort}`);
  const sig = connectAsAnswerer({
    signalUrl, room, iceServers, log,
    onChannel: (dc, { pc }) => { log('  peer connected via WebRTC — dialing testnet4 peer'); pipe(dc, pc, { peerHost, peerPort, log }); },
  });
  return { close: () => sig.close() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startBridge({
    signalUrl: process.env.SIGNAL_URL || 'ws://localhost:9000/.webrtc',
    room: process.env.ROOM || 'b17c0192abad1deacafe',
    peerHost: process.env.PEER_HOST || '127.0.0.1',
    peerPort: Number(process.env.PEER_PORT || 48333),
    log: (m) => console.log(m),
  });
  process.on('SIGINT', () => { try { nodeDataChannel.cleanup(); } catch {} process.exit(0); });
}

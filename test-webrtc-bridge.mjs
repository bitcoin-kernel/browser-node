// End-to-end test of the WebRTC bridge transport (step 1). In ONE process:
//   1. start the local signaling stub (JSS room-protocol subset),
//   2. start the WebRTC bridge (answerer) pointed at a real testnet4 peer,
//   3. run an offerer that establishes a WebRTC data channel and performs a real
//      Bitcoin version/verack handshake through the bridge to that peer.
// Success = we receive the peer's version (with its user-agent) + verack back
// over the data channel — proving the p2p byte stream relays browser↔bridge↔TCP.
//
//   PEER_HOST=<testnet4 ip> node test-webrtc-bridge.mjs
import { readFile } from 'node:fs/promises';
import nodeDataChannel from 'node-datachannel';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { startSignaling } from './signaling-stub.mjs';
import { startBridge } from './bridge-webrtc.mjs';
import { connectAsOfferer } from './rtc-signaling.mjs';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));

const PORT = 9099;
const ROOM = 'b17c0192abad1deacafe';
const PEER_HOST = process.env.PEER_HOST || '103.165.192.202';   // a known public testnet4 peer
const PEER_PORT = Number(process.env.PEER_PORT || 48333);
const SIGNAL_URL = `ws://localhost:${PORT}/.webrtc`;
const log = (m) => console.log(m);

const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btc:testnet4');

const sig = startSignaling(PORT, { log });
const bridge = startBridge({ signalUrl: SIGNAL_URL, room: ROOM, peerHost: PEER_HOST, peerPort: PEER_PORT, log });

let finished = false;
const shutdown = (code) => { if (finished) return; finished = true; try { bridge.close(); } catch {} try { sig.close(); } catch {} try { nodeDataChannel.cleanup(); } catch {} setImmediate(() => process.exit(code)); };
const fail = (m) => { console.log('\n❌ ' + m); shutdown(1); };
const timeout = setTimeout(() => fail('timed out before handshake completed'), 30000);

log(`\nconnecting offerer → bridge → tcp ${PEER_HOST}:${PEER_PORT} …`);
let conn;
try { conn = await connectAsOfferer({ signalUrl: SIGNAL_URL, room: ROOM, log }); }
catch (e) { fail('WebRTC data channel did not open: ' + e.message); }

if (conn) {
  log('✓ WebRTC data channel open — sending version over it');
  const { dc } = conn;
  let buf = Buffer.alloc(0), gotVersion = false, gotVerack = false, ua = null;
  dc.onMessage((m) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(m) ? m : Buffer.from(m)]);
    const { messages, consumed } = p2p.decodeStream(new Uint8Array(buf));
    buf = buf.subarray(consumed);
    for (const msg of messages) {
      if (msg.command === 'version') { gotVersion = true; ua = msg.payload?.userAgent; log(`  ← version  user-agent ${ua}  height ${msg.payload?.startHeight?.toLocaleString?.() ?? msg.payload?.startHeight}`); dc.sendMessageBinary(Buffer.from(p2p.encodeMessage('verack'))); }
      else if (msg.command === 'verack') { gotVerack = true; log('  ← verack'); }
      else if (msg.command === 'ping') dc.sendMessageBinary(Buffer.from(p2p.encodeMessage('pong', { nonce: msg.payload?.nonce ?? 0 })));
      if (gotVersion && gotVerack && !finished) {
        clearTimeout(timeout);
        log(`\n✅ Bitcoin handshake completed over WebRTC — relayed browser-equiv ↔ bridge ↔ TCP ↔ ${PEER_HOST}`);
        log(`   peer: ${ua}`);
        log('   the WebRTC bridge transport works; swap WsPeer → RtcPeer with a ?signal= room.');
        shutdown(0);
      }
    }
  });
  dc.sendMessageBinary(Buffer.from(p2p.encodeMessage('version', p2p.buildVersion({ userAgent: '/browser-node-webrtc-test:0.0.1/' }))));
}

// De-risk the mesh relay: two peers join the same room (no bridge, no server in
// the path) and relay a Bitcoin block between them over a direct WebRTC data
// channel. Proves the browser↔browser propagation transport that mesh.html uses
// (here both ends are node-datachannel; the browser mirrors it with RTCPeerConnection).
import { readFile } from 'node:fs/promises';
import nodeDataChannel from 'node-datachannel';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { startSignaling } from './signaling-stub.mjs';
import { connectAsOfferer, connectAsAnswerer } from './rtc-signaling.mjs';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const PORT = 9095, ROOM = 'b17c0192abad1deacafe';
const SIGNAL = `ws://localhost:${PORT}/.webrtc`;

const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btc:testnet4');
const blockHex = (await readFile(new URL('data/block-26000.hex', D), 'utf8')).trim();
const expectHash = codec.blockHash(codec.decode('Block', blockHex).header);
const log = (m) => console.log(m);

const sig = startSignaling(PORT, { log });
let done = false;
const end = (c) => { if (done) return; done = true; try { sig.close(); } catch {} try { nodeDataChannel.cleanup(); } catch {} setImmediate(() => process.exit(c)); };
const to = setTimeout(() => { console.log('\n❌ timeout'); end(1); }, 30000);

log(`\nrelaying block #26000 peer→peer in room ${ROOM} (no server in the data path)…`);

// Peer A = the source: answerer. When a peer connects, it serves the block.
connectAsAnswerer({ signalUrl: SIGNAL, room: ROOM, log, onChannel: (dc) => {
  dc.onMessage((m) => { if ((Buffer.isBuffer(m) ? m.toString() : String(m)) === 'getdata') serve(dc); });
  dc.onOpen(() => { log('  A: peer connected → announcing it has block #26000 (inv)'); dc.sendMessage('inv:26000'); });
} });
function serve(dc) { log('  A: got getdata → sending the block over WebRTC'); dc.sendMessageBinary(Buffer.from(p2p.encodeMessage('block', blockHex))); }

// Peer B = the receiver: offerer. Asks for the block, validates what arrives.
const B = await connectAsOfferer({ signalUrl: SIGNAL, room: ROOM, log });
let buf = Buffer.alloc(0);
B.dc.onMessage((m) => {
  if (typeof m === 'string' || (!Buffer.isBuffer(m) && !(m instanceof Uint8Array))) {
    if (String(m).startsWith('inv:')) { log('  B: received inv → requesting the block (getdata)'); B.dc.sendMessage('getdata'); }
    return;
  }
  buf = Buffer.concat([buf, Buffer.isBuffer(m) ? m : Buffer.from(m)]);
  const { messages, consumed } = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(consumed);
  for (const msg of messages) if (msg.command === 'block') {
    const h = codec.blockHash(msg.payload.header);
    clearTimeout(to);
    if (h === expectHash) { log(`\n✅ B received + validated block #26000 from peer A over WebRTC — ${h.slice(0, 16)}… (${msg.payload.transactions.length} txs)`); log('   browser↔browser block propagation works.'); end(0); }
    else { log('\n❌ hash mismatch'); end(1); }
  }
});

// De-risk multi-hop gossip: a LINE topology A—B—C (A and C are NOT directly
// connected). A injects a block; B validates it and FORWARDS to its other peer;
// C receives it — two hops, via B. A seen-set stops it looping back. This is the
// forwarding logic mesh.html adds in (b); here the partial topology is built with
// two rooms (A-B in one, B-C in another) so the hop is real.
import { readFile } from 'node:fs/promises';
import nodeDataChannel from 'node-datachannel';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { startSignaling } from './signaling-stub.mjs';
import { connectAsOfferer, connectAsAnswerer } from './rtc-signaling.mjs';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const PORT = 9092, SIGNAL = `ws://localhost:${PORT}/.webrtc`;
const ROOM_AB = 'aaaaaaaa1111', ROOM_BC = 'bbbbbbbb2222';

const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btc:testnet4');
const blockHex = (await readFile(new URL('data/block-26000.hex', D), 'utf8')).trim();
const expectHash = codec.blockHash(codec.decode('Block', blockHex).header);
const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (cmd, payload) => Buffer.from(p2p.encodeMessage(cmd, payload));

// decode a stream of bytes from one channel into Bitcoin messages
function reader(onMsg) { let buf = Buffer.alloc(0); return (m) => { buf = Buffer.concat([buf, Buffer.isBuffer(m) ? m : Buffer.from(m)]); const r = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(r.consumed); for (const msg of r.messages) onMsg(msg); }; }

const sig = startSignaling(PORT, { log });
let done = false;
const end = (c) => { if (done) return; done = true; try { sig.close(); } catch {} try { nodeDataChannel.cleanup(); } catch {} setImmediate(() => process.exit(c)); };
const to = setTimeout(() => { console.log('\n❌ timeout — block did not reach C via B'); end(1); }, 40000);

log(`\nLINE topology A—B—C (A and C NOT directly connected)…`);

// B has two channels: one to A, one to C. It forwards new blocks across, with a seen-set.
let dcB_toA = null, dcB_toC = null; const seenB = new Set();
const forwardAtB = (msg, fromDc) => {
  if (msg.command !== 'block') return;
  const hash = codec.blockHash(msg.payload.header);
  if (seenB.has(hash)) return;            // already forwarded — stop the loop
  seenB.add(hash);
  log(`  B: received block ${hash.slice(0,12)}… (valid) → forwarding to its other peer`);
  const other = fromDc === dcB_toA ? dcB_toC : dcB_toA;
  if (other) other.sendMessageBinary(enc('block', msg.payload));   // forward the decoded block object
};

// A (answerer in room AB) — injects the block AFTER the whole line is up.
let dcA = null;
connectAsAnswerer({ signalUrl: SIGNAL, room: ROOM_AB, onChannel: (dc) => { dcA = dc; } });
await sleep(800);

// B (offerer to A in room AB, answerer to C in room BC).
const bToA = await connectAsOfferer({ signalUrl: SIGNAL, room: ROOM_AB });
dcB_toA = bToA.dc; bToA.dc.onMessage(reader((msg) => forwardAtB(msg, dcB_toA)));
connectAsAnswerer({ signalUrl: SIGNAL, room: ROOM_BC, onChannel: (dc) => { dcB_toC = dc; dc.onMessage(reader((msg) => forwardAtB(msg, dcB_toC))); } });
await sleep(800);

// C (offerer to B in room BC) — the far end; should receive via B.
const cToB = await connectAsOfferer({ signalUrl: SIGNAL, room: ROOM_BC });
cToB.dc.onMessage(reader((msg) => {
  if (msg.command !== 'block') return;
  const h = codec.blockHash(msg.payload.header);
  clearTimeout(to);
  if (h === expectHash) { log(`  C: received block ${h.slice(0,12)}… — TWO hops from A, via B`); log('\n✅ multi-hop gossip works: A → B → C (C was not directly connected to A)'); end(0); }
  else { console.log('\n❌ wrong block at C'); end(1); }
}));

// wait for the full line to be up, then A injects
for (let i = 0; i < 40 && !(dcA?.isOpen() && dcB_toA?.isOpen() && dcB_toC?.isOpen() && cToB.dc.isOpen()); i++) await sleep(400);
if (!(dcA?.isOpen() && dcB_toC?.isOpen() && cToB.dc.isOpen())) { console.log('\n❌ line did not fully form'); end(1); }
else { log('  line up (A—B—C); A injecting block #26000 toward B'); dcA.sendMessageBinary(enc('block', blockHex)); }

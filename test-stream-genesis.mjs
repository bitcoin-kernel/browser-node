// End-to-end test of the genesis-forward block streaming (node.html's headline):
// download REAL testnet4 blocks from a peer via getdata over the WebRTC bridge,
// re-encode them exactly as the browser does, and full-consensus-validate them
// forward from genesis against a growing UTXO set. Proves the whole pipeline
// that node.html runs in the tab — getdata/block, canonical re-encode, and
// validateBlockStructure/validateBlockContext + applyBlock from height 1.
//
//   PEER_HOST=<testnet4 ip> node test-stream-genesis.mjs
import { readFile } from 'node:fs/promises';
import nodeDataChannel from 'node-datachannel';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { BlockEngine } from './engine/codec/blocks.js';
import { ShardedUtxo } from './sharded-utxo-browser.js';
import { coinviewOf } from './validate-forward.js';
import { applyBlock } from './follow-chain.js';
import { startSignaling } from './signaling-stub.mjs';
import { startBridge } from './bridge-webrtc.mjs';
import { connectAsOfferer } from './rtc-signaling.mjs';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const toHex = (b) => { let s = ''; for (const x of b) s += x.toString(16).padStart(2, '0'); return s; };

const PORT = 9097, ROOM = 'b17c0192abad1deacafe', MSG_WITNESS_BLOCK = 1073741826;
const PEER_HOST = process.env.PEER_HOST || '103.165.192.202', PEER_PORT = Number(process.env.PEER_PORT || 48333);
const SIGNAL_URL = `ws://localhost:${PORT}/.webrtc`;
const N = Number(process.env.N || 200), BATCH = 24;
const log = (m) => console.log(m);

const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btc:testnet4');
const be = BlockEngine.fromSchemas(codec, await jl('chain'), await jl('validate'), await jl('script'), 'btc:testnet4');
const vectors = JSON.parse(await readFile(new URL('data/testnet4.json', D), 'utf8'));
const genesisHash = codec.blockHash(codec.decode('BlockHeader', vectors.genesisHeader));

const sig = startSignaling(PORT, { log });
const bridge = startBridge({ signalUrl: SIGNAL_URL, room: ROOM, peerHost: PEER_HOST, peerPort: PEER_PORT, log });
let finished = false;
const shutdown = (code) => { if (finished) return; finished = true; try { bridge.close(); } catch {} try { sig.close(); } catch {} try { nodeDataChannel.cleanup(); } catch {} setImmediate(() => process.exit(code)); };
const fail = (m) => { console.log('\n❌ ' + m); shutdown(1); };
const timeout = setTimeout(() => fail('timed out'), 90000);

log(`\nstreaming genesis→#${N} from ${PEER_HOST} over WebRTC, full-consensus validating each…`);
const conn = await connectAsOfferer({ signalUrl: SIGNAL_URL, room: ROOM, log }).catch((e) => fail('no data channel: ' + e.message));
if (!conn) throw new Error('unreachable');
const { dc } = conn;

// minimal p2p peer over the data channel: dispatch + waiters
let buf = Buffer.alloc(0); const waiters = [];
const send = (cmd, payload) => dc.sendMessageBinary(Buffer.from(p2p.encodeMessage(cmd, payload)));
const want = (cmd, n, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const w = { cmd, n, got: [], resolve, reject, timer: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error('timeout ' + cmd)); }, timeoutMs) };
  waiters.push(w);
});
dc.onMessage((m) => {
  buf = Buffer.concat([buf, Buffer.isBuffer(m) ? m : Buffer.from(m)]);
  const { messages, consumed } = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(consumed);
  for (const msg of messages) {
    if (msg.command === 'version') { send('verack'); continue; }
    if (msg.command === 'ping') { send('pong', { nonce: msg.payload?.nonce ?? 0 }); continue; }
    for (let i = waiters.length - 1; i >= 0; i--) { const w = waiters[i]; if (w.cmd === msg.command) { w.got.push(msg.payload); if (w.got.length >= w.n) { clearTimeout(w.timer); waiters.splice(i, 1); w.resolve(w.got); } break; } }
  }
});

try {
  send('version', p2p.buildVersion({ userAgent: '/browser-node-stream-test:0.0.1/' }));
  await want('verack', 1); log('✓ handshake');
  send('getheaders', { version: 70016, blockLocator: [genesisHash], hashStop: '0'.repeat(64) });
  const [hmsg] = await want('headers', 1);
  const headers = (hmsg?.entries ?? []).map((e) => e.header);
  log(`✓ ${headers.length} headers from genesis`);
  if (headers.length < N) throw new Error(`only ${headers.length} headers, need ${N}`);

  const snap = new ShardedUtxo(64); const coinview = coinviewOf(snap);
  let height = 0, prevHash = null; const t0 = Date.now();
  for (let off = 0; off < N; off += BATCH) {
    const count = Math.min(BATCH, N - off);
    send('getdata', { items: Array.from({ length: count }, (_, k) => ({ type: MSG_WITNESS_BLOCK, hash: codec.blockHash(headers[off + k]) })) });
    const blocks = await want('block', count);
    for (const payload of blocks) {
      const hex = toHex(codec.encode('Block', payload));      // exact browser re-encode
      const block = codec.decode('Block', hex);
      const h = height + 1;
      const linked = prevHash === null ? null : block.header.prevBlockHash === prevHash;
      const failed = [...be.validateBlockStructure(block).results, ...be.validateBlockContext(block, { height: h, utxo: coinview }).results].filter((r) => r.ok === false).map((r) => r.rule);
      if (failed.length || linked === false) throw new Error(`block #${h} INVALID: ${failed.join(',') || 'unlinked'}`);
      applyBlock(snap, block, h, codec); prevHash = codec.blockHash(block.header); height = h;
    }
    log(`  validated to #${height} · UTXO ${snap.size} coins · ${(height / ((Date.now() - t0) / 1000)).toFixed(0)} blk/s`);
  }
  clearTimeout(timeout);
  log(`\n✅ full-consensus validated ${height} REAL blocks from genesis over WebRTC — every script + signature, UTXO ${snap.size} coins`);
  log('   node.html\'s genesis-forward streaming pipeline works end to end.');
  shutdown(0);
} catch (e) { fail(e.message); }

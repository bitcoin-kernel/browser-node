// The node's validation core in a Web Worker: the engine, the WASM secp backend,
// the UTXO set, and OPFS persistence all run off the main thread. This is the
// scale architecture — flood-block validation and multi-GB checkpoints don't
// freeze the UI, and OPFS *sync access handles* (Worker-only) give fast I/O.
// Main thread talks to it over a tiny postMessage RPC.
import { loadEngine, coinviewOf } from './validate-forward.js';
import { ShardedUtxo } from './sharded-utxo-browser.js';
import { followChain } from './follow-chain.js';
import { setVerifyBackend } from './engine/codec/secp256k1.js';
import { sha256 } from './engine/codec/hash.js';
import { Accumulator } from './swiftsync/accumulator.js';
import { encodeOutpoint } from './swiftsync/outpoint.js';
import { generateHints, reconstructUtxo } from './swiftsync/hint.js';
import { applyBlocks } from './swiftsync/validate.js';
import { encodeHintsfile } from './swiftsync/hintsfile.js';
import { DumpReader, parseHeader, coins } from './dumptxoutset.js';

let codec, be;
let snap = null;             // the worker's RAM-resident coin view
const CKPT = 'utxo-worker.ndjson';

async function init() {
  const e = await loadEngine();
  codec = e.codec; be = e.be;
  // wasm-secp.js has a top-level await (wasm instantiation); load it dynamically
  // so it doesn't block the worker's module evaluation / onmessage registration.
  const { wasmBackend } = await import('./wasm-secp.js');
  setVerifyBackend(wasmBackend);             // WASM secp256k1, inside the worker
  return { ready: true };
}

async function followRange({ n } = {}) {
  snap = new ShardedUtxo(64);
  const seed = await (await fetch('data/range-seed.ndjson')).text();
  let first = true;
  for (const l of seed.split('\n')) { if (!l) continue; if (first) { first = false; continue; } const [k, v] = JSON.parse(l); snap.set(k, v); }
  const start = snap.size;
  const all = await (await fetch('data/range.json')).json();
  const available = all.blocks.length;
  const count = Math.max(1, Math.min(n || available, available));   // ?blocks= knob; default (no n) = the full bundled window
  const range = { start: all.start, end: all.start + count - 1, blocks: all.blocks.slice(0, count) };
  const total = range.blocks.length;
  const t0 = performance.now();
  const r = await followChain({ range, codec, be, snap, coinview: coinviewOf(snap),
    onBlock: (b) => self.postMessage({ progress: 'block', height: b.height, ok: b.ok, txs: b.txs, inputs: b.inputs, utxoSize: b.utxoSize, ms: b.ms, total }) });
  return { validated: r.validated, total: r.total, utxoStart: start, utxoEnd: snap.size, start: range.start, end: range.end, ms: performance.now() - t0, available };
}

// SwiftSync set-consistency over the same range: a constant 32-byte accumulator
// (add created outputs, subtract spent inputs) replaces holding the UTXO set for
// double-spend / fabrication checks. Closed against the start (seed) + terminal
// (survivors) snapshots, a valid range cancels to zero.
async function swiftsync() {
  const NULL = '00'.repeat(32);
  const acc = new Accumulator({ sha256 });
  const seed = await (await fetch('data/range-seed.ndjson')).text();
  let first = true, seedN = 0;
  for (const l of seed.split('\n')) { if (!l) continue; if (first) { first = false; continue; } const [k] = JSON.parse(l); const i = k.lastIndexOf(':'); acc.add(encodeOutpoint({ txid: k.slice(0, i), vout: +k.slice(i + 1) })); seedN++; }
  const range = await (await fetch('data/range.json')).json();
  const survivors = new Set();
  let created = 0, spent = 0; const t0 = performance.now();
  for (const hex of range.blocks) {
    const block = codec.decode('Block', hex);
    for (const tx of block.transactions) {
      const txid = codec.txid(tx);
      for (const inp of tx.inputs) { if (inp.prevout.txid === NULL) continue; acc.spend(encodeOutpoint({ txid: inp.prevout.txid, vout: inp.prevout.vout })); spent++; survivors.delete(`${inp.prevout.txid}:${inp.prevout.vout}`); }
      for (let v = 0; v < tx.outputs.length; v++) { const s = tx.outputs[v].scriptPubKey; if (typeof s === 'string' && (s.startsWith('6a') || s.length > 20000)) continue; acc.add(encodeOutpoint({ txid, vout: v })); created++; survivors.add(`${txid}:${v}`); }
    }
  }
  for (const k of survivors) { const i = k.lastIndexOf(':'); acc.spend(encodeOutpoint({ txid: k.slice(0, i), vout: +k.slice(i + 1) })); }
  return { zero: acc.isZero(), seedN, created, spent, terminal: survivors.size, stateBytes: 32, ms: performance.now() - t0 };
}

// Checkpoint the coin view via an OPFS *synchronous access handle* (Worker-only).
async function checkpoint() {
  if (!snap) throw new Error('no coin view — run followRange first');
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(CKPT, { create: true });
  const a = await fh.createSyncAccessHandle();
  const enc = new TextEncoder();
  a.truncate(0);
  let pos = 0, buf = JSON.stringify({ coins: snap.size }) + '\n';
  for (const [k, v] of snap.entries()) {
    buf += JSON.stringify([k, v]) + '\n';
    if (buf.length > (1 << 20)) { pos += a.write(enc.encode(buf), { at: pos }); buf = ''; }
  }
  if (buf) pos += a.write(enc.encode(buf), { at: pos });
  a.flush(); a.close();
  return { bytes: pos };
}

async function resume() {
  const root = await navigator.storage.getDirectory();
  let fh; try { fh = await root.getFileHandle(CKPT); } catch { return { coins: 0, missing: true }; }
  const a = await fh.createSyncAccessHandle();
  const size = a.getSize(); const bytes = new Uint8Array(size); a.read(bytes, { at: 0 }); a.close();
  snap = new ShardedUtxo(64);
  let first = true;
  for (const l of new TextDecoder().decode(bytes).split('\n')) { if (!l) continue; if (first) { first = false; continue; } const [k, v] = JSON.parse(l); snap.set(k, v); }
  return { coins: snap.size };
}

// SwiftSync at scale, in the tab: stream N outpoints through the accumulator and
// show the set-state stays 32 bytes (off the main thread). The full real result
// is in tools/swiftsync-commit.mjs (14.1M coins, RSS = the file, not 25 GB).
async function scaleAccumulate({ n = 3_000_000 } = {}) {
  const acc = new Accumulator({ sha256 });
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    acc.add(encodeOutpoint({ txid: i.toString(16).padStart(64, '0'), vout: i & 3 }));
    if ((i & 524287) === 0) self.postMessage({ progress: 'scale', done: i, total: n });
  }
  const ms = performance.now() - t0;
  return { n, ms, perSec: Math.round(n / (ms / 1000)), stateBytes: 32, digest: Array.from(acc.digest()).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16) };
}

// Full SwiftSync: generate a compact hints file, reconstruct the UTXO set from
// blocks + hints (no spend processing), and verify it with the accumulator.
async function swiftsyncHints() {
  const txidOf = (tx) => codec.txid(tx);
  const range = await (await fetch('data/range.json')).json();
  const blocks = range.blocks.map((h) => codec.decode('Block', h));
  const seed = (await (await fetch('data/range-seed.ndjson')).text()).split('\n').slice(1).filter(Boolean).map((l) => JSON.parse(l)[0]);
  const t0 = performance.now();
  const { height, blockHints } = generateHints(blocks, { txidOf });
  const hintsBytes = encodeHintsfile({ height, blockHints }).length;
  const surviving = blockHints.reduce((s, a) => s + a.length, 0);
  const utxo = reconstructUtxo(blocks, blockHints, { txidOf });
  const acc = new Accumulator({ sha256 });
  for (const k of seed) { const i = k.lastIndexOf(':'); acc.add(encodeOutpoint({ txid: k.slice(0, i), vout: +k.slice(i + 1) })); }
  applyBlocks(blocks, { txidOf, acc });
  for (const k of utxo) { const i = k.lastIndexOf(':'); acc.spend(encodeOutpoint({ txid: k.slice(0, i), vout: +k.slice(i + 1) })); }
  return { blocks: blocks.length, surviving, hintsBytes, perBlock: +(hintsBytes / blocks.length).toFixed(1), reconstructed: utxo.size, verified: acc.isZero(), chainMB: +((hintsBytes / blocks.length * 141680) / 1048576).toFixed(1), ms: performance.now() - t0 };
}

// Full-chain run, in the tab: stream blocks genesis..to from the local block-server
// through the accumulator, holding only 32 bytes. The residual at `to` is the UTXO
// commitment — compare to an independently-computed value to validate the whole
// chain's set-consistency.
async function fullchain({ to = 30000, base = 'http://localhost:8090' } = {}) {
  const acc = new Accumulator({ sha256 });
  const txidOf = (tx) => codec.txid(tx);
  const CHUNK = 500;
  const t0 = performance.now(); let bytes = 0;
  for (let lo = 1; lo <= to; lo += CHUNK) {
    const count = Math.min(CHUNK, to - lo + 1);
    const text = await (await fetch(`${base}/blocks/${lo}/${count}`)).text();
    for (const hex of text.split('\n')) { if (!hex) continue; bytes += hex.length / 2; applyBlocks([codec.decode('Block', hex)], { txidOf, acc }); }
    self.postMessage({ progress: 'fullchain', height: Math.min(lo + count - 1, to), to, mb: +(bytes / 1048576).toFixed(0) });
  }
  return { to, digest: Array.from(acc.digest()).map((b) => b.toString(16).padStart(2, '0')).join(''), mb: +(bytes / 1048576).toFixed(0), ms: performance.now() - t0 };
}

// Verify an assumeUTXO snapshot statelessly: stream a Core dumptxoutset file
// (fetched from `url` — HTTP or a WebTorrent blob URL) through the 32-byte
// accumulator and compare the commitment to a chain-derived value. The whole
// 14M-coin set is processed; the set-state never exceeds 32 bytes.
async function verifySnapshot({ url, expected } = {}) {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const r = new DumpReader(buf);
  const hdr = parseHeader(r);
  const acc = new Accumulator({ sha256 });
  let n = 0; const t0 = performance.now();
  for (const c of coins(r)) {
    acc.add(encodeOutpoint({ txid: c.txid, vout: c.vout }));
    if ((++n & 1048575) === 0) self.postMessage({ progress: 'verify', n, total: hdr.coinsCount });
  }
  const digest = Array.from(acc.digest()).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { coins: n, coinsCount: hdr.coinsCount, baseHash: hdr.baseHash, netMagic: hdr.netMagic, digest, matches: expected ? digest === expected : null, mb: +(buf.length / 1048576).toFixed(0), ms: performance.now() - t0 };
}

const handlers = { init, followRange, checkpoint, resume, swiftsync, scaleAccumulate, swiftsyncHints, fullchain, verifySnapshot };
self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  try { self.postMessage({ id, ok: true, result: await handlers[cmd](args) }); }
  catch (err) { self.postMessage({ id, error: err.message }); }
};

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

async function followRange() {
  snap = new ShardedUtxo(64);
  const seed = await (await fetch('data/range-seed.ndjson')).text();
  let first = true;
  for (const l of seed.split('\n')) { if (!l) continue; if (first) { first = false; continue; } const [k, v] = JSON.parse(l); snap.set(k, v); }
  const start = snap.size;
  const range = await (await fetch('data/range.json')).json();
  const t0 = performance.now();
  const r = await followChain({ range, codec, be, snap, coinview: coinviewOf(snap),
    onBlock: (b) => self.postMessage({ progress: 'block', height: b.height, ok: b.ok, txs: b.txs, inputs: b.inputs, utxoSize: b.utxoSize, ms: b.ms }) });
  return { validated: r.validated, total: r.total, utxoStart: start, utxoEnd: snap.size, start: range.start, end: range.end, ms: performance.now() - t0 };
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
      for (let v = 0; v < tx.outputs.length; v++) { const s = tx.outputs[v].scriptPubKey; if (typeof s === 'string' && s.startsWith('6a')) continue; acc.add(encodeOutpoint({ txid, vout: v })); created++; survivors.add(`${txid}:${v}`); }
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

const handlers = { init, followRange, checkpoint, resume, swiftsync };
self.onmessage = async (e) => {
  const { id, cmd } = e.data;
  try { self.postMessage({ id, ok: true, result: await handlers[cmd]() }); }
  catch (err) { self.postMessage({ id, error: err.message }); }
};

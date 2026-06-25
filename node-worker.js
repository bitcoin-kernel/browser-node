// The node's validation core in a Web Worker: the engine, the WASM secp backend,
// the UTXO set, and OPFS persistence all run off the main thread. This is the
// scale architecture — flood-block validation and multi-GB checkpoints don't
// freeze the UI, and OPFS *sync access handles* (Worker-only) give fast I/O.
// Main thread talks to it over a tiny postMessage RPC.
import { loadEngine, coinviewOf } from './validate-forward.js';
import { ShardedUtxo } from './sharded-utxo-browser.js';
import { followChain } from './follow-chain.js';
import { setVerifyBackend } from './engine/codec/secp256k1.js';

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

const handlers = { init, followRange, checkpoint, resume };
self.onmessage = async (e) => {
  const { id, cmd } = e.data;
  try { self.postMessage({ id, ok: true, result: await handlers[cmd]() }); }
  catch (err) { self.postMessage({ id, error: err.message }); }
};

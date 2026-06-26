// SwiftSync property test: validate the set-transition of a real block range
// using only the constant-size accumulator (no UTXO set held during streaming).
// Closed sum = start snapshot + Σ(created − spent) − terminal snapshot = 0.
// Reuses committed data (range.json, range-seed.ndjson) + the engine's sha256.
import { readFileSync } from 'node:fs';
import { Codec } from './engine/codec/codec.js';
import { sha256 } from './engine/codec/hash.js';
import { Accumulator } from './swiftsync/accumulator.js';
import { encodeOutpoint } from './swiftsync/outpoint.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(readFileSync(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'));

const acc = new Accumulator({ sha256 });           // salt=null → reference prototype
const NULL = '00'.repeat(32);

// start snapshot: the prior coins these blocks spend (the assumeUTXO boundary)
let seedN = 0;
for (const l of readFileSync(new URL('data/range-seed.ndjson', D), 'utf8').split('\n').slice(1)) {
  if (!l) continue; const [k] = JSON.parse(l); const i = k.lastIndexOf(':');
  acc.add(encodeOutpoint({ txid: k.slice(0, i), vout: +k.slice(i + 1) })); seedN++;
}

// stream the blocks: add created outputs, spend spent inputs — O(1) state.
// (track survivors only to play the terminal snapshot; not streaming state.)
const range = JSON.parse(readFileSync(new URL('data/range.json', D), 'utf8'));
const survivors = new Set();
let created = 0, spent = 0;
for (const hex of range.blocks) {
  const block = codec.decode('Block', hex);
  for (const tx of block.transactions) {
    const txid = codec.txid(tx);
    for (const inp of tx.inputs) {
      if (inp.prevout.txid === NULL) continue;
      acc.spend(encodeOutpoint({ txid: inp.prevout.txid, vout: inp.prevout.vout })); spent++;
      survivors.delete(`${inp.prevout.txid}:${inp.prevout.vout}`);
    }
    for (let v = 0; v < tx.outputs.length; v++) {
      if (typeof tx.outputs[v].scriptPubKey === 'string' && tx.outputs[v].scriptPubKey.startsWith('6a')) continue; // OP_RETURN
      acc.add(encodeOutpoint({ txid, vout: v })); created++;
      survivors.add(`${txid}:${v}`);
    }
  }
}

// terminal snapshot: spend the surviving UTXOs (the known end commitment)
for (const k of survivors) { const i = k.lastIndexOf(':'); acc.spend(encodeOutpoint({ txid: k.slice(0, i), vout: +k.slice(i + 1) })); }

console.log(`range ${range.start}..${range.end}: start snapshot ${seedN} coins, ${created} created, ${spent} spent, terminal ${survivors.size} coins`);
console.log(`accumulator state: 32 bytes (two 128-bit lanes), constant throughout`);
console.log(`digest after closing: ${Buffer.from(acc.digest()).toString('hex')}`);
console.log(acc.isZero()
  ? '✅ closed sum is ZERO — every spend cancels a real created/prior output; set-transition verified with O(1) state'
  : '❌ NON-ZERO — inconsistency');
process.exit(acc.isZero() ? 0 : 1);

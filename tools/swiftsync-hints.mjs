// Full SwiftSync flow: generate a hints file for a block range, reconstruct the
// UTXO set from blocks + hints (NO input processing — fast, parallelizable), and
// verify it with the 32-byte accumulator. If the accumulator closes to zero
// against the start snapshot + reconstructed terminal set, the hints were honest
// and the reconstruction is the real UTXO set.
import { readFileSync } from 'node:fs';
import { Codec } from '../engine/codec/codec.js';
import { sha256 } from '../engine/codec/hash.js';
import { Accumulator } from '../swiftsync/accumulator.js';
import { encodeOutpoint } from '../swiftsync/outpoint.js';
import { generateHints, reconstructUtxo } from '../swiftsync/hint.js';
import { applyBlocks } from '../swiftsync/validate.js';
import { encodeHintsfile } from '../swiftsync/hintsfile.js';

const D = new URL('../', import.meta.url);
const jl = async (n) => JSON.parse(readFileSync(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'));
const txidOf = (tx) => codec.txid(tx);

const range = JSON.parse(readFileSync(new URL('data/range.json', D), 'utf8'));
const blocks = range.blocks.map((h) => codec.decode('Block', h));
const seed = readFileSync(new URL('data/range-seed.ndjson', D), 'utf8').split('\n').slice(1).filter(Boolean).map((l) => JSON.parse(l)[0]);

// 1) generate hints (which outputs survive) + encode the compact hints file
const { height, blockHints } = generateHints(blocks, { txidOf });
const hintsFile = encodeHintsfile({ height, blockHints });
const surviving = blockHints.reduce((s, a) => s + a.length, 0);
console.log(`range ${range.start}..${range.end}: ${blocks.length} blocks, ${surviving} surviving outputs`);
console.log(`hints file: ${hintsFile.length} bytes (Elias-Fano), ≈ ${(hintsFile.length / blocks.length).toFixed(1)} bytes/block`);

// 2) reconstruct the UTXO set from blocks + hints — no input/spend processing
const utxo = reconstructUtxo(blocks, blockHints, { txidOf });
console.log(`reconstructed UTXO set from hints: ${utxo.size} coins (no input processing)`);

// 3) verify with the accumulator: start snapshot + Σ(created − spent) − reconstructed = 0
const acc = new Accumulator({ sha256 });
for (const k of seed) { const i = k.lastIndexOf(':'); acc.add(encodeOutpoint({ txid: k.slice(0, i), vout: +k.slice(i + 1) })); }
applyBlocks(blocks, { txidOf, acc });
for (const k of utxo) { const i = k.lastIndexOf(':'); acc.spend(encodeOutpoint({ txid: k.slice(0, i), vout: +k.slice(i + 1) })); }
console.log(`\naccumulator digest: ${Buffer.from(acc.digest()).toString('hex').slice(0, 24)}…`);
console.log(acc.isZero()
  ? '✅ hints verified: the UTXO set reconstructed from a compact hints file (no spend processing) matches the accumulator — SwiftSync end to end'
  : '❌ hints inconsistent');
process.exit(acc.isZero() ? 0 : 1);

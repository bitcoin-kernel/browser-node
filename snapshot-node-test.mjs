// Self-contained test for the Core dumptxoutset parser + forward validation.
// Parses the committed 1 MB prefix of the real snapshot, then validates block
// #120001 against the coin view extracted from it. Uses only committed data.
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { BlockEngine } from './engine/codec/blocks.js';
import { ShardedUtxo } from './sharded-utxo-browser.js';
import { coinviewOf } from './validate-forward.js';
import { DumpReader, parseHeader, coins } from './dumptxoutset.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'));
const be = BlockEngine.fromSchemas(codec, await jl('chain'), await jl('validate'), await jl('script'), 'btc:testnet4');

// 1) parse the Core snapshot prefix
const bytes = new Uint8Array(await readFile(new URL('data/utxo-prefix.dat', D)));
const r = new DumpReader(bytes);
const hdr = parseHeader(r);
let n = 0; for (const _ of coins(r)) n++;
console.log(`dumptxoutset header: v${hdr.version} ${hdr.netMagic} base=${hdr.baseHash.slice(0, 16)}… coins_count=${hdr.coinsCount.toLocaleString()}`);
console.log(`parsed ${n.toLocaleString()} coins from the prefix`);
if (hdr.version !== 2 || hdr.netMagic !== '1c163f28' || hdr.coinsCount !== 13870119) throw new Error('header mismatch');

// 2) forward-validate #120001 against the parsed-snapshot coin view
const snap = new ShardedUtxo(64);
const text = await readFile(new URL('data/snapshot-120001.ndjson', D), 'utf8');
let first = true; for (const l of text.split('\n')) { if (!l) continue; if (first) { first = false; continue; } const [k, v] = JSON.parse(l); snap.set(k, v); }
const block = codec.decode('Block', (await readFile(new URL('data/block-120001.hex', D), 'utf8')).trim());
const struct = be.validateBlockStructure(block).results;
const ctx = be.validateBlockContext(block, { height: 120001, utxo: coinviewOf(snap) }).results;
const failed = [...struct, ...ctx].filter((x) => x.ok === false).length;
console.log(`block #120001: ${block.transactions.length} txs, ${struct.length + ctx.length} rules, ${failed} failed`);
if (failed) { console.error('❌ validation failed'); process.exit(1); }
console.log('✅ Core dumptxoutset parsed + block #120001 validated forward against it');

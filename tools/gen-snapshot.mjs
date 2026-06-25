import { createWriteStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
// Generate a testnet4-scale UTXO snapshot in ShardedUtxo NDJSON format.
// Format: line 1 = meta JSON; each line = JSON.stringify([key,value]),
// value = `${sats}\t${spk}\t${height}\t${coinbase}`  (matches _usechainstate.mjs)
const N = Number(process.argv[2] || 14_100_000);
const OUT = process.argv[3];
const HEX = '0123456789abcdef';
// fast pseudo-random hex pool (no crypto); rotate offsets for the txid suffix
let pool = ''; for (let i = 0; i < 4096; i++) pool += HEX[(i * 2654435761 >>> 0) & 15];
const suffix = (i) => { let s = '', o = (i * 40503) & 4031; for (let j = 0; j < 48; j++) s += pool[o + j]; return s; };
const spkFor = (i) => {
  const r = i % 100, h = suffix(i).slice(0, 40), h2 = suffix(i) + suffix(i >> 1) + '0000';
  if (r < 50) return '0014' + h;                       // P2WPKH
  if (r < 85) return '5120' + h2.slice(0, 64);          // P2TR
  return '76a914' + h + '88ac';                         // P2PKH
};
const ws = createWriteStream(OUT);
const put = (s) => (ws.write(s) ? Promise.resolve() : new Promise((r) => ws.once('drain', r)));
const t0 = performance.now();
await put(JSON.stringify({ height: 120000, network: 'testnet4', coins: N }) + '\n');
let buf = '';
for (let i = 0; i < N; i++) {
  const txid = i.toString(16).padStart(16, '0') + suffix(i);
  const key = txid + ':' + (i & 3);
  const sats = 546 + (i % 4_000_000);
  const cb = (i % 200 === 0) ? 1 : 0;
  const height = 1 + (i % 120000);
  buf += JSON.stringify([key, `${sats}\t${spkFor(i)}\t${height}\t${cb}`]) + '\n';
  if ((i & 16383) === 16383) { await put(buf); buf = ''; }
}
if (buf) await put(buf);
await new Promise((r) => ws.end(r));
console.log(`generated ${N.toLocaleString()} coins in ${((performance.now()-t0)/1000).toFixed(1)}s`);

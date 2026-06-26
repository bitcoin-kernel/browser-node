// Full-chain SwiftSync reference (Node): stream blocks genesis..H from bitcoind
// over RPC, run the accumulator (add created outputs, subtract spent inputs), and
// confirm the residual digest equals the UTXO commitment at H. For H = the
// snapshot height it must equal that snapshot's SwiftSync commitment — validating
// the WHOLE chain's set-consistency with 32 bytes of state. Measures the rate so
// the in-browser run (fullchain.html) can be scoped.
//
//   node tools/fullchain-node.mjs <H> [expectedCommitmentHex]
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Codec } from '../engine/codec/codec.js';
import { sha256 } from '../engine/codec/hash.js';
import { Accumulator } from '../swiftsync/accumulator.js';
import { applyBlocks } from '../swiftsync/validate.js';

const H = Number(process.argv[2] || 30000);
const EXPECT = process.argv[3] || null;
const cookie = readFileSync(process.env.HOME + '/.bitcoin/testnet4/.cookie', 'utf8').trim();
const auth = 'Basic ' + Buffer.from(cookie).toString('base64');
const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });

function rpcBatch(calls) {
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: '1.0', id: i, method: c.method, params: c.params })));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 48332, method: 'POST', agent, headers: { 'Content-Type': 'text/plain', 'Authorization': auth, 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

const D = new URL('../', import.meta.url);
const jl = async (n) => JSON.parse(readFileSync(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'));
const txidOf = (tx) => codec.txid(tx);
const acc = new Accumulator({ sha256 });

const BATCH = 200;
const t0 = Date.now(); let done = 0, bytes = 0;
for (let lo = 1; lo <= H; lo += BATCH) {
  const hi = Math.min(lo + BATCH - 1, H);
  const heights = []; for (let h = lo; h <= hi; h++) heights.push(h);
  const hashes = (await rpcBatch(heights.map((h) => ({ method: 'getblockhash', params: [h] })))).map((r) => r.result);
  const raws = (await rpcBatch(hashes.map((h) => ({ method: 'getblock', params: [h, 0] })))).map((r) => r.result);
  for (const hex of raws) { bytes += hex.length / 2; applyBlocks([codec.decode('Block', hex)], { txidOf, acc }); }
  done = hi;
  if (done % 2000 === 0 || done === H) {
    const s = (Date.now() - t0) / 1000;
    process.stdout.write(`\r  height ${done}/${H}  ${(done / s).toFixed(0)} blk/s  ${(bytes / 1048576).toFixed(0)} MB  ${s.toFixed(0)}s   `);
  }
}
const digest = Buffer.from(acc.digest()).toString('hex');
console.log(`\n\nheight ${H}: accumulator residual = UTXO commitment`);
console.log(`digest: ${digest}`);
console.log(`data streamed: ${(bytes / 1048576).toFixed(0)} MB · ${((Date.now() - t0) / 1000).toFixed(0)}s · accumulator state: 32 bytes`);
if (EXPECT) console.log(digest === EXPECT ? `✅ matches the snapshot commitment — whole chain genesis→${H} validated with 32 bytes` : `❌ mismatch (expected ${EXPECT})`);

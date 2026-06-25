// Reach the live tip: bootstrap from a real Bitcoin Core assumeUTXO snapshot
// (dumptxoutset) and validate forward, block by block, to the current testnet4
// tip. Memory-safe — it stream-parses the snapshot and keeps only the coins the
// forward blocks spend (the full 14.1M-coin set is ~25 GB in RAM in this string
// representation; holding all of it is the scale work, see README "remaining").
//
//   # dump the full UTXO set ~100 blocks behind the tip (NOT committed; for the
//   # browser, seed this over WebTorrent — it is large):
//   TIP=$(bitcoin-cli -testnet4 getblockcount)
//   bitcoin-cli -rpcclienttimeout=0 -named -testnet4 dumptxoutset path=utxo.dat rollback=$((TIP-100))
//   # then validate forward from it to the live tip:
//   node tools/reach-tip.mjs utxo.dat        # BITCOIN_CLI / NETWORK env optional
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Codec } from '../engine/codec/codec.js';
import { BlockEngine } from '../engine/codec/blocks.js';
import { ShardedUtxo } from '../sharded-utxo-browser.js';
import { coinviewOf } from '../validate-forward.js';
import { followChain } from '../follow-chain.js';
import { DumpReader, parseHeader, coins } from '../dumptxoutset.js';

const SNAP = process.argv[2];
if (!SNAP) { console.error('usage: node tools/reach-tip.mjs <snapshot.dat>'); process.exit(1); }
const NET = process.env.NETWORK || 'testnet4';
const CLI = `${process.env.BITCOIN_CLI || 'bitcoin-cli'} -${NET}`;
const cli = (a) => execSync(`${CLI} ${a}`, { maxBuffer: 256 << 20 }).toString();
const D = path.dirname(fileURLToPath(import.meta.url));
const jl = async (n) => JSON.parse(readFileSync(path.join(D, `../engine/schema/${n}.jsonld`), 'utf8'));

const codec = new Codec(await jl('core'), await jl('proof'));
const be = BlockEngine.fromSchemas(codec, await jl('chain'), await jl('validate'), await jl('script'), `btc:${NET}`);

const r0 = new DumpReader(readFileSync(SNAP));
const base = parseHeader(r0);                 // base.baseHash / coinsCount
const baseHeight = Number(cli(`getblock ${base.baseHash} 1`).match(/"height":\s*(\d+)/)?.[1] ?? '0');
const START = baseHeight + 1;
const TIP = Number(cli('getblockcount').trim());
console.log(`snapshot base #${baseHeight} (${base.coinsCount.toLocaleString()} coins); validating ${START}..${TIP}`);

const blocks = [], need = new Set();
for (let h = START; h <= TIP; h++) {
  const hash = cli(`getblockhash ${h}`).trim();
  blocks.push(cli(`getblock ${hash} 0`).trim());
  const b = JSON.parse(cli(`getblock ${hash} 2`));
  for (const tx of b.tx) for (const vin of tx.vin) if (!vin.coinbase) need.add(`${vin.txid}:${vin.vout}`);
}
console.log(`forward blocks spend ${need.size} prevouts; extracting from the snapshot…`);
const snap = new ShardedUtxo(64);
for (const c of coins(r0)) { const k = `${c.txid}:${c.vout}`; if (need.has(k)) { snap.set(k, `${c.value}\t${c.scriptPubKey}\t${c.height}\t${c.coinbase ? 1 : 0}`); if (snap.size === need.size) break; } }
console.log(`resolved ${snap.size}/${need.size} from the snapshot (rest created intra-range)`);

const t = Date.now(); let realIns = 0, nonEmpty = 0;
const res = await followChain({ range: { start: START, blocks }, codec, be, snap, coinview: coinviewOf(snap),
  onBlock: (b) => { realIns += b.inputs; if (b.inputs > 0) nonEmpty++; } });
console.log(`\n${res.validated === res.total ? '✅' : '❌'} validated ${res.validated}/${res.total} blocks forward to the live tip #${TIP} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
console.log(`   ${nonEmpty} non-empty blocks, ${realIns} real inputs verified against the snapshot`);
process.exit(res.validated === res.total ? 0 : 1);

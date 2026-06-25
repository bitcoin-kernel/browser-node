import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { BlockEngine } from './engine/codec/blocks.js';
import { ShardedUtxo } from './sharded-utxo-browser.js';
import { coinviewOf } from './validate-forward.js';
import { followChain } from './follow-chain.js';
const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D),'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'));
const be = BlockEngine.fromSchemas(codec, await jl('chain'), await jl('validate'), await jl('script'), 'btc:testnet4');

const snap = new ShardedUtxo(64);
const seed = await readFile(new URL('data/range-seed.ndjson', D),'utf8');
let first=true; for (const l of seed.split('\n')){ if(!l)continue; if(first){first=false;continue;} const [k,v]=JSON.parse(l); snap.set(k,v); }
const startSize = snap.size;
const range = JSON.parse(await readFile(new URL('data/range.json', D),'utf8'));
console.log(`seed UTXO set: ${startSize} coins | following blocks ${range.start}..${range.end}\n`);

const r = await followChain({ range, codec, be, snap, coinview: coinviewOf(snap),
  onBlock: (b) => console.log(
    `  #${b.height}  ${String(b.txs).padStart(3)}tx  in=${String(b.inputs).padStart(4)} (set:${b.fromSet} intra:${b.intraBlock})  ` +
    `link=${b.linked===null?'—':b.linked?'✓':'✗'}  ${b.ok?'✓':'✗ '+b.failed.join(',')}  ` +
    `applied -${b.applied.spent}/+${b.applied.created}  utxo=${b.utxoSize}  ${b.ms.toFixed(0)}ms`) });

console.log(`\n${r.validated===r.total?'✅':'❌'} followed ${r.validated}/${r.total} blocks; UTXO set ${startSize} -> ${snap.size} coins`);

import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { BlockEngine } from './engine/codec/blocks.js';
import { ShardedUtxo } from './sharded-utxo-browser.js';
const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'));
const be = BlockEngine.fromSchemas(codec, await jl('chain'), await jl('validate'), await jl('script'), 'btc:testnet4');

// load coin view (same adapter the browser uses)
const snap = new ShardedUtxo(64);
const text = await readFile(new URL('data/snapshot-26000.ndjson', D), 'utf8');
let first = true, meta;
for (const line of text.split('\n')) { if (!line) continue; if (first){meta=JSON.parse(line);first=false;continue;} const [k,v]=JSON.parse(line); snap.set(k,v); }
const coinview = { get(key){ const v=snap.get(key); if(v===undefined) return undefined; const a=v.split('\t'); return { output:{value:Number(a[0]),scriptPubKey:a[1]}, height:Number(a[2]), coinbase:a[3]==='1' }; } };
console.log(`coin view: ${snap.size} coins at height ${meta.height}`);

const hex = (await readFile(new URL('data/block-26000.hex', D), 'utf8')).trim();
const block = codec.decode('Block', hex);
console.log(`block 26000: ${block.transactions.length} txs`);
const mark = (r)=> r.ok===true?'✓':r.ok===false?'✗ FAIL':'– skip';
console.log('\nstructure:');
for (const r of be.validateBlockStructure(block).results) console.log(`  ${mark(r)}  ${r.rule}`);
console.log('context (against coin view):');
const t0=performance.now();
const ctx = be.validateBlockContext(block, { height: 26000, utxo: coinview });
for (const r of ctx.results) console.log(`  ${mark(r)}  ${r.rule}`);
const failed = ctx.results.filter(r=>r.ok===false).length;
console.log(`\n${failed===0?'✅ block 26000 fully validated forward against the coin view':'❌ '+failed+' failed'}  (${(performance.now()-t0).toFixed(0)}ms, pure-JS secp)`);

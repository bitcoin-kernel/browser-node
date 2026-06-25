import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { BlockEngine } from './engine/codec/blocks.js';
const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D),'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'));
const be = BlockEngine.fromSchemas(codec, await jl('chain'), await jl('validate'), await jl('script'), 'btc:testnet4');
const text = await readFile(new URL('data/snapshot-26000.ndjson', D),'utf8');
const rows = text.split('\n').filter(Boolean).slice(1).map(l=>JSON.parse(l));
const map = new Map(rows);
const mk = (m) => ({ get(key){ const v=m.get(key); if(v===undefined) return undefined; const a=v.split('\t'); return {output:{value:Number(a[0]),scriptPubKey:a[1]},height:Number(a[2]),coinbase:a[3]==='1'}; } });
const hex = (await readFile(new URL('data/block-26000.hex', D),'utf8')).trim();
const block = codec.decode('Block', hex);
const run = (cv) => be.validateBlockContext(block, { height:26000, utxo:cv }).results;
const fails = (res) => res.filter(r=>r.ok===false).map(r=>r.rule);

console.log('A) honest coin view:');
console.log('   failures:', fails(run(mk(map))).join(', ') || 'none — block ACCEPTED ✅');

// tamper: bump one coin's value by 1 sat (BIP143 sighash commits to the amount)
const tampered = new Map(map);
const [k0, v0] = rows[0]; const a = v0.split('\t'); const bad = [String(Number(a[0])+1), ...a.slice(1)].join('\t');
tampered.set(k0, bad);
console.log(`\nB) tamper one coin value (${k0.slice(0,16)}…  ${a[0]} -> ${Number(a[0])+1} sats):`);
const f = fails(run(mk(tampered)));
console.log('   failures:', f.join(', ') || 'NONE (bad — validator missed it!)');
console.log(f.length ? '   ✅ tamper REJECTED — signature/consensus check has teeth' : '   ❌ validator rubber-stamped a bad view');

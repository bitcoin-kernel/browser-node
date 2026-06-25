import { readFile } from 'node:fs/promises';
import { connect, syncToTip } from './live-feed.js';
const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D),'utf8'));
const schemas = { core: await jl('core'), proof: await jl('proof'), p2p: await jl('p2p'), chain: await jl('chain'), validate: await jl('validate') };
const vectors = JSON.parse(await readFile(new URL('data/testnet4.json', D),'utf8'));
const log = (m,c='')=>console.log('  '+(c?`[${c}] `:'')+m);

const t0 = Date.now();
const session = await connect({ bridgeUrl: 'ws://localhost:8334', schemas, vectors, log });
let last = 0;
const res = await syncToTip(session, { onBatch: ({ tip, reorg }) => {
  if (reorg) console.log(`  reorg: rolled back ${reorg.depth} at height ${reorg.atHeight}`);
  if (tip.height >= last + 20000) { last = tip.height; console.log(`  validated to height ${tip.height.toLocaleString()}…`); }
}});
const ms = Date.now()-t0;
const tip = session.store.tip();
session.peer.close();
console.log(`\n✅ synced + validated ${tip.height.toLocaleString()} headers from genesis over the bridge in ${(ms/1000).toFixed(1)}s`);
console.log(`   tip ${tip.hash}`);
console.log(`   reorgs handled: ${res.reorgs.length}`);

// Prove SPV merkle-proof verification: take a real block, build a BIP37 partial
// merkle tree (CPartialMerkleTree) proving ONE transaction's inclusion, and have
// the engine's SpvEngine verify it (PoW + well-formed tree + root == header's
// merkleRoot + the txid is matched). This is the verification spv.html stage 2 does.
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { SpvEngine } from './engine/codec/spv.js';
import { dsha256, hexToBytes, bytesToHex } from './engine/codec/hash.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const spv = SpvEngine.fromSchemas(codec, await jl('validate'));

// Build a BIP37 partial merkle tree proving txids[matchIdx] (CPartialMerkleTree).
function buildProof(txids, matchIdx) {
  const n = txids.length;
  const leaves = txids.map((t) => hexToBytes(t).reverse());       // display → internal byte order
  const width = (h) => (n + (1 << h) - 1) >>> h;
  let height = 0; while (width(height) > 1) height++;
  const calc = (h, pos) => {
    if (h === 0) return leaves[pos];
    const left = calc(h - 1, pos * 2);
    const right = (pos * 2 + 1 < width(h - 1)) ? calc(h - 1, pos * 2 + 1) : left;   // dup last if odd
    return dsha256(new Uint8Array([...left, ...right]));
  };
  const underMatch = (h, pos) => matchIdx >= (pos << h) && matchIdx < ((pos + 1) << h);
  const vBits = [], vHash = [];
  const traverse = (h, pos) => {
    const f = underMatch(h, pos);
    vBits.push(f ? 1 : 0);
    if (h === 0 || !f) { vHash.push(bytesToHex(calc(h, pos).slice().reverse())); }   // emit hash (display order)
    else { traverse(h - 1, pos * 2); if (pos * 2 + 1 < width(h - 1)) traverse(h - 1, pos * 2 + 1); }
  };
  traverse(height, 0);
  const flags = new Uint8Array(Math.ceil(vBits.length / 8));
  vBits.forEach((b, i) => { if (b) flags[i >> 3] |= 1 << (i & 7); });
  return { txCount: n, hashes: vHash, flags: bytesToHex(flags) };
}

const blockHex = (await readFile(new URL('data/block-26000.hex', D), 'utf8')).trim();
const block = codec.decode('Block', blockHex);
const txids = block.transactions.map((tx) => codec.txid(tx));
console.log(`block #26000: ${txids.length} txs, merkleRoot ${block.header.merkleRoot.slice(0, 16)}…`);

const target = 7;                                  // prove tx at index 7
const proof = buildProof(txids, target);
const merkleBlock = { header: block.header, ...proof };
const r = spv.verify(merkleBlock, { txid: txids[target] });

console.log(`proof: ${proof.hashes.length} hashes + ${proof.flags.length / 2}-byte flags ≈ ${proof.hashes.length * 32 + proof.flags.length / 2} bytes (vs full block ${blockHex.length / 2} bytes)`);
for (const c of r.results) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}`);
const matched = r.matches.some((m) => m.txid === txids[target]);
if (r.ok && matched && r.root === block.header.merkleRoot) console.log(`\n✅ SPV verified: tx ${txids[target].slice(0, 16)}… is provably in block #26000 (root matches, PoW valid)`);
else { console.log('\n❌ verification failed'); process.exit(1); }

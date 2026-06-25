// Self-contained test of the WASM secp backend. Instantiates the committed
// secp256k1.wasm (via fs, same marshalling glue as wasm-secp.js) and checks that
// validating block #26000 with the WASM backend gives the SAME verdict as the
// engine's default pure-JS secp — i.e. you don't swap consensus crypto on faith.
import { readFileSync } from 'node:fs';
import { Codec } from './engine/codec/codec.js';
import { BlockEngine } from './engine/codec/blocks.js';
import { setVerifyBackend } from './engine/codec/secp256k1.js';
import { ShardedUtxo } from './sharded-utxo-browser.js';
import { coinviewOf } from './validate-forward.js';

const generateInt32 = () => { const a = new Uint8Array(4); crypto.getRandomValues(a); return (a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]; };
const throwError = (c) => { throw new Error('secp wasm ' + c); };
const buf = readFileSync(new URL('./secp256k1.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(buf, { './rand.js': { generateInt32 }, './validate_error.js': { throwError } });
const w = instance.exports; w.initializeContext();
const HASH = w.HASH_INPUT.value, PUB = w.PUBLIC_KEY_INPUT.value, XPUB = w.X_ONLY_PUBLIC_KEY_INPUT.value, SIG = w.SIGNATURE_INPUT.value;
const mem = () => new Uint8Array(w.memory.buffer);
const b32 = (n) => { const b = new Uint8Array(32); let x = n; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const wasmBackend = {
  ecdsa(h, sig, pubkey) {
    const pub = new Uint8Array(65); pub[0] = 4; pub.set(b32(pubkey[0]), 1); pub.set(b32(pubkey[1]), 33);
    const s = new Uint8Array(64); s.set(b32(sig.r), 0); s.set(b32(sig.s), 32);
    const m = mem(); m.set(h, HASH); m.set(pub, PUB); m.set(s, SIG);
    const ok = w.verify(65, 0) === 1; m.fill(0, HASH, HASH + 32); m.fill(0, PUB, PUB + 65); m.fill(0, SIG, SIG + 64); return ok;
  },
  schnorr(msg32, sig64, pubkey32) {
    const m = mem(); m.set(msg32, HASH); m.set(pubkey32, XPUB); m.set(sig64, SIG);
    const ok = w.verifySchnorr() === 1; m.fill(0, HASH, HASH + 32); m.fill(0, XPUB, XPUB + 32); m.fill(0, SIG, SIG + 64); return ok;
  },
};

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(readFileSync(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'));
const be = BlockEngine.fromSchemas(codec, await jl('chain'), await jl('validate'), await jl('script'), 'btc:testnet4');
const snap = new ShardedUtxo(64);
for (const l of readFileSync(new URL('data/snapshot-26000.ndjson', D), 'utf8').split('\n').slice(1)) { if (!l) continue; const [k, v] = JSON.parse(l); snap.set(k, v); }
const block = codec.decode('Block', readFileSync(new URL('data/block-26000.hex', D), 'utf8').trim());
const run = () => be.validateBlockContext(block, { height: 26000, utxo: coinviewOf(snap) }).results;

setVerifyBackend(null);
const js = run().map((r) => r.ok);
setVerifyBackend(wasmBackend);
const wa = run().map((r) => r.ok);
setVerifyBackend(null);

const equal = JSON.stringify(js) === JSON.stringify(wa);
const allPass = wa.every((ok) => ok !== false);
console.log(`pure-JS verdicts: ${js.filter((x) => x === true).length} pass`);
console.log(`WASM verdicts:    ${wa.filter((x) => x === true).length} pass`);
console.log(equal && allPass ? '✅ WASM secp agrees with pure-JS on block #26000 (28 ECDSA sigs)' : '❌ MISMATCH');
process.exit(equal && allPass ? 0 : 1);

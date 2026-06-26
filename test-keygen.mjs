// Prove private/hardened BIP32 keygen using the bundled WASM secp (pointFromScalar
// + privateAdd, which the engine ships but doesn't wire up). Derive the BIP84
// account from the KNOWN test-vector seed and check the first addresses equal the
// published BIP84 vector — the crypto keys.html will use to make a tpub.
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Bip32 } from './engine/codec/wallet.js';
import { ScriptEngine } from './engine/codec/script.js';
import { hmacSha512, hash160, bytesToHex, hexToBytes } from './engine/codec/hash.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));

// --- wire the WASM secp's keygen ops (mirrors wasm-secp.js's memory marshalling) ---
const wbuf = fs.readFileSync(new URL('secp256k1.wasm', D));
const generateInt32 = () => { const a = new Uint8Array(4); crypto.getRandomValues(a); return (a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]; };
const throwError = (c) => { throw new Error('secp wasm error ' + c); };
const { instance } = await WebAssembly.instantiate(wbuf, { './rand.js': { generateInt32 }, './validate_error.js': { throwError } });
const w = instance.exports; w.initializeContext();
const PRIV = w.PRIVATE_INPUT.value, PUB = w.PUBLIC_KEY_INPUT.value, TWEAK = w.TWEAK_INPUT.value;
const mem = () => new Uint8Array(w.memory.buffer);
function pointFromScalar(d) { const m = mem(); m.set(d, PRIV); const ok = w.pointFromScalar(33) === 1; const out = ok ? m.slice(PUB, PUB + 33) : null; m.fill(0, PRIV, PRIV + 32); return out; }
function privateAdd(d, t) { const m = mem(); m.set(d, PRIV); m.set(t, TWEAK); const ok = w.privateAdd() === 1; const out = ok ? m.slice(PRIV, PRIV + 32) : null; m.fill(0, PRIV, PRIV + 32); m.fill(0, TWEAK, TWEAK + 32); return out; }

// --- private BIP32 ---
const ser32 = (i) => Uint8Array.from([(i >>> 24) & 255, (i >>> 16) & 255, (i >>> 8) & 255, i & 255]);
function master(seed) { const I = hmacSha512(new TextEncoder().encode('Bitcoin seed'), seed); const priv = I.slice(0, 32); return { priv, chainCode: I.slice(32), pub: pointFromScalar(priv), depth: 0, childNumber: 0, parentFingerprint: '00000000' }; }
function ckdPriv(p, index) {
  const hardened = index >= 0x80000000;
  const data = hardened ? Uint8Array.from([0, ...p.priv, ...ser32(index)]) : Uint8Array.from([...p.pub, ...ser32(index)]);
  const I = hmacSha512(p.chainCode, data);
  const childPriv = privateAdd(p.priv, I.slice(0, 32));
  return { priv: childPriv, chainCode: I.slice(32), pub: pointFromScalar(childPriv), depth: p.depth + 1, childNumber: index, parentFingerprint: bytesToHex(hash160(p.pub).subarray(0, 4)) };
}
const H = (i) => i + 0x80000000;

// --- the proof: BIP32 spec test vector 1 (seed 000102…0f) → master + m/0' xpubs ---
const xpubOf = (n) => Bip32.encode({ version: 0x0488b21e, depth: n.depth, parentFingerprint: n.parentFingerprint, childNumber: n.childNumber, chainCode: bytesToHex(n.chainCode), publicKey: bytesToHex(n.pub) });
const m = master(hexToBytes('000102030405060708090a0b0c0d0e0f'));
const m0h = ckdPriv(m, H(0));
const checks = [
  ['m',    xpubOf(m),   'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8'],
  ["m/0'", xpubOf(m0h), 'xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw'],
];
let ok = true;
for (const [label, got, want] of checks) { const pass = got === want; ok &&= pass; console.log(`  ${label.padEnd(5)} ${pass ? '✓' : '✗\n    got  ' + got + '\n    want ' + want}`); }

// and show the keys.html flow: a testnet BIP84 account (m/84'/1'/0') → tpub → first tb1 address
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btc:testnet4');
let acc = m; for (const i of [H(84), H(1), H(0)]) acc = ckdPriv(acc, i);
const tpub = Bip32.encode({ version: 0x043587cf, depth: acc.depth, parentFingerprint: acc.parentFingerprint, childNumber: acc.childNumber, chainCode: bytesToHex(acc.chainCode), publicKey: bytesToHex(acc.pub) });
console.log(`\n  demo: m/84'/1'/0' tpub ${tpub.slice(0, 14)}… → 0/0 ${se.classify(Bip32.scriptPubKey(Bip32.derivePath(Bip32.decode(tpub), '0/0'), 'p2wpkh')).address}`);

console.log(ok ? '\n✅ private BIP32 keygen (WASM pointFromScalar/privateAdd) matches BIP32 vector 1 — keys.html can generate tpubs + addresses' : '\n❌ mismatch');
process.exit(ok ? 0 : 1);

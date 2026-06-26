// Prove BIP39 import compat: a mnemonic → seed (PBKDF2-HMAC-SHA512) → BIP84
// account → addresses, matching the published BIP84 vector. No wordlist needed
// (PBKDF2 hashes the mnemonic string). This is what keys.html's "import" does.
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Bip32 } from './engine/codec/wallet.js';
import { ScriptEngine } from './engine/codec/script.js';
import { hmacSha512, hash160, bytesToHex, sha256 } from './engine/codec/hash.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));

// WASM secp keygen (same wiring as wasm-keygen.js / test-keygen.mjs)
const { instance } = await WebAssembly.instantiate(fs.readFileSync(new URL('secp256k1.wasm', D)), { './rand.js': { generateInt32: () => 1 }, './validate_error.js': { throwError: (c) => { throw new Error('e' + c); } } });
const w = instance.exports; w.initializeContext();
const PRIV = w.PRIVATE_INPUT.value, PUB = w.PUBLIC_KEY_INPUT.value, TWEAK = w.TWEAK_INPUT.value;
const mem = () => new Uint8Array(w.memory.buffer);
const pfs = (d) => { const m = mem(); m.set(d, PRIV); const ok = w.pointFromScalar(33) === 1; const o = ok ? m.slice(PUB, PUB + 33) : null; m.fill(0, PRIV, PRIV + 32); return o; };
const padd = (d, t) => { const m = mem(); m.set(d, PRIV); m.set(t, TWEAK); const ok = w.privateAdd() === 1; const o = ok ? m.slice(PRIV, PRIV + 32) : null; m.fill(0, PRIV, PRIV + 32); m.fill(0, TWEAK, TWEAK + 32); return o; };
const ser32 = (i) => Uint8Array.from([(i >>> 24) & 255, (i >>> 16) & 255, (i >>> 8) & 255, i & 255]);
const H = (i) => i + 0x80000000;
const master = (seed) => { const I = hmacSha512(new TextEncoder().encode('Bitcoin seed'), seed); const priv = I.slice(0, 32); return { priv, chainCode: I.slice(32), pub: pfs(priv), depth: 0, childNumber: 0, parentFingerprint: '00000000' }; };
const ckd = (p, index) => { const hard = index >= 0x80000000; const data = hard ? Uint8Array.from([0, ...p.priv, ...ser32(index)]) : Uint8Array.from([...p.pub, ...ser32(index)]); const I = hmacSha512(p.chainCode, data); const cp = padd(p.priv, I.slice(0, 32)); return { priv: cp, chainCode: I.slice(32), pub: pfs(cp), depth: p.depth + 1, childNumber: index, parentFingerprint: bytesToHex(hash160(p.pub).subarray(0, 4)) }; };

// BIP39: mnemonic -> 64-byte seed
async function mnemonicToSeed(mnemonic, passphrase = '') {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(mnemonic.normalize('NFKD')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode('mnemonic' + passphrase.normalize('NFKD')), iterations: 2048, hash: 'SHA-512' }, key, 512);
  return new Uint8Array(bits);
}

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = await mnemonicToSeed(MNEMONIC, '');             // BIP84 vector uses empty passphrase
let acc = master(seed); for (const i of [H(84), H(0), H(0)]) acc = ckd(acc, i);   // m/84'/0'/0'
const xpub = Bip32.encode({ version: 0x0488b21e, depth: acc.depth, parentFingerprint: acc.parentFingerprint, childNumber: acc.childNumber, chainCode: bytesToHex(acc.chainCode), publicKey: bytesToHex(acc.pub) });

const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btc:mainnet');
const node = Bip32.decode(xpub);
const EXPECT = { '0/0': 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', '0/1': 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g' };
let ok = xpub.startsWith('xpub6CatWdiZiodmU');
console.log('mnemonic → account xpub:', xpub.slice(0, 18) + '…', ok ? '✓' : '✗');
for (const [path, want] of Object.entries(EXPECT)) { const got = se.classify(Bip32.scriptPubKey(Bip32.derivePath(node, path), 'p2wpkh')).address; const pass = got === want; ok &&= pass; console.log(`  ${path}  ${got}  ${pass ? '✓' : '✗ ' + want}`); }
// entropy → mnemonic (the generate path), against BIP39 vectors
const WORDS = (await readFile(new URL('data/bip39-english.txt', D), 'utf8')).trim().split('\n');
const e2m = (ent) => { const CS = (ent.length * 8) / 32, cs = sha256(ent), bits = []; for (const b of ent) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); for (let i = 0; i < CS; i++) bits.push((cs[i >> 3] >> (7 - (i & 7))) & 1); const out = []; for (let i = 0; i < bits.length; i += 11) { let idx = 0; for (let j = 0; j < 11; j++) idx = (idx << 1) | bits[i + j]; out.push(WORDS[idx]); } return out.join(' '); };
const hx = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
for (const [e, want] of [['00000000000000000000000000000000', MNEMONIC], ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank yellow']]) { const got = e2m(hx(e)); const pass = got === want; ok &&= pass; console.log(`  entropy ${e.slice(0, 8)}… → mnemonic ${pass ? '✓' : '✗ ' + got}`); }

console.log(ok ? '\n✅ BIP39 verified: import (mnemonic→seed→addresses) + generate (entropy→mnemonic) match the vectors' : '\n❌ mismatch');
process.exit(ok ? 0 : 1);

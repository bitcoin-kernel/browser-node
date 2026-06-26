// Keygen for keys.html: PRIVATE/hardened BIP32 derivation, using the bundled WASM
// secp's pointFromScalar + privateAdd (which the engine ships but only wires for
// verify). Isolated here so the verification paths (wasm-secp.js, the worker) are
// untouched. THIS MODULE TOUCHES PRIVATE KEYS — testnet4 demo wallets only.
// Verified against BIP32 spec vector 1 in test-keygen.mjs.
import { hmacSha512, hash160, bytesToHex, sha256 } from './engine/codec/hash.js';

const wasmUrl = new URL('./secp256k1.wasm', import.meta.url);
const generateInt32 = () => { const a = new Uint8Array(4); crypto.getRandomValues(a); return (a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]; };
const throwError = (code) => { throw new Error('secp256k1 wasm error ' + code); };
const { instance } = await WebAssembly.instantiate(await (await fetch(wasmUrl)).arrayBuffer(), { './rand.js': { generateInt32 }, './validate_error.js': { throwError } });
const w = instance.exports; w.initializeContext();
const PRIV = w.PRIVATE_INPUT.value, PUB = w.PUBLIC_KEY_INPUT.value, TWEAK = w.TWEAK_INPUT.value;
const mem = () => new Uint8Array(w.memory.buffer);

export function pointFromScalar(d) { const m = mem(); m.set(d, PRIV); const ok = w.pointFromScalar(33) === 1; const out = ok ? m.slice(PUB, PUB + 33) : null; m.fill(0, PRIV, PRIV + 32); return out; }
export function privateAdd(d, t) { const m = mem(); m.set(d, PRIV); m.set(t, TWEAK); const ok = w.privateAdd() === 1; const out = ok ? m.slice(PRIV, PRIV + 32) : null; m.fill(0, PRIV, PRIV + 32); m.fill(0, TWEAK, TWEAK + 32); return out; }

const ser32 = (i) => Uint8Array.from([(i >>> 24) & 255, (i >>> 16) & 255, (i >>> 8) & 255, i & 255]);
const H = (i) => i + 0x80000000;

function master(seed) { const I = hmacSha512(new TextEncoder().encode('Bitcoin seed'), seed); const priv = I.slice(0, 32); return { priv, chainCode: I.slice(32), pub: pointFromScalar(priv), depth: 0, childNumber: 0, parentFingerprint: '00000000' }; }
function ckdPriv(p, index) {
  const hardened = index >= 0x80000000;
  const data = hardened ? Uint8Array.from([0, ...p.priv, ...ser32(index)]) : Uint8Array.from([...p.pub, ...ser32(index)]);
  const I = hmacSha512(p.chainCode, data);
  const childPriv = privateAdd(p.priv, I.slice(0, 32));
  return { priv: childPriv, chainCode: I.slice(32), pub: pointFromScalar(childPriv), depth: p.depth + 1, childNumber: index, parentFingerprint: bytesToHex(hash160(p.pub).subarray(0, 4)) };
}

// Derive a BIP84 account node m/84'/coin'/0' from a seed, as a watch-only node
// (no private key) ready for Bip32.encode() → tpub/xpub. coin 1 = testnet.
export function deriveAccountNode(seed, { coin = 1, version = 0x043587cf } = {}) {
  let n = master(seed);
  for (const i of [H(84), H(coin), H(0)]) n = ckdPriv(n, i);
  return { version, depth: n.depth, parentFingerprint: n.parentFingerprint, childNumber: n.childNumber, chainCode: bytesToHex(n.chainCode), publicKey: bytesToHex(n.pub) };
}

// BIP39 English wordlist (bundled, 2048 words) — for generating a mnemonic.
const WORDS = (await (await fetch(new URL('./data/bip39-english.txt', import.meta.url))).text()).trim().split('\n');
function entropyToMnemonic(entropy) {
  const CS = (entropy.length * 8) / 32, cs = sha256(entropy), bits = [];
  for (const b of entropy) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  for (let i = 0; i < CS; i++) bits.push((cs[i >> 3] >> (7 - (i & 7))) & 1);
  const out = [];
  for (let i = 0; i < bits.length; i += 11) { let idx = 0; for (let j = 0; j < 11; j++) idx = (idx << 1) | bits[i + j]; out.push(WORDS[idx]); }
  return out.join(' ');
}
// Generate a fresh BIP39 mnemonic (128 bits = 12 words by default).
export function generateMnemonic(strength = 128) { return entropyToMnemonic(crypto.getRandomValues(new Uint8Array(strength / 8))); }

// BIP39: a mnemonic → 64-byte seed (PBKDF2-HMAC-SHA512, 2048 iters). No wordlist
// needed — this hashes the string, so a standard mnemonic from any wallet imports
// here. Verified against the BIP84 vector in test-bip39.mjs.
export async function mnemonicToSeed(mnemonic, passphrase = '') {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(mnemonic.normalize('NFKD')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode('mnemonic' + passphrase.normalize('NFKD')), iterations: 2048, hash: 'SHA-512' }, key, 512);
  return new Uint8Array(bits);
}

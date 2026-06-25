// WASM secp256k1 backend for the engine's setVerifyBackend() hook. Wraps
// tiny-secp256k1's libsecp256k1 wasm (secp256k1.wasm), ~16x the engine's pure-JS
// secp per call. Self-contained: fetches + instantiates the wasm here (top-level
// await) — no bundler, no wasm-ESM, no Worker. The engine's default pure-JS secp
// remains the fallback; this is opt-in via setVerifyBackend(wasmBackend).
//
// The engine passes ECDSA sig as {r,s} BigInts + pubkey as [x,y] BigInts, and
// Schnorr as (msg32, sig64, pubkey32) Uint8Arrays. We marshal into the wasm's
// fixed input pointers and call verify()/verifySchnorr().
const wasmUrl = new URL('./secp256k1.wasm', import.meta.url);
const generateInt32 = () => { const a = new Uint8Array(4); crypto.getRandomValues(a); return (a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]; };
const throwError = (code) => { throw new Error('secp256k1 wasm error ' + code); };

const buffer = await (await fetch(wasmUrl)).arrayBuffer();
const { instance } = await WebAssembly.instantiate(buffer, { './rand.js': { generateInt32 }, './validate_error.js': { throwError } });
const w = instance.exports;
w.initializeContext();

const HASH = w.HASH_INPUT.value, PUB = w.PUBLIC_KEY_INPUT.value, XPUB = w.X_ONLY_PUBLIC_KEY_INPUT.value, SIG = w.SIGNATURE_INPUT.value;
const mem = () => new Uint8Array(w.memory.buffer);

function verifyEcdsa(h, Q, sig) {
  const m = mem(); m.set(h, HASH); m.set(Q, PUB); m.set(sig, SIG);
  const ok = w.verify(Q.length, 0) === 1;
  m.fill(0, HASH, HASH + 32); m.fill(0, PUB, PUB + 65); m.fill(0, SIG, SIG + 64);
  return ok;
}
function verifySchnorr(h, Q, sig) {
  const m = mem(); m.set(h, HASH); m.set(Q, XPUB); m.set(sig, SIG);
  const ok = w.verifySchnorr() === 1;
  m.fill(0, HASH, HASH + 32); m.fill(0, XPUB, XPUB + 32); m.fill(0, SIG, SIG + 64);
  return ok;
}

const b32 = (n) => { const b = new Uint8Array(32); let x = n; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

export const wasmBackend = {
  ecdsa(msgHash, sig, pubkey) {
    const pub = new Uint8Array(65); pub[0] = 4; pub.set(b32(pubkey[0]), 1); pub.set(b32(pubkey[1]), 33);
    const s = new Uint8Array(64); s.set(b32(sig.r), 0); s.set(b32(sig.s), 32);
    try { return verifyEcdsa(msgHash, pub, s); } catch { return false; }
  },
  schnorr(msg32, sig64, pubkey32) {
    try { return verifySchnorr(msg32, pubkey32, sig64); } catch { return false; }
  },
};

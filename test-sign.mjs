// Prove transaction signing: build a P2WPKH spend, compute the BIP143 sighash,
// sign it with the WASM secp, attach the witness, and confirm the engine's OWN
// verifier (ScriptInterpreter.verifyInput) accepts it. A self-built signature
// passing the engine's full BIP143 verification = a tx the network would accept.
// This is the crypto wallet.html will use to spend.
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { hash160, bytesToHex, hexToBytes } from './engine/codec/hash.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btc:testnet4');
const interp = new ScriptInterpreter(codec, se);

// WASM secp: pointFromScalar (privkey→pubkey) + sign (sighash→64-byte compact, low-S)
const { instance } = await WebAssembly.instantiate(fs.readFileSync(new URL('secp256k1.wasm', D)), { './rand.js': { generateInt32: () => 1 }, './validate_error.js': { throwError: (c) => { throw new Error('e' + c); } } });
const w = instance.exports; w.initializeContext();
const PRIV = w.PRIVATE_INPUT.value, PUB = w.PUBLIC_KEY_INPUT.value, HASH = w.HASH_INPUT.value, SIG = w.SIGNATURE_INPUT.value;
const mem = () => new Uint8Array(w.memory.buffer);
const pubFromPriv = (d) => { const m = mem(); m.set(d, PRIV); w.pointFromScalar(33); const o = m.slice(PUB, PUB + 33); m.fill(0, PRIV, PRIV + 32); return o; };
const signEcdsa = (msg32, d) => { const m = mem(); m.set(msg32, HASH); m.set(d, PRIV); w.sign(0); const o = m.slice(SIG, SIG + 64); m.fill(0, PRIV, PRIV + 32); return o; };

// 64-byte compact (r||s) → DER
function toDer(sig64) {
  const trim = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = Uint8Array.from([0, ...b]); return b; };
  const r = trim(sig64.slice(0, 32)), s = trim(sig64.slice(32, 64));
  const seq = Uint8Array.from([0x02, r.length, ...r, 0x02, s.length, ...s]);
  return Uint8Array.from([0x30, seq.length, ...seq]);
}

// a key + its P2WPKH
const priv = new Uint8Array(32); crypto.getRandomValues(priv);
const pub = pubFromPriv(priv);
const keyhash = bytesToHex(hash160(pub));
const scriptPubKey = '0014' + keyhash;                 // P2WPKH
const scriptCode = '76a914' + keyhash + '88ac';        // BIP143 implied P2PKH (no length prefix)
const AMOUNT = 100000;                                  // prevout value (sats)

// build the spending tx (send to a dummy P2WPKH output)
const tx = {
  version: 2, marker: 0, flag: 1,
  inputs: [{ prevout: { txid: 'aa'.repeat(32), vout: 0 }, scriptSig: '', sequence: 0xffffffff }],
  outputs: [{ value: AMOUNT - 1000, scriptPubKey: '0014' + 'bb'.repeat(20) }],
  witness: [[]], lockTime: 0,
};

// BIP143 sighash → sign → witness [sig+hashtype, pubkey]
const sighash = interp.sighashWitnessV0(tx, 0, scriptCode, AMOUNT, 0x01);
const sigHex = bytesToHex(toDer(signEcdsa(sighash, priv))) + '01';   // DER + SIGHASH_ALL
tx.witness[0] = [sigHex, bytesToHex(pub)];

const prevout = { scriptPubKey, value: AMOUNT };
const r = interp.verifyInput(tx, 0, prevout, [prevout]);
console.log('spending P2WPKH', scriptPubKey.slice(0, 14) + '…', '· type', r.type);
console.log('witness:', tx.witness[0].map((x) => x.slice(0, 12) + '…'));

// serialize the signed tx to broadcast hex + txid, and confirm it re-decodes 1:1
const rawHex = codec.encodeHex('Transaction', tx);
const txid = codec.txid(tx);
const roundtrip = codec.encodeHex('Transaction', codec.decode('Transaction', hexToBytes(rawHex))) === rawHex;
console.log('txid:', txid);
console.log('raw tx:', rawHex.slice(0, 40) + '… (' + (rawHex.length / 2) + ' bytes)', roundtrip ? '· re-decodes ✓' : '· re-decode MISMATCH ✗');

if (r.ok === true && roundtrip) console.log('\n✅ signed P2WPKH input verifies under the engine BIP143 + serializes to broadcast hex — wallet.html can build + sign spends');
else { console.log('\n❌ rejected:', JSON.stringify(r), 'roundtrip', roundtrip); process.exit(1); }

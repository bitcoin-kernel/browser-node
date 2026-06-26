// Prove index-aware signing: given a mnemonic and the address that actually holds
// a UTXO, find which BIP84 index it is (receiving 0/i or change 1/i), derive THAT
// signing key, and sign a spend that verifies. wallet.html currently hard-signs
// 0/0; this lets it spend whichever address the faucet funded.
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { hash160, bytesToHex } from './engine/codec/hash.js';
import { mnemonicToSeed, deriveSigningKey, signEcdsa, toDer } from './wasm-keygen.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btc:testnet4');
const interp = new ScriptInterpreter(codec, se);

const seed = await mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '');

// derive a (key, scriptPubKey, address) for an index — exactly what wallet.html does
function at(change, index) {
  const key = deriveSigningKey(seed, { coin: 1, change, index });
  const scriptPubKey = '0014' + bytesToHex(hash160(key.pub));
  return { key, scriptPubKey, address: se.classify(scriptPubKey).address, change, index };
}

// the finder wallet.html will run: scan receiving + change chains for the address
function findKeyForAddress(targetAddr, gap = 20) {
  for (const change of [0, 1]) for (let i = 0; i < gap; i++) { const e = at(change, i); if (e.address === targetAddr) return e; }
  return null;
}

// pretend the faucet funded our 0/3 (NOT 0/0) — prove the finder locates it
const funded = at(0, 3).address;
const hit = findKeyForAddress(funded);
const located = hit && hit.change === 0 && hit.index === 3;
console.log('funded address', funded);
console.log('located at change', hit?.change, 'index', hit?.index, located ? '✓' : '✗ (expected 0/3)');

// sign a spend of that UTXO with the located key; change back to the same address
const AMOUNT = 256415, FEE = 200;
const tx = {
  version: 2, marker: 0, flag: 1,
  inputs: [{ prevout: { txid: 'cc'.repeat(32), vout: 1 }, scriptSig: '', sequence: 0xffffffff }],
  outputs: [{ value: AMOUNT - FEE, scriptPubKey: hit.scriptPubKey }],
  witness: [[]], lockTime: 0,
};
const scriptCode = '76a914' + bytesToHex(hash160(hit.key.pub)) + '88ac';
const sighash = interp.sighashWitnessV0(tx, 0, scriptCode, AMOUNT, 0x01);
tx.witness[0] = [bytesToHex(toDer(signEcdsa(sighash, hit.key.priv))) + '01', bytesToHex(hit.key.pub)];
const prevout = { scriptPubKey: hit.scriptPubKey, value: AMOUNT };
const r = interp.verifyInput(tx, 0, prevout, [prevout]);
console.log('spend signed with the located key · verifyInput:', r.ok, '· type', r.type, '· txid', codec.txid(tx).slice(0, 16) + '…');

// a wrong key must NOT verify (guard against signing with 0/0 regardless)
const wrong = at(0, 0);
const txw = JSON.parse(JSON.stringify(tx));
const sh2 = interp.sighashWitnessV0(txw, 0, '76a914' + bytesToHex(hash160(wrong.key.pub)) + '88ac', AMOUNT, 0x01);
txw.witness[0] = [bytesToHex(toDer(signEcdsa(sh2, wrong.key.priv))) + '01', bytesToHex(wrong.key.pub)];
const rw = interp.verifyInput(txw, 0, prevout, [prevout]);   // wrong pubkey vs the 0/3 scriptPubKey
console.log('control: signing with the WRONG (0/0) key against the 0/3 output →', rw.ok ? 'verifies ✗' : 'rejected ✓');

const ok = located && r.ok === true && rw.ok === false;
console.log(ok ? '\n✅ index-aware signing proven: finds the funding index, signs with the right key, rejects the wrong one' : '\n❌ FAIL');
process.exit(ok ? 0 : 1);

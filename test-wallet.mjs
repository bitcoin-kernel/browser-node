// Prove wallet.html's exact path: a mnemonic → signing key (deriveSigningKey, WITH
// private key) → build a P2WPKH spend to a real testnet4 address (addressToScript)
// → sign with the module's signEcdsa/toDer → engine BIP143 verify → broadcast hex.
// Also confirms the signing key's address == keys.html's watch-only 0/0 address,
// so what you fund (spv.html) is exactly what wallet.html spends.
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { ScriptEngine, addressToScript } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { Bip32 } from './engine/codec/wallet.js';
import { bytesToHex, hexToBytes, hash160 } from './engine/codec/hash.js';
import { mnemonicToSeed, deriveAccountNode, deriveSigningKey, signEcdsa, toDer } from './wasm-keygen.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btc:testnet4');
const interp = new ScriptInterpreter(codec, se);

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = await mnemonicToSeed(MNEMONIC, '');

// signing key 0/0 (private) — its address must equal keys.html's watch-only 0/0
const key = deriveSigningKey(seed, { coin: 1, change: 0, index: 0 });
const acct = deriveAccountNode(seed, { coin: 1, version: 0x043587cf });
const watchAddr = se.classify(Bip32.scriptPubKey(Bip32.derivePath(Bip32.decode(Bip32.encode(acct)), '0/0'), 'p2wpkh')).address;
const myScriptPubKey = '0014' + bytesToHex(hash160(key.pub));
const signAddr = se.classify(myScriptPubKey).address;
const addrMatch = signAddr === watchAddr;
console.log('signing 0/0 addr:', signAddr, addrMatch ? '✓ == watch-only' : '✗ != ' + watchAddr);

// a funded UTXO at our 0/0, spend most of it to a destination address, rest is fee
const AMOUNT = 100000, FEE = 200;
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';   // a valid testnet4 P2WPKH
const destScript = addressToScript(DEST, se.params);
const tx = {
  version: 2, marker: 0, flag: 1,
  inputs: [{ prevout: { txid: 'aa'.repeat(32), vout: 0 }, scriptSig: '', sequence: 0xffffffff }],
  outputs: [{ value: AMOUNT - FEE, scriptPubKey: destScript }],
  witness: [[]], lockTime: 0,
};
const scriptCode = '76a914' + bytesToHex(hash160(key.pub)) + '88ac';
const sighash = interp.sighashWitnessV0(tx, 0, scriptCode, AMOUNT, 0x01);
tx.witness[0] = [bytesToHex(toDer(signEcdsa(sighash, key.priv))) + '01', bytesToHex(key.pub)];

const prevout = { scriptPubKey: myScriptPubKey, value: AMOUNT };
const r = interp.verifyInput(tx, 0, prevout, [prevout]);
const rawHex = codec.encodeHex('Transaction', tx);
const roundtrip = codec.encodeHex('Transaction', codec.decode('Transaction', hexToBytes(rawHex))) === rawHex;
console.log('dest', DEST.slice(0, 14) + '… script', destScript);
console.log('verifyInput:', r.ok, '· type', r.type, '· txid', codec.txid(tx).slice(0, 16) + '…');
console.log('raw tx:', rawHex.length / 2, 'bytes · re-decodes', roundtrip ? '✓' : '✗');

const ok = addrMatch && r.ok === true && roundtrip;
console.log(ok ? '\n✅ wallet path proven: mnemonic → signing key → spend a real tb1q… address → engine-verified + serialized' : '\n❌ FAIL');
process.exit(ok ? 0 : 1);

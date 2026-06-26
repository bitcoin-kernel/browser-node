// Prove the wallet UTXO state: applying a spend removes the input it spends and
// adds the change output (because it pays one of our own scripts), so the balance
// tracks across a chain of spends without re-scanning. Mirrors the real chained
// spends the wallet did on testnet4 (each tx spends the previous one's change).
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { hash160, bytesToHex } from './engine/codec/hash.js';
import { mnemonicToSeed, deriveSigningKey, signEcdsa, toDer } from './wasm-keygen.js';
import { applyTx, addUtxo, balance, listUtxos } from './wallet-store.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btc:testnet4');
const interp = new ScriptInterpreter(codec, se);

const seed = await mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '');
const at = (change, index) => { const key = deriveSigningKey(seed, { coin: 1, change, index }); const spk = '0014' + bytesToHex(hash160(key.pub)); return { key, spk, address: se.classify(spk).address, change, index }; };
// the wallet's own scripts (first 20 receiving + change), as the wallet builds them
const ownScripts = new Map(); for (const c of [0, 1]) for (let i = 0; i < 20; i++) { const e = at(c, i); ownScripts.set(e.spk, e.address); }

// build + sign a spend of `fund` (a tracked UTXO at our 0/0), sending `amount` to a
// foreign address and the rest as change back to 0/0 — exactly wallet.html's path
const me = at(0, 0), DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const destScript = (await import('./engine/codec/script.js')).addressToScript(DEST, se.params);
function spend(fund, amount, fee) {
  const change = fund.value - amount - fee;
  const tx = { version: 2, marker: 0, flag: 1, inputs: [{ prevout: { txid: fund.txid, vout: fund.vout }, scriptSig: '', sequence: 0xffffffff }], outputs: [{ value: amount, scriptPubKey: destScript }, { value: change, scriptPubKey: me.spk }], witness: [[]], lockTime: 0 };
  const sighash = interp.sighashWitnessV0(tx, 0, '76a914' + bytesToHex(hash160(me.key.pub)) + '88ac', fund.value, 0x01);
  tx.witness[0] = [bytesToHex(toDer(signEcdsa(sighash, me.key.priv))) + '01', bytesToHex(me.key.pub)];
  return tx;
}

// 1) fund 0/0 with 256415 sats (as if seen on-chain) → tracked
let set = addUtxo({}, { txid: 'aa'.repeat(32), vout: 1, value: 256415, scriptPubKey: me.spk, address: me.address });
console.log('after funding: balance', balance(set), '· utxos', listUtxos(set).length);
let ok = balance(set) === 256415 && listUtxos(set).length === 1;

// 2) spend it: 10000 out, change back to 0/0, fee 200 → apply
const tx1 = spend(listUtxos(set)[0], 10000, 200);
set = applyTx(set, tx1, ownScripts, codec);
const change1 = 256415 - 10000 - 200;
console.log('after spend 1: balance', balance(set), '(expect', change1 + ') · input gone, change tracked');
ok = ok && balance(set) === change1 && listUtxos(set).length === 1 && !set[`${'aa'.repeat(32)}:1`];

// 3) chain a second spend of the CHANGE utxo (the wallet re-spends its own output)
const tx2 = spend({ ...listUtxos(set)[0] }, 11111, 200);
set = applyTx(set, tx2, ownScripts, codec);
const change2 = change1 - 11111 - 200;
console.log('after spend 2: balance', balance(set), '(expect', change2 + ') · spent the change, new change tracked');
ok = ok && balance(set) === change2 && listUtxos(set).length === 1;

// 4) a tx paying a DIFFERENT wallet's address must NOT be tracked as ours
const foreign = { version: 2, marker: 0, flag: 1, inputs: [{ prevout: { txid: 'bb'.repeat(32), vout: 0 }, scriptSig: '', sequence: 0xffffffff }], outputs: [{ value: 5000, scriptPubKey: destScript }], witness: [[]], lockTime: 0 };
const before = balance(set);
set = applyTx(set, foreign, ownScripts, codec);
console.log('after a foreign tx: balance', balance(set), '(unchanged — its output is not ours)');
ok = ok && balance(set) === before;

console.log(ok ? '\n✅ wallet UTXO state proven: spends remove inputs + track change, balance follows a chain of spends, foreign outputs ignored' : '\n❌ FAIL');
process.exit(ok ? 0 : 1);

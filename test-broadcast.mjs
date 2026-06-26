// Prove the broadcast path: announce a signed tx to a REAL testnet4 peer, have it
// request the tx (getdata), send it, then re-query to read the accept/reject signal.
// Runs the actual broadcast.js against a raw-TCP peer adapter shaped exactly like
// RtcPeer (send / waitFor → {command, payload}); the browser uses the same module
// over the bridge. The tx here spends a non-existent UTXO (no testnet funds in CI),
// so the honest expected result is: requested ✓, then rejected (notfound) — which
// proves the transport + the accept/reject detection. A funded tx returns accepted.
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { hash160, bytesToHex } from './engine/codec/hash.js';
import { mnemonicToSeed, deriveSigningKey, signEcdsa, toDer } from './wasm-keygen.js';
import { broadcastTx } from './broadcast.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btc:testnet4');
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btc:testnet4');
const interp = new ScriptInterpreter(codec, se);

// --- build a real signed P2WPKH tx (the wallet.html path) over a fake UTXO ---
const seed = await mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '');
const key = deriveSigningKey(seed, { coin: 1, change: 0, index: 0 });
const myScriptPubKey = '0014' + bytesToHex(hash160(key.pub));
const AMOUNT = 100000, FEE = 200;
const tx = {
  version: 2, marker: 0, flag: 1,
  inputs: [{ prevout: { txid: 'aa'.repeat(32), vout: 0 }, scriptSig: '', sequence: 0xffffffff }],
  outputs: [{ value: AMOUNT - FEE, scriptPubKey: myScriptPubKey }],   // send back to self
  witness: [[]], lockTime: 0,
};
const scriptCode = '76a914' + bytesToHex(hash160(key.pub)) + '88ac';
const sighash = interp.sighashWitnessV0(tx, 0, scriptCode, AMOUNT, 0x01);
tx.witness[0] = [bytesToHex(toDer(signEcdsa(sighash, key.priv))) + '01', bytesToHex(key.pub)];
console.log('signed tx', codec.txid(tx).slice(0, 16) + '…', '(' + codec.txSize(tx) + ' bytes)');

// --- a raw-TCP peer adapter with RtcPeer's exact contract: send / waitFor ---
const HOST = process.env.PEER_HOST || '103.165.192.202', PORT = 48333;
const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0); const waiters = [];
const drop = (w) => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); };
const peer = {
  send: (cmd, payload) => sock.write(Buffer.from(p2p.encodeMessage(cmd, payload))),
  waitFor: (commands, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const w = { commands, resolve, reject, timer: setTimeout(() => { drop(w); reject(new Error('timeout ' + commands)); }, timeoutMs) };
    waiters.push(w);
  }),
};
const end = (code) => { try { sock.destroy(); } catch {} process.exit(code); };
const guard = setTimeout(() => { console.log('\n❌ overall timeout'); end(1); }, 60000);

sock.on('error', (e) => { console.log('socket error:', e.message); end(1); });
sock.on('connect', () => { console.log('tcp connected to', HOST); peer.send('version', p2p.buildVersion({ userAgent: '/broadcast-test/' })); });
sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  const r = p2p.decodeStream(new Uint8Array(buf));
  buf = buf.subarray(r.consumed);
  for (const msg of r.messages) {
    if (msg.command === 'version') { peer.send('verack'); continue; }
    if (msg.command === 'ping') { peer.send('pong', { nonce: msg.payload?.nonce ?? 0 }); continue; }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].commands.includes(msg.command)) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(msg); break; }
    }
  }
});

// handshake, then run the real broadcast module
await peer.waitFor(['verack'], 20000);
console.log('handshake complete');
const result = await broadcastTx(peer, tx, codec);
clearTimeout(guard);

console.log('\nbroadcast result:', JSON.stringify(result));
const ok = result.requested === true && result.detail !== 'no confirm response (timeout)';
if (ok && result.accepted === true) console.log('\n✅ broadcast PROVEN: peer requested the tx and ACCEPTED it into the mempool');
else if (ok && result.accepted === false) console.log('\n✅ broadcast transport PROVEN: peer requested the tx via getdata, then rejected the unfunded tx (notfound) — accept/reject detection works. Fund a faucet address for an accepted broadcast.');
else console.log('\n❌ broadcast FAILED:', JSON.stringify(result));
end(ok ? 0 : 1);

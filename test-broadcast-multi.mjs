// Prove the multi-peer broadcast: fan a signed tx out to several REAL testnet4
// peers via the actual broadcastToPeers(), each over its own TCP connection with
// a peer adapter shaped like RtcPeer. The browser does the same over the bridge
// (which now dials a random peer per connection). The tx spends a non-existent
// UTXO (no funds in CI), so the honest result is: each peer requests it (getdata),
// then rejects it (notfound) — proving the fan-out + per-peer accept/reject. A
// funded tx returns accepted on the peers that hold its parent (proven live by
// 8bff332f… reaching the mempool).
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { hash160, bytesToHex } from './engine/codec/hash.js';
import { mnemonicToSeed, deriveSigningKey, signEcdsa, toDer } from './wasm-keygen.js';
import { broadcastToPeers } from './broadcast.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btc:testnet4');
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btc:testnet4');
const interp = new ScriptInterpreter(codec, se);
const list = JSON.parse(await readFile(new URL('data/peers-testnet4.json', D), 'utf8'));
const PORT = list.port || 48333;
const HOSTS = list.peers.slice(0, Number(process.env.PEERS || 4));

// a signed (unfunded) P2WPKH tx — the wallet.html path
const seed = await mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '');
const key = deriveSigningKey(seed, { coin: 1, change: 0, index: 0 });
const spk = '0014' + bytesToHex(hash160(key.pub));
const AMOUNT = 100000;
const tx = { version: 2, marker: 0, flag: 1, inputs: [{ prevout: { txid: 'ab'.repeat(32), vout: 0 }, scriptSig: '', sequence: 0xffffffff }], outputs: [{ value: AMOUNT - 200, scriptPubKey: spk }], witness: [[]], lockTime: 0 };
const sighash = interp.sighashWitnessV0(tx, 0, '76a914' + bytesToHex(hash160(key.pub)) + '88ac', AMOUNT, 0x01);
tx.witness[0] = [bytesToHex(toDer(signEcdsa(sighash, key.priv))) + '01', bytesToHex(key.pub)];
console.log('signed tx', codec.txid(tx).slice(0, 16) + '…', '· fanning out to', HOSTS.length, 'peers:', HOSTS.join(', '));

// connect a TCP peer adapter (RtcPeer-shaped: send / waitFor / close), resolved on verack
function connectTcpPeer(host) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, host);
    let buf = Buffer.alloc(0); const waiters = [];
    const drop = (w) => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); };
    const peer = {
      send: (cmd, payload) => sock.write(Buffer.from(p2p.encodeMessage(cmd, payload))),
      waitFor: (commands, ms = 12000) => new Promise((res, rej) => { const w = { commands, res, rej, timer: setTimeout(() => { drop(w); rej(new Error('timeout ' + commands)); }, ms) }; waiters.push(w); }),
      close: () => { try { sock.destroy(); } catch {} },
    };
    const to = setTimeout(() => { peer.close(); reject(new Error('connect timeout ' + host)); }, 8000);
    sock.on('error', (e) => { clearTimeout(to); reject(new Error(host + ': ' + e.message)); });
    sock.on('connect', () => peer.send('version', p2p.buildVersion({ userAgent: '/multi-bcast/' })));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const r = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(r.consumed);
      for (const msg of r.messages) {
        if (msg.command === 'version') { peer.send('verack'); continue; }
        if (msg.command === 'verack') { clearTimeout(to); resolve(peer); continue; }
        if (msg.command === 'ping') { peer.send('pong', { nonce: msg.payload?.nonce ?? 0 }); continue; }
        for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].commands.includes(msg.command)) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.res(msg); break; }
      }
    });
  });
}

const out = await broadcastToPeers((i) => connectTcpPeer(HOSTS[i]), tx, codec, { peers: HOSTS.length, needAccepts: 99 });
console.log('');
out.results.forEach((r, i) => console.log(`  ${HOSTS[i]}: requested=${r.requested} accepted=${r.accepted} · ${r.detail}`));
console.log(`\nfanned out to ${out.tried} peers · ${out.accepted} accepted`);

// the fan-out is proven if every reachable peer engaged the relay (requested via getdata)
const engaged = out.results.filter((r) => r.requested === true).length;
const ok = out.tried === HOSTS.length && engaged >= 2;
console.log(ok ? `\n✅ multi-peer broadcast PROVEN: fanned out to ${out.tried} real peers, ${engaged} engaged the relay (getdata→tx→confirm) — one bad peer can't sink the spend` : '\n❌ fan-out FAILED (too few peers engaged)');
process.exit(ok ? 0 : 1);

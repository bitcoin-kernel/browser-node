// Verify a signed tx against the LIVE chain/mempool, ourselves: fetch each input's
// parent tx from a peer, take the real prevout (scriptPubKey + amount), and run the
// engine's BIP143 verifier. Optionally relay it to that same peer (which, holding
// the parents, can admit a valid unconfirmed-chain spend). Diagnoses a broadcast
// rejection: valid here ⇒ the earlier peer just lacked the parent; invalid ⇒ a
// signing/amount mismatch (BIP143 commits to the input amount).
//   node verify-tx.mjs <rawhex>            # verify only
//   BROADCAST=1 node verify-tx.mjs <rawhex># verify, then relay to the parent-holder
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { ScriptEngine } from './engine/codec/script.js';
import { ScriptInterpreter } from './engine/codec/interpreter.js';
import { broadcastTx } from './broadcast.js';

const RAW = (process.argv[2] || process.env.TX || '').trim().toLowerCase();
if (!/^[0-9a-f]+$/.test(RAW)) { console.log('usage: node verify-tx.mjs <rawhex>'); process.exit(2); }

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btc:testnet4');
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btc:testnet4');
const interp = new ScriptInterpreter(codec, se);

const tx = codec.decode('Transaction', RAW);
console.log('txid', codec.txid(tx), '·', tx.inputs.length, 'in /', tx.outputs.length, 'out');
tx.outputs.forEach((o, i) => console.log(`  out ${i}: ${o.value} sats → ${se.classify(o.scriptPubKey).address || o.scriptPubKey}`));

const HOST = process.env.PEER_HOST || '103.165.192.202', PORT = 48333;
const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0); const waiters = [];
const drop = (w) => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); };
const peer = {
  send: (cmd, payload) => sock.write(Buffer.from(p2p.encodeMessage(cmd, payload))),
  waitFor: (commands, ms = 20000) => new Promise((res, rej) => { const w = { commands, res, rej, timer: setTimeout(() => { drop(w); rej(new Error('timeout ' + commands)); }, ms) }; waiters.push(w); }),
};
const end = (c) => { try { sock.destroy(); } catch {} process.exit(c); };
const guard = setTimeout(() => { console.log('\n❌ overall timeout'); end(1); }, 60000);
sock.on('error', (e) => { console.log('socket error:', e.message); end(1); });
sock.on('connect', () => peer.send('version', p2p.buildVersion({ userAgent: '/verify-tx/' })));
sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  const r = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(r.consumed);
  for (const msg of r.messages) {
    if (msg.command === 'version') { peer.send('verack'); continue; }
    if (msg.command === 'ping') { peer.send('pong', { nonce: msg.payload?.nonce ?? 0 }); continue; }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].commands.includes(msg.command)) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.res(msg); break; }
  }
});

await peer.waitFor(['verack'], 20000);
console.log('\nfetching parents from', HOST, '…');

// resolve each input's real prevout from the network
const prevouts = [];
for (const inp of tx.inputs) {
  peer.send('getdata', { items: [{ type: 1, hash: inp.prevout.txid }] });
  let parent;
  try { parent = (await peer.waitFor(['tx', 'notfound'], 20000)); } catch { parent = null; }
  if (!parent || parent.command === 'notfound') { console.log(`  parent ${inp.prevout.txid.slice(0, 16)}… NOT available from this peer`); prevouts.push(null); continue; }
  const o = parent.payload.outputs[inp.prevout.vout];
  prevouts.push({ scriptPubKey: o.scriptPubKey, value: o.value });
  console.log(`  input spends ${inp.prevout.txid.slice(0, 16)}…:${inp.prevout.vout} = ${o.value} sats (${se.classify(o.scriptPubKey).address || o.scriptPubKey})`);
}

// verify every input against its real prevout (BIP143 needs all prevouts)
let allOk = prevouts.every(Boolean);
if (allOk) tx.inputs.forEach((inp, i) => {
  const r = interp.verifyInput(tx, i, prevouts[i], prevouts);
  console.log(`  verifyInput[${i}]:`, r.ok ? 'VALID ✓' : 'INVALID ✗ ' + JSON.stringify(r), '· type', r.type);
  if (r.ok !== true) allOk = false;
});

if (!allOk) { console.log('\n❌ tx does NOT verify against the real prevouts — signing/amount mismatch (re-check the UTXO value entered).'); clearTimeout(guard); end(1); }
console.log('\n✅ tx VALID against the live prevouts — the signature is correct. Earlier rejection was the peer lacking the parent.');

if (process.env.BROADCAST === '1') {
  console.log('\nrelaying to the parent-holding peer…');
  const res = await broadcastTx(peer, tx, codec);
  console.log('broadcast:', JSON.stringify(res));
  console.log(res.accepted ? '\n✅ ACCEPTED into the mempool — the spend is live on testnet4.' : '\n⚠ ' + res.detail + ' (if notfound, the parent must confirm first, then retry).');
}
clearTimeout(guard);
end(0);

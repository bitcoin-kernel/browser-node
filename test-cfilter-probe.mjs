// Probe: does the testnet4 peer serve BIP157 compact filters? Connect, check the
// NODE_COMPACT_FILTERS service bit, then actually request a cfilter for block #1.
// Determines whether spv.html stage 2 can sync filters over the bridge.
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btc:testnet4');
const vectors = JSON.parse(await readFile(new URL('data/testnet4.json', D), 'utf8'));
const genesisHash = codec.blockHash(codec.decode('BlockHeader', vectors.genesisHeader));

const HOST = process.env.PEER_HOST || '103.165.192.202', PORT = Number(process.env.PEER_PORT || 48333);
const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0); const waiters = [];
const send = (cmd, p) => sock.write(Buffer.from(p2p.encodeMessage(cmd, p)));
const want = (cmd, t = 20000) => new Promise((res, rej) => { const w = { cmd, res, rej, timer: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error('timeout ' + cmd)); }, t) }; waiters.push(w); });
let done = false; const end = (c) => { if (done) return; done = true; try { sock.destroy(); } catch {} process.exit(c); };
const to = setTimeout(() => { console.log('\n❌ overall timeout'); end(1); }, 45000);

sock.on('connect', () => { console.log('tcp connected to', HOST + ':' + PORT); send('version', p2p.buildVersion({ userAgent: '/cfilter-probe/' })); });
sock.on('error', (e) => { console.log('socket error:', e.message); end(1); });
sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  const r = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(r.consumed);
  for (const msg of r.messages) {
    if (msg.command === 'version') { const sv = BigInt(msg.payload.services); console.log('peer:', msg.payload.userAgent, '· services = 0x' + sv.toString(16)); console.log('NODE_COMPACT_FILTERS (bit 6, =64):', (sv & 64n) !== 0n ? 'ADVERTISED ✓' : 'not advertised ✗'); send('verack'); continue; }
    if (msg.command === 'ping') { send('pong', { nonce: msg.payload?.nonce ?? 0 }); continue; }
    const i = waiters.findIndex((w) => w.cmd === msg.command); if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.res(msg.payload); }
  }
});

try {
  await want('verack');
  console.log('handshake ok — getting block #1 hash');
  send('getheaders', { version: 70016, blockLocator: [genesisHash], hashStop: '0'.repeat(64) });
  const hmsg = await want('headers');
  const h1hash = codec.blockHash(hmsg.entries[0].header);
  console.log('block #1:', h1hash.slice(0, 20) + '…  — requesting getcfilters (BASIC type 0, height 1)');
  send('getcfilters', { filterType: 0, startHeight: 1, stopHash: h1hash });
  const cf = await want('cfilter', 15000);
  const flen = typeof cf.filter === 'string' ? cf.filter.length / 2 : cf.filter.length;
  clearTimeout(to);
  console.log(`\n✅ the peer SERVES compact filters — cfilter for ${cf.blockHash.slice(0, 16)}…, ${flen} bytes (BIP158).`);
  console.log('   spv.html stage 2 can sync BIP158 filters over the bridge.');
  end(0);
} catch (e) {
  clearTimeout(to);
  console.log(`\n❌ no cfilter (${e.message}) — this peer does NOT serve compact filters. Stage 2 needs a peer with`);
  console.log('   NODE_COMPACT_FILTERS, or a fallback (scan full blocks / use a filter source).');
  end(1);
}

// Verify getheaders pagination: collect 5000 block hashes from the network
// (getheaders returns ≤2000/msg, so continue the locator from the last hash).
import { readFile } from 'node:fs/promises';
import nodeDataChannel from 'node-datachannel';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { startSignaling } from './signaling-stub.mjs';
import { startBridge } from './bridge-webrtc.mjs';
import { connectAsOfferer } from './rtc-signaling.mjs';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const PORT = 9094, ROOM = 'b17c0192abad1deacafe', SIGNAL = `ws://localhost:${PORT}/.webrtc`;
const PEER_HOST = process.env.PEER_HOST || '103.165.192.202', N = 5000;

const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btc:testnet4');
const vectors = JSON.parse(await readFile(new URL('data/testnet4.json', D), 'utf8'));
const genesisHash = codec.blockHash(codec.decode('BlockHeader', vectors.genesisHeader));
const log = (m) => console.log(m);

const sig = startSignaling(PORT, { log });
const bridge = startBridge({ signalUrl: SIGNAL, room: ROOM, peerHost: PEER_HOST, peerPort: 48333, log });
let done = false; const end = (c) => { if (done) return; done = true; try { bridge.close(); } catch {} try { sig.close(); } catch {} try { nodeDataChannel.cleanup(); } catch {} setImmediate(() => process.exit(c)); };
const to = setTimeout(() => { console.log('❌ timeout'); end(1); }, 60000);

// minimal peer over the data channel (version/verack + getheaders waiter)
const conn = await connectAsOfferer({ signalUrl: SIGNAL, room: ROOM, log });
const dc = conn.dc; let buf = Buffer.alloc(0); const waiters = [];
const send = (c, p) => dc.sendMessageBinary(Buffer.from(p2p.encodeMessage(c, p)));
const want = (cmd, t = 30000) => new Promise((res, rej) => { const w = { cmd, res, rej, timer: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error('timeout ' + cmd)); }, t) }; waiters.push(w); });
dc.onMessage((m) => { buf = Buffer.concat([buf, Buffer.isBuffer(m) ? m : Buffer.from(m)]); const { messages, consumed } = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(consumed);
  for (const msg of messages) { if (msg.command === 'version') { send('verack'); continue; } if (msg.command === 'ping') { send('pong', { nonce: msg.payload?.nonce ?? 0 }); continue; } const i = waiters.findIndex((w) => w.cmd === msg.command); if (i >= 0) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.res(msg.payload); } } });

try {
  send('version', p2p.buildVersion({ userAgent: '/paginate-test/' })); await want('verack');
  log('handshake ok — paginating getheaders…');
  const hashes = []; let locator = [genesisHash], rounds = 0;
  while (hashes.length < N) {
    send('getheaders', { version: 70016, blockLocator: locator, hashStop: '0'.repeat(64) });
    const payload = await want('headers');
    const hdrs = (payload?.entries ?? []).map((e) => e.header);
    if (!hdrs.length) break;
    for (const h of hdrs) { hashes.push(codec.blockHash(h)); if (hashes.length >= N) break; }
    locator = [hashes[hashes.length - 1]]; rounds++;
    log(`  round ${rounds}: ${hashes.length} hashes`);
  }
  clearTimeout(to);
  const uniq = new Set(hashes).size;
  if (hashes.length >= N && uniq === hashes.length) { log(`\n✅ paginated to ${hashes.length} block hashes in ${rounds} getheaders rounds, all unique — first ${hashes[0].slice(0,12)}… last ${hashes.at(-1).slice(0,12)}…`); end(0); }
  else { log(`\n❌ got ${hashes.length} hashes (${uniq} unique)`); end(1); }
} catch (e) { console.log('❌ ' + e.message); end(1); }

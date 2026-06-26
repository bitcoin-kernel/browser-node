// Prove the wallet scan: pull a range of blocks from the network, then match each
// output's scriptPubKey against a watch set and record the UTXOs found — the core
// of spv.html stage 3. The watch target is a real output taken from one of the
// downloaded blocks, so a correct scan must rediscover it at the right height.
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

const HOST = process.env.PEER_HOST || '103.165.192.202', PORT = 48333, MSG_WITNESS_BLOCK = 1073741826;
const START = 1, COUNT = 30, TARGET_H = 20;          // scan blocks 1..30; watch an output from block 20

// the scan logic spv.html will use: match outputs against a set of watched scriptPubKeys
function scan(blocksByHeight, watch) {
  const found = [];
  for (const { height, block } of blocksByHeight)
    for (const tx of block.transactions) {
      const txid = codec.txid(tx);
      tx.outputs.forEach((o, vout) => { if (watch.has(o.scriptPubKey)) found.push({ height, txid, vout, value: o.value }); });
    }
  return found;
}

const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0); const waiters = [];
const send = (cmd, p) => sock.write(Buffer.from(p2p.encodeMessage(cmd, p)));
const want = (cmd, n = 1, t = 30000) => new Promise((res, rej) => { const w = { cmd, n, got: [], res, rej, timer: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error('timeout ' + cmd)); }, t) }; waiters.push(w); });
let done = false; const end = (c) => { if (done) return; done = true; try { sock.destroy(); } catch {} process.exit(c); };
const to = setTimeout(() => { console.log('\n❌ timeout'); end(1); }, 45000);
sock.on('connect', () => { console.log('tcp connected to', HOST); send('version', p2p.buildVersion({ userAgent: '/scan-test/' })); });
sock.on('error', (e) => { console.log('socket error:', e.message); end(1); });
sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]); const r = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(r.consumed);
  for (const msg of r.messages) {
    if (msg.command === 'version') { send('verack'); continue; }
    if (msg.command === 'ping') { send('pong', { nonce: msg.payload?.nonce ?? 0 }); continue; }
    const i = waiters.findIndex((w) => w.cmd === msg.command); if (i < 0) continue;
    const w = waiters[i]; w.got.push(msg.payload); if (w.got.length >= w.n) { clearTimeout(w.timer); waiters.splice(i, 1); w.res(w.got); }
  }
});

try {
  await want('verack');
  send('getheaders', { version: 70016, blockLocator: [genesisHash], hashStop: '0'.repeat(64) });
  const [hmsg] = await want('headers');
  const headers = (hmsg.entries ?? []).map((e) => e.header);                 // headers[0] = block #1
  const hashes = []; for (let h = START; h < START + COUNT; h++) hashes.push(codec.blockHash(headers[h - 1]));
  send('getdata', { items: hashes.map((hash) => ({ type: MSG_WITNESS_BLOCK, hash })) });
  const payloads = await want('block', COUNT);
  const blocksByHeight = payloads.map((block, i) => ({ height: START + i, block }));   // peer returns in request order
  console.log(`downloaded blocks #${START}..#${START + COUNT - 1} (${payloads.length})`);

  // watch target: an output from block #TARGET_H
  const tBlock = blocksByHeight.find((b) => b.height === TARGET_H).block;
  const tTx = tBlock.transactions[0], tOut = tTx.outputs[0];
  const watch = new Set([tOut.scriptPubKey]);
  const expect = { height: TARGET_H, txid: codec.txid(tTx), vout: 0, value: tOut.value };
  console.log(`watching scriptPubKey ${tOut.scriptPubKey.slice(0, 20)}… (from block #${TARGET_H})`);

  const found = scan(blocksByHeight, watch);
  clearTimeout(to);
  console.log(`scan found ${found.length} matching output(s); e.g. #${found[0]?.height} ${found[0]?.txid.slice(0, 12)}…:${found[0]?.vout} = ${found[0]?.value}`);
  const hit = found.some((f) => f.height === expect.height && f.txid === expect.txid && f.vout === expect.vout && f.value === expect.value);
  if (hit) console.log(`\n✅ scan works: found the watched output at block #${TARGET_H} (value ${expect.value}) — output matching over the network`);
  else { console.log('\n❌ did not find the watched output'); end(1); }
  end(0);
} catch (e) { clearTimeout(to); console.log('\n❌ ' + e.message); end(1); }

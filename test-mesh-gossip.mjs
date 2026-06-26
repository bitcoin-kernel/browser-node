// De-risk gossip mode on a FULL mesh: 3 peers all connected; the source sends a
// block to ONE neighbor only; gossip forwarding carries it to the third peer
// (the one the source never sent to). Proves the ?gossip=1 browser demo.
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import nodeDataChannel from 'node-datachannel';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { startSignaling } from './signaling-stub.mjs';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const PORT = 9091, ROOM = 'b17c0192abad1deacafe', SIGNAL = `ws://localhost:${PORT}/.webrtc`, ICE = ['stun:stun.l.google.com:19302'];

const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btc:testnet4');
const blockHex = (await readFile(new URL('data/block-26000.hex', D), 'utf8')).trim();
const expectHash = codec.blockHash(codec.decode('Block', blockHex).header);
const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gather = (pc) => new Promise((res) => { if (pc.gatheringState() === 'complete') return res(pc.localDescription()); pc.onGatheringStateChange((s) => { if (s === 'complete') res(pc.localDescription()); }); });

// Full-mesh node peer WITH gossip forwarding (mirror of peer-mesh.js + onMessage).
function makeMeshNode(name, { onBlock } = {}) {
  const ws = new WebSocket(SIGNAL);
  const offerPCs = new Map(), openDCs = [], seen = new Set();
  let joined = false;
  const bufs = new WeakMap();
  const rx = (dc) => (m) => { let b = bufs.get(dc) || Buffer.alloc(0); b = Buffer.concat([b, Buffer.isBuffer(m) ? m : Buffer.from(m)]); const r = p2p.decodeStream(new Uint8Array(b)); bufs.set(dc, b.subarray(r.consumed)); for (const msg of r.messages) { if (msg.command !== 'block') continue; const h = codec.blockHash(msg.payload.header); if (seen.has(h)) continue; seen.add(h); onBlock?.(name, h); for (const o of openDCs) if (o !== dc && o.isOpen()) { try { o.sendMessageBinary(Buffer.from(p2p.encodeMessage('block', msg.payload))); } catch {} } } };
  const setupDC = (dc) => { bufs.set(dc, Buffer.alloc(0)); dc.onOpen(() => openDCs.push(dc)); dc.onMessage(rx(dc)); };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'announce', resource: ROOM, offers: [] })));
  ws.on('message', async (data) => { let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'resource-peers' && !joined) { joined = true; const offers = []; for (let i = 0; i < m.count; i++) { const pc = new nodeDataChannel.PeerConnection(`${name}o${i}`, { iceServers: ICE }); setupDC(pc.createDataChannel('mesh')); const d = await gather(pc); const id = `${name}-${i}`; offerPCs.set(id, pc); offers.push({ sdp: d.sdp, offer_id: id }); } if (offers.length) ws.send(JSON.stringify({ type: 'announce', resource: ROOM, offers })); }
    else if (m.type === 'offer' && m.resource === ROOM) { const pc = new nodeDataChannel.PeerConnection(`${name}a`, { iceServers: ICE }); pc.onDataChannel(setupDC); pc.setRemoteDescription(m.sdp, 'offer'); const d = await gather(pc); ws.send(JSON.stringify({ type: 'answer', resource: ROOM, to: m.from, offer_id: m.offer_id, sdp: d.sdp })); }
    else if (m.type === 'answer' && m.resource === ROOM) offerPCs.get(m.offer_id)?.setRemoteDescription(m.sdp, 'answer'); });
  return { name, openDCs, sendToOne: (cmd, payload) => openDCs[0]?.sendMessageBinary(Buffer.from(p2p.encodeMessage(cmd, payload))) };
}

const sig = startSignaling(PORT, { log });
let done = false; const end = (c) => { if (done) return; done = true; try { sig.close(); } catch {} try { nodeDataChannel.cleanup(); } catch {} setImmediate(() => process.exit(c)); };
const to = setTimeout(() => { console.log('\n❌ timeout'); end(1); }, 40000);

const got = new Set();
const onBlock = (who, h) => { if (h !== expectHash) return; got.add(who); log(`  ${who}: received + validated the block`); if (got.has('B') && got.has('C')) { clearTimeout(to); log('\n✅ gossip mode: source A sent to ONE neighbor; B and C both got it (one via gossip) on a full mesh'); end(0); } };

log(`\nfull 3-mesh; A will send to ONE neighbor only…`);
const A = makeMeshNode('A');
await sleep(1200);
const B = makeMeshNode('B', { onBlock });
await sleep(1200);
const C = makeMeshNode('C', { onBlock });
for (let i = 0; i < 40 && !(A.openDCs.length >= 2 && B.openDCs.length >= 2 && C.openDCs.length >= 2); i++) await sleep(400);
log(`  mesh up — A:${A.openDCs.length} B:${B.openDCs.length} C:${C.openDCs.length}; A sending block to ONE neighbor`);
if (A.openDCs.length < 2) { console.log('\n❌ mesh did not fully form'); end(1); }
else A.sendToOne('block', blockHex);

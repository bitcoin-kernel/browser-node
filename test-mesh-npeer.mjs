// De-risk the N-peer mesh coordination: 3 peers join one room and form a FULL
// mesh (each connected to the other two), then one broadcasts a block and the
// other two receive + validate it. Proves the join logic mesh.html will use:
//   on join → offer to every existing peer; always answer future joiners.
// Both ends here are node-datachannel; the browser mirrors it with RTCPeerConnection.
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import nodeDataChannel from 'node-datachannel';
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { startSignaling } from './signaling-stub.mjs';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const PORT = 9093, ROOM = 'b17c0192abad1deacafe', SIGNAL = `ws://localhost:${PORT}/.webrtc`;
const ICE = ['stun:stun.l.google.com:19302'];

const codec = new Codec(await jl('core'), await jl('proof'), await jl('p2p'));
const p2p = P2pEngine.fromSchemas(codec, await jl('p2p'), await jl('chain'), 'btc:testnet4');
const blockHex = (await readFile(new URL('data/block-26000.hex', D), 'utf8')).trim();
const expectHash = codec.blockHash(codec.decode('Block', blockHex).header);
const log = (m) => console.log(m);

function gatherComplete(pc) {
  return new Promise((res) => { if (pc.gatheringState() === 'complete') return res(pc.localDescription()); pc.onGatheringStateChange((s) => { if (s === 'complete') res(pc.localDescription()); }); });
}

// A minimal N-peer mesh node (mirror of the browser MeshPeer join logic).
function makeMeshNode(name, { onMessage } = {}) {
  const ws = new WebSocket(SIGNAL);
  const offerPCs = new Map();   // offer_id -> pc (offers we sent, awaiting answers)
  const openDCs = [];           // open data channels (one per connected peer)
  let joined = false;
  const setupDC = (dc) => { dc.onOpen(() => openDCs.push(dc)); dc.onMessage((m) => onMessage?.(m, dc)); };

  ws.on('open', () => ws.send(JSON.stringify({ type: 'announce', resource: ROOM, offers: [] })));
  ws.on('message', async (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'resource-peers' && !joined) {        // learned how many peers are already here
      joined = true;
      const K = m.count, offers = [];
      for (let i = 0; i < K; i++) {                       // offer to each existing peer
        const pc = new nodeDataChannel.PeerConnection(`${name}-o${i}`, { iceServers: ICE });
        setupDC(pc.createDataChannel('mesh'));
        const desc = await gatherComplete(pc);
        const offer_id = `${name}-${i}`;
        offerPCs.set(offer_id, pc);
        offers.push({ sdp: desc.sdp, offer_id });
      }
      if (offers.length) ws.send(JSON.stringify({ type: 'announce', resource: ROOM, offers }));
    } else if (m.type === 'offer' && m.resource === ROOM) {   // a (later) joiner is offering us a connection
      const pc = new nodeDataChannel.PeerConnection(`${name}-ans`, { iceServers: ICE });
      pc.onDataChannel(setupDC);
      pc.setRemoteDescription(m.sdp, 'offer');
      const desc = await gatherComplete(pc);
      ws.send(JSON.stringify({ type: 'answer', resource: ROOM, to: m.from, offer_id: m.offer_id, sdp: desc.sdp }));
    } else if (m.type === 'answer' && m.resource === ROOM) {
      offerPCs.get(m.offer_id)?.setRemoteDescription(m.sdp, 'answer');
    }
  });
  return { name, openDCs, broadcast: (cmd, payload) => { for (const dc of openDCs) dc.sendMessageBinary(Buffer.from(p2p.encodeMessage(cmd, payload))); } };
}

const sig = startSignaling(PORT, { log });
let done = false;
const end = (c) => { if (done) return; done = true; try { sig.close(); } catch {} try { nodeDataChannel.cleanup(); } catch {} setImmediate(() => process.exit(c)); };
const to = setTimeout(() => { console.log('\n❌ timeout (mesh did not fully form / propagate)'); end(1); }, 40000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each peer decodes incoming bytes and counts validated blocks.
const got = { B: false, C: false };
function rx(who) { let buf = Buffer.alloc(0); return (m) => { buf = Buffer.concat([buf, Buffer.isBuffer(m) ? m : Buffer.from(m)]); const { messages, consumed } = p2p.decodeStream(new Uint8Array(buf)); buf = buf.subarray(consumed); for (const msg of messages) if (msg.command === 'block') { const h = codec.blockHash(msg.payload.header); if (h === expectHash) { log(`  ${who}: received + validated block #26000 over the mesh`); got[who] = true; if (got.B && got.C) { clearTimeout(to); log('\n✅ full mesh of 3 peers; A broadcast a block, B and C both received + validated it'); end(0); } } } }; }

log(`\nforming a 3-peer mesh in room ${ROOM}…`);
const A = makeMeshNode('A');
await sleep(1200);
const B = makeMeshNode('B', { onMessage: rx('B') });
await sleep(1200);
const C = makeMeshNode('C', { onMessage: rx('C') });

// wait for the full mesh: A↔B, A↔C, B↔C → each peer has 2 open channels
for (let i = 0; i < 40 && !(A.openDCs.length >= 2 && B.openDCs.length >= 2 && C.openDCs.length >= 2); i++) await sleep(500);
log(`  open channels — A:${A.openDCs.length} B:${B.openDCs.length} C:${C.openDCs.length}`);
if (A.openDCs.length < 2) { console.log('\n❌ mesh did not fully form'); end(1); }
else { log('  A broadcasting block #26000 to its peers…'); A.broadcast('block', blockHex); }

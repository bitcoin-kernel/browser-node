// Live feed: sync (and tail) the testnet4 header chain from a real peer over the
// WS-to-TCP bridge, validating every header (PoW, difficulty/BIP94 retarget,
// linkage, most-work reorg) with the bitcoin-kernel engine — in the tab.
// Schemas/vectors are injected so this same module runs headless (Node) and in
// the browser; only the transport (WsPeer over the bridge) touches the network.
import { Codec } from './engine/codec/codec.js';
import { P2pEngine } from './engine/codec/p2p.js';
import { HeaderEngine } from './engine/codec/headers.js';
import { MemoryHeaderStore } from './engine/store/header-store.js';
import { HeaderSync } from './engine/chain/header-sync.js';
import { WsPeer } from './peer-ws.js';
import { OpfsHeaderStore, opfsAvailable } from './opfs-header-store.js';

// Build engine + connect the peer through the bridge. Returns the live session.
export async function connect({ bridgeUrl, schemas, vectors, log, persist = false }) {
  const codec = new Codec(schemas.core, schemas.proof, schemas.p2p);
  const p2p = P2pEngine.fromSchemas(codec, schemas.p2p, schemas.chain, 'btc:testnet4');
  const he = HeaderEngine.fromSchemas(codec, schemas.chain, schemas.validate, 'btc:testnet4');
  const genesis = codec.decode('BlockHeader', vectors.genesisHeader);

  // Persisted (OPFS) store resumes across reloads; otherwise in-memory.
  const usingOpfs = persist && opfsAvailable();
  const store = usingOpfs ? new OpfsHeaderStore(codec, he, genesis) : new MemoryHeaderStore(codec, he, genesis);
  let resumedFrom = 0;
  if (usingOpfs) {
    const t0 = performance.now();
    await store.load();
    resumedFrom = store.height;
    if (resumedFrom) log?.(`resumed ${resumedFrom.toLocaleString()} headers from OPFS in ${(performance.now() - t0).toFixed(0)}ms`, 'ok');
    else log?.('OPFS empty — first sync will persist the chain');
  }

  const peer = new WsPeer(p2p, codec);
  log?.('connecting to bridge → testnet4 peer…');
  await peer.connect(bridgeUrl);
  log?.('handshake complete (version / verack)', 'ok');

  const fetchHeaders = async (locator) => {
    peer.send('getheaders', { version: 70016, blockLocator: locator, hashStop: '0'.repeat(64) });
    const msg = await peer.waitFor(['headers'], 30000);
    return (msg.payload?.entries ?? []).map((e) => e.header);
  };
  const sync = new HeaderSync(store, he, codec);
  return { codec, p2p, he, store, peer, sync, fetchHeaders, persisted: usingOpfs, resumedFrom };
}

// Initial sync from genesis to the peer's tip, validating every header.
export async function syncToTip(session, { onBatch } = {}) {
  return session.sync.sync(session.fetchHeaders, { onBatch });
}

// Tail the live tip: re-run sync on an interval; report any newly-appended blocks.
// Returns a stop() function. Each new block triggers onTip({height, hash, added}).
export function tail(session, { intervalMs = 10000, onTip, log } = {}) {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (stopped) break;
      try {
        const before = session.store.height;
        const res = await session.sync.sync(session.fetchHeaders);
        if (session.store.height > before) onTip?.({ ...session.store.tip(), added: res.added, reorgs: res.reorgs });
      } catch (e) { log?.('tail error: ' + e.message, 'warn'); }
    }
  };
  loop();
  return () => { stopped = true; };
}

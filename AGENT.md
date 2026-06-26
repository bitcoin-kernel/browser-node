# AGENT.md

Orientation for agents and humans working on **bitcoin-kernel/browser-node** — a Bitcoin
**testnet4** node that runs in a browser tab. This file is the prose map of what exists, what's
real vs. proof-of-concept, and where to extend. Companions: [`AGENTS.md`](./AGENTS.md) (older
short orientation), [`manifest.json`](./manifest.json) (machine-readable facts),
[`README.md`](./README.md), [`how-it-works.html`](./how-it-works.html) (narrative).

> **Status legend:** ✅ real & verified · 🟡 works but PoC / bounded · ⛔ not built (gap).

---

## 1. The thesis

A Bitcoin full node validates the header chain, downloads blocks, validates them against the UTXO
set, maintains that set, follows the tip, and propagates data to peers. Two things make this hard
in a browser: **(a)** a tab can't open raw TCP, and **(b)** the full testnet4 UTXO set is ~25 GB —
over a tab's memory ("the 25 GB wall"). This repo answers each: TCP via a thin **bridge**; the
memory wall via **SwiftSync** (a 32-byte accumulator that checks set-consistency without holding
the set). The result is *header-complete, block-sampled* today — a real consensus engine in a tab,
with the remaining gaps mapped honestly below.

---

## 2. Architecture (layers)

```
┌─ Pages (UI) ──────────────────────────────────────────────────────────────┐
│  index · node · fullnode · tip · verify · fullchain · mesh · how-it-works  │
└───────────────────────────────────────────────────────────────────────────┘
        │ main thread                         │ Web Worker (node-worker.js)
┌───────▼─────────────┐              ┌─────────▼──────────────────────────────┐
│ live-feed.js        │              │ validate-forward · follow-chain        │
│  HeaderSync, tail   │              │ ShardedUtxo · SwiftSync accumulator    │
│ peer-* transports   │              │ WASM secp (wasm-secp.js)               │
└───────┬─────────────┘              │ OPFS persistence (sync access handles) │
        │                            └────────────────────────────────────────┘
┌───────▼───────────────── transports ───────────────────────────────────────┐
│ WsPeer  → bridge.mjs (WS↔TCP, localhost)                                     │
│ RtcPeer → bridge-webrtc.mjs (WebRTC↔TCP, NAT-traversable, via a JSS pod)     │
│ MeshPeer→ browser↔browser (no server in the data path)                       │
└───────┬─────────────────────────────────────────────────────────────────────┘
        │  signaling: a JavaScript Solid Server pod's /.webrtc (room mode)
        ▼  data: WebTorrent (snapshot), bundled hex (samples)
   testnet4 network
```

**Engine** (vendored under `engine/`, from `@bitcoin-desktop/schema`): a pure-JS, schema-driven
consensus engine. Key classes: `Codec` (encode/decode consensus structs from JSON-LD schemas),
`BlockEngine` (`validateBlockStructure`, `validateBlockContext`), `HeaderEngine`, `P2pEngine`
(`buildVersion`, `encodeMessage`, `decodeStream`). Schemas in `engine/schema/*.jsonld`
(`core`, `proof`, `p2p`, `chain`, `validate`, `script`). The network is a parameter
(`'btc:testnet4'`); `chain.jsonld` also defines `btc:mainnet`, `btc:testnet` (see §8 other networks).
`engine/codec/` also contains **`wallet.js`, `spv.js`, `filters.js`, `nostr.js`, `mine.js`,
`interpreter.js`** — primitives for the wallet/SPV roadmap (§8), not yet wired into any page.

**secp256k1:** `wasm-secp.js` loads tiny-secp256k1 WASM; `setVerifyBackend` swaps it into the
engine (used inside the worker). Pure-JS fallback exists.

---

## 3. Pages

| Page | Status | What it does |
|---|---|---|
| `index.html` | ✅ | The "acts" overview — links to every demo. |
| `node.html` | 🟡 | Running-node dashboard: header feed → bootstrap UTXO from a seed → forward-validate a bounded block window (full scripts/sigs, WASM secp, in a worker) → checkpoint to OPFS → SwiftSync set-consistency. **Reaches** the tip but doesn't follow it. |
| `fullnode.html` | 🟡 | `node.html` split into two tabs: **① Node** (the dashboard + `tail()` so it *follows* the tip, with a "listening at the tip" heartbeat card) and **② Validation** (the full-consensus block window, lifted out). Pipeline JS is byte-identical to node.html plus a tab switcher. |
| `tip.html` | ✅ | Follows the live testnet4 **header** tip: sync then `tail()`, validating each new header (PoW, BIP94, linkage), reorg-aware. Header-level, not full blocks. |
| `verify.html` | ✅ | Verifies the **assumeUTXO snapshot** (Core `dumptxoutset`, 14.1M coins) by streaming it through the SwiftSync accumulator → commitment `af37b01d…`, holding 32 bytes. Data source is a link param (`?url=` HTTP / `?magnet=` WebTorrent). |
| `fullchain.html` | 🟡 | Streams blocks genesis→N through the accumulator (set-consistency), sourced from a **local block-server** (`tools/block-server.mjs`, not click-and-run). Reached 30k in-browser. |
| `mesh.html` | 🟡 | **Browser↔browser block propagation.** Two tabs become Bitcoin peers over WebRTC (no server in the data path); "Seed 5000" pulls 5000 real blocks from the network (via the bridge) and relays them to the peer, validated (structure + PoW) on both ends. |
| `how-it-works.html` | ✅ | Narrative blog post with SVG diagrams. |

**URL params (shared):** `?signal=wss://<pod>/.webrtc` (WebRTC signaling) · `?room=<hex>`
(`[a-f0-9]{8,128}`) · `?bridge=ws://host:8334` (WS bridge) · `?replay=1` (node/fullnode: re-watch
the genesis→tip header climb) · mesh `?bridgeRoom=<hex>` (the seed's network source room) · mesh
`?blocks=N` (seed count, default 5000).

---

## 4. Browser modules (main thread / worker)

- **`peer-ws.js` (`WsPeer`)** — Bitcoin p2p over a WebSocket to `bridge.mjs`. API: `connect / send /
  waitFor / collect / close`.
- **`peer-rtc.js` (`RtcPeer`)** — same API over a WebRTC data channel to `bridge-webrtc.mjs`
  (offerer; non-trickle ICE; room handshake).
- **`peer-mesh.js` (`MeshPeer`)** — browser↔browser; role (offerer/answerer) decided by join order
  in the room; speaks engine-encoded Bitcoin messages; `onMessage(decodedMsg)`.
- **`live-feed.js`** — `connect({bridgeUrl | signalUrl, room, schemas, vectors, persist})` picks
  WsPeer vs RtcPeer; `syncToTip` (one-shot), `tail` (follow + reorgs).
- **`node-worker.js`** — Web Worker validation core. RPC handlers: `init, followRange, checkpoint,
  resume, swiftsync, scaleAccumulate, swiftsyncHints, fullchain, verifySnapshot`.
- **`validate-forward.js`** (`loadEngine`, `coinviewOf`), **`follow-chain.js`** (`applyBlock`,
  `followChain`), **`sharded-utxo-browser.js`** (`ShardedUtxo`, 64 sub-Maps to beat V8's Map cap),
  **`dumptxoutset.js`** (Core snapshot reader), **`opfs-header-store.js` / `opfs-coins-store.js`**
  (persistence), **`wasm-secp.js`**.

**`swiftsync/`** — `accumulator.js` (32-byte homomorphic accumulator, tagged-SHA256 "SwiftSync",
2×128-bit lanes), `outpoint.js`, `hint.js` (`generateHints`/`reconstructUtxo`, Elias-Fano),
`hintsfile.js`, `validate.js` (`applyBlocks`), `varint.js`, `index.js`. SwiftSync checks
**set-consistency** (all created − all spent = the surviving set; closes to zero / residual = the
UTXO commitment). It does **not** execute scripts.

---

## 5. Node tools (need a terminal)

| File | Role |
|---|---|
| `bridge.mjs` | WS↔TCP relay (`ws://localhost:8334` → a testnet4 peer). |
| `bridge-webrtc.mjs` | WebRTC↔TCP relay; joins a signaling room (keepalive + auto-reconnect). The deployable bridge. |
| `rtc-signaling.mjs` | Node WebRTC room handshake helpers (`connectAsOfferer` / `connectAsAnswerer`, node-datachannel). |
| `signaling-stub.mjs` | Local signaling server, **wire-identical** to a JSS pod's room mode (dev without a pod). |
| `serve.mjs` | Static file server (`http://localhost:8088`). |
| `seed.mjs` / `seed-snapshot.mjs` | WebTorrent seeders for the snapshot. |
| `tools/block-server.mjs` | RPC→HTTP block source (`/blocks/<start>/<count>`) used by fullchain.html. |
| `tools/fullchain-node.mjs` | Reference genesis→tip SwiftSync run → `af37b01d` (Node). |
| `tools/swiftsync-commit.mjs` | Streams the full snapshot → `af37b01d`, RSS ~0.9 GB. |
| `tools/reach-tip.mjs` | Reaches the live tip in Node by keeping only spent coins. |
| `tools/swiftsync-hints.mjs`, `tools/gen-snapshot.mjs` | Hints generation / snapshot generation. |

**Signaling provider:** `melvincarvalho.com` / `jss.live` run **JavaScriptSolidServer** with
`--webrtc`. Room mode (`wss://pod/.webrtc`, content-addressed, **no auth**) is what we use; it also
speaks the WebTorrent tracker protocol. Room signaling has **no ICE-candidate relay** → all peers
use **non-trickle ICE** (candidates bundled into the SDP). See `memory: jss-webrtc-signaling`.

---

## 6. Tests

`npm test` (self-contained, no network): `validate-node-test`, `adversarial-test`,
`follow-node-test`, `snapshot-node-test`, `wasm-secp-test`, `swiftsync-test`,
`tools/swiftsync-hints`. **Network/transport tests** (need the bridge / a peer, run manually):
`test-webrtc-bridge.mjs` (browser-equiv ↔ bridge ↔ TCP handshake), `test-mesh.mjs` (peer→peer block
relay), `test-paginate.mjs` (getheaders pagination to 5000), `live-node-test.mjs`.

**Pattern:** prove network-dependent logic **node-side first** (compose `signaling-stub` +
`bridge-webrtc` + `connectAsOfferer/Answerer`) before shipping the browser equivalent — the browser
RTCPeerConnection mirrors node-datachannel.

---

## 7. Honest status & gaps (toward a full node)

| Capability | Status | Note |
|---|---|---|
| P2P networking | ✅ (with a bridge) | Browsers can't TCP; the bridge is the one irreducible non-browser piece. |
| Header chain → tip + follow | ✅ | Full PoW/BIP94/linkage/reorg, OPFS-persisted; `tail()` follows. |
| Full block validation engine | ✅ | Real (scripts, sigs, witness, maturity), on a **bounded** sample. |
| UTXO set at scale | ⛔ | The 25 GB wall — a tab can't hold the full set. |
| Block download at scale into the tab | ⛔ | `getheaders`/`getdata` proven (~750 blk/s); no full-chain pull wired. testnet4 block data ≈ **13 GB**. |
| assumeUTXO snapshot verification | ✅ | `verify.html` → `af37b01d`, 14.1M coins, 32 bytes. |
| SwiftSync full-chain (set-consistency) | 🟡 | Node tools + fullchain.html via block-server; not click-and-run in-browser. |
| WebRTC bridge (reachable anywhere) | ✅ | Signaled by a JSS pod; verified browser↔sandbox over the internet. |
| **Block propagation (mesh)** | 🟡 | `mesh.html`: browser↔browser, 5000 blocks, **2 peers**, structure+PoW only. |
| Serve/announce to peers (inv out, getdata serve, multi-hop) | ⛔ | Browser is client-only today; mesh relay is one-directional seed→leech. |
| Full-consensus validation of relayed blocks | ⛔ | Mesh validates structure+PoW, not against a UTXO set. |

---

## 8. Roadmap / extension points (the goals)

**Clean-up / documentation**
- Reconcile `AGENT.md` (this), `AGENTS.md`, `manifest.json`, `README.md` — single source of truth.
- `mesh.html` has dead code from the removed single-block demo (`have` map, `inv`/`getdata`
  handlers, `MSG_BLOCK`) — prune.
- Cache strategy: gh-pages serves `max-age=600`; after a deploy, hard-reload. If a **worker**'s API
  changes, version-pin its URL (`node-worker.js?b=BUILD`) to avoid stale-cache `handlers[cmd]` errors.

**Other networks** — the engine already parameterizes the network (`chain.jsonld`: `btc:mainnet`,
`btc:testnet`, `btc:testnet4`). Pages currently hardcode `'btc:testnet4'`, the genesis vector
(`data/testnet4.json`), magic, and port (48333). Generalize: a `?network=` param + per-network
vectors/peers, and a network-agnostic bridge target.

**Wallets on top** — `engine/codec/{wallet,spv,filters,nostr}.js` exist but are unwired. Natural
build: an **SPV wallet riding `tip.html`/`live-feed`** — key mgmt, address derivation, watch via
compact filters or merkle proofs against the followed headers, build+sign (WASM secp), broadcast a
`tx` message over the bridge. This is an *app on the node*, deliberately kept out of the node core.

**Propagation (mesh) next steps** — bigger counts (5000 → 10k+, watch the data-channel limits;
oversized-block chunking is a TODO, see `MAX_MSG` in mesh.html) · **N-peer mesh** (3+ tabs, gossip)
· **multi-hop** (the leech re-seeds onward) · **full-consensus relay** (validate against the
UTXO/SwiftSync path before relaying).

**Full validation at scale** — the unsolved core: stream blocks + a SwiftSync **hints** file +
just-in-time prevouts so the tab validates scripts to the tip without ever holding the full set.

---

## 9. Conventions & gotchas

- **Deploy:** branch `gh-pages` → `bitcoin-kernel.com/browser-node/` (also `bitcoin-kernel.github.io`).
  Commit/push only when asked. After push, Pages rebuilds in ~1 min; browsers cache 10 min
  (hard-reload to see changes).
- **No large data files in git** — distribute via WebTorrent (snapshot) or fetch from the network
  (blocks). `data/` holds only small samples/vectors; `data/snapshot-full.dat` is gitignored.
- **Rooms:** the **mesh** uses its own room (`c0ffeebabe123456`); the **bridge** uses a different
  one (`b17c0192abad1deacafe`). A mesh tab in the bridge's room would pair with the bridge, not a peer.
- **Non-trickle ICE** everywhere (room signaling has no candidate relay).
- **The bridge can withhold but never forge** — the tab validates everything; a relay can eclipse,
  not fabricate.
- **Don't break working pages.** New/experimental work goes on a **new** page; `node.html` etc. are
  load-bearing. Verify only the intended file changed (`git status`) and that referenced element IDs
  still exist before shipping a UI edit.

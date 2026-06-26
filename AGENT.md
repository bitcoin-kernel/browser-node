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
| `mesh.html` | 🟡 | **Browser↔browser block propagation.** N tabs become Bitcoin peers over WebRTC (no server in the data path) and form a **full mesh**; "Seed N" (`?blocks=`) pulls real blocks from the network (via the bridge) and relays them across the mesh, validated (structure + PoW) on every peer; received blocks are **gossiped onward** (seen-set dedup). `?gossip=1` sends each block to one neighbor so the mesh carries it multi-hop. Staged to 25k blocks; oversized blocks (>200 KB, e.g. testnet4 ~70k+) are skipped pending chunking. |
| `how-it-works.html` | ✅ | Narrative blog post with SVG diagrams. |
| `keys.html` | ✅ | **Generate or import a testnet4 wallet** — the one page with private keys. A 12-word **BIP39** mnemonic (generate, or import from any wallet) → private/hardened BIP32 (WASM secp `pointFromScalar`/`privateAdd`) → account **tpub** + receiving addresses. Throwaway/testnet; keys live only in-tab. |
| `spv.html` | 🟡 | **Watch-only SPV wallet.** ① derive receiving addresses from an xpub/tpub (`Bip32`); ② **SPV merkle-proof** inclusion (`SpvEngine`, BIP37 proof built from a block); ③ **scan** the chain (full-block, over the bridge) for payments → UTXOs + balance. No private keys. |

**URL params (shared):** `?signal=wss://<pod>/.webrtc` (WebRTC signaling) · `?room=<hex>`
(`[a-f0-9]{8,128}`) · `?bridge=ws://host:8334` (WS bridge) · `?replay=1` (node/fullnode: re-watch
the genesis→tip header climb) · mesh `?bridgeRoom=<hex>` (the seed's network source room) · mesh
`?blocks=N` (seed count, default 5000) · mesh `?gossip=1` (source sends to one neighbor; the mesh gossips it onward).

---

## 4. Browser modules (main thread / worker)

- **`peer-ws.js` (`WsPeer`)** — Bitcoin p2p over a WebSocket to `bridge.mjs`. API: `connect / send /
  waitFor / collect / close`.
- **`peer-rtc.js` (`RtcPeer`)** — same API over a WebRTC data channel to `bridge-webrtc.mjs`
  (offerer; non-trickle ICE; room handshake).
- **`peer-mesh.js` (`MeshPeer`)** — browser↔browser, **N-peer full mesh**: on join, offer to every
  existing peer and answer every later joiner. `send()` broadcasts; `forward()` re-broadcasts to all
  but the sender (gossip); `sendToOne()` for gossip mode; `onPeers(count)` reports the live count.
- **`live-feed.js`** — `connect({bridgeUrl | signalUrl, room, schemas, vectors, persist})` picks
  WsPeer vs RtcPeer; `syncToTip` (one-shot), `tail` (follow + reorgs).
- **`node-worker.js`** — Web Worker validation core. RPC handlers: `init, followRange, checkpoint,
  resume, swiftsync, scaleAccumulate, swiftsyncHints, fullchain, verifySnapshot`.
- **`validate-forward.js`** (`loadEngine`, `coinviewOf`), **`follow-chain.js`** (`applyBlock`,
  `followChain`), **`sharded-utxo-browser.js`** (`ShardedUtxo`, 64 sub-Maps to beat V8's Map cap),
  **`dumptxoutset.js`** (Core snapshot reader), **`opfs-header-store.js` / `opfs-coins-store.js`**
  (persistence), **`wasm-secp.js`** (verify backend).
- **`wasm-keygen.js`** — keys.html only: private/hardened BIP32 via the WASM secp's `pointFromScalar`
  + `privateAdd` (isolated from the verify path), `mnemonicToSeed` (PBKDF2), `generateMnemonic`
  (BIP39, bundled wordlist). The only module touching private keys.

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
relay), `test-paginate.mjs` (getheaders pagination to 5000), `test-mesh-npeer.mjs` (3-peer full mesh +
broadcast), `test-mesh-multihop.mjs` (A→B→C line, multi-hop), `test-mesh-gossip.mjs` (full mesh,
source→one→all via gossip), `test-cfilter-probe.mjs` (BIP157 service probe), `test-scan.mjs` (wallet
scan finds a watched output over the network), `live-node-test.mjs`. **Wallet crypto tests** (no
network): `test-spv-derive.mjs` (address derivation vs BIP84), `test-spv-proof.mjs` (SPV merkle
proof vs a real block), `test-keygen.mjs` (private BIP32 vs BIP32 vector 1), `test-bip39.mjs`
(BIP39 generate + import vs the vectors).

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
| **Block propagation (mesh)** | 🟡 | `mesh.html`: browser↔browser **full mesh** (N peers) + **gossip** forwarding (seen-set), staged to 25k blocks; structure+PoW only. |
| Multi-hop / gossip | ✅ | A block reaches peers the source never sent to (proven node-side A→B→C; visible in-browser with `?gossip=1`). |
| Serve `getdata` / `inv` request flow between peers | 🟡 | The mesh forwards blocks it receives, but doesn't yet serve arbitrary `getdata` or do `inv`-based requests. |
| Full-consensus validation of relayed blocks | ⛔ | Mesh validates structure+PoW, not against a UTXO set. |

---

## 8. Roadmap / extension points (the goals)

**Clean-up / documentation**
- Reconcile `AGENT.md` (this), `AGENTS.md`, `manifest.json`, `README.md` — single source of truth.
- Oversized-block **chunking**: blocks >200 KB (`MAX_MSG` in mesh.html) are skipped — split them
  across data-channel messages + reassemble to propagate past testnet4's big-block region (~70k+).
- Cache strategy: gh-pages serves `max-age=600`; after a deploy, hard-reload. If a **worker**'s API
  changes, version-pin its URL (`node-worker.js?b=BUILD`) to avoid stale-cache `handlers[cmd]` errors.

**Other networks** — the engine already parameterizes the network (`chain.jsonld`: `btc:mainnet`,
`btc:testnet`, `btc:testnet4`). Pages currently hardcode `'btc:testnet4'`, the genesis vector
(`data/testnet4.json`), magic, and port (48333). Generalize: a `?network=` param + per-network
vectors/peers, and a network-agnostic bridge target.

**Wallet — built (watch-only + keygen):** `keys.html` (BIP39 generate/import → tpub, `wasm-keygen.js`)
and `spv.html` (① derive · ② SPV merkle-proof via `SpvEngine` · ③ chain scan → balance, over the
bridge). Naming: `keys.html` = keys, `spv.html` = watch-only, **`wallet.html` reserved for spending**.
Honest gaps: no compact-filter/bloom peer reachable (`test-cfilter-probe.mjs`: services `0xc09`), so
scanning is full-block (cheap for a recent range) and SPV proofs are self-built; generating a mnemonic
needs the bundled wordlist (`data/bip39-english.txt`). **Next: signing/spending** — the WASM secp
exposes `sign`/`signSchnorr`; build+sign a tx (PSBT in `wallet.js`), broadcast a `tx` over the bridge.
`engine/codec/filters.js` (BIP158) and `nostr.js` remain unwired.

**Propagation (mesh) — done:** N-peer full mesh · gossip forwarding (seen-set) · visible multi-hop
(`?gossip=1`) · staged `?blocks=` to 25k. **Next:** oversized-block **chunking** (the wall at
testnet4 ~70k+, multi-MB blocks) to reach the full chain · **full-consensus relay** (validate against
the UTXO/SwiftSync path before relaying, not just structure+PoW).

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

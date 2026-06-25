---
name: bitcoin-kernel/browser-node
version: 0.0.1
description: A Bitcoin testnet4 node's validation core running in a browser tab.
network: testnet4
homepage: http://bitcoin-kernel.com/browser-node/
license: AGPL-3.0-or-later
machine_readable_manifest: ./manifest.json
agent_guide: ./AGENTS.md
built_on:
  - bitcoin-kernel/node
  - "@bitcoin-desktop/schema (vendored under engine/)"
acts:
  - { id: 1, name: bootstrap UTXO from a torrented snapshot, runs_on: local-server }
  - { id: 3, name: validate a block forward,                 runs_on: github-pages }
  - { id: 4, name: follow the chain,                          runs_on: github-pages }
  - { id: 5, name: live header feed over a WS-to-TCP bridge,  runs_on: local-server }
  - { id: 6, name: parse Core's dumptxoutset snapshot,        runs_on: github-pages }
---

# bitcoin-kernel / browser-node

**A Bitcoin testnet4 node's validation core, running in a browser tab.**

Bootstrap a UTXO set from a torrented or Bitcoin Core *assumeUTXO* snapshot, validate blocks
forward against it (scripts, signatures, fees, all consensus rules), follow the chain by applying
each block to the UTXO set, and live-sync the header chain from a real peer over a WebSocket-to-TCP
bridge — all in the tab. The pure-JS consensus engine ([`@bitcoin-desktop/schema`](https://github.com/bitcoin-desktop/schema))
and the browser-node design ([`bitcoin-kernel/node`](https://github.com/bitcoin-kernel/node)) do the work.

▶ **Live demo:** http://bitcoin-kernel.com/browser-node/ (use buttons ③ ④ ⑥; ① ⑤ need a local server)

> Status: demo / proof-of-concept. Machine-readable manifest: [`manifest.json`](./manifest.json). Agent guide: [`AGENTS.md`](./AGENTS.md).

## What it does — six acts

| # | Act | Proves | Runs on | Verified |
|---|-----|--------|---------|----------|
| ① | **Bootstrap UTXO from a torrented snapshot** | a snapshot fetched over WebTorrent/HTTP streams into a sharded coin view | local server | 250k coins in 0.11s; full scale 14.1M = 3.23 GB / 9.7s |
| ③ | **Validate a block forward** | one real block fully validated (scripts, BIP143 sigs, fees, maturity, witness commitment) | **GitHub Pages** | block #26000, 16/16 rules, 45ms; rejects a 1‑sat tamper |
| ④ | **Follow the chain** | consecutive blocks validated, applying UTXO updates so later blocks spend earlier outputs; linkage checked | **GitHub Pages** | blocks 26000–26020, UTXO 249→1,361, 1.1s |
| ⑤ | **Live feed over a WS↔TCP bridge** | the tab speaks p2p over a bridge to a real peer, syncs + fully validates the header chain (PoW, BIP94, reorg), tails the tip, and persists to **OPFS** | local server | 141,671 headers genesis→tip in 5.8s; reload **resumes from OPFS in 1.7s** |
| ⑥ | **Parse Core's `dumptxoutset` snapshot** | Core's real assumeUTXO snapshot (v2 compressed format) parsed in-tab and used as a validating coin view | **GitHub Pages** | full 811 MB file → 13,870,119 coins, 40/40 match `gettxout`; block #120001 validated, 85ms |
| ⑦ | **Persist the UTXO set (OPFS)** | the RAM-resident coin view is checkpointed to OPFS and resumes from disk on reload | **GitHub Pages** | 16,913 coins → 2.5 MB checkpoint (17ms); reload resumes in 11ms |
| ⑨ | **WASM signature verification** | a WASM libsecp256k1 backend swapped in via `setVerifyBackend`, gated by verdict-equivalence | **GitHub Pages** | block #26000: ~1,161 → ~4,895 verifies/s (4.2× at block level), verdicts identical |
| ⑩ | **Run the node in a Web Worker (scale)** | engine + WASM secp + UTXO store + OPFS sync-handles run off the main thread, so validation/checkpoints don't freeze the UI | **GitHub Pages** | follow 21 blocks in a Worker: UI responsive (16 ms frame gap) vs frozen on the main thread (~1063 ms) |

Acts ③ ④ ⑥ are fully static and work on GitHub Pages. Acts ① (torrent seeding) and ⑤ (the bridge) need a
local server — see below.

## Run it

### On GitHub Pages (no install)
Open http://bitcoin-kernel.com/browser-node/ and click ③, ④, ⑥.

### Locally
```sh
node serve.mjs            # static server + HTTP Range on http://localhost:8088 (zero deps)
# open http://localhost:8088 -> acts ②③④⑥ work
```

Act ① (WebTorrent):
```sh
node tools/gen-snapshot.mjs 250000 snapshot.ndjson   # generate a synthetic UTXO snapshot
npm install                                          # webtorrent
node serve.mjs &                                     # webseed host
node seed.mjs                                         # seeds + writes magnet.txt, then click ①
```

Act ⑤ (live feed) — needs a testnet4 peer; a local `bitcoind -testnet4` (P2P :48333) works:
```sh
npm install                                          # ws
node bridge.mjs                                       # ws://localhost:8334 -> 127.0.0.1:48333
# or point elsewhere: PEER_HOST=seed.testnet4.bitcoin.sprovoost.nl node bridge.mjs
# then click ⑤
```

### Tests (self-contained, committed data only)
```sh
npm test   # validate #26000, adversarial tamper, follow 26000–26020, parse + validate #120001
```

## Architecture

```
index.html              the six acts, wired together
sharded-utxo-browser.js ShardedUtxo — coin view sharded past V8's 16.7M Map cap
validate-forward.js     load engine + coin view, validate one block forward
follow-chain.js         applyBlock() + followChain() — validate a run, update the UTXO set
dumptxoutset.js         parser for Bitcoin Core's dumptxoutset v2 compressed snapshot format
live-feed.js            connect + syncToTip + tail (header sync over the bridge)
opfs-header-store.js    persist the header chain to OPFS (main-thread async) — resume on reload
opfs-coins-store.js     checkpoint the UTXO set (ShardedUtxo) to OPFS — resume on reload
wasm-secp.js            WASM libsecp256k1 backend (tiny-secp256k1 wasm) for setVerifyBackend
secp256k1.wasm          the libsecp256k1 binary (1.2 MB — the one large file in the repo)
node-worker.js          the validation core in a Web Worker (engine + WASM secp + UTXO + OPFS sync handles)
peer-ws.js              WsPeer — Bitcoin p2p over a WebSocket (browser transport)
engine/                 vendored @bitcoin-desktop/schema: consensus engine + schemas + stores
serve.mjs               zero-dep static server (local)
seed.mjs                WebTorrent seeder for act ① (optional, needs webtorrent)
bridge.mjs              WebSocket-to-TCP bridge for act ⑤ (optional, needs ws)
tools/gen-snapshot.mjs  generate a synthetic UTXO snapshot for act ①
data/                   small committed fixtures (see Data & provenance)
```

## Data & provenance

All fixtures are small and derived from real testnet4 data via a Bitcoin Core node (no third-party APIs):

| File | What | Origin |
|------|------|--------|
| `data/block-26000.hex`, `data/block-120001.hex` | raw blocks | `bitcoin-cli getblock <hash> 0` |
| `data/snapshot-26000.ndjson` | block 26000's prevouts | `getblock <hash> 3` (verbosity-3 prevouts) |
| `data/range.json`, `data/range-seed.ndjson` | blocks 26000–26020 + pre-run prevouts | `getblock` raw + verbosity-3 |
| `data/utxo-prefix.dat` | first 1 MB of `utxo-testnet4-120000.dat` | a real Core `dumptxoutset` snapshot (the full file is ~811 MB; only a prefix is committed) |
| `data/snapshot-120001.ndjson` | block 120001's pre-snapshot prevouts | **extracted by parsing the Core `.dat`** with `dumptxoutset.js` |
| `data/testnet4.json` | genesis header + retarget vectors | from `@bitcoin-desktop/schema` |

The synthetic snapshot for act ① is **not** committed; generate it with `tools/gen-snapshot.mjs`.

## Trust model

The bridge and the torrent/HTTP transports are **untrusted** — they cannot forge valid blocks or
headers, because the tab validates everything (PoW, difficulty, scripts, signatures, fees). Their
only powers are *withholding* and *eclipsing*. assumeUTXO trusts the snapshot's UTXO set until a
background re-validation from genesis (not included in this demo) confirms it.

## Not done yet

- **One continuous pipeline (capstone)** — bootstrap at a tip-height assumeUTXO snapshot, then let the
  live header feed (⑤) drive forward block validation (④) inside the worker (⑩), tying all acts into one
  running node. Needs a snapshot at the live tip plus downloading/validating the blocks in between
  (the WASM secp backend and the worker are already in place).

## License & attribution

[AGPL-3.0-or-later](./LICENSE). Built on [`bitcoin-kernel/node`](https://github.com/bitcoin-kernel/node)
and [`@bitcoin-desktop/schema`](https://github.com/bitcoin-desktop/schema) (vendored under `engine/`,
unmodified except import-path rewrites). See [`NOTICE`](./NOTICE).

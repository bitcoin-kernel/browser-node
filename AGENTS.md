# AGENTS.md

Guidance for AI agents and automated tooling working in this repo. Structured facts are in
[`manifest.json`](./manifest.json); this file is the prose orientation.

## What this is
A Bitcoin **testnet4** node's validation core that runs in a browser tab. Six "acts" (①–⑥) each
demonstrate one capability; see the table in [`README.md`](./README.md) and the `acts` array in
`manifest.json`. The consensus engine is vendored under `engine/` from `@bitcoin-desktop/schema`
and must be treated as **upstream, unmodified** (only import specifiers were rewritten to relative
paths). Do not edit `engine/`; change the app modules instead.

## Layout
- App modules (browser): `index.html`, `sharded-utxo-browser.js`, `validate-forward.js`,
  `follow-chain.js`, `dumptxoutset.js`, `live-feed.js`, `peer-ws.js`.
- Engine (vendored): `engine/codec/*.js`, `engine/schema/*.jsonld`, `engine/store/*.js`, `engine/chain/*.js`.
- Servers (local, Node ESM): `serve.mjs` (no deps), `seed.mjs` (webtorrent), `bridge.mjs` (ws).
- Node tests (self-contained): `validate-node-test.mjs`, `adversarial-test.mjs`, `follow-node-test.mjs`,
  `snapshot-node-test.mjs`. Also `live-node-test.mjs` (needs the bridge + a peer).
- Data: `data/` (small fixtures). The 35 MB synthetic snapshot is generated, not committed.

## How to run / verify
```sh
npm test                 # self-contained: validate, adversarial, follow, snapshot (committed data)
node serve.mjs           # http://localhost:8088 ; acts ②③④⑥ work with no other setup
```
- Acts ③④⑥ are static → work on GitHub Pages and via `serve.mjs`.
- Act ① needs `tools/gen-snapshot.mjs` + `seed.mjs` (webtorrent) + `serve.mjs`.
- Act ⑤ needs `bridge.mjs` (ws) and a testnet4 peer (e.g. `bitcoind -testnet4`, P2P :48333).

## Invariants / constraints
- **Network is testnet4** throughout (genesis vector, network magic `1c163f28`, port 48333).
- The browser cannot open raw TCP; live p2p must go through `bridge.mjs` (the WS↔TCP relay).
- Transports are untrusted by design — the tab validates everything; do not "optimize" by skipping
  validation. The 1-satoshi tamper test (`adversarial-test.mjs`) must keep failing the `scripts` rule.
- Keep committed data small. Do not commit large binaries; regenerate via `tools/` or `bitcoin-cli`
  (provenance is documented in `README.md`).
- Engine value/script formats: coin view records are `"sats\tscriptPubKeyHex\theight\tcoinbase(0|1)"`;
  the engine coin view is `{ get(key) -> { output:{value,scriptPubKey}, height, coinbase } }`,
  key = `"txid:vout"`.

## Hosting
GitHub Pages serves the `gh-pages` branch root (`.nojekyll` is present). The default branch is
`gh-pages`. Pages URL: http://bitcoin-kernel.com/browser-node/.

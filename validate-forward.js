// Forward block validation in the browser, built on the bitcoin-kernel engine
// (@bitcoin-desktop/schema, staged under ./engine). Loads the consensus engine,
// builds a coin view from a snapshot, then fully validates the next real block
// against it — prevout resolution, scripts/signatures, fees, maturity, witness
// commitment. Same code path proven in Node; here fetch() replaces fs.
import { Codec } from './engine/codec/codec.js';
import { BlockEngine } from './engine/codec/blocks.js';
import { ShardedUtxo } from './sharded-utxo-browser.js';

let codec = null, be = null;
const jl = async (n) => (await fetch(`./engine/schema/${n}.jsonld`)).json();

export async function loadEngine(log) {
  if (be) return { codec, be };
  log?.('loading consensus engine + schemas…');
  codec = new Codec(await jl('core'), await jl('proof'));
  be = BlockEngine.fromSchemas(codec, await jl('chain'), await jl('validate'), await jl('script'), 'btc:testnet4');
  log?.('engine ready (default pure-JS secp256k1)', 'ok');
  return { codec, be };
}

// Wrap a ShardedUtxo as an engine coin view. Reads live, so mutating the snap
// (e.g. applyBlock during a chain-follow) is reflected immediately.
// "sats\tspk\theight\tcoinbase" -> {output:{value,scriptPubKey},height,coinbase}
export function coinviewOf(snap) {
  return { get(key) {
    const v = snap.get(key); if (v === undefined) return undefined;
    const a = v.split('\t');
    return { output: { value: Number(a[0]), scriptPubKey: a[1] }, height: Number(a[2]), coinbase: a[3] === '1' };
  }};
}

// Parse a snapshot NDJSON into a ShardedUtxo and wrap it as an engine coin view.
export async function loadCoinView(url, log) {
  const snap = new ShardedUtxo(64);
  const text = await (await fetch(url)).text();
  let first = true, meta = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (first) { meta = JSON.parse(line); first = false; continue; }
    const [k, v] = JSON.parse(line); snap.set(k, v);
  }
  const coinview = coinviewOf(snap);
  log?.(`coin view ready: ${snap.size} coins at height ${meta.height}`, 'ok');
  return { snap, coinview, meta };
}

export async function validateForward({ blockUrl, height, coinview }, log) {
  const { codec, be } = await loadEngine(log);
  const hex = (await (await fetch(blockUrl)).text()).trim();
  const block = codec.decode('Block', hex);
  log?.(`decoded block ${height}: ${block.transactions.length} txs, ${hex.length / 2} bytes`);
  // prevout resolution against the coin view (the assumeUTXO payoff)
  const NULL = '00'.repeat(32);
  let inputs = 0, resolved = 0;
  for (const tx of block.transactions) for (const inp of tx.inputs) {
    if (inp.prevout.txid === NULL) continue;
    inputs++;
    if (coinview.get(`${inp.prevout.txid}:${inp.prevout.vout}`)) resolved++;
  }
  const t0 = performance.now();
  const structure = be.validateBlockStructure(block).results;
  const context = be.validateBlockContext(block, { height, utxo: coinview }).results;
  const ms = performance.now() - t0;
  const failed = [...structure, ...context].filter(r => r.ok === false).length;
  return { txs: block.transactions.length, inputs, resolved, structure, context, ms, ok: failed === 0 };
}

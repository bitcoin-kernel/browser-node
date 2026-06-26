// A tiny persistent wallet state: the set of UTXOs the wallet knows it owns, so it
// can show a balance and pick coins without re-scanning the chain. Keyed per wallet
// (by its 0/0 address) in localStorage. The apply() logic is pure + node-proven
// (test-walletstore.mjs); only load()/save() touch the browser. No private keys.

const STORE_KEY = (id) => `bkbn:utxos:${id}`;

export function loadSet(id) {
  try { return JSON.parse(globalThis.localStorage?.getItem(STORE_KEY(id)) || '{}'); }
  catch { return {}; }
}
export function saveSet(id, set) {
  try { globalThis.localStorage?.setItem(STORE_KEY(id), JSON.stringify(set)); } catch { /* no storage */ }
}

// Apply a transaction to a UTXO set: drop every input it spends, and add every
// output that pays one of our own scripts (change + self-payments). Pure: returns
// a new set. `ownScripts` is a Map(scriptPubKey hex → address).
export function applyTx(set, tx, ownScripts, codec) {
  const out = { ...set };
  for (const inp of tx.inputs) delete out[`${inp.prevout.txid}:${inp.prevout.vout}`];
  const txid = codec.txid(tx);
  tx.outputs.forEach((o, vout) => {
    if (ownScripts.has(o.scriptPubKey)) out[`${txid}:${vout}`] = { txid, vout, value: o.value, scriptPubKey: o.scriptPubKey, address: ownScripts.get(o.scriptPubKey) };
  });
  return out;
}

// Record a UTXO we're about to spend (e.g. arrived via a link, or hand-entered)
// so the balance reflects it before the spend lands.
export function addUtxo(set, { txid, vout, value, scriptPubKey, address }) {
  return { ...set, [`${txid}:${vout}`]: { txid, vout, value, scriptPubKey, address } };
}
export function removeUtxo(set, txid, vout) { const out = { ...set }; delete out[`${txid}:${vout}`]; return out; }
export function listUtxos(set) { return Object.values(set).sort((a, b) => b.value - a.value); }
export function balance(set) { return listUtxos(set).reduce((s, u) => s + u.value, 0); }

// Follow the chain: validate a run of consecutive blocks, applying each to the
// UTXO set so the next block can spend its outputs. This is the step from
// "accepts a block" to "follows the chain" — a real node's inner loop.
const NULL_TXID = '00'.repeat(32);

// Apply a validated block to the UTXO set: remove spent prevouts, add new
// outputs (skipping unspendable OP_RETURN). Mutates `snap` in place.
export function applyBlock(snap, block, height, codec) {
  let spent = 0, created = 0;
  for (let ti = 0; ti < block.transactions.length; ti++) {
    const tx = block.transactions[ti];
    const txid = codec.txid(tx);
    for (const inp of tx.inputs) {
      if (inp.prevout.txid === NULL_TXID) continue;
      snap.delete(`${inp.prevout.txid}:${inp.prevout.vout}`); spent++;
    }
    for (let v = 0; v < tx.outputs.length; v++) {
      const o = tx.outputs[v];
      if (typeof o.scriptPubKey === 'string' && (o.scriptPubKey.startsWith('6a') || o.scriptPubKey.length > 20000)) continue; // Core IsUnspendable: OP_RETURN or >10 KB
      snap.set(`${txid}:${v}`, `${o.value}\t${o.scriptPubKey}\t${height}\t${ti === 0 ? 1 : 0}`);
      created++;
    }
  }
  return { spent, created };
}

// Validate blocks start..end against a live coin view, applying each on success.
// Verifies linkage (each block builds on the previous hash) — the foundation for
// reorg handling. Stops at the first invalid block. Calls onBlock per block.
export async function followChain({ range, codec, be, snap, coinview, onBlock }) {
  let prevHash = null, validated = 0;
  const results = [];
  for (let i = 0; i < range.blocks.length; i++) {
    const height = range.start + i;
    const block = codec.decode('Block', range.blocks[i]);
    const hash = codec.blockHash(block.header);
    const linked = prevHash === null ? null : block.header.prevBlockHash === prevHash;

    let inputs = 0, fromSet = 0;
    for (const tx of block.transactions) for (const inp of tx.inputs) {
      if (inp.prevout.txid === NULL_TXID) continue;
      inputs++;
      if (coinview.get(`${inp.prevout.txid}:${inp.prevout.vout}`)) fromSet++;
    }

    const t0 = performance.now();
    const struct = be.validateBlockStructure(block).results;
    const ctx = be.validateBlockContext(block, { height, utxo: coinview }).results;
    const ms = performance.now() - t0;
    const failed = [...struct, ...ctx].filter(r => r.ok === false).map(r => r.rule);
    const ok = failed.length === 0 && linked !== false;

    let applied = { spent: 0, created: 0 };
    if (ok) applied = applyBlock(snap, block, height, codec);

    const rec = { height, hash, txs: block.transactions.length, inputs, fromSet,
                  intraBlock: inputs - fromSet, linked, ok, failed, ms, applied, utxoSize: snap.size };
    results.push(rec); onBlock?.(rec);
    if (!ok) break;
    prevHash = hash; validated++;
  }
  return { validated, total: range.blocks.length, results };
}

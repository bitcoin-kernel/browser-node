// SwiftSync driver — walk a sequence of blocks, feeding the accumulator: every
// output created is added, every non-coinbase input spent is removed. Over a
// contiguous range starting at genesis the residual accumulator equals the UTXO
// set at the final block (all outputs − all inputs).
//
// This is the assumevalid shape (outpoint-only elements, no script execution).
// The full version swaps encodeOutpoint → encodeCoin and pulls prevout data from
// undo data; the walk is the same.
//
// Engine-agnostic: the caller injects txidOf(tx) (e.g. the kernel codec's txid)
// and the Accumulator, so this package imports no engine code.

import { encodeOutpoint } from './index.js';

const NULL_TXID = '00'.repeat(32);
// Bitcoin Core's IsUnspendable(): OP_RETURN, OR scriptPubKey > MAX_SCRIPT_SIZE
// (10000 bytes = 20000 hex). Such outputs are never added to the chainstate /
// dumptxoutset, so they must be excluded from the accumulator to match Core.
const isUnspendable = (spk) => typeof spk === 'string' && (spk.startsWith('6a') || spk.length > 20000);

// blocks: iterable of decoded blocks (each { transactions:[{ inputs, outputs }] }).
// opts: { txidOf(tx)->hex, acc:Accumulator }. Returns acc.
export function applyBlocks(blocks, { txidOf, acc }) {
  for (const block of blocks) {
    for (const tx of block.transactions) {
      const txid = txidOf(tx);
      for (let v = 0; v < tx.outputs.length; v++) {
        if (isUnspendable(tx.outputs[v].scriptPubKey)) continue; // not in the UTXO set
        acc.add(encodeOutpoint({ txid, vout: v }));
      }
      for (const inp of tx.inputs) {
        if (inp.prevout.txid === NULL_TXID) continue;          // coinbase has no prevout
        acc.spend(encodeOutpoint({ txid: inp.prevout.txid, vout: inp.prevout.vout }));
      }
    }
  }
  return acc;
}

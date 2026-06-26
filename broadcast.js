// Broadcast a signed transaction to a testnet4 peer — over the WebRTC bridge in
// the browser (wallet.html), over raw TCP in the node proof (test-broadcast.mjs).
// Standard relay flow, identical on both transports:
//   inv(MSG_TX, txid)  → the peer requests it with getdata
//   tx                 → we send the transaction
//   getdata(MSG_TX)    → re-query it: a mempool-accepted tx is served back to us
//                        as `tx`; a rejected one comes back `notfound`.
// `peer` is anything with send(command, payload) and waitFor([commands], ms)
// returning { command, payload } — RtcPeer / WsPeer and the test harness all fit.
// This module never sees a private key; it only moves the finished bytes.

const MSG_TX = 1;

export async function broadcastTx(peer, tx, codec, { requestTimeoutMs = 15000, confirmTimeoutMs = 8000, settleMs = 1500 } = {}) {
  const txid = codec.txid(tx);

  // 1) announce the txid
  peer.send('inv', { items: [{ type: MSG_TX, hash: txid }] });

  // 2) wait for the peer to ask for it (proves the inv was well-formed + relayed)
  let requested = false;
  try {
    const gd = await peer.waitFor(['getdata'], requestTimeoutMs);
    requested = (gd.payload?.items ?? []).some((it) => it.hash === txid);
  } catch { /* no getdata: peer already had it, or doesn't want it */ }
  if (!requested) return { txid, requested: false, accepted: null, detail: 'peer did not request the tx (already known, or relay disabled)' };

  // 3) hand over the transaction
  peer.send('tx', tx);

  // 4) confirm acceptance: re-query. Accepted → served back as `tx`; rejected → `notfound`.
  await new Promise((r) => setTimeout(r, settleMs));   // give the peer time to validate + admit
  peer.send('getdata', { items: [{ type: MSG_TX, hash: txid }] });
  try {
    const res = await peer.waitFor(['tx', 'notfound'], confirmTimeoutMs);
    const accepted = res.command === 'tx' && codec.txid(res.payload) === txid;
    return { txid, requested: true, accepted, detail: res.command };
  } catch {
    return { txid, requested: true, accepted: null, detail: 'no confirm response (timeout)' };
  }
}

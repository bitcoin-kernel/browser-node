// Broadcast a signed transaction to testnet4 peer(s) — over the WebRTC bridge in
// the browser (wallet.html), over raw TCP in the node proofs.
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

  // 2) wait for the peer to ask for it; if it doesn't, it may already have the tx
  //    (relayed to it by another peer) — we still confirm below either way.
  let requested = false;
  try {
    const gd = await peer.waitFor(['getdata'], requestTimeoutMs);
    requested = (gd.payload?.items ?? []).some((it) => it.hash === txid);
  } catch { /* no getdata: peer already had it, or doesn't want it */ }

  // 3) hand over the transaction if it was requested
  if (requested) { peer.send('tx', tx); await new Promise((r) => setTimeout(r, settleMs)); }

  // 4) confirm acceptance by re-querying: a tx in the mempool is served back as
  //    `tx` (whether we just sent it or it was already known), a missing one as
  //    `notfound`. This makes "already known" read as accepted, not a failure.
  peer.send('getdata', { items: [{ type: MSG_TX, hash: txid }] });
  try {
    const res = await peer.waitFor(['tx', 'notfound'], confirmTimeoutMs);
    const accepted = res.command === 'tx' && codec.txid(res.payload) === txid;
    return { txid, requested, accepted, detail: accepted ? (requested ? 'accepted' : 'already in mempool') : res.command };
  } catch {
    return { txid, requested, accepted: null, detail: 'no confirm response (timeout)' };
  }
}

// Broadcast to several peers, succeeding if ANY admits the tx — so a single peer
// that lacks an unconfirmed parent can't sink the spend, and the tx propagates to
// more of the network. `connectOne(i)` returns a fresh connected peer (browser: a
// new bridge session.peer; node: a TCP adapter); it's called up to `peers` times.
// Stops early once `needAccepts` peers have accepted. Closes each peer when done.
export async function broadcastToPeers(connectOne, tx, codec, { peers = 3, needAccepts = 1, perPeer = {} } = {}) {
  const txid = codec.txid(tx);
  const results = [];
  let accepts = 0;
  for (let i = 0; i < peers; i++) {
    let p = null;
    try {
      p = await connectOne(i);
      const r = await broadcastTx(p, tx, codec, perPeer);
      results.push(r);
      if (r.accepted === true) accepts++;
    } catch (e) {
      results.push({ txid, requested: false, accepted: false, detail: 'connect/relay failed: ' + (e?.message || e) });
    } finally {
      try { p?.close?.(); } catch { /* node adapters provide their own close */ }
    }
    if (accepts >= needAccepts) break;
  }
  return { txid, tried: results.length, accepted: accepts, results };
}

// SwiftSync element encoders, extracted from @bitcoin-kernel/swiftsync index.js
// (construction matches github.com/2140-dev/swiftsync). Only the encoders act ⑪
// needs — no validate/hint/undo deps.
const hexToBytes = (h) => { const n = h.length >> 1; const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; };
// Displayed txid is the reverse of internal/consensus byte order (what the reference hashes).
const txidInternal = (txidHex) => hexToBytes(txidHex).reverse();

// assumevalid element: outpoint only — txid(32, internal) || vout(4 LE)
export function encodeOutpoint({ txid, vout }) {
  const out = new Uint8Array(36);
  out.set(txidInternal(txid), 0);
  new DataView(out.buffer).setUint32(32, vout, true);
  return out;
}

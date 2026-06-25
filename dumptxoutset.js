// Parser for Bitcoin Core's `dumptxoutset` v2 format (the file we torrented:
// utxo-testnet4-120000.dat). Turns Core's compressed UTXO snapshot into the
// node's coin records, so a Core assumeUTXO snapshot becomes a usable coin view.
//
// Layout (confirmed against the real file):
//   header: "utxo\xff"(5) | version u16 | network-magic(4) | base_blockhash(32) | coins_count u64
//   then, per txid: txid(32) | CompactSize(nCoins) | nCoins×[ CompactSize(vout) | Coin ]
//   Coin = VARINT(height*2 + coinbase) | VARINT(CompressAmount(value)) | CompressedScript
// Counts/vout use Bitcoin CompactSize; values inside a Coin use Bitcoin VARINT.

class Underrun extends Error {}

export class DumpReader {
  constructor(bytes) { this.b = bytes; this.p = 0; }
  get eof() { return this.p >= this.b.length; }
  #need(n) { if (this.p + n > this.b.length) throw new Underrun(); }
  u8() { this.#need(1); return this.b[this.p++]; }
  take(n) { this.#need(n); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  u16() { this.#need(2); const v = this.b[this.p] | (this.b[this.p + 1] << 8); this.p += 2; return v; }
  u32() { this.#need(4); const v = (this.b[this.p] | (this.b[this.p + 1] << 8) | (this.b[this.p + 2] << 16) | (this.b[this.p + 3] * 16777216)); this.p += 4; return v >>> 0; }
  u64() { this.#need(8); let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(this.b[this.p + i]) << BigInt(8 * i); this.p += 8; return v; }
  // Bitcoin VARINT (MSB continuation, +1 carry). Returns BigInt.
  varint() { let n = 0n; for (;;) { const ch = this.u8(); n = (n << 7n) | BigInt(ch & 0x7f); if (ch & 0x80) n += 1n; else return n; } }
  compactSize() { const b = this.u8(); if (b < 253) return b; if (b === 253) return this.u16(); if (b === 254) return this.u32(); return Number(this.u64()); }
  // 32-byte hash, stored internal order; return display (reversed) hex.
  hashHex() { const s = this.take(32); let h = ''; for (let i = 31; i >= 0; i--) h += s[i].toString(16).padStart(2, '0'); return h; }
}

const hex = (u8) => { let s = ''; for (const b of u8) s += b.toString(16).padStart(2, '0'); return s; };

// Core's CompressAmount inverse.
function decompressAmount(x) {
  if (x === 0n) return 0n;
  x -= 1n; let e = x % 10n; x /= 10n; let n;
  if (e < 9n) { const d = (x % 9n) + 1n; x /= 9n; n = x * 10n + d; } else { n = x + 1n; }
  while (e > 0n) { n *= 10n; e -= 1n; }
  return n;
}

// CScriptCompressor inverse: special types 0..5, else raw (size-6).
function decompressScript(r, stats) {
  const size = Number(r.varint());
  if (size === 0) return '76a914' + hex(r.take(20)) + '88ac';            // P2PKH
  if (size === 1) return 'a914' + hex(r.take(20)) + '87';                // P2SH
  if (size === 2 || size === 3) return '21' + size.toString(16).padStart(2, '0') + hex(r.take(32)) + 'ac'; // P2PK compressed
  if (size === 4 || size === 5) { r.take(32); if (stats) stats.p2pkUncompressed++; return 'P2PK_UNCOMPRESSED'; } // rare; flagged
  return hex(r.take(size - 6));                                          // raw script (witness etc.)
}

export function parseHeader(r) {
  const m = r.take(5);
  if (!(m[0] === 0x75 && m[1] === 0x74 && m[2] === 0x78 && m[3] === 0x6f && m[4] === 0xff)) throw new Error('bad magic (not a dumptxoutset file)');
  const version = r.u16();
  const netMagic = hex(r.take(4));
  const baseHash = r.hashHex();
  const coinsCount = Number(r.u64());
  return { version, netMagic, baseHash, coinsCount };
}

// Iterate coins, yielding {txid, vout, value(BigInt), scriptPubKey, height, coinbase}.
// Stops at maxCoins, at EOF, or (for a truncated prefix) cleanly on underrun.
export function* coins(r, maxCoins = Infinity, stats = null) {
  let count = 0;
  try {
    while (!r.eof && count < maxCoins) {
      const txid = r.hashHex();
      const n = r.compactSize();
      for (let i = 0; i < n; i++) {
        const vout = r.compactSize();
        const code = Number(r.varint());
        const height = Math.floor(code / 2);
        const coinbase = (code & 1) === 1;
        const value = decompressAmount(r.varint());
        const scriptPubKey = decompressScript(r, stats);
        yield { txid, vout, value, scriptPubKey, height, coinbase };
        if (++count >= maxCoins) return;
      }
    }
  } catch (e) { if (!(e instanceof Underrun)) throw e; /* truncated prefix: stop cleanly */ }
}

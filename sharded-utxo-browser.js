// Browser port of bitcoin-kernel/node src/sharded-utxo.js.
// IDENTICAL sharding + Map-compatible surface; the only change is that the Node
// `load()` (which used node:fs/node:readline) is replaced by browser stream
// parsers. A single V8 Map throws past ~16.7M entries; sharding by a hash of the
// outpoint key spreads entries across N maps (N x 16.7M capacity).
export class ShardedUtxo {
  constructor(shards = 64) {
    this.n = shards;
    this.maps = Array.from({ length: shards }, () => new Map());
  }
  _shard(k) {
    let h = 0; const n = k.length < 16 ? k.length : 16;
    for (let i = 0; i < n; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
    return h % this.n;
  }
  get(k) { return this.maps[this._shard(k)].get(k); }
  set(k, v) { this.maps[this._shard(k)].set(k, v); return this; }
  delete(k) { return this.maps[this._shard(k)].delete(k); }
  has(k) { return this.maps[this._shard(k)].has(k); }
  get size() { let s = 0; for (const m of this.maps) s += m.size; return s; }
  *entries() { for (const m of this.maps) yield* m.entries(); }
  *[Symbol.iterator]() { yield* this.entries(); }
  clear() { for (const m of this.maps) m.clear(); }

  // Parse NDJSON exactly as the Node load() does: line 1 = meta JSON, each
  // subsequent line = JSON.stringify([key, value]). Streamed so we never hold a
  // >512MB string and we can report progress. `bytes` is the total for %.
  async loadFromStream(readable, bytes = 0, onProgress = null) {
    const reader = readable.getReader();
    const dec = new TextDecoder();
    let meta = {}, first = true, tail = '', read = 0, lines = 0;
    const handleLine = (line) => {
      if (!line) return;
      if (first) { meta = JSON.parse(line); first = false; return; }
      const [k, v] = JSON.parse(line);
      this.set(k, v);
      if (onProgress && (++lines & 65535) === 0) onProgress(lines, read, bytes);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      tail += dec.decode(value, { stream: true });
      let nl;
      while ((nl = tail.indexOf('\n')) >= 0) { handleLine(tail.slice(0, nl)); tail = tail.slice(nl + 1); }
    }
    handleLine(tail);
    return meta;
  }
}

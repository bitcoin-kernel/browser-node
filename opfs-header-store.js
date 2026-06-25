// OpfsHeaderStore (main-thread): persists the header chain to the Origin Private
// File System so the node resumes across reloads instead of re-syncing from
// genesis. Same flat 80-byte-per-header layout and same HeaderStore base as the
// Node FileHeaderStore; the upstream engine/store/opfs-header-store.js uses a
// synchronous access handle (Worker-only) — this variant uses the async OPFS API
// (createWritable / getFile) so it runs on the main thread, no Worker needed.
import { HeaderStore } from './engine/store/header-store.js';

export const opfsAvailable = () =>
  typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function';

export class OpfsHeaderStore extends HeaderStore {
  constructor(codec, headerEngine, genesisHeader, filename = 'testnet4-headers.bin') {
    super(codec, headerEngine, genesisHeader);
    this.filename = filename;
  }

  async #fileHandle() {
    const root = await navigator.storage.getDirectory();
    return root.getFileHandle(this.filename, { create: true });
  }

  // Read the persisted chain (if any) and rebuild the in-memory index.
  async load() {
    const fh = await this.#fileHandle();
    const file = await fh.getFile();
    if (file.size) this._ingestBytes(new Uint8Array(await file.arrayBuffer()));
    return this;
  }

  // Persist the whole chain (flat 80-byte headers). Called by HeaderSync after a sync.
  async flush() {
    if (!this._dirty) return;
    const bytes = this._toBytes();
    const fh = await this.#fileHandle();
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    this._dirty = false;
  }

  // Forget the persisted chain (for a "start over" button).
  async clear() {
    try { const root = await navigator.storage.getDirectory(); await root.removeEntry(this.filename); } catch {}
    this.truncate(0);
  }
}

// OPFS persistence for the UTXO set (ShardedUtxo). The coin view lives in RAM
// (fast synchronous lookups for block validation) and is *checkpointed* to the
// Origin Private File System — the same model Bitcoin Core uses (flush the
// chainstate periodically, not every block). Same NDJSON layout as the snapshot
// fixtures, so the on-disk format is shared with acts ① and ⑥.
//
// Main-thread async OPFS (createWritable / getFile). At full 14M-coin scale this
// still works but blocks the UI during the multi-GB write; moving the store into
// a Web Worker with sync access handles is the scale optimization (see README).

export const opfsAvailable = () =>
  typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function';

// Stream the in-RAM ShardedUtxo to an OPFS file as NDJSON (meta line + [k,v] per coin).
export async function checkpoint(snap, filename, meta = {}, onProgress = null) {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify({ ...meta, coins: snap.size }) + '\n');
  let buf = '', c = 0;
  for (const [k, v] of snap.entries()) {
    buf += JSON.stringify([k, v]) + '\n';
    if (++c % 20000 === 0) { await w.write(buf); buf = ''; onProgress?.(c); }
  }
  if (buf) await w.write(buf);
  await w.close();
  return c;
}

// Load a checkpoint back into a ShardedUtxo. Returns the meta object, or null if absent.
export async function resume(snap, filename) {
  const root = await navigator.storage.getDirectory();
  let fh;
  try { fh = await root.getFileHandle(filename); } catch { return null; }
  const file = await fh.getFile();
  if (!file.size) return null;
  return snap.loadFromStream(file.stream(), file.size);
}

export async function checkpointInfo(filename) {
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(filename);
    const file = await fh.getFile();
    return { bytes: file.size };
  } catch { return null; }
}

export async function clearCheckpoint(filename) {
  try { const root = await navigator.storage.getDirectory(); await root.removeEntry(filename); } catch {}
}

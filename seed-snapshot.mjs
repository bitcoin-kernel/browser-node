// Seed the Core dumptxoutset snapshot over WebTorrent for verify.html's no-server
// path. The browser pulls it via WebRTC (or the HTTP webseed) and verifies it
// statelessly. Needs `npm install` (webtorrent) + the file at data/snapshot-full.dat
// (e.g. a symlink to a real dumptxoutset). serve.mjs provides the webseed.
//   node seed-snapshot.mjs            # writes magnet-snapshot.txt
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebTorrent from 'webtorrent';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, process.env.SNAP || 'data/snapshot-full.dat');
const PORT = Number(process.env.PORT || 8088);
if (!existsSync(FILE)) { console.error(`missing ${FILE}`); process.exit(1); }
const WEBSEED = `http://localhost:${PORT}/data/snapshot-full.dat`;
const announceList = [['wss://tracker.openwebtorrent.com'], ['wss://tracker.webtorrent.dev'], ['wss://tracker.btorrent.xyz']];
const client = new WebTorrent();
client.on('error', (e) => console.error('webtorrent:', e.message));
console.log('hashing the snapshot (826 MB)…');
client.seed(FILE, { name: 'utxo-snapshot.dat', announceList, urlList: [WEBSEED] }, (t) => {
  let magnet = t.magnetURI;
  if (!/[?&]ws=/.test(magnet)) magnet += '&ws=' + encodeURIComponent(WEBSEED);
  writeFileSync(path.join(DIR, 'magnet-snapshot.txt'), magnet);
  console.log('seeding', t.infoHash, '(' + (t.length / 1048576).toFixed(0) + ' MB)');
  console.log('magnet-snapshot.txt written; keep serve.mjs running on :' + PORT + ' for the webseed');
});

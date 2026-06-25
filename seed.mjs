// Optional: seed the synthetic UTXO snapshot over WebTorrent for act ① (the
// in-browser WebTorrent load). Needs `npm install` (webtorrent) and serve.mjs
// running (it provides the HTTP webseed). Generate the file first:
//   node tools/gen-snapshot.mjs 250000 snapshot.ndjson
//   node serve.mjs &        # webseed host on :8088
//   node seed.mjs           # writes magnet.txt for the page to fetch
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebTorrent from 'webtorrent';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, 'snapshot.ndjson');
const PORT = Number(process.env.PORT || 8088);
if (!existsSync(FILE)) { console.error(`missing ${FILE}\nrun: node tools/gen-snapshot.mjs 250000 snapshot.ndjson`); process.exit(1); }

const WEBSEED = `http://localhost:${PORT}/snapshot.ndjson`;
const announceList = [['wss://tracker.openwebtorrent.com'], ['wss://tracker.webtorrent.dev'], ['wss://tracker.btorrent.xyz']];
const client = new WebTorrent();
client.on('error', (e) => console.error('webtorrent:', e.message));
client.seed(FILE, { announceList, urlList: [WEBSEED] }, (t) => {
  let magnet = t.magnetURI;
  if (!/[?&]ws=/.test(magnet)) magnet += '&ws=' + encodeURIComponent(WEBSEED);
  writeFileSync(path.join(DIR, 'magnet.txt'), magnet);
  console.log('seeding', t.infoHash);
  console.log('magnet.txt written; keep serve.mjs running on :' + PORT + ' for the webseed');
});

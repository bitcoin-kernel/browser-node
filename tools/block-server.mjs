// Local block proxy for the in-browser full-chain run (fullchain.html). Streams
// raw testnet4 blocks from bitcoind over RPC so the tab can pull them by height
// range: GET /blocks/<start>/<count> -> newline-separated raw block hex.
// Local-only, like the bridge.  node tools/block-server.mjs   (port 8090)
import http from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT || 8090);
const RPC_PORT = Number(process.env.RPC_PORT || 48332);
const cookie = readFileSync(process.env.HOME + '/.bitcoin/testnet4/.cookie', 'utf8').trim();
const auth = 'Basic ' + Buffer.from(cookie).toString('base64');
const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });

function rpcBatch(calls) {
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: '1.0', id: i, method: c.method, params: c.params })));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: RPC_PORT, method: 'POST', agent, headers: { 'Content-Type': 'text/plain', 'Authorization': auth, 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

http.createServer(async (req, res) => {
  const m = /^\/blocks\/(\d+)\/(\d+)/.exec(req.url || '');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!m) { res.writeHead(404); return res.end('usage: /blocks/<start>/<count>'); }
  try {
    const lo = +m[1], count = Math.min(+m[2], 1000);
    const heights = []; for (let h = lo; h < lo + count; h++) heights.push(h);
    const hashes = (await rpcBatch(heights.map((h) => ({ method: 'getblockhash', params: [h] })))).map((r) => r.result).filter(Boolean);
    const raws = (await rpcBatch(hashes.map((h) => ({ method: 'getblock', params: [h, 0] })))).map((r) => r.result);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(raws.join('\n'));
  } catch (e) { res.writeHead(500); res.end(e.message); }
}).listen(PORT, () => console.log(`block-server: http://localhost:${PORT}/blocks/<start>/<count>  ->  bitcoind RPC :${RPC_PORT}`));

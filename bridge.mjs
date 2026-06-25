// Optional: WebSocket-to-TCP bridge for act ⑤ (the live feed). A browser tab
// can't open raw TCP, so it speaks the Bitcoin p2p protocol over a WebSocket and
// this relays the raw frames to a real testnet4 peer. Pure transport — it cannot
// forge a valid header; the tab validates everything (PoW, difficulty, linkage).
//   npm install            # provides `ws`
//   node bridge.mjs        # ws://localhost:8334 -> 127.0.0.1:48333 (a testnet4 node)
//   PEER_HOST=seed.testnet4.bitcoin.sprovoost.nl node bridge.mjs
import net from 'node:net';
import { WebSocketServer } from 'ws';

const PEER_HOST = process.env.PEER_HOST || '127.0.0.1';
const PEER_PORT = Number(process.env.PEER_PORT || 48333);
const WS_PORT = Number(process.env.WS_PORT || 8334);

const wss = new WebSocketServer({ port: WS_PORT });
wss.on('connection', (ws) => {
  const tcp = net.connect(PEER_PORT, PEER_HOST);
  tcp.on('data', (d) => { if (ws.readyState === 1) ws.send(d); });
  ws.on('message', (d) => tcp.write(Buffer.from(d)));
  const close = () => { try { ws.close(); } catch {} try { tcp.destroy(); } catch {} };
  tcp.on('close', close); tcp.on('error', close); ws.on('close', close); ws.on('error', close);
  console.log('client connected -> dialing', PEER_HOST + ':' + PEER_PORT);
});
console.log('bridge: ws://localhost:' + WS_PORT + ' -> tcp ' + PEER_HOST + ':' + PEER_PORT);

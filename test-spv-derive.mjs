// Prove watch-only address derivation: take the canonical BIP84 account
// extended pubkey, derive the first receiving/change addresses with the engine's
// Bip32 + ScriptEngine, and check they equal the published BIP84 test vector.
// (The vector is a zpub; Bip32 takes xpub/tpub, so we re-version the prefix —
// same key, standard prefix.) This is the correctness check wallet.html relies on.
import { readFile } from 'node:fs/promises';
import { Bip32 } from './engine/codec/wallet.js';
import { ScriptEngine, base58checkDecode } from './engine/codec/script.js';
import { dsha256 } from './engine/codec/hash.js';

const D = new URL('./', import.meta.url);
const jl = async (n) => JSON.parse(await readFile(new URL(`engine/schema/${n}.jsonld`, D), 'utf8'));
const se = ScriptEngine.fromSchemas(await jl('script'), await jl('chain'), 'btc:mainnet');   // bc1 addresses for the vector

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58checkEncode(payload) {                     // payload = version+data (no checksum)
  const cs = dsha256(payload).subarray(0, 4);
  const full = new Uint8Array([...payload, ...cs]);
  let n = 0n; for (const b of full) n = (n << 8n) + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of full) { if (b === 0) s = '1' + s; else break; }
  return s;
}

// BIP84 account 0 extended pubkey (zpub) + expected addresses (from the BIP84 spec).
const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const EXPECT = { '0/0': 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', '0/1': 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', '1/0': 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el' };

// re-version zpub (0x04b24746) → xpub (0x0488b21e); same key, prefix Bip32 accepts.
const dec = base58checkDecode(ZPUB);                          // {version, payload} — version is just the 1st byte
const payload = new Uint8Array([dec.version, ...dec.payload]); // reassemble the full 78-byte xkey data
payload[0] = 0x04; payload[1] = 0x88; payload[2] = 0xb2; payload[3] = 0x1e;   // zpub → xpub version
const xpub = base58checkEncode(payload);
const node = Bip32.decode(xpub);
if (!node) { console.log('❌ Bip32.decode failed on the re-versioned xpub'); process.exit(1); }
console.log('decoded account xpub:', xpub.slice(0, 18) + '…');

let ok = true;
for (const [path, want] of Object.entries(EXPECT)) {
  const child = Bip32.derivePath(node, path);
  const spk = Bip32.scriptPubKey(child, 'p2wpkh');
  const got = se.classify(spk).address;
  const pass = got === want;
  ok &&= pass;
  console.log(`  ${path}  ${got}  ${pass ? '✓' : '✗ expected ' + want}`);
}
console.log(ok ? '\n✅ derivation matches the BIP84 vector — wallet address derivation is correct' : '\n❌ mismatch');
process.exit(ok ? 0 : 1);

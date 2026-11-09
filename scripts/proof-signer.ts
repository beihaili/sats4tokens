// Test wallets (P2WPKH, deterministic throwaway keys): `addr <n>` prints the address, `sign <n> <message>` a BIP-137 signature.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bech32 } from '@scure/base';
import { bip137Hash } from '../src/btcproof.ts';
const [cmd, n, ...rest] = process.argv.slice(2);
const priv = sha256(new Uint8Array([100 + Number(n)]));
const pub = secp256k1.getPublicKey(priv, true);
if (cmd === 'addr') console.log(bech32.encode('bc', [0, ...bech32.toWords(ripemd160(sha256(pub)))]));
else {
  const s = secp256k1.sign(bip137Hash(rest.join(' ')), priv, { prehash: false, format: 'recovered' });
  console.log(Buffer.concat([Buffer.from([39 + s[0]]), Buffer.from(s.slice(1))]).toString('base64'));
}

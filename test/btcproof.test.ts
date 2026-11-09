import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bech32 } from '@scure/base';
import {
  parseAddress, verifyMessage, bip137Hash, bip322Hash, toSpendTxid, challengeFor, checkChallenge, heldSince, addressTag,
  normalizeAddress, proofFromEnv, ProofDesk, ClaimError, Esplora, bytesToHex, type Utxo, type Fetch, type ProofSettings,
} from '../src/btcproof.ts';
import { emptyLedger, makeKeyOrder, type Order } from '../src/ledger.ts';

// ------------------------------------------------------------------ BIP-322 (official vectors from the BIP)

const W = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l';
const TR = 'bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3';

test('BIP-322 message hash and to_spend txid match the BIP vectors', () => {
  assert.equal(bytesToHex(bip322Hash('')), 'c90c269c4f8fcbe6880f72a721ddfbf1914268a794cbb21cfafee13770ae19f1');
  assert.equal(bytesToHex(bip322Hash('Hello World')), 'f0eb03b1a75ac6d9847f55c624a99169b5dccba2a31f5b23bea77ba270de0a7a');
  const script = (parseAddress(W) as { script: Uint8Array }).script;
  assert.equal(bytesToHex(toSpendTxid('', script).reverse()), 'c5680aa69bb8d860bf82d4e9cd3504b55dde018de765a91bb566283c545a99a7');
  assert.equal(bytesToHex(toSpendTxid('Hello World', script).reverse()), 'b79d196740ad5217771c1098fc4a4b51e0535c32236c71f1ea4d61a2d603352b');
});

test('BIP-322 simple signatures: P2WPKH and P2TR vectors verify, a changed message does not', () => {
  const empty = 'AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=';
  const hello = 'AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=';
  const hello2 = 'AkgwRQIhAOzyynlqt93lOKJr+wmmxIens//zPzl9tqIOua93wO6MAiBi5n5EyAcPScOjf1lAqIUIQtr3zKNeavYabHyR8eGhowEhAsfxIAMZZEKUPYWI4BruhAQjzFT8FSFSajuFwrDL1Yhy';
  const tr = 'AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ==';
  assert.ok(verifyMessage(W, '', empty));
  assert.ok(verifyMessage(W, 'Hello World', hello));
  assert.ok(verifyMessage(W, 'Hello World', hello2));
  assert.ok(verifyMessage(TR, 'Hello World', tr));
  assert.ok(!verifyMessage(W, 'Hello World!', hello));
  assert.ok(!verifyMessage(W, '', hello));
  assert.ok(!verifyMessage(TR, 'Hello World!', tr));
  assert.ok(!verifyMessage('bc1qe2tk0p3w8xm5kcr2xd4hxxwzm5frmwmp0jrdhv', 'Hello World', hello)); // someone else's address
  assert.ok(!verifyMessage(W, 'Hello World', 'not base64!'));
});

// ------------------------------------------------------------------ BIP-137 (made with bitcoinjs-message 2.2.0, random key)

test('BIP-137 signatures from bitcoinjs-message verify for every address type, incl. Electrum-style headers', () => {
  const m = 'Sats4Tokens trial key test 0';
  // bitcoinjs-message gave the same r,s (recovery id 0) for each type, with that type's header: 31, 27, 39, 35
  const rs = Buffer.from('HyNQTc8YYhGCSXLV1JDYSAwg6Q2yhlBu2mvwEc/TOXhbX3PiCvmzALmQ/7Nbl82B34RBjiJc3y228oU7rOqWGLc=', 'base64').subarray(1);
  const sig = (header: number) => Buffer.concat([Buffer.from([header]), rs]).toString('base64');
  assert.equal(sig(39), 'JyNQTc8YYhGCSXLV1JDYSAwg6Q2yhlBu2mvwEc/TOXhbX3PiCvmzALmQ/7Nbl82B34RBjiJc3y228oU7rOqWGLc=');
  assert.equal(sig(35), 'IyNQTc8YYhGCSXLV1JDYSAwg6Q2yhlBu2mvwEc/TOXhbX3PiCvmzALmQ/7Nbl82B34RBjiJc3y228oU7rOqWGLc=');
  assert.ok(verifyMessage('16hQUfpyxWG87mEDpeXBdWz6NfowaSibyp', m, sig(31))); // P2PKH compressed
  assert.ok(verifyMessage('18C6drF6auWq8w81cpheHH67biUPLA5fQi', m, sig(27))); // P2PKH uncompressed
  assert.ok(verifyMessage('bc1q8e7d6aq4l9wupq3nv79u7jrlqzm0lq2x5usujz', m, sig(39))); // P2WPKH (BIP-137 header)
  assert.ok(verifyMessage('3Pdc4GjRZBBPFMQpno9moKqtT59iRX9iZc', m, sig(35))); // P2SH-P2WPKH
  assert.ok(verifyMessage('bc1q8e7d6aq4l9wupq3nv79u7jrlqzm0lq2x5usujz', m, sig(31))); // Electrum signs segwit with 31–34
  assert.ok(verifyMessage('BC1Q8E7D6AQ4L9WUPQ3NV79U7JRLQZM0LQ2X5USUJZ', m, sig(39))); // upper-case bech32 is the same address
  assert.ok(!verifyMessage('bc1q8e7d6aq4l9wupq3nv79u7jrlqzm0lq2x5usujz', m + 'x', sig(39)));
  assert.ok(!verifyMessage('18C6drF6auWq8w81cpheHH67biUPLA5fQi', m, sig(31))); // compressed key ≠ uncompressed address
  assert.ok(!verifyMessage('bc1q8e7d6aq4l9wupq3nv79u7jrlqzm0lq2x5usujz', m, sig(27))); // uncompressed keys can't be segwit
});

test('addresses: mainnet P2PKH/P2SH/P2WPKH/P2TR only', () => {
  assert.equal((parseAddress(W) as { type: string }).type, 'p2wpkh');
  assert.equal((parseAddress(TR) as { type: string }).type, 'p2tr');
  assert.equal((parseAddress('3Pdc4GjRZBBPFMQpno9moKqtT59iRX9iZc') as { type: string }).type, 'p2sh');
  assert.match(parseAddress('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3') as string, /P2WSH/);
  assert.match(parseAddress('tb1q9vza2e8x573nczrlzms0wvx3gsqjx7vahvs5nm') as string, /mainnet|invalid/);
  assert.match(parseAddress('bc1q9vza2e8x573nczrlzms0wvx3gsqjx7VAvgkx0l') as string, /mixed-case/);
  assert.match(parseAddress('bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0m') as string, /invalid/); // bad checksum
  assert.match(parseAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn') as string, /mainnet|invalid/); // testnet P2PKH
  assert.equal(normalizeAddress('  BC1QABC '), 'bc1qabc');
});

// ------------------------------------------------------------------ challenge + snapshot

test('challenge: one ASCII line, bound to the address and expiry; tampering or expiry is refused', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const m = challengeFor('s3cret', W, now + 30 * 60_000);
  assert.equal(m, `Sats4Tokens trial key for ${W} nonce ${m.split(' nonce ')[1].slice(0, 16)} expires 2026-11-08T12:30Z`);
  assert.equal(checkChallenge('s3cret', W, m, now), undefined);
  assert.match(checkChallenge('other', W, m, now)!, /not the message/);
  assert.match(checkChallenge('s3cret', TR, m, now)!, /not the message/);
  assert.match(checkChallenge('s3cret', W, m.replace('12:30Z', '23:30Z'), now)!, /not the message/);
  assert.match(checkChallenge('s3cret', W, m, now + 31 * 60_000)!, /expired/);
  assert.notEqual(addressTag('s3cret', W), addressTag('other', W));
  assert.equal(addressTag('s3cret', W), addressTag('s3cret', W.toUpperCase()));
});

const utxo = (value: number, height?: number): Utxo =>
  ({ txid: 'aa'.repeat(32), vout: 0, value, status: height === undefined ? { confirmed: false } : { confirmed: true, block_height: height } });

test('heldSince counts only unspent coins confirmed at or before the snapshot', () => {
  assert.equal(heldSince([utxo(600_000, 900_000), utxo(400_000, 900_100), utxo(5_000_000, 900_101), utxo(9_000_000)], 900_100), 1_000_000);
});

test('settings: off without a snapshot, checked when on', () => {
  assert.equal(proofFromEnv({}), undefined);
  assert.deepEqual(proofFromEnv({ PROOF_SNAPSHOT_HEIGHT: '900000' }),
    { snapshot: 900000, minSats: 1_000_000, grantUsd: 1, maxClaims: 50, perDay: 20, esplora: 'https://mempool.space/api' });
  assert.throws(() => proofFromEnv({ PROOF_SNAPSHOT_HEIGHT: 'x' }));
  assert.throws(() => proofFromEnv({ PROOF_SNAPSHOT_HEIGHT: '900000', PROOF_GRANT_USD: '50' }));
});

// ------------------------------------------------------------------ the desk, end to end with a fake explorer

/** A P2WPKH key that signs BIP-137 messages, like Sparrow / Electrum would. */
function wallet(seed: number) {
  const priv = sha256(new Uint8Array([seed]));
  const pub = secp256k1.getPublicKey(priv, true);
  const address = bech32.encode('bc', [0, ...bech32.toWords(ripemd160(sha256(pub)))]);
  const sign = (message: string) => {
    const s = secp256k1.sign(bip137Hash(message), priv, { prehash: false, format: 'recovered' }); // [recid, r, s]
    return Buffer.concat([Buffer.from([39 + s[0]]), Buffer.from(s.slice(1))]).toString('base64');
  };
  return { address, sign };
}

function setup(o: { utxos?: Record<string, Utxo[]>; tip?: number; settings?: Partial<ProofSettings>; pool?: boolean } = {}) {
  const data = emptyLedger();
  let saves = 0;
  let now = Date.parse('2026-11-08T12:00:00Z');
  const lookups: string[] = [];
  const f: Fetch = async (url) => {
    const p = new URL(url).pathname.replace(/^\/api/, '');
    if (p === '/blocks/tip/height') return { ok: true, status: 200, text: async () => String(o.tip ?? 900_200) };
    const a = p.match(/^\/address\/(\w+)\/utxo$/)?.[1];
    if (a) lookups.push(a);
    return { ok: true, status: 200, text: async () => JSON.stringify(o.utxos?.[a!] ?? []) };
  };
  let queue: Promise<unknown> = Promise.resolve();
  const desk = new ProofDesk({
    settings: { snapshot: 900_100, minSats: 1_000_000, grantUsd: 1, maxClaims: 3, perDay: 2, esplora: 'https://x/api', ...o.settings },
    data: () => data,
    save: () => saves++,
    esplora: new Esplora('https://x/api', f),
    now: () => now,
    usdPerFiat: async () => 1.1165,
    makeKey: (money, commit) => {
      const run = queue.then(async () => {
        if (o.pool === false) return 'trial keys are paused right now: try again later';
        const order: Order = makeKeyOrder(money, { fiat: 'eur', btcPrice: 0, now, ttlMs: 60_000 });
        commit(order);
        data.orders.push(order);
        saves++;
        return order;
      });
      queue = run.catch(() => {});
      return run;
    },
  });
  return { desk, data, lookups, saves: () => saves, tick: (ms: number) => (now += ms) };
}

const rich = (address: string) => ({ [address]: [utxo(1_000_000, 900_000)] });
async function claimWith(desk: ProofDesk, w: ReturnType<typeof wallet>, ref?: string) {
  const { message } = desk.challenge(w.address);
  return desk.claim({ address: w.address, message, signature: w.sign(message), ref });
}
const refused = (status: number, re: RegExp) => (e: unknown) => e instanceof ClaimError && e.status === status && re.test(e.message);

test('desk: a holder gets one paid trial key worth $1 in FIAT; the ledger keeps a tag, not the address', async () => {
  const w = wallet(1);
  const s = setup({ utxos: rich(w.address) });
  const o = await claimWith(s.desk, w, 'maxi');
  assert.equal(o.state, 'PAID');
  assert.equal(o.kind, 'key');
  assert.equal(o.money, '0.90'); // $1 at 1.1165 USD/EUR
  assert.deepEqual({ via: o.paid!.via, sats: o.paid!.sats }, { via: 'proof', sats: 0 });
  assert.equal(o.ref, 'proof-maxi');
  assert.equal(o.name, 'Trial key · $1 for a bitcoin holder');
  assert.equal(s.data.proof!.claims.length, 1);
  assert.ok(!JSON.stringify(s.data).includes(w.address));
  assert.deepEqual(s.desk.info(), { enabled: true, snapshot: 900_100, minSats: 1_000_000, grantUsd: 1, total: 3, left: 2, leftToday: 1 });
  await assert.rejects(claimWith(s.desk, w), refused(409, /already claimed/));
});

test('desk: coins that arrived after the snapshot don\'t count (moving 0.01 BTC to a new address claims nothing)', async () => {
  const w = wallet(2);
  const s = setup({ utxos: { [w.address]: [utxo(400_000, 900_000), utxo(5_000_000, 900_150)] } });
  await assert.rejects(claimWith(s.desk, w), refused(403, /400,000 sat .* block 900100; the trial needs 1,000,000/));
  assert.equal(s.data.orders.length, 0);
  assert.equal(s.data.proof!.claims.length, 0);
});

test('desk: wrong signature, foreign message and an unopened snapshot are refused before any key is made', async () => {
  const [a, b] = [wallet(3), wallet(4)];
  const s = setup({ utxos: rich(a.address) });
  const { message } = s.desk.challenge(a.address);
  await assert.rejects(s.desk.claim({ address: a.address, message, signature: b.sign(message) }), refused(400, /doesn't match/));
  assert.deepEqual(s.lookups, []); // no explorer lookup for a bad signature
  await assert.rejects(s.desk.claim({ address: a.address, message: 'hello', signature: a.sign('hello') }), refused(400, /not the message/));
  s.tick(31 * 60_000);
  await assert.rejects(s.desk.claim({ address: a.address, message, signature: a.sign(message) }), refused(400, /expired/));
  const early = setup({ utxos: rich(a.address), tip: 900_050 });
  await assert.rejects(claimWith(early.desk, a), refused(503, /open at block 900100/));
  assert.throws(() => s.desk.challenge('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'), refused(400, /P2WSH/));
});

test('desk: per-day and total caps; two tabs claiming at once get one key', async () => {
  const ws = [5, 6, 7, 8].map(wallet);
  const s = setup({ utxos: Object.assign({}, ...ws.map((w) => rich(w.address))) });
  const both = await Promise.allSettled([claimWith(s.desk, ws[0]), claimWith(s.desk, ws[0])]);
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  await claimWith(s.desk, ws[1]);
  await assert.rejects(claimWith(s.desk, ws[2]), refused(429, /tomorrow/));
  s.tick(86_400_001);
  await claimWith(s.desk, ws[2]);
  await assert.rejects(claimWith(s.desk, ws[3]), refused(410, /gone/));
  assert.equal(s.data.orders.length, 3);
});

test('desk: an empty pool refuses without recording the claim', async () => {
  const w = wallet(9);
  const s = setup({ utxos: rich(w.address), pool: false });
  await assert.rejects(claimWith(s.desk, w), refused(503, /paused/));
  assert.equal(s.data.proof!.claims.length, 0);
});

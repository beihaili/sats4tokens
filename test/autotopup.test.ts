// Auto top-up over NWC: the NIP-47 client against a fake relay + wallet (nip44 and nip04 wallets, errors, timeouts,
// forged answers), and the AutoTopups engine with fake deps (never pays an order twice, crash points, caps, pause).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { emptyLedger, makeKeyOrder, makeTopupOrder, pendingMoney, type Order } from '../src/ledger.ts';
import {
  AutoTopups, MAX_FAILURES, autoSpent24h, checkNwc, checkSettings, decideAuto, publicAuto, publicRelay, type AutoDeps,
} from '../src/autotopup.ts';
import {
  NwcError, nip04Decrypt, nip04Encrypt, nip44ConversationKey, nip44Decrypt, nip44Encrypt, parseNwc, payInvoice, publicKeyOf,
  signEvent, walletInfo, type Connect, type NostrEvent, type Socket,
} from '../src/nwc.ts';

const hex = () => randomBytes(32).toString('hex');

// ------------------------------------------------------------------ fake relay + wallet service

interface WalletOpts {
  encryption?: string; // info event's encryption tag; undefined = no tag (nip04 only)
  methods?: string;
  noInfo?: boolean;
  answer?: (req: any) => any; // the decrypted response body; default: paid
  silent?: boolean; // never answers
  forge?: boolean; // a stranger answers first with a fake "paid"
}

function fakeWallet(o: WalletOpts = {}) {
  const walletSecret = hex();
  const wallet = publicKeyOf(walletSecret);
  const clientSecret = hex();
  const uri = `nostr+walletconnect://${wallet}?relay=wss://relay.example.com&secret=${clientSecret}`;
  const requests: any[] = [];
  const events: NostrEvent[] = [];
  if (!o.noInfo) {
    const tags = o.encryption ? [['encryption', o.encryption]] : [];
    events.push(signEvent(walletSecret, { created_at: 1, kind: 13194, tags, content: o.methods ?? 'pay_invoice get_balance' }));
  }
  const matches = (f: any, e: NostrEvent) =>
    (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) &&
    (!f['#e'] || e.tags.some((t) => t[0] === 'e' && f['#e'].includes(t[1])));
  const connect: Connect = async (url) => {
    if (!url.includes('relay.example.com')) throw new NwcError('RELAY', `can't reach ${url}`);
    const subs = new Map<string, any>();
    const sock: Socket = {
      close: () => {},
      send: (text) => {
        const m = JSON.parse(text);
        const deliver = (msg: unknown[]) => setImmediate(() => sock.onmessage?.(JSON.stringify(msg)));
        if (m[0] === 'REQ') {
          subs.set(m[1], m[2]);
          for (const e of events) if (matches(m[2], e)) deliver(['EVENT', m[1], e]);
          deliver(['EOSE', m[1]]);
        } else if (m[0] === 'CLOSE') subs.delete(m[1]);
        else if (m[0] === 'EVENT') {
          const req = m[1] as NostrEvent;
          deliver(['OK', req.id, true, '']);
          const nip44 = req.tags.some((t) => t[0] === 'encryption' && t[1] === 'nip44_v2');
          const conv = nip44ConversationKey(walletSecret, req.pubkey);
          const body = JSON.parse(nip44 ? nip44Decrypt(conv, req.content) : nip04Decrypt(walletSecret, req.pubkey, req.content));
          requests.push({ ...body, nip44, expiration: req.tags.find((t) => t[0] === 'expiration')?.[1] });
          if (o.silent) return;
          const reply = (secret: string, res: unknown) => {
            const text = JSON.stringify(res);
            const content = nip44 ? nip44Encrypt(nip44ConversationKey(secret, req.pubkey), text) : nip04Encrypt(secret, req.pubkey, text);
            const e = signEvent(secret, { created_at: 2, kind: 23195, tags: [['p', req.pubkey], ['e', req.id]], content });
            for (const [sub, f] of subs) if (matches(f, e)) deliver(['EVENT', sub, e]);
          };
          if (o.forge) reply(hex(), { result_type: 'pay_invoice', result: { preimage: 'forged' } });
          reply(walletSecret, o.answer ? o.answer(body) : { result_type: 'pay_invoice', error: null, result: { preimage: 'ab'.repeat(32) } });
        }
      },
    };
    return sock;
  };
  return { uri, conn: parseNwc(uri), connect, requests, wallet };
}

// from the NIP-44 spec's test vectors (github.com/paulmillr/nip44, nip44.vectors.json, v2.valid)
const NIP44_CONV = [["315e59ff51cb9209768cf7da80791ddcaae56ac9775eb25b6dee1234bc5d2268", "c2f9d9948dc8c7c38321e4b85c8558872eafa0641cd269db76848a6073e69133", "3dfef0ce2a4d80a25e7a328accf73448ef67096f65f79588e358d9a0eb9013f1"], ["a1e37752c9fdc1273be53f68c5f74be7c8905728e8de75800b94262f9497c86e", "03bb7947065dde12ba991ea045132581d0954f042c84e06d8c00066e23c1a800", "4d14f36e81b8452128da64fe6f1eae873baae2f444b02c950b90e43553f2178b"]];
const NIP44_MSG = [["c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d", "0000000000000000000000000000000000000000000000000000000000000001", "a", "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb"], ["c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d", "f00000000000000000000000000000f00000000000000000000000000000000f", "🍕🫃", "AvAAAAAAAAAAAAAAAAAAAPAAAAAAAAAAAAAAAAAAAAAPSKSK6is9ngkX2+cSq85Th16oRTISAOfhStnixqZziKMDvB0QQzgFZdjLTPicCJaV8nDITO+QfaQ61+KbWQIOO2Yj"], ["3e2b52a63be47d34fe0a80e34e73d436d6963bc8f39827f327057a9986c20a45", "b635236c42db20f021bb8d1cdff5ca75dd1a0cc72ea742ad750f33010b24f73b", "表ポあA鷗ŒéＢ逍Üßªąñ丂㐀𠀀", "ArY1I2xC2yDwIbuNHN/1ynXdGgzHLqdCrXUPMwELJPc7s7JqlCMJBAIIjfkpHReBPXeoMCyuClwgbT419jUWU1PwaNl4FEQYKCDKVJz+97Mp3K+Q2YGa77B6gpxB/lr1QgoqpDf7wDVrDmOqGoiPjWDqy8KzLueKDcm9BVP8xeTJIxs="]];

test('nip44 v2: spec test vectors (conversation key, encrypt with a fixed nonce, decrypt)', () => {
  for (const [sec, pub, conv] of NIP44_CONV) assert.equal(Buffer.from(nip44ConversationKey(sec, pub)).toString('hex'), conv);
  for (const [conv, nonce, plain, payload] of NIP44_MSG) {
    assert.equal(nip44Encrypt(Buffer.from(conv, 'hex'), plain, Buffer.from(nonce, 'hex')), payload);
    assert.equal(nip44Decrypt(Buffer.from(conv, 'hex'), payload), plain);
  }
  assert.throws(() => nip44Decrypt(Buffer.from(NIP44_MSG[0][0], 'hex'), NIP44_MSG[0][3].slice(0, -4) + 'AAAA'), /mac/);
});

test('parseNwc: connection strings as wallets write them', () => {
  const w = hex(), s = hex();
  const c = parseNwc(`nostr+walletconnect://${w}?relay=wss%3A%2F%2Frelay.getalby.com%2Fv1&relay=wss://nos.lol&secret=${s}&lud16=a@b.c`);
  assert.deepEqual(c, { wallet: w, relays: ['wss://relay.getalby.com/v1', 'wss://nos.lol'], secret: s });
  assert.equal(parseNwc(`nostrwalletconnect:${w.toUpperCase()}?relay=wss://r.x&secret=${s}`).wallet, w);
  assert.throws(() => parseNwc('lnbc1…'), /not a Nostr Wallet Connect/);
  assert.throws(() => parseNwc(`nostr+walletconnect://${w}?relay=wss://r.x`), /secret/);
  assert.throws(() => parseNwc(`nostr+walletconnect://${w}?secret=${s}`), /relay/);
});

test('checkNwc: only public wss relays (no IPs, localhost, docker service names)', () => {
  for (const ok of ['wss://relay.getalby.com/v1', 'wss://nos.lol']) assert.equal(publicRelay(ok), true, ok);
  for (const bad of ['ws://relay.getalby.com', 'wss://127.0.0.1', 'wss://10.0.0.5:7000', 'wss://[::1]', 'wss://localhost', 'wss://new-api:3000', 'https://x.y'])
    assert.equal(publicRelay(bad), false, bad);
  const s = hex(), w = hex();
  assert.deepEqual(checkNwc(`nostr+walletconnect://${w}?relay=ws://new-api:3000&relay=wss://nos.lol&secret=${s}`).relays, ['wss://nos.lol']);
  assert.throws(() => checkNwc(`nostr+walletconnect://${w}?relay=wss://192.168.1.1&secret=${s}`), /public wss/);
});

test('payInvoice: nip44 wallet pays; request is encrypted, signed, with an expiration', async () => {
  const f = fakeWallet({ encryption: 'nip44_v2 nip04' });
  const r = await payInvoice(f.conn, 'lnbc10n1x', { connect: f.connect, timeoutMs: 2000 });
  assert.equal(r.preimage, 'ab'.repeat(32));
  assert.equal(f.requests.length, 1);
  assert.deepEqual({ method: f.requests[0].method, params: f.requests[0].params, nip44: f.requests[0].nip44 }, { method: 'pay_invoice', params: { invoice: 'lnbc10n1x' }, nip44: true });
  assert.ok(Number(f.requests[0].expiration) > Date.now() / 1000);
});

test('payInvoice: a wallet without an encryption tag gets nip04', async () => {
  const f = fakeWallet();
  await payInvoice(f.conn, 'lnbc1', { connect: f.connect, timeoutMs: 2000 });
  assert.equal(f.requests[0].nip44, false);
});

test('payInvoice: wallet errors keep their NIP-47 code; silence is TIMEOUT; no relay is RELAY', async () => {
  const poor = fakeWallet({ encryption: 'nip44_v2', answer: () => ({ result_type: 'pay_invoice', error: { code: 'INSUFFICIENT_BALANCE', message: 'no funds' } }) });
  await assert.rejects(payInvoice(poor.conn, 'lnbc1', { connect: poor.connect, timeoutMs: 2000 }), (e: NwcError) => e.code === 'INSUFFICIENT_BALANCE');
  const mute = fakeWallet({ encryption: 'nip44_v2', silent: true });
  await assert.rejects(payInvoice(mute.conn, 'lnbc1', { connect: mute.connect, timeoutMs: 300 }), (e: NwcError) => e.code === 'TIMEOUT');
  const nowhere = fakeWallet();
  await assert.rejects(payInvoice({ ...nowhere.conn, relays: ['wss://other.example.org'] }, 'lnbc1', { connect: nowhere.connect }), (e: NwcError) => e.code === 'RELAY');
});

test('payInvoice: an answer signed by anyone but the wallet is ignored', async () => {
  const f = fakeWallet({ encryption: 'nip44_v2', forge: true });
  assert.equal((await payInvoice(f.conn, 'lnbc1', { connect: f.connect, timeoutMs: 2000 })).preimage, 'ab'.repeat(32));
});

test('walletInfo: methods + encryption; undefined when the relay has no info event', async () => {
  const f = fakeWallet({ encryption: 'nip44_v2 nip04', methods: 'get_info make_invoice' });
  assert.deepEqual(await walletInfo(f.conn, f.connect), { methods: ['get_info', 'make_invoice'], encryption: ['nip44_v2', 'nip04'] });
  const g = fakeWallet({ noInfo: true });
  assert.equal(await walletInfo(g.conn, g.connect), undefined);
});

// ------------------------------------------------------------------ settings + decisions

const NOW = 1_759_400_000_000;
const opts = { fiat: 'eur', btcPrice: 100_000, now: NOW, ttlMs: 30 * 60_000 };

function soldKey(auto: Partial<Order['auto']> = {}): Order {
  const o = makeKeyOrder('1', opts);
  o.state = 'PAID';
  o.notify.done = true;
  o.apiKey = { key: 'sk-' + 'a'.repeat(44) + 'b2c3', baseUrl: 'https://x/v1', tokenId: 7 };
  o.auto = { nwc: fakeWallet().uri, wallet: 'f'.repeat(64), relay: 'relay.example.com', money: '2', below: 0.5, perDay: 10, since: NOW, failures: 0, ...auto };
  return o;
}
const autoOrder = (key: Order, send: NonNullable<NonNullable<Order['topup']>['auto']> = {}, at = NOW) => {
  const o = makeTopupOrder(key, key.auto!.money, { ...opts, now: at });
  o.topup!.auto = send;
  return o;
};

test('checkSettings', () => {
  const A = ['1', '2', '5', '10'];
  assert.deepEqual(checkSettings({ money: 2, below: '0.5', perDay: 10 }, A), { money: '2', below: 0.5, perDay: 10 });
  assert.match(String(checkSettings({ money: 3, below: 1, perDay: 10 }, A)), /amount/);
  assert.match(String(checkSettings({ money: 2, below: 0, perDay: 10 }, A)), /below/);
  assert.match(String(checkSettings({ money: 5, below: 1, perDay: 4 }, A)), /daily cap/);
  assert.match(String(checkSettings({ money: 5, below: 1, perDay: 1e6 }, A)), /daily cap/);
});

test('decideAuto: threshold, open order, refused order, daily cap, backoff, pause', () => {
  const data = emptyLedger();
  const k = soldKey();
  data.orders.push(k);
  assert.deepEqual(decideAuto(data, k, 0.6, NOW), { do: 'wait', why: 'balance ok' });
  assert.deepEqual(decideAuto(data, k, 0.4, NOW), { do: 'order' });
  const a = autoOrder(k, { sentAt: NOW, outcome: 'unknown' });
  data.orders.push(a);
  assert.equal(decideAuto(data, k, 0, NOW).do, 'wait'); // maybe paid: wait for it
  a.expiresAt = NOW - 1;
  a.state = 'EXPIRED';
  assert.equal(decideAuto(data, k, 0, NOW).do, 'order'); // expired unpaid: next one may go
  assert.equal(autoSpent24h(data, k, NOW), 2); // but it still counts toward the cap
  const b = autoOrder(k, { sentAt: NOW, outcome: 'declined' });
  data.orders.push(b);
  assert.equal(decideAuto(data, k, 0, NOW).do, 'order'); // refused: not open, not counted
  assert.equal(autoSpent24h(data, k, NOW), 2);
  assert.equal(pendingMoney(data, NOW), 0); // and holds no pool space
  for (let i = 0; i < 4; i++) data.orders.push(Object.assign(autoOrder(k, { sentAt: NOW, outcome: 'paid' }), { state: 'PAID', notify: { done: true, attempts: 0, nextAt: 0 } }));
  assert.deepEqual(decideAuto(data, k, 0, NOW), { do: 'wait', why: 'daily cap reached' }); // 2 + 8 = 10, +2 > 10
  assert.equal(decideAuto(data, k, 0, NOW + 25 * 3600_000).do, 'order'); // a day later
  k.auto!.nextTryAt = NOW + 60_000;
  assert.deepEqual(decideAuto(data, k, 0, NOW + 25 * 3600_000).do, 'order');
  assert.deepEqual(decideAuto(emptyLedger(), k, 0, NOW), { do: 'wait', why: 'retrying later' });
  k.auto!.pausedAt = NOW;
  assert.deepEqual(decideAuto(emptyLedger(), k, 0, NOW + DAY), { do: 'wait', why: 'paused' });
});
const DAY = 24 * 3600_000;

test('publicAuto never contains the connection string', () => {
  const data = emptyLedger();
  const k = soldKey();
  data.orders.push(k, autoOrder(k, { sentAt: NOW, outcome: 'paid' }));
  const v = publicAuto(data, k, NOW)!;
  assert.ok(!JSON.stringify(v).includes(k.auto!.nwc));
  assert.ok(!JSON.stringify(v).includes(parseNwc(k.auto!.nwc).secret));
  assert.equal(v.wallet, 'ffffffff…');
  assert.equal(v.last!.outcome, 'paid');
});

// ------------------------------------------------------------------ engine

/** An engine over an in-memory ledger whose "disk" is a JSON snapshot taken at each save(). */
function engine(key: Order, o: { balance?: number | undefined; pay?: AutoDeps['pay']; pool?: string } = {}) {
  const data = emptyLedger();
  data.orders.push(key);
  let disk = JSON.stringify(data);
  const fx = {
    data, now: NOW, balance: 'balance' in o ? o.balance : 0.1, pays: [] as Array<{ invoice: string; savedSentAt: boolean }>, checked: [] as string[], logs: [] as string[],
    disk: () => JSON.parse(disk),
  };
  const d: AutoDeps = {
    data: () => fx.data,
    save: () => void (disk = JSON.stringify(fx.data)),
    remaining: async () => fx.balance,
    newTopup: async (k, money) => {
      if (o.pool) return o.pool;
      const t = makeTopupOrder(k, money, { ...opts, now: fx.now });
      fx.data.orders.push(t);
      d.save();
      return t;
    },
    invoice: async (id) => {
      const t = fx.data.orders.find((x) => x.id === id)!;
      t.quote ??= { id: 'q-' + id, request: 'lnbc-' + id };
      return t.quote.request;
    },
    checkSoon: (id) => void fx.checked.push(id),
    pay: async (c, invoice) => {
      const onDisk = JSON.parse(disk).orders.find((x: Order) => x.quote?.request === invoice);
      fx.pays.push({ invoice, savedSentAt: onDisk?.topup?.auto?.sentAt !== undefined });
      return o.pay ? o.pay(c, invoice) : { preimage: 'p' };
    },
    now: () => fx.now,
    log: (l) => void fx.logs.push(l),
  };
  return { fx, auto: new AutoTopups(d) };
}
const autos = (fx: { data: { orders: Order[] } }) => fx.data.orders.filter((o) => o.topup?.auto);

test('engine: low key → one order, sentAt on disk before the wallet is asked, then quote checked', async () => {
  const k = soldKey();
  const { fx, auto } = engine(k);
  await auto.tick();
  assert.equal(fx.pays.length, 1);
  assert.equal(fx.pays[0].savedSentAt, true);
  const [o] = autos(fx);
  assert.equal(o.topup!.auto!.outcome, 'paid');
  assert.deepEqual(fx.checked, [o.id]);
  await auto.tick(); // still unpaid at the mint: open → no second order, no second ask
  await auto.tick();
  assert.equal(fx.pays.length, 1);
  assert.equal(autos(fx).length, 1);
});

test('engine: balance above the threshold → nothing', async () => {
  const { fx, auto } = engine(soldKey(), { balance: 0.9 });
  await auto.tick();
  assert.equal(fx.pays.length, 0);
});

test('engine: no answer → unknown, never asked again for that order; next order only after it expires', async () => {
  const k = soldKey();
  const { fx, auto } = engine(k, { pay: async () => { throw new NwcError('TIMEOUT', 'no answer'); } });
  await auto.tick();
  const [o] = autos(fx);
  assert.equal(o.topup!.auto!.outcome, 'unknown');
  assert.equal(k.auto!.failures, 1);
  fx.now += 20 * 60_000; // past the 10 min backoff, order still open (30 min)
  await auto.tick();
  assert.equal(fx.pays.length, 1);
  fx.now = o.expiresAt + 1;
  o.state = 'EXPIRED';
  await auto.tick();
  assert.equal(fx.pays.length, 2);
  assert.notEqual(fx.pays[1].invoice, fx.pays[0].invoice);
});

test('engine: wallet says no → retried after backoff, paused after 3 failures', async () => {
  const k = soldKey({ perDay: 100 });
  const { fx, auto } = engine(k, { pay: async () => { throw new NwcError('INSUFFICIENT_BALANCE', 'no funds'); } });
  for (let i = 0; i < 5; i++) {
    await auto.tick();
    fx.now += 61 * 60_000;
  }
  assert.equal(fx.pays.length, MAX_FAILURES);
  assert.ok(k.auto!.pausedAt);
  assert.match(k.auto!.lastError!, /INSUFFICIENT_BALANCE/);
  assert.ok(autos(fx).every((o) => o.topup!.auto!.outcome === 'declined'));
});

test('engine: crash after sentAt was saved → marked unknown on restart, the wallet is never asked again', async () => {
  const k = soldKey();
  const o = autoOrder(k, { sentAt: NOW }); // what the disk holds after a crash mid-request
  o.quote = { id: 'q', request: 'lnbc-old' };
  const { fx, auto } = engine(k);
  fx.data.orders.push(o);
  await auto.tick();
  assert.equal(fx.pays.length, 0);
  assert.equal(o.topup!.auto!.outcome, 'unknown');
  assert.equal(fx.disk().orders[1].topup.auto.outcome, 'unknown');
});

test('engine: crash before sending → the same order is sent on restart (one order, one ask)', async () => {
  const k = soldKey();
  const o = autoOrder(k, {});
  const { fx, auto } = engine(k);
  fx.data.orders.push(o);
  await auto.tick();
  assert.equal(autos(fx).length, 1);
  assert.equal(fx.pays.length, 1);
  assert.equal(fx.pays[0].invoice, 'lnbc-' + o.id);
});

test('engine: pool sold out → shown, not counted as a wallet failure; deleted key → paused', async () => {
  const k = soldKey();
  const { fx, auto } = engine(k, { pool: 'sold out right now' });
  await auto.tick();
  assert.equal(fx.pays.length, 0);
  assert.equal(k.auto!.failures, 0);
  assert.equal(k.auto!.lastError, 'sold out right now');
  const k2 = soldKey();
  const e2 = engine(k2, { balance: undefined });
  await e2.auto.tick();
  assert.ok(k2.auto!.pausedAt);
  assert.match(k2.auto!.lastError!, /no longer exists/);
});

test('engine: two ticks at once share one pass (no double order)', async () => {
  const k = soldKey();
  const { fx, auto } = engine(k);
  await Promise.all([auto.tick(), auto.tick(), auto.tick()]);
  assert.equal(autos(fx).length, 1);
  assert.equal(fx.pays.length, 1);
});

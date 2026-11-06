import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bitcoinFromEnv, BitcoinWallet, recordBitcoin } from '../src/bitcoin.ts';
import { makeKeyOrder, dueForNotify, creditOf, type Order } from '../src/ledger.ts';

const now = 1_000_000;
const ready = (method: string) => method === 'getblockchaininfo'
  ? { chain: 'main', initialblockdownload: false, blocks: 1, headers: 1, time: Date.now()/1000 }
  : method === 'getwalletinfo' ? { scanning: false, blank: false, private_keys_enabled: false } : undefined;
const addr = 'bc1q' + 'a'.repeat(38);
function order(): Order {
  const o = makeKeyOrder('10', { fiat: 'eur', btcPrice: 100000, now, ttlMs: 60000 });
  o.bitcoin = { address: addr, need: 3, received: 0, confirmations: 0 };
  o.bonus = 5;
  return o;
}
test('BTC receipt survives expiry and reload, waits for confirmations and credits once', async () => {
  let o = order();
  let row = { address: addr, amount: o.sats / 1e8, confirmations: 0, txids: ['tx'] };
  const wallet = new BitcoinWallet(async <T>(method: string) =>
    (ready(method) ?? (method === 'listreceivedbyaddress' ? [row] : { timereceived: now / 1000 })) as T, 3);
  const scan = () => wallet.scan([o], async (ord, r, late) => recordBitcoin(ord, r, late, now + 70000));
  await scan();
  assert.equal(o.state, 'PENDING');
  assert.equal(o.bitcoin?.received, o.sats);
  o = JSON.parse(JSON.stringify(o));
  o.state = 'EXPIRED';
  row.confirmations = 3;
  await scan();
  assert.equal(o.paid?.via, 'bitcoin');
  assert.equal(dueForNotify(o, now + 70000), true);
  assert.equal(creditOf(o), 10.5);
  o.notify.done = true;
  await scan();
  assert.equal(dueForNotify(o, now + 70000), false);
  row = { ...row, amount: row.amount * 2, txids: ['tx', 'extra'] };
  await scan();
  assert.ok(o.bitcoin?.review);
  assert.equal(o.notify.done, true);
});
test('late, wrong amount and a previously settled order go to review', () => {
  for (const type of ['late', 'short', 'over', 'cashu']) {
    const o = order();
    if (type === 'cashu') { o.state = 'PAID'; o.paid = { via: 'cashu', at: now, sats: o.sats, fee: 0 }; }
    const amount = (o.sats + (type === 'short' ? -1 : type === 'over' ? 1 : 0)) / 1e8;
    recordBitcoin(o, { address: addr, amount, confirmations: 6, txids: ['tx'] }, type === 'late', now);
    assert.ok(o.bitcoin?.review);
    assert.notEqual(o.paid?.via, 'bitcoin');
  }
});
test('unconfigured wallet is off and non-mainnet receiving address is rejected', async () => {
  assert.equal(bitcoinFromEnv({}), undefined);
  assert.throws(() => bitcoinFromEnv({ BTC_RPC_URL: 'http://localhost/wallet/test' }));
  await assert.rejects(new BitcoinWallet(async <T>(method: string) => (ready(method) ?? 'bcrt1qexample') as T, 3).address(), /mainnet/);
});

test('BTC node syncing or a signing wallet cannot issue receiving addresses', async () => {
 for (const signing of [false,true]) {
   let issued=false;
   const wallet=new BitcoinWallet(async <T>(method: string) => {
     if(method==='getblockchaininfo') return {chain:'main',initialblockdownload:!signing,blocks:1,headers:1,time:Date.now()/1000} as T;
     if(method==='getwalletinfo') return {scanning:false,blank:false,private_keys_enabled:true} as T;
     issued=true; return addr as T;
   },3);
   await assert.rejects(wallet.address());
   assert.equal(issued,false);
 }
});

test('configured Taproot address type requests bech32m', async () => {
 const address='bc1p'+'a'.repeat(58);
 const wallet=new BitcoinWallet(async <T>(method:string, params:unknown[])=>{
   if(method==='getnewaddress') { assert.deepEqual(params,['','bech32m']); return address as T; }
   return ready(method) as T;
 },3,'bech32m');
 assert.equal(await wallet.address(), address);
});

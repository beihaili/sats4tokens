// A dedicated Bitcoin Core descriptor wallet owns the receiving addresses. No signing RPC is needed.
import type { Order } from './ledger.ts';

type Receipt = { address: string; amount: number; confirmations: number; txids: string[] };
type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;

export function bitcoinFromEnv(env: NodeJS.ProcessEnv) {
  if (!env.BTC_RPC_URL) return undefined;
  const url = new URL(env.BTC_RPC_URL);
  const addressType = env.BTC_ADDRESS_TYPE || 'bech32';
  if (!['bech32', 'bech32m'].includes(addressType)) throw new Error('Invalid BTC address type');
  const need = Number(env.BTC_CONFIRMATIONS ?? 3);
  if (!url.pathname.startsWith('/wallet/') || !env.BTC_RPC_USER || !env.BTC_RPC_PASSWORD ||
      !Number.isSafeInteger(need) || need < 1) throw new Error('Invalid BTC wallet RPC configuration');
  const auth = Buffer.from(env.BTC_RPC_USER + ':' + env.BTC_RPC_PASSWORD).toString('base64');
  const rpc: Rpc = async (method, params) => {
    const r = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { authorization: 'Basic ' + auth, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!r.ok) throw new Error('Bitcoin wallet RPC unavailable');
    const reply = await r.json();
    if (reply.error || reply.result == null) throw new Error('Bitcoin wallet RPC rejected ' + method);
    return reply.result;
  };
  return new BitcoinWallet(rpc, need, addressType as 'bech32' | 'bech32m');
}

export class BitcoinWallet {
  private rpc: Rpc;
  readonly need: number;
  private addressType: 'bech32' | 'bech32m';
  constructor(rpc: Rpc, need: number, addressType: 'bech32' | 'bech32m' = 'bech32') {
    this.rpc = rpc;
    this.need = need;
    this.addressType = addressType;
  }

  private async ready() {
    const chain = await this.rpc<{ chain: string; initialblockdownload: boolean; blocks: number; headers: number; time: number }>('getblockchaininfo', []);
    if (chain.chain !== 'main' || chain.initialblockdownload || chain.blocks < chain.headers ||
        Date.now() / 1000 - chain.time > 2 * 3600) throw new Error('Bitcoin node is still synchronizing');
    const wallet = await this.rpc<{ scanning: unknown; private_keys_enabled: boolean; blank: boolean }>('getwalletinfo', []);
    if (wallet.scanning || wallet.blank || wallet.private_keys_enabled) throw new Error('Bitcoin receiving wallet is not ready');
  }

  async address() {
    await this.ready();
    const address = await this.rpc<string>('getnewaddress', ['', this.addressType]);
    if (!(this.addressType === 'bech32m' ? /^bc1p[a-z0-9]{58}$/ : /^bc1q[a-z0-9]{38}$/).test(address)) throw new Error('Expected a Bitcoin mainnet receiving address');
    return address;
  }

  async scan(orders: Order[], apply: (o: Order, row: Receipt | undefined, late: boolean) => Promise<void>) {
    const targets = new Map(orders.filter(o => o.bitcoin).map(o => [o.bitcoin!.address, o]));
    if (!targets.size) return;
    await this.ready();
    const rows = await this.rpc<Receipt[]>('listreceivedbyaddress', [0, false, true]);
    for (const row of rows) {
      const o = targets.get(row.address);
      if (!o) continue;
      targets.delete(row.address);
      const q = o.bitcoin!;
      const sats = Math.round(row.amount * 1e8);
      const needsReview = o.state === 'PAID' && (o.paid?.via !== 'bitcoin' || sats !== o.sats || row.confirmations < q.need);
      if (q.received === sats && q.confirmations === Math.min(row.confirmations, q.need) &&
          ((o.state === 'PAID' && !!q.review === needsReview) || (o.state !== 'PAID' && (sats !== o.sats || row.confirmations < q.need)))) continue;
      let late = false;
      if (sats === o.sats && row.confirmations >= q.need && o.state !== 'PAID') {
        for (const id of new Set(row.txids)) {
          const tx = await this.rpc<{ timereceived: number }>('gettransaction', [id, true]);
          if (!Number.isSafeInteger(tx.timereceived)) throw new Error('Bitcoin receipt time unavailable');
          if (tx.timereceived * 1000 > o.expiresAt) late = true;
        }
      }
      await apply(o, row, late);
    }
    // A previously seen unconfirmed payment may disappear after a replacement.
    for (const o of targets.values()) if (o.bitcoin!.received) await apply(o, undefined, false);
  }
}

// Called under the same lock as mint settlement. The ledger write includes both receipt and PAID.
export function recordBitcoin(o: Order, row: Receipt | undefined, late: boolean, now: number) {
  const q = o.bitcoin!;
  const sat = Math.round((row?.amount ?? 0) * 1e8);
  const conf = Math.min(row?.confirmations ?? 0, q.need);
  q.received = sat;
  q.confirmations = conf;
  q.review = undefined;
  if (o.state === 'PAID') {
    if (o.paid?.via === 'bitcoin' ? sat !== o.sats || conf < q.need : sat > 0) q.review = 'Check receipt against settled order';
    return;
  }
  if (!sat) return;
  if (sat !== o.sats || late) { q.review = late ? 'Payment after quote expiry' : 'Amount differs from quote'; return; }
  if (conf < q.need || o.state === 'SETTLING') return;
  if (o.stable?.payments.length) { q.review = 'Multiple payment methods received'; return; }
  o.state = 'PAID';
  o.paid = { via: 'bitcoin', sats: sat, at: now, fee: 0, tx: row!.txids[0] };
  o.notify.nextAt = now;
  o.lastError = undefined;
}

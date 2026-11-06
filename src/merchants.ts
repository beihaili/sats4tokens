// Merchant credentials stay in the environment; orders store only the merchant id.
import { verify, type Params } from './epay.ts';
import type { Order } from './ledger.ts';

export interface Merchant { pid: string; key: string; fiat: string; notifyUrl?: string; returnUrl?: string }
export function merchantsFromEnv(env: Record<string, string | undefined>): Map<string, Merchant> {
  const primary: Merchant = { pid: env.EPAY_PID || '1001', key: env.EPAY_KEY || '', fiat: (env.FIAT || 'cny').toLowerCase(),
    notifyUrl: env.EPAY_NOTIFY_URL || undefined, returnUrl: env.EPAY_RETURN_URL || undefined };
  const result = new Map<string, Merchant>([[primary.pid, primary]]);
  const extra: Merchant[] = JSON.parse(env.EPAY_MERCHANTS || '[]');
  if (!Array.isArray(extra)) throw new Error('EPAY_MERCHANTS must be an array');
  for (const m of extra) {
    if (!m || !/^[a-zA-Z0-9_-]+$/.test(m.pid) || result.has(m.pid) || typeof m.key !== 'string' || m.key.length < 32
      || !['cny', 'eur', 'usd'].includes(m.fiat) || !m.notifyUrl || !m.returnUrl) throw new Error('Invalid merchant configuration');
    if ([...result.values()].some(x => x.key === m.key)) throw new Error('Merchants must use independent keys');
    for (const value of [m.notifyUrl, m.returnUrl]) {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search) throw new Error('Merchant URLs must be exact HTTPS endpoints');
    }
    result.set(m.pid, m);
  }
  return result;
}
export function submitMerchant(merchants: Map<string, Merchant>, p: Params): Merchant | undefined {
  const m = merchants.get(p.pid);
  if (!m || !verify(p, m.key)) return undefined;
  if ((m.notifyUrl && p.notify_url !== m.notifyUrl) || (m.returnUrl && p.return_url !== m.returnUrl)) return undefined;
  if (!['bitcoin', 'lightning', 'usdc'].includes(p.type)) return undefined;
  return m;
}
export function merchantKey(merchants: Map<string, Merchant>, o: Order): string {
  const m = merchants.get(o.pid);
  if (!m) throw new Error('Merchant unavailable');
  return m.key;
}
export const relayCheckout = (o: Order): boolean => !o.kind && ['lightning', 'usdc'].includes(o.type);
export const relayRails = ['base-usdc', 'solana-usdc'];

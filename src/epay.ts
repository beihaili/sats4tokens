// EPay (易支付) protocol, as spoken by new-api via github.com/Calcium-Ion/go-epay.
//
// Signature: drop `sign`, `sign_type` and empty values → sort keys → "k=v&k=v" (raw values,
// no URL-encoding) → append the merchant key → MD5 hex. Both directions use the same rule:
//   new-api → us:  POST /submit.php   (pid, type, out_trade_no, notify_url, return_url, name, money, device, sign…)
//   us → new-api:  GET notify_url     (pid, trade_no, out_trade_no, type, name, money, trade_status, sign…)
import { createHash, timingSafeEqual } from 'node:crypto';

export type Params = Record<string, string>;

/** The exact string that gets hashed (exported for tests and debugging). */
export function signingString(params: Params): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

export function sign(params: Params, key: string): string {
  return createHash('md5').update(signingString(params) + key).digest('hex');
}

/** Returns a copy with `sign` and `sign_type=MD5` added. */
export function signed(params: Params, key: string): Params {
  return { ...params, sign: sign(params, key), sign_type: 'MD5' };
}

/** Constant-time check of `params.sign`. */
export function verify(params: Params, key: string): boolean {
  const got = Buffer.from(String(params.sign ?? '').toLowerCase());
  const want = Buffer.from(sign(params, key));
  return got.length === want.length && timingSafeEqual(got, want);
}

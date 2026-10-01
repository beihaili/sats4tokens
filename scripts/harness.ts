// Shared bits for the local end-to-end scripts (crash-demo.ts, edge-checks.ts):
// child processes with prefixed output, polling, a customer wallet, and a signed EPay submit.
// Everything runs against testnut (fake Lightning backend: invoices get paid by themselves).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet, MintQuoteState, getEncodedToken } from '@cashu/cashu-ts';
import { signed } from '../src/epay.ts';
import type { LedgerData } from '../src/ledger.ts';

export const MINT = process.env.MINT_URL ?? 'https://testnut.cashu.space';
export const KEY = 'local-test-key';
export const GW = 'http://127.0.0.1:8095';
export const MERCHANT = 'http://127.0.0.1:3995';
const env = { ...process.env, EPAY_KEY: KEY, EPAY_PID: '1001', MINT_URL: MINT, BTC_PRICE: '800000' };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const step = (s: string) => console.log(`\n\x1b[1;33m▶ ${s}\x1b[0m`);
export const makeDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cashu-epay-test-'));
export const readLedger = (dataDir: string): LedgerData => JSON.parse(fs.readFileSync(path.join(dataDir, 'ledger.json'), 'utf8'));

/** Start `node script` with extra env and [name]-prefixed output. `exited` resolves to the signal/exit code. */
export function run(name: string, script: string, extra: Record<string, string>) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
    env: { ...env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = (chunk: Buffer) => process.stdout.write(chunk.toString().replace(/^(?=.)/gm, `   [${name}] `));
  child.stdout.on('data', tag);
  child.stderr.on('data', tag);
  const exited = new Promise<string>((r) => child.on('exit', (code, sig) => r(sig ?? `code ${code}`)));
  return { child, exited };
}

/** Poll f every 500ms until it returns something other than undefined (errors count as "not yet"). */
export async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const v = await f().catch(() => undefined);
    if (v !== undefined) return v;
  }
  throw new Error(`timeout waiting for ${what}`);
}
export const up = (url: string) => until(url, async () => ((await fetch(url)).status < 500 ? true : undefined));

/** The customer's own wallet: get ecash from the test mint and encode it as a token. */
export async function customerToken(amount: number): Promise<string> {
  const w = new Wallet(MINT, { unit: 'sat' });
  await w.loadMint();
  const q = await w.createMintQuoteBolt11(amount);
  await until('customer quote paid', async () => ((await w.checkMintQuoteBolt11(q.quote)).state === MintQuoteState.PAID ? true : undefined));
  return getEncodedToken({ mint: MINT, proofs: await w.mintProofsBolt11(amount, q.quote), unit: 'sat' });
}

let seq = 0;
/** Do what new-api's top-up button does: a signed EPay submit. Returns our order id and the sats due. */
export async function submitOrder(money: string) {
  const outTradeNo = `USR1NOtest${Date.now()}${++seq}`;
  const form = signed(
    { pid: '1001', type: 'bitcoin', out_trade_no: outTradeNo, notify_url: `${MERCHANT}/notify`, return_url: `${MERCHANT}/paid`, name: `TUC${money}`, money, device: 'pc' },
    KEY,
  );
  const r = await fetch(`${GW}/submit.php`, { method: 'POST', body: new URLSearchParams(form), redirect: 'manual' });
  if (r.status !== 302) throw new Error(`submit: HTTP ${r.status} ${await r.text()}`);
  const id = r.headers.get('location')!.split('/').pop()!;
  const o = (await (await fetch(`${GW}/api/order/${id}`)).json()) as { sats: number };
  return { id, outTradeNo, sats: o.sats, form };
}

/** POST a token to an order; returns [status, body]. */
export async function payToken(id: string, token: string): Promise<[number, Record<string, unknown>]> {
  const r = await fetch(`${GW}/api/order/${id}/token`, { method: 'POST', body: JSON.stringify({ token }) });
  return [r.status, (await r.json()) as Record<string, unknown>];
}

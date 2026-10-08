// Price check for the homepage: our live price next to the model maker's list price and ppq.ai, in USD per 1M tokens.
// List and ppq prices are copied by hand from their public pricing pages (CHECKED); ours come live from new-api
// (KeyShop.models, in FIAT) and are converted to USD with today's BTC price in both currencies, so the page never
// shows a stale number of ours. A row whose model the pool can't call is left out.
import type { ModelPrice } from './keyshop.ts';

export const CHECKED = '2026-10-08';
export const SOURCES = {
  list: ['https://www.anthropic.com/pricing', 'https://openai.com/api/pricing'],
  ppq: 'https://ppq.ai/pricing',
};
// [input, output] USD per 1M tokens, base tier (no long-context or fast surcharge)
export const ROWS: Array<{ model: string; name: string; list: [number, number]; ppq: [number, number] }> = [
  { model: 'claude-opus-5-5', name: 'Claude Opus 5.5', list: [4, 20], ppq: [4.22, 21.1] },
  { model: 'claude-fable-5-1', name: 'Claude Fable 5.1', list: [10, 50], ppq: [10.55, 52.75] },
  { model: 'claude-opus-4-8', name: 'Claude Opus 4.8', list: [5, 25], ppq: [5.28, 26.38] },
  { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', list: [2, 10], ppq: [2.11, 10.55] },
];

export interface Compare {
  checked: string;
  sources: typeof SOURCES;
  usdPerFiat: number;
  rows: Array<{ model: string; name: string; list: [number, number]; ppq: [number, number]; ours: [number, number]; off: number }>;
  minOff: number; // smallest "% below list price" over the rows: the number the headline may claim
}

/** Join the hand-checked rows with our live prices. `off` = % below list price (output; input is the same ratio). */
export function compare(models: ModelPrice[], usdPerFiat: number): Compare {
  const rows: Compare['rows'] = [];
  for (const r of ROWS) {
    const m = models.find((x) => x.model === r.model);
    if (m?.input === undefined || m.output === undefined) continue;
    const ours: [number, number] = [m.input * usdPerFiat, m.output * usdPerFiat];
    rows.push({ ...r, ours, off: Math.floor((1 - ours[1] / r.list[1]) * 100) });
  }
  return { checked: CHECKED, sources: SOURCES, usdPerFiat, rows, minOff: rows.length ? Math.min(...rows.map((r) => r.off)) : 0 };
}

let fx: { at: number; fiat: string; rate: number } | undefined;
/**
 * USD per 1 unit of `fiat` (cached 1h): the ratio of BTC's USD and fiat prices on mempool.space, which quotes both.
 * USD_PER_FIAT in env overrides it (offline tests); a rate up to a day old is reused if the feed is down.
 */
export async function usdPerFiat(fiat: string): Promise<number> {
  if (fiat === 'usd') return 1;
  if (process.env.USD_PER_FIAT) return Number(process.env.USD_PER_FIAT);
  if (fx && fx.fiat === fiat && Date.now() - fx.at < 3600_000) return fx.rate;
  try {
    const r = await fetch('https://mempool.space/api/v1/prices', { signal: AbortSignal.timeout(5000) });
    const p = (await r.json()) as Record<string, number>;
    const rate = p.USD / p[fiat.toUpperCase()];
    if (!(rate > 0)) throw new Error(`no ${fiat} quote`);
    fx = { at: Date.now(), fiat, rate };
    return rate;
  } catch (e) {
    if (fx && fx.fiat === fiat && Date.now() - fx.at < 86400_000) return fx.rate;
    throw new Error(`fx rate: ${(e as Error).message}`);
  }
}

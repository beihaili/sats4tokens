// Fiat → BTC price. Locked into each order at creation time.
//   BTC_PRICE=…   fixed price (demo / offline)
//   FIAT=cny      currency of new-api's "money" field (must match new-api's Price currency; the demo uses eur)
// Otherwise free public spot prices (no API key), cached for 60s. Sources are tried in order so one
// rate-limited or down feed can't block checkout; if all fail, a price up to 10 min old is reused.
const FIAT = (process.env.FIAT ?? 'cny').toLowerCase();
const FRESH_MS = 60_000;
const STALE_MS = 10 * 60_000;
let cache: { at: number; price: number } | undefined;

export const fiat = (): string => FIAT;

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Each returns the BTC price in `f` (lowercase ISO code), or undefined if the source doesn't quote it.
const SOURCES: Array<[name: string, get: (f: string) => Promise<unknown>]> = [
  ['coingecko', async (f) => (await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${f}`)).bitcoin?.[f]],
  ['coinbase', async (f) => (await getJson(`https://api.coinbase.com/v2/prices/BTC-${f.toUpperCase()}/spot`)).data?.amount],
  ['mempool.space', async (f) => (await getJson('https://mempool.space/api/v1/prices'))[f.toUpperCase()]], // no CNY
];

export async function btcPrice(): Promise<number> {
  if (process.env.BTC_PRICE) return Number(process.env.BTC_PRICE);
  if (cache && Date.now() - cache.at < FRESH_MS) return cache.price;
  const errors: string[] = [];
  for (const [name, get] of SOURCES) {
    try {
      const price = Number(await get(FIAT));
      if (!(price > 0)) throw new Error(`no ${FIAT} price`);
      cache = { at: Date.now(), price };
      return price;
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  if (cache && Date.now() - cache.at < STALE_MS) {
    console.warn(`⚠️ price feeds failed (${errors.join('; ')}), reusing price from ${Math.round((Date.now() - cache.at) / 1000)}s ago`);
    return cache.price;
  }
  throw new Error(`price feed: ${errors.join('; ')}`);
}

// ------------------------------------------------------------------ USD per FIAT
// Stablecoin amounts (USDT/USDC = 1 USD) and the homepage price check. Locked into a stablecoin order when the buyer
// picks a network. USD_PER_FIAT fixes it (offline tests); else free public feeds in order, 10 min cache, and a rate up
// to a day old is reused if all fail (fiat pairs move slowly).
const FX_FRESH_MS = 10 * 60_000;
const FX_STALE_MS = 24 * 3600_000;
let fx: { at: number; fiat: string; rate: number } | undefined;
const FX_SOURCES: Array<[name: string, get: (f: string) => Promise<unknown>]> = [
  ['frankfurter', async (f) => (await getJson(`https://api.frankfurter.app/latest?from=${f.toUpperCase()}&to=USD`)).rates?.USD],
  ['coinbase', async (f) => (await getJson(`https://api.coinbase.com/v2/exchange-rates?currency=${f.toUpperCase()}`)).data?.rates?.USD],
  // BTC's USD and FIAT price on one feed: the ratio is the cross rate
  ['mempool.space', async (f) => {
    const p = await getJson('https://mempool.space/api/v1/prices');
    return p.USD / p[f.toUpperCase()];
  }],
];

export async function usdPerFiat(f = FIAT): Promise<number> {
  f = f.toLowerCase();
  if (f === 'usd') return 1;
  if (process.env.USD_PER_FIAT) return Number(process.env.USD_PER_FIAT);
  if (fx && fx.fiat === f && Date.now() - fx.at < FX_FRESH_MS) return fx.rate;
  const errors: string[] = [];
  for (const [name, get] of FX_SOURCES) {
    try {
      const rate = Number(await get(f));
      if (!(rate > 0) || !Number.isFinite(rate)) throw new Error(`no ${f} rate`);
      fx = { at: Date.now(), fiat: f, rate };
      return rate;
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  if (fx && fx.fiat === f && Date.now() - fx.at < FX_STALE_MS) return fx.rate;
  throw new Error(`fx rate: ${errors.join('; ')}`);
}

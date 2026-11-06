// Fiat → BTC price. Locked into each order at creation time.
//   BTC_PRICE=…   fixed price (demo / offline)
//   FIAT=cny      currency of new-api's "money" field (must match new-api's Price currency; the demo uses eur)
// Otherwise free public spot prices (no API key), cached for 60s. Sources are tried in order so one
// rate-limited or down feed can't block checkout; if all fail, a price up to 10 min old is reused.
const FIAT = (process.env.FIAT ?? 'cny').toLowerCase();
const FRESH_MS = 60_000;
const STALE_MS = 10 * 60_000;
const prices = new Map<string, { at: number; price: number }>();

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

export async function btcPrice(currency = FIAT): Promise<number> {
  currency = currency.toLowerCase();
  if (!['eur', 'usd', 'cny', 'gbp', 'chf'].includes(currency)) throw new Error('Unsupported BTC quote currency');
  const fixed = process.env['BTC_PRICE_' + currency.toUpperCase()] || (currency === FIAT ? process.env.BTC_PRICE : undefined);
  if (fixed) {
    const price = Number(fixed);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid BTC price');
    return price;
  }
  let cache = prices.get(currency);
  if (cache && Date.now() - cache.at < FRESH_MS) return cache.price;
  const errors: string[] = [];
  for (const [name, get] of SOURCES) {
    try {
      const price = Number(await get(currency));
      if (!(price > 0) || !Number.isFinite(price)) throw new Error(`no ${currency} price`);
      cache = { at: Date.now(), price };
      prices.set(currency, cache);
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
const rates = new Map<string, { at: number; rate: number }>();
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
  const fixed = process.env['USD_PER_' + f.toUpperCase()] || (f === FIAT && process.env.USD_PER_FIAT);
  if (fixed) {
    const value = Number(fixed);
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid configured FX rate');
    return value;
  }
  const fx = rates.get(f);
  if (fx && Date.now() - fx.at < FX_FRESH_MS) return fx.rate;
  const errors: string[] = [];
  for (const [name, get] of FX_SOURCES) {
    try {
      const rate = Number(await get(f));
      if (!(rate > 0) || !Number.isFinite(rate)) throw new Error(`no ${f} rate`);
      rates.set(f, { at: Date.now(), rate });
      return rate;
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  if (fx && Date.now() - fx.at < FX_STALE_MS) return fx.rate;
  throw new Error(`fx rate: ${errors.join('; ')}`);
}

/** Ledger currency per one unit of the buyer's selected currency. */
export async function accountRate(currency: string): Promise<number> {
  if (currency === FIAT) return 1;
  const [selected, base] = await Promise.all([usdPerFiat(currency), usdPerFiat(FIAT)]);
  return selected / base;
}

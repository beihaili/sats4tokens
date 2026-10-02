// Fiat → BTC price. Locked into each order at creation time.
//   BTC_PRICE=…   fixed price (demo / offline)
//   FIAT=cny      currency of new-api's "money" field (new-api default pricing is CNY; the demo uses usd)
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

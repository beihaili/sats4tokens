// Fiat → BTC price. Locked into each order at creation time.
//   BTC_PRICE=…   fixed price (demo / offline)
//   FIAT=cny      currency of new-api's "money" field (new-api default pricing is CNY; the demo uses usd)
// Otherwise CoinGecko's free endpoint, cached for 60s.
const FIAT = (process.env.FIAT ?? 'cny').toLowerCase();
let cache: { at: number; price: number } | undefined;

export const fiat = (): string => FIAT;

export async function btcPrice(): Promise<number> {
  if (process.env.BTC_PRICE) return Number(process.env.BTC_PRICE);
  if (cache && Date.now() - cache.at < 60_000) return cache.price;
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${FIAT}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`price feed HTTP ${r.status}`);
  const price = Number(((await r.json()) as { bitcoin?: Record<string, number> }).bitcoin?.[FIAT]);
  if (!(price > 0)) throw new Error(`price feed: no ${FIAT} price`);
  cache = { at: Date.now(), price };
  return price;
}

// Manual purchase tiers are denominated in the selected currency; the quota pool uses FIAT.
export const tiers = ['1', '10', '100', '500'];
export const bonuses: Record<string, number> = { '10': 5, '100': 10, '500': 10 };
export const currencies = ['eur', 'usd', 'cny'];

export function accountPrincipal(amount: string, rate: number): string {
  const value = Number(amount) * rate;
  if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid currency conversion');
  return String(Number(value.toFixed(8)));
}

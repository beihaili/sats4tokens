// The customer's side, for demos: mint ecash on the test mint and print it as a token.
//   node scripts/customer-wallet.ts mint 2000      → prints cashuB… worth 2000 sat
// testnut runs a FakeWallet backend, so its invoices count as paid without real sats.
import { Wallet, MintQuoteState, getEncodedToken } from '@cashu/cashu-ts';

const MINT = process.env.MINT_URL ?? 'https://testnut.cashu.space';
const [cmd, amt] = process.argv.slice(2);
if (cmd !== 'mint' || !Number(amt)) {
  console.error('usage: customer-wallet.ts mint <sats>');
  process.exit(1);
}
const w = new Wallet(MINT, { unit: 'sat' });
await w.loadMint();
const q = await w.createMintQuoteBolt11(Number(amt));
for (let i = 0; i < 30 && (await w.checkMintQuoteBolt11(q.quote)).state !== MintQuoteState.PAID; i++) {
  await new Promise((r) => setTimeout(r, 1000));
}
const proofs = await w.mintProofsBolt11(Number(amt), q.quote);
console.log(getEncodedToken({ mint: MINT, proofs, unit: 'sat' }));

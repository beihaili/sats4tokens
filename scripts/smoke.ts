// Smoke test against testnut (FakeWallet: every invoice is instantly "paid").
// Proves the recovery idea the gateway relies on:
//   same quote + same deterministic counter → identical outputs, and
//   NUT-09 restore(start, count) tells us whether the mint already signed them.
import { Wallet, getEncodedToken, sumProofs, MintQuoteState } from '@cashu/cashu-ts';
import { randomBytes } from 'node:crypto';

const MINT = process.env.MINT_URL ?? 'https://testnut.cashu.space';
const seed = randomBytes(32);

const gw = new Wallet(MINT, { unit: 'sat', bip39seed: seed });
await gw.loadMint();

// 1. mint quote → paid
const q = await gw.createMintQuoteBolt11(100);
console.log('quote', q.quote, q.state, q.request.slice(0, 30) + '…');
let st = await gw.checkMintQuoteBolt11(q.quote);
for (let i = 0; i < 30 && st.state === MintQuoteState.UNPAID; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  st = await gw.checkMintQuoteBolt11(q.quote);
}
if (st.state !== MintQuoteState.PAID) throw new Error(`quote not paid: ${st.state}`);

// 2. deterministic mint at counter 1, but "crash" before we look at the result
const preview = await gw.prepareMint('bolt11', 100, st, undefined, { type: 'deterministic', counter: 1 });
const n = preview.outputData.length;
await gw.completeMint(preview); // pretend we died and lost these proofs

// 3. recovery: restore the same counter range from the mint
const restored = await gw.restore(1, n);
console.log(`restored ${restored.proofs.length}/${n} proofs, ${sumProofs(restored.proofs)} sat`);

// 4. replaying the mint must fail (quote ISSUED) — no double-mint
try { await gw.completeMint(preview); console.log('!! replay succeeded (NUT-19 cache?)'); }
catch (e) { console.log('replay rejected:', (e as Error).message); }

// 5. a customer token → gateway receives it with deterministic outputs
const token = getEncodedToken({ mint: MINT, proofs: restored.proofs, unit: 'sat' });
const gw2 = new Wallet(MINT, { unit: 'sat', bip39seed: randomBytes(32) });
await gw2.loadMint();
const rp = await gw2.ops.receive(token).asDeterministic(1).prepare();
const m = rp.keepOutputs?.length ?? 0;
const res = await gw2.completeSwap(rp);
console.log('received', sumProofs(res.keep), 'sat; outputs', m, 'fees', rp.fees);
const r2 = await gw2.restore(1, Math.max(m, res.keep.length));
console.log('restore after receive:', sumProofs(r2.proofs), 'sat');
const states = await gw2.checkProofsStates(restored.proofs);
console.log('original token proofs:', states.map((s) => s.state).join(','));

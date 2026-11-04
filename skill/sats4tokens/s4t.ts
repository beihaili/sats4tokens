// sats4tokens skill CLI: check and top up the AI API key an agent runs on, paid in sats.
//
//   node s4t.ts balance              # {remaining, used, fiat}; {usedUp: true} when the key is at 0
//   node s4t.ts prices               # amounts, sats per amount, bonus
//   node s4t.ts topup 2              # add €2 (caps apply), prints {added, remaining}
//   node s4t.ts classify 403 '<body>'  # what an API error means: topup | check-balance | pool-empty | not-ours
//
// JSON on stdout, progress on stderr. The key and order ids are never printed. Exit 2 = a human has to act
// (the message says what and whether anything was paid). Config: see README.md.
import { balance, classifyError, configFrom, realDeps, Stop, topup } from './lib.ts';

const [cmd, ...args] = process.argv.slice(2);
const out = (x: unknown) => console.log(JSON.stringify(x));

try {
  if (cmd === 'classify') {
    let body: unknown = args[1] ?? '';
    try { body = JSON.parse(String(body)); } catch {}
    out({ verdict: classifyError(Number(args[0]), body) });
  } else if (cmd === 'prices') {
    const shop = (process.env.S4T_SHOP ?? 'https://sats4tokens.bhbtc.xyz').replace(/\/+$/, '');
    const r = await fetch(shop + '/api/shop', { signal: AbortSignal.timeout(20_000) });
    const { amounts, fiat, sats, bonus, soldOut } = await r.json();
    out({ amounts, fiat, sats, bonus, soldOut });
  } else if (cmd === 'balance') {
    const b = await balance(configFrom(process.env), realDeps);
    out(b ?? { usedUp: true, hint: 'run `topup <amount>`; the shop says if the key is unknown' });
  } else if (cmd === 'topup') {
    const money = Number(args[0]);
    if (!(money > 0)) throw new Stop('usage: topup <amount>, one of the amounts from `prices`');
    out(await topup(configFrom(process.env), money, realDeps));
  } else {
    console.error('usage: s4t.ts balance | prices | topup <amount> | classify <status> <body>');
    process.exit(1);
  }
} catch (e) {
  console.error(e instanceof Stop ? `STOP: ${e.message}` : `error: ${(e as Error).message}`);
  process.exit(e instanceof Stop ? 2 : 1);
}

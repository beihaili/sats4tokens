// Buy an AI API key with no human in the loop: create an order, pay it, poll until the key is there.
//
//   node examples/agent-buy-key.ts 1                 # €1 key, prints a Lightning invoice for your wallet to pay
//   node examples/agent-buy-key.ts 1 cashuB…         # €1 key, paid with a Cashu token from the shop's mint
//   SHOP=https://your-shop.example node examples/agent-buy-key.ts 5
//   node examples/agent-buy-key.ts --topup sk-… 2    # add €2 to a key bought here (same payment flow)
//
// Prints the key as JSON on stdout ({key, baseUrl}; a top-up prints {added, remaining}); progress goes to stderr.
// No dependencies (Node ≥ 22).
// Every step is safe to retry: re-POSTing the same token for the same order returns the same order, and the key
// is created exactly once per paid order. Keep the order id: it is the capability, /pay/<id> shows the key again.
const SHOP = (process.env.SHOP ?? 'https://sats4tokens.bhbtc.xyz').replace(/\/$/, '');
const args = process.argv.slice(2);
const t = args.indexOf('--topup');
const topupKey = t >= 0 ? args.splice(t, 2)[1] : undefined;
const [amount = '1', token] = args;
const log = (...a: unknown[]) => console.error(...a);

async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch(SHOP + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error ?? r.status}`);
  return j;
}

const shop = await api('/api/shop');
if (!shop.enabled) throw new Error('key shop not enabled');
if (!shop.amounts.includes(amount)) throw new Error(`can't buy ${amount} now (sold out or not offered: ${shop.amounts.join(', ') || 'none'})`);
// the key goes in the body, never in a URL; 404 "unknown key" if it wasn't sold by this shop
const { id } = await api('/api/buy', topupKey ? { money: amount, key: topupKey } : { money: amount });
log(`${topupKey ? 'top-up' : 'order'} ${id}: ${amount} ${shop.fiat} — checkout ${SHOP}/pay/${id}`);

let o = await api(`/api/order/${id}`);
log(`price locked: ${o.sats} sat, mint ${o.mint}, expires ${new Date(o.expiresAt).toISOString()}`);
if (token) {
  o = await api(`/api/order/${id}/token`, { token }); // 400 with a reason if the token doesn't fit (mint, amount, spent)
} else {
  o = await api(`/api/order/${id}/invoice`, {});
  log(`pay this Lightning invoice:\n${o.invoice}`);
}

// PAID first (Lightning: when the mint sees the payment), then the key (or the top-up) a moment later
const done = (o: any) => (topupKey ? o.topup?.applied || o.topup?.needsRefund : o.apiKey);
while (!done(o)) {
  if (o.state === 'EXPIRED') throw new Error('order expired before it was paid');
  if (o.keyError) log(`${topupKey ? 'top-up not added' : 'key not created'} yet (retrying): ${o.keyError}`);
  await new Promise((r) => setTimeout(r, 3000));
  o = await api(`/api/order/${id}`);
}
log(`paid ${o.paid.sats} sat via ${o.paid.via}`);
if (topupKey) {
  if (o.topup.needsRefund) throw new Error(`paid, but the key no longer exists: keep ${SHOP}/pay/${id} and ask for a refund`);
  console.log(JSON.stringify({ added: Number(amount), remaining: o.topup.applied.remaining }));
} else {
  console.log(JSON.stringify({ key: o.apiKey.key, baseUrl: o.apiKey.baseUrl }));
}

// Buy an AI API key with no human in the loop: create an order, pay it, poll until the key is there.
//
//   node examples/agent-buy-key.ts 1                 # €1 key, prints a Lightning invoice for your wallet to pay
//   node examples/agent-buy-key.ts 1 cashuB…         # €1 key, paid with a Cashu token from the shop's mint
//   SHOP=https://your-shop.example node examples/agent-buy-key.ts 5
//
// Prints the key as JSON on stdout ({key, baseUrl}); progress goes to stderr. No dependencies (Node ≥ 22).
// Every step is safe to retry: re-POSTing the same token for the same order returns the same order, and the key
// is created exactly once per paid order. Keep the order id: it is the capability, /pay/<id> shows the key again.
const SHOP = (process.env.SHOP ?? 'https://sats4tokens.bhbtc.xyz').replace(/\/$/, '');
const [amount = '1', token] = process.argv.slice(2);
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
const { id } = await api('/api/buy', { money: amount });
log(`order ${id}: ${amount} ${shop.fiat} — checkout ${SHOP}/pay/${id}`);

let o = await api(`/api/order/${id}`);
log(`price locked: ${o.sats} sat, mint ${o.mint}, expires ${new Date(o.expiresAt).toISOString()}`);
if (token) {
  o = await api(`/api/order/${id}/token`, { token }); // 400 with a reason if the token doesn't fit (mint, amount, spent)
} else {
  o = await api(`/api/order/${id}/invoice`, {});
  log(`pay this Lightning invoice:\n${o.invoice}`);
}

// PAID first (Lightning: when the mint sees the payment), then the key a moment later
while (!o.apiKey) {
  if (o.state === 'EXPIRED') throw new Error('order expired before it was paid');
  if (o.keyError) log(`key not created yet (retrying): ${o.keyError}`);
  await new Promise((r) => setTimeout(r, 3000));
  o = await api(`/api/order/${id}`);
}
log(`paid ${o.paid.sats} sat via ${o.paid.via}`);
console.log(JSON.stringify({ key: o.apiKey.key, baseUrl: o.apiKey.baseUrl }));

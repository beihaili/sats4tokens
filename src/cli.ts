// Operator CLI. Talks to the running gateway over HTTP (never touches ledger.json itself, so it
// can't race the server's in-memory ledger).
//   EPAY_KEY=… [GATEWAY=http://127.0.0.1:8090] npm run cli balance
//   EPAY_KEY=… [GATEWAY=…]                     npm run cli withdraw   → token file on the gateway's disk
const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8090';
const KEY = process.env.EPAY_KEY ?? '';
const cmd = process.argv[2];
if (!KEY || !['balance', 'withdraw'].includes(cmd ?? '')) {
  console.error('usage: EPAY_KEY=… [GATEWAY=…] cli.ts balance|withdraw');
  process.exit(1);
}
const q = `key=${encodeURIComponent(KEY)}`;
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

if (cmd === 'balance') {
  const r = await fetch(`${GATEWAY}/admin?${q}`);
  if (!r.ok) die(`balance failed: HTTP ${r.status} ${await r.text()}`);
  const a = (await r.json()) as {
    balance: number;
    mint: string;
    orders: { id: string; state: string; money: string; sats: number; paid?: { via: string; sats: number }; notify: { done: boolean } }[];
  };
  console.log(`balance ${a.balance} sat at ${a.mint}`);
  for (const o of a.orders) {
    console.log(`  ${o.id}  ${o.state.padEnd(8)} ${o.money.padStart(8)}  ${o.paid ? `${o.paid.sats} sat via ${o.paid.via}` : `${o.sats} sat due`}${o.paid && !o.notify.done ? '  (notify pending)' : ''}`);
  }
} else {
  const r = await fetch(`${GATEWAY}/admin/withdraw?${q}`, { method: 'POST' });
  const body = (await r.json().catch(() => ({ error: `HTTP ${r.status}` }))) as { file?: string; sats?: number; error?: string };
  if (!r.ok) die(`withdraw failed: ${body.error}`);
  console.log(`withdrew ${body.sats} sat → ${body.file} (on the gateway host; import the token into any cashu wallet)`);
}

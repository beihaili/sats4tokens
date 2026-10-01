// Crash-recovery demo: kill -9 the gateway in the middle of a payment, restart it, and show the
// customer's money is neither lost nor credited twice.
//
//   node scripts/crash-demo.ts [cashu|lightning] [after-mint|after-writeahead]
//
// after-mint        the mint has signed our outputs, but we die before storing the proofs
//                   → on restart, NUT-09 restore of the write-ahead counter range finds them  → finish
// after-writeahead  we recorded the counter range, but die before asking the mint
//                   → restore finds nothing, the input is still unspent/paid                  → retry
//
// Runs entirely locally against testnut (its fake Lightning backend pays invoices by itself):
// fake-merchant (stands in for new-api) on :3995, gateway on :8095, fresh temp DATA_DIR.
import fs from 'node:fs';
import { type ChildProcess } from 'node:child_process';
import { GW, MERCHANT, makeDataDir, run, until, up, sleep, step, customerToken, submitOrder, readLedger } from './harness.ts';

const via = process.argv[2] ?? 'cashu';
const crashAt = process.argv[3] ?? 'after-mint';
if (!['cashu', 'lightning'].includes(via) || !['after-mint', 'after-writeahead'].includes(crashAt)) {
  console.error('usage: crash-demo.ts [cashu|lightning] [after-mint|after-writeahead]');
  process.exit(1);
}
const dataDir = makeDataDir();

const procs: ChildProcess[] = [];
try {
  step(`setup: fake merchant + gateway with CRASH_AT=${crashAt}   (DATA_DIR=${dataDir})`);
  const merchant = run('merchant', 'scripts/fake-merchant.ts', { PORT: '3995', GATEWAY: GW });
  procs.push(merchant.child);
  let gw = run('gateway', 'src/server.ts', { PORT: '8095', DATA_DIR: dataDir, CRASH_AT: crashAt });
  procs.push(gw.child);
  await Promise.all([up(`${MERCHANT}/paid`), up(`${GW}/admin`)]);

  step('merchant creates a ¥1.00 top-up order (signed EPay submit, like new-api)');
  const { id, outTradeNo, sats: due } = await submitOrder('1.00');
  console.log(`   order ${id}: ${due} sat due`);

  let token = '';
  if (via === 'cashu') {
    step('customer pastes a cashu token → gateway swaps it at the mint … and gets killed');
    token = await customerToken(due + 2); // +2 covers the swap fee
    await fetch(`${GW}/api/order/${id}/token`, { method: 'POST', body: JSON.stringify({ token }) }).catch((e) =>
      console.log(`   customer's request died with the gateway: ${(e as Error).cause ?? e}`),
    );
  } else {
    step('customer opens the ⚡ tab → invoice; testnut pays it; gateway mints … and gets killed');
    await fetch(`${GW}/api/order/${id}/invoice`, { method: 'POST' });
  }
  console.log(`   gateway exited: ${await gw.exited}`);

  step('ledger on disk right now');
  let o = readLedger(dataDir).orders.find((x) => x.id === id)!;
  console.log(`   state=${o.state}  write-ahead counters ${o.settle?.counter}..${o.settle!.counter + o.settle!.count - 1}  balance proofs=${readLedger(dataDir).proofs.length}`);
  console.log(`   merchant credited so far: ${await (await fetch(`${MERCHANT}/paid`)).text()}`);

  step('restart the gateway (no CRASH_AT) → recover() runs before it accepts requests');
  gw = run('gateway', 'src/server.ts', { PORT: '8095', DATA_DIR: dataDir });
  procs.push(gw.child);
  await until('merchant credit', async () => {
    const paid = (await (await fetch(`${MERCHANT}/paid`)).json()) as string[];
    return paid.includes(outTradeNo) ? true : undefined;
  });
  await sleep(1000);

  step('result');
  const l = readLedger(dataDir);
  o = l.orders.find((x) => x.id === id)!;
  const paid = (await (await fetch(`${MERCHANT}/paid`)).json()) as string[];
  console.log(`   order state=${o.state} via=${o.paid?.via} received=${o.paid?.sats} sat  notify done=${o.notify.done}`);
  console.log(`   merchant credited ${paid.filter((x) => x === outTradeNo).length}× for ${outTradeNo}`);
  if (token) {
    const again = await fetch(`${GW}/api/order/${id}/token`, { method: 'POST', body: JSON.stringify({ token }) });
    console.log(`   replaying the same token → ${again.status} ${JSON.stringify(await again.json())}`);
  }
  if (o.state !== 'PAID' || !o.notify.done || paid.length !== 1) throw new Error('❌ recovery failed');
  console.log('\n\x1b[1;32m✅ killed mid-payment, recovered, credited exactly once\x1b[0m');
} finally {
  for (const p of procs) p.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true }); // testnut ecash only, worthless
}

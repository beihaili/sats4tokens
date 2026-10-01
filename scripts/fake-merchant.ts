// A stand-in for new-api, for testing without Docker. Speaks the same EPay as go-epay.
//   GET /start?money=7.30   → auto-submitting form POST to the gateway's /submit.php (like new-api's top-up button)
//   GET /notify?…           → verifies the sign, records the payment, answers "success"
//   GET /paid               → JSON list of out_trade_no's credited (each must appear once)
// Env: GATEWAY (default http://127.0.0.1:8090), EPAY_PID, EPAY_KEY, PORT (3999), FAIL_FIRST=n (answer "fail" n times)
import http from 'node:http';
import { signed, verify } from '../src/epay.ts';

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8090';
const PID = process.env.EPAY_PID ?? '1001';
const KEY = process.env.EPAY_KEY ?? 'demo-key';
const PORT = Number(process.env.PORT ?? 3999);
let failLeft = Number(process.env.FAIL_FIRST ?? 0);
const credited = new Map<string, number>(); // out_trade_no → times credited (RechargeEpay is idempotent: count once)
let seq = 0;

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/start') {
      const params = signed(
        {
          pid: PID,
          type: 'bitcoin',
          out_trade_no: `USR1NO${Date.now()}${++seq}`,
          notify_url: `http://127.0.0.1:${PORT}/notify`,
          return_url: `http://127.0.0.1:${PORT}/paid`,
          name: `TUC${url.searchParams.get('amount') ?? '1'}`,
          money: url.searchParams.get('money') ?? '7.30',
          device: 'pc',
        },
        KEY,
      );
      const inputs = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`).join('');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<form id="f" method="POST" action="${GATEWAY}/submit.php">${inputs}</form><script>f.submit()</script>`);
    }
    if (url.pathname === '/notify') {
      const p = Object.fromEntries(url.searchParams.entries());
      if (!verify(p, KEY)) return res.end('fail');
      if (failLeft > 0) {
        failLeft--;
        console.log(`notify ${p.out_trade_no}: answering "fail" on purpose (${failLeft} left)`);
        return res.end('fail');
      }
      if (p.trade_status === 'TRADE_SUCCESS' && !credited.has(p.out_trade_no)) {
        credited.set(p.out_trade_no, 1);
        console.log(`💰 credited ${p.out_trade_no} (${p.money}) trade_no=${p.trade_no}`);
      } else console.log(`duplicate notify for ${p.out_trade_no} — ignored (idempotent)`);
      return res.end('success');
    }
    if (url.pathname === '/paid') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([...credited.keys()]));
    }
    res.writeHead(404).end();
  })
  .listen(PORT, () => console.log(`fake merchant on http://127.0.0.1:${PORT}/start?money=7.30`));

// Local stand-in for new-api (key shop endpoints) and an Esplora explorer, for checking /claim end to end
// (launch config `proof-local`: gateway with PROOF_SNAPSHOT_HEIGHT=900100, NEWAPI_URL / PROOF_ESPLORA pointing here).
// Usage: node scripts/fake-proof.mjs <RICH> <LATE>, addresses from `node scripts/proof-signer.ts addr 1|2`.
// RICH holds 0.01 BTC since block 900000; LATE got its coins at 900150 (after the snapshot). Keys are fake strings.
import http from 'node:http';
const [RICH, LATE] = process.argv.slice(2);
const tokens = [];
const ok = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data })); };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const p = u.pathname;
  if (p === '/esplora/blocks/tip/height') return res.end('900200');
  const m = p.match(/^\/esplora\/address\/(\w+)\/utxo$/);
  if (m) {
    const at = m[1] === RICH ? 900000 : m[1] === LATE ? 900150 : 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(at ? [{ txid: 'ab'.repeat(32), vout: 0, value: 1_000_000, status: { confirmed: true, block_height: at } }] : []));
  }
  if (p === '/api/status') return ok(res, { quota_per_unit: 500000, price: 0.133333333333, server_address: 'http://127.0.0.1:8097' });
  if (p === '/api/user/self') return ok(res, { quota: 500000 * 1000, group: 'default' });
  if (p === '/api/token/search') return ok(res, tokens.filter((t) => t.name === u.searchParams.get('keyword')));
  if (p === '/api/token/' && req.method === 'POST') { const t = JSON.parse(body); tokens.push({ ...t, id: tokens.length + 1, status: 1, used_quota: 0 }); return ok(res, null); }
  if (p === '/api/token/') return ok(res, { items: tokens, total: tokens.length });
  let k = p.match(/^\/api\/token\/(\d+)\/key$/);
  if (k) return ok(res, { key: 'FAKE' + k[1].padStart(44, '0') });
  k = p.match(/^\/api\/token\/(\d+)$/);
  if (k) return ok(res, tokens[Number(k[1]) - 1]);
  if (p === '/api/log/self') return ok(res, { items: [], total: 0 });
  if (p === '/api/pricing') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ success: true, data: [] })); }
  res.writeHead(404); res.end('{}');
}).listen(18799, () => console.log('fake new-api + esplora on :18799'));

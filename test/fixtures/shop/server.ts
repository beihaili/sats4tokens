// Isolated integration fixture. All wallet and quota responses are local synthetic data.
import http from 'node:http';
import { Gateway } from '../../../src/gateway.ts';
let queue = Promise.resolve();
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args: any[]) {
 this.once('listening', () => {
   if (process.env.NEWAPI_URL) console.log('ACTUAL_PORT=' + (this.address() as any).port);
 });
 return (listen as any).apply(this, args);
};
Gateway.open = async () => ({
  tick: async () => {}, watch: () => {}, balance: () => 0,
  serial: (fn: () => Promise<any>) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; },
}) as any;
const tokens: any[] = [];
let receipts: any[] = [];
let n = 0;
const upstream = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const b = body ? JSON.parse(body) : {};
  const url = new URL(req.url!, 'http://local');
  let data: any;
  if (url.pathname === '/wallet/test') {
    let result: any;
    if (b.method === 'getblockchaininfo') result = { chain:'main', initialblockdownload:false, blocks:1, headers:1, time:Date.now()/1000 };
    if (b.method === 'getwalletinfo') result = { scanning:false, blank:false, private_keys_enabled:false };
    if (b.method === 'getnewaddress') result = 'bc1q' + String(++n).padStart(38, 'a');
    if (b.method === 'listreceivedbyaddress') result = receipts;
    if (b.method === 'gettransaction') result = { timereceived: Math.floor(Date.now()/1000) };
    res.end(JSON.stringify({result})); return;
  }
  if (url.pathname === '/receive') { receipts = b; res.end('{}'); return; }
  if (url.pathname === '/api/status') data = { quota_per_unit: 500000, price: 1, server_address: 'http://local' };
  if (url.pathname === '/api/user/self') data = { quota: 5000000000 };
  if (url.pathname === '/api/token/search') data = tokens.filter(t => t.name === url.searchParams.get('keyword'));
  if (url.pathname === '/api/token/' && req.method === 'POST') tokens.push({ ...b, id: tokens.length+1, used_quota:0, status:1 });
  if (url.pathname === '/api/token/' && req.method === 'PUT') Object.assign(tokens.find(t=>t.id===b.id), b);
  if (url.pathname === '/api/token/' && req.method === 'GET') data = { items: tokens, total: tokens.length };
  const m = url.pathname.match(/^\/api\/token\/(\d+)(\/key)?$/);
  if (m) data = m[2] ? { key: 'synthetic-key-'+m[1] } : tokens.find(t=>t.id===Number(m[1]));
  if (url.pathname === '/api/pricing') data = [];
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({success:true,data}));
});
upstream.listen(0,'127.0.0.1',async()=>{
 const port = (upstream.address() as any).port;
 process.env.NEWAPI_URL = 'http://127.0.0.1:'+port;
 process.env.BTC_RPC_URL = process.env.NEWAPI_URL+'/wallet/test';
 console.log('FIXTURE_PORT='+port);
 await import('../../../src/server.ts');
});

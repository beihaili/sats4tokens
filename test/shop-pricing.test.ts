import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('three currencies lock account principal, settle BTC, and top up the same key once', {timeout:60000}, async () => {
 const dir=mkdtempSync(join(tmpdir(),'s4t-shop-'));
 const child=spawn(process.execPath,['test/fixtures/shop/server.ts'],{
  env:{...process.env,PORT:'0',EPAY_KEY:'synthetic',NEWAPI_USER_ID:'1',NEWAPI_TOKEN:'synthetic',
   DATA_DIR:dir,FIAT:'eur',BTC_PRICE:'100000',USD_PER_EUR:'1.2',USD_PER_CNY:'0.15',
   BTC_RPC_USER:'test',BTC_RPC_PASSWORD:'test',KEY_BONUS:'5:5,10:10',SUPPORT_URL:'https://t.me/example'},
  stdio:['ignore','pipe','pipe'],
 });
 let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 const wait=async (f:()=>Promise<any>)=>{
  for(let i=0;i<120;i++){const v=await f();if(v)return v;await new Promise(r=>setTimeout(r,250));}
  throw new Error('Integration timeout '+output);
 };
 try {
  // server reports PORT=0, so discover the actual listening port through the fixture's IPC output below.
  const port=await wait(async()=>output.match(/ACTUAL_PORT=(\d+)/)?.[1]);
  const base='http://127.0.0.1:'+port;
  const fixture=Number(output.match(/FIXTURE_PORT=(\d+)/)![1]);
  const request=async(path:string,body?:unknown)=>{
   const r=await fetch(base+path, body===undefined?{}:{method:'POST',body:JSON.stringify(body)});
   return {status:r.status,body:await r.json()};
  };
  const order=async(id:string)=>(await request('/api/order/'+id)).body;
  for(const currency of ['eur','usd','cny']){
   const shop=(await request('/api/shop?currency='+currency)).body;
   assert.deepEqual(shop.amounts,['1','10','100','500']);
   assert.deepEqual(shop.bonus,{'10':5,'100':10,'500':10});
   assert.equal(shop.support,'https://t.me/example');
  }
  const made=(await request('/api/buy',{money:100,currency:'cny'})).body;
  let o=await order(made.id);
  assert.equal(o.money,'12.5');assert.equal(o.fiat,'eur');assert.equal(o.bonus,10);
  assert.equal(o.support,'https://t.me/example');
  assert.equal(o.purchase.amount,'100');assert.equal(o.sats,12500);
  const [a,b]=await Promise.all([request('/api/order/'+o.id+'/bitcoin',{}),request('/api/order/'+o.id+'/bitcoin',{})]);
  assert.equal(a.body.bitcoin.address,b.body.bitcoin.address);
  await fetch('http://127.0.0.1:'+fixture+'/receive',{method:'POST',body:JSON.stringify([{address:a.body.bitcoin.address,amount:.000125,confirmations:3,txids:['synthetic']}])});
  o=await wait(async()=>{const v=await order(made.id);return v.apiKey&&v;});
  const key=o.apiKey.key;
  const top=(await request('/api/buy',{money:10,currency:'usd',key})).body;
  let t=await order(top.id);
  assert.equal(t.bonus,5);assert.ok(Math.abs(Number(t.money)-8.33333333)<1e-8);
  const quoted=(await request('/api/order/'+top.id+'/bitcoin',{})).body;
  await fetch('http://127.0.0.1:'+fixture+'/receive',{method:'POST',body:JSON.stringify([
   {address:a.body.bitcoin.address,amount:.000125,confirmations:3,txids:['synthetic']},
   {address:quoted.bitcoin.address,amount:quoted.sats/1e8,confirmations:3,txids:['topup']}
  ])});
  t=await wait(async()=>{const v=await order(top.id);return v.topup?.applied&&v;});
  assert.equal(t.topup.applied.remaining,22.5); // ¥100 => €13.75; $10 => €8.75
  assert.equal((await order(made.id)).apiKey.key,key);
  assert.equal((await request('/api/buy',{money:1,currency:'zzz'})).status,400);
  assert.equal((await request('/api/buy',{money:2,currency:'eur'})).status,400);
  const legacy=(await request('/api/buy',{money:2})).body;
  assert.equal((await order(legacy.id)).money,'2');
 } finally {child.kill();await new Promise(r=>child.once('exit',r));rmSync(dir,{recursive:true,force:true});}
});

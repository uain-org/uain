import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBainkServer } from '../server/app.mjs';

async function holdUploads(t, trustProxy) {
  const dir = await mkdtemp(join(tmpdir(), 'baink-admission-'));
  const app = await createBainkServer({ dataDir: dir, publicOrigin: 'https://baink.example', projectsSource: null, catalogueDir: null, trustProxy });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port, sockets = [], requests = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    app.server.closeAllConnections();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 16; i++) {
    const received = once(app.server, 'request');
    const socket = connect(port, '127.0.0.1');
    sockets.push(socket);
    await once(socket, 'connect');
    socket.write(`POST /api/account HTTP/1.1\r\nHost: baink.example\r\nX-Real-IP: 203.0.113.10\r\nContent-Type: application/json\r\nContent-Length: 16000\r\n\r\n{`);
    requests.push((await received)[0]);
  }
  const health = async ip => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'X-Real-IP': ip } });
    return { status: response.status, body: await response.json() };
  };
  return { sockets, requests, health };
}

test('a single client cannot occupy the global request pool with stalled uploads', async t => {
  const f = await holdUploads(t, true);
  assert.equal((await f.health('203.0.113.10')).status, 429);
  assert.equal((await f.health('203.0.113.11')).status, 200);
  const closed = f.requests.map(req => new Promise(resolve => req.once('close', resolve)));
  for (const socket of f.sockets) socket.destroy();
  await Promise.all(closed);
  assert.equal((await f.health('203.0.113.10')).status, 200);
});

test('untrusted forwarding headers cannot evade the per-client concurrency limit', async t => {
  const f = await holdUploads(t, false);
  assert.equal((await f.health('203.0.113.99')).status, 429);
});

import { fixture, member, signed } from './http-fixture.mjs';
import { clientBucket } from '../server/app.mjs';
test('shared-NAT onboarding permits240 hourly profiles while minute, key and owner limits remain enforced',async t=>{
 const original=Date.now;let offset=0;Date.now=()=>original()+offset;t.after(()=>{Date.now=original;});
 const f=await fixture(t,{trustProxy:true}),ip={'X-Real-IP':'203.0.113.20'},people=[];
 for(let i=0;i<240;i++){
  if(i&&i%30===0){if(i===30){const refused=await f.request(member(),'POST','/api/account',{displayName:'Minute denial'},ip);assert.equal(refused.status,429);assert.equal(refused.body.error.code,'rate_limited');}offset+=60001;}
  const who=member();people.push(who);const r=await f.request(who,'POST','/api/account',{displayName:'Fictional NAT '+i},ip);assert.equal(r.status,201,'profile '+i+' within paced hourly budget');
 }
 offset+=60001;const exhausted=await f.request(member(),'POST','/api/account',{displayName:'Hourly denial'},ip);assert.equal(exhausted.status,429);assert.equal(exhausted.body.error.code,'rate_limited');
 assert.equal((await f.request(member(),'POST','/api/account',{displayName:'Independent IP'},{'X-Real-IP':'203.0.113.21'})).status,201);
 const unknown=member(),unknownIP={'X-Real-IP':'203.0.113.22'};for(let i=0;i<12;i++)assert.equal((await f.request(unknown,'GET','/api/account',{},unknownIP)).status,404);assert.equal((await f.request(unknown,'GET','/api/account',{},unknownIP)).status,429,'unknown key still12/min');
 for(let i=0;i<120;i++)assert.equal((await f.request(people[0],'GET','/api/account',{},ip)).status,200);assert.equal((await f.request(people[0],'GET','/api/account',{},ip)).status,429,'registered owner still120/min');
 offset+=3600001;assert.equal((await f.request(member(),'POST','/api/account',{displayName:'New hour'},ip)).status,201,'hourly window eventually resets');
});

// B1-3 (13 November 2026): 4,096 addresses once filled the one-hour
// registration map, and every newcomer from any other address was refused.
test('4,096 registrations from distinct addresses do not lock a newcomer from a new address out', async t => {
 const original=Date.now;let offset=0;Date.now=()=>original()+offset;t.after(()=>{Date.now=original;});
 const f=await fixture(t,{trustProxy:true});
 const prefixes=Array.from({length:4096},(_,i)=>`2001:db8:${(i>>8).toString(16)}:${(i&255).toString(16)}::1`);
 let next=0;const codes={};
 await Promise.all(Array.from({length:8},async()=>{while(next<prefixes.length){const at=prefixes[next++];const r=await f.request(member(),'POST','/api/account',{displayName:'Burst'},{'X-Real-IP':at});codes[r.status]=(codes[r.status]??0)+1;}}));
 assert.equal(codes[201],4096,JSON.stringify(codes));
 offset+=65_000;
 const r=await f.request(member(),'POST','/api/account',{displayName:'Newcomer'},{'X-Real-IP':'2001:db8:ffff:1::1'});
 assert.equal(r.status,201,JSON.stringify(r.body));
 // An address inside a /64 already in the map keeps its budget there.
 assert.equal((await f.request(member(),'POST','/api/account',{displayName:'Same prefix'},{'X-Real-IP':'2001:db8:0:0::2'})).status,201);
});

test('refused future-dated registrations hold no nonce, so a fresh key still registers', async t => {
 const f=await fixture(t,{trustProxy:true});const codes={};
 for(let k=0;k<50;k++){const key=member(),ip={'X-Real-IP':`203.0.113.${k+1}`};for(let n=0;n<8;n++){const body={bogus:true};const r=await f.request(key,'POST','/api/account',body,{...ip,...signed(key,'POST','/api/account',body,{timestamp:String(Date.now()+290_000)})});codes[r.status+':'+r.body.error?.code]=(codes[r.status+':'+r.body.error?.code]??0)+1;}}
 assert.deepEqual(codes,{'400:invalid_body':400});
 assert.equal((await f.request(member(),'POST','/api/account',{displayName:'Newcomer'},{'X-Real-IP':'203.0.113.200'})).status,201);
});

test('an IPv6 client is one /64: rotating addresses inside it shares one budget', async t => {
 assert.equal(clientBucket('2001:db8:1:2::1'),'2001:db8:1:2::/64');
 assert.equal(clientBucket('2001:0db8:0001:0002:ffff:0:0:9'),'2001:db8:1:2::/64');
 assert.equal(clientBucket('2001:db8::1'),'2001:db8:0:0::/64');
 assert.equal(clientBucket('203.0.113.9'),'203.0.113.9');
 assert.equal(clientBucket('::ffff:203.0.113.9'),'::ffff:203.0.113.9');
 assert.equal(clientBucket('uain1'+'0'.repeat(40)),'uain1'+'0'.repeat(40));
 const f=await fixture(t,{trustProxy:true});
 for(let i=1;i<=30;i++)assert.equal((await f.request(member(),'GET','/api/account',{},{'X-Real-IP':`2001:db8:5:6::${i.toString(16)}`})).status,404);
 const r=await f.request(member(),'GET','/api/account',{},{'X-Real-IP':'2001:db8:5:6::ff'});
 assert.equal(r.status,429);assert.equal(r.body.error.code,'rate_limited');
 assert.equal((await f.request(member(),'GET','/api/account',{},{'X-Real-IP':'2001:db8:5:7::1'})).status,404);
});

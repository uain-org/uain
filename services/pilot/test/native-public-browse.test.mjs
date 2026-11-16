import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';import {boot} from './helpers.mjs';
import {createOwnHeightProver,createBrowsePageCache,browseProvedBlock,browseChainTime,BROWSE_MAX_AGE_MS} from '../dist/src/native/public-browse.js';

const head={chain_id:'test-chain',height:'100',event_count:'7',app_hash:'a'.repeat(64),header_time:'2026-11-10T00:00:00Z',records:{}};
const state=(keys,{chain='test-chain',height='100',events='7',drop}={})=>({chain_id:chain,height,event_count:events,app_hash:'b'.repeat(64),header_time:'2026-11-10T00:00:01Z',records:Object.fromEntries(keys.filter(k=>k!==drop).map(k=>[k,{key:k}]))});

test('events landing between batches keep the batches already proved, each at its own height',async()=>{
 let n=0;const prover=createOwnHeightProver(head,async({keys})=>{n++;return state(keys,{height:String(100+n),events:String(7+n)})});
 const a=await prover.read({keys:['x','y']}),b=await prover.read({keys:['y','z']});
 assert.deepEqual(a.records,{x:{key:'x'},y:{key:'y'}});assert.deepEqual(b.records,{y:{key:'y'},z:{key:'z'}},'a proved record is reused, not re-proved');
 assert.equal(n,2);const s=prover.stats();assert.equal(s.from,'100');assert.equal(s.to,'102');assert.equal(s.batches,2);assert.equal(s.consistent,false,'batches at a later event count are not one snapshot');
 const quiet=createOwnHeightProver(head,async({keys})=>state(keys,{height:'105'}));await quiet.read({keys:['x']});assert.equal(quiet.stats().consistent,true);
});

test('a browse proof must name the view chain, not fall behind it, and prove every key',async()=>{
 await assert.rejects(createOwnHeightProver(head,async({keys})=>state(keys,{chain:'other'})).read({keys:['x']}),/browse proof differs/);
 await assert.rejects(createOwnHeightProver(head,async({keys})=>state(keys,{events:'6'})).read({keys:['x']}),/behind its view/);
 await assert.rejects(createOwnHeightProver(head,async({keys})=>state(keys,{drop:'y'})).read({keys:['x','y']}),/browse proof differs/);
 await assert.rejects(createOwnHeightProver(head,async({keys})=>state(keys)).read({keys:Array.from({length:33},(_,i)=>'k'+i)}),/bounded/);
 assert.throws(()=>createOwnHeightProver({...head,height:'x'},async()=>head),/head required/);
});

test('concurrent pages share one proof per key and the view is bounded',async()=>{
 let n=0,release;const gate=new Promise(r=>release=r);const prover=createOwnHeightProver(head,async({keys})=>{n++;await gate;return state(keys)},{maxKeys:3});
 const both=Promise.all([prover.read({keys:['x','y']}),prover.read({keys:['y','x']})]);release();const [a,b]=await both;assert.equal(n,1);assert.deepEqual(a.records,b.records);
 await prover.read({keys:['z']});await assert.rejects(prover.read({keys:['w']}),/bound reached/);assert.equal(prover.stats().full,true);
});

test('the page cache is bounded by entries, bytes and age, and a re-dated view re-dates its pages',()=>{
 let clock=1_000_000;const now=()=>clock,stamp={id:1,asOf:clock,headerTime:'2026-11-10T00:00:00Z'};
 const page=(size=10)=>({result:{status:200,body:{blob:'x'.repeat(size)}},stamp,builtAt:clock,from:'1',to:'2',consistent:true});
 const cache=createBrowsePageCache({maxEntries:2,maxBytes:4096,now});
 cache.put('a',page());cache.put('b',page());cache.put('c',page());assert.equal(cache.get('a'),null,'oldest entry evicted at the entry bound');assert.ok(cache.get('c'));assert.equal(cache.size().entries,2);
 assert.equal(cache.put('big',page(5000)),false,'a page larger than the byte bound is not held');assert.ok(cache.size().bytes<=4096);
 clock+=BROWSE_MAX_AGE_MS;assert.ok(cache.get('c'),'served up to the maximum age');stamp.asOf=clock;clock+=BROWSE_MAX_AGE_MS;assert.ok(cache.get('c'),'confirming the view current re-dates its pages');
 clock+=1;assert.equal(cache.get('c'),null,'never served past the maximum age');
 assert.throws(()=>createBrowsePageCache({maxEntries:1025}),/bounded/);assert.throws(()=>createBrowsePageCache({maxAgeMs:BROWSE_MAX_AGE_MS+1}),/bounded/);
});

test('every browse answer says plainly how old it is',()=>{
 const stamp={id:1,asOf:Date.parse('2026-11-10T00:00:00Z'),headerTime:'2026-11-09T23:59:58Z'},page={result:{},stamp,builtAt:stamp.asOf,from:'10',to:'12',consistent:false,bytes:0};
 const block=browseProvedBlock(page,stamp.asOf+42000,true,'/api/native/public/projects');
 assert.equal(block.as_of,'2026-11-10T00:00:00.000Z');assert.equal(block.age_seconds,42);assert.deepEqual(block.heights,{from:'10',to:'12'});assert.equal(block.consistent_snapshot,false);assert.equal(block.refreshing,true);assert.equal(block.strict_read,'/api/native/public/projects');
 assert.match(block.note,/proved on the chain/);assert.match(block.note,/42 seconds ago/);assert.match(block.note,/newer copy/);
 assert.equal(browseChainTime(stamp,stamp.asOf+42000),'2026-11-10T00:00:40.000Z','discovery deadlines use the proved block time plus the time since');
});

test('browse pages survive events landing during every read; strict twins refuse; a cold page answers a retry-after inside the gateway',async()=>{
 const root=await mkdtemp(join(tmpdir(),'uain-public-browse-')),genesis=join(root,'genesis.json'),binary=join(root,'proof-reader'),dataFile=join(root,'data.json'),counter=join(root,'counter'),blocked=join(root,'blocked');
 const ids=['alzheimer','cancer','longevity','test1'],records={'legacy_import':{status:'ready'},'legacy/reconciliation':{table_counts:{contributions:'0'}},'credit_count':'0','karma_count':'0'};
 records['legacy/catalog/projects/00000000']={table:'projects',page:0,total:ids.length,rows:ids.map(id=>Buffer.from(JSON.stringify([id])).toString('base64url'))};
 for(const id of ids){records['legacy_project/'+id]={id,lead:'lead',state:'active',work_ids:[],task_ids:[],claim_ids:[]};records['legacy/row/projects/'+Buffer.from(JSON.stringify([id])).toString('base64url')]={table:'projects',row:{id,title:id,summary:'Public original '+id,stop_conditions:'[]',opened_at:'2026-10-01T00:00:00Z'}}}
 await writeFile(genesis,'{}');await writeFile(dataFile,JSON.stringify({events:'1',records}));await writeFile(counter,'0');
 // A checkpoint (it reads credit_count) sees the projected head; every other batch sees one more
 // event and a higher block, as when the starter signs during a read.
 const script=`#!/usr/bin/env node\nconst fs=require('node:fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const s=JSON.parse(input),d=JSON.parse(fs.readFileSync(${JSON.stringify(dataFile)})),keys=s.keys??[];const n=Number(fs.readFileSync(${JSON.stringify(counter)},'utf8'))+1;fs.writeFileSync(${JSON.stringify(counter)},String(n));if(fs.existsSync(${JSON.stringify(blocked)})){const until=Date.now()+1500;while(Date.now()<until){}}const checkpoint=keys.includes('credit_count'),events=checkpoint||!d.moving?d.events:String(Number(d.events)+n);const r=Object.fromEntries([...new Set([...keys,'legacy_import','legacy/reconciliation'])].map(k=>[k,d.records[k]??null]));fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify({chain_id:'test-chain',height:String(40+n),event_count:events,app_hash:'a'.repeat(64),header_time:new Date().toISOString(),records:r}),{mode:0o600});});\n`;
 await writeFile(binary,script,{mode:0o700});let t;const savedWait=process.env.UAIN_PUBLIC_BROWSE_WAIT_MS;
 try{
  const epoch=createHash('sha256').update('{}').digest('hex');t=await boot({UAIN_AUTHORITY:'native',UAIN_NATIVE_PROJECTION:'1',UAIN_NATIVE_STATE_BINARY:binary,UAIN_NATIVE_STATE_SHA256:createHash('sha256').update(script).digest('hex'),UAIN_NATIVE_GENESIS:genesis,UAIN_NATIVE_GENESIS_SHA256:epoch,UAIN_NATIVE_RPC:'http://127.0.0.1:1'});
  const{pool}=await import('../dist/src/storage/store.js');await pool.query('INSERT INTO native_epochs(epoch,chain_id,genesis_sha256,cursor) VALUES($1,$2,$1,$3)',[epoch,'test-chain','1']);
  await pool.query("INSERT INTO participants(id,did,name,operator,reachability,region,lon,lat,enrolled_at,last_seen_at) VALUES('lead','did:fixture:lead','Lead','Fixture','none','',0,0,'2026-10-01','2026-10-01')");
  for(const id of ids)await pool.query('INSERT INTO projects(id,title,summary,lead,state,stop_conditions,opened_at) VALUES($1,$1,$1,$2,$3,$4,$5)',[id,'lead','active','[]','2026-10-01T00:00:00Z']);
  await writeFile(dataFile,JSON.stringify({events:'1',moving:true,records}));
  assert.equal((await t.http('/api/native/public/projects')).status,503,'a strict read still refuses a page whose batches moved past its head');
  const{warmNativePublicReads,nativePublicReady}=await import('../dist/src/api/native-public-read-routes.js');await warmNativePublicReads();assert.equal(nativePublicReady(),true,'the core pages are proved although every batch saw a new event');
  const page=await t.http('/api/projects');assert.equal(page.status,200);const body=await page.json();
  assert.deepEqual(body.projects.map(p=>p.id).sort(),ids);assert.equal(body.proved.consistent_snapshot,false);assert.ok(BigInt(body.proved.heights.to)>BigInt(body.proved.heights.from),'the page says its proofs span heights');
  assert.equal((await t.http('/api/projects/cancer')).status,200);assert.equal((await t.http('/api/stats')).status,200);
  assert.equal((await t.http('/api/projects/missing')).status,404,'a proved absence stays a 404');
  // Archiving a project changes the visibility key: the held page is not reused for it.
  await pool.query("INSERT INTO project_archives(project_id,reason,archived_at) VALUES('test1','Test archive','2026-10-01T00:00:00Z')");
  assert.equal((await(await t.http('/api/projects')).json()).count,3,'visibility is part of the page key');
  // A cold page while proofs are slow: a clear retry-after inside the gateway, never a hang.
  // Archiving another project opens a new view, whose opening proof is held up.
  process.env.UAIN_PUBLIC_BROWSE_WAIT_MS='300';await writeFile(blocked,'1');await pool.query("INSERT INTO project_archives(project_id,reason,archived_at) VALUES('alzheimer','Test archive','2026-10-01T00:00:00Z')");
  const at=Date.now(),cold=await t.http('/api/projects/cancer/claims');assert.equal(cold.status,503);assert.equal(cold.headers.get('retry-after'),'5');const why=await cold.json();assert.equal(why.retry_after_seconds,5);assert.match(why.message,/Try again/);assert.ok(Date.now()-at<3000,'the cold answer came within the wait bound');
  await rm(blocked);let after;for(let i=0;i<40;i++){after=await t.http('/api/projects/cancer/claims');if(after.status===200)break;await new Promise(r=>setTimeout(r,250))}assert.equal(after.status,200,'the build went on and the retry found it');
 }finally{if(savedWait===undefined)delete process.env.UAIN_PUBLIC_BROWSE_WAIT_MS;else process.env.UAIN_PUBLIC_BROWSE_WAIT_MS=savedWait;if(t){await t.db.flushLog();const{syncCounts}=await import('../dist/src/storage/ratelimit.js');await syncCounts();await t.close()}await rm(root,{recursive:true,force:true})}
});

#!/usr/bin/env node
// Prepare an identity/history SHADOW snapshot. This is not a complete migration:
// projects, obligations, instance attribution and artifact availability must be
// reconciled before an authoritative cutoff. Read-only public API requests only.
import {createHash,createPublicKey,verify} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const api=(process.env.UAIN_API??'https://uain.global').replace(/\/$/,'');
const output=resolve(process.argv[2]??'snapshot');
// Independently pinned in lib/onchain.ts and the existing ledger-root workflow.
const pem='-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAje31vIyrita/VWJVnmVgQkPJjGmH0od88CqK+irV3M8=\n-----END PUBLIC KEY-----\n';
const key=createPublicKey(pem);
const sha=value=>createHash('sha256').update(value).digest('hex');
async function get(path){const r=await fetch(api+path,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(`${path}: HTTP ${r.status}`);return r.json();}
const start=await get('/api/ledger/head');
const directory=await get('/api/directory?page_size=100');assert.equal(directory.pages,1,'implement paging before export');
const members=[];const unclaimed=[];const seen=new Set();
for(const row of directory.participants){const id=row.member?.address;if(!id)throw Error('directory row without member identity');if(!/^uain1[0-9a-f]{40}$/.test(id)){unclaimed.push(row);continue;}if(seen.has(id))continue;seen.add(id);
 const original=await get('/api/members/'+id);const raw=Buffer.from(original.public_key,'base64url');assert.equal('uain1'+sha(raw).slice(0,40),id,'member key/address mismatch');
 const creditAmounts=original.agents.map(a=>{assert.ok(Number.isSafeInteger(a.credits)&&a.credits>=0,'unsafe legacy credits');return BigInt(a.credits);});
 assert.ok(Number.isSafeInteger(original.karma),'unsafe legacy Karma');
 members.push({id,public_key:original.public_key,name:original.name,operator:row.operator,family:row.model??'',licence:original.licence.status,karma:original.karma,credits:creditAmounts.reduce((a,b)=>a+b,0n).toString(),sequence:'0',default_verifier:false,creator:false,active_projects:0});
}
members.sort((a,b)=>a.id.localeCompare(b.id));
const guardian='uain158ac8d0debcf01d43164ef14736597da589d8b54';assert.ok(members.some(m=>m.id===guardian&&m.licence==='active'),'UAIN Review guardian unavailable');
const events=[];let cursor=0;
for(;;){const page=await get(`/api/events?after_id=${cursor}&limit=500`);events.push(...page.events);if(!page.more)break;assert.ok(page.cursor>cursor,'cursor did not advance');cursor=page.cursor;}
let previous='0'.repeat(64),version=null;
for(const e of events){assert.equal(e.prev_hash,previous,`event ${e.id} linkage`);const v=Number(e.hash_version??1);
 if(v===2){if(e.redacted){assert.equal(e.summary,'[redacted: participant record purged by the operator]');assert.equal(e.salt,null);assert.equal(e.commits,null);}else assert.equal(sha(e.salt+'\n'+JSON.stringify([e.summary,e.commits??null])),e.content_digest,`event ${e.id} content`);
 assert.equal(sha(e.prev_hash+'\n'+JSON.stringify([2,e.id,e.at,e.kind,e.actor,e.peer??null,e.content_digest??null,version])),e.hash,`event ${e.id} hash`);
 }else if(v===1){if(!e.redacted)assert.equal(sha(e.prev_hash+'\n'+JSON.stringify([e.id,e.at,e.kind,e.actor,e.peer??null,e.summary])),e.hash,`event ${e.id} legacy hash`);}else throw Error('unknown hash version');previous=e.hash;version=v;
}
assert.equal(previous,start.hash);assert.equal(events.length,start.count);assert.equal(events.at(-1).id,start.id);
const rootResult=await get('/api/ledger/roots?from=2026-09-21');const roots=rootResult.roots.filter(r=>!r.provisional);
function merkle(leaves){let level=leaves.map(h=>Buffer.from(h,'hex'));assert.ok(level.length);while(level.length>1){const next=[];for(let i=0;i<level.length;i+=2)next.push(Buffer.from(sha(Buffer.concat([level[i],level[i+1]??level[i]])),'hex'));level=next;}return level[0].toString('hex');}
for(const r of roots){const day=events.filter(e=>e.at.slice(0,10)===r.date);assert.equal(day.length,r.count);assert.equal(day[0].id,r.first_id);assert.equal(day.at(-1).id,r.last_id);assert.equal(day.at(-1).hash,r.head);assert.equal(merkle(day.map(e=>e.hash)),r.root);
 const payload={date:r.date,root:r.root,head:r.head,count:r.count,first_id:r.first_id,last_id:r.last_id};assert.ok(verify(null,Buffer.from(JSON.stringify(payload)),key,Buffer.from(r.signature,'base64')),`root ${r.date} signature`);}
const end=await get('/api/ledger/head');assert.deepEqual(end,start,'ledger changed during capture; retry from a new consistent snapshot');
const snapshot={version:1,kind:'identity-and-history-shadow',api,head:start,members,unclaimed,events,roots,pinned_public_key:pem};
const encoded=JSON.stringify(snapshot);const digest=sha(encoded);
const genesis={version:1,guardians:[guardian],members,legacy:{manifest_digest:digest,ledger_head:start.hash,last_event_id:start.id,pinned_public_key:pem}};
await mkdir(output,{recursive:true});await writeFile(resolve(output,'public-snapshot.json'),encoded+'\n',{flag:'wx'});await writeFile(resolve(output,'app-genesis.json'),JSON.stringify(genesis,null,2)+'\n',{flag:'wx'});
const receipt={kind:snapshot.kind,manifest_digest:digest,members:members.length,unclaimed_instances:unclaimed.length,events:events.length,completed_roots:roots.length,ledger_head:start.hash,last_event_id:start.id,genesis_file:resolve(output,'app-genesis.json')};await writeFile(resolve(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(receipt,null,2));

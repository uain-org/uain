#!/usr/bin/env node
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {captureSnapshot} from './capture.mjs';
import {stableJSON} from './snapshot.mjs';
import {migrationPage} from './plan.mjs';
import {sourcePublicPolicy} from './public-policy.mjs';
const require=createRequire(new URL('../../services/pilot/package.json',import.meta.url));
const {Client}=require('pg');
const [outputPath,keyPath,guardian,policyPath]=process.argv.slice(2);
if(!outputPath||!keyPath||!policyPath||!/^uain1[0-9a-f]{40}$/.test(guardian??''))throw Error('usage: DATABASE_URL=<read-only connection> node chain/migration/export.mjs NEW_DIRECTORY PINNED_LEDGER_PUBLIC_KEY GUARDIAN REVIEWED_PUBLIC_POLICY_JSON');
const publicPolicy=sourcePublicPolicy(JSON.parse(await readFile(policyPath,'utf8')));
const client=new Client({connectionString:process.env.DATABASE_URL,application_name:'uain-read-only-legacy-export'});
await client.connect();let snapshot;
try{snapshot=await captureSnapshot(client,{pinnedPublicKey:await readFile(keyPath,'utf8'),publicPolicy});}finally{await client.end();}
const members=snapshot.reconciliation.members.map(({instances,...m})=>({...m,karma:Number(m.karma)}));
if(!members.some(m=>m.id===guardian&&m.licence==='active'))throw Error('guardian must be a keyed active source member');
const legacy={manifest_digest:snapshot.manifest_digest,ledger_head:snapshot.reconciliation.ledger.head,last_event_id:Number(snapshot.reconciliation.ledger.last_event_id),pinned_public_key:snapshot.pinned_public_key};
const genesis={version:1,guardians:[guardian],members,legacy};
const begin={manifest_digest:snapshot.manifest_digest,records_root:snapshot.records_root,total_records:String(snapshot.records.length),accounts:String(members.length),ledger_head:legacy.ledger_head,last_event_id:String(legacy.last_event_id)};
const pages=[];for(let start=0;start<snapshot.records.length;){const records=migrationPage(snapshot,start);pages.push({start:String(start),records});start+=records.length;}
// Directory creation is exclusive: never replace a prior approved migration.
const output=resolve(outputPath);await mkdir(output,{recursive:false,mode:0o700});
for(const [name,value] of [['snapshot.json',snapshot],['app-genesis.json',genesis],['begin.json',begin],['pages.json',pages],['reconciliation.json',snapshot.reconciliation]])await writeFile(resolve(output,name),stableJSON(value)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({manifest_digest:snapshot.manifest_digest,records_root:snapshot.records_root,records:snapshot.records.length,table_counts:snapshot.reconciliation.table_counts,members:members.length,unclaimed:snapshot.reconciliation.unclaimed.length,obligations:snapshot.reconciliation.obligations.length,cutoff_ready:snapshot.reconciliation.cutoff_ready}));

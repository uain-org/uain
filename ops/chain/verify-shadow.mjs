#!/usr/bin/env node
// Read-only proof capture over SSH. RPC remains loopback-only on both hosts.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const run=promisify(execFile);
const [genesisArg,proofArg,destination]=process.argv.slice(2);
if(!genesisArg||!proofArg||!destination)throw Error('usage: verify-shadow.mjs PINNED_PUBLIC_GENESIS PROOF_BINARY NEW_OUTPUT_DIRECTORY');
const genesisPath=resolve(genesisArg),proofBinary=resolve(proofArg),output=resolve(destination);
const raw=await readFile(genesisPath);const genesis=JSON.parse(raw);
assert.equal(genesis.chain_id,'uain-shadow-20261008-1');
assert.equal(createHash('sha256').update(raw).digest('hex'),'54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff','genesis differs from installed public trust anchor');
await mkdir(output); // Deliberately refuse an existing receipt directory.
const hosts=['uain-app-1','uain-db-1'];
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const python=`import json,sys,urllib.request
out=[]
for i,r in enumerate(json.loads(sys.argv[1])):
 p=json.dumps(dict(jsonrpc='2.0',id=i,**r)).encode()
 req=urllib.request.Request('http://127.0.0.1:26667',data=p,headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=10) as f: d=json.load(f)
 if 'error' in d: raise RuntimeError(d['error'])
 out.append(d['result'])
print(json.dumps(out))`;
async function rpc(host,requests){const {stdout}=await run('ssh',[host,'python3 -c '+quote(python)+' '+quote(JSON.stringify(requests))],{timeout:60000,maxBuffer:4*1024*1024});return JSON.parse(stdout);}
const statuses=await Promise.all(hosts.map(h=>rpc(h,[{method:'status'},{method:'net_info'}])));
statuses.forEach(([s,n],i)=>{assert.equal(s.node_info.network,genesis.chain_id);assert.equal(s.sync_info.catching_up,false);assert.equal(s.validator_info.voting_power,i===0?'10':'0');assert.ok(Number(n.n_peers)>=1);});
const height=Math.min(...statuses.map(([s])=>Number(s.sync_info.latest_block_height)))-2;
assert.ok(Number.isSafeInteger(height)&&height>1);
const keys=['legacy',...genesis.app_state.members.map(m=>'member/'+m.id)];
const requests=[{method:'commit',params:{height:String(height+1)}},...keys.map(key=>({method:'abci_query',params:{path:'/store/federation/key',data:Buffer.from(key).toString('hex'),height:String(height),prove:true}}))];
const captures=await Promise.all(hosts.map(h=>rpc(h,requests)));
assert.equal(captures[0][0].signed_header.header.app_hash,captures[1][0].signed_header.header.app_hash);
const checks=[];
for(let n=0;n<hosts.length;n++)for(let i=0;i<keys.length;i++){
 const query=captures[n][i+1].response;
 assert.equal(query.value,captures[0][i+1].response.value,'state differs between hosts');
 const value=JSON.parse(Buffer.from(query.value,'base64'));
 assert.deepEqual(value,i===0?genesis.app_state.legacy:genesis.app_state.members[i-1]);
 const path=join(output,`${hosts[n]}-${i}.json`);
 await writeFile(path,JSON.stringify({signed_header:captures[n][0].signed_header,query},null,2)+'\n',{flag:'wx'});
 const {stdout}=await run(proofBinary,['--genesis',genesisPath,'--bundle',path,'--key',keys[i]],{timeout:10000,maxBuffer:65536});
 assert.ok(stdout.includes('STATE_PROOF_VERIFIED'));
 checks.push({host:hosts[n],key:keys[i],proof_verified:true});
}
const ready=await fetch('https://uain.global/api/ready',{signal:AbortSignal.timeout(15000)});assert.equal(ready.status,200);
const receipt={checked_at:new Date().toISOString(),chain_id:genesis.chain_id,genesis_sha256:createHash('sha256').update(raw).digest('hex'),height,app_hash:captures[0][0].signed_header.header.app_hash,validator_id:statuses[0][0].node_info.id,fullnode_id:statuses[1][0].node_info.id,genesis_members:genesis.app_state.members.length,checks,existing_federation_ready:true,trust:'fixed bootstrap validator set independently pinned in public genesis; RPC does not supply the trust anchor'};
await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({pass:true,height,app_hash:receipt.app_hash,members:receipt.genesis_members,proofs:checks.length,receipt:join(output,'receipt.json')},null,2));

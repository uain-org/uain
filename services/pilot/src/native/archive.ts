/** Retained epoch evidence is an archive, never a current signing or discovery
 * context. Verify content and independently retained genesis bytes; preserve
 * the original proof for readers without claiming fresh chain verification. */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import type pg from 'pg';
import {canonical,evidenceDocument} from './evidence.ts';
import {verifiedCommand} from './command-signature.ts';
const hex=(v:any)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
function requireArchive(value:any):asserts value {if(!value)throw Error('retained native research archive differs')}
function verifyArchivedSubmission(envelope:any,event:any){
 // Shape, key/member binding and signature: the one routine (command-signature.ts).
 const signed=verifiedCommand(envelope);requireArchive(signed);
 const command=signed.command;
 requireArchive(command.version===1&&command.operation==='submit');
 requireArchive(typeof command.chain_id==='string'&&command.chain_id.length<=128);
 requireArchive(typeof command.sequence==='string'&&/^(0|[1-9][0-9]*)$/.test(command.sequence)&&BigInt(command.sequence)<=18446744073709551615n&&typeof command.expires_height==='string'&&/^[1-9][0-9]*$/.test(command.expires_height)&&BigInt(command.expires_height)<=9223372036854775807n);
 requireArchive(command.payload&&Object.keys(command.payload).sort().join(',')==='evidence_digest,id,task'&&Object.values(command.payload).every(value=>typeof value==='string'));
 requireArchive(event.command_digest===sha(signed.bytes));
}
async function retainedGenesis(currentGenesis:string,epoch:string,chain:string){
 const path=resolve(join(dirname(currentGenesis),'..',epoch,'genesis.json'));
 requireArchive(await realpath(path)===path);
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const info=await fd.stat();requireArchive(info.isFile()&&info.size<=8*1024*1024);
  const buffer=Buffer.alloc(Math.min(info.size+1,8*1024*1024+1));let length=0;
  while(length<buffer.length){const {bytesRead}=await fd.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead}
  const raw=buffer.subarray(0,length);requireArchive(length===info.size&&sha(raw)===epoch&&JSON.parse(raw.toString()).chain_id===chain);
 }finally{await fd.close()}
}
function archivedRecord(proofs:any[],key:string){
 const matches=proofs.flatMap(p=>(p.queries??[]).filter((q:any)=>typeof q.key==='string'&&Buffer.from(q.key,'base64').toString()===key).map((q:any)=>({p,q})));
 requireArchive(matches.length>0);const {p,q}=matches[0];requireArchive(q.code===0&&q.height===p.height&&typeof q.value==='string'&&q.value.length<=4*1024*1024);
 const value=JSON.parse(Buffer.from(q.value,'base64').toString());requireArchive(canonical(value)===canonical(p.records[key]));return value;
}
function originalArchivedBody(row:any){
 const proofs=row.proof,submittedKey='legacy_submission/'+row.id;
 const workKey=['legacy_work/'+row.id,'legacy/work/'+row.id].find(key=>proofs.some((p:any)=>p.records?.[key]));requireArchive(workKey);const work=archivedRecord(proofs,workKey);requireArchive(work.project===row.project_id&&work.task===row.task_id&&work.member===row.contributor&&work.author===row.instance);
 if(proofs.some((p:any)=>p.records?.[submittedKey]))return archivedRecord(proofs,submittedKey).payload;
 const lookup=archivedRecord(proofs,'legacy/lookup/contributions/'+row.id);requireArchive(typeof lookup.source==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(lookup.source));
 const base='legacy/row/contributions/'+lookup.source,first=archivedRecord(proofs,base);let source=first;
 if(!first.row){
  requireArchive(Number.isInteger(first.parts)&&first.parts>=1&&first.parts<=210&&hex(first.row_sha256));const parts:Buffer[]=[];
  for(let i=0;i<first.parts;i++){const part=archivedRecord(proofs,'legacy/chunk/contributions/'+lookup.source+'/'+String(i).padStart(6,'0'));requireArchive(typeof part==='string'&&part.length<=14000);parts.push(Buffer.from(part,'base64'))}
  const raw=Buffer.concat(parts);requireArchive(raw.length<=2*1024*1024&&sha(raw)===first.row_sha256);source=JSON.parse(raw.toString());
 }
 requireArchive(source.table==='contributions'&&source.row?.id===row.id&&source.row.contributor===row.instance&&source.row.project_id===row.project_id&&(source.row.task_id??'')===row.task_id);return source.row;
}
export async function archivedResearchDocument(pool:pg.Pool,currentGenesis:string,epoch:string,id:string){
 requireArchive(hex(epoch)&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id));
 const meta=(await pool.query('SELECT epoch,chain_id,genesis_sha256,cursor,retired_at FROM native_epochs WHERE epoch=$1',[epoch])).rows[0];
 if(!meta?.retired_at)return{status:409,body:{error:'native_epoch_not_archived'}};
 requireArchive(meta.epoch===epoch&&meta.genesis_sha256===epoch&&typeof meta.chain_id==='string'&&meta.chain_id.length<=128);
 await retainedGenesis(currentGenesis,epoch,meta.chain_id);
 const row=(await pool.query('SELECT * FROM native_research_documents WHERE epoch=$1 AND id=$2',[epoch,id])).rows[0];
 if(!row)return{status:404,body:{error:'native_archived_research_not_found',epoch,id}};
 requireArchive(row.epoch===epoch&&row.id===id&&['legacy','native'].includes(row.source_kind)&&Buffer.byteLength(JSON.stringify(row))<=16*1024*1024);
 requireArchive(row.body!==null&&hex(row.source_hash));
 requireArchive(Array.isArray(row.proof)&&row.proof.length>0&&row.proof.length<=128&&row.proof.every((p:any)=>p?.chain_id===meta.chain_id)&&row.proof.some((p:any)=>p.height===row.state_height&&p.app_hash===row.app_hash));
 let publication:any=null;
 if(row.source_kind==='legacy'){const original=originalArchivedBody(row);requireArchive(canonical(original)===canonical(row.body)&&sha(JSON.stringify(original))===row.source_hash)}
 if(row.source_kind==='native'){
  const document=evidenceDocument(row.body);requireArchive(document.digest===row.evidence_digest);
  const contribution=archivedRecord(row.proof,'contribution/'+id),task=archivedRecord(row.proof,'task/'+row.task_id);requireArchive(contribution.id===id&&contribution.task===row.task_id&&contribution.author===row.contributor&&(contribution.author_instance??'')===row.instance&&contribution.evidence_digest===document.digest&&task.project===row.project_id);
  publication=(await pool.query('SELECT * FROM native_publications WHERE epoch=$1 AND id=$2',[epoch,id])).rows[0];
  const receipt=publication?.receipt,event=receipt?.state?.receipt?.event,command=receipt?.envelope?.command;
  requireArchive(publication?.epoch===epoch&&publication.id===id&&publication.member===row.contributor&&publication.instance===row.instance&&publication.evidence_digest===document.digest&&publication.canonical_body===document.canonical&&canonical(publication.body)===document.canonical);
  requireArchive(receipt?.state?.chain_id===meta.chain_id&&receipt.state.receipt.finalized===true&&event?.operation==='submit'&&event.subject===id&&event.member===row.contributor&&(event.instance??'')===row.instance&&command?.operation==='submit'&&command.chain_id===meta.chain_id&&command.member===row.contributor&&(command.instance??'')===row.instance&&command.payload?.id===id&&command.payload.task===row.task_id&&command.payload.evidence_digest===document.digest);
  verifyArchivedSubmission(receipt.envelope,event);requireArchive(sha(JSON.stringify(publication.body))===row.source_hash);
  const capsule={format:'uain-native-publication-v1',epoch,id,evidence_digest:document.digest,canonical_body:document.canonical,receipt};requireArchive(hex(publication.replica_digest)&&sha(canonical(capsule))===publication.replica_digest);
 }
 return{status:200,body:{...row,authority:'native-archive',publication,archive:{chain_id:meta.chain_id,genesis_sha256:epoch,retired_at:meta.retired_at,finalized_event_cursor:meta.cursor,independently_retained_genesis_verified:true,current_chain_verified:false,proof_status:'retained_epoch_evidence',canonical_body_sha256:sha(canonical(row.body)),submission_signature_verified:row.source_kind==='native'},guidance:'This research and its original proof belong to a retired epoch. They are retained evidence and do not authorize current commands or establish current chain state.'}};
}
export async function archivedNativeEpochs(pool:pg.Pool,after='',limit=20){
 requireArchive((after===''||hex(after))&&Number.isInteger(limit)&&limit>=1&&limit<=100);
 const rows=(await pool.query(`SELECT e.epoch,e.chain_id,e.genesis_sha256,e.cursor,e.state_height,e.app_hash,e.retired_at,
 (SELECT count(*)::text FROM native_research_documents d WHERE d.epoch=e.epoch) AS research_count
 FROM native_epochs e WHERE e.retired_at IS NOT NULL AND ($1::text='' OR e.epoch<$1) ORDER BY e.epoch DESC LIMIT $2`,[after,limit+1])).rows;
 for(const row of rows)requireArchive(hex(row.epoch)&&row.genesis_sha256===row.epoch&&row.retired_at);
 const selected=rows.slice(0,limit);return{authority:'native-archive',epochs:selected,more:rows.length>limit,next_after:rows.length>limit?selected.at(-1)?.epoch:null,current_chain_verified:false};
}

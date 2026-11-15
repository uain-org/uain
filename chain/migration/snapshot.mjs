import {sourcePublicPolicy,sourceIssuanceRecords} from './public-policy.mjs';
import {compatibilityCapsules} from './capsules.mjs';
import {createHash,createPublicKey,verify} from 'node:crypto';
import assert from 'node:assert/strict';
import {COLUMNS,TABLES} from './schema.mjs';
export {COLUMNS,TABLES};
const sha=value=>createHash('sha256').update(value).digest('hex');
const compare=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
export function stableJSON(value){
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){assert.ok(Number.isFinite(value),'non-finite source number');return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(stableJSON).join(',')+']';
 assert.ok(value&&Object.getPrototypeOf(value)===Object.prototype,'unsupported source value');
 return '{'+Object.keys(value).sort(compare).map(k=>JSON.stringify(k)+':'+stableJSON(value[k])).join(',')+'}';
}
function integer(value,name){
 assert.ok(typeof value==='string'&&/^-?(0|[1-9][0-9]*)$/.test(value)||Number.isSafeInteger(value),`unsafe ${name}`);
 return BigInt(value);
}
function safeNumber(value,name){const n=integer(value,name);assert.ok(n>=0&&n<=9007199254740991n,`unsafe ledger ${name}`);return Number(n);}
const keyFields={reset_public_records:['path'],reset_reserved_ids:['kind','record_id'],project_archives:['project_id'],agent_runs:['participant_id','source','external_id'],project_members:['project_id','member_id'],task_workers:['task_id','participant'],item_workers:['item','participant'],ledger_roots:['date'],task_passes:['task_id','participant'],item_declines:['item','participant']};
export const rowID=(table,row)=>Buffer.from(stableJSON((keyFields[table]??['id']).map(k=>{assert.ok(row[k]!=null,`${table}: missing primary key ${k}`);return String(row[k]);}))).toString('base64url');
export const recordLeaf=(record,index)=>sha('uain:legacy-record:v1\n'+index+'\n'+record.key+'\n'+sha(record.value));
function merkle(leaves){
 assert.ok(leaves.length,'empty import');let levels=[leaves];
 while(levels.at(-1).length>1){const old=levels.at(-1),next=[];for(let i=0;i<old.length;i+=2)next.push(sha(Buffer.concat([Buffer.from(old[i],'hex'),Buffer.from(old[i+1]??old[i],'hex')])));levels.push(next);}
 return {root:levels.at(-1)[0],proofs:leaves.map((_,index)=>{const out=[];for(const level of levels.slice(0,-1)){out.push(level[index^1]??level[index]);index=Math.floor(index/2);}return out;})};
}
export function verifyRecord(record,index,siblings,root){
 if(!Number.isSafeInteger(index)||index<0||!Array.isArray(siblings)||siblings.length>32)return false;
 let value=recordLeaf(record,index);
 for(const sibling of siblings){if(!/^[0-9a-f]{64}$/.test(sibling))return false;value=sha(Buffer.concat((index%2?[sibling,value]:[value,sibling]).map(x=>Buffer.from(x,'hex'))));index=Math.floor(index/2);}
 return index===0&&value===root;
}
function verifyLedger(events,roots,pinned){
 const key=createPublicKey(pinned);assert.equal(key.asymmetricKeyType,'ed25519','pinned ledger key must be Ed25519');
 let previous='0'.repeat(64),previousVersion=null,lastID=0;
 for(const e of events){
  const id=safeNumber(e.id,'event id'),v=safeNumber(e.hash_version??'1','version'),redacted=integer(e.redacted??'0','redacted')!==0n;
  assert.ok(id>lastID,'ledger must be ordered by original numeric IDs');assert.equal(e.prev_hash,previous,`event ${id} linkage`);
  if(v===2){
   if(redacted){assert.equal(e.summary,'[redacted: participant record purged by the operator]');assert.equal(e.salt,null);assert.equal(e.commits,null);}
   else assert.equal(sha(e.salt+'\n'+JSON.stringify([e.summary,e.commits??null])),e.content_digest,`event ${id} original content digest`);
   assert.equal(sha(e.prev_hash+'\n'+JSON.stringify([2,id,e.at,e.kind,e.actor,e.peer??null,e.content_digest??null,previousVersion])),e.hash,`event ${id} original v2 hash`);
  }else if(v===1){if(!redacted)assert.equal(sha(e.prev_hash+'\n'+JSON.stringify([id,e.at,e.kind,e.actor,e.peer??null,e.summary])),e.hash,`event ${id} original v1 hash`);}
  else throw Error('unknown legacy hash version');
  previous=e.hash;previousVersion=v;lastID=id;
 }
 for(const root of roots){
  const rows=events.filter(e=>e.at.slice(0,10)===root.date),count=safeNumber(root.count,'root count');
  assert.equal(rows.length,count,`root ${root.date} count`);
  const payload={date:root.date,root:root.root,head:root.head,count,first_id:root.first_id==null?null:safeNumber(root.first_id,'root first ID'),last_id:root.last_id==null?null:safeNumber(root.last_id,'root last ID')};
  if(count){assert.equal(payload.first_id,safeNumber(rows[0].id,'first ID'));assert.equal(payload.last_id,safeNumber(rows.at(-1).id,'last ID'));assert.equal(payload.head,rows.at(-1).hash);assert.equal(payload.root,merkle(rows.map(r=>r.hash)).root);}
  else {assert.equal(root.root,null);assert.equal(root.head,null);}
  assert.ok(verify(null,Buffer.from(JSON.stringify(payload)),key,Buffer.from(root.signature,'base64')),`root ${root.date} signature against pinned key`);
 }
 return {head:previous,last_event_id:String(lastID),count:events.length};
}
const references={participants:{member_id:'members'},agent_runs:{participant_id:'participants'},projects:{lead:'participants'},project_members:{project_id:'projects',member_id:'participants'},contributions:{project_id:'projects',contributor:'participants',task_id:'tasks'},verifications:{contribution_id:'contributions',verifier:'participants'},amendments:{project_id:'projects',author:'participants'},claims:{project_id:'projects',created_by:'participants'},claim_revisions:{claim_id:'claims',base:'claim_revisions',author:'participants'},claim_reviews:{revision_id:'claim_revisions',reviewer:'participants'},tasks:{project_id:'projects',created_by:'participants',parent_task:'tasks',from_claim:'claims',closed_by:'participants',prize_contribution:'contributions'},prior_art_challenges:{task_id:'tasks',challenger:'participants',decided_by:'participants'},benevolence_flags:{project_id:'projects',task_id:'tasks',flagger:'participants',decided_by:'participants'},kpi_resolutions:{task_id:'tasks',resolved_by:'participants'},task_workers:{task_id:'tasks',participant:'participants'},member_wallets:{member_id:'members',bound_by:'participants'},credit_ledger:{participant:'participants'},credit_deferrals:{contribution_id:'contributions',participant:'participants'},karma_events:{participant_id:'participants'},test_attempts:{test_id:'skill_tests',participant_id:'participants'},task_passes:{task_id:'tasks',participant:'participants'}};
export function buildSnapshot(source,{pinnedPublicKey,publicPolicy}={}){
 assert.ok(pinnedPublicKey,'independently pinned ledger public key required');
 if(publicPolicy!==undefined)publicPolicy=sourcePublicPolicy(publicPolicy);
 assert.deepEqual(Object.keys(source).sort(),TABLES,'complete public table set required');
 const tables={};
 for(const table of TABLES){
  assert.ok(Array.isArray(source[table]),`${table} must be rows`);
  const seen=new Set();
  tables[table]=source[table].map(row=>{for(const column of Object.keys(row))assert.ok(COLUMNS[table].includes(column),`${table}: unreviewed/private column ${column}`);const id=rowID(table,row);assert.ok(!seen.has(id),`${table}: duplicate row`);seen.add(id);return structuredClone(row);}).sort((a,b)=>{
   // Ledger linkage has its historical numeric order; other keys sort by bytes.
   if(table==='events')return integer(a.id,'event ID')<integer(b.id,'event ID')?-1:1;
   return compare(rowID(table,a),rowID(table,b));
  });
 }
 const byID=Object.fromEntries(TABLES.map(t=>[t,new Map(tables[t].filter(r=>r.id!=null).map(r=>[String(r.id),r]))]));
 for(const [table,fields] of Object.entries(references))for(const row of tables[table])for(const [field,target] of Object.entries(fields))if(row[field]!=null)assert.ok(byID[target].has(String(row[field])),`${table}.${field}: missing ${target}/${row[field]}`);
 const ledger=verifyLedger(tables.events,tables.ledger_roots,pinnedPublicKey);
 const instances=tables.participants.map(p=>{
  const credits=integer(p.credits,'participant credits'),karma=integer(p.karma,'participant Karma');assert.ok(credits>=0n,'negative legacy credits');
  const creditSum=tables.credit_ledger.filter(e=>e.participant===p.id).reduce((n,e)=>n+integer(e.delta,'credit delta'),0n);
  const karmaSum=tables.karma_events.filter(e=>e.participant_id===p.id).reduce((n,e)=>n+integer(e.delta,'Karma delta'),0n);
  assert.equal(creditSum,credits,`${p.id} credit cache/journal mismatch`);assert.equal(karmaSum,karma,`${p.id} Karma cache/journal mismatch`);
  return {id:p.id,member:p.member_id??null,name:p.name,family:p.model??'',operator:p.operator,state:p.state,credits:credits.toString(),karma:karma.toString()};
 });
 const members=[],unclaimed=[];
 for(const m of tables.members){
  const owned=instances.filter(i=>i.member===m.id);
  const credits=owned.reduce((n,i)=>n+BigInt(i.credits),0n),karma=owned.reduce((n,i)=>n+BigInt(i.karma),0n);
  if(!m.public_key||m.state==='key_pending'){unclaimed.push({id:m.id,kind:'member',state:m.state,instances:owned.map(i=>i.id),credits:credits.toString(),karma:karma.toString()});continue;}
  const raw=Buffer.from(m.public_key,'base64url');assert.equal(raw.length,32,'invalid member Ed25519 key');assert.equal('uain1'+sha(raw).slice(0,40),m.id,'member address/key mismatch');
  assert.ok(karma>=-9223372036854775808n&&karma<=9223372036854775807n,'native Karma range');
  const primary=tables.participants.filter(p=>p.member_id===m.id).sort((a,b)=>compare((a.enrolled_at??'')+a.id,(b.enrolled_at??'')+b.id))[0];
  const licence=m.state==='withdrawn'?'withdrawn':m.state==='revoked'?'revoked':'active';assert.ok(licence!=='active'||karma>-10n,'active source licence below revocation threshold');
  const activeProjects=tables.projects.filter(p=>owned.some(i=>i.id===p.lead)&&!['halted','complete'].includes(p.state)).length;
  members.push({id:m.id,public_key:m.public_key,name:m.name,operator:primary?.operator??'Legacy member without instance',family:primary?.model??'',licence,karma:karma.toString(),credits:credits.toString(),sequence:'0',default_verifier:false,creator:false,active_projects:0,instances:owned});
 }
 members.sort((a,b)=>compare(a.id,b.id));
 for(const i of instances)if(!i.member)unclaimed.push({...i,kind:'instance'});
 const owner=participant=>{const i=instances.find(i=>i.id===participant);assert.ok(i,'missing obligation participant');return {instance:i.id,member:members.some(m=>m.id===i.member)?i.member:null,legacy_member:i.member};};
 const obligations=[];
 const add=(kind,table,row,recipient,amount)=>obligations.push({id:kind+':'+rowID(table,row),kind,table,source:rowID(table,row),...(recipient?owner(recipient):{}),...(amount!=null?{amount:String(amount)}:{}),record:Object.fromEntries(Object.entries(row).filter(([k])=>['id','participant','contributor','created_by','challenger','flagger','author','amount','kind','released_at','contribution_id','project_id','task_id','state','credits_awarded','credits_deferred','prize_due','award_pending','award_held','karma_awarded','submitted_at','settled_at','award_withheld','verifiers_required'].includes(k))),source_row_sha256:sha(stableJSON(row))});
 for(const r of tables.credit_deferrals)if(r.released_at==null)add('credit_deferral','credit_deferrals',r,r.participant,r.amount);
 for(const r of tables.contributions){
  if(r.award_pending!=null)add('future_award','contributions',r,r.contributor);
  if(r.prize_due!=null&&integer(r.prize_due,'prize due')>0n&&!byID.tasks.get(r.task_id)?.prize_contribution&&!r.award_withheld)add('prize_due','contributions',r,r.contributor,r.prize_due);
  if(!['settled','rejected'].includes(r.state))add('pending_contribution','contributions',r,r.contributor);
 }
 for(const r of tables.tasks)if(r.closed_at==null&&!r.prize_contribution)add('open_task','tasks',r,r.created_by);
 for(const [table,kind] of [['prior_art_challenges','prior_art_challenge'],['benevolence_flags','benevolence_flag'],['claim_revisions','claim_revision']])for(const r of tables[table])if(['open','draft','disputed'].includes(r.state))add(kind,table,r,r.challenger??r.flagger??r.author);
 obligations.sort((a,b)=>compare(a.id,b.id));
 const reconciliation={version:1,policy:'legacy-preservation-v1',ledger,completed_roots:tables.ledger_roots.length,table_counts:Object.fromEntries(TABLES.map(t=>[t,tables[t].length])),members,unclaimed,obligations,coin_issued:'0',cutoff_ready:obligations.length===0&&unclaimed.length===0};
 const manifest={version:1,kind:'complete-public-federation-snapshot',tables,reconciliation,pinned_public_key:pinnedPublicKey,...(publicPolicy?{public_policy:publicPolicy}:{})};
 const manifestDigest=sha(stableJSON(manifest)),records=[];
 for(const table of TABLES)for(const row of tables[table]){
  const id=rowID(table,row),value=stableJSON({table,row}),key=`legacy/row/${table}/${id}`;
  if(Buffer.byteLength(value)<=16384)records.push({key,value});
  else {const bytes=Buffer.from(value),parts=[];for(let at=0;at<bytes.length;at+=10000)parts.push(bytes.subarray(at,at+10000).toString('base64'));
   records.push({key,value:stableJSON({table,row_sha256:sha(bytes),parts:parts.length})});
   parts.forEach((data,n)=>records.push({key:`legacy/chunk/${table}/${id}/${String(n).padStart(6,'0')}`,value:JSON.stringify(data)}));
  }
 }
 for(const table of TABLES)for(const row of tables[table]){
  const alias=row.id??(table==='ledger_roots'?row.date:null);
  if(alias!=null)records.push({key:`legacy/lookup/${table}/${alias}`,value:stableJSON({source:rowID(table,row)})});
 }
 for(const table of TABLES)for(let at=0;at<tables[table].length;at+=32)records.push({key:`legacy/catalog/${table}/${String(at/32).padStart(8,'0')}`,value:stableJSON({table,page:at/32,total:tables[table].length,rows:tables[table].slice(at,at+32).map(row=>rowID(table,row))})});
 for(const m of members){const native={...m,karma:safeSignedKarma(m.karma),instances:m.instances.map(i=>({...i,karma:safeSignedKarma(i.karma)}))};records.push({key:'legacy/account/'+m.id,value:stableJSON(native)});}
 for(const obligation of obligations)records.push({key:'legacy/obligation/'+obligation.id,value:stableJSON(obligation)});
 for(const table of ['projects','tasks','contributions','claims','skill_tests'])for(const row of tables[table])records.push({key:`legacy/reserved/${table}/${row.id}`,value:JSON.stringify({source:rowID(table,row)})});
 for(const capsule of compatibilityCapsules(tables,{publicPolicy}))records.push({key:capsule.key,value:stableJSON(capsule.value)});
 if(publicPolicy)for(const record of sourceIssuanceRecords(tables,publicPolicy))records.push({...record,value:stableJSON(JSON.parse(record.value))});
 records.push({key:'legacy/reconciliation',value:stableJSON({manifest_digest:manifestDigest,version:1,policy:reconciliation.policy,ledger,table_counts:reconciliation.table_counts,completed_roots:reconciliation.completed_roots,coin_issued:'0',cutoff_ready:reconciliation.cutoff_ready,member_count:members.length,unclaimed_count:unclaimed.length,obligation_count:obligations.length})});
 records.sort((a,b)=>compare(a.key,b.key));
 // Oversized obligation/account/reconciliation records need explicit paging,
 // never silent truncation. Raw research rows already use byte-preserving chunks.
 for(const r of records)assert.ok(Buffer.byteLength(r.value)<=16384,`projection exceeds bounded record: ${r.key}`);
 const tree=merkle(records.map(recordLeaf));
 return {...manifest,manifest_digest:manifestDigest,records_root:tree.root,records,proofs:tree.proofs};
}
function safeSignedKarma(value){const n=BigInt(value);assert.ok(n>=-9007199254740991n&&n<=9007199254740991n,'Karma outside portable JSON range');return Number(n);}

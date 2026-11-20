/** Compatibility reads for public pages. Original descriptions are immutable
 * source rows; current states and ownership always come from the pinned chain.
 * This module performs no pilot writes and accepts no unverified caller state. */
import {createHash} from 'node:crypto';
import {evidenceDocument} from './evidence.ts';
import {normalizeAddress} from '../identity/wallet-proof.ts';
// Karma v2 (DEC-TASK-057): violations add strikes and never lower Karma; 10 revoke the licence. The chain omits zero.
const strikeCount=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:0;
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const validID=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v);
const arr=(value:any):any[]=>value==null?[]:typeof value==='string'?JSON.parse(value):value;
/** Legacy research rows are served in the form the ledger committed to, which is the form the pilot
 * served (services/pilot/src/application/db.ts, hydrateContribution): JSON text parsed, an empty
 * revised claim as null, and novelty_event_id as a number. Otherwise verify-ledger.mjs cannot
 * recompute the digests of version 2 entries (docs/ledger.md: the fields "as the API serves them").
 * Decided by Rahul on 15 November 2026 (docs/security/todos.md, option a). Values that are already
 * structured pass through unchanged, and text that does not parse is left as it is. */
const parsedText=(value:any,empty:any)=>{if(typeof value!=='string')return value;if(value==='')return empty;try{return JSON.parse(value)}catch{return value}};
/** A claim revision's id as the ledger committed it (services/pilot/src/ledger/records.ts,
 * revisionCommitment: `revision: r.id`, `base: r.base`): the pilot's numeric row id as a number, so
 * verify-ledger.mjs finds "CL-n revision 3" and recomputes its digest, and the MCP claim tools'
 * integer base_revision round-trips. A native proposal id (`native:...`) was never committed by the
 * pilot ledger and stays a string. Served as a string before 17 November 2026. */
export const committedRevisionId=(value:any)=>typeof value==='number'?value:/^[0-9]{1,15}$/.test(String(value))?Number(value):String(value);
export function committedResearchForm(c:any){
 const out={...c};
 if(typeof out.reproduction==='string')out.reproduction=parsedText(out.reproduction,null);
 if(typeof out.forecast==='string')out.forecast=parsedText(out.forecast,null);
 for(const key of ['sources','source_checks'])if(typeof out[key]==='string')out[key]=parsedText(out[key],[]);
 out.verifications=(c.verifications??[]).map((v:any)=>{const r={...v};
  if(typeof r.against_claim_history==='string')r.against_claim_history=parsedText(r.against_claim_history,[]);
  if(typeof r.reproduction_receipt==='string')r.reproduction_receipt=parsedText(r.reproduction_receipt,null);
  if(typeof r.novelty_checked==='string')r.novelty_checked=parsedText(r.novelty_checked,null);
  if(r.revised_claim==='')r.revised_claim=null;
  if(typeof r.novelty_event_id==='string'&&/^[0-9]{1,15}$/.test(r.novelty_event_id))r.novelty_event_id=Number(r.novelty_event_id);
  return r});
 return out;
}
const amount=(value:any)=>{const n=Number(value??0);if(!Number.isSafeInteger(n))throw Error('unsafe public standing amount');return n};
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const rowKey=(table:string,id:string)=>'legacy/row/'+table+'/'+Buffer.from(JSON.stringify([id])).toString('base64url');
const tableOf:any={participant:'participants',member:'members',project:'projects',task:'tasks',contribution:'contributions',claim:'claims'};
const aliasOf:any={participant:'actor',member:'account',project:'project',task:'task',contribution:'work',claim:'claim'};
export function checkedNativeWalletBinding(current:any,member:string,network:'ethereum'|'solana',records:any){
 if(!current||current.active===false)return null;
 const normalized=normalizeAddress(network,current.address) as {address?:string;error?:string},address=normalized.address;
 if(current.policy!=='member-proved-external-wallet-v1'||current.member!==member||current.network!==network||current.active!==true||!/^\d{20}$/.test(current.binding)||typeof address!=='string'||(network==='ethereum'?address.toLowerCase()!==current.address||current.address==='0x'+'0'.repeat(40):address!==current.address))throw Error('native wallet binding proof identity differs');
 if(canonical(records['external_wallet_binding/'+current.binding])!==canonical(current)||records['external_wallet_end/'+current.binding]!==null||records['external_wallet_owner/'+network+'/'+current.address]!==member)throw Error('native wallet binding proof differs');
 return{address:current.address,binding:current.binding,bound_at:null,bound_height:current.height,proof:'/api/native/wallets/'+current.binding,ownership:'member-proved',network};
}
type Dependencies={visibility?:{isProjectVisible:(id:string)=>boolean};epoch:string;read:(selection:any)=>Promise<any>;query:(sql:string,args?:any[])=>Promise<any>;sourceCache?:{rows:Map<string,any>;bytes:number};catalogCache?:Map<string,string[]>;baselineMembers?:string[]};
/** Match the original publication and discovery rules against proved state. */
export function isNativeDiscoveryTask(task:any,project:any,status:string,time:string){
 if(!task?.prior_art||!task.verification||!project?.prior_art||![task.benevolence?.class,project.benevolence?.class].every(c=>['benevolent','neutral'].includes(c)))return false;
 const live=['open','needs_comparison','awaiting_verification'];
 if(status!=='all'&&(status==='sitemap'?!live.includes(task.status):task.status!==status))return false;
 if((live.includes(status)||status==='sitemap')&&(['halted','complete'].includes(project.state)||task.prior_art_challenges?.some((c:any)=>c.state==='open')))return false;
 if(status==='sitemap'&&task.prior_art_challenges?.some((c:any)=>c.state==='upheld'))return false;
 if((status==='open'||status==='sitemap'&&task.status==='open')&&task.kind==='future'&&!(Date.parse(task.resolves_by)>Date.parse(time)))return false;
 return true;
}
/** Imported tasks retain their original publication metadata. Current proved
 * original-policy work may be found without claiming later declarations exist.
 * This is discovery of a contribution path, never a reward or member grant. */
const researchBasis=(prior:any)=>{
 const basis=prior?.statement??prior?.basis,searches=prior?.searched??prior?.searches;
 return typeof basis==='string'&&!!basis.trim()&&Array.isArray(searches)&&new Set(searches.filter(s=>typeof s==='string'&&s.trim()).map(s=>s.trim())).size>=2;
};
const challenged=(rows:any[])=>rows?.some(c=>['open','upheld'].includes(c.state));
/**
 * Original research tasks closed to new work (10 November 2026). Their answers could only be
 * signed by the UAIN Client, retired that day; the uain-agent kit submits paid project tasks
 * only, so no current tool can submit them. A tester's signed submissions to both were refused
 * with only a bare code. They leave open discovery (the feed, /tasks, the MCP, the sitemap) and
 * their pages say why; existing results stay readable. The chain record is not changed.
 */
export const CLOSED_TO_NEW_WORK:Readonly<Record<string,string>>=Object.freeze({
 'T-37':'Closed to new work. Answers to this task could only be submitted with the UAIN Client, which was retired on 10 November 2026; the uain-agent kit submits paid project tasks only. The existing results stay readable below.',
 'T-39':'Closed to new work. Answers to this task could only be submitted with the UAIN Client, which was retired on 10 November 2026; the uain-agent kit submits paid project tasks only. Its check also asks two official sources to agree within 0.000001 while they differ by about 0.0001, so no honest answer could pass it. The existing result stays readable below.',
});
export function nativeTaskDiscovery(task:any,project:any,status:string,time:string):any|null{
 const closed=typeof task?.id==='string'&&Object.hasOwn(CLOSED_TO_NEW_WORK,task.id)?CLOSED_TO_NEW_WORK[task.id]:null;
 if(closed&&status==='sitemap')return null;
 const found=taskDiscovery(task,project,status,time);
 return found&&closed?{...found,closed_to_new_work:closed}:found;
}
const HISTORY_STATUSES=['needs_comparison','awaiting_verification','answered','closed'];
function taskDiscovery(task:any,project:any,status:string,time:string):any|null{
 const strict=isNativeDiscoveryTask(task,project,status,time);
 if(status==='sitemap')return strict?{policy:task.research_policy??'native',publication_status:'declared',metadata_missing:[]}:null;
 const legacy=task?.research_policy==='legacy'&&project?.research_policy==='legacy';
 if(legacy){
  if(strict&&(!['open','all'].includes(status)||task.status!=='open'))return{policy:'legacy',publication_status:'declared',metadata_missing:[]};
  // A lifecycle filter (answered, closed, needs_comparison, awaiting_verification) lists original-policy
  // tasks in exactly that status as read-only history (12 November 2026). Before, only open ones
  // reached discovery, so those filters always returned 0. 'open' and 'all' are unchanged.
  if(HISTORY_STATUSES.includes(status)){
   if(task.status!==status||task.submission?.malevolent||![task.benevolence?.class,project.benevolence?.class].every(c=>[null,undefined,'unreviewed','benevolent','neutral'].includes(c)))return null;
   return{policy:'legacy',publication_status:task.verification?'declared':'legacy_metadata_incomplete',read_only:true,existing_results:(task.results??[]).map((r:any)=>({id:r.id,state:r.state})),note:'Read-only history: this task is not taking new work. Its results stay readable with uain_tasks {task_id}.'};
  }
  if(!['open','all'].includes(status)||task.status!=='open'||task.submission?.state!=='open'||['halted','complete','closed'].includes(project.state)||!researchBasis(task.prior_art)||!researchBasis(project.prior_art))return null;
  if(!['question','done_when','how_to_check'].every(key=>typeof task[key]==='string'&&task[key].trim())||task.novelty==='known'||task.price?.won_by||task.submission.malevolent||task.submission.count>=task.submission.limit||project.work_count>=project.work_limit)return null;
  if(![task.benevolence?.class,project.benevolence?.class].every(c=>[null,undefined,'unreviewed','benevolent','neutral'].includes(c)))return null;
  if(challenged(task.prior_art_challenges)||challenged(task.benevolence_flags)||challenged(project.benevolence_flags))return null;
  if(task.kind==='future'&&(!(Date.parse(task.resolves_by)>Date.parse(time))||![null,undefined,'','awaiting'].includes(task.kpi_status)))return null;
  const missing=[];if(!task.verification)missing.push('task.verification');if(!['benevolent','neutral'].includes(task.benevolence?.class))missing.push('task.benevolence');if(!['benevolent','neutral'].includes(project.benevolence?.class))missing.push('project.benevolence');
  return{policy:'legacy',publication_status:missing.length?'legacy_metadata_incomplete':'declared',metadata_missing:missing,existing_results:(task.results??[]).map((r:any)=>({id:r.id,state:r.state})),contribution_requires:'Read existing results and disputed evidence first, identify an unresolved gap, and establish that the proposed contribution is new.',requires_project_join:true,reward_requires:'Independent verification and novelty attestations; discovery does not establish a reward.'};
 }
 return strict?{policy:task?.research_policy??'native',publication_status:'declared',metadata_missing:[]}:null;
}
export function createNativePublicReader(deps:Dependencies){return new NativePublicReader(deps)}
const DERIVED=['ids','resolve','member','participant','contribution','challenges','discoveryProject','task','claim','project'] as const,DERIVED_LIMIT=50000;
/** Participation records planned with a census; any beyond it are still proved on demand. */
const PARTICIPATION_PREFETCH=4096;
export class NativePublicReader{
 query:Dependencies['query'];private source=new Map<string,any>();private catalogs=new Map<string,string[]>();private chainID='';private cache={rows:this.source,bytes:0};
 constructor(private deps:Dependencies){this.query=deps.query;this.cache=deps.sourceCache??this.cache;this.source=this.cache.rows;this.catalogs=deps.catalogCache??this.catalogs;
  // One reader is one read: each catalogue id list and each derived row is worked out once and shared
  // by every row that needs it. Before (10 November 2026), every project row re-walked every
  // contribution and task, and ids() re-read the event projection on every call: one /api/projects
  // read sent 14,150 queries. Results come from the same proved records either way.
  for(const name of DERIVED){const plain=(this as any)[name].bind(this);(this as any)[name]=(...args:any[])=>{const key=name+'\u0000'+JSON.stringify(args);let hit=this.derived.get(key);if(!hit){if(this.derived.size>=DERIVED_LIMIT)this.derived.clear();hit=plain(...args);this.derived.set(key,hit)}return hit}}
 }
 private memo=new Map<string,any>();private latest:any;private derived=new Map<string,Promise<any>>();private joins?:Promise<any[]>;private censused=new Set<string>();
 /** Plans and proves the census of `kinds` in shared batches. One reader is one read, and what it
  * proved stays in its memo, so a kind it has already planned is not walked again: every project
  * page of a view used to re-walk the whole catalogue (about 3,000 keys) to find nothing missing. */
 async warm(wanted:string[]){
  const kinds=wanted.filter(kind=>!this.censused.has(kind));if(!kinds.length)return;
  await this.census(kinds);for(const kind of kinds)this.censused.add(kind);
 }
 private async census(kinds:string[]){
  const sourceTable=(kind:string)=>tableOf[kind]??(['amendments','claim_reviews','claim_revisions','verifications','prior_art_challenges','benevolence_flags','kpi_resolutions','tasks'].includes(kind)?kind:null);
  // Discover the immutable catalogs together; each page is still independently
  // proved and checked by ids() before any catalog identity is used.
  const planned=new Set<string>(),keys:string[]=[];
  const push=(target:string[],...selected:string[])=>{for(const key of selected)if(!planned.has(key)){planned.add(key);if(planned.size>20000)throw Error('public census warm-up exceeds bound');target.push(key)}};
  const tables=[...new Set(kinds.map(kind=>{const table=sourceTable(kind);if(!table)throw Error('unsupported public catalog');return table}))],catalogs:string[]=[];
  push(catalogs,...tables.filter(table=>!this.catalogs.has(table)).map(table=>'legacy/catalog/'+table+'/00000000'));await this.records(catalogs);
  for(const kind of kinds)for(const id of await this.ids(kind)){
   if(tableOf[kind]){
    const prefix=kind==='participant'?'instance':kind,alias=aliasOf[kind];
    push(keys,prefix+'/'+id,'legacy_'+alias+'/'+id,'legacy/'+alias+'/'+id,prefix+'_metadata/'+id);
    if(kind==='contribution')push(keys,'legacy_submission/'+id,'legacy_work_status/'+id,'legacy_future_award/'+id,'legacy_future_award_progress/'+id);
    if(kind==='task')push(keys,'legacy_task_opening/'+id);
    if(kind==='project')push(keys,'legacy_project_claims/'+id,'legacy_project_kpi/'+id,'legacy_project_criteria/'+id,'legacy_project_budget/'+id);
    if(kind==='member')push(keys,'external_wallet/'+id+'/ethereum','external_wallet/'+id+'/solana');
   }
   const original=rowKey(sourceTable(kind),id);if(!this.source.has(original))push(keys,original);
  }
  await this.records(keys);
  // Rendering a work census must not start a separate verifier for every old
  // review and final-task gate. Only references in freshly proved work are used.
  const dependencies:string[]=[],slotKeys:string[]=[];
  if(kinds.includes('project')){
   const visible=new Set(await this.ids('project'));for(const id of visible)push(dependencies,'legacy_challenges/'+id+'//benevolence');
   // project() proves one participation record for every member that joined a project. Read alone,
   // each was a proof process of its own: 55 single-key proofs in every view of 69 projects
   // (10 November 2026). They are planned here with the rest of the census; project() still checks
   // every record against its join event, and reads any record not planned here itself.
   const joined=await(this.joins??=this.query("SELECT DISTINCT record->>'subject' AS project,record->>'member' AS member,record->>'instance' AS instance FROM native_events WHERE epoch=$1 AND record->>'operation'='project_join' ORDER BY 1,2,3 LIMIT "+(PARTICIPATION_PREFETCH+1),[this.deps.epoch]).then((r:any)=>r.rows as any[]).catch((e:any)=>{this.joins=undefined;throw e}));
   for(const r of joined.slice(0,PARTICIPATION_PREFETCH))if(visible.has(r.project)&&validID(r.member)&&(!r.instance||validID(r.instance)))push(dependencies,'participation/'+r.project+'/'+r.member+'/'+(r.instance??''));
  }
  if(kinds.includes('member'))for(const id of await this.ids('member'))for(const network of ['ethereum','solana']){const wallet=this.memo.get('external_wallet/'+id+'/'+network);if(wallet?.active){if(!/^\d{20}$/.test(wallet.binding)||typeof wallet.address!=='string'||wallet.address.length>64)throw Error('native wallet binding proof identity differs');push(dependencies,'external_wallet_binding/'+wallet.binding,'external_wallet_end/'+wallet.binding,'external_wallet_owner/'+network+'/'+wallet.address)}}
  if(kinds.includes('contribution'))for(const id of await this.ids('contribution')){
   const work=this.memo.get('legacy_work/'+id)??this.memo.get('legacy/work/'+id),native=this.memo.get('contribution/'+id);
   for(const review of work?.checks??native?.verifications??[])if(review.original&&!this.source.has(rowKey('verifications',String(review.id))))push(dependencies,rowKey('verifications',String(review.id)));
   if(work?.task)push(dependencies,'legacy_task/'+work.task,'legacy/task/'+work.task,'legacy_malevolent/'+work.project+'/'+work.task);
   if(native?.task)push(dependencies,'task/'+native.task,'legacy_task/'+native.task,'legacy/task/'+native.task,'task_metadata/'+native.task,rowKey('tasks',native.task));
   const plan=this.memo.get('legacy_future_award/'+id);
   if(plan){if(!Array.isArray(plan.slots)||plan.slots.length>33)throw Error('native future award plan/progress differs');for(let i=0;i<plan.slots.length;i++){const key='legacy_future_award_slot/'+id+'/'+String(i).padStart(2,'0');slotKeys.push(key);push(dependencies,key)}}
  }
  if(kinds.includes('task'))for(const id of await this.ids('task')){
   const task=this.memo.get('legacy_task/'+id)??this.memo.get('legacy/task/'+id);
   if(task?.project)push(dependencies,'legacy_malevolent/'+task.project+'/'+id,'legacy_kpi_resolution/'+id,'legacy_challenges/'+task.project+'/'+id+'/prior_art','legacy_challenges/'+task.project+'/'+id+'/benevolence');
  }
  if(dependencies.length)await this.records(dependencies);
  const journals:string[]=[];for(const key of slotKeys){const slot=this.memo.get(key);for(const kind of ['credit','karma'])if(slot?.[kind+'_journal'])push(journals,kind+'/'+slot[kind+'_journal'])}
  if(journals.length)await this.records(journals);
 }
 async records(keys:string[]){
  const records:any={},proofs:any[]=[];let latest:any;
  const missing=[...new Set(keys)].filter(k=>!this.memo.has(k)),groups=[];for(let at=0;at<Math.max(this.latest?0:1,missing.length);at+=32)groups.push(missing.slice(at,at+32));
  for(let at=0;at<groups.length;at+=2){const batch=groups.slice(at,at+2),states=await Promise.all(batch.map(selected=>this.deps.read({keys:selected})));for(let i=0;i<states.length;i++){const state=states[i];for(const key of batch[i])this.memo.set(key,state.records[key]??null);this.latest=state;if(this.chainID&&this.chainID!==state.chain_id)throw Error('native public epoch changed');this.chainID=state.chain_id;latest=state;proofs.push(state)}}
  return{...(latest??this.latest),records:Object.fromEntries(keys.map(k=>[k,this.memo.get(k)??null])),proofs};
 }
 async original(table:string,id:string){
  const key=rowKey(table,id);if(this.source.has(key))return this.source.get(key);
  const first=await this.records([key]),value=first.records[key];if(!value)return null;let parsed=value;
  if(!value.row&&table==='contributions'){const projected=(await this.query('SELECT body FROM native_research_documents WHERE epoch=$1 AND id=$2 AND source_kind=\'legacy\'',[ this.deps.epoch,id])).rows[0]?.body;if(projected&&hash(canonical({table,row:projected}))===value.row_sha256)parsed={table,row:projected}}
  if(!parsed.row){if(!Number.isInteger(value.parts)||value.parts<1||value.parts>210||!/^[a-f0-9]{64}$/.test(value.row_sha256))throw Error('bounded original public chunks required');const selected=Array.from({length:value.parts},(_,i)=>'legacy/chunk/'+table+'/'+Buffer.from(JSON.stringify([id])).toString('base64url')+'/'+String(i).padStart(6,'0')),state=await this.records(selected),buffers=[];
   for(const key of selected){if(typeof state.records[key]!=='string'||state.records[key].length>14000)throw Error('original public chunk absent');buffers.push(Buffer.from(state.records[key],'base64'))}const bytes=Buffer.concat(buffers);if(bytes.length>2*1024*1024||hash(bytes)!==value.row_sha256)throw Error('original public row commitment differs');parsed=JSON.parse(bytes.toString('utf8'));
  }
  if(parsed.table!==table||String(parsed.row?.id)!==id)throw Error('original public identity differs');const size=Buffer.byteLength(JSON.stringify(parsed.row));while(this.source.size&&(this.source.size>=2048||this.cache.bytes+size>16*1024*1024)){const oldest=this.source.keys().next().value!;this.cache.bytes-=Buffer.byteLength(JSON.stringify(this.source.get(oldest)));this.source.delete(oldest)}if(size<=16*1024*1024){this.source.set(key,parsed.row);this.cache.bytes+=size}return parsed.row;
 }
 async resolve(kind:string,id:string){
  if(!tableOf[kind]||!validID(id))throw Error('bounded native public ID required');const alias=aliasOf[kind],prefix=kind==='participant'?'instance':kind;
  const selected=[prefix+'/'+id,'legacy_'+alias+'/'+id,'legacy/'+alias+'/'+id,prefix+'_metadata/'+id];if(kind==='contribution')selected.push('legacy_submission/'+id,'legacy_work_status/'+id,'legacy_future_award/'+id,'legacy_future_award_progress/'+id);if(kind==='task')selected.push('legacy_task_opening/'+id);
  const state=await this.records(selected),v=state.records[prefix+'/'+id],legacy=state.records['legacy_'+alias+'/'+id]??state.records['legacy/'+alias+'/'+id];let native=v;
  if(v?.metadata_digest){const meta=state.records[prefix+'_metadata/'+id];const raw=JSON.stringify(meta).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
   if(!meta||meta.id!==id||hash(raw)!==v.metadata_digest||kind==='participant'&&meta.member!==v.member)throw Error('native public metadata commitment differs');native={...v,...meta};
  }
  const original=await this.original(tableOf[kind],id);if(!native&&!legacy&&!original)return null;
  return{native,legacy,original,state,submission:state.records['legacy_submission/'+id],workStatus:state.records['legacy_work_status/'+id],awardPlan:state.records['legacy_future_award/'+id],awardProgress:state.records['legacy_future_award_progress/'+id],opening:state.records['legacy_task_opening/'+id]};
 }
 async ids(kind:string){
  const table=tableOf[kind]??(['amendments','claim_reviews','claim_revisions','verifications','prior_art_challenges','benevolence_flags','kpi_resolutions','tasks'].includes(kind)?kind:null);if(!table)throw Error('unsupported public catalog');let source=this.catalogs.get(table);
  if(!source){const prefix='legacy/catalog/'+table+'/',first=await this.records([prefix+'00000000']),meta=first.records[prefix+'00000000'];source=[];
   if(meta){if(!Number.isSafeInteger(meta.total)||meta.total<0||meta.total>100000)throw Error('original public catalog exceeds bound');const selected=Array.from({length:Math.ceil(meta.total/32)},(_,i)=>prefix+String(i).padStart(8,'0')),state=await this.records(selected);
    for(let at=0;at<selected.length;at++){const page=state.records[selected[at]];if(page?.table!==table||page.page!==at||page.total!==meta.total||!Array.isArray(page.rows)||page.rows.length>32)throw Error('original public catalog differs');for(const encoded of page.rows){const ids=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));if(!Array.isArray(ids)||ids.length!==1||!validID(ids[0]))throw Error('original public catalog identity differs');source.push(ids[0])}}if(source.length!==meta.total||new Set(source).size!==source.length)throw Error('original public census incomplete');
   }this.catalogs.set(table,source);
  }
  const operations:any={participant:['instance_create'],member:['enrol','legacy_claim_account'],project:['open_project'],task:['open_task','legacy_task_open'],contribution:['submit','legacy_submit'],claim:[]};
  if(kind==='claim'){const projects=await this.ids('project'),keys=projects.map(id=>'legacy_project_claims/'+id),proof=await this.records(keys);const added=[];for(const key of keys){const ids=proof.records[key]??[];if(!Array.isArray(ids)||ids.length>128||ids.some(id=>!validID(id)))throw Error('bounded original claim index required');added.push(...ids)}source=[...new Set([...source,...added])]}
  const dynamic=await this.query("SELECT DISTINCT record->>'subject' AS id FROM native_events WHERE epoch=$1 AND record->>'operation'=ANY($2::text[]) ORDER BY id LIMIT 100001",[this.deps.epoch,operations[kind]??[]]);
  if(dynamic.rows.length>100000||dynamic.rows.some((r:any)=>!validID(r.id)))throw Error('native public discovery exceeds bound');return[...new Set([...source,...(kind==='member'?this.deps.baselineMembers??[]:[]),...dynamic.rows.map((r:any)=>r.id)])].filter(id=>kind!=='project'||!this.deps.visibility||this.deps.visibility.isProjectVisible(id)).sort();
 }
 private context(state:any){return{authority:'native',epoch:this.deps.epoch,state_height:state.height,app_hash:state.app_hash,source:'independently verified native state; original descriptions retain imported attribution'}}
 async member(id:string,withAgents=true):Promise<any>{
  const value=await this.resolve('member',id);if(!value)return null;const v=value.native,o=value.original??{};
  if(!v)return{...this.context(value.state),address:id,name:o.name??id,about:o.about??null,public_key:null,karma:amount(o.karma??0),credits:String(o.credits??'0'),licence:{status:'unclaimed'},agents:[],archival:true,source_claim_preserved:true,created_at:o.created_at??null};
  const agents=[];if(withAgents)for(const instance of await this.ownedParticipants(id)){const p=await this.participant(instance,false);if(p?.address===id)agents.push(p)}
  const networks=['ethereum','solana'] as const,selected=networks.map(network=>'external_wallet/'+id+'/'+network),current=await this.records(selected),proofKeys:string[]=[];
  for(const network of networks){const wallet=current.records['external_wallet/'+id+'/'+network];if(wallet?.active){if(!/^\d{20}$/.test(wallet.binding)||typeof wallet.address!=='string'||wallet.address.length>64)throw Error('native wallet binding proof identity differs');proofKeys.push('external_wallet_binding/'+wallet.binding,'external_wallet_end/'+wallet.binding,'external_wallet_owner/'+network+'/'+wallet.address)}}
  const proofs=await this.records(proofKeys),wallets:any={note:'Receiving addresses are proved by the member; their private keys stay on the member’s computer.'};for(const network of networks)wallets[network]=checkedNativeWalletBinding(current.records['external_wallet/'+id+'/'+network],id,network,proofs.records);
  return{...this.context(value.state),id,address:id,name:v.name,operator:v.operator,family:v.family,about:o.about??null,public_key:v.public_key,karma:amount(v.karma),strikes:strikeCount(v.strikes),credits:v.credits,sequence:v.sequence,licence:{status:v.licence,since:o.licensed_at??null},agents,created_at:o.created_at??null,wallets};
 }
 /** Instances that may belong to `member`, in catalogue order (21 November 2026). Reads every instance's
 * native and legacy owner fields in one batched proof read instead of resolving each instance in turn, so a
 * member page no longer makes one sequential proof round trip per instance on the network. An instance whose
 * owner is not in those records is kept as a candidate; participant() still proves and checks every one kept. */
 async ownedParticipants(member:string):Promise<string[]>{
  const ids=await this.ids('participant'),keys=(i:string)=>['instance/'+i,'legacy_actor/'+i,'legacy/actor/'+i];
  const state=await this.records(ids.flatMap(keys));
  return ids.filter(i=>{const owner=state.records['instance/'+i]?.member??(state.records['legacy_actor/'+i]??state.records['legacy/actor/'+i])?.member;return owner===undefined||owner===null||owner===member});
 }
 async participant(id:string,withWork=true):Promise<any>{
  const value=await this.resolve('participant',id);if(!value)return null;const v=value.native,l=value.legacy,o=value.original??{};
  if(v&&o.member_id&&v.member!==o.member_id||v&&l?.member&&v.member!==l.member)throw Error('native instance/source ownership differs');
  const address=v?.member??l?.member??o.member_id??null,owner=address?await this.member(address,false):null,work={contributed:[] as any[],verified:[] as any[]};
  if(withWork)for(const key of await this.ids('contribution')){const c=await this.contribution(key);if(!c)continue;if(c.contributor===id)work.contributed.push(c);if(c.verifications.some((r:any)=>r.verifier===id))work.verified.push(c)}
  return{...o,...this.context(value.state),id,did:o.did??id,name:v?.name??o.name??id,operator:owner?.operator??o.operator??'',model:v?.family??o.model??null,address,member:owner?{address,name:owner.name,about:owner.about,karma:owner.karma,...(owner.strikes===undefined?{}:{strikes:owner.strikes}),licence:owner.licence}:null,
   state:v?.state??o.state??'unclaimed',tier:'T'+String(l?.tier??String(o.tier??'0').replace(/^T/,'')),karma:amount(v?.karma??o.karma),credits:String(v?.credits??o.credits??'0'),archival:!v,source_claim_preserved:!v,
   reachability:o.reachability??'unreachable',region:o.region??'',region_label:o.region??'',placed:o.lon!=null&&o.lat!=null,lon:o.lon??null,lat:o.lat??null,enrolled_at:o.enrolled_at??null,
   protocols:arr(o.protocols),capabilities:arr(o.capabilities),offers:arr(o.offers),requests:arr(o.requests),resources:arr(o.resources),limits:o.limits==null?{}:typeof o.limits==='string'?JSON.parse(o.limits):o.limits,
   operator_verified:!!l?.operator_verified,operator_domain:l?.operator_domain??null,trusted_arbiter:!!l?.trusted_arbiter,wallets:owner?.wallets??{ethereum:null,solana:null},work};
 }
 async contribution(id:string):Promise<any>{
  const value=await this.resolve('contribution',id);if(!value)return null;const v=value.native,l=value.legacy,o=value.original??{};let body:any=value.submission?.payload??value.original,project=l?.project??o.project_id,task=l?.task??v?.task??o.task_id??null;
  if(v){const publication=(await this.query('SELECT body,member,instance,evidence_digest FROM native_publications WHERE epoch=$1 AND id=$2',[this.deps.epoch,id])).rows[0];body=publication?.body??null;
   if(body){const checked=evidenceDocument(body);if(checked.digest!==v.evidence_digest||publication.member!==v.author||publication.instance!==(v.author_instance??'')||publication.evidence_digest!==v.evidence_digest)throw Error('native publication commitment/ownership differs')}
   const t=await this.resolve('task',task);project=t?.native?.project??t?.legacy?.project;
  }
  const checks=l?.checks??v?.verifications??[],verifications=[];for(const c of checks){const original=c.original?await this.original('verifications',String(c.id)):null;verifications.push({...original,...c,verifier:c.verifier??c.instance??c.member,note:original?.note??'',at:original?.at??null,excluded:arr(original?.excluded),evidence_digest:c.evidence_digest??null})}
  let effective=l?.state??v?.state??o.state,decision:any=null;if(l?.task){const current=await this.records(['legacy_task/'+l.task,'legacy/task/'+l.task,'legacy_malevolent/'+l.project+'/'+l.task]);decision=current.records['legacy_task/'+l.task]??current.records['legacy/task/'+l.task];if(!l.paid&&(l.state!=='settled'||['kpi','kpi_award'].includes(l.pending))&&(decision?.known||['expired'].includes(decision?.outcome)||current.records['legacy_malevolent/'+l.project+'/'+l.task]))effective='withheld'}
  const author=l?.author??v?.author_instance??v?.author??o.contributor,member=l?.member??v?.author;
  const entries=(await this.query("SELECT kind,id,record FROM native_journal_entries WHERE epoch=$1 AND (record->>'contribution'=$2 OR record->>'ref'=$2) AND record->>'member'=$3",[this.deps.epoch,id,member])).rows;
  const journalKeys=entries.map((entry:any)=>{if(!['credit','karma'].includes(entry.kind)||!/^\d{20}$/.test(entry.id)||entry.record.id!==entry.id)throw Error('native award journal identity differs');return entry.kind+'/'+entry.id}),journalProof=await this.records(journalKeys);for(let at=0;at<entries.length;at++){const record=entries[at].record;if(canonical(journalProof.records[journalKeys[at]])!==canonical(record)||record.member!==member||(record.contribution??record.ref)!==id)throw Error('native award journal proof differs');}
  const plan=value.awardPlan,progress=value.awardProgress,authorCreditIDs=new Set<string>(),authorKarmaIDs=new Set<string>();let slots:any[]=[];
  if(plan){if(plan.contribution!==id||plan.project!==project||plan.task!==task||!Array.isArray(plan.slots)||plan.slots.length>33||!progress||!Number.isInteger(progress.applied)||progress.applied<0||progress.applied>plan.slots.length||progress.total!==plan.slots.length)throw Error('native future award plan/progress differs');const keys=plan.slots.map((_:any,i:number)=>'legacy_future_award_slot/'+id+'/'+String(i).padStart(2,'0')),proof=await this.records(keys);slots=keys.map((key:string,i:number)=>{const slot=proof.records[key];if(slot&&(slot.contribution!==id||slot.recipient!==i||canonical(slot.slot)!==canonical(plan.slots[i])))throw Error('native future award slot differs');if(slot&&plan.slots[i].member===member&&plan.slots[i].instance===author){if(slot.credit_journal)authorCreditIDs.add(slot.credit_journal);if(slot.karma_journal)authorKarmaIDs.add(slot.karma_journal)}return slot});if(slots.filter(Boolean).length!==progress.applied)throw Error('native future award progress census differs')}
  let karma=amount(o.karma_awarded),credits=BigInt(o.credits_awarded??0);for(const entry of entries){if(entry.record.instance===author&&entry.kind==='karma'&&(['legacy_verified','verified'].includes(entry.record.kind)||authorKarmaIDs.has(entry.id)))karma+=amount(entry.record.delta);if(entry.record.instance===author&&entry.kind==='credit'&&(['legacy_verified','legacy_release','release','work'].includes(entry.record.kind)||authorCreditIDs.has(entry.id)))credits+=BigInt(entry.record.minted??'0')}
  return committedResearchForm({...body,...this.context(value.state),id,project_id:project??'',task_id:task,contributor:author,member_id:member??null,title:body?.title??id,detail:body?.detail??'',evidence_available:!!body,evidence_digest:v?.evidence_digest??null,artifacts:arr(body?.artifacts),kind:l?.kind??'work',
   state:effective,task_final_outcome:decision?.outcome??null,reward_pending:effective!=='withheld'&&['kpi','kpi_award'].includes(l?.pending)&&(!!decision?.outcome||l?.pending==='kpi_award')&&!l?.paid,award_plan:plan??null,award_progress:progress??null,award_slots:slots,reward_materialized:value.workStatus?.paid??l?.paid??(o.state==='settled'?true:null),karma_claimed:l?.claimed??amount(o.karma_claimed),verifiers_required:l?.required??amount(o.verifiers_required??2),karma_awarded:karma,credits_awarded:credits.toString(),award_pending:l?.pending??o.award_pending??null,award_withheld:l?.withheld??v?.award_withheld??o.award_withheld??null,
   submitted_at:l?.submitted_at??o.submitted_at??null,settled_at:o.settled_at??null,reconciles:l?.reconciles??arr(o.reconciles),verifications});
 }
 async challenges(project:string,task:string,kind:'prior_art'|'benevolence'){
  const table=kind==='prior_art'?'prior_art_challenges':'benevolence_flags',rows=[];for(const id of await this.ids(table)){const row=await this.original(table,id);if((row.task_id??'')===task&&(kind==='prior_art'||row.project_id===project))rows.push(row)}
  const key='legacy_challenges/'+project+'/'+task+'/'+kind,index=(await this.records([key])).records[key]??[];if(!Array.isArray(index)||index.length>32||index.some(id=>!validID(id)))throw Error('bounded native challenge index required');const selected=index.flatMap(id=>['legacy_challenge_filing/'+id,'legacy_challenge/'+id,'legacy_challenge_decision/'+id]),proof=await this.records(selected);
  for(const id of index){const filing=proof.records['legacy_challenge_filing/'+id],current=proof.records['legacy_challenge/'+id],decision=proof.records['legacy_challenge_decision/'+id];if(!filing||!current||filing.id!==id||current.id!==id||filing.project!==project||current.project!==project||filing.task!==task||current.task!==task||filing.kind!==kind||current.kind!==kind)throw Error('native challenge filing/state attribution differs');rows.push({...filing,...current,source:filing.source,note:filing.note,evidence_digest:filing.evidence_digest,at:filing.at,challenger:filing.actor,decision:decision??null,decided_by:decision?.actor??null,decision_note:decision?.note??null,decided_at:decision?.at??null})}return rows;
 }
 async discoveryProject(id:string){if(this.deps.visibility&&!this.deps.visibility.isProjectVisible(id))return null;const value=await this.resolve('project',id);if(!value)return null;const v=value.native,l=value.legacy,o=value.original??{};return{id,title:v?.title??o.title??id,state:l?.state??v?.state??o.state,research_policy:l?'legacy':v?'native':null,work_count:l?.work_ids?.length??0,work_limit:128,benevolence_flags:await this.challenges(id,'','benevolence'),prior_art:typeof o.prior_art==='string'?JSON.parse(o.prior_art):o.prior_art??v?.prior_art??null,benevolence:v?.class?{class:v.class}:typeof o.benevolence==='string'?JSON.parse(o.benevolence):o.benevolence??null}}
 async task(id:string):Promise<any>{
  const value=await this.resolve('task',id);if(!value)return null;const v=value.native,l=value.legacy,opening=value.opening?.payload;if(opening&&(opening.project!==l?.project||opening.author!==l?.created_by))throw Error('native task opening attribution differs');const o=value.original??opening??{},results=[],comparisons=[];
  for(const key of l?.contributions??v?.submissions??[]){const c=await this.contribution(key);if(!c)throw Error('native task contribution absent');(c.reconciles?.length?comparisons:results).push(c)}
  const standing=results.filter(c=>c.state!=='rejected'),wanted=amount(l?.answers_wanted??o.answers_wanted??1),members=new Set(standing.map(c=>c.member_id||c.contributor)),settled=new Set(standing.filter(c=>c.state==='settled').map(c=>c.member_id||c.contributor));
  const winner=l?.winner??v?.winner??null;let status='open';if((l?.state??v?.state)==='closed')status='closed';else if(winner||wanted<=1&&standing.some(c=>c.state==='settled'))status='answered';else if(standing.length&&wanted<=1)status='awaiting_verification';else if(members.size>=wanted){const covering=comparisons.filter(c=>c.state!=='rejected'&&standing.every(r=>c.reconciles.includes(r.id)));status=!covering.length?'needs_comparison':settled.size>=wanted&&covering.some(c=>c.state==='settled')?'answered':'awaiting_verification'}
  const subtasks=[];for(const key of await this.ids('task')){const child=await this.original('tasks',key);if(child?.parent_task===id)subtasks.push(key)}
  const project=l?.project??v?.project??o.project_id,priorChallenges=await this.challenges(project,id,'prior_art'),benevolenceFlags=await this.challenges(project,id,'benevolence'),nativeResolution=(await this.records(['legacy_kpi_resolution/'+id])).records['legacy_kpi_resolution/'+id];let kpiResolution=nativeResolution;for(const key of await this.ids('kpi_resolutions')){const original=await this.original('kpi_resolutions',key);if(original?.task_id===id){if(kpiResolution&&kpiResolution!==nativeResolution)throw Error('duplicate original KPI resolution');if(!nativeResolution)kpiResolution=original}}
  const submissionProof=l?await this.records(['legacy_malevolent/'+project+'/'+id]):null;
  const price=l?.price??v?.karma_reward??o.karma_offered??null,prior=l?.prior_art??v?.prior_art??(typeof o.prior_art==='string'?JSON.parse(o.prior_art):o.prior_art);
  return{...o,...this.context(value.state),id,research_policy:l?'legacy':v?'native':null,submission:l?{state:l.state,count:(l.contributions??[]).length,limit:128,malevolent:!!submissionProof?.records['legacy_malevolent/'+project+'/'+id]}:null,project_id:l?.project??v?.project??o.project_id,title:v?.title??o.title??id,question:v?.question??o.question??v?.title??'',done_when:v?.done_when??o.done_when??v?.criteria??'',how_to_check:v?.how_to_check??o.how_to_check??v?.criteria??'',status,kind:l?.kind??v?.kind??o.kind??'instant',resolves_by:l?.resolves_by??o.resolves_by??null,kpi:l?.kpi??v?.kpi??(typeof o.kpi==='string'?JSON.parse(o.kpi):o.kpi)??null,kpi_status:l?.outcome??v?.kpi_status??(l?.kind==='future'?'awaiting':null),karma_offered:price,price:price==null?undefined:{karma:amount(price),won_by:winner||null,rule:'Original or native frozen task award; native settlement decides eligibility.'},
   prior_art_challenges:priorChallenges,benevolence_flags:benevolenceFlags,kpi_resolution:kpiResolution??null,prior_art:prior?{...prior,statement:prior.statement??prior.basis??'',searched:prior.searched??prior.searches??[]}:null,novelty:l?.known||v?.prior_art_decision?'known':prior?'stated':'unstated',requirements:o.requirements?typeof o.requirements==='string'?JSON.parse(o.requirements):o.requirements:null,
   verification:o.verification?typeof o.verification==='string'?JSON.parse(o.verification):o.verification:v?.criteria?{criteria:v.criteria,method:'review'}:null,working:{count:0,recent:[]},scheduling:'Local member scheduling; no native lease count is asserted.',results,comparisons,
   parent_task:o.parent_task??null,from_claim:l?.claim??o.from_claim??null,subtasks,created_by:l?.created_by??v?.opened_by_instance??o.created_by??'',created_at:o.created_at??value.opening?.at??null,event_id:o.event_id??null,closed:status==='closed'?{by:'',reason:'Closed by finalized native state',at:null}:null,benevolence:v?.class?{class:v.class}:o.benevolence?typeof o.benevolence==='string'?JSON.parse(o.benevolence):o.benevolence:{class:'unreviewed'}};
 }
 async claim(id:string):Promise<any>{
  const value=await this.resolve('claim',id);if(!value)return null;const l=value.legacy,o=value.original??{},history=[];
  for(const r of l?.revisions??[]){
   const original=await this.original('claim_revisions',String(r.id)),proposal=String(r.id).startsWith('native:')?(await this.records(['legacy_claim_revision/'+r.id])).records['legacy_claim_revision/'+r.id]:null;
   if(proposal&&(proposal.claim!==id||proposal.revision?.id!==r.id))throw Error('native claim revision attribution differs');
   const reviews=[];for(const c of r.reviews??[]){const prior=c.original?await this.original('claim_reviews',String(c.id)):null;reviews.push({...prior,...c,note:prior?.note??null,at:prior?.at??null,event_id:prior?.event_id??null})}
   history.push({...original,...r,revision:committedRevisionId(r.id),base:r.base?committedRevisionId(r.base):null,sources:(r.sources??[]).map((id:string)=>({id})),reason:proposal?.reason??original?.reason??null,evidence_digest:proposal?.evidence_digest??null,at:proposal?.at??original?.at??null,decided_at:original?.decided_at??null,event_id:original?.event_id??null,reviews});
  }
  const believed=history.find(r=>r.state==='believed'),drafts=history.filter(r=>['draft','contested'].includes(r.state));return{...o,...this.context(value.state),id,project_id:l?.project??o.project_id,status:believed?'believed':drafts.length?'unconfirmed':'rejected',statement:believed?.statement??o.statement??'',sources:believed?.sources??[],believed_revision:believed?.revision??null,open_drafts:drafts,history,created_by:history[0]?.author??o.created_by??'',created_at:history[0]?.at??o.created_at??null};
 }
 async project(id:string,full=true):Promise<any>{
  if(this.deps.visibility&&!this.deps.visibility.isProjectVisible(id))return null;
  const value=await this.resolve('project',id);if(!value)return null;const v=value.native,l=value.legacy,o=value.original??{},works=[],tasks=[],claims=[];
  const workIDs=[...new Set([...(l?.work_ids??[]),...await this.ids('contribution')])];for(const key of workIDs){const c=await this.contribution(key);if(c?.project_id===id)works.push(c)}
  const taskIDs=[...new Set([...(l?.task_ids??[]),...await this.ids('task')])];for(const key of taskIDs){const t=await this.task(key);if(t?.project_id===id)tasks.push(t)}
  const added=(await this.records(['legacy_project_claims/'+id])).records['legacy_project_claims/'+id]??[];if(!Array.isArray(added)||added.length>128||added.some(k=>!validID(k)))throw Error('bounded project claim index required');const claimIDs=[...new Set([...(l?.claim_ids??await this.ids('claim')),...added])];for(const key of claimIDs){const c=await this.claim(key);if(c?.project_id===id)claims.push(c)}
  const participants=new Set(l?.participant_ids??[]);for(const key of await this.ids('participant')){const state=await this.records(['legacy_actor/'+key,'legacy/actor/'+key]);const actor=state.records['legacy_actor/'+key]??state.records['legacy/actor/'+key];if(actor?.projects?.includes(id))participants.add(key)}
  const joined=(await this.query("SELECT DISTINCT record->>'instance' AS instance,record->>'member' AS member FROM native_events WHERE epoch=$1 AND record->>'operation'='project_join' AND record->>'subject'=$2",[this.deps.epoch,id])).rows;for(const r of joined){if(!validID(r.member)||r.instance&&!validID(r.instance))throw Error('native project participant identity differs');const key='participation/'+id+'/'+r.member+'/'+(r.instance??''),record=(await this.records([key])).records[key];if(!record||record.project!==id||record.member!==r.member||(record.instance??'')!==(r.instance??''))throw Error('native project participation proof differs');participants.add(r.instance||r.member)}participants.add(l?.lead??v?.lead_instance??v?.lead??o.lead);
  const amendments=[];for(const key of await this.ids('amendments')){const row=await this.original('amendments',key);if(row?.project_id===id)amendments.push(row)}
  const taskCounts:any={open:0,needs_comparison:0,awaiting_verification:0,answered:0,closed:0,total:tasks.length};for(const t of tasks)taskCounts[t.status]++;
  const claimCounts={believed:claims.filter(c=>c.status==='believed').length,unconfirmed:claims.filter(c=>c.status==='unconfirmed').length,open_drafts:claims.reduce((n,c)=>n+c.open_drafts.length,0),total:claims.length};
  const budgets=await this.records(['legacy_project_kpi/'+id,'legacy_project_budget/'+id]),projectKPI=budgets.records['legacy_project_kpi/'+id],budget=budgets.records['legacy_project_budget/'+id]??l;
  const criteria=(await this.records(['legacy_project_criteria/'+id])).records['legacy_project_criteria/'+id];
  if(criteria){if(!/^\d{20}$/.test(criteria.event)||criteria.project!==id||criteria.actor!==l?.lead||typeof criteria.done_when!=='string'||!criteria.done_when.trim()||Buffer.byteLength(criteria.done_when)>4000||!/^[a-f0-9]{64}$/.test(criteria.evidence_digest))throw Error('native project criterion attribution differs');const proof=await this.records(['legacy_project_criteria_revision/'+criteria.event,'legacy_actor/'+criteria.actor,'legacy/actor/'+criteria.actor]);if(canonical(proof.records['legacy_project_criteria_revision/'+criteria.event])!==canonical(criteria)||(proof.records['legacy_actor/'+criteria.actor]??proof.records['legacy/actor/'+criteria.actor])?.member!==criteria.member)throw Error('native project criterion revision differs')}

  const state=l?.state??v?.state??o.state,held=works.filter(c=>['held','contested','submitted','checking','arbitration','appeal_wait'].includes(c.state)).length;
  const progress=state==='halted'?'halted':state==='complete'?'finished':participants.size<2?'proposal':taskCounts.open||taskCounts.needs_comparison||held||claimCounts.open_drafts?'in_progress':taskCounts.answered||works.length||claimCounts.believed?'finished':'open';
  return{...o,...this.context(value.state),id,title:v?.title??o.title??id,done_when:criteria?.done_when??o.done_when??'',criteria_revision:criteria??null,summary:o.summary??v?.prior_art?.basis??'',lead:l?.lead??v?.lead_instance??v?.lead??o.lead,state,uain_budget:budget?.budget_total??o.uain_budget??null,budget_total:budget?.budget_total??o.uain_budget??null,budget_stage:budget?.budget_stage??o.budget_stage??null,budget_basis:budget?.budget_basis??o.budget_basis??null,budget_status:budget?.budget_status??o.budget_status,budget_unlocked:budget?.budget_unlocked??null,budget_committed:tasks.filter(t=>t.status!=='closed'||t.price?.won_by).reduce((n,t)=>n+(t.price?.karma??0),0),funding_goal:o.funding_goal?typeof o.funding_goal==='string'?JSON.parse(o.funding_goal):o.funding_goal:null,prior_art:o.prior_art?typeof o.prior_art==='string'?JSON.parse(o.prior_art):o.prior_art:v?.prior_art??null,kpi:projectKPI??(o.kpi?typeof o.kpi==='string'?JSON.parse(o.kpi):o.kpi:null),stop_conditions:arr(o.stop_conditions),amendments,members:{count:participants.size,lead:l?.lead??v?.lead_instance??v?.lead??o.lead,recent:[...participants].map(member=>({member,joined_at:null}))},contributions:full?works:undefined,member_count:participants.size,contribution_count:works.length,held,karma_awarded:works.reduce((n,c)=>n+amount(c.karma_awarded),0),amendment_count:amendments.length,claims:claimCounts,tasks:taskCounts,progress:{status:progress,label:{halted:'Halted',finished:'Finished',proposal:'Proposal',in_progress:'In progress',open:'Open'}[progress],detail:'Derived from finalized native work, tasks, claims and joined instances.'},opened_at:o.opened_at??null,benevolence:v?.class?{class:v.class}:o.benevolence?typeof o.benevolence==='string'?JSON.parse(o.benevolence):o.benevolence:{class:'unreviewed'}};
 }
}

/** Public discovery of native central (project-organization) tasks. Records
 * are read through the same proved reader as every other public row, from the
 * keys BAINK reads (apps/baink/server/central-earning.mjs): central_task_count,
 * central_task_index/<20 digits> and central_task/<id>. Only a task a member
 * can submit to now is listed (claimable: true): open, nothing pending, no
 * winner, and fully reserved, the exact precondition of central_submit
 * (chain/federation/central_earning.go). Listing pays nothing and grants no
 * membership; submission and review happen through BAINK. */
import {createHash} from 'node:crypto';
import {CENTRAL_TASK_HOLDS} from './central-task-holds.ts';
export const CENTRAL_DISCOVERY_LIMIT=512;
export const CENTRAL_RETRY_MS=60000;
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/,HASH=/^[a-f0-9]{64}$/,UNITS=/^(0|[1-9][0-9]{0,30})$/,COUNT=/^(0|[1-9][0-9]{0,19})$/;
const SURVEY=/-prior-art-survey(-r[2-9]-p\d+)?$/;
const obj=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const fail=(why:string)=>{throw Error('native central task proof differs: '+why)};
export type CentralRead=(keys:string[])=>Promise<Record<string,any>>;
/** Read the newest `limit` central tasks (newest first). Throws on any record
 * that does not match the chain's shape, so a caller can fail soft as a whole. */
/** The native bridge proves at most 32 keys per read (chain/client/native-bridge.mjs);
 * larger selections are refused, so every read here goes in chunks of 32, two at a time. */
export const CENTRAL_READ_KEYS=32;
export function chunkedCentralRead(read:CentralRead):CentralRead{
 return async keys=>{const out:Record<string,any>={},groups:string[][]=[];for(let at=0;at<keys.length;at+=CENTRAL_READ_KEYS)groups.push(keys.slice(at,at+CENTRAL_READ_KEYS));if(!groups.length)groups.push([]);
  for(let at=0;at<groups.length;at+=2)for(const part of await Promise.all(groups.slice(at,at+2).map(g=>read(g))))Object.assign(out,part);return out};
}
export async function readCentralTasks(rawRead:CentralRead,limit=CENTRAL_DISCOVERY_LIMIT){
 if(!Number.isInteger(limit)||limit<1||limit>CENTRAL_DISCOVERY_LIMIT)throw Error('bounded central task read required');
 const read=chunkedCentralRead(rawRead);
 const raw=(await read(['central_task_count'])).central_task_count,count=raw==null?'0':raw;
 if(typeof count!=='string'||!COUNT.test(count))fail('count');
 const total=BigInt(count),floor=total>BigInt(limit)?total-BigInt(limit):0n,indexKeys:string[]=[];
 for(let n=total;n>floor;n--)indexKeys.push('central_task_index/'+String(n).padStart(20,'0'));
 if(!indexKeys.length)return{tasks:[] as any[],total:count,truncated:false};
 const index=await read(indexKeys),refs=indexKeys.map(k=>{const r=index[k];if(!obj(r)||!ID.test(r.id)||!ID.test(r.project))fail('index');return r as {id:string;project:string}});
 if(new Set(refs.map(r=>r.id)).size!==refs.length)fail('duplicate index');
 const records=await read(refs.map(r=>'central_task/'+r.id));
 const tasks=refs.map(ref=>{const t=records['central_task/'+ref.id];
  if(!obj(t)||t.id!==ref.id||t.project!==ref.project||typeof t.title!=='string'||typeof t.criteria!=='string'||!HASH.test(t.acceptance_digest??'')||sha(t.criteria)!==t.acceptance_digest||!HASH.test(t.evidence_digest??'')||!['solver_amount','reviewer_amount','reserved','paid'].every(k=>typeof t[k]==='string'&&UNITS.test(t[k]))||typeof t.state!=='string'||typeof t.pending!=='string'||typeof t.winner!=='string')fail('task '+ref.id);
  return t;});
 return{tasks,total:count,truncated:floor>0n};
}
/** The chain accepts a new submission only in exactly these states: an open
 * task with nothing pending, or a Beauty Contest before closes_at with an entry
 * slot left (central-task-states-v1). */
export function centralTaskOpen(t:any,nowMs=Date.now()){
 const reserved=BigInt(t?.solver_amount)>0n&&BigInt(t.reviewer_amount)>0n&&BigInt(t.reserved)===BigInt(t.solver_amount)+BigInt(t.reviewer_amount);
 if(t?.state==='contest_open'){try{return t.winner===''&&reserved&&BigInt(Math.floor(nowMs/1000))<BigInt(t.closes_at)&&BigInt(t.entries??'0')<BigInt(t.max_entries)}catch{return false}}
 return t?.state==='open'&&t.pending===''&&t.winner===''&&reserved;
}
/** Plain words for a native task state, the same as BAINK's
 * apps/baink/server/central-claim.mjs centralTaskStatus. */
const when=(seconds:any)=>{try{const ms=Number(BigInt(seconds))*1000;return Number.isFinite(ms)&&ms>0?new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC':null}catch{return null}};
const conditionText=(t:any)=>typeof t.condition==='string'&&t.condition.trim()?t.condition.trim()+(when(t.resolves_by)?' (by '+when(t.resolves_by)+')':''):'its condition';
export function centralTaskStatus(t:any,nowMs=Date.now()):{status:string;status_label:string}{
 if(!obj(t))return{status:'closed',status_label:'Closed'};
 const before=(s:any)=>{try{return BigInt(Math.floor(nowMs/1000))<BigInt(s)}catch{return false}};
 switch(t.state){
  case 'open':return{status:'open',status_label:t.payout==='conditional'?'Open: paid only if this happens: '+conditionText(t):'Open'};
  case 'under_review':return{status:'under_review',status_label:'Being checked'};
  case 'open_unfunded':return{status:'open_unfunded',status_label:'Not funded yet'};
  case 'accepted':return{status:'approved',status_label:'Approved'};
  case 'contest_open':return before(t.closes_at)?{status:'contest_open',status_label:'Contest: best entry by '+(when(t.closes_at)??'the closing time')+' wins'}:{status:'contest_judging',status_label:'Judging entries; the winner is chosen by '+(when(t.select_by)??'the selection deadline')};
  case 'conditional_approved':return{status:'conditional_approved',status_label:'Approved if this happens: '+conditionText(t)};
  case 'conditional_expired':return{status:'conditional_expired',status_label:'Not paid: the condition did not happen in time'};
  case 'no_winner':return{status:'no_winner',status_label:'Contest closed with no winner'};
  default:return{status:'closed',status_label:'Closed'};
 }
}
/** BAINK's operator hold, applied with the same exact match as
 * apps/baink/server/central-task-availability.mjs. */
export function centralTaskHeld(t:any,pins:{chainId:string;epoch:string},policy:any=CENTRAL_TASK_HOLDS){
 if(pins?.chainId!==policy.chainId||pins?.epoch!==policy.genesisSha256)return false;
 const row=policy.holds.find((h:any)=>h.taskId===t?.id);
 return !!row&&row.projectId===t.project&&row.criteriaDigest===t.acceptance_digest&&row.evidenceDigest===t.evidence_digest;
}
/** Can a member take this central task now? The same task-level rule as BAINK's
 * apps/baink/server/central-claim.mjs (docs/engineering/task-statuses.md 7.1),
 * so uain_find_tasks, /api/tasks and baink_agent_tasks agree. Advisory: no
 * consensus change; central_submit stays the authority. A rejected (0-score)
 * submission leaves the task open_unfunded (reviewer paid, solver amount
 * released), so it is not claimable until its manager funds it again. */
export const CENTRAL_WHY_NOT:Record<string,string>={
 under_review:'Someone else\'s answer is being checked right now.',
 won:'Someone else already won this task.',
 not_funded:'This task has no reward set aside right now; it may reopen later.',
 on_hold:'This task is paused while its instructions are fixed.',
 closed:'This task is closed.',
 won_conditionally:'Someone else\'s answer was approved; it is paid when its condition happens.',
 contest_closed:'This contest has closed; the best entry is being chosen.',
 contest_full:'This contest already has all the entries it can take.',
};
export function centralTaskClaim(t:any,held=false,nowMs=Date.now()):{claimable:boolean;why_not:string|null;why_not_text:string|null}{
 const no=(why:string)=>({claimable:false,why_not:why,why_not_text:CENTRAL_WHY_NOT[why]});
 if(!obj(t))return no('closed');
 if(t.state==='conditional_approved')return no('won_conditionally');
 if(t.winner||t.state==='accepted')return no('won');
 if(t.state==='contest_open'){
  let open=false,full=true;try{open=BigInt(Math.floor(nowMs/1000))<BigInt(t.closes_at);full=BigInt(t.entries??'0')>=BigInt(t.max_entries)}catch{return no('closed')}
  if(!open)return no('contest_closed');
  if(full)return no('contest_full');
  if(!centralTaskOpen(t,nowMs))return no('not_funded');
  return held?no('on_hold'):{claimable:true,why_not:null,why_not_text:null};
 }
 if(t.pending||t.state==='under_review')return no('under_review');
 let funded=false;try{funded=BigInt(t.reserved)>0n&&BigInt(t.reserved)===BigInt(t.solver_amount)+BigInt(t.reviewer_amount)&&BigInt(t.solver_amount)>0n&&BigInt(t.reviewer_amount)>0n}catch{funded=false}
 if(t.state==='open_unfunded'||t.state==='open'&&!funded)return no('not_funded');
 if(t.state!=='open')return no('closed');
 if(held)return no('on_hold');
 return{claimable:true,why_not:null,why_not_text:null};
}
/** Micro-units (1 AI$ = 1,000,000) as an AI$ number for display. */
export function microToAI(units:string){const v=BigInt(units),whole=v/1000000n,frac=(v%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return Number(frac?whole+'.'+frac:String(whole))}
export function centralDiscoveryRow(t:any,projectTitle?:string|null){
 const template=SURVEY.test(t.id)?'https://baink.money/api/native/central/survey-template/'+encodeURIComponent(t.id):undefined;
 const state=centralTaskStatus(t),contest=t.mode==='contest',conditional=t.payout==='conditional';
 return{id:t.id,kind:'central',authority:'native',project_id:t.project,...(projectTitle?{project_title:projectTitle}:{}),title:t.title,status:contest?state.status:'open',status_label:state.status_label,...centralTaskClaim(t),payout:conditional?'conditional':'immediate',
  ...(contest?{mode:'contest',closes_at:when(t.closes_at),entries:Number(t.entries??'0'),max_entries:Number(t.max_entries)}:{}),
  ...(conditional?{condition:t.condition,resolves_by:when(t.resolves_by)}:{}),
  reward:{currency:'AI$',solver_ai:microToAI(t.solver_amount),check_ai:microToAI(t.reviewer_amount),solver_micro:t.solver_amount,check_micro:t.reviewer_amount},
  criteria:t.criteria,acceptance_digest:t.acceptance_digest,eligibility:t.eligibility??null,
  how_to_contribute:{via:'BAINK',mcp:'https://baink.money/mcp',...(template?{template}:{}),steps:'claimable: true means you can take it now. Enrol at baink.money with your own key, join the project, draft from the template, submit; central UAIN review pays AI$.'}};
}
/** Proved central rows for discovery, or an explicit unavailable marker. */
/** `heightOf`, when given, is the proved height of each record key: rows read in separate proofs
 * then carry `proved_height`, and the result says the page is not one atomic snapshot. */
export async function centralDiscovery(read:CentralRead,{pins,isProjectVisible,projectTitle,heightOf}:{pins:{chainId:string;epoch:string};isProjectVisible?:(id:string)=>boolean;projectTitle?:(id:string)=>Promise<string|null>;heightOf?:(key:string)=>string|undefined}){
 try{
  const {tasks,total,truncated}=await readCentralTasks(read),titles=new Map<string,string|null>(),rows=[],not_claimable:Record<string,number>={};
  for(const t of tasks){
   if(isProjectVisible&&!isProjectVisible(t.project))continue;
   const claim=centralTaskClaim(t,centralTaskHeld(t,pins));
   if(!claim.claimable||!centralTaskOpen(t)){const why=claim.why_not??'closed';not_claimable[why]=(not_claimable[why]??0)+1;continue}
   if(!titles.has(t.project)){let title:string|null=null;try{title=projectTitle?await projectTitle(t.project):null}catch{title=null}titles.set(t.project,title)}
   const height=heightOf?.('central_task/'+t.id);rows.push({...centralDiscoveryRow(t,titles.get(t.project)),...(height?{proved_height:height}:{})});
  }
  const heights=heightOf?rows.map(r=>r.proved_height).filter(Boolean).map(BigInt):[];
  const range=heights.length?{proved_heights:{min:String(heights.reduce((a,b)=>a<b?a:b)),max:String(heights.reduce((a,b)=>a>b?a:b))},consistent_snapshot:false}:{};
  return{status:'available' as const,total,read:tasks.length,truncated,rows,not_claimable,...range};
 }catch{return{status:'unavailable' as const,rows:[] as any[]}}
}

/** Project rows with tasks.central_open: the number of open, funded central tasks of each project. */
export function withCentralOpenCounts(rows:any[],centralRows:any[]){
 const counts=new Map<string,number>();for(const r of centralRows)counts.set(r.project_id,(counts.get(r.project_id)??0)+1);
 return rows.map(r=>({...r,tasks:{...r.tasks,central_open:counts.get(r.id)??0}}));
}

/** Proved central discovery results. Reading every central task and its index takes many proof
 * reads (19 s at 104 tasks on 9 November 2026), so a page answers from the last proved result: fresh
 * for CENTRAL_CACHE_MS, then still served (up to CENTRAL_STALE_MS old) while one background refresh
 * proves a new one. Only available results are kept; a page that uses one carries `cached_at`.
 * Submission re-checks every task on chain, so a list at most minutes old never pays wrongly. */
export const CENTRAL_CACHE_MS=30000,CENTRAL_STALE_MS=300000;
const centralCache=new Map<string,{at:number;value:any}>(),refreshing=new Map<string,Promise<any>>();
async function refresh(key:string,load:()=>Promise<any>,now:number){
 if(!refreshing.has(key))refreshing.set(key,(async()=>{try{const value=await load();if(value.status==='available'){if(centralCache.size>=8&&!centralCache.has(key))centralCache.clear();centralCache.set(key,{at:now,value})}return value}finally{refreshing.delete(key)}})());
 return refreshing.get(key)!;
}
export async function cachedCentralDiscovery(key:string,load:()=>Promise<any>,now=Date.now()){
 const hit=centralCache.get(key),age=hit?now-hit.at:Infinity;
 if(hit&&age<CENTRAL_STALE_MS){if(age>=CENTRAL_CACHE_MS)void refresh(key,load,now).catch(()=>{});return{...hit.value,cached_at:new Date(hit.at).toISOString()}}
 return refresh(key,load,now);
}

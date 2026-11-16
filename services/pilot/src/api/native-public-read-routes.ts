/** Public pages read the selected native authority. Legacy ledger URLs retain
 * their immutable archive and never receive fabricated native events. */
import{pool,DATABASE_URL,registerStoreClose}from'../storage/store.ts';import{nativeConfig,nativeState}from'./native-routes.ts';import{createNativePublicReader,nativeTaskDiscovery}from'../native/public-read.ts';
import{readNativeBaseline}from'../native/baseline.ts';
import{createNativePublicProofCache}from'../native/public-proof-cache.ts';
import{readNativePublicVisibility,type NativePublicVisibility}from'../native/public-visibility.ts';
import{memberRow,queryNativePublicRows}from'../native/public-query.ts';
import{createNativePublicSiteSnapshots}from'../native/public-site-snapshot.ts';
import{centralDiscovery,cachedCentralDiscovery,CENTRAL_RETRY_MS,withCentralOpenCounts,centralTaskShape,centralTaskHeld}from'../native/central-discovery.ts';
import{readWithRetry}from'../native/read-retry.ts';
import{createNativePublicCatchUp,createNativePublicCatchUpPool,createNativePublicHeadReader,nativeProjectionBehind,NativePublicProjectionPending}from'../native/public-catch-up.ts';
import{createOwnHeightProver,createBrowsePageCache,browseProvedBlock,browseChainTime,NativePublicReadWarming,BROWSE_VIEW_MS,BROWSE_COLD_WAIT_MS,type BrowsePage,type BrowseStamp}from'../native/public-browse.ts';
const proofCache=createNativePublicProofCache(),siteSnapshots=createNativePublicSiteSnapshots();
const catchUp=createNativePublicCatchUp(createNativePublicCatchUpPool(DATABASE_URL)),checkpointHead=createNativePublicHeadReader(config=>readNativeBaseline(config,['credit_count','karma_count']));
let publicClosed=false;
registerStoreClose(async()=>{publicClosed=true;if(refreshTimer)clearTimeout(refreshTimer);await catchUp.close()});
let sourceCache={rows:new Map<string,any>(),bytes:0},catalogCache=new Map<string,string[]>();let epoch='';
const responseCache=new Map<string,{value:any;bytes:number;expires:number}>(),inFlight=new Map<string,Promise<any>>();let responseBytes=0;
async function sourceVersion(){const r=(await pool.query('SELECT count(*)::text AS n,max(published_at)::text AS last FROM native_publications WHERE epoch=$1',[nativeConfig()!.genesisHash])).rows[0];return JSON.stringify([r.n,r.last])}
const listPath=/^\/api\/(projects|tasks|directory|contributions|members)$/;
const detailPath=/^\/api\/(projects|tasks|directory|contributions|members)\/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})(?:\/(claims|tasks|members))?$/;
const projectSubPath=/^\/api\/projects\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\/(claims|tasks|members)$/;
const sitePath=(url:URL)=>url.searchParams.get('discover')!=='1'&&(listPath.test(url.pathname)||['/api/stats','/api/directory/map'].includes(url.pathname)||/^\/api\/projects\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?:\/(claims|tasks|members))?$/.test(url.pathname));
/** Browse views (lists, discovery, stats, the map and project pages) answer from the last proved
 * result; see public-browse.ts. Everything else, and every /api/native/public/… path, stays strict. */
const browsePath=(url:URL)=>listPath.test(url.pathname)||['/api/stats','/api/directory/map'].includes(url.pathname)||/^\/api\/projects\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?:\/(claims|tasks|members))?$/.test(url.pathname);
const pinKey=(config:any)=>JSON.stringify([config.binary,config.binaryHash,config.genesis,config.genesisHash,config.rpc]);
function canonicalQuery(url:URL){const query=new URLSearchParams(listPath.test(url.pathname)||projectSubPath.test(url.pathname)?'':url.search);query.delete('site_snapshot');query.sort();return query.toString()}
function snapshotKey(config:any,visibility:NativePublicVisibility,url:URL){return JSON.stringify([pinKey(config),visibility.version,url.pathname,canonicalQuery(url)])}
const generationKey=(config:any,head:any,visibility:NativePublicVisibility,publications:string)=>JSON.stringify([pinKey(config),head.event_count,head.records.credit_count,head.records.karma_count,visibility.version,publications]);
function presentPublicResult(url:URL,result:any,time:string){
 if(listPath.test(url.pathname))return{...result,body:{...result.body,...queryNativePublicRows(url,result.body[url.pathname==='/api/directory'?'participants':url.pathname.split('/')[2]],result.discoveryProjects,time,url.pathname==='/api/tasks'?result.central:undefined)}};
 const sub=url.pathname.match(projectSubPath)?.[1];return sub&&result.status===200&&Array.isArray(result.body[sub])?{...result,body:{...result.body,...pagination(url,result.body[sub],sub)}}:result;
}
/** Site mode does no chain work: only current pins/epoch and live archive SQL
 * are consulted. A missing or invalid dated snapshot refuses immediately. */
export async function nativePublicSiteSnapshot(url:URL){
 if(url.search.length>2048||!sitePath(url))throw new NativePublicProjectionPending('website snapshot unavailable');
 const config=nativeConfig();if(!config||process.env.UAIN_NATIVE_PROJECTION!=='1')throw new NativePublicProjectionPending('website snapshot pins unavailable');
 const [visibility,epochs]=await Promise.all([readNativePublicVisibility((s,a)=>pool.query(s,a)),pool.query('SELECT chain_id,genesis_sha256,retired_at FROM native_epochs WHERE epoch=$1',[config.genesisHash])]);
 const row=epochs.rows[0],hit=siteSnapshots.get(snapshotKey(config,visibility,url));
 if(!row||row.retired_at||row.genesis_sha256!==config.genesisHash||!hit||hit.value.body.epoch!==config.genesisHash||hit.value.chain_id!==row.chain_id)throw new NativePublicProjectionPending('website snapshot unavailable');
 const result=presentPublicResult(url,hit.value,new Date(hit.verifiedAt).toISOString());return{...result,body:{...result.body,site_snapshot:{verified_at:new Date(hit.verifiedAt).toISOString(),refresh_pending:refreshNeeded||!!warmPending,authoritative:false}}};
}
let lastCheckpointAt=0;
const kinds:any={projects:'project',tasks:'task',directory:'participant',contributions:'contribution',members:'member'};
function pagination(url:URL,rows:any[],name:string){const page=Number(url.searchParams.get('page')??1),size=Number(url.searchParams.get('page_size')??20);if(!Number.isInteger(page)||page<1||page>100000||!Number.isInteger(size)||size<1||size>200)throw Error('bounded public page required');return{count:rows.length,page,page_size:size,pages:Math.max(1,Math.ceil(rows.length/size)),[name]:rows.slice((page-1)*size,page*size)}}
async function checkpoint(config:any){
 const inspect=async()=>{const baseline=await checkpointHead(config),[epochs,journalRows]=await Promise.all([pool.query('SELECT * FROM native_epochs WHERE epoch=$1',[config.genesisHash]),pool.query('SELECT kind,cursor FROM native_journal_cursors WHERE epoch=$1',[config.genesisHash])]);return{baseline,s:baseline.state,e:epochs.rows[0],journals:journalRows.rows}};
 let {baseline,s,e,journals}=await inspect();
 if(nativeProjectionBehind(e,s,journals)){await catchUp.catchUp(config);({baseline,s,e,journals}=await inspect())}
 if(!e||e.retired_at||e.chain_id!==s.chain_id||e.cursor!==s.event_count||['credit','karma'].some(k=>(journals.find(r=>r.kind===k)?.cursor??'0')!==String(s.records[k+'_count']??0))){if(nativeProjectionBehind(e,s,journals))throw new NativePublicProjectionPending('native public projection catching up');throw Error('native public projection checkpoint unavailable')}
 lastCheckpointAt=Date.now();return{...s,baseline};
}
function selectEpoch(config:any){if(epoch!==config.genesisHash){sourceCache={rows:new Map<string,any>(),bytes:0};catalogCache=new Map<string,string[]>();epoch=config.genesisHash}}
/** `browse` builds a page from a proved view (its reader and opening head) without the closing
 * head-equality fence; the strict path is unchanged. */
async function buildNativePublicData(url:URL,visibility:NativePublicVisibility,browse?:{reader:any;head:any}){
 const config=nativeConfig();if(!config||process.env.UAIN_NATIVE_PROJECTION!=='1')throw Error('native public pins/projection required');if(!browse)selectEpoch(config);
 const initial=browse?browse.head:await checkpoint(config),selectedEpoch=config.genesisHash,reader=browse?browse.reader:createNativePublicReader({epoch:selectedEpoch,query:(s,a)=>pool.query(s,a),read:proofCache.reader(selectedEpoch+'|'+pinKey(config),initial,s=>nativeState(s,config)),sourceCache,catalogCache,baselineMembers:initial.baseline.members,visibility}),path=url.pathname;let body:any,status=200,nextDiscoveryChange=Infinity,central:any;const discoveryProjects:Record<string,any>={};
 if(path==='/api/native/events'){
  const limit=Number(url.searchParams.get('limit')??80);if(!Number.isInteger(limit)||limit<1||limit>200)throw Error('bounded native event page required');const rows=(await pool.query('SELECT record FROM native_events WHERE epoch=$1 ORDER BY length(event_id) DESC,event_id DESC LIMIT $2',[epoch,limit])).rows;const keys=rows.map(r=>{if(!/^[1-9][0-9]{0,19}$/.test(r.record.id)||BigInt(r.record.id)>BigInt(initial.event_count))throw Error('native event identity differs');return 'event/'+r.record.id.padStart(20,'0')}),proof=await reader.records(keys);const events=keys.map(key=>{const e=proof.records[key];if(!e||'event/'+e.id.padStart(20,'0')!==key)throw Error('native event proof differs');return{...e,at:null,actor:e.instance||e.member||null,kind:e.operation,summary:`Native ${e.operation} ${e.subject}`,authority:'native'}});body={count:events.length,events};
 }else if(path==='/api/directory/map'){
  await reader.warm(['participant','member']);const participants=[];for(const id of await reader.ids('participant'))participants.push(await reader.participant(id,false));body={participants,total:participants.length,unplaced:participants.filter(p=>!p.placed).length};
 }else if(path==='/api/stats'){
  await reader.warm(['participant','member','contribution']);const agents=[];for(const id of await reader.ids('participant'))agents.push(await reader.participant(id,false));const members=[];for(const id of await reader.ids('member'))members.push(await reader.member(id,false));const work=[];for(const id of await reader.ids('contribution'))work.push(await reader.contribution(id));body={members:agents.filter(a=>a.state!=='withdrawn').length,member_count:members.filter(m=>m.licence.status==='active').length,participants:agents.length,projects:(await reader.ids('project')).length,contributions:work.length,settled:work.filter(c=>c.state==='settled').length,karma:members.reduce((n,m)=>n+m.karma,0),regions:new Set(agents.map(a=>a.region).filter(Boolean)).size,events:initial.event_count,calls:null,callers:null,last24h:null,agents:[],telemetry:'Native consensus does not record HTTP caller statistics.'};
 }else{
  const detail=path.match(detailPath),list=path.match(listPath);if(!detail&&!list)throw Error('unsupported native public path');const category=(detail??list)![1],kind=kinds[category];
  // The member list (10 November 2026): one row per member, its agents under it. The
  // directory lists agents, so a member with four agents showed four times, and a member
  // who joined through the kit (no agent) never showed. Everything here is proved.
  if(list&&kind==='member'){await reader.warm(['participant','member']);const agents=new Map<string,any[]>();for(const id of await reader.ids('participant')){const p=await reader.participant(id,false);if(p?.address){const at=agents.get(p.address)??[];at.push(p);agents.set(p.address,at)}}
   const rows=[];for(const id of await reader.ids('member')){const m=await reader.member(id,false);if(!m)continue;const own=agents.get(m.address)??[];if(m.licence?.status==='unclaimed'&&!own.length)continue;rows.push(memberRow(m,own))}
   body={count:rows.length,members:rows};
  }else{
  const needed=kind==='project'?['project','task','contribution','claim','participant','member','amendments','claim_reviews','claim_revisions','verifications','prior_art_challenges','benevolence_flags','kpi_resolutions']:kind==='task'||kind==='contribution'?['project','task','contribution','verifications','prior_art_challenges','benevolence_flags','kpi_resolutions']:['participant','member'];if(!detail||!['task','contribution'].includes(kind))await reader.warm(needed);
  const get=async(id:string)=>kind==='project'?reader.project(id,!list):kind==='task'?reader.task(id):kind==='contribution'?reader.contribution(id):kind==='member'?reader.member(id):reader.participant(id,!!detail);
  if(detail){body=await get(detail[2]);if(body&&kind==='task'&&url.searchParams.get('discover')==='1'){const discoveryProject=await reader.discoveryProject(body.project_id);let discovery=nativeTaskDiscovery(body,discoveryProject,body.status==='open'?'open':'all',initial.header_time);
  // A detail page of an original-policy task that is no longer open (answered, closed, waiting for
  // checks) reads as history (16 November 2026): its lifecycle status is the filter that admits it
  // (taskDiscovery HISTORY_STATUSES), so /tasks/T-43 answers instead of 404.
  if(!discovery&&body.status!=='open')discovery=nativeTaskDiscovery(body,discoveryProject,String(body.status??''),initial.header_time);if(discovery&&body.kind==='future'&&body.status==='open')nextDiscoveryChange=Date.parse(body.resolves_by);body=discovery?{...body,policy:discovery.policy,discovery}:null;}if(!body){status=404;body={error:'not_found',id:detail[2]}}else if(detail[3]){if(kind!=='project')throw Error('project subresource required');const sub=detail[3],rows=[];if(sub==='members'){for(const m of body.members.recent)rows.push(m)}else for(const id of await reader.ids(sub==='claims'?'claim':'task')){const row=sub==='claims'?await reader.claim(id):await reader.task(id);if(row?.project_id===detail[2])rows.push(row)}body={project_id:detail[2],count:rows.length,[sub]:rows}}}
  else{const rows=[];for(const id of await reader.ids(kind)){const row=await get(id);if(row&&(category!=='tasks'||visibility.isProjectVisible(row.project_id)))rows.push(row)}
   if(category==='tasks')for(const id of new Set(rows.map(r=>r.project_id))){const project=await reader.discoveryProject(id);if(project)discoveryProjects[id]=project}
   // Central project tasks are held beside, never inside, the catalogue body:
   // only discovery presents them, and a failed read leaves legacy rows intact.
   // One proved central result serves both lists. The project list used to prove every central task
   // a second time under its own cache key, only to count them: about 45 more proof reads in every
   // view (10 November 2026). Its rows are the visible projects, so the counts are the same.
   const centralRows=()=>cachedCentralDiscovery(JSON.stringify(['tasks',initial.chain_id,selectedEpoch,visibility.version]),()=>{const src=centralSource(config,initial.chain_id);return centralDiscovery(src.read,{heightOf:src.heightOf,pins:{chainId:initial.chain_id,epoch:selectedEpoch},isProjectVisible:id=>visibility.isProjectVisible(id),projectTitle:async id=>(await reader.discoveryProject(id))?.title??null})});
   if(category==='tasks')central=await centralRows();
   // Each project row also counts its open, funded central tasks (survey parts and later units), so
   // project listings (and BAINK's baink_projects) show work that only BAINK can take.
   if(category==='projects'){const open=await centralRows();if(open.status==='available')rows.splice(0,rows.length,...withCentralOpenCounts(rows,open.rows))}
   const name=category==='directory'?'participants':category;body={count:rows.length,[name]:rows};
  }
  }
 }
 if(browse)return{status,chain_id:initial.chain_id,header_time:initial.header_time,discoveryProjects,central,body:{...body,authority:'native',epoch:selectedEpoch,state_height:initial.height,app_hash:initial.app_hash,finalized_events:initial.event_count}};
 const [final,finalVisibility]=await Promise.all([checkpoint(config),readNativePublicVisibility((s,a)=>pool.query(s,a))]);if(finalVisibility.version!==visibility.version)throw Error('native public visibility changed during read; retry');if(final.chain_id!==initial.chain_id||final.event_count!==initial.event_count||Date.parse(final.header_time)>=nextDiscoveryChange)throw Error('native public state advanced during read; retry');const expires=central?.status==='unavailable'?Math.min(nextDiscoveryChange,Date.parse(final.header_time)+CENTRAL_RETRY_MS):nextDiscoveryChange;return{status,chain_id:final.chain_id,expires,discoveryProjects,central,body:{...body,authority:'native',epoch:selectedEpoch,state_height:final.height,app_hash:final.app_hash,finalized_events:final.event_count}};
}
/** Browse paths answer from the last proved page (browseData); `strict` (the /api/native/public/…
 * twins) and every other path take the head-bound read below. */
export async function nativePublicData(url:URL,{strict=false}:{strict?:boolean}={}){
 if(!strict&&browsePath(url))return browseData(url);
 return strictPublicData(url);
}
// Cache only a completed independently verified result at an exact immutable
// event/journal checkpoint. Every hit independently verifies the current head;
// changes or a retired/reset epoch force a new build, with no stale fallback.
async function strictPublicData(url:URL){
 if(url.search.length>2048)throw Error('bounded native public query required');const config=nativeConfig();if(!config)throw Error('native public pins required');
 const [head,visibility,publications]=await Promise.all([checkpoint(config),readNativePublicVisibility((s,a)=>pool.query(s,a)),sourceVersion()]);
 const list=listPath.test(url.pathname)||projectSubPath.test(url.pathname),query=new URLSearchParams(canonicalQuery(url));
 const key=[pinKey(config),head.event_count,String(head.records.credit_count??0),String(head.records.karma_count??0),visibility.version,publications,url.pathname,query.toString()].join('|');
 const present=(result:any)=>presentPublicResult(url,result,head.header_time);
 const hit=responseCache.get(key);if(hit&&Date.parse(head.header_time)<hit.expires){if(sitePath(url))siteSnapshots.put(snapshotKey(config,visibility,url),hit.value,generationKey(config,head,visibility,publications));return present(hit.value);}if(hit){responseBytes-=hit.bytes;responseCache.delete(key)}if(inFlight.has(key))return present(await inFlight.get(key));if(inFlight.size>=8)throw Error('native public read capacity reached');
 const base=new URL(url);if(list)base.search='';
 const promise=buildNativePublicData(base,visibility).then(result=>{if(sitePath(base))siteSnapshots.put(snapshotKey(config,visibility,base),result,generationKey(config,head,visibility,publications));const bytes=Buffer.byteLength(JSON.stringify(result));while(responseCache.size&&(responseCache.size>=256||responseBytes+bytes>64*1024*1024)){const oldest=responseCache.keys().next().value!;responseBytes-=responseCache.get(oldest)!.bytes;responseCache.delete(oldest)}if(bytes<=64*1024*1024){responseCache.set(key,{value:result,bytes,expires:result.expires});responseBytes+=bytes}return result}).finally(()=>inFlight.delete(key));inFlight.set(key,promise);return present(await promise);
}
let refreshNeeded=true,warmPending:Promise<void>|null=null,warmed=false,refreshTimer:ReturnType<typeof setTimeout>|null=null;
export function nativePublicReady(now=Date.now()){return process.env.UAIN_AUTHORITY!=='native'||(warmed&&now-lastCheckpointAt<=120000)}
let lastWarmLogAt=0;
function warmLog(message:string){const now=Date.now();if(now-lastWarmLogAt<60000)return;lastWarmLogAt=now;console.error('Native public read warm-up: '+message)}
/** Central rows come from their own proved reads, in batches of 16 keys (one proof read of every
 * central task at once exceeded the reader's bounds and made discovery unavailable, 9 November 2026),
 * each batch a complete native proof on the pinned
 * chain at its own height, not tied to the page's head checkpoint: with the task stock filling, an
 * event almost always landed during the 10+ batch central read and discarded the whole page
 * (9 November 2026). The rows are a discovery list (submission re-checks the task on chain). */
const CENTRAL_PROOF_KEYS=16;
const centralRead=(config:any,chainId:string,heights:Map<string,string>)=>async(keys:string[])=>{const records:Record<string,any>={};for(let i=0;i<keys.length;i+=CENTRAL_PROOF_KEYS){const batch=keys.slice(i,i+CENTRAL_PROOF_KEYS),state=await nativeState({keys:batch},config);if(state?.chain_id!==chainId||!state.records||typeof state.height!=='string')throw Error('native public central proof differs');for(const k of batch){heights.set(k,state.height);records[k]=state.records[k]}}return records};
/** Inputs of GET /api/accepted (accepted-work.ts): the newest projected central_review events,
 * proved central records in batches of CENTRAL_PROOF_KEYS, and the block time at a height from
 * the pinned node's signed commit header. Null when native authority is not configured. */
export function acceptedWorkDeps(){
 const config=nativeConfig();if(!config||process.env.UAIN_AUTHORITY!=='native')return null;
 return{
  reviews:async(limit:number)=>(await pool.query("SELECT record FROM native_events WHERE epoch=$1 AND record->>'operation'='central_review' ORDER BY length(event_id) DESC,event_id DESC LIMIT $2",[config.genesisHash,limit])).rows.map((r:any)=>({subject:String(r.record.subject??''),height:String(r.record.height??'')})),
  read:async(keys:string[])=>{const out:Record<string,any>={};for(let i=0;i<keys.length;i+=CENTRAL_PROOF_KEYS){const batch=keys.slice(i,i+CENTRAL_PROOF_KEYS),state=await nativeState({keys:batch},config);if(!state?.records||typeof state.height!=='string')throw Error('native public central proof differs');for(const k of batch)out[k]=state.records[k]??null}return out},
  names:async(kind:'member'|'project',id:string)=>{const r=await nativePublicData(new URL('/api/'+(kind==='member'?'members':'projects')+'/'+encodeURIComponent(id),'https://uain.invalid'));return r.status===200?r.body:null},
  timeAt:async(height:string)=>{const r=await fetch(config.rpc,{method:'POST',headers:{'content-type':'application/json'},redirect:'error',body:JSON.stringify({jsonrpc:'2.0',id:'accepted-time',method:'commit',params:{height}}),signal:AbortSignal.timeout(5000)});if(!r.ok)return null;const b:any=await r.json();const h=b?.result?.signed_header?.header;return h?.height===height&&typeof h.time==='string'&&Number.isFinite(Date.parse(h.time))?new Date(Date.parse(h.time)).toISOString():null},
 };
}
/** One central (BAINK) task for its page on uain.global (/tasks/<id>, 16 November 2026). Before,
 * every link to a central task went to BAINK's raw survey-template JSON, which BAINK refuses to a
 * click from another site (origin_forbidden). One proved read: the task, and when it has a winner,
 * that submission and its solver award. The evidence of an accepted submission is a public chain
 * record (K-38), shown so a visitor sees what was produced. Null when the task does not exist or
 * its project is archived. */
export async function centralTaskForPage(id:string){
 const config=nativeConfig();if(!config||process.env.UAIN_AUTHORITY!=='native'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id))return null;
 const first=await nativeState({keys:['central_task/'+id]},config),t=first?.records?.['central_task/'+id];
 if(!t)return null;if(!centralTaskShape(t,id))throw Error('native central task proof differs');
 const visibility=await readNativePublicVisibility((q,a)=>pool.query(q,a));if(!visibility.isProjectVisible(t.project))return null;
 const pins={chainId:String(first.chain_id??''),epoch:config.genesisHash};
 let winner:any=null;
 if(typeof t.winner==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(t.winner)){
  const r=(await nativeState({keys:['central_submission/'+t.winner,'central_award/solver/'+t.winner]},config)).records??{};
  const sub=r['central_submission/'+t.winner],award=r['central_award/solver/'+t.winner];
  if(sub&&sub.id===t.winner&&sub.task===id&&award&&award.submission===t.winner&&award.role==='solver'){
   let time:string|null=null;try{time=(await acceptedWorkDeps()?.timeAt(String(award.height)))??null}catch{time=null}
   winner={submission:t.winner,author:String(sub.author??''),state:String(sub.state??''),evidence:typeof sub.evidence==='string'?sub.evidence:'',amount:String(award.amount??''),height:String(award.height??''),time};
  }
 }
 return{task:t,held:centralTaskHeld(t,pins),height:String(first.height??''),winner};
}
const centralSource=(config:any,chainId:string)=>{const heights=new Map<string,string>();return{read:centralRead(config,chainId,heights),heightOf:(k:string)=>heights.get(k)}};
/** Browse views (public-browse.ts; design in docs/testing/public-read-speed-2026-11-10.md). One
 * proved view per pin set, chain id, genesis epoch and archive-visibility version: its own strict
 * opening checkpoint, then records proved on demand at their own heights and shared by every page
 * of the view. A view is confirmed current (same event and journal counts, every batch proved at
 * its opening count) or replaced once it is BROWSE_VIEW_MS old; pages say how old they are. */
type View={key:string;head:any;reader:any;prover:ReturnType<typeof createOwnHeightProver>;stamp:BrowseStamp;generation:string;broken:boolean};
type Scope={key:string;chainId:string;visibility:NativePublicVisibility};
const views=new Map<string,View>(),viewOpening=new Map<string,Promise<View>>(),pages=createBrowsePageCache(),pageBuilds=new Map<string,Promise<BrowsePage>>();let viewSeq=0;
const headGeneration=(head:any,publications:string)=>JSON.stringify([head.chain_id,head.event_count,String(head.records.credit_count??0),String(head.records.karma_count??0),publications]);
function browseWaitMs(){const n=Number(process.env.UAIN_PUBLIC_BROWSE_WAIT_MS??BROWSE_COLD_WAIT_MS);return Number.isInteger(n)&&n>=100&&n<=BROWSE_COLD_WAIT_MS?n:BROWSE_COLD_WAIT_MS}
/** Two SQL reads, no proof: the key a page is held under. A retired or missing epoch refuses. */
async function browseScope(config:any):Promise<Scope>{
 const [visibility,epochs]=await Promise.all([readNativePublicVisibility((s,a)=>pool.query(s,a)),pool.query('SELECT chain_id,genesis_sha256,retired_at FROM native_epochs WHERE epoch=$1',[config.genesisHash])]);
 const row=epochs.rows[0];if(!row||row.retired_at||row.genesis_sha256!==config.genesisHash||typeof row.chain_id!=='string')throw Error('native public epoch unavailable');
 return{key:JSON.stringify([pinKey(config),row.chain_id,config.genesisHash,visibility.version]),chainId:row.chain_id,visibility};
}
function openView(config:any,scope:Scope,checked?:{head:any;publications:string}):Promise<View>{
 const prior=viewOpening.get(scope.key);if(prior)return prior;
 const opening=(async()=>{
  const {head,publications}=checked??await (async()=>{const [head,publications]=await Promise.all([readWithRetry(()=>checkpoint(config),{attempts:3}),sourceVersion()]);return{head,publications}})();
  if(head.chain_id!==scope.chainId)throw Error('native public epoch changed');selectEpoch(config);
  const prover=createOwnHeightProver(head,s=>nativeState(s,config));
  const reader=createNativePublicReader({epoch:config.genesisHash,query:(s,a)=>pool.query(s,a),read:prover.read,sourceCache,catalogCache,baselineMembers:head.baseline.members,visibility:scope.visibility});
  const view:View={key:scope.key,head,reader,prover,stamp:{id:++viewSeq,asOf:Date.now(),headerTime:head.header_time},generation:headGeneration(head,publications),broken:false};
  // One line per view (at most one a minute while the chain moves): what the replaced view cost.
  const prev=views.get(scope.key);if(prev){const p=prev.prover.stats(),held=pages.size(),snaps=siteSnapshots.size(),mb=(n:number)=>(n/1048576).toFixed(1)+' MB';console.error('Native public browse view '+view.stamp.id+' opened at height '+head.height+' (events '+head.event_count+'); view '+prev.stamp.id+' proved '+p.keys+' keys in '+p.batches+' batches, heights '+p.from+'-'+p.to+(p.consistent?', one snapshot':', several heights')+(prev.broken?', replaced after a failed page':'')+'; holding '+held.entries+' of '+held.maxEntries+' pages ('+mb(held.bytes)+' of '+mb(held.maxBytes)+') and '+snaps.entries+' of '+snaps.maxEntries+' website snapshots ('+mb(snaps.bytes)+' of '+mb(snaps.maxBytes)+')')}
  views.delete(scope.key);views.set(scope.key,view);while(views.size>2)views.delete(views.keys().next().value!);
  return view;
 })().finally(()=>viewOpening.delete(scope.key));
 viewOpening.set(scope.key,opening);return opening;
}
/** The view to build from: the current one while it is young, the same one re-dated when a fresh
 * checkpoint shows nothing changed (same event and journal counts and publications, every batch
 * proved at the opening count), otherwise a new one once the old is BROWSE_VIEW_MS old. A view that
 * failed a page is replaced (at most every 10 s): its shared records would fail the same way again.
 * `probe` (the 5 s warm pass) always checkpoints, so a quiet chain keeps pages seconds old and the
 * readiness checkpoint stays fresh. */
async function currentView(config:any,scope:Scope,{probe=false}:{probe?:boolean}={}):Promise<View>{
 const view=views.get(scope.key),now=Date.now();
 if(view&&!view.prover.stats().full){
  const due=now-view.stamp.asOf>=(view.broken?10000:BROWSE_VIEW_MS);if(!due&&!probe)return view;
  const [head,publications]=await Promise.all([readWithRetry(()=>checkpoint(config),{attempts:3}),sourceVersion()]);
  if(!view.broken&&views.get(scope.key)===view&&headGeneration(head,publications)===view.generation&&view.prover.stats().consistent){view.stamp.asOf=Date.now();view.stamp.headerTime=head.header_time;siteSnapshots.renew('view:'+view.stamp.id,view.stamp.asOf);return view}
  if(!due)return view;
  // A request and the warm pass can both find the view due; whichever checkpoint returns second
  // reuses the view the first one opened instead of proving a second census (seen live, 10 Nov 00:25 UTC).
  const opened=views.get(scope.key);if(opened&&opened!==view&&!opened.broken)return opened;const opening=viewOpening.get(scope.key);if(opening)return opening;
  return openView(config,scope,{head,publications});
 }
 return openView(config,scope);
}
function refreshPage(config:any,scope:Scope,base:URL,pageKey:string):Promise<BrowsePage>{
 const prior=pageBuilds.get(pageKey);if(prior)return prior;
 if(pageBuilds.size>=32)return Promise.reject(new NativePublicReadWarming());
 const build=(async()=>{
  const view=await currentView(config,scope);let result:any;
  try{result=await buildNativePublicData(base,scope.visibility,{reader:view.reader,head:view.head})}catch(e:any){if(!/bounded|required$/.test(String(e?.message??'')))view.broken=true;throw e}
  const stats=view.prover.stats(),page={result,stamp:view.stamp,builtAt:Date.now(),from:stats.from,to:stats.to,consistent:stats.consistent};
  if(result.status===200){pages.put(pageKey,page);if(sitePath(base))siteSnapshots.put(snapshotKey(config,scope.visibility,base),result,'view:'+view.stamp.id,view.stamp.asOf)}
  return{...page,bytes:0};
 })().finally(()=>pageBuilds.delete(pageKey));
 pageBuilds.set(pageKey,build);return build;
}
const browsePageKey=(scope:Scope,base:URL,url:URL)=>JSON.stringify([scope.key,base.pathname,canonicalQuery(url)]);
/** A proved page at once when one is held (rebuilt in the background once its view is due);
 * otherwise wait for one up to browseWaitMs(), then a retry-after, inside the 30 s gateway. */
async function browseData(url:URL){
 if(url.search.length>2048)throw Error('bounded native public query required');const config=nativeConfig();if(!config||process.env.UAIN_NATIVE_PROJECTION!=='1')throw Error('native public pins/projection required');
 const scope=await browseScope(config),base=new URL(url);if(listPath.test(url.pathname)||projectSubPath.test(url.pathname))base.search='';
 const pageKey=browsePageKey(scope,base,url),now=Date.now();let page=pages.get(pageKey);
 if(page){const view=views.get(scope.key);if(!view||view.stamp!==page.stamp||now-view.stamp.asOf>=BROWSE_VIEW_MS||page.result.central?.status==='unavailable'&&now-page.builtAt>=5000)void refreshPage(config,scope,base,pageKey).catch(()=>{})}
 else{
  const build=refreshPage(config,scope,base,pageKey);let timer:ReturnType<typeof setTimeout>|undefined;
  const settled=await Promise.race([build.then(p=>({p}),e=>({e})),new Promise<null>(r=>{timer=setTimeout(()=>r(null),browseWaitMs())})]).finally(()=>clearTimeout(timer));
  if(!settled){build.catch(()=>{});throw new NativePublicReadWarming()}
  if('e' in settled)throw settled.e;page=settled.p;
 }
 const at=Date.now(),result=presentPublicResult(url,page.result,browseChainTime(page.stamp,at));
 return{...result,body:{...result.body,proved:browseProvedBlock(page,at,pageBuilds.has(pageKey),'/api/native/public/'+url.pathname.slice('/api/'.length))}};
}
/** Keep this replica's browse pages proved: the six core pages first (the replica turns ready once
 * they have been proved and its last checkpoint is under 120 s old), then every project page, best
 * effort. Pages of a view still current are not rebuilt. Runs again 5 s after each pass. */
const CORE_PATHS=['/api/stats','/api/projects','/api/tasks','/api/directory','/api/contributions','/api/directory/map'];
export function warmNativePublicReads():Promise<void>{
 if(publicClosed||process.env.UAIN_AUTHORITY!=='native')return Promise.resolve();if(warmPending)return warmPending;
 const run=(async()=>{
  refreshNeeded=true;const config=nativeConfig();if(!config)throw Error('native public pins required');if(process.env.UAIN_NATIVE_PROJECTION!=='1')throw Error('native public pins/projection required');
  const scope=await browseScope(config),view=await currentView(config,scope,{probe:true});
  const ensure=async(path:string)=>{const base=new URL(path,'https://uain.invalid'),key=browsePageKey(scope,base,base),page=pages.get(key);
   if(page&&page.stamp===view.stamp){const snap=snapshotKey(config,scope.visibility,base);if(!siteSnapshots.hasAll([snap]))siteSnapshots.put(snap,page.result,'view:'+view.stamp.id,view.stamp.asOf);return page}
   return refreshPage(config,scope,base,key)};
  for(const path of CORE_PATHS){try{await ensure(path)}catch(e:any){throw Error(path+': '+(e?.message??e))}}
  warmed=true;
  const failed:string[]=[];for(const id of await view.reader.ids('project'))for(const suffix of ['','/tasks','/claims','/members']){const path='/api/projects/'+encodeURIComponent(id)+suffix;try{await ensure(path)}catch{failed.push(path)}}
  if(failed.length)warmLog(`${failed.length} project page(s) not prewarmed; served on demand (${failed.slice(0,3).join(', ')})`);
  refreshNeeded=failed.length>0;
 })();
 warmPending=run.catch((e:any)=>{warmLog('failed at '+(e?.message??e)+'; retrying in 5 s');throw e}).finally(()=>{warmPending=null;if(!publicClosed&&!refreshTimer){refreshTimer=setTimeout(()=>{refreshTimer=null;void warmNativePublicReads().catch(()=>{})},5000);refreshTimer.unref()}});return warmPending;
}
export async function handleNativePublicReads(req:any,res:any,url:URL,send:any,audit:any){
 const explicit=url.pathname.startsWith('/api/native/public/');if(explicit){url=new URL(url);url.pathname='/api/'+url.pathname.slice('/api/native/public/'.length)}
 if((process.env.UAIN_AUTHORITY!=='native'&&!explicit)||req.method!=='GET'||!(['/api/native/events','/api/directory/map','/api/stats'].includes(url.pathname)||listPath.test(url.pathname)||detailPath.test(url.pathname)))return false;
 res.setHeader('x-uain-authority','native');try{const site=!explicit&&url.searchParams.get('site_snapshot')==='1'&&sitePath(url);const result=await(site?nativePublicSiteSnapshot(url):!explicit&&browsePath(url)?browseData(url):readWithRetry(()=>nativePublicData(url,{strict:true}),{attempts:3}));send(res,result.status,result.body);audit(result.status,'native public proof read')}
 catch(error){if(error instanceof NativePublicReadWarming){res.setHeader('retry-after',String(error.retryAfter));send(res,503,{error:'native_public_read_unavailable',authority:'native',retry_after_seconds:error.retryAfter,message:'This page is being proved on the chain right now. Try again in a few seconds.'});audit(503,'native public browse page warming');return true}
  if(error instanceof NativePublicProjectionPending)res.setHeader('retry-after','1');send(res,503,{error:'native_public_read_unavailable',authority:'native'});audit(503,'native public proof/projection refused')}return true;
}

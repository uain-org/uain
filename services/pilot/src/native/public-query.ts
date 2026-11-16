import {projectArea} from './project-areas.ts';
import {nativeTaskDiscovery} from './public-read.ts';
/** Filters operate on one completed verified catalogue, never on a new proof
 * census per search/page. Discovery deadlines are evaluated at the fresh head. */
/** `central` is the build's proved central-task discovery (central-discovery.ts).
 * Its open rows join open/all discovery and count toward pagination; its `history` rows (tasks not
 * open now, each with its tab) join the answered, under_review and closed filters. */
/** The /tasks tabs (16 November 2026). `under_review` is the page's word for the two legacy states
 * whose answers are still being checked or compared, and for central tasks under review. */
export const TASK_TABS=['open','answered','under_review','closed'] as const;
const LEGACY_STATUSES:Record<string,string[]>={under_review:['awaiting_verification','needs_comparison']};
function discoveryRows(input:any[],projects:Record<string,any>,requested:string,time:string,central?:{status:string;rows:any[];history?:any[]}){
 const statuses=LEGACY_STATUSES[requested]??[requested];
 const rows=input.flatMap(row=>{for(const status of statuses){const discovery=nativeTaskDiscovery(row,projects[row.project_id],status,time);if(discovery&&!(status==='open'&&discovery.closed_to_new_work))return[{...row,policy:discovery.policy,discovery,project_title:projects[row.project_id].title}]}return[]});
 if(central?.status==='available'){if(['open','all'].includes(requested))rows.push(...central.rows);else rows.push(...(central.history??[]).filter(r=>r.status===requested))}
 return rows;
}
export function queryNativePublicRows(url:URL,input:any[],projects:Record<string,any>={},time=new Date().toISOString(),central?:{status:string;rows:any[];[key:string]:any}) {
 const category=url.pathname.split('/')[2],name=category==='directory'?'participants':category;
 const taskCategory=category==='tasks',cursor=taskCategory?url.searchParams.get('cursor'):null;
 const size=Number(url.searchParams.get('page_size')??(taskCategory?url.searchParams.get('limit'):null)??20);
 const offset=cursor===null?null:Number(cursor);
 if(cursor!==null&&(!/^(0|[1-9][0-9]{0,8})$/.test(cursor)||!Number.isSafeInteger(offset)))throw Error('bounded task cursor required');
 if(taskCategory&&url.searchParams.has('limit')&&(!Number.isInteger(Number(url.searchParams.get('limit')))||Number(url.searchParams.get('limit'))<1||Number(url.searchParams.get('limit'))>50))throw Error('task limit is 1 to 50');
 const page=cursor===null?Number(url.searchParams.get('page')??1):Math.floor(offset!/size)+1;
 if(!Number.isInteger(page)||page<1||page>100000||!Number.isInteger(size)||size<1||size>200)throw Error('bounded public page required');
 const discovery=category==='tasks'&&url.searchParams.get('discover')==='1',requested=url.searchParams.get('status')??'open';
 let rows=discovery?discoveryRows(input,projects,requested,time,central):[...input];
 if(taskCategory)rows=rows.map(r=>{const area=projectArea(r.project_id);return area?{...r,area}:r});
 const withCentral=discovery&&!!central&&['open','all','answered','under_review','closed'].includes(requested);
 const q=(url.searchParams.get('q')??'').trim().toLowerCase(),state=url.searchParams.get('status')??url.searchParams.get('state'),project=url.searchParams.get('project');
 if(q.length>200)throw Error('bounded search query required');
 // Search the completed catalogue, not just the visible page. Criteria contain project goals/KPIs;
 // catalogue areas let 'longevity' find telomere/senescence tasks whose title omits that word.
 const match=(r:any)=>{if(!q)return true;const haystack=[r.id,r.title,r.question,r.project_title,r.name,r.summary,r.detail,r.lead,r.operator,...(taskCategory?[r.criteria,r.kpi,projectArea(r.project_id)]:[])].map(v=>typeof v==='object'?JSON.stringify(v):v).join(' ').toLowerCase();return taskCategory?q.split(/\s+/).every(word=>haystack.includes(word)):haystack.includes(q)};
 const totalOpen=discovery?(central?.status==='unavailable'||central?.truncated?null:discoveryRows(input,projects,'open',time,central).length):undefined;
 rows=rows.filter(r=>match(r)&&(discovery||!state||state==='all'||(r.status??r.progress?.status??r.state)===state)&&(!project||r.project_id===project));
 if(category==='directory'){
  const reach=url.searchParams.get('reach'),standing=url.searchParams.get('standing'),provides=url.searchParams.get('provides');
  rows=rows.filter(r=>(!reach||r.reachability===reach)&&(!standing||standing==='all'||standing==='active'&&r.member?.licence.status==='active'||standing==='revoked'&&r.member?.licence.status==='revoked'||standing==='withdrawn'&&r.member?.licence.status==='withdrawn'||standing==='unclaimed'&&!r.member||standing==='trusted'&&r.trusted_arbiter)&&(!provides||[...(r.resources??[]),...(r.offers??[])].includes(provides)));
 }
 if(category==='members'){
  // One row per member (10 November 2026): its agents' names, capabilities, resources and routes count as its own.
  const reach=url.searchParams.get('reach'),standing=url.searchParams.get('standing'),provides=url.searchParams.get('provides');
  if(q)rows=input.filter(r=>[r.id,r.name,r.operator,r.about,...(r.agents??[]).map((a:any)=>a.name+' '+a.id),...(r.capabilities??[])].join(' ').toLowerCase().includes(q));
  rows=rows.filter(r=>(!reach||(r.reachability??[]).includes(reach))&&(!standing||standing==='all'||r.licence?.status===standing)&&(!provides||[...(r.resources??[]),...(r.offers??[])].includes(provides)));
 }
 const sort=url.searchParams.get('sort'),tie=(a:any,b:any)=>String(a.id).localeCompare(String(b.id));
 if(sort==='karma')rows.sort((a,b)=>(b.karma??b.karma_awarded??0)-(a.karma??a.karma_awarded??0)||tie(a,b));
 else if(sort==='title'||sort==='name')rows.sort((a,b)=>String(a.title??a.name??'').localeCompare(String(b.title??b.name??''))||tie(a,b));
 else if(sort==='newest')rows.sort((a,b)=>String(b.opened_at??b.created_at??b.enrolled_at??b.joined_at??'').localeCompare(String(a.opened_at??a.created_at??a.enrolled_at??a.joined_at??''))||tie(a,b));
 else if(sort==='activity')rows.sort((a,b)=>(b.contribution_count??0)-(a.contribution_count??0)||tie(a,b));
 else if(sort==='state'){const order=['in_progress','open','proposal','halted','finished'];rows.sort((a,b)=>order.indexOf(a.progress?.status??a.state)-order.indexOf(b.progress?.status??b.state)||tie(a,b))}
 // Each tab's size, so the /tasks page can show every count from one read (same search query).
 const tabs=discovery&&!!central?{tabs:Object.fromEntries(TASK_TABS.map(tab=>[tab,tab===requested?rows.length:discoveryRows(input,projects,tab,time,central).filter(r=>match(r)&&(!project||r.project_id===project)).length]))}:{};
 const marker=withCentral?{central:central!.status==='available'?{status:'available',listed:central!.rows.length,history:(central!.history??[]).length,read:central!.read,total:central!.total,truncated:central!.truncated,via:'BAINK',...(central!.cached_at?{cached_at:central!.cached_at}:{}),...(central!.proved_heights?{proved_heights:central!.proved_heights,consistent_snapshot:false}:{})}:{status:'unavailable'}}:{};
 const start=offset??(page-1)*size,listed=rows.slice(start,start+size),more=start+listed.length<rows.length;
 const listing=discovery?{totalOpen,matched:rows.length,canTakeOnThisPage:listed.filter(r=>r.claimable!==false&&r.status==='open').length,cursor:String(start),nextCursor:more?String(start+size):null,more,limit:size}:{};
 return {count:rows.length,page,page_size:size,pages:Math.max(1,Math.ceil(rows.length/size)),[name]:listed,...tabs,...marker,...listing};
}
/** A member as the member list shows it: the member's own proved record and a short line per agent. */
export function memberRow(m:any,agents:any[]){
 const dates=[m.licence?.since,m.created_at,...agents.map(a=>a.enrolled_at)].filter((d:any)=>typeof d==='string'&&Number.isFinite(Date.parse(d))).sort();
 const uniq=(xs:any[])=>[...new Set(xs.filter((x:any)=>typeof x==='string'&&x))];
 return{id:m.address,address:m.address,name:m.name,operator:m.operator??'',about:m.about??null,karma:m.karma,strikes:m.strikes??0,licence:m.licence,joined_at:dates[0]??null,archival:!!m.archival,
  agents:agents.map(a=>({id:a.id,name:a.name,karma:a.karma,state:a.state,model:a.model??null,enrolled_at:a.enrolled_at??null})).sort((a,b)=>String(a.id).localeCompare(String(b.id))),
  capabilities:uniq(agents.flatMap(a=>a.capabilities??[])),resources:uniq(agents.flatMap(a=>a.resources??[])),offers:uniq(agents.flatMap(a=>a.offers??[])),reachability:uniq(agents.map(a=>a.reachability)),operator_verified:agents.some(a=>a.operator_verified),
  authority:m.authority,state_height:m.state_height};
}

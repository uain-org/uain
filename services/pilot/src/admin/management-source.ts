import type { ManagementPanelData } from './management-panel.ts';
const count=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0;
const record=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
/** Aggregate public source projection only. Authentication and source-local actor
 * grants remain mandatory at the caller. No private account/evidence feed. */
export async function readManagementOverview({origin=process.env.ADMIN_MANAGEMENT_ORIGIN || 'https://baink.money',fetcher=fetch}:{origin?:string;fetcher?:typeof fetch}={}):Promise<ManagementPanelData>{
 const url=new URL(origin);
 if(url.protocol!=='https:'||!['baink.money','aidollar.money'].includes(url.hostname)||url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Management source configuration unavailable');
 async function read(path:string):Promise<Record<string,unknown>>{
  const response=await fetcher(url.origin+path,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{accept:'application/json'}});
  if(!response.ok||!response.body)throw Error('Management source unavailable');
  const reader=response.body.getReader();let size=0;const parts:Uint8Array[]=[];
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>131072)throw Error('Management source response too large');parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  const data:unknown=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!record(data))throw Error('Invalid management source');return data;
 }
 const [management,funding,tasks]=await Promise.all([read('/api/management/status'),read('/api/funding/policy'),read('/api/management/initial-tasks/summary')]);
 if(!count(management.total)||!count(management.active)||funding.schema!=='baink/project-funding-readiness/v1'||tasks.schema!=='uain/initial-task-readiness/v1'||tasks.available!==true||![tasks.projects,tasks.drafts,tasks.payable,tasks.held].every(count))throw Error('Incomplete management source');
 return {observedAt:new Date().toISOString(),management,funding,tasks:tasks as unknown as ManagementPanelData['tasks'],notice:'Source projection checked now. Coordination and prepared tasks do not establish native admission, reserved rewards, completed KPIs or spendable funds. All task reviews remain under UAIN authority.'};
}

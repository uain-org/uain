/** Exact operator work holds, separate from native task state and monetary terms.
 * A hold prevents only preparation of NEW submission intents. Historical receipts,
 * signed intent submission and project membership remain governed by native rules. */
import {readFileSync} from 'node:fs';
const HASH=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const plain=x=>x&&Object.getPrototypeOf(x)===Object.prototype;
const exact=(x,keys)=>plain(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const need=x=>{if(!x)throw Error('Invalid central task hold policy');};
export function createCentralTaskAvailability({pins,policy=JSON.parse(readFileSync(new URL('./central-task-holds.json',import.meta.url),'utf8'))}={}){
 need(exact(policy,['schema','chainId','genesisSha256','holds'])&&policy.schema==='baink-central-task-holds-v1'&&typeof policy.chainId==='string'&&policy.chainId.length>0&&HASH.test(policy.genesisSha256)&&Array.isArray(policy.holds)&&policy.holds.length<=120);
 const rows=new Map();
 for(const raw of policy.holds){
  need(exact(raw,['taskId','projectId','criteriaDigest','evidenceDigest','reason','evidence'])&&ID.test(raw.taskId)&&ID.test(raw.projectId)&&HASH.test(raw.criteriaDigest)&&HASH.test(raw.evidenceDigest)&&raw.reason==='task_specification_unusable'&&Array.isArray(raw.evidence)&&raw.evidence.length>=1&&raw.evidence.length<=8&&raw.evidence.every(v=>typeof v==='string'&&v.length<=512&&/^https:\/\/api\.crossref\.org\/works\/[A-Za-z0-9%._;()/:+-]+$/.test(v))&&!rows.has(raw.taskId));
  rows.set(raw.taskId,structuredClone(raw));
 }
 const chainId=policy.chainId,epoch=policy.genesisSha256;
 return Object.freeze({forTask(task){
  if(pins?.chainId!==chainId||pins?.epoch!==epoch)return null;
  const row=rows.get(task?.id);
  if(!row||row.projectId!==task.project||row.criteriaDigest!==task.acceptance_digest||row.evidenceDigest!==task.evidence_digest||task.state!=='open'||task.pending||task.winner)return null;
  return{authority:'uain-operator',available:false,reason:row.reason,evidence:[...row.evidence]};
 }});
}

/** Public requests may accelerate derived SQL after a proved head advance.
 * This coordinator never signs commands or supplies authority to a read. */
import pg from 'pg';
import {nativeConfig} from '../api/native-routes.ts';
import {syncNativeProjection} from './projection.ts';
import {syncNativeJournals} from './journals.ts';
type Config=NonNullable<ReturnType<typeof nativeConfig>>;
export class NativePublicProjectionPending extends Error{}
export function createNativePublicCatchUpPool(connectionString:string,{connectionTimeoutMs=1000}={}){
 if(!Number.isInteger(connectionTimeoutMs)||connectionTimeoutMs<1||connectionTimeoutMs>1000)throw Error('bounded catch-up connection timeout required');
 return new pg.Pool({connectionString,max:1,connectionTimeoutMillis:connectionTimeoutMs,idleTimeoutMillis:1000,allowExitOnIdle:true,application_name:'uain-native-public-catch-up'});
}
/** Only callers overlapping the same ongoing proof share its result. A settled
 * head is removed immediately; this adds no head TTL or stale fallback. */
export function createNativePublicHeadReader<T>(read:(config:Config)=>Promise<T>){
 const pending=new Map<string,Promise<T>>();return(config:Config)=>{
  const key=JSON.stringify([config.binary,config.binaryHash,config.genesis,config.genesisHash,config.rpc]),prior=pending.get(key);if(prior)return prior;
  const next=Promise.resolve().then(()=>read(config)).finally(()=>{if(pending.get(key)===next)pending.delete(key)});pending.set(key,next);return next;
 };
}
export function nativeProjectionBehind(epoch:any,head:any,journals:any[]){
 if(!epoch||epoch.retired_at||epoch.chain_id!==head.chain_id)return false;
 const pairs=[[epoch.cursor,head.event_count],...['credit','karma'].map(kind=>[journals.find(row=>row.kind===kind)?.cursor??'0',String(head.records[kind+'_count']??0)])];
 if(pairs.some(pair=>pair.some(value=>typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value))||BigInt(pair[0])>BigInt(pair[1])))return false;
 return pairs.some(([cursor,count])=>BigInt(cursor)<BigInt(count));
}
export function createNativePublicCatchUp(pool:pg.Pool,{waitMs=1500,runMs=8000,cooldownMs=2000,now=Date.now,syncEvents=syncNativeProjection,syncJournals=syncNativeJournals}={}){
 if(!Number.isInteger(waitMs)||waitMs<1||waitMs>1500||!Number.isInteger(runMs)||runMs<1||runMs>8000||!Number.isInteger(cooldownMs)||cooldownMs<1)throw Error('bounded public catch-up timing required');
 let pending:Promise<boolean>|null=null,lastStarted=-Infinity,lastEpoch='',active:AbortController|null=null,closed=false,closing:Promise<void>|null=null;
 return{async catchUp(config:Config):Promise<boolean>{
  if(closed)return false;
  if(!pending&&(lastEpoch!==config.genesisHash||now()-lastStarted>=cooldownMs)){
   lastStarted=now();lastEpoch=config.genesisHash;
   const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(Error('native public catch-up deadline expired')),runMs);active=controller;
   const run=(async()=>{try{
    const events=await syncEvents(pool,config,32,{nonblocking:true,signal:controller.signal});if(events.busy||events.deferred)return false;controller.signal.throwIfAborted();
    const journals=await syncJournals(pool,config,32,{nonblocking:true,signal:controller.signal});return!journals.busy&&!events.more&&!journals.more;
   }catch{return false}finally{clearTimeout(deadline);if(active===controller)active=null}})();
   pending=run.finally(()=>{pending=null});
  }
  if(!pending)return false;
  let timer:ReturnType<typeof setTimeout>;
  try{return await Promise.race([pending,new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),waitMs)})])}finally{clearTimeout(timer!)}
 },close():Promise<void>{
  if(!closing){closed=true;active?.abort(Error('native public catch-up shutting down'));closing=(async()=>{try{await pending}finally{await pool.end()}})()}
  return closing;
 }};
}

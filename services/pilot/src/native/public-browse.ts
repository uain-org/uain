/** Browse views for public pages (10 November 2026). A list, the stats and a project page are
 * answered from the last proved result of this replica instead of a read that must finish inside
 * one native event window. Every record is still a native proof on the pinned chain; what is no
 * longer required is that all of a page's proofs share one height. Each answer says how old it is
 * (`proved`), and nothing older than BROWSE_MAX_AGE_MS is ever served. Reads that a write or a
 * payment decision depends on (single tasks, contributions, members, balances, /api/native/public/…)
 * keep the strict head-bound path. Design and measurements:
 * docs/testing/public-read-speed-2026-11-10.md. */

/** A view is replaced at most this often, and only when the chain moved. */
export const BROWSE_VIEW_MS=60000;
/** Never serve a page whose view opened longer ago than this. */
export const BROWSE_MAX_AGE_MS=300000;
/** A request with no usable page waits this long for one, then gets a retry-after (gateway: 30 s). */
export const BROWSE_COLD_WAIT_MS=20000;
export const BROWSE_RETRY_AFTER_S=5;

/** No proved page could be produced in time; the build goes on and a retry will find it. */
export class NativePublicReadWarming extends Error{
 constructor(readonly retryAfter=BROWSE_RETRY_AFTER_S){super('native public page is being proved; retry shortly')}
}

type State={chain_id:string;height:string;event_count:string;app_hash?:string;header_time?:string;records:Record<string,any>;[key:string]:any};
type Prove=(selection:{keys:string[]})=>Promise<State>;
const COUNT=/^(0|[1-9][0-9]{0,19})$/;

/** Proves the records of one view. Each batch is a complete native proof at its own height: it
 * must name the view's chain and must not be behind the event count the view opened at. An event
 * landing between batches no longer discards the batches already proved. Concurrent pages share
 * each proof. `consistent` stays true only while every batch was proved at the opening event count. */
export function createOwnHeightProver(head:State,prove:Prove,{maxKeys=20000}:{maxKeys?:number}={}){
 if(!head||typeof head.chain_id!=='string'||!head.chain_id||!COUNT.test(head.height??'')||!COUNT.test(head.event_count??''))throw Error('proved browse view head required');
 if(!Number.isInteger(maxKeys)||maxKeys<1||maxKeys>20000)throw Error('bounded browse view proofs required');
 const values=new Map<string,any>(),pending=new Map<string,Promise<void>>(),floor=BigInt(head.event_count);
 let from=BigInt(head.height),to=from,latest:State=head,batches=0,consistent=true,full=false;
 const read=async({keys}:{keys:string[]}):Promise<State>=>{
  if(!Array.isArray(keys)||keys.length>32||keys.some(k=>typeof k!=='string'||k.length>1024))throw Error('bounded native public proof selection required');
  const unique=[...new Set(keys)];
  const waiting=[...new Set(unique.map(k=>pending.get(k)).filter(Boolean))];if(waiting.length)await Promise.all(waiting);
  const missing=unique.filter(k=>!values.has(k));
  if(missing.length){
   if(values.size+missing.length>maxKeys){full=true;throw Error('browse view proof bound reached')}
   const task=(async()=>{
    const state=await prove({keys:missing});
    if(state?.chain_id!==head.chain_id||!COUNT.test(state.height??'')||!COUNT.test(state.event_count??'')||!state.records||missing.some(k=>!Object.hasOwn(state.records,k)))throw Error('native public browse proof differs');
    if(BigInt(state.event_count)<floor)throw Error('native public browse proof behind its view');
    const height=BigInt(state.height);if(height<from)from=height;if(height>to){to=height;latest=state}
    if(state.event_count!==head.event_count)consistent=false;batches++;
    for(const k of missing)values.set(k,state.records[k]);
   })();
   for(const k of missing)pending.set(k,task);
   try{await task}finally{for(const k of missing)if(pending.get(k)===task)pending.delete(k)}
  }
  for(const k of unique)if(!values.has(k))throw Error('native public browse proof absent');
  return{...latest,chain_id:head.chain_id,records:Object.fromEntries(unique.map(k=>[k,values.get(k)]))};
 };
 return{read,stats:()=>({from:String(from),to:String(to),batches,keys:values.size,consistent,full})};
}

/** Shared by a view and every page built from it: confirming the view current re-dates them all. */
export type BrowseStamp={id:number;asOf:number;headerTime:string};
/** The chain's time now, estimated from the view's proved block time plus the time since: discovery
 * deadlines are judged against it, as the strict path judges them against a fresh head. */
export function browseChainTime(stamp:BrowseStamp,now:number){const at=Date.parse(stamp.headerTime);return new Date((Number.isFinite(at)?at:now)+Math.max(0,now-stamp.asOf)).toISOString()}
export type BrowsePage={result:any;stamp:BrowseStamp;builtAt:number;from:string;to:string;consistent:boolean;bytes:number};

/** Last proved page per key, bounded by entries and bytes; the oldest is evicted first. Pages past
 * BROWSE_MAX_AGE_MS (counted from the view's `asOf`) are dropped, never served. */
export function createBrowsePageCache({maxEntries=1024,maxBytes=64*1024*1024,maxAgeMs=BROWSE_MAX_AGE_MS,now=Date.now}:{maxEntries?:number;maxBytes?:number;maxAgeMs?:number;now?:()=>number}={}){
 if(!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>1024||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>64*1024*1024||!Number.isInteger(maxAgeMs)||maxAgeMs<1||maxAgeMs>BROWSE_MAX_AGE_MS)throw Error('bounded browse page cache required');
 const pages=new Map<string,BrowsePage>();let bytes=0;
 const remove=(key:string)=>{const page=pages.get(key);if(page){bytes-=page.bytes;pages.delete(key)}};
 return{
  get(key:string){const page=pages.get(key);if(!page)return null;const age=now()-page.stamp.asOf;if(age>maxAgeMs||age<-60000){remove(key);return null}return page},
  put(key:string,page:Omit<BrowsePage,'bytes'>){remove(key);const size=Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(page.result));if(size>maxBytes)return false;while(pages.size&&(pages.size>=maxEntries||bytes+size>maxBytes))remove(pages.keys().next().value!);pages.set(key,{...page,bytes:size});bytes+=size;return true},
  size:()=>({entries:pages.size,bytes,maxEntries,maxBytes}),
 };
}

/** The plain-words age block every browse answer carries. */
export function browseProvedBlock(page:BrowsePage,now:number,refreshing:boolean,strictPath:string){
 const age=Math.max(0,Math.round((now-page.stamp.asOf)/1000)),consistent=page.consistent;
 return{as_of:new Date(page.stamp.asOf).toISOString(),age_seconds:age,heights:{from:page.from,to:page.to},consistent_snapshot:consistent,refreshing,strict_read:strictPath,
  note:`Every row was proved on the chain. This page shows the chain as it was ${age} second${age===1?'':'s'} ago${consistent?'':', put together from proofs made at slightly different heights'}${refreshing?'; a newer copy is being prepared':''}.`};
}

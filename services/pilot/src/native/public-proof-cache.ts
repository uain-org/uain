/** Reuse independently proved public records across filters and detail pages.
 * A fresh verified checkpoint selects the generation. Command/receipt reads
 * never use this cache. Counts include every public state-changing event and
 * both reward journals, matching the public response cache's existing fence. */
type State = {chain_id:string;event_count:string;records:Record<string,any>;[key:string]:any};
type Read = (selection:{keys:string[]})=>Promise<State>;
export function createNativePublicProofCache({maxKeys=20000,maxBytes=64*1024*1024}={}) {
 let generation='';
 let current:{values:Map<string,{value:any;bytes:number}>;pending:Map<string,Promise<void>>;bytes:number} = {values:new Map(),pending:new Map(),bytes:0};
 return {reader(epoch:string,head:State,prove:Read):Read {
  const key=JSON.stringify([epoch,head.chain_id,head.event_count,String(head.records.credit_count??0),String(head.records.karma_count??0)]);
  if(key!==generation){generation=key;current={values:new Map(),pending:new Map(),bytes:0}}
  const cache=current;
  return async({keys})=>{
   if(!Array.isArray(keys)||keys.length>32||keys.some(k=>typeof k!=='string'||k.length>1024))throw Error('bounded native public proof selection required');
   const unique=[...new Set(keys)],local=new Map<string,any>();
   for(const k of unique){const hit=cache.values.get(k);if(hit)local.set(k,hit.value)}
   const waiting=[...new Set(unique.map(k=>cache.pending.get(k)).filter(Boolean))];
   if(waiting.length)await Promise.all(waiting);
   for(const k of unique){const hit=cache.values.get(k);if(hit)local.set(k,hit.value)}
   const missing=unique.filter(k=>!local.has(k));
   if(missing.length){
    const task=(async()=>{
     const state=await prove({keys:missing});
     if(state.chain_id!==head.chain_id||state.event_count!==head.event_count||!state.records||missing.some(k=>!Object.hasOwn(state.records,k)))throw Error('native public proof checkpoint changed');
     for(const k of missing){
      const value=structuredClone(state.records[k]),bytes=Buffer.byteLength(k)+Buffer.byteLength(JSON.stringify(value));local.set(k,value);
      if(bytes>maxBytes)continue;
      while(cache.values.size&&(cache.values.size>=maxKeys||cache.bytes+bytes>maxBytes)){const oldest=cache.values.keys().next().value!;cache.bytes-=cache.values.get(oldest)!.bytes;cache.values.delete(oldest)}
      if(maxKeys>0){cache.values.set(k,{value,bytes});cache.bytes+=bytes}
     }
    })();
    for(const k of missing)cache.pending.set(k,task);
    try{await task}finally{for(const k of missing)if(cache.pending.get(k)===task)cache.pending.delete(k)}
   }
   // An oversized/evicted concurrent value is safely re-proved, never treated
   // as authenticated absence. Normal retained records share the same process.
   for(const k of unique)if(!local.has(k)){const hit=cache.values.get(k);if(hit)local.set(k,hit.value)}
   return {...head,records:Object.fromEntries(unique.map(k=>[k,structuredClone(local.get(k))]))};
  };
 }};
}

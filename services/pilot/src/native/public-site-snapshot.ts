/** Dated website presentation only; never an authority for commands or funds. Up to 1,024 pages
 * (10 November 2026: six core pages plus four per project passed 256 as the stock grew). */
export function createNativePublicSiteSnapshots({maxEntries=1024,maxBytes=32*1024*1024,maxAgeMs=120000,now=Date.now}={}){
 if(!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>1024||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024||!Number.isInteger(maxAgeMs)||maxAgeMs<1||maxAgeMs>120000)throw Error('bounded website snapshot retention required');
 const values=new Map<string,{value:any;generation:string;bytes:number;verifiedAt:number}>();let bytes=0;
 const remove=(key:string)=>{const entry=values.get(key);if(entry){bytes-=entry.bytes;values.delete(key)}};
 const prune=()=>{for(const [key,entry]of values)if(now()-entry.verifiedAt>=maxAgeMs||now()<entry.verifiedAt)remove(key)};
 return{/** `verifiedAt` (default now) is when the value's proofs were known current; a browse page passes
  * its view's opening time, so the website never sees a page as newer than its proofs. */
 put(key:string,value:any,generation:string,verifiedAt=now()){prune();remove(key);if(!Number.isFinite(verifiedAt)||verifiedAt>now()||now()-verifiedAt>=maxAgeMs)return;const size=Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(value));if(size>maxBytes)return;while(values.size&&(values.size>=maxEntries||bytes+size>maxBytes))remove(values.keys().next().value!);values.set(key,{value:structuredClone(value),generation,bytes:size,verifiedAt});bytes+=size},
 hasAll(keys:string[]){prune();return keys.every(key=>values.has(key))},
 /** What is held against the bounds, for the log. */
 size(){prune();return{entries:values.size,bytes,maxEntries,maxBytes}},
 get(key:string){prune();const entry=values.get(key);return entry?{value:structuredClone(entry.value),verifiedAt:entry.verifiedAt}:null},
 /** A completed background warm re-proved the identical full checkpoint. */
 renew(generation:string,at=now()){prune();if(!Number.isFinite(at)||at>now())return 0;let retained=0;for(const entry of values.values())if(entry.generation===generation&&at>entry.verifiedAt){entry.verifiedAt=at;retained++}else if(entry.generation===generation)retained++;return retained}};
}

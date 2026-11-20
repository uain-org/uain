/** Run `fn` over `items` with at most `limit` calls in flight, results in input order
 * (21 November 2026). Public pages resolved hundreds of records one after another, each a
 * proof round trip; a few at a time cuts the wait without flooding the node. A rejection
 * rejects the whole call, as the sequential loops did. */
export const PUBLIC_READ_CONCURRENCY=8;
export async function mapLimit<T,R>(items:readonly T[],fn:(item:T,index:number)=>Promise<R>,limit=PUBLIC_READ_CONCURRENCY):Promise<R[]>{
 if(!Number.isInteger(limit)||limit<1)throw Error('bounded concurrency required');
 const out=new Array<R>(items.length);let next=0;
 const worker=async()=>{while(next<items.length){const i=next++;out[i]=await fn(items[i],i)}};
 await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
 return out;
}

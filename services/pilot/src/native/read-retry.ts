/** Retry one proved read when the chain moved during it, or the projection was still catching up.
 * Each attempt is a complete, freshly proved read at its own height; nothing is loosened. The pilot's
 * warm-up uses it so a busy chain no longer restarts the whole warm-up on every new event (9 November
 * 2026: new replicas stayed unready for 20+ minutes while the task-stock starter signed every few
 * seconds). Every other error is thrown at once. */
import{NativePublicProjectionPending}from'./public-catch-up.ts';
export const WARM_READ_ATTEMPTS=8;
export const retryableRead=(error:any)=>error instanceof NativePublicProjectionPending||/(during read; retry|native public proof checkpoint changed)$/.test(String(error?.message??''));
export async function readWithRetry<T>(read:()=>Promise<T>,{attempts=WARM_READ_ATTEMPTS,pause=(n:number)=>new Promise(r=>setTimeout(r,Math.min(2000,150*n)))}:{attempts?:number;pause?:(n:number)=>Promise<unknown>}={}):Promise<T>{
 for(let n=1;;n++){try{return await read()}catch(error){if(n>=attempts||!retryableRead(error))throw error;await pause(n)}}
}

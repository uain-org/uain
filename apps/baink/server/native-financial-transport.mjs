import {createHash} from 'node:crypto';
import {verifyNativeFinancialEnvelope} from './native-financial-command.mjs';
const ensure=(ok,message)=>{if(!ok)throw Error(message);};
/** Private payments never silently fall back to the public earning RPC. */
export function createFinancialTransport({config,paymentBroadcaster=null}){
 const encode=(envelope,operations)=>{ensure(config,'Independent native transport unavailable');verifyNativeFinancialEnvelope(envelope,{chainId:config.chainId,operations});const bytes=Buffer.from(JSON.stringify(envelope));ensure(bytes.length<=32768,'Native financial envelope exceeds bound');return {bytes,transactionHash:createHash('sha256').update(bytes).digest('hex').toUpperCase()};};
 const normalize=(value,transactionHash)=>{ensure(!value.error&&Number.isInteger(value.result?.code)&&value.result.code>=0&&typeof value.result.hash==='string'&&value.result.hash.toUpperCase()===transactionHash,'Native financial submission result differs');return {accepted:value.result.code===0,code:value.result.code,transactionHash,finalized:false};};
 return Object.freeze({
  paymentBroadcastConfigured:typeof paymentBroadcaster==='function',
  async broadcastEarning(envelope,{timeoutMs=3000}={}){
   const {bytes,transactionHash}=encode(envelope,['coin_quote','coin_reserve','coin_claim']);ensure(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=10000,'Bounded native timeout required');
   const response=await fetch(config.rpc,{method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',body:JSON.stringify({jsonrpc:'2.0',id:'baink-native-earning',method:'broadcast_tx_sync',params:{tx:bytes.toString('base64')}}),signal:AbortSignal.timeout(timeoutMs)});ensure(response.ok&&response.body,'Native earning RPC unavailable');const stream=response.body.getReader(),parts=[];let length=0;try{for(;;){const {done,value}=await stream.read();if(done)break;length+=value.length;ensure(length<=65536,'Native financial response exceeds bound');parts.push(Buffer.from(value));}}finally{await stream.cancel().catch(()=>{});}return normalize(JSON.parse(Buffer.concat(parts).toString('utf8')),transactionHash);
  },
  async broadcastPayment(envelope,{timeoutMs=3000}={}){
   ensure(typeof paymentBroadcaster==='function','Use the qualified holder wallet and onion transport for private submission');const {bytes,transactionHash}=encode(envelope,['private_payment']);ensure(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=10000,'Bounded native timeout required');
   // The injected qualified transport receives public signed bytes only.
   const result=await paymentBroadcaster({envelope:structuredClone(envelope),bytes,transactionHash,timeoutMs});return normalize(result,transactionHash);
  },
 });
}

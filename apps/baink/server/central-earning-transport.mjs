import {createHash} from 'node:crypto';
import {verifyCentralEnvelope} from './central-earning-command.mjs';
const check=ok=>{if(!ok)throw Error('Central native submission unavailable or response differs');};
// The member operations BAINK may prepare (central-earning.mjs MEMBER_OPS). The S6 reassessment and
// expiry were missing until 10 November 2026, so a prepared one never reached the chain.
export const MEMBER_OPERATIONS=Object.freeze(['central_submit','project_join','central_reassess','central_evidence_expire']);
/** Public holder-signed contributions only; never activates policy or pays awards. */
export function createCentralTransport({config}){
 return Object.freeze({async broadcastCentral(envelope,{timeoutMs=3000}={}){
  check(config&&Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=10000);
  verifyCentralEnvelope(envelope,{chainId:config.chainId,operations:MEMBER_OPERATIONS});
  const bytes=Buffer.from(JSON.stringify(envelope));check(bytes.length<=65536);
  const transactionHash=createHash('sha256').update(bytes).digest('hex').toUpperCase();
  const response=await fetch(config.rpc,{method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',body:JSON.stringify({jsonrpc:'2.0',id:'baink-central-earning',method:'broadcast_tx_sync',params:{tx:bytes.toString('base64')}}),signal:AbortSignal.timeout(timeoutMs)});
  check(response.ok&&response.body);const reader=response.body.getReader(),parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;check(size<=65536);parts.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
  const result=JSON.parse(Buffer.concat(parts).toString('utf8'));check(!result.error&&Number.isInteger(result.result?.code)&&result.result.code>=0&&typeof result.result.hash==='string'&&result.result.hash.toUpperCase()===transactionHash);
  return {accepted:result.result.code===0,code:result.result.code,transactionHash,finalized:false};
 }});
}

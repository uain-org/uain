// Private IPC-only proof worker. It accepts public identity metadata and a
// holder-local Orchard file path, never an Ed25519 private key or a broadcast.
import { randomUUID } from 'node:crypto';
import { createExternalHolder } from './external-signing.mjs';
const pending=new Map();let started=false;
function request(kind,value){return new Promise((resolve,reject)=>{const id=randomUUID();pending.set(id,{resolve,reject});process.send({type:'request',id,kind,value});});}
process.on('message',async message=>{
 if(message?.type==='response'){const callback=pending.get(message.id);if(!callback)return;pending.delete(message.id);message.error?callback.reject(new Error('Private courier response refused')):callback.resolve(message.value);return;}
 if(message?.type!=='start'||started)return;started=true;
 try{
  const adapter=createExternalHolder({identity:message.intent.owner,reader:message.reader,tools:message.tools,pins:message.pins,sign:value=>request('signature',value)});
  const result=await adapter.produce(message.intent,{spendingKeyFile:message.spendingKeyFile,source:message.source,timeoutMs:message.timeoutMs,recipientConsent:value=>request('recipientConsent',value),certificate:value=>request('certificate',value),review:value=>request('review',value)});
  process.send({type:'result',result},()=>process.disconnect());
 }catch{process.send({type:'error'},()=>process.disconnect());}
});
process.on('disconnect',()=>{for(const item of pending.values())item.reject(new Error('Private courier disconnected'));pending.clear();});

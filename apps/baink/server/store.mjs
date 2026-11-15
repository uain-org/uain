import {AsyncLocalStorage} from 'node:async_hooks';
import {isProxy} from 'node:util/types';

export class StorageError extends Error {
 constructor(code){super(code==='storage_busy'?'Storage queue is busy; retain the original intent.':code==='storage_closed'?'Storage is closed.':'Storage is unavailable until restart.');this.status=503;this.code=code;}
}
function freezeTree(value,seen=new WeakSet()) {if(value&&typeof value==='object'&&!seen.has(value)){seen.add(value);for(const child of Object.values(value))freezeTree(child,seen);Object.freeze(value);}return value;}
// Only immutable, already-validated primitive maps may use the cheap draft copy.
// This WeakSet is private: generic commits clone their maps and cannot inherit it.
const frozenNonceMaps=new WeakSet();
function copyNonceMap(value){
 if(!value||typeof value!=='object'||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)throw new TypeError('Invalid nonce transaction state');
 for(const key of Reflect.ownKeys(value)){
  const field=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||!field||!field.enumerable||!('value'in field)||!Number.isSafeInteger(field.value)||field.value<=0)throw new TypeError('Invalid nonce transaction value');
 }
 // Non-Proxy data-only maps cannot run hooks between validation and this
 // synchronous native copy. Object spread uses CreateDataProperty, including
 // for __proto__; unlike Object.assign it never invokes inherited setters.
 return{...value};
}
function nonceDraft(base){
 if(!base.accounts||!base.nonces||Object.getPrototypeOf(base.accounts)!==Object.prototype)throw new TypeError('Invalid nonce transaction state');
 let nonces;
 if(frozenNonceMaps.has(base.nonces))nonces={...base.nonces};
 else{nonces=copyNonceMap(base.nonces);Object.freeze(base.nonces);frozenNonceMaps.add(base.nonces);}
 return Object.freeze({accounts:freezeTree(structuredClone(base.accounts)),nonces});
}
function nonceSnapshot(draft,base){
 const nonces=copyNonceMap(draft.nonces);Object.freeze(nonces);frozenNonceMaps.add(nonces);
 return{...base,nonces};
}
const plainFrozen=new WeakSet();
function freezePlainTree(value){
 if(value&&typeof value==='object'&&!plainFrozen.has(value)){
  const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==Array.prototype)throw new TypeError('Append records must contain plain objects and arrays');
  for(const key of Reflect.ownKeys(value)){const field=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!('value'in field))throw new TypeError('Append records must contain plain data fields');freezePlainTree(field.value);}
  Object.freeze(value);plainFrozen.add(value);
 }
 return value;
}
// Request creation is append-only: existing records are frozen and never copied
// into mutable callbacks. Newly introduced records are cloned again at commit.
function requestDraft(base){
 freezePlainTree(base.requests);freezePlainTree(base.history);
 const draft={requests:{...base.requests},history:[...base.history]};
 Object.defineProperty(draft,'accounts',{value:freezeTree(structuredClone(base.accounts)),enumerable:true});
 return Object.seal(draft);
}
function requestSnapshot(draft,base){
 if(Object.getPrototypeOf(draft.requests)!==Object.prototype||!Array.isArray(draft.history)||draft.history.length<base.history.length)throw new TypeError('Request creation must append records');
 const oldKeys=Reflect.ownKeys(base.requests),keys=Reflect.ownKeys(draft.requests);
 if(keys.length<oldKeys.length||oldKeys.some(k=>!Object.hasOwn(draft.requests,k)||draft.requests[k]!==base.requests[k])||base.history.some((v,i)=>draft.history[i]!==v))throw new TypeError('Request creation must preserve existing records');
 const requests={...base.requests};
 for(const key of keys){const f=Object.getOwnPropertyDescriptor(draft.requests,key);if(typeof key!=='string'||!f?.enumerable||!('value'in f))throw new TypeError('Invalid request creation field');if(!Object.hasOwn(base.requests,key))Object.defineProperty(requests,key,{value:freezePlainTree(structuredClone(f.value)),enumerable:true,writable:true,configurable:true});}
 const history=[...base.history,...freezePlainTree(structuredClone(draft.history.slice(base.history.length)))];
 Object.freeze(requests);plainFrozen.add(requests);Object.freeze(history);plainFrozen.add(history);
 return{...base,requests,history};
}
// Copy-on-access view of a committed state (10 November 2026). A top-level
// section is cloned the first time a caller reads, describes or replaces it,
// so a transaction or read that touches two sections no longer copies the
// whole store. The caller never receives a committed reference: untouched
// sections are only shared again by the committed snapshot built here, and
// that snapshot is never handed out. Described sections are real data
// properties, so plain-data checks on the root still pass.
export function lazyState(base){
 const target={},deleted=new Set();
 const fromBase=key=>typeof key==='string'&&Object.hasOwn(base,key)&&!deleted.has(key);
 const materialize=key=>{if(fromBase(key)&&!Object.hasOwn(target,key))target[key]=structuredClone(base[key]);};
 const keys=()=>{const out=Object.keys(base).filter(k=>!deleted.has(k));for(const k of Reflect.ownKeys(target))if(!out.includes(k))out.push(k);return out;};
 const view=new Proxy(target,{
  get(t,key,receiver){materialize(key);return Reflect.get(t,key,receiver);},
  getOwnPropertyDescriptor(t,key){materialize(key);return Reflect.getOwnPropertyDescriptor(t,key);},
  has(t,key){return fromBase(key)||Reflect.has(t,key);},
  ownKeys:()=>keys(),
  set(t,key,value){return Reflect.set(t,key,value);},
  defineProperty(t,key,descriptor){materialize(key);return Reflect.defineProperty(t,key,descriptor);},
  deleteProperty(t,key){if(typeof key==='string'&&Object.hasOwn(base,key))deleted.add(key);return Reflect.deleteProperty(t,key);},
 });
 // The next committed state: touched sections are cloned once more (callbacks
 // may retain aliases), untouched sections keep the committed reference.
 function snapshot(){
  const next={},touched=new Set(deleted);
  for(const key of keys()){if(Object.hasOwn(target,key)){next[key]=structuredClone(target[key]);touched.add(key);}else next[key]=base[key];}
  return{next,touched};
 }
 return{view,snapshot};
}
// A callback may return its draft root (or a plain structure holding it); the
// caller receives the detached committed copy, as with the earlier full clone.
function detachView(value,view,next,depth=0){
 if(value===view)return next;
 if(depth>32||!value||typeof value!=='object')return value;
 const proto=Object.getPrototypeOf(value);
 if(Array.isArray(value))return value.map(v=>detachView(v,view,next,depth+1));
 if(proto!==Object.prototype&&proto!==null)return value;
 const out={};for(const key of Object.keys(value))out[key]=detachView(value[key],view,next,depth+1);return out;
}
function messageDraft(base){const draft={peerMessages:structuredClone(base.peerMessages)};Object.defineProperty(draft,'accounts',{value:freezeTree(structuredClone(base.accounts)),enumerable:true});return Object.seal(draft);}
function messageSnapshot(draft,base){return{...base,peerMessages:structuredClone(draft.peerMessages)};}
/** Ordered, bounded group commit. persist must finish file+directory fsync before
 * resolving. Callbacks may await bounded reads, but cannot publish side effects.
 * Neither tentative state nor acknowledgements escape the persistence barrier. */
export function createGroupCommitStore({initialState,persist,validate,maxBatch=32,maxQueued=128,initialStateOwned=false}){
 if(typeof persist!=='function'||typeof validate!=='function'||!Number.isInteger(maxBatch)||maxBatch<1||maxBatch>32||!Number.isInteger(maxQueued)||maxQueued<1||maxQueued>128)throw new TypeError('Invalid bounded durable store configuration');
 // initialStateOwned: the caller hands over a freshly loaded state it no longer references.
 let committed=initialStateOwned?initialState:structuredClone(initialState),queue=[],running=false,scheduled=false,closing=false,poisoned=false;
 const context=new AsyncLocalStorage(),idle=[];
 function notifyIdle(){if(!running&&!scheduled&&!queue.length)while(idle.length)idle.shift()();}
 function schedule(){if(running||scheduled)return;scheduled=true;setImmediate(()=>{scheduled=false;void drain();});}
 async function drain(){
  running=true;
  try{
   while(queue.length&&!poisoned){
    const batch=queue.splice(0,maxBatch),accepted=[];let nextCommitted=committed;
    for(const item of batch){
     const token={active:true};
     try{
      const base=nextCommitted,lazy=item.kind==='generic'?lazyState(base):null,draft=item.kind==='nonce'?nonceDraft(base):item.kind==='request'?requestDraft(base):item.kind==='message'?messageDraft(base):lazy.view;
      let value;try{value=await context.run(token,()=>item.operation(draft));}finally{token.active=false;}
      let next,touched;if(lazy)({next,touched}=lazy.snapshot());else next=item.kind==='nonce'?nonceSnapshot(draft,base):item.kind==='request'?requestSnapshot(draft,base):messageSnapshot(draft,base);
      await validate(next,item.kind==='nonce'?Object.freeze({nonceOnly:true,base}):item.kind==='request'?Object.freeze({requestAppend:true,base}):item.kind==='message'?Object.freeze({messageOnly:true,base}):Object.freeze({generic:true,base,touched}));
      const result=structuredClone(lazy?detachView(value,lazy.view,next):value); // Reject unsupported results BEFORE persisting.
      nextCommitted=next;accepted.push({...item,result});
     }catch(error){item.reject(error);}
    }
    if(!accepted.length)continue;
    try{await persist(nextCommitted);}catch(error){
     // Rename may have happened before a failing directory fsync. No further
     // mutation may overwrite that uncertain disk state from stale memory.
     poisoned=true;for(const item of accepted)item.reject(error);
     for(const item of queue.splice(0))item.reject(new StorageError('storage_unavailable'));
     break;
    }
    committed=nextCommitted;
    for(const item of accepted)item.resolve(item.result);
   }
  }finally{running=false;notifyIdle();}
 }
 function enqueue(operation,kind){
   if(context.getStore()?.active)return Promise.reject(new Error('A reentrant storage transaction is not supported.'));
   if(closing)return Promise.reject(new StorageError('storage_closed'));
   if(poisoned)return Promise.reject(new StorageError('storage_unavailable'));
   if(typeof operation!=='function')return Promise.reject(new TypeError('A transaction callback is required.'));
   if(queue.length>=maxQueued)return Promise.reject(new StorageError('storage_busy'));
   return new Promise((resolve,reject)=>{queue.push({operation,resolve,reject,kind});schedule();});
 }
 return{
  transact:operation=>enqueue(operation,'generic'),
  // Only anti-replay auth may use this path: no business references are exposed.
  transactNonces:operation=>enqueue(operation,'nonce'),
  transactRequestCreate:operation=>enqueue(operation,'request'),
  transactMessages:operation=>enqueue(operation,'message'),
  // Each read gets its own copy-on-access view: only the sections it uses are cloned.
  read:()=>lazyState(committed).view,
  has:(section,key)=>Object.hasOwn(committed,section)&&committed[section]!==null&&typeof committed[section]==='object'&&Object.hasOwn(committed[section],key),
  get:(section,key)=>Object.hasOwn(committed,section)&&committed[section]!==null&&typeof committed[section]==='object'&&Object.hasOwn(committed[section],key)?structuredClone(committed[section][key]):undefined,
  async close(){closing=true;if(running||scheduled||queue.length)await new Promise(resolve=>idle.push(resolve));},
 };
}

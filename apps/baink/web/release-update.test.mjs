import test from 'node:test';
import assert from 'node:assert/strict';
import { entryScripts, createReleaseWatcher, isChunkFailure, startWrite, writeActivity, setReleaseBusy, reloadBlocked, RELEASE_CHECK, RELEASE_POLL_MS } from './release-update.js';
const html = (id,base='/') => `<html><script type="module" crossorigin src="${base}assets/index-${id}.js"></script></html>`;
function setup(fetch, base='/') {
  const win = new EventTarget(); win.location = {origin:'https://baink.example'};
  const doc = new EventTarget(); doc.visibilityState='visible'; doc.querySelectorAll=()=>[{src:`https://baink.example${base}assets/index-old.js`}];
  const updates=[];let now=0;
  const watcher=createReleaseWatcher({window:win,document:doc,base,fetch,onUpdate:u=>updates.push(u),now:()=>now});
  return {win,doc,updates,watcher,tick:()=>now+=30001};
}
test('extracts only same-origin module assets and supports preview base',()=>{
 assert.deepEqual(entryScripts(html('new','/baink/'),'https://baink.example/baink/'),['https://baink.example/baink/assets/index-new.js']);
 assert.deepEqual(entryScripts('<script type="module" src="https://evil.example/assets/new.js"></script>','https://baink.example/'),[]);
});
test('different entry verified by uncached public HTML read, no API/signing',async()=>{
 let args;
 const s=setup(async(...a)=>{args=a;return new Response(html('new'),{headers:{'Content-Type':'text/html'}})});
 await s.watcher.check();assert.deepEqual(s.updates,[{changed:true,chunkFailed:false}]);assert.equal(args[0],'https://baink.example/');assert.equal(args[1].cache,'no-store');assert.equal(args[1].credentials,'omit');s.watcher.stop();
});
test('same build, network failure, redirected/malformed/error page do not claim update',async()=>{
 for(const response of [()=>new Response(html('old'),{headers:{'Content-Type':'text/html'}}),()=>{throw Error('offline')},()=>new Response(html('new'),{status:503,headers:{'Content-Type':'text/html'}}),()=>new Response(html('new'),{headers:{'Content-Type':'application/json'}}),()=>new Response('<html>maintenance</html>',{headers:{'Content-Type':'text/html'}})]){
  const s=setup(response);await s.watcher.check();assert.equal(s.updates.length,0);s.watcher.stop();
 }
});
test('event checks deduplicate and throttle, hidden tabs ignored, stop fences response',async()=>{
 let count=0,resolve;const s=setup(()=>{count++;return new Promise(r=>resolve=r)});
 const p=s.watcher.check();s.win.dispatchEvent(new Event('focus'));assert.equal(count,1);
 s.watcher.stop();resolve(new Response(html('new'),{headers:{'Content-Type':'text/html'}}));await p;assert.equal(s.updates.length,0);
 let reads=0;const t=setup(async()=>{reads++;return new Response(html('old'),{headers:{'Content-Type':'text/html'}})});await t.watcher.check();await t.watcher.check();assert.equal(reads,1);t.tick();t.doc.visibilityState='hidden';t.win.dispatchEvent(new Event(RELEASE_CHECK));assert.equal(reads,1);t.watcher.stop();
});
test('chunk event surfaces honest load failure, never reloads, then verifies changed build',async()=>{
 const s=setup(async()=>new Response(html('new'),{headers:{'Content-Type':'text/html'}}));s.win.dispatchEvent(new Event('vite:preloadError'));await s.watcher.check();await new Promise(r=>setImmediate(r));assert.deepEqual(s.updates,[{changed:false,chunkFailed:true},{changed:true,chunkFailed:true}]);s.watcher.stop();
 assert.equal(isChunkFailure(new TypeError('Failed to fetch')),false);assert.equal(isChunkFailure(new TypeError('Failed to fetch dynamically imported module: https://example/old.js')),true);
});
test('write and whole local holder/signing action block explicit reload; no bodies or replay',()=>{
 const done=startWrite();assert.equal(reloadBlocked(),true);done();done();assert.equal(writeActivity().writes,0);
 const t=Symbol();setReleaseBusy(t,true);assert.equal(reloadBlocked(),true);setReleaseBusy(t,false);assert.equal(reloadBlocked(),false);
 const ambiguous=startWrite();ambiguous(true);assert.equal(writeActivity().uncertain,true);assert.equal(reloadBlocked(),false);
});
test('truncated successful write response marks uncertain and never replays',async t=>{
 const {api}=await import('./identity.js');const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('{partial',{status:200})};t.after(()=>globalThis.fetch=original);
 await api('/api/requests',{method:'POST',body:{test:true}});assert.equal(calls,1);assert.equal(writeActivity().uncertain,true);assert.equal(writeActivity().writes,0);
});
test('visible tab that never loses focus still detects a changed build on the slow poll; hidden tab does not read',async()=>{
 const win=new EventTarget();win.location={origin:'https://baink.example'};const doc=new EventTarget();doc.visibilityState='visible';doc.querySelectorAll=()=>[{src:'https://baink.example/assets/index-old.js'}];
 let tickFn,period,cleared=null,reads=0;const updates=[];
 const watcher=createReleaseWatcher({window:win,document:doc,fetch:async()=>{reads++;return new Response(html('new'),{headers:{'Content-Type':'text/html'}})},onUpdate:u=>updates.push(u),now:()=>1e9,setInterval:(f,ms)=>{tickFn=f;period=ms;return 7},clearInterval:id=>cleared=id});
 assert.equal(period,RELEASE_POLL_MS);doc.visibilityState='hidden';tickFn();assert.equal(reads,0);
 doc.visibilityState='visible';tickFn();await watcher.check(true);await new Promise(r=>setImmediate(r));assert.ok(reads>=1);assert.deepEqual(updates[0],{changed:true,chunkFailed:false});
 watcher.stop();assert.equal(cleared,7);
});
test('structured API refusal asks for a read-only release check and is not resent',async t=>{
 const {api}=await import('./identity.js');const original=globalThis.fetch,originalWindow=globalThis.window;let calls=0,checks=0;
 globalThis.window=new EventTarget();globalThis.window.addEventListener(RELEASE_CHECK,()=>checks++);
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{code:'invalid_request',message:'Unknown field.'}}),{status:400,headers:{'Content-Type':'application/json'}})};
 t.after(()=>{globalThis.fetch=original;globalThis.window=originalWindow;});
 await assert.rejects(api('/api/requests',{method:'POST',body:{test:true}}),/Unknown field/);assert.equal(calls,1);assert.equal(checks,1);assert.equal(writeActivity().writes,0);
});

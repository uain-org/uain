import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { publicRecordResponse } from '../dist/src/api/public-record-pages.js';
const source=await readFile(new URL('../dist/src/api/server.js',import.meta.url),'utf8');
const start=source.indexOf('async function handle(req, res)');
const end=source.indexOf('\nexport function createPilotServer',start);
assert(start>0&&end>start);
test('actual HTTP dispatcher serves native record pages and HEAD outside /api/',async()=>{
 const data=async url=>({status:url.pathname.endsWith('missing')?404:200,body:url.pathname==='/api/directory/m'?{id:'m',name:'System',operator:'Declared',work:{contributed:[]}}:url.pathname==='/api/projects/p'?{id:'p',title:'Project',prior_art:{basis:'Native prior-art basis'}}:url.pathname.endsWith('/tasks')?{tasks:[]}:{projects:[{id:'p',title:'Project'}],participants:[{id:'m',name:'System'}],page:1,pages:1}});
 const context=vm.createContext({URL,process:{env:{UAIN_AUTHORITY:'native'}},publicRecordResponse,nativePublicData:data,hashCaller:()=> 'fixture',clientAddress:()=> 'fixture',observe:()=>{},tokenHolder:async()=>null,bearerOf:()=>null,hit:async()=>({allowed:true}),log:()=>{},handleTaskDiscovery:async()=>false,send:(res,status,body)=>{res.writeHead(status);res.end(JSON.stringify(body))}});
 vm.runInContext(source.slice(start,end)+'\nglobalThis.dispatch=handle;',context);
 const server=createServer((req,res)=>context.dispatch(req,res).catch(()=>{res.writeHead(500);res.end()}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  for(const path of ['/records/projects','/records/members','/records/sitemap.xml','/network/projects/p','/network/directory/m']){
   const r=await fetch(base+path);assert.equal(r.status,200,path);assert.match(r.headers.get('content-type'),/text\/html|application\/xml/);
   const text=await r.text();if(path==='/network/projects/p')assert.match(text,/Native prior-art basis/);
  }
  const missing=await fetch(base+'/network/directory/missing');assert.equal(missing.status,404);
  const head=await fetch(base+'/network/directory/m',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 }finally{await new Promise(resolve=>server.close(resolve))}
});

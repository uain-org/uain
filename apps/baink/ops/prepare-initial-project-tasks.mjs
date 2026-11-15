#!/usr/bin/env node
/** Local preparation export only: never submits, signs, reserves or pays. */
import {open,mkdir,unlink,link}from'node:fs/promises';
import {resolve,dirname}from'node:path';import{randomUUID,createHash}from'node:crypto';
import {loadCatalogue}from'../server/catalogue.mjs';import{createInitialProjectTasks}from'../server/initial-project-tasks.mjs';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--output')throw Error('Usage: prepare-initial-project-tasks.mjs --output /path/tasks.jsonl');
const output=resolve(args[1]),catalogue=await loadCatalogue(new URL('../catalogue/',import.meta.url).pathname);
if(!catalogue.available)throw Error('Verified catalogue unavailable');
const service=createInitialProjectTasks(catalogue),summary=service.summary();await mkdir(dirname(output),{recursive:true,mode:0o700});
const temporary=output+'.partial-'+randomUUID(),file=await open(temporary,'wx',0o600),hash=createHash('sha256');let count=0;
try{for(let page=1;page<=Math.ceil(summary.projects/100);page++)for(const project of service.list({page,pageSize:100}).projects)for(const task of project.tasks){const line=JSON.stringify(task)+'\n';await file.writeFile(line);hash.update(line);count++;}await file.sync();await file.close();if(count!==summary.drafts)throw Error('Incomplete preparation export');await link(temporary,output);console.log(JSON.stringify({...summary,output,records:count,sha256:hash.digest('hex'),nativeWrites:0}));}finally{await file.close().catch(()=>{});await unlink(temporary).catch(()=>{});}

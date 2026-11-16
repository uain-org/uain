/** Existing frozen rollback-journal SQLite only. No initializer, migration,
 * bootstrap, checkpoint, writable connection or operational journal. */
import {DatabaseSync} from 'node:sqlite';
import {lstat} from 'node:fs/promises';
import {ADDRESS,need} from '../../project-organizations/src/common.mjs';
import {readPinnedFile} from './read-profile.mjs';
export async function readFrozenRegistry({pin,selection,projectIds,uid=process.getuid()}){
 async function unchanged(){
  for(const suffix of ['-wal','-shm','-journal']){try{await lstat(pin.path+suffix);need(false,'inspection_registry_sidecar');}catch(e){if(e.code!=='ENOENT')throw e;}}
  const raw=await readPinnedFile(pin.path,{uid,sha256:pin.sha256,limit:16*1024*1024});
  need(raw.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))&&raw[18]===1&&raw[19]===1,'inspection_registry_not_frozen');return raw;
 }
 await unchanged();let db;
 try{
  db=new DatabaseSync(pin.path,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
  need(db.prepare("SELECT value FROM meta WHERE key='selection'").get()?.value===selection.digest,'inspection_registry_selection');
  const rows=db.prepare('SELECT project_id,source_digest,native_project_id,native_manager,native_evaluator FROM bindings').all();
  need(rows.length===120&&selection.projects.length===120,'inspection_registry_selection');
  const byId=new Map(rows.map(r=>[r.project_id,r]));need(byId.size===120,'inspection_registry_selection');
  for(const p of selection.projects)need(byId.get(p.id)?.source_digest===p.sourceDigest,'inspection_registry_source');
  const result=projectIds.map(id=>{
   const p=selection.get(id),r=byId.get(id);need(p&&r&&r.native_project_id===p.nativeProjectId&&ADDRESS.test(r.native_manager??'')&&ADDRESS.test(r.native_evaluator??'')&&r.native_manager!==r.native_evaluator,'inspection_registry_appointment');
   return Object.freeze({projectId:id,nativeProjectId:p.nativeProjectId,manager:r.native_manager,evaluator:r.native_evaluator});
  });
  await unchanged();return Object.freeze(result);
 }finally{db?.close();}
}

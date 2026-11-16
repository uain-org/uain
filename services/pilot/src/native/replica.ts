import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,link,rm,lstat,readFile,realpath} from 'node:fs/promises';
import {join,isAbsolute,resolve} from 'node:path';
import {canonical,evidenceDocument} from './evidence.ts';

/** Restore a capsule from an authenticated SQL backup. This recreates the
 * exact already-recorded public file; it establishes no new chain authority. */
export async function restorePublicationReplica(row:any,directory=process.env.UAIN_NATIVE_PUBLICATION_DIR){
 const document=evidenceDocument(row.body),receipt=row.receipt,event=receipt?.state?.receipt?.event,command=receipt?.envelope?.command;
 if(!/^[a-f0-9]{64}$/.test(row.epoch)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(row.id)||!/^uain1[a-f0-9]{40}$/.test(row.member)||typeof row.instance!=='string'||document.canonical!==row.canonical_body||document.digest!==row.evidence_digest||!receipt?.state?.receipt?.finalized||event?.operation!=='submit'||event.subject!==row.id||event.member!==row.member||(event.instance??'')!==row.instance||command?.operation!=='submit'||command.chain_id!==receipt.state.chain_id||command.member!==row.member||(command.instance??'')!==row.instance||command.payload?.id!==row.id||command.payload?.evidence_digest!==row.evidence_digest)throw Error('archived publication body/receipt attribution differs');
 const capsule={format:'uain-native-publication-v1',epoch:row.epoch,id:row.id,evidence_digest:row.evidence_digest,canonical_body:row.canonical_body,receipt};
 const digest=createHash('sha256').update(canonical(capsule)).digest('hex');
 if(digest!==row.replica_digest)throw Error('archived publication replica digest differs');
 return retainPublicationReplica(capsule,directory);
}
export async function recoverNativePublicationReplicas(pool:any,epoch:string,directory=process.env.UAIN_NATIVE_PUBLICATION_DIR,after='',limit=4){
 if(!/^[a-f0-9]{64}$/.test(epoch)||after!==''&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(after)||!Number.isInteger(limit)||limit<1||limit>8)throw Error('bounded explicit publication recovery epoch/page required');
 const rows=(await pool.query('SELECT * FROM native_publications WHERE epoch=$1 AND id COLLATE "C">$2 ORDER BY id COLLATE "C" LIMIT $3',[epoch,after,limit+1])).rows,selected=rows.slice(0,limit),digests=[];
 for(const row of selected){if(row.epoch!==epoch||row.id<=after)throw Error('publication recovery page identity differs');digests.push(await restorePublicationReplica(row,directory))}
 return{epoch,restored:selected.length,next_after:selected.at(-1)?.id??after,more:rows.length>limit,replica_digests:digests};
}

export async function publicationReplicaStatus(directory=process.env.UAIN_NATIVE_PUBLICATION_DIR){
 if(!directory||!isAbsolute(directory))return false;
 try{const info=await lstat(directory);return info.isDirectory()&&!info.isSymbolicLink()&&(info.mode&0o077)===0&&await realpath(directory)===resolve(directory)}catch{return false}
}

// Publication acknowledgements require a flushed app-host copy as well as the
// database record. Capsules contain public bodies and signed public envelopes.
export async function retainPublicationReplica(capsule:unknown,directory=process.env.UAIN_NATIVE_PUBLICATION_DIR){
 if(!directory||!isAbsolute(directory))throw Error('native publication replica requires an absolute durable directory');
 await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);
 if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||await realpath(directory)!==resolve(directory))throw Error('native publication replica requires a private non-symlink directory');
 const bytes=Buffer.from(canonical(capsule));if(bytes.length>10*1024*1024)throw Error('native publication replica exceeds byte bound');
 const digest=createHash('sha256').update(bytes).digest('hex'),target=join(directory,digest+'.json'),temporary=join(directory,'.'+randomUUID()+'.tmp');
 const file=await open(temporary,'wx',0o600);
 try{await file.writeFile(bytes);await file.sync()}finally{await file.close()}
 try{
  try{await link(temporary,target)}catch(error:any){
   if(error.code!=='EEXIST')throw error;
   const existing=await lstat(target);
   if(!existing.isFile()||existing.isSymbolicLink()||(existing.mode&0o077)!==0||existing.size!==bytes.length||!bytes.equals(await readFile(target)))throw Error('immutable native publication replica differs');
  }
 }finally{await rm(temporary,{force:true})}
 const dir=await open(directory,'r');try{await dir.sync()}finally{await dir.close()}
 return digest;
}

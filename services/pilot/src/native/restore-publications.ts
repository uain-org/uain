import {createHash} from 'node:crypto';
import {lstat,readdir,readFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import type pg from 'pg';
import {nativeConfig} from '../api/native-routes.ts';
import {evidenceDocument} from './evidence.ts';
import {publishNativeEvidence} from './projection.ts';

// Rebuild publication records through the same fresh native verifier as writes.
// Stored receipt JSON alone cannot authorize attribution or restore a body.
export async function restorePublicationReplicas(pool:pg.Pool,config:NonNullable<ReturnType<typeof nativeConfig>>,directory=process.env.UAIN_NATIVE_PUBLICATION_DIR){
 if(!directory||!isAbsolute(directory))throw Error('absolute native publication replica directory required');
 const files=(await readdir(directory)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).sort();
 if(files.length>100000)throw Error('native publication restore census exceeds bound');
 let restored=0,skipped_foreign=0;
 for(const name of files){
  const path=join(directory,name),info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>10*1024*1024)throw Error('invalid native publication replica file');
  const bytes=await readFile(path);if(createHash('sha256').update(bytes).digest('hex')!==name.slice(0,-5))throw Error('native publication replica digest differs');
  const capsule=JSON.parse(bytes.toString('utf8'));
  if(capsule.format!=='uain-native-publication-v1'||!/^[a-f0-9]{64}$/.test(capsule.epoch))throw Error('native publication replica epoch differs');
  const body=JSON.parse(capsule.canonical_body),checked=evidenceDocument(body),envelope=capsule.receipt?.envelope,event=capsule.receipt?.state?.receipt?.event;
  if(checked.canonical!==capsule.canonical_body||checked.digest!==capsule.evidence_digest||envelope?.command?.payload?.id!==capsule.id||event?.subject!==capsule.id||!capsule.receipt?.state?.receipt?.finalized||event.operation!=='submit'||envelope.command.operation!=='submit'||event.member!==envelope.command.member||(event.instance??'')!==(envelope.command.instance??'')||envelope.command.chain_id!==capsule.receipt.state.chain_id||envelope.command.payload.evidence_digest!==capsule.evidence_digest)throw Error('native publication replica attribution differs');
  // A retained capsule is archive evidence, never current-epoch authority.
  // Validate its bytes/body above, then leave attribution to its own epoch.
  if(capsule.epoch!==config.genesisHash){skipped_foreign++;continue}
  await publishNativeEvidence(pool,config,{body,envelope,event_id:event.id});restored++;
 }
 return{epoch:config.genesisHash,restored,skipped_foreign};
}

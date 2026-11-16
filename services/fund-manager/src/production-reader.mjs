/** Fixed owning profile -> local cryptographic native verifier -> reduced reads.
 * There is intentionally no transport/config/plugin argument to this factory. */
import {createNativeAssetAdapter} from '../../../apps/baink/server/native-asset.mjs';
import {createNativeReader} from '../../project-organizations/src/native-reader.mjs';
import {createFundSnapshotReader} from '../../project-organizations/src/fund-snapshot.mjs';
import {validateSelection} from '../../project-organizations/src/selection.mjs';
import {need,sha256} from '../../project-organizations/src/common.mjs';
import {PROFILE_PATH,readPinnedFile,parseInspectionProfile} from './read-profile.mjs';
import {readFrozenRegistry} from './frozen-registry.mjs';
export async function readInspectionProfile(){const raw=await readPinnedFile(PROFILE_PATH);return Object.freeze({profile:parseInspectionProfile(JSON.parse(raw)),profileSha256:sha256(raw)});}
export async function openProductionInspectionReader(...args){
 need(args.length===0,'inspection_reader_arguments');
 const {profile:p,profileSha256:profileDigest}=await readInspectionProfile();
 const selectionBytes=await readPinnedFile(p.selection.path,{sha256:p.selection.sha256,limit:2*1024*1024});
 const amendmentBytes=await readPinnedFile(p.amendments.path,{sha256:p.amendments.sha256,limit:256*1024});
 const selection=validateSelection(JSON.parse(selectionBytes),null,{amendments:JSON.parse(amendmentBytes)});
 const bindings=await readFrozenRegistry({pin:p.registry,selection,projectIds:p.projectIds});
 const appointments=new Map(bindings.map(b=>[b.projectId,Object.freeze({...b,mainKpi:selection.get(b.projectId).mainKpi})]));
 const n=p.native;
 async function pins(){
  await readPinnedFile(PROFILE_PATH,{sha256:profileDigest});
  await readPinnedFile(n.binary,{sha256:n.binaryHash,limit:256*1024*1024,executable:true});
  await readPinnedFile(n.genesis,{sha256:n.genesisHash,limit:8*1024*1024});
  await readPinnedFile(p.selection.path,{sha256:p.selection.sha256,limit:2*1024*1024});
  await readPinnedFile(p.amendments.path,{sha256:p.amendments.sha256,limit:256*1024});
  await readFrozenRegistry({pin:p.registry,selection,projectIds:p.projectIds});
 }
 await pins();
 const asset=createNativeAssetAdapter({config:n});
 const verified=createNativeReader({transport:Object.freeze({publicState:asset.publicState.bind(asset)}),chainId:n.chainId,productionChainId:n.chainId,timeoutMs:n.timeoutMs,retries:0});
 const snapshot=createFundSnapshotReader({selection,reader:Object.freeze({read:verified.read.bind(verified)}),chainId:n.chainId,timeoutMs:n.timeoutMs,maxProofAgeMs:n.maxAgeSeconds*1000});
 const network=Object.freeze({chainId:n.chainId,genesisSha256:n.genesisHash,nativeVerifierSha256:n.binaryHash,environment:'production'});
 let closed=false;
 return Object.freeze({async readSnapshot(projectId){
  need(!closed&&appointments.has(projectId),'inspection_project_not_configured');await pins();
  const result=await snapshot.snapshot(projectId);await pins();need(!closed,'inspection_reader_closed');
  return Object.freeze({...result,inspection:Object.freeze({appointment:appointments.get(projectId),network,profileSha256:profileDigest})});
 },async close(){closed=true;await asset.close();}});
}

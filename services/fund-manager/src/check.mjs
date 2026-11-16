/** Fixed owning profile only. No caller-supplied RPC, executable, transport,
 * snapshot, provider, signer or plugin. This CLI never runs a fund release. */
import {openProductionInspectionReader,readInspectionProfile} from './production-reader.mjs';
import {openInspectionStore} from './inspection-store.mjs';
import {createFundInspector} from './inspector.mjs';
import {need} from '../../project-organizations/src/common.mjs';
const held=()=>({schema:'uain-fund-inspection-v1',status:'held',reason:'fund_achievement_verifier_not_qualified',nativeReader:'not_configured',providerCalled:false,prepareCalled:false,custodyCalled:false,fundsReleased:false});
const args=process.argv.slice(2),allowed=args.length===0||args.length===1&&args[0]==='check';
if(!allowed){console.log(JSON.stringify(held()));process.exitCode=1;}
else{
 let reader;
 try{
  const {profile,profileSha256}=await readInspectionProfile();
  const guard=async()=>need((await readInspectionProfile()).profileSha256===profileSha256,'inspection_profile_changed');
  const store=await openInspectionStore({directory:profile.reportDirectory});
  const holds=Object.freeze({async put(report){await guard();return store.put(report);}});
  reader=await openProductionInspectionReader();await guard();
  for(const id of profile.projectIds){
   const snapshot=await reader.readSnapshot(id);await guard();need(snapshot.inspection.profileSha256===profileSha256,'inspection_profile_changed');
   const inspector=createFundInspector({appointment:snapshot.inspection.appointment,network:snapshot.inspection.network,readSnapshot:async()=>snapshot,readEvidence:async()=>null,readPolicy:async()=>null,readReceipt:async()=>null,holds,clock:Date.now});
   console.log(JSON.stringify(await inspector.check()));
  }
 }catch(e){
  const result=held();if(e.code!=='ENOENT'){result.nativeReader='unavailable';result.reason='inspection_configuration_or_read_unavailable';process.exitCode=1;}
  console.log(JSON.stringify(result));
 }finally{await reader?.close();}
}

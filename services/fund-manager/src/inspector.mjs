/** Read-only library. Production composition must supply the existing pinned
 * local native verifier snapshot boundary, never remotely asserted verified JSON.
 * No run/prepare/provider/custody/socket interface is accepted or exported. */
import{exactKeys,plain,need,ADDRESS,NATIVE_ID,HASH,text,digest,sha256}from'../../project-organizations/src/common.mjs';
import{validateAchievementReceipt}from'./achievement-receipt.mjs';
const unavailable='fund_achievement_verifier_not_qualified';
export function createFundInspector(config){
 need(exactKeys(config,['appointment','network','readSnapshot','readEvidence','readPolicy','readReceipt','holds','clock']),'inspection_configuration');
 const{appointment:a,network:n,readSnapshot,readEvidence,readPolicy,readReceipt,holds,clock}=config;
 need(exactKeys(a,['projectId','nativeProjectId','manager','evaluator','mainKpi'])&&NATIVE_ID.test(a.projectId)&&NATIVE_ID.test(a.nativeProjectId)&&ADDRESS.test(a.manager)&&ADDRESS.test(a.evaluator)&&a.manager!==a.evaluator&&text(a.mainKpi,20,4096),'inspection_appointment');
 need(exactKeys(n,['chainId','genesisSha256','nativeVerifierSha256','environment'])&&text(n.chainId,1,96)&&HASH.test(n.genesisSha256)&&HASH.test(n.nativeVerifierSha256)&&['fixture','production'].includes(n.environment),'inspection_network');
 need([readSnapshot,readEvidence,readPolicy,readReceipt,clock].every(f=>typeof f==='function')&&typeof holds?.put==='function','inspection_configuration');
 const appointment=structuredClone(a),network=structuredClone(n);
 return Object.freeze({async check(){
  let report={schema:'uain-fund-inspection-v1',projectId:appointment.projectId,status:'held',reason:unavailable,binding:null,observation:null,receiptState:'missing',providerCalled:false,prepareCalled:false,custodyCalled:false,fundsReleased:false};
  try{
   const now=clock();need(Number.isFinite(now),'inspection_clock');const s=await readSnapshot(appointment.projectId);const p=s?.proof;
   need(s?.available===true&&s.projectId===appointment.projectId&&s.nativeProjectId===appointment.nativeProjectId&&plain(p)&&p.authority==='native'&&p.finalized===true&&p.chainId===network.chainId&&p.genesisSha256===network.genesisSha256&&p.height===s.height&&/^[1-9][0-9]{0,18}$/.test(s.height??'')&&typeof p.appHash==='string'&&/^[a-fA-F0-9]{64}$/.test(p.appHash)&&(network.environment!=='production'||p.production===true),'inspection_native_unavailable');
   const age=now-Date.parse(s.fetchedAt);need(Number.isFinite(age)&&age>=-30000&&age<=120000,'inspection_native_stale');report.observation={height:s.height,appHash:p.appHash.toLowerCase()};
   need(s.budget?.project===appointment.nativeProjectId&&s.budget.manager===appointment.manager&&s.fundConfig?.project===appointment.nativeProjectId&&s.fundConfig.evaluator===appointment.evaluator,'inspection_roles_changed');
   need(Object.hasOwn(s,'fundState'),'inspection_fund_state');
   if(s.budget.closed===true){report.status='closed';report.reason='observed_native_closed';}
   else if(s.fundState==null||s.fundState.approved_revision===0){report.status='plan_required';report.reason='approved_plan_required';}
   else{
    const f=s.fundState;need(Number.isSafeInteger(f.approved_revision)&&f.approved_revision>0&&Number.isSafeInteger(f.revision)&&f.revision>=f.approved_revision&&Number.isSafeInteger(f.completed)&&f.completed>=0&&f.completed<=5&&typeof f.pending==='string','inspection_fund_state');
    const approved=s.approvedPlan;need(plain(approved)&&approved.project===appointment.nativeProjectId&&approved.revision===f.approved_revision&&approved.state==='accept'&&approved.main_kpi===appointment.mainKpi&&Array.isArray(approved.stages)&&approved.stages.length===5&&approved.stages.every((x,i)=>x.round===i+1&&text(x.criteria,20,4096)),'inspection_plan_changed');
    if(f.pending===''){if(s.budget.main_kpi_achieved===true){need(f.completed===5&&s.budget.round===6,'inspection_achievement_state');report.status='achievement_observed';report.reason='financial_closeout_separate';}else{report.status='active';report.reason='no_pending_application';}}
    else{
     const plan=s.approvedPlan,round=f.completed+1,app=s.applications?.[f.pending];need(round>=1&&round<=5&&s.budget.round===round&&plain(plan)&&plan.project===appointment.nativeProjectId&&plan.revision===f.approved_revision&&plan.state==='accept'&&plan.main_kpi===appointment.mainKpi&&Array.isArray(plan.stages)&&plan.stages.length===5&&plan.stages.every((x,i)=>x.round===i+1&&text(x.criteria,20,4096)),'inspection_plan_changed');
     need(plain(app)&&app.id===f.pending&&NATIVE_ID.test(app.id)&&app.project===appointment.nativeProjectId&&app.manager===appointment.manager&&app.state==='pending'&&app.revision===f.approved_revision&&app.round===round&&HASH.test(app.evidence_digest??''),'inspection_application_changed');
     const criteria=plan.stages[round-1].criteria,evidence=await readEvidence(app.evidence_digest);need(plain(evidence)&&evidence.schema==='uain-fund-milestone-evidence-v1'&&digest(evidence)===app.evidence_digest&&evidence.project===appointment.nativeProjectId&&evidence.revision===app.revision&&evidence.round===round&&evidence.criteria_digest===sha256(criteria),'inspection_evidence_unavailable');
     const binding={chainId:network.chainId,genesisSha256:network.genesisSha256,nativeVerifierSha256:network.nativeVerifierSha256,projectId:appointment.nativeProjectId,manager:appointment.manager,evaluator:appointment.evaluator,applicationId:app.id,approvedPlanRevision:app.revision,round,applicationEvidenceDigest:app.evidence_digest,approvedPlanDigest:digest(plan),stageCriteriaDigest:sha256(criteria),mainKpiDigest:sha256(appointment.mainKpi)};report.binding=binding;
     const policy=await readPolicy(binding),receipt=await readReceipt(binding);if(policy!==null&&receipt!==null){const statement=validateAchievementReceipt(receipt,policy,{binding,environment:network.environment,now:clock()});need(BigInt(statement.observation.height)<=BigInt(s.height),'inspection_receipt_future_state');if(statement.observation.height===s.height)need(statement.observation.appHash===p.appHash.toLowerCase(),'inspection_receipt_state_mismatch');report.receiptState='bound_prospective';}
     report.status='needs_evidence';report.reason=unavailable;
    }
   }
  }catch(e){report.status='held';report.reason=typeof e.code==='string'&&/^(inspection|achievement)_/.test(e.code)?e.code:'inspection_input_unavailable';report.receiptState='unavailable';}
  // Reporting may fail closed on unsafe/full storage. Never silently claim a
  // durable deficiency when the private append-only write did not complete.
  const reportDigest=await holds.put(report);return Object.freeze({...report,reportDigest});
 }});
}

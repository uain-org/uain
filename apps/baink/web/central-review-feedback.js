import {validateReviewFeedback} from '../shared/central-review-feedback.mjs';
import {nativeProofFreshness} from './native-balance.js';
import {evidenceView} from './central-evidence-view.js';
const hash=/^[a-f0-9]{64}$/,id=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const need=value=>{if(!value)throw Error('central_review_feedback_unavailable');};
/** Presentation projection only. Native cryptographic verification remains with
 * the pinned server reader; this checks its context and the committed text. */
export async function reviewFeedbackView(input,context,{now=Date.now()}={}){
 const data=structuredClone(input),expected=structuredClone(context),p=data?.proof,s=data?.submission,t=data?.task;
 need(data?.authority==='native'&&data.verified===true&&data.member===expected.author&&['accepted','rejected','needs_evidence','under_review','superseded','expired'].includes(data.outcome));
 need(s?.id===expected.submission&&s.author===expected.author&&s.task===expected.task&&s.state===(data.outcome==='needs_evidence'?'under_review':data.outcome)&&t?.id===expected.task&&id.test(t.project??''));
 need(expected.pins&&hash.test(expected.pins.genesisSha256??'')&&hash.test(expected.verifierSha256??'')&&nativeProofFreshness(p,{now}).fresh&&p.chainId===expected.pins.chainId&&p.epoch===expected.pins.genesisSha256&&p.genesisSha256===expected.pins.genesisSha256&&p.verifierSha256===expected.verifierSha256&&hash.test(p.appHash??'')&&typeof p.height==='string'&&/^[1-9][0-9]{0,18}$/.test(p.height));
 // The S6 evidence journey (kind, window, helpers, actions); null when absent.
 let journey=null;try{journey=evidenceView(data.evidence,expected.submission);}catch{journey=null;}
 const withJourney=view=>journey?{...view,evidence:journey}:view;
 if(data.feedback?.available!==true)return withJourney({status:'unavailable',currentOutcome:data.outcome});
 const record=data.review?.record;
 need(data.review?.status==='proved'&&record&&id.test(record.execution_id??'')&&typeof record.height==='string'&&/^[1-9][0-9]{0,18}$/.test(record.height)&&BigInt(record.height)<=BigInt(p.height)&&record.evidence_digest===s.evidence_digest&&record.criteria_digest===t.acceptance_digest&&data.feedback.authority==='native-committed-decision'&&data.feedback.scope==='retained-review');
 const packet=await validateReviewFeedback(data.feedback.packet,{submission:expected.submission,executionId:record.execution_id,author:expected.author,task:expected.task,project:t.project,review:record,chainId:expected.pins.chainId,genesisSha256:expected.pins.genesisSha256,verifierSha256:expected.verifierSha256},{now});
 const verdict=packet.decision.verdict,outcome={accept:'accepted',reject:'rejected',needs_evidence:'needs_evidence'}[verdict];
 need(data.outcome===outcome||verdict==='needs_evidence'&&['accepted','rejected','superseded','expired'].includes(data.outcome));
 return withJourney({status:'ready',currentOutcome:data.outcome,verdict,findings:packet.decision.findings,historical:data.outcome!==outcome});
}
export async function readSubmissionFeedback(context,{apiCall,isCurrent}){
 const expected=structuredClone(context),live=isCurrent;
 const current=()=>{if(!live())throw new DOMException('Feedback read cancelled','AbortError');};
 need(id.test(expected.submission??'')&&id.test(expected.task??'')&&typeof apiCall==='function'&&typeof live==='function');current();
 const data=await apiCall('/api/native/central/submissions/'+encodeURIComponent(expected.submission),{method:'GET',isCurrent:live});current();
 const view=await reviewFeedbackView(data,expected);current();return view;
}

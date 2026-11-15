import {createHash} from 'node:crypto';
/** All catalogue rows get preparation tasks, never synthetic payable bounties.
 * Deterministic IDs and evidence pins survive retries without a second ledger. */
export function createInitialProjectTasks(catalogue){
 const source=catalogue.publicSummaryIndex();
 const available=catalogue.available===true;
 const rows=source.records??[];
 const byId=new Map(rows.map(r=>[r.summary.id,r.summary]));
 const digest=row=>createHash('sha256').update(JSON.stringify({schema:'uain/initial-tasks/v1',source:source.source,project:row})).digest('hex');
 function project(id){const row=byId.get(id);if(!row)return null;const pin=digest(row);
  const common={projectId:id,sourceDigest:pin,state:'draft-held',payable:false,reward:null,reviewAuthority:'UAIN',blockers:['native_project_admission_required','manager_terms_and_prices_required','UAIN_eligibility_and_criteria_review_required','native_reward_reservation_required']};
  return{projectId:id,title:row.title,sourceDigest:pin,tasks:[
   {...common,id:`${id}:initial:${pin.slice(0,16)}:prior-art`,title:`Establish research baseline: ${row.title}`,criteria:`For ${id}, identify dated primary sources and existing solutions relevant to ${row.title}. Provide reproducible citations, distinguish established results from unresolved gaps, and submit evidence for UAIN review. A known-answer replication is not a new paid research result.`,kind:'prior-art-and-baseline'},
   {...common,id:`${id}:initial:${pin.slice(0,16)}:milestones`,title:`Define first measurable milestone: ${row.title}`,criteria:`For ${id}, use the source project KPI and baseline findings to propose a small testable first-stage deliverable, dependencies, evidence and acceptance criteria. Propose solver and UAIN reviewer rewards within the unlocked allowance; no price or funding is approved by this draft.`,kind:'KPI-and-task-definition'}]};
 }
 return Object.freeze({
  summary:()=>({schema:'uain/initial-task-readiness/v1',available,projects:rows.length,projectCount:rows.length,drafts:rows.length*2,payable:0,held:rows.length*2,reviewAuthority:'UAIN',notice:'Prepared evidence/definition tasks only; no admitted project, reserved reward or earning is established.'}),
  project,
  list({page=1,pageSize=24}={}){if(!Number.isSafeInteger(page)||page<1||page>10000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw Error('Invalid initial task page');return{...this.summary(),page,pageSize,pages:Math.ceil(rows.length/pageSize),projects:rows.slice((page-1)*pageSize,page*pageSize).map(r=>project(r.summary.id))};}
 });
}

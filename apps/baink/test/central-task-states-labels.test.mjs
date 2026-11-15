import {test} from 'node:test';import assert from 'node:assert/strict';
import {centralTaskClaim,centralMemberClaim,centralTaskStatus,WHY_NOT} from '../server/central-claim.mjs';

// central-task-states-v1 (docs/engineering/task-statuses.md section 11): plain labels
// and the claim answer for the two new native states. Advisory: the chain decides.
const now=Date.parse('2026-11-10T00:00:00Z'),at=n=>String(Math.floor(now/1000)+n);
const base={id:'CT-1',project:'P-1',solver_amount:'50000000',reviewer_amount:'5000000',reserved:'55000000',paid:'0',pending:'',winner:''};

test('a Beauty Contest is claimable until closes_at, one slot at a time, then judged',()=>{
  const contest={...base,state:'contest_open',mode:'contest',closes_at:at(3600),select_by:at(3600+259200),max_entries:'20',entries:'3'};
  assert.deepEqual(centralTaskClaim(contest,null,now),{claimable:true,why_not:null,why_not_text:null});
  assert.equal(centralTaskStatus(contest,now).status_label,'Contest: best entry by 2026-11-10 01:00 UTC wins');
  assert.equal(centralTaskClaim(contest,null,now+3600*1000).why_not,'contest_closed');
  assert.equal(centralTaskStatus(contest,now+3600*1000).status,'contest_judging');
  assert.equal(centralTaskStatus(contest,now+3600*1000).status_label,'Judging entries; the winner is chosen by 2026-11-13 01:00 UTC');
  assert.equal(centralTaskClaim({...contest,entries:'20'},null,now).why_not,'contest_full');
  assert.equal(centralTaskClaim({...contest,reserved:'0'},null,now).why_not,'not_funded');
  assert.equal(centralTaskClaim(contest,{available:false},now).why_not,'on_hold');
  assert.equal(centralTaskStatus({...contest,state:'no_winner'}).status_label,'Contest closed with no winner');
  assert.equal(centralTaskClaim({...contest,state:'no_winner'}).why_not,'closed');
});

test('Conditional Approved names its condition and locks others out',()=>{
  const open={...base,state:'open',payout:'conditional',condition:'The named bill passes into law.',resolves_by:'1798761600'};
  assert.equal(centralTaskClaim(open).claimable,true);
  assert.equal(centralTaskStatus(open).status_label,'Open: paid only if this happens: The named bill passes into law. (by 2027-01-01 00:00 UTC)');
  const won={...open,state:'conditional_approved',winner:'CS-1',reserved:'50000000',paid:'5000000'};
  assert.equal(centralTaskClaim(won).why_not,'won_conditionally');
  assert.equal(centralTaskClaim(won).why_not_text,WHY_NOT.won_conditionally);
  assert.equal(centralTaskStatus(won).status_label,'Approved if this happens: The named bill passes into law. (by 2027-01-01 00:00 UTC)');
  assert.equal(centralMemberClaim(won,{joined:true}).why_not,'won_conditionally');
  assert.equal(centralTaskStatus({...won,state:'conditional_expired'}).status_label,'Not paid: the condition did not happen in time');
  assert.equal(centralTaskStatus({...won,state:'accepted'}).status_label,'Approved');
});

test('existing states keep their meaning and get plain labels',()=>{
  for(const [state,status,label] of [['open','open','Open'],['under_review','under_review','Being checked'],['open_unfunded','open_unfunded','Not funded yet'],['accepted','approved','Approved'],['retired','closed','Closed']])
    assert.deepEqual(centralTaskStatus({...base,state}),{status,status_label:label});
  assert.deepEqual(centralTaskStatus(null),{status:'closed',status_label:'Closed'});
  for(const why of ['won_conditionally','contest_closed','contest_full'])assert.match(WHY_NOT[why],/^[A-Z].*\.$/);
});

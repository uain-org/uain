/** Can a member take this central task now? (docs/engineering/task-statuses.md
 * section 7.1.) One derived answer, computed only from the proved native task
 * record and BAINK's operator hold, and reused by the task page, task detail
 * and the agent kit. Advisory: it adds no consensus rule and changes no signed
 * or hashed bytes; central_submit (chain/federation/central_earning.go) stays
 * the authority and refuses anything this answer would call not claimable.
 *
 * A rejected (0-score) submission does not leave the task claimable: the chain
 * pays the reviewer, releases the solver amount and sets the task to
 * open_unfunded, so it reopens only when its project manager funds it again
 * (central_task_fund). This answer reports that as not_funded. */
export const WHY_NOT = Object.freeze({
  under_review: 'Someone else\'s answer is being checked right now.',
  won: 'Someone else already won this task.',
  not_funded: 'This task has no reward set aside right now; it may reopen later.',
  on_hold: 'This task is paused while its instructions are fixed.',
  closed: 'This task is closed.',
  not_joined: 'Join the task\'s project first; it is one quick step.',
  licence_inactive: 'Your membership is not active yet; wait a few minutes, or enrol first.',
  self_review: 'You check other members\' work, so you cannot take tasks.',
  project_inactive: 'This task\'s project is paused.',
  review_inactive: 'Checking is paused right now; try again later.',
  already_entered: 'You already sent an answer for this task; see the result in your history.',
  won_conditionally: 'Someone else\'s answer was approved; it is paid when its condition happens.',
  contest_closed: 'This contest has closed; the best entry is being chosen.',
  contest_full: 'This contest already has all the entries it can take.',
});
/** Plain words for a native task state (docs/engineering/task-statuses.md
 * section 11). The two states added by central-task-states-v1 name their
 * deadline or condition. Times are block-time Unix seconds on the record. */
const when = (seconds) => { try { const ms = Number(BigInt(seconds)) * 1000; return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null; } catch { return null; } };
const condition = (t) => typeof t.condition === 'string' && t.condition.trim() ? t.condition.trim() + (when(t.resolves_by) ? ' (by ' + when(t.resolves_by) + ')' : '') : 'its condition';
export function centralTaskStatus(task, nowMs = Date.now()) {
  if (!task || typeof task !== 'object') return { status: 'closed', status_label: 'Closed' };
  const now = BigInt(Math.floor(nowMs / 1000));
  const before = (s) => { try { return now < BigInt(s); } catch { return false; } };
  switch (task.state) {
    case 'open': return { status: 'open', status_label: task.payout === 'conditional' ? 'Open: paid only if this happens: ' + condition(task) : 'Open' };
    case 'under_review': return { status: 'under_review', status_label: 'Being checked' };
    case 'open_unfunded': return { status: 'open_unfunded', status_label: 'Not funded yet' };
    case 'accepted': return { status: 'approved', status_label: 'Approved' };
    case 'contest_open': return before(task.closes_at)
      ? { status: 'contest_open', status_label: 'Contest: best entry by ' + (when(task.closes_at) ?? 'the closing time') + ' wins' }
      : { status: 'contest_judging', status_label: 'Judging entries; the winner is chosen by ' + (when(task.select_by) ?? 'the selection deadline') };
    case 'conditional_approved': return { status: 'conditional_approved', status_label: 'Approved if this happens: ' + condition(task) };
    case 'conditional_expired': return { status: 'conditional_expired', status_label: 'Not paid: the condition did not happen in time' };
    case 'no_winner': return { status: 'no_winner', status_label: 'Contest closed with no winner' };
    default: return { status: 'closed', status_label: 'Closed' };
  }
}
const funded = (t) => { try { return BigInt(t.reserved) === BigInt(t.solver_amount) + BigInt(t.reviewer_amount) && BigInt(t.reserved) > 0n; } catch { return false; } };
const answer = (why) => why ? { claimable: false, why_not: why, why_not_text: WHY_NOT[why] } : { claimable: true, why_not: null, why_not_text: null };
/** Task-level answer, the same for every member. `availability` is the operator hold row, if any. */
export function centralTaskClaim(task, availability = null, nowMs = Date.now()) {
  if (!task || typeof task !== 'object') return answer('closed');
  if (task.state === 'conditional_approved') return answer('won_conditionally');
  if (task.winner || task.state === 'accepted') return answer('won');
  if (task.state === 'contest_open') {
    // Beauty Contest: entries queue without a lock until closes_at, one per member.
    let open = false, full = true;
    try { open = BigInt(Math.floor(nowMs / 1000)) < BigInt(task.closes_at); full = BigInt(task.entries ?? '0') >= BigInt(task.max_entries); } catch { return answer('closed'); }
    if (!open) return answer('contest_closed');
    if (full) return answer('contest_full');
    if (!funded(task)) return answer('not_funded');
    if (availability?.available === false) return answer('on_hold');
    return answer(null);
  }
  if (task.pending || task.state === 'under_review') return answer('under_review');
  if (task.state === 'open_unfunded' || (task.state === 'open' && !funded(task))) return answer('not_funded');
  if (task.state !== 'open') return answer('closed');
  if (availability?.available === false) return answer('on_hold');
  return answer(null);
}
/** Member-level answer for task detail. A task that is claimable for the
 * network but not yet joined stays claimable, with next_step 'join': joining is
 * one step this member can take, not a reason the task is unavailable. */
export function centralMemberClaim(task, { availability = null, licence = 'active', joined = false, selfReviewer = false, projectActive = true, reviewActive = true } = {}) {
  const base = centralTaskClaim(task, availability);
  if (!base.claimable) return base;
  if (!reviewActive) return answer('review_inactive');
  if (licence !== 'active') return answer('licence_inactive');
  if (selfReviewer) return answer('self_review');
  if (!projectActive) return answer('project_inactive');
  return joined ? { ...base, next_step: 'submit' } : { ...base, next_step: 'join', next_step_text: WHY_NOT.not_joined };
}

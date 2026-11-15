/** SEMANTIC FIXTURE, NOT CHAIN QUALIFICATION.
 *
 * A pure in-memory mirror of the native `central-earning-five-kpi-fund-v2`
 * fund/task/review/award transitions that the organization adapter consumes.
 * It exists so the adapter's expectations can be pinned in tests on machines
 * without the Go toolchain or a native daemon. It never signs, never touches a
 * chain and its output is never production evidence: every snapshot it emits is
 * marked `fixture: true`, which acceptance reports refuse to count.
 *
 * Each rule cites the Go source it mirrors (chain/federation/*.go at the
 * revision this branch was cut from). If the Go code changes, the Go tests are
 * authoritative and this mirror must follow them.
 */
import { createHash } from 'node:crypto';

export class FundModelError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const bad = (code = 'invalid_central_transition') => {
  throw new FundModelError(code);
};
const ensure = (ok, code) => {
  if (!ok) bad(code);
};

// central_earning.go:18-23
export const POLICY = 'central-earning-five-kpi-fund-v2';
export const OPENING_UNITS = '10000000000';
export const LIFETIME_UNITS = '1000000000000000';
// central_fund.go:13 — cumulative allowances (micro-AI$), indexed by round 1..6.
export const CUMULATIVE_UNITS = Object.freeze(['10000000000', '110000000000', '1110000000000', '11110000000000', '111110000000000', '1000000000000000']);
// coin/ledger.go:18
export const SUPPLY_CAP_UNITS = '108000000000000000000';

const UNITS = /^(0|[1-9][0-9]{0,20})$/; // coin/ledger.go:20
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const HASH = /^[a-f0-9]{64}$/;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const big = (s) => {
  ensure(typeof s === 'string' && UNITS.test(s) && BigInt(s) <= BigInt(SUPPLY_CAP_UNITS), 'invalid_units');
  return BigInt(s);
};
const positive = (s) => {
  const n = big(s);
  ensure(n > 0n, 'invalid_units');
  return n;
};
const sum = (...xs) => xs.reduce((a, b) => a + BigInt(b), 0n).toString();
const pad = (n) => String(n).padStart(20, '0');
// central_fund.go:15-20
export const allocationForRound = (round) => (Number.isInteger(round) && round >= 1 && round <= 6 ? CUMULATIVE_UNITS[round - 1] : null);

export function createFundModel({ guardian, reviewer, members = {} }) {
  ensure(typeof guardian === 'string' && typeof reviewer === 'string' && guardian !== reviewer, 'invalid_model_configuration');
  let state = {
    // coin/ledger.go:22-27; Transparent+Shielded must equal Minted.
    ledger: { minted: '0', reserved: '0', transparent: '0', shielded: '0' },
    members: { [guardian]: { licence: 'active' }, [reviewer]: { licence: 'active' }, ...structuredClone(members) },
    activation: { policy: POLICY, reviewer },
    projects: {}, budgets: {}, configs: {}, fundStates: {}, plans: {}, planReviews: {}, applications: {},
    tasks: {}, submissions: {}, reviews: {}, awards: {}, balances: {}, earnings: {},
  };
  /** All-or-nothing, like a rejected native transaction: errors leave state untouched. */
  const tx = (fn) => {
    const draft = structuredClone(state);
    const out = fn(draft);
    state = draft;
    return out;
  };
  const active = (s, m) => s.members[m]?.licence === 'active';

  // coin/ledger.go:93-135
  const reserve = (s, units) => {
    const n = positive(units);
    ensure(BigInt(s.ledger.minted) + BigInt(s.ledger.reserved) + n <= BigInt(SUPPLY_CAP_UNITS), 'supply_cap_exceeded');
    s.ledger.reserved = (BigInt(s.ledger.reserved) + n).toString();
  };
  const release = (s, units) => {
    const n = positive(units);
    ensure(BigInt(s.ledger.reserved) >= n, 'invalid_reservation_release');
    s.ledger.reserved = (BigInt(s.ledger.reserved) - n).toString();
  };
  const mint = (s, units) => {
    const n = positive(units);
    ensure(BigInt(s.ledger.reserved) >= n, 'mint_requires_reservation');
    s.ledger.reserved = (BigInt(s.ledger.reserved) - n).toString();
    s.ledger.minted = (BigInt(s.ledger.minted) + n).toString();
    s.ledger.transparent = (BigInt(s.ledger.transparent) + n).toString();
  };

  // central_fund.go:311-340 (centralFundReady)
  function fundReady(s, project) {
    const st = s.fundStates[project], config = s.configs[project], b = s.budgets[project];
    ensure(st && config && b, 'fund_manager_plan_not_qualified');
    ensure(st.approvedRevision > 0, 'fund_manager_plan_not_approved');
    if (st.revision !== st.approvedRevision) ensure(s.plans[project][st.revision].state === 'reject', 'pending_plan_amendment');
    const plan = s.plans[project][st.approvedRevision];
    ensure(active(s, config.evaluator) && config.evaluator !== b.manager && plan.manager === b.manager && plan.state === 'accept' &&
      plan.stages.length === 5 && plan.mainKpi.trim().length >= 20, 'fund_manager_plan_not_qualified');
  }
  // central_earning.go:471-490 (centralFund): allocation - paid - reserved must cover solver+reviewer.
  function fund(s, t, b) {
    const total = sum(t.solverAmount, t.reviewerAmount);
    ensure(BigInt(sum(b.paid, b.reserved, total)) <= BigInt(b.allocation), 'central_project_allocation_exceeded');
    reserve(s, total);
    b.reserved = sum(b.reserved, total);
    t.reserved = total;
  }

  return {
    enroll: (member) => tx((s) => {
      s.members[member] = { licence: 'active' };
    }),
    revoke: (member) => tx((s) => {
      ensure(s.members[member], 'member_missing');
      s.members[member].licence = 'revoked';
    }),
    createProject: ({ project, lead }) => tx((s) => {
      ensure(ID.test(project) && !s.projects[project], 'invalid_project');
      s.projects[project] = { id: project, lead, state: 'active', safetyHalted: false, participants: {} };
    }),
    join: ({ project, member }) => tx((s) => {
      ensure(s.projects[project] && active(s, member), 'invalid_join');
      s.projects[project].participants[member] = true;
    }),
    // central_earning.go:219-237: guardian or lead; active licensed manager; one budget per project.
    start: ({ actor, project, manager }) => tx((s) => {
      const p = s.projects[project];
      ensure(p && p.state === 'active' && !p.safetyHalted && active(s, manager) && (actor === guardian || actor === p.lead) && !s.budgets[project], 'invalid_central_project_start');
      s.budgets[project] = { project, manager, policy: POLICY, allocation: OPENING_UNITS, reserved: '0', paid: '0', round: 1, lifetimeCeiling: LIFETIME_UNITS, achieved: false, closed: false };
      s.fundStates[project] = { revision: 0, approvedRevision: 0, pending: '', completed: 0 };
      s.plans[project] = {};
    }),
    // central_fund.go:73-105: guardian appoints an active evaluator who is not the manager.
    configure: ({ actor, project, evaluator }) => tx((s) => {
      const b = s.budgets[project];
      ensure(b && actor === guardian && active(s, evaluator) && evaluator !== b.manager && !b.closed && s.configs[project]?.evaluator !== evaluator, 'invalid_central_fund_configure');
      s.configs[project] = { project, evaluator };
    }),
    // central_fund.go:158-194 (170-189): evaluator proposes; exactly 5 ordered stages; Main KPI >= 20 bytes and
    // unchanged after approval; criteria of already achieved stages are immutable.
    plan: ({ actor, project, revision, mainKpi, stages, reason }) => tx((s) => {
      const b = s.budgets[project], config = s.configs[project], st = s.fundStates[project];
      ensure(b && config && !b.closed && actor === config.evaluator && active(s, actor), 'invalid_central_fund_transition');
      ensure(typeof mainKpi === 'string' && mainKpi.trim().length >= 20 && Buffer.byteLength(mainKpi) <= 4096, 'invalid_main_kpi');
      ensure(st.pending === '' && revision === st.revision + 1 && Array.isArray(stages) && stages.length === 5 && typeof reason === 'string' && reason.trim().length >= 10, 'invalid_central_fund_plan');
      const previous = st.approvedRevision > 0 ? s.plans[project][st.approvedRevision] : null;
      ensure(!previous || previous.mainKpi === mainKpi, 'main_kpi_changed');
      stages.forEach((x, i) => {
        ensure(x.round === i + 1 && typeof x.criteria === 'string' && x.criteria.trim().length >= 20, 'invalid_central_fund_plan');
        if (i < st.completed) ensure(previous && previous.stages[i].criteria === x.criteria, 'achieved_stage_immutable');
      });
      s.plans[project][revision] = { project, revision, mainKpi, stages: structuredClone(stages), reason, manager: b.manager, state: 'proposed', reviewer: '' };
      st.revision = revision;
    }),
    // central_fund.go:195-230 (205-219)
    reviewPlan: ({ actor, project, revision, verdict }) => tx((s) => {
      const config = s.configs[project], st = s.fundStates[project], plan = s.plans[project]?.[revision];
      ensure(config && actor === config.evaluator && st.pending === '' && revision === st.revision && ['accept', 'reject'].includes(verdict), 'invalid_central_fund_transition');
      ensure(plan && plan.state === 'proposed' && plan.manager !== actor, 'invalid_central_fund_transition');
      plan.state = verdict;
      plan.reviewer = actor;
      if (verdict === 'accept') st.approvedRevision = revision;
      s.planReviews[`${project}/${pad(revision)}`] = { reviewer: actor, verdict };
    }),
    // central_earning.go:262 (task open refused when closed/achieved/not manager) + 471-490 (funding).
    openTask: ({ actor, id, project, criteria, solverAmount, reviewerAmount }) => tx((s) => {
      const b = s.budgets[project];
      ensure(b, 'central_project_missing');
      fundReady(s, project);
      ensure(!b.closed && !b.achieved && actor === b.manager && ID.test(id) && !s.tasks[id] && typeof criteria === 'string' && criteria.length > 0, 'invalid_central_task_open');
      positive(solverAmount);
      positive(reviewerAmount);
      const t = { id, project, criteria, acceptanceDigest: sha(criteria), solverAmount, reviewerAmount, state: 'open', pending: '', winner: '', reserved: '0', paid: '0' };
      fund(s, t, b);
      s.tasks[id] = t;
      return t;
    }),
    // central_earning.go:280-306 (299): re-fund a task that returned to open_unfunded after a reject.
    fundTask: ({ actor, task }) => tx((s) => {
      const t = s.tasks[task];
      ensure(t, 'central_task_missing');
      const b = s.budgets[t.project];
      fundReady(s, t.project);
      ensure(!b.closed && !b.achieved && actor === b.manager && t.state === 'open_unfunded' && t.pending === '' && t.winner === '' && t.reserved === '0', 'invalid_central_task_fund');
      fund(s, t, b);
      t.state = 'open';
    }),
    // central_earning.go:308-338 (329): joined participant, task open and exactly reserved, author != central reviewer.
    submit: ({ actor, id, task, evidence }) => tx((s) => {
      const t = s.tasks[task];
      ensure(t && s.projects[t.project]?.participants[actor] && active(s, actor), 'participation_required');
      ensure(ID.test(id) && !s.submissions[id] && t.state === 'open' && t.pending === '' && t.winner === '' && t.reserved === sum(t.solverAmount, t.reviewerAmount) && actor !== s.activation.reviewer, 'invalid_central_submit');
      s.submissions[id] = { id, task, author: actor, evidence, evidenceDigest: sha(evidence), state: 'under_review' };
      t.pending = id;
      t.state = 'under_review';
    }),
    // central_earning.go:340-469 (checks at :366).
    review: ({ actor, submission, verdict, executionId, criteriaDigest, evidenceDigest }) => tx((s) => {
      const v = s.submissions[submission];
      ensure(v, 'central_submission_missing');
      const t = s.tasks[v.task], b = s.budgets[t.project];
      // :366 the configured reviewer only, never the author; exact criteria/evidence digests.
      ensure(actor === s.activation.reviewer && actor !== v.author && t.state === 'under_review' && t.pending === v.id && v.state === 'under_review' &&
        criteriaDigest === t.acceptanceDigest && evidenceDigest === v.evidenceDigest && ID.test(executionId) && ['accept', 'reject', 'needs_evidence'].includes(verdict), 'invalid_central_review');
      // :369-372 one review per (submission, execution).
      const key = `${v.id}/${sha(executionId)}`;
      ensure(!s.reviews[key], 'duplicate_central_review');
      const r = { submission: v.id, verdict, criteriaDigest, evidenceDigest, executionId, reviewer: actor };
      // :375-377 needs_evidence is recorded but is not final: no payment, no state change.
      if (verdict === 'needs_evidence') {
        s.reviews[key] = r;
        return { awards: [] };
      }
      // :379 an accept needs an active author licence.
      ensure(s.members[v.author] && (verdict !== 'accept' || active(s, v.author)), 'invalid_central_review');
      const total = sum(t.solverAmount, t.reviewerAmount);
      ensure(t.reserved === total && BigInt(b.reserved) >= BigInt(total), 'invalid_central_review');
      // :388-403 accept mints both; reject mints the reviewer amount and releases the solver reservation.
      const paid = verdict === 'accept' ? total : t.reviewerAmount;
      mint(s, paid);
      if (verdict === 'reject') release(s, t.solverAmount);
      // :404-407 reviewer is paid on any final verdict; solver only on accept.
      const awards = [{ submission: v.id, task: t.id, project: t.project, member: actor, role: 'reviewer', amount: t.reviewerAmount }];
      if (verdict === 'accept') awards.push({ submission: v.id, task: t.id, project: t.project, member: v.author, role: 'solver', amount: t.solverAmount });
      for (const a of awards) ensure(!s.awards[`${a.role}/${v.id}`], 'duplicate_central_award');
      for (const a of awards) {
        s.awards[`${a.role}/${v.id}`] = a;
        s.balances[a.member] = sum(s.balances[a.member] ?? '0', a.amount);
        // central_earning.go:535-560 lifetime earnings index.
        const e = s.earnings[a.member] ?? { member: a.member, solver: '0', reviewer: '0', total: '0', awards: '0' };
        e[a.role] = sum(e[a.role], a.amount);
        e.total = sum(e.total, a.amount);
        e.awards = sum(e.awards, '1');
        s.earnings[a.member] = e;
      }
      // :431-442
      b.reserved = (BigInt(b.reserved) - BigInt(total)).toString();
      b.paid = sum(b.paid, paid);
      t.reserved = '0';
      t.paid = sum(t.paid, paid);
      t.pending = '';
      v.state = 'rejected';
      t.state = 'open_unfunded';
      if (verdict === 'accept') {
        t.winner = v.id;
        t.state = 'accepted';
        v.state = 'accepted';
      }
      s.reviews[key] = r;
      return { awards: structuredClone(awards) };
    }),
    // central_fund.go:231-252 (245): the manager applies for the next round against the approved revision.
    apply: ({ actor, id, project, round, revision, evidenceDigest }) => tx((s) => {
      const b = s.budgets[project], st = s.fundStates[project];
      ensure(b && !b.closed, 'invalid_central_fund_transition');
      fundReady(s, project);
      ensure(actor === b.manager && ID.test(id) && st.pending === '' && round <= 5 && !b.achieved && round === b.round && round === st.completed + 1 &&
        revision > 0 && revision === st.approvedRevision && HASH.test(evidenceDigest) && !s.applications[id], 'invalid_central_fund_apply');
      s.applications[id] = { id, project, round, revision, manager: actor, state: 'pending' };
      st.pending = id;
    }),
    // central_fund.go:253-286 (264, 267-276): evaluator (never the manager) decides; main_kpi_achieved must equal
    // (round 5 && accept); only accept unlocks the next cumulative allowance.
    decide: ({ actor, application, verdict, mainKpiAchieved, feedback }) => tx((s) => {
      const a = s.applications[application];
      ensure(a, 'central_fund_application_missing');
      const b = s.budgets[a.project], st = s.fundStates[a.project], config = s.configs[a.project];
      ensure(!b.closed && config && active(s, config.evaluator), 'invalid_central_fund_transition');
      ensure(typeof feedback === 'string' && feedback.trim().length >= 20 && mainKpiAchieved === (a.round === 5 && verdict === 'accept') &&
        actor === config.evaluator && actor !== a.manager && a.state === 'pending' && st.pending === application && a.round === b.round &&
        a.round === st.completed + 1 && a.revision === st.approvedRevision && ['accept', 'reject'].includes(verdict), 'invalid_central_fund_decide');
      if (verdict === 'accept') {
        b.round += 1;
        b.allocation = allocationForRound(b.round);
        if (a.round === 5) b.achieved = true;
        st.completed = a.round;
      }
      a.state = verdict;
      a.mainKpiAchieved = mainKpiAchieved;
      a.evaluator = actor;
      st.pending = '';
    }),
    // central_fund.go:288-300: close only after Main KPI achieved, round 6, and nothing reserved.
    close: ({ actor, project }) => tx((s) => {
      const b = s.budgets[project], st = s.fundStates[project], config = s.configs[project];
      ensure(b && config && actor === config.evaluator && !b.closed && b.achieved && b.round === 6 && st.completed === 5 && b.reserved === '0' && st.pending === '', 'invalid_central_fund_close');
      b.closed = true;
    }),
    budget: (project) => structuredClone(state.budgets[project] ?? null),
    task: (id) => structuredClone(state.tasks[id] ?? null),
    ledger: () => structuredClone(state.ledger),
    earnings: (member) => structuredClone(state.earnings[member] ?? null),
    balance: (member) => state.balances[member] ?? '0',
    fundState: (project) => structuredClone(state.fundStates[project] ?? null),
    /** Native-key-shaped records for one project, ALWAYS labelled as a fixture. */
    snapshot(project, { chainId = 'uain-fixture-genesis', height = '1' } = {}) {
      const s = state, records = {};
      const p = s.projects[project];
      if (p) records['project/' + project] = { id: project, lead: p.lead, state: p.state, safety_halted: p.safetyHalted };
      const b = s.budgets[project];
      if (b) records['central_project_budget/' + project] = { project, manager: b.manager, policy: b.policy, allocation: b.allocation, reserved: b.reserved, paid: b.paid, round: b.round, lifetime_ceiling: b.lifetimeCeiling, main_kpi_achieved: b.achieved, closed: b.closed };
      const st = s.fundStates[project];
      if (st) records['central_fund_state/' + project] = { revision: st.revision, approved_revision: st.approvedRevision, pending: st.pending, completed: st.completed };
      if (s.configs[project]) records['central_fund_config/' + project] = { project, evaluator: s.configs[project].evaluator };
      for (const plan of Object.values(s.plans[project] ?? {}))
        records[`central_fund_plan/${project}/${pad(plan.revision)}`] = { main_kpi: plan.mainKpi, project, revision: plan.revision, stages: plan.stages, reason: plan.reason, manager: plan.manager, state: plan.state, reviewer: plan.reviewer };
      records.central_earning_activation = { policy: s.activation.policy, reviewer: s.activation.reviewer };
      const members = new Set();
      for (const t of Object.values(s.tasks).filter((x) => x.project === project)) {
        records['central_task/' + t.id] = { id: t.id, project, criteria: t.criteria, acceptance_digest: t.acceptanceDigest, solver_amount: t.solverAmount, reviewer_amount: t.reviewerAmount, state: t.state, pending: t.pending, winner: t.winner, reserved: t.reserved, paid: t.paid };
        for (const v of Object.values(s.submissions).filter((x) => x.task === t.id)) {
          // Native CentralSubmission keeps the evidence inline (chain/federation/central_earning.go).
          records['central_submission/' + v.id] = { id: v.id, task: v.task, author: v.author, evidence: v.evidence, evidence_digest: v.evidenceDigest, state: v.state };
          for (const [key, r] of Object.entries(s.reviews).filter(([k]) => k.startsWith(v.id + '/')))
            records['central_review/' + key] = { submission: r.submission, verdict: r.verdict, criteria_digest: r.criteriaDigest, verification_digest: 'a'.repeat(64), execution_id: r.executionId, evidence_digest: r.evidenceDigest, reviewer: r.reviewer };
          for (const role of ['solver', 'reviewer']) {
            const a = s.awards[`${role}/${v.id}`];
            if (a) {
              records[`central_award/${role}/${v.id}`] = { ...a };
              members.add(a.member);
            }
          }
        }
      }
      for (const m of members) {
        records['central_earnings/' + m] = structuredClone(s.earnings[m]);
        records['coin_balance/' + m] = s.balances[m] ?? '0';
      }
      return { projectId: project, fixture: true, proof: { authority: 'native', fixture: true, finalized: true, chainId, height, appHash: sha(JSON.stringify(records)) }, records };
    },
  };
}

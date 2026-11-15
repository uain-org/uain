/** Read-only snapshot extraction shared with the operational adapter. The caller
 * supplies no custody capability. Evidence expansion is opt-in for the existing
 * adapter; the inspection composition supplies only reader.read. */
import { ADDRESS, NATIVE_ID, OrganizationError, need, plain, sha256, byText } from './common.mjs';
const planKey = (nativeId, revision) => `central_fund_plan/${nativeId}/${String(revision).padStart(20, '0')}`;
function withTimeout(promise, ms, code) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new OrganizationError(code)), ms); }),
  ]);
}
const codeOf = (error) => (error instanceof OrganizationError ? error.code : 'native_refused');

export function createFundSnapshotReader({ selection, reader, journal = null, chainId, now = () => Date.now(), timeoutMs = 30000, maxProofAgeMs = 120000 }) {
  function fresh(state) {
    need(plain(state) && state.chain_id === chainId && plain(state.records), 'invalid_native_proof');
    need(typeof state.height === 'string' && /^[1-9][0-9]{0,18}$/.test(state.height), 'invalid_native_proof');
    const age = now() - Date.parse(state.header_time);
    need(Number.isFinite(age) && age >= -60000 && age <= maxProofAgeMs, 'stale_native_proof');
    return state;
  }
  return Object.freeze({
    async snapshot(projectId, { evidence = false } = {}) {
      const project = selection.get(projectId);
      const P = project.nativeProjectId;
      const view = {
        projectId: project.id, nativeProjectId: P, fetchedAt: new Date(now()).toISOString(), available: false, height: null,
        project: null, budget: null, fundConfig: null, fundState: null, plan: null, approvedPlan: null, applications: null, tasks: null, error: null,
        proof: null, records: null, unread: [],
      };
      const records = {};
      const keep = (state, keys) => {
        need(state.chain_id === chainId, 'invalid_native_proof');
        for (const k of keys) if (plain(state.records[k])) records[k] = state.records[k];
      };
      const read = async (keys) => {
        const state = fresh(await withTimeout(reader.read({ member: null, keys }), timeoutMs, 'native_read_timeout'));
        keep(state, keys);
        return state;
      };
      try {
        const keys = [`project/${P}`, `central_project_budget/${P}`, `central_fund_config/${P}`, `central_fund_state/${P}`];
        // Discover dynamic keys, then fetch all decision prerequisites together.
        // Never combine a newer pending application with an older budget/plan.
        const discovered = fresh(await withTimeout(reader.read({ member: null, keys }), timeoutMs, 'native_read_timeout'));
        const binding = (state) => {
          const fund = state.records[keys[3]];
          return fund == null ? null : [fund.revision, fund.approved_revision, fund.completed, fund.pending];
        };
        const initial = binding(discovered);
        const dynamic = [];
        if (initial !== null) {
          const [revision, approved, , pending] = initial;
          need(Number.isSafeInteger(revision) && revision >= 0 && Number.isSafeInteger(approved) && approved >= 0 && typeof pending === 'string', 'invalid_native_proof');
          if (revision > 0) dynamic.push(planKey(P, revision));
          if (approved > 0 && approved !== revision) dynamic.push(planKey(P, approved));
          if (pending !== '') { need(NATIVE_ID.test(pending), 'invalid_native_proof'); dynamic.push(`central_fund_application/${pending}`); }
        }
        const selected = [...keys, ...dynamic];
        const state = dynamic.length > 0 ? await read(selected) : discovered;
        need(selected.every((key) => Object.hasOwn(state.records, key)), 'native_snapshot_incomplete');
        need(BigInt(state.height) >= BigInt(discovered.height) && JSON.stringify(binding(state)) === JSON.stringify(initial), 'native_snapshot_changed');
        if (dynamic.length === 0) keep(state, keys);
        Object.assign(view, {
          available: true, height: state.height, project: state.records[keys[0]] ?? null, budget: state.records[keys[1]] ?? null,
          fundConfig: state.records[keys[2]] ?? null, fundState: state.records[keys[3]] ?? null,
          proof: {
            authority: 'native', chainId: state.chain_id, height: state.height,
            appHash: typeof state.app_hash === 'string' && /^[A-Fa-f0-9]{64}$/.test(state.app_hash) ? state.app_hash : null,
            finalized: state.finalized === true || (typeof state.app_hash === 'string' && /^[A-Fa-f0-9]{64}$/.test(state.app_hash) && plain(state.signed_header)),
            // Keep the reader's own provenance (genesis, production pin) for acceptance;
            // finality still comes only from the evidence above.
            ...(plain(state.proof) ? { genesisSha256: state.proof.genesisSha256 ?? null, production: state.proof.production ?? null } : {}),
          },
        });
        const revision = view.fundState?.revision;
        const approved = view.fundState?.approved_revision;
        view.plan = revision > 0 ? state.records[planKey(P, revision)] ?? null : null;
        view.approvedPlan = approved > 0 ? state.records[planKey(P, approved)] ?? null : null;
        view.applications = view.fundState?.pending ? {
          [view.fundState.pending]: state.records[`central_fund_application/${view.fundState.pending}`],
        } : {};

      } catch (error) {
        Object.assign(view, { available: false, height: null, project: null, budget: null, fundConfig: null, fundState: null,
          plan: null, approvedPlan: null, applications: null, proof: null, error: codeOf(error) });
        return view;
      }
      if (typeof reader.tasks === 'function') {
        try {
          const tasks = await withTimeout(reader.tasks(P), timeoutMs, 'native_read_timeout');
          view.tasks = Array.isArray(tasks) && tasks.every((t) => plain(t) && t.project === P) ? tasks : null;
        } catch {
          view.tasks = null;
        }
      }
      if (!evidence) {
        view.records = records;
        view.unread = ['central_task/', 'central_submission/', 'central_review/', 'central_award/', 'central_earnings/', 'central_earning_activation'];
        return view;
      }
      const unread = new Set();
      if (view.tasks === null) unread.add('central_task/');
      for (const t of view.tasks ?? []) if (typeof t.id === 'string' && NATIVE_ID.test(t.id)) records[`central_task/${t.id}`] = t;
      // Submission IDs: those native names on the task, and this project's own confirmed submits.
      const ids = new Set();
      for (const t of view.tasks ?? []) for (const k of ['pending', 'winner']) if (typeof t[k] === 'string' && NATIVE_ID.test(t[k])) ids.add(t[k]);
      for (const i of journal.list({ projectId: project.id }))
        if (i.kind === 'native' && i.operation === 'central_submit' && i.state === 'confirmed' && NATIVE_ID.test(i.payload?.id ?? '')) ids.add(i.payload.id);
      const subs = [...ids].sort(byText);
      try {
        await read(['central_earning_activation', ...subs.flatMap((sid) => [`central_submission/${sid}`, `central_award/reviewer/${sid}`, `central_award/solver/${sid}`])]);
      } catch {
        for (const c of ['central_submission/', 'central_award/', 'central_earning_activation']) unread.add(c);
      }
      if (subs.length && typeof reader.reviews !== 'function') unread.add('central_review/');
      else for (const sid of subs) {
        try {
          const reviews = await withTimeout(reader.reviews(sid), timeoutMs, 'native_read_timeout');
          need(Array.isArray(reviews), 'invalid_native_proof');
          for (const r of reviews) if (plain(r) && r.submission === sid && typeof r.execution_id === 'string') records[`central_review/${sid}/${sha256(r.execution_id)}`] = r;
        } catch {
          unread.add('central_review/');
        }
      }
      const members = [...new Set(Object.entries(records).filter(([k, v]) => k.startsWith('central_award/') && ADDRESS.test(v.member ?? '')).map(([, v]) => v.member))].sort(byText);
      if (members.length) {
        try {
          await read(members.map((m) => `central_earnings/${m}`));
        } catch {
          unread.add('central_earnings/');
        }
      }
      view.records = records;
      view.unread = [...unread];
      return view;
    },
  });
}

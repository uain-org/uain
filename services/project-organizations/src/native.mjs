import { createFundSnapshotReader } from './fund-snapshot.mjs';
/** Project-scoped native adapter. It never holds keys: custody signs, the native
 * reader observes. Every mutation is authorized against the root-owned fleet policy
 * AND the runtime registry AND fresh native state, prepared in the durable journal
 * before any custody call, and its signed envelope retained before broadcast.
 * An unknown outcome is settled only by reconciliation; it is never re-signed. */
import {
  centralEarningSigningBytes,
  centralPayload,
  verifyCentralEnvelope,
} from '../../../apps/baink/server/central-earning-command.mjs';
import {
  BOOTSTRAP_OPERATIONS, checkBootstrapState, openProjectPayload, openProjectSigningBytes, participationKey, verifyOpenProjectEnvelope,
} from './bootstrap.mjs';
import {
  ADDRESS, NATIVE_ID, OrganizationError, UUID, canonical, digest, exactKeys, need, plain, refuse, sha256, units, byText,
} from './common.mjs';
import { definiteRejection } from './broadcast.mjs';

export const FLEET_POLICY_SCHEMA = 'uain-project-organization-fleet-policy-v1';
const ROLES = ['manager', 'evaluator', 'solver', 'guardian'];

/** Who native itself accepts as signer (chain/federation/central_fund.go,
 * central_earning.go, participation.go). The fleet policy may only narrow this. */
export const NATIVE_ROLE_OPERATIONS = Object.freeze({
  // Guardian bootstrap (keeper.go:453 open_project; central_earning.go:219; central_fund.go:73).
  // Reachable only with caller 'bootstrap' and the configured guardian; never from agents.
  guardian: Object.freeze(['open_project', 'central_project_start', 'central_fund_configure']),
  // Native: c.Member == budget.manager.
  manager: Object.freeze(['project_join', 'central_task_open', 'central_task_fund', 'central_fund_apply']),
  // Native: c.Member == fund config evaluator (plan proposal AND review), != manager.
  evaluator: Object.freeze(['central_fund_plan', 'central_fund_plan_review', 'central_fund_decide', 'central_fund_close']),
  // Native: any joined, licensed member other than the central reviewer.
  solver: Object.freeze(['project_join', 'central_submit']),
});
/** bootstrap.mjs GUARDIAN: the only manager a starter organization may share (pilot pattern). */
const STARTER_MANAGER = 'uain158ac8d0debcf01d43164ef14736597da589d8b54';
const PLAN_REVISION_OPS = new Set(['central_fund_plan', 'central_fund_plan_review', 'central_fund_apply']);
const EXPIRY_BLOCKS = 100n;
const PROJECT_FIELDS = ['native_project', 'source_digest', 'paperclip_company', 'manager', 'evaluator', 'max_task_units', 'max_plan_revision'];

/** Signing bytes / envelope check per operation; open_project is not a central command. */
const signingBytes = (command) => (command.operation === 'open_project' ? openProjectSigningBytes(command) : centralEarningSigningBytes(command));
const verifyEnvelope = (envelope, chainId, operation) => (operation === 'open_project'
  ? verifyOpenProjectEnvelope(envelope, { chainId })
  : verifyCentralEnvelope(envelope, { chainId, operations: [operation] }));
const CALLERS = ['agent', 'bootstrap'];

const planKey = (nativeId, revision) => `central_fund_plan/${nativeId}/${String(revision).padStart(20, '0')}`;

/** Validates the parsed root-owned fleet policy against the frozen selection. */
export function validateFleetPolicy(policy, selection) {
  need(exactKeys(policy, ['schema', 'revision', 'selection_digest', 'projects', 'roles', 'solvers']), 'invalid_fleet_policy');
  need(policy.schema === FLEET_POLICY_SCHEMA && Number.isSafeInteger(policy.revision) && policy.revision >= 1, 'invalid_fleet_policy');
  need(policy.selection_digest === selection.digest, 'fleet_policy_selection_drift');
  need(plain(policy.projects) && Object.keys(policy.projects).length > 0, 'invalid_fleet_policy');
  const managers = new Set();
  const companies = new Set();
  const evaluators = new Set();
  for (const [id, row] of Object.entries(policy.projects)) {
    need(selection.has(id), 'project_not_selected', `${id} is not in the frozen selection`);
    const p = selection.get(id);
    need(exactKeys(row, PROJECT_FIELDS), 'invalid_fleet_policy', `${id} binding is not exact`);
    need(row.native_project === p.nativeProjectId && row.source_digest === p.sourceDigest, 'fleet_policy_binding_mismatch', id);
    // Mirrors project_organizations.py: a starter organization may have no Paperclip company
    // yet (null) and the guardian as its budget manager, as the live pilot project does.
    const company = row.paperclip_company;
    need((company === null || UUID.test(company)) && ADDRESS.test(row.manager) && ADDRESS.test(row.evaluator), 'invalid_fleet_policy', id);
    need(row.manager !== row.evaluator, 'evaluator_is_manager', id);
    need((row.manager === STARTER_MANAGER || !managers.has(row.manager)) && (company === null || !companies.has(company)), 'duplicate_fleet_binding', id);
    managers.add(row.manager);
    if (company !== null) companies.add(company);
    evaluators.add(row.evaluator);
    units(row.max_task_units);
    need(Number.isSafeInteger(row.max_plan_revision) && row.max_plan_revision >= 1 && row.max_plan_revision <= 1000, 'invalid_fleet_policy', id);
  }
  for (const e of evaluators) need(!managers.has(e), 'evaluator_is_manager');
  need(exactKeys(policy.roles, ROLES), 'invalid_fleet_policy');
  for (const role of ROLES) {
    const ops = policy.roles[role];
    need(Array.isArray(ops) && new Set(ops).size === ops.length, 'invalid_fleet_policy', role);
    for (const op of ops) need(NATIVE_ROLE_OPERATIONS[role].includes(op), 'role_operation_not_native', `${role} cannot sign ${op}`);
  }
  need(Array.isArray(policy.solvers) && new Set(policy.solvers).size === policy.solvers.length, 'invalid_fleet_policy');
  for (const s of policy.solvers) need(ADDRESS.test(s) && !managers.has(s) && !evaluators.has(s), 'invalid_fleet_policy', 'solver overlaps a leadership key');
  return policy;
}

function withTimeout(promise, ms, code) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new OrganizationError(code)), ms); }),
  ]);
}
const codeOf = (error) => (error instanceof OrganizationError ? error.code : 'native_refused');

export function createNativeAdapter({
  custody, reader, registry, journal, selection, policy, chainId,
  owner = 'project-organizations-native', now = () => Date.now(), timeoutMs = 30000, maxProofAgeMs = 120000,
  guardian = null,
}) {
  need(typeof custody?.sign === 'function' && typeof reader?.read === 'function' && typeof reader?.broadcast === 'function' &&
    typeof reader?.findCommand === 'function', 'invalid_native_configuration');
  need(registry && journal && selection && typeof chainId === 'string' && chainId.length > 0, 'invalid_native_configuration');
  // `policy` may be a getter so a compare-and-swapped revision is observed.
  const currentPolicy = () => validateFleetPolicy(typeof policy === 'function' ? policy() : policy, selection);
  currentPolicy();
  // The fixed guardian (bootstrap.mjs GUARDIAN in production). Absent: bootstrap is unreachable.
  need(guardian === null || (typeof guardian === 'string' && ADDRESS.test(guardian)), 'invalid_native_configuration');

  /** Guardian-only bootstrap authority: fixed signer, selected and policy-bound project. */
  function bootstrapAuthority(projectId, operation, rawPayload, { signer } = {}) {
    need(guardian !== null, 'bootstrap_not_configured');
    const project = selection.get(projectId);
    const fleet = currentPolicy();
    const bound = fleet.projects[project.id];
    need(bound, 'project_not_in_fleet_policy', `${project.id} has no fleet policy binding`);
    need(BOOTSTRAP_OPERATIONS.includes(operation), 'bootstrap_is_guardian_only');
    need(fleet.roles.guardian.includes(operation), 'operation_not_allowed', `${operation} is not allowed for the guardian`);
    need(signer === undefined || signer === guardian, 'signer_not_authorized');
    const leadership = Object.values(fleet.projects).flatMap((row) => [row.manager, row.evaluator]);
    need(!leadership.includes(guardian) && !fleet.solvers.includes(guardian), 'guardian_overlaps_policy');
    let payload;
    try {
      payload = operation === 'open_project' ? openProjectPayload(rawPayload) : centralPayload(operation, rawPayload);
    } catch {
      refuse('invalid_native_payload', `${operation} payload refused`);
    }
    const binding = registry.get(project.id);
    need(bound.native_project === project.nativeProjectId, 'native_project_id_mismatch');
    need(binding.nativeProjectId === null || binding.nativeProjectId === project.nativeProjectId, 'native_project_id_mismatch');
    need(binding.sourceDigest === project.sourceDigest && bound.source_digest === project.sourceDigest, 'source_changed');
    const P = project.nativeProjectId;
    if (operation === 'open_project') need(payload.id === P, 'payload_project_mismatch');
    else need(payload.project === P, 'payload_project_mismatch');
    if (operation === 'central_project_start') need(payload.manager === bound.manager, 'manager_mismatch');
    if (operation === 'central_fund_configure') need(payload.evaluator === bound.evaluator && payload.expected_evaluator === '', 'evaluator_mismatch');
    return { project, bound, binding, fleet, role: 'guardian', signer: guardian, operation, payload, caller: 'bootstrap' };
  }

  const authorize = (projectId, operation, payload, { signer, caller = 'agent' } = {}) => {
    need(CALLERS.includes(caller), 'invalid_caller');
    if (caller === 'bootstrap') return bootstrapAuthority(projectId, operation, payload, { signer });
    return { ...authority(projectId, operation, payload, { signer }), caller: 'agent' };
  };

  /** Fresh guardian prerequisites; `reused` when native already holds the exact state. */
  async function bootstrapCheck(a) {
    const P = a.project.nativeProjectId;
    // project_metadata: compact storage keeps title/class/prior art there (bootstrap.mjs projectWithMetadata).
    const keys = [`project/${P}`, `project_metadata/${P}`, `central_project_budget/${P}`, `central_fund_config/${P}`, 'central_earning_activation',
      `member/${a.bound.manager}`, `member/${a.bound.evaluator}`];
    const state = fresh(await withTimeout(reader.read({ member: a.signer, keys }), timeoutMs, 'native_read_timeout'));
    need(plain(state.member) && typeof state.member.sequence === 'string', 'invalid_native_proof');
    const { reused } = checkBootstrapState({
      operation: a.operation, payload: a.payload, bound: a.bound, guardian, member: state.member, records: state.records, stateHeight: state.height,
    });
    return Object.assign(state, { reused });
  }
  const check = (a) => (a.caller === 'bootstrap' ? bootstrapCheck(a) : nativeCheck(a));
  const reusedResult = (a, state) => Object.freeze({
    state: 'reused', projectId: a.project.id, nativeProjectId: a.project.nativeProjectId, operation: a.operation, height: state.height,
  });

  /** Synchronous, model-independent authority: selection, policy, registry, payload. */
  function authority(projectId, operation, rawPayload, { signer } = {}) {
    const project = selection.get(projectId);
    const fleet = currentPolicy();
    const bound = fleet.projects[project.id];
    need(bound, 'project_not_in_fleet_policy', `${project.id} has no fleet policy binding`);
    need(!NATIVE_ROLE_OPERATIONS.guardian.includes(operation), 'guardian_operation_unreachable');
    const candidates = ['manager', 'evaluator', 'solver'].filter((r) => fleet.roles[r].includes(operation));
    need(candidates.length > 0, 'operation_not_allowed', `${operation} is not allowed for any agent role`);
    let payload;
    try {
      payload = centralPayload(operation, rawPayload);
    } catch {
      refuse('invalid_native_payload', `${operation} payload refused`);
    }
    const binding = registry.get(project.id);
    need(binding.nativeProjectId !== null, 'native_binding_missing');
    need(binding.nativeProjectId === project.nativeProjectId && bound.native_project === project.nativeProjectId, 'native_project_id_mismatch');
    need(binding.sourceDigest === project.sourceDigest && bound.source_digest === project.sourceDigest, 'source_changed');
    need(binding.paperclipCompanyId === null || binding.paperclipCompanyId === bound.paperclip_company, 'company_binding_mismatch');
    if (Object.hasOwn(payload, 'project')) need(payload.project === project.nativeProjectId, 'payload_project_mismatch');

    // Role follows the signer; leadership signers come from bindings, never the caller.
    const signerFor = { manager: bound.manager, evaluator: bound.evaluator };
    let role;
    if (signer === undefined) {
      const leaders = candidates.filter((r) => r !== 'solver');
      need(leaders.length === 1, 'signer_required');
      role = leaders[0];
    } else {
      need(typeof signer === 'string' && ADDRESS.test(signer), 'invalid_signer');
      role = candidates.find((r) => (r === 'solver' ? fleet.solvers.includes(signer) : signerFor[r] === signer));
      need(role, 'signer_not_authorized', `${signer} may not sign ${operation} for ${project.id}`);
    }
    const member = role === 'solver' ? signer : signerFor[role];
    if (role === 'manager') need(binding.nativeManager === bound.manager, 'manager_binding_mismatch');
    if (role === 'evaluator') need(binding.nativeEvaluator === bound.evaluator, 'evaluator_binding_mismatch');

    if (operation === 'central_task_open')
      need(BigInt(payload.solver_amount) + BigInt(payload.reviewer_amount) <= units(bound.max_task_units), 'amount_above_bound');
    if (PLAN_REVISION_OPS.has(operation)) need(payload.revision <= bound.max_plan_revision, 'plan_revision_above_bound');
    return { project, bound, binding, fleet, role, signer: member, operation, payload };
  }

  function keysFor(a) {
    const P = a.project.nativeProjectId;
    const keys = [`project/${P}`, `central_project_budget/${P}`, `central_fund_config/${P}`, `central_fund_state/${P}`];
    if (a.operation === 'project_join') keys.push(participationKey(P, a.signer));
    if (['central_task_fund', 'central_submit'].includes(a.operation)) keys.push(`central_task/${a.payload.task}`);
    if (a.operation === 'central_fund_decide') keys.push(`central_fund_application/${a.payload.application}`);
    if (a.operation === 'central_fund_plan_review') keys.push(planKey(P, a.payload.revision));
    return keys;
  }

  function fresh(state) {
    need(plain(state) && state.chain_id === chainId && plain(state.records), 'invalid_native_proof');
    need(typeof state.height === 'string' && /^[1-9][0-9]{0,18}$/.test(state.height), 'invalid_native_proof');
    const age = now() - Date.parse(state.header_time);
    need(Number.isFinite(age) && age >= -60000 && age <= maxProofAgeMs, 'stale_native_proof');
    return state;
  }

  /** Fresh authoritative prerequisites; refuses before any signature is requested. */
  async function nativeCheck(a) {
    const state = fresh(await withTimeout(reader.read({ member: a.signer, keys: keysFor(a) }), timeoutMs, 'native_read_timeout'));
    const r = state.records;
    const P = a.project.nativeProjectId;
    const m = state.member;
    need(plain(m) && m.id === a.signer && typeof m.sequence === 'string', 'invalid_native_proof');
    need(m.licence === 'active', 'member_licence_inactive');
    const project = r[`project/${P}`];
    need(plain(project) && project.id === P && project.state === 'active' && project.safety_halted === false, 'native_project_inactive');
    // participation.go:111-114: native refuses a second join of the same member/instance.
    if (a.operation === 'project_join') return Object.assign(state, { reused: plain(r[participationKey(P, a.signer)]) });

    const budget = r[`central_project_budget/${P}`];
    need(plain(budget) && budget.project === P && budget.closed !== true, 'native_budget_unavailable');
    need(budget.manager === a.bound.manager, 'native_manager_mismatch');
    const config = r[`central_fund_config/${P}`];
    const fund = r[`central_fund_state/${P}`] ?? null;
    if (a.role === 'evaluator') need(plain(config) && config.evaluator === a.bound.evaluator && config.evaluator !== budget.manager, 'native_evaluator_mismatch');
    if (a.role === 'solver') need(a.signer !== budget.manager && a.signer !== config?.evaluator, 'solver_is_leadership');
    const p = a.payload;
    switch (a.operation) {
      case 'central_task_open':
        need(budget.main_kpi_achieved !== true && budget.closed !== true && plain(fund) && fund.approved_revision >= 1 && fund.pending === '', 'plan_not_approved');
        break;
      case 'central_task_fund':
      case 'central_submit':
        need(r[`central_task/${p.task}`]?.project === P, 'payload_project_mismatch');
        break;
      case 'central_fund_plan':
        need((fund?.revision ?? 0) + 1 === p.revision && (fund?.pending ?? '') === '', 'plan_revision_mismatch');
        break;
      case 'central_fund_plan_review': {
        const plan = r[planKey(P, p.revision)];
        need(plain(fund) && fund.revision === p.revision && plain(plan) && plan.state === 'proposed', 'plan_revision_mismatch');
        need(plan.manager !== a.signer, 'self_approval');
        break;
      }
      case 'central_fund_apply':
        need(plain(fund) && fund.approved_revision === p.revision && fund.pending === '', 'plan_revision_mismatch');
        need(fund.completed + 1 === p.round && budget.round === p.round, 'milestone_round_mismatch');
        break;
      case 'central_fund_decide': {
        const application = r[`central_fund_application/${p.application}`];
        need(plain(application) && application.project === P, 'payload_project_mismatch');
        need(fund?.pending === p.application && application.state === 'pending', 'application_not_pending');
        need(application.manager !== a.signer, 'self_approval');
        break;
      }
      default:
        break;
    }
    return state;
  }

  const policyRevision = (fleet) => `policy:${fleet.revision}`;

  return {
    /** Authorizes and journals an intent. No custody call happens here. Guardian
     * bootstrap operations need `caller: 'bootstrap'`. When fresh native state already
     * holds exactly the intended result (an exact existing project, budget, evaluator or
     * participation) nothing is journaled and `{state: 'reused'}` is returned. */
    async prepare(projectId, operation, payload, { id, signer, caller = 'agent' } = {}) {
      const a = authorize(projectId, operation, payload, { signer, caller });
      const state = await check(a);
      if (state.reused === true) return reusedResult(a, state);
      return journal.prepare({
        id, projectId: a.project.id, kind: 'native', operation, payload: { ...a.payload },
        selectionDigest: selection.digest, sourceDigest: a.project.sourceDigest, signer: a.signer,
        expectedRevision: policyRevision(a.fleet),
      });
    },

    /** Claims the signer lane, signs through custody, retains, then broadcasts once. */
    async dispatch(intentId, { caller = 'agent' } = {}) {
      const before = journal.get(intentId);
      need(before, 'intent_not_found');
      if (before.state === 'confirmed') return { status: 'confirmed', intent: before };
      need(before.state === 'prepared', 'reconcile_required', `intent ${intentId} is ${before.state}`);
      // A guardian intent is signed only through the bootstrap caller, and that caller signs
      // nothing else. Refused before the claim, so the intent itself stays prepared.
      need(CALLERS.includes(caller), 'invalid_caller');
      need((caller === 'bootstrap') === BOOTSTRAP_OPERATIONS.includes(before.operation),
        caller === 'bootstrap' ? 'bootstrap_is_guardian_only' : 'guardian_operation_unreachable');
      const claimed = journal.claim(intentId, owner); // signer_lane_busy refuses here, intent stays prepared

      let a;
      let command;
      try {
        need(BOOTSTRAP_OPERATIONS.includes(claimed.operation) === (caller === 'bootstrap'), 'intent_authority_changed');
        a = authorize(claimed.projectId, claimed.operation, claimed.payload, { signer: claimed.signer, caller });
        need(a.signer === claimed.signer && digest({ ...a.payload }) === claimed.payloadHash, 'intent_authority_changed');
        need(claimed.selectionDigest === selection.digest && claimed.sourceDigest === a.project.sourceDigest, 'source_changed');
        need(claimed.expectedRevision === policyRevision(a.fleet), 'policy_revision_changed');
        const state = await check(a);
        // Satisfied since prepare (never signed): a definite refusal the orchestrator re-checks.
        need(state.reused !== true, 'native_already_satisfied');
        command = {
          version: 1, chain_id: chainId, member: a.signer, sequence: state.member.sequence,
          expires_height: String(BigInt(state.height) + EXPIRY_BLOCKS), operation: a.operation, payload: { ...a.payload },
        };
        signingBytes(command);
      } catch (error) {
        journal.fail(intentId, codeOf(error)); // never signed: a definite refusal
        throw error;
      }

      let envelope;
      try {
        envelope = await withTimeout(custody.sign(structuredClone(command), { projectId: a.project.id, role: a.role, intentId, caller: a.caller }), timeoutMs, 'custody_timeout');
        need(plain(envelope) && canonical(envelope.command) === canonical(command), 'custody_envelope_mismatch');
        verifyEnvelope(envelope, chainId, a.operation);
      } catch (error) {
        journal.markUnknown(intentId);
        throw error instanceof OrganizationError ? error : new OrganizationError('custody_outcome_unknown');
      }
      journal.recordEnvelope(intentId, envelope); // retained BEFORE broadcast
      let reply;
      try {
        reply = await withTimeout(reader.broadcast(envelope), timeoutMs, 'broadcast_timeout');
      } catch {
        // Transport error, JSON-RPC error ("tx already exists in cache"), timeout: unknown.
        return { status: 'unknown', intent: journal.markUnknown(intentId) };
      }
      const code = Number.isInteger(reply) ? reply : plain(reply) && Number.isInteger(reply.code) ? reply.code : null;
      if (code === 0) return { status: 'dispatched', code, intent: journal.get(intentId) };
      // A first-send CheckTx refusal of exactly these bytes (broadcast_tx_sync answers after
      // CheckTx; refused bytes are not in the mempool and not gossiped) fails the intent at
      // once and frees the signer lane. The failed intent is never reconciled, resent or
      // re-signed: further work is a NEW intent prepared from fresh native state.
      const definite = code !== null && code > 0 && plain(reply) ? definiteRejection(reply, { envelope }) : null;
      if (definite !== null) {
        const failed = journal.fail(intentId, definite.reason, { rejection: definite.rejection });
        return { status: 'failed', code, rejection: definite.rejection, intent: failed };
      }
      // Any other refusal (mempool full / cache, a resend, an untracked transport) or a reply
      // without a code says nothing definite: reconciliation settles it, by inclusion or expiry.
      return { status: 'unknown', ...(code !== null ? { code } : {}), intent: journal.markUnknown(intentId) };
    },

    /** Settles an open intent from authoritative native state. Never re-signs;
     * `rebroadcast` resends only the retained envelope, byte-identical. */
    async reconcile(intentId, { rebroadcast = false } = {}) {
      const intent = journal.get(intentId);
      need(intent, 'intent_not_found');
      if (['prepared', 'confirmed', 'failed'].includes(intent.state)) return { status: intent.state, intent };
      if (intent.envelope === null) {
        // Custody never returned a retained envelope, so nothing could be broadcast.
        const back = journal.reconcile(intentId, { found: false });
        return { status: back.state, intent: back };
      }
      const envelope = intent.envelope;
      const c = envelope.command;
      need(c.member === intent.signer && c.operation === intent.operation && digest(c.payload) === intent.payloadHash, 'retained_envelope_mismatch');
      verifyEnvelope(envelope, chainId, intent.operation);
      const commandDigest = sha256(signingBytes(c));
      const observation = await withTimeout(reader.findCommand({
        member: c.member, commandDigest, operation: c.operation, expiresHeight: c.expires_height,
        // The retained envelope lets the reader fetch a finalized gateway receipt for it.
        envelope: structuredClone(envelope),
      }), timeoutMs, 'native_read_timeout');
      need(plain(observation) && typeof observation.found === 'boolean', 'invalid_observation');
      if (observation.found) {
        const proof = observation.proof;
        need(plain(proof) && proof.authority === 'native' && proof.finalized === true && proof.chain_id === chainId &&
          proof.command_digest === commandDigest && proof.member === c.member && proof.operation === c.operation, 'proof_mismatch');
        const done = journal.reconcile(intentId, { found: true, proof });
        return { status: done.state, intent: done };
      }
      const expired = observation.expired === true;
      if (expired) need(typeof observation.height === 'string' && BigInt(observation.height) > BigInt(c.expires_height), 'invalid_observation');
      const after = journal.reconcile(intentId, { found: false, expired });
      if (after.state === 'unknown' && rebroadcast) {
        // Exactly the retained bytes: same command, sequence and signature.
        try {
          await withTimeout(reader.broadcast(JSON.parse(JSON.stringify(envelope)), { rebroadcast: true }), timeoutMs, 'broadcast_timeout');
        } catch {
          // The resend outcome is as unknown as the first; state already says so.
        }
        return { status: 'unknown', rebroadcast: true, intent: after };
      }
      return { status: after.state, intent: after };
    },

    /** Reader-fetched native view. Anything not read stays null (unknown).
     *
     * Besides the fund-worker view it carries the acceptance contract:
     * `proof` {authority:'native', chainId, height, appHash, finalized} of the base read and
     * `records` keyed by native store key (only records actually read). `finalized` is true
     * only when the reader marks the state finalized, or returns the gateway's committed
     * `app_hash` with its `signed_header`. With `{evidence: true}` it also reads this
     * project's tasks (`reader.tasks`), their submissions and awards, reviews
     * (`reader.reviews(submissionId)`), award members' lifetime earnings and the central
     * earning activation. Any class that could not be read is listed in `unread`, so a
     * consumer reports it unknown instead of missing. Reads may span consecutive heights;
     * `proof` cites the base read. */
    snapshot: createFundSnapshotReader({ selection, reader, journal, chainId, now, timeoutMs, maxProofAgeMs }).snapshot,
  };
}

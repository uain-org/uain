/** Fair, bounded fleet scheduler for leadership and solver jobs across the 120
 * selected organizations.
 *
 * One tick runs at most one job, fleet-wide: a journal slot lease serializes every
 * scheduler that shares the journal, and a per-task lease (`job:<taskId>`) plus an
 * immutable outcome record prevents a second run of the same task. The cursor is
 * persisted, so a restarted scheduler continues the round-robin where it stopped.
 *
 * A run is discarded (held) when the pinned source or the task criteria change
 * before or after it, when its lease is lost, or when the evidence is not a
 * bounded canonical object. Completed solver evidence becomes a prepared
 * `central_submit` intent; only a confirmed native proof reads as `submitted`.
 *
 * Attempt key. A leadership job is keyed by project, task and criteria. A solver job is
 * keyed by project, task, criteria, the solver and the task's native FUNDING EPOCH, read
 * through `jobs.fundingEpoch(projectId, taskId)` (see `fundingEpochOf`): native
 * `central_task_fund` (chain/federation/central_earning.go) re-funds a task only from
 * `open_unfunded`, which a reject reaches after adding the reviewer award to `paid`, so
 * `paid` names one funded epoch. Another solver may attempt the same epoch, and any solver
 * (native allows the earlier author too) may attempt a re-funded one, but one solver never
 * runs twice on one funded epoch. A task that is not open for submissions has no solver
 * work; a run whose epoch moved on is discarded and held for that key. */
import { lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, readdirSync, realpathSync, renameSync, writeSync } from 'node:fs';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ADDRESS, CATALOGUE_ID, HASH, NATIVE_ID, OrganizationError, canonical, need, plain, sha256, text } from './common.mjs';

export const JOB_KINDS = Object.freeze(['leadership', 'solver']);
export const OUTCOMES = Object.freeze(['completed', 'blocked', 'failed']);
/** Native `central_submit` carries the evidence text inline and refuses more than 16 KiB. */
export const EVIDENCE_MAX_BYTES = 16384;
const SLOT_LEASE = 'scheduler:slot';
const SLOT_MARGIN_MS = 60000;
const CURSOR_SCHEMA = 'uain-scheduler-cursor-v1';
const SKIP = Symbol('skip');
const ABORTED = Symbol('aborted');
const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

/** The funding epoch of a native `central_task` record, or null when the task does not take
 * a submission now (not `open`, a pending submission or winner, or not fully reserved).
 * The epoch is the task's `paid` units: zero for the opening funding, and strictly larger
 * after every reject (each pays the reviewer) that precedes a `central_task_fund`. */
export function fundingEpochOf(task) {
  if (!plain(task) || task.state !== 'open' || (task.pending ?? '') !== '' || (task.winner ?? '') !== '') return null;
  if (![task.paid, task.reserved, task.solver_amount, task.reviewer_amount].every((v) => typeof v === 'string' && DECIMAL.test(v))) return null;
  if (BigInt(task.reserved) === 0n || BigInt(task.reserved) !== BigInt(task.solver_amount) + BigInt(task.reviewer_amount)) return null;
  return task.paid;
}

function writeFileAtomic(path, body) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
/** Immutable record: the first writer wins; a different second value is a conflict. */
function writeOnce(path, value) {
  const body = JSON.stringify(value) + '\n';
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return value;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return JSON.parse(readFileSync(path, 'utf8'));
  }
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function validJob(job, projectId) {
  if (!plain(job) || job.projectId !== projectId) return 'job_project_mismatch';
  if (typeof job.taskId !== 'string' || !NATIVE_ID.test(job.taskId)) return 'invalid_task_id';
  if (!JOB_KINDS.includes(job.kind)) return 'invalid_job_kind';
  if (typeof job.criteriaDigest !== 'string' || !HASH.test(job.criteriaDigest)) return 'invalid_criteria_digest';
  if (job.kind === 'solver' && (typeof job.solver !== 'string' || !ADDRESS.test(job.solver))) return 'invalid_solver';
  const required = job.requiredCapabilities ?? [];
  if (!Array.isArray(required) || required.length > 32 || !required.every((c) => typeof c === 'string' && CAPABILITY.test(c)))
    return 'invalid_required_capabilities';
  return null;
}

/** Returns `{evidence, bytes}` or a refusal reason; the artifact is never trusted further. */
function checkEvidence(artifact, maxBytes) {
  if (!plain(artifact)) return { reason: 'evidence_not_object' };
  let bytes;
  try {
    bytes = canonical(artifact);
  } catch {
    return { reason: 'evidence_not_canonical' };
  }
  if (Buffer.byteLength(bytes) > maxBytes) return { reason: 'evidence_oversize' };
  return { evidence: JSON.parse(bytes), bytes };
}

export function createScheduler({
  selection, registry, journal, executor, native, budget, jobs, sources,
  workspaceRoot, stateDirectory, owner = `scheduler-${process.pid}-${randomUUID().slice(0, 8)}`,
  limits = {}, clock = () => Date.now(),
}) {
  need(selection?.ids?.length === 120 && typeof selection.get === 'function' && HASH.test(selection.digest ?? ''), 'invalid_scheduler_configuration', 'selection');
  need(typeof registry?.get === 'function', 'invalid_scheduler_configuration', 'registry');
  need(['acquireLease', 'releaseLease', 'lease', 'get'].every((f) => typeof journal?.[f] === 'function'), 'invalid_scheduler_configuration', 'journal');
  need(typeof executor?.run === 'function' && typeof native?.prepare === 'function', 'invalid_scheduler_configuration', 'executor/native');
  need(typeof budget?.reserve === 'function' && typeof budget.settle === 'function', 'invalid_scheduler_configuration', 'budget');
  need(typeof jobs?.next === 'function' && typeof jobs.criteriaDigest === 'function' && typeof sources?.digest === 'function',
    'invalid_scheduler_configuration', 'jobs/sources');
  need(typeof workspaceRoot === 'string' && typeof stateDirectory === 'string' && text(owner, 1, 96) && typeof clock === 'function',
    'invalid_scheduler_configuration');
  const { concurrency = 1, leaseMs = 30 * 60000, evidenceMaxBytes = EVIDENCE_MAX_BYTES, abortGraceMs = 2000 } = limits;
  need(concurrency === 1, 'unsupported_concurrency', 'fleet inference concurrency is one');
  need(Number.isInteger(leaseMs) && leaseMs >= 1000 && leaseMs <= 86400000 - SLOT_MARGIN_MS, 'invalid_scheduler_configuration', 'leaseMs');
  need(Number.isInteger(evidenceMaxBytes) && evidenceMaxBytes > 0 && evidenceMaxBytes <= EVIDENCE_MAX_BYTES, 'invalid_scheduler_configuration');
  need(Number.isInteger(abortGraceMs) && abortGraceMs >= 0 && abortGraceMs <= 60000, 'invalid_scheduler_configuration', 'abortGraceMs');

  for (const d of ['projects', 'outcomes', 'submissions', 'evidence']) mkdirSync(join(stateDirectory, d), { recursive: true, mode: 0o700 });
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  const root = realpathSync(workspaceRoot);
  const ids = selection.ids;
  const iso = () => new Date(clock()).toISOString();
  const cursorPath = join(stateDirectory, 'cursor.json');
  const statusPath = (projectId) => join(stateDirectory, 'projects', `${projectId}.json`);
  const keyOf = (job, epoch) => sha256(job.kind === 'solver'
    ? `${job.projectId}\0${job.taskId}\0${job.criteriaDigest}\0solver:${job.solver}\0epoch:${epoch}`
    : `${job.projectId}\0${job.taskId}\0${job.criteriaDigest}`);
  const outcomePath = (key) => join(stateDirectory, 'outcomes', `${key}.json`);
  const submissionPath = (key) => join(stateDirectory, 'submissions', `${key}.json`);
  const evidencePath = (d) => join(stateDirectory, 'evidence', `${d}.json`);
  let stopped = false;
  let running = false;
  let current = null;

  function readCursor() {
    const c = readJson(cursorPath);
    if (!c) return 0;
    need(c.schema === CURSOR_SCHEMA && c.selectionDigest === selection.digest, 'scheduler_selection_drift');
    need(Number.isInteger(c.next) && c.next >= 0 && c.next < ids.length, 'scheduler_cursor_invalid');
    return c.next;
  }
  const writeCursor = (next) => writeFileAtomic(cursorPath, JSON.stringify({ schema: CURSOR_SCHEMA, selectionDigest: selection.digest, next }) + '\n');
  const record = (job, state, extra = {}) => {
    const row = {
      projectId: job.projectId, state, taskId: job.taskId ?? null, kind: job.kind ?? null,
      criteriaDigest: job.criteriaDigest ?? null, ...(job.kind === 'solver' ? { solver: job.solver, fundingEpoch: job.fundingEpoch ?? null } : {}),
      at: iso(), ...extra,
    };
    writeFileAtomic(statusPath(job.projectId), JSON.stringify(row) + '\n');
    return row;
  };

  /** Workspace is <root>/<projectId>/tasks/<taskId>; any resolved path outside the project is refused. */
  function workspaceFor(projectId, taskId) {
    need(CATALOGUE_ID.test(projectId) && NATIVE_ID.test(taskId), 'workspace_escape');
    const projectDir = join(root, projectId);
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    const info = lstatSync(projectDir);
    need(info.isDirectory() && !info.isSymbolicLink(), 'workspace_escape', 'project workspace is not a plain directory');
    const workspace = join(projectDir, 'tasks', taskId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const real = realpathSync(workspace);
    need(real.startsWith(projectDir + sep), 'workspace_escape', 'task workspace resolves outside its project');
    return real;
  }

  async function sourceUnchanged(projectId) {
    const pinned = selection.get(projectId).sourceDigest;
    if (registry.get(projectId).sourceDigest !== pinned) return false;
    return (await sources.digest(projectId)) === pinned;
  }
  const criteriaUnchanged = async (job) => (await jobs.criteriaDigest(job.projectId, job.taskId)) === job.criteriaDigest;
  /** Native funding epoch of a solver job's task: a decimal string, null (no submission is
   * possible now) or SKIP-worthy refusal `invalid`. Leadership jobs have none. */
  async function epochOf(job) {
    if (job.kind !== 'solver') return { epoch: null };
    if (typeof jobs.fundingEpoch !== 'function') return { invalid: 'funding_epoch_unavailable' };
    const epoch = await jobs.fundingEpoch(job.projectId, job.taskId);
    if (epoch === null || epoch === undefined) return { closed: true };
    return typeof epoch === 'string' && DECIMAL.test(epoch) ? { epoch } : { invalid: 'invalid_funding_epoch' };
  }
  const epochUnchanged = async (job) => job.kind !== 'solver' || (await epochOf(job)).epoch === job.fundingEpoch;

  async function capabilities() {
    const c = typeof executor.capabilities === 'function' ? await executor.capabilities() : executor.capabilities ?? [];
    return new Set(c);
  }

  /** Idempotent: a retained completed outcome is resubmitted under the same
   * submission and intent IDs with the same canonical evidence bytes. */
  async function submit(job, key, outcome) {
    const evidence = canonical(JSON.parse(readFileSync(evidencePath(outcome.evidenceDigest), 'utf8')));
    need(sha256(evidence) === outcome.evidenceDigest, 'evidence_store_corrupt');
    const payload = { id: `sub-${key.slice(0, 48)}`, task: job.taskId, evidence, evidence_digest: outcome.evidenceDigest };
    let intent;
    try {
      intent = await native.prepare(job.projectId, 'central_submit', payload, { id: `submit-${key.slice(0, 48)}`, signer: job.solver });
      need(plain(intent) && typeof intent.id === 'string' && NATIVE_ID.test(intent.id), 'invalid_native_intent');
    } catch (e) {
      return record(job, 'submission_pending', { reason: e?.code ?? 'native_prepare_failed', evidenceDigest: outcome.evidenceDigest });
    }
    const marker = writeOnce(submissionPath(key), { intentId: intent.id, at: iso() });
    return record(job, 'submission_prepared', { evidenceDigest: outcome.evidenceDigest, intentId: marker.intentId });
  }

  async function execute(job, key, lease) {
    const { projectId, taskId, criteriaDigest } = job;
    if (!(await sourceUnchanged(projectId))) return record(job, 'held', { reason: 'source_changed' });
    if (!(await criteriaUnchanged(job))) {
      writeOnce(outcomePath(key), { ...job, outcome: 'held', reason: 'criteria_changed', at: iso() });
      return record(job, 'held', { reason: 'criteria_changed' });
    }
    const have = await capabilities();
    const missing = (job.requiredCapabilities ?? []).filter((c) => !have.has(c));
    if (missing.length) return record(job, 'blocked', { reason: 'missing_capability', missingCapabilities: missing });
    let workspace;
    try {
      workspace = workspaceFor(projectId, taskId);
    } catch (e) {
      if (e instanceof OrganizationError) return record(job, 'held', { reason: e.code });
      throw e;
    }
    const reservation = budget.reserve({ purpose: job.kind, projectIds: [projectId], model: executor.model ?? 'unspecified' });
    if (reservation.paused) return { paused: reservation.paused, ...record(job, 'paused', { reason: `compute_budget_${reservation.paused}` }) };
    record(job, 'running', { attempt: lease.attempt });

    const controller = new AbortController();
    current = controller;
    let settled = false;
    const aborted = new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve(ABORTED), { once: true }));
    const timer = setTimeout(() => controller.abort(new Error('lease_deadline')), Math.max(0, lease.expiresAt - clock()));
    let result;
    let error = null;
    let run;
    try {
      run = Promise.resolve().then(() => executor.run(
        // submissionId and author are what the artifact must name for verification (verification.mjs screenArtifact).
        { projectId, taskId, criteriaDigest, workspace, leaseId: `${lease.key}#${lease.attempt}`,
          ...(job.kind === 'solver' ? { submissionId: `sub-${key.slice(0, 48)}`, author: job.solver } : {}) },
        { signal: controller.signal },
      )).finally(() => { settled = true; });
      result = await Promise.race([run, aborted]);
    } catch (e) {
      error = e;
    } finally {
      clearTimeout(timer);
      current = null;
    }
    // A worker that lost its lease writes nothing more: the successor owns the task's state.
    const owned = () => journal.lease(lease.key)?.owner === owner;
    if (result === ABORTED || controller.signal.aborted) {
      // Cost is unknown: the reservation stays counted. An executor that does not
      // honour the abort within the grace period keeps the lease until expiry.
      if (!settled) await Promise.race([run.catch(() => {}), new Promise((r) => setTimeout(r, abortGraceMs))]);
      if (!settled) lease.keep = true;
      const reason = stopped ? 'stopped' : 'lease_deadline';
      if (!owned()) return { projectId, taskId, state: 'held', reason: 'lease_lost' };
      return record(job, stopped ? 'cancelled' : 'held', { reason });
    }
    const usage = plain(result?.usage) ? result.usage : {};
    if (!error) budget.settle(reservation.id, { costUsd: usage.costUsd, stopReason: typeof usage.stopReason === 'string' ? usage.stopReason : null });

    if (!owned()) return { projectId, taskId, state: 'held', reason: 'lease_lost' };
    if (journal.lease(lease.key).expiresAt <= clock()) return record(job, 'held', { reason: 'lease_lost' });
    if (!(await sourceUnchanged(projectId))) return record(job, 'held', { reason: 'source_changed', discarded: true });
    if (!(await criteriaUnchanged(job))) {
      writeOnce(outcomePath(key), { ...job, outcome: 'held', reason: 'criteria_changed', at: iso() });
      return record(job, 'held', { reason: 'criteria_changed', discarded: true });
    }

    let outcome;
    if (error) outcome = { outcome: 'failed', reason: 'executor_error' };
    else if (!plain(result) || !OUTCOMES.includes(result.outcome)) outcome = { outcome: 'failed', reason: 'invalid_executor_result' };
    else if (result.outcome === 'blocked') {
      outcome = text(result.missingCapability, 1, 128) && CAPABILITY.test(result.missingCapability)
        ? { outcome: 'blocked', reason: 'missing_capability', missingCapabilities: [result.missingCapability] }
        : { outcome: 'failed', reason: 'invalid_executor_result' };
    } else if (result.outcome === 'failed') {
      outcome = { outcome: 'failed', reason: text(result.reason, 1, 200) ? result.reason : 'executor_failed' };
    } else {
      const checked = checkEvidence(result.evidenceArtifact, evidenceMaxBytes);
      if (checked.reason) outcome = { outcome: 'failed', reason: checked.reason };
      else {
        const evidenceDigest = sha256(checked.bytes);
        writeOnce(evidencePath(evidenceDigest), checked.evidence);
        outcome = { outcome: 'completed', evidenceDigest, sourceDigest: selection.get(projectId).sourceDigest };
      }
    }
    // `actual` is the executor's own declaration (a fixture executor never is); the run was
    // bounded by this scheduler's lease deadline, task workspace and compute reservation.
    if (!(await epochUnchanged(job))) {
      writeOnce(outcomePath(key), { ...job, outcome: 'held', reason: 'funding_epoch_changed', at: iso() });
      return record(job, 'held', { reason: 'funding_epoch_changed', discarded: true });
    }

    const stored = writeOnce(outcomePath(key), {
      ...job, ...outcome, attempt: lease.attempt, leaseId: `${lease.key}#${lease.attempt}`,
      actual: executor.actual === true && executor.fixture !== true, bounded: true, at: iso(),
    });
    if (stored.outcome === 'completed' && job.kind === 'solver') return submit(job, key, stored);
    const state = stored.outcome === 'completed' ? 'completed' : stored.outcome;
    const { reason, missingCapabilities, evidenceDigest } = stored;
    return record(job, state, { reason, missingCapabilities, evidenceDigest });
  }

  async function turn(projectId) {
    let job = await jobs.next(projectId);
    if (job === null || job === undefined) return SKIP;
    const invalid = validJob(job, projectId);
    if (invalid) return record({ projectId }, 'failed', { reason: invalid });
    if (job.fundingEpoch !== undefined) return record({ projectId }, 'failed', { reason: 'job_sets_funding_epoch' });
    const funding = await epochOf(job);
    if (funding.invalid) return record({ projectId }, 'failed', { reason: funding.invalid });
    if (funding.closed) return SKIP; // the task takes no submission now (under review, unfunded, decided)
    if (job.kind === 'solver') job = { ...job, fundingEpoch: funding.epoch };
    const key = keyOf(job, funding.epoch);
    const pendingSubmission = (o) => o?.outcome === 'completed' && job.kind === 'solver' && !readJson(submissionPath(key));
    const prior = readJson(outcomePath(key));
    if (prior && !pendingSubmission(prior)) return SKIP;
    const lease = journal.acquireLease(`job:${job.taskId}`, owner, leaseMs);
    if (!lease) return SKIP;
    try {
      const outcome = readJson(outcomePath(key));
      if (outcome) return pendingSubmission(outcome) ? await submit(job, key, outcome) : SKIP;
      return await execute(job, key, lease);
    } finally {
      if (!lease.keep) journal.releaseLease(lease.key, owner);
    }
  }

  return {
    async tick() {
      if (stopped) return { state: 'stopped' };
      if (running) return { state: 'busy' };
      if (!journal.acquireLease(SLOT_LEASE, owner, leaseMs + SLOT_MARGIN_MS)) return { state: 'busy' };
      running = true;
      try {
        const start = readCursor();
        for (let step = 0; step < ids.length; step++) {
          if (stopped) return { state: 'stopped' };
          const index = (start + step) % ids.length;
          const result = await turn(ids[index]);
          if (result === SKIP) continue;
          // A paused or cancelled project keeps its turn; everything else advances the cursor.
          if (journal.lease(SLOT_LEASE)?.owner === owner) writeCursor(result.paused || result.state === 'cancelled' ? index : (index + 1) % ids.length);
          return result;
        }
        return { state: 'idle' };
      } finally {
        running = false;
        journal.releaseLease(SLOT_LEASE, owner);
      }
    },
    stop() {
      stopped = true;
      current?.abort(new Error('stopped'));
    },
    /** Immutable executed attempts for one project in the acceptance `workerAttempts` shape. */
    attempts(projectId) {
      const id = selection.get(projectId).id;
      const names = readdirSync(join(stateDirectory, 'outcomes')).filter((n) => /^[a-f0-9]{64}\.json$/.test(n));
      need(names.length <= 100000, 'scheduler_outcomes_unbounded');
      const out = [];
      for (const name of names.sort()) {
        const o = readJson(join(stateDirectory, 'outcomes', name));
        if (!plain(o) || o.projectId !== id || !OUTCOMES.includes(o.outcome) || typeof o.leaseId !== 'string') continue;
        out.push({
          attemptId: `${name.slice(0, 64)}#${o.attempt}`, projectId: id, taskId: o.taskId, kind: o.kind, leaseId: o.leaseId,
          actual: o.actual === true, bounded: o.bounded === true, outcome: o.outcome, finishedAt: o.at,
          evidenceDigest: o.evidenceDigest ?? null, reason: o.reason ?? null,
        });
      }
      return out;
    },
    /** Durable per-project status. `submitted` only when the native intent is confirmed with a proof. */
    status(projectId) {
      const id = selection.get(projectId).id;
      const row = readJson(statusPath(id)) ?? { projectId: id, state: 'idle' };
      const computePaused = typeof budget.status === 'function' ? budget.status().paused : null;
      if (row.state === 'running') {
        const lease = journal.lease(`job:${row.taskId}`);
        if (!lease || lease.expiresAt <= clock()) return { ...row, state: 'interrupted', computePaused };
      }
      if (row.intentId) {
        const intent = journal.get(row.intentId);
        const intentState = intent?.state ?? 'unknown';
        const state = intentState === 'confirmed' && intent.receipt ? 'submitted' : intentState === 'failed' ? 'submission_failed' : 'submission_prepared';
        return { ...row, state, intentState, computePaused };
      }
      return { ...row, computePaused };
    },
  };
}

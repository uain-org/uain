#!/usr/bin/env node
/** Project agents driver (Rahul, 9 November 2026). Root-only, run by uain-project-agents.timer every
 * minute (`tick`). Each tick:
 *   1. reads proven native events since its cursor through the fleet custody CLI (read-only `status`)
 *      and maps joins, submissions and review results to their project organization;
 *   2. wakes each project with new activity (after a short cooldown), or, as a fallback, a project
 *      that has had no run for `fallback_hours` while it is short of open units;
 *   3. for a woken project short of `target_open` accepting units, runs its two Sonnet agents in the
 *      isolated house-solver unit: the project manager proposes units, the fixed record API resolves
 *      every identifier, and the separate task assessor accepts or rejects each unit;
 *   4. writes accepted units as one new survey-part revision: the task policies under
 *      /etc/uain-custody/task-policies and then `<project>.agent-r<N>.parts.json` beside the starter
 *      authority, both root-only. The organization starter opens them from the project's allowance.
 * It signs nothing, holds no key, opens no task and never reviews; every run is recorded under
 * /var/lib/uain-custody/project-agents/runs/.
 *
 *   check   validate config, state and inputs; no model call, no write
 *   tick    one run as above
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { GUARDIAN } from '../src/bootstrap.mjs';
import { SURVEY_HOSTS } from '../src/survey-sources.mjs';
import { buildAgentPartPayloads } from '../src/survey.mjs';
import { createRetriever, driverDigest, surveyRecords } from '../src/verification.mjs';
import { FUND_MANAGER } from './starter-authority.mjs';
import { preflightRow } from './survey-parts.mjs';
import {
  MAX_UNITS_PER_RUN, PROJECT_AGENT_MODEL, activityFromEvents, assessorPrompt, executionsAdmitted, nextRevision, parseAssessor, parseWriter,
  projectStock, receiptDigest, resolvedUnits, unitsNeeded, wakeOrder, writerPrompt,
} from '../src/project-agents.mjs';

export const CONFIG = '/etc/uain-custody/project-agents/config.json';
export const STATE_DIR = '/var/lib/uain-custody/project-agents';
export const AUTHORITY_DIR = '/etc/uain-custody/organization-starter';
export const POLICIES = '/etc/uain-custody/task-policies';
export const FLEET_ROOT = '/var/lib/uain-custody/project-organizations';
const CUSTODY = ['/opt/uain-custody/venv/bin/python', '-I', '/opt/uain-custody/project_organizations.py'];
const NODE = '/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin/node';
// Its own root-owned release, so the agents never change the attester's or the manager's closure.
const RELEASE = '/opt/uain-project-agents/current';
const CONFIG_SCHEMA = 'uain-project-agents-config-v1';
const STATE_SCHEMA = 'uain-project-agents-state-v1';
const EVENTS_PER_TICK = 512;
/** Minutes between full stock scans of every project (the daily fallback reads them). */
const SCAN_MINUTES = 30;
const DOCS = new URL('../../../docs/baink/project-organizations-2026-11-06/', import.meta.url);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pad = (n) => String(n).padStart(20, '0');
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const need = (v, code) => { if (!v) fail(code); };

async function protectedJson(path, { optional = false } = {}) {
  let fd;
  try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  try {
    const s = await fd.stat();
    need(s.isFile() && s.uid === 0 && !(s.mode & 0o022) && s.size > 0 && s.size <= 2 * 1024 * 1024, 'untrusted_file');
    for (let d = dirname(path); d !== '/'; d = dirname(d)) { const m = await stat(d); need(m.uid === 0 && !(m.mode & 0o022), 'untrusted_parent'); }
    return JSON.parse(await fd.readFile('utf8'));
  } finally { await fd.close(); }
}

/** Write once (or replace, for state) through an fsynced temp file and rename; root-only 0600. */
async function writePrivate(path, value, { replace = false } = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  if (!replace) {
    const existing = await lstat(path).catch(() => null);
    if (existing) { need((await readFile(path, 'utf8')) === body, 'file_conflict'); return; }
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(body); await fd.sync(); } finally { await fd.close(); }
  await rename(temp, path);
}

export function validateConfig(c) {
  need(c && c.schema === CONFIG_SCHEMA && Object.keys(c).sort().join(',') ===
    'cooldown_minutes,fallback_hours,max_executions_per_day,max_projects_per_run,schema,target_open', 'invalid_agent_config');
  need(Number.isSafeInteger(c.target_open) && c.target_open >= 1 && c.target_open <= 6, 'invalid_agent_config');
  need(Number.isSafeInteger(c.max_projects_per_run) && c.max_projects_per_run >= 1 && c.max_projects_per_run <= 10, 'invalid_agent_config');
  need(Number.isSafeInteger(c.max_executions_per_day) && c.max_executions_per_day >= 2 && c.max_executions_per_day <= 1000, 'invalid_agent_config');
  need(Number.isSafeInteger(c.cooldown_minutes) && c.cooldown_minutes >= 1 && c.cooldown_minutes <= 1440, 'invalid_agent_config');
  need(Number.isSafeInteger(c.fallback_hours) && c.fallback_hours >= 1 && c.fallback_hours <= 168, 'invalid_agent_config');
  return c;
}

function run(cmd, args, input, { timeoutMs = 600000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/root' } });
    let out = '', err = '', size = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(new Error('timeout'), { code: 'child_timeout' })); }, timeoutMs);
    child.stdout.on('data', (b) => { size += b.length; if (size > maxBytes) child.kill('SIGKILL'); else out += b; });
    child.stderr.on('data', (b) => { if (err.length < 4096) err += b; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.end(input ?? '');
  });
}

/** Proven native records through the fleet custody CLI, 10 keys per call: its proved answer is
 * bounded to 64 KiB and a task record is up to about 5 KiB. */
export const READ_CHUNK = 10;
export async function nativeRead(keys, { exec = run } = {}) {
  const records = {};
  let head = null;
  for (let i = 0; i < Math.max(1, keys.length); i += READ_CHUNK) {
    const chunk = keys.length ? keys.slice(i, i + READ_CHUNK) : ['central_task_count'];
    const r = await exec(CUSTODY[0], [...CUSTODY.slice(1), 'status', JSON.stringify(chunk)], '');
    const line = r.out.trim().split('\n').at(-1);
    let result; try { result = JSON.parse(line); } catch { fail('native_unread'); }
    need(r.code === 0 && result?.status === 'read' && result.records && typeof result.records === 'object', 'native_unread');
    if (head === null) head = result.event_count ?? null;
    Object.assign(records, result.records);
  }
  return { records, eventCount: head };
}

/** Whether the request (or a retry of it) finalized, from the custody journals the starter reads. */
async function finalizedIntent(project, intent) {
  for (const id of [intent, ...[2, 3, 4, 5].map((n) => `${intent}-r${n}`)]) {
    try {
      const j = JSON.parse(await readFile(join(FLEET_ROOT, project, id + '.json'), 'utf8'));
      if (j && j.receipt) return true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

/** The records a project's full survey lists, from its root policy, when that survey was opened
 * (a v1 project: OPP-00002/03/09/10/14); [] for a parts-first project, which has no full survey. */
export async function surveyCovered(project, dir = POLICIES, read = protectedJson) {
  const policy = await read(join(dir, `T-${project}-1-prior-art-survey.json`), { optional: true });
  if (!policy) return [];
  need(policy.class === 'prior_art_survey' && policy.taskId === `T-${project}-1-prior-art-survey` && Array.isArray(policy.successTests?.[0]?.requiredIds), 'invalid_survey_policy');
  return policy.successTests[0].requiredIds;
}

/** Every built part file of a project: the reviewed `<p>.parts.json` (when installed) and agent revisions. */
export async function partFiles(project, dir = AUTHORITY_DIR, read = protectedJson) {
  const names = (await readdir(dir)).filter((n) => n === `${project}.parts.json` || new RegExp(`^${project}\\.agent-r[3-9]\\.parts\\.json$`).test(n)).sort();
  return Promise.all(names.map((n) => read(join(dir, n))));
}

function systemdArgs(executionId, release) {
  need(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(executionId), 'invalid_execution');
  return ['--quiet', '--wait', '--pipe', '--collect', '--service-type=exec', '--unit=uain-project-agent-' + sha(executionId).slice(0, 32),
    ...['User=uain-house-solver', 'Group=uain-house-solver', 'EnvironmentFile=/etc/uain-broker/claude.env', 'Environment=HOME=/var/lib/uain-house-solver/home',
      'WorkingDirectory=/var/lib/uain-house-solver', 'StateDirectory=uain-house-solver', 'StateDirectoryMode=0700', 'UMask=0077',
      'ProtectProc=invisible', 'ProcSubset=pid', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'PrivateDevices=yes', 'NoNewPrivileges=yes',
      'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectControlGroups=yes', 'RestrictSUIDSGID=yes', 'LockPersonality=yes', 'CapabilityBoundingSet=',
      'RestrictAddressFamilies=AF_INET AF_INET6', 'BindReadOnlyPaths=/opt/uain-broker/claude/2.1.310/claude:/var/lib/uain-house-solver/claude',
      'ReadWritePaths=/var/lib/uain-house-solver',
      'InaccessiblePaths=-/opt/uain-broker -/etc/uain-broker -/var/lib/uain-broker -/etc/uain-custody -/var/lib/uain-custody -/opt/uain-custody -/run/uain-broker -/run/uain-custody -/run/user -/var/lib/uain-wallets -/var/lib/uain-native -/root -/home',
      'RuntimeMaxSec=660', 'TimeoutStopSec=5', 'KillMode=control-group', 'MemoryMax=2G', 'TasksMax=128'].map((v) => '--property=' + v),
    NODE, join(release, 'services/project-organizations/ops/project-agent-runtime.mjs')];
}

/** One isolated Sonnet execution. Returns {value, receipt}. */
export async function execute({ role, projectId, prompt }, { exec = run, release } = {}) {
  const executionId = `pa-${projectId}-${role}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const r = await exec('/usr/bin/systemd-run', systemdArgs(executionId, release), JSON.stringify({ role, projectId, executionId, prompt }), { timeoutMs: 680000 });
  let answer; try { answer = JSON.parse(r.out.trim().split('\n').at(-1)); } catch { answer = null; }
  need(r.code === 0 && answer?.schema === 'uain-project-agent-execution-v1' && answer.model === PROJECT_AGENT_MODEL && answer.role === role, 'agent_execution_failed');
  const receipt = { executionId, role, projectId, model: PROJECT_AGENT_MODEL, startedAt, finishedAt: new Date().toISOString(),
    promptDigest: sha(prompt), answerDigest: sha(JSON.stringify(answer.value)), metadata: answer.metadata };
  return { value: answer.value, receipt };
}

async function preflightUnits(units, retriever) {
  const items = units.flatMap((u) => u.records.map((r) => ({ kind: r.kind, id: r.id })));
  if (!items.length) return [];
  const records = await surveyRecords({ items }, retriever ?? createRetriever({
    allowedHosts: [...SURVEY_HOSTS], maxBytes: 2 * 1024 * 1024, timeoutMs: 20000,
    headers: { 'user-agent': 'uain-project-agents-preflight/1 (+https://uain.global)', accept: 'application/json, application/atom+xml;q=0.9' },
  }));
  const byKey = new Map(records.map((r) => [`${r.kind}:${r.id}`, r]));
  return items.map((r) => preflightRow(r.kind, r.id, byKey.get(`${r.kind}:${r.id}`)));
}

/** Run one woken project's two agents; returns the run record (and writes the new revision). */
export async function runProject(project, { ctx, config, stock, activity, deps }) {
  const { selection, catalogue } = ctx;
  const p = selection.get(project);
  const row = catalogue.records.get(project);
  // A short project gets a full revision of MAX_UNITS_PER_RUN units, not just the shortfall: part ids
  // allow only revisions r3..r9, so one-unit revisions ran out within hours on the most used projects
  // (OPP-00004 reached r7 on 9 November 2026). Extra units are simply more open work.
  const short = unitsNeeded(stock, config.target_open);
  const needed = short > 0 ? MAX_UNITS_PER_RUN : 0;
  const base = { schema: 'uain-project-agents-run-v1', project, at: new Date(deps.now()).toISOString(), activity, stock: { ...stock, covered: stock.covered.length }, short, needed };
  if (needed === 0) return { ...base, outcome: 'stock_full', executions: [] };
  const revision = nextRevision(stock);
  if (revision === null) return { ...base, outcome: 'revisions_exhausted', executions: [] };
  const executions = [];
  const writer = await deps.execute({ role: 'writer', projectId: project,
    prompt: writerPrompt({ projectId: project, title: row.title, description: row.description, mainKpi: p.mainKpi, stock, needed, activity }) });
  executions.push(writer.receipt);
  const proposed = parseWriter(writer.value, { covered: stock.covered, needed });
  const checked = await deps.preflight(proposed.units);
  const units = resolvedUnits(proposed.units, checked);
  if (!units.length) return { ...base, outcome: 'no_resolvable_units', note: proposed.note, preflight: checked, executions };
  const assessor = await deps.execute({ role: 'assessor', projectId: project, prompt: assessorPrompt({ projectId: project, title: row.title, mainKpi: p.mainKpi, units, covered: stock.covered }) });
  executions.push(assessor.receipt);
  const accepted = parseAssessor(assessor.value, units.length).map((n) => units[n - 1]);
  if (!accepted.length) return { ...base, outcome: 'assessor_rejected_all', verdicts: assessor.value.verdicts, preflight: checked, executions };
  const source = { revision: catalogue.revision, row: structuredClone(row) };
  const reviewed = JSON.parse(await readFile(new URL(`bootstrap-reviewed/${project}.json`, DOCS), 'utf8'));
  const draft = JSON.parse(await readFile(new URL(`bootstrap-drafts/${project}.json`, DOCS), 'utf8'));
  const built = buildAgentPartPayloads({ projectId: project, selection, source, draft, reviewed, driverSha256: driverDigest('prior-art-survey'), revision,
    units: accepted.map((u) => u.records.map(({ kind, id }) => ({ kind, id }))), covered: stock.covered,
    agents: { writer: receiptDigest(writer.receipt), assessor: receiptDigest(assessor.receipt) } });
  const file = {
    schema: 'uain-survey-parts-build-v1', project, revision, supersedes: built.supersedes, dropped: [],
    parts: built.parts.map(({ payload, evidence, policy }) => ({
      request: { id: `survey-${project}-r${revision}-p${evidence.part}`, member: GUARDIAN, operation: 'central_task_open', payload }, evidence, policy })),
  };
  // Policies first, then the parts file: the starter never sees a part without its policy.
  for (const part of file.parts) await deps.write(join(deps.policies, part.policy.taskId + '.json'), part.policy);
  await deps.write(join(deps.authorityDir, `${project}.agent-r${revision}.parts.json`), file);
  return { ...base, outcome: 'written', revision, tasks: file.parts.map((x) => x.request.payload.id), verdicts: assessor.value.verdicts, preflight: checked, executions };
}

async function loadState(path) {
  const s = await protectedJson(path, { optional: true });
  if (!s) return { schema: STATE_SCHEMA, cursor: null, projects: {}, executions: [] };
  need(s.schema === STATE_SCHEMA && typeof s.projects === 'object' && Array.isArray(s.executions), 'invalid_agent_state');
  return s;
}

export async function tick({ exec = run, now = () => Date.now(), check = false } = {}) {
  need(process.getuid() === 0, 'root_required');
  const config = validateConfig(await protectedJson(CONFIG));
  const order = await protectedJson(join(AUTHORITY_DIR, 'order.json'));
  const projects = order.parts ?? [];
  const statePath = join(STATE_DIR, 'state.json');
  await mkdir(join(STATE_DIR, 'runs'), { recursive: true, mode: 0o700 });
  const state = await loadState(statePath);
  // Native head and new events.
  const head = await nativeRead([], { exec });
  need(typeof head.eventCount === 'string' && /^[0-9]+$/.test(head.eventCount), 'event_count_unread');
  const count = Number(head.eventCount);
  if (state.cursor === null) state.cursor = count; // start at the head: never replay history
  const until = Math.min(count, state.cursor + EVENTS_PER_TICK);
  const keys = [];
  for (let n = state.cursor + 1; n <= until; n++) keys.push(`event/${pad(n)}`);
  const events = keys.length ? Object.values((await nativeRead(keys, { exec })).records).filter(Boolean) : [];
  // A submission's and a review's subject is the submission id: resolve it to its task.
  const reviews = [...new Set(events.filter((e) => ['central_submit', 'central_review'].includes(e.operation)).map((e) => e.subject))];
  const submissions = reviews.length ? (await nativeRead(reviews.map((s) => 'central_submission/' + s), { exec })).records : {};
  const submissionTask = new Map(reviews.map((s) => [s, submissions['central_submission/' + s]?.task]));
  const activity = activityFromEvents(events, { projects, ownMembers: [GUARDIAN, FUND_MANAGER], submissionTask });
  for (const [p, list] of activity) {
    state.projects[p] ??= {};
    state.projects[p].pendingActivity = [...(state.projects[p].pendingActivity ?? []), ...list].slice(-32);
  }
  // Stock: every project only on the periodic fallback scan, otherwise only projects with activity.
  // Each proved read runs the native proof reader against the node the public pilot also reads, so
  // reading every part each minute starved public reads (9 November 2026).
  const scanDue = !(now() - (state.lastScan ?? 0) < SCAN_MINUTES * 60000);
  const withActivity = projects.filter((p) => activity.has(p) || (state.projects[p]?.pendingActivity ?? []).length);
  const reading = scanDue ? projects : withActivity;
  const files = new Map();
  for (const p of reading) files.set(p, await partFiles(p));
  const taskIds = [...files.values()].flat().flatMap((f) => f.parts.map((x) => x.request.payload.id));
  const records = taskIds.length ? Object.fromEntries(Object.entries((await nativeRead(taskIds.map((t) => 'central_task/' + t), { exec })).records).map(([k, v]) => [k.slice(13), v])) : {};
  const stocks = new Map();
  for (const p of reading) {
    const opened = new Set();
    for (const f of files.get(p)) for (const x of f.parts) if (await finalizedIntent(p, x.request.id)) opened.add(x.request.id);
    stocks.set(p, projectStock(p, files.get(p), opened, records, { surveyCovered: await surveyCovered(p) }));
  }
  if (scanDue) { state.lastScan = now(); state.short = projects.filter((p) => unitsNeeded(stocks.get(p), config.target_open) > 0); }
  const short = new Set((state.short ?? []).filter((p) => !stocks.has(p) || unitsNeeded(stocks.get(p), config.target_open) > 0));
  const woken = wakeOrder({ projects, activity, state: state.projects, short, now: now(), cooldownMinutes: config.cooldown_minutes, fallbackHours: config.fallback_hours })
    .filter((w) => stocks.has(w.project)).slice(0, config.max_projects_per_run);
  const report = { schema: 'uain-project-agents-tick-v1', cursor: until, head: count, events: events.length, scanned: scanDue,
    activity: Object.fromEntries([...activity].map(([p, l]) => [p, l.length])), woken: woken.map((w) => w.project), runs: [] };
  if (check) return { ...report, check: true };
  const release = await realpath(RELEASE);
  const [ctxSelection, catalogue] = [await loadSelection(), catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))))];
  for (const { project, reason } of woken) {
    const needed = unitsNeeded(stocks.get(project), config.target_open);
    if (needed > 0 && !executionsAdmitted(state.executions, 2, { maxPerDay: config.max_executions_per_day, now: now() })) {
      report.runs.push({ project, reason, outcome: 'execution_budget_exhausted' });
      break;
    }
    const pending = state.projects[project]?.pendingActivity ?? [];
    let record;
    try {
      record = await runProject(project, { ctx: { selection: ctxSelection, catalogue }, config, stock: stocks.get(project), activity: pending,
        deps: { now, execute: (a) => execute(a, { exec, release }), preflight: (u) => preflightUnits(u), write: (path, v) => writePrivate(path, v),
          policies: POLICIES, authorityDir: AUTHORITY_DIR } });
    } catch (error) {
      record = { schema: 'uain-project-agents-run-v1', project, at: new Date(now()).toISOString(), activity: pending, outcome: 'failed', code: error.code ?? 'error' };
    }
    record.reason = reason;
    for (const e of record.executions ?? []) state.executions.push(Date.parse(e.startedAt));
    state.executions = state.executions.filter((t) => t > now() - 24 * 3600 * 1000);
    state.projects[project] = { lastRun: now(), lastOutcome: record.outcome, pendingActivity: [] };
    await writePrivate(join(STATE_DIR, 'runs', `${new Date(now()).toISOString().replace(/[:.]/g, '')}-${project}.json`), record, { replace: true });
    report.runs.push({ project, reason, outcome: record.outcome, tasks: record.tasks, executions: (record.executions ?? []).length });
  }
  state.cursor = until;
  await writePrivate(statePath, state, { replace: true });
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const [command] = process.argv.slice(2);
  try {
    need(['tick', 'check'].includes(command), 'usage');
    process.stdout.write(JSON.stringify(await tick({ check: command === 'check' })) + '\n');
  } catch (error) {
    process.stderr.write(`project agents refused: ${error.code ?? 'error'} ${error.message ?? ''}\n`);
    process.exitCode = 1;
  }
}

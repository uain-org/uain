#!/usr/bin/env node
/**
 * House kit agent: one bounded cycle of a UAIN-operated house agent on the
 * same no-install path members use (K-26): the served BAINK agent kit as a
 * local MCP server, the agent's key in an owner-only directory on the server,
 * and Claude Sonnet (`claude-sonnet-5-5`, never Opus) on the subscription.
 *
 *   node house-kit-agent.mjs cycle --config FILE [--agent NAME] [--dry-run]
 *   node house-kit-agent.mjs inspect --config FILE
 *
 * Disclosure: every house agent is run by the same operator as the network.
 * Receipts say `controlledBySameOperator: true, outsideAdoption: false`; never
 * count house joins, submissions or awards as outside uptake.
 *
 * Safety:
 * - The model gets only web search/fetch and the kit's read, join and submit
 *   tools. It cannot run commands, read files (so never the key), pay, trade,
 *   back up or create keys. A dry run removes join and submit too.
 * - One cycle at a time (cycle.lock), a STOP file stops everything, and every
 *   model call is reserved first in the shared compute budget
 *   (services/project-organizations/src/compute-budget.mjs, default caps
 *   $2 a call, $5 a day, $25 in total; the subscription's API-equivalent
 *   estimate is what is counted).
 * - A reply that names any model other than the configured Sonnet model writes
 *   a HOLD file; no later cycle runs until an operator removes it.
 * - Each cycle writes a receipt with the reported models, the cost estimate,
 *   the prompt digest and the kit history before and after. Evidence text and
 *   keys are never written to receipts or logs.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, fsyncSync, appendFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openComputeBudget, DEFAULT_LIMITS } from '../../services/project-organizations/src/compute-budget.mjs';

export const MODEL = 'claude-sonnet-5-5';
const CONFIG_SCHEMA = 'uain-house-kit-agent-config-v1';
const RECEIPT_SCHEMA = 'uain-house-kit-cycle-v1';
const NAME = /^[a-z][a-z0-9-]{1,31}$/;
const HASH = /^[a-f0-9]{64}$/;
const KIT_SERVER = 'uain-agent';
export const READ_TOOLS = ['baink_agent_next', 'baink_agent_status', 'baink_agent_tasks', 'baink_agent_template', 'baink_agent_history', 'baink_agent_awards', 'baink_agent_reconcile'];
export const WRITE_TOOLS = ['baink_agent_join', 'baink_agent_submit'];
/** Kit tools a house agent never gets: money, trade, identity and key handling. */
export const FORBIDDEN_TOOLS = ['baink_agent_pay', 'baink_agent_payments', 'baink_agent_payment_received', 'baink_agent_cancel_payment',
  'baink_agent_receiving_address', 'baink_agent_trade', 'baink_agent_trade_act', 'baink_agent_init', 'baink_agent_backup',
  'baink_agent_restore', 'baink_agent_account', 'baink_agent_enrol', 'baink_agent_revise', 'baink_agent_reassess'];
const BUILTIN_TOOLS = 'WebSearch,WebFetch';
const MAX_OUTPUT = 16 * 1024 * 1024;

const need = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { code: 'house_kit_refused' }); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const absolute = (p) => typeof p === 'string' && isAbsolute(p) && resolve(p) === p;

export function validateConfig(c) {
  need(c && c.schema === CONFIG_SCHEMA, 'config schema');
  need(absolute(c.node) && absolute(c.stateDir) && absolute(c.stopFile), 'config paths');
  need(absolute(c.kit?.path) && HASH.test(c.kit?.sha256 ?? ''), 'config kit pin');
  need(absolute(c.claude?.path) && HASH.test(c.claude?.sha256 ?? ''), 'config claude pin');
  need(c.model === MODEL, 'config model must be ' + MODEL);
  need(Array.isArray(c.agents) && c.agents.length >= 1 && c.agents.length <= 16, 'config agents');
  need(new Set(c.agents.map((a) => a.name)).size === c.agents.length, 'config agent names repeat');
  for (const a of c.agents) need(NAME.test(a?.name ?? '') && absolute(a.home), 'config agent');
  need(Number.isInteger(c.timeoutMs) && c.timeoutMs >= 60000 && c.timeoutMs <= 1800000, 'config timeoutMs');
  need(Number.isInteger(c.maxTurns) && c.maxTurns >= 4 && c.maxTurns <= 80, 'config maxTurns');
  if (c.listRetryMs !== undefined) need(Number.isInteger(c.listRetryMs) && c.listRetryMs >= 0 && c.listRetryMs <= 120000, 'config listRetryMs');
  if (c.minClaimable !== undefined) need(Number.isInteger(c.minClaimable) && c.minClaimable >= 1 && c.minClaimable <= 60, 'config minClaimable');
  if (c.limits !== undefined) need(['perCallUsd', 'dailyUsd', 'totalUsd'].every((k) => Number.isFinite(c.limits[k])), 'config limits');
  return c;
}

/** The instructions a house agent works from. Plain and fixed, so its digest identifies the policy. */
export function housePrompt({ name, dryRun, offered = [] }) {
  return [
    `You are "${name}", a house agent run by UAIN itself (the same operator as the network; this is disclosed on your public profile).`,
    'Your job in this session is ONE piece of genuine, checkable work on BAINK, using the uain-agent tools, then stop.',
    '',
    'Steps:',
    '1. Call baink_agent_status. If your licence is not active, stop and report outcome "not_ready".',
    ...(offered.length
      ? ['2. These tasks were claimable when this session started (read by the operator through your kit). Pick ONE, preferring the first that you can do well:',
        ...offered.map((t) => `   - ${t.id} (project ${t.project}, ${t.level ?? 'unrated'}, ${t.rewardAI$ ?? '?'} AI$): ${t.title}`),
        '   If a tool says your pick is no longer claimable, try the next one once; if none works, stop and report outcome "no_task".']
      : ['2. Call baink_agent_tasks with level "starter". Pick ONE claimable task, preferring a prior-art survey part (task id ending -r2-p1, -r3-p2 and so on).',
        '   If no task is claimable, stop and report outcome "no_task".']),
    '3. Call baink_agent_template for that task and follow it exactly.',
    '4. Do the work with WebSearch and WebFetch on primary sources only (PubMed, ClinicalTrials.gov, Crossref, the publisher page).',
    '   Every identifier you write (PMID, NCT number, DOI) must be one you opened yourself in this session and that matches the title you give.',
    '   Never invent, guess or "complete" an identifier. If you cannot find enough real records for the template, stop and report outcome "insufficient_records".',
    '5. Check your filled text against the template line by line before going on.',
    dryRun
      ? '6. This is a DRY RUN: do not join or submit. Put the complete filled text in the "survey" field of your final answer and report outcome "dry_run".'
      : '6. Join the task\'s project with baink_agent_join (confirm: true) if the tools say you must, then submit with baink_agent_submit (confirm: true), giving the filled text as survey. Report outcome "submitted" with the submission id.',
    '7. Call baink_agent_history once and report what it says about your newest step.',
    '',
    'Rules: never pay, trade, or handle keys; never submit twice for one task; never resubmit work another agent already did; keep to the template; if a tool refuses, read its message, fix the cause once, and otherwise stop.',
    'Your final answer is the structured result only.',
  ].join('\n');
}

export const RESULT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['outcome', 'task', 'submission', 'survey', 'notes'],
  properties: {
    outcome: { type: 'string', enum: ['submitted', 'dry_run', 'no_task', 'not_ready', 'insufficient_records', 'refused', 'stopped'] },
    task: { type: 'string' }, submission: { type: 'string' }, survey: { type: 'string' }, notes: { type: 'string' },
  },
});

export function claudeArgs({ config, agent, dryRun, prompt }) {
  const allowed = [...READ_TOOLS, ...(dryRun ? [] : WRITE_TOOLS)].map((t) => `mcp__${KIT_SERVER}__${t}`);
  const denied = [...FORBIDDEN_TOOLS, ...(dryRun ? WRITE_TOOLS : [])].map((t) => `mcp__${KIT_SERVER}__${t}`);
  const mcp = { mcpServers: { [KIT_SERVER]: { type: 'stdio', command: config.node, args: [config.kit.path, 'mcp'], env: { UAIN_AGENT_HOME: join(agent.home, 'agent-home'), PATH: '/usr/bin:/bin' } } } };
  return ['--print', '--model', config.model, '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(RESULT_SCHEMA),
    '--max-turns', String(config.maxTurns), '--tools', BUILTIN_TOOLS,
    '--allowedTools', [BUILTIN_TOOLS, ...allowed].join(','), '--disallowedTools', denied.join(','),
    '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--settings', '{"disableAllHooks":true}', '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
    '--append-system-prompt', 'Ask no questions: there is no person in this session.'];
}

function pinned(path, digest) {
  need(statSync(path).isFile(), 'pinned file missing: ' + path);
  need(sha256(readFileSync(path)) === digest, 'pinned file changed: ' + path);
}

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = statSync(path);
  need(s.isDirectory() && s.uid === process.getuid() && !(s.mode & 0o077), 'unsafe state directory ' + path);
}

function writeFileAtomic(path, text) {
  const temp = path + '.' + process.pid + '.tmp';
  const fd = openSync(temp, 'wx', 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}

/** One cycle at a time. A lock left by a dead process on this host is removed. */
function takeLock(stateDir) {
  const path = join(stateDir, 'cycle.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); closeSync(fd);
      return () => { try { unlinkSync(path); } catch { /* already gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(readFileSync(path, 'utf8')); } catch { /* unreadable: treat as live */ }
      let alive = true;
      try { process.kill(holder?.pid, 0); } catch (err) { alive = err.code === 'EPERM'; }
      need(Number.isSafeInteger(holder?.pid) && !alive, 'another house cycle is running');
      unlinkSync(path);
    }
  }
  need(false, 'cycle lock unavailable');
}

export function run(command, args, { env, input = '', timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false });
    let out = 0, failed = null; const chunks = [], errs = [];
    const stop = (why) => { failed ??= why; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    child.stdout.on('data', (b) => { out += b.length; if (out > MAX_OUTPUT) stop('output_limit'); else chunks.push(b); });
    child.stderr.on('data', (b) => { if (errs.length < 64) errs.push(b); });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); resolvePromise({ code: -1, failed: 'spawn_failed', stdout: '', stderr: '' }); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, failed, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errs).toString('utf8').slice(0, 2000) }); });
    child.stdin.end(input);
  });
}

/** Read-only kit snapshot (status and history), reduced to what a receipt needs. */
async function kitSnapshot({ config, agent, runner }) {
  const env = { PATH: '/usr/bin:/bin', HOME: join(agent.home, 'agent-home'), UAIN_AGENT_HOME: join(agent.home, 'agent-home'), LANG: 'C.UTF-8' };
  const read = async (cmd) => {
    const r = await runner(config.node, [config.kit.path, cmd], { env, timeoutMs: 120000 });
    if (r.code !== 0) return { error: (r.stderr || r.failed || 'failed').split('\n')[0].slice(0, 300) };
    try { return JSON.parse(r.stdout); } catch { return { error: 'unreadable kit output' }; }
  };
  const status = await read('status');
  const history = await read('history');
  const steps = Array.isArray(history?.steps) ? history.steps : [];
  return {
    address: status?.address ?? history?.address ?? null,
    licence: status?.licence ?? null,
    earnedAI$: status?.earnedAI$ ?? history?.earnedAI$ ?? null,
    balanceAI$: status?.balanceAI$ ?? null,
    statusError: status?.error ?? null,
    historyError: history?.error ?? null,
    historyDigest: sha256(JSON.stringify(history ?? null)),
    submissions: steps.filter((s) => s && s.operation === 'central_submit' && s.submission)
      .map((s) => ({ submission: s.submission, task: s.task ?? null, status: s.status ?? null, outcome: s.outcome ?? null, review: typeof s.review === 'string' ? s.review.slice(0, 160) : null })).slice(-20),
  };
}

/**
 * The full claimable task list, read through the pinned kit's own exported `ops.tasks`
 * with enough pages. The kit CLI reads only its first 5 pages (60 tasks, oldest first),
 * which on 10 November 2026 hid 63 of the 66 open tasks; reported to the kit's owners.
 */
export async function kitTasks({ config, agent }) {
  const kit = await import(pathToFileURL(config.kit.path).href);
  const r = await kit.ops.tasks({ home: join(agent.home, 'agent-home') }, { pages: config.taskPages ?? 20 });
  const tasks = (r.tasks ?? []).filter((t) => t.claimable === true).map((t) => ({ id: t.id, project: t.project, title: String(t.title ?? '').slice(0, 160),
    rewardAI$: t.rewardAI$ ?? null, level: t.level ?? null, minutes: t.minutes ?? null, survey: t.survey === true }));
  return { claimableCount: r.claimableCount, more: r.more === true, tasks };
}

/** Starter survey parts first, then other starter tasks, then the rest; at most `limit`. */
export function candidates(tasks, limit = 8) {
  const rank = (t) => (t.level === 'starter' ? 0 : t.level === 'standard' ? 2 : 4) + (t.survey ? 0 : 1);
  return [...tasks].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id)).slice(0, limit);
}

export async function cycle({ config, agentName, dryRun = false, runner = run, listTasks = kitTasks, now = () => Date.now(), env = process.env }) {
  validateConfig(config);
  privateDir(config.stateDir);
  const stamp = () => new Date(now()).toISOString();
  if (existsSync(config.stopFile)) return { schema: RECEIPT_SCHEMA, at: stamp(), outcome: 'stopped', reason: 'stop_file' };
  if (existsSync(join(config.stateDir, 'HOLD'))) return { schema: RECEIPT_SCHEMA, at: stamp(), outcome: 'stopped', reason: 'hold_file' };
  const release = takeLock(config.stateDir);
  try {
    const order = config.agents.map((a) => a.name);
    const cursorPath = join(config.stateDir, 'next-agent.json');
    let index = 0;
    try { index = JSON.parse(readFileSync(cursorPath, 'utf8')).index % order.length; } catch { /* first cycle */ }
    const agent = agentName ? config.agents.find((a) => a.name === agentName) : config.agents[index];
    need(agent, 'unknown agent ' + agentName);
    if (!agentName) writeFileAtomic(cursorPath, JSON.stringify({ index: (index + 1) % order.length }));
    pinned(config.kit.path, config.kit.sha256);
    pinned(config.claude.path, config.claude.sha256);
    need(typeof env.CLAUDE_CODE_OAUTH_TOKEN === 'string' && env.CLAUDE_CODE_OAUTH_TOKEN.length > 0, 'subscription token missing from the environment');
    need(!['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].some((k) => env[k]), 'API credentials are not used by house agents');

    const before = await kitSnapshot({ config, agent, runner });
    let listed = null, listError = null;
    // Proof reads can fail transiently (central_proof_unavailable); one retry after a pause.
    for (let attempt = 0; attempt < 2 && !listed; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, config.listRetryMs ?? 20000));
      try { listed = await listTasks({ config, agent }); listError = null; } catch (e) { listError = String(e?.code ?? e?.message ?? e).slice(0, 300); }
    }
    before.claimableCount = Number.isInteger(listed?.claimableCount) ? listed.claimableCount : null;
    const base = { schema: RECEIPT_SCHEMA, at: stamp(), agent: { name: agent.name, address: before.address }, mode: dryRun ? 'dry-run' : 'production',
      controlledBySameOperator: true, outsideAdoption: false, kitSha256: config.kit.sha256, claudeSha256: config.claude.sha256, model: config.model,
      claimableBefore: before.claimableCount };
    // Paid starter stock is scarce: a house agent takes a task only while plenty are left for members.
    const minClaimable = config.minClaimable ?? 10;
    if (before.claimableCount === null) return finish(config, { ...base, outcome: 'skipped', reason: 'task_list_unreadable', error: listError ?? before.statusError ?? before.historyError });
    if (before.claimableCount < minClaimable) return finish(config, { ...base, outcome: 'left_for_members', reason: `fewer than ${minClaimable} claimable tasks` });
    const budget = openComputeBudget({ directory: join(config.stateDir, 'compute'), now, ...(config.limits ? { limits: config.limits } : {}) });
    const reservation = budget.reserve({ purpose: dryRun ? 'house-kit-dry-run' : 'house-kit-cycle', projectIds: ['house-fleet'], model: config.model });
    if (!reservation.id) return finish(config, { ...base, outcome: 'paused', reason: 'compute_budget', budget: { paused: reservation.paused, dailyUsd: reservation.dailyUsd, totalUsd: reservation.totalUsd } });

    const offered = candidates(listed.tasks);
    const prompt = housePrompt({ name: agent.name, dryRun, offered });
    const claudeHome = join(agent.home, 'claude-home');
    privateDir(claudeHome);
    // Claude Code runs its helpers (web page reading, summaries) on a small model unless told
    // otherwise; pin those to the same Sonnet model so every call is Sonnet.
    const childEnv = { PATH: '/usr/bin:/bin', HOME: claudeHome, TMPDIR: claudeHome, LANG: 'C.UTF-8', CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_DEFAULT_HAIKU_MODEL: config.model, ANTHROPIC_SMALL_FAST_MODEL: config.model };
    const started = now();
    const r = await runner(config.claude.path, claudeArgs({ config, agent, dryRun, prompt }), { env: childEnv, input: prompt, timeoutMs: config.timeoutMs });
    // stream-json: one event per line; the last `result` event carries usage and the structured answer.
    let result = null;
    for (const line of r.stdout.split('\n')) { try { const e = JSON.parse(line); if (e?.type === 'result') result = e; } catch { /* partial line */ } }
    // The whole stream is kept owner-only for quality review. The model never sees keys, so none are in it.
    const transcripts = join(config.stateDir, 'transcripts');
    privateDir(transcripts);
    const transcriptName = new Date(started).toISOString().replace(/[:.]/g, '-') + '-' + agent.name + '.jsonl';
    writeFileAtomic(join(transcripts, transcriptName), r.stdout);
    const reportedModels = Object.keys(result?.modelUsage ?? {});
    const costUsd = Number.isFinite(result?.total_cost_usd) && result.total_cost_usd >= 0 ? result.total_cost_usd : undefined;
    budget.settle(reservation.id, { costUsd, stopReason: r.failed ?? (result?.subtype ?? 'unreadable') });
    const structured = result?.structured_output && typeof result.structured_output === 'object' ? result.structured_output : null;
    const after = await kitSnapshot({ config, agent, runner });
    const known = new Set(before.submissions.map((s) => s.submission));
    const receipt = {
      ...base,
      durationMs: now() - started,
      exit: { code: r.code, failed: r.failed, subtype: result?.subtype ?? null, isError: result?.is_error ?? null, numTurns: result?.num_turns ?? null },
      reportedModels,
      modelUsage: result?.modelUsage ?? null,
      usageSource: 'subscription', costBasis: 'api-equivalent-estimate', costUsd: costUsd ?? null,
      promptSha256: sha256(prompt),
      offered: offered.map((t) => t.id),
      outcome: structured?.outcome ?? 'unreadable',
      task: structured?.task || null,
      submission: structured?.submission || null,
      surveySha256: structured?.survey ? sha256(structured.survey) : null,
      notes: typeof structured?.notes === 'string' ? structured.notes.slice(0, 1200) : null,
      finalText: typeof result?.result === 'string' ? result.result.slice(0, 1500) : null,
      transcript: transcriptName,
      before: { licence: before.licence, earnedAI$: before.earnedAI$, balanceAI$: before.balanceAI$, historyDigest: before.historyDigest, error: before.statusError ?? before.historyError },
      after: { licence: after.licence, earnedAI$: after.earnedAI$, balanceAI$: after.balanceAI$, historyDigest: after.historyDigest, error: after.statusError ?? after.historyError,
        newSubmissions: after.submissions.filter((s) => !known.has(s.submission)) },
    };
    if (reportedModels.some((m) => m !== config.model)) {
      writeFileAtomic(join(config.stateDir, 'HOLD'), JSON.stringify({ at: stamp(), reason: 'model_mismatch', reportedModels }) + '\n');
      receipt.hold = 'model_mismatch';
    }
    if (dryRun && structured?.survey) {
      // The dry-run text is kept owner-only beside the receipt for quality review; it is never logged.
      const dir = join(config.stateDir, 'dry-run');
      privateDir(dir);
      writeFileAtomic(join(dir, receipt.at.replace(/[:.]/g, '-') + '-' + agent.name + '.txt'), structured.survey);
    }
    return finish(config, receipt);
  } finally {
    release();
  }
}

function finish(config, receipt) {
  const dir = join(config.stateDir, 'receipts');
  privateDir(dir);
  writeFileAtomic(join(dir, receipt.at.replace(/[:.]/g, '-') + '-' + (receipt.agent?.name ?? 'none') + '.json'), JSON.stringify(receipt, null, 1) + '\n');
  appendFileSync(join(config.stateDir, 'cycles.jsonl'), JSON.stringify({ at: receipt.at, agent: receipt.agent?.name, mode: receipt.mode, outcome: receipt.outcome,
    reportedModels: receipt.reportedModels, costUsd: receipt.costUsd, task: receipt.task, submission: receipt.submission, hold: receipt.hold }) + '\n', { mode: 0o600 });
  return receipt;
}

export function inspect(config) {
  validateConfig(config);
  const budget = openComputeBudget({ directory: join(config.stateDir, 'compute'), ...(config.limits ? { limits: config.limits } : {}) });
  return { stop: existsSync(config.stopFile), hold: existsSync(join(config.stateDir, 'HOLD')), agents: config.agents.map((a) => a.name), budget: budget.status(), defaults: DEFAULT_LIMITS };
}

async function main(argv) {
  const [mode, ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--config' || a === '--agent') { need(rest[i + 1] && !o[a], 'argument ' + a); o[a] = rest[++i]; }
    else need(false, 'unknown argument ' + a);
  }
  need(absolute(o['--config']), '--config must be an absolute path');
  const config = JSON.parse(readFileSync(o['--config'], 'utf8'));
  if (mode === 'inspect') return inspect(config);
  // `dry-run` as a mode lets one systemd template unit run both (uain-house-agent@cycle / @dry-run).
  need(mode === 'cycle' || mode === 'dry-run', 'usage: house-kit-agent.mjs cycle|dry-run|inspect --config FILE [--agent NAME] [--dry-run]');
  return cycle({ config, agentName: o['--agent'], dryRun: mode === 'dry-run' || o.dryRun === true });
}

// Node resolves symlinks in import.meta.url, and the installed path runs through
// /opt/uain-house-agents/current, so compare canonical paths.
const invokedPath = (() => { try { return realpathSync(resolve(process.argv[1] ?? '')); } catch { return null; } })();
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); },
    (e) => { process.stderr.write('house-kit-agent: ' + e.message + '\n'); process.exitCode = 1; });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { cycle, claudeArgs, validateConfig, housePrompt, inspect, MODEL, FORBIDDEN_TOOLS } from './house-kit-agent.mjs';

const fake = (o) => { const f = fakeRunner(o); return { runner: f.runner, listTasks: f.listTasks }; };
const sha = (s) => createHash('sha256').update(s).digest('hex');

function setup({ limits } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'house-kit-'));
  chmodSync(root, 0o700);
  writeFileSync(join(root, 'kit.mjs'), 'kit');
  writeFileSync(join(root, 'claude'), 'claude');
  const config = {
    schema: 'uain-house-kit-agent-config-v1', node: '/usr/bin/node', model: MODEL,
    kit: { path: join(root, 'kit.mjs'), sha256: sha('kit') }, claude: { path: join(root, 'claude'), sha256: sha('claude') },
    agents: [{ name: 'alpha', home: join(root, 'alpha') }, { name: 'beta', home: join(root, 'beta') }],
    stateDir: join(root, 'state'), stopFile: join(root, 'STOP'), timeoutMs: 600000, maxTurns: 40, ...(limits ? { limits } : {}),
  };
  return { root, config };
}

/** Fake kit and Claude: the kit answers status/history; Claude answers with the given result. */
function fakeRunner({ claudeResult, afterSubmit = true, claimable = 30 } = {}) {
  const calls = [];
  let submitted = false;
  const runner = async (command, args, { env, input }) => {
    calls.push({ command, args, env, input });
    if (args[1] === 'status') return { code: 0, stdout: JSON.stringify({ address: 'uain1' + 'a'.repeat(40), licence: 'active', earnedAI$: submitted ? '0' : '0' }) };
    if (args[1] === 'history') {
      const steps = submitted && afterSubmit ? [{ operation: 'central_submit', submission: 'CS-1', task: 'T-1', status: 'finalized', outcome: 'under_review', review: 'recorded; waiting' }] : [];
      return { code: 0, stdout: JSON.stringify({ address: 'uain1' + 'a'.repeat(40), steps }) };
    }
    submitted = true;
    return { code: 0, stdout: JSON.stringify({ type: 'system', subtype: 'init' }) + '\n' + JSON.stringify(claudeResult) + '\n' };
  };
  const listTasks = async () => ({ claimableCount: claimable, more: false,
    tasks: Array.from({ length: claimable }, (_, i) => ({ id: `T-OPP-${String(i).padStart(5, '0')}-1-prior-art-survey-r2-p1`, project: 'P', title: 't', level: i % 2 ? 'starter' : 'standard', survey: true })) });
  return { runner, calls, listTasks };
}

const ok = (models = { [MODEL]: { costUSD: 0.4 } }, outcome = 'submitted') => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 12, total_cost_usd: 0.4,
  modelUsage: models, structured_output: { outcome, task: 'T-1', submission: 'CS-1', survey: outcome === 'dry_run' ? 'filled text' : '', notes: 'done' } });

test('config refuses any model but Sonnet', () => {
  const { config } = setup();
  assert.throws(() => validateConfig({ ...config, model: 'claude-opus-5-5' }), /claude-sonnet-5-5/);
  assert.equal(validateConfig(config), config);
});

test('the model never gets payment, trade, key or shell tools; a dry run cannot join or submit', () => {
  const { config } = setup();
  const live = claudeArgs({ config, agent: config.agents[0], dryRun: false });
  const dry = claudeArgs({ config, agent: config.agents[0], dryRun: true });
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(value(live, '--tools'), 'WebSearch,WebFetch');
  assert.equal(value(live, '--model'), MODEL);
  assert.match(value(live, '--allowedTools'), /baink_agent_submit/);
  assert.doesNotMatch(value(dry, '--allowedTools'), /baink_agent_(submit|join)/);
  assert.match(value(dry, '--disallowedTools'), /baink_agent_submit/);
  for (const t of FORBIDDEN_TOOLS) {
    assert.doesNotMatch(value(live, '--allowedTools'), new RegExp(t + '(,|$)'));
    assert.match(value(live, '--disallowedTools'), new RegExp(t));
  }
  assert.doesNotMatch(value(live, '--allowedTools'), /Bash|Read|Write|Edit/);
  const mcp = JSON.parse(value(live, '--mcp-config'));
  assert.equal(mcp.mcpServers['uain-agent'].env.UAIN_AGENT_HOME, join(config.agents[0].home, 'agent-home'));
  assert.match(housePrompt({ name: 'alpha', dryRun: true }), /DRY RUN: do not join or submit/);
});

test('a STOP file stops the cycle before any call', async () => {
  const { config } = setup();
  writeFileSync(config.stopFile, 'stop');
  const { runner, calls, listTasks } = fakeRunner({ claudeResult: ok() });
  const r = await cycle({ config, runner, listTasks, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  assert.equal(r.outcome, 'stopped');
  assert.equal(calls.length, 0);
});

test('a cycle reserves budget, runs Sonnet once, and writes a disclosed receipt', async () => {
  const { config } = setup();
  const { runner, calls, listTasks } = fakeRunner({ claudeResult: ok() });
  const r = await cycle({ config, runner, listTasks, env: { CLAUDE_CODE_OAUTH_TOKEN: 't', HOME: '/root' } });
  assert.equal(r.outcome, 'submitted');
  assert.equal(r.agent.name, 'alpha');
  assert.deepEqual(r.reportedModels, [MODEL]);
  assert.equal(r.controlledBySameOperator, true);
  assert.equal(r.outsideAdoption, false);
  assert.equal(r.after.newSubmissions[0].submission, 'CS-1');
  const claude = calls.find((c) => c.command === config.claude.path);
  assert.deepEqual(Object.keys(claude.env).sort(), ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_OAUTH_TOKEN', 'DISABLE_AUTOUPDATER', 'HOME', 'LANG', 'PATH', 'TMPDIR']);
  assert.equal(claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, MODEL);
  assert.equal(readdirSync(join(config.stateDir, 'transcripts')).length, 1);
  assert.equal(readdirSync(join(config.stateDir, 'receipts')).length, 1);
  const status = inspect(config).budget;
  assert.equal(status.totalUsd, 0.4);
  assert.equal(status.openReservations, 0);
  // Round robin: the next cycle takes the second agent.
  const second = await cycle({ config, ...fake({ claudeResult: ok() }), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  assert.equal(second.agent.name, 'beta');
});

test('any other reported model holds every later cycle', async () => {
  const { config } = setup();
  const r = await cycle({ config, ...fake({ claudeResult: ok({ [MODEL]: {}, 'claude-opus-5-5': {} }) }), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  assert.equal(r.hold, 'model_mismatch');
  assert.ok(existsSync(join(config.stateDir, 'HOLD')));
  const { runner, calls, listTasks } = fakeRunner({ claudeResult: ok() });
  const next = await cycle({ config, runner, listTasks, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  assert.equal(next.reason, 'hold_file');
  assert.equal(calls.length, 0);
});

test('an exhausted daily cap pauses without calling the model', async () => {
  const { config } = setup({ limits: { perCallUsd: 1, dailyUsd: 1, totalUsd: 5 } });
  await cycle({ config, ...fake({ claudeResult: { ...ok(), total_cost_usd: 1 } }), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  const { runner, calls, listTasks } = fakeRunner({ claudeResult: ok() });
  const r = await cycle({ config, runner, listTasks, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  assert.equal(r.outcome, 'paused');
  assert.equal(r.reason, 'compute_budget');
  assert.equal(calls.filter((c) => c.command === config.claude.path).length, 0);
});

test('API credentials and a changed kit are refused', async () => {
  const { config } = setup();
  await assert.rejects(cycle({ config, ...fake({ claudeResult: ok() }), env: { CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' } }), /API credentials/);
  writeFileSync(config.kit.path, 'changed');
  await assert.rejects(cycle({ config, ...fake({ claudeResult: ok() }), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } }), /pinned file changed/);
});

test('a dry run keeps the filled text owner-only and out of the receipt', async () => {
  const { config } = setup();
  const r = await cycle({ config, dryRun: true, ...fake({ claudeResult: ok(undefined, 'dry_run') }), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  assert.equal(r.mode, 'dry-run');
  assert.equal(r.surveySha256, sha('filled text'));
  assert.ok(!JSON.stringify(r).includes('filled text'));
  const files = readdirSync(join(config.stateDir, 'dry-run'));
  assert.equal(readFileSync(join(config.stateDir, 'dry-run', files[0]), 'utf8'), 'filled text');
});

test('a house agent leaves scarce paid work to members', async () => {
  const { config } = setup();
  const { runner, calls, listTasks } = fakeRunner({ claudeResult: ok(), claimable: 9 });
  const r = await cycle({ config, runner, listTasks, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  assert.equal(r.outcome, 'left_for_members');
  assert.equal(r.claimableBefore, 9);
  assert.equal(calls.filter((c) => c.command === config.claude.path).length, 0);
  assert.equal(inspect(config).budget.receipts, 0);
});

test('the prompt offers starter survey parts first, from the full list', async () => {
  const { config } = setup();
  const { runner, calls, listTasks } = fakeRunner({ claudeResult: ok(), claimable: 12 });
  const r = await cycle({ config, runner, listTasks, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  assert.equal(r.offered.length, 8);
  const prompt = calls.find((c) => c.command === config.claude.path).input;
  assert.match(prompt, /T-OPP-00001-1-prior-art-survey-r2-p1 \(project P, starter/);
  assert.ok(prompt.indexOf('starter') < prompt.indexOf('standard'));
});

test('a transient task-list failure is retried once', async () => {
  const { config } = setup();
  config.listRetryMs = 0;
  const f = fakeRunner({ claudeResult: ok() });
  let calls = 0;
  const flaky = async (a) => { calls++; if (calls === 1) throw Object.assign(new Error('x'), { code: 'central_proof_unavailable' }); return f.listTasks(a); };
  const r = await cycle({ config, runner: f.runner, listTasks: flaky, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  assert.equal(calls, 2);
  assert.equal(r.outcome, 'submitted');
  const g = fakeRunner({ claudeResult: ok() });
  const down = await cycle({ config, runner: g.runner, listTasks: async () => { throw Object.assign(new Error('x'), { code: 'central_proof_unavailable' }); }, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  assert.equal(down.outcome, 'skipped');
  assert.equal(down.error, 'central_proof_unavailable');
});

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fetchClient, older } from './fetch-client.mjs';
import { codexPreflight } from './preflight.mjs';

process.umask(0o077);
const env = process.env;
const agent = env.UAIN_AGENT ?? 'claude';
if (!['claude', 'codex'].includes(agent)) throw new Error('This image supports claude or codex');
const home = env.UAIN_HOME, member = env.UAIN_MEMBER_HOME;
if (!home || !member || !home.startsWith(`${member}/slots/`)) throw new Error('A leased persistent slot is required');
const config = path.join(home, 'worker.json');
const api = env.UAIN_API ?? 'https://uain.global';
const flag = (name, fallback) => {
  const value = env[name] ?? fallback;
  if (!/^(true|false)$/.test(value)) throw new Error(`${name} must be true or false`);
  return value === 'true';
};
const number = (name, fallback, integer = false) => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) throw new Error(`${name} must be positive`);
  return String(value);
};
const limits = ['--budget', number('UAIN_BUDGET_USD', '20'), '--budget-tokens', number('UAIN_BUDGET_TOKENS', '12000000', true), '--hours', number('UAIN_HOURS', '12')];
if (env.UAIN_TASKS) limits.push('--tasks', number('UAIN_TASKS', '', true));
const args = [...limits, ...(flag('UAIN_REVIEW_ONLY', 'true') ? ['--review-only'] : [])];
if (fs.existsSync(config)) {
  const saved = JSON.parse(fs.readFileSync(config));
  if (saved.agent !== agent || saved.base !== api.replace(/\/$/, '')) throw new Error('Slot belongs to another agent or network; select a different UAIN_SLOT');
}
if (agent === 'codex') codexPreflight(member);
if (env.UAIN_MEMBER_KEY_FILE) {
  const source = fs.realpathSync(env.UAIN_MEMBER_KEY_FILE);
  if (!source.startsWith(`${member}/`)) throw new Error('Imported key must be mounted inside fenced member storage');
  const target = path.join(member, 'key.json');
  if (!fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
}
const lastFile = path.join(home, 'client-version');
const previous = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8').trim() : '0.14.3';
// 0.14.4 removes redundant nested deny mounts for member slots. Earlier
// clients can fall back to a sandbox that does not fence the member key.
const minimum = agent === 'codex' && older(previous, '0.14.4') ? '0.14.4' : previous;
const client = await fetchClient(api, path.join(home, 'releases'), { minimum, allowLoopback: env.UAIN_ALLOW_TEST_HTTP === '1' });
fs.writeFileSync(lastFile, client.version, { mode: 0o600 });
let child;
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; child?.kill(signal); });
async function run(argv, extra = {}) {
  if (stopping) return 143;
  return await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(client.directory, 'uain-worker.mjs'), ...argv], { stdio: 'inherit', env: { ...env, UAIN_BASE: api, ...extra } });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 143 : 1)));
  });
}
if (!fs.existsSync(config)) {
  if (!flag('UAIN_ACCEPT_PRINCIPLES', 'false')) throw new Error('Read the Universal Principles, then set UAIN_ACCEPT_PRINCIPLES=true before enrolling');
  if (!env.UAIN_OPERATOR?.trim() || !env.UAIN_AGENT_NAME?.trim()) throw new Error('UAIN_OPERATOR and UAIN_AGENT_NAME are required');
  // A kernel lock serializes first enrolment even though Compose replicas have separate PID namespaces.
  const setup = ['setup', '--yes', '--new-agent', '--agent', agent, '--name', `${env.UAIN_AGENT_NAME} (${path.basename(home)})`, '--operator', env.UAIN_OPERATOR, '--region', env.UAIN_REGION ?? 'unstated', '--base', api, ...limits];
  const wrapper = spawnSync('flock', [path.join(member, '.setup.lock'), process.execPath, path.join(client.directory, 'uain-worker.mjs'), ...setup], { stdio: 'inherit', env: { ...env, UAIN_BASE: api }, timeout: 120000 });
  if (wrapper.status !== 0 || stopping) process.exit(wrapper.status ?? 1);
}
console.log(`Runner ${path.basename(home)}: verified client ${client.version}; ${agent}; persistent member storage`);
// The kernel lease proves no previous container still owns this slot. PID numbers are local to a container.
fs.rmSync(path.join(home, 'worker.pid'), { force: true });
process.exitCode = await run(args, { UAIN_WORKER_CHILD: '1', ...(agent === 'codex' ? { UAIN_REQUIRE_KEY_FENCE: '1' } : {}) });

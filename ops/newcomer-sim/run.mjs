#!/usr/bin/env node
// Newcomer simulator: a fresh agent that knows only the public UAIN/BAINK MCP
// servers walks through the platform the way a new member would. Each run is
// recorded and rendered as a readable report (report.html, report.md).
//
//   node ops/newcomer-sim/run.mjs --list
//   node ops/newcomer-sim/run.mjs earn-both
//   node ops/newcomer-sim/run.mjs --all --parallel 3
//   node ops/newcomer-sim/run.mjs status --persona earn-both-1   (reuse an account)
//   node ops/newcomer-sim/run.mjs --say "your own first message" --persona me-1
//
// Accounts (keys made by the agent's own kit) live outside the repository in
// $UAIN_TEST_ACCOUNTS (default ~/.uain-test-accounts), one folder per persona,
// so they can be reused. Never commit that folder.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRun } from './render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { scenarios, debrief, goalDebrief } = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'));
const ROOT = process.env.UAIN_TEST_ACCOUNTS || join(homedir(), '.uain-test-accounts');
const SERVERS = {
  uain: process.env.UAIN_MCP_URL || 'https://uain.global/mcp',
  baink: process.env.BAINK_MCP_URL || 'https://baink.money/mcp',
};

function parseArgs(argv) {
  const o = { ids: [], parallel: 1, agent: 'claude', model: 'claude-sonnet-5-5', debrief: true, turnTimeoutMin: 25 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--list') o.list = true;
    else if (a === '--all') o.all = true;
    else if (a === '--parallel') o.parallel = Number(v());
    else if (a === '--persona') o.persona = v();
    else if (a === '--agent') o.agent = v();
    else if (a === '--model') o.model = v();
    else if (a === '--hint') o.hint = v();
    else if (a === '--say') o.say = v();
    else if (a === '--mcp') o.mcp = v().split(',');
    else if (a === '--no-debrief') o.debrief = false;
    else if (a === '--turn-timeout') o.turnTimeoutMin = Number(v());
    else if (a === '--help' || a === '-h') o.help = true;
    else o.ids.push(a);
  }
  return o;
}

const private0700 = (p) => { mkdirSync(p, { recursive: true }); chmodSync(p, 0o700); return p; };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';

function nextPersona(id) {
  for (let n = 1; ; n++) if (!existsSync(join(ROOT, 'personas', `${id}-${n}`))) return `${id}-${n}`;
}

// One agent turn. Returns { sessionId, ok }.
function runTurn({ agent, model, cwd, env, mcpConfig, message, sessionId, transcript, timeoutMin, label }) {
  return new Promise((resolve) => {
    let cmd, args;
    if (agent === 'claude') {
      cmd = 'claude';
      args = ['-p', message, '--model', model, '--mcp-config', mcpConfig, '--strict-mcp-config',
        '--setting-sources', 'project', '--output-format', 'stream-json', '--verbose',
        '--permission-mode', 'bypassPermissions'];
      if (sessionId) args.push('--resume', sessionId);
    } else if (agent === 'codex') {
      const cfg = JSON.parse(readFileSync(mcpConfig, 'utf8')).mcpServers;
      cmd = 'codex';
      args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '--dangerously-bypass-approvals-and-sandbox'];
      if (model && !model.startsWith('claude')) args.push('-m', model);
      for (const [k, s] of Object.entries(cfg)) args.push('-c', `mcp_servers.${k}.url="${s.url}"`);
      args.push(message);
    } else throw Error(`unknown agent ${agent}`);
    appendFileSync(transcript, JSON.stringify({ type: 'sim_user', text: message, at: new Date().toISOString() }) + '\n');
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', sid = sessionId, ok = false;
    const timer = setTimeout(() => {
      appendFileSync(transcript, JSON.stringify({ type: 'sim_timeout', minutes: timeoutMin }) + '\n');
      child.kill('SIGTERM');
    }, timeoutMin * 60_000);
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        appendFileSync(transcript, line + '\n');
        try {
          const ev = JSON.parse(line);
          if (ev.session_id) sid = ev.session_id;
          if (ev.type === 'result') ok = !ev.is_error;
          if (ev.type === 'assistant') for (const c of ev.message?.content || [])
            if (c.type === 'tool_use') process.stdout.write(`  [${label}] → ${c.name}\n`);
        } catch { /* non-JSON line, kept in transcript */ }
      }
    });
    child.stderr.on('data', (d) => appendFileSync(transcript, JSON.stringify({ type: 'sim_stderr', text: String(d) }) + '\n'));
    child.on('close', (code) => { clearTimeout(timer); resolve({ sessionId: sid, ok: ok || (agent === 'codex' && code === 0) }); });
  });
}

async function runScenario(sc, o) {
  const persona = o.persona || nextPersona(sc.id);
  const pdir = private0700(join(ROOT, 'personas', persona));
  const workspace = private0700(join(pdir, 'workspace'));
  const agentHome = private0700(join(pdir, 'agent-home'));
  const runDir = private0700(join(pdir, 'runs', `${stamp()}-${sc.id}`));
  const servers = Object.fromEntries((o.mcp || sc.mcp).map((k) => [k, { type: 'http', url: SERVERS[k] }]));
  const mcpConfig = join(runDir, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: servers }, null, 2));
  const transcript = join(runDir, 'transcript.jsonl');
  const meta = { scenario: sc.id, title: sc.title, persona, agent: o.agent, model: o.model, mcp: Object.keys(servers),
    servers, startedAt: new Date().toISOString() };
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));
  // The agent's own kit keeps its key here, so the persona keeps its account across runs.
  const env = { ...process.env, UAIN_AGENT_HOME: agentHome };
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
  console.log(`▶ ${sc.id} as ${persona} (${o.agent}/${o.model}, MCP: ${meta.mcp.join('+')})`);
  const turns = sc.turns.map((t) => t.replace('{{hint}}', o.hint || ''));
  // A scenario with a goal also asks whether the agent reached it, and in how many calls.
  if (o.debrief) turns.push(debrief + (sc.goal && goalDebrief ? goalDebrief.replace('{{goal}}', sc.goal) : ''));
  let sessionId, okAll = true;
  if (o.agent === 'codex') turns.splice(0, turns.length, turns.join('\n\n'));
  for (const [i, message] of turns.entries()) {
    const r = await runTurn({ agent: o.agent, model: o.model, cwd: workspace, env, mcpConfig, message, sessionId,
      transcript, timeoutMin: o.turnTimeoutMin, label: `${persona} t${i + 1}` });
    sessionId = r.sessionId; okAll &&= r.ok;
  }
  meta.finishedAt = new Date().toISOString(); meta.sessionId = sessionId; meta.ok = okAll;
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));
  const { summary } = renderRun(runDir);
  console.log(`✔ ${sc.id} as ${persona}: ${summary.headline}\n  report: ${join(runDir, 'report.html')}`);
  return { runDir, summary };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || (!o.list && !o.all && !o.ids.length && !o.say)) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).join('\n').replace(/^\/\/ ?/gm, ''));
    return;
  }
  if (o.list) { for (const s of scenarios) console.log(`${s.id.padEnd(16)} ${s.title}  [${s.mcp.join('+')}]`); return; }
  let chosen = o.all ? scenarios.filter((s) => s.id !== 'status' && s.id !== 'trade-buy' && !s.id.startsWith('mx-')) : o.ids.map((id) => {
    const s = scenarios.find((x) => x.id === id); if (!s) throw Error(`no scenario ${id} (try --list)`); return s;
  });
  if (o.say) chosen = [{ id: 'custom', title: 'Custom first message', mcp: o.mcp || ['uain', 'baink'], turns: [o.say] }];
  private0700(ROOT);
  const queue = [...chosen], results = [];
  await Promise.all(Array.from({ length: Math.max(1, o.parallel) }, async () => {
    while (queue.length) results.push(await runScenario(queue.shift(), o));
  }));
  writeFileSync(join(ROOT, 'last-batch.json'), JSON.stringify(results, null, 2));
  console.log(`\nDone: ${results.length} run(s). Summary: ${join(ROOT, 'last-batch.json')}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

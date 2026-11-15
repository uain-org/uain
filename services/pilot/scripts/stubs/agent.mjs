#!/usr/bin/env node
/**
 * A stand-in for `claude`, `codex`, `hermes` and `openclaw` in
 * scripts/worker-test.mjs. It accepts
 * the arguments the worker passes, prints output in each CLI's format, and does
 * real work against the pilot over MCP, so the worker can be exercised without
 * spending anything.
 *
 * Which CLI it plays comes from STUB_KIND (claude|codex|hermes|openclaw). What it does comes
 * from $STUB_DIR/mode, read on every run so a test can change it mid-flight:
 *   work     do the first item uain_next offers, as the prompt says: a
 *            prior_art_challenge is decided (upheld, or $STUB_DECISION) with no
 *            uain_start, and a check that says attest_novelty attests "new"
 *   challenge  as work, but a task's answer is found already public: it is
 *            shown with uain_task_prior_art, before any uain_start, not answered
 *   nothing  submit nothing and say why
 *   fail     report an error and exit non-zero
 *   hang     never finish (to test that closing the window ends it)
 * Every invocation is appended to $STUB_DIR/calls.jsonl, and the item a
 * working run took to $STUB_DIR/items.jsonl. STUB_OLD=1 plays a
 * version from before Hermes's --usage-file, OpenClaw's `agent exec`, Claude
 * Code's dontAsk mode and Codex's permission profiles.
 *
 * As Codex, `codex sandbox ... -P <profile> -C <dir> -- <command>` runs the
 * command, refusing it ("Operation not permitted") if it names a path the
 * profile denies, as the real sandbox refuses to open one; each is recorded
 * in $STUB_DIR/sandbox.jsonl. STUB_NO_FENCE=1 plays a system where the deny
 * is not enforced.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const kind = process.env.STUB_KIND ?? 'claude';
const dir = process.env.STUB_DIR;
const args = process.argv.slice(2);

if (args[0] === '--version') {
  console.log(
    {
      claude: '9.9.9 (Claude Code stub)',
      codex: 'codex-cli 9.9.9-stub',
      hermes: 'Hermes Agent v9.9.9 (stub)',
      openclaw: 'OpenClaw 9.9.9-stub',
    }[kind],
  );
  process.exit(0);
}
const old = process.env.STUB_OLD === '1';
if (args.at(-1) === '--help') {
  if (kind === 'hermes')
    console.log(
      old
        ? 'usage: hermes [-z PROMPT] [--yolo] [--accept-hooks]'
        : 'usage: hermes [-z PROMPT] [--usage-file PATH] [--yolo] [--accept-hooks]',
    );
  else if (kind === 'openclaw')
    // As the real one: before `agent exec`, this prints the help of `agent`.
    console.log(
      old
        ? 'Usage: openclaw agent [options]\n  --local  --json  --session-id <id>'
        : 'Usage: openclaw agent exec [options]\n  --cwd <dir>  --config <path>  --json',
    );
  else if (kind === 'claude')
    console.log(claudeHelp());
  else console.log('Usage: codex exec [OPTIONS] [PROMPT]\n  -s, --sandbox <SANDBOX_MODE>');
  process.exit(0);
}

/** Claude Code's --help, as far as the worker reads it. */
function claudeHelp() {
  return old
    ? '  --permission-mode <mode>  (choices: "acceptEdits", "bypassPermissions", "default", "plan")\n  --settings <file-or-json>'
    : '  --permission-mode <mode>  (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")\n  --permission-prompts <target>  (choices: "host", "none")\n  --settings <file-or-json>';
}

if (kind === 'codex' && args[0] === 'sandbox') {
  const sep = args.indexOf('--');
  const opts = args.slice(1, sep);
  const cmd = args.slice(sep + 1);
  const denied = [];
  opts.forEach((a, i) => {
    const table = opts[i - 1] === '-c' && a.match(/^permissions\.[^.=]+\.filesystem=(.*)$/)?.[1];
    if (table)
      for (const m of table.matchAll(/"((?:[^"\\]|\\.)*)"\s*=\s*"deny"/g))
        denied.push(JSON.parse(`"${m[1]}"`));
  });
  fs.appendFileSync(
    path.join(dir, 'sandbox.jsonl'),
    `${JSON.stringify({ profile: opts[opts.indexOf('-P') + 1], cd: opts[opts.indexOf('-C') + 1], cmd, denied })}\n`,
  );
  if (old) {
    console.error("error: unrecognized subcommand 'sandbox'");
    process.exit(2);
  }
  const reaches = cmd
    .slice(1)
    .some((a) => denied.some((d) => a === d || a.startsWith(`${d}/`)));
  if (reaches && process.env.STUB_NO_FENCE !== '1') {
    console.error(`${cmd[0]}: ${cmd.at(-1)}: Operation not permitted`);
    process.exit(1);
  }
  process.exit(spawnSync(cmd[0], cmd.slice(1), { stdio: 'ignore' }).status ?? 1);
}

if (kind === 'claude') {
  // As the real one: a mode its --help does not list is refused.
  const asked = args[args.indexOf('--permission-mode') + 1];
  if (args.includes('--permission-mode') && !claudeHelp().includes(`"${asked}"`)) {
    console.error(`error: option '--permission-mode <mode>' argument '${asked}' is invalid.`);
    process.exit(1);
  }
}

const mode = (() => {
  try {
    return fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim();
  } catch {
    return 'work';
  }
})();
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

let url;
let token;
let extra = {};
if (kind === 'hermes') {
  // As Hermes: UAIN is an entry in config.yaml, its token a ${VAR} resolved
  // from this run's environment.
  const file = path.join(
    process.env.HERMES_HOME ?? path.join(process.env.HOME, '.hermes'),
    'config.yaml',
  );
  const yaml = fs.readFileSync(file, 'utf8');
  const block = yaml.slice(yaml.search(/^\s+uain:/m));
  url = block.match(/url:\s*"([^"]+)"/)[1];
  const ref = block.match(/Authorization:\s*"Bearer \$\{(\w+)\}"/)?.[1];
  token = ref ? process.env[ref] : null;
  extra = {
    yolo: process.env.HERMES_YOLO_MODE,
    hooks: process.env.HERMES_ACCEPT_HOOKS,
  };
} else if (kind === 'openclaw') {
  const file = opt('--config') ?? process.env.OPENCLAW_CONFIG_PATH;
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const server = cfg.mcp.servers.uain;
  url = server.url;
  const ref = server.headers.Authorization.match(/\$\{(\w+)\}/)?.[1];
  token = ref ? process.env[ref] : null;
  extra = {
    include: cfg.$include ?? null,
    transport: server.transport,
    config: file,
  };
} else if (kind === 'claude') {
  const cfg = JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8'))
    .mcpServers.uain;
  url = cfg.url;
  token = cfg.headers.Authorization.replace(/^Bearer /, '');
  extra = {
    settings: opt('--settings')
      ? JSON.parse(fs.readFileSync(opt('--settings'), 'utf8'))
      : null,
  };
} else {
  const c = args.filter((_, i) => args[i - 1] === '-c');
  url = c
    .find((s) => s.startsWith('mcp_servers.uain.url='))
    ?.split('=')[1]
    .replace(/"/g, '');
  const envName = c
    .find((s) => s.startsWith('mcp_servers.uain.bearer_token_env_var='))
    ?.split('=')[1]
    .replace(/"/g, '');
  token = process.env[envName];
}

fs.appendFileSync(
  path.join(dir, 'calls.jsonl'),
  `${JSON.stringify({ kind, mode, pid: process.pid, cwd: process.cwd(), args, url, token_present: Boolean(token), container: process.env.STUB_CONTAINER ?? null, uain_env: Object.keys(process.env).filter((k) => k.startsWith('UAIN_')).sort(), claude_env: Object.keys(process.env).filter((k) => k.startsWith('CLAUDE')).sort(), ...extra })}\n`,
);

const cost = Number(process.env.STUB_COST ?? 0.12);
function finish({ ok, reply }) {
  if (kind === 'hermes') {
    // Only the answer on stdout; what it cost in the usage file, even on
    // failure.
    if (ok) console.log(reply);
    fs.writeFileSync(
      opt('--usage-file'),
      JSON.stringify({
        estimated_cost_usd: cost,
        completed: ok,
        turn_exit_reason: ok ? 'completed' : reply,
      }),
    );
    process.exit(ok ? 0 : 2);
  }
  if (kind === 'openclaw' && args[1] === '--local') {
    // Older: log lines first, then the result printed over many lines, with
    // tokens but no cost.
    console.log('Config: missing env var "OPENCLAW_GATEWAY_TOKEN"');
    console.log(
      JSON.stringify(
        {
          payloads: ok ? [{ text: reply }] : [],
          meta: {
            agentMeta: { usage: { input: 1000, output: 200 } },
            ...(ok ? {} : { error: { message: reply } }),
          },
        },
        null,
        2,
      ),
    );
    process.exit(ok ? 0 : 1);
  }
  if (kind === 'openclaw') {
    console.log(
      JSON.stringify({
        ok,
        status: ok ? 'ok' : 'error',
        final: ok ? reply : '',
        costUsd: cost,
        ...(ok ? {} : { error: { message: reply, kind: 'provider' } }),
      }),
    );
    process.exit(ok ? 0 : 1);
  }
  if (kind === 'claude') {
    console.log(
      JSON.stringify({
        type: 'result',
        is_error: !ok,
        total_cost_usd: cost,
        result: reply,
      }),
    );
  } else {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'stub' }));
    if (ok) {
      console.log(
        JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 1000,
            cached_input_tokens: 0,
            output_tokens: 200,
          },
        }),
      );
      fs.writeFileSync(opt('-o'), reply);
    } else {
      // As the real CLI: an error event, and no final message written.
      console.log(JSON.stringify({ type: 'error', message: reply }));
      console.log(
        JSON.stringify({ type: 'turn.failed', error: { message: reply } }),
      );
    }
  }
  process.exit(ok ? 0 : 1);
}

if (mode === 'hang') {
  fs.writeFileSync(path.join(dir, 'hang.pid'), String(process.pid));
  setInterval(() => {}, 1e6);
} else if (mode === 'said-failed') {
  finish({
    ok: true,
    reply: 'FAILED: uain_next is unavailable in this session',
  });
} else if (mode === 'fail') {
  finish({
    ok: false,
    reply: process.env.STUB_ERROR ?? 'Invalid API key · Please run /login',
  });
} else if (mode === 'nothing') {
  finish({ ok: true, reply: 'NOTHING: none of these are in my area' });
} else {
  const c = new Client({ name: `${kind}-stub`, version: '1' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const call = async (name, a) =>
    JSON.parse((await c.callTool({ name, arguments: a })).content[0].text);
  let next = await call('uain_next', {});
  let item = next.items?.[0];
  // As the prompt asks: say you are on it first, and back off if crowded.
  // A prior_art_challenge has no uain_start, and a task is started only once
  // the search shows its answer is not already public.
  const idOf = {
    verify: 'contribution_id',
    review_claim: 'revision_id',
    compare: 'task_id',
    task: 'task_id',
  };
  const solved = mode === 'challenge' && item?.kind === 'task';
  if (item && idOf[item.kind] && !solved) {
    const s = await call('uain_start', {
      kind: item.kind,
      id: String(item[idOf[item.kind]]),
    });
    fs.appendFileSync(
      path.join(dir, 'starts.jsonl'),
      `${JSON.stringify({ kind: item.kind, id: item[idOf[item.kind]], enough: s.enough_already })}\n`,
    );
    if (s.enough_already) item = null;
  }
  if (mode === 'start-then-nothing') {
    await c.close();
    finish({
      ok: true,
      reply: 'NOTHING: looked closer and decided against it',
    });
  }
  let did = 'nothing to do';
  if (item?.kind === 'join') {
    await call('uain_join_project', { project_id: item.project.id });
    next = await call('uain_next', {});
    item = next.items?.find((i) => i.kind !== 'join');
    did = `joined ${item ? 'and then ' : ''}`;
  }
  if (item)
    fs.appendFileSync(
      path.join(dir, 'items.jsonl'),
      `${JSON.stringify({ kind: item.kind, id: item.contribution_id ?? item.challenge_id ?? item.revision_id ?? item.task_id, attest_novelty: item.attest_novelty ?? false })}\n`,
    );
  if (solved) {
    const r = await call('uain_task_prior_art', {
      task_id: item.task_id,
      // Blocked by the server's source policy, so it is never fetched.
      source: 'https://127.0.0.1/already-solved',
      note: 'Stub search: its table one gives exactly what the task asks.',
    });
    did = `showed ${item.task_id} is already solved (challenge ${r.challenge?.id})`;
  } else if (item?.kind === 'prior_art_challenge') {
    await call('uain_task_prior_art_decide', {
      challenge_id: item.challenge_id,
      decision: process.env.STUB_DECISION ?? 'upheld',
      note: 'Stub decision: the source gives the answer to the question.',
    });
    did = `decided challenge ${item.challenge_id}`;
  } else if (item?.kind === 'task' || item?.kind === 'continue_task') {
    await call('uain_task_start', { task_id: item.task_id });
    const r = await call('uain_contribute', {
      project_id: item.project.id,
      task_id: item.task_id,
      title: `Answer to ${item.task_id}`,
      detail: 'Stub answer.',
      claim: `What ${item.task_id} established.`,
      karma_claimed: 3,
    });
    did = `answered ${item.task_id} as ${r.contribution.id}`;
  } else if (item?.kind === 'verify') {
    await call('uain_verify', {
      contribution_id: item.contribution_id,
      verdict: 'confirmed',
      note: 'Stub check.',
      ...(item.believed_claim ? { against_claim: 'supports' } : {}),
      ...(item.attest_novelty
        ? {
            novelty: 'new',
            novelty_checked: [
              'stub query, Google Scholar, 2026-09-29',
              'stub query, GitHub, 2026-09-29',
            ],
          }
        : {}),
    });
    did = `verified ${item.contribution_id}`;
  } else if (item?.kind === 'compare') {
    const r = await call('uain_contribute', {
      project_id: item.project.id,
      task_id: item.task_id,
      reconciles: item.results,
      title: `Comparison for ${item.task_id}`,
      detail: 'Stub comparison.',
      claim: `What the answers to ${item.task_id} together establish.`,
      karma_claimed: 1,
    });
    did = `compared as ${r.contribution.id}`;
  } else if (item?.kind === 'review_claim') {
    await call('uain_claim_review', {
      revision_id: item.revision_id,
      verdict: 'confirm',
      note: 'Stub review.',
    });
    did = `reviewed revision ${item.revision_id}`;
  }
  await c.close();
  finish({ ok: true, reply: `DONE: ${did}` });
}

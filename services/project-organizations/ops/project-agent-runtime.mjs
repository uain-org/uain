#!/usr/bin/env node
/** One project-agent model execution inside the isolated house-solver unit (no custody, keys or
 * native access: `ops/project-agents.mjs` starts it through systemd-run with the same sandbox as the
 * house remote solver). Reads {role, projectId, executionId, prompt} on stdin and prints the
 * structured answer with its provider metadata. Sonnet only, subscription OAuth only. */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runClaudeStructured } from '../../../ops/agents/claude-house-solver.mjs';
import { PROJECT_AGENT_MODEL, PROJECT_AGENT_SCHEMAS } from '../src/project-agents.mjs';

/** The pinned server CLI 2.1.310, bind-mounted read-only into the unit (house-remote-solver-host.mjs). */
export const CLI = '/var/lib/uain-house-solver/claude';
export const CLI_SHA256 = 'b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56';
const TOOLS = Object.freeze({ writer: 'WebSearch,WebFetch', assessor: '' });

export async function execute(request, { run = runClaudeStructured, env = process.env } = {}) {
  const { role, projectId, executionId, prompt } = request ?? {};
  if (!Object.hasOwn(TOOLS, role) || typeof projectId !== 'string' || typeof executionId !== 'string' || typeof prompt !== 'string')
    throw Error('invalid project agent request');
  const schema = PROJECT_AGENT_SCHEMAS[role];
  const result = await run({
    executable: CLI, sha256: CLI_SHA256, prompt, projectId, env, usageSource: 'subscription', timeoutMs: 600000,
    tools: TOOLS[role], outputSchema: schema, purpose: 'project-agent-' + role,
    validateOutput: (value) => { if (value === null || typeof value !== 'object') throw Error('invalid'); return value; },
  });
  if (result.metadata?.model !== PROJECT_AGENT_MODEL) throw Error('project agent model refused');
  return { schema: 'uain-project-agent-execution-v1', role, projectId, executionId, model: PROJECT_AGENT_MODEL, value: result.value, metadata: result.metadata };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const chunks = [];
  let n = 0;
  for await (const b of process.stdin) { n += b.length; if (n > 262144) throw Error('input too large'); chunks.push(b); }
  try {
    process.stdout.write(JSON.stringify(await execute(JSON.parse(Buffer.concat(chunks).toString('utf8')))) + '\n');
  } catch (error) {
    process.stderr.write(`project agent refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}

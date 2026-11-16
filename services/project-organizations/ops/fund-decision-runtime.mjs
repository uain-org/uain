#!/usr/bin/env node
/** One Fund Manager decision execution inside the isolated house-solver unit (10 November 2026).
 * The manager stage (`fund` step) starts it through systemd-run with the same sandbox as the
 * project agents: no custody, keys, native access or network tools. Reads {projectId, executionId,
 * prompt} on stdin and prints the structured answer with its provider metadata. Sonnet only
 * (`claude-sonnet-5-5`), subscription OAuth only, no tools. It decides nothing by itself: the
 * manager stage checks the answer (`parseDecision`) and the root driver checks the record. */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runClaudeStructured } from '../../../ops/agents/claude-house-solver.mjs';
import { DECIDER_SCHEMA, FUND_DECIDER_MODEL } from '../src/fund-rounds.mjs';

/** The pinned server CLI 2.1.310, bind-mounted read-only into the unit; the same pins as
 * ops/project-agent-runtime.mjs (kept here so the organizations release needs no project-agents code). */
export const CLI = '/var/lib/uain-house-solver/claude';
export const CLI_SHA256 = 'b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56';

export const RUNTIME_SCHEMA = 'uain-fund-decision-execution-v1';

export async function execute(request, { run = runClaudeStructured, env = process.env } = {}) {
  const { projectId, executionId, prompt } = request ?? {};
  if (typeof projectId !== 'string' || !/^OPP-[0-9]{5}$/.test(projectId) || typeof executionId !== 'string' || typeof prompt !== 'string')
    throw Error('invalid fund decision request');
  const result = await run({
    executable: CLI, sha256: CLI_SHA256, prompt, projectId, env, usageSource: 'subscription', timeoutMs: 600000,
    tools: '', outputSchema: DECIDER_SCHEMA, purpose: 'fund-manager-decision',
    validateOutput: (value) => { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid'); return value; },
  });
  if (result.metadata?.model !== FUND_DECIDER_MODEL) throw Error('fund decision model refused');
  return { schema: RUNTIME_SCHEMA, projectId, executionId, model: FUND_DECIDER_MODEL, value: result.value, metadata: result.metadata };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const chunks = [];
  let n = 0;
  for await (const b of process.stdin) { n += b.length; if (n > 262144) throw Error('input too large'); chunks.push(b); }
  try {
    process.stdout.write(JSON.stringify(await execute(JSON.parse(Buffer.concat(chunks).toString('utf8')))) + '\n');
  } catch (error) {
    process.stderr.write(`fund decision refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}

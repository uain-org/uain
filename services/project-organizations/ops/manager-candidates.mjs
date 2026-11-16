#!/usr/bin/env node
/** Reviewed candidate tasks for the manager stage (src/candidates.mjs).
 *
 *   build <drafts.json> --reviewed-by <name> --reviewed-at <YYYY-MM-DD> [--source <label>]
 *       converts a reviewed `uain-small-task-drafts-v1` document deterministically to
 *       `uain-manager-candidates-v1` and prints it (one line of JSON). Same input, same output.
 *   check <candidates.json>
 *       validates a candidates file against the frozen selection and prints the count per project.
 *
 * Writes nothing; the operator installs the output root-owned (runbook 8c). */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadSelection } from '../src/selection.mjs';
import { candidateCounts, candidatesFromDrafts, validateCandidates } from '../src/candidates.mjs';
import { need } from '../src/common.mjs';

export async function main(argv, { read = (p) => readFileSync(p) } = {}) {
  const [command, file, ...rest] = argv;
  const selection = await loadSelection();
  if (command === 'build') {
    need(typeof file === 'string', 'usage');
    const flags = {};
    for (let i = 0; i < rest.length; i += 2) {
      need(['--reviewed-by', '--reviewed-at', '--source'].includes(rest[i]) && typeof rest[i + 1] === 'string', 'usage', rest[i]);
      flags[rest[i]] = rest[i + 1];
    }
    const bytes = read(file);
    const out = candidatesFromDrafts(bytes, { reviewedBy: flags['--reviewed-by'], reviewedAt: flags['--reviewed-at'], source: flags['--source'] ?? file });
    validateCandidates(out, { selection });
    return JSON.stringify(out);
  }
  if (command === 'check') {
    need(typeof file === 'string' && rest.length === 0, 'usage');
    const c = validateCandidates(JSON.parse(read(file).toString('utf8')), { selection });
    return JSON.stringify({ schema: c.schema, reviewed: c.reviewed, candidates: candidateCounts(c, Object.keys(c.projects)) });
  }
  need(false, 'usage', 'usage: build <drafts.json> --reviewed-by <name> --reviewed-at <YYYY-MM-DD> [--source <label>] | check <candidates.json>');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    process.stdout.write((await main(process.argv.slice(2))) + '\n');
  } catch (error) {
    process.stderr.write(`manager candidates refused: ${error?.code ?? 'refused'} ${error?.message ?? ''}\n`);
    process.exitCode = 1;
  }
}

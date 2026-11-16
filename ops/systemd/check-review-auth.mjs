import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codexPreflight } from '../../runner/preflight.mjs';

const instance = process.argv[2];
if (!['review-claude', 'review-codex'].includes(instance)) throw new Error('Only the two UAIN Review instances may use this unit');
const directory = `/home/uain/.uain-${instance}`;
const cfg = JSON.parse(fs.readFileSync(path.join(directory, 'worker.json')));
const agent = instance.slice('review-'.length);
if (cfg.agent !== agent || cfg.base !== 'https://uain.global' || cfg.participant?.id !== `uain-reviewer-${agent}`)
  throw new Error('Reviewer identity or network does not match the intended instance');
const result = spawnSync(agent, agent === 'codex' ? ['login', 'status'] : ['auth', 'status'], { encoding: 'utf8', timeout: 15000 });
if (result.status !== 0) throw new Error(`${agent} is not signed in; the owner must complete subscription authorization`);
if (agent === 'codex') {
  if (!/Logged in using ChatGPT/i.test(`${result.stdout}${result.stderr}`)) throw new Error('Expected a Codex subscription login');
  codexPreflight(directory);
} else {
  const auth = JSON.parse(result.stdout);
  if (!auth.loggedIn || auth.authMethod !== 'claude.ai') throw new Error('Expected a Claude subscription login');
}
console.log(`${instance}: subscription and identity preflight passed`);

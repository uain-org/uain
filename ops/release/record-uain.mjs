#!/usr/bin/env node
// Keeps docs/releases/uain/ and the `uain` pointer in step with production.
//
// A UAIN release is a `main` deploy through .github/workflows/deploy.yml whose
// deploy job reached "Record the release" (rollout applied, front-door site
// check passed, uain-release ConfigMap written). Only those runs are recorded,
// as status `deployed`: the evidence is the run, not a test. A run that failed
// or was cancelled, and a prose-only run (no deploy job), is never recorded.
//
//   node ops/release/record-uain.mjs --check
//       exit 1 when GitHub lists a recorded deploy newer than the pointer,
//       0 when the pointer is current, 3 when GitHub cannot be read.
//   node ops/release/record-uain.mjs --sync [--dry-run]
//       writes a record for every recorded deploy after the pointer, moves the
//       pointer to the newest, and regenerates CURRENT.md (needs `gh`).
//   node ops/release/record-uain.mjs --record --run ID --sha SHA --at ISO
//       writes one record from the deploy run itself (no `gh`), with the
//       current pointer as prior, and moves the pointer; for deploy.yml.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = 'nuah-org/uain-universa';
const RUN_URL = (id) => `https://github.com/${REPO}/actions/runs/${id}`;

export function recordFor({ run, sha, at, prior, note }) {
  if (!/^[0-9]+$/.test(String(run))) throw new Error('run must be a GitHub run id');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('sha must be a 40-hex commit');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(at)) throw new Error('at must be ISO UTC without fractions');
  const id = sha.slice(0, 8);
  return {
    schema: 1,
    component: 'uain',
    release_id: id,
    source_commit: sha,
    deployed_at: at,
    prior: prior && prior !== id ? prior : null,
    status: 'deployed',
    evidence: [RUN_URL(run)],
    note:
      note ??
      `deploy.yml run ${run}: Apply the manifest, the front-door site check (/, /api/ready, /network/live, waitlist) and Record the release passed. Activation evidence only; no separate public check was cited.`,
  };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

export function pointer(root = ROOT) {
  return readJson(path.join(root, 'docs/releases/current.json'));
}

/** Writes a record (unless one exists) and moves the pointer when it is newer. */
export function apply(record, root = ROOT, { movePointer = true } = {}) {
  const file = path.join(root, 'docs/releases/uain', `${record.release_id}.json`);
  const created = !fs.existsSync(file);
  if (created) writeJson(file, record);
  if (movePointer) {
    const current = pointer(root);
    const live = current.current.uain;
    const liveAt = live ? readJson(path.join(root, 'docs/releases/uain', `${live}.json`)).deployed_at : null;
    if (!liveAt || record.deployed_at > liveAt) {
      current.current.uain = record.release_id;
      writeJson(path.join(root, 'docs/releases/current.json'), current);
    }
  }
  return created;
}

function gh(args) {
  const out = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw Object.assign(new Error(`gh ${args[0]} ${args[1] ?? ''}: ${out.stderr.trim().slice(0, 200)}`), { code: 'gh' });
  return JSON.parse(out.stdout);
}

/** Recorded deploys newer than `since` (ISO), oldest first. */
export function recordedDeploys(since, run = gh) {
  const runs = run(['run', 'list', '-R', REPO, '--workflow', 'deploy.yml', '--limit', '200', '--json', 'databaseId,headSha,conclusion,createdAt'])
    .filter((r) => r.conclusion === 'success' && (!since || r.createdAt >= since.slice(0, 10)))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const out = [];
  for (const r of runs) {
    const jobs = run(['run', 'view', String(r.databaseId), '-R', REPO, '--json', 'jobs']).jobs;
    const deploy = jobs.find((j) => j.name === 'deploy');
    const step = deploy?.steps?.find((s) => s.name === 'Record the release');
    if (deploy?.conclusion !== 'success' || step?.conclusion !== 'success') continue;
    const at = step.completedAt.replace(/\.\d+Z$/, 'Z');
    if (since && at <= since) continue;
    out.push({ run: r.databaseId, sha: r.headSha, at });
  }
  return out;
}

function render(root) {
  const out = spawnSync(process.execPath, [path.join(root, 'ops/docs/render-status.mjs'), '--root', root], { cwd: root, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(out.stderr || out.stdout);
}

export function main(argv, { root = ROOT, run = gh, log = console.log } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean' }, sync: { type: 'boolean' }, record: { type: 'boolean' },
      'dry-run': { type: 'boolean' }, run: { type: 'string' }, sha: { type: 'string' }, at: { type: 'string' },
    },
    strict: true,
  });
  const live = pointer(root).current.uain;
  const liveRecord = readJson(path.join(root, 'docs/releases/uain', `${live}.json`));
  if (values.record) {
    const record = recordFor({ run: values.run, sha: values.sha, at: values.at, prior: live });
    const created = apply(record, root);
    render(root);
    log(`${created ? 'recorded' : 'already recorded'} uain ${record.release_id}; pointer ${pointer(root).current.uain}`);
    return 0;
  }
  let newer;
  try {
    newer = recordedDeploys(liveRecord.deployed_at, run).filter((d) => d.sha.slice(0, 8) !== live);
  } catch (error) {
    log(`uain pointer check unavailable: ${error.message}`);
    return 3;
  }
  if (values.check) {
    if (!newer.length) {
      log(`uain pointer ${live} is the newest recorded deploy`);
      return 0;
    }
    log(`uain pointer ${live} is stale: ${newer.length} newer deploy(s), newest ${newer.at(-1).sha.slice(0, 8)} at ${newer.at(-1).at}. Run: node ops/release/record-uain.mjs --sync`);
    return 1;
  }
  if (values.sync) {
    let prior = live;
    for (const d of newer) {
      const record = recordFor({ run: d.run, sha: d.sha, at: d.at, prior });
      if (values['dry-run']) log(`would record ${record.release_id} (${d.at}, run ${d.run}, prior ${prior})`);
      else apply(record, root);
      prior = record.release_id;
    }
    if (!values['dry-run']) render(root);
    log(`${values['dry-run'] ? 'would record' : 'recorded'} ${newer.length} deploy(s); pointer ${values['dry-run'] ? prior : pointer(root).current.uain}`);
    return 0;
  }
  log('usage: record-uain.mjs --check | --sync [--dry-run] | --record --run ID --sha SHA --at ISO');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { boot } from './helpers.mjs';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const program = fileURLToPath(new URL('./fixtures/reproduce-sum.mjs', import.meta.url));
const data = fileURLToPath(new URL('./fixtures/reproduction-numbers.txt', import.meta.url));
const artifacts = [
  { label: 'program', manifest: { version: 1, uri: 'https://artifacts.example/sum.mjs',
    sha256: sha(readFileSync(program)), bytes: readFileSync(program).length,
    media_type: 'text/javascript', license: 'LicenseRef-TestFixture', role: 'code' } },
  { label: 'dataset', manifest: { version: 1, uri: 'https://artifacts.example/numbers.txt',
    sha256: sha(readFileSync(data)), bytes: readFileSync(data).length,
    media_type: 'text/plain', license: 'LicenseRef-TestFixture', role: 'dataset' } },
];
const reproduction = {
  version: 1, inputs: ['program', 'dataset'], command: 'node sum.mjs numbers.txt',
  environment: 'Node.js >=22.13; no additional dependencies', seed: 'none',
  outputs: [{ metric: 'sum', expected: 42, absolute_tolerance: 0 }],
};
async function arena() {
  const lead = await t.member(`Artifact lead ${Math.random()}`);
  const checker = await t.member(`Artifact checker ${Math.random()}`);
  const checker2 = await t.member(`Artifact checker2 ${Math.random()}`);
  const project = (await lead.call('uain_propose', { title: `Artifact ${Math.random()}`,
    summary: 'Reproduce a controlled sum.', stop_conditions: ['Use only fixture data.'] })).project;
  for (const m of [checker, checker2]) await m.call('uain_join_project', { project_id: project.id });
  return { lead, checker, checker2, project };
}
const submit = (x, extra = {}) => x.lead.call('uain_contribute', {
  project_id: x.project.id, title: 'Sum', detail: 'Add the three numbers.',
  artifacts, reproduction, karma_claimed: 10, ...extra,
});
const receipt = (digest, extra = {}) => ({
  version: 1, manifest_digest: digest ?? '0'.repeat(64), outcome: 'reproduced',
  command: reproduction.command, environment: process.version, seed: 'none',
  inputs: artifacts.map((a) => ({ label: a.label, status: 'matched',
    observed_sha256: a.manifest.sha256, observed_bytes: a.manifest.bytes })),
  outputs: [{ metric: 'sum', observed: 42 }], detail: 'Ran the controlled reference fixture.',
  ...extra,
});

test('MCP preserves pinned manifests and a reproduction recipe', async () => {
  const x = await arena();
  const result = await submit(x);
  assert.equal(result.submitted, true, JSON.stringify(result));
  assert.deepEqual(result.contribution.artifacts, artifacts);
  assert.deepEqual(result.contribution.reproduction, reproduction);
  assert.match(result.contribution.artifact_manifest_digest, /^[a-f0-9]{64}$/);
  assert.equal(result.contribution.artifact_evidence, 'declared');
});

test('direct writes refuse invalid hashes and ambiguous manifest labels before recording work', async () => {
  const x = await arena();
  for (const bad of [[{ ...artifacts[0], manifest: { ...artifacts[0].manifest, sha256: 'bad' } }],
    [artifacts[0], artifacts[0]]]) {
    const result = await t.db.contribute({ contributor: x.lead.id, projectId: x.project.id,
      title: 'Bad descriptor', detail: 'd', artifacts: bad, karmaClaimed: 10 });
    assert.equal(result.error, 'bad_artifact_evidence');
  }
});

test('a receipt cannot confirm changed input bytes or a different manifest', async () => {
  const x = await arena();
  const sub = await submit(x);
  for (const bad of [receipt('f'.repeat(64)), receipt(sub.contribution.artifact_manifest_digest, {
    inputs: receipt(sub.contribution.artifact_manifest_digest).inputs.map((r) =>
      r.label === 'dataset' ? { ...r, observed_sha256: sha('changed bytes') } : r),
  })]) {
    const result = await t.db.verify({ verifier: x.checker.id, contributionId: sub.contribution.id,
      verdict: 'confirmed', note: 'Checked.', reproductionReceipt: bad });
    assert.equal(result.error, 'bad_reproduction_receipt', JSON.stringify(result));
    assert.equal((await t.db.getContribution(sub.contribution.id)).verifications.length, 0);
  }
});

test('a declared result outside its tolerance cannot be confirmed with a reproduction receipt', async () => {
  const x = await arena();
  const sub = await submit(x);
  const result = await t.db.verify({ verifier: x.checker.id, contributionId: sub.contribution.id,
    verdict: 'confirmed', note: 'Checked.', reproductionReceipt: receipt(sub.contribution.artifact_manifest_digest,
      { outputs: [{ metric: 'sum', observed: 43 }] }) });
  assert.equal(result.error, 'bad_reproduction_receipt');
  assert.equal((await t.db.getContribution(sub.contribution.id)).state, 'held');
});

test('a clean controlled run records receipts and settles once through the existing checks', async () => {
  const x = await arena();
  const sub = await submit(x);
  const actual = JSON.parse(execFileSync(process.execPath, [program, data], { encoding: 'utf8' }));
  assert.equal(actual.sum, 42);
  const proof = receipt(sub.contribution.artifact_manifest_digest, { outputs: [{ metric: 'sum', observed: actual.sum }] });
  for (const m of [x.checker, x.checker2]) {
    const result = await m.call('uain_verify', { contribution_id: sub.contribution.id,
      verdict: 'confirmed', note: 'Ran the reference fixture.', reproduction_receipt: proof });
    assert.equal(result.error, undefined, JSON.stringify(result));
  }
  const stored = await t.db.getContribution(sub.contribution.id);
  assert.equal(stored.state, 'settled');
  assert.equal(stored.verifications.length, 2);
  assert.deepEqual(stored.verifications[0].reproduction_receipt, proof);
  const repeat = await x.checker.call('uain_verify', { contribution_id: sub.contribution.id,
    verdict: 'confirmed', note: 'Retry.', reproduction_receipt: proof });
  assert.equal(repeat.error, 'already_settled');
});

test('legacy label-only submissions remain usable and do not acquire invented reproduction evidence', async () => {
  const x = await arena();
  const result = await submit(x, { artifacts: [{ label: 'old output', bytes: 12 }], reproduction: undefined });
  assert.equal(result.submitted, true);
  assert.equal(result.contribution.artifact_evidence, 'legacy');
  assert.equal(result.contribution.artifact_manifest_digest, null);
  await x.checker.call('uain_verify', { contribution_id: result.contribution.id, verdict: 'confirmed', note: 'Checked legacy work.' });
  const stored = await t.db.getContribution(result.contribution.id);
  assert.equal(stored.verifications[0].reproduction_receipt, null);
});

test('the ledger binds the submitted manifest and MCP explains receipt rejection', async () => {
  const x = await arena();
  const sub = await submit(x);
  const event = (await t.db.prepare("SELECT * FROM events WHERE actor = ? AND kind = 'contribution' ORDER BY id DESC").all(x.lead.id))[0];
  assert.ok(event.summary.includes(sub.contribution.artifact_manifest_digest), event.summary);
  const denied = await x.checker.call('uain_verify', { contribution_id: sub.contribution.id,
    verdict: 'confirmed', note: 'Receipt mismatch.', reproduction_receipt: receipt('f'.repeat(64)) });
  assert.equal(denied.error, 'bad_reproduction_receipt');
  assert.match(denied.message, /manifest/i);
});

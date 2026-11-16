import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactManifestDigest, validateArtifactEvidence, validateReproductionReceipt } from '../dist/src/evidence/artifact-evidence.js';
const artifacts = [{ label: 'input', manifest: { version: 1, uri: 'https://artifacts.example/input',
  sha256: 'a'.repeat(64), bytes: 12, media_type: 'text/plain', license: 'LicenseRef-TestFixture' } }];
const recipe = { version: 1, inputs: ['input'], command: 'run reference', environment: 'pinned reference runtime',
  seed: '5', outputs: [{ metric: 'value', expected: 42, absolute_tolerance: 0.25 }] };
const receipt = (extra = {}) => ({ version: 1, manifest_digest: artifactManifestDigest(artifacts, recipe),
  outcome: 'reproduced', command: 'run reference', environment: 'actual runtime', seed: '5', detail: 'Observed reference run.',
  inputs: [{ label: 'input', status: 'matched', observed_sha256: 'a'.repeat(64), observed_bytes: 12 }],
  outputs: [{ metric: 'value', observed: 42 }], ...extra });
const check = (extra, verdict = 'confirmed') => validateReproductionReceipt(artifacts, recipe, receipt(extra), verdict);

test('fingerprints ignore object key order and detect changed recipe or descriptor content', () => {
  const reordered = artifacts.map((a) => ({ manifest: { ...a.manifest }, label: a.label }));
  assert.equal(artifactManifestDigest(reordered, { outputs: recipe.outputs, ...recipe }), artifactManifestDigest(artifacts, recipe));
  assert.notEqual(artifactManifestDigest(artifacts, { ...recipe, command: 'different command' }), artifactManifestDigest(artifacts, recipe));
  assert.notEqual(artifactManifestDigest([{ ...artifacts[0], manifest: { ...artifacts[0].manifest, bytes: 13 } }], recipe), artifactManifestDigest(artifacts, recipe));
});
test('declared input references, sizes, versions and numeric outputs are validated', () => {
  assert.equal(validateArtifactEvidence(artifacts, recipe).ok, true);
  for (const bad of [{ ...recipe, inputs: ['unknown'] }, { ...recipe, inputs: ['input', 'input'] },
    { ...recipe, version: 2 }, { ...recipe, outputs: [{ metric: 'value', expected: Infinity, absolute_tolerance: 0 }] },
    { ...recipe, outputs: [{ metric: 'value', expected: 42, absolute_tolerance: -1 }] }])
    assert.equal(validateArtifactEvidence(artifacts, bad).ok, false);
  assert.equal(validateArtifactEvidence([{ ...artifacts[0], bytes: 10 }], recipe).ok, false);
});
test('receipt coverage and output tolerances have exact boundaries', () => {
  assert.equal(check({ outputs: [{ metric: 'value', observed: 42.25 }] }).ok, true);
  for (const extra of [{ inputs: [] }, { inputs: [...receipt().inputs, ...receipt().inputs] },
    { outputs: [] }, { outputs: [{ metric: 'unknown', observed: 42 }] },
    { outputs: [{ metric: 'value', observed: 42.251 }] }]) assert.equal(check(extra).ok, false);
});
test('a reproduced receipt must use the declared seed', () => {
  assert.equal(check({ seed: '6' }).ok, false);
});
test('mismatches and inaccessible inputs can be recorded with a dispute but cannot confirm', () => {
  const mismatch = { outcome: 'mismatch', inputs: [{ ...receipt().inputs[0], status: 'mismatch', observed_bytes: 13 }] };
  assert.equal(check(mismatch, 'disputed').ok, true);
  assert.equal(check(mismatch).ok, false);
  const inaccessible = { outcome: 'inaccessible', inputs: [{ label: 'input', status: 'inaccessible' }], outputs: [] };
  assert.equal(check(inaccessible, 'disputed').ok, true);
  assert.equal(check(inaccessible).ok, false);
  assert.equal(check({ outcome: 'mismatch' }, 'disputed').ok, false);
});
test('an inaccessible outcome cannot coexist with complete matched reproduction observations', () => {
  assert.equal(check({ outcome: 'inaccessible' }, 'disputed').ok, false);
});

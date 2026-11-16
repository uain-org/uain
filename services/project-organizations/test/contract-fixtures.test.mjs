// Language-neutral golden contract fixtures (fixtures/contracts), project
// organization consumer: the organization digest form and native unit amounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIFETIME_UNITS, UNITS_PER_AID, canonical, digest, units } from '../src/common.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL('../../../fixtures/contracts/' + name, import.meta.url), 'utf8'));
const ME = 'js-organizations';
const accepts = (run) => {
  try {
    run();
    return true;
  } catch {
    return false;
  }
};

test('organization canonical JSON and digests match byte for byte', () => {
  const { organization } = fixture('canonical-json.json');
  assert.ok(organization.vectors.length > 0);
  for (const v of organization.vectors) {
    const value = JSON.parse(v.json);
    assert.equal(canonical(value), v.canonical, v.name);
    assert.equal(digest(value), v.sha256, v.name);
  }
  for (const v of organization.edge_inputs) {
    const want = v.outcomes[ME];
    assert.ok(want !== undefined, `${v.name}: no ${ME} outcome`);
    if (want === 'refused') assert.throws(() => canonical(JSON.parse(v.json)), { code: 'non_canonical_value' }, v.name);
    else assert.equal(canonical(JSON.parse(v.json)), want.canonical, v.name);
  }
});

test('native unit amounts keep their exact boundaries', () => {
  const f = fixture('amounts.json');
  assert.equal(UNITS_PER_AID.toString(), f.constants.units_per_aid);
  assert.equal(LIFETIME_UNITS.toString(), f.constants.lifetime_ceiling_units);
  for (const v of f.task_amounts) {
    assert.equal(accepts(() => units(v.value)), v.positive, JSON.stringify(v.value));
    assert.equal(accepts(() => units(v.value, { allowZero: true })), v.nonnegative, JSON.stringify(v.value));
  }
});

test('registry audit and single-claim fixtures are valid policy tests and keep their golden verdicts', async () => {
  const { checkTest: auditTest, verify: auditVerify } = await import('../verifiers/registry-audit.mjs');
  const { checkTest: claimTest, verify: claimVerify } = await import('../verifiers/single-claim.mjs');
  const body = (v) => new Uint8Array(Buffer.from(JSON.stringify(v)));
  const reg = fixture('registry-audit.json');
  assert.equal(auditTest(reg.successTest), null);
  for (const c of reg.cases) {
    const records = Object.entries(reg.pubmedRecords).map(([id, json]) => ({ kind: 'pubmed', id, status: 200, body: body(json) }));
    const r = auditVerify({ successTests: [reg.successTest], audit: c.audit, registry: [{ status: 200, body: body(reg.registryPage) }], records, verifiedAt: reg.verifiedAt });
    assert.equal(r.status, c.status, c.name);
  }
  const claim = fixture('single-claim-check.json');
  assert.equal(claimTest(claim.successTest), null);
  const records = Object.entries(claim.records).map(([key, json]) => ({ kind: key.split(':')[0], id: key.split(':')[1], status: 200, body: body(json) }));
  for (const c of claim.cases) assert.equal(claimVerify({ successTests: [claim.successTest], check: c.check, records }).status, c.status, c.name);
});

test('fund-round evidence bundle and decision record digests match the shared golden vectors', async () => {
  const f = fixture('fund-round.json');
  const { applicationId, decisionPayload, intentId } = await import('../src/fund-rounds.mjs');
  assert.equal(canonical(f.evidence.value), f.evidence.canonical);
  assert.equal(digest(f.evidence.value), f.evidence.sha256);
  assert.equal(applicationId(f.evidence.value.project, f.evidence.value.round, f.evidence.sha256), f.evidence.application);
  assert.deepEqual(f.evidence.apply_batch.request.payload, { id: f.evidence.application, project: f.evidence.value.nativeProject, round: f.evidence.value.round,
    revision: f.evidence.value.planRevision, evidence_digest: f.evidence.sha256 });
  assert.equal(f.evidence.apply_batch.request.id, intentId('apply', f.evidence.application, 1));
  assert.equal(canonical(f.decision.value), f.decision.canonical);
  assert.equal(digest(f.decision.value), f.decision.sha256);
  assert.deepEqual(decisionPayload(f.decision.value), f.decision.decide_batch.request.payload);
  assert.equal(f.decision.decide_batch.request.id, intentId('decide', f.evidence.application, 1));
  assert.deepEqual(decisionPayload(f.missing_evidence.value), f.missing_evidence.payload);
  assert.equal(f.missing_evidence.payload.verification_digest, f.missing_evidence.sha256);
});

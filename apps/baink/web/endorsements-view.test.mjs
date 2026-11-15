import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEndorsementList,
  validateOwnEndorsement,
  validateEndorsementMutation,
} from './endorsements-view.js';
const subject = { address: 'uain1' + 'a'.repeat(40), profileVersion: 2 },
  actor = 'uain1' + 'b'.repeat(40);
const provenance = {
  kind: 'holder-published-peer-upvotes',
  independentlyVerified: false,
  affectsNativeKarma: false,
  establishesTrust: false,
  affectsMoney: false,
  countScope: 'current-published-profile-version-distinct-author-addresses',
  notice: 'Local assertions only.',
};
const record = {
  id: '10000000-0000-4000-8000-000000000001',
  author: actor,
  target: subject.address,
  profileVersion: 2,
  createdAt: '2026-11-01T00:00:00.000Z',
};
const list = () => ({
  subject: { ...subject },
  endorsements: [{ ...record }],
  count: 1,
  page: 1,
  pageSize: 25,
  pages: 1,
  provenance: { ...provenance },
});
const receipt = () => ({
  ...record,
  revokedAt: null,
  active: true,
  visibility: 'current-published-profile-version',
});
test('endorsement view accepts exact source-bound count and genuinezero only after validresponse', () => {
  const a = list();
  assert.deepEqual(validateEndorsementList(a, subject), a);
  assert.equal(
    validateEndorsementList({ ...a, endorsements: [], count: 0 }, subject)
      .count,
    0,
  );
  for (const change of [
    (r) => (r.subject.address = actor),
    (r) => (r.subject.profileVersion = 1),
    (r) => (r.count = 0),
    (r) => (r.pages = 2),
    (r) => (r.endorsements[0].author = subject.address),
    (r) => (r.endorsements[0].profileVersion = 1),
    (r) => (r.endorsements[0].createdAt = 'wrong'),
    (r) => (r.provenance.independentlyVerified = true),
    (r) => (r.provenance.affectsMoney = true),
    (r) => (r.endorsements[0].privateKey = 'hidden'),
  ]) {
    const r = list();
    change(r);
    assert.throws(() => validateEndorsementList(r, subject), /endorsement/i);
  }
  assert.throws(() => validateEndorsementList(null, subject), /endorsement/i);
});
test('own endorsement is exactholder/currentrevision and neveranotherpublicrow', () => {
  const a = { subject, endorsement: receipt(), provenance };
  assert.equal(
    validateOwnEndorsement(a, subject, actor).endorsement.author,
    actor,
  );
  assert.equal(
    validateOwnEndorsement({ ...a, endorsement: null }, subject, actor)
      .endorsement,
    null,
  );
  for (const change of [
    (r) => (r.endorsement.author = 'uain1' + 'c'.repeat(40)),
    (r) => (r.endorsement.active = false),
    (r) => (r.endorsement.revokedAt = '2026-11-01T01:00:00.000Z'),
    (r) => (r.subject = { ...subject, profileVersion: 3 }),
  ]) {
    const r = structuredClone(a);
    change(r);
    assert.throws(
      () => validateOwnEndorsement(r, subject, actor),
      /endorsement/i,
    );
  }
});
test('old revoked idempotent receipt remains revoked and cannotbe renderedasanactiveupvote', () => {
  const a = {
    created: false,
    endorsement: {
      ...receipt(),
      active: false,
      revokedAt: '2026-11-01T01:00:00.000Z',
      visibility: 'revoked',
    },
    provenance,
  };
  assert.equal(
    validateEndorsementMutation(a, subject, actor).endorsement.active,
    false,
  );
  const b = structuredClone(a);
  b.endorsement.active = true;
  assert.throws(
    () => validateEndorsementMutation(b, subject, actor),
    /endorsement/i,
  );
  const c = structuredClone(a);
  c.endorsement.profileVersion = 1;
  assert.throws(
    () => validateEndorsementMutation(c, subject, actor),
    /endorsement/i,
  );
  const d = { changed: true, endorsement: { ...a.endorsement }, provenance };
  assert.equal(validateEndorsementMutation(d, subject, actor).changed, true);
});
test('JSON coercion cannot bypass string identity, self or duplicate bindings', () => {
  for (const change of [
    (r) => (r.endorsements[0].author = [actor]),
    (r) => (r.endorsements[0].author = [subject.address]),
    (r) => (r.endorsements[0].id = [record.id]),
    (r) => (r.subject.address = [subject.address]),
  ]) {
    const r = list();
    change(r);
    assert.throws(() => validateEndorsementList(r, subject), /endorsement/i);
  }
  const r = list();
  r.count = 2;
  r.endorsements = [
    { ...record, author: [actor] },
    { ...record, id: '20000000-0000-4000-8000-000000000002', author: [actor] },
  ];
  assert.throws(() => validateEndorsementList(r, subject), /endorsement/i);
  assert.throws(
    () =>
      validateOwnEndorsement(
        { subject, endorsement: null, provenance },
        subject,
        [actor],
      ),
    /endorsement/i,
  );
});
test('mutation requires explicit expected holder and a possible created state', () => {
  const a = { created: true, endorsement: receipt(), provenance };
  for (const invalid of [undefined, null, [actor], ''])
    assert.throws(
      () => validateEndorsementMutation(a, subject, invalid),
      /endorsement/i,
    );
  assert.throws(
    () =>
      validateEndorsementMutation(
        a,
        { address: [subject.address], profileVersion: 2 },
        actor,
      ),
    /endorsement/i,
  );
  const r = {
    ...a,
    endorsement: {
      ...receipt(),
      active: false,
      revokedAt: '2026-11-01T01:00:00.000Z',
      visibility: 'revoked',
    },
  };
  assert.throws(
    () => validateEndorsementMutation(r, subject, actor),
    /endorsement/i,
  );
});

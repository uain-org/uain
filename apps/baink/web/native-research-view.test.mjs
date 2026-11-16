import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeResearchView,
  createNativeResearchGate,
  nativeResearchPath,
} from './native-research-view.js';
const owner = 'uain1' + 'a'.repeat(40),
  checker = 'uain1' + 'b'.repeat(40),
  other = 'uain1' + 'c'.repeat(40),
  NOW = Date.parse('2026-10-31T12:00:30Z');
const proof = () => ({
  authority: 'native',
  chainId: 'uain-shadow-test',
  height: '100',
  appHash: '1'.repeat(64),
  headerTime: '2026-10-31T12:00:00Z',
  maxAgeSeconds: 120,
  epoch: '2'.repeat(64),
  genesisSha256: '2'.repeat(64),
  verifierSha256: '3'.repeat(64),
});
const fixture = () => ({
  status: 'partial',
  scope: 'native-committed-legacy-records',
  complete: false,
  member: {
    address: owner,
    name: 'Research member',
    family: '',
    operator: 'Declared operator',
    licence: 'active',
  },
  proof: proof(),
  records: [
    {
      id: 'RC-4577',
      projectId: 'existing-project',
      taskId: 'T-41',
      authorInstanceId: 'author-one',
      memberAddress: owner,
      claim: 'A recorded research statement.',
      state: 'settled',
      submittedAt: '2026-09-30T10:09:12.132Z',
      checks: [
        {
          memberAddress: checker,
          instanceId: 'checker-one',
          verdict: 'confirmed',
          novelty: 'new',
          original: true,
        },
        {
          memberAddress: checker,
          instanceId: 'checker-two',
          verdict: 'confirmed',
          novelty: 'new',
          original: true,
        },
      ],
      distinctCheckerMembers: 1,
      distinctNonAuthorConfirmedNewMembers: 1,
      aiDollarPayment: 'not-established-by-this-record',
    },
  ],
  discovery: {
    instanceLimit: 4,
    projectLimit: 4,
    workLimit: 8,
    complete: false,
    source: 'public-project-hints/native-legacy-work-index',
  },
  notice: 'Only a bounded selection of imported native records.',
});
const view = (payload, options = {}) =>
  nativeResearchView(payload, owner, { now: NOW, ...options });

test('a current partial native selection stays partial and retains committed statements without earnings claims', () => {
  const result = view(fixture());
  assert.equal(result.status, 'partial');
  assert.equal(result.proofCurrent, true);
  assert.equal(result.complete, false);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].claim, 'A recorded research statement.');
  assert.equal(
    result.records[0].aiDollarPayment,
    'not-established-by-this-record',
  );
});
test('null research records remain unreported and never become zero achievements', () => {
  const payload = fixture();
  payload.records = null;
  const result = view(payload);
  assert.equal(result.status, 'partial');
  assert.equal(result.records, null);
  assert.equal(result.recordCount, null);
  assert.equal(result.proofCurrent, true);
  const missing = {
    status: 'unavailable',
    scope: 'native-committed-legacy-records',
    complete: false,
    member: null,
    proof: null,
    records: null,
    discovery: { instanceLimit: 4, workLimit: 8, complete: false },
    notice: 'Unavailable',
  };
  assert.equal(view(missing).records, null);
  assert.equal(view(missing).proofCurrent, false);
  const bounded = fixture();
  bounded.records = [];
  assert.equal(view(bounded).recordCount, 0);
  assert.equal(view(bounded).complete, false);
});
test('proof expiry or malformed metadata removes both the proof claim and displayed records without another response', () => {
  const payload = fixture();
  assert.equal(
    view(payload, { now: Date.parse('2026-10-31T12:01:59.999Z') }).proofCurrent,
    true,
  );
  const expired = view(payload, { now: Date.parse('2026-10-31T12:02:00Z') });
  assert.equal(expired.proofCurrent, false);
  assert.equal(expired.records, null);
  assert.equal(expired.member, null);
  for (const mutate of [
    (p) => (p.proof.headerTime = 'invalid'),
    (p) => (p.proof.maxAgeSeconds = 121),
    (p) => (p.proof.headerTime = '2026-10-31T12:01:30.001Z'),
    (p) => (p.proof.epoch = 'f'.repeat(64)),
  ]) {
    const invalid = fixture();
    mutate(invalid);
    assert.equal(view(invalid).proofCurrent, false);
    assert.equal(view(invalid).records, null);
  }
});
test('foreign member/record ownership and malformed record shapes are refused before any native record is presented', () => {
  for (const mutate of [
    (p) => (p.member.address = other),
    (p) => (p.records[0].memberAddress = other),
    (p) => (p.records[0].checks[0].original = 'true'),
    (p) => (p.records[0].aiDollarPayment = 'paid'),
    (p) => (p.complete = true),
    (p) => (p.scope = 'http-projection'),
    (p) => (p.records = Array.from({ length: 9 }, () => p.records[0])),
  ]) {
    const invalid = fixture();
    mutate(invalid);
    const result = view(invalid);
    assert.equal(result.proofCurrent, false);
    assert.equal(result.records, null);
  }
});
test('two checking instances of one member count once, and author checks cannot inflate the non-author count', () => {
  const payload = fixture();
  assert.equal(view(payload).records[0].distinctCheckerMembers, 1);
  assert.equal(
    view(payload).records[0].distinctNonAuthorConfirmedNewMembers,
    1,
  );
  payload.records[0].checks.push({
    memberAddress: owner,
    instanceId: 'author-other-instance',
    verdict: 'confirmed',
    novelty: 'new',
    original: true,
  });
  payload.records[0].distinctCheckerMembers = 2;
  const result = view(payload);
  assert.equal(result.records[0].distinctCheckerMembers, 2);
  assert.equal(result.records[0].distinctNonAuthorConfirmedNewMembers, 1);
  payload.records[0].distinctNonAuthorConfirmedNewMembers = 2;
  assert.equal(view(payload).records, null);
});
test('late responses and old expiry callbacks cannot overwrite another target or a new request generation', async () => {
  const gate = createNativeResearchGate();
  let release, state;
  const a = gate.begin(owner);
  const pending = new Promise((resolve) => (release = resolve)).then(() =>
    gate.apply(a, () => (state = 'late owner response')),
  );
  gate.invalidate();
  const b = gate.begin(other);
  gate.apply(b, () => (state = 'current other response'));
  release();
  await pending;
  assert.equal(state, 'current other response');
  assert.equal(
    gate.apply(a, () => (state = null)),
    false,
  );
  const newer = gate.begin(other);
  assert.equal(gate.isCurrent(b), false);
  assert.equal(gate.isCurrent(newer), true);
  gate.invalidate();
  assert.equal(
    gate.apply(newer, () => (state = 'after unmount')),
    false,
  );
});
test('the native record path is public-address-only with no key, auth or redirect material', () => {
  assert.equal(
    nativeResearchPath(owner),
    `/api/members/${owner}/native-record`,
  );
  for (const address of [
    '../account',
    owner + '?token=secret',
    'https://other.test',
    null,
  ])
    assert.throws(() => nativeResearchPath(address));
});

test('unpublished or mismatched anonymous profiles cannot mount a new native proof read', async () => {
  const { canReadNativeResearch } = await import('./native-research-view.js');
  for (const profile of [
    null,
    { address: owner, published: false },
    { address: other, published: true },
  ])
    assert.equal(
      canReadNativeResearch({
        address: owner,
        profile,
        requirePublished: true,
      }),
      false,
    );
  assert.equal(
    canReadNativeResearch({
      address: owner,
      profile: { address: owner, published: true },
      requirePublished: true,
    }),
    true,
  );
  assert.equal(
    canReadNativeResearch({
      address: owner,
      profile: null,
      requirePublished: false,
    }),
    true,
  );
});
test('the real native research adapter output qualifies without replacing native records with HTTP hints', async () => {
  const { createHash, generateKeyPairSync } = await import('node:crypto'),
    { createNativeResearch } = await import('../server/native-research.mjs');
  const { publicKey } = generateKeyPairSync('ed25519'),
    raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
    address =
      'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40);
  const member = {
    id: address,
    public_key: raw.toString('base64url'),
    name: 'Native fixture',
    family: '',
    operator: '',
    licence: 'active',
  };
  const authoritative = fixture().records[0];
  const records = {
    legacy_import: {
      policy: 'legacy-preservation-v1',
      status: 'ready',
      manifest_digest: '4'.repeat(64),
    },
    [`member/${address}`]: member,
    [`legacy/account/${address}`]: {
      ...member,
      instances: [{ id: 'author-one', member: address }],
    },
    [`legacy_account_claimed/${address}`]: {
      instances: 1,
      manifest_digest: '4'.repeat(64),
    },
    'legacy/project/existing-project': {
      id: 'existing-project',
      work_ids: ['RC-4577'],
    },
    'legacy/work/RC-4577': {
      id: 'RC-4577',
      kind: 'work',
      project: 'existing-project',
      task: 'T-41',
      author: 'author-one',
      member: address,
      claim_statement: 'Native committed statement, not an HTTP claim.',
      state: 'settled',
      submitted_at: authoritative.submittedAt,
      checks: authoritative.checks.map((row) => ({
        member: row.memberAddress,
        verifier: row.instanceId,
        verdict: row.verdict,
        novelty: row.novelty,
        original: row.original,
      })),
    },
  };
  const native = {
    configured: true,
    pins: {
      chainId: 'uain-shadow-test',
      epoch: '2'.repeat(64),
      verifierSha256: '3'.repeat(64),
    },
    publicState: async () => ({
      state: {
        chain_id: 'uain-shadow-test',
        height: '100',
        app_hash: '1'.repeat(64),
        header_time: '2026-10-31T12:00:00Z',
        member: structuredClone(member),
        records: structuredClone(records),
      },
      proof: proof(),
    }),
  };
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        projects: [{ id: 'existing-project', claim: 'Untrusted HTTP claim' }],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  const payload = await createNativeResearch({
      native,
      fetchImpl,
      now: () => NOW,
    }).get(address),
    result = nativeResearchView(payload, address, { now: NOW });
  assert.equal(result.proofCurrent, true);
  assert.equal(
    result.records[0].claim,
    'Native committed statement, not an HTTP claim.',
  );
  assert.equal(result.records[0].distinctCheckerMembers, 1);
  assert.equal(result.complete, false);
});

test('known, rejected or non-original entries cannot inflate recorded confirmed-new member counts', () => {
  const payload = fixture();
  payload.records[0].checks = [
    {
      memberAddress: checker,
      instanceId: 'not-original',
      verdict: 'confirmed',
      novelty: 'new',
      original: false,
    },
    {
      memberAddress: other,
      instanceId: 'known-result',
      verdict: 'confirmed',
      novelty: 'known',
      original: true,
    },
    {
      memberAddress: checker,
      instanceId: 'rejected-result',
      verdict: 'rejected',
      novelty: 'new',
      original: true,
    },
  ];
  payload.records[0].distinctCheckerMembers = 2;
  payload.records[0].distinctNonAuthorConfirmedNewMembers = 0;
  assert.equal(
    view(payload).records[0].distinctNonAuthorConfirmedNewMembers,
    0,
  );
  const oversized = fixture();
  oversized.records[0].checks = Array.from(
    { length: 33 },
    () => oversized.records[0].checks[0],
  );
  assert.equal(view(oversized).records, null);
});

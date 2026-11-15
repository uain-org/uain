import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createNativeResearch } from '../server/native-research.mjs';

const HASH = 'a'.repeat(64),
  EPOCH = 'b'.repeat(64),
  VERIFIER = 'c'.repeat(64);
const OTHER = 'uain1' + 'd'.repeat(40),
  CHECKER = 'uain1' + 'e'.repeat(40);
const PROJECT = 'alzheimer-s-disease-open-questions-answered-from';
const SECOND = 'longevity-and-ageing-open-questions-on-open-data';
const WHEN = Date.parse('2026-10-31T18:01:00Z');
function who() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    address:
      'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40),
    public_key: raw.toString('base64url'),
  };
}
function fixture({ timeoutMs = 8000 } = {}) {
  const actor = who();
  let time = WHEN;
  const calls = [],
    http = [];
  const member = {
    id: actor.address,
    public_key: actor.public_key,
    name: 'Claude (fixture)',
    family: 'Claude Code',
    operator: 'Self-declared operator',
    licence: 'active',
    credits: '134',
    karma: 132,
  };
  const instances = [
    'claude-lead',
    'claude-researcher-1',
    'claude-researcher-2',
    'claude-verifier',
  ].map((id) => ({ id, member: actor.address, state: 'active' }));
  const context = (height) => ({
    state: {
      chain_id: 'isolated-research-fixture',
      height,
      header_time: new Date(WHEN - 1000).toISOString(),
      app_hash: HASH,
      member: structuredClone(member),
      records: {
        legacy_import: {
          policy: 'legacy-preservation-v1',
          status: 'ready',
          manifest_digest: HASH,
        },
        [`member/${actor.address}`]: structuredClone(member),
      },
    },
    proof: {
      authority: 'native',
      chainId: 'isolated-research-fixture',
      height,
      appHash: HASH,
      headerTime: new Date(WHEN - 1000).toISOString(),
      maxAgeSeconds: 120,
      epoch: EPOCH,
      genesisSha256: EPOCH,
      verifierSha256: VERIFIER,
    },
  });
  const base = context('1022200'),
    work = context('1022204');
  base.state.records[`legacy/account/${actor.address}`] = {
    ...member,
    instances,
  };
  base.state.records[`legacy_account_claimed/${actor.address}`] = {
    instances: 4,
    manifest_digest: HASH,
  };
  base.state.records[`legacy/project/${PROJECT}`] = {
    id: PROJECT,
    lead: 'claude-lead',
    participant_ids: instances.map((x) => x.id),
    work_ids: ['RC-4565', 'RC-4577'],
  };
  base.state.records[`legacy/project/${SECOND}`] = {
    id: SECOND,
    lead: 'claude-lead',
    participant_ids: instances.map((x) => x.id),
    work_ids: ['RC-4576'],
  };
  const check = (member, verifier) => ({
    id: '151',
    member,
    verifier,
    verdict: 'confirmed',
    novelty: 'new',
    original: true,
    bootstrap: false,
  });
  work.state.records['legacy/work/RC-4565'] = {
    id: 'RC-4565',
    kind: 'work',
    author: 'claude-verifier',
    member: actor.address,
    project: PROJECT,
    task: 'T-36',
    claim_statement: 'A source-backed legacy research statement.',
    submitted_at: '2026-09-30T09:43:03.138Z',
    state: 'settled',
    claimed: 50,
    prize_due: 30,
    raw_meta: { private_hint: 'never-returned' },
    checks: [check(OTHER, 'reviewer-one'), check(OTHER, 'reviewer-two')],
  };
  work.state.records['legacy/work/RC-4576'] = {
    ...structuredClone(work.state.records['legacy/work/RC-4565']),
    id: 'RC-4576',
    project: SECOND,
    author: 'claude-researcher-1',
    task: 'T-45',
    checks: [check(OTHER, 'reviewer-one'), check(CHECKER, 'reviewer-two')],
  };
  work.state.records['legacy/work/RC-4577'] = {
    ...structuredClone(work.state.records['legacy/work/RC-4565']),
    id: 'RC-4577',
    checks: [check(actor.address, 'claude-lead'), check(OTHER, 'reviewer-one')],
  };
  const native = {
    configured: true,
    timeoutMs,
    pins: {
      chainId: 'isolated-research-fixture',
      epoch: EPOCH,
      verifierSha256: VERIFIER,
    },
    publicState: async (selection, options) => {
      calls.push({ selection, options });
      const result = structuredClone(
        selection.keys.some((k) => k.startsWith('legacy/work/')) ? work : base,
      );
      for (const key of selection.keys)
        if (!Object.hasOwn(result.state.records, key))
          result.state.records[key] = null;
      return result;
    },
  };
  const fetchImpl = async (url, options) => {
    http.push({ url, options });
    return new Response(
      JSON.stringify({
        projects: [
          { id: PROJECT, title: 'untrusted title', work: { forged: true } },
          { id: SECOND },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const reader = () =>
    createNativeResearch({ native, fetchImpl, now: () => time });
  return {
    actor,
    member,
    base,
    work,
    native,
    fetchImpl,
    calls,
    http,
    reader,
    setTime: (value) => (time = value),
  };
}

test('native legacy account/project/work proofs supply records; HTTP supplies only bounded project hints', async () => {
  const f = fixture(),
    out = await f.reader().get(f.actor.address);
  assert.equal(out.status, 'available');
  assert.equal(out.scope, 'native-committed-legacy-records');
  assert.equal(out.complete, false);
  assert.equal(out.member.address, f.actor.address);
  assert.equal(out.records.length, 3);
  assert.deepEqual(
    out.records.map((x) => x.id),
    ['RC-4577', 'RC-4576', 'RC-4565'],
  );
  assert.equal(out.records[2].distinctCheckerMembers, 1);
  assert.equal(out.records[2].distinctNonAuthorConfirmedNewMembers, 1);
  assert.equal(out.records[0].distinctCheckerMembers, 2);
  assert.equal(out.records[0].distinctNonAuthorConfirmedNewMembers, 1);
  assert.equal(out.records[1].distinctNonAuthorConfirmedNewMembers, 2);
  assert.equal(out.records[0].state, 'settled');
  assert.equal(
    out.records[0].aiDollarPayment,
    'not-established-by-this-record',
  );
  assert.equal(out.proof.height, '1022200');
  assert.equal(out.proof.maxAgeSeconds, 120);
  assert.deepEqual(out.discovery, {
    instanceLimit: 4,
    workLimit: 8,
    projectLimit: 4,
    source: 'public-project-hints/native-legacy-work-index',
    complete: false,
  });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].selection.member, f.actor.address);
  assert.equal(
    f.http[0].url,
    'https://uain.global/api/projects?page=1&page_size=4',
  );
  assert.equal(f.http[0].options.method, 'GET');
  assert.equal(f.http[0].options.redirect, 'error');
  for (const secret of [
    'raw_meta',
    'private_hint',
    'signed_header',
    'credits',
    'prize_due',
    'karma',
    'untrusted title',
    'public_key',
  ])
    assert.equal(JSON.stringify(out).includes(secret), false, secret);
});

test('substituted/stale/foreign public-key or missing selected proof never becomes a native member/record', async () => {
  for (const mutate of [
    (f) => (f.base.proof.authority = 'http'),
    (f) => (f.base.proof.epoch = 'f'.repeat(64)),
    (f) => (f.base.proof.verifierSha256 = 'f'.repeat(64)),
    (f) => (f.base.proof.chainId = 'another-chain'),
    (f) => (f.base.proof.appHash = 'f'.repeat(64)),
    (f) => (f.base.proof.maxAgeSeconds = 121),
    (f) => {
      f.base.proof.headerTime = f.base.state.header_time = new Date(
        WHEN - 121000,
      ).toISOString();
    },
    (f) => (f.base.state.member.public_key = who().public_key),
    (f) => delete f.base.state.records[`member/${f.actor.address}`],
  ]) {
    const f = fixture();
    mutate(f);
    const out = await f.reader().get(f.actor.address);
    assert.equal(out.status, 'unavailable');
    assert.equal(out.member, null);
    assert.equal(out.records, null);
  }
});

test('unclaimed or unreconciled legacy import leaves proven identity with unknown records', async () => {
  for (const mutate of [
    (f) => (f.base.state.records.legacy_import.status = 'loading'),
    (f) =>
      (f.base.state.records[
        `legacy_account_claimed/${f.actor.address}`
      ].manifest_digest = 'f'.repeat(64)),
    (f) => (f.base.state.records[`legacy/account/${f.actor.address}`] = null),
    (f) =>
      (f.base.state.records[
        `legacy/account/${f.actor.address}`
      ].instances[0].member = OTHER),
  ]) {
    const f = fixture();
    mutate(f);
    const out = await f.reader().get(f.actor.address);
    assert.equal(out.status, 'partial');
    assert.equal(out.member.address, f.actor.address);
    assert.equal(out.records, null);
    assert.equal(f.calls.length, 1);
  }
});

test('work proof must match base epoch/appHash and nondecreasing height; HTTP cannot fill missing records', async () => {
  for (const mutate of [
    (f) => (f.work.proof.epoch = 'f'.repeat(64)),
    (f) => {
      f.work.proof.appHash = f.work.state.app_hash = 'f'.repeat(64);
    },
    (f) => {
      f.work.proof.height = f.work.state.height = '1';
    },
    (f) => (f.work.proof.verifierSha256 = 'f'.repeat(64)),
    (f) => {
      f.work.proof.headerTime = f.work.state.header_time = new Date(
        WHEN - 121000,
      ).toISOString();
    },
  ]) {
    const f = fixture();
    mutate(f);
    const out = await f.reader().get(f.actor.address);
    assert.equal(out.status, 'partial');
    assert.equal(out.records, null);
    assert.equal(out.member.address, f.actor.address);
  }
});

test('foreign work author/member/project and forged index IDs never appear as owned achievements', async () => {
  for (const patch of [
    { member: OTHER },
    { author: 'foreign-instance' },
    { project: 'not-in-proven-index' },
    { project: SECOND },
    { id: 'RC-999999' },
  ]) {
    const f = fixture();
    Object.assign(f.work.state.records['legacy/work/RC-4577'], patch);
    const out = await f.reader().get(f.actor.address);
    assert.equal(out.status, 'partial');
    assert.equal(
      out.records.some((x) => x.id === 'RC-4577'),
      false,
    );
  }
  const f = fixture();
  f.base.state.records[`legacy/project/${PROJECT}`].id = 'substituted-project';
  const out = await f.reader().get(f.actor.address);
  assert.equal(
    out.records?.some((x) => x.projectId === PROJECT) ?? false,
    false,
  );
});

test('unknown discovery, empty indexes and missing work remain null rather than a fabricated zero history', async () => {
  for (const payload of [
    { projects: [] },
    { projects: [{ id: '../secret' }] },
    null,
  ]) {
    const f = fixture();
    const r = createNativeResearch({
      native: f.native,
      now: () => WHEN,
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    const out = await r.get(f.actor.address);
    assert.equal(out.status, 'partial');
    assert.equal(out.records, null);
    assert.equal(out.complete, false);
  }
  const f = fixture();
  for (const key of Object.keys(f.work.state.records))
    if (key.startsWith('legacy/work/')) f.work.state.records[key] = null;
  const out = await f.reader().get(f.actor.address);
  assert.equal(out.records, null);
  assert.equal(out.status, 'partial');
});

test('checker summaries count distinct member addresses and only non-author confirmed new original checks', async () => {
  const f = fixture(),
    row = f.work.state.records['legacy/work/RC-4577'];
  row.checks = [
    {
      member: OTHER,
      verifier: 'same-1',
      verdict: 'confirmed',
      novelty: 'new',
      original: true,
    },
    {
      member: OTHER,
      verifier: 'same-2',
      verdict: 'confirmed',
      novelty: 'new',
      original: true,
    },
    {
      member: CHECKER,
      verifier: 'known',
      verdict: 'confirmed',
      novelty: 'known',
      original: true,
    },
    {
      member: f.actor.address,
      verifier: 'self',
      verdict: 'confirmed',
      novelty: 'new',
      original: true,
    },
  ];
  const out = await f.reader().get(f.actor.address),
    item = out.records.find((x) => x.id === 'RC-4577');
  assert.equal(item.distinctCheckerMembers, 3);
  assert.equal(item.distinctNonAuthorConfirmedNewMembers, 1);
  row.checks[0].member = 'not-a-native-address';
  assert.equal(
    (await f.reader().get(f.actor.address)).records.some(
      (x) => x.id === 'RC-4577',
    ),
    false,
  );
});

test('discovery caps projects/owned instances/work and rejects oversized or redirected HTTP hints', async () => {
  const f = fixture();
  const p = f.base.state.records[`legacy/project/${PROJECT}`];
  p.work_ids = Array.from({ length: 20 }, (_, i) => `RC-${4600 + i}`);
  const out = await f.reader().get(f.actor.address);
  assert.equal(out.records, null);
  assert.equal(f.calls[1].selection.keys.length, 8);
  assert.deepEqual(f.calls[1].selection.keys.slice(0, 2), [
    'legacy/work/RC-4619',
    'legacy/work/RC-4618',
  ]);
  for (const response of [
    new Response('', {
      status: 302,
      headers: { location: 'https://evil.invalid' },
    }),
    new Response('x'.repeat(262145), {
      headers: { 'content-type': 'application/json' },
    }),
    new Response('invalid', {
      headers: { 'content-type': 'application/json' },
    }),
  ]) {
    const g = fixture();
    const result = await createNativeResearch({
      native: g.native,
      fetchImpl: async () => response,
      now: () => WHEN,
    }).get(g.actor.address);
    assert.equal(result.records, null);
    assert.equal(result.status, 'partial');
    assert.equal(g.calls.length, 1);
  }
});

test('cache copies/coalesces, expires in20s and never serves expired proof or a new pin epoch', async () => {
  const f = fixture(),
    r = f.reader();
  const [a, b] = await Promise.all([
    r.get(f.actor.address),
    r.get(f.actor.address),
  ]);
  assert.equal(f.calls.length, 2);
  a.records[0].claim = 'changed';
  assert.notEqual(b.records[0].claim, 'changed');
  f.setTime(WHEN + 20001);
  await r.get(f.actor.address);
  assert.equal(f.calls.length, 4);
  f.setTime(WHEN + 121000);
  assert.equal((await r.get(f.actor.address)).records, null);
  f.setTime(WHEN);
  f.native.pins.epoch = 'f'.repeat(64);
  assert.equal((await r.get(f.actor.address)).status, 'unavailable');
});

test('real-job admission stays at2 after deadline even if native transport ignores cancellation', async () => {
  const f = fixture({ timeoutMs: 100 });
  let release,
    calls = 0;
  const hung = new Promise((resolve) => {
    release = resolve;
  });
  f.native.publicState = async () => {
    calls++;
    await hung;
    return structuredClone(f.base);
  };
  const r = f.reader(),
    second = who().address;
  const a = r.get(f.actor.address),
    b = r.get(second);
  assert.equal((await r.get(who().address)).status, 'unavailable');
  await Promise.all([a, b]);
  assert.equal(calls, 2);
  await r.get(who().address);
  assert.equal(calls, 2);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await r.get(who().address);
  assert.equal(calls, 3);
});

test('only first4 owned instances and at most32 full checks can contribute to a projected record', async () => {
  const f = fixture();
  const account = f.base.state.records[`legacy/account/${f.actor.address}`];
  account.instances.push({
    id: 'fifth-owned-instance',
    member: f.actor.address,
  });
  f.base.state.records[`legacy_account_claimed/${f.actor.address}`].instances =
    5;
  f.work.state.records['legacy/work/RC-4577'].author = 'fifth-owned-instance';
  const out = await f.reader().get(f.actor.address);
  assert.equal(out.status, 'partial');
  assert.equal(
    out.records.some((row) => row.id === 'RC-4577'),
    false,
  );
  const g = fixture();
  g.work.state.records['legacy/work/RC-4577'].checks = Array.from(
    { length: 33 },
    () =>
      structuredClone(g.work.state.records['legacy/work/RC-4565'].checks[0]),
  );
  const second = await g.reader().get(g.actor.address);
  assert.equal(
    second.records.some((row) => row.id === 'RC-4577'),
    false,
  );
});

test('oversized hint lists and absent native project indexes cannot supply source records', async () => {
  const f = fixture();
  const r = createNativeResearch({
    native: f.native,
    now: () => WHEN,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          projects: Array.from({ length: 5 }, (_, i) => ({ id: 'hint-' + i })),
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  const out = await r.get(f.actor.address);
  assert.equal(out.records, null);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].selection.keys.length, 2);
  const g = fixture();
  g.base.state.records[`legacy/project/${PROJECT}`] = null;
  g.base.state.records[`legacy/project/${SECOND}`] = null;
  const second = await g.reader().get(g.actor.address);
  assert.equal(second.records, null);
  assert.equal(g.calls.length, 1);
});

test('oldest validated proof governs expiry, and disabled/invalid selections make no source calls', async () => {
  const f = fixture();
  f.work.proof.headerTime = f.work.state.header_time = new Date(
    WHEN - 10000,
  ).toISOString();
  const out = await f.reader().get(f.actor.address);
  assert.equal(out.proof.headerTime, f.work.proof.headerTime);
  const g = fixture();
  g.native.configured = false;
  assert.equal((await g.reader().get(g.actor.address)).status, 'unavailable');
  assert.equal(g.calls.length, 0);
  assert.equal(g.http.length, 0);
  const h = fixture();
  await h.reader().get('https://evil.invalid');
  assert.equal(h.calls.length, 0);
  assert.equal(h.http.length, 0);
});

test('64-entry cache evicts old members instead of retaining unbounded profiles', async () => {
  const fixtures = Array.from({ length: 65 }, () => fixture()),
    map = new Map(fixtures.map((f) => [f.actor.address, f]));
  let reads = 0;
  const native = {
    ...fixtures[0].native,
    publicState: async (selection) => {
      reads++;
      const f = map.get(selection.member);
      return structuredClone(
        selection.keys.some((k) => k.startsWith('legacy/work/'))
          ? f.work
          : f.base,
      );
    },
  };
  const r = createNativeResearch({
    native,
    fetchImpl: fixtures[0].fetchImpl,
    now: () => WHEN,
  });
  for (const f of fixtures)
    assert.equal((await r.get(f.actor.address)).status, 'available');
  assert.equal(reads, 130);
  await r.get(fixtures[64].actor.address);
  assert.equal(reads, 130);
  await r.get(fixtures[0].actor.address);
  assert.equal(reads, 132);
});

test('publication refuses proof expiry or a pin change during the same read', async () => {
  for (const change of [
    (f) => f.setTime(WHEN + 121000),
    (f) => (f.native.pins.epoch = 'f'.repeat(64)),
  ]) {
    const f = fixture(),
      original = f.native.publicState;
    f.native.publicState = async (selection, options) => {
      const out = await original(selection, options);
      if (selection.keys.some((k) => k.startsWith('legacy/work/'))) change(f);
      return out;
    };
    const out = await f.reader().get(f.actor.address);
    assert.equal(out.status, 'unavailable');
    assert.equal(out.records, null);
    assert.equal(out.proof, null);
  }
});

test('separate total deadline permits two valid native reads while each call retains the native timeout cap', async () => {
  const f = fixture({ timeoutMs: 100 });
  const original = f.native.publicState;
  f.native.publicState = async (selection, options) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return original(selection, options);
  };
  const reader = createNativeResearch({
    native: f.native,
    fetchImpl: f.fetchImpl,
    now: () => WHEN,
    totalTimeoutMs: 250,
  });
  const out = await reader.get(f.actor.address);
  assert.equal(out.status, 'available');
  assert.equal(f.calls.length, 2);
  assert.ok(
    f.calls.every(
      (call) => call.options.timeoutMs > 0 && call.options.timeoutMs <= 100,
    ),
  );
});

test('total deadline override requires an integer between100 and12000ms', () => {
  for (const totalTimeoutMs of [
    0,
    99,
    12001,
    250.5,
    '12000',
    NaN,
    Infinity,
    null,
  ]) {
    const f = fixture();
    assert.throws(
      () => createNativeResearch({ native: f.native, totalTimeoutMs }),
      RangeError,
    );
  }
  assert.doesNotThrow(() =>
    createNativeResearch({ native: fixture().native, totalTimeoutMs: 12000 }),
  );
});

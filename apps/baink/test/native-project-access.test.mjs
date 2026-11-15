import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeProjectAccess } from '../server/native-project-access.mjs';

const PROJECT = 'breast-and-lung-cancer-open-questions-with-no-pu';
const MEMBER = 'uain17fae025e2b7492156d438712aab8efcb4113b0fd';
const KEY = 'wpwtSOfm7XkVbHxuo5hXx6VOusc_DVFutMfYi8EiiWw';
const WHEN = Date.parse('2026-10-31T18:00:30Z'),
  HASH = 'a'.repeat(64),
  EPOCH = 'b'.repeat(64),
  VERIFIER = 'c'.repeat(64);
const request = () => ({
  projectId: PROJECT,
  expectedInstanceId: 'claude-lead',
  expectedMember: MEMBER,
  actor: {
    address: MEMBER,
    publicKey: Buffer.from(KEY, 'base64url').toString('base64'),
  },
});
function fixture(timeoutMs = 8000) {
  let clock = WHEN;
  const calls = [];
  // Public bundle shape, with controlled fresh proof metadata. No private key.
  const member = {
    id: MEMBER,
    public_key: KEY,
    name: 'Claude (UAIN)',
    family: 'Claude Code',
    operator: 'United AI Network (Rahul Jalan)',
    licence: 'active',
    sequence: '0',
  };
  const records = {
    legacy_import: {
      policy: 'legacy-preservation-v1',
      status: 'ready',
      manifest_digest: HASH,
    },
    [`member/${MEMBER}`]: structuredClone(member),
    [`legacy_project/${PROJECT}`]: null,
    [`project/${PROJECT}`]: null,
    'legacy_actor/claude-lead': null,
    [`legacy/project/${PROJECT}`]: {
      id: PROJECT,
      lead: 'claude-lead',
      state: 'verifying',
    },
    'instance/claude-lead': {
      id: 'claude-lead',
      member: MEMBER,
      state: 'active',
    },
    'legacy/actor/claude-lead': {
      id: 'claude-lead',
      member: MEMBER,
      source_state: 'active',
      projects: [PROJECT],
      operator_verified: false,
      trusted_arbiter: false,
    },
    [`legacy/account/${MEMBER}`]: {
      id: MEMBER,
      public_key: KEY,
      instances: [{ id: 'claude-lead', member: MEMBER, state: 'active' }],
    },
    [`legacy_account_claimed/${MEMBER}`]: {
      instances: 1,
      manifest_digest: HASH,
    },
  };
  const context = {
    state: {
      chain_id: 'isolated-project-access',
      height: '1022204',
      app_hash: HASH,
      header_time: new Date(WHEN - 1000).toISOString(),
      member,
      records,
    },
    proof: {
      authority: 'native',
      chainId: 'isolated-project-access',
      height: '1022204',
      appHash: HASH,
      headerTime: new Date(WHEN - 1000).toISOString(),
      maxAgeSeconds: 120,
      epoch: EPOCH,
      genesisSha256: EPOCH,
      verifierSha256: VERIFIER,
    },
  };
  const native = {
    configured: true,
    timeoutMs,
    pins: {
      chainId: 'isolated-project-access',
      epoch: EPOCH,
      verifierSha256: VERIFIER,
    },
    publicState: async (selection, options) => {
      calls.push({ selection, options });
      const out = structuredClone(context);
      for (const key of selection.keys)
        if (!Object.hasOwn(out.state.records, key))
          out.state.records[key] = null;
      return out;
    },
  };
  return {
    context,
    native,
    calls,
    reader: () => createNativeProjectAccess({ native, now: () => clock }),
    setTime: (value) => (clock = value),
  };
}

test('public bundle-shaped current lead qualifies mirror read only via exactly one pinned eight-key selection', async () => {
  const f = fixture(),
    out = await f.reader().check(request());
  assert.equal(out.allowed, true);
  assert.equal(out.reason, 'verified-current-lead');
  assert.equal(out.proof.authority, 'native');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].selection, {
    member: MEMBER,
    keys: [
      `legacy_project/${PROJECT}`,
      `legacy/project/${PROJECT}`,
      `project/${PROJECT}`,
      'instance/claude-lead',
      'legacy_actor/claude-lead',
      'legacy/actor/claude-lead',
      `legacy/account/${MEMBER}`,
      `legacy_account_claimed/${MEMBER}`,
    ],
  });
  assert.ok(f.calls[0].options.timeoutMs <= 8000);
  assert.deepEqual(Object.keys(out).sort(), ['allowed', 'proof', 'reason']);
  for (const field of [
    'operator_verified',
    'trusted_arbiter',
    'public_key',
    'signed_header',
    'records',
    'credits',
  ])
    assert.equal(JSON.stringify(out).includes(field), false);
  f.context.state.records[`legacy/project/${PROJECT}`].state = 'active';
  assert.equal((await f.reader().check(request())).allowed, true);
});

test('wrong actor or malformed configured tuple/key is denied before native RPC', async () => {
  for (const mutate of [
    (x) => (x.actor.address = 'uain1' + 'f'.repeat(40)),
    (x) => (x.expectedMember = 'uain1' + 'f'.repeat(40)),
    (x) => (x.projectId = '../secret'),
    (x) => (x.projectId = 123),
    (x) => (x.expectedInstanceId = 123),
    (x) => (x.expectedInstanceId = 'https://evil.invalid'),
    (x) => (x.actor.publicKey = KEY),
    (x) => (x.actor.publicKey += '='),
    (x) => (x.actor.publicKey = 'A'.repeat(43) + '='),
    (x) => (x.actor.publicKey = Buffer.from(KEY, 'base64url')),
  ]) {
    const f = fixture(),
      input = request();
    mutate(input);
    assert.deepEqual(await f.reader().check(input), {
      allowed: false,
      reason: 'not-authorized',
      proof: null,
    });
    assert.equal(f.calls.length, 0);
  }
});

test('revoked/inactive/changed native facts deny rather than infer operator trust or historical authority', async () => {
  for (const mutate of [
    (f) => {
      f.context.state.member.licence = f.context.state.records[
        `member/${MEMBER}`
      ].licence = 'revoked';
    },
    (f) => (f.context.state.records['instance/claude-lead'].state = 'halted'),
    (f) =>
      (f.context.state.records['instance/claude-lead'].member =
        'uain1' + 'f'.repeat(40)),
    (f) =>
      (f.context.state.records['legacy/actor/claude-lead'].source_state =
        'halted'),
    (f) => (f.context.state.records['legacy/actor/claude-lead'].projects = []),
    (f) =>
      (f.context.state.records['legacy/actor/claude-lead'].member =
        'uain1' + 'f'.repeat(40)),
    (f) =>
      (f.context.state.records[`legacy/project/${PROJECT}`].lead = 'new-lead'),
    (f) =>
      (f.context.state.records[`legacy/project/${PROJECT}`].state = 'closed'),
    (f) => (f.context.state.records[`legacy/account/${MEMBER}`].instances = []),
    (f) =>
      (f.context.state.records[
        `legacy_account_claimed/${MEMBER}`
      ].manifest_digest = 'f'.repeat(64)),
    (f) => (f.context.state.records.legacy_import.status = 'loading'),
    (f) => (f.context.state.records['legacy/actor/claude-lead'] = null),
  ]) {
    const f = fixture();
    mutate(f);
    const out = await f.reader().check(request());
    assert.equal(out.allowed, false);
    assert.equal(out.reason, 'not-authorized');
    assert.ok(out.proof);
  }
});

test('stale/mixed/missing or malformed proofs fail closed without a proof summary', async () => {
  for (const mutate of [
    (f) => (f.context.proof.epoch = 'f'.repeat(64)),
    (f) => (f.context.proof.genesisSha256 = 'f'.repeat(64)),
    (f) => (f.context.proof.verifierSha256 = 'f'.repeat(64)),
    (f) => (f.context.proof.chainId = 'other'),
    (f) => (f.context.proof.authority = 'http'),
    (f) => (f.context.state.app_hash = 'f'.repeat(64)),
    (f) => (f.context.proof.maxAgeSeconds = 121),
    (f) => {
      f.context.proof.headerTime = f.context.state.header_time = new Date(
        WHEN - 121000,
      ).toISOString();
    },
    (f) => {
      f.context.proof.headerTime = f.context.state.header_time = new Date(
        WHEN + 61000,
      ).toISOString();
    },
    (f) => delete f.context.state.records['instance/claude-lead'],
    (f) => delete f.context.state.records[`member/${MEMBER}`],
    (f) => (f.context.state.member.public_key = 'malformed'),
    (f) => (f.context.state.records[`member/${MEMBER}`].licence = 'revoked'),
  ]) {
    const f = fixture();
    mutate(f);
    const original = f.native.publicState;
    f.native.publicState = async (selection, options) => {
      const out = await original(selection, options);
      if (!Object.hasOwn(f.context.state.records, 'instance/claude-lead'))
        delete out.state.records['instance/claude-lead'];
      return out;
    };
    assert.deepEqual(await f.reader().check(request()), {
      allowed: false,
      reason: 'proof-unavailable',
      proof: null,
    });
  }
  const f = fixture();
  f.native.publicState = async () => {
    throw new Error('private-source-error');
  };
  assert.equal((await f.reader().check(request())).reason, 'proof-unavailable');
});

test('cache coalesces/copies and keys exact tuple/actor/pins, expires at20s and never outlives proof', async () => {
  const f = fixture(),
    r = f.reader();
  const [a, b] = await Promise.all([r.check(request()), r.check(request())]);
  assert.equal(f.calls.length, 1);
  a.proof.height = '1';
  assert.equal(b.proof.height, '1022204');
  await r.check({ ...request(), projectId: 'different-project' });
  assert.equal(f.calls.length, 2);
  f.setTime(WHEN + 20001);
  f.context.state.records[`legacy/project/${PROJECT}`].lead = 'changed';
  assert.equal((await r.check(request())).allowed, false);
  assert.equal(f.calls.length, 3);
  f.setTime(WHEN + 121000);
  assert.equal((await r.check(request())).reason, 'proof-unavailable');
  f.setTime(WHEN);
  f.native.pins.epoch = 'f'.repeat(64);
  assert.equal((await r.check(request())).reason, 'proof-unavailable');
});

test('actual native job slots remain capped at2 after timeout and ignore-abort response', async () => {
  const f = fixture(25);
  let release,
    calls = 0;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  f.native.publicState = async () => {
    calls++;
    await wait;
    return structuredClone(f.context);
  };
  const r = f.reader();
  const first = r.check(request()),
    second = r.check({ ...request(), projectId: 'second-project' });
  assert.equal(
    (await r.check({ ...request(), projectId: 'third-project' })).reason,
    'proof-unavailable',
  );
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  await r.check({ ...request(), projectId: 'fourth-project' });
  assert.equal(calls, 2);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await r.check({ ...request(), projectId: 'fifth-project' });
  assert.equal(calls, 3);
});

test('64-entry cap evicts old tuple decisions; current proof/pins are checked at publication', async () => {
  const f = fixture(),
    original = f.native.publicState;
  let reads = 0;
  f.native.publicState = async (selection, options) => {
    reads++;
    const out = await original(selection, options),
      id = selection.keys
        .find((k) => k.startsWith('legacy/project/'))
        .slice('legacy/project/'.length);
    out.state.records[`legacy/project/${id}`] = {
      id,
      lead: 'claude-lead',
      state: 'active',
    };
    out.state.records['legacy/actor/claude-lead'].projects = [id];
    return out;
  };
  const r = f.reader();
  for (let i = 0; i < 65; i++)
    assert.equal(
      (await r.check({ ...request(), projectId: 'project-' + i })).allowed,
      true,
    );
  assert.equal(reads, 65);
  await r.check({ ...request(), projectId: 'project-64' });
  assert.equal(reads, 65);
  await r.check({ ...request(), projectId: 'project-0' });
  assert.equal(reads, 66);
  const g = fixture(),
    read = g.native.publicState;
  g.native.publicState = async (...args) => {
    const out = await read(...args);
    g.native.pins.epoch = 'f'.repeat(64);
    return out;
  };
  assert.equal((await g.reader().check(request())).reason, 'proof-unavailable');
});

test('operative project/actor overlays override frozen import; only proven absence permits fallback', async () => {
  for (const patch of [
    { lead: 'new-lead' },
    { state: 'paused' },
    { id: 'different-project' },
  ]) {
    const f = fixture();
    f.context.state.records[`legacy_project/${PROJECT}`] = {
      ...f.context.state.records[`legacy/project/${PROJECT}`],
      ...patch,
    };
    assert.equal((await f.reader().check(request())).allowed, false);
  }
  const f = fixture();
  f.context.state.records['legacy_actor/claude-lead'] = {
    ...f.context.state.records['legacy/actor/claude-lead'],
    projects: [],
  };
  assert.equal((await f.reader().check(request())).allowed, false);
  const g = fixture();
  g.context.state.records[`legacy_project/${PROJECT}`] = 'malformed';
  assert.equal((await g.reader().check(request())).allowed, false);
  const h = fixture();
  h.context.state.records[`project/${PROJECT}`] = {
    id: PROJECT,
    lead: MEMBER,
    state: 'active',
  };
  assert.equal((await h.reader().check(request())).allowed, false);
  const valid = fixture();
  valid.context.state.records[`legacy_project/${PROJECT}`] = {
    ...valid.context.state.records[`legacy/project/${PROJECT}`],
    state: 'active',
  };
  valid.context.state.records[`legacy/project/${PROJECT}`].lead =
    'old-import-lead';
  assert.equal((await valid.reader().check(request())).allowed, true);
  for (const key of [
    `legacy_project/${PROJECT}`,
    'legacy_actor/claude-lead',
    `project/${PROJECT}`,
  ]) {
    const missing = fixture(),
      original = missing.native.publicState;
    missing.native.publicState = async (...args) => {
      const out = await original(...args);
      delete out.state.records[key];
      return out;
    };
    assert.equal(
      (await missing.reader().check(request())).reason,
      'proof-unavailable',
    );
  }
});

test('unqualified compact-instance metadata policy cannot confer mirror access', async () => {
  const f = fixture();
  f.context.state.records['instance/claude-lead'].account_policy =
    'compact-account-v1';
  f.context.state.records['instance/claude-lead'].metadata_digest = HASH;
  assert.equal((await f.reader().check(request())).allowed, false);
});

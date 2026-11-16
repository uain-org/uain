import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeWorkCurrent,
  NativeWorkCurrentError,
} from '../server/native-work-current.mjs';
import { nativeWorkCurrentFixture } from './fixtures/native-work-current-fixture.mjs';
const WHEN = Date.parse('2026-11-01T00:00:01Z');
function fixture({ timeoutMs = 8000 } = {}) {
  const f = nativeWorkCurrentFixture(),
    calls = [];
  let clock = WHEN;
  const native = {
    configured: true,
    timeoutMs,
    pins: f.pins,
    publicState: async (selection, options) => {
      calls.push({ selection, options });
      return structuredClone(f.context);
    },
  };
  return {
    ...f,
    native,
    calls,
    reader: () =>
      createNativeWorkCurrent({ native, now: () => clock, timeoutMs }),
    setTime: (value) => (clock = value),
  };
}
const get = (f) => f.reader().get(f.actor, f.query);
const unavailable = (out) => {
  assert.equal(out.status, 'unavailable');
  for (const k of ['work', 'project', 'task', 'proof'])
    assert.equal(out[k], null);
  assert.equal(out.complete, false);
  assert.equal(out.aiDollarPayment, 'not-established-by-this-record');
  assert.equal(out.claimBelief, 'not-evaluated');
};
test('one exact14-key proof yields holder-bound imported fallback status only', async () => {
  const f = fixture(),
    out = await get(f);
  assert.equal(out.status, 'available');
  assert.equal(out.scope, 'native-current-work-status');
  assert.equal(out.actorAddress, f.actor.address);
  assert.deepEqual(out.binding, f.query);
  assert.equal(out.work.state, 'settled');
  assert.equal(out.work.pending, '');
  assert.equal(out.work.withheld, '');
  assert.equal(out.task.outcome, '');
  assert.equal(out.work.recordSourceKey, 'legacy/work/RC-4577');
  assert.equal(out.work.statusSourceKey, 'legacy/work/RC-4577');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].selection, {
    member: f.actor.address,
    keys: f.keys,
  });
  assert.ok(f.calls[0].options.timeoutMs <= 8000);
  assert.equal(JSON.stringify(out).includes('never-return'), false);
  assert.equal(Object.hasOwn(out.work, 'paid'), false);
  assert.equal(Object.hasOwn(out.work, 'claimed'), false);
});
test('compact status wins frozen flags; mutable full/compact disagreement fails closed', async () => {
  const f = fixture(),
    r = f.state.records,
    w = r['legacy/work/RC-4577'];
  r['legacy_work_status/RC-4577'] = {
    id: w.id,
    project: w.project,
    task: w.task,
    member: w.member,
    kind: 'work',
    state: 'rejected',
    pending: 'kpi',
    withheld: 'known',
    paid: true,
    comparison: false,
  };
  let out = await get(f);
  assert.equal(out.status, 'available');
  assert.equal(out.work.state, 'rejected');
  assert.equal(out.work.statusSourceKey, 'legacy_work_status/RC-4577');
  assert.equal(Object.hasOwn(out.work, 'paid'), false);
  r['legacy_work/RC-4577'] = {
    ...w,
    state: 'rejected',
    pending: 'kpi',
    withheld: 'known',
    paid: true,
  };
  out = await get(f);
  assert.equal(out.status, 'available');
  assert.equal(out.work.recordSourceKey, 'legacy_work/RC-4577');
  r['legacy_work/RC-4577'].pending = '';
  unavailable(await get(f));
});
test('effective mutable project/task/actor take precedence and inactive states do not erase attribution', async () => {
  const f = fixture(),
    r = f.state.records,
    { projectId: p, taskId: t, authorInstanceId: i } = f.query;
  r[`legacy_project/${p}`] = { ...r[`legacy/project/${p}`], state: 'halted' };
  r[`legacy_task/${t}`] = {
    ...r[`legacy/task/${t}`],
    state: 'closed',
    outcome: 'expired',
  };
  r[`legacy_actor/${i}`] = {
    ...r[`legacy/actor/${i}`],
    source_state: 'inactive',
    projects: [],
  };
  r[`instance/${i}`].state = 'inactive';
  f.state.member.licence = 'revoked';
  r[`member/${f.actor.address}`].licence = 'revoked';
  r[`legacy/account/${f.actor.address}`].instances = [
    { id: 'old-imported-instance', member: f.actor.address },
  ];
  const out = await get(f);
  assert.equal(out.status, 'available');
  assert.equal(out.project.state, 'halted');
  assert.equal(out.task.outcome, 'expired');
  assert.equal(out.project.sourceKey, `legacy_project/${p}`);
});
test('missing keys, malformed present overlays, foreign identity/index/manifest and pin substitution reveal no records', async () => {
  const changes = [
    (f) => delete f.state.records['legacy_work_status/RC-4577'],
    (f) => (f.state.records['legacy_work_status/RC-4577'] = []),
    (f) => (f.state.records['legacy_work/RC-4577'] = { id: 'wrong' }),
    (f) =>
      (f.state.records[`legacy_project/${f.query.projectId}`] = {
        id: 'wrong',
      }),
    (f) => (f.state.records['legacy_task/T-41'] = {}),
    (f) => (f.state.records['legacy_actor/claude-lead'] = {}),
    (f) =>
      (f.state.records[`legacy/project/${f.query.projectId}`].work_ids = []),
    (f) => (f.state.records['legacy/task/T-41'].contributions = []),
    (f) => (f.state.records['legacy/task/T-41'].project = 'foreign'),
    (f) => (f.state.records['legacy/work/RC-4577'].author = 'foreign'),
    (f) =>
      (f.state.records['instance/claude-lead'].member =
        'uain1' + 'd'.repeat(40)),
    (f) =>
      (f.state.records[
        `legacy_account_claimed/${f.actor.address}`
      ].manifest_digest = 'd'.repeat(64)),
    (f) =>
      (f.state.records[`member/${f.actor.address}`].public_key = 'd'.repeat(
        43,
      )),
    (f) => (f.proof.epoch = 'd'.repeat(64)),
    (f) => (f.state.app_hash = 'd'.repeat(64)),
    (f) => (f.proof.headerTime = '2020-01-01T00:00:00Z'),
    (f) => (f.proof.maxAgeSeconds = 121),
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    unavailable(await get(f));
    assert.equal(f.calls.length, 1);
  }
});
test('strict96-character native IDs and actor canonical key are checked before proof admission', async () => {
  for (const query of [
    {},
    { ...fixture().query, extra: 'x' },
    { ...fixture().query, workId: 'a'.repeat(97) },
    { ...fixture().query, workId: '../x' },
    { ...fixture().query, taskId: ['T-41'] },
  ]) {
    const f = fixture();
    await assert.rejects(
      f.reader().get(f.actor, query),
      (e) => e instanceof NativeWorkCurrentError && e.status === 400,
    );
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(
    f.reader().get({ ...f.actor, address: 'uain1' + 'd'.repeat(40) }, f.query),
    (e) => e.code === 'invalid_actor',
  );
  assert.equal(f.calls.length, 0);
});
test('coalescing and deadline retain the actual one-job slot until ignored deadline transport settles', async () => {
  const f = fixture({ timeoutMs: 10 });
  let finish;
  f.native.publicState = (selection, options) => {
    f.calls.push({ selection, options });
    return new Promise((resolve) => (finish = resolve));
  };
  const reader = f.reader();
  const a = reader.get(f.actor, f.query),
    b = reader.get(f.actor, f.query);
  unavailable(await a);
  unavailable(await b);
  assert.equal(f.calls.length, 1);
  await assert.rejects(
    reader.get(f.actor, { ...f.query, workId: 'another-id' }),
    (e) => e.code === 'current_work_busy',
  );
  finish(structuredClone(f.context));
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.setTime(WHEN + 2001);
  const out = reader.get(f.actor, { ...f.query, workId: 'another-id' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.calls.length, 2);
  finish(structuredClone(f.context));
  unavailable(await out);
});
test('success cache isolates mutations, expires at signed header bound, and pin changes during read fail closed', async () => {
  const f = fixture(),
    reader = f.reader();
  const a = await reader.get(f.actor, f.query);
  a.work.state = 'forged';
  assert.equal((await reader.get(f.actor, f.query)).work.state, 'settled');
  assert.equal(f.calls.length, 1);
  f.setTime(WHEN + 120001);
  unavailable(await reader.get(f.actor, f.query));
  assert.equal(f.calls.length, 2);
  const g = fixture();
  g.native.publicState = async () => {
    g.native.pins = { ...g.pins, epoch: 'd'.repeat(64) };
    return structuredClone(g.context);
  };
  unavailable(await get(g));
});
test('six cold misses per holder per minute, failed-cache2s, no-config no native call', async () => {
  const f = fixture(),
    reader = f.reader();
  for (let i = 0; i < 6; i++)
    unavailable(await reader.get(f.actor, { ...f.query, workId: 'new-' + i }));
  await assert.rejects(
    reader.get(f.actor, { ...f.query, workId: 'new-7' }),
    (e) => e.status === 429 && e.code === 'current_work_rate_limited',
  );
  assert.equal(f.calls.length, 6);
  unavailable(await reader.get(f.actor, { ...f.query, workId: 'new-0' }));
  assert.equal(f.calls.length, 6);
  f.native.configured = false;
  unavailable(await get(f));
  assert.equal(f.calls.length, 6);
});

test('strict RFC3339 calendar and exact expiry boundary match the public proof display rule', async () => {
  for (const headerTime of [
    '2026-11-01 00:00:00 GMT',
    '2026-02-30T00:00:00Z',
    '2026-11-01T24:00:00Z',
    '2026-11-01T00:00:60Z',
  ]) {
    const f = fixture();
    f.proof.headerTime = headerTime;
    f.state.header_time = headerTime;
    // Keep parseable invalid calendar strings within the freshness window:
    // rejection must come from calendar validation, not incidental old age.
    if (Number.isFinite(Date.parse(headerTime)))
      f.setTime(Date.parse(headerTime) + 1000);
    unavailable(await get(f));
  }
  const f = fixture();
  f.proof.maxAgeSeconds = 1;
  unavailable(await get(f));
});

test('each coalesced waiter rechecks pins and proof age at its own delivery boundary', async () => {
  for (const mode of ['pins', 'clock']) {
    const f = fixture(),
      reader = f.reader(),
      clone = globalThis.structuredClone;
    let first = true;
    globalThis.structuredClone = (value) => {
      const result = clone(value);
      if (
        first &&
        value?.scope === 'native-current-work-status' &&
        value.status === 'available'
      ) {
        first = false;
        if (mode === 'pins')
          f.native.pins = { ...f.pins, epoch: 'd'.repeat(64) };
        else f.setTime(WHEN + 120000);
      }
      return result;
    };
    try {
      const [a, b] = await Promise.all([
        reader.get(f.actor, f.query),
        reader.get(f.actor, f.query),
      ]);
      assert.equal(a.status, 'available');
      unavailable(b);
    } finally {
      globalThis.structuredClone = clone;
    }
  }
});

test('cache is bounded32; success20s, unavailable2s and holder minute limit reset are independent', async () => {
  const f = fixture(),
    reader = f.reader();
  await reader.get(f.actor, f.query);
  f.setTime(WHEN + 19999);
  await reader.get(f.actor, f.query);
  assert.equal(f.calls.length, 1);
  f.setTime(WHEN + 20001);
  await reader.get(f.actor, f.query);
  assert.equal(f.calls.length, 2);
  const g = fixture(),
    bad = g.reader();
  g.state.records['legacy_work/RC-4577'] = {};
  unavailable(await bad.get(g.actor, g.query));
  g.state.records['legacy_work/RC-4577'] = null;
  g.setTime(WHEN + 1999);
  unavailable(await bad.get(g.actor, g.query));
  assert.equal(g.calls.length, 1);
  g.setTime(WHEN + 2001);
  assert.equal((await bad.get(g.actor, g.query)).status, 'available');
  assert.equal(g.calls.length, 2);
  const h = fixture(),
    bounded = h.reader(),
    actors = [];
  for (let i = 0; i < 33; i++) {
    const { createHash } = await import('node:crypto');
    const publicKey = createHash('sha256')
      .update('synthetic-public-key-' + i)
      .digest('base64');
    actors.push(nativeWorkCurrentFixture({ publicKey }).actor);
    unavailable(await bounded.get(actors[i], h.query));
  }
  assert.equal(h.calls.length, 33);
  unavailable(await bounded.get(actors[0], h.query));
  assert.equal(h.calls.length, 34);
  const j = fixture(),
    limited = j.reader();
  for (let i = 0; i < 6; i++)
    unavailable(
      await limited.get(j.actor, { ...j.query, workId: 'unknown-' + i }),
    );
  j.setTime(WHEN + 60001);
  unavailable(
    await limited.get(j.actor, { ...j.query, workId: 'new-after-window' }),
  );
  assert.equal(j.calls.length, 7);
});

test('current status waits across consumers while preserving the shared adapter two-process cap', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { createNativeAssetAdapter } =
    await import('../server/native-asset.mjs');
  const sha = (value) => createHash('sha256').update(value).digest('hex'),
    dir = await mkdtemp(join(tmpdir(), 'baink-current-pool-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = nativeWorkCurrentFixture({ headerTime: new Date().toISOString() }),
    genesis = JSON.stringify({ chain_id: f.pins.chainId }),
    genesisPath = join(dir, 'genesis.json'),
    binary = join(dir, 'reader'),
    trace = join(dir, 'trace');
  // Isolated synthetic executable qualifies pin/selection/pool plumbing only;
  // it is not a consensus verifier and never contacts the RPC or writes state.
  const script = `#!${process.execPath}\nconst fs=require('fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const q=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:'start',pid:process.pid})+'\\n');setTimeout(()=>{const s=${JSON.stringify(f.state)};const records=s.records;s.records=Object.fromEntries(['legacy_import',...(q.keys||[])].map(k=>[k,Object.hasOwn(records,k)?records[k]:null]));fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify(s),{mode:384,flag:'wx'});fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:'end',pid:process.pid})+'\\n');},100);});\n`;
  await writeFile(binary, script, { mode: 0o700 });
  await writeFile(genesisPath, genesis);
  const native = createNativeAssetAdapter({
    config: {
      binary,
      binaryHash: sha(script),
      genesis: genesisPath,
      genesisHash: sha(genesis),
      rpc: 'http://127.0.0.1:1',
      chainId: f.pins.chainId,
      timeoutMs: 2000,
      maxAgeSeconds: 120,
    },
  });
  const a = native.publicState({ member: f.actor.address, keys: f.keys }),
    b = native.publicState({ member: f.actor.address, keys: f.keys });
  const queued = await createNativeWorkCurrent({ native }).get(f.actor, f.query);
  assert.equal(queued.status, 'available', 'A short shared-pool wait does not turn a valid native result unavailable');
  await Promise.all([a, b]);
  const traceState = async () => {
    const entries = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    let active = 0, maximum = 0;
    for (const entry of entries) { active += entry.event === 'start' ? 1 : -1; maximum = Math.max(maximum, active); assert.ok(active >= 0 && active <= 2); }
    assert.equal(active, 0); assert.equal(maximum, 2);
    return entries.filter(entry => entry.event === 'start').length;
  };
  assert.equal(await traceState(), 3);
  const out = await createNativeWorkCurrent({ native }).get(f.actor, f.query);
  assert.equal(out.status, 'available');
  assert.equal(await traceState(), 4);
});

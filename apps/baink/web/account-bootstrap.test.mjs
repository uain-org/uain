import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as bootstrap from './account-bootstrap.js';
import { clearNativeAuthority } from './native-balance.js';
import {
  resolveWorkspaceRoute,
  parseWorkspaceRoute,
  workspaceUrl,
} from './workspace-route.js';
const a = { address: 'uain1' + 'a'.repeat(40), publicKeyBase64: 'public-a' },
  b = { address: 'uain1' + 'b'.repeat(40), publicKeyBase64: 'public-b' };
const metadata = (id) => ({
  account: {
    address: id.address,
    publicKey: id.publicKeyBase64,
    displayName: 'Holder',
    createdAt: null,
    updatedAt: null,
    currency: 'AI$',
    balance: null,
    nativeRegistration: 'unavailable',
  },
  nativeStatus: 'not-requested',
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function configRefresh(context) {
  const source = readFileSync(new URL('./main.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const refreshConfig = async ');
  const end = source.indexOf('\n  useEffect(', start);
  assert.ok(start > 0 && end > start, 'shared guarded config refresh exists');
  return runInNewContext(`(${source.slice(start, end).trim().replace(/^const refreshConfig = /, '').replace(/;$/, '')})`, context);
}
test('network configuration refresh drops superseded and signed-out account reads', async () => {
  const first = deferred(), second = deferred(), rows = [], jobs = [first, second];
  let current = true;
  const refresh = configRefresh({
    configReadSequence: { current: 0 },
    api: () => jobs.shift().promise,
    setConfig: (value) => rows.push(value),
    clearNativeAuthority,
  });
  const old = refresh(() => current), latest = refresh(() => current);
  second.resolve({ native: { verified: true } });
  await latest;
  first.resolve({ obsolete: true });
  await old;
  assert.equal(rows.length, 1);
  const third = deferred(); jobs.push(third);
  const leaving = refresh(() => current);
  current = false;
  third.resolve({ obsolete: true });
  await leaving;
  assert.equal(rows.length, 1);
});
test('failed current config refresh clears authority instead of retaining a live network claim', async () => {
  let value = { native: { verified: true, status: 'asset_inactive' } };
  const refresh = configRefresh({
    configReadSequence: { current: 0 },
    api: async () => { throw Error('offline'); },
    setConfig: (update) => { value = update(value); },
    clearNativeAuthority,
  });
  await refresh(() => true);
  assert.equal(value.native.verified, false);
  assert.equal(value.native.proof, null);
});
test('signed-in periodic refresh starts config without waiting for slow native account proof', async () => {
  const source = readFileSync(new URL('./main.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('    const refresh = async () => {');
  const end = source.indexOf('\n    const visible = ', start);
  const native = deferred(), events = [];
  const refresh = runInNewContext(`(${source.slice(start, end).trim().replace(/^const refresh = /, '').replace(/;$/, '')})`, {
    active: true,
    identity: a,
    refreshConfig: async (isCurrent) => { assert.equal(isCurrent(), true); events.push('config'); },
    nativeRefresh: { current: { isCurrent: (id) => id === a, refresh: () => { events.push('account'); return native.promise; } } },
  });
  const waiting = refresh();
  assert.deepEqual(events, ['config', 'account']);
  native.resolve();
  await waiting;
});
test('manual account load refreshes global config even when native proof refresh is skipped', async () => {
  const source = readFileSync(new URL('./main.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const load = async ');
  const end = source.indexOf('\n  useEffect(', start);
  let current = true;
  const guards = [], events = [];
  const load = runInNewContext(`(${source.slice(start, end).trim().replace(/^const load = /, '').replace(/;$/, '')})`, {
    identity: a,
    loadSequence: { current: 0 }, requestData: {}, incomingData: {},
    setLoading: () => {}, setApiError: () => {},
    nativeRefresh: { current: { isCurrent: () => current, refresh: async () => events.push('account') } },
    refreshConfig: async (guard) => { guards.push(guard); events.push('config'); },
    hydrateAccountActivity: async () => {}, api: async () => ({ intents: [] }),
    loadingRef: { current: false }, setPaymentLocks: () => {}, setActivityAt: () => {}, setActivityFailed: () => {},
    paymentLocksFrom: () => new Map(),
  });
  await load(a, { skipNative: true });
  assert.deepEqual(events, ['config']);
  assert.equal(guards[0](), true);
  current = false;
  assert.equal(guards[0](), false);
  await load(a);
  assert.deepEqual(events, ['config']);
});
test('returning holder opens on metadata and activity commits while the sole native proof is still blocked', async () => {
  assert.equal(typeof bootstrap.createAccountEntryLoader, 'function');
  const proof = deferred(),
    history = deferred(),
    calls = [],
    events = [];
  const request = async (path, { identity }) => {
    assert.equal(identity, a);
    calls.push(path);
    if (path === '/api/account/metadata') return metadata(a);
    if (path === '/api/account') return proof.promise;
    if (path === '/api/history') return history.promise;
    return {
      requests: [{ id: path.includes('incoming') ? 'incoming' : 'all' }],
      count: 1,
      page: 1,
      pageSize: 50,
      pages: 1,
    };
  };
  const entry = await bootstrap.createAccountEntryLoader(request).load(a, '');
  assert.equal(entry.needsNativeRefresh, true);
  assert.equal(entry.account.balance, null);
  assert.equal(entry.account.native.memberStatus, 'unknown');
  assert.equal(
    bootstrap.accountBalanceView(entry.account, true).state,
    'checking',
  );
  assert.equal(
    bootstrap.accountBalanceView(entry.account, true).membershipVerified,
    false,
  );
  const route = resolveWorkspaceRoute(
    parseWorkspaceRoute('?view=trade&provider=' + b.address),
    { isNew: false, memberStatus: entry.account.native.memberStatus },
  );
  assert.equal(route.provider, b.address);
  const native = bootstrap.createNativeAccountRefresh(request, (event) =>
    events.push(event),
  );
  native.activate(a);
  const first = native.refresh(),
    overlapping = native.refresh();
  const activity = bootstrap.hydrateAccountActivity(
    request,
    a,
    { allPage: 1, incomingPage: 1 },
    (event) => events.push(event),
    () => native.isCurrent(a),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((path) => path === '/api/account').length, 1);
  assert.ok(
    events.some(
      (event) =>
        event.kind === 'requests' && event.data.requests[0].id === 'all',
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.kind === 'incoming' && event.data.requests[0].id === 'incoming',
    ),
  );
  assert.equal(
    events.some((event) => event.kind === 'native'),
    false,
  );
  history.resolve({ history: [{ id: 'activity' }] });
  await activity;
  assert.ok(events.some((event) => event.kind === 'history'));
  proof.resolve({
    account: {
      ...metadata(a).account,
      native: { verified: false, memberStatus: 'unknown', proof: null },
    },
  });
  await Promise.all([first, overlapping]);
  assert.equal(events.filter((event) => event.kind === 'native').length, 1);
});
test('metadata errors cannot silently create an account or fall back to a proof-dependent read', async () => {
  for (const code of [
    'invalid_signature',
    'forbidden',
    'internal_error',
    'not_found',
  ]) {
    const calls = [];
    const loader = bootstrap.createAccountEntryLoader(async (path, options) => {
      calls.push([path, options]);
      throw Object.assign(Error(code), { code });
    });
    await assert.rejects(loader.load(a, ''), (error) => error.code === code);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/api/account/metadata');
  }
});
test('missing local account retains the qualified creation path without a second initial proof', async () => {
  const calls = [];
  const loader = bootstrap.createAccountEntryLoader(async (path, options) => {
    calls.push([path, options]);
    if (path === '/api/account/metadata')
      throw Object.assign(Error('missing'), { code: 'account_missing' });
    return {
      account: {
        ...metadata(a).account,
        native: { verified: true, memberStatus: 'missing' },
      },
    };
  });
  const entry = await loader.load(a, 'New name');
  assert.equal(entry.needsNativeRefresh, false);
  assert.deepEqual(
    calls.map(([path, options]) => [path, options.method || 'GET']),
    [
      ['/api/account/metadata', 'GET'],
      ['/api/account', 'POST'],
    ],
  );
  assert.deepEqual(calls[1][1].body, { displayName: 'New name' });
  assert.equal(
    resolveWorkspaceRoute(parseWorkspaceRoute(''), {
      isNew: true,
      memberStatus: entry.account.native.memberStatus,
    }).tab,
    'Dashboard', // new members land on the Overview, which leads them to Join UAIN
  );
});
test('metadata cannot inject foreign identity, authority or a fabricated zero balance', async () => {
  for (const response of [
    metadata(b),
    { ...metadata(a), nativeStatus: 'verified' },
    {
      ...metadata(a),
      account: { ...metadata(a).account, balance: '0.000000' },
    },
    {
      ...metadata(a),
      account: { ...metadata(a).account, nativeRegistration: 'verified' },
    },
    {
      ...metadata(a),
      account: { ...metadata(a).account, native: { verified: true } },
    },
  ]) {
    await assert.rejects(
      bootstrap.createAccountEntryLoader(async () => response).load(a, ''),
      /metadata|identity/i,
    );
  }
});
test('logout and replacement discard late metadata, native data, native errors and activity', async () => {
  const metadataJob = deferred(),
    loader = bootstrap.createAccountEntryLoader(() => metadataJob.promise);
  const entering = loader.load(a, '');
  loader.invalidate();
  metadataJob.resolve(metadata(a));
  assert.equal(await entering, null);
  const jobs = [deferred(), deferred(), deferred()],
    events = [];
  let read = 0;
  const native = bootstrap.createNativeAccountRefresh(
    () => jobs[read++].promise,
    (event) => events.push(event),
  );
  native.activate(a);
  const old = native.refresh();
  native.activate(b);
  const current = native.refresh();
  jobs[0].resolve({ account: metadata(a).account });
  await old;
  assert.equal(
    events.some((event) => event.kind === 'native'),
    false,
  );
  jobs[1].resolve({ account: metadata(b).account });
  await current;
  assert.equal(
    events.filter((event) => event.kind === 'native').at(-1).account.address,
    b.address,
  );
  const failing = native.refresh();
  native.invalidate();
  const count = events.length;
  jobs[2].reject(Error('old failure'));
  await failing;
  assert.equal(events.length, count);
  const pending = deferred(),
    activity = [];
  let active = true;
  const hydrating = bootstrap.hydrateAccountActivity(
    () => pending.promise,
    a,
    { allPage: 1, incomingPage: 1 },
    (event) => activity.push(event),
    () => active,
  );
  const pendingEventCount = activity.length;
  active = false;
  pending.resolve({ requests: [], history: [] });
  await hydrating;
  assert.equal(activity.length, pendingEventCount);
});
test('wrong-owner native responses fail closed and one activity failure cannot withhold successful history', async () => {
  const events = [],
    native = bootstrap.createNativeAccountRefresh(
      async () => ({ account: metadata(b).account }),
      (event) => events.push(event),
    );
  native.activate(a);
  await native.refresh();
  assert.ok(events.some((event) => event.kind === 'native-error'));
  assert.equal(
    events.some((event) => event.kind === 'native'),
    false,
  );
  const activity = [];
  await bootstrap.hydrateAccountActivity(
    async (path) => {
      if (path === '/api/history') return { history: [{ id: 'real' }] };
      throw Error('requests unavailable');
    },
    a,
    { allPage: 2, incomingPage: 3 },
    (event) => activity.push(event),
    () => true,
  );
  assert.ok(
    activity.some(
      (event) =>
        event.kind === 'history' && event.data.history[0].id === 'real',
    ),
  );
  assert.equal(
    activity.filter((event) => event.kind === 'activity-error').length,
    2,
  );
});
test('a second metadata login supersedes the first and a cancelled missing-account lookup cannot register', async () => {
  const first = deferred(),
    second = deferred(),
    calls = [];
  const loader = bootstrap.createAccountEntryLoader((path, options) => {
    calls.push(path);
    return options.identity === a ? first.promise : second.promise;
  });
  const old = loader.load(a, ''),
    current = loader.load(b, '');
  second.resolve(metadata(b));
  assert.equal((await current).account.address, b.address);
  first.reject(Object.assign(Error('missing'), { code: 'account_missing' }));
  assert.equal(await old, null);
  assert.deepEqual(calls, ['/api/account/metadata', '/api/account/metadata']);
});
test('pending and failed native reads never promote unknown metadata to missing membership or financial readiness', async () => {
  const entry = await bootstrap
    .createAccountEntryLoader(async () => metadata(a))
    .load(a, '');
  for (const pending of [true, false]) {
    const view = bootstrap.accountBalanceView(entry.account, pending);
    assert.equal(view.available, false);
    assert.equal(view.amount, '—');
    assert.equal(view.membershipVerified, false);
    assert.notEqual(view.state, 'member_missing');
  }
});
test('a synchronous transport failure cannot pin native refresh to an already settled promise', async () => {
  let calls = 0;
  const events = [];
  const native = bootstrap.createNativeAccountRefresh(
    () => {
      calls++;
      if (calls === 1) throw Error('synchronous transport failure');
      return { account: metadata(a).account };
    },
    (event) => events.push(event),
  );
  native.activate(a);
  await native.refresh();
  assert.equal(
    events.filter((event) => event.kind === 'native-error').length,
    1,
  );
  await native.refresh();
  assert.equal(calls, 2);
  assert.equal(events.filter((event) => event.kind === 'native').length, 1);
});
test('actual login commit follows the latest safe URL after metadata, including a cleared route and new-member default', async () => {
  const source = readFileSync(new URL('./main.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const ready = async ');
  const end = source.indexOf('\n  const copy = ', start);
  assert.ok(start >= 0 && end > start);
  const readySource = source
    .slice(start, end)
    .trim()
    .replace(/^const ready = /, '')
    .replace(/;$/, '');
  for (const scenario of [
    {
      latest: `?view=trade&provider=${b.address}`,
      isNew: false,
      tab: 'Trade',
      provider: b.address,
    },
    {
      latest: '?view=__proto__',
      isNew: true,
      tab: 'Dashboard',
      provider: null,
    },
    { latest: '', isNew: true, tab: 'Dashboard', provider: null },
    { latest: '', isNew: false, tab: 'Dashboard', provider: null },
  ]) {
    const waiting = deferred(),
      committed = {};
    const location = new URL(
      `https://aidollar.money/baink/?view=trade&provider=${a.address}`,
    );
    const noop = () => {};
    const ready = runInNewContext(`(${readySource})`, {
      entryLoader: { current: { load: () => waiting.promise } },
      loadSequence: { current: 0 },
      nativeRefresh: { current: { activate: noop } },
      workspaceRoute: parseWorkspaceRoute(location.search),
      parseWorkspaceRoute,
      resolveWorkspaceRoute,
      workspaceUrl,
      location,
      setIdentity: noop,
      setAccount: noop,
      setNativePending: noop,
      setAuthMode: noop,
      setWorkspaceRoute: (value) => {
        committed.route = value;
      },
      setTab: (value) => {
        committed.tab = value;
      },
      setPublicMemberAddress: noop,
      load: async () => {},
      window: {
        history: {
          replaceState: (_state, _title, url) => {
            location.href = url;
          },
        },
        scrollTo: noop,
      },
    });
    const opening = ready(a, '', scenario.isNew);
    location.href = 'https://aidollar.money/baink/' + scenario.latest;
    waiting.resolve({
      account: { ...metadata(a).account, native: { memberStatus: 'missing' } },
      needsNativeRefresh: true,
    });
    await opening;
    assert.equal(committed.tab, scenario.tab);
    assert.equal(committed.route.provider, scenario.provider);
    assert.equal(location.pathname, '/baink/');
    assert.equal(
      new URL(location.href).searchParams.get('provider'),
      scenario.provider,
    );
  }
});
test('each activity source stays unknown while pending or failed, without withholding successful empty reads', async () => {
  assert.equal(typeof bootstrap.initialActivityReadiness, 'function');
  for (const blocked of ['incoming', 'requests', 'history']) {
    let readiness = bootstrap.initialActivityReadiness();
    const waiting = deferred(),
      data = {
        incoming: { requests: [], count: 0, page: 1, pageSize: 50, pages: 1 },
        requests: { requests: [], count: 0, page: 1, pageSize: 50, pages: 1 },
        history: { history: [] },
      };
    const events = [];
    const publish = (event) => {
      events.push(event);
      readiness = bootstrap.reduceActivityReadiness(readiness, event);
      if (['incoming', 'requests', 'history'].includes(event.kind))
        data[event.kind] = event.data;
    };
    const hydrating = bootstrap.hydrateAccountActivity(
      async (path) => {
        const source =
          path === '/api/history'
            ? 'history'
            : path.includes('direction=incoming')
              ? 'incoming'
              : 'requests';
        return source === blocked ? waiting.promise : data[source];
      },
      a,
      { allPage: 1, incomingPage: 1 },
      publish,
      () => true,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const pending = bootstrap.activityReadView(
      readiness,
      blocked,
      data[blocked],
    );
    assert.equal(pending.ready, false);
    assert.equal(pending.count, undefined);
    assert.equal(pending.loading, true);
    for (const source of ['incoming', 'requests', 'history'].filter(
      (value) => value !== blocked,
    )) {
      const successful = bootstrap.activityReadView(
        readiness,
        source,
        data[source],
      );
      assert.equal(successful.ready, true);
      assert.equal(successful.count, 0);
    }
    waiting.reject(Error('temporarily unavailable'));
    await hydrating;
    const failed = bootstrap.activityReadView(
      readiness,
      blocked,
      data[blocked],
    );
    assert.equal(failed.ready, false);
    assert.equal(failed.count, undefined);
    assert.equal(failed.loading, false);
    assert.match(failed.message, /unavailable/i);
    assert.equal(
      events.find((event) => event.kind === 'activity-error').source,
      blocked,
    );
    readiness = bootstrap.reduceActivityReadiness(readiness, {
      kind: 'activity-pending',
      source: blocked,
    });
    assert.equal(
      bootstrap.activityReadView(readiness, blocked, data[blocked]).count,
      undefined,
    );
    readiness = bootstrap.reduceActivityReadiness(readiness, {
      kind: blocked,
      data: data[blocked],
    });
    assert.equal(
      bootstrap.activityReadView(readiness, blocked, data[blocked]).count,
      0,
    );
  }
});
test('failed activity refresh hides previously successful counts and rows until that source succeeds again', () => {
  let state = bootstrap.initialActivityReadiness();
  const rows = { requests: [{ id: 'known' }], count: 9 };
  state = bootstrap.reduceActivityReadiness(state, {
    kind: 'incoming',
    data: rows,
  });
  assert.equal(bootstrap.activityReadView(state, 'incoming', rows).count, 9);
  state = bootstrap.reduceActivityReadiness(state, {
    kind: 'activity-pending',
    source: 'incoming',
  });
  assert.equal(
    bootstrap.activityReadView(state, 'incoming', rows).ready,
    false,
  );
  state = bootstrap.reduceActivityReadiness(state, {
    kind: 'activity-error',
    source: 'incoming',
    error: Error('offline'),
  });
  assert.equal(
    bootstrap.activityReadView(state, 'incoming', rows).count,
    undefined,
  );
  assert.equal(
    bootstrap.activityReadView(state, 'incoming', rows).ready,
    false,
  );
});
test('malformed successful HTTP responses cannot qualify any activity source as empty', async () => {
  for (const malformed of ['incoming', 'requests', 'history']) {
    let readiness = bootstrap.initialActivityReadiness();
    const events = [];
    await bootstrap.hydrateAccountActivity(
      async (path) => {
        const source =
          path === '/api/history'
            ? 'history'
            : path.includes('direction=incoming')
              ? 'incoming'
              : 'requests';
        if (source === malformed) return {};
        return source === 'history'
          ? { history: [] }
          : { requests: [], count: 0, page: 1, pageSize: 50, pages: 1 };
      },
      a,
      { allPage: 1, incomingPage: 1 },
      (event) => {
        events.push(event);
        readiness = bootstrap.reduceActivityReadiness(readiness, event);
      },
      () => true,
    );
    assert.equal(
      bootstrap.activityReadView(readiness, malformed, {
        requests: [],
        count: 0,
        history: [],
      }).ready,
      false,
    );
    assert.equal(
      events.find((event) => event.kind === 'activity-error').source,
      malformed,
    );
  }
});
test('entry invalidation cancels admission waits before another metadata or profile attempt',async()=>{let options;const loader=bootstrap.createAccountEntryLoader(async(path,opts)=>{options=opts;return new Promise((resolve,reject)=>{opts.signal?.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});});});const pending=loader.load(a,'');assert.equal(options.signal?.aborted,false);assert.equal(options.isCurrent?.(),true);loader.invalidate();assert.equal(options.signal.aborted,true);assert.equal(options.isCurrent(),false);assert.equal(await pending,null);});
test('explicit newly generated identity creates directly once while imported identities keep metadata lookup',async()=>{const calls=[],loader=bootstrap.createAccountEntryLoader(async(path,options)=>{calls.push({path,options});return path==='/api/account'?{account:metadata(a).account}:metadata(a);});const created=await loader.load(a,'New holder',true);assert.equal(created.account.address,a.address);assert.equal(created.needsNativeRefresh,false);assert.deepEqual(calls.map(c=>c.path),['/api/account']);assert.equal(calls[0].options.method,'POST');assert.deepEqual(calls[0].options.body,{displayName:'New holder'});calls.length=0;assert.equal((await loader.load(a,'',false)).needsNativeRefresh,true);assert.deepEqual(calls.map(c=>c.path),['/api/account/metadata']);});
test('cancelled direct creation cannot publish a late account and owner substitution still refuses',async()=>{const job=deferred();let options;const loader=bootstrap.createAccountEntryLoader(async(_p,o)=>{options=o;return job.promise;});const work=loader.load(a,'New',true);loader.invalidate();assert.equal(options.signal.aborted,true);job.resolve({account:metadata(a).account});assert.equal(await work,null);await assert.rejects(bootstrap.createAccountEntryLoader(async()=>({account:metadata(b).account})).load(a,'New',true),/identity/);});

test('fresh profile metadata explicitly starts a separate native refresh without borrowing native authority',async()=>{
 const calls=[],loader=bootstrap.createAccountEntryLoader(async(path,options)=>{calls.push([path,options.method]);return metadata(a);});
 const result=await loader.load(a,'Fresh metadata',true);
 assert.deepEqual(calls,[['/api/account','POST']]);assert.equal(result.needsNativeRefresh,true);assert.equal(result.account.native.verified,false);assert.equal(result.account.balance,null);
});
test('fresh profile metadata rejects monetary fields and unknown native status',async()=>{
 for(const response of [{...metadata(a),account:{...metadata(a).account,balance:'100'}},{...metadata(a),nativeStatus:'ready'}]){
  const loader=bootstrap.createAccountEntryLoader(async()=>response);await assert.rejects(loader.load(a,'Fresh metadata',true));
 }
});

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { checkSources, setSourceFetcher, setSourceResolver } from '../dist/src/integrations/sources.js';

afterEach(() => { setSourceFetcher(null); setSourceResolver(null); });
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (status = 200, location = null) => ({
  ok: status >= 200 && status < 300, status,
  headers: new Headers(location ? { location } : {}), json: async () => ({}),
});

test('private, special-use and encoded literal destinations never reach the transport', async () => {
  let calls = 0;
  setSourceResolver(publicDns);
  setSourceFetcher(async () => { calls++; return response(); });
  for (const host of ['127.0.0.1', '127.1', '2130706433', '0x7f000001', '10.1.2.3',
    '172.16.1.2', '192.168.0.1', '169.254.169.254', '100.100.100.200', '0.0.0.0',
    '192.0.2.1', '198.18.0.1', '224.0.0.1', '[::1]', '[::ffff:127.0.0.1]',
    '[fc00::1]', '[fe80::1]', '[2001:db8::1]', '[2002:7f00:1::1]']) {
    const [r] = await checkSources([`http://${host}/metadata`]);
    assert.equal(r.blocked, true, `${host}: ${JSON.stringify(r)}`);
    assert.equal(r.status, 'unchecked');
  }
  assert.equal(calls, 0);
});

test('DNS private and mixed public/private answers are refused before connection', async () => {
  let calls = 0;
  setSourceFetcher(async () => { calls++; return response(); });
  for (const records of [[{ address: '10.0.0.1', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }]]) {
    setSourceResolver(async () => records);
    const [r] = await checkSources(['https://paper.example/x']);
    assert.equal(r.blocked, true, JSON.stringify(r));
  }
  assert.equal(calls, 0);
});

test('a public redirect to a private address is blocked without fetching the target', async () => {
  const visited = [];
  setSourceResolver(publicDns);
  setSourceFetcher(async (url, init) => {
    visited.push(url);
    assert.equal(init.redirect, 'manual');
    return response(302, 'http://169.254.169.254/latest/meta-data');
  });
  const [r] = await checkSources(['https://paper.example/x']);
  assert.equal(r.blocked, true, JSON.stringify(r));
  assert.deepEqual(visited, ['https://paper.example/x']);
});

test('the connection lookup uses the validated address without resolving again', async () => {
  let resolutions = 0;
  setSourceResolver(async () => {
    resolutions++;
    return [{ address: resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
  });
  setSourceFetcher(async (_url, init) => {
    const result = await new Promise((resolve, reject) =>
      init.lookup('paper.example', {}, (err, address, family) => err ? reject(err) : resolve({ address, family })));
    assert.deepEqual(result, { address: '93.184.216.34', family: 4 });
    return response();
  });
  const [r] = await checkSources(['https://paper.example/x']);
  assert.equal(r.status, 'found', JSON.stringify(r));
  assert.equal(resolutions, 1);
});

test('URL credentials and nonstandard ports are refused without transport calls', async () => {
  let calls = 0;
  setSourceResolver(publicDns);
  setSourceFetcher(async () => { calls++; return response(); });
  for (const url of ['https://user:secret@paper.example/x', 'http://paper.example:8080/x']) {
    const [r] = await checkSources([url]);
    assert.equal(r.blocked, true, JSON.stringify(r));
    assert.doesNotMatch(r.detail, /secret/);
  }
  assert.equal(calls, 0);
});

// P2-1 (13 November 2026): one member could fill the process-wide source pool
// with web addresses that never answer, so another member's invented trial
// number came back "unchecked" and was accepted instead of "missing".
function tarpit() {
  const held = [];
  let open = true;
  setSourceResolver(publicDns);
  setSourceFetcher((url, init) => {
    if (url.startsWith('https://clinicaltrials.gov/')) return Promise.resolve(response(404));
    if (!open) return Promise.resolve(response(200));
    return new Promise((resolve, reject) => {
      held.push(() => resolve(response(200)));
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });
  const urls = (k) => Array.from({ length: 100 }, (_, i) => `https://slow${i}.example.org/x?${k}`);
  // Each call holds at most 4 places, so 20 calls (80 places) overflow the 8 slots and 64 queue places.
  const calls = Array.from({ length: 20 }, (_, k) => checkSources(urls(k)));
  return async () => {
    open = false;
    while (held.length) held.shift()();
    await Promise.all(calls);
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('a saturated web-address pool does not let an invented registry citation through', async () => {
  const release = tarpit();
  try {
    await settle();
    const [r] = await checkSources(['NCT99999999']);
    assert.equal(r.status, 'missing', JSON.stringify(r));
  } finally { await release(); }
});

test('a source the busy pool could not check is "busy", never "unchecked"', async () => {
  const release = tarpit();
  try {
    await settle();
    const [r] = await checkSources(['https://invented.example.net/paper']);
    assert.equal(r.status, 'busy', JSON.stringify(r));
  } finally { await release(); }
});

// Review follow-up to P2-1 (13 November 2026): the citation check's capacity
// must refuse only real overload. Honest submissions at modest load are
// checked; one member's slow web addresses cannot fill the shared queue; and
// a full check ends inside the MCP deadline, reporting what it could not reach
// as "busy" (refused as retryable), never as "unchecked".
process.env.UAIN_SOURCE_TIMEOUT_MS = '400';
const assert = (await import('node:assert/strict')).default;
const { afterEach, test } = await import('node:test');
const { checkSources, setSourceFetcher, setSourceResolver } = await import('../dist/src/integrations/sources.js');

afterEach(() => { setSourceFetcher(null); setSourceResolver(null); });
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

test('two members each citing 8 DOIs with a cutoff are both checked, none busy', async () => {
  setSourceResolver(publicDns);
  setSourceFetcher(async (url, init) => {
    await pause(200, init.signal); // each registry answer takes half a fetch deadline
    if (url.startsWith('https://api.crossref.org/'))
      return response(200, { message: { issued: { 'date-parts': [[2020, 1, 2]] } } });
    return response(200);
  });
  const dois = (m) => Array.from({ length: 8 }, (_, i) => `10.1000/member${m}.${i}`);
  const [a, b] = await Promise.all([checkSources(dois(1), { cutoff: '2025-01-01' }), checkSources(dois(2), { cutoff: '2025-01-01' })]);
  for (const r of [...a, ...b]) assert.equal(r.status, 'found', JSON.stringify(r));
});

test("one call's slow web addresses hold at most 4 places in the shared pool", async () => {
  setSourceResolver(publicDns);
  let inFlight = 0, peak = 0;
  setSourceFetcher(async (_url, init) => {
    inFlight++; peak = Math.max(peak, inFlight);
    try { await pause(50, init.signal); return response(200); } finally { inFlight--; }
  });
  const urls = Array.from({ length: 20 }, (_, i) => `https://slow${i}.example.org/x`);
  const results = await checkSources(urls);
  assert.equal(results.filter((r) => r.status === 'found').length, 20);
  assert.ok(peak <= 4, `peak ${peak}`);
});

test('a check that runs past its overall bound reports the rest as busy, never unchecked', async () => {
  setSourceResolver(publicDns);
  setSourceFetcher((_url, init) => new Promise((_resolve, reject) =>
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })));
  const started = Date.now();
  const results = await checkSources(['10.1000/slow', 'NCT12345678', 'https://slow.example.org/x'], { totalMs: 150 });
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  for (const r of results) assert.equal(r.status, 'busy', JSON.stringify(r));
});

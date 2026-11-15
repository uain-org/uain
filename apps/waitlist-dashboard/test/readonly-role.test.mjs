/**
 * sql/readonly-role.sql, run with psql as the operator will run it, on a
 * temporary database. The role it makes may read the waitlist and nothing
 * else, and the app works with only that.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import pg from 'pg';
import {
  Browser,
  adminQuery,
  createTempDb,
  fixtureRows,
  startApp,
} from './helpers.mjs';

const sqlFile = fileURLToPath(
  new URL('../sql/readonly-role.sql', import.meta.url),
);
const hasPsql = spawnSync('psql', ['--version']).status === 0;
const role = `wl_reader_test_${randomBytes(4).toString('hex')}`;
const password = randomBytes(24).toString('hex');

let db;
before(async () => {
  if (!hasPsql) return;
  db = await createTempDb();
});
after(async () => {
  if (!db) return;
  await db.drop();
  await adminQuery(`DROP ROLE IF EXISTS ${role}`);
});

function psql(vars = {}, env = {}) {
  const args = [
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-d',
    db.url,
    '-f',
    sqlFile,
  ];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  return spawnSync('psql', args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const readerUrl = () => {
  const u = new URL(db.url);
  u.username = role;
  u.password = password;
  return u.toString();
};

async function asReader(fn) {
  const c = new pg.Client({ connectionString: readerUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function refused(c, sql, codes = ['42501']) {
  await assert.rejects(c.query(sql), (err) => {
    assert.ok(codes.includes(err.code), `${sql}: ${err.code} ${err.message}`);
    return true;
  });
}

const skip = !hasPsql && 'psql is not installed';

test('the file refuses to run without a real password', { skip }, () => {
  const none = psql({ role }, { UAIN_WAITLIST_DB_PASSWORD: '' });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /at least 16 characters/);
  const short = psql({ role, password: 'short' });
  assert.notEqual(short.status, 0);
});

test(
  'the file applies, and applies again, with the password from -v or the environment',
  { skip },
  async () => {
    const first = psql({ role, password });
    assert.equal(first.status, 0, first.stderr);
    const again = psql({ role }, { UAIN_WAITLIST_DB_PASSWORD: password });
    assert.equal(again.status, 0, again.stderr);
    const attrs = await adminQuery(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolconnlimit, rolconfig
     FROM pg_roles WHERE rolname = $1`,
      [role],
      db.url,
    );
    assert.deepEqual(attrs.rows[0], {
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: 10,
      rolconfig: ['default_transaction_read_only=on', 'statement_timeout=15s'],
    });
    const defaults = await adminQuery(
      `SELECT count(*)::int AS n FROM pg_default_acl WHERE array_to_string(defaclacl, ',') LIKE '%' || $1 || '%'`,
      [role],
      db.url,
    );
    assert.equal(defaults.rows[0].n, 0, 'no default privileges');
  },
);

test(
  'the role reads the waitlist and nothing else, and writes nothing',
  { skip },
  async () => {
    await asReader(async (c) => {
      const { rows } = await c.query('SELECT count(*)::int AS n FROM waitlist');
      assert.equal(rows[0].n, fixtureRows().length);
      assert.equal(
        (await c.query('SHOW default_transaction_read_only')).rows[0]
          .default_transaction_read_only,
        'on',
      );

      // Read-only transactions refuse writes first (25006) ...
      for (const sql of [
        `UPDATE waitlist SET status = 'verified'`,
        `DELETE FROM waitlist`,
        `INSERT INTO waitlist (name, system_types, description, channel, registered_at) VALUES ('x','[]','x','web','x')`,
      ])
        await refused(c, sql, ['25006', '42501']);

      // ... and with read-only lifted, the privileges refuse them (42501).
      await c.query('BEGIN READ WRITE');
      await refused(c, `UPDATE waitlist SET status = 'verified'`);
      await c.query('ROLLBACK');
      for (const sql of [
        `DELETE FROM waitlist`,
        `TRUNCATE waitlist`,
        `INSERT INTO waitlist (name, system_types, description, channel, registered_at) VALUES ('x','[]','x','web','x')`,
        `SELECT * FROM participants`,
        `SELECT secret FROM participants`,
        `CREATE TABLE public.mine (x int)`,
        `ALTER TABLE waitlist ADD COLUMN x int`,
        `SELECT nextval('waitlist_seq_seq')`,
      ]) {
        await c.query('BEGIN READ WRITE');
        await refused(c, sql);
        await c.query('ROLLBACK');
      }
    });
    const after = await adminQuery(
      `SELECT count(*)::int AS n FROM waitlist WHERE status = 'verified'`,
      [],
      db.url,
    );
    assert.equal(after.rows[0].n, 1, 'nothing changed');
    const privileges = await adminQuery(
      `SELECT c.relname, has_table_privilege($1, c.oid, 'SELECT') AS can_select,
            has_table_privilege($1, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_write
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'S') ORDER BY 1`,
      [role],
      db.url,
    );
    for (const r of privileges.rows) {
      assert.equal(r.can_select, r.relname === 'waitlist', r.relname);
      assert.equal(r.can_write, false, r.relname);
    }
  },
);

test('the dashboard needs nothing more than that role', { skip }, async () => {
  const app = await startApp({ databaseUrl: readerUrl() });
  try {
    const b = new Browser(app.base);
    assert.equal((await b.login()).status, 303);
    for (const path of [
      '/',
      '/signups',
      '/signups?q=kestrel&type=ai_agent&sort=name&dir=asc',
      '/signups/UAIN-00000001',
      '/export.csv',
    ])
      assert.equal((await b.request(path)).status, 200, path);
  } finally {
    await app.close();
  }
});

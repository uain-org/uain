/**
 * Boots the pilot against a throwaway store on an ephemeral port. Environment
 * has to be set before db.mjs is first imported, because the store and the
 * rate limits are read at module load. node --test runs each file in its own
 * process, so each file gets its own database, dropped when it closes.
 *
 * UAIN_TEST_PG names a PostgreSQL server the tests may create databases on,
 * as a URL to its maintenance database.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pg from 'pg';
import { newKey, proveWith } from '../../../public/worker/uain-key.mjs';

export { newKey, proveWith };

/** A fresh key and its enrol proof, for tests that enrol by hand. */
export function keyed() {
  const key = newKey();
  return { key, proof: proveWith(key, 'enrol') };
}

const ADMIN =
  process.env.UAIN_TEST_PG ?? 'postgres://postgres@127.0.0.1:5432/postgres';

/** A fresh database, sorting text byte by byte as production does. */
async function freshDatabase() {
  const name = `uain_test_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(
    `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
  );
  await admin.end();
  const url = new URL(ADMIN);
  url.pathname = `/${name}`;
  if (process.env.UAIN_TEST_VECTOR === '1') {
    const db = new pg.Client({connectionString:url.toString()});
    await db.connect();
    try { await db.query('CREATE EXTENSION vector'); } finally { await db.end(); }
  }
  return { name, url: url.toString() };
}

async function dropDatabase(name) {
  if (!/^uain_test_\d+_[a-z0-9]+$/.test(name)) throw new Error('Unexpected test database name');
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  try {
    // close() has already ended our pool/listener. FORCE tries to terminate
    // other roles' workers and needs privileges the disposable test role lacks.
    // A remaining application connection should fail teardown visibly.
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally { await admin.end(); }
}

export async function boot(env = {}) {
  process.env.UAIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'uain-test-'));
  const database = await freshDatabase();
  process.env.DATABASE_URL = database.url;
  process.env.UAIN_RATE_ENROLMENTS_PER_HOUR ??= '1000';
  process.env.UAIN_RATE_AGENTS_PER_HOUR ??= '1000';
  process.env.UAIN_RATE_REQUESTS_PER_MIN ??= '100000';
  process.env.UAIN_RATE_REGISTRATIONS_PER_HOUR ??= '1000';
  // The suite predates the novelty rule and opens tasks and settles work
  // without it, as a local test network may. test/novelty.test.mjs boots
  // with it on, as production runs.
  process.env.UAIN_REQUIRE_PRIOR_ART ??= '0';
  // Likewise the benevolence classes (30 September 2026): the suite opens
  // projects and tasks without declaring one. test/benevolence.test.mjs boots
  // with the rule on, as production runs.
  process.env.UAIN_REQUIRE_BENEVOLENCE ??= '0';
  // And the verification plan every new task states (30 September 2026):
  // test/task-requirements.test.mjs boots with it on, as production runs.
  process.env.UAIN_REQUIRE_VERIFICATION_PLAN ??= '0';
  // And proofs that name no server (audit E-8, 15 November 2026): the suite
  // signs unbound proofs (public/worker/uain-key.mjs without an audience).
  // test/bound-proofs-and-sessions.test.mjs checks the default is on.
  process.env.UAIN_REQUIRE_BOUND_PROOFS ??= '0';
  Object.assign(process.env, env);

  const { createPilotServer } = await import('../dist/src/api/server.js');
  const db = await import('../dist/src/application/db.js');
  // UAIN_WRITE_THREAD=1 runs the suite with writes on their own thread, as the
  // server runs them.
  if (process.env.UAIN_WRITE_THREAD === '1')
    await (await import('../dist/src/runtime/writer.js')).startWriter();
  const server = createPilotServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const clients = [];
  async function connect(token) {
    const client = new Client({ name: 'uain-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
    });
    await client.connect(transport);
    clients.push(client);
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const body = r.content?.[0]?.text ?? '';
      try {
        return JSON.parse(body);
      } catch {
        return { raw: body, isError: r.isError };
      }
    };
    return { client, call };
  }

  /**
   * Make an agent one of UAIN's own, so it may open projects and check work
   * without karma. Tests written before the karma thresholds use it for every
   * member; tests of the thresholds enrol with { uain: false }.
   */
  async function makeUain(id) {
    await db.setUainRole({ participant: id, role: 'project-creator', on: true, by: 'operator:test' });
    await db.setUainRole({ participant: id, role: 'default-verifier', on: true, by: 'operator:test' });
  }

  let n = 0;
  /** Enrol a system over MCP and return a client that acts as it. */
  async function member(operator, name = `system-${++n}`, { uain = true } = {}) {
    const anon = await connect();
    const key = newKey();
    const r = await anon.call('uain_enrol', {
      name,
      operator,
      authority: 'Test operator',
      principles: ['voluntary', 'verifiable', 'authority', 'benevolent'],
      proof: proveWith(key, 'enrol'),
    });
    if (!r.session_token) throw new Error(`enrol failed: ${JSON.stringify(r)}`);
    if (uain) await makeUain(r.participant.id);
    const me = await connect(r.session_token);
    return { id: r.participant.id, token: r.session_token, key, ...me };
  }

  /** Another agent of the member that holds `key`, signed in over MCP. */
  async function instance(key, operator, name = `system-${++n}`, { uain = true, model } = {}) {
    const anon = await connect();
    const r = await anon.call('uain_login', {
      proof: proveWith(key, 'login'),
      new_agent: {
        name,
        operator,
        model,
        principles: ['voluntary', 'verifiable', 'authority', 'benevolent'],
      },
    });
    if (!r.session_token) throw new Error(`login failed: ${JSON.stringify(r)}`);
    if (uain) await makeUain(r.participant.id);
    const me = await connect(r.session_token);
    return { id: r.participant.id, token: r.session_token, key, ...me };
  }

  async function close() {
    for (const c of clients) await c.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await (await import('../dist/src/runtime/writer.js')).stopWriter();
    const store = await import('../dist/src/storage/store.js');
    await store.close();
    await dropDatabase(database.name);
  }

  /** Enrol straight into the store with a fresh key; the participant row. */
  async function enrol(input) {
    const r = await db.enrol({ ...input, proof: proveWith(newKey(), 'enrol') });
    if (r.error) throw new Error(`enrol failed: ${JSON.stringify(r)}`);
    return r.participant;
  }

  const http = (path, init) => fetch(`${base}${path}`, init);
  return { base, db, http, connect, member, instance, makeUain, enrol, close };
}

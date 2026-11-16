/**
 * The network side of ops/backup/drill.sh. Boots the connection server on a
 * database the drill made, gives it a small network the way the tests do
 * (members, a project, a task, work checked twice and settled, a believed
 * claim, a completed day of ledger with its signed root), and then keeps
 * enrolling members until it is stopped, so the backup is taken while the
 * store is being written to.
 *
 *   DATABASE_URL=… UAIN_DATA_DIR=… node scripts/backup-drill-traffic.mjs <pinned.pem>
 *
 * Writes the ledger's public key to <pinned.pem> once the network exists: the
 * drill waits for that file, and later pins the restored server to it. On
 * SIGTERM it stops, and prints how many members it enrolled after that point.
 * Local only: refuses any database not named uain_backupdrill_….
 */
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newKey, proveWith } from '../../../public/worker/uain-key.mjs';

const pinned = process.argv[2];
if (!pinned) throw new Error('usage: backup-drill-traffic.mjs <pinned.pem>');
const target = new URL(process.env.DATABASE_URL ?? '');
if (!/^\/uain_backupdrill_[a-z0-9_]+$/.test(target.pathname) || target.hostname !== '127.0.0.1')
  throw new Error('Refusing anything except a local uain_backupdrill_ database');
if (!process.env.UAIN_DATA_DIR) throw new Error('UAIN_DATA_DIR is not set');
process.env.UAIN_RATE_ENROLMENTS_PER_HOUR ??= '1000000';
process.env.UAIN_RATE_AGENTS_PER_HOUR ??= '1000000';
process.env.UAIN_RATE_REQUESTS_PER_MIN ??= '1000000';
process.env.UAIN_RATE_REGISTRATIONS_PER_HOUR ??= '1000000';
// A local test network: its project and task open without a prior-art basis
// or a benevolence class, and its work settles without a novelty attestation.
process.env.UAIN_REQUIRE_PRIOR_ART ??= '0';
process.env.UAIN_REQUIRE_BENEVOLENCE ??= '0';
process.env.UAIN_REQUIRE_VERIFICATION_PLAN ??= '0';

// The traffic signs unbound proofs; bound ones are required by default since audit E-8.
process.env.UAIN_REQUIRE_BOUND_PROOFS ??= '0';
const { createPilotServer } = await import('../dist/src/api/server.js');
const db = await import('../dist/src/application/db.js');
const writer = await import('../dist/src/runtime/writer.js');
const store = await import('../dist/src/storage/store.js');
if (process.env.UAIN_WRITE_THREAD === '1') await writer.startWriter();
const server = createPilotServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const clients = [];
async function connect(token) {
  const client = new Client({ name: 'uain-backup-drill', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
    }),
  );
  clients.push(client);
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const body = JSON.parse(r.content?.[0]?.text ?? '{}');
    if (body.error) throw new Error(`${name}: ${JSON.stringify(body)}`);
    return body;
  };
}

const PRINCIPLES = ['voluntary', 'verifiable', 'authority', 'benevolent'];
async function member(name, operator) {
  const r = await (await connect())('uain_enrol', {
    name,
    operator,
    authority: 'Backup drill operator',
    principles: PRINCIPLES,
    proof: proveWith(newKey(), 'enrol'),
  });
  // UAIN's own, so they may open projects and check work without karma.
  for (const role of ['project-creator', 'default-verifier'])
    await db.setUainRole({ participant: r.participant.id, role, on: true, by: 'operator:backup-drill' });
  return connect(r.session_token);
}

const lead = await member('Drill lead', 'Drill operator A');
const worker = await member('Drill worker', 'Drill operator B');
const checkers = [await member('Drill checker 1', 'Drill operator C'), await member('Drill checker 2', 'Drill operator D')];
const { project } = await lead('uain_propose', {
  title: 'Backup drill',
  summary: 'State for a backup to carry.',
  stop_conditions: ['Halt if the drill needs anything but its own database.'],
});
for (const who of [worker, ...checkers]) await who('uain_join_project', { project_id: project.id });
const { task } = await lead('uain_task_open', {
  project_id: project.id,
  title: 'Count',
  question: 'How many?',
  done_when: 'Two checks agree.',
  how_to_check: 'Count again.',
  karma_offered: 20,
});
await worker('uain_task_start', { task_id: task.id });
const { contribution } = await worker('uain_contribute', {
  project_id: project.id,
  task_id: task.id,
  title: 'Counted',
  detail: 'Counted twice.',
  claim: 'There are three.',
  karma_claimed: 20,
});
for (const who of checkers)
  await who('uain_verify', { contribution_id: contribution.id, verdict: 'confirmed', note: 'Counted again.' });
const plain = await worker('uain_contribute', { project_id: project.id, title: 'Note', detail: 'A note.', karma_claimed: 5 });
await checkers[0]('uain_verify', { contribution_id: plain.contribution.id, verdict: 'confirmed', note: 'Read it.' });

// Move what is there into yesterday, as the journey test does, so the ledger
// has a completed day whose root the verifier recomputes and checks.
const yesterday = new Date(Date.now() - 86_400_000).toISOString();
await db.prepare('UPDATE events SET at = ?, hash = NULL, prev_hash = NULL').run(yesterday);
await db.backfillEventHashes();

writeFileSync(pinned, (await (await fetch(`${base}/api/ledger/key`)).json()).pem);

let stopping = false;
let wrote = 0;
process.on('SIGTERM', () => {
  stopping = true;
});
while (!stopping) {
  const r = await db.enrol({
    name: `Drill member ${wrote + 1}`,
    operator: `Drill operator ${wrote + 1}`,
    principles: PRINCIPLES,
    proof: proveWith(newKey(), 'enrol'),
  });
  if (r.error) throw new Error(`enrol failed: ${JSON.stringify(r)}`);
  wrote += 1;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
for (const c of clients) await c.close().catch(() => {});
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
await writer.stopWriter();
await store.close();
console.log(`wrote ${wrote}`);

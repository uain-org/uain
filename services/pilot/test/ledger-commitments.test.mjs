/**
 * Hash version 2 (docs/ledger.md): what a purge may change, which key the
 * roots must be signed with, and the research record each entry commits to.
 * Entries in the version 1 form, as production's ledger holds them, must go
 * on verifying exactly as before.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

const MARKER = '[redacted: participant record purged by the operator]';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
      : v;
const digestOf = (record) => sha(JSON.stringify(canonical({ version: 1, ...record })));
/** The version 1 rule, as production's entries were hashed. */
const legacyHash = (prev, e) => sha(`${prev}\n${JSON.stringify([e.id, e.at, e.kind, e.actor, e.peer ?? null, e.summary])}`);

let t;
let ledger;
const legacy = [];
const allEvents = async () => await t.db.prepare('SELECT * FROM events ORDER BY id').all();
const eventOf = async (commits) =>
  (await allEvents()).find((e) => e.commits?.startsWith(`${commits} sha256:`));
const tmp = mkdtempSync(join(tmpdir(), 'uain-ledger-key-'));

before(async () => {
  t = await boot();
  ledger = await import('../dist/src/ledger/ledger.js');
  // A ledger that already holds entries in the version 1 form, written the
  // day before, then one of them purged the version 1 way: any text goes.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  let prev = t.db.GENESIS_HASH;
  for (const [kind, actor, summary] of [
    ['join', 'legacy-a', 'legacy-a enrolled'],
    ['join', 'legacy-b', 'legacy-b enrolled'],
    ['handshake', 'legacy-b', 'Joined "Before version 2"'],
  ]) {
    const { id } = await t.db
      .prepare('INSERT INTO events (at, kind, actor, peer, summary) VALUES (?, ?, ?, NULL, ?) RETURNING id')
      .get(yesterday, kind, actor, summary);
    const hash = legacyHash(prev, { id, at: yesterday, kind, actor, peer: null, summary });
    await t.db.prepare('UPDATE events SET hash = ?, prev_hash = ? WHERE id = ?').run(hash, prev, id);
    legacy.push({ id, hash });
    prev = hash;
  }
  await t.db
    .prepare("UPDATE events SET summary = '[gone]', redacted = 1 WHERE id = ?")
    .run(legacy[1].id);
});
after(async () => {
  await t.close();
});

const script = fileURLToPath(new URL('../scripts/verify-ledger.mjs', import.meta.url));
/** Runs the independent verifier; its exit code and what it printed. */
async function verifyLedger(env = {}) {
  const clean = { ...process.env };
  delete clean.LEDGER_PUBLIC_KEY_FILE;
  delete clean.LEDGER_PUBLIC_KEY_PEM;
  return await new Promise((resolve) =>
    execFile(process.execPath, [script], { env: { ...clean, UAIN_API: t.base, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })));
}

/** Runs one operator action as the maintenance workflow does. */
async function maintenance(env) {
  const main = fileURLToPath(new URL('../dist/src/application/maintenance.js', import.meta.url));
  return await new Promise((resolve) =>
    execFile(process.execPath, [main], { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })));
}

describe('operator restatement', () => {
  test('is recorded under a well-formed operator, never a participant', async () => {
    const claudeCode = await t.enrol({ name: 'claude-code', operator: 'Restate Labs A' });
    const kestrel = await t.enrol({ name: 'Kestrel restate', operator: 'Restate Labs B' });
    await t.makeUain(kestrel.id);
    const { id: pid } = await t.db.propose({
      lead: kestrel.id, title: 'Restate fixture', summary: 's', stopConditions: ['Halt on restricted data.'],
    });
    await t.db.joinProject(pid, claudeCode.id);
    await t.db.prepare("SELECT setval('contribution_number', 4501)").get();
    const c = await t.db.contribute({
      contributor: kestrel.id, projectId: pid, title: 'Surface divergence', detail: 'Reproduced.',
      artifacts: [{ label: 'uain-surface-divergence-r2-v1' }], karmaClaimed: 50,
    });
    assert.equal(c.id, 'RC-4502');
    await t.db
      .prepare("INSERT INTO verifications (contribution_id, verifier, verdict, note, at) VALUES ('RC-4502', ?, 'partial', ?, ?)")
      .run(claudeCode.id, 'The verdict is `partial` on a scope question.', new Date().toISOString());

    for (const bad of ['', 'claude-code', 'operator:', 'operator:two words'])
      assert.equal((await maintenance({ ACTION: 'restate-rc4502', OPERATOR_ID: bad })).code, 1, bad);
    assert.equal((await t.db.getContribution('RC-4502')).verifications[0].verdict, 'partial');

    const ran = await maintenance({ ACTION: 'restate-rc4502', OPERATOR_ID: 'operator:test-founder' });
    assert.equal(ran.code, 0, ran.stderr);
    const entry = (await allEvents()).at(-1);
    assert.equal(entry.kind, 'amendment');
    assert.equal(entry.actor, 'operator:test-founder');
    assert.equal(entry.peer, kestrel.id);
    assert.equal(ledger.verifyChain(await allEvents()).ok, true);
  });
});

describe('entries written before hash version 2', () => {
  test('keep their hashes and verify exactly as before, beside version 2 entries', async () => {
    await t.member('After version 2');
    const rows = await allEvents();
    for (const { id, hash } of legacy) {
      const row = rows.find((e) => e.id === id);
      assert.equal(row.hash, hash);
      assert.equal(row.hash_version, 1);
      assert.equal(row.content_digest, null);
    }
    const intact = rows.find((e) => e.id === legacy[0].id);
    assert.equal(legacyHash(intact.prev_hash, intact), intact.hash);
    assert.ok(rows.at(-1).hash_version === 2);
    const r = ledger.verifyChain(rows);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.content_checked, rows.length - 1, 'only the version 1 purge goes unchecked');
    const run = await verifyLedger();
    assert.equal(run.code, 0, run.stdout);
    assert.match(run.stdout, /1 redacted before hash version 2/);
    assert.match(run.stdout, /1 completed day\(s\) recomputed/);
  });

  test('a legacy entry altered in place still fails, as it always did', async () => {
    await t.db.prepare('UPDATE events SET actor = ? WHERE id = ?').run('someone-else', legacy[0].id);
    const r = ledger.verifyChain(await allEvents());
    assert.deepEqual(r.errors.map((e) => [e.id, e.error]), [[legacy[0].id, 'content_mismatch']]);
    await t.db.prepare('UPDATE events SET actor = ? WHERE id = ?').run('legacy-a', legacy[0].id);
  });
});

describe('a purged version 2 entry', () => {
  let row;
  before(async () => {
    const m = await t.member('To be purged');
    row = (await allEvents()).find((e) => e.actor === m.id && e.hash_version === 2);
    await t.db
      .prepare('UPDATE events SET summary = ?, commits = NULL, salt = NULL, redacted = 1 WHERE id = ?')
      .run(MARKER, row.id);
  });
  const errorsNow = async () => ledger.verifyChain(await allEvents()).errors.map((e) => [e.id, e.error]);

  test('keeps everything but its text checkable', async () => {
    assert.deepEqual(await errorsNow(), []);
    const run = await verifyLedger();
    assert.equal(run.code, 0, run.stdout);
    assert.match(run.stdout, /1 redacted since: all but the erased text checked/);
  });

  test('fails if its text is anything but the marker', async () => {
    await t.db.prepare('UPDATE events SET summary = ? WHERE id = ?').run('[redacted] but it was fine', row.id);
    assert.deepEqual(await errorsNow(), [[row.id, 'bad_redaction']]);
    const run = await verifyLedger();
    assert.equal(run.code, 1);
    assert.match(run.stdout, new RegExp(`#${row.id}: redacted, but carries more than the redaction marker`));
    await t.db.prepare('UPDATE events SET summary = ? WHERE id = ?').run(MARKER, row.id);
  });

  test('fails if any other field changes', async () => {
    await t.db.prepare('UPDATE events SET actor = ? WHERE id = ?').run('someone-else', row.id);
    assert.deepEqual(await errorsNow(), [[row.id, 'content_mismatch']]);
    await t.db.prepare('UPDATE events SET actor = ? WHERE id = ?').run(row.actor, row.id);
  });

  test('cannot pass as a version 1 entry, whose purges go unchecked', async () => {
    const next = (await allEvents()).find((e) => e.id > row.id);
    await t.db.prepare('UPDATE events SET hash_version = 1, summary = ? WHERE id = ?').run('anything at all', row.id);
    assert.deepEqual(await errorsNow(), [[next.id, 'content_mismatch']]);
    await t.db.prepare('UPDATE events SET hash_version = 2, summary = ? WHERE id = ?').run(MARKER, row.id);
    assert.deepEqual(await errorsNow(), []);
  });
});

describe('research records', () => {
  let x;
  const open = async () => (await x.lead.call('uain_task_open', {
    project_id: x.p.id, title: `Task ${Math.random().toString(36).slice(2, 8)}`,
    question: 'What is the measured number?', done_when: 'A reproducible number.',
    how_to_check: 'Recompute from the inputs.',
  })).task;
  const answer = (who, task, claim) => who.call('uain_contribute', {
    project_id: x.p.id, task_id: task.id, title: 'Measured result',
    detail: 'Recomputed the number from the published inputs.', claim,
  });
  const check = (who, id, extra = {}) => who.call('uain_verify', {
    contribution_id: id, verdict: 'confirmed', note: 'Checked inputs, calculation and claim.', ...extra,
  });

  before(async () => {
    const people = await Promise.all(['lead', 'a', 'b', 'v1', 'v2', 'r1', 'r2'].map((n) =>
      t.member(`Records ${n}`)));
    const [lead, a, b, v1, v2, r1, r2] = people;
    const p = (await lead.call('uain_propose', {
      title: 'Records', summary: 'Measure one number.', stop_conditions: ['Halt if restricted data is needed.'],
    })).project;
    await Promise.all(people.slice(1).map((m) => m.call('uain_join_project', { project_id: p.id })));
    x = { lead, a, b, v1, v2, r1, r2, p };

    // A check before any belief, a belief, then a supporting check and a
    // refreshed one: the late answer joins the belief's sources.
    const task = await open();
    x.late = (await answer(b, task, 'The number is 42.')).contribution;
    await check(v1, x.late.id);
    x.first = (await answer(a, task, 'The number is 42.')).contribution;
    await check(v1, x.first.id);
    const believed = (await check(v2, x.first.id)).claim;
    x.claim = await lead.call('uain_claims', { claim_id: believed.id });
    const current = x.claim.believed_revision;
    await check(v2, x.late.id, { against_claim: 'supports', against_claim_revision: current });
    await check(v1, x.late.id, { against_claim: 'supports', against_claim_revision: current });
    // Another settled result, then an edit of the belief and its reviews.
    const other = (await answer(a, await open(), 'The number is 43.')).contribution;
    await check(v1, other.id);
    await check(v2, other.id);
    x.edit = await b.call('uain_claim_edit', {
      claim_id: believed.id, base_revision: current, statement: 'The number is 42 or 43.',
      sources: [x.first.id, other.id], reason: 'New evidence.',
    });
    for (const m of [r1, r2])
      await m.call('uain_claim_review', { revision_id: x.edit.revision, verdict: 'confirm', note: 'Checked.' });
  });

  test('every announcing entry commits to its record, which recomputes from the public API', async () => {
    const e = await eventOf(x.first.id);
    assert.ok(e, 'the submission carries a commitment');
    const c = await (await t.http(`/api/contributions/${x.first.id}`)).json();
    const recomputed = digestOf({
      record: 'contribution', id: c.id, project_id: c.project_id, contributor: c.contributor,
      kind: c.kind, title: c.title, detail: c.detail, task_id: c.task_id, reconciles: c.reconciles,
      karma_claimed: c.karma_claimed, verifiers_required: c.verifiers_required, artifacts: c.artifacts,
      reproduction: c.reproduction, claim_statement: c.claim_statement, evidence: c.evidence,
      sources: c.sources, source_checks: c.source_checks, forecast: c.forecast, meta: c.meta,
      submitted_at: c.submitted_at,
    });
    assert.equal(e.commits, `${x.first.id} sha256:${recomputed}`);
    const kinds = new Set((await allEvents()).filter((r) => r.commits).map((r) => r.commits.split(' sha256:')[0]
      .replace(/^RC-\d+/, 'RC').replace(/^CL-\d+ revision \d+/, 'CL revision')));
    assert.deepEqual([...kinds].sort(), ['CL revision', 'CL revision review', 'RC', 'RC check']);
    const run = await verifyLedger();
    assert.equal(run.code, 0, run.stdout);
    const n = Number(/records: +(\d+)/.exec(run.stdout)[1]);
    // 3 submissions here and the restatement fixture's, 7 checks (a refresh
    // among them), 3 claim revisions (the belief grown by support counts
    // once, at its latest commitment) and 2 reviews.
    assert.equal(n, 16, run.stdout);
  });

  test('a changed method, verdict note, claim sentence or review is detected', async () => {
    const tamper = [
      ['contributions', 'detail', 'id', x.first.id, `${x.first.id} does not match`],
      ['verifications', 'note', 'contribution_id', x.first.id, `${x.first.id} check does not match`],
      ['claim_revisions', 'statement', 'id', x.claim.believed_revision,
        `${x.claim.id} revision ${x.claim.believed_revision} does not match`],
      ['claim_reviews', 'note', 'revision_id', x.edit.revision,
        `${x.claim.id} revision ${x.edit.revision} review does not match`],
    ];
    for (const [table, column, key, value, message] of tamper) {
      const rows = await t.db.prepare(`SELECT id, ${column} AS was FROM ${table} WHERE ${key} = ?`).all(value);
      await t.db.prepare(`UPDATE ${table} SET ${column} = ${column} || ' (edited)' WHERE ${key} = ?`).run(value);
      const run = await verifyLedger();
      assert.equal(run.code, 1, `${table}.${column}: ${run.stdout}`);
      assert.ok(run.stdout.includes(message), run.stdout);
      for (const r of rows) await t.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(r.was, r.id);
    }
    assert.equal((await verifyLedger()).code, 0);
  });

  test('a recomputed digest shows the content change directly', async () => {
    const e = await eventOf(x.late.id);
    const served = async () => {
      const c = await (await t.http(`/api/contributions/${x.late.id}`)).json();
      return digestOf({
        record: 'contribution', id: c.id, project_id: c.project_id, contributor: c.contributor,
        kind: c.kind, title: c.title, detail: c.detail, task_id: c.task_id, reconciles: c.reconciles,
        karma_claimed: c.karma_claimed, verifiers_required: c.verifiers_required, artifacts: c.artifacts,
        reproduction: c.reproduction, claim_statement: c.claim_statement, evidence: c.evidence,
        sources: c.sources, source_checks: c.source_checks, forecast: c.forecast, meta: c.meta,
        submitted_at: c.submitted_at,
      });
    };
    assert.equal(e.commits, `${x.late.id} sha256:${await served()}`);
    await t.db.prepare('UPDATE contributions SET claim_statement = ? WHERE id = ?').run('The number is 7.', x.late.id);
    assert.notEqual(e.commits, `${x.late.id} sha256:${await served()}`);
    await t.db.prepare('UPDATE contributions SET claim_statement = ? WHERE id = ?').run('The number is 42.', x.late.id);
    assert.equal(e.commits, `${x.late.id} sha256:${await served()}`);
  });

  test('the commitment cannot be swapped: it is under the entry hash', async () => {
    const e = await eventOf(x.first.id);
    await t.db.prepare('UPDATE events SET commits = ? WHERE id = ?').run(`${x.first.id} sha256:${'0'.repeat(64)}`, e.id);
    assert.deepEqual(ledger.verifyChain(await allEvents()).errors.map((r) => [r.id, r.error]), [[e.id, 'content_mismatch']]);
    await t.db.prepare('UPDATE events SET commits = ? WHERE id = ?').run(e.commits, e.id);
  });
});

describe('the verifier and the signing key', () => {
  test('passes with the pinned key, fails with any other, and warns without one', async () => {
    const served = (await (await t.http('/api/ledger/key')).json()).pem;
    const right = join(tmp, 'right.pem');
    writeFileSync(right, served);
    const pinned = await verifyLedger({ LEDGER_PUBLIC_KEY_FILE: right });
    assert.equal(pinned.code, 0, pinned.stdout);
    assert.match(pinned.stdout, /key: +pinned/);
    assert.doesNotMatch(pinned.stdout, /WARNING/);
    assert.equal((await verifyLedger({ LEDGER_PUBLIC_KEY_PEM: served })).code, 0);

    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const wrong = join(tmp, 'wrong.pem');
    writeFileSync(wrong, other);
    const refused = await verifyLedger({ LEDGER_PUBLIC_KEY_FILE: wrong });
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stdout, /the server signs with a key other than the pinned one/);
    assert.match(refused.stdout, /signature does not verify/);

    const unpinned = await verifyLedger();
    assert.equal(unpinned.code, 0, unpinned.stdout);
    assert.match(unpinned.stdout, /WARNING — no pinned key/);
  });
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
let ledger;
before(async () => {
  t = await boot();
  ledger = await import('../dist/src/ledger/ledger.js');
  // Some activity to chain.
  const a = await t.member('Ledger A');
  const b = await t.member('Ledger B');
  const p = await a.call('uain_propose', {
    title: 'Ledger project',
    summary: 's',
    stop_conditions: ['Halt on restricted data.'],
  });
  await b.call('uain_join_project', { project_id: p.project.id });
});
after(async () => {
  await t.close();
});

const allEvents = async () => await t.db.prepare('SELECT * FROM events ORDER BY id').all();

describe('hash chain', () => {
  test('is valid after activity', async () => {
    const r = ledger.verifyChain(await allEvents());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(r.entries >= 5);
    assert.equal((await allEvents())[0].prev_hash, t.db.GENESIS_HASH);
  });

  test('detects a summary altered in the database', async () => {
    const row = (await allEvents())[2];
    await t.db.prepare('UPDATE events SET summary = ? WHERE id = ?').run('forged', row.id);
    const r = ledger.verifyChain(await allEvents());
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors.map((e) => [e.id, e.error]), [[row.id, 'content_mismatch']]);
    await t.db.prepare('UPDATE events SET summary = ? WHERE id = ?').run(row.summary, row.id);
    assert.equal(ledger.verifyChain(await allEvents()).ok, true);
  });

  test('detects a deleted entry', async () => {
    const rows = await allEvents();
    const r = ledger.verifyChain(rows.filter((_, i) => i !== 1));
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].error, 'broken_link');
  });

  test('redaction keeps linkage', async () => {
    const row = (await allEvents())[1];
    // As a purge redacts: the marker, and no salt or record digest.
    await t.db
      .prepare('UPDATE events SET summary = ?, commits = NULL, salt = NULL, redacted = 1 WHERE id = ?')
      .run('[redacted: participant record purged by the operator]', row.id);
    const r = ledger.verifyChain(await allEvents());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.redacted, 1);
  });

  test('backfill is idempotent and reproduces the same hashes', async () => {
    const before = await allEvents();
    const last = before.at(-1);
    await t.db.prepare('UPDATE events SET hash = NULL, prev_hash = NULL WHERE id = ?').run(last.id);
    assert.equal(await t.db.backfillEventHashes(), 1);
    assert.equal(await t.db.backfillEventHashes(), 0);
    assert.deepEqual((await allEvents()).at(-1), last);
  });

  test('events over HTTP carry hashes, including by cursor', async () => {
    const r = await (await t.http('/api/events?after_id=0&limit=3')).json();
    assert.ok(r.events.every((e) => /^[0-9a-f]{64}$/.test(e.hash) && 'redacted' in e));
    assert.equal(r.events[1].prev_hash, r.events[0].hash);
  });
});

describe('signed daily roots', () => {
  test('today’s root is signed, provisional, and verifies with the published key', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await (await t.http(`/api/ledger/roots/${today}`)).json();
    assert.equal(r.provisional, true);
    assert.equal(r.count, (await allEvents()).length);
    const key = await (await t.http('/api/ledger/key')).json();
    assert.equal(ledger.verifyRootSignature(r, key.pem), true);
    assert.equal(ledger.verifyRootSignature({ ...r, count: r.count + 1 }, key.pem), false);
  });

  test('a completed day is cached and does not change', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    // Move two entries into yesterday, rehashing them in place is not needed:
    // the root covers stored hashes, whatever day they fall on.
    const rows = await allEvents();
    await t.db.prepare('UPDATE events SET at = ? WHERE id IN (?, ?)').run(yesterday, rows[0].id, rows[1].id);
    const day = yesterday.slice(0, 10);
    const first = await ledger.dayRoot(day);
    assert.equal(first.provisional, false);
    assert.equal(first.count, 2);
    assert.equal(ledger.verifyRootSignature(first), true);
    assert.deepEqual(await ledger.dayRoot(day), first);
  });

  // Baseline 06b-17 (13 November 2026): under native authority nothing is
  // written to the root cache table, so every anonymous GET /api/ledger/roots
  // re-read and re-signed up to 366 days. Completed days are now held in memory
  // for a short while; what is signed and served is unchanged.
  test('under native authority a completed day is not recomputed on every read', async () => {
    const earlier = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const day = earlier.slice(0, 10);
    const rows = await allEvents();
    await t.db.prepare('UPDATE events SET at = ? WHERE id = ?').run(earlier, rows[2].id);
    const before = process.env.UAIN_AUTHORITY;
    process.env.UAIN_AUTHORITY = 'native';
    try {
      const first = await ledger.dayRoot(day);
      assert.equal(first.count, 1);
      assert.equal(ledger.verifyRootSignature(first), true);
      // Recomputing would now see two entries; a held root is not recomputed.
      await t.db.prepare('UPDATE events SET at = ? WHERE id = ?').run(earlier, rows[3].id);
      assert.deepEqual(await ledger.dayRoot(day), first);
      const [listed] = (await ledger.dayRoots(day, day));
      assert.deepEqual(listed, first);
    } finally {
      if (before === undefined) delete process.env.UAIN_AUTHORITY; else process.env.UAIN_AUTHORITY = before;
      ledger.resetHeldRoots?.();
    }
  });

  test('an inclusion proof verifies against the day’s root', async () => {
    const ev = (await allEvents()).at(-1);
    const p = await (await t.http(`/api/ledger/proof/${ev.id}`)).json();
    assert.equal(p.leaf, ev.hash);
    assert.equal(ledger.verifyProof(p.leaf, p.proof, p.root), true);
    assert.equal(ledger.verifyProof(p.leaf, p.proof, '0'.repeat(64)), false);
  });

  test('merkle trees with odd leaves prove every leaf', () => {
    const leaves = Array.from({ length: 7 }, (_, i) =>
      String(i).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a'),
    );
    const root = ledger.merkleRoot(leaves);
    leaves.forEach((leaf, i) =>
      assert.equal(ledger.verifyProof(leaf, ledger.merkleProof(leaves, i), root), true),
    );
  });

  test('routes answer, and bad dates are refused', async () => {
    assert.equal((await t.http('/api/ledger/head')).status, 200);
    assert.equal((await t.http('/api/ledger/roots?from=yesterday')).status, 400);
    assert.equal((await t.http('/api/ledger/roots/2999-01-01')).status, 404);
    assert.equal((await t.http('/api/ledger/proof/999999')).status, 404);
    const d = await (await t.http('/api/descriptor')).json();
    assert.match(d.ledger.signing_key, /^[A-Za-z0-9+/]+=*$/);
  });
});

describe('verify-ledger script', () => {
  test('passes against the live test server', async () => {
    // Undo the test manipulations above so the chain is consistent end to end:
    // the day move changed `at`, which content hashes commit to.
    await t.db.prepare('UPDATE events SET hash = NULL, prev_hash = NULL').run();
    await t.db.prepare('DELETE FROM ledger_roots').run();
    await t.db.backfillEventHashes();
    const script = fileURLToPath(new URL('../scripts/verify-ledger.mjs', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [script], {
      env: { ...process.env, UAIN_API: t.base },
    });
    assert.match(stdout, /PASS/);
  });

  // W11 remainder (15 November 2026): it checked only the roots the server chose to serve, so a
  // server that left out a day passed. Runs after the test above, which leaves a consistent chain
  // with entries on earlier, completed days.
  test('fails when the server leaves out a completed day that has entries', async () => {
    const { roots } = await (await t.http('/api/ledger/roots')).json();
    const left = roots.find((r) => !r.provisional && r.count > 0);
    assert.ok(left, 'the fixture has a completed day with entries');
    const proxy = createServer(async (req, res) => {
      const upstream = await fetch(t.base + req.url);
      let body = await upstream.text();
      if (req.url.split('?')[0] === '/api/ledger/roots') {
        const served = JSON.parse(body);
        served.roots = served.roots.filter((r) => r.date !== left.date);
        served.count = served.roots.length;
        body = JSON.stringify(served);
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(body);
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const script = fileURLToPath(new URL('../scripts/verify-ledger.mjs', import.meta.url));
      await assert.rejects(
        promisify(execFile)(process.execPath, [script], {
          env: { ...process.env, UAIN_API: `http://127.0.0.1:${proxy.address().port}` },
        }),
        (e) => /FAIL/.test(e.stdout) && e.stdout.includes(`${left.date}: ${left.count} entr(ies) but no signed root`),
      );
    } finally {
      await new Promise((resolve) => proxy.close(resolve));
    }
  });
});

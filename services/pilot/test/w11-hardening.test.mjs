// W11 security hardening, the pilot API's part (docs/baink/plan-9-nov-2026.md,
// audits 06a and 06b): archived projects refuse writes, free text has bounds,
// and /api/stream has per-copy and per-caller caps and a replay bound.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t, pool;
before(async () => {
  t = await boot({ UAIN_MAX_STREAMS_PER_CALLER: '2', UAIN_STREAM_REPLAY_MAX: '3' });
  ({ pool } = await import('../dist/src/storage/store.js'));
});
after(async () => {
  if (!t) return;
  await t.db.flushLog();
  await (await import('../dist/src/storage/ratelimit.js')).syncCounts();
  await t.close();
});

const long = (n) => 'x'.repeat(n);
const STOP = ['Halt if the work would require restricted data.'];

describe('archived projects', () => {
  test('refuse work, checks, tasks, claims and joins, without throwing', async () => {
    const lead = await t.member('Archive-Lead');
    const other = await t.member('Archive-Other');
    const opened = await lead.call('uain_propose', { title: 'Archive refusal check', summary: 'A project to archive', stop_conditions: STOP });
    const pid = opened.project?.id;
    assert.ok(pid, JSON.stringify(opened));
    const task = await t.db.openTask({ author: lead.id, projectId: pid, title: 'T', question: 'Q?', doneWhen: 'D', howToCheck: 'H' });
    assert.ok(task.task?.id ?? task.id, JSON.stringify(task));
    const work = await t.db.contribute({ contributor: lead.id, projectId: pid, title: 'W', detail: 'Before archiving', karmaClaimed: 1 });
    const workId = work.contribution?.id ?? work.id;

    await pool.query('INSERT INTO project_archives VALUES ($1, $2, $3)', [pid, 'test', new Date().toISOString()]);
    const events = async () => (await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n;
    const before = await events();

    const refused = {
      contribute: await t.db.contribute({ contributor: lead.id, projectId: pid, title: 'W2', detail: 'After', karmaClaimed: 1 }),
      openTask: await t.db.openTask({ author: lead.id, projectId: pid, title: 'T2', question: 'Q2?', doneWhen: 'D', howToCheck: 'H' }),
      createClaim: await t.db.createClaim({ author: lead.id, projectId: pid, statement: 'S', sources: [workId ?? 'RC-1'], reason: 'R' }),
      completeProject: await t.db.completeProject({ participant: lead.id, projectId: pid, reason: 'done' }),
      updateDoneWhen: await t.db.updateDoneWhen({ participant: lead.id, projectId: pid, doneWhen: 'Later' }),
    };
    for (const [write, result] of Object.entries(refused))
      assert.equal(result?.error, 'project_archived', `${write}: ${JSON.stringify(result)}`);
    if (workId) {
      const checked = await t.db.verify({ verifier: other.id, contributionId: workId, verdict: 'confirm', note: 'checked' });
      assert.equal(checked?.error, 'project_archived', JSON.stringify(checked));
    }
    assert.equal(await t.db.joinProject(pid, other.id), null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_members WHERE project_id = $1 AND member_id = $2', [pid, other.id])).rows[0].n, 0);
    assert.equal(await events(), before, 'nothing reached the ledger');
  });
});

describe('text bounds', () => {
  test('the store refuses over-long task and claim text', async () => {
    const a = await t.member('Bounds-Op');
    const opened = await a.call('uain_propose', { title: 'Bounds', summary: 'Bounds', stop_conditions: STOP });
    const pid = opened.project?.id;
    const base = { author: a.id, projectId: pid, title: 'T', question: 'Q?', doneWhen: 'D', howToCheck: 'H' };
    assert.deepEqual(await t.db.openTask({ ...base, title: long(201) }), { error: 'text_too_long', field: 'title', max: 200 });
    assert.deepEqual(await t.db.openTask({ ...base, question: long(20001) }), { error: 'text_too_long', field: 'question', max: 20000 });
    assert.deepEqual(
      await t.db.createClaim({ author: a.id, projectId: pid, statement: long(1001), sources: ['RC-1'], reason: 'R' }),
      { error: 'text_too_long', field: 'statement', max: 1000 },
    );
    assert.deepEqual(
      await t.db.createClaim({ author: a.id, projectId: pid, statement: 'S', sources: [long(101)], reason: 'R' }),
      { error: 'text_too_long', field: 'sources', max: 100 },
    );
    assert.deepEqual(
      await t.db.closeTask({ participant: a.id, taskId: 'T-1', reason: long(10001) }),
      { error: 'text_too_long', field: 'reason', max: 10000 },
    );
    // At the bound is fine.
    const ok = await t.db.openTask({ ...base, title: long(200) });
    assert.equal(ok.error, undefined, JSON.stringify(ok));
  });

  test('the MCP schemas refuse them before the store is asked', async () => {
    const a = await t.member('Bounds-MCP');
    const r = await a.client.callTool({
      name: 'uain_task_open',
      arguments: { project_id: 'any', title: 'T', question: long(20001), done_when: 'D', how_to_check: 'H' },
    }).catch((e) => ({ isError: true, content: [{ text: String(e?.message ?? e) }] }));
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /20000|too_big|too long|Too big/i);
    const c = await a.client.callTool({
      name: 'uain_claim_create',
      arguments: { project_id: 'any', statement: long(1001), sources: ['RC-1'], reason: 'R' },
    }).catch((e) => ({ isError: true, content: [{ text: String(e?.message ?? e) }] }));
    assert.equal(c.isError, true);
    assert.match(c.content[0].text, /1000|too_big|too long|Too big/i);
  });
});

describe('/api/stream', () => {
  const open = async (path = '/api/stream', headers = {}) => {
    const controller = new AbortController();
    const r = await t.http(path, { headers, signal: controller.signal });
    return { r, close: () => controller.abort() };
  };

  test('a caller holds at most its share of streams; closing one frees a place', async () => {
    const one = await open();
    const two = await open();
    assert.equal(one.r.status, 200);
    assert.equal(two.r.status, 200);
    const three = await open();
    assert.equal(three.r.status, 429);
    const body = await three.r.json();
    assert.equal(body.error, 'too_many_streams');
    assert.equal(body.limit, 2);
    assert.ok(three.r.headers.get('retry-after'));
    one.close();
    await new Promise((r) => setTimeout(r, 100));
    const four = await open();
    assert.equal(four.r.status, 200);
    two.close();
    four.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  test('an agent counts apart from its address', async () => {
    const a = await t.member('Stream-Agent');
    const anon = [await open(), await open()];
    const mine = await open('/api/stream', { authorization: `Bearer ${a.token}` });
    assert.equal(mine.r.status, 200);
    for (const s of [...anon, mine]) s.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  test('a replay past its bound sends what it may, says where to page from, and ends', async () => {
    // The members enrolled above are well over three ledger entries.
    const { r } = await open('/api/stream?after=0');
    assert.equal(r.status, 200);
    const text = await r.text(); // ends by itself
    const entries = text.match(/^event: entry$/gm) ?? [];
    assert.ok(entries.length >= 3 && entries.length <= 500, `${entries.length} entries`);
    const truncated = /event: truncated\ndata: (.+)\n/.exec(text);
    assert.ok(truncated, text.slice(-400));
    const info = JSON.parse(truncated[1]);
    assert.equal(info.page, `/api/events?after=${info.next_after}`);
    const page = await (await t.http(info.page)).json();
    assert.ok(Array.isArray(page.events ?? page), 'the page it names answers');
  });

  test('a short replay is not cut', async () => {
    const head = (await pool.query('SELECT max(id)::int AS n FROM events')).rows[0].n;
    const s = await open(`/api/stream?after=${head - 1}`);
    assert.equal(s.r.status, 200);
    const reader = s.r.body.getReader();
    let text = '';
    while (!text.includes('event: ready')) text += new TextDecoder().decode((await reader.read()).value);
    assert.equal(text.includes('truncated'), false);
    s.close();
    await new Promise((r) => setTimeout(r, 100));
  });
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { boot } from './helpers.mjs';

let metrics, t;
before(async () => {
  t = await boot();
  const { startMetrics, registry } = await import('../dist/src/operations/metrics.js');
  const { pool } = await import('../dist/src/storage/store.js');
  startMetrics(pool, 0);
  metrics = createServer(async (_, res) => res.end(await registry.metrics()));
  await new Promise(resolve => metrics.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  if (metrics) await new Promise(resolve => metrics.close(resolve));
  if (t) {
    await t.db.flushLog();
    const { syncCounts } = await import('../dist/src/storage/ratelimit.js');
    await syncCounts();
    await t.close();
  }
});

test('public project requests share route labels without exposing record IDs', async () => {
  for (const id of ['metrics-missing-project-one', 'metrics-missing-project-two']) {
    assert.equal((await t.http('/api/projects/' + id)).status, 404);
  }
  const body = await (await fetch(`http://127.0.0.1:${metrics.address().port}/metrics`)).text();
  assert.match(body, /uain_http_request_duration_seconds_count\{route="GET \/api\/projects",status="4xx"\} 2/);
  assert.equal(body.includes('metrics-missing-project-one'), false);
  assert.equal(body.includes('metrics-missing-project-two'), false);
  for (const state of ['total', 'idle', 'waiting']) {
    assert.match(body, new RegExp(`uain_pg_pool_connections\\{state="${state}"\\} \\d+`));
  }
});

test('the write path reports its queue, waits, holds and pending writer calls', async () => {
  const { watchWrites } = await import('../dist/src/operations/metrics.js');
  const { writeQueue } = await import('../dist/src/storage/store.js');
  const writer = await import('../dist/src/runtime/writer.js');
  watchWrites({ main: writeQueue, writer: writer.writerStats, pending: writer.pendingWrites });
  // One write, so the counters have moved on whichever thread wrote it.
  await t.member('Metrics-Writer');
  const body = await (await fetch(`http://127.0.0.1:${metrics.address().port}/metrics`)).text();
  for (const name of ['uain_write_queue_waiting', 'uain_write_queue_running', 'uain_writes_started_total', 'uain_write_wait_seconds_total', 'uain_write_holds_total', 'uain_write_hold_seconds_total'])
    assert.match(body, new RegExp(`${name}\\{thread="main"\\} [0-9.e-]+`));
  assert.match(body, /uain_writer_pending_calls \d+/);
  if (process.env.UAIN_WRITE_THREAD !== '1') assert.ok(writeQueue.started > 0 && writeQueue.held > 0);
});

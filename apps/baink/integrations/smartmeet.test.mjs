import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSmartMeetClient } from './smartmeet-api.mjs';

test('missing integration credentials never requests or reports an empty live calendar', async () => {
  const client = createSmartMeetClient({
    fetchImpl() {
      throw new Error('Network must stay unused');
    },
  });
  assert.deepEqual(await client.listMeetings(), {
    status: 'not-configured',
    meetings: null,
  });
  assert.equal(client.configured, false);
});

test('list uses the documented platform-scoped API and exposes only meeting navigation data', async () => {
  let request;
  const client = createSmartMeetClient({
    apiOrigin: 'https://api.smartmeet.example/',
    apiKey: 'test-only-key',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return Response.json({
        ok: true,
        requestId: 'request-1',
        platformName: 'BAINK',
        meetings: [
          {
            meetingId: 'meeting-1',
            title: 'Research review',
            date: '2026-11-01',
            time: '13:00',
            organizerName: 'Test',
            organizerEmail: 'test@example.com',
            isMeetingStarted: false,
            isMeetingEnded: false,
            sourcePlatform: 'BAINK',
            createdAt: '2026-10-31T00:00:00Z',
            joinUrl: 'https://smartmeet.org/meeting/meeting-1',
            joinToken: 'never-forward',
          },
        ],
        pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
      });
    },
  });
  assert.equal(client.configured, true);
  const result = await client.listMeetings({ status: 'upcoming', limit: 20 });
  assert.equal(
    request.url,
    'https://api.smartmeet.example/meeting-suite/v1/api/external/meetings?status=upcoming&limit=20&offset=0',
  );
  assert.equal(request.options.headers['X-API-Key'], 'test-only-key');
  assert.equal(request.options.headers['X-Platform-Name'], 'BAINK');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(result, {
    status: 'available',
    meetings: [
      {
        id: 'meeting-1',
        title: 'Research review',
        date: '2026-11-01',
        time: '13:00',
        state: 'upcoming',
        url: 'https://smartmeet.org/meeting/meeting-1',
      },
    ],
    pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
  });
});

test('rejects credential-bearing origins and invalid filters before sending credentials', async () => {
  for (const apiOrigin of [
    'http://smartmeet.org',
    'https://u:p@smartmeet.org',
    'https://smartmeet.org/path',
    'https://smartmeet.org/?key=x',
  ]) {
    assert.throws(
      () => createSmartMeetClient({ apiOrigin, apiKey: 'test-key' }),
      /HTTPS origin/,
    );
  }
  const client = createSmartMeetClient({
    apiOrigin: 'https://smartmeet.org',
    apiKey: 'test-key',
    fetchImpl() {
      throw new Error('No request');
    },
  });
  await assert.rejects(client.listMeetings({ status: 'invalid' }), /status/);
  await assert.rejects(client.listMeetings({ limit: 101 }), /limit/);
  await assert.rejects(client.listMeetings({ offset: -1 }), /offset/);
});

test('upstream errors do not leak response bodies or report success', async () => {
  const client = createSmartMeetClient({
    apiOrigin: 'https://smartmeet.org',
    apiKey: 'test-key',
    fetchImpl: async () =>
      new Response('sensitive error text', { status: 401 }),
  });
  await assert.rejects(
    client.listMeetings(),
    (error) =>
      error.message === 'SmartMeet request failed (401)' &&
      error.status === 401,
  );
});

test('malformed data fails clearly and untrusted meeting links are omitted', async () => {
  let payload = {
    ok: true,
    meetings: [
      {
        meetingId: 'm',
        title: 'Review',
        joinUrl: 'https://elsewhere.example/?token=secret',
      },
    ],
  };
  const client = createSmartMeetClient({
    apiOrigin: 'https://smartmeet.org',
    apiKey: 'test-key',
    fetchImpl: async () => Response.json(payload),
  });
  assert.equal((await client.listMeetings()).meetings[0].url, null);
  payload = { ok: false, error: 'private upstream error' };
  await assert.rejects(client.listMeetings(), /invalid meeting list/);
});

test('round 3: meeting reads reject advertised and streamed responses above one MiB', async () => {
  for (const advertised of [true, false]) {
    let cancelled = false;
    const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, meetings: [{ meetingId: 'm', title: 'x'.repeat(2 * 1024 * 1024) }] }));
    const client = createSmartMeetClient({
      apiOrigin: 'https://smartmeet.org', apiKey: 'test-only-key',
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 65536) controller.enqueue(bytes.subarray(i, i + 65536));
          controller.close();
        },
        cancel() { cancelled = true; },
      }), { headers: advertised ? { 'content-length': String(bytes.length) } : {} }),
    });
    await assert.rejects(client.listMeetings(), /invalid meeting list/);
    assert.equal(cancelled, true, 'stop consuming the oversized upstream stream');
  }
});

test('round 3: upstream meeting count and pagination cannot bypass the requested shape', async () => {
  for (const payload of [
    { ok: true, meetings: [{ meetingId: 'a' }, { meetingId: 'b' }] },
    { ok: true, meetings: [], pagination: { total: { private: 'never-forward' }, limit: 1, offset: 0, hasMore: false } },
  ]) {
    const client = createSmartMeetClient({ apiOrigin: 'https://smartmeet.org', apiKey: 'test-only-key', fetchImpl: async () => Response.json(payload) });
    await assert.rejects(client.listMeetings({ limit: 1 }), /invalid meeting list/);
  }
});

test('meeting navigation must match the exact projected meeting rather than another platform meeting',async()=>{const payload={ok:true,meetings:[{meetingId:'meeting-one',title:'Fixture',joinUrl:'https://smartmeet.org/meeting/meeting-other?joinToken=never-forward'}]};const client=createSmartMeetClient({apiOrigin:'https://api.smartmeet.org',apiKey:'fixture',fetchImpl:async()=>Response.json(payload)});assert.equal((await client.listMeetings()).meetings[0].url,null);payload.meetings[0].joinUrl='https://smartmeet.org/meeting/meeting-one/?tracking=never-forward#fragment';assert.equal((await client.listMeetings()).meetings[0].url,'https://smartmeet.org/meeting/meeting-one/');});

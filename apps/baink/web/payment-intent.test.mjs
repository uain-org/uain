import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBainkServer } from '../server/app.mjs';
import { api, createIdentity } from './identity.js';
import { createPaymentIntent } from './payment-intent.js';

test('a committed request with a lost response retries once without creating a duplicate request', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baink-intent-'));
  const app = await createBainkServer({
    dataDir,
    publicOrigin: 'https://baink.example',
    projectsSource: null,
    catalogueDir: null,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const originalFetch = globalThis.fetch,
    originalLocation = globalThis.location;
  let loseNextResponse = false;
  globalThis.location = { origin: 'https://baink.example' };
  globalThis.fetch = async (path, options) => {
    const response = await originalFetch(base + path, {
      ...options,
      headers: { ...options.headers, Origin: 'https://baink.example' },
    });
    if (
      loseNextResponse &&
      path === '/api/requests' &&
      options.method === 'POST'
    ) {
      loseNextResponse = false;
      assert.equal(response.status, 201);
      await response.json();
      throw new TypeError(
        'Connection closed after the server committed the request',
      );
    }
    return response;
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const payee = await createIdentity(),
    payer = await createIdentity();
  await api('/api/account', { identity: payee, method: 'POST', body: {} });
  await api('/api/account', { identity: payer, method: 'POST', body: {} });
  const form = createPaymentIntent();
  const fields = { to: payer.address, amount: '2.5', memo: 'Research' };
  const send = (body) =>
    api('/api/requests', { identity: payee, method: 'POST', body });
  loseNextResponse = true;
  await assert.rejects(form.prepare(fields).run(send), /Connection closed/);
  assert.equal(
    (await api('/api/requests', { identity: payee })).requests.length,
    1,
  );
  // Reopening confirmation and retrying unchanged intent must reuse its original identifier.
  const recovered = await form.prepare({ ...fields }).run(send);
  const afterRetry = await api('/api/requests', { identity: payee });
  assert.equal(afterRetry.requests.length, 1);
  assert.equal(afterRetry.requests[0].id, recovered.request.id);
  // A confirmed success completes the intent; an intentional new identical request is allowed.
  await form.prepare(fields).run(send);
  assert.equal(
    (await api('/api/requests', { identity: payee })).requests.length,
    2,
  );
});

test('changing the intent rotates its identifier while failed unchanged confirmation retries preserve it', async () => {
  const form = createPaymentIntent();
  const fields = { to: 'uain1' + 'a'.repeat(40), amount: '1', memo: '' };
  let firstId;
  await assert.rejects(
    form.prepare(fields).run(async (body) => {
      firstId = body.clientRequestId;
      throw new Error('offline');
    }),
    /offline/,
  );
  let retryId;
  await assert.rejects(
    form.prepare({ ...fields }).run(async (body) => {
      retryId = body.clientRequestId;
      throw new Error('offline');
    }),
    /offline/,
  );
  assert.equal(retryId, firstId);
  form.invalidate(); // A field changed, even if the user later restores its old value.
  let editedId;
  await form.prepare(fields).run(async (body) => {
    editedId = body.clientRequestId;
    return {};
  });
  assert.notEqual(editedId, firstId);
});

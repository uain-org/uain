import assert from 'node:assert/strict';
import { test } from 'node:test';
import { objectStorage, storageFromEnv } from '../dist/src/integrations/object-storage.js';

const config = {
  endpoint: 'https://nyc3.digitaloceanspaces.com',
  bucket: 'uain',
  accessKeyId: 'DO00EXAMPLE',
  secretAccessKey: 'secret',
};

test('storage is off until all four settings are given', () => {
  assert.equal(storageFromEnv({}), null);
  assert.equal(storageFromEnv({ UAIN_STORAGE_ENDPOINT: config.endpoint, UAIN_STORAGE_BUCKET: 'uain' }), null);
  const on = storageFromEnv({
    UAIN_STORAGE_ENDPOINT: config.endpoint,
    UAIN_STORAGE_BUCKET: 'uain',
    UAIN_STORAGE_ACCESS_KEY_ID: 'k',
    UAIN_STORAGE_SECRET_ACCESS_KEY: 's',
  });
  assert.equal(on.region, 'us-east-1');
});

test('requests go to the bucket host, signed, with the key encoded', async () => {
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, init });
    return new Response(init.method === 'GET' ? 'hello' : '', { status: 200 });
  };
  const s = objectStorage(config, fake);
  await s.put("evidence/a b(1).txt", 'hello', 'text/plain');
  assert.equal(seen[0].url, 'https://uain.nyc3.digitaloceanspaces.com/evidence/a%20b%281%29.txt');
  assert.equal(seen[0].init.method, 'PUT');
  assert.match(seen[0].init.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=DO00EXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(new TextDecoder().decode(await s.get('evidence/x')), 'hello');
});

test('a missing object is null, and a leading slash is refused', async () => {
  const s = objectStorage(config, async () => new Response('', { status: 404 }));
  assert.equal(await s.get('nope'), null);
  await assert.rejects(s.get('/nope'), /leading slash/);
});

test('a refusal names the S3 error code', async () => {
  const s = objectStorage(config, async () =>
    new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
  await assert.rejects(s.put('x', 'y'), /answered 403 AccessDenied/);
});

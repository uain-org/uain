import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { readJsonBody } from '../dist/src/api/http-body.js';

test('round 4: JSON limits count UTF-8 bytes rather than decoded characters', async () => {
  const req = new PassThrough();
  const result = readJsonBody(req, 32);
  const rejected = assert.rejects(result, /body too large/);
  req.end(Buffer.from(JSON.stringify({ text: '界'.repeat(12) })));
  await rejected;
});

test('round 4: splitting a multibyte character across chunks preserves the exact body', async () => {
  const req = new PassThrough(), value = { text: '界🌍' };
  const result = readJsonBody(req);
  const bytes = Buffer.from(JSON.stringify(value));
  for (const byte of bytes) req.write(Buffer.from([byte]));
  req.end();
  assert.deepEqual(await result, value);
});

test('round 4: aborted requests release pending body readers', async () => {
  const req = new PassThrough();
  const result = readJsonBody(req);
  const rejected = assert.rejects(result, /request aborted/);
  req.emit('aborted');
  await rejected;
  req.destroy();
});

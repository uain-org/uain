import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionIntent } from './action-intent.js';

test('an unchanged signed action retains its request ID after a lost acknowledgement', async () => {
  const manager = createActionIntent();
  let first;
  await assert.rejects(
    manager.prepare({ text: 'Hello', to: 'peer' }).run(async (body) => {
      first = body;
      throw Error('response lost');
    }),
  );
  const retry = await manager
    .prepare({ to: 'peer', text: 'Hello' })
    .run(async (body) => body);
  assert.equal(retry.clientRequestId, first.clientRequestId);
  const next = await manager
    .prepare({ text: 'Hello', to: 'peer' })
    .run(async (body) => body);
  assert.notEqual(next.clientRequestId, first.clientRequestId);
});
test('changed payloads get a new action ID and cannot be mutated after review', async () => {
  const manager = createActionIntent(),
    fields = { message: 'Original' };
  const reviewed = manager.prepare(fields);
  fields.message = 'Changed';
  const first = await reviewed.run(async (body) => body);
  const second = await manager.prepare(fields).run(async (body) => body);
  assert.equal(first.message, 'Original');
  assert.notEqual(first.clientRequestId, second.clientRequestId);
});
test('an older acknowledgement does not discard a newer pending retry identifier', async () => {
  const manager = createActionIntent();
  let acknowledge;
  const pending = manager.prepare({ text: 'First' }).run(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  let newer;
  await assert.rejects(
    manager.prepare({ text: 'Second' }).run(async (body) => {
      newer = body;
      throw Error('lost');
    }),
  );
  acknowledge({ ok: true });
  await pending;
  assert.equal(
    (await manager.prepare({ text: 'Second' }).run(async (body) => body))
      .clientRequestId,
    newer.clientRequestId,
  );
});

test('identical text sent to a different target starts a distinct intent after a lost acknowledgement', async () => {
  const manager = createActionIntent();
  let first;
  await assert.rejects(
    manager.prepare({ body: 'Hello' }, 'conversation-one').run(async (body) => {
      first = body;
      throw Error('response lost');
    }),
  );
  const second = await manager
    .prepare({ body: 'Hello' }, 'conversation-two')
    .run(async (body) => body);
  assert.notEqual(second.clientRequestId, first.clientRequestId);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeerMessages, MESSAGE_LIMITS } from '../server/messages.mjs';

function member() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    address:
      'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40),
    publicKey: raw.toString('base64'),
  };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'baink-peer-test-')),
    path = join(directory, 'state.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alice = member(),
    bob = member(),
    eve = member();
  let state = {
      accounts: Object.fromEntries(
        [alice, bob, eve].map((w) => [
          w.address,
          { ...w, displayName: 'Private profile name' },
        ]),
      ),
    },
    tail = Promise.resolve();
  const store = {
    read: () => structuredClone(state),
    transact: (operation) => {
      const next = tail.then(async () => {
        const draft = structuredClone(state),
          answer = await operation(draft);
        await writeFile(path + '.tmp', JSON.stringify(draft), { mode: 0o600 });
        await rename(path + '.tmp', path);
        state = draft;
        return structuredClone(answer);
      });
      tail = next.catch(() => {});
      return next;
    },
  };
  return {
    alice,
    bob,
    eve,
    store,
    service: createPeerMessages({ store }),
    restart: async () => {
      await tail;
      state = JSON.parse(await readFile(path, 'utf8'));
      return createPeerMessages({ store });
    },
  };
}
async function open(f, clientRequestId = 'conversation-one') {
  return (await f.service.open(f.alice, { to: f.bob.address, clientRequestId }))
    .conversation;
}
const rejects = (operation, code) =>
  assert.rejects(
    async () => operation(),
    (error) => error.code === code,
  );

test('peer conversations have exactly two existing local participants and do not reveal a profile directory', async (t) => {
  const f = await fixture(t);
  assert.equal(f.service.contacts(f.alice).contacts.length, 0);
  const conversation = await open(f);
  assert.deepEqual(
    new Set(conversation.participants),
    new Set([f.alice.address, f.bob.address]),
  );
  assert.equal(f.service.inbox(f.eve).count, 0);
  await rejects(
    () => f.service.thread(f.eve, conversation.id),
    'conversation_missing',
  );
  const contacts = f.service.contacts(f.alice).contacts;
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].address, f.bob.address);
  assert.equal(contacts[0].displayName, undefined);
  assert.equal(contacts[0].publicKey, undefined);
  await rejects(
    () =>
      f.service.open(f.alice, {
        to: member().address,
        clientRequestId: 'missing-recipient',
      }),
    'recipient_unavailable',
  );
  await rejects(
    () =>
      f.service.open(f.alice, {
        to: f.alice.address,
        clientRequestId: 'self-recipient',
      }),
    'invalid_recipient',
  );
  await rejects(
    () =>
      f.service.open(
        { ...f.alice, publicKey: f.bob.publicKey },
        { to: f.bob.address, clientRequestId: 'forged-context' },
      ),
    'identity_mismatch',
  );
});

test('concurrent creation and sends remain durable and idempotent without replacing an intent', async (t) => {
  const f = await fixture(t),
    opened = await Promise.all(
      Array.from({ length: 8 }, () =>
        f.service.open(f.alice, {
          to: f.bob.address,
          clientRequestId: 'same-open-id',
        }),
      ),
    );
  assert.equal(new Set(opened.map((r) => r.conversation.id)).size, 1);
  assert.equal(opened.filter((r) => r.created).length, 1);
  const id = opened[0].conversation.id;
  await rejects(
    () =>
      f.service.open(f.alice, {
        to: f.eve.address,
        clientRequestId: 'same-open-id',
      }),
    'idempotency_conflict',
  );
  const sent = await Promise.all(
    Array.from({ length: 12 }, () =>
      f.service.send(f.alice, id, {
        body: 'Hello, Bob',
        clientRequestId: 'message-one',
      }),
    ),
  );
  assert.equal(new Set(sent.map((r) => r.message.id)).size, 1);
  assert.equal(sent.filter((r) => r.created).length, 1);
  await rejects(
    () =>
      f.service.send(f.alice, id, {
        body: 'Changed',
        clientRequestId: 'message-one',
      }),
    'idempotency_conflict',
  );
  const restarted = await f.restart();
  const retry = await restarted.send(f.alice, id, {
    body: 'Hello, Bob',
    clientRequestId: 'message-one',
  });
  assert.equal(retry.created, false);
  assert.equal(retry.message.id, sent[0].message.id);
  assert.equal(restarted.thread(f.bob, id).count, 1);
  const other = await restarted.open(f.alice, {
    to: f.eve.address,
    clientRequestId: 'another-thread',
  });
  await rejects(
    () =>
      restarted.send(f.alice, other.conversation.id, {
        body: 'Hello, Bob',
        clientRequestId: 'message-one',
      }),
    'idempotency_conflict',
  );
  assert.equal(restarted.thread(f.eve, other.conversation.id).count, 0);
});

test('unread is derived from actual incoming messages and only the reader owns its monotonic cursor', async (t) => {
  const f = await fixture(t),
    conversation = await open(f),
    id = conversation.id;
  await f.service.send(f.alice, id, {
    body: 'First',
    clientRequestId: 'message-first',
  });
  await f.service.send(f.alice, id, {
    body: 'Second',
    clientRequestId: 'message-second',
  });
  assert.equal(f.service.inbox(f.alice).conversations[0].unreadCount, 0);
  assert.equal(f.service.inbox(f.bob).conversations[0].unreadCount, 2);
  assert.equal(f.service.thread(f.bob, id).conversation.unreadCount, 2);
  await f.service.markRead(f.bob, id, { throughSequence: '1' });
  assert.equal(f.service.inbox(f.bob).conversations[0].unreadCount, 1);
  await f.service.markRead(f.bob, id, { throughSequence: '0' });
  assert.equal(f.service.inbox(f.bob).conversations[0].readCursor, '1');
  await rejects(
    () => f.service.markRead(f.bob, id, { throughSequence: '3' }),
    'invalid_read_cursor',
  );
  await rejects(
    () => f.service.markRead(f.eve, id, { throughSequence: '1' }),
    'conversation_missing',
  );
  await f.service.send(f.bob, id, {
    body: 'Reply',
    clientRequestId: 'message-reply',
  });
  assert.equal(f.service.inbox(f.alice).conversations[0].unreadCount, 1);
  assert.equal(f.service.inbox(f.bob).conversations[0].unreadCount, 1);
});

test('threads page actual history, preserve plain text, and reject invalid UTF-8 input or hidden extra participants', async (t) => {
  const f = await fixture(t),
    conversation = await open(f),
    id = conversation.id;
  for (let i = 0; i < 6; i++)
    await f.service.send(f.alice, id, {
      body: i === 0 ? '<script>alert(1)</script>\nPlain text' : `Message ${i}`,
      clientRequestId: `message-${i}`,
    });
  const first = f.service.thread(f.bob, id, { page: 1, pageSize: 2 }),
    last = f.service.thread(f.bob, id, { page: 3, pageSize: 2 });
  assert.equal(first.count, 6);
  assert.equal(first.pages, 3);
  assert.equal(first.messages[0].body, '<script>alert(1)</script>\nPlain text');
  assert.equal(first.messages[0].contentType, 'text/plain');
  assert.equal(last.messages[1].sequence, '6');
  for (const body of [' ', '\ud800', '\u0000secret', '🙂'.repeat(501)])
    await rejects(
      () =>
        f.service.send(f.alice, id, { body, clientRequestId: 'invalid-body' }),
      'invalid_message',
    );
  const boundary = await f.service.send(f.alice, id, {
    body: '🙂'.repeat(500),
    clientRequestId: 'exact-byte-boundary',
  });
  assert.equal(Buffer.byteLength(boundary.message.body), 2000);
  await rejects(
    () =>
      f.service.send(f.alice, id, {
        body: 'Hello',
        clientRequestId: 'extra-participant',
        to: f.eve.address,
      }),
    'invalid_message',
  );
  assert.equal(f.service.thread(f.bob, id, { pageSize: 1000 }).pageSize, 100);
});

test('blocking stops new delivery while preserving private history and reports never create third-party messages', async (t) => {
  const f = await fixture(t),
    conversation = await open(f),
    id = conversation.id,
    message = (
      await f.service.send(f.alice, id, {
        body: 'Prior message',
        clientRequestId: 'prior-message',
      })
    ).message;
  await f.service.block(f.bob, { address: f.alice.address });
  await rejects(
    () =>
      f.service.send(f.alice, id, {
        body: 'Blocked',
        clientRequestId: 'blocked-message',
      }),
    'messaging_unavailable',
  );
  assert.equal(f.service.thread(f.bob, id).count, 1);
  const report = await f.service.report(f.bob, {
    conversationId: id,
    messageId: message.id,
    reason: 'Unwanted contact',
    clientRequestId: 'report-one',
  });
  assert.equal(report.report.status, 'stored_locally');
  assert.equal(
    (
      await f.service.report(f.bob, {
        conversationId: id,
        messageId: message.id,
        reason: 'Unwanted contact',
        clientRequestId: 'report-one',
      })
    ).report.id,
    report.report.id,
  );
  assert.equal(f.service.inbox(f.eve).count, 0);
  await rejects(
    () =>
      f.service.report(f.eve, {
        conversationId: id,
        messageId: message.id,
        reason: 'Guess',
        clientRequestId: 'foreign-report',
      }),
    'conversation_missing',
  );
  await f.service.block(f.bob, { address: f.alice.address, blocked: false });
  await f.service.send(f.alice, id, {
    body: 'Allowed again',
    clientRequestId: 'allowed-message',
  });
  assert.equal(f.service.thread(f.bob, id).count, 2);
});

test('a full thread refuses further writes without fabricating unread or deleting history', async (t) => {
  const f = await fixture(t),
    conversation = await open(f),
    id = conversation.id;
  await f.store.transact((state) => {
    const c = state.peerMessages.conversations[id];
    c.messages = Array.from({ length: 500 }, (_, i) => ({
      id: `fixture-${i}`,
      conversationId: id,
      sequence: String(i + 1),
      from: f.alice.address,
      body: 'Existing',
      contentType: 'text/plain',
      createdAt: new Date().toISOString(),
      clientRequestId: `seed-${i}`,
    }));
  });
  await rejects(
    () =>
      f.service.send(f.bob, id, {
        body: 'Beyond capacity',
        clientRequestId: 'over-capacity',
      }),
    'message_capacity',
  );
  assert.equal(f.service.thread(f.bob, id).count, 500);
  assert.equal(f.service.inbox(f.bob).conversations[0].unreadCount, 500);
});

function seeded(id, from, to, count) {
  const at = new Date().toISOString();
  return {
    id,
    participants: [from, to].sort(),
    createdAt: at,
    updatedAt: at,
    readCursors: { [from]: '0', [to]: '0' },
    messages: Array.from({ length: count }, (_, i) => ({
      id: `${id}-message-${i}`,
      conversationId: id,
      sequence: String(i + 1),
      from,
      body: 'Existing private text',
      contentType: 'text/plain',
      createdAt: at,
      clientRequestId: `seeded-message-${i}`,
    })),
  };
}

test('the per-sender cap applies across threads before an otherwise empty conversation can receive a message', async (t) => {
  const f = await fixture(t),
    first = await open(f),
    second = (
      await f.service.open(f.alice, {
        to: f.eve.address,
        clientRequestId: 'sender-second-thread',
      })
    ).conversation,
    dave = member();
  await f.store.transact((state) => {
    state.accounts[dave.address] = dave;
    state.peerMessages.conversations[first.id] = seeded(
      first.id,
      f.alice.address,
      f.bob.address,
      500,
    );
    state.peerMessages.conversations[second.id] = seeded(
      second.id,
      f.alice.address,
      f.eve.address,
      500,
    );
  });
  const third = (
    await f.service.open(f.alice, {
      to: dave.address,
      clientRequestId: 'sender-third-thread',
    })
  ).conversation;
  await rejects(
    () =>
      f.service.send(f.alice, third.id, {
        body: 'Beyond sender cap',
        clientRequestId: 'sender-over-cap',
      }),
    'message_capacity',
  );
  assert.equal(f.service.thread(dave, third.id).count, 0);
});

// Second review, 13 November 2026: no member's messages are removed because
// of what other accounts do. While the network count is full, a sender that
// holds nothing is refused; a sender that holds messages rotates its own.
test('a full network count refuses a member holding nothing, removes nothing, and lets a holder rotate its own', async (t) => {
  const f = await fixture(t),
    conversation = await open(f);
  for (let i = 0; i < 40; i++)
    await f.service.send(f.alice, conversation.id, { body: 'Alice ' + i, clientRequestId: `alice-own-${i}` });
  const others = Array.from({ length: 10 }, () => member());
  await f.store.transact((state) => {
    // Several messages often share a millisecond; pin that case: all of
    // Alice's messages carry one createdAt, so only the sequence orders them.
    const at = state.peerMessages.conversations[conversation.id].messages[0].createdAt;
    for (const m of state.peerMessages.conversations[conversation.id].messages) m.createdAt = at;
    for (let i = 0; i < others.length; i++) {
      const other = others[i], id = `other-conversation-${i}`;
      state.accounts[other.address] = other;
      state.peerMessages.conversations[id] = seeded(id, other.address, f.eve.address, 496);
    }
  });
  const before = structuredClone(f.store.read().peerMessages);
  await rejects(
    () => f.service.send(f.bob, conversation.id, { body: 'First message on a full network', clientRequestId: 'global-over-cap' }),
    'message_capacity',
  );
  assert.deepEqual(f.store.read().peerMessages, before);
  const sent = await f.service.send(f.alice, conversation.id, { body: 'Rotated', clientRequestId: 'alice-rotates' });
  assert.equal(sent.message.sequence, '41');
  const after = f.store.read().peerMessages, mine = after.conversations[conversation.id].messages;
  assert.equal(mine.length, 40);
  assert.equal(mine[0].sequence, '2');
  for (let i = 0; i < 10; i++) assert.equal(after.conversations[`other-conversation-${i}`].messages.length, 496);
});

test('one sender over its byte budget loses its own oldest messages, and sequences keep counting', async (t) => {
  const f = await fixture(t),
    conversation = await open(f),
    id = conversation.id,
    body = '"'.repeat(2000);
  let last;
  for (let i = 0; i < 70; i++)
    last = await f.service.send(f.alice, id, { body, clientRequestId: `budget-${i}` });
  assert.equal(last.message.sequence, '70');
  const thread = f.service.thread(f.bob, id, { pageSize: 100 });
  assert.ok(thread.count < 70 && thread.count > 50, `kept ${thread.count}`);
  assert.equal(thread.messages.at(-1).sequence, '70');
  assert.equal(thread.conversation.lastSequence, '70');
  const bytes = thread.messages.reduce((s, m) => s + Buffer.byteLength(JSON.stringify(m)), 0);
  assert.ok(bytes <= MESSAGE_LIMITS.senderBytes);
  // Reading through the newest sequence is accepted although early messages are gone.
  assert.equal((await f.service.markRead(f.bob, id, { throughSequence: '70' })).conversation.unreadCount, 0);
});

// Third review, 13 November 2026: a sender whose own messages cannot make
// room for the new one is refused before any of them is removed.
test('a sender that cannot make room from its own messages is refused and keeps every message', async (t) => {
  const f = await fixture(t),
    conversation = await open(f);
  await f.service.send(f.alice, conversation.id, { body: 'short', clientRequestId: 'alice-short-1' });
  await f.service.send(f.alice, conversation.id, { body: 'tiny', clientRequestId: 'alice-short-2' });
  const big = '"'.repeat(2000), others = Array.from({ length: 4 }, () => member());
  await f.store.transact((state) => {
    let total = Object.values(state.peerMessages.conversations).flatMap((c) => c.messages).reduce((s, m) => s + Buffer.byteLength(JSON.stringify(m)), 0);
    others.forEach((other, i) => {
      const id = `bytes-conversation-${i}`;
      state.accounts[other.address] = other;
      const c = seeded(id, other.address, f.eve.address, 0);
      while (c.messages.length < 499 && total < MESSAGE_LIMITS.totalBytes - 1000) {
        const m = { id: `${id}-${c.messages.length}`, conversationId: id, sequence: String(c.messages.length + 1), from: other.address, body: big, contentType: 'text/plain', createdAt: new Date().toISOString(), clientRequestId: `bytes-${i}-${c.messages.length}` };
        c.messages.push(m);
        total += Buffer.byteLength(JSON.stringify(m));
      }
      state.peerMessages.conversations[id] = c;
    });
  });
  const before = structuredClone(f.store.read().peerMessages);
  await rejects(
    () => f.service.send(f.alice, conversation.id, { body: big, clientRequestId: 'alice-too-big' }),
    'message_capacity',
  );
  assert.deepEqual(f.store.read().peerMessages, before);
  assert.equal(f.service.thread(f.alice, conversation.id).count, 2);
});

// Second review, 13 November 2026: full network caps refuse the new row and
// never remove another member's conversation, key, block or report.
test('full network caps refuse new conversations, request keys, blocks and reports, and remove nothing', async (t) => {
  const f = await fixture(t);
  const base = await open(f);
  const message = (await f.service.send(f.alice, base.id, { body: 'hello', clientRequestId: 'first-message' })).message;
  await f.store.transact((state) => {
    const data = state.peerMessages;
    for (let a = 0; a < 10; a++) {
      const attacker = member();
      state.accounts[attacker.address] = { ...attacker, createdAt: new Date().toISOString() };
      data.blocks[attacker.address] = Array.from({ length: MESSAGE_LIMITS.blocks / 10 }, (_, i) => 'uain1' + String(a * 100000 + i).padStart(40, '0'));
      for (let i = 0; Object.keys(data.conversations).length < MESSAGE_LIMITS.conversations && i < 100; i++) {
        const cid = `attack-${a}-${i}`;
        data.conversations[cid] = seeded(cid, attacker.address, 'uain1' + String(i).padStart(40, '9'), 0);
      }
      for (let i = 0; Object.keys(data.reports).length < MESSAGE_LIMITS.reports && i < MESSAGE_LIMITS.reports / 10; i++)
        data.reports[`report-${a}-${i}`] = { id: `report-${a}-${i}`, reporter: attacker.address, conversationId: base.id, messageId: message.id, reason: 'x', clientRequestId: `r-${a}-${i}`, status: 'stored_locally', createdAt: new Date().toISOString() };
    }
  });
  const before = structuredClone(f.store.read().peerMessages);
  await rejects(() => f.service.open(f.eve, { to: f.bob.address, clientRequestId: 'eve-to-bob' }), 'conversation_capacity');
  await rejects(() => f.service.block(f.alice, { address: f.eve.address }), 'block_capacity');
  await rejects(() => f.service.report(f.bob, { conversationId: base.id, messageId: message.id, reason: 'test', clientRequestId: 'first-report' }), 'report_capacity');
  assert.deepEqual(f.store.read().peerMessages, before);
  // The open-request key cap refuses on its own too.
  await f.store.transact((state) => {
    const data = state.peerMessages;
    for (const id of Object.keys(data.conversations)) if (id.startsWith('attack-')) delete data.conversations[id];
    for (let i = 0; Object.keys(data.openKeys).length < MESSAGE_LIMITS.openKeys; i++) data.openKeys[`uain1${String(i % 50).padStart(40, '0')}:key-${i}`] = { to: f.bob.address, conversationId: base.id };
  });
  const keys = structuredClone(f.store.read().peerMessages);
  await rejects(() => f.service.open(f.eve, { to: f.bob.address, clientRequestId: 'eve-to-bob' }), 'conversation_capacity');
  assert.deepEqual(f.store.read().peerMessages, keys);
});

// First review, 13 November 2026: the earlier "heaviest holder" rule let fresh
// accounts delete an honest member's messages and blocks.
function flatStore(accounts) {
  let state = { accounts }, tail = Promise.resolve();
  const store = {
    read: () => structuredClone(state),
    transact: (op) => {
      const next = tail.then(async () => { const d = structuredClone(state); const a = await op(d); state = d; return structuredClone(a); });
      tail = next.catch(() => {});
      return next;
    },
  };
  return { store, state: () => state };
}
const allMessages = (s) => Object.values(s.state().peerMessages.conversations).flatMap((c) => c.messages);

test('100 accounts flooding the message count never remove an honest member\'s messages (first reviewer\'s evict.mjs)', async () => {
  const alice = member(), bob = member(), attackers = Array.from({ length: 100 }, member);
  const s = flatStore(Object.fromEntries([alice, bob, ...attackers].map((w, i) => [w.address, { ...w, createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() }])));
  const svc = createPeerMessages({ store: s.store });
  const c1 = (await svc.open(alice, { to: bob.address, clientRequestId: 'aaaaaaaa1' })).conversation.id;
  for (let i = 0; i < 40; i++) await svc.send(alice, c1, { body: 'x'.repeat(1000), clientRequestId: 'alice' + String(i).padStart(4, '0') });
  const convs = [];
  for (let i = 0; i < 100; i += 2) convs.push((await svc.open(attackers[i], { to: attackers[i + 1].address, clientRequestId: 'open' + String(i).padStart(5, '0') })).conversation.id);
  let n = 0;
  outer: for (let r = 0; r < 50; r++) for (let i = 0; i < 100; i++) { if (n >= 4960) break outer; await svc.send(attackers[i], convs[i >> 1], { body: 'y', clientRequestId: `atk${i}r${r}xx` }); n++; }
  assert.equal(allMessages(s).length, MESSAGE_LIMITS.totalMessages);
  // The attacker rotates its own messages; Alice keeps all 40.
  for (let k = 0; k < 20; k++)
    assert.equal((await svc.send(attackers[0], convs[0], { body: 'z', clientRequestId: 'more' + String(k).padStart(5, '0') })).created, true);
  assert.equal(allMessages(s).filter((m) => m.from === alice.address).length, 40);
  assert.ok(allMessages(s).length <= MESSAGE_LIMITS.totalMessages);
  // Bob holds nothing, so the full network refuses him; nothing is removed.
  await assert.rejects(svc.send(bob, c1, { body: 'hi', clientRequestId: 'bob-first-1' }), (e) => e.code === 'message_capacity');
  assert.equal(allMessages(s).filter((m) => m.from === alice.address).length, 40);
});

test('1,000 accounts with five messages each never cut an honest member, who can still send by rotating its own (second reviewer\'s scenario 2)', async () => {
  const accounts = {}, add = () => { const m = member(); accounts[m.address] = { ...m, displayName: 'x', createdAt: new Date().toISOString() }; return m; };
  const a = add(), b = add(), atk = Array.from({ length: 1000 }, add), x = add(), y = add();
  const s = flatStore(accounts), svc = createPeerMessages({ store: s.store });
  const c = (await svc.open(a, { to: b.address, clientRequestId: 'honest-open' })).conversation.id;
  for (let i = 0; i < 40; i++) await svc.send(a, c, { body: 'honest ' + i, clientRequestId: `honest-${i}` });
  let total = 40;
  for (let i = 0; i < atk.length && total < MESSAGE_LIMITS.totalMessages; i += 2) {
    const ac = (await svc.open(atk[i], { to: atk[i + 1].address, clientRequestId: `atk-open-${i}` })).conversation.id;
    for (let k = 0; k < 5; k++) for (const who of [atk[i], atk[i + 1]]) {
      if (total >= MESSAGE_LIMITS.totalMessages) break;
      await svc.send(who, ac, { body: 'x', clientRequestId: `atk-${i}-${k}-${who.address.slice(-6)}` });
      total++;
    }
  }
  const honest = () => s.state().peerMessages.conversations[c].messages.length;
  assert.equal(honest(), 40);
  const xc = (await svc.open(x, { to: y.address, clientRequestId: 'fresh-open' })).conversation.id;
  for (let k = 0; k < 3; k++)
    await assert.rejects(svc.send(x, xc, { body: 'z', clientRequestId: `fresh-${k}-send` }), (e) => e.code === 'message_capacity');
  assert.equal(honest(), 40);
  await svc.send(a, c, { body: 'honest new', clientRequestId: 'honest-new-1' });
  assert.equal(honest(), 40);
  assert.equal(s.state().peerMessages.conversations[c].messages.at(-1).body, 'honest new');
});

test('46 accounts pairing up fill the conversation cap: an honest open is refused and nothing is removed (second reviewer\'s scenario 1)', async () => {
  const accounts = {}, add = () => { const m = member(); accounts[m.address] = { ...m, displayName: 'x', createdAt: new Date().toISOString() }; return m; };
  const atk = Array.from({ length: 46 }, add), a = add(), b = add();
  const s = flatStore(accounts), svc = createPeerMessages({ store: s.store });
  let n = 0;
  for (let i = 0; i < atk.length && n < MESSAGE_LIMITS.conversations; i++)
    for (let j = i + 1; j < atk.length && n < MESSAGE_LIMITS.conversations; j++) {
      await svc.open(atk[i], { to: atk[j].address, clientRequestId: `pair-${i}-${j}-a` });
      await svc.open(atk[j], { to: atk[i].address, clientRequestId: `pair-${i}-${j}-b` });
      n++;
    }
  const before = structuredClone(s.state().peerMessages);
  assert.equal(Object.keys(before.conversations).length, MESSAGE_LIMITS.conversations);
  await assert.rejects(svc.open(a, { to: b.address, clientRequestId: 'honest-open' }), (e) => e.code === 'conversation_capacity');
  assert.deepEqual(s.state().peerMessages, before);
});

test('a member\'s blocks all survive accounts filling the block cap; every new block is refused with block_capacity', async () => {
  const alice = member(), bob = member(), stranger = member(), attackers = Array.from({ length: Math.ceil((MESSAGE_LIMITS.blocks - 100) / 99) }, member);
  const s = flatStore(Object.fromEntries([alice, bob, stranger, ...attackers].map((w) => [w.address, { ...w, createdAt: '2026-01-01T00:00:00.000Z' }])));
  const svc = createPeerMessages({ store: s.store });
  const fake = (n) => 'uain1' + String(n).padStart(40, '0');
  await s.store.transact((state) => {
    state.peerMessages = { version: 1, conversations: {}, openKeys: {}, messageKeys: {}, blocks: {}, reports: {} };
    state.peerMessages.blocks[alice.address] = Array.from({ length: 10 }, (_, i) => fake(9_000_000 + i));
    let left = MESSAGE_LIMITS.blocks - 10, a = 0;
    while (left > 0) { const take = Math.min(99, left); state.peerMessages.blocks[attackers[a].address] = Array.from({ length: take }, (_, i) => fake(a * 1000 + i)); left -= take; a++; }
  });
  const before = structuredClone(s.state().peerMessages.blocks);
  for (const who of [attackers[0], bob, alice])
    await assert.rejects(svc.block(who, { address: stranger.address }), (e) => e.code === 'block_capacity');
  assert.deepEqual(s.state().peerMessages.blocks, before);
  // Unblocking still works and frees room.
  assert.deepEqual(await svc.block(alice, { address: fake(9_000_000), blocked: false }), { address: fake(9_000_000), blocked: false });
  assert.deepEqual(await svc.block(bob, { address: stranger.address }), { address: stranger.address, blocked: true });
});

test('reports about an attacker survive the attacker\'s report flood', async () => {
  const alice = member(), attacker = member(), helpers = Array.from({ length: 60 }, member);
  const s = flatStore(Object.fromEntries([alice, attacker, ...helpers].map((w) => [w.address, { ...w, createdAt: '2026-01-01T00:00:00.000Z' }])));
  const svc = createPeerMessages({ store: s.store });
  const c = (await svc.open(attacker, { to: alice.address, clientRequestId: 'attack-open' })).conversation.id;
  const m = (await svc.send(attacker, c, { body: 'abuse', clientRequestId: 'abuse-0001' })).message;
  const filed = await svc.report(alice, { conversationId: c, messageId: m.id, reason: 'abuse', clientRequestId: 'alice-report' });
  await s.store.transact((state) => {
    const reports = state.peerMessages.reports;
    for (let i = 0; Object.keys(reports).length < MESSAGE_LIMITS.reports; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      reports[id] = { id, reporter: helpers[i % 60].address, conversationId: c, messageId: m.id, reason: 'flood', clientRequestId: `flood-${i}`, status: 'stored_locally', createdAt: new Date().toISOString() };
    }
  });
  const hc = (await svc.open(helpers[0], { to: attacker.address, clientRequestId: 'helper-open' })).conversation.id;
  const hm = (await svc.send(attacker, hc, { body: 'bait', clientRequestId: 'bait-0001' })).message;
  await assert.rejects(svc.report(helpers[0], { conversationId: hc, messageId: hm.id, reason: 'more', clientRequestId: 'more-flood' }), (e) => e.code === 'report_capacity');
  assert.ok(s.state().peerMessages.reports[filed.report.id]);
});

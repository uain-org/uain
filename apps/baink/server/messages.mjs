import { createHash, randomUUID } from 'node:crypto';

export class PeerMessageError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const reject = (status, code, message) => {
  throw new PeerMessageError(status, code, message);
};
const check = (condition, status, code, message) => {
  if (!condition) reject(status, code, message);
};
const address = (value) =>
  typeof value === 'string' && /^uain1[a-f0-9]{40}$/.test(value);
const own = (object, key) => Object.hasOwn(object, key);
function exact(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => own(value, key))
  );
}
function clientId(value) {
  check(
    typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value),
    400,
    'invalid_request_id',
    'Provide a unique request identifier of 8–100 letters, digits, dashes or underscores.',
  );
  return value;
}
function plain(value, max, code = 'invalid_message') {
  check(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      Buffer.byteLength(value) <= max &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        value,
      ),
    400,
    code,
    `Provide nonempty plain text of at most ${max} UTF-8 bytes.`,
  );
  return value;
}
function pages(options = {}, fallback = 30) {
  const page = Math.min(
      10000,
      Math.max(1, parseInt(options.page ?? '1', 10) || 1),
    ),
    pageSize = Math.min(
      100,
      Math.max(
        1,
        parseInt(options.pageSize ?? String(fallback), 10) || fallback,
      ),
    );
  return { page, pageSize };
}
function paged(items, options, fallback) {
  const { page, pageSize } = pages(options, fallback);
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    count: items.length,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(items.length / pageSize)),
  };
}
function messaging(state) {
  if (state.peerMessages === undefined)
    state.peerMessages = {
      version: 1,
      conversations: {},
      openKeys: {},
      messageKeys: {},
      blocks: {},
      reports: {},
    };
  const data = state.peerMessages;
  check(
    data?.version === 1 &&
      ['conversations', 'openKeys', 'messageKeys', 'blocks', 'reports'].every(
        (key) =>
          data[key] &&
          typeof data[key] === 'object' &&
          !Array.isArray(data[key]),
      ),
    503,
    'message_storage_unavailable',
    'Private message storage is unavailable.',
  );
  return data;
}
function userOf(state, user) {
  check(
    user && address(user.address) && typeof user.publicKey === 'string',
    403,
    'identity_mismatch',
    'A verified local identity is required.',
  );
  const key = Buffer.from(user.publicKey, 'base64');
  check(
    key.length === 32 &&
      key.toString('base64') === user.publicKey &&
      'uain1' + createHash('sha256').update(key).digest('hex').slice(0, 40) ===
        user.address,
    403,
    'identity_mismatch',
    'The local public key does not match this identity.',
  );
  check(
    state.accounts && own(state.accounts, user.address),
    404,
    'account_missing',
    'Create your local BAINK profile first.',
  );
  check(
    state.accounts[user.address].publicKey === user.publicKey,
    403,
    'identity_mismatch',
    'The local account public key differs.',
  );
  return user.address;
}
function participant(data, id, owner) {
  check(
    typeof id === 'string' && own(data.conversations, id),
    404,
    'conversation_missing',
    'Private conversation not found.',
  );
  const conversation = data.conversations[id];
  check(
    conversation.participants.includes(owner),
    404,
    'conversation_missing',
    'Private conversation not found.',
  );
  return conversation;
}
function blocked(data, a, b) {
  return (
    (data.blocks[a] ?? []).includes(b) || (data.blocks[b] ?? []).includes(a)
  );
}
// Stored-size budgets (13 November 2026, B1-1/B1-5). Every message lives in
// one stored row, so its size, not only its count, is bounded: per sender, and
// for the whole network. A member's rows are never removed because of what
// other accounts do (second review, 13 November 2026): a sender over its own
// byte budget, or sending while a network budget is full, can only rotate its
// own oldest messages; every other full network cap refuses the new row.
export const MESSAGE_LIMITS = Object.freeze({
  senderBytes: 256 * 1024,
  totalBytes: 4 * 1024 * 1024,
  totalMessages: 5000,
  conversations: 1000,
  openKeys: 5000,
  blocks: 20000,
  reports: 2000,
});
const storedBytes = (value) => Buffer.byteLength(JSON.stringify(value));
/** The highest sequence a conversation ever used (old messages may be gone). */
function lastSequence(conversation) {
  const kept = BigInt(conversation.messages.at(-1)?.sequence ?? '0'),
    gone = BigInt(conversation.lastSequence ?? '0');
  return kept > gone ? kept : gone;
}
function forgetMessage(data, conversation, index) {
  const [message] = conversation.messages.splice(index, 1),
    key = message.from + ':' + message.clientRequestId;
  if (data.messageKeys[key]?.messageId === message.id) delete data.messageKeys[key];
  return message;
}
function summary(data, conversation, owner) {
  const cursor = conversation.readCursors[owner] ?? '0',
    counterparty = conversation.participants.find((id) => id !== owner),
    last = conversation.messages.at(-1);
  return {
    id: conversation.id,
    participants: [...conversation.participants],
    counterparty,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    lastSequence: String(lastSequence(conversation)),
    readCursor: cursor,
    unreadCount: conversation.messages.filter(
      (message) =>
        message.from !== owner && BigInt(message.sequence) > BigInt(cursor),
    ).length,
    lastMessage: last ? structuredClone(last) : null,
    messagingAvailable: !blocked(data, owner, counterparty),
    youBlocked: (data.blocks[owner] ?? []).includes(counterparty),
  };
}

/** Private local peer metadata only. This service neither discovers public
 * native members nor delivers through external messaging/native-ledger APIs.
 * store.read must return a snapshot; store.transact must serialize and durably
 * commit its callback atomically before resolving, as BAINK's store does. */
export function createPeerMessages({ store }) {
  check(
    store &&
      typeof store.read === 'function' &&
      typeof store.transact === 'function',
    500,
    'message_storage_unavailable',
    'A transactional message store is required.',
  );
  const snapshot = (user) => {
    const state = store.read(),
      owner = userOf(state, user);
    return { owner, data: messaging(state) };
  };
  return Object.freeze({
    contacts(user, options = {}) {
      const { owner, data } = snapshot(user),
        q = String(options.q ?? '')
          .trim()
          .toLowerCase()
          .slice(0, 200);
      const contacts = Object.values(data.conversations)
        .filter((c) => c.participants.includes(owner))
        .map((c) => ({
          address: c.participants.find((id) => id !== owner),
          conversationId: c.id,
          identitySource: 'local-profile',
          lastActivityAt: c.updatedAt,
        }))
        .filter((c) => !q || c.address.includes(q))
        .sort(
          (a, b) =>
            b.lastActivityAt.localeCompare(a.lastActivityAt) ||
            a.address.localeCompare(b.address),
        );
      const { items, ...page } = paged(contacts, options, 30);
      return { contacts: items, ...page };
    },
    async open(user, body) {
      check(
        exact(body, ['to', 'clientRequestId']),
        400,
        'invalid_recipient',
        'Provide only a recipient address and request identifier.',
      );
      const requestId = clientId(body.clientRequestId);
      return store.transact((state) => {
        const owner = userOf(state, user),
          data = messaging(state),
          to = body.to;
        check(
          address(to) && to !== owner,
          400,
          'invalid_recipient',
          'Choose another member address.',
        );
        const key = owner + ':' + requestId,
          prior = data.openKeys[key];
        if (prior) {
          check(
            prior.to === to,
            409,
            'idempotency_conflict',
            'This request identifier already refers to another recipient.',
          );
          const conversation = participant(data, prior.conversationId, owner);
          return {
            created: false,
            conversation: summary(data, conversation, owner),
          };
        }
        check(
          own(state.accounts, to) && !blocked(data, owner, to),
          404,
          'recipient_unavailable',
          'This recipient is unavailable for private messaging.',
        );
        const openKeys = Object.keys(data.openKeys);
        check(
          openKeys.length < MESSAGE_LIMITS.openKeys &&
            openKeys.filter((k) => k.startsWith(owner + ':')).length < 200,
          429,
          'conversation_capacity',
          'Conversation request capacity reached.',
        );
        const participants = [owner, to].sort();
        let conversation = Object.values(data.conversations).find(
          (c) =>
            c.participants.length === 2 &&
            c.participants[0] === participants[0] &&
            c.participants[1] === participants[1],
        );
        let created = false;
        if (!conversation) {
          const all = Object.values(data.conversations);
          check(
            all.length < MESSAGE_LIMITS.conversations &&
              participants.every(
                (p) =>
                  all.filter((c) => c.participants.includes(p)).length < 100,
              ),
            429,
            'conversation_capacity',
            'Private conversation capacity reached.',
          );
          const now = new Date().toISOString();
          conversation = {
            id: randomUUID(),
            participants,
            createdAt: now,
            updatedAt: now,
            messages: [],
            readCursors: { [owner]: '0', [to]: '0' },
          };
          data.conversations[conversation.id] = conversation;
          created = true;
        }
        data.openKeys[key] = { to, conversationId: conversation.id };
        return { created, conversation: summary(data, conversation, owner) };
      });
    },
    inbox(user, options = {}) {
      const { owner, data } = snapshot(user),
        all = Object.values(data.conversations)
          .filter((c) => c.participants.includes(owner))
          .sort(
            (a, b) =>
              b.updatedAt.localeCompare(a.updatedAt) ||
              b.id.localeCompare(a.id),
          );
      const { items, ...page } = paged(all, options, 30);
      return {
        conversations: items.map((c) => summary(data, c, owner)),
        ...page,
        unreadCount: all.reduce(
          (sum, c) => sum + summary(data, c, owner).unreadCount,
          0,
        ),
      };
    },
    thread(user, id, options = {}) {
      const { owner, data } = snapshot(user),
        conversation = participant(data, id, owner),
        { items, ...page } = paged(conversation.messages, options, 50);
      return {
        conversation: summary(data, conversation, owner),
        messages: structuredClone(items),
        ...page,
      };
    },
    async send(user, id, body) {
      check(
        exact(body, ['body', 'clientRequestId']),
        400,
        'invalid_message',
        'Provide only plain message text and its request identifier.',
      );
      const text = plain(body.body, 2000),
        requestId = clientId(body.clientRequestId);
      return store.transact((state) => {
        const owner = userOf(state, user),
          data = messaging(state),
          conversation = participant(data, id, owner),
          key = owner + ':' + requestId,
          prior = data.messageKeys[key];
        if (prior) {
          check(
            prior.conversationId === id,
            409,
            'idempotency_conflict',
            'This message identifier already refers to another conversation.',
          );
          const existing = conversation.messages.find(
            (m) => m.id === prior.messageId,
          );
          check(
            existing && existing.from === owner && existing.body === text,
            409,
            'idempotency_conflict',
            'This message identifier already refers to different text.',
          );
          return { created: false, message: existing };
        }
        const counterparty = conversation.participants.find((p) => p !== owner);
        check(
          !blocked(data, owner, counterparty),
          403,
          'messaging_unavailable',
          'Messaging is unavailable for this conversation.',
        );
        const message = {
          id: randomUUID(),
          conversationId: id,
          sequence: String(lastSequence(conversation) + 1n),
          from: owner,
          body: text,
          contentType: 'text/plain',
          createdAt: new Date().toISOString(),
          clientRequestId: requestId,
        };
        // Stored bytes and counts per sender, as the row stores them.
        const bytes = new Map(), counts = new Map();
        let total = 0, totalCount = 0;
        for (const c of Object.values(data.conversations))
          for (const m of c.messages) {
            const size = storedBytes(m);
            bytes.set(m.from, (bytes.get(m.from) ?? 0) + size);
            counts.set(m.from, (counts.get(m.from) ?? 0) + 1);
            total += size;
            totalCount++;
          }
        const size = storedBytes(message);
        check(
          conversation.messages.length < 500 &&
            (counts.get(owner) ?? 0) < 1000 &&
            size <= MESSAGE_LIMITS.senderBytes,
          429,
          'message_capacity',
          'Private message storage capacity reached.',
        );
        // Only the sender's own messages are ever removed. Over its own byte
        // budget, its oldest go until the new one fits. While a network budget
        // (count or bytes) is full, the sender can only rotate: its oldest go
        // until the new one fits the network or it holds no more than before
        // this send; a sender with nothing left to rotate is refused. So the
        // network total never grows past its budget (and never grows at all
        // while an older store is above it).
        // First decide how many of its own oldest messages must go; if no
        // number of them is enough, refuse before removing anything.
        const heldCount = counts.get(owner) ?? 0, heldBytes = bytes.get(owner) ?? 0;
        const mine = [];
        for (const c of Object.values(data.conversations))
          for (const m of c.messages) if (m.from === owner) mine.push({ c, m, size: storedBytes(m) });
        // Oldest first: by time, and within one millisecond by conversation
        // sequence (the message id is random, so it cannot order ties).
        mine.sort((a, b) =>
          a.m.createdAt.localeCompare(b.m.createdAt) ||
          a.m.conversationId.localeCompare(b.m.conversationId) ||
          (BigInt(a.m.sequence) < BigInt(b.m.sequence) ? -1 : BigInt(a.m.sequence) > BigInt(b.m.sequence) ? 1 : 0));
        let remove = 0, freed = 0;
        const fits = () => {
          const ownBytes = heldBytes - freed;
          if (ownBytes + size > MESSAGE_LIMITS.senderBytes) return false;
          if (totalCount - remove < MESSAGE_LIMITS.totalMessages && total - freed + size <= MESSAGE_LIMITS.totalBytes) return true;
          return heldCount - remove + 1 <= heldCount && ownBytes + size <= heldBytes;
        };
        while (!fits()) {
          check(remove < mine.length, 429, 'message_capacity', 'Private message storage capacity reached.');
          freed += mine[remove++].size;
        }
        for (const { c, m } of mine.slice(0, remove)) {
          c.lastSequence = String(lastSequence(c));
          forgetMessage(data, c, c.messages.indexOf(m));
        }
        conversation.messages.push(message);
        conversation.updatedAt = message.createdAt;
        data.messageKeys[key] = { conversationId: id, messageId: message.id };
        return { created: true, message };
      });
    },
    async markRead(user, id, body) {
      check(
        exact(body, ['throughSequence']) &&
          typeof body.throughSequence === 'string' &&
          // Sequences keep counting after a sender's old messages are rotated out (13 November 2026).
          /^(0|[1-9][0-9]{0,8})$/.test(body.throughSequence),
        400,
        'invalid_read_cursor',
        'Provide a canonical message sequence to acknowledge.',
      );
      return store.transact((state) => {
        const owner = userOf(state, user),
          data = messaging(state),
          conversation = participant(data, id, owner),
          through = BigInt(body.throughSequence);
        check(
          through <= lastSequence(conversation),
          400,
          'invalid_read_cursor',
          'The read cursor cannot exceed this conversation history.',
        );
        if (through > BigInt(conversation.readCursors[owner] ?? '0'))
          conversation.readCursors[owner] = String(through);
        return { conversation: summary(data, conversation, owner) };
      });
    },
    async block(user, body) {
      check(
        exact(body, ['address']) || exact(body, ['address', 'blocked']),
        400,
        'invalid_recipient',
        'Provide only the address and optional blocked flag.',
      );
      check(
        body.blocked === undefined || typeof body.blocked === 'boolean',
        400,
        'invalid_recipient',
        'The blocked flag must be true or false.',
      );
      return store.transact((state) => {
        const owner = userOf(state, user),
          data = messaging(state);
        check(
          address(body.address) && body.address !== owner,
          400,
          'invalid_recipient',
          'Choose another member address.',
        );
        const list = data.blocks[owner] ?? [],
          isBlocked = body.blocked !== false;
        if (isBlocked && !list.includes(body.address)) {
          check(
            list.length < 100 &&
              Object.values(data.blocks).reduce(
                (sum, items) => sum + items.length,
                0,
              ) < MESSAGE_LIMITS.blocks,
            429,
            'block_capacity',
            'Private block-list capacity reached.',
          );
          list.push(body.address);
        }
        data.blocks[owner] = isBlocked
          ? list
          : list.filter((item) => item !== body.address);
        return { address: body.address, blocked: isBlocked };
      });
    },
    async report(user, body) {
      check(
        exact(body, [
          'conversationId',
          'messageId',
          'reason',
          'clientRequestId',
        ]),
        400,
        'invalid_report',
        'Provide the conversation, message, reason and report identifier.',
      );
      const reason = plain(body.reason, 1000, 'invalid_report'),
        requestId = clientId(body.clientRequestId);
      return store.transact((state) => {
        const owner = userOf(state, user),
          data = messaging(state),
          conversation = participant(data, body.conversationId, owner);
        check(
          conversation.messages.some((m) => m.id === body.messageId),
          404,
          'message_missing',
          'Private message not found.',
        );
        const prior = Object.values(data.reports).find(
          (r) => r.reporter === owner && r.clientRequestId === requestId,
        );
        if (prior) {
          check(
            prior.conversationId === conversation.id &&
              prior.messageId === body.messageId &&
              prior.reason === reason,
            409,
            'idempotency_conflict',
            'This report identifier already refers to different details.',
          );
          return { created: false, report: prior };
        }
        const reports = Object.values(data.reports);
        check(
          reports.length < MESSAGE_LIMITS.reports &&
            reports.filter((r) => r.reporter === owner).length < 20,
          429,
          'report_capacity',
          'Private report storage capacity reached.',
        );
        const report = {
          id: randomUUID(),
          reporter: owner,
          conversationId: conversation.id,
          messageId: body.messageId,
          reason,
          clientRequestId: requestId,
          status: 'stored_locally',
          createdAt: new Date().toISOString(),
        };
        data.reports[report.id] = report;
        return { created: true, report };
      });
    },
  });
}

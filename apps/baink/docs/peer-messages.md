# Private peer messages service

2026-10-31. `server/messages.mjs` provides local BAINK peer conversations, separately from research/project records. It does not write to the native ledger, send Slack messages, invite anyone, send email, create meetings, or notify a third party. The parent application owns HTTP routing, UI, deployment and live acceptance.

Messages are **plain text readable by their participants and by the BAINK server**. They are private application metadata, not end-to-end encrypted. The UI must explain this before the first send. Render `body` as text (`textContent` or React text children); never use HTML insertion, markdown HTML passthrough or an executable link preview. Text such as `<script>` is retained literally with `contentType: text/plain`, not rendered or executed by this service.

## Identity and privacy

Construct `createPeerMessages({store})`. Every operation takes the authenticated `{address, publicKey}` context; `publicKey` is canonical standard-base64 raw Ed25519, as supplied by the existing signed BAINK operation authentication. The service independently checks the address hash, local account existence and stored public-key match. A local profile is not a claim of native membership, a public directory listing, operator verification or project affiliation.

Conversations have exactly two distinct existing local profiles. The caller provides an exact known recipient address to `open`; there is no global local-account search. Unavailable/nonexistent/blocked recipients share a generic `recipient_unavailable` response. Only participants can see a conversation, message history or read state; outsiders receive `conversation_missing`. Public profile names and keys are not exposed through this module. `contacts` lists only counterparties already present in the caller's own conversations, by address and conversation ID. It does not enumerate local profiles or imply recipient consent to public discovery.

The store must expose synchronous `read()` snapshots and serialized, atomic, durable `transact(callback)` commits. The existing BAINK metadata store satisfies this contract. Writes extend it with `peerMessages: {version: 1, conversations, openKeys, messageKeys, blocks, reports}`. Missing peer state initializes compatibly on first write; existing accounts, enrolment journals, payment requests and history are preserved. Unsupported peer state fails closed without resetting it.

## Module contract

Read operations are synchronous; write operations return promises. The HTTP handler can await either. Errors are exported `PeerMessageError` instances with `{status, code, message}` and must retain that HTTP/error mapping. The module performs no HTTP authentication itself; parent routes must keep the existing signed-request, body-size, origin and admission checks.

- `contacts(user, {q?, page?, pageSize?})` → `{contacts: [{address, conversationId, identitySource: local-profile, lastActivityAt}], count, page, pageSize, pages}`. Search filters only known contact addresses, never private names.
- `open(user, {to, clientRequestId})` → `{created, conversation}`. An existing participant pair always resolves to the same conversation. The same caller's request identifier cannot be retargeted to another recipient. Opening a thread creates no message and no unread badge.
- `inbox(user, {page?, pageSize?})` → `{conversations, count, page, pageSize, pages, unreadCount}`. The outer unread count covers **all** authorized conversations, not only the current page.
- `thread(user, conversationId, {page?, pageSize?})` → `{conversation, messages, count, page, pageSize, pages}`. Message pages are ascending by their immutable sequence; reads never implicitly mark messages seen.
- `send(user, conversationId, {body, clientRequestId})` → `{created, message}`. A repeated identifier/body/conversation returns the original message. Reusing that identifier for changed text or another thread returns `idempotency_conflict`, including after restart. The sender is always the authenticated context; extra recipient/sender/participant fields are rejected.
- `markRead(user, conversationId, {throughSequence})` → `{conversation}`. `throughSequence` is a canonical decimal **string**, including `"0"`, not a number. It must be within the actual thread history. Only that caller's cursor changes, and it cannot move backward.
- `block(user, {address, blocked?})` → `{address, blocked}`. Omitted `blocked` means true; false unblocks. Either participant's block prevents new sends and new open requests, preserving existing private history. The service does not announce who blocked whom to the other party.
- `report(user, {conversationId, messageId, reason, clientRequestId})` → `{created, report}`. The reporter must be a participant and the message must belong to that conversation. Reports are idempotent and stored locally as `status: stored_locally`; no report is sent externally and no monitored moderation queue is claimed.

Conversation summaries contain `{id, participants: [address, address], counterparty, createdAt, updatedAt, messageCount, lastSequence, readCursor, unreadCount, lastMessage, messagingAvailable, youBlocked}`. `lastSequence` and `readCursor` are decimal strings. `lastMessage` is null for an empty conversation. Otherwise it is the last actual message, never a synthetic welcome or activity record.

Messages contain `{id, conversationId, sequence, from, body, contentType: text/plain, createdAt, clientRequestId}`. **`from` is the sender field; there is no `sender` alias.** The sequence is a canonical decimal string. Unread counts derive from actual messages whose `from` differs from the reader and whose sequence exceeds that reader's cursor. Sending one's own message does not fabricate unread activity or acknowledge earlier incoming messages.

Proposed parent routes are `GET/POST /api/messages/conversations`, `GET /api/messages/conversations/:id`, `POST /:id/messages`, and `POST /:id/read`; routing is intentionally outside this module's change. Blocking, reporting and contacts can be wired separately with the same signed-operation protection.

## Bounds

Client request identifiers are 8–100 ASCII letters, digits, dashes or underscores. Message text is nonempty, at most 2,000 UTF-8 bytes, rejects unpaired surrogates and control characters other than tab/newline/carriage return, and retains its original plain text. Reports allow 1,000 UTF-8 bytes. Thread pages default to 50 and inbox/contact pages to 30; all pages cap at 100 rows.

Storage caps are 1,000 conversations globally, 100 per participant, 500 messages per conversation, 1,000 sent messages per member and 5,000 messages globally. Open-request idempotency records cap at 200/member and 5,000 globally. Blocks cap at 100/member and 5,000 globally; reports at 20/reporter and 1,000 globally. Capacity failures preserve history and read cursors; there is no silent deletion, background delivery, automatic membership expansion or arbitrary participant addition. Plan a deliberate storage/retention upgrade before these metadata limits are reached.

## Verification and release state

TDD evidence: `node --test apps/baink/test/messages.test.mjs` first failed because the module did not exist, then passed **8/8** tests after implementation. Tests exercise real generated Ed25519 identities, serialized JSON commits and restart recovery, private participant authorization, absence of global directory/profile leakage, concurrent creation/sending, same/cross-thread idempotency conflicts, monotonic reader-owned cursors, actual unread counts, pagination, literal HTML-looking text, the exact 2,000-byte UTF-8 boundary, block/unblock and locally retained reports. Separate seeded capacity fixtures prove per-thread, per-sender and global message caps without thousands of unnecessary filesystem writes.

After formatting and syntax verification, the combined `npm --prefix apps/baink test` run passed **116/116** tests across the concurrently integrated app modules. This module's changes are confined to `server/messages.mjs`, `test/messages.test.mjs` and this document; the parent task owns the HTTP integration and its additional tests.

No production messages, external notifications or native transactions were created during development. HTTP integration, UI text rendering/consent, deployment and public behavior must be validated separately by the parent task before claiming delivery.

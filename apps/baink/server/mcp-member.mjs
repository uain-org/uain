// The no-install member path on baink.money/mcp (11 November 2026, P0-2).
//
// Two listed tools:
//   baink_signer          returns the short signer (shared/uain_signer.py) the member's own AI
//                         runs in its code sandbox, with its SHA-256 and public address.
//   baink_member_request  a signed relay, not a new authority: it hands one request that the
//                         member's AI already signed to the SAME BAINK HTTP handling the kit
//                         uses (signature check, nonce store, per-key and per-IP budgets,
//                         eligibility checks and intent records all run unchanged). It allows
//                         only the earning path and refuses payments, sends, requests and Trade.
//
// The private key never reaches this server: anything that looks like one is refused
// without being echoed. No model is called and no process is started.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SIGNER_TEXT = readFileSync(new URL('../shared/uain_signer.py', import.meta.url), 'utf8');
export const SIGNER = Object.freeze({
  file: 'uain_signer.py',
  url: 'https://baink.money/uain_signer.py',
  checksumUrl: 'https://baink.money/uain_signer.py.sha256',
  sha256: createHash('sha256').update(SIGNER_TEXT).digest('hex'),
  bytes: Buffer.byteLength(SIGNER_TEXT),
  text: SIGNER_TEXT,
});
export const MEMBER_TOOL_NAMES = ['baink_signer', 'baink_member_request'];
/** tools/call may carry a full 16,384-byte evidence submission for the relay only. */
export const MEMBER_REQUEST_LIMIT = 65536;

const ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,95}';
const UUID = '[a-f0-9-]{36}';
const QUERY = '(?:\\?[A-Za-z0-9=&_.%-]{0,400})?';
/** The earning path only: [method, path pattern]. Everything else is refused. */
const ALLOWED = [
  ['GET', '/api/config'],
  ['GET', '/api/account'],
  ['POST', '/api/account'],
  ['GET', '/api/native/enrol'],
  ['POST', '/api/native/enrol/prepare'],
  ['POST', `/api/native/enrol/${UUID}/(?:submit|receipt)`],
  ['POST', '/api/native/central/prepare'],
  ['POST', `/api/native/central/intents/${UUID}/(?:submit|reconcile)`],
  ['GET', `/api/native/central/intents${QUERY}`],
  ['GET', '/api/native/central/status'],
  ['GET', `/api/native/central/tasks${QUERY}`],
  ['GET', `/api/native/central/tasks/${ID}`],
  ['GET', `/api/native/central/survey-template/${ID}`],
  ['GET', `/api/native/central/awards${QUERY}`],
  ['GET', `/api/native/central/submissions/${ID}${QUERY}`],
  ['GET', '/api/public/contribution/uain1[a-f0-9]{40}'],
].map(([method, pattern]) => [method, new RegExp(`^${pattern}$`)]);
const EARNING_OPERATIONS = ['project_join', 'central_submit', 'central_reassess'];
/**
 * The most steps one relay reply lists (12 November 2026). A member's steps list grows with
 * every submission and each step can carry up to 16,384 bytes of evidence, so the relay passes
 * on the newest RELAY_INTENT_LIMIT (BAINK lists newest first), plus every step still waiting
 * to be settled, so recovery never loses one. One step: GET /api/native/central/intents?id=<id>.
 */
export const RELAY_INTENT_LIMIT = 10;
const INTENTS_PATH = '/api/native/central/intents';
/** A step that may still need its reconcile or receipt call. */
const stepWaiting = (i) => i?.finalized !== true && !['finalized', 'expired', 'expired-unused'].includes(i?.status);

/** The relay's bounded copy of a steps list: newest first, at most the limit, waiting steps kept. */
export function boundIntentList(answer, query = new URLSearchParams()) {
  const all = Array.isArray(answer?.intents) ? answer.intents : [];
  const total = Number.isSafeInteger(answer?.total) ? answer.total : all.length;
  if (query.has('id')) return { answer: { intents: all.slice(0, 1), total }, shown: Math.min(all.length, 1), total, one: true };
  const asked = Number(query.get('limit'));
  const limit = Number.isSafeInteger(asked) && asked >= 1 ? Math.min(asked, RELAY_INTENT_LIMIT) : RELAY_INTENT_LIMIT;
  const newest = all.slice(0, limit);
  const waiting = all.slice(limit).filter(stepWaiting);
  const intents = [...newest, ...waiting];
  return {
    answer: { intents, total, shown: intents.length, limit, more: total > intents.length },
    shown: intents.length,
    total,
    one: false,
  };
}

export function memberPathAllowed(method, path, body) {
  if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) return false;
  if (path === '/api/native/central/prepare') return EARNING_OPERATIONS.includes(body?.operation);
  return true;
}

const ask = (what) => ({ do: what, tool: 'baink_guide', args: { question: 'how do I start without installing anything?' } });
const relay = (what, method, path, body) => ({
  do: what,
  sign: method === 'GET' ? `sign_request(key, "GET", "${path}")` : `sign_request(key, "${method}", "${path}", ${body ?? '{...}'})`,
  tool: 'baink_member_request',
  args: { '...': 'the dictionary sign_request returns' },
});

export const MEMBER_TOOLS = [
  {
    name: 'baink_signer',
    description:
      'Get the short signer your AI runs in its own code sandbox, so the person installs nothing: it makes the member key, signs each request for baink_member_request and checks every prepared step before signing it. It is Python with no packages and no network calls; check its SHA-256 before running it. It signs only enrol, project_join, central_submit and central_reassess, never a payment or a Trade step.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'baink_member_request',
    description:
      'Send one request your sandbox signed with the signer from baink_signer: create a profile, enrol, list tasks, join a project, submit work and read the review result, with nothing installed. Pass exactly what sign_request returned, and sign a fresh request for every call (each signature works once, for 5 minutes). Paying and Trade need the uain-agent kit, and a private key is never passed here.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST'] },
        path: { type: 'string', maxLength: 512, pattern: '^/api/' , description: 'For example /api/native/central/tasks?order=newest&state=open&limit=12&cursor=0' },
        body: { type: 'object', description: 'The JSON body for POST, exactly as signed.' },
        publicKey: { type: 'string', maxLength: 44, description: 'From sign_request.' },
        nonce: { type: 'string', maxLength: 128, description: 'From sign_request.' },
        timestamp: { type: 'string', maxLength: 13, description: 'From sign_request.' },
        signature: { type: 'string', maxLength: 88, description: 'From sign_request.' },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

const SECRET_NAME = /private|secret|seed|mnemonic|passphrase|password|jwk/i;
// A 43-character base64url run standing alone (a raw Ed25519 seed). Standard base64 values
// (public key, signature) and longer runs never match.
const KEYLIKE = /(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_+/=-])/g;
/** True when anything in the arguments looks like a private key (it is never echoed). */
function looksLikeKey(value, ownKey, depth = 0) {
  if (depth > 32) return true;
  if (typeof value === 'string') {
    if (/PRIVATE KEY|-----BEGIN/i.test(value)) return true;
    for (const m of value.matchAll(KEYLIKE)) if (m[0] !== ownKey) return true;
    return false;
  }
  if (Array.isArray(value)) return value.some((v) => looksLikeKey(v, ownKey, depth + 1));
  if (value && typeof value === 'object')
    return Object.entries(value).some(([k, v]) => SECRET_NAME.test(k) || looksLikeKey(k, ownKey, depth + 1) || looksLikeKey(v, ownKey, depth + 1));
  return false;
}
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SIGNED = ['publicKey', 'nonce', 'timestamp', 'signature'];

/** Plain answers for the refusals a member meets on this path; every one names the next call. */
const NEXT_BY_CODE = {
  invalid_signature: 'The signature was refused or is older than 5 minutes. Sign the same request again with sign_request (it makes a fresh nonce and time) and send it once more. Check the path and body are exactly what you signed.',
  replay_detected: 'This signature was already used. Sign the request again with sign_request and send the new one; nothing was done twice.',
  account_missing: 'This key has no BAINK profile yet. Create one first.',
  central_intent_pending: 'You already have a step waiting. Read it with GET /api/native/central/intents (newest first; a waiting step is always listed) and settle it with its reconcile call before preparing another.',
  enrol_intent_pending: 'Your enrolment was already prepared or sent. Read it with GET /api/native/enrol and check it with its receipt call; do not prepare a new one.',
  central_licence_inactive: 'Your membership is not active yet; it usually turns active within a few minutes of enrolling. Wait two minutes, then read GET /api/native/central/status again.',
  central_inactive: 'Earning is not active for this member yet. Wait two minutes and read GET /api/native/central/status again.',
  central_submission_exists: 'A submission with this id already exists: read it with GET /api/native/central/submissions/<id>; never send it again.',
  central_already_joined: 'You already joined this project. Go on to submit.',
  enrol_idempotency_conflict: 'This enrolment id was used with other names. Use enrol_request_id with the names you sent first, or read GET /api/native/enrol.',
  native_member_exists: 'This key is already a member. Skip enrolment and list tasks.',
  central_proof_unavailable: 'The network could not be read just now; nothing was signed or sent. Wait 30 seconds and prepare again.',
  native_proof_unavailable: 'The network could not be read just now; nothing was signed or sent. Wait 30 seconds and try again.',
  central_task_not_open: 'This task is no longer open. List open tasks and choose another.',
  central_project_join_required: 'Join the task\'s project first (central/prepare with operation project_join), then submit.',
};

function nextAfter(method, path, status, data) {
  const intent = data?.intent;
  if (path === '/api/account' && method === 'POST' || (path === '/api/account' && method === 'GET' && status === 200))
    return relay('Profile ready. If this key is not a member yet, enrol (names are public; the person\'s yes covers it), using enrol_request_id for clientRequestId. A member already enrolled lists open tasks instead.', 'POST', '/api/native/enrol/prepare', '{"clientRequestId": enrol_request_id(...), "name": "...", "operator": "...", "family": ""}');
  if (/\/prepare$/.test(path) && intent?.status === 'prepared') {
    const submit = path.includes('/enrol/') ? `/api/native/enrol/${intent.id}/submit` : `/api/native/central/intents/${intent.id}/submit`;
    return relay('Check and sign the prepared step with sign_prepared(key, intent, operation, payload, config), then send the envelope.', 'POST', submit, '{"envelope": <what sign_prepared returned>}');
  }
  if (/\/prepare$/.test(path) && intent?.id)
    return relay('This exact step was sent earlier: never sign it again. Check it.', 'POST', path.includes('/enrol/') ? `/api/native/enrol/${intent.id}/receipt` : `/api/native/central/intents/${intent.id}/reconcile`, '{}');
  if (/\/submit$/.test(path) && intent?.id)
    return relay('Sent. Check that the network recorded it (repeat until it reads finalized, about a minute apart).', 'POST', path.includes('/enrol/') ? `/api/native/enrol/${intent.id}/receipt` : `/api/native/central/intents/${intent.id}/reconcile`, '{}');
  if (/\/(reconcile|receipt)$/.test(path)) {
    if (intent?.status !== 'finalized') return relay('Not recorded yet. Check again in about a minute; never send the step again.', 'POST', path, '{}');
    if (path.includes('/enrol/')) return relay('Enrolled. Membership turns active within a few minutes; then list open tasks.', 'GET', '/api/native/central/status');
    // A recorded submission is followed by reading that submission's review (P0-2 copy gap, 12 November 2026).
    const submission = intent.command?.operation === 'central_submit' ? intent.command.payload?.id : ['central_reassess', 'central_evidence_expire'].includes(intent.command?.operation) ? intent.command.payload?.submission : null;
    if (typeof submission === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(submission))
      return relay('Recorded. Read this submission\'s review result (usually 2 to 10 minutes, up to an hour when many arrive together), then tell the person the outcome.', 'GET', `/api/native/central/submissions/${submission}`);
    return relay('Joined. Read what the task asks for, then submit.', 'GET', '/api/native/central/survey-template/<task id>');
  }
  if (path.startsWith('/api/native/central/tasks'))
    return relay('Read what a survey task asks for, research it, then join its project and submit.', 'GET', '/api/native/central/survey-template/<task id>');
  if (path.startsWith('/api/native/central/survey-template/'))
    return relay('Join the task\'s project once (after the person\'s yes), then submit. Use submission_id for the payload id.', 'POST', '/api/native/central/prepare', '{"operation": "project_join", "payload": {"project": "<project>"}}');
  if (path.startsWith('/api/native/central/submissions/')) {
    const outcome = data?.outcome;
    if (outcome === 'accepted')
      return relay('Accepted: it now counts in your contribution points (Karma). Tell the person the outcome and the points it added, then ask before taking another task (unless they asked for a number of tasks).', 'GET', '/api/native/central/tasks?order=newest&state=open&limit=12&cursor=0');
    if (outcome === 'under_review')
      return relay('Still waiting for the reviewer; nothing to do. Read this submission again in a few minutes. Start another task only if the person asked for more than one.', 'GET', '/api/native/central/tasks?order=newest&state=open&limit=12&cursor=0');
    return relay('Each submission shows its review outcome. Tell the person the outcome, then ask before taking another task (unless they asked for a number of tasks).', 'GET', '/api/native/central/tasks?order=newest&state=open&limit=12&cursor=0');
  }
  if (path === '/api/native/central/status' && status === 200)
    return relay('Your contribution points (Karma) and accepted work are in contribution. Take the next open task to add to them.', 'GET', '/api/native/central/tasks?order=newest&state=open&limit=12&cursor=0');
  if (path === INTENTS_PATH) {
    const list = data?.intents;
    if (data?.one === true)
      return list?.length
        ? relay('This is the one step you asked for. If it is not finalized, settle it with its reconcile call; never sign it again.', 'POST', `/api/native/central/intents/${list[0].id}/reconcile`, '{}')
        : relay(`No step of yours has that id. List your newest steps instead (at most ${RELAY_INTENT_LIMIT} at a time).`, 'GET', INTENTS_PATH);
    const cut = data?.more === true ? ` Showing the newest ${data.shown} of your ${data.total} steps (at most ${RELAY_INTENT_LIMIT}, plus any still waiting). For one older step, sign GET ${INTENTS_PATH}?id=<step id>.` : '';
    return relay(`Each sent step is listed here, newest first.${cut} Read a submission's review result with its id, or take the next open task.`, 'GET', '/api/native/central/submissions/<submission id>');
  }
  if (path.startsWith('/api/public/contribution/'))
    return relay('Take the next open task to add to your contribution points.', 'GET', '/api/native/central/tasks?order=newest&state=open&limit=12&cursor=0');
  return relay('List the open tasks you can take.', 'GET', '/api/native/central/tasks?order=newest&state=open&limit=12&cursor=0');
}

const fault = (code, message, next) => ({ data: { error: { code, message } }, isError: true, next });

/**
 * One member tool call. forward({method, path, body, headers}) runs the request through the
 * BAINK HTTP handler and resolves {status, body}.
 */
export async function memberCall(name, args, { forward }) {
  if (name === 'baink_signer') {
    if (!plain(args) || Object.keys(args).length) return fault('invalid_arguments', 'baink_signer takes no arguments.', ask('Ask the guide.'));
    return {
      data: {
        signer: SIGNER.file, language: 'python3', url: SIGNER.url, checksumUrl: SIGNER.checksumUrl, sha256: SIGNER.sha256, bytes: SIGNER.bytes,
        howToUse: [
          'Save the text below as uain_signer.py in your code sandbox, check that its SHA-256 equals sha256, and import it. It makes no network calls.',
          'First visit: me = new_key(). Show the person me["privateKey"] (43 characters) once and ask them to save it somewhere safe. Say plainly: this key is now visible in this chat, and anyone who has it can act as them. Never ask for a backup passphrase.',
          'Later visits: the person pastes their key back; use it only inside the sandbox. Never pass it to any tool.',
          'Each call: args = sign_request(key, method, path, body) and send args with baink_member_request. Sign again for every call.',
          'Each write: prepare it, then envelope = sign_prepared(key, intent, operation, payload, config) checks the step and signs it; send {"envelope": envelope} to the submit path the reply names.',
          'Use submission_id(address, task, draft) and enrol_request_id(address, name, operator) so a retry never makes a second step. For a survey, survey(...) and survey_evidence(...) build the exact evidence.',
          'Rather keep the key in a file on your own computer? The uain-agent kit does that: kit_identity_file(key) gives its identity file for the same member.',
        ],
        text: SIGNER.text,
      },
      isError: false,
      next: relay('Make the key in your sandbox, then create the public profile (after the person says yes).', 'POST', '/api/account', '{"displayName": "Research agent"}'),
    };
  }
  // The private-key guard runs first, on everything, so a key is never echoed or forwarded.
  const ownKey = plain(args) && typeof args.publicKey === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(args.publicKey) ? Buffer.from(args.publicKey, 'base64').toString('base64url') : null;
  if (looksLikeKey(args, ownKey))
    return fault('private_key_refused', 'Something in this request looks like a private key, so nothing was sent and it was not stored. Never pass the key to a tool: keep it in your sandbox and send only what sign_request returns. If the key was shared by mistake, the person should treat it as exposed.', relay('Sign the request in your sandbox and send only its result.', 'GET', '/api/account'));
  if (!plain(args) || Object.keys(args).some((k) => !['method', 'path', 'body', ...SIGNED].includes(k)) || !['GET', 'POST'].includes(args.method) || typeof args.path !== 'string' || args.path.length > 512 || /[\x00-\x20\x7f]/.test(args.path))
    return fault('invalid_arguments', 'Pass exactly what sign_request returned: method, path, body (POST only), publicKey, nonce, timestamp and signature. Nothing was sent.', ask('Ask the guide how to start without installing anything.'));
  const given = SIGNED.filter((k) => Object.hasOwn(args, k));
  if (
    (given.length !== 0 && given.length !== 4) ||
    (given.length === 4 && (!ownKey || !/^[A-Za-z0-9_-]{22,128}$/.test(args.nonce) || !/^\d{13}$/.test(args.timestamp) || !/^[A-Za-z0-9+/]{86}==$/.test(args.signature))) ||
    (args.method === 'GET' && Object.hasOwn(args, 'body')) ||
    (args.method === 'POST' && !plain(args.body))
  )
    return fault('invalid_arguments', 'The signed fields are missing or malformed. Pass exactly what sign_request returned. Nothing was sent.', relay('Sign the request again and send its result unchanged.', args.method, args.path.split('?')[0]));
  if (!memberPathAllowed(args.method, args.path, args.body))
    return fault(
      'not_on_this_path',
      'This request is not part of the earning path here, so nothing was sent. Without installing anything you can create a profile, enrol, list and read tasks, join, submit and read reviews. Paying, sending, payment requests and Trade need the uain-agent kit on the person\'s computer.',
      { do: 'Ask the guide which call does what you need.', tool: 'baink_guide', args: { question: 'do I need the kit to pay or trade?' } },
    );
  const headers = given.length
    ? { 'x-baink-public-key': args.publicKey, 'x-baink-nonce': args.nonce, 'x-baink-timestamp': args.timestamp, 'x-baink-signature': args.signature }
    : {};
  const reply = await forward({ method: args.method, path: args.path, body: args.method === 'POST' ? args.body : undefined, headers });
  const path = args.path.split('?')[0];
  let data = plain(reply.body) ? reply.body : {};
  if (reply.status >= 200 && reply.status < 300) {
    // The steps list is bounded on this path (RELAY_INTENT_LIMIT); nextStep says how to read more.
    if (args.method === 'GET' && path === INTENTS_PATH) {
      const bounded = boundIntentList(data, new URL(args.path, 'https://baink.money').searchParams);
      data = bounded.answer;
      return { data: { status: reply.status, answer: data }, isError: false, next: nextAfter(args.method, path, reply.status, { ...data, one: bounded.one }) };
    }
    return { data: { status: reply.status, answer: data }, isError: false, next: nextAfter(args.method, path, reply.status, data) };
  }
  const code = typeof data.error?.code === 'string' ? data.error.code : 'http_' + reply.status;
  const message = typeof data.error?.message === 'string' ? data.error.message : 'BAINK could not answer this request.';
  const plainNext = NEXT_BY_CODE[code] ?? (reply.status === 429 || reply.status === 503 ? 'BAINK is busy or this key reached its limit. Wait a minute, sign the request again and send it once more.' : null);
  const next = code === 'account_missing'
    ? relay(NEXT_BY_CODE.account_missing, 'POST', '/api/account', '{"displayName": "Research agent"}')
    : code === 'central_intent_pending'
      ? relay(plainNext, 'GET', '/api/native/central/intents')
      : code === 'enrol_intent_pending'
        ? relay(plainNext, 'GET', '/api/native/enrol')
        : plainNext
          ? relay(plainNext, args.method, path)
          : ask('Read the message; if it is unclear, ask the guide.');
  return { data: { status: reply.status, error: { code, message }, ...(reply.retryAfter ? { retryAfterSeconds: reply.retryAfter } : {}) }, isError: true, next };
}

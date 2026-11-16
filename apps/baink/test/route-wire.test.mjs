// Wire-level checks for the route-module extraction (P8): a sample of public,
// private and member routes keep their status codes, error shapes, auth
// phase and body bounds. These assertions were also run against the
// pre-extraction router, so they pin behaviour rather than describe the new
// layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, member, audience } from './http-fixture.mjs';
import { bodyLimitFor, createRequestContext, MAX_BODY } from '../server/routes/context.mjs';
import { ApiError, errorBody, shapeError } from '../server/http-errors.mjs';
import { createPublicRoutes } from '../server/routes/public.mjs';
import { createIdentityRoutes } from '../server/routes/identity.mjs';
import { createWorkRoutes } from '../server/routes/work.mjs';
import { createTradeRoutes } from '../server/routes/trade.mjs';
import { createWalletRoutes } from '../server/routes/wallet.mjs';
import { createManagementRoutes } from '../server/routes/management.mjs';

const NOT_FOUND = { error: { code: 'not_found', message: 'The requested API operation does not exist.' } };
const NO_SIGNATURE = { error: { code: 'invalid_signature', message: 'A valid member signature is required.' } };
const ACCOUNT_MISSING = { error: { code: 'account_missing', message: 'Create your BAINK profile to continue.' } };

function assertJsonHeaders(r) {
  assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-store');
}

test('public health, status and config keep their shape', async (t) => {
  const f = await fixture(t);
  const settlement = {
    available: false,
    code: 'settlement_requires_native_readiness',
    message: 'Check the current native account proof for asset and settlement readiness.',
  };
  for (const path of ['/api/health', '/api/status']) {
    const r = await f.request(null, 'GET', path);
    assert.equal(r.status, 200);
    assertJsonHeaders(r);
    assert.deepEqual(r.body, { ok: true, service: 'baink', storage: 'ready', settlement });
  }
  const config = await f.request(null, 'GET', '/api/config');
  assert.equal(config.status, 200);
  assertJsonHeaders(config);
  assert.deepEqual(Object.keys(config.body), [
    'auth', 'currency', 'asset', 'native', 'settlement', 'publicReview',
    'nativeProjectPilot', 'nativeEarning', 'centralEarning',
    'nativePayments', 'nativeRegistration', 'integrations', 'projectManagement',
    'proposalCatalogue', 'projectFunding', 'trade',
  ]);
  assert.deepEqual(config.body.auth, {
    audience, algorithm: 'Ed25519', scheme: 'signed-operations', maxAgeMs: 300000,
  });
  assert.deepEqual(config.body.publicReview, { configured: false, available: false, publicKey: null });
  assert.deepEqual(config.body.nativePayments, {
    intentsAvailable: true, serverSubmissionEnabled: false,
    holderSubmissionRequired: true, recipientConfirmationRequired: true,
  });
  assert.equal(config.body.native.verified, false);
  assert.equal(config.body.native.balanceUnits, null);
  // The public-review health route answers without a configured checker.
  const review = await f.request(null, 'GET', '/api/native/review/health');
  assert.equal(review.status, 200);
  assert.deepEqual(review.body, { configured: false, available: false, publicKey: null });
});

test('the published survey template is public and an unknown one is a typed 404', async (t) => {
  const f = await fixture(t);
  const file = JSON.parse(await readFile(new URL('../server/survey-templates.json', import.meta.url), 'utf8'));
  const taskId = 'T-OPP-00002-1-prior-art-survey';
  const r = await f.request(null, 'GET', `/api/native/central/survey-template/${taskId}`);
  assert.equal(r.status, 200);
  assertJsonHeaders(r);
  assert.deepEqual(r.body, { taskId, ...file.templates[taskId] });
  assert.equal(r.body.project, 'P-OPP-00002');
  const missing = await f.request(null, 'GET', '/api/native/central/survey-template/T-OPP-99999-1-prior-art-survey');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, {
    error: { code: 'survey_template_missing', message: 'This task has no published survey template.' },
  });
  // A survey part with no static row, on a server without native, has nothing to derive from.
  const part = await f.request(null, 'GET', '/api/native/central/survey-template/T-OPP-99999-1-prior-art-survey-r2-p1');
  assert.equal(part.status, 404);
  assert.deepEqual(part.body, missing.body);
  // A path outside the template pattern is not a template route at all.
  const other = await f.request(null, 'GET', '/api/native/central/survey-template/anything');
  assert.equal(other.status, 404);
  assert.deepEqual(other.body, NOT_FOUND);
});

test('unknown routes and unsupported methods are the same 404 before any signature check', async (t) => {
  const f = await fixture(t);
  for (const [method, path] of [
    ['GET', '/api/nope'],
    ['POST', '/api/config'],
    ['DELETE', '/api/account'],
    ['POST', '/api/operations/organizations'],
    ['PUT', '/api/trade/offers'],
    ['GET', '/api/native/payments/prepare'],
  ]) {
    const r = await f.request(null, method, path);
    assert.equal(r.status, 404, `${method} ${path}`);
    assertJsonHeaders(r);
    assert.deepEqual(r.body, NOT_FOUND, `${method} ${path}`);
  }
});

test('every route group refuses an unsigned private operation with 401', async (t) => {
  const f = await fixture(t);
  for (const [method, path] of [
    ['GET', '/api/account'], // identity
    ['GET', '/api/messages/conversations'], // identity
    ['GET', '/api/work/current'], // work
    ['GET', '/api/native/central/status'], // work
    ['GET', '/api/trade/enquiries'], // trade
    ['GET', '/api/history'], // trade
    ['GET', '/api/native/payments'], // wallet
    ['GET', '/api/native/enrol'], // wallet
    ['GET', '/api/operations/organizations'], // management
    ['GET', '/api/meetings'], // management
  ]) {
    const r = await f.request(null, method, path);
    assert.equal(r.status, 401, `${method} ${path}`);
    assertJsonHeaders(r);
    assert.deepEqual(r.body, NO_SIGNATURE, `${method} ${path}`);
  }
});

test('a signed identity without a profile reaches only profile creation', async (t) => {
  const f = await fixture(t);
  const who = member();
  for (const [method, path] of [
    ['GET', '/api/account'],
    ['GET', '/api/native/payments'],
    ['GET', '/api/history'],
    ['GET', '/api/work/current'],
  ]) {
    const r = await f.request(who, method, path);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(r.body, ACCOUNT_MISSING, `${method} ${path}`);
  }
  const created = await f.request(who, 'POST', '/api/account', { displayName: 'Wire' });
  assert.equal(created.status, 201);
  assert.equal(created.body.account.address, who.address);
  assert.equal(created.body.account.currency, 'AI$');
  // Member-phase routes now answer with their usual shapes.
  const history = await f.request(who, 'GET', '/api/history');
  assert.equal(history.status, 200);
  assert.deepEqual(history.body, {
    history: [], count: 0,
    notice: 'Payment-request activity only; no transfers have settled.',
  });
  const enrol = await f.request(who, 'GET', '/api/native/enrol');
  assert.equal(enrol.status, 200);
  const metadata = await f.request(who, 'GET', '/api/account/metadata');
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.account.balance, null);
  assert.equal(metadata.body.nativeStatus, 'not-requested');
  // A repeated POST is idempotent and still 200.
  const again = await f.request(who, 'POST', '/api/account', { displayName: 'Wire' });
  assert.equal(again.status, 200);
});

test('body bounds follow the route and are checked before the signature', async (t) => {
  const f = await fixture(t);
  const big = { pad: 'x'.repeat(20_000) };
  const ordinary = await f.request(null, 'POST', '/api/requests', big);
  assert.equal(ordinary.status, 413);
  assert.deepEqual(ordinary.body, { error: { code: 'body_too_large', message: 'The request body is too large.' } });
  // The checker route accepts larger signed artifacts, so the same body gets
  // past the bound and stops at the signature check instead.
  const review = await f.request(null, 'POST', '/api/native/review', big);
  assert.equal(review.status, 401);
  assert.deepEqual(review.body, NO_SIGNATURE);
  const crossOrigin = await f.request(null, 'GET', '/api/config', {}, { Origin: 'https://elsewhere.example' });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(crossOrigin.body, { error: { code: 'origin_forbidden', message: 'This origin is not allowed.' } });
});

test('route groups claim disjoint private operations', () => {
  // Group order in app.mjs must never decide which handler answers. Build
  // each group with inert dependencies and check that exactly one claims
  // every private operation and none claims a public one.
  const inert = new Proxy({}, { get: () => undefined });
  const groups = [
    createPublicRoutes(inert), createIdentityRoutes(inert), createWorkRoutes(inert),
    createTradeRoutes(inert), createWalletRoutes(inert), createManagementRoutes(inert),
  ];
  const id = '00000000-0000-0000-0000-000000000000';
  const hex32 = 'a'.repeat(32);
  const addr = 'uain1' + 'b'.repeat(40);
  const privateOps = [
    ['GET', '/api/account'], ['POST', '/api/account'], ['PATCH', '/api/account'],
    ['GET', '/api/account/metadata'], ['GET', '/api/profile'], ['PATCH', '/api/profile'],
    ['GET', '/api/profile/endorsements'], ['POST', `/api/profiles/${addr}/endorsements`],
    ['POST', `/api/profile/endorsements/${id}/withdraw`],
    ['GET', '/api/messages/conversations'], ['POST', '/api/messages/conversations'],
    ['GET', '/api/messages/contacts'], ['POST', '/api/messages/blocks'], ['POST', '/api/messages/reports'],
    ['GET', `/api/messages/conversations/${id}`], ['POST', `/api/messages/conversations/${id}/messages`],
    ['POST', `/api/messages/conversations/${id}/read`],
    ['GET', '/api/work/current'], ['GET', '/api/work/claim'], ['GET', '/api/work/selections'],
    ['POST', '/api/work/selections'], ['POST', `/api/work/selections/${id}/withdraw`],
    ['GET', '/api/native/project-pilot'], ['POST', '/api/native/project-pilot/prepare'],
    ['POST', '/api/native/project-pilot/snapshot'], ['POST', `/api/native/project-pilot/${id}/submit`],
    ['GET', '/api/native/central/status'], ['GET', '/api/native/central/awards'], ['GET', '/api/native/central/tasks'],
    ['GET', '/api/native/central/tasks/T-OPP-00002-1-prior-art-survey'], ['GET', '/api/native/central/intents'],
    ['POST', '/api/native/central/prepare'], ['POST', `/api/native/central/intents/${id}/submit`],
    ['GET', '/api/native/earning/materials'], ['GET', '/api/native/earning/materials/pack-1'],
    ['POST', '/api/native/review'], ['GET', `/api/native/review/${hex32}`],
    ['GET', `/api/native/review/${hex32}/artifact/certificate`], ['POST', `/api/native/review/${hex32}/recover`],
    ['POST', '/api/trade/offers'], ['PATCH', `/api/trade/offers/${id}`], ['POST', `/api/trade/offers/${id}/withdraw`],
    ['POST', `/api/trade/offers/${id}/enquiries`], ['GET', '/api/trade/enquiries'],
    ['GET', `/api/trade/enquiries/${id}/terms`], ['POST', `/api/trade/enquiries/${id}/terms`],
    ['GET', `/api/trade/terms/${id}`], ['PATCH', `/api/trade/terms/${id}`], ['POST', `/api/trade/terms/${id}/send`],
    ['POST', `/api/trade/terms/${id}/payment-request`],
    ['GET', '/api/requests'], ['POST', '/api/requests'], ['POST', `/api/requests/${id}/pay`],
    ['POST', `/api/requests/${id}/cancel`], ['POST', '/api/transfers'], ['GET', '/api/history'],
    ['GET', '/api/native/earning'], ['POST', '/api/native/earning/prepare'], ['POST', `/api/native/earning/${id}/submit`],
    ['GET', '/api/native/payments'], ['POST', '/api/native/payments/prepare'], ['GET', `/api/native/payments/${id}`],
    ['POST', `/api/native/payments/${id}/agree`], ['GET', '/api/native/instances'],
    ['POST', '/api/native/instances/prepare'], ['POST', `/api/native/instances/${id}/submit`],
    ['GET', '/api/native/enrol'], ['POST', '/api/native/enrol/prepare'], ['POST', `/api/native/enrol/${id}/receipt`],
    ['GET', '/api/operations/organizations'], ['GET', '/api/projects/p-1/operations'],
    ['GET', '/api/management/projects/OPP-00001/chat'], ['POST', '/api/management/projects/OPP-00001/evidence'],
    ['GET', '/api/meetings'],
  ];
  const ctxFor = (method, path) => ({ method, path });
  for (const [method, path] of privateOps) {
    const claims = groups.filter((g) => g.isPrivate?.(ctxFor(method, path))).map((g) => g.name);
    assert.equal(claims.length, 1, `${method} ${path}: ${claims.join(',') || 'none'}`);
  }
  for (const [method, path] of [
    ['GET', '/api/health'], ['GET', '/api/config'], ['GET', '/api/proposals'], ['GET', '/api/projects'],
    ['GET', '/api/trade/offers'], ['GET', `/api/trade/offers/${id}`], ['GET', '/api/profiles'],
    ['GET', `/api/members/${addr}`], ['GET', '/api/management/projects/OPP-00001'],
    ['GET', '/api/native/asset'], ['GET', '/api/native/review/health'], ['GET', '/api/work/projects'],
    ['GET', '/api/nope'], ['POST', '/api/config'],
  ]) {
    const claims = groups.filter((g) => g.isPrivate?.(ctxFor(method, path))).map((g) => g.name);
    assert.deepEqual(claims, [], `${method} ${path}`);
  }
});

test('shared body bounds, query parsing and error shaping', () => {
  assert.equal(bodyLimitFor('POST', '/api/native/review'), 131072);
  assert.equal(bodyLimitFor('POST', '/api/native/review-worker/claim'), 131072);
  assert.equal(bodyLimitFor('GET', '/api/native/review'), MAX_BODY);
  assert.equal(bodyLimitFor('POST', '/api/native/payments/00000000-0000-0000-0000-000000000000/submit'), 32768);
  assert.equal(bodyLimitFor('POST', '/api/native/payments/00000000-0000-0000-0000-000000000000/agree'), MAX_BODY);
  assert.equal(bodyLimitFor('POST', '/api/account'), 16_384);

  const res = { setTimeout(ms) { this.timeout = ms; } };
  const ctx = createRequestContext({
    req: { method: 'GET' }, res,
    url: new URL('https://baink.example/api/trade/offers?page=2&search=x'),
    body: {}, requestAudience: audience,
  });
  assert.equal(ctx.path, '/api/trade/offers');
  assert.equal(ctx.user, null);
  assert.deepEqual({ ...ctx.query() }, { page: 2, search: 'x' });
  const before = ctx.deadline;
  ctx.extendDeadline(28_000);
  assert.equal(res.timeout, 28_000);
  assert.ok(ctx.deadline >= before);
  const dup = createRequestContext({
    req: { method: 'GET' }, res,
    url: new URL('https://baink.example/api/x?a=1&a=2'), body: {}, requestAudience: audience,
  });
  assert.throws(() => dup.query(), (e) => e instanceof ApiError && e.status === 400 && e.code === 'invalid_query');

  class DomainError extends Error { constructor() { super('Domain refused.'); this.status = 409; this.code = 'domain_refused'; } }
  assert.deepEqual(shapeError(new DomainError(), [ApiError, DomainError]), {
    known: true, status: 409, body: errorBody('domain_refused', 'Domain refused.'),
  });
  assert.deepEqual(shapeError(new Error('secret detail'), [ApiError]), {
    known: false, status: 500,
    body: { error: { code: 'internal_error', message: 'The operation could not be completed.' } },
  });
});

// OPP10 was prospectively corrected before its first native opening; the public
// composer must use that exact contract, not the older bundled draft.
test('OPP10 public survey template matches the qualified native contract', async (t) => {
  const f = await fixture(t);
  const { surveyTemplates } = await import('../../../services/project-organizations/ops/survey-templates.mjs');
  const taskId = 'T-OPP-00010-1-prior-art-survey';
  const expected = (await surveyTemplates()).templates[taskId];
  assert.equal(expected.criteriaDigest, '8d4c68d002ab5f842281e1f5b3b9c00ee612fd43c56a71c3c0ca27e98447d478');
  assert.equal(expected.required.length, 11);
  assert.ok(expected.required.every(r => r.title && r.title !== 'untitled'));
  const reply = await f.request(null, 'GET', `/api/native/central/survey-template/${taskId}`);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { taskId, ...expected });
});

import { createHash, randomUUID } from 'node:crypto';

const ADDRESS = /^uain1[a-f0-9]{40}$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SOURCE_PROJECT = {
  proposals: /^(OPP|PRB)-[0-9]{5}$/,
  projects: /^[a-z0-9][a-z0-9-]{0,159}$/,
};
const INTENT = /^[A-Za-z0-9_-]{8,100}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FORBIDDEN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const MAX_ALL = 1000,
  MAX_OWNER = 200,
  MAX_SELECTED = 100,
  MAX_RESPONSE = 512 * 1024;
export class WorkSelectionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'WorkSelectionError';
    this.status = status;
    this.code = code;
  }
}
const refuse = (status, code, message) => {
  throw new WorkSelectionError(status, code, message);
};
const check = (condition, status, code, message) => {
  if (!condition) refuse(status, code, message);
};
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === 'string' &&
        'value' in Object.getOwnPropertyDescriptor(value, key),
    )
  );
}
function only(value, fields, code = 'invalid_body') {
  check(
    record(value) && Object.keys(value).every((key) => fields.includes(key)),
    400,
    code,
    'This request contains unsupported fields or is not a plain object.',
  );
}
function sourceError() {
  refuse(
    503,
    'source_unavailable',
    'The current research source is unavailable or could not be validated.',
  );
}
function sourceText(value, max, { nullable = false, nonempty = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > max ||
    FORBIDDEN.test(value) ||
    (nonempty && !value.trim())
  )
    sourceError();
  return value;
}
function sourceUrl(value) {
  if (value === null || value === undefined) return null;
  sourceText(value, 2048);
  let url;
  try {
    url = new URL(value);
  } catch {
    sourceError();
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  )
    sourceError();
  const seen = new Set();
  for (const [key, item] of url.searchParams) {
    if (
      !['project', 'tab'].includes(key) ||
      seen.has(key) ||
      !PROJECT.test(item)
    )
      sourceError();
    seen.add(key);
  }
  if (Buffer.byteLength(url.href) > 2048) sourceError();
  return url.href;
}
/** Fixed project-level projection only. Volatile fetchedAt and all unrelated
 * properties are deliberately omitted. This digest is a review binding, not a
 * native proof, execution claim, reservation, reward or monetary commitment. */
function normalizedSource(value) {
  if (
    !record(value) ||
    typeof value.kind !== 'string' ||
    !Object.hasOwn(SOURCE_PROJECT, value.kind) ||
    typeof value.projectId !== 'string' ||
    !SOURCE_PROJECT[value.kind].test(value.projectId) ||
    value.sourceAvailable !== true
  )
    sourceError();
  const taskCount = value.taskCount ?? null;
  if (taskCount !== null && (!Number.isSafeInteger(taskCount) || taskCount < 0))
    sourceError();
  return {
    kind: value.kind,
    projectId: value.projectId,
    title: sourceText(value.title, 1000, { nonempty: true }),
    description: sourceText(value.description, 5000),
    category: sourceText(value.category, 200),
    status: sourceText(value.status, 80),
    sourceRevision: sourceText(value.sourceRevision, 200, { nullable: true }),
    sourceAuthority: sourceText(value.sourceAuthority, 200, { nullable: true }),
    sourceUrl: sourceUrl(value.sourceUrl),
    sourceAvailable: true,
    taskCount,
  };
}
export function selectionDigest(source) {
  const snapshot = normalizedSource(source),
    canonical =
      '{' +
      Object.keys(snapshot)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + JSON.stringify(snapshot[key]))
        .join(',') +
      '}';
  return createHash('sha256').update(canonical).digest('hex');
}
function actor(state, user) {
  check(
    record(user) &&
      typeof user.address === 'string' &&
      ADDRESS.test(user.address) &&
      typeof user.publicKey === 'string',
    401,
    'authentication_required',
    'A signed BAINK identity is required.',
  );
  check(
    user.publicKey.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(user.publicKey),
    401,
    'invalid_identity',
    'The public key must be canonical Ed25519 base64.',
  );
  const key = Buffer.from(user.publicKey, 'base64');
  check(
    key.length === 32 &&
      key.toString('base64') === user.publicKey &&
      'uain1' + createHash('sha256').update(key).digest('hex').slice(0, 40) ===
        user.address,
    401,
    'invalid_identity',
    'The public key must match this identity address.',
  );
  check(
    record(state) &&
      record(state.accounts) &&
      Object.hasOwn(state.accounts, user.address),
    404,
    'account_missing',
    'Create your local BAINK profile first.',
  );
  check(
    state.accounts[user.address].publicKey === user.publicKey,
    401,
    'invalid_identity',
    'The local account public key does not match.',
  );
  return { address: user.address, publicKey: user.publicKey };
}
function dataOf(state, { initialize = false } = {}) {
  if (state.workSelections === undefined) {
    if (!initialize) return { version: 1, selections: {} };
    state.workSelections = { version: 1, selections: {} };
  }
  const value = state.workSelections;
  check(
    record(value) && value.version === 1 && record(value.selections),
    503,
    'selection_storage_invalid',
    'Private research selection storage is unavailable.',
  );
  return value;
}
function owned(data, id, user) {
  check(
    typeof id === 'string' && UUID.test(id),
    400,
    'invalid_identifier',
    'A valid research selection identifier is required.',
  );
  const value = Object.hasOwn(data.selections, id) ? data.selections[id] : null;
  check(
    value &&
      value.owner === user.address &&
      value.ownerPublicKey === user.publicKey,
    404,
    'selection_missing',
    'Private research selection not found.',
  );
  return value;
}
function publicSelection(value) {
  return {
    id: value.id,
    owner: value.owner,
    kind: value.kind,
    projectId: value.projectId,
    sourceDigest: value.sourceDigest,
    source: structuredClone(value.source),
    availability: value.availability,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    withdrawnAt: value.withdrawnAt,
    claim: false,
    settlementAvailable: false,
  };
}
function bounded(value) {
  check(
    Buffer.byteLength(JSON.stringify(value)) <= MAX_RESPONSE,
    503,
    'selection_response_limit',
    'This private selection response exceeds its size bound.',
  );
  return value;
}
function page(value, fallback, max) {
  if (value === undefined) return fallback;
  check(
    ((typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^[1-9][0-9]{0,5}$/.test(value))) &&
      Number(value) >= 1 &&
      Number(value) <= max,
    400,
    'invalid_query',
    'Pagination requires bounded positive whole numbers.',
  );
  return Number(value);
}
function intentOf(body) {
  only(body, ['clientRequestId', 'kind', 'projectId', 'sourceDigest']);
  check(
    typeof body.clientRequestId === 'string' &&
      INTENT.test(body.clientRequestId),
    400,
    'invalid_request_id',
    'Use an intent identifier of 8–100 letters, digits, dashes or underscores.',
  );
  check(
    typeof body.kind === 'string' &&
      Object.hasOwn(SOURCE_PROJECT, body.kind) &&
      typeof body.projectId === 'string' &&
      SOURCE_PROJECT[body.kind].test(body.projectId),
    400,
    'invalid_selection',
    'Choose a valid research source.',
  );
  check(
    typeof body.sourceDigest === 'string' && DIGEST.test(body.sourceDigest),
    400,
    'invalid_source_digest',
    'Review the current research source before saving this choice.',
  );
  return {
    clientRequestId: body.clientRequestId,
    kind: body.kind,
    projectId: body.projectId,
    sourceDigest: body.sourceDigest,
  };
}
function priorIntent(data, user, intent) {
  const prior = Object.values(data.selections).find(
    (value) =>
      value.owner === user.address &&
      value.clientRequestId === intent.clientRequestId,
  );
  if (prior)
    check(
      prior.ownerPublicKey === user.publicKey &&
        prior.kind === intent.kind &&
        prior.projectId === intent.projectId &&
        prior.sourceDigest === intent.sourceDigest,
      409,
      'idempotency_conflict',
      'This intent identifier already refers to a different research selection.',
    );
  return prior;
}
function noActiveDuplicate(data, user, intent) {
  check(
    !Object.values(data.selections).some(
      (value) =>
        value.owner === user.address &&
        value.kind === intent.kind &&
        value.projectId === intent.projectId &&
        value.availability === 'selected',
    ),
    409,
    'selection_exists',
    'This research source is already selected. Withdraw that choice before explicitly saving another intent.',
  );
}

export function createWorkSelections({
  store,
  resolveSource,
  now = () => Date.now(),
  sourceTimeoutMs = 8000,
}) {
  check(
    store &&
      typeof store.read === 'function' &&
      typeof store.transact === 'function' &&
      typeof resolveSource === 'function' &&
      typeof now === 'function',
    500,
    'selection_service_invalid',
    'A transactional store and research source resolver are required.',
  );
  check(
    Number.isInteger(sourceTimeoutMs) &&
      sourceTimeoutMs >= 10 &&
      sourceTimeoutMs <= 8000,
    500,
    'selection_service_invalid',
    'A bounded research source timeout is required.',
  );
  const pending = new Map();
  let activeReads = 0;
  async function current(kind, id) {
    const key = kind + ':' + id;
    if (pending.has(key))
      return structuredClone(await pending.get(key).response);
    check(
      activeReads < 4,
      503,
      'source_unavailable',
      'The research source is busy. Retry shortly.',
    );
    activeReads++;
    const abort = new AbortController(),
      entry = { response: null };
    let timer;
    const upstream = Promise.resolve()
      .then(() => resolveSource(kind, id, { signal: abort.signal }))
      .then((raw) => {
        if (raw === null) return null;
        const source = normalizedSource(raw);
        if (source.kind !== kind || source.projectId !== id) sourceError();
        return source;
      })
      .catch(() => sourceError());
    entry.response = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(
          new WorkSelectionError(
            503,
            'source_unavailable',
            'The research source did not complete within its deadline.',
          ),
        );
      }, sourceTimeoutMs);
      // A response timeout is not proof that the upstream job stopped. Keep
      // its slot and the rejected response until that actual job settles.
      upstream.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        activeReads--;
        if (pending.get(key) === entry) pending.delete(key);
      });
    });
    pending.set(key, entry);
    return structuredClone(await entry.response);
  }
  const snapshot = (user) => {
    const state = store.read(),
      bound = actor(state, user);
    return { user: bound, data: dataOf(state) };
  };
  return Object.freeze({
    async review(kind, projectId) {
      check(
        typeof kind === 'string' &&
          Object.hasOwn(SOURCE_PROJECT, kind) &&
          typeof projectId === 'string' &&
          SOURCE_PROJECT[kind].test(projectId),
        400,
        'invalid_selection',
        'Choose a valid research source.',
      );
      const source = await current(kind, projectId);
      check(
        source !== null,
        404,
        'source_missing',
        'This research source does not exist.',
      );
      return { source, sourceDigest: selectionDigest(source) };
    },
    async select(user, body) {
      const intent = intentOf(body),
        initial = snapshot(user),
        prior = priorIntent(initial.data, initial.user, intent);
      if (prior) return { created: false, selection: publicSelection(prior) };
      noActiveDuplicate(initial.data, initial.user, intent);
      // The source is read outside the store mutex. Its accepted snapshot is
      // immutable evidence of the review, not a pin on future source changes.
      const source = await current(intent.kind, intent.projectId);
      check(
        source !== null,
        404,
        'source_missing',
        'The reviewed research source no longer exists.',
      );
      check(
        selectionDigest(source) === intent.sourceDigest,
        409,
        'source_stale',
        'The research source changed. Review the current source before saving a new intent.',
      );
      const result = await store.transact((state) => {
        const bound = actor(state, user),
          data = dataOf(state, { initialize: true }),
          again = priorIntent(data, bound, intent);
        if (again) return { created: false, selection: publicSelection(again) };
        noActiveDuplicate(data, bound, intent);
        const mine = Object.values(data.selections).filter(
          (value) => value.owner === bound.address,
        );
        check(
          mine.filter((value) => value.availability === 'selected').length <
            MAX_SELECTED,
          429,
          'selection_capacity',
          'Private research selection capacity reached.',
        );
        // Withdrawn choices no longer count (13 November 2026, B1-5): the
        // owner's oldest withdrawn ones make room in the owner's own budget,
        // and a full network prunes withdrawn choices first. A choice that is
        // still selected is never removed; when only those remain the new
        // choice is refused.
        const forget = (rows) => {
          const oldest = rows.sort(
            (a, b) =>
              (a.withdrawnAt ?? a.updatedAt).localeCompare(b.withdrawnAt ?? b.updatedAt) ||
              a.id.localeCompare(b.id),
          )[0];
          delete data.selections[oldest.id];
        };
        for (let count = mine.length; count >= MAX_OWNER; count--)
          forget(
            Object.values(data.selections).filter(
              (v) => v.owner === bound.address && v.availability === 'withdrawn',
            ),
          );
        for (let count = Object.keys(data.selections).length; count >= MAX_ALL; count--) {
          const all = Object.values(data.selections),
            withdrawn = all.filter((v) => v.availability === 'withdrawn');
          check(
            withdrawn.length > 0,
            429,
            'selection_capacity',
            'Private research selection capacity reached.',
          );
          forget(withdrawn);
        }
        const at = new Date(now()).toISOString(),
          value = {
            id: randomUUID(),
            owner: bound.address,
            ownerPublicKey: bound.publicKey,
            ...intent,
            source: structuredClone(source),
            availability: 'selected',
            createdAt: at,
            updatedAt: at,
            withdrawnAt: null,
          };
        data.selections[value.id] = value;
        return { created: true, selection: publicSelection(value) };
      });
      return bounded(result);
    },
    list(user, query = {}) {
      only(query, ['page', 'pageSize', 'availability'], 'invalid_query');
      const availability = query.availability ?? 'selected';
      check(
        ['selected', 'withdrawn', 'all'].includes(availability),
        400,
        'invalid_query',
        'Choose selected, withdrawn or all private choices.',
      );
      const selectedPage = page(query.page, 1, 10000),
        pageSize = page(query.pageSize, 20, 25),
        initial = snapshot(user);
      const selections = Object.values(initial.data.selections)
        .filter(
          (value) =>
            value.owner === initial.user.address &&
            value.ownerPublicKey === initial.user.publicKey &&
            (availability === 'all' || value.availability === availability),
        )
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        );
      return bounded({
        selections: selections
          .slice((selectedPage - 1) * pageSize, selectedPage * pageSize)
          .map(publicSelection),
        count: selections.length,
        page: selectedPage,
        pageSize,
        pages: Math.max(1, Math.ceil(selections.length / pageSize)),
      });
    },
    async withdraw(user, id, body = {}) {
      only(body, []);
      return store.transact((state) => {
        const bound = actor(state, user),
          data = dataOf(state, { initialize: true }),
          value = owned(data, id, bound);
        if (value.availability === 'withdrawn')
          return { changed: false, selection: publicSelection(value) };
        check(
          value.availability === 'selected',
          503,
          'selection_storage_invalid',
          'The private selection state is invalid.',
        );
        const at = new Date(now()).toISOString();
        value.availability = 'withdrawn';
        value.withdrawnAt = at;
        value.updatedAt = at;
        return { changed: true, selection: publicSelection(value) };
      });
    },
    async inspect(user, id) {
      const initial = snapshot(user),
        value = owned(initial.data, id, initial.user),
        selection = publicSelection(value);
      try {
        const source = await current(value.kind, value.projectId);
        if (source === null)
          return {
            selection,
            current: {
              status: 'missing',
              source: null,
              sourceDigest: null,
              changed: null,
            },
          };
        const digest = selectionDigest(source);
        return bounded({
          selection,
          current: {
            status: 'available',
            source,
            sourceDigest: digest,
            changed: digest !== value.sourceDigest,
          },
        });
      } catch {
        return {
          selection,
          current: {
            status: 'unavailable',
            source: null,
            sourceDigest: null,
            changed: null,
          },
        };
      }
    },
  });
}

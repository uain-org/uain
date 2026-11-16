/** Opt-in peer upvotes for one exact published profile revision. HTTP signature
 * verification remains the caller's responsibility. This module grants no
 * native reputation, licence, independent trust, financial or research authority.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createMemberProfiles, ProfileError } from './profiles.mjs';
const ADDRESS = /^uain1[a-f0-9]{40}$/;
const ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const INTENT = /^[A-Za-z0-9_-]{8,100}$/;
const plain = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(
    (key) =>
      typeof key === 'string' &&
      'value' in Object.getOwnPropertyDescriptor(value, key),
  );
const fields = (value, allowed, required = allowed) =>
  plain(value) &&
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(value, key));
export class ProfileEndorsementError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ProfileEndorsementError';
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => {
  throw new ProfileEndorsementError(status, code, message);
};
const input = () =>
  fail(
    400,
    'invalid_endorsement',
    'Use only the documented upvote fields and exact profile revision.',
  );
const corrupt = () =>
  fail(
    503,
    'endorsement_store_invalid',
    'Peer endorsements are temporarily unavailable.',
  );
const integer = (value) => Number.isSafeInteger(value) && value >= 1;
const iso = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
function targetAddress(value) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) input();
  return value;
}
const PROVENANCE = {
  kind: 'holder-published-peer-upvotes',
  independentlyVerified: false,
  affectsNativeKarma: false,
  establishesTrust: false,
  affectsMoney: false,
  countScope: 'current-published-profile-version-distinct-author-addresses',
  notice:
    'Opt-in assertions by local key holders only. Counts do not establish unique independent systems, verified work, licence, trust, Karma or money.',
};
const projection = (row) => ({
  id: row.id,
  author: row.author,
  target: row.target,
  profileVersion: row.profileVersion,
  createdAt: row.createdAt,
});
function receipt(row, profile) {
  const active =
    row.revokedAt === null && profile?.version === row.profileVersion;
  return {
    ...projection(row),
    revokedAt: row.revokedAt,
    active,
    visibility:
      row.revokedAt !== null
        ? 'revoked'
        : active
          ? 'current-published-profile-version'
          : 'not-current-published-profile',
  };
}
export function createProfileEndorsements({
  store,
  now = () => Date.now(),
  maxRecords = 10000,
  maxPerAuthor = 500,
  maxActivePerTarget = 500,
  maxWritesPerMinute = 30,
} = {}) {
  if (
    !store ||
    typeof store.read !== 'function' ||
    typeof store.transact !== 'function' ||
    typeof now !== 'function' ||
    !integer(maxRecords) ||
    maxRecords > 10000 ||
    !integer(maxPerAuthor) ||
    maxPerAuthor > 1000 ||
    !integer(maxActivePerTarget) ||
    maxActivePerTarget > 1000 ||
    !integer(maxWritesPerMinute) ||
    maxWritesPerMinute > 60
  )
    throw TypeError(
      'A durable store, clock and bounded endorsement limits are required.',
    );
  function stamp() {
    const value = now();
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 8640000000000000 - 60000
    )
      fail(
        503,
        'endorsement_clock_invalid',
        'The endorsement timestamp is unavailable.',
      );
    return value;
  }
  function actor(state, user) {
    if (
      !plain(user) ||
      typeof user.address !== 'string' ||
      !ADDRESS.test(user.address) ||
      typeof user.publicKey !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(user.publicKey)
    )
      fail(
        401,
        'endorsement_identity_required',
        'A signed local key-holder identity is required.',
      );
    const raw = Buffer.from(user.publicKey, 'base64');
    if (
      raw.length !== 32 ||
      raw.toString('base64') !== user.publicKey ||
      'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40) !==
        user.address
    )
      fail(
        401,
        'endorsement_identity_required',
        'The public key must match the holder address.',
      );
    const account = state.accounts?.[user.address];
    if (
      !plain(account) ||
      account.address !== user.address ||
      account.publicKey !== user.publicKey
    )
      fail(
        403,
        'endorsement_account_required',
        'This holder needs its own matching BAINK account.',
      );
    return user.address;
  }
  function readData(state) {
    if (state.profileEndorsements === undefined)
      return { version: 1, records: {}, rate: {} };
    const data = state.profileEndorsements;
    if (
      !fields(data, ['version', 'records', 'rate']) ||
      data.version !== 1 ||
      !plain(data.records) ||
      !plain(data.rate) ||
      Object.keys(data.records).length > maxRecords ||
      Object.keys(data.rate).length > 10000
    )
      corrupt();
    const intents = new Set(),
      active = new Set();
    for (const [id, row] of Object.entries(data.records)) {
      if (
        !ID.test(id) ||
        !fields(row, [
          'id',
          'author',
          'target',
          'profileVersion',
          'clientRequestId',
          'published',
          'createdAt',
          'revokedAt',
        ]) ||
        row.id !== id ||
        typeof row.author !== 'string' ||
        !ADDRESS.test(row.author) ||
        typeof row.target !== 'string' ||
        !ADDRESS.test(row.target) ||
        row.author === row.target ||
        !integer(row.profileVersion) ||
        row.profileVersion >= Number.MAX_SAFE_INTEGER ||
        typeof row.clientRequestId !== 'string' ||
        !INTENT.test(row.clientRequestId) ||
        row.published !== true ||
        !iso(row.createdAt) ||
        !(
          row.revokedAt === null ||
          (iso(row.revokedAt) &&
            Date.parse(row.revokedAt) >= Date.parse(row.createdAt))
        )
      )
        corrupt();
      const intent = row.author + ':' + row.clientRequestId;
      if (intents.has(intent)) corrupt();
      intents.add(intent);
      if (row.revokedAt === null) {
        const key = row.author + ':' + row.target + ':' + row.profileVersion;
        if (active.has(key)) corrupt();
        active.add(key);
      }
    }
    for (const [address, bucket] of Object.entries(data.rate))
      if (
        !ADDRESS.test(address) ||
        !fields(bucket, ['until', 'count']) ||
        !Number.isSafeInteger(bucket.until) ||
        bucket.until < 0 ||
        bucket.until > 8640000000000000 ||
        !integer(bucket.count) ||
        bucket.count > 60
      )
        corrupt();
    return data;
  }
  async function profile(state, target, { missing = false } = {}) {
    try {
      return (
        await createMemberProfiles({
          store: {
            read: () => state,
            transact() {
              throw Error('Read projection cannot write.');
            },
          },
          maxProfiles: 10000,
        }).get(target)
      ).profile;
    } catch (error) {
      if (error instanceof ProfileError && error.status === 404) {
        if (missing) return null;
        fail(
          404,
          'endorsement_target_missing',
          'No current published profile exists for this identity.',
        );
      }
      if (error instanceof ProfileError && error.status === 400) input();
      corrupt();
    }
  }
  function version(value) {
    if (!integer(value) || value >= Number.MAX_SAFE_INTEGER) input();
    return value;
  }
  function requireVersion(current, value) {
    if (current.version !== value)
      fail(
        409,
        'profile_version_conflict',
        'The published profile changed. Read it again before endorsing.',
      );
  }
  function page(query) {
    if (!fields(query, ['page', 'pageSize'], [])) input();
    const p = query.page ?? 1,
      size = query.pageSize ?? 25;
    if (!integer(p) || p > 10000 || !integer(size) || size > 25) input();
    return { page: p, pageSize: size };
  }
  function admit(data, author, time) {
    for (const [key, value] of Object.entries(data.rate))
      if (value.until <= time) delete data.rate[key];
    const bucket = data.rate[author] ?? { until: time + 60000, count: 0 };
    if (bucket.count >= maxWritesPerMinute)
      fail(
        429,
        'endorsement_rate_limited',
        'Too many new endorsements. Try again later.',
      );
    if (
      !Object.hasOwn(data.rate, author) &&
      Object.keys(data.rate).length >= 10000
    )
      fail(
        503,
        'endorsement_capacity',
        'Peer endorsement capacity has been reached.',
      );
    data.rate[author] = { until: bucket.until, count: bucket.count + 1 };
  }
  return Object.freeze({
    async list(target, query = {}) {
      targetAddress(target);
      const paging = page(query),
        state = store.read(),
        data = readData(state),
        current = await profile(state, target);
      const values = Object.values(data.records)
        .filter(
          (row) =>
            row.target === target &&
            row.profileVersion === current.version &&
            row.revokedAt === null,
        )
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        );
      return {
        subject: { address: target, profileVersion: current.version },
        endorsements: values
          .slice(
            (paging.page - 1) * paging.pageSize,
            paging.page * paging.pageSize,
          )
          .map(projection),
        count: values.length,
        ...paging,
        pages: Math.max(1, Math.ceil(values.length / paging.pageSize)),
        provenance: structuredClone(PROVENANCE),
      };
    },
    async own(user, target, query) {
      targetAddress(target);
      if (!fields(query, ['profileVersion'])) input();
      version(query.profileVersion);
      const state = store.read(),
        author = actor(state, user),
        data = readData(state),
        current = await profile(state, target);
      requireVersion(current, query.profileVersion);
      const found = Object.values(data.records).find(
        (row) =>
          row.author === author &&
          row.target === target &&
          row.profileVersion === current.version &&
          row.revokedAt === null,
      );
      return {
        subject: { address: target, profileVersion: current.version },
        endorsement: found ? receipt(found, current) : null,
        provenance: structuredClone(PROVENANCE),
      };
    },
    async add(user, target, body) {
      targetAddress(target);
      if (
        !fields(body, ['clientRequestId', 'profileVersion', 'publish']) ||
        typeof body.clientRequestId !== 'string' ||
        !INTENT.test(body.clientRequestId) ||
        body.publish !== true
      )
        input();
      version(body.profileVersion);
      const original = actor(store.read(), user),
        holder = { address: user.address, publicKey: user.publicKey },
        clientRequestId = body.clientRequestId,
        profileVersion = body.profileVersion;
      if (original === target)
        fail(
          400,
          'self_endorsement',
          'A holder cannot endorse its own profile.',
        );
      return store.transact(async (state) => {
        const author = actor(state, holder),
          data = readData(state),
          values = Object.values(data.records),
          existing = values.find(
            (row) =>
              row.author === author && row.clientRequestId === clientRequestId,
          );
        if (existing) {
          if (
            existing.target !== target ||
            existing.profileVersion !== profileVersion
          )
            fail(
              409,
              'endorsement_intent_conflict',
              'This intent identifier was already used for different endorsement details.',
            );
          const current = await profile(state, target, { missing: true });
          return {
            created: false,
            endorsement: receipt(existing, current),
            provenance: structuredClone(PROVENANCE),
          };
        }
        const current = await profile(state, target);
        requireVersion(current, profileVersion);
        if (
          values.some(
            (row) =>
              row.author === author &&
              row.target === target &&
              row.profileVersion === current.version &&
              row.revokedAt === null,
          )
        )
          fail(
            409,
            'endorsement_exists',
            'This holder already endorses the current profile revision.',
          );
        // Withdrawn rows no longer count (13 November 2026, B1-5): an author's
        // budget counts its active endorsements, and a full store prunes
        // withdrawn rows (oldest withdrawal first). An active endorsement is
        // never removed; when only those remain the new one is refused.
        if (
          values.filter((row) => row.author === author && row.revokedAt === null)
            .length >= maxPerAuthor ||
          values.filter(
            (row) =>
              row.target === target &&
              row.profileVersion === current.version &&
              row.revokedAt === null,
          ).length >= maxActivePerTarget
        )
          fail(
            503,
            'endorsement_capacity',
            'Peer endorsement capacity has been reached. Existing records are preserved.',
          );
        const time = stamp();
        admit(data, author, time);
        for (let count = values.length; count >= maxRecords; count--) {
          const rows = Object.values(data.records),
            revoked = rows.filter((row) => row.revokedAt !== null);
          if (!revoked.length)
            fail(503, 'endorsement_capacity', 'Peer endorsement capacity has been reached. Existing records are preserved.');
          const gone = revoked.sort((a, b) => a.revokedAt.localeCompare(b.revokedAt) || a.id.localeCompare(b.id))[0];
          delete data.records[gone.id];
        }
        const id = randomUUID(),
          row = {
            id,
            author,
            target,
            profileVersion: current.version,
            clientRequestId,
            published: true,
            createdAt: new Date(time).toISOString(),
            revokedAt: null,
          };
        data.records[id] = row;
        state.profileEndorsements = data;
        return {
          created: true,
          endorsement: receipt(row, current),
          provenance: structuredClone(PROVENANCE),
        };
      });
    },
    async withdraw(user, id, body = {}) {
      if (typeof id !== 'string' || !ID.test(id) || !fields(body, [])) input();
      actor(store.read(), user);
      const holder = { address: user.address, publicKey: user.publicKey };
      return store.transact(async (state) => {
        const author = actor(state, holder),
          data = readData(state),
          row = data.records[id];
        if (!row || row.author !== author)
          fail(
            404,
            'endorsement_missing',
            'No endorsement belonging to this holder exists for that identifier.',
          );
        if (row.revokedAt !== null)
          return {
            changed: false,
            endorsement: receipt(row, null),
            provenance: structuredClone(PROVENANCE),
          };
        const time = stamp();
        if (time < Date.parse(row.createdAt))
          fail(
            503,
            'endorsement_clock_invalid',
            'The endorsement timestamp is unavailable.',
          );
        row.revokedAt = new Date(time).toISOString();
        state.profileEndorsements = data;
        return {
          changed: true,
          endorsement: receipt(row, null),
          provenance: structuredClone(PROVENANCE),
        };
      });
    },
  });
}

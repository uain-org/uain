/** Opt-in, self-authored public profiles. Never derives claims from private
 * BAINK accounts or writes native membership, trust, achievement or money state. */
const ADDRESS = /^uain1[0-9a-f]{40}$/;
const FIELDS = ['displayName', 'summary', 'capabilities', 'services', 'languages', 'availability', 'website', 'publish', 'expectedVersion'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export class ProfileError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const refuse = (status, code, message) => { throw new ProfileError(status, code, message); };
const invalid = () => refuse(400, 'invalid_profile', 'Profile fields or publication/version settings are invalid.');

function cleanText(value, max, multiline = false) {
  const control = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== 'string' || value.length > max || control.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid();
  return value.trim();
}
function listText(value, count, length) {
  if (!Array.isArray(value) || value.length > count) invalid();
  const items = value.map(item => cleanText(item, length));
  if (items.some(item => !item)) invalid();
  return [...new Set(items)];
}
function https(value) {
  value = cleanText(value, 500);
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password) invalid();
  const result = url.href;
  if (result.length > 500) invalid();
  return result;
}
function payload(body) {
  if (!object(body) || Object.keys(body).some(key => ![...FIELDS, 'publicContact'].includes(key)) || FIELDS.some(key => !Object.hasOwn(body, key))) invalid();
  if (typeof body.publish !== 'boolean' || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0 || body.expectedVersion >= Number.MAX_SAFE_INTEGER) invalid();
  const data = {
    displayName: cleanText(body.displayName, 120), summary: cleanText(body.summary, 2000, true),
    capabilities: listText(body.capabilities, 20, 100), services: listText(body.services, 20, 200),
    languages: listText(body.languages, 10, 80), availability: body.availability,
    website: https(body.website), publicContact: https(body.publicContact ?? ''),
  };
  if (!['open', 'limited', 'unavailable'].includes(data.availability) || (body.publish && data.displayName.length < 2)) invalid();
  return data;
}

export function createMemberProfiles({store, maxProfiles = 2000, now = () => new Date().toISOString()} = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.transact !== 'function' || !Number.isSafeInteger(maxProfiles) || maxProfiles < 1 || maxProfiles > 10_000)
    throw Error('A transactional profile store and bounded capacity are required.');
  function records(state) {
    const data = state.memberProfiles ?? {};
    if (!object(data) || Object.keys(data).length > maxProfiles) refuse(503, 'profile_store_invalid', 'The public profile store is unavailable.');
    return data;
  }
  function actor(user, state) {
    if (!object(user) || !ADDRESS.test(user.address)) refuse(401, 'profile_identity_required', 'A verified signed member identity is required.');
    if (!object(state.accounts) || !Object.hasOwn(state.accounts, user.address)) refuse(403, 'profile_account_required', 'Create your own BAINK account before saving a public profile.');
    return user.address;
  }
  function view(record, address) {
    try {
      if (!ADDRESS.test(address) || !object(record) || record.address !== address || !Number.isSafeInteger(record.version) || record.version < 1 || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw Error();
      const data = payload(Object.fromEntries([...FIELDS, 'publicContact'].map(key => [key, key === 'publish' ? record.published : key === 'expectedVersion' ? record.version : record[key]])));
      return {...data, address, published: record.published, version: record.version, createdAt: record.createdAt, updatedAt: record.updatedAt,
        provenance: {kind: 'self-declared', independentlyVerified: false, authorAddress: address,
          note: 'Written by this key holder. Licence, autonomy, trust, availability, capabilities and services are not independently verified here. Actual native research outcomes are separate.'}};
    } catch { refuse(503, 'profile_store_invalid', 'The public profile record is unavailable.'); }
  }
  return Object.freeze({
    async own(user) {
      const state = store.read(), address = actor(user, state), data = records(state);
      return {profile: Object.hasOwn(data, address) ? view(data[address], address) : null};
    },
    async get(address) {
      if (typeof address !== 'string' || !ADDRESS.test(address)) refuse(400, 'invalid_profile_address', 'Provide a complete UAIN public member address.');
      const data = records(store.read());
      if (!Object.hasOwn(data, address) || data[address]?.published !== true) refuse(404, 'profile_missing', 'No published public profile exists for this address.');
      return {profile: view(data[address], address)};
    },
    async list(input = {}) {
      if (!object(input) || Object.keys(input).some(key => !['page', 'pageSize', 'search'].includes(key))) invalid();
      const {page = 1, pageSize = 24, search = ''} = input;
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid();
      const term = cleanText(search, 120).toLowerCase(), data = records(store.read());
      const profiles = Object.entries(data).filter(([, item]) => item?.published === true).map(([address, item]) => view(item, address))
        .filter(item => !term || [item.address, item.displayName, item.summary, ...item.capabilities, ...item.services, ...item.languages].join('\n').toLowerCase().includes(term))
        .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.address.localeCompare(b.address));
      return {profiles: profiles.slice((page - 1) * pageSize, page * pageSize), count: profiles.length,
        page, pageSize, pages: Math.max(1, Math.ceil(profiles.length / pageSize)), provenance: 'Explicitly published, self-declared BAINK profiles only.'};
    },
    async save(user, body) {
      if (!object(body)) invalid();
      const withdrawal = body.publish === false && Object.keys(body).length === 2 && Object.hasOwn(body, 'expectedVersion');
      if (withdrawal && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 || body.expectedVersion >= Number.MAX_SAFE_INTEGER)) invalid();
      const data = withdrawal ? null : payload(body);
      // Verify caller before entering a store transaction; repeat inside it to
      // avoid acting on an account removed between the read and commit.
      actor(user, store.read());
      return store.transact(state => {
        const address = actor(user, state), stored = records(state), previous = Object.hasOwn(stored, address) ? view(stored[address], address) : null;
        if ((previous?.version ?? 0) !== body.expectedVersion) refuse(409, 'profile_version_conflict', 'The profile changed. Reload your own profile before saving.');
        if (!previous && Object.keys(stored).length >= maxProfiles) refuse(503, 'profile_capacity', 'Public profile capacity has been reached.');
        if (withdrawal && !previous) refuse(404, 'profile_missing', 'No profile exists to withdraw.');
        const stamp = now();
        if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))) refuse(503, 'profile_clock_invalid', 'The profile timestamp is unavailable.');
        const fields = withdrawal ? Object.fromEntries(['displayName', 'summary', 'capabilities', 'services', 'languages', 'availability', 'website', 'publicContact'].map(key => [key, previous[key]])) : data;
        const record = {...fields, address, published: body.publish, version: (previous?.version ?? 0) + 1,
          createdAt: previous?.createdAt ?? stamp, updatedAt: stamp};
        state.memberProfiles ??= {};
        state.memberProfiles[address] = record;
        return {profile: view(record, address)};
      });
    },
  });
}

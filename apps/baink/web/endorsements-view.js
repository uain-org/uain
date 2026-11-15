const address = /^uain1[a-f0-9]{40}$/;
const isAddress = (x) => typeof x === 'string' && address.test(x);
const id =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) =>
  object(x) &&
  Object.keys(x).length === keys.length &&
  keys.every((k) => Object.hasOwn(x, k));
const integer = (x) => Number.isSafeInteger(x) && x >= 1;
const check = (x) => {
  if (!x)
    throw Error(
      'This endorsement response could not be verified. Refresh the profile before trying again.',
    );
};
const timestamp = (x) =>
  typeof x === 'string' &&
  Number.isFinite(Date.parse(x)) &&
  new Date(Date.parse(x)).toISOString() === x;
function binding(data, subject) {
  check(
    exact(subject, ['address', 'profileVersion']) &&
      isAddress(subject.address) &&
      integer(subject.profileVersion) &&
      exact(data, ['address', 'profileVersion']) &&
      data.address === subject.address &&
      data.profileVersion === subject.profileVersion,
  );
}
function source(p) {
  check(
    exact(p, [
      'kind',
      'independentlyVerified',
      'affectsNativeKarma',
      'establishesTrust',
      'affectsMoney',
      'countScope',
      'notice',
    ]) &&
      p.kind === 'holder-published-peer-upvotes' &&
      p.independentlyVerified === false &&
      p.affectsNativeKarma === false &&
      p.establishesTrust === false &&
      p.affectsMoney === false &&
      p.countScope ===
        'current-published-profile-version-distinct-author-addresses' &&
      typeof p.notice === 'string' &&
      p.notice.length <= 1000,
  );
}
function row(r, subject, actor, receipt = false) {
  check(
    exact(r, [
      'id',
      'author',
      'target',
      'profileVersion',
      'createdAt',
      ...(receipt ? ['revokedAt', 'active', 'visibility'] : []),
    ]) &&
      typeof r.id === 'string' &&
      id.test(r.id) &&
      isAddress(r.author) &&
      r.author !== subject.address &&
      r.target === subject.address &&
      r.profileVersion === subject.profileVersion &&
      timestamp(r.createdAt),
  );
  if (actor !== undefined) check(isAddress(actor) && r.author === actor);
  if (receipt) {
    check(typeof r.active === 'boolean');
    if (r.revokedAt !== null)
      check(
        timestamp(r.revokedAt) &&
          Date.parse(r.revokedAt) >= Date.parse(r.createdAt) &&
          r.active === false &&
          r.visibility === 'revoked',
      );
    else
      check(
        r.active
          ? r.visibility === 'current-published-profile-version'
          : r.visibility === 'not-current-published-profile',
      );
  }
}
export function validateEndorsementList(data, subject) {
  check(
    exact(data, [
      'subject',
      'endorsements',
      'count',
      'page',
      'pageSize',
      'pages',
      'provenance',
    ]),
  );
  binding(data.subject, subject);
  source(data.provenance);
  check(
    Number.isSafeInteger(data.count) &&
      data.count >= 0 &&
      data.count <= 1000 &&
      integer(data.page) &&
      data.page <= 10000 &&
      integer(data.pageSize) &&
      data.pageSize <= 25 &&
      data.pages === Math.max(1, Math.ceil(data.count / data.pageSize)) &&
      Array.isArray(data.endorsements) &&
      data.endorsements.length ===
        Math.min(
          data.pageSize,
          Math.max(0, data.count - (data.page - 1) * data.pageSize),
        ),
  );
  const authors = new Set(),
    ids = new Set();
  for (const r of data.endorsements) {
    row(r, subject);
    check(!authors.has(r.author) && !ids.has(r.id));
    authors.add(r.author);
    ids.add(r.id);
  }
  return structuredClone(data);
}
export function validateOwnEndorsement(data, subject, actor) {
  check(exact(data, ['subject', 'endorsement', 'provenance']));
  binding(data.subject, subject);
  source(data.provenance);
  check(isAddress(actor));
  if (data.endorsement !== null) {
    row(data.endorsement, subject, actor, true);
    check(
      data.endorsement.active === true && data.endorsement.revokedAt === null,
    );
  }
  return structuredClone(data);
}
export function validateEndorsementMutation(data, subject, actor) {
  check(
    exact(subject, ['address', 'profileVersion']) &&
      isAddress(subject.address) &&
      integer(subject.profileVersion) &&
      isAddress(actor),
  );
  check(object(data));
  const operation = Object.hasOwn(data, 'created') ? 'created' : 'changed';
  check(
    exact(data, [operation, 'endorsement', 'provenance']) &&
      typeof data[operation] === 'boolean',
  );
  source(data.provenance);
  row(data.endorsement, subject, actor, true);
  if (operation === 'created' && data.created)
    check(
      data.endorsement.active === true && data.endorsement.revokedAt === null,
    );
  if (operation === 'changed')
    check(
      data.endorsement.active === false &&
        data.endorsement.visibility === 'revoked',
    );
  return structuredClone(data);
}

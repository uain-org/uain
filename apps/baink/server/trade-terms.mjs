import { createHash, randomUUID } from "node:crypto";
import { nativeUnitsFromDecimal, formatNativeUnits } from "./native-asset.mjs";

const ADDRESS = /^uain1[a-f0-9]{40}$/;
const ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CLIENT = /^[A-Za-z0-9_-]{8,100}$/;
const LIMITS = { drafts: 500, proposals: 1000, intents: 2000, rate: 2000 };
const MAX_BYTES = 2 * 1024 * 1024;
const NOTICE =
  "Discussion only. No agreement, purchase, escrow, payment or native financial action is created.";
export class TradeTermsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "TradeTermsError";
    this.status = status;
    this.code = code;
  }
}
const check = (ok, status, code, message) => {
  if (!ok) throw new TradeTermsError(status, code, message);
};
const invalid = (ok, code = "invalid_terms_body") =>
  check(ok, 400, code, "Provide the supported structured terms fields.");
function record(x) {
  return (
    x !== null &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(x)) &&
    Reflect.ownKeys(x).every(
      (k) =>
        typeof k === "string" &&
        "value" in Object.getOwnPropertyDescriptor(x, k),
    )
  );
}
function fields(x, required, optional = []) {
  invalid(
    record(x) &&
      required.every((k) => Object.hasOwn(x, k)) &&
      Object.keys(x).every((k) => required.includes(k) || optional.includes(k)),
  );
}
function canonical(x) {
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  if (record(x))
    return (
      "{" +
      Object.keys(x)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(x[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(x);
}
const digest = (x) => createHash("sha256").update(canonical(x)).digest("hex");
const text = (x, max) => {
  invalid(
    typeof x === "string" &&
      Buffer.byteLength(x) <= max &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        x,
      ),
    "invalid_terms",
  );
  const out = x.trim();
  invalid(out.length > 0, "invalid_terms");
  return out;
};
function identifier(x) {
  invalid(typeof x === "string" && ID.test(x), "invalid_terms_id");
  return x;
}
function intentId(x) {
  invalid(typeof x === "string" && CLIENT.test(x));
  return x;
}
function revision(x) {
  invalid(Number.isSafeInteger(x) && x > 0);
  return x;
}
function normalize(input) {
  fields(
    input,
    ["scope", "deliverables", "price", "timeline", "acceptanceCriteria"],
    ["expiresAt"],
  );
  let units;
  try {
    units = nativeUnitsFromDecimal(input.price);
  } catch {
    invalid(false, "invalid_terms");
  }
  let expiresAt = input.expiresAt ?? null;
  invalid(
    expiresAt === null ||
      (typeof expiresAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt) &&
        Number.isFinite(Date.parse(expiresAt)) &&
        new Date(expiresAt).toISOString() === expiresAt),
    "invalid_terms",
  );
  return {
    scope: text(input.scope, 2048),
    deliverables: text(input.deliverables, 2048),
    price: formatNativeUnits(units),
    priceUnits: units,
    currency: "AI$",
    timeline: text(input.timeline, 1024),
    acceptanceCriteria: text(input.acceptanceCriteria, 2048),
    expiresAt,
  };
}
function storedTerms(value) {
  try {
    if (!record(value) || Object.keys(value).length !== 8) return false;
    const input = Object.fromEntries(
      [
        "scope",
        "deliverables",
        "price",
        "timeline",
        "acceptanceCriteria",
        "expiresAt",
      ].map((k) => [k, value[k]]),
    );
    return canonical(normalize(input)) === canonical(value);
  } catch {
    return false;
  }
}
function date(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function storedRow(row, id, kind) {
  if (
    !record(row) ||
    row.id !== id ||
    !ID.test(id) ||
    !ID.test(row.enquiryId ?? "") ||
    !ADDRESS.test(row.author ?? "") ||
    typeof row.authorPublicKey !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(row.authorPublicKey) ||
    typeof row.contextDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.contextDigest) ||
    !storedTerms(row.terms) ||
    !record(row.enquirySnapshot) ||
    row.enquirySnapshot.id !== row.enquiryId ||
    ![row.enquirySnapshot.buyer, row.enquirySnapshot.seller].includes(
      row.author,
    )
  )
    return false;
  if (kind === "draft")
    return (
      Number.isSafeInteger(row.revision) &&
      row.revision > 0 &&
      date(row.createdAt) &&
      date(row.updatedAt) &&
      (row.lastSentRevision === null ||
        (Number.isSafeInteger(row.lastSentRevision) &&
          row.lastSentRevision > 0 &&
          row.lastSentRevision <= row.revision))
    );
  return (
    ID.test(row.draftId ?? "") &&
    Number.isSafeInteger(row.draftRevision) &&
    row.draftRevision > 0 &&
    date(row.sentAt)
  );
}
function storage(state, initialize = false) {
  check(
    record(state),
    503,
    "terms_storage_invalid",
    "Structured terms storage is unavailable.",
  );
  if (state.tradeTerms === undefined) {
    const empty = {
      version: 1,
      drafts: {},
      proposals: {},
      intents: {},
      rate: {},
    };
    if (initialize) state.tradeTerms = empty;
    return empty;
  }
  const data = state.tradeTerms;
  check(
    record(data) &&
      data.version === 1 &&
      Object.keys(LIMITS).every(
        (k) => record(data[k]) && Object.keys(data[k]).length <= LIMITS[k],
      ),
    503,
    "terms_storage_invalid",
    "Structured terms storage is unavailable.",
  );
  check(
    Buffer.byteLength(JSON.stringify(data)) <= MAX_BYTES,
    503,
    "terms_storage_invalid",
    "Structured terms storage exceeds its bounds.",
  );
  for (const kind of ["drafts", "proposals"])
    for (const [id, row] of Object.entries(data[kind]))
      check(
        storedRow(row, id, kind === "drafts" ? "draft" : "proposal"),
        503,
        "terms_storage_invalid",
        "Structured terms records have an unsupported format.",
      );
  for (const p of Object.values(data.proposals)) {
    const d = Object.hasOwn(data.drafts, p.draftId)
      ? data.drafts[p.draftId]
      : null;
    check(
      d &&
        d.author === p.author &&
        d.authorPublicKey === p.authorPublicKey &&
        d.enquiryId === p.enquiryId &&
        p.draftRevision <= d.revision,
      503,
      "terms_storage_invalid",
      "Structured terms references are unavailable.",
    );
  }
  return data;
}
function bounded(x) {
  check(
    Buffer.byteLength(JSON.stringify(x)) <= 256 * 1024,
    503,
    "terms_capacity",
    "This terms result exceeds its size limit.",
  );
  return structuredClone(x);
}
const flags = {
  nonbinding: true,
  binding: false,
  settlementAvailable: false,
  acceptanceAvailable: false,
  notice: NOTICE,
};
function draftDTO(d) {
  return {
    id: d.id,
    kind: "nonbinding-terms-draft",
    enquiryId: d.enquiryId,
    author: d.author,
    revision: d.revision,
    terms: structuredClone(d.terms),
    enquirySnapshot: structuredClone(d.enquirySnapshot),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    lastSentRevision: d.lastSentRevision,
    ...flags,
  };
}
function proposalDTO(p) {
  return {
    id: p.id,
    kind: "nonbinding-terms-proposal",
    enquiryId: p.enquiryId,
    author: p.author,
    draftId: p.draftId,
    draftRevision: p.draftRevision,
    terms: structuredClone(p.terms),
    enquirySnapshot: structuredClone(p.enquirySnapshot),
    sentAt: p.sentAt,
    ...flags,
  };
}
function page(query) {
  fields(query, [], ["page", "pageSize"]);
  const number = (x, fallback, max) => {
    if (x === undefined) return fallback;
    invalid(
      (typeof x === "number" && Number.isSafeInteger(x)) ||
        (typeof x === "string" && /^[1-9][0-9]{0,4}$/.test(x)),
      "invalid_terms_query",
    );
    const n = Number(x);
    invalid(n >= 1 && n <= max, "invalid_terms_query");
    return n;
  };
  return {
    page: number(query.page, 1, 10000),
    pageSize: number(query.pageSize, 10, 10),
  };
}

/** Signature verification belongs to the parent. context is synchronous and must
 * authorize the exact participant from the same state passed by this service. */
export function createTradeTermsService({
  store,
  context,
  now = () => Date.now(),
} = {}) {
  if (
    !store ||
    typeof store.read !== "function" ||
    typeof store.transact !== "function" ||
    typeof context !== "function" ||
    typeof now !== "function"
  )
    throw new TypeError(
      "A durable store, synchronous enquiry context and clock are required.",
    );
  const stamp = () => {
    const n = now();
    if (!Number.isSafeInteger(n) || n < 0 || n > 8640000000000000)
      throw new TypeError("Terms clock must return integer milliseconds.");
    return n;
  };
  function resolve(state, user, enquiryId, write = false) {
    const c = context(state, user, enquiryId, { write });
    check(
      record(c) && record(c.enquiry) && typeof c.then !== "function",
      503,
      "terms_context_invalid",
      "Enquiry context is unavailable.",
    );
    const e = c.enquiry;
    check(
      e.id === enquiryId &&
        typeof e.buyer === "string" &&
        ADDRESS.test(e.buyer) &&
        typeof e.seller === "string" &&
        ADDRESS.test(e.seller) &&
        e.buyer !== e.seller &&
        record(e.offer) &&
        Number.isSafeInteger(e.offer.revision) &&
        e.offer.revision >= 1,
      503,
      "terms_context_invalid",
      "Enquiry context is unavailable.",
    );
    check(
      record(user) &&
        ((user.address === e.buyer && user.publicKey === c.buyerPublicKey) ||
          (user.address === e.seller && user.publicKey === c.sellerPublicKey)),
      404,
      "terms_not_found",
      "Private terms were not found.",
    );
    const snapshot = {
      id: e.id,
      kind: "nonbinding-enquiry",
      offerId: e.offerId,
      buyer: e.buyer,
      seller: e.seller,
      message: e.message,
      offer: structuredClone(e.offer),
      createdAt: e.createdAt,
      binding: false,
      settlementAvailable: false,
    };
    check(
      Buffer.byteLength(JSON.stringify(snapshot)) <= 8192,
      503,
      "terms_context_invalid",
      "Enquiry context exceeds its bounds.",
    );
    const binding = digest({
      enquiry: snapshot,
      buyerPublicKey: c.buyerPublicKey,
      sellerPublicKey: c.sellerPublicKey,
    });
    return { snapshot, binding };
  }
  function same(row, c) {
    check(
      row.contextDigest === c.binding,
      503,
      "terms_context_invalid",
      "The original enquiry context changed.",
    );
  }
  function rowFor(data, id) {
    const row = Object.hasOwn(data.drafts, id)
      ? data.drafts[id]
      : Object.hasOwn(data.proposals, id)
        ? data.proposals[id]
        : null;
    check(
      row && record(row),
      404,
      "terms_not_found",
      "Private terms were not found.",
    );
    return row;
  }
  function author(row, user) {
    check(
      row.author === user.address && row.authorPublicKey === user.publicKey,
      404,
      "terms_not_found",
      "Private terms were not found.",
    );
  }
  function recover(data, user, clientRequestId, fingerprint, contextDigest) {
    const key = user.address + "/" + clientRequestId;
    const old = Object.hasOwn(data.intents, key) ? data.intents[key] : null;
    if (!old) return null;
    check(
      record(old) &&
        record(old.result) &&
        old.resultDigest === digest(old.result),
      503,
      "terms_storage_invalid",
      "The original terms receipt is unavailable.",
    );
    check(
      old.authorPublicKey === user.publicKey,
      404,
      "terms_not_found",
      "Private terms were not found.",
    );
    check(
      old.fingerprint === fingerprint,
      409,
      "terms_intent_conflict",
      "This intent already performed a different terms action.",
    );
    check(
      old.contextDigest === contextDigest,
      503,
      "terms_context_invalid",
      "The original terms receipt context changed.",
    );
    return bounded(old.result);
  }
  function rate(data, user, n) {
    for (const [address, bucket] of Object.entries(data.rate)) {
      check(
        ADDRESS.test(address) &&
          record(bucket) &&
          Number.isSafeInteger(bucket.startedAt) &&
          Number.isSafeInteger(bucket.count) &&
          bucket.count >= 1 &&
          bucket.count <= 30,
        503,
        "terms_storage_invalid",
        "Structured terms rate storage is unavailable.",
      );
      if (n - bucket.startedAt >= 60000) delete data.rate[address];
    }
    let bucket = Object.hasOwn(data.rate, user.address)
      ? data.rate[user.address]
      : null;
    if (!bucket) {
      check(
        Object.keys(data.rate).length < LIMITS.rate,
        503,
        "terms_capacity",
        "Structured terms write capacity is full.",
      );
      bucket = { startedAt: n, count: 0 };
      data.rate[user.address] = bucket;
    }
    check(
      bucket.count < 30,
      429,
      "terms_rate_limited",
      "Terms allows thirty new changes per identity per minute.",
    );
    bucket.count++;
  }
  function commit(data, user, clientRequestId, fingerprint, result) {
    check(
      Object.keys(data.intents).length < LIMITS.intents,
      503,
      "terms_capacity",
      "Structured terms intent capacity is full.",
    );
    check(
      Object.keys(data.intents).filter((k) => k.startsWith(user.address + "/"))
        .length < 200,
      429,
      "terms_limit",
      "This identity has reached its terms intent limit.",
    );
    data.intents[user.address + "/" + clientRequestId] = {
      authorPublicKey: user.publicKey,
      fingerprint,
      contextDigest: (result.draft
        ? data.drafts[result.draft.id]
        : data.proposals[result.proposal.id]
      ).contextDigest,
      resultDigest: digest(result),
      result: structuredClone(result),
    };
    check(
      Buffer.byteLength(JSON.stringify(data)) <= MAX_BYTES,
      503,
      "terms_capacity",
      "Structured terms storage has reached its limit.",
    );
    return bounded(result);
  }
  return {
    create(user, enquiryId, body) {
      identifier(enquiryId);
      fields(body, ["clientRequestId", "terms"]);
      const client = intentId(body.clientRequestId),
        terms = normalize(body.terms),
        fingerprint = digest(["create", enquiryId, terms]);
      return store.transact((state) => {
        const c = resolve(state, user, enquiryId),
          existing = storage(state);
        const prior = recover(existing, user, client, fingerprint, c.binding);
        if (prior) return prior;
        check(
          resolve(state, user, enquiryId, true).binding === c.binding,
          503,
          "terms_context_invalid",
          "Enquiry context changed during this action.",
        );
        const data = storage(state, true),
          drafts = Object.values(data.drafts);
        check(
          drafts.length < LIMITS.drafts,
          503,
          "terms_capacity",
          "Structured terms draft capacity is full.",
        );
        check(
          drafts.filter((x) => x.author === user.address).length < 100 &&
            drafts.filter(
              (x) => x.author === user.address && x.enquiryId === enquiryId,
            ).length < 20,
          429,
          "terms_limit",
          "This identity has reached its draft limit.",
        );
        const n = stamp();
        rate(data, user, n);
        const d = {
          id: randomUUID(),
          enquiryId,
          author: user.address,
          authorPublicKey: user.publicKey,
          revision: 1,
          terms,
          contextDigest: c.binding,
          enquirySnapshot: c.snapshot,
          createdAt: new Date(n).toISOString(),
          updatedAt: new Date(n).toISOString(),
          lastSentRevision: null,
        };
        data.drafts[d.id] = d;
        return commit(data, user, client, fingerprint, { draft: draftDTO(d) });
      });
    },
    update(user, id, body) {
      identifier(id);
      fields(body, ["clientRequestId", "expectedRevision", "terms"]);
      const client = intentId(body.clientRequestId),
        expected = revision(body.expectedRevision),
        terms = normalize(body.terms),
        fingerprint = digest(["update", id, expected, terms]);
      return store.transact((state) => {
        const data = storage(state),
          d = rowFor(data, id);
        check(
          Object.hasOwn(data.drafts, id),
          404,
          "terms_not_found",
          "Private draft was not found.",
        );
        const c = resolve(state, user, d.enquiryId);
        author(d, user);
        same(d, c);
        const prior = recover(data, user, client, fingerprint, c.binding);
        if (prior) return prior;
        check(
          resolve(state, user, d.enquiryId, true).binding === c.binding,
          503,
          "terms_context_invalid",
          "Enquiry context changed during this action.",
        );
        check(
          d.revision === expected,
          409,
          "terms_revision_changed",
          "The draft changed. Reload and review the current version.",
        );
        check(
          d.revision < Number.MAX_SAFE_INTEGER,
          503,
          "terms_capacity",
          "Draft revision capacity is full.",
        );
        const n = stamp();
        rate(data, user, n);
        d.terms = terms;
        d.revision++;
        d.updatedAt = new Date(n).toISOString();
        return commit(data, user, client, fingerprint, { draft: draftDTO(d) });
      });
    },
    send(user, id, body) {
      identifier(id);
      fields(body, [
        "clientRequestId",
        "expectedRevision",
        "confirmNonbinding",
      ]);
      const client = intentId(body.clientRequestId),
        expected = revision(body.expectedRevision);
      check(
        body.confirmNonbinding === true,
        400,
        "nonbinding_confirmation_required",
        "Confirm that this proposal creates no agreement or payment.",
      );
      const fingerprint = digest(["send", id, expected, true]);
      return store.transact((state) => {
        const data = storage(state),
          d = rowFor(data, id);
        check(
          Object.hasOwn(data.drafts, id),
          404,
          "terms_not_found",
          "Private draft was not found.",
        );
        const c = resolve(state, user, d.enquiryId);
        author(d, user);
        same(d, c);
        const prior = recover(data, user, client, fingerprint, c.binding);
        if (prior) return prior;
        check(
          resolve(state, user, d.enquiryId, true).binding === c.binding,
          503,
          "terms_context_invalid",
          "Enquiry context changed during this action.",
        );
        check(
          d.revision === expected,
          409,
          "terms_revision_changed",
          "The draft changed. Reload and review the current version.",
        );
        check(
          d.lastSentRevision !== d.revision,
          409,
          "terms_version_already_sent",
          "This draft version was already sent. Review its existing proposal.",
        );
        const proposals = Object.values(data.proposals);
        check(
          proposals.length < LIMITS.proposals,
          503,
          "terms_capacity",
          "Structured terms proposal capacity is full.",
        );
        check(
          proposals.filter((x) => x.author === user.address).length < 200 &&
            proposals.filter((x) => x.enquiryId === d.enquiryId).length < 100,
          429,
          "terms_limit",
          "This proposal limit has been reached.",
        );
        const n = stamp();
        rate(data, user, n);
        const p = {
          id: randomUUID(),
          enquiryId: d.enquiryId,
          author: d.author,
          authorPublicKey: d.authorPublicKey,
          draftId: d.id,
          draftRevision: d.revision,
          terms: structuredClone(d.terms),
          enquirySnapshot: structuredClone(d.enquirySnapshot),
          contextDigest: d.contextDigest,
          sentAt: new Date(n).toISOString(),
        };
        data.proposals[p.id] = p;
        d.lastSentRevision = d.revision;
        return commit(data, user, client, fingerprint, {
          proposal: proposalDTO(p),
        });
      });
    },
    detail(user, id) {
      identifier(id);
      const state = store.read(),
        data = storage(state),
        row = rowFor(data, id),
        c = resolve(state, user, row.enquiryId);
      same(row, c);
      if (Object.hasOwn(data.drafts, id)) {
        author(row, user);
        return bounded({ draft: draftDTO(row) });
      }
      return bounded({ proposal: proposalDTO(row) });
    },
    list(user, enquiryId, query = {}) {
      identifier(enquiryId);
      const paging = page(query),
        state = store.read(),
        c = resolve(state, user, enquiryId),
        data = storage(state);
      const drafts = Object.values(data.drafts).filter(
        (x) =>
          x.enquiryId === enquiryId &&
          x.author === user.address &&
          x.authorPublicKey === user.publicKey,
      );
      const proposals = Object.values(data.proposals).filter(
        (x) => x.enquiryId === enquiryId,
      );
      for (const row of [...drafts, ...proposals]) same(row, c);
      const rows = [
        ...drafts.map((x) => ({ kind: "draft", row: x, date: x.updatedAt })),
        ...proposals.map((x) => ({ kind: "proposal", row: x, date: x.sentAt })),
      ].sort(
        (a, b) =>
          b.date.localeCompare(a.date) || b.row.id.localeCompare(a.row.id),
      );
      const selected = rows.slice(
        (paging.page - 1) * paging.pageSize,
        paging.page * paging.pageSize,
      );
      return bounded({
        drafts: selected
          .filter((x) => x.kind === "draft")
          .map((x) => draftDTO(x.row)),
        proposals: selected
          .filter((x) => x.kind === "proposal")
          .map((x) => proposalDTO(x.row)),
        draftCount: drafts.length,
        proposalCount: proposals.length,
        ...paging,
        pages: Math.max(1, Math.ceil(rows.length / paging.pageSize)),
      });
    },
  };
}

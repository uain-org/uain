import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { createTradeService } from "../server/trade.mjs";
import {
  createTradeTermsService,
  TradeTermsError,
} from "../server/trade-terms.mjs";
function member() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    address:
      "uain1" + createHash("sha256").update(key).digest("hex").slice(0, 40),
    publicKey: key.toString("base64"),
  };
}
const content = () => ({
  scope: "Review the submitted package.",
  deliverables: "A written reproducibility report.",
  price: "1.234567",
  timeline: "Within two working days.",
  acceptanceCriteria: "Document the exact inputs and observed outcomes.",
  expiresAt: null,
});
async function fixture() {
  const buyer = member(),
    seller = member(),
    other = member();
  let state = {
      accounts: Object.fromEntries(
        [buyer, seller, other].map((x) => [x.address, x]),
      ),
    },
    tail = Promise.resolve(),
    stamp = 1793620000000;
  const store = {
    read: () => structuredClone(state),
    transact(fn) {
      const p = tail.then(() => {
        const copy = structuredClone(state);
        const result = fn(copy);
        assert.equal(
          typeof result?.then,
          "undefined",
          "transaction callback must be synchronous",
        );
        state = JSON.parse(JSON.stringify(copy));
        return structuredClone(result);
      });
      tail = p.catch(() => {});
      return p;
    },
  };
  const trade = createTradeService({ store, now: () => stamp });
  const context = (...args) => trade.termsContext(...args);
  const terms = () =>
    createTradeTermsService({ store, context, now: () => stamp });
  const { offer } = await trade.create(seller, {
    clientRequestId: "terms-offer-0001",
    title: "Package review",
    description: "Review the published package.",
    price: "2",
    publish: true,
  });
  const { enquiry } = await trade.enquire(buyer, offer.id, {
    clientRequestId: "terms-enquiry-0001",
    expectedRevision: offer.revision,
    message: "Discuss this scope.",
  });
  return {
    buyer,
    seller,
    other,
    store,
    trade,
    terms: terms(),
    restart: terms,
    offer,
    enquiry,
    advance(ms) {
      stamp += ms;
    },
    mutate(fn) {
      return store.transact(fn);
    },
    async block() {
      await store.transact((s) => {
        s.peerMessages ??= { version: 1, blocks: {} };
        s.peerMessages.blocks[seller.address] = [buyer.address];
      });
    },
  };
}
const create = (
  f,
  id = "create-draft-0001",
  terms = content(),
  user = f.buyer,
) => f.terms.create(user, f.enquiry.id, { clientRequestId: id, terms });
const send = (f, draft, id = "send-proposal-0001", user = f.buyer) =>
  f.terms.send(user, draft.id, {
    clientRequestId: id,
    expectedRevision: draft.revision,
    confirmNonbinding: true,
  });
const code = (status, code) => (e) => e.status === status && e.code === code;
test("draft is author-only and proposed price remains separate from original enquiry quote", async () => {
  const f = await fixture();
  const { draft } = await create(f);
  assert.equal(draft.kind, "nonbinding-terms-draft");
  assert.equal(draft.revision, 1);
  assert.equal(draft.terms.priceUnits, "1234567");
  assert.equal(draft.enquirySnapshot.offer.price, "2.000000");
  assert.equal(draft.nonbinding, true);
  assert.equal(draft.binding, false);
  assert.equal(draft.settlementAvailable, false);
  assert.deepEqual(f.terms.detail(f.buyer, draft.id), { draft });
  assert.throws(
    () => f.terms.detail(f.seller, draft.id),
    code(404, "terms_not_found"),
  );
  assert.deepEqual(f.terms.list(f.seller, f.enquiry.id).drafts, []);
});
test("explicit exact-version send freezes participant-only immutable snapshot", async () => {
  const f = await fixture();
  const { draft } = await create(f);
  const { proposal } = await send(f, draft);
  assert.equal(proposal.kind, "nonbinding-terms-proposal");
  assert.equal(proposal.draftRevision, 1);
  assert.equal(proposal.acceptanceAvailable, false);
  assert.deepEqual(f.terms.detail(f.seller, proposal.id), { proposal });
  assert.throws(
    () => f.terms.detail(f.other, proposal.id),
    (e) => e.status === 404,
  );
  const edited = { ...content(), scope: "New scope after send." };
  await f.terms.update(f.buyer, draft.id, {
    clientRequestId: "edit-draft-0001",
    expectedRevision: 1,
    terms: edited,
  });
  assert.equal(
    f.terms.detail(f.seller, proposal.id).proposal.terms.scope,
    content().scope,
  );
  assert.equal(f.terms.detail(f.buyer, draft.id).draft.revision, 2);
});
test("only draft author can update or send; outsider and fake actor fields never expand scope", async () => {
  const f = await fixture();
  const { draft } = await create(f);
  await assert.rejects(
    async () => send(f, draft, "seller-send-0001", f.seller),
    code(404, "terms_not_found"),
  );
  await assert.rejects(
    async () =>
      f.terms.update(f.seller, draft.id, {
        clientRequestId: "seller-edit-0001",
        expectedRevision: 1,
        terms: content(),
      }),
    code(404, "terms_not_found"),
  );
  await assert.rejects(
    async () =>
      f.terms.create(f.buyer, f.enquiry.id, {
        clientRequestId: "actor-field-0001",
        actor: f.seller,
        terms: content(),
      }),
    code(400, "invalid_terms_body"),
  );
});
test("concurrent exact-version edits serialize and one loses without overwriting", async () => {
  const f = await fixture();
  const { draft } = await create(f);
  const results = await Promise.allSettled(
    ["one", "two"].map((x) =>
      f.terms.update(f.buyer, draft.id, {
        clientRequestId: "concurrent-edit-" + x,
        expectedRevision: 1,
        terms: { ...content(), scope: x },
      }),
    ),
  );
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    results.find((x) => x.status === "rejected").reason.code,
    "terms_revision_changed",
  );
  assert.equal(f.terms.detail(f.buyer, draft.id).draft.revision, 2);
});
test("stale send and missing explicit confirmation do not publish", async () => {
  const f = await fixture();
  const { draft } = await create(f);
  await f.terms.update(f.buyer, draft.id, {
    clientRequestId: "edit-before-send",
    expectedRevision: 1,
    terms: { ...content(), price: "5" },
  });
  await assert.rejects(
    async () => send(f, draft),
    code(409, "terms_revision_changed"),
  );
  await assert.rejects(
    async () =>
      f.terms.send(f.buyer, draft.id, {
        clientRequestId: "unconfirmed-send",
        expectedRevision: 2,
        confirmNonbinding: false,
      }),
    code(400, "nonbinding_confirmation_required"),
  );
  assert.equal(f.terms.list(f.seller, f.enquiry.id).proposals.length, 0);
});
test("stable intents replay original create/update receipts without reverting later state", async () => {
  const f = await fixture();
  const first = await create(f);
  const body = {
    clientRequestId: "exact-update-0001",
    expectedRevision: 1,
    terms: { ...content(), scope: "Revision two" },
  };
  const second = await f.terms.update(f.buyer, first.draft.id, body);
  await send(f, second.draft);
  const state = f.store.read();
  assert.deepEqual(await create(f), first);
  assert.deepEqual(await f.terms.update(f.buyer, first.draft.id, body), second);
  assert.deepEqual(f.store.read(), state);
  assert.deepEqual(
    await f.restart().create(f.buyer, f.enquiry.id, {
      clientRequestId: "create-draft-0001",
      terms: content(),
    }),
    first,
  );
});
test("exact sent retry after block/withdraw preserves original receipt; fresh actions cannot send", async () => {
  const f = await fixture();
  const { draft } = await create(f);
  const first = await send(f, draft);
  await f.block();
  assert.deepEqual(await send(f, draft), first);
  await assert.rejects(
    async () => create(f, "blocked-create-0001"),
    (e) => e.code === "peer_blocked",
  );
  await assert.rejects(
    async () =>
      f.terms.update(f.buyer, draft.id, {
        clientRequestId: "blocked-edit-0001",
        expectedRevision: 1,
        terms: content(),
      }),
    (e) => e.code === "peer_blocked",
  );
  assert.deepEqual(f.terms.detail(f.seller, first.proposal.id), first);
});
test("withdrawn current offer blocks new draft changes while historical reads and exact retry work", async () => {
  const f = await fixture();
  const first = await create(f);
  await f.trade.withdraw(f.seller, f.offer.id);
  assert.deepEqual(await create(f), first);
  await assert.rejects(
    async () => send(f, first.draft),
    (e) => e.code === "offer_withdrawn",
  );
  assert.equal(
    f.terms.detail(f.buyer, first.draft.id).draft.id,
    first.draft.id,
  );
});
test("same intent changed action/body/id conflicts and does not mutate state", async () => {
  const f = await fixture();
  const { draft } = await create(f);
  const before = f.store.read();
  await assert.rejects(
    async () => create(f, "create-draft-0001", { ...content(), price: "2" }),
    code(409, "terms_intent_conflict"),
  );
  await assert.rejects(
    async () =>
      f.terms.send(f.buyer, draft.id, {
        clientRequestId: "create-draft-0001",
        expectedRevision: 1,
        confirmNonbinding: true,
      }),
    code(409, "terms_intent_conflict"),
  );
  assert.deepEqual(f.store.read(), before);
});
test("one draft version cannot publish duplicate proposals under different fresh IDs", async () => {
  const f = await fixture();
  const { draft } = await create(f);
  await send(f, draft);
  await assert.rejects(
    async () => send(f, draft, "different-send-0001"),
    code(409, "terms_version_already_sent"),
  );
  assert.equal(f.terms.list(f.seller, f.enquiry.id).proposalCount, 1);
});
test("past expiry is informational and does not masquerade as agreement validity", async () => {
  const f = await fixture();
  const { draft } = await create(f, "expired-draft-0001", {
    ...content(),
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  const { proposal } = await send(f, draft);
  assert.equal(proposal.terms.expiresAt, "2020-01-01T00:00:00.000Z");
  assert.equal(proposal.binding, false);
});
test("input schema rejects authority injection, numbers, exponent/overscale amounts and malformed expiry", async () => {
  const f = await fixture();
  for (const terms of [
    { ...content(), price: 1 },
    { ...content(), price: "1e3" },
    { ...content(), price: "0" },
    { ...content(), price: "1.0000001" },
    { ...content(), priceUnits: "1" },
    { ...content(), currency: "USD" },
    { ...content(), expiresAt: "2026-02-31T00:00:00.000Z" },
    { ...content(), scope: "bad\0text" },
    { ...content(), scope: "x".repeat(2049) },
  ])
    await assert.rejects(
      async () => create(f, "invalid-content-0001", terms),
      (e) => e.status === 400,
    );
  assert.equal(f.terms.list(f.buyer, f.enquiry.id).draftCount, 0);
});
test("fresh writes check current transactional membership and block state, never stale pre-read", async () => {
  const f = await fixture();
  const { draft } = await create(f);
  const blocking = f.block();
  const posting = send(f, draft);
  await blocking;
  await assert.rejects(posting, (e) => e.code === "peer_blocked");
  assert.equal(f.terms.list(f.seller, f.enquiry.id).proposalCount, 0);
});
test("context or original enquiry drift refuses existing terms rather than rebinding participants/snapshot", async () => {
  const f = await fixture();
  const { draft } = await create(f);
  await f.mutate(
    (s) => (s.trade.enquiries[f.enquiry.id].offerPrice = "99.000000"),
  );
  assert.throws(
    () => f.terms.detail(f.buyer, draft.id),
    (e) => e.status === 503,
  );
});
test("read-only missing storage stays absent and outputs cannot mutate stored drafts", async () => {
  const f = await fixture();
  assert.deepEqual(f.terms.list(f.buyer, f.enquiry.id).drafts, []);
  assert.equal(f.store.read().tradeTerms, undefined);
  const { draft } = await create(f);
  draft.terms.scope = "mutated";
  assert.equal(
    f.terms.detail(f.buyer, draft.id).draft.terms.scope,
    content().scope,
  );
});
test("rate limit rejects new changes but exact successful replay remains available", async () => {
  const f = await fixture();
  const { draft } = await create(f);
  for (let revision = 1; revision < 30; revision++)
    await f.terms.update(f.buyer, draft.id, {
      clientRequestId: "rate-update-" + String(revision).padStart(4, "0"),
      expectedRevision: revision,
      terms: { ...content(), scope: "scope " + revision },
    });
  await assert.rejects(
    async () => create(f, "rate-overflow-0001"),
    code(429, "terms_rate_limited"),
  );
  assert.equal((await create(f)).draft.id, draft.id);
  f.advance(60001);
  assert.equal((await create(f, "after-window-0001")).draft.revision, 1);
});
test("query and ID bounds reject prototype/accessor fields without invoking them", async () => {
  const f = await fixture();
  let invoked = 0;
  const body = { clientRequestId: "accessor-test-0001", terms: content() };
  Object.defineProperty(body, "terms", {
    get() {
      invoked++;
      return content();
    },
    enumerable: true,
  });
  await assert.rejects(
    async () => f.terms.create(f.buyer, f.enquiry.id, body),
    (e) => e.status === 400,
  );
  assert.equal(invoked, 0);
  assert.throws(
    () => f.terms.list(f.buyer, f.enquiry.id, { pageSize: 11 }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => f.terms.detail(f.buyer, "../secret"),
    (e) => e.status === 400,
  );
});
test("original enquiry drift also refuses exact create replay instead of rebinding a stale receipt", async () => {
  const f = await fixture();
  await create(f);
  await f.mutate(
    (s) =>
      (s.trade.enquiries[f.enquiry.id].message = "Changed original message."),
  );
  await assert.rejects(
    async () => create(f),
    (e) => e.status === 503,
  );
});
test("both authors retain private drafts; combined pagination never exposes counterparty drafts", async () => {
  const f = await fixture();
  const own = await create(f);
  const peer = await create(f, "seller-draft-0001", content(), f.seller);
  await send(f, peer.draft, "seller-send-0001", f.seller);
  const seen = f.terms.list(f.buyer, f.enquiry.id, { page: 1, pageSize: 1 });
  assert.equal(seen.drafts.length + seen.proposals.length, 1);
  assert.equal(seen.draftCount, 1);
  assert.equal(seen.proposalCount, 1);
  assert.equal(seen.pages, 2);
  const all = [
    seen,
    f.terms.list(f.buyer, f.enquiry.id, { page: 2, pageSize: 1 }),
  ];
  assert.ok(all.some((x) => x.drafts.some((d) => d.id === own.draft.id)));
  assert.ok(all.every((x) => x.drafts.every((d) => d.id !== peer.draft.id)));
});
test("concurrent sends publish one immutable version and reject the other fresh intent", async () => {
  const f = await fixture();
  const { draft } = await create(f);
  const results = await Promise.allSettled([
    send(f, draft, "race-send-first"),
    send(f, draft, "race-send-second"),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    results.find((x) => x.status === "rejected").reason.code,
    "terms_version_already_sent",
  );
  assert.equal(f.terms.list(f.seller, f.enquiry.id).proposalCount, 1);
});
test("malformed stored draft indexes and row shapes fail closed rather than exposing or overwriting records", async () => {
  for (const mutate of [
    (s) => {
      const [id, row] = Object.entries(s.tradeTerms.drafts)[0];
      row.id = "00000000-0000-4000-8000-000000000000";
    },
    (s) => (Object.values(s.tradeTerms.drafts)[0].terms.priceUnits = "1"),
    (s) => (Object.values(s.tradeTerms.drafts)[0].revision = -1),
    (s) => (Object.values(s.tradeTerms.drafts)[0].createdAt = "bad"),
  ]) {
    const f = await fixture();
    const { draft } = await create(f);
    await f.mutate(mutate);
    assert.throws(
      () => f.terms.detail(f.buyer, draft.id),
      (e) => e instanceof TradeTermsError && e.status === 503,
    );
  }
});
test("context must stay synchronous and match its write-time source before creating anything", async () => {
  const f = await fixture();
  const asyncService = createTradeTermsService({
    store: f.store,
    context: async () => ({}),
  });
  await assert.rejects(
    async () =>
      asyncService.create(f.buyer, f.enquiry.id, {
        clientRequestId: "async-context-0001",
        terms: content(),
      }),
    (e) => e.status === 503,
  );
  const changing = createTradeTermsService({
    store: f.store,
    context: (state, user, id, options) => {
      const c = f.trade.termsContext(state, user, id, options);
      if (options.write) c.enquiry.message = "Changed under callback";
      return c;
    },
  });
  await assert.rejects(
    async () =>
      changing.create(f.buyer, f.enquiry.id, {
        clientRequestId: "changed-context-0001",
        terms: content(),
      }),
    (e) => e.status === 503,
  );
  assert.equal(f.store.read().tradeTerms, undefined);
});
test("byte-cap refusal rolls back mutated revision, rates and intent rather than consuming capacity", async () => {
  const f = await fixture();
  const large = {
    scope: "s".repeat(2048),
    deliverables: "d".repeat(2048),
    price: "1",
    timeline: "t".repeat(1024),
    acceptanceCriteria: "a".repeat(2048),
    expiresAt: null,
  };
  const drafts = [
    (await create(f, "capacity-buyer-0001", large)).draft,
    (await create(f, "capacity-seller-0001", large, f.seller)).draft,
  ];
  let refused = false;
  for (let i = 0; i < 400; i++) {
    if (i % 10 === 0) f.advance(60001);
    const j = i % 2,
      user = j ? f.seller : f.buyer,
      previous = f.store.read();
    try {
      const r = await f.terms.update(user, drafts[j].id, {
        clientRequestId: "capacity-edit-" + String(i).padStart(4, "0"),
        expectedRevision: drafts[j].revision,
        terms: large,
      });
      drafts[j] = r.draft;
    } catch (e) {
      assert.equal(e.code, "terms_capacity");
      assert.deepEqual(f.store.read(), previous);
      refused = true;
      break;
    }
  }
  assert.equal(refused, true);
});
test("same actor reusing an intent for another enquiry is a definite409 before context-drift checks", async () => {
  const f = await fixture();
  await create(f);
  const { enquiry } = await f.trade.enquire(f.buyer, f.offer.id, {
    clientRequestId: "second-enquiry-0001",
    expectedRevision: f.offer.revision,
    message: "Another independent enquiry.",
  });
  const before = f.store.read();
  await assert.rejects(
    async () =>
      f.terms.create(f.buyer, enquiry.id, {
        clientRequestId: "create-draft-0001",
        terms: content(),
      }),
    code(409, "terms_intent_conflict"),
  );
  assert.deepEqual(f.store.read(), before);
});

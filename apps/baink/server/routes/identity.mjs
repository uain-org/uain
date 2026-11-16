// Identity and account routes: the local BAINK account and its metadata,
// public profiles and endorsements, the member directory and native research
// record, and peer messages. Account reads ask the native adapter for the
// current proof on every request; nothing here caches a balance or licence.
import { fail } from "../http-errors.mjs";
import { only, text } from "./context.mjs";

const PROFILE_ENDORSEMENTS_PATH = /^\/api\/profiles\/(uain1[a-f0-9]{40})\/endorsements$/;
const ENDORSEMENT_WITHDRAW_PATH = /^\/api\/profile\/endorsements\/([a-f0-9-]{36})\/withdraw$/;
const CONVERSATION_PATH = /^\/api\/messages\/conversations\/([a-f0-9-]{36})(?:\/(messages|read))?$/;

/** The body checks of POST /api/account. Authentication runs them before it
 * reserves a nonce for an unregistered key (13 November 2026, B1-3), so a
 * refused body can no longer hold a slot of the unregistered nonce pool. */
export function checkAccountBody(body, method = "POST") {
  only(body, method === "POST" ? ["displayName", "via"] : ["displayName"]);
  return text(body.displayName, 80, "Display name", { optional: true });
}

function publicAccount(account) {
  return { ...account, currency: "AI$" };
}

export function createIdentityRoutes({
  store,
  nativeAsset,
  accountBatchingEnabled,
  profiles,
  endorsements,
  memberDirectory,
  nativeResearch,
  messages,
  campaigns = null,
}) {
  const qualifiedAccount = async (account, ctx) => {
    // Only validated, authenticated profile operations wait for the proof queue.
    if (accountBatchingEnabled) ctx.extendDeadline(28_000);
    return {
      ...publicAccount(account),
      ...(await nativeAsset.account(account.address, account.publicKey)),
    };
  };
  const accountMetadata = (account, user) => {
    if (account.address !== user.address || account.publicKey !== user.publicKey)
      fail(503, "account_metadata_unavailable", "Local account metadata is unavailable.");
    const stamp = value => typeof value === "string" && value.length <= 80 ? value : null;
    return {account: {
      address: user.address, publicKey: user.publicKey,
      displayName: typeof account.displayName === "string" && account.displayName.length <= 80 ? account.displayName : "",
      createdAt: stamp(account.createdAt), updatedAt: stamp(account.updatedAt),
      currency: "AI$", balance: null, nativeRegistration: "unavailable",
    }, nativeStatus: "not-requested"};
  };
  return {
    name: "identity",
    async public(ctx) {
      const { method, path, body } = ctx;
      const publicProfile = path.match(/^\/api\/profiles\/(uain1[a-f0-9]{40})$/);
      if (method === "GET" && path === "/api/profiles")
        return ctx.send(200, await profiles.list(ctx.query()));
      if (method === "GET" && publicProfile)
        return ctx.send(200, await profiles.get(publicProfile[1]));
      const profileEndorsementsPath = path.match(PROFILE_ENDORSEMENTS_PATH);
      if (method === "GET" && profileEndorsementsPath) {
        only(body, []);
        return ctx.send(
          200,
          await endorsements.list(profileEndorsementsPath[1], ctx.query()),
        );
      }
      const nativeResearchPath = path.match(
        /^\/api\/members\/(uain1[a-f0-9]{40})\/native-record$/,
      );
      if (method === "GET" && nativeResearchPath) {
        only(ctx.query(), []);
        return ctx.send(200, await nativeResearch.get(nativeResearchPath[1]));
      }
      const directoryPath = path.match(/^\/api\/members\/(uain1[a-f0-9]{40})$/);
      if (method === "GET" && (path === "/api/members" || directoryPath)) {
        const query = ctx.query();
        return ctx.send(
          200,
          directoryPath
            ? await memberDirectory.get(directoryPath[1], query)
            : await memberDirectory.list(query),
        );
      }
    },
    isPrivate(ctx) {
      const { method, path } = ctx;
      const conversationPath = path.match(CONVERSATION_PATH);
      return Boolean(
        (PROFILE_ENDORSEMENTS_PATH.test(path) && method === "POST") ||
        (ENDORSEMENT_WITHDRAW_PATH.test(path) && method === "POST") ||
        (path === "/api/profile/endorsements" && method === "GET") ||
        (path === "/api/profile" && ["GET", "PATCH"].includes(method)) ||
        (path === "/api/messages/conversations" &&
          ["GET", "POST"].includes(method)) ||
        (path === "/api/messages/contacts" && method === "GET") ||
        (["/api/messages/blocks", "/api/messages/reports"].includes(path) &&
          method === "POST") ||
        (conversationPath &&
          ((method === "GET" && !conversationPath[2]) ||
            (method === "POST" && conversationPath[2]))) ||
        (path === "/api/account/metadata" && method === "GET") ||
        (path === "/api/account" && ["GET", "POST", "PATCH"].includes(method)),
      );
    },
    async private(ctx) {
      const { method, path, body, user } = ctx;
      if (path === "/api/profile/endorsements" && method === "GET") {
        only(body, []);
        const query = ctx.query();
        only(query, ["target", "profileVersion"]);
        if (
          typeof query.profileVersion !== "string" ||
          !/^[1-9]\d{0,14}$/.test(query.profileVersion)
        )
          fail(
            400,
            "invalid_query",
            "An exact positive profile version is required.",
          );
        return ctx.send(
          200,
          await endorsements.own(user, query.target, {
            profileVersion: Number(query.profileVersion),
          }),
        );
      }
      const profileEndorsementsPath = path.match(PROFILE_ENDORSEMENTS_PATH);
      if (profileEndorsementsPath && method === "POST") {
        only(ctx.query(), []);
        const result = await endorsements.add(
          user,
          profileEndorsementsPath[1],
          body,
        );
        return ctx.send(result.created ? 201 : 200, result);
      }
      const endorsementWithdrawPath = path.match(ENDORSEMENT_WITHDRAW_PATH);
      if (endorsementWithdrawPath && method === "POST") {
        only(ctx.query(), []);
        return ctx.send(
          200,
          await endorsements.withdraw(user, endorsementWithdrawPath[1], body),
        );
      }
      if (path === "/api/account/metadata") {
        only(ctx.query(), []);
        only(body, []);
        const account = store.account(user.address);
        if (!account)
          fail(404, "account_missing", "Create your BAINK profile to continue.");
        return ctx.send(200, accountMetadata(account, user));
      }
      if (path === "/api/profile")
        return ctx.send(
          200,
          method === "GET"
            ? await profiles.own(user)
            : await profiles.save(user, body),
        );
      if (path === "/api/messages/conversations") {
        if (method === "GET")
          return ctx.send(200, messages.inbox(user, ctx.query()));
        const result = await messages.open(user, body);
        return ctx.send(result.created ? 201 : 200, result);
      }
      if (path === "/api/messages/contacts")
        return ctx.send(200, messages.contacts(user, ctx.query()));
      if (path === "/api/messages/blocks")
        return ctx.send(200, await messages.block(user, body));
      if (path === "/api/messages/reports") {
        const result = await messages.report(user, body);
        return ctx.send(result.created ? 201 : 200, result);
      }
      const conversationPath = path.match(CONVERSATION_PATH);
      if (conversationPath) {
        if (method === "GET")
          return ctx.send(
            200,
            messages.thread(user, conversationPath[1], ctx.query()),
          );
        if (conversationPath[2] === "read")
          return ctx.send(
            200,
            await messages.markRead(user, conversationPath[1], body),
          );
        const result = await messages.send(user, conversationPath[1], body);
        return ctx.send(result.created ? 201 : 200, result);
      }
      if (path === "/api/account") {
        if (method === "GET") {
          const account = store.account(user.address);
          if (!account)
            fail(
              404,
              "account_missing",
              "Create your BAINK profile to continue.",
            );
          return ctx.send(200, { account: await qualifiedAccount(account, ctx) });
        }
        if (method === "POST" || method === "PATCH") {
          const displayName = checkAccountBody(body, method);
          // Campaign code from /go/<code>: kept once, at creation, and only as a
          // known code or "unknown" (server/campaigns.mjs).
          const via = method === "POST" ? campaigns?.accept(body.via) ?? null : null;
          const result = await store.transact((state) => {
            const existing = state.accounts[user.address];
            if (method === "PATCH" && !existing)
              fail(
                404,
                "account_missing",
                "Create your BAINK profile to continue.",
              );
            if (existing && method === "POST")
              return { created: false, account: publicAccount(existing) };
            if (!existing && Object.keys(state.accounts).length >= 10_000)
              fail(429, "capacity", "Profile capacity reached.");
            const account = {
              address: user.address,
              publicKey: user.publicKey,
              displayName,
              createdAt: existing?.createdAt ?? new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              ...(existing?.via ? { via: existing.via } : !existing && via ? { via } : {}),
            };
            state.accounts[user.address] = account;
            return { created: !existing, account: publicAccount(account) };
          });
          if (accountBatchingEnabled && method === "POST")
            return ctx.send(result.created ? 201 : 200, accountMetadata(result.account, user));
          return ctx.send(result.created ? 201 : 200, {
            account: await qualifiedAccount(result.account, ctx),
          });
        }
      }
    },
  };
}

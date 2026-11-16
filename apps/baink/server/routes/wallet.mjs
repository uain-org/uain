// Wallet and native routes: the native asset, holder earning (quote,
// reserve, claim), native payments, instance creation and native enrolment.
// Every read goes to the native adapter or the durable intent journal; the
// routes never cache a balance or licence.
import { only } from "./context.mjs";

export function createWalletRoutes({
  nativeAsset,
  nativeEarning,
  nativePayments,
  nativeInstances,
  nativeEnrol,
}) {
  return {
    name: "wallet",
    async public(ctx) {
      if (ctx.method === "GET" && ctx.path === "/api/native/asset")
        return ctx.send(200, await nativeAsset.asset());
    },
    isPrivate(ctx) {
      const { method, path } = ctx;
      const { financialOperation, instancePath } = walletPaths(ctx);
      return Boolean(
        financialOperation ||
        (path === "/api/native/instances" && method === "GET") ||
        (path === "/api/native/instances/prepare" && method === "POST") ||
        (instancePath && method === "POST") ||
        (method === "GET" && path === "/api/native/enrol") ||
        (method === "POST" &&
          (path === "/api/native/enrol/prepare" ||
            /^\/api\/native\/enrol\/[a-f0-9-]{36}\/(submit|receipt)$/.test(
              path,
            ))),
      );
    },
    async member(ctx) {
      const { method, path, body, user } = ctx;
      const { financialOperation, instancePath, earningPath, paymentPath } = walletPaths(ctx);
      if (financialOperation) {
        only(ctx.query(), []);
        if (method === "GET") {
          only(body, []);
          return ctx.send(200, paymentPath
            ? nativePayments.get(user, paymentPath[1])
            : path === "/api/native/payments" ? nativePayments.list(user) : nativeEarning.list(user));
        }
        let result;
        if (earningPath) result = await nativeEarning[earningPath[2]](user, earningPath[1], body);
        else if (paymentPath) result = await nativePayments[paymentPath[2]](user, paymentPath[1], body);
        else if (path === "/api/native/payments/prepare") result = await nativePayments.prepare(user, body);
        else result = await nativeEarning[path.split("/").at(-1)](user, body);
        return ctx.send(result.created ? 201 : result.attempted ? 202 : 200, result);
      }
      if (method === "GET" && path === "/api/native/instances") {
        only(ctx.query(), []);
        only(body, []);
        return ctx.send(200, nativeInstances.list(user));
      }
      if (method === "POST" && path === "/api/native/instances/prepare") {
        only(ctx.query(), []);
        const result = await nativeInstances.prepare(user, body);
        return ctx.send(result.created ? 201 : 200, {
          intent: result.intent,
        });
      }
      if (method === "POST" && instancePath) {
        only(ctx.query(), []);
        const result = await nativeInstances[instancePath[2]](
          user,
          instancePath[1],
          body,
        );
        return ctx.send(result.attempted ? 202 : 200, {
          intent: result.intent,
        });
      }
      if (method === "GET" && path === "/api/native/enrol")
        return ctx.send(200, nativeEnrol.list(user));
      if (method === "POST" && path === "/api/native/enrol/prepare") {
        const result = await nativeEnrol.prepare(user, body);
        return ctx.send(result.created ? 201 : 200, {
          intent: result.intent,
        });
      }
      const enrolPath = path.match(
        /^\/api\/native\/enrol\/([a-f0-9-]{36})\/(submit|receipt)$/,
      );
      if (method === "POST" && enrolPath) {
        const result = await nativeEnrol[enrolPath[2]](user, enrolPath[1], body);
        return ctx.send(result.attempted ? 202 : 200, {
          intent: result.intent,
        });
      }
    },
  };
}

function walletPaths({ method, path }) {
  const instancePath = path.match(
    /^\/api\/native\/instances\/([a-f0-9-]{36})\/(submit|receipt)$/,
  );
  const earningPath = path.match(/^\/api\/native\/earning\/([a-f0-9-]{36})\/(submit|receipt|reconcile)$/);
  const paymentPath = path.match(/^\/api\/native\/payments\/([a-f0-9-]{36})(?:\/(agree|submit|recover|receipt|confirm|abandon))?$/);
  const financialOperation =
    (method === "GET" && path === "/api/native/earning") ||
    (method === "POST" && ["/api/native/earning/readiness", "/api/native/earning/discover", "/api/native/earning/prepare"].includes(path)) ||
    (method === "POST" && earningPath) ||
    (method === "GET" && path === "/api/native/payments") ||
    (method === "POST" && path === "/api/native/payments/prepare") ||
    (paymentPath && (method === "GET" && !paymentPath[2] || method === "POST" && paymentPath[2]));
  return { instancePath, earningPath, paymentPath, financialOperation };
}

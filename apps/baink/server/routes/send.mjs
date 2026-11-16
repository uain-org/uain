// No-install sending routes (docs/baink/no-install-send-design-2026-11-09.md).
// The browser signs; these routes only accept signed intents, hand back the
// prepared command for the browser to sign, and report status to finality.
import { only } from "./context.mjs";

const SEND = /^\/api\/native\/sends\/([a-f0-9]{64})(?:\/(sign|refresh|cancel|confirm))?$/;
const ADDRESS_PATH = /^\/api\/native\/receiving-address\/(uain1[a-f0-9]{40})$/;

export function createSendRoutes({ serverSend }) {
  return {
    name: "send",
    isPrivate({ method, path }) {
      const match = path.match(SEND);
      return Boolean(
        (path === "/api/native/sends" && ["GET", "POST"].includes(method)) ||
        (match && (method === "GET" ? !match[2] : method === "POST" && match[2])) ||
        (["/api/native/receiving-address", "/api/native/receiving-key"].includes(path) && method === "POST") ||
        (ADDRESS_PATH.test(path) && method === "GET"),
      );
    },
    async member(ctx) {
      const { method, path, body, user } = ctx;
      if (path === "/api/native/sends" && method === "GET") { only(ctx.query(), []); return ctx.send(200, serverSend.list(user)); }
      if (path === "/api/native/sends" && method === "POST") {
        only(ctx.query(), []);
        const result = await serverSend.create(user, body);
        // Start building at once; the background reconciler continues it.
        if (result.created) serverSend.build(result.send.id).catch(() => {});
        return ctx.send(result.created ? 201 : 200, result);
      }
      if (path === "/api/native/receiving-address" && method === "POST") { only(ctx.query(), []); return ctx.send(200, await serverSend.registerReceivingAddress(user, body)); }
      if (path === "/api/native/receiving-key" && method === "POST") { only(ctx.query(), []); return ctx.send(200, await serverSend.registerReceivingKey(user, body)); }
      const address = path.match(ADDRESS_PATH);
      if (address && method === "GET") { only(ctx.query(), []); return ctx.send(200, serverSend.receivingAddress(user, address[1])); }
      const match = path.match(SEND);
      if (!match) return;
      only(ctx.query(), []);
      if (method === "GET" && !match[2]) return ctx.send(200, serverSend.get(user, match[1]));
      if (method === "POST" && match[2]) {
        const result = await serverSend[match[2]](user, match[1], body);
        return ctx.send(result.attempted ? 202 : 200, result);
      }
    },
  };
}

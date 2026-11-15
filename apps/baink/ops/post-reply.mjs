#!/usr/bin/env node
// Add one thread to /admin Replies from a JSON file (docs/admin.md, "Drafts and replies from an agent").
//   BAINK_ADMIN_TOKEN=... node ops/post-reply.mjs reply.json [--url https://baink.money]
// reply.json: {"platform":"reddit","where":"r/ClaudeAI","threadUrl":"https://www.reddit.com/r/…",
//              "threadTitle":"...","threadInfo":"3h, 12 comments","why":"...","draft":"..."}
// The token needs replies:create. Prints the new code and its /go/ link; 409 when the thread was already added.
import { readFileSync } from "node:fs";
const [file, flag, value] = process.argv.slice(2);
const origin = flag === "--url" ? value : process.env.BAINK_URL ?? "https://baink.money";
const token = process.env.BAINK_ADMIN_TOKEN;
if (!file || !token) { console.error("Usage: BAINK_ADMIN_TOKEN=... node ops/post-reply.mjs reply.json [--url origin]"); process.exit(2); }
const response = await fetch(`${origin}/admin/api/replies`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: readFileSync(file, "utf8") });
const body = await response.json().catch(() => null);
if (response.status === 409) { console.log(JSON.stringify({ alreadyAdded: true, existing: body?.error?.existing ?? null })); process.exit(0); }
if (!response.ok) { console.error(`Refused (${response.status}): ${body?.error?.message ?? "no answer"}`); process.exit(1); }
console.log(JSON.stringify(body, null, 2));

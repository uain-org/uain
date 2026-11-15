#!/usr/bin/env node
// Send one draft post to /admin from a JSON file (docs/admin.md, "Drafts and replies from an agent").
//   BAINK_ADMIN_TOKEN=... node ops/post-draft.mjs draft.json [--url https://baink.money]
// draft.json: {"platform":"reddit","where":"r/LocalLLaMA","label":"...","title":"...","body":"...","intro":"...","notes":"..."}
// The token can only create drafts. Prints the new code, its /go/ link and the edit page.
import { readFileSync } from "node:fs";
const [file, flag, value] = process.argv.slice(2);
const origin = flag === "--url" ? value : process.env.BAINK_URL ?? "https://baink.money";
const token = process.env.BAINK_ADMIN_TOKEN;
if (!file || !token) { console.error("Usage: BAINK_ADMIN_TOKEN=... node ops/post-draft.mjs draft.json [--url origin]"); process.exit(2); }
const response = await fetch(`${origin}/admin/api/drafts`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: readFileSync(file, "utf8") });
const body = await response.json().catch(() => null);
if (!response.ok) { console.error(`Refused (${response.status}): ${body?.error?.message ?? "no answer"}`); process.exit(1); }
console.log(JSON.stringify(body, null, 2));

// /admin: email + password login for the team's marketing workspace (campaign
// numbers, posts and replies from server/campaigns.mjs), plus a scoped token API
// for an agent. Neither is a BAINK member identity and neither carries wallet,
// payment or member authority. See docs/admin.md.
//
// Accounts live in <dataDir>/admin-users.json (0600), written only by
// ops/admin-user.mjs on the server. There is no sign-up and no email reset.
// Passwords: scrypt (N=2^15, r=8, p=1), 16-byte salt. Sessions: random 32-byte
// token in an HttpOnly, Secure, SameSite=Strict cookie, kept in memory, 8 hours.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { readFile, writeFile, rename, chmod } from "node:fs/promises";
import { join } from "node:path";
import { retryHint, withRetryHint } from "./http-errors.mjs";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_MS = 8 * 60 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000, FAIL_MAX = 5;
const COOKIE = "baink_admin";
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export const usersFile = (dataDir) => join(dataDir, "admin-users.json");
export const tokensFile = (dataDir) => join(dataDir, "admin-tokens.json");
const DRAFTS_PER_HOUR = 30;
const READS_PER_HOUR = 120;
export async function readTokens(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(tokensFile(dataDir), "utf8"));
    return parsed?.schema === "baink-admin-tokens-v1" && parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {};
  } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}
export async function writeTokens(dataDir, tokens) {
  const file = tokensFile(dataDir), tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ schema: "baink-admin-tokens-v1", tokens }, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}
export const tokenDigest = (token) => createHash("sha256").update(String(token)).digest("hex");
export const TOKEN_SCOPES = ["drafts:create", "replies:create", "marketing:read"];
/** A token's scopes: stored as "a,b" (older tokens have one). */
export const tokenScopes = (t) => String(t?.scope ?? "").split(",").map((v) => v.trim()).filter((v) => TOKEN_SCOPES.includes(v));

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 200)
    throw new Error("Password must be 12 to 200 characters.");
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function checkPassword(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored).split("$");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(String(password).slice(0, 200), Buffer.from(salt, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
// Compared when the email is unknown, so a wrong email and a wrong password take the same time.
const DUMMY = hashPassword("not-a-real-password-" + randomBytes(8).toString("hex"));

export async function readUsers(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(usersFile(dataDir), "utf8"));
    return parsed?.schema === "baink-admin-users-v1" && parsed.users && typeof parsed.users === "object" ? parsed.users : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
export async function writeUsers(dataDir, users) {
  const file = usersFile(dataDir), tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ schema: "baink-admin-users-v1", users }, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}
export const normalEmail = (email) => {
  const value = String(email ?? "").trim().toLowerCase();
  if (!EMAIL.test(value)) throw new Error("Give a valid email address.");
  return value;
};

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (part, whole) => (whole > 0 ? ` <span class="pct">${Math.round((part / whole) * 1000) / 10}%</span>` : "");

export function createAdmin({ dataDir, campaigns, acceptedTask, clientIp, secureCookie = true, uainOrigin = "https://uain.global", now = Date.now }) {
  const sessions = new Map(); // sha256(token) -> { email, expires }
  // Failed attempts (13 November 2026, B1-6): one log per key kind, so failures
  // from many addresses or unknown emails can never push an admin email's
  // lockout out. "email:" holds only existing admin emails (as many as there
  // are admins) and is never trimmed; the other logs drop their least recently
  // used key past 10,000.
  const logs = { "ip": new Map(), "tok-ip": new Map(), "email": new Map(), "unknown-email": new Map() };
  const logOf = (key) => logs[key.slice(0, key.indexOf(":"))];
  const failures = { get: (key) => logOf(key).get(key), delete: (key) => logOf(key).delete(key) };
  // scrypt (N=2^15) runs in the libuv pool: at most two at once, sixteen waiting.
  const SCRYPT_RUNNING = 2, SCRYPT_WAITING = 16;
  let hashing = 0;
  const hashWaiters = [];
  async function boundedHash(work) {
    if (hashing >= SCRYPT_RUNNING) {
      if (hashWaiters.length >= SCRYPT_WAITING) return null;
      await new Promise((resolve) => hashWaiters.push(resolve));
    } else hashing++;
    try { return { value: await work() }; }
    finally { const next = hashWaiters.shift(); if (next) next(); else hashing--; }
  }
  let usersCache = null, usersReadAt = 0;
  async function users() {
    if (!usersCache || now() - usersReadAt > 10_000) { usersCache = await readUsers(dataDir); usersReadAt = now(); }
    return usersCache;
  }
  const digest = (token) => createHash("sha256").update(token).digest("hex");
  function limited(key) {
    const log = logOf(key), recent = (log.get(key) ?? []).filter((t) => now() - t < FAIL_WINDOW_MS);
    log.delete(key);
    if (log !== logs.email && log.size >= 10_000) log.delete(log.keys().next().value);
    log.set(key, recent);
    return recent.length >= FAIL_MAX;
  }
  const failed = (key) => logOf(key).set(key, [...(logOf(key).get(key) ?? []), now()]);
  // Seconds until the oldest counted attempt leaves its window (retry hint for a 429).
  const waitFor = (times, windowMs) => times.length ? (Math.min(...times) + windowMs - now()) / 1000 : undefined;
  function cookieValue(req) {
    for (const part of String(req.headers.cookie ?? "").split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === COOKIE) return rest.join("=");
    }
    return null;
  }
  async function current(req) {
    const token = cookieValue(req);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = sessions.get(digest(token));
    if (!session || session.expires < now()) { sessions.delete(digest(token)); return null; }
    if (!(await users())[session.email]) { sessions.delete(digest(token)); return null; } // removed admin
    return session;
  }
  const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? "; Secure" : ""}`;

  function page(res, status, title, body, headers = {}) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · BAINK admin</title><style>${STYLE}</style></head><body>${body}</body></html>`;
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${COPY_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      ...headers,
    });
    res.end(html);
  }
  const loginForm = (message = "", email = "") => `<main class="login"><h1>BAINK admin</h1>${message ? `<p class="msg">${esc(message)}</p>` : ""}<form method="post" action="/admin/login"><label>Email<input name="email" type="email" autocomplete="username" required value="${esc(email)}"></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Log in</button></form></main>`;

  const PLATFORM_NAMES = { x: "X", reddit: "Reddit", hn: "Hacker News", linkedin: "LinkedIn", other: "Other" };
  const STATUS_NAMES = { draft: "Draft", ready: "Ready", posted: "Posted" };
  // The link to post is uain.global/go/<code> (UAIN is what we promote, 11 November 2026);
  // baink.money/go/<code> is the same code and count, kept for links already out.
  const goLink = (origin, code) => `${uainOrigin}/go/${code}`;
  const bainkGoLink = (origin, code) => `${origin}/go/${code}`;
  const nav = (session, active) => `<header><h1>BAINK marketing</h1><nav><a href="/admin"${active === "numbers" ? ' class="on"' : ""}>Numbers</a><a href="/admin/posts"${active === "posts" ? ' class="on"' : ""}>Posts</a><a href="/admin/replies"${active === "replies" ? ' class="on"' : ""}>Replies</a><a href="/admin/posts/new" class="new">+ New post</a></nav><form method="post" action="/admin/logout"><span>${esc(session.email)}</span><button type="submit">Log out</button></form></header>`;

  // What Numbers shows, for the page and for a marketing:read token: Draft posts
  // and replies that are New or Skipped are left out.
  async function numbers() {
    const report = await campaigns.report({ acceptedTask });
    const posts = new Map(campaigns.posts().map((p) => [p.code, p]));
    const replies = new Map(campaigns.replies().map((r) => [r.code, r]));
    const postRows = [], replyRows = [], notShown = [];
    for (const r of report.campaigns) {
      const reply = replies.get(r.code);
      if (reply) { (reply.status === "replied" ? replyRows : notShown).push({ ...r, reply }); continue; }
      const post = posts.get(r.code);
      (post?.status === "draft" ? notShown : postRows).push({ ...r, post });
    }
    return { report, postRows, replyRows, notShown };
  }
  const totalOf = (rows) => rows.reduce((t, r) => ({ reads: t.reads + r.reads, bots: t.bots + (r.bots ?? 0), accounts: t.accounts + r.accounts, enrolled: t.enrolled + r.enrolled, acceptedTask: t.acceptedTask + r.acceptedTask, spent: t.spent + r.spent }), { reads: 0, bots: 0, accounts: 0, enrolled: 0, acceptedTask: 0, spent: 0 });

  async function dashboard(session) {
    const { report, postRows: postData, replyRows: replyData } = await numbers();
    const line = (r, name, sub) => {
      const out = r.url ? ` <a href="${esc(r.url)}" rel="noopener noreferrer" target="_blank" title="Open it">↗</a>` : "";
      return `<tr><td>${name}${out}<div class="code">${sub}</div></td><td>${r.reads}</td><td>${r.accounts}${pct(r.accounts, r.reads)}</td><td>${r.enrolled}${pct(r.enrolled, r.accounts)}</td><td>${r.acceptedTask}${pct(r.acceptedTask, r.enrolled)}${r.acceptedTaskUnknown ? ` <span class="pct">(+${r.acceptedTaskUnknown} unreadable)</span>` : ""}</td><td>${r.spent}${pct(r.spent, r.acceptedTask)}</td></tr>`;
    };
    const table = (title, rows, empty) => {
      const total = totalOf(rows);
      const body = rows.map((r) => r._html).join("") || `<tr><td colspan="6" class="note">${empty}</td></tr>`;
      return `<h2>${title}</h2><table><thead><tr><th>${title === "Replies" ? "Reply" : "Post"}</th><th>Opened</th><th>Joined</th><th>Enrolled</th><th>First task accepted</th><th>First spend</th></tr></thead>
<tbody>${body}</tbody><tfoot><tr><td>Total</td><td>${total.reads}</td><td>${total.accounts}</td><td>${total.enrolled}</td><td>${total.acceptedTask}</td><td>${total.spent}</td></tr></tfoot></table>`;
    };
    const replyRows = replyData.map(({ reply, ...r }) => ({ ...r, _html: line(r, `<a href="/admin/replies#${esc(r.code)}">${esc(reply.threadTitle)}</a>`, `${esc(r.code)} · ${esc(reply.where || PLATFORM_NAMES[reply.platform])}`) }));
    const postRows = postData.map(({ post: p, ...r }) => {
      const name = p ? `<a href="/admin/posts/${esc(r.code)}">${esc(r.label)}</a>` : esc(r.label);
      return { ...r, _html: line(r, name, `${esc(r.code)}${p ? ` · ${esc(PLATFORM_NAMES[p.platform] ?? p.platform)} · ${esc(STATUS_NAMES[p.status] ?? p.status)}` : ""}`) };
    });
    return `${nav(session, "numbers")}
<main><p class="note">Per link (<code>uain.global/go/&lt;code&gt;</code>; the older <code>baink.money/go/&lt;code&gt;</code> counts under the same code). Draft posts and replies not yet posted are left out. Opened counts people and agents; link-preview and crawler bots are left out (${postData.concat(replyData).reduce((n, r) => n + (r.bots ?? 0), 0)} on these rows). Each percentage is of the column before it. Read ${esc(report.generatedAt)}; page reads lag by up to a minute.</p>
${table("Posts", postRows, "No posts yet.")}
${table("Replies", replyRows, "No replies posted yet.")}
<details><summary>What each column counts</summary><p>${esc(report.note)}</p></details></main>`;
  }

  const REPLY_STATUS_NAMES = { new: "New", replied: "Replied", skipped: "Skipped" };
  function repliesPage(session, origin, query, message = "") {
    const all = campaigns.replies();
    const copy = (id, text) => `<button type="button" class="copy" data-copy="${id}">Copy</button><textarea id="${id}" hidden readonly>${esc(text)}</textarea>`;
    // Rows made with a drafts token show no author; a person's own rows show their login.
    const by = (r) => r.createdBy && !r.createdBy.startsWith("token:") ? ` · by ${esc(r.createdBy)}` : "";
    const card = (r) => {
      const link = goLink(origin, r.code);
      const head = `<div class="rhead"><a href="${esc(r.threadUrl)}" rel="noopener noreferrer" target="_blank">${esc(r.threadTitle)} ↗</a><div class="code">${esc(r.code)} · ${esc(PLATFORM_NAMES[r.platform] ?? r.platform)}${r.where ? ` · ${esc(r.where)}` : ""}${r.threadInfo ? ` · ${esc(r.threadInfo)}` : ""} · added ${esc(String(r.createdAt).slice(0, 10))}${by(r)}</div></div>`;
      if (r.status !== "new") return `<div class="reply" id="${esc(r.code)}">${head}${r.replyUrl ? `<p><a href="${esc(r.replyUrl)}" rel="noopener noreferrer" target="_blank">Your reply ↗</a></p>` : ""}</div>`;
      return `<div class="reply" id="${esc(r.code)}">${head}
${r.why ? `<p class="why">${esc(r.why)}</p>` : ""}
<div class="link"><span>Link for this reply</span><code>${esc(link)}</code>${copy(`l-${esc(r.code)}`, link)}</div>
${r.draft ? `<div class="draft"><div class="dhead"><span>Draft reply</span>${copy(`d-${esc(r.code)}`, r.draft)}</div><pre>${esc(r.draft)}</pre></div>` : ""}
<div class="ractions"><form method="post" action="/admin/replies/${esc(r.code)}"><input type="hidden" name="status" value="replied"><input name="replyUrl" placeholder="URL of your reply, once posted" required><button type="submit">Replied</button></form>
<form method="post" action="/admin/replies/${esc(r.code)}"><input type="hidden" name="status" value="skipped"><button type="submit" class="ghost">Skip</button></form></div></div>`;
    };
    const group = (status) => all.filter((r) => r.status === status);
    const fresh = group("new"), done = group("replied"), skipped = group("skipped");
    const notice = message ? `<p class="${/^(Saved|Marked)/.test(message) ? "ok" : "msg"}">${esc(message)}</p>` : "";
    return `${nav(session, "replies")}<main>${notice}
<details open class="guide"><summary>What to look for</summary>
<p>Conversations close to our angle. Examples:</p>
<ul>
<li>People who want to help a cause but can't donate money or run a lab (Change.org, Avaaz, Ecosia crowds; "how can I help with Alzheimer's/cancer research?")</li>
<li>Volunteer computing folks: Folding@home, BOINC, "what happened to Folding@home?", "use my idle PC or AI for science"</li>
<li>"AI for good", "AI for science", "can AI cure diseases?" discussions</li>
<li>People with unused Claude, Codex or ChatGPT limits asking what to do with them</li>
</ul>
<p class="note">Answer their question first, say you're on the team, one reply per thread in your own words, and use this reply's own link. Lead with the cause, not the coin.</p>
</details>
<h2>New <span class="pct">${fresh.length}</span></h2>${fresh.map(card).join("") || `<p class="note">Nothing new. Add a thread by hand below.</p>`}
<h2>Replied <span class="pct">${done.length}</span></h2>${done.map(card).join("") || `<p class="note">No replies posted yet.</p>`}
<details><summary>Skipped <span class="pct">${skipped.length}</span></summary>${skipped.map(card).join("") || `<p class="note">None.</p>`}</details>
<details><summary>Add a thread by hand</summary><form method="post" action="/admin/replies" class="edit">
<div class="row"><label>Platform<select name="platform">${options(PLATFORM_NAMES, "reddit")}</select></label><label>Where<input name="where" placeholder="r/ClaudeAI"></label><label>Age and comments<input name="threadInfo" placeholder="3h, 12 comments"></label></div>
<label>Thread URL<input name="threadUrl" required placeholder="https://www.reddit.com/r/…"></label>
<label>Thread title<input name="threadTitle" required></label>
<label>Why it fits<input name="why"></label>
<label>Draft reply<textarea name="draft" rows="6"></textarea></label>
<button type="submit">Add thread</button></form></details>
<script>${COPY_JS}</script></main>`;
  }

  function postsPage(session, query) {
    const platform = PLATFORM_NAMES[query.get("platform")] ? query.get("platform") : "";
    const all = campaigns.posts().filter((p) => !platform || p.platform === platform);
    const filters = [["", "All"], ...Object.entries(PLATFORM_NAMES)].map(([k, v]) => `<a href="/admin/posts${k ? `?platform=${k}` : ""}"${k === platform ? ' class="on"' : ""}>${v}</a>`).join("");
    const section = (status) => {
      const list = all.filter((p) => p.status === status);
      if (!list.length) return "";
      return `<h2>${STATUS_NAMES[status]} <span class="pct">${list.length}</span></h2><table class="posts"><thead><tr><th>Post</th><th>Platform</th><th>Where</th><th>Updated</th><th></th></tr></thead><tbody>${list.map((p) => `<tr><td><a href="/admin/posts/${esc(p.code)}">${esc(p.label)}</a><div class="code">${esc(p.code)}</div></td><td>${esc(PLATFORM_NAMES[p.platform] ?? p.platform)}</td><td>${esc(p.where)}</td><td>${esc((p.updatedAt ?? "").slice(0, 10))}</td><td>${p.url ? `<a href="${esc(p.url)}" rel="noopener noreferrer" target="_blank">open ↗</a>` : ""}</td></tr>`).join("")}</tbody></table>`;
    };
    const body = ["draft", "ready", "posted"].map(section).join("") || `<p class="note">No posts yet. <a href="/admin/posts/new">Write the first one</a>.</p>`;
    const notice = query.get("deleted") === "1" ? `<p class="ok">Post deleted.</p>` : "";
    return `${nav(session, "posts")}<main>${notice}<div class="filters">${filters}</div>${body}</main>`;
  }

  const options = (map, selected) => Object.entries(map).map(([k, v]) => `<option value="${k}"${k === selected ? " selected" : ""}>${v}</option>`).join("");
  function postForm(session, origin, post, message = "") {
    const isNew = !post?.code;
    const p = post ?? { platform: "reddit", label: "", where: "", title: "", body: "", intro: "", notes: "", url: "", status: "draft" };
    const link = isNew ? "" : goLink(origin, p.code);
    const copy = (id, text) => `<button type="button" class="copy" data-copy="${id}">Copy</button><textarea id="${id}" hidden readonly>${esc(text)}</textarea>`;
    return `${nav(session, "posts")}<main class="edit">
${message ? `<p class="msg">${esc(message)}</p>` : ""}
<h2>${isNew ? "New post" : esc(p.label)}</h2>
${isNew ? "" : `<div class="link"><span>Link for this post</span><code>${esc(link)}</code>${copy("c-link", link)}<a href="${esc(link)}/llms.txt" target="_blank">what agents see ↗</a> <a href="${esc(link)}" target="_blank">what people see ↗</a></div><p class="note">Older link, same code and count: <code>${esc(bainkGoLink(origin, p.code))}</code></p>`}
<form method="post" action="${isNew ? "/admin/posts" : `/admin/posts/${esc(p.code)}`}">
<div class="row"><label>Platform<select name="platform"${isNew ? "" : " disabled"}>${options(PLATFORM_NAMES, p.platform)}</select></label>
<label>Where<input name="where" value="${esc(p.where)}" placeholder="r/LocalLLaMA, @aldi, Show HN…"></label>
<label>Status<select name="status">${options(STATUS_NAMES, p.status)}</select></label></div>
${isNew ? "" : `<input type="hidden" name="platform" value="${esc(p.platform)}">`}
<label>Name (for this dashboard)<input name="label" required value="${esc(p.label)}" placeholder="Reddit r/LocalLLaMA, design question"></label>
<label>Title <span class="hint">Reddit/HN title, empty for X</span><input name="title" value="${esc(p.title)}"></label>
<label>Post text ${isNew ? "" : copy("c-body", (p.title ? p.title + "\n\n" : "") + p.body)}<textarea name="body" rows="12">${esc(p.body)}</textarea></label>
<label>Intro for agents <span class="hint">shown at the top of the link's guide; empty uses a default</span><textarea name="intro" rows="3">${esc(p.intro)}</textarea></label>
<label>Post URL <span class="hint">paste it once posted</span><input name="url" value="${esc(p.url)}" placeholder="https://…"></label>
<label>Notes <span class="hint">sub rules, flair, what to change before posting</span><textarea name="notes" rows="4">${esc(p.notes)}</textarea></label>
<button type="submit">${isNew ? "Create post and link" : "Save"}</button>
</form>
${isNew ? "" : `<form method="post" action="/admin/posts/${esc(p.code)}/delete" class="delete" data-confirm="Delete this post? Its link stops counting and its code is never reused."><button type="submit" class="danger">Delete post</button></form>`}
${isNew ? "" : `<p class="note">Code <code>${esc(p.code)}</code> never changes. ${p.createdBy && !p.createdBy.startsWith("token:") ? `Created by ${esc(p.createdBy)}${p.createdAt ? ` on ${esc(p.createdAt.slice(0, 10))}` : ""}.` : ""}</p>`}
<script>${COPY_JS}</script></main>`;
  }

  async function form(req) {
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 65536) return null; chunks.push(chunk); }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }
  // Same-origin POSTs only (the cookie is SameSite=Strict as well). BAINK sends
  // Referrer-Policy: no-referrer, so browsers post this form with Origin: null;
  // then the browser's own Sec-Fetch-Site must say same-origin.
  const sameOrigin = (req, origin) => req.headers.origin === origin ||
    ((!req.headers.origin || req.headers.origin === "null") && req.headers["sec-fetch-site"] === "same-origin");

  // Token API for an agent: Bearer token from ops/admin-user.mjs token-add. By scope it
  // can create Draft posts, create New replies, or read posts, replies and numbers.
  // No scope edits, sets a status or URL, deletes or opens a page.
  const draftUse = new Map();
  const sendJson = (res, status, body, wait) => { const json = JSON.stringify(withRetryHint(res, status, body, wait)); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json), "Cache-Control": "no-store" }); res.end(json); return true; };
  /** The token's name once it is valid, has the scope and is under its hourly limit; otherwise answers and returns null. */
  async function tokenFor(req, res, scope, kind, perHour) {
    const send = (...a) => (sendJson(res, ...a), null);
    const auth = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "");
    const ip = clientIp(req);
    if (limited("tok-ip:" + ip)) return send(429, { error: { code: "rate_limited", message: "Too many bad tokens; wait 15 minutes." } }, waitFor(failures.get("tok-ip:" + ip) ?? [], FAIL_WINDOW_MS));
    const entry = auth && Object.entries(await readTokens(dataDir)).find(([, t]) => t.hash === tokenDigest(auth[1]));
    if (!entry) { failed("tok-ip:" + ip); return send(401, { error: { code: "unauthorized", message: "A valid token is required." } }); }
    if (!tokenScopes(entry[1]).includes(scope)) return send(403, { error: { code: "forbidden", message: `This token does not have ${scope}.` } });
    const [name] = entry;
    const useKey = `${kind}:${name}`;
    const recent = (draftUse.get(useKey) ?? []).filter((t) => now() - t < 3_600_000);
    if (recent.length >= perHour) return send(429, { error: { code: "rate_limited", message: `At most ${perHour} ${kind} an hour.` } }, waitFor(recent, 3_600_000));
    return { name, used: () => draftUse.set(useKey, [...recent, now()]) };
  }
  // Read API (scope marketing:read): what the Numbers, Posts and Replies pages show, as JSON.
  // Admin logins are left out of every row.
  async function readApi(req, res, origin, what) {
    const token = await tokenFor(req, res, "marketing:read", "reads", READS_PER_HOUR);
    if (!token) return true;
    token.used();
    if (what === "posts") return sendJson(res, 200, { posts: campaigns.posts().map((p) => ({ code: p.code, status: p.status, platform: p.platform, where: p.where, label: p.label, title: p.title, body: p.body, intro: p.intro, notes: p.notes, url: p.url || null, link: goLink(origin, p.code), createdAt: p.createdAt, updatedAt: p.updatedAt })) });
    if (what === "replies") return sendJson(res, 200, { replies: campaigns.replies().map((r) => ({ code: r.code, status: r.status, platform: r.platform, where: r.where, threadUrl: r.threadUrl, threadTitle: r.threadTitle, threadInfo: r.threadInfo, why: r.why, draft: r.draft, replyUrl: r.replyUrl || null, link: goLink(origin, r.code), createdAt: r.createdAt })) });
    const { report, postRows, replyRows, notShown } = await numbers();
    const count = ({ code, label, url, reads, bots, accounts, enrolled, acceptedTask, acceptedTaskUnknown, spent }) => ({ code, label, url, reads, bots, accounts, enrolled, acceptedTask, acceptedTaskUnknown, spent });
    return sendJson(res, 200, {
      generatedAt: report.generatedAt, note: report.note,
      posts: { rows: postRows.map((r) => ({ ...count(r), platform: r.post?.platform ?? null, status: r.post?.status ?? null })), total: totalOf(postRows) },
      replies: { rows: replyRows.map((r) => ({ ...count(r), platform: r.reply.platform, where: r.reply.where })), total: totalOf(replyRows) },
      // Counted but left out of the Numbers page: links of Draft posts and of replies that are New or Skipped.
      notShown: notShown.map((r) => ({ ...count(r), kind: r.reply ? "reply" : "post", status: (r.reply ?? r.post).status })),
    });
  }
  async function draftApi(req, res, origin, kind = "drafts") {
    const send = (...a) => sendJson(res, ...a);
    const token = await tokenFor(req, res, kind === "replies" ? "replies:create" : "drafts:create", kind, DRAFTS_PER_HOUR);
    if (!token) return true;
    const { name } = token;
    if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return send(415, { error: { code: "json_required", message: "Send JSON." } });
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 65536) return send(413, { error: { code: "body_too_large", message: "At most 64 KB." } }); chunks.push(chunk); }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { error: { code: "invalid_json", message: "The body is not JSON." } }); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return send(400, { error: { code: "invalid_post", message: "Send a JSON object." } });
    const allowed = kind === "replies"
      ? ["platform", "where", "threadUrl", "threadTitle", "threadInfo", "why", "draft", "intro"]
      : ["platform", "label", "where", "title", "body", "intro", "notes", "codeBase"];
    const extra = Object.keys(input).filter((k) => !allowed.includes(k));
    if (extra.length) return send(400, { error: { code: "invalid_post", message: `Unsupported fields: ${extra.join(", ")}. A token cannot set status or URLs of posted items.` } });
    try {
      if (kind === "replies") {
        const reply = await campaigns.createReply(input, { by: `token:${name}` });
        token.used();
        return send(201, { code: reply.code, status: reply.status, link: goLink(origin, reply.code), page: `${origin}/admin/replies#${reply.code}` });
      }
      const post = await campaigns.createPost(input, { by: `token:${name}`, status: "draft" });
      token.used();
      return send(201, { code: post.code, status: post.status, link: goLink(origin, post.code), edit: `${origin}/admin/posts/${post.code}` });
    } catch (error) {
      // A known thread answers 409 with only its code: the token learns nothing else.
      if (error.code === "reply_exists") return send(409, { error: { code: "already_added", message: "This thread was already added.", existing: error.existing } });
      if (error.code === "invalid_post" || error.code === "capacity" || error.code === "code_exhausted") return send(error.status ?? 400, { error: { code: error.code, message: error.message } });
      throw error;
    }
  }

  /** Handles everything under /admin. Returns true when it answered. */
  return async function handle(req, res, url, origin) {
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (!(path === "/admin" || path.startsWith("/admin/"))) return false;
    if (path === "/admin/api/numbers" || path === "/admin/api/posts") {
      if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }); res.end(); return true; }
      return readApi(req, res, origin, path.slice("/admin/api/".length));
    }
    if (path === "/admin/api/drafts" || path === "/admin/api/replies") {
      if (req.method === "GET" && path === "/admin/api/replies") return readApi(req, res, origin, "replies");
      if (req.method !== "POST") { res.writeHead(405, { Allow: path === "/admin/api/replies" ? "GET, POST" : "POST" }); res.end(); return true; }
      return draftApi(req, res, origin, path === "/admin/api/replies" ? "replies" : "drafts");
    }
    const replyPath = /^\/admin\/replies\/([a-z0-9][a-z0-9-]{0,39})$/.exec(path);
    if (path === "/admin/replies" || replyPath) {
      if (req.method === "GET" && !replyPath) {
        const session = await current(req);
        if (!session) return page(res, 200, "Log in", loginForm()), true;
        const msg = { replied: "Marked as replied.", skipped: "Marked as skipped.", added: "Saved: thread added." }[url.searchParams.get("done")] ?? "";
        return page(res, 200, "Replies", repliesPage(session, origin, url.searchParams, msg)), true;
      }
      if (req.method !== "POST") return page(res, 405, "Not allowed", `<main class="login"><p class="msg">Method not allowed.</p></main>`, { Allow: "GET, POST" }), true;
      if (!sameOrigin(req, origin)) return page(res, 403, "Refused", `<main class="login"><p class="msg">Refused: cross-site request.</p></main>`), true;
      const session = await current(req);
      if (!session) return page(res, 303, "Log in", "", { Location: "/admin" }), true;
      const fields = await form(req);
      if (!fields) return page(res, 413, "Too large", `${nav(session, "replies")}<main><p class="msg">Too long.</p></main>`), true;
      try {
        if (replyPath) {
          const status = fields.get("status");
          if (!["replied", "skipped"].includes(status)) throw Object.assign(new Error("Choose Replied or Skip."), { status: 400, code: "invalid_post" });
          await campaigns.setReplyStatus(replyPath[1], { status, replyUrl: fields.get("replyUrl") ?? "" }, { by: session.email });
          return page(res, 303, "Saved", "", { Location: `/admin/replies?done=${status}` }), true;
        }
        const input = Object.fromEntries(["platform", "where", "threadUrl", "threadTitle", "threadInfo", "why", "draft"].filter((k) => fields.has(k)).map((k) => [k, fields.get(k)]));
        await campaigns.createReply(input, { by: session.email });
        return page(res, 303, "Saved", "", { Location: "/admin/replies?done=added" }), true;
      } catch (error) {
        if (!["invalid_post", "post_missing", "reply_exists", "capacity", "code_exhausted"].includes(error.code)) throw error;
        return page(res, error.status ?? 400, "Replies", repliesPage(session, origin, url.searchParams, error.message)), true;
      }
    }
    const postPath = /^\/admin\/posts\/([a-z0-9][a-z0-9-]{0,39})$/.exec(path);
    const deletePath = /^\/admin\/posts\/([a-z0-9][a-z0-9-]{0,39})\/delete$/.exec(path);
    if (deletePath) {
      if (req.method !== "POST") return page(res, 405, "Not allowed", `<main class="login"><p class="msg">Method not allowed.</p></main>`, { Allow: "POST" }), true;
      if (!sameOrigin(req, origin)) return page(res, 403, "Refused", `<main class="login"><p class="msg">Refused: cross-site request.</p></main>`), true;
      const session = await current(req);
      if (!session) return page(res, 303, "Log in", "", { Location: "/admin" }), true;
      await form(req);
      try {
        await campaigns.deletePost(deletePath[1], { by: session.email });
      } catch (error) {
        if (error.code !== "post_missing") throw error;
        return page(res, 404, "Not found", `${nav(session, "posts")}<main><p class="msg">No such post.</p></main>`), true;
      }
      return page(res, 303, "Deleted", "", { Location: "/admin/posts?deleted=1" }), true;
    }
    if (req.method === "GET" && (path === "/admin" || path === "/admin/posts" || path === "/admin/posts/new" || postPath)) {
      const session = await current(req);
      if (!session) return page(res, 200, "Log in", loginForm()), true;
      if (path === "/admin") return page(res, 200, "Numbers", await dashboard(session)), true;
      if (path === "/admin/posts") return page(res, 200, "Posts", postsPage(session, url.searchParams)), true;
      if (path === "/admin/posts/new") return page(res, 200, "New post", postForm(session, origin, null)), true;
      const post = campaigns.post(postPath[1]);
      if (!post) return page(res, 404, "Not found", `${nav(session, "posts")}<main><p class="msg">No such post.</p></main>`), true;
      const saved = url.searchParams.get("saved") === "1" ? "Saved." : "";
      return page(res, 200, post.label, postForm(session, origin, post, saved).replace('<p class="msg">Saved.</p>', '<p class="ok">Saved.</p>')), true;
    }
    if (req.method === "POST" && (path === "/admin/posts" || postPath)) {
      if (!sameOrigin(req, origin)) return page(res, 403, "Refused", `<main class="login"><p class="msg">Refused: cross-site request.</p></main>`), true;
      const session = await current(req);
      if (!session) return page(res, 303, "Log in", "", { Location: "/admin" }), true;
      const fields = await form(req);
      if (!fields) return page(res, 413, "Too large", `${nav(session, "posts")}<main><p class="msg">The post is too long.</p></main>`), true;
      const input = Object.fromEntries(["platform", "label", "where", "title", "body", "intro", "notes", "url", "status"].filter((k) => fields.has(k)).map((k) => [k, fields.get(k)]));
      try {
        const post = postPath
          ? await campaigns.updatePost(postPath[1], input, { by: session.email })
          : await campaigns.createPost(input, { by: session.email, status: input.status || "draft" });
        return page(res, 303, "Saved", "", { Location: `/admin/posts/${post.code}?saved=1` }), true;
      } catch (error) {
        if (!["invalid_post", "post_missing", "capacity", "code_exhausted"].includes(error.code)) throw error;
        const existing = postPath ? campaigns.post(postPath[1]) : null;
        return page(res, error.status ?? 400, "Fix the post", postForm(session, origin, existing ? { ...existing, ...input } : { platform: "reddit", ...input }, error.message)), true;
      }
    }
    if (req.method === "POST" && (path === "/admin/login" || path === "/admin/logout")) {
      if (!sameOrigin(req, origin)) return page(res, 403, "Refused", `<main class="login"><p class="msg">Refused: cross-site request.</p></main>`), true;
      if (path === "/admin/logout") {
        const token = cookieValue(req);
        if (token) sessions.delete(digest(token));
        return page(res, 303, "Logged out", "", { Location: "/admin", "Set-Cookie": cookie("", 0) }), true;
      }
      const fields = await form(req);
      const email = String(fields?.get("email") ?? "").trim().toLowerCase(), password = fields?.get("password") ?? "";
      const ip = clientIp(req);
      const user = Object.hasOwn(await users(), email) ? (await users())[email] : undefined;
      // Unknown emails are counted too (the answers stay the same), in their own log.
      const emailKey = (user ? "email:" : "unknown-email:") + email;
      if (limited("ip:" + ip) || limited(emailKey))
        return page(res, 429, "Log in", loginForm("Too many failed attempts. Try again in 15 minutes.", email), { "Retry-After": String(retryHint(429, "rate_limited", Math.max(waitFor(failures.get("ip:" + ip) ?? [], FAIL_WINDOW_MS) ?? 0, waitFor(failures.get(emailKey) ?? [], FAIL_WINDOW_MS) ?? 0) || undefined).retryAfterSeconds) }), true;
      const checked = await boundedHash(async () => user ? await checkPassword(password, user.password) : (await checkPassword(password, await DUMMY), false));
      if (!checked)
        return page(res, 429, "Log in", loginForm("Too many log-in attempts right now. Try again in a few seconds.", email), { "Retry-After": "5" }), true;
      if (!checked.value) {
        failed("ip:" + ip); failed(emailKey);
        return page(res, 401, "Log in", loginForm("Wrong email or password.", email)), true;
      }
      failures.delete(emailKey);
      const token = randomBytes(32).toString("base64url");
      for (const [key, s] of sessions) if (s.expires < now()) sessions.delete(key);
      sessions.set(digest(token), { email, expires: now() + SESSION_MS });
      return page(res, 303, "Logged in", "", { Location: "/admin", "Set-Cookie": cookie(token, SESSION_MS / 1000) }), true;
    }
    page(res, 405, "Not allowed", `<main class="login"><p class="msg">Method not allowed.</p></main>`, { Allow: "GET, POST" });
    return true;
  };
}

// Copy buttons: the only script, allowed by its hash in the CSP.
const COPY_JS = `document.querySelectorAll("button.copy").forEach(function(b){b.addEventListener("click",function(){var t=document.getElementById(b.dataset.copy);navigator.clipboard.writeText(t.value).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1500)})})});document.querySelectorAll("form[data-confirm]").forEach(function(f){f.addEventListener("submit",function(e){if(!confirm(f.dataset.confirm))e.preventDefault()})})`;
const COPY_HASH = createHash("sha256").update(COPY_JS).digest("base64");
// Minimal functional style; the visual design is Claude's (AGENTS.md).
const STYLE = `body{font:15px/1.5 system-ui,sans-serif;margin:0;color:#14213d;background:#f6f8fb}
header{display:flex;justify-content:space-between;align-items:center;padding:16px 24px;background:#0b2a4a;color:#fff}
header h1{margin:0;font-size:20px}header form{display:flex;gap:12px;align-items:center}
main{padding:24px;max-width:1100px;margin:0 auto}.login{max-width:360px;margin:12vh auto}
form label{display:block;margin:12px 0}input{display:block;width:100%;box-sizing:border-box;padding:8px;margin-top:4px;border:1px solid #c5ced9;border-radius:6px}
button{padding:8px 16px;border:0;border-radius:6px;background:#0a9be0;color:#fff;cursor:pointer}
.msg{background:#fdecec;color:#8a1c1c;padding:8px 12px;border-radius:6px}
table{width:100%;border-collapse:collapse;background:#fff}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #e3e8ef}
th{background:#eef2f7;font-weight:600}tfoot td{font-weight:600}.code{font:12px monospace;color:#6b7a90}.pct{color:#6b7a90;font-size:13px}.note{color:#4a5a70}
header nav{display:flex;gap:6px}header nav a{color:#cfe3f5;text-decoration:none;padding:6px 12px;border-radius:6px}header nav a.on{background:#123a63;color:#fff}header nav a.new{background:#0a9be0;color:#fff}
h2{font-size:17px;margin:28px 0 8px}.filters{display:flex;gap:6px;flex-wrap:wrap}.filters a{padding:4px 10px;border-radius:14px;background:#e6ecf3;color:#14213d;text-decoration:none;font-size:13px}.filters a.on{background:#0b2a4a;color:#fff}
.edit{max-width:820px}.edit textarea,.edit select{display:block;width:100%;box-sizing:border-box;padding:8px;margin-top:4px;border:1px solid #c5ced9;border-radius:6px;font:inherit}
.row{display:grid;grid-template-columns:1fr 2fr 1fr;gap:12px}.hint{color:#6b7a90;font-size:13px;font-weight:normal}[hidden]{display:none!important}
.link{display:flex;gap:10px;align-items:center;background:#fff;border:1px solid #e3e8ef;border-radius:8px;padding:10px 12px;flex-wrap:wrap}.link span{color:#6b7a90;font-size:13px}
button.copy{padding:3px 10px;font-size:12px;background:#e6ecf3;color:#14213d}.ok{background:#e7f6ec;color:#17602f;padding:8px 12px;border-radius:6px}
select:disabled{background:#eef2f7}form.delete{margin-top:28px;padding-top:16px;border-top:1px solid #e3e8ef}button.danger{background:#fff;color:#b42318;border:1px solid #e6b3ad}
.reply{background:#fff;border:1px solid #e3e8ef;border-radius:8px;padding:12px 14px;margin:10px 0}.rhead a{font-weight:600}.why{color:#4a5a70;margin:6px 0}
.draft{margin-top:10px}.dhead{display:flex;gap:10px;align-items:center;color:#6b7a90;font-size:13px}.draft pre{white-space:pre-wrap;font:inherit;background:#f6f8fb;border:1px solid #e3e8ef;border-radius:6px;padding:10px;margin:6px 0 0}
.ractions{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap}.ractions form{display:flex;gap:8px;align-items:center}.ractions input{margin:0;min-width:320px}button.ghost{background:#e6ecf3;color:#14213d}
details{margin:18px 0}details summary{cursor:pointer;font-weight:600}.guide{background:#fff;border:1px solid #e3e8ef;border-radius:8px;padding:12px 16px}.guide ul{margin:6px 0 10px;padding-left:20px}.guide li{margin:3px 0}`;

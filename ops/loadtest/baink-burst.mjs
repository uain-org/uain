#!/usr/bin/env node
// BAINK burst test: concurrent simulated members, not single requests.
//
// Each simulated member has its own Ed25519 identity and its own client IP
// (sent as X-Real-IP, which BAINK trusts only from loopback, the way Nginx
// forwards it), so every member stays inside BAINK's per-member and per-IP
// limits exactly as a real member would. Run it ON the BAINK host against
// 127.0.0.1:8798 (or a throwaway copy): from one outside IP you would only
// measure Nginx's 10 requests/s per-IP limiter.
//
// Mix (per member action, after a think time):
//   viewers  - public pages and lists only (/, a JS asset, health, config,
//              projects, work list, trade feed, funding policy)
//   members  - the same plus signed reads: account/balance, tasks, own
//              submissions, payment requests, sends
//   writers  - a small share of writes (payment requests, messages, work
//              choices); off unless --writes is given. Never on production.
//              --writes and --register are refused for a non-loopback --target
//              unless --allow-remote-writes is given.
//
// Pacing: at most 100 signed requests per member per 300 s (BAINK refuses
// above 128 outstanding nonces per 300 s) and at most 100 per minute (BAINK
// admits 120). Retries happen only on 429, 5xx and transport errors, with
// capped exponential backoff and a fresh signature.
//
// Stops at once when a step's error rate exceeds --max-error-rate, when the
// public review health loses a flag that was true at the start, or when the
// target's /api/health fails twice in a row.
//
// Usage (examples in docs/testing/baink-burst-2026-11-10.md):
//   node ops/loadtest/baink-burst.mjs --target http://127.0.0.1:8798 \
//     --origin https://baink.money --steps 20,50,100,200 --hold 60 \
//     --identities /root/baink-loadtest/ids.json --register \
//     --out /root/baink-loadtest/result.json
import { generateKeyPairSync, createHash, sign, randomBytes, createPrivateKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    target: { type: "string", default: "http://127.0.0.1:8798" },
    origin: { type: "string", default: "" },
    steps: { type: "string", default: "20,50,100,200" },
    hold: { type: "string", default: "60" },
    ramp: { type: "string", default: "10" },
    think: { type: "string", default: "3" },
    "member-share": { type: "string", default: "0.5" },
    "write-share": { type: "string", default: "0.05" },
    writes: { type: "boolean", default: false },
    identities: { type: "string", default: "" },
    register: { type: "boolean", default: false },
    "allow-remote-writes": { type: "boolean", default: false },
    "max-error-rate": { type: "string", default: "0.05" },
    "review-health": { type: "string", default: "https://baink.money/api/native/review/health" },
    "no-review-health": { type: "boolean", default: false },
    "ip-prefix": { type: "string", default: "198.18" },
    "timeout": { type: "string", default: "30" },
    out: { type: "string", default: "" },
    label: { type: "string", default: "" },
    pid: { type: "string", default: "" },
    skip: { type: "string", default: "" },
  },
});

const target = args.target.replace(/\/$/, "");
// 13 November 2026 (security review OP-9): writes and registration create rows on the
// target, so they run only against loopback (on the BAINK host or a throwaway copy)
// unless --allow-remote-writes says otherwise on purpose. Loopback on the production
// host is still production: the operator decides that, not this check.
const targetHost = new URL(target).hostname.replace(/^\[|\]$/g, "");
const loopback = targetHost === "localhost" || targetHost === "::1" || /^127(\.\d{1,3}){3}$/.test(targetHost);
if ((args.writes || args.register) && !loopback && !args["allow-remote-writes"]) {
  console.error(`--writes and --register need a loopback --target (got ${targetHost}); pass --allow-remote-writes to write to a remote target on purpose.`);
  process.exit(2);
}
const steps = args.steps.split(",").map(Number);
const holdMs = Number(args.hold) * 1000;
const rampMs = Number(args.ramp) * 1000;
const thinkMs = Number(args.think) * 1000;
const memberShare = Number(args["member-share"]);
const writeShare = args.writes ? Number(args["write-share"]) : 0;
const maxErrorRate = Number(args["max-error-rate"]);
const timeoutMs = Number(args.timeout) * 1000;
const maxUsers = Math.max(...steps);
if (!steps.every((n) => Number.isInteger(n) && n > 0 && n <= 1000)) throw new Error("--steps must be positive integers up to 1000");

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const NONCE_WINDOW_MS = 300_000, NONCE_BUDGET = 100, MINUTE_BUDGET = 100;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function newIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
  return { privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }), publicKey: raw.toString("base64") };
}
function hydrate(id) {
  const raw = Buffer.from(id.publicKey, "base64");
  return {
    ...id,
    key: createPrivateKey(id.privateKeyPem),
    address: `uain1${createHash("sha256").update(raw).digest("hex").slice(0, 40)}`,
  };
}

// ---- metrics -------------------------------------------------------------
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]); };
function newStep(users) {
  return { users, startedAt: new Date().toISOString(), endedAt: null, calls: 0, ok: 0, failed: 0, retries: 0, refusals: {}, statuses: {}, transport: {}, byRoute: {}, latency: [], actionLatency: [], health: [], eventLoopP99ms: null, stopped: null };
}
let step = null;
function record(route, status, ms, kind) {
  if (!step) return;
  step.calls++;
  step.statuses[status] = (step.statuses[status] ?? 0) + 1;
  const r = (step.byRoute[route] ??= { calls: 0, ok: 0, statuses: {}, ms: [] });
  r.calls++; r.statuses[status] = (r.statuses[status] ?? 0) + 1; r.ms.push(ms);
  step.latency.push(ms);
  if (kind) step.refusals[kind] = (step.refusals[kind] ?? 0) + 1;
}

// ---- HTTP with the documented retry policy -------------------------------
const audienceFor = () => args.origin || target;
async function call(user, method, path, { body, signed = false, route = path, attempts = 4 } = {}) {
  const began = performance.now();
  for (let attempt = 1; ; attempt++) {
    const headers = { "x-real-ip": user.ip, "user-agent": "baink-burst/1" };
    if (args.origin) headers.origin = args.origin;
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
    if (signed) {
      await user.pace();
      const nonce = randomBytes(24).toString("base64url"), timestamp = String(Date.now());
      const message = canonical({ audience: audienceFor(), method, path, body: body ?? {}, nonce, timestamp });
      headers["x-baink-public-key"] = user.id.publicKey;
      headers["x-baink-nonce"] = nonce;
      headers["x-baink-timestamp"] = timestamp;
      headers["x-baink-signature"] = sign(null, Buffer.from(message), user.id.key).toString("base64");
    }
    const t0 = performance.now();
    let status, code = null, transport = null;
    try {
      const res = await fetch(target + path, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
      status = res.status;
      const text = await res.text();
      if (status >= 400) { try { code = JSON.parse(text)?.error?.code ?? null; } catch {} }
    } catch (error) {
      transport = error.name === "TimeoutError" ? "timeout" : (error.cause?.code ?? error.name);
      status = "transport";
    }
    const ms = performance.now() - t0;
    const retryable = status === "transport" || status === 429 || (typeof status === "number" && status >= 500);
    record(route, status, ms, code ?? transport);
    if (transport && step) step.transport[transport] = (step.transport[transport] ?? 0) + 1;
    if (!retryable || attempt >= attempts || stopping) {
      const ok = typeof status === "number" && status < 400;
      if (step) { if (ok) { step.ok++; step.byRoute[route].ok++; } else step.failed++; step.actionLatency.push(performance.now() - began); }
      return { status, code, ok };
    }
    if (step) step.retries++;
    await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random()));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- simulated members ---------------------------------------------------
class SimUser {
  constructor(index, id) {
    this.index = index;
    this.ip = `${args["ip-prefix"]}.${Math.floor(index / 250)}.${(index % 250) + 1}`;
    this.id = id;
    this.kind = !id ? "viewer" : "member";
    this.signedTimes = [];
    this.active = false;
  }
  async pace() {
    for (;;) {
      const now = Date.now();
      while (this.signedTimes.length && this.signedTimes[0] < now - NONCE_WINDOW_MS) this.signedTimes.shift();
      const lastMinute = this.signedTimes.filter((t) => t > now - 60_000).length;
      if (this.signedTimes.length < NONCE_BUDGET && lastMinute < MINUTE_BUDGET) { this.signedTimes.push(now); return; }
      await sleep(1000);
    }
  }
}
const PUBLIC_ACTIONS = [
  ["page", 3, (u) => call(u, "GET", "/", { route: "GET /" })],
  ["asset", 2, (u) => call(u, "GET", assetPath, { route: "GET /assets/*" })],
  ["health", 1, (u) => call(u, "GET", "/api/health")],
  ["config", 2, (u) => call(u, "GET", "/api/config")],
  ["projects", 3, (u) => call(u, "GET", "/api/projects")],
  ["work", 3, (u) => call(u, "GET", "/api/work/projects", { route: "GET /api/work/projects" })],
  ["trade-feed", 2, (u) => call(u, "GET", "/api/trade/feed")],
  ["funding", 1, (u) => call(u, "GET", "/api/funding/policy")],
];
const MEMBER_ACTIONS = [
  ["balance", 3, (u) => call(u, "GET", "/api/account", { signed: true, route: "GET /api/account (signed)" })],
  ["tasks", 3, (u) => call(u, "GET", "/api/native/central/tasks?limit=12", { signed: true, route: "GET /api/native/central/tasks (signed)" })],
  ["submissions", 2, (u) => call(u, "GET", "/api/native/central/intents", { signed: true, route: "GET /api/native/central/intents (signed)" })],
  ["requests", 2, (u) => call(u, "GET", "/api/requests", { signed: true, route: "GET /api/requests (signed)" })],
  ["sends", 1, (u) => call(u, "GET", "/api/native/sends", { signed: true, route: "GET /api/native/sends (signed)" })],
  ["awards", 1, (u) => call(u, "GET", "/api/native/central/awards?limit=20", { signed: true, route: "GET /api/native/central/awards (signed)" })],
];
let writeSeq = 0;
const WRITE_ACTIONS = [
  ["payment-request", 3, (u) => call(u, "POST", "/api/requests", { signed: true, route: "POST /api/requests (signed)", body: { to: otherMember(u), amount: "0.000001", memo: `Load test request ${++writeSeq} (fictional)`, clientRequestId: `burst-${runTag}-${u.index}-${writeSeq}` } })],
  ["work-choice", 1, (u) => call(u, "GET", "/api/work/selections", { signed: true, route: "GET /api/work/selections (signed)" })],
];
function otherMember(u) {
  const others = users.filter((o) => o.id && o !== u);
  return others[Math.floor(Math.random() * others.length)].id.address;
}
// --skip drops named actions (for example native-proof reads on a copy with no chain access).
const skip = new Set(args.skip.split(",").filter(Boolean));
for (const list of [PUBLIC_ACTIONS, MEMBER_ACTIONS, WRITE_ACTIONS]) for (let i = list.length - 1; i >= 0; i--) if (skip.has(list[i][0])) list.splice(i, 1);
function pick(actions) {
  const total = actions.reduce((s, a) => s + a[1], 0);
  let r = Math.random() * total;
  for (const a of actions) { r -= a[1]; if (r <= 0) return a; }
  return actions.at(-1);
}
async function memberLoop(u) {
  await sleep(Math.random() * thinkMs);
  while (u.active && !stopping) {
    let action;
    if (u.kind === "member" && writeShare > 0 && Math.random() < writeShare) action = pick(WRITE_ACTIONS);
    else if (u.kind === "member" && Math.random() < 0.6) action = pick(MEMBER_ACTIONS);
    else action = pick(PUBLIC_ACTIONS);
    await action[2](u);
    // Exponential think time, mean --think seconds, as a person or agent reading a page.
    await sleep(-Math.log(1 - Math.random()) * thinkMs);
  }
}

// ---- guards --------------------------------------------------------------
let stopping = false, baselineReview = null;
async function reviewFlags() {
  if (args["no-review-health"]) return null;
  try {
    const r = await fetch(args["review-health"], { signal: AbortSignal.timeout(10_000) });
    const j = await r.json();
    return { status: r.status, available: j.available === true, brokerReady: j.brokerReady === true, rootReady: (j.rootReady ?? j.broker?.payload?.rootReady ?? j.receipt?.payload?.rootReady) === true };
  } catch (e) { return { status: "transport", error: e.name }; }
}
async function targetHealth() {
  const t0 = performance.now();
  try {
    const r = await fetch(target + "/api/health", { headers: { "x-real-ip": "198.19.255.254" }, signal: AbortSignal.timeout(10_000) });
    await r.text();
    return { ok: r.ok, status: r.status, ms: Math.round(performance.now() - t0) };
  } catch (e) { return { ok: false, status: "transport", ms: Math.round(performance.now() - t0) }; }
}
// Optional server-side sample: CPU share and RSS of the BAINK process (--pid).
let lastCpu = null;
async function processSample() {
  if (!args.pid) return null;
  try {
    const stat = (await readFile(`/proc/${args.pid}/stat`, "utf8")).split(") ")[1].split(" ");
    const ticks = Number(stat[11]) + Number(stat[12]), at = performance.now();
    const rss = Number((await readFile(`/proc/${args.pid}/status`, "utf8")).match(/VmRSS:\s+(\d+)/)[1]) * 1024;
    const prev = lastCpu; lastCpu = { ticks, at };
    return { cpu: prev ? Number(((ticks - prev.ticks) / 100 / ((at - prev.at) / 1000)).toFixed(2)) : null, rssMiB: Math.round(rss / 1048576) };
  } catch { return null; }
}
function degraded(now) {
  if (!baselineReview || !now || baselineReview.status !== 200) return null;
  for (const k of ["available", "brokerReady", "rootReady"]) if (baselineReview[k] && !now[k]) return `review health lost ${k}`;
  return null;
}

// ---- run -----------------------------------------------------------------
const runTag = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
let assetPath = "/";
let users = [];
async function main() {
  const startedAt = new Date().toISOString();
  // Discover one real JS asset from the page, as a browser would.
  try {
    const html = await (await fetch(target + "/", { headers: { "x-real-ip": "198.19.255.253" } })).text();
    assetPath = html.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0] ?? "/";
  } catch {}
  // Identities: members need registered keys. Kept in a 0600 file the caller owns.
  const memberCount = Math.round(maxUsers * memberShare);
  let ids = [];
  if (memberCount) {
    if (args.identities) { try { ids = JSON.parse(await readFile(args.identities, "utf8")); } catch {} }
    while (ids.length < memberCount) ids.push(newIdentity());
    if (args.identities) await writeFile(args.identities, JSON.stringify(ids), { mode: 0o600 });
  }
  users = Array.from({ length: maxUsers }, (_, i) => new SimUser(i, i % Math.round(1 / Math.max(memberShare, 1e-9)) === 0 && ids.length ? hydrate(ids.shift()) : null));
  const members = users.filter((u) => u.id);
  if (args.register) {
    let made = 0, existing = 0, refused = 0;
    let cursor = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (cursor < members.length) {
        const u = members[cursor++];
        const r = await call(u, "POST", "/api/account", { signed: true, body: { displayName: `Load test ${runTag.slice(0, 8)} #${u.index} (fictional)` }, route: "POST /api/account (register)" });
        if (r.status === 201) made++; else if (r.status === 200) existing++; else refused++;
      }
    }));
    console.log(JSON.stringify({ registered: { made, existing, refused } }));
  }
  baselineReview = await reviewFlags();
  console.log(JSON.stringify({ start: startedAt, target, origin: args.origin || null, steps, holdSeconds: holdMs / 1000, members: members.length, viewers: maxUsers - members.length, writes: writeShare, baselineReview }));
  const results = [];
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let healthFails = 0;
  for (const n of steps) {
    if (stopping) break;
    step = newStep(n);
    loop.reset();
    // Ramp: activate users evenly across --ramp seconds.
    const toStart = users.slice(0, n).filter((u) => !u.active);
    toStart.forEach((u, i) => setTimeout(() => { if (!stopping) { u.active = true; memberLoop(u); } }, (rampMs * i) / Math.max(1, toStart.length)));
    const until = performance.now() + rampMs + holdMs;
    while (performance.now() < until && !stopping) {
      await sleep(5000);
      const h = await targetHealth();
      const proc = await processSample();
      if (proc) (step.proc ??= []).push(proc);
      step.health.push(h);
      healthFails = h.ok ? 0 : healthFails + 1;
      if (healthFails >= 2) { stopping = true; step.stopped = "target /api/health failed twice"; }
      const errRate = step.calls >= 50 ? step.failed / Math.max(1, step.ok + step.failed) : 0;
      if (errRate > maxErrorRate) { stopping = true; step.stopped = `error rate ${(errRate * 100).toFixed(1)}% > ${maxErrorRate * 100}%`; }
      if (step.health.length % 2 === 0) {
        const rv = await reviewFlags();
        step.review = rv;
        const why = degraded(rv);
        if (why) { stopping = true; step.stopped = why; }
      }
    }
    step.endedAt = new Date().toISOString();
    step.eventLoopP99ms = Math.round(loop.percentile(99) / 1e6);
    const summary = summarize(step);
    results.push(summary);
    console.log(JSON.stringify({ step: summary.users, ok: summary.ok, failed: summary.failed, errorRate: summary.errorRate, rps: summary.rps, p50: summary.p50ms, p95: summary.p95ms, p99: summary.p99ms, stopped: summary.stopped }));
  }
  stopping = true;
  for (const u of users) u.active = false;
  await sleep(Math.min(timeoutMs, 5000));
  const report = { label: args.label || null, startedAt, endedAt: new Date().toISOString(), target, origin: args.origin || null, members: members.length, viewers: maxUsers - members.length, writeShare, thinkSeconds: thinkMs / 1000, holdSeconds: holdMs / 1000, rampSeconds: rampMs / 1000, baselineReview, finalReview: await reviewFlags(), steps: results };
  if (args.out) await writeFile(args.out, JSON.stringify(report, null, 2) + "\n");
  process.exit(0);
}
function summarize(s) {
  const seconds = (Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000;
  const byRoute = Object.fromEntries(Object.entries(s.byRoute).sort().map(([k, v]) => [k, { calls: v.calls, ok: v.ok, statuses: v.statuses, p50ms: pct(v.ms, 0.5), p95ms: pct(v.ms, 0.95), p99ms: pct(v.ms, 0.99) }]));
  return {
    users: s.users, startedAt: s.startedAt, endedAt: s.endedAt, seconds,
    calls: s.calls, actions: s.ok + s.failed, ok: s.ok, failed: s.failed, retries: s.retries,
    errorRate: Number((s.failed / Math.max(1, s.ok + s.failed)).toFixed(4)),
    rps: Number((s.calls / Math.max(1, seconds)).toFixed(1)),
    p50ms: pct(s.latency, 0.5), p95ms: pct(s.latency, 0.95), p99ms: pct(s.latency, 0.99),
    actionP95ms: pct(s.actionLatency, 0.95),
    statuses: s.statuses, refusals: s.refusals, transport: s.transport,
    healthP95ms: pct(s.health.map((h) => h.ms), 0.95), healthFailures: s.health.filter((h) => !h.ok).length,
    serverCpuMax: s.proc ? Math.max(...s.proc.map((p) => p.cpu ?? 0)) : null,
    serverCpuMean: s.proc ? Number((s.proc.filter((p) => p.cpu != null).reduce((a, p) => a + p.cpu, 0) / Math.max(1, s.proc.filter((p) => p.cpu != null).length)).toFixed(2)) : null,
    serverRssMaxMiB: s.proc ? Math.max(...s.proc.map((p) => p.rssMiB)) : null,
    review: s.review ?? null, eventLoopP99ms: s.eventLoopP99ms, stopped: s.stopped, byRoute,
  };
}
process.on("SIGINT", () => { stopping = true; console.log(JSON.stringify({ interrupted: true })); });
main().catch((e) => { console.error(e); process.exit(1); });

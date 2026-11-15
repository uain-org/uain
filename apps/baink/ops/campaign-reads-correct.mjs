#!/usr/bin/env node
/** One-off correction of the /go/<code> open counts (12 November 2026).
 *
 * Until BAINK 0.3.95 every view of /go/<code> was one read, link-preview bots and
 * crawlers included, and nothing about the reader was stored. The web server's
 * access log still holds each request's User-Agent, so the bot views of that
 * period can be moved from `reads` to `bots` with the same test the server now
 * applies to live traffic (isLinkBot in server/campaigns.mjs). The log is only
 * read; nothing from it is stored except the per-code numbers.
 *
 * Step 1, as a user that can read the log (prints a plan, touches no store):
 *   zcat -f /var/log/nginx/access.log* | node campaign-reads-correct.mjs plan \
 *     --release /opt/baink/current --before 2026-11-12T10:00:00Z > plan.json
 *   --before is when the release that counts bots apart started: later requests
 *   are already split by the server and must not be moved twice.
 *
 * Step 2, as the store owner (baink), with baink.service stopped (the service
 * holds the store's writer lock and this refuses while it runs):
 *   BAINK_DATA_DIR=/var/lib/baink node campaign-reads-correct.mjs apply \
 *     --release /opt/baink/current --plan plan.json [--apply]
 *   Dry run unless --apply. It runs once: a second run is refused.
 *
 * Only codes that have their own count are corrected. The shared "unknown" bucket
 * and deleted codes are left as counted, because the log cannot say which of
 * those requests were counted under which row.
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fail = (message) => { console.error(message); process.exit(1); };
function options(argv) {
  const out = { mode: argv[0], apply: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--apply") out.apply = true;
    else if (["--release", "--before", "--plan"].includes(argv[i])) out[argv[i].slice(2)] = argv[++i];
    else fail(`Unknown argument: ${argv[i]}`);
  }
  if (!["plan", "apply"].includes(out.mode) || !out.release) fail("Usage: campaign-reads-correct.mjs plan|apply --release <dir> ... (see the header)");
  return out;
}
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// nginx "combined": addr - user [12/Nov/2026:07:20:35 +0000] "GET /go/x HTTP/1.1" 200 123 "referer" "agent"
const LINE = /^\S+ \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\] "(GET|HEAD) (\S+)[^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"/;
const GO = /^(?:\/uain)?\/go\/([^/?]*)(?:\/llms\.txt)?\/?(?:\?.*)?$/;

/** Bot views per code among log lines before `before` (ms). Pure, for the test. */
export function planFromLines(lines, { before, isLinkBot, codePattern }) {
  const codes = {};
  let seen = 0, late = 0;
  for (const line of lines) {
    const m = LINE.exec(line);
    if (!m) continue;
    const [, d, mon, y, h, mi, sec, sign, oh, om, method, path, status, agent] = m;
    const go = GO.exec(path);
    // 502-504 never reached BAINK (the service was restarting), so they were not counted.
    if (!go || ["502", "503", "504"].includes(status)) continue;
    const offset = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60000;
    const at = Date.UTC(Number(y), MONTHS[mon], Number(d), Number(h), Number(mi), Number(sec)) - offset;
    if (at >= before) { late++; continue; }
    seen++;
    const code = codePattern.test(go[1]) ? go[1] : "unknown";
    const row = (codes[code] ??= { views: 0, bots: 0 });
    row.views++;
    if (isLinkBot({ "user-agent": agent }, method)) row.bots++;
  }
  return { seen, late, codes };
}

/** Move plan.codes[code].bots from reads to bots. Throws without changing anything if a number does not fit. */
export function correct(state, plan, at) {
  if (state.campaignReadsCorrection) throw new Error(`Already corrected at ${state.campaignReadsCorrection.at}.`);
  const deleted = new Set([...Object.values(state.campaignPosts ?? {}), ...Object.values(state.campaignReplies ?? {})].filter((p) => p?.deleted).map((p) => p.code));
  const moved = {}, skipped = {};
  for (const [code, row] of Object.entries(plan.codes)) {
    if (!row.bots) continue;
    const current = state.campaignReads?.[code];
    if (code === "unknown" || deleted.has(code) || !current) { skipped[code] = row.bots; continue; }
    if (row.bots > current.reads) throw new Error(`${code}: the log shows ${row.bots} bot views but only ${current.reads} reads are stored.`);
    // Bots the new release has already counted since it started stay; the old ones are added.
    moved[code] = { readsBefore: current.reads, reads: current.reads - row.bots, bots: (current.bots ?? 0) + row.bots, moved: row.bots };
  }
  for (const [code, m] of Object.entries(moved)) state.campaignReads[code] = { ...state.campaignReads[code], reads: m.reads, bots: m.bots };
  state.campaignReadsCorrection = { at, before: plan.before, moved: Object.fromEntries(Object.entries(moved).map(([code, m]) => [code, m.moved])) };
  return { moved, skipped };
}

async function main() {
  const opts = options(process.argv.slice(2));
  const server = (file) => import(pathToFileURL(join(opts.release, "server", file)).href);
  if (opts.mode === "plan") {
    const before = Date.parse(opts.before ?? "");
    if (!Number.isFinite(before)) fail("--before needs a time, for example 2026-11-12T10:00:00Z");
    const { isLinkBot, CAMPAIGN_CODE } = await server("campaigns.mjs");
    if (typeof isLinkBot !== "function") fail("This release does not count bots apart; use the release that does.");
    const lines = [];
    for await (const line of createInterface({ input: process.stdin })) if (line.includes("/go/")) lines.push(line);
    const plan = planFromLines(lines, { before, isLinkBot, codePattern: CAMPAIGN_CODE });
    process.stdout.write(JSON.stringify({ schema: "baink-campaign-reads-correction-v1", before: new Date(before).toISOString(), ...plan }, null, 1) + "\n");
    return;
  }
  const dataDir = process.env.BAINK_DATA_DIR;
  if (!dataDir || !opts.plan) fail("apply needs BAINK_DATA_DIR and --plan");
  const plan = JSON.parse(await readFile(opts.plan, "utf8"));
  if (plan.schema !== "baink-campaign-reads-correction-v1" || !plan.codes) fail("Not a correction plan.");
  const { loadStore } = await server("app.mjs");
  // Takes writer.lock exactly as the service does; refuses while it runs.
  const store = await loadStore(dataDir);
  try {
    const at = new Date().toISOString();
    const result = opts.apply
      ? await store.transact((state) => correct(state, plan, at))
      : correct(structuredClone({ campaignReads: store.read().campaignReads ?? {}, campaignPosts: store.read().campaignPosts ?? {}, campaignReplies: store.read().campaignReplies ?? {}, campaignReadsCorrection: store.read().campaignReadsCorrection }), plan, at);
    process.stdout.write(JSON.stringify({ applied: opts.apply, ...result }, null, 1) + "\n");
  } finally {
    await store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

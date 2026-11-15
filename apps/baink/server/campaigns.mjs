// Campaign pages: /go/<code> serves the current public llms.txt with a short
// intro for the place the link was posted, and tells the agent to pass
// --via <code> to the kit. The kit sends that code once, when it creates the
// BAINK account, so sign-ups can be counted per post without a referral
// parameter on the shared link. See docs/campaigns.md.
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";

export const CAMPAIGN_CODE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const UNKNOWN = "unknown";
const FLUSH_MS = 60_000;
const LLMS_TTL_MS = 30_000;
const UAIN_TTL_MS = 5 * 60_000;
const UAIN_RETRY_MS = 30_000;

export function loadCampaigns(file = new URL("./campaigns.json", import.meta.url)) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (parsed?.schema !== "baink-campaigns-v1" || !parsed.campaigns || typeof parsed.campaigns !== "object")
    throw new Error("campaigns.json must be a baink-campaigns-v1 file.");
  const campaigns = new Map();
  for (const [code, row] of Object.entries(parsed.campaigns)) {
    if (!CAMPAIGN_CODE.test(code) || code === UNKNOWN) throw new Error(`Invalid campaign code: ${code}`);
    if (typeof row?.label !== "string" || typeof row?.intro !== "string" || row.intro.length > 800)
      throw new Error(`Campaign ${code} needs a label and an intro of at most 800 characters.`);
    if (row.url !== undefined && (typeof row.url !== "string" || !/^https:\/\/[^\s"<>]{1,500}$/.test(row.url)))
      throw new Error(`Campaign ${code}: url must be an https link to the post.`);
    campaigns.set(code, { label: row.label, intro: row.intro.trim(), ...(row.url ? { url: row.url } : {}) });
  }
  return campaigns;
}

/** The guide for one campaign: an intro, then the public llms.txt with every
 * `uain-agent.mjs next` and `account --name "..."` carrying --via <code>. */
const seedPlatform = (code) => code.startsWith("rd-") ? "reddit" : code.startsWith("x-") ? "x" : code.startsWith("hn-") ? "hn" : "other";
const seedWhere = (label) => /r\/[A-Za-z0-9_]+/.exec(label)?.[0] ?? (/^X, (official BAINK|Aldi|Vignesh)/.exec(label) ? { "official BAINK": "@BAINK", Aldi: "Aldi", Vignesh: "Vignesh" }[/^X, (official BAINK|Aldi|Vignesh)/.exec(label)[1]] : /Show HN/.test(label) ? "Show HN" : "");
const DEFAULT_INTRO = "Follow the journey above from the shell. If you are a chat-only assistant that cannot run commands, tell the person to give this same link to an agent that can.";
export function campaignGuide(code, campaign, llmsText, { network = "baink" } = {}) {
  const via = ` --via ${code}`;
  const body = llmsText
    .replace(/uain-agent\.mjs next(?! --via)/g, `uain-agent.mjs next${via}`)
    .replace(/(account --name "[^"\n]*")(?! --via)/g, `$1${via}`);
  return [
    body.replace(/\n+$/, ""),
    "",
    "---",
    "",
    `## Started from: ${campaign.label}`,
    "",
    campaign.intro,
    "",
    `Campaign code: ${code}. Pass --via ${code} the first time you run the kit`,
    `(node uain-agent.mjs next --via ${code}); the kit remembers it and sends it`,
    `once, when it creates the ${network === "uain" ? "member" : "BAINK"} account. It only counts which post brought`,
    "people here; it changes nothing else and earns nobody anything.",
    "",
  ].join("\n");
}

export const PLATFORMS = ["x", "reddit", "hn", "linkedin", "other"];
export const STATUSES = ["draft", "ready", "posted"];
export const REPLY_STATUSES = ["new", "replied", "skipped"];
const POSTS_MAX = 2000;
const REPLIES_MAX = 5000;
const PREFIX = { x: "x", reddit: "rd", hn: "hn", linkedin: "li", other: "post" };
const clean = (v, max, name, { optional = false } = {}) => {
  if (v === undefined || v === null || v === "") { if (optional) return ""; throw Object.assign(new Error(`${name} is required.`), { status: 400, code: "invalid_post" }); }
  if (typeof v !== "string") throw Object.assign(new Error(`${name} must be text.`), { status: 400, code: "invalid_post" });
  const t = v.replace(/\r\n/g, "\n").trim();
  if (t.length > max) throw Object.assign(new Error(`${name} is at most ${max} characters.`), { status: 400, code: "invalid_post" });
  return t;
};
/** Turns form/API input into a stored post's editable fields. */
export function postFields(input, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.hasOwn(input, k);
  if (!partial || has("platform")) {
    if (!PLATFORMS.includes(input.platform)) throw Object.assign(new Error(`Platform is one of ${PLATFORMS.join(", ")}.`), { status: 400, code: "invalid_post" });
    out.platform = input.platform;
  }
  if (!partial || has("label")) out.label = clean(input.label, 120, "Name");
  if (!partial || has("where")) out.where = clean(input.where, 120, "Where", { optional: true });
  if (!partial || has("title")) out.title = clean(input.title, 300, "Title", { optional: true });
  if (!partial || has("body")) out.body = clean(input.body, 10000, "Post text", { optional: true });
  if (!partial || has("intro")) out.intro = clean(input.intro, 800, "Intro for agents", { optional: true });
  if (!partial || has("notes")) out.notes = clean(input.notes, 2000, "Notes", { optional: true });
  if (has("url") || !partial) {
    const url = clean(input.url, 500, "Post URL", { optional: true });
    if (url && !/^https:\/\/[^\s"<>]+$/.test(url)) throw Object.assign(new Error("Post URL must be an https link."), { status: 400, code: "invalid_post" });
    out.url = url;
  }
  if (has("status")) {
    if (!STATUSES.includes(input.status)) throw Object.assign(new Error(`Status is one of ${STATUSES.join(", ")}.`), { status: 400, code: "invalid_post" });
    out.status = input.status;
  }
  return out;
}
const httpsUrl = (value, name, code = "invalid_post") => {
  if (!/^https:\/\/[^\s"<>]+$/.test(value)) throw Object.assign(new Error(`${name} must be an https link.`), { status: 400, code });
  return value;
};
/** Fields of a reply (a thread by someone else worth answering). */
export function replyFields(input) {
  if (!PLATFORMS.includes(input.platform)) throw Object.assign(new Error(`Platform is one of ${PLATFORMS.join(", ")}.`), { status: 400, code: "invalid_post" });
  return {
    platform: input.platform,
    threadUrl: httpsUrl(clean(input.threadUrl, 500, "Thread URL"), "Thread URL"),
    threadTitle: clean(input.threadTitle, 300, "Thread title"),
    where: clean(input.where, 120, "Where", { optional: true }),
    threadInfo: clean(input.threadInfo, 120, "Thread age and comments", { optional: true }),
    why: clean(input.why, 300, "Why it fits", { optional: true }),
    draft: clean(input.draft, 10000, "Draft reply", { optional: true }),
    intro: clean(input.intro, 800, "Intro for agents", { optional: true }),
  };
}
/** The same thread written differently is one thread: lowercase host, reddit hosts folded,
 * no query, hash or trailing slash. */
export function threadKey(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (/(^|\.)reddit\.com$/.test(host)) host = "reddit.com";
    if (host === "twitter.com" || host === "mobile.twitter.com" || host === "mobile.x.com") host = "x.com";
    return `${host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch { return String(url).toLowerCase(); }
}
const replyIntro = (where) => `The person came from a reply on ${where || "a forum thread"} by a BAINK team member. Explain in plain words what you will do on their behalf, then follow the journey above.`;

/** A free code from a base: rd-localllama, rd-localllama-02, ... */
export function nextCode(base, taken) {
  const root = String(base).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 34) || "post";
  if (!taken.has(root) && root !== UNKNOWN) return root;
  for (let n = 2; n < 1000; n++) { const code = `${root}-${String(n).padStart(2, "0")}`; if (!taken.has(code)) return code; }
  throw Object.assign(new Error("No free code for this name."), { status: 409, code: "code_exhausted" });
}

export function createCampaigns({ store, llmsFile, uainLlms, campaigns: seeds = loadCampaigns(), now = Date.now, onError } = {}) {
  // Codes from campaigns.json (seeds) plus posts created in /admin (state.campaignPosts).
  // A stored post with a seed's code overrides that seed.
  // Replies (state.campaignReplies) share the code space and the /go/ guide with posts.
  const replyLabel = (r) => `Reply: ${r.threadTitle}`;
  const campaigns = {
    // A deleted post is a tombstone: not a campaign any more, but its code stays taken.
    get(code) {
      const r = store.read().campaignReplies?.[code];
      if (r) return r.deleted ? undefined : { label: replyLabel(r), intro: r.intro || replyIntro(r.where), url: r.replyUrl || null, kind: "reply" };
      const p = store.read().campaignPosts?.[code]; if (p?.deleted) return undefined; return p ? { label: p.label, intro: p.intro || seeds.get(code)?.intro || DEFAULT_INTRO, url: p.url || null } : seeds.get(code);
    },
    has(code) { const r = store.read().campaignReplies?.[code]; if (r) return !r.deleted; const p = store.read().campaignPosts?.[code]; return p ? !p.deleted : seeds.has(code); },
    keys() {
      const stored = store.read().campaignPosts ?? {}, replies = store.read().campaignReplies ?? {};
      return [...new Set([...seeds.keys(), ...Object.keys(stored), ...Object.keys(replies)])].filter((code) => !stored[code]?.deleted && !replies[code]?.deleted);
    },
  };
  const takenCodes = (state) => new Set([...seeds.keys(), ...Object.keys(state.campaignPosts ?? {}), ...Object.keys(state.campaignReplies ?? {})]);
  let llms = null; // { text, mtimeMs, checkedAt }
  async function llmsText() {
    if (llms && now() - llms.checkedAt < LLMS_TTL_MS) return llms.text;
    const info = await stat(llmsFile);
    if (!llms || info.mtimeMs !== llms.mtimeMs) llms = { text: await readFile(llmsFile, "utf8"), mtimeMs: info.mtimeMs, checkedAt: now() };
    else llms.checkedAt = now();
    return llms.text;
  }
  // The UAIN guide for uain.global/go/<code> (proxied to /uain/go/<code>): uain.global's own
  // llms.txt, fetched and kept for 5 minutes. The last good copy is kept when a fetch fails;
  // with none yet, the BAINK guide answers instead, so the link never breaks.
  let uain = null; // { text, at }
  let uainPending = null;
  async function uainText() {
    if (!uainLlms) return llmsText();
    if (uain && now() - uain.at < UAIN_TTL_MS) return uain.text;
    uainPending ??= (async () => {
      try {
        const text = await uainLlms();
        if (typeof text === "string" && text.startsWith("# ")) uain = { text, at: now() };
        else throw new Error("UAIN llms.txt did not look like the guide.");
      } catch (error) {
        onError?.(Object.assign(error, { code: error.code ?? "uain_llms_unavailable" }));
        if (uain) uain.at = now() - UAIN_TTL_MS + UAIN_RETRY_MS;
      } finally { uainPending = null; }
    })();
    await uainPending;
    return uain?.text ?? llmsText();
  }
  // Reads are counted in memory and written at most once a minute: the page is
  // public and unauthenticated, so it never writes the store per request. Only
  // known codes and one "unknown" bucket are kept, so the counts stay bounded.
  // Nothing about the reader (address, agent) is kept: a view adds one to `reads`
  // (a person or an agent) or to `bots` (isLinkBot), and that is all.
  let pending = new Map();
  const add = (map, key, reads, bots) => { const row = map.get(key) ?? { reads: 0, bots: 0 }; map.set(key, { reads: row.reads + reads, bots: row.bots + bots }); };
  async function flush() {
    if (!pending.size) return;
    const batch = pending;
    pending = new Map();
    try {
      await store.transact((state) => {
        state.campaignReads ??= {};
        for (const [code, count] of batch) {
          const row = state.campaignReads[code] ?? { reads: 0, firstAt: null, lastAt: null };
          state.campaignReads[code] = { ...row, reads: row.reads + count.reads, bots: (row.bots ?? 0) + count.bots, firstAt: row.firstAt ?? new Date(now()).toISOString(), lastAt: new Date(now()).toISOString() };
        }
      });
    } catch (error) {
      for (const [code, count] of batch) add(pending, code, count.reads, count.bots);
      onError?.(error);
    }
  }
  const timer = setInterval(() => { flush(); }, FLUSH_MS);
  timer.unref?.();

  return {
    known: (code) => campaigns.has(code),
    /** Text for GET /go/<code>; an unknown or malformed code gets the plain guide. */
    async page(rawCode) {
      return (await this.view(rawCode)).text;
    },
    /** One counted view: { code (null when unknown), campaign, text }. Text and HTML views share it.
     * network "uain": the same code and count, with uain.global's llms.txt as the guide.
     * bot: a link-preview or crawler view (isLinkBot); it is counted apart and is not an open. */
    async view(rawCode, { network = "baink", bot = false } = {}) {
      const code = typeof rawCode === "string" && CAMPAIGN_CODE.test(rawCode) && campaigns.has(rawCode) ? rawCode : null;
      const key = code ?? UNKNOWN;
      add(pending, key, bot ? 0 : 1, bot ? 1 : 0);
      const llms = network === "uain" ? await uainText() : await llmsText();
      const campaign = code ? campaigns.get(code) : null;
      return { code, campaign, text: code ? campaignGuide(code, campaign, llms, { network }) : llms };
    },
    /** A code sent at account creation: kept only when it is a known campaign. */
    accept(via) {
      if (via === undefined || via === null) return null;
      if (typeof via !== "string" || !CAMPAIGN_CODE.test(via)) return UNKNOWN;
      return campaigns.has(via) ? via : UNKNOWN;
    },
    /** Funnel per code: page reads, accounts, enrolled, first accepted task, first spend.
     * acceptedTask(address) answers true/false/null (null: could not be read). */
    async report({ acceptedTask } = {}) {
      await flush();
      const state = store.read();
      const rows = new Map();
      const row = (code) => {
        if (!rows.has(code)) rows.set(code, { code, kind: campaigns.get(code)?.kind ?? "post", label: campaigns.get(code)?.label ?? (code === UNKNOWN ? "Unknown or mistyped code" : code), url: campaigns.get(code)?.url ?? null, reads: 0, bots: 0, accounts: 0, enrolled: 0, acceptedTask: 0, acceptedTaskUnknown: 0, spent: 0 });
        return rows.get(code);
      };
      const deleted = new Set([...Object.values(state.campaignPosts ?? {}), ...Object.values(state.campaignReplies ?? {})].filter((p) => p?.deleted).map((p) => p.code));
      for (const code of campaigns.keys()) row(code);
      for (const [code, value] of Object.entries(state.campaignReads ?? {})) if (!deleted.has(code)) { row(code).reads = value.reads; row(code).bots = value.bots ?? 0; }
      const enrolled = new Set(Object.values(state.nativeIntents ?? {}).filter((i) => i?.status === "finalized" || i?.activation?.verified === true).map((i) => i.member));
      const spent = new Set([
        ...Object.values(state.serverSendIntents ?? {}).filter((s) => s?.status === "finalized").map((s) => s.intent?.from),
        ...Object.values(state.nativePaymentIntents ?? {}).filter((p) => ["ledger-recorded", "recipient-confirmed-paid"].includes(p?.status)).map((p) => p.payer),
      ]);
      // Accounts keep their via; a deleted post's row is just not shown.
      const attributed = Object.values(state.accounts ?? {}).filter((a) => typeof a?.via === "string" && !deleted.has(a.via));
      const answers = await Promise.all(attributed.map(async (a) => {
        if (typeof acceptedTask !== "function") return null;
        try { return await acceptedTask(a.address); } catch { return null; }
      }));
      attributed.forEach((account, i) => {
        const r = row(account.via);
        r.accounts++;
        if (enrolled.has(account.address)) r.enrolled++;
        if (answers[i] === true) r.acceptedTask++;
        else if (answers[i] === null) r.acceptedTaskUnknown++;
        if (spent.has(account.address)) r.spent++;
      });
      return {
        generatedAt: new Date(now()).toISOString(),
        note: "reads: /go/<code> opens by people and agents (no reader data kept). bots: link-preview and crawler views, and header-only requests, left out of reads. accounts: BAINK accounts created with that code. enrolled: finalized UAIN enrolment through BAINK. acceptedTask: public Karma above 0 on uain.global. spent: a finalized payment sent through BAINK.",
        campaigns: [...rows.values()],
      };
    },
    /** Posts for /admin: stored posts plus seeds not yet stored, newest first. */
    posts() {
      const stored = store.read().campaignPosts ?? {};
      const list = Object.values(stored).filter((p) => !p.deleted);
      for (const [code, seed] of seeds) if (!stored[code]) list.push({ code, platform: seedPlatform(code), label: seed.label, where: seedWhere(seed.label), title: "", body: "", intro: seed.intro, notes: "", url: seed.url ?? "", status: seed.url ? "posted" : "ready", seed: true, createdAt: null, updatedAt: null, createdBy: "campaigns.json" });
      return list.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || a.code.localeCompare(b.code));
    },
    post(code) { return this.posts().find((p) => p.code === code) ?? null; },
    /** New post; the code is made from codeBase (or platform + where) and never changes. */
    async createPost(input, { by, status = "draft" } = {}) {
      const fields = postFields({ ...input, status });
      return store.transact((state) => {
        state.campaignPosts ??= {};
        if (Object.keys(state.campaignPosts).length >= POSTS_MAX) throw Object.assign(new Error("Post capacity reached."), { status: 429, code: "capacity" });
        const taken = takenCodes(state);
        const prefix = PREFIX[fields.platform];
        const base = input.codeBase ? String(input.codeBase) : `${prefix}-${fields.where || fields.label}`;
        const code = nextCode(base, taken);
        const at = new Date(now()).toISOString();
        const post = { code, ...fields, createdAt: at, updatedAt: at, createdBy: by };
        state.campaignPosts[code] = post;
        return post;
      });
    },
    /** Edit a post. A seed is copied into the store on its first edit. The code never changes. */
    async updatePost(code, input, { by } = {}) {
      const fields = postFields(input, { partial: true });
      return store.transact((state) => {
        state.campaignPosts ??= {};
        let current = state.campaignPosts[code];
        if (current?.deleted) throw Object.assign(new Error("No such post."), { status: 404, code: "post_missing" });
        if (!current) {
          const seed = seeds.get(code);
          if (!seed) throw Object.assign(new Error("No such post."), { status: 404, code: "post_missing" });
          current = { code, platform: seedPlatform(code), label: seed.label, where: seedWhere(seed.label), title: "", body: "", intro: seed.intro, notes: "", url: seed.url ?? "", status: "ready", createdAt: new Date(now()).toISOString(), createdBy: "campaigns.json" };
        }
        const next = { ...current, ...fields, updatedAt: new Date(now()).toISOString(), updatedBy: by };
        if (next.status === "posted" && !next.url) throw Object.assign(new Error("Add the post URL when it is posted."), { status: 400, code: "invalid_post" });
        state.campaignPosts[code] = next;
        return next;
      });
    },
    /** Soft delete: the post stays as a tombstone so its code is never reused; its /go/ link
     * serves the plain guide and it leaves Posts and Numbers. A seed gets a tombstone too. */
    async deletePost(code, { by } = {}) {
      return store.transact((state) => {
        state.campaignPosts ??= {};
        const current = state.campaignPosts[code];
        if ((!current && !seeds.has(code)) || current?.deleted) throw Object.assign(new Error("No such post."), { status: 404, code: "post_missing" });
        const at = new Date(now()).toISOString();
        const base = current ?? { code, label: seeds.get(code).label, createdBy: "campaigns.json" };
        state.campaignPosts[code] = { ...base, deleted: true, deletedAt: at, deletedBy: by, updatedAt: at };
        return state.campaignPosts[code];
      });
    },
    /** Replies for /admin, newest first. */
    replies() {
      return Object.values(store.read().campaignReplies ?? {}).filter((r) => !r.deleted)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.code.localeCompare(b.code));
    },
    reply(code) { const r = store.read().campaignReplies?.[code]; return r && !r.deleted ? r : null; },
    /** A thread already added (any status, deleted included): the same thread is never added twice. */
    replyForThread(url) {
      const key = threadKey(url);
      return Object.values(store.read().campaignReplies ?? {}).find((r) => r.threadKey === key) ?? null;
    },
    /** New reply, status new, with its own code: rd-reply-01, rd-reply-02, ... */
    async createReply(input, { by } = {}) {
      const fields = replyFields(input);
      const key = threadKey(fields.threadUrl);
      return store.transact((state) => {
        state.campaignReplies ??= {};
        const existing = Object.values(state.campaignReplies).find((r) => r.threadKey === key);
        if (existing) throw Object.assign(new Error(`This thread was already added (${existing.code}, ${existing.deleted ? "deleted" : existing.status}).`), { status: 409, code: "reply_exists", existing: existing.code });
        if (Object.keys(state.campaignReplies).length >= REPLIES_MAX) throw Object.assign(new Error("Reply capacity reached."), { status: 429, code: "capacity" });
        const taken = takenCodes(state), prefix = `${PREFIX[fields.platform]}-reply`;
        let code = null;
        for (let n = 1; n < 10000 && !code; n++) { const c = `${prefix}-${String(n).padStart(2, "0")}`; if (!taken.has(c)) code = c; }
        if (!code) throw Object.assign(new Error("No free reply code."), { status: 409, code: "code_exhausted" });
        const at = new Date(now()).toISOString();
        const reply = { code, ...fields, threadKey: key, status: "new", replyUrl: "", createdAt: at, updatedAt: at, createdBy: by };
        state.campaignReplies[code] = reply;
        return reply;
      });
    },
    /** Mark a reply replied (needs the URL of the comment) or skipped. */
    async setReplyStatus(code, { status, replyUrl } = {}, { by } = {}) {
      if (!REPLY_STATUSES.includes(status)) throw Object.assign(new Error(`Status is one of ${REPLY_STATUSES.join(", ")}.`), { status: 400, code: "invalid_post" });
      const url = clean(replyUrl, 500, "Reply URL", { optional: true });
      if (status === "replied") { if (!url) throw Object.assign(new Error("Paste the URL of your reply first."), { status: 400, code: "invalid_post" }); httpsUrl(url, "Reply URL"); }
      return store.transact((state) => {
        const current = state.campaignReplies?.[code];
        if (!current || current.deleted) throw Object.assign(new Error("No such reply."), { status: 404, code: "post_missing" });
        const next = { ...current, status, replyUrl: status === "replied" ? url : current.replyUrl, updatedAt: new Date(now()).toISOString(), updatedBy: by };
        state.campaignReplies[code] = next;
        return next;
      });
    },
    flush,
    close: async () => { clearInterval(timer); await flush(); },
  };
}

/** uain.global's llms.txt, the guide behind uain.global/go/<code>. */
export function uainLlmsReader(origin = "https://uain.global", { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  return async () => {
    const response = await fetchImpl(`${origin}/llms.txt`, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "baink-go/1 (uain.global/go guide)", Accept: "text/plain" } });
    if (!response.ok) throw Object.assign(new Error(`uain.global/llms.txt answered ${response.status}.`), { code: "uain_llms_unavailable" });
    const text = await response.text();
    if (text.length > 200_000) throw Object.assign(new Error("uain.global/llms.txt is too large."), { code: "uain_llms_unavailable" });
    return text;
  };
}

/** Accepted task = public Karma above 0 (every accepted AI$ award also gives Karma). */
export function karmaReader({ origin = "https://uain.global", fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const cache = new Map();
  return async (address) => {
    const hit = cache.get(address);
    if (hit === true) return true;
    if (hit && Date.now() - hit < 60_000) return false;
    const response = await fetchImpl(`${origin}/api/members/${address}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 404) { cache.set(address, Date.now()); return false; }
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.address !== address || !Number.isFinite(Number(body.karma))) return null;
    const accepted = Number(body.karma) > 0;
    cache.set(address, accepted ? true : Date.now());
    return accepted;
  };
}

// ---- Who opened /go/<code> (docs/campaigns.md, "What counts as an open").
// A post's link is fetched by the platform's preview bot and by crawlers within seconds of
// posting, before any person sees it. Those views are counted apart. Agents and their fetchers
// are the audience and always count, even where their User-Agent holds the word "bot"
// (ChatGPT-User sends "+https://openai.com/bot"), so they are checked first.
const READER_AGENT = /(Claude-User|claude-code|ChatGPT-User|MistralAI-User|Perplexity-User|DuckAssistBot|Google-Agent|Gemini|codex|uain-agent)/i;
// A name ending in "bot" followed by a version or separator (Twitterbot/1.0, Googlebot-Image,
// trendictionbot0.5.0), so a phone model such as "CUBOT NOTE" is not caught; then the preview
// fetchers and crawlers that do not call themselves a bot ("Mozilla / 5.0", with spaces, is a
// scraper seen on 12 November 2026; no browser writes it that way).
const LINK_BOT = /(bot(?:[\/;)\d-]|$)|Slackbot|TelegramBot|crawler|spider|scraper|facebookexternalhit|facebookcatalog|WhatsApp|Slack-ImgProxy|SkypeUriPreview|BingPreview|Google-InspectionTool|Mediapartners-Google|embedly|iframely|Cardyb|trendiction|dataminr|^Anthill$|ia_archiver|Yahoo! Slurp|GoogleOther|Google-Extended|FeedFetcher-Google|Google-Read-Aloud|^Mozilla \/ 5\.0)/i;
/** True for a link-preview or crawler view, and for a header-only (HEAD) request, which reads nothing. */
export function isLinkBot(headers = {}, method = "GET") {
  if (method === "HEAD") return true;
  const agent = String(headers["user-agent"] ?? "");
  if (headers["signature-agent"] || READER_AGENT.test(agent)) return false;
  return LINK_BOT.test(agent);
}

// ---- Browser view of /go/<code> (docs/campaigns.md, "People and agents").
// Only a clear browser navigation gets HTML; every fetcher that names itself, or signs as an
// agent, gets the text guide. Browser-driving agents that look like people (anonymous Grok,
// headless renders) still get everything: the HTML page carries the full guide.
const AGENT_UA = /(Claude-User|ClaudeBot|anthropic|ChatGPT-User|OAI-SearchBot|GPTBot|MistralAI-User|DuckAssistBot|Perplexity|Google-Agent|Gemini|bot\b|crawler|spider|curl|wget|python|node-fetch|undici|axios|httpie|uain-agent)/i;
export function wantsHtml(headers = {}) {
  const accept = String(headers.accept ?? "");
  const mode = String(headers["sec-fetch-mode"] ?? ""), dest = String(headers["sec-fetch-dest"] ?? "");
  if (!(mode === "navigate" || dest === "document")) return false;
  if (headers["signature-agent"] || AGENT_UA.test(String(headers["user-agent"] ?? ""))) return false;
  // Accept must prefer text/html: it is listed, and before any text/markdown or text/plain.
  const types = accept.split(",").map((part) => {
    const [type, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return { type: type.trim(), q: q ? Number(q.slice(2)) : 1 };
  });
  const q = (t) => Math.max(-1, ...types.filter((x) => x.type === t).map((x) => x.q));
  const html = q("text/html");
  return html > 0 && html >= q("text/markdown") && html >= q("text/plain");
}

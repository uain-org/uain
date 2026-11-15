/**
 * Verify the UAIN event ledger from outside, trusting nothing but the maths.
 *
 *   LEDGER_PUBLIC_KEY_FILE=ledger-public.pem UAIN_API=https://uain.global \
 *     node scripts/verify-ledger.mjs
 *
 * 1. Pages every event by cursor and checks the hash chain (docs/ledger.md):
 *    each entry's prev_hash is the previous entry's hash, and
 *    - an entry of hash_version 1 (written before version 2) that is not
 *      redacted hashes to sha256(prev_hash + "\n" + JSON.stringify([id, at,
 *      kind, actor, peer, summary]));
 *    - every entry of hash_version 2, redacted or not, hashes to
 *      sha256(prev_hash + "\n" + JSON.stringify([2, id, at, kind, actor, peer,
 *      content_digest, the previous entry's hash_version or null])), where
 *      content_digest is sha256(salt + "\n" + JSON.stringify([summary,
 *      commits])); a redacted one carries the fixed marker as its summary, and
 *      neither commits nor salt.
 * 2. For each version 2 entry whose commits is "<subject> sha256:<digest>",
 *    fetches the research record the subject names and recomputes the digest:
 *    a contribution or a check of one, a claim revision or a review of one,
 *    and from 29 September 2026 a task or project opened on a prior-art
 *    basis, and a challenge that a task is already solved and its decision;
 *    from 30 September 2026 a wallet address bound to a member, with its
 *    message and signature, and its removal, and how a future-solvable
 *    task's KPI resolved; and the benevolence class a task or project was
 *    opened with, and a flag that work is malevolent and its decision.
 * 3. Recomputes every completed UTC day's Merkle root from those hashes and
 *    checks its Ed25519 signature against a pinned key: the PEM in
 *    LEDGER_PUBLIC_KEY_FILE (or key.json from the ledger-roots branch), or in
 *    LEDGER_PUBLIC_KEY_PEM, as the ledger-root workflow pins it. It fails if
 *    the server signs with any other key.
 *    Without a pin it uses the key the server serves, and warns that this
 *    proves only that the server agrees with itself. It also fails if a
 *    completed day that has entries has no root at all.
 *
 * Deliberately has no dependencies and does not import the server's code, so
 * it checks the published rules rather than the implementation.
 * Exits non-zero on any failure.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = (process.env.UAIN_API ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const GENESIS = '0'.repeat(64);
const REDACTED = '[redacted: participant record purged by the operator]';

const get = async (path, { missing = false } = {}) => {
  for (;;) {
    const r = await fetch(`${API}${path}`);
    // A long ledger is more requests than a minute's allowance; wait it out.
    if (r.status === 429) {
      await new Promise((ok) => setTimeout(ok, 1000 * Number(r.headers.get('retry-after') ?? 5)));
      continue;
    }
    if (missing && r.status === 404) return null;
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }
};

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const shaBytes = (b) => createHash('sha256').update(b).digest();
// Keys sorted at every level, as the server's evidenceDigest has them.
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
      : v;
const digestOf = (record) => sha256hex(JSON.stringify(canonical({ version: 1, ...record })));

function merkleRoot(leaves) {
  if (leaves.length === 0) return null;
  let level = leaves.map((h) => Buffer.from(h, 'hex'));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(shaBytes(Buffer.concat([level[i], level[i + 1] ?? level[i]])));
    level = next;
  }
  return level[0].toString('hex');
}

const failures = [];
const fail = (msg) => failures.push(msg);

// 1. The chain.
const events = [];
let cursor = 0;
for (;;) {
  const page = await get(`/api/events?after_id=${cursor}&limit=200`);
  events.push(...page.events);
  if (page.events.length < 200) break;
  cursor = page.cursor;
}

let prev = GENESIS;
let prevVersion = null;
let legacyRedacted = 0;
let redacted = 0;
for (const e of events) {
  const version = Number(e.hash_version ?? 1);
  if (e.prev_hash !== prev) fail(`#${e.id}: prev_hash does not link to the previous entry`);
  if (version === 2) {
    if (e.redacted) {
      redacted += 1;
      if (e.summary !== REDACTED || e.salt != null || e.commits != null)
        fail(`#${e.id}: redacted, but carries more than the redaction marker`);
    } else if (
      e.salt == null ||
      sha256hex(`${e.salt}\n${JSON.stringify([e.summary, e.commits ?? null])}`) !== e.content_digest
    )
      fail(`#${e.id}: summary or commits does not match its digest`);
    const content = JSON.stringify([2, e.id, e.at, e.kind, e.actor, e.peer ?? null, e.content_digest ?? null, prevVersion]);
    if (sha256hex(`${e.prev_hash}\n${content}`) !== e.hash) fail(`#${e.id}: content does not match its hash`);
  } else if (version !== 1) {
    fail(`#${e.id}: unknown hash_version ${e.hash_version}`);
  } else if (e.redacted) {
    legacyRedacted += 1;
  } else {
    const content = JSON.stringify([e.id, e.at, e.kind, e.actor, e.peer ?? null, e.summary]);
    if (sha256hex(`${e.prev_hash}\n${content}`) !== e.hash)
      fail(`#${e.id}: content does not match its hash`);
  }
  prev = e.hash;
  prevVersion = version;
}

const head = await get('/api/ledger/head');
if (events.length && head.hash !== prev) fail('head reported by the server is not the end of the chain');

// 2. The research records version 2 entries commit to. A claim revision's
// sources grow in place as later work supports it, and each entry that adds
// one commits the revision again, so only its latest commitment must match.
const TAG = /^(?:(RC-\d+)( check)?|(CL-\d+) revision (\d+)( review)?) sha256:([0-9a-f]{64})$/;
// The novelty rule's records: a task or project as opened, with its prior-art
// basis, and a challenge that a task is already solved, and its decision.
// And how a future-solvable task's KPI resolved (decision D7).
const OPENED =
  /^(?:(T-\d+)(?: challenge (\d+)( decision)?| (kpi resolution))?|project ([a-z0-9-]+)) sha256:([0-9a-f]{64})$/;
// A flag that a project or task is malevolent, and its decision.
const FLAGGED = /^benevolence flag (\d+)( decision)? sha256:([0-9a-f]{64})$/;
// The class a task or project was declared with at opening: only a
// declaration has a statement, and a record without one commits no key.
const declared = (b) =>
  b?.statement ? { benevolence: { class: b.declared ?? b.class, statement: b.statement } } : {};
const contributions = new Map();
const claims = new Map();
const tasks = new Map();
const task = async (id) => {
  if (!tasks.has(id)) tasks.set(id, await get(`/api/tasks/${id}`, { missing: true }));
  return tasks.get(id);
};
const contribution = async (id) => {
  if (!contributions.has(id)) contributions.set(id, await get(`/api/contributions/${id}`, { missing: true }));
  return contributions.get(id);
};
const claim = async (id) => {
  if (!claims.has(id)) claims.set(id, await get(`/api/claims/${id}`, { missing: true }));
  return claims.get(id);
};
// A wallet address bound to a member, with the message and signature that
// prove it, and its removal (decision D6, 30 September 2026).
const WALLET = /^wallet (\d+)( unbind)? sha256:([0-9a-f]{64})$/;
const revisions = new Map();
const tagged = [];
const opened = [];
const wallets = [];
const flagged = [];
for (const e of events) {
  if (Number(e.hash_version ?? 1) !== 2 || e.redacted || e.commits == null) continue;
  const m = TAG.exec(e.commits);
  if (!m && OPENED.test(e.commits)) {
    opened.push(e);
    continue;
  }
  if (!m && WALLET.test(e.commits)) {
    wallets.push(e);
    continue;
  }
  if (!m && FLAGGED.test(e.commits)) {
    flagged.push(e);
    continue;
  }
  if (!m) {
    fail(`#${e.id}: commits names no record this script knows: ${e.commits}`);
    continue;
  }
  if (m[3] && !m[5]) revisions.set(`${m[3]} revision ${m[4]}`, e);
  else tagged.push(e);
}
tagged.push(...revisions.values());

let recordsChecked = 0;
for (const e of tagged) {
  const [, rc, check, cl, rev, review, digest] = TAG.exec(e.commits);
  const subject = rc ? `${rc}${check ?? ''}` : `${cl} revision ${rev}${review ?? ''}`;
  let record = null;
  if (rc) {
    const c = await contribution(rc);
    if (c && !check)
      record = {
        record: 'contribution', id: c.id, project_id: c.project_id, contributor: c.contributor,
        kind: c.kind, title: c.title, detail: c.detail, task_id: c.task_id ?? null,
        reconciles: c.reconciles, karma_claimed: c.karma_claimed,
        verifiers_required: c.verifiers_required, artifacts: c.artifacts,
        reproduction: c.reproduction ?? null, claim_statement: c.claim_statement ?? null,
        evidence: c.evidence ?? null, sources: c.sources, source_checks: c.source_checks,
        forecast: c.forecast ?? null, meta: c.meta ?? null, submitted_at: c.submitted_at,
      };
    const v = check && c?.verifications.find((x) => x.verifier === e.actor);
    // The judgement this entry made, if any, carries the entry's id.
    const j = v && (v.against_claim_history ?? []).find((x) => x.event_id === e.id);
    if (v)
      record = {
        record: 'check', contribution_id: v.contribution_id, verifier: v.verifier,
        verdict: v.verdict, note: v.note, at: v.at, excluded: v.excluded,
        revised_claim: v.revised_claim ?? null, reproduction_receipt: v.reproduction_receipt ?? null,
        // A bootstrap arbitration (from 30 September 2026), only when it is one.
        ...(v.bootstrap === true ? { bootstrap: true } : {}),
        judgement: j ? { revision: j.revision, relation: j.relation, note: j.note, at: j.at } : null,
        // The novelty attestation, only on the entry that made it.
        ...(v.novelty_event_id != null && v.novelty_event_id === e.id
          ? {
              novelty: {
                novelty: v.novelty, checked: v.novelty_checked ?? null,
                known_source: v.known_source ?? null, note: v.novelty_note ?? null,
              },
            }
          : {}),
      };
  } else {
    const c = await claim(cl);
    const r = c?.history.find((x) => x.revision === Number(rev));
    if (r && !review)
      record = {
        record: 'claim_revision', claim_id: c.id, revision: r.revision, base: r.base ?? null,
        action: r.action, statement: r.statement, sources: r.sources.map((s) => s.id),
        reason: r.reason, author: r.author, at: r.at,
      };
    const rv = review && r?.reviews.find((x) => x.reviewer === e.actor);
    if (rv)
      record = {
        record: 'claim_review', claim_id: c.id, revision: r.revision, reviewer: rv.reviewer,
        verdict: rv.verdict, note: rv.note, at: rv.at,
      };
  }
  if (!record) fail(`#${e.id}: commits to ${subject}, which the server does not serve`);
  else if (digestOf(record) !== digest) fail(`#${e.id}: ${subject} does not match the digest its entry committed`);
  else recordsChecked += 1;
}

for (const e of opened) {
  const [, tid, challengeId, decision, resolution, pid, digest] = OPENED.exec(e.commits);
  const subject = e.commits.split(' sha256:')[0];
  let record = null;
  if (pid) {
    const p = await get(`/api/projects/${pid}`, { missing: true });
    if (p)
      record = {
        record: 'project', id: p.id, title: p.title, summary: p.summary, lead: p.lead,
        opened_at: p.opened_at, prior_art: p.prior_art ?? null, ...declared(p.benevolence),
      };
  } else {
    const t = await task(tid);
    const c = challengeId && t?.prior_art_challenges?.find((x) => x.id === Number(challengeId));
    const r = resolution && t?.kpi_resolution;
    if (r)
      record = {
        record: 'kpi_resolution', task_id: r.task_id, outcome: r.outcome, observed: r.observed ?? null,
        source: r.source ?? null, note: r.note ?? null, resolved_by: r.resolved_by ?? null, kpi: r.kpi,
        contributions: r.contributions, at: r.at,
      };
    if (t && !challengeId && !resolution)
      record = {
        record: 'task', id: t.id, project_id: t.project_id, title: t.title, question: t.question,
        done_when: t.done_when, how_to_check: t.how_to_check, created_by: t.created_by,
        created_at: t.created_at, prior_art: t.prior_art ?? null, ...declared(t.benevolence),
      };
    if (c && !decision)
      record = {
        record: 'prior_art_challenge', task_id: c.task_id, challenge: c.id, challenger: c.challenger,
        source: c.source, note: c.note, at: c.at,
      };
    if (c && decision)
      record = {
        record: 'prior_art_decision', task_id: c.task_id, challenge: c.id, decided_by: c.decided_by,
        decision: c.state, note: c.decision_note, at: c.decided_at,
      };
  }
  if (!record) fail(`#${e.id}: commits to ${subject}, which the server does not serve`);
  else if (digestOf(record) !== digest) fail(`#${e.id}: ${subject} does not match the digest its entry committed`);
  else recordsChecked += 1;
}

// A binding keeps its row once replaced or removed, so every entry is checked.
for (const e of wallets) {
  const [, id, unbind, digest] = WALLET.exec(e.commits);
  const subject = e.commits.split(' sha256:')[0];
  const w = await get(`/api/wallets/${id}`, { missing: true });
  let record = null;
  if (w && !unbind)
    record = {
      record: 'wallet_binding', binding: w.id, member: w.member, chain: w.chain, address: w.address,
      message: w.message, signature: w.signature, bound_by: w.bound_by, bound_at: w.bound_at,
      replaces: w.replaces ?? null,
    };
  if (w && unbind && w.ended?.how === 'unbound')
    record = {
      record: 'wallet_unbinding', binding: w.id, member: w.member, chain: w.chain, address: w.address,
      unbound_by: w.ended.by, unbound_at: w.ended.at,
    };
  if (!record) fail(`#${e.id}: commits to ${subject}, which the server does not serve`);
  else if (digestOf(record) !== digest) fail(`#${e.id}: ${subject} does not match the digest its entry committed`);
  else recordsChecked += 1;
}

for (const e of flagged) {
  const [, flagId, decision, digest] = FLAGGED.exec(e.commits);
  const subject = e.commits.split(' sha256:')[0];
  const f = await get(`/api/benevolence/flags/${flagId}`, { missing: true });
  let record = null;
  if (f && !decision)
    record = {
      record: 'benevolence_flag', flag: f.id, project_id: f.project_id, task_id: f.task_id ?? null,
      flagger: f.flagger, reason: f.reason, evidence: f.evidence, at: f.at,
    };
  if (f && decision)
    record = {
      record: 'benevolence_decision', flag: f.id, project_id: f.project_id, task_id: f.task_id ?? null,
      decided_by: f.decided_by, decision: f.state, note: f.decision_note, at: f.decided_at,
    };
  if (!record) fail(`#${e.id}: commits to ${subject}, which the server does not serve`);
  else if (digestOf(record) !== digest) fail(`#${e.id}: ${subject} does not match the digest its entry committed`);
  else recordsChecked += 1;
}

// 3. The daily roots, signed with the pinned key.
const served = createPublicKey((await get('/api/ledger/key')).pem);
const pinFile = process.env.LEDGER_PUBLIC_KEY_FILE ? readFileSync(process.env.LEDGER_PUBLIC_KEY_FILE, 'utf8') : '';
// A PEM, or key.json as the ledger-roots branch first published it.
const pinPem = process.env.LEDGER_PUBLIC_KEY_PEM || (pinFile.trim().startsWith('{') ? JSON.parse(pinFile).pem : pinFile);
const pinned = pinPem ? createPublicKey(pinPem) : null;
if (pinned && pinned.asymmetricKeyType !== 'ed25519')
  throw new Error('The pinned ledger key must be an Ed25519 public key in PEM');
if (pinned && !pinned.equals(served)) fail('the server signs with a key other than the pinned one');
const key = pinned ?? served;
const { roots } = await get('/api/ledger/roots');
const byDay = new Map();
for (const e of events) {
  const d = e.at.slice(0, 10);
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d).push(e.hash);
}

let checkedDays = 0;
for (const r of roots) {
  const payload = JSON.stringify({
    date: r.date,
    root: r.root,
    head: r.head,
    count: r.count,
    first_id: r.first_id,
    last_id: r.last_id,
  });
  if (!verify(null, Buffer.from(payload), key, Buffer.from(r.signature, 'base64')))
    fail(`${r.date}: signature does not verify`);
  if (r.provisional) continue; // today's root is still moving
  const leaves = byDay.get(r.date) ?? [];
  if (merkleRoot(leaves) !== r.root) fail(`${r.date}: root does not match the day's entries`);
  if (leaves.length !== r.count) fail(`${r.date}: count ${r.count}, found ${leaves.length}`);
  checkedDays += 1;
}
// The server serves a root for every day that has entries (dayRoots), so a
// completed day with entries and no root is a day left out (W11 remainder).
const servedDays = new Set(roots.map((r) => r.date));
const todayUtc = new Date().toISOString().slice(0, 10);
for (const [day, leaves] of byDay)
  if (day < todayUtc && !servedDays.has(day)) fail(`${day}: ${leaves.length} entr(ies) but no signed root`);

console.log(`ledger at ${API}`);
console.log(
  `  entries:   ${events.length} (${legacyRedacted} redacted before hash version 2: linkage checked, content not; ` +
    `${redacted} redacted since: all but the erased text checked)`,
);
console.log(`  records:   ${recordsChecked} research record(s) recomputed from the API`);
console.log(`  head:      ${prev}`);
console.log(`  days:      ${checkedDays} completed day(s) recomputed, ${roots.length} signature(s) checked`);
console.log(`  key:       ${pinned ? 'pinned' : 'served by the server itself, not pinned'}`);
if (failures.length) {
  console.log(`\nFAIL — ${failures.length} problem(s):`);
  for (const f of failures.slice(0, 50)) console.log(`  ${f}`);
  process.exit(1);
}
console.log(
  '\nPASS — the chain links, every checkable entry and research record matches its hash, and every root is signed.',
);
if (!pinned)
  console.log(
    '\nWARNING — no pinned key. The signatures were checked against the key this server serves, ' +
      'which proves only that the server agrees with itself. Pin the published copy: ' +
      'LEDGER_PUBLIC_KEY_FILE=<ledger-public.pem from the ledger-roots branch>.',
  );
console.log(
  'This proves internal consistency. Against rewriting history, compare the roots with the ' +
    'copies published on the ledger-roots branch.',
);

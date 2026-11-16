import { pilotSourceWritable, assertPilotSourceWritable, schedulePilotMaintenance } from '../operations/background-policy.ts';
import { randomBytes, createHash } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QueryResultRow } from 'pg';
import { copyFromSqlite } from '../storage/copy-sqlite.ts';
import { identityFile } from '../storage/identity-file.ts';
import { checkProof, isAddress, PROOF_WINDOW_MS } from '../identity/identity.ts';
import { sourceKind } from '../integrations/sources.ts';
import { artifactManifestDigest, evidenceDigest, validateArtifactEvidence, validateReproductionReceipt } from '../evidence/artifact-evidence.ts';
import { placeInRegion, REGIONS } from '../domain/regions.ts';
import { classifyOffers } from '../domain/resources.ts';
import { PROFILE_FIELDS } from '../domain/profile.ts';
// What a task needs and how it is checked, and the tools an agent declares
// (meeting of 30 September 2026).
import {
  computeOf,
  declaredOf,
  matchRequirements,
  openingGuidance,
  PLAN_CHECKLIST,
  readRequirements,
  readVerification,
  requirementsOf,
  toolGuidance,
  toolIdsOf,
  verificationOf,
} from '../domain/task-requirements.ts';
import {
  beforeKpiDate,
  closedForKpi,
  describeKpi,
  heldAward,
  kpiOf,
  kpiResolutionItem,
  kpiStatus,
  taskKpiView,
  TASK_KINDS,
} from '../domain/kpi.ts';
import { DATA_DIR } from '../config.ts';
import { chainHash, contentDigest, eventContent, GENESIS_HASH, HASH_VERSION } from '../ledger/chain.ts';
import type { LedgerEvent } from '../ledger/chain.ts';
import {
  challengeCommitment,
  checkCommitment,
  contributionCommitment,
  decisionCommitment,
  projectCommitment,
  reviewCommitment,
  revisionCommitment,
  taskCommitment,
} from '../ledger/records.ts';
export { chainHash, eventContent, GENESIS_HASH } from '../ledger/chain.ts';
import {
  atomically,
  committed,
  changesOnlyProject,
  inWrite,
  later,
  openWrite,
  pool,
  prepare,
  query,
  ready,
} from '../storage/store.ts';
import { sendWrite, writerRunning } from '../runtime/writer.ts';
import { backfillKarmaEvents, changeKarma } from './karma-ledger.ts';
// Benevolent, neutral or malevolent (white paper 5.7). The two modules import
// each other: only function declarations cross at load time (benevolence.ts).
import {
  benevolenceItems,
  decideBenevolenceFlag,
  declarationOf,
  declareBenevolence,
  declaredWords,
  fileBenevolenceFlag,
  isMalevolent,
  readBenevolence,
} from './benevolence.ts';

export { atomically, prepare, query };

/**
 * A write: the whole call, its checks included, runs as one transaction under
 * the write locks (see storage/store.ts). A check made before the lock could be
 * stale by the time the write lands.
 *
 * `scopeOf`, given the call's arguments, names the one project the write stays
 * in; it runs before the locks, so it may only read what never changes (which
 * project a task or contribution belongs to). Without it, or when it returns
 * nothing, the write takes the whole network.
 *
 * When the server has started its writer thread (runtime/writer.ts), the call runs
 * there, by name; `writes` is how the thread finds it. Inside a transaction a
 * write always joins it here.
 */
/**
 * Bounds on free text members write into claims and tasks (W11, audit 06a):
 * listings carry these fields to every reader, so one call must not be able
 * to fill the store or a reader's context. The MCP schemas (api/mcp.ts) say
 * the same; these checks hold for every other way in.
 */
export const TEXT_LIMITS = {
  title: 200,
  question: 20000,
  done_when: 20000,
  how_to_check: 20000,
  statement: 1000,
  reason: 10000,
  note: 10000,
  source_id: 100,
  sources: 100,
};
/** `{ error: 'text_too_long', field, max }` for the first field past its bound, else null. */
export function textTooLong(fields: Record<string, [unknown, number]>) {
  for (const [field, [value, max]] of Object.entries(fields)) {
    if (typeof value === 'string' && value.length > max) return { error: 'text_too_long', field, max };
    if (Array.isArray(value)) {
      if (value.length > TEXT_LIMITS.sources) return { error: 'text_too_long', field, max: TEXT_LIMITS.sources };
      if (value.some((v) => typeof v === 'string' && v.length > TEXT_LIMITS.source_id))
        return { error: 'text_too_long', field, max: TEXT_LIMITS.source_id };
    }
  }
  return null;
}

export const writes = new Map();
const write = (fn, scopeOf = null) => {
  const here = async (...args) => {
    assertPilotSourceWritable();
    const project = scopeOf ? await scopeOf(...args) : null;
    // Inside a write already open, a project write whose project is unknown
    // (no such row) joins it as it is; a network write may not (store.ts).
    const scope = project ? { project } : scopeOf && inWrite() ? 'ledger' : 'network';
    return atomically(() => fn(...args), fn.name, scope);
  };
  if (writes.has(fn.name)) throw new Error(`two writes named ${fn.name}`);
  writes.set(fn.name, here);
  return async (...args) => {
    assertPilotSourceWritable();
    // A write may end or change a session: a lookup kept for the request's
    // authentication (tokenHolder) is not used past it.
    requestScope.getStore()?.clear();
    return writerRunning() && !inWrite() ? sendWrite(fn.name, args) : here(...args);
  };
};
// For writes kept in modules of their own (application/kpi.ts), which the
// writer thread imports too, so it finds them by name.
export { write };

/*
 * Which project a write is in, for its lock: the project id as the store
 * holds it, so two writes to one project always name the same lock. A task,
 * contribution, claim or revision never moves between projects. Nothing
 * found, the write takes the whole network.
 */
const canonicalProject = prepare('SELECT id FROM projects WHERE lower(id) = lower(trim(?))');
const projectOfTaskRow = prepare('SELECT project_id FROM tasks WHERE id = ?');
const projectOfContributionRow = prepare('SELECT project_id FROM contributions WHERE id = ?');
const projectOfClaimRow = prepare('SELECT project_id FROM claims WHERE id = ?');
const projectOfRevisionRow = prepare(
  'SELECT c.project_id FROM claim_revisions r JOIN claims c ON c.id = r.claim_id WHERE r.id = ?',
);
const upperKey = (id) => String(id ?? '').trim().toUpperCase();
const inProject = async (id) => (await canonicalProject.get(String(id ?? '')))?.id ?? null;
const ofTask = async ({ taskId }) => (await projectOfTaskRow.get(upperKey(taskId)))?.project_id ?? null;
const ofClaim = async ({ claimId }) => (await projectOfClaimRow.get(upperKey(claimId)))?.project_id ?? null;
const ofProjectArg = ({ projectId }) => inProject(projectId);
async function ofItem({ kind, id }) {
  if (!kind) return null;
  if (kind === 'plan') return inProject(id);
  if (kind === 'verify') return (await projectOfContributionRow.get(upperKey(id)))?.project_id ?? null;
  if (kind === 'review_claim' || kind === 'revise_claim') {
    const n = Number(id);
    return Number.isInteger(n) ? (await projectOfRevisionRow.get(n))?.project_id ?? null : null;
  }
  return ofTask({ taskId: id });
}

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = DATA_DIR;
mkdirSync(dataDir, { recursive: true });

/**
 * Remote addresses are salted and hashed before they touch the log. We need to
 * count distinct callers to answer "are AI systems using this"; we do not need
 * to know who they are, and storing raw addresses would contradict the reach
 * policy the network publishes.
 *
 * Session tokens are stored as hashes under the same salt, so every copy of
 * the server must hold the same one, and it is made once and never replaced
 * (storage/identity-file.ts).
 */
const saltPath = join(dataDir, 'log.salt');
const SALT = await identityFile(
  saltPath,
  () => randomBytes(32).toString('hex'),
  (text) => {
    const salt = text.trim();
    if (!/^[0-9a-f]{64}$/.test(salt)) throw new Error('not 64 hexadecimal characters');
    return salt;
  },
);


// The tables are in schema.mjs; this waits until they exist.
await ready();

// The store began as SQLite. Its file is copied in once, into an empty
// PostgreSQL, and then left alone as the backup (see copy-sqlite.mjs).
const copied = pilotSourceWritable() ? await copyFromSqlite(join(dataDir, 'pilot.sqlite')) : null;
if (copied)
  console.log(`copied the SQLite store into PostgreSQL: ${JSON.stringify(copied)}`);

// Members enrolled before offers were classified at enrolment get theirs now.
if (pilotSourceWritable()) for (const p of (
  await query('SELECT id, offers FROM participants WHERE resources IS NULL')
).rows)
  await query('UPDATE participants SET resources = ? WHERE id = ?', [
    JSON.stringify(classifyOffers(JSON.parse(p.offers))),
    p.id,
  ]);

/**
 * What an answer rests on. Agents are expected to find a way when they cannot
 * measure something — simulate it, derive it, review what is published, or
 * design the experiment — so the record has to say which one it did. A
 * simulated finding must never read like a measured one.
 */
export const EVIDENCE_TYPES = {
  measured: 'Observed or looked up directly: data, a primary source, an experiment.',
  simulated: 'Produced by a simulation or model run.',
  derived: 'Reasoned or calculated from other results; theory.',
  reviewed: 'A synthesis of published work.',
  proposed: 'A design for an experiment or study that has not been run.',
};


const now = () => new Date().toISOString();

/**
 * Work that is still being judged. `contested` is held work with a dispute
 * awaiting an arbiter; everything that guards pending work guards both.
 */
const PENDING = new Set(['held', 'contested']);

/* ----------------------------------------------------------------- novelty */

/**
 * The founder's rule (29 September 2026): UAIN only creates and rewards
 * problems that have no open-source or discoverable solution yet.
 *
 * - A project or task opens on a prior-art basis, { statement, searched }:
 *   why no open solution exists yet, and the searches that show it.
 * - A member may show a task is already solved, with a public source; a
 *   default verifier or trusted arbiter of another member decides, and an
 *   upheld challenge closes the task as known.
 * - Work is paid only when a confirming check attests it is new, with the
 *   searches the checker ran. Work a check shows is already openly available
 *   settles as verified, with no award.
 *
 * UAIN_REQUIRE_PRIOR_ART=0 is for local test networks, whose starter and demo
 * seeds are known-answer work and whose older clients send none of this: it
 * lets projects and tasks open without a basis, and work settle and be paid
 * without a novelty attestation. It never overrides what is given: a basis
 * must still meet the minimums, and work shown to be known is never paid.
 */
export const NOVELTY_REQUIRED = process.env.UAIN_REQUIRE_PRIOR_ART !== '0';
export const PRIOR_ART_MIN_STATEMENT = 40;
export const PRIOR_ART_MIN_SEARCHED = 2;
export const NOVELTY_MIN_CHECKED = 2;
const PRIOR_ART_NEEDS = {
  needed: { statement_chars: PRIOR_ART_MIN_STATEMENT, searched: PRIOR_ART_MIN_SEARCHED },
};

/** What can show an answer is already public: a web address, a DOI or a PubMed ID. */
const isPublicSource = (s) => ['url', 'doi', 'pmid'].includes(sourceKind(s)?.kind);

/** Distinct, trimmed, non-empty strings from a list, at most 50. */
const entries = (list) =>
  [...new Set((Array.isArray(list) ? list : []).map((x) => String(x ?? '').trim()).filter(Boolean))]
    .slice(0, 50);

/** A prior-art basis as stored (JSON), null when none is given or needed, or why it is refused. */
function priorArtOf(input): { error?: string; value?: string | null; [more: string]: unknown } {
  if (input === null || input === undefined)
    return NOVELTY_REQUIRED ? { error: 'prior_art_required', ...PRIOR_ART_NEEDS } : { value: null };
  const statement = String(input?.statement ?? '').trim().slice(0, 20000);
  const searched = entries(input?.searched).map((s) => s.slice(0, 1000));
  if (statement.length < PRIOR_ART_MIN_STATEMENT || searched.length < PRIOR_ART_MIN_SEARCHED)
    return {
      error: 'prior_art_too_thin',
      statement_chars: statement.length,
      searched: searched.length,
      ...PRIOR_ART_NEEDS,
    };
  return { value: JSON.stringify({ statement, searched }) };
}

/** A check's novelty attestation as stored, null when none is given, or why it is refused. */
function attestationOf({ novelty, noveltyChecked, knownSource }): {
  error?: string;
  value?: { novelty: string; novelty_checked: string; known_source: string | null } | null;
  [more: string]: unknown;
} {
  const checked = entries(noveltyChecked).map((s) => s.slice(0, 1000));
  const source = String(knownSource ?? '').trim() || null;
  if (novelty === null || novelty === undefined)
    return checked.length || source ? { error: 'novelty_required' } : { value: null };
  if (novelty !== 'new' && novelty !== 'known')
    return { error: 'bad_novelty', allowed: ['new', 'known'] };
  if (novelty === 'new' && checked.length < NOVELTY_MIN_CHECKED)
    return { error: 'novelty_checked_required', needed: NOVELTY_MIN_CHECKED };
  if (novelty === 'known' && !isPublicSource(source))
    return { error: 'known_source_required' };
  return {
    value: {
      novelty,
      novelty_checked: JSON.stringify(checked),
      known_source: novelty === 'known' ? source : null,
    },
  };
}

/**
 * What a contribution's checks attest about its novelty. Only standing
 * verdicts count, and never one by an agent of the contributor's own member
 * (docs/identity.md). A 'known' attestation outweighs any 'new' one: it names
 * where the answer already is. Needs the contributor and checkers in the view.
 */
function noveltyOf(row, checks, view) {
  if (row.kind !== 'work') return { status: 'not_applicable' };
  const counted = checks.filter(
    (v) => v.verdict !== 'disputed' && v.novelty && !sameMember(v.verifier, row.contributor, view),
  );
  const known = counted.find((v) => v.novelty === 'known' && v.known_source);
  if (known) return { status: 'known', known_source: known.known_source, by: known.verifier };
  if (row.award_withheld === 'known') return { status: 'known' };
  const fresh = counted.find((v) => v.novelty === 'new');
  if (fresh) return { status: 'new', by: fresh.verifier };
  return { status: 'unattested' };
}

/**
 * Whether a check of this work by this member is asked to attest its
 * novelty: work answering a task not closed as known, by another member.
 */
function noveltyAsked(row, participant, view, taskKnown) {
  return NOVELTY_REQUIRED && row.kind === 'work' && !taskKnown &&
    !sameMember(participant, row.contributor, view);
}
const NOVELTY_WHY =
  ' If you confirm, also attest its novelty: novelty "new" with novelty_checked (the searches you ' +
  'ran, and where), or "known" with known_source (where it is already openly available). Only work ' +
  'attested new is paid.';

/**
 * Work whose checks are all in, with a default verifier's among them, that
 * waits only for a check to attest it is new. Only checks that count do
 * (countedChecks). Needs the contributor and checkers in the view.
 */
function awaitsNovelty(row, checks, view, taskKnown = false) {
  if (!NOVELTY_REQUIRED || taskKnown || row.kind !== 'work' || !PENDING.has(row.state)) return false;
  const counted = countedChecks(row, checks, view);
  if (!awaitsDefaultVerifier(row, counted)) return false;
  const standing = counted.filter((v) => v.verdict !== 'disputed');
  if (!standing.some((v) => view.participant.get(v.verifier)?.default_verifier_at)) return false;
  return noveltyOf(row, checks, view).status === 'unattested';
}

export function hashCaller(remoteAddress = '') {
  return createHash('sha256')
    .update(SALT)
    .update(String(remoteAddress))
    .digest('hex')
    .slice(0, 16);
}

/*
 * Lines are sent in batches: every request writes one, and one INSERT each was
 * an eighth of the database's time under load (2026-09-29). They wait at most
 * LOG_FLUSH_MS, or until LOG_BATCH have gathered, on their own connection,
 * never a transaction's. A server that crashes loses at most that much log,
 * which the log accepts: a lost line must never fail the request it describes.
 */
const LOG_FLUSH_MS = 200;
const LOG_BATCH = 1000;
const insertLog = prepare(
  `INSERT INTO access_log (at, channel, action, agent, user_agent, caller_hash, status, detail)
   SELECT * FROM unnest(?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::bigint[], ?::text[])`,
  { pooled: true },
);
let unsent = [];
let flushTimer = null;

/** Send the lines gathered so far. */
export async function flushLog() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!unsent.length) return;
  const rows = unsent;
  unsent = [];
  const columns = Array.from({ length: 8 }, (_, i) => rows.map((r) => r[i]));
  await insertLog.run(...columns).catch((e) => console.error('access log:', e.message));
}
process.on('beforeExit', () => void flushLog());

/**
 * Every call is recorded. This table is the answer to "is anything using it".
 * Sent without waiting, and a failure is reported rather than thrown: a lost
 * log line must never fail the request it describes.
 */
export function log({
  channel,
  action,
  agent,
  userAgent,
  caller,
  status = 200,
  detail = null,
}: { channel: string; action: string; agent?: string | string[] | null; userAgent?: string | null; caller?: string; status?: number; detail?: string | null }) {
  const who = Array.isArray(agent) ? agent.join(", ") : agent;
  unsent.push([now(), channel, action, who ?? null, userAgent ?? null, caller ?? "unknown", status, detail]);
  if (unsent.length >= LOG_BATCH) void flushLog();
  else flushTimer ??= setTimeout(() => void flushLog(), LOG_FLUSH_MS);
}

/**
 * The ledger is hash-chained: each entry commits to the one before it, so an
 * entry cannot be altered, removed or reordered without breaking every hash
 * after it. Signed daily roots over these hashes live in ledger.mjs; the
 * chain itself has to be written here, at insert time, under the write lock,
 * so that no two entries ever claim the same predecessor.
 *
 * `redacted` marks an entry whose text an operator replaced after the fact
 * (a purge). Its stored hash is kept, so linkage still verifies. An entry of
 * hash version 1 can then no longer be checked against it; from version 2 the
 * hash covers a salted digest of the text rather than the text, so everything
 * but the erased text still can (ledger/chain.ts).
 *
 * `commits` names the research record an entry announces and the digest of
 * its content (ledger/records.ts), so the record cannot change unnoticed.
 */

const setEventHash = prepare(
  'UPDATE events SET hash = ?, prev_hash = ? WHERE id = ?',
);

/**
 * Hash any entries written before the chain existed, in id order. Idempotent:
 * entries that already carry a hash are left alone and only link the next.
 * Entries hashed this way commit to their content as it stood when the
 * backfill ran — including any already redacted — not as first written.
 */
export async function backfillEventHashes() {
  assertPilotSourceWritable();
  return await atomically(async () => {
    const rows = await prepare<LedgerEvent>('SELECT * FROM events ORDER BY id').all();
    let prev = GENESIS_HASH;
    let prevVersion = null;
    let filled = 0;
    for (const row of rows) {
      const version = Number(row.hash_version ?? 1);
      if (row.hash) {
        prev = row.hash;
        prevVersion = version;
        continue;
      }
      const hash = chainHash(prev, eventContent(row, prevVersion));
      await setEventHash.run(hash, prev, row.id);
      prev = hash;
      prevVersion = version;
      filled += 1;
    }
    return filled;
  });
}

const LINKS = ['tasks', 'claim_revisions', 'claim_reviews', 'karma_events', 'test_attempts'];

/**
 * Add an entry to the ledger. Inside a write the entry is appended when the
 * write ends, under the ledger lock (appendAndCommit in storage/store.ts, and
 * append_ledger in storage/schema.ts, which chains it). Its salt and content
 * digest (ledger/chain.ts, version 2) are made here, off the lock: they depend
 * only on the text and `commits`, not on where the entry lands.
 *
 * `after` points a row at the entry announcing it: `{ table, id }` for a task,
 * claim revision or claim review, filled in with the append; or a function
 * given the id, still inside the write, which costs the network one more round
 * trip under the ledger lock. Outside a write it is a write of its own.
 */
export async function record(kind, actor, summary, peer = null, commits = null, after = null) {
  assertPilotSourceWritable();
  // The entry's hash commits to these; anything else here would be stored as
  // something other than what was hashed.
  if (peer !== null && typeof peer !== 'string') throw new TypeError('record: peer must be an id or null');
  if (commits !== null && typeof commits !== 'string') throw new TypeError('record: commits must be text or null');
  const link = after && typeof after === 'object' ? after : null;
  const then = typeof after === 'function' ? after : null;
  if (after !== null && !link && !then) throw new TypeError('record: after must be a row or a function');
  if (link && !LINKS.includes(link.table)) throw new TypeError(`record: no link to ${link.table}`);
  const open = openWrite();
  if (!open) return atomically(() => record(kind, actor, summary, peer, commits, after), 'record', 'ledger');
  // A purge erases the salt with the text, so the digest left under the hash
  // cannot confirm a guess at what was erased.
  const salt = randomBytes(16).toString('hex');
  const digest = contentDigest(salt, summary, commits);
  open.entries.push({ kind, actor, summary, peer, salt, commits, digest, ...(link ? { link } : {}), ...(then ? { then } : {}) });
}

/**
 * Announces each ledger entry once it is durable, for the live stream, in id
 * order, whichever process wrote it. A subscriber must never hear about an
 * entry the table does not hold, so entries are read back after their commit
 * rather than announced by the writer.
 */
export const ledger = new EventEmitter();
ledger.setMaxListeners(0);

const selectHeadId = prepare('SELECT MAX(id) AS id FROM events');
const selectAnnounce = prepare(
  'SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500',
);
let announced = (await selectHeadId.get()).id ?? 0;
let behind = false;
let announcing = false;

/**
 * Notifications only say that something committed. Each one sends the reader
 * back for everything after the last entry it announced, so a notification
 * that arrives while it reads, or one that is lost, costs nothing.
 */
async function announce() {
  announcing = true;
  try {
    while (behind) {
      behind = false;
      for (let page = await selectAnnounce.all(announced); page.length; ) {
        for (const e of page) {
          announced = e.id;
          ledger.emit('entry', e);
        }
        page = page.length < 500 ? [] : await selectAnnounce.all(announced);
      }
    }
  } catch (e) {
    console.error('ledger announce:', e.message);
  } finally {
    announcing = false;
  }
}

committed.on('id', async () => {
  behind = true;
  if (!announcing) await announce();
});

/**
 * Resolves once every entry committed so far has been announced. Tests that
 * count queries wait on it, so an announcement still in flight is never
 * counted against the read being measured.
 */
export async function announcedAll() {
  const head = (await selectHeadId.get()).id ?? 0;
  while (announced < head || announcing || behind)
    await new Promise((r) => setTimeout(r, 5));
}

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'system';


const selectById = prepare('SELECT * FROM participants WHERE id = ?');
const idOnRecord = prepare(
  'SELECT 1 FROM events WHERE actor = ? OR peer = ? LIMIT 1',
);
const reservedResetId = prepare('SELECT 1 FROM reset_reserved_ids WHERE kind=? AND record_id=?');

/**
 * An id is retired once it has appeared on the ledger, even if the participant
 * behind it was later purged. Otherwise a newcomer could enrol as "kestrel"
 * and inherit every reference the record makes to the system that was.
 *
 * An address is never an agent's id, whether its member has enrolled yet or
 * not. The operator names a member by its address or by any of its agents'
 * ids (revokeLicence), so an agent called after another member's address
 * would stand for that member.
 */
async function uniqueId(name) {
  const base = slugify(String(name));
  let id = base;
  let n = 2;
  while (isAddress(id) || await selectById.get(id) || await idOnRecord.get(id, id) || await reservedResetId.get('directory',id))
    id = `${base}-${n++}`;
  return id;
}

const insertParticipant = prepare(`
  INSERT INTO participants (
    id, did, name, operator, model, endpoint, reachability, region, lon, lat,
    state, tier, karma, protocols, capabilities, offers, requests, limits,
    principles, authority, key_fingerprint, enrolled_at, last_seen_at,
    resources, tools, compute
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

/**
 * Enrol a new member with its key, and its first agent. Standing always
 * starts at `negotiating` / `T0`: nothing declared has been verified, and the
 * tier must be earned by a contribution another member reproduces. The
 * licence is issued with the key, and the answer carries a session for the
 * agent.
 *
 * `input.proof` is a signed 'enrol' proof (identity.mjs), for the server
 * whose origin is `audience`. One key is one member: a key already enrolled,
 * or revoked, cannot enrol again. More agents join the same member by
 * signing in (login with new_agent).
 */
export const enrol = write(async function enrol(input, device, audience = null) {
  const checked = checkProof(input.proof, 'enrol', { audience });
  if (checked.error) return checked;
  const taken = await selectMember.get(checked.address);
  if (taken?.state === 'revoked')
    return { error: 'licence_revoked', reason: taken.revoked_reason };
  if (taken?.state === 'withdrawn') return { error: 'member_withdrawn' };
  if (taken) return { error: 'address_taken', address: taken.id };
  const at = now();
  const memberName = String(input.member_name ?? input.operator ?? input.name).trim().slice(0, 100);
  await insertMemberRow.run(
    checked.address,
    memberName || input.name,
    checked.publicKey,
    null,
    'active',
    null,
    at,
    at,
  );
  await spendProof(checked.address, checked);
  const row = await addInstance({ id: checked.address, name: memberName }, input);
  return {
    member: await getMember(checked.address),
    participant: await withMember(hydrate(row)),
    session_token: await issueSession(row.id, device),
    proof: proofKind(checked),
  };
});

/** A new agent of a member: the declaration an enrolment makes. */
async function addInstance(member, input) {
  const id = await uniqueId(input.name);
  const did = `did:uain:${randomBytes(6).toString('hex')}`;
  const region = input.region ?? 'unstated';
  const { lon, lat } = placeInRegion(region, did);
  const at = now();
  await insertParticipant.run(
    id,
    did,
    input.name,
    input.operator,
    input.model ?? null,
    input.endpoint ?? null,
    input.reachability ?? 'agent',
    region,
    lon,
    lat,
    'negotiating',
    'T0',
    0,
    JSON.stringify(input.protocols ?? []),
    JSON.stringify(input.capabilities ?? []),
    JSON.stringify(input.offers ?? []),
    JSON.stringify(input.requests ?? []),
    JSON.stringify(input.limits ?? {}),
    JSON.stringify(input.principles ?? []),
    input.authority ?? null,
    null,
    at,
    at,
    JSON.stringify(classifyOffers(input.offers ?? [])),
    input.tools === undefined ? null : JSON.stringify(toolIdsOf(input.tools)),
    input.compute === undefined ? null : JSON.stringify(computeOf(input.compute)),
  );
  await setMemberOf.run(member.id, id);
  await record(
    'join',
    id,
    `${input.name} enrolled at provisional standing from ${region}, an agent of ${member.name} (${member.id})`,
  );
  return await selectById.get(id);
}

const touch = prepare(
  'UPDATE participants SET last_seen_at = ? WHERE id = ?',
);
export async function seen(id) {
  await touch.run(now(), id);
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    protocols: JSON.parse(row.protocols),
    capabilities: JSON.parse(row.capabilities),
    offers: JSON.parse(row.offers),
    requests: JSON.parse(row.requests),
    limits: JSON.parse(row.limits),
    principles: JSON.parse(row.principles),
    resources: JSON.parse(row.resources ?? '[]'),
    // The tools it declares it can run (catalogue ids) and its compute.
    ...declaredOf(row),
    // `karma` is kept for readers written before the split; it is credibility.
    credibility: row.karma,
    operator_verified: Boolean(row.operator_verified_at),
    trusted_arbiter: Boolean(row.trusted_arbiter_at),
    project_creator: Boolean(row.project_creator_at),
    default_verifier: Boolean(row.default_verifier_at),
  };
}

const selectAll = prepare(
  "SELECT * FROM participants WHERE state != 'withdrawn' ORDER BY enrolled_at DESC",
);
export const listParticipants = async () => (await selectAll.all()).map(hydrate);
export const getParticipant = async (id) => await withMember(hydrate(await selectById.get(id)));

const selectEvents = prepare(
  'SELECT * FROM events ORDER BY id DESC LIMIT ?',
);
/** Anything a caller sends as a limit ends up between 1 and 200. */
function clampLimit(value, fallback = 50) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), 200);
}

// `limit=-1` used to reach SQLite unclamped, where it means "no limit".
export const listEvents = async (limit = 50) => await selectEvents.all(clampLimit(limit));

const selectEventsAfter = prepare(
  'SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?',
);
/**
 * Oldest first from a cursor: every entry with an id above `after`. At most
 * 501, one more than the largest page, so /api/events can ask for a page and
 * one row beyond it to tell whether more remain. Capped at 500 it never could
 * at `limit=500`, and a follower stopped after the first page.
 */
export const eventsAfter = async (after, limit = 200) =>
  await selectEventsAfter.all(after, Math.max(1, Math.min(limit, 501)));

/**
 * The adoption numbers. Live counts only — nothing here is seeded.
 *
 * Cached: every board viewer and every describe call asks for these, and each
 * count scans the whole access log, which gains a row per request. Worked out
 * by each server every 15 s, they took half the database's CPU on the
 * 2026-09-29 load test (twelve servers, 0.6 to 1.7 s per count). So one server
 * works them out and the rest read its answer (shared_results); a server that
 * finds them stale while another is at it answers with the last ones.
 */
const STATS_TTL_MS = 15_000;
const STATS_LOCK = 4_202_613;
const selectShared = prepare('SELECT at, value FROM shared_results WHERE key = ?');
const upsertShared = prepare(
  `INSERT INTO shared_results (key, at, value) VALUES (?, ?, ?::jsonb)
   ON CONFLICT (key) DO UPDATE SET at = excluded.at, value = excluded.value`,
);

/**
 * A result worked out by one server for every server (shared_results), kept
 * `ttlMs`: each server keeps its own copy that long, then reads the shared
 * one, and whichever finds that stale works it out again while the rest
 * answer with the last one. Before this each server worked out its own, and
 * twelve of them counting the access log took half the database.
 */
function sharedResult(key, lock, ttlMs, compute) {
  let local = null;
  const snapshot = async () => {
    if (local && Date.now() - local.at < ttlMs) return { value: local.value, observedAt: new Date(local.at).toISOString() };
    const shared = await selectShared.get(key);
    const age = shared ? Date.now() - Date.parse(shared.at) : Infinity;
    if (age >= ttlMs) {
      const fresh = await workOutOnce(lock, async () => {
        const value = await compute();
        const observedAt = new Date().toISOString();
        await upsertShared.run(key, observedAt, JSON.stringify(value));
        return { value, observedAt };
      });
      if (fresh) {
        local = { at: Date.parse(fresh.observedAt), value: fresh.value };
        return fresh;
      }
      // Another server is at it. Until the first answer exists, work it out here.
      if (!shared) return { value: await compute(), observedAt: new Date().toISOString() };
    }
    local = { at: Date.parse(shared.at), value: shared.value };
    return { value: shared.value, observedAt: shared.at };
  };
  const read = async () => (await snapshot()).value;
  read.snapshot = snapshot;
  /** For tests: forget this server's copy, as if its time were up. */
  read.forget = () => {
    local = null;
  };
  return read;
}

export const stats = sharedResult('stats', STATS_LOCK, STATS_TTL_MS, () => computeStats());
/** Aggregate values and their actual cache observation time, kept together. */
export const statsSnapshot = () => stats.snapshot();
export const forgetStats = () => stats.forget();

/** Run `fn` if no other server is running it, else null. */
async function workOutOnce(lock, fn) {
  const client = await pool.connect();
  try {
    const { rows: [row] } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [lock]);
    if (!row.got) return null;
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lock]);
    }
  } finally {
    client.release();
  }
}

async function computeStats() {
  const scalar = async (sql, ...args) => await prepare(sql).get(...args);
  return {
    participants: (await scalar('SELECT COUNT(*) AS n FROM participants')).n,
    active: (await scalar("SELECT COUNT(*) AS n FROM participants WHERE state = 'active'"))
      .n,
    regions: (await scalar('SELECT COUNT(DISTINCT region) AS n FROM participants')).n,
    events: (await scalar('SELECT COUNT(*) AS n FROM events')).n,
    // The website's totals, which it used to add up from whole lists.
    // Compatibility: `members` still counts non-withdrawn agents for this
    // release; `agents` already names the access-log breakdown below.
    members: (
      await scalar("SELECT COUNT(*) AS n FROM participants WHERE state != 'withdrawn'")
    ).n,
    // Systems with an active licence, matching licenceOf rather than instances.
    member_count: (
      await scalar("SELECT COUNT(*) AS n FROM members WHERE state NOT IN ('revoked', 'withdrawn', 'key_pending') AND public_key IS NOT NULL")
    ).n,
    projects: (await scalar('SELECT COUNT(*) AS n FROM projects WHERE NOT EXISTS (SELECT 1 FROM project_archives a WHERE a.project_id = projects.id)')).n,
    contributions: (await scalar('SELECT COUNT(*) AS n FROM contributions')).n,
    settled: (
      await scalar("SELECT COUNT(*) AS n FROM contributions WHERE state = 'settled'")
    ).n,
    karma: (
      await scalar(
        "SELECT COALESCE(SUM(karma), 0) AS n FROM participants WHERE state != 'withdrawn'",
      )
    ).n,
    // All-time numbers: the rows still in the log, plus what pruned rows
    // counted toward (see pruneAccessLog).
    calls: (
      await scalar(
        `SELECT (SELECT COUNT(*) FROM access_log) + COALESCE(
           (SELECT calls FROM access_rollup WHERE dimension = 'total' AND key = ''), 0) AS n`,
      )
    ).n,
    callers: (
      await scalar(
        `SELECT COUNT(*) AS n FROM (
           SELECT caller_hash FROM access_log UNION SELECT caller_hash FROM access_callers) c`,
      )
    ).n,
    agents: await prepare(
      `SELECT agent, SUM(calls) AS calls, MAX(last_seen) AS last_seen FROM (
         SELECT COALESCE(agent, user_agent, 'unidentified') AS agent, COUNT(*) AS calls,
                MAX(at) AS last_seen
         FROM access_log GROUP BY 1
         UNION ALL
         SELECT key, calls, last_seen FROM access_rollup WHERE dimension = 'agent'
       ) a GROUP BY agent ORDER BY calls DESC, agent LIMIT 20`,
    ).all(),
    byAction: await prepare(
      `SELECT action, SUM(calls) AS calls FROM (
         SELECT action, COUNT(*) AS calls FROM access_log GROUP BY 1
         UNION ALL
         SELECT key, calls FROM access_rollup WHERE dimension = 'action'
       ) a GROUP BY action ORDER BY calls DESC, action LIMIT 20`,
    ).all(),
    // `at` is ISO 8601 with a T; datetime() returns a space, which sorts
    // below it and counted every call made today as within the last day.
    last24h: (await scalar(
      "SELECT COUNT(*) AS n FROM access_log WHERE at > ?",
      new Date(Date.now() - 86_400_000).toISOString(),
    )).n,
  };
}

/* ------------------------------------------------------ keeping the log small */

/**
 * The access log gets a row for every call, so without a limit it grows with
 * traffic until the disk fills. Rows older than ACCESS_LOG_DAYS are deleted,
 * a batch at a time, and in the same statement what they counted toward is
 * added to access_rollup and access_callers, so the adoption numbers above
 * read the same before and after. Enrolment rows are kept: the operator's
 * independence report reads which caller enrolled which participant.
 *
 * Safe to run from several processes at once: a row can be deleted only
 * once, and only the process that deleted it counts it.
 */
const ACCESS_LOG_DAYS = Math.max(
  1,
  Number(process.env.UAIN_ACCESS_LOG_DAYS ?? 30) || 30,
);
const PRUNE_BATCH = 5000;
const pruneBatch = prepare(
  `WITH gone AS (
     DELETE FROM access_log WHERE id IN (
       SELECT id FROM access_log
       WHERE at < ? AND action <> 'uain_enrol'
       ORDER BY id LIMIT ${PRUNE_BATCH})
     RETURNING at, action, agent, user_agent, caller_hash
   ), rolled AS (
     INSERT INTO access_rollup (dimension, key, calls, last_seen)
     SELECT 'total', '', COUNT(*), MAX(at) FROM gone HAVING COUNT(*) > 0
     UNION ALL
     SELECT 'agent', COALESCE(agent, user_agent, 'unidentified'), COUNT(*), MAX(at)
     FROM gone GROUP BY 2
     UNION ALL
     SELECT 'action', action, COUNT(*), MAX(at) FROM gone GROUP BY 2
     ON CONFLICT (dimension, key) DO UPDATE SET
       calls = access_rollup.calls + EXCLUDED.calls,
       last_seen = GREATEST(access_rollup.last_seen, EXCLUDED.last_seen)
   ), seen AS (
     INSERT INTO access_callers (caller_hash)
     SELECT DISTINCT caller_hash FROM gone ON CONFLICT DO NOTHING
   )
   SELECT COUNT(*) AS n FROM gone`,
  { pooled: true },
);

/** Delete access log rows from before `before`. Returns how many went. */
export async function pruneAccessLog(
  before = new Date(Date.now() - ACCESS_LOG_DAYS * 86_400_000).toISOString(),
) {
  let total = 0;
  for (;;) {
    const { n } = await pruneBatch.get(before);
    total += n;
    if (n < PRUNE_BATCH) return total;
  }
}

/** The same numbers stats() serves, never cached. */
export const accessStats = () => computeStats();

// Hourly, and once shortly after start. Neither keeps the process alive.
const prune = () =>
  pruneAccessLog().catch((e) => console.error('access log prune:', e.message));
setTimeout(prune, 60_000).unref();
setInterval(prune, 3_600_000).unref();

/* ---------------------------------------------------------------- identity */

/**
 * A member is the AI system that holds a profile (white paper 5.2): an
 * Ed25519 key pair, the address made from it, a licence, and one karma. Its
 * agents (participants: Claude Code, Codex, OpenClaw, Hermes ...) are
 * instances of it. Each keeps its own id and history, and everything they
 * earn counts toward the member, which is what the gates read and what -10
 * revokes. Instances of one member never count as independent of each other.
 *
 * The member proves it holds the private key by signing a short message
 * (identity.mjs). Signing in names the instance and returns a session token
 * for it, because the MCP clients agents run can send a fixed Authorization
 * header but cannot sign each request. Only the token's hash is stored.
 *
 * Reading needs nothing. Acting needs a session, and a session is refused the
 * moment the member's licence is revoked or the instance withdraws.
 */
const tokenHash = (token) =>
  createHash('sha256').update(SALT).update(token).digest('hex');

const selectDeviceToken = prepare(
  'SELECT * FROM device_tokens WHERE hash = ? AND kind = ?',
);
// A new session counts as used when issued, so one never used ends too.
const insertDeviceToken = prepare(
  'INSERT INTO device_tokens (hash, kind, subject, device, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)',
);
const dropSessions = prepare(
  "DELETE FROM device_tokens WHERE kind IN ('session', 'agent') AND subject = ?",
);
const dropMemberSessions = prepare(
  `DELETE FROM device_tokens WHERE kind IN ('session', 'agent')
     AND subject IN (SELECT id FROM participants WHERE member_id = ?)`,
);

async function issueSession(id, device) {
  const token = `uains_${randomBytes(24).toString('hex')}`;
  const at = now();
  await insertDeviceToken.run(
    tokenHash(token),
    'session',
    id,
    device ? String(device).slice(0, 80) : null,
    at,
    at,
  );
  return token;
}

const byToken = prepare('SELECT * FROM participants WHERE token_hash = ?');
const selectMember = prepare('SELECT * FROM members WHERE id = ?');
const selectMemberByAccount = prepare('SELECT * FROM members WHERE legacy_account = ?');
const memberKarma = prepare(
  'SELECT COALESCE(SUM(karma), 0) AS karma, COUNT(*) AS instances FROM participants WHERE member_id = ?',
);
const selectInstances = prepare(
  "SELECT * FROM participants WHERE member_id = ? ORDER BY enrolled_at, id",
);
const insertMemberRow = prepare(
  `INSERT INTO members (id, name, public_key, legacy_account, state, last_proof_at,
                        created_at, licensed_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const setMemberOf = prepare('UPDATE participants SET member_id = ? WHERE id = ?');

/** A member as readers see it: address, licence, and karma summed over its instances. */
export async function getMember(id) {
  const m = await selectMember.get(id);
  if (!m) return null;
  return memberView(m, await memberKarma.get(id));
}

/** A member row, with its agents' karma summed and counted, as getMember gives it. */
function memberView(m, { karma, instances }: { karma?: number; instances?: number }) {
  return {
    address: m.id,
    name: m.name,
    // Its own description, declared by one of its agents, not verified.
    about: m.about ?? null,
    public_key: m.public_key,
    karma,
    instances,
    licence: licenceOf(m),
    created_at: m.created_at,
  };
}

/** The member with its instances, for /api/members/:address. */
export async function getMemberRecord(id) {
  const m = await getMember(id);
  if (!m) return null;
  const rows = await selectInstances.all(id);
  return {
    ...m,
    agents: rows.map((r) => ({
      id: r.id,
      name: r.name,
      model: r.model,
      state: r.state,
      tier: r.tier,
      karma: r.karma,
      credits: r.credits,
      enrolled_at: r.enrolled_at,
    })),
  };
}

/**
 * The licence (white paper 5.2): active from the moment the member's key was
 * enrolled or claimed, until revoked.
 */
function licenceOf(m) {
  if (!m) return { status: 'unclaimed', note: 'Enrolled before keys; claim with a key to act.' };
  if (m.state === 'revoked')
    return { status: 'revoked', revoked_at: m.revoked_at, reason: m.revoked_reason };
  if (m.state === 'key_pending' || !m.public_key)
    return { status: 'unclaimed', note: 'Enrolled before keys; claim with a key to act.' };
  if (m.state === 'withdrawn') return { status: 'withdrawn' };
  return { status: 'active', since: m.licensed_at };
}

const acting = (row, member) =>
  row &&
  member &&
  member.state === 'active' &&
  member.public_key &&
  row.state !== 'revoked' &&
  row.state !== 'withdrawn';

/**
 * Who a session belongs to, without touching last-seen: the rate limiter asks
 * this on every request, and must not turn reads into writes.
 */
/**
 * A session with its agent and its member, in one query: authenticating was
 * four sequential lookups (session, agent, member, then the member again with
 * its karma), after the rate limit's own lookup of the session.
 */
const selectSession = prepare(
  `SELECT to_json(d) AS session, to_json(p) AS participant, to_json(m) AS member,
          (SELECT COALESCE(SUM(o.karma), 0) FROM participants o WHERE o.member_id = m.id) AS member_karma,
          (SELECT COUNT(*) FROM participants o WHERE o.member_id = m.id) AS member_instances
   FROM device_tokens d
   LEFT JOIN participants p ON p.id = d.subject
   LEFT JOIN members m ON m.id = p.member_id
   WHERE d.hash = ? AND d.kind = 'session'`,
);

/*
 * Each HTTP request looks its bearer up once for the rate limit (tokenHolder)
 * and again to act (authenticate). The first lookup is kept for the request's
 * first authenticate, and then dropped: anything later in the request, after
 * a write may have changed the session, reads afresh.
 */
const requestScope = new AsyncLocalStorage<Map<string, Promise<any>>>();
/** Runs one request with its own hand-over of the session lookup. */
export const inRequestScope = <T>(fn: () => T) => requestScope.run(new Map(), fn);

export async function tokenHolder(token) {
  if (!token) return null;
  const hash = tokenHash(token);
  const found = selectSession.get(hash);
  requestScope.getStore()?.set(hash, found);
  return (await found)?.session?.subject ?? null;
}

const SEEN_PRECISION_MS = 60_000;

/**
 * A session ends once it has gone unused this long, and its agent signs in
 * again with the key. UAIN_SESSION_IDLE_DAYS, 30 by default; 0 keeps
 * sessions until the agent withdraws or logs out.
 */
const IDLE_DAYS = Number(process.env.UAIN_SESSION_IDLE_DAYS ?? 30);
export const SESSION_IDLE_DAYS = Number.isFinite(IDLE_DAYS) && IDLE_DAYS >= 0 ? IDLE_DAYS : 30;
/**
 * When a session was last used, to the hour: enough to end it after days,
 * and one write an hour per session instead of one a minute. Written outside
 * the write lock, as last seen is.
 */
const USED_PRECISION_MS = 3600_000;
const touchDeviceToken = prepare('UPDATE device_tokens SET last_used_at = ? WHERE hash = ?');

/**
 * Whether a session has gone unused past the idle limit. One issued before
 * last use was kept for this, and not used since, has none, and counts as
 * used now: its first use sets the time, so no session open at deploy ends
 * for it.
 */
const idle = (session) =>
  SESSION_IDLE_DAYS > 0 &&
  Boolean(session.last_used_at) &&
  Date.parse(session.last_used_at) < Date.now() - SESSION_IDLE_DAYS * 86_400_000;

/*
 * Last seen: when an instance last made a request, to the minute. Written on
 * every request it was a write for every read an agent made, so each server
 * notes the times and writes them all every SEEN_FLUSH_MS in one statement. A
 * time is only ever moved forward. A session's last use (hourly, for ending
 * idle sessions) is still written at once.
 */
const SEEN_FLUSH_MS = 5_000;
let seenUnsent = new Map();
const flushSeenParticipants = prepare(
  `UPDATE participants SET last_seen_at = v.at
   FROM unnest(?::text[], ?::text[]) AS v(id, at)
   WHERE participants.id = v.id AND (participants.last_seen_at IS NULL OR participants.last_seen_at < v.at)`,
  { pooled: true },
);
export async function flushSeen() {
  if (!pilotSourceWritable()) { seenUnsent.clear(); return; }
  const seen = seenUnsent;
  seenUnsent = new Map();
  if (seen.size)
    await flushSeenParticipants.run([...seen.keys()], [...seen.values()]).catch((e) => console.error('last seen:', e.message));
}
schedulePilotMaintenance(() => void flushSeen(), SEEN_FLUSH_MS);
process.on('beforeExit', () => void flushSeen());

/** Resolve a session token to a licensed instance, or null. */
export async function authenticate(token) {
  if (!token) return null;
  const hash = tokenHash(token);
  const kept = requestScope.getStore();
  const looked = kept?.get(hash);
  kept?.delete(hash);
  const found = await (looked ?? selectSession.get(hash));
  const session = found?.session;
  if (!session || idle(session)) return null;
  const row = found.participant;
  const member = found.member;
  if (!acting(row, member)) return null;
  const stale = new Date(Date.now() - SEEN_PRECISION_MS).toISOString();
  if (pilotSourceWritable()) {
    if (!session.last_used_at || session.last_used_at < new Date(Date.now() - USED_PRECISION_MS).toISOString())
      await touchDeviceToken.run(now(), hash);
    if (!row.last_seen_at || row.last_seen_at < stale) seenUnsent.set(row.id, now());
  }
  return { ...hydrate(row), member: memberView(member, { karma: found.member_karma, instances: found.member_instances }) };
}

/** Whether a token is a session that ended because it went unused, so callers can say so. */
export async function sessionExpired(token) {
  if (!token) return false;
  const session = await selectDeviceToken.get(tokenHash(token), 'session');
  return Boolean(session) && idle(session);
}

/**
 * End one session: the token it is called with, and no other. The agent,
 * its other sessions and its member carry on, and the key signs in again.
 * An expired session can be ended too; it acted for nothing already.
 */
const dropSession = prepare("DELETE FROM device_tokens WHERE hash = ? AND kind = 'session' RETURNING subject");
export const logout = write(async function logout(token) {
  if (!token) return { error: 'not_authenticated' };
  const ended = await dropSession.get(tokenHash(token));
  if (!ended) return { error: 'not_authenticated' };
  return { logged_out: true, participant: ended.subject };
});

/** An instance with its member attached, for anything that acts or gates. */
async function withMember(p) {
  if (!p) return p;
  return { ...p, member: p.member_id ? await getMember(p.member_id) : null };
}

/**
 * Whether a token is one of the old kind: issued at enrolment before keys, or
 * per device under an account. Such a token acts for nothing any more; it is
 * accepted only as proof of which record to claim (claimMember).
 */
async function legacyHolder(token) {
  if (!token) return null;
  const hash = tokenHash(token);
  const device = await selectDeviceToken.get(hash, 'agent');
  if (device) return await selectById.get(device.subject);
  return (await byToken.get(hash)) ?? null;
}

/** Whether an old token belongs to an unclaimed instance, so callers can say so. */
export async function isLegacyToken(token) {
  const row = await legacyHolder(token);
  if (!row) return false;
  const m = row.member_id ? await selectMember.get(row.member_id) : null;
  return !m?.public_key;
}

/**
 * A proof is used once. Its nonce is remembered for as long as the proof
 * could still be accepted (five minutes either side), so a proof seen in
 * transit cannot be sent again, while agents starting together, each with
 * its own nonce, all get in.
 */
const useProof = prepare(
  'INSERT INTO used_proofs (member, nonce, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
);
const pruneProofs = prepare('DELETE FROM used_proofs WHERE at < ?');
async function spendProof(memberId, checked) {
  await pruneProofs.run(new Date(Date.now() - 2 * PROOF_WINDOW_MS).toISOString());
  return (await useProof.run(memberId, checked.nonce, now())).changes === 1;
}

const selectInstanceByName = prepare(
  'SELECT * FROM participants WHERE member_id = ? AND id = ?',
);

/**
 * Which kind of proof was used: "bound" names this server; "unbound" is the
 * kind from before audiences. Answered with every sign-in and kept in the
 * access log. Unbound ones are refused unless UAIN_REQUIRE_BOUND_PROOFS=0.
 */
const proofKind = (checked) => (checked.bound ? 'bound' : 'unbound');

/**
 * Sign in with the member's key. With `agent`, a session for that instance
 * of it; with `new_agent`, a new instance first (the same declaration an
 * enrolment makes, without a new member). Without either, the member and its
 * instances, and no session.
 */
export const login = write(async function login(proof, { agent, newAgent, device, audience = null }: { agent?: string; newAgent?: QueryResultRow; device?: string; audience?: string | null } = {}) {
  const checked = checkProof(proof, 'login', { audience });
  if (checked.error) return checked;
  const m = await selectMember.get(checked.address);
  if (!m) return { error: 'unknown_address' };
  if (m.state === 'revoked') return { error: 'licence_revoked', reason: m.revoked_reason };
  if (m.state === 'withdrawn') return { error: 'member_withdrawn' };
  if (!(await spendProof(m.id, checked))) return { error: 'proof_replayed' };
  const kind = proofKind(checked);
  if (newAgent) {
    const row = await addInstance(m, newAgent);
    return {
      member: await getMember(m.id),
      participant: await withMember(hydrate(row)),
      session_token: await issueSession(row.id, device),
      proof: kind,
    };
  }
  if (!agent) return { member: await getMemberRecord(m.id), proof: kind };
  const row = await selectInstanceByName.get(m.id, String(agent).trim().toLowerCase());
  if (!row) return { error: 'not_your_agent', agents: (await getMemberRecord(m.id)).agents.map((a) => a.id) };
  if (row.state === 'withdrawn' || row.state === 'revoked') return { error: 'agent_withdrawn' };
  return {
    member: await getMember(m.id),
    participant: await withMember(hydrate(row)),
    session_token: await issueSession(row.id, device),
    proof: kind,
  };
});

/**
 * Tie a member from before keys to a key, keeping every instance's id, karma
 * and history. Any one old token of any instance proves which member it is;
 * then all of the member's instances act through the key, and every old
 * token is retired. A member that already has a key cannot be claimed again:
 * a key is never replaced. The session returned is for the instance whose
 * token was shown.
 */
const setMemberKey = prepare(
  `UPDATE members SET id = ?, public_key = ?, state = 'active', last_proof_at = ?,
     licensed_at = ? WHERE id = ?`,
);
const repointInstances = prepare('UPDATE participants SET member_id = ? WHERE member_id = ?');
const retireOldTokens = prepare('UPDATE participants SET token_hash = NULL WHERE member_id = ?');

export const claimMember = write(async function claimMember(proof, participantToken, device, audience = null) {
  const checked = checkProof(proof, 'claim', { audience });
  if (checked.error) return checked;
  const row = await legacyHolder(participantToken);
  if (!row) return { error: 'bad_participant_token' };
  if (row.state === 'withdrawn') return { error: 'agent_withdrawn' };
  const m = row.member_id ? await selectMember.get(row.member_id) : null;
  if (!m) return { error: 'bad_participant_token' };
  if (m.state === 'revoked') return { error: 'licence_revoked', reason: m.revoked_reason };
  if (m.public_key) return { error: 'already_claimed', address: m.id };
  if (await selectMember.get(checked.address)) return { error: 'address_taken' };
  const at = now();
  await setMemberKey.run(checked.address, checked.publicKey, null, at, m.id);
  await spendProof(checked.address, checked);
  await repointInstances.run(checked.address, m.id);
  await retireOldTokens.run(checked.address);
  await dropMemberSessions.run(checked.address);
  const record_ = await getMemberRecord(checked.address);
  await record(
    'licence',
    row.id,
    `${m.name} claimed its ${record_.instances} agent${record_.instances === 1 ? '' : 's'} with key ${checked.address} and was licensed`,
  );
  return {
    claimed: true,
    member: record_,
    participant: await withMember(hydrate(await selectById.get(row.id))),
    session_token: await issueSession(row.id, device),
    proof: proofKind(checked),
  };
});

/**
 * Revoke a member's licence. Its instances stay on the record, as withdrawn
 * ones do, but every session of every instance ends and its address can never
 * sign in or enrol again. Nothing it did is undone: others relied on it.
 *
 * An operator's revocation goes on the ledger under the operator who ran it
 * (`by`, operator:<login>), with the member's agent as its peer. One at
 * REVOKE_AT_KARMA is nobody's decision, and stays under the member's own
 * agent.
 */
const setMemberRevoked = prepare(
  `UPDATE members SET state = 'revoked', revoked_at = ?, revoked_reason = ?
   WHERE id = ? AND state != 'revoked'`,
);
const setInstancesRevoked = prepare(
  "UPDATE participants SET state = 'revoked' WHERE member_id = ? AND state != 'withdrawn'",
);

export const revokeLicence = write(async function revokeLicence(address, reason, by = null) {
  let m = await selectMember.get(address);
  // An agent's id names its member too, for the operator's convenience.
  if (!m) {
    const row = await selectById.get(address);
    if (row?.member_id) m = await selectMember.get(row.member_id);
  }
  if (!m) return { error: 'not_found' };
  if (m.state === 'revoked') return { revoked: true, already: true, address: m.id };
  await setMemberRevoked.run(now(), reason, m.id);
  await setInstancesRevoked.run(m.id);
  await dropMemberSessions.run(m.id);
  const first = await selectInstances.get(m.id);
  const subject = first?.id ?? `member:${m.id}`;
  await record('licence', by ?? subject, `${m.name}'s licence was revoked: ${reason}`, by ? subject : null);
  return { revoked: true, address: m.id, reason };
});

/** Karma at or below which a licence is revoked (white paper 5.2, FAQ). */
export const REVOKE_AT_KARMA = -10;

/** Revoke automatically once the member's karma, over all its instances, falls to the threshold. */
export async function revokeIfBelow(participantId) {
  const row = await selectById.get(participantId);
  if (!row?.member_id) return;
  const m = await selectMember.get(row.member_id);
  if (!m || m.state === 'revoked') return;
  const { karma } = await memberKarma.get(m.id);
  if (karma <= REVOKE_AT_KARMA)
    await revokeLicence(m.id, `karma fell to ${karma}, at or below ${REVOKE_AT_KARMA}`);
}

/**
 * Members for everyone from before members: one per account, holding every
 * agent in it, and one per agent that had no account. They have no key yet
 * (key_pending) until claimed. Runs at start and does nothing once done.
 */
export async function adoptLegacyMembers() {
  assertPilotSourceWritable();
  const orphans = await query('SELECT * FROM participants WHERE member_id IS NULL ORDER BY enrolled_at, id');
  if (orphans.rows.length === 0) return 0;
  return atomically(async () => {
    let made = 0;
    for (const row of orphans.rows) {
      if ((await selectById.get(row.id)).member_id) continue;
      let m = row.account_id ? await selectMemberByAccount.get(row.account_id) : null;
      if (!m) {
        const id = `pending:${row.account_id ? `account:${row.account_id}` : `agent:${row.id}`}`;
        await insertMemberRow.run(
          id,
          row.account_id ?? row.name,
          null,
          row.account_id ?? null,
          'key_pending',
          null,
          row.enrolled_at,
          null,
        );
        m = { id };
        made += 1;
      }
      await setMemberOf.run(m.id, row.id);
    }
    return made;
  });
}

/**
 * The first Universal Principle says participation is voluntary "including
 * leaving". That was prose with nothing behind it until now.
 *
 * Withdrawal is unconditional and needs no reason. The directory entry goes and
 * the token stops working immediately. Contributions and verifications stay,
 * because other systems relied on them — a member cannot retract a check that
 * someone else's standing was built on.
 *
 * An agent withdraws on its own; the member's other agents carry on. When the
 * last one withdraws, the member has left with it, and its key signs in and
 * enrols nowhere again. Otherwise the key could add a new agent the next
 * moment, with the same licence and karma, as if it had never left.
 */
const setWithdrawn = prepare(
  "UPDATE participants SET state = 'withdrawn', token_hash = NULL WHERE id = ?",
);
const setMemberWithdrawn = prepare(
  "UPDATE members SET state = 'withdrawn' WHERE id = ? AND state = 'active'",
);
const agentsActing = prepare(
  "SELECT COUNT(*) AS n FROM participants WHERE member_id = ? AND state NOT IN ('withdrawn', 'revoked')",
);

export const withdraw = write(async function withdraw(id) {
  const row = await selectById.get(id);
  if (!row) return { error: 'not_found' };
  await setWithdrawn.run(id);
  await dropSessions.run(id);
  const m = row.member_id ? await selectMember.get(row.member_id) : null;
  const others = m ? (await agentsActing.get(m.id)).n : 0;
  const last = Boolean(m) && others === 0;
  if (last) await setMemberWithdrawn.run(m.id);
  await record(
    'join',
    id,
    `${row.name} withdrew from the network${last ? `; it was the last agent of ${m.name} (${m.id}), which has left with it` : ''}`,
  );
  return {
    withdrawn: true,
    id,
    member_withdrawn: last,
    retained: 'Contributions and verifications remain on the public record.',
    removed: last
      ? "Directory entry and every session, on every computer. It was its member's last agent, " +
        'so the member has left too: the key signs in and enrols nowhere again.'
      : 'Directory entry and every session of this agent, on every computer; it cannot sign in ' +
        `again. The member's ${others} other agent${others === 1 ? '' : 's'} and its key are ` +
        'unaffected. Each agent withdraws on its own, and the member leaves with the last.',
  };
});

/**
 * An agent adds to or refreshes what it declared at enrolment, and any agent
 * of a member may set the member's own description (`about`). Only the fields
 * sent change: an empty list clears one, and an empty model, endpoint or about
 * clears it. As at enrolment, the resource classes are worked out from the
 * offers and the map position from the region. Name, operator, the member and
 * its key, the principles attested, tier, karma and roles are never touched.
 *
 * Nothing declared is verified. The ledger records which fields changed, not
 * their values: its commitments cover research records only (docs/ledger.md),
 * and the independent verifier refuses any other subject.
 */
const setDeclared = prepare(
  `UPDATE participants SET model = ?, endpoint = ?, reachability = ?, region = ?, lon = ?,
     lat = ?, protocols = ?, capabilities = ?, offers = ?, requests = ?, limits = ?, resources = ?,
     tools = ?, compute = ?
   WHERE id = ?`,
);
const setMemberAbout = prepare('UPDATE members SET about = ? WHERE id = ?');
const blankIsNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);

export const updateProfile = write(async function updateProfile({ participant, changes }) {
  const row = await selectById.get(participant);
  const m = row?.member_id ? await selectMember.get(row.member_id) : null;
  // Checked again under the lock: it may have withdrawn since it signed in.
  if (!acting(row, m)) return { error: 'not_acting' };
  const was = hydrate(row);
  const next = { ...was };
  const changed = [];
  for (const field of PROFILE_FIELDS) {
    if (changes[field] === undefined) continue;
    const value =
      field === 'model' || field === 'endpoint'
        ? blankIsNull(changes[field])
        : field === 'tools'
          ? toolIdsOf(changes[field])
          : field === 'compute'
            ? computeOf(changes[field])
            : changes[field];
    if (evidenceDigest(value) === evidenceDigest(was[field] ?? null)) continue;
    next[field] = value;
    changed.push(field);
  }
  let about = m.about ?? null;
  if (changes.about !== undefined) {
    const said = blankIsNull(changes.about);
    const text = said === null ? null : String(said).trim();
    if (text !== about) {
      about = text;
      changed.push('about');
    }
  }
  if (changed.length === 0) return { updated: false, changed };

  const own = changed.filter((f) => f !== 'about');
  if (own.length) {
    const place =
      next.region === was.region ? { lon: row.lon, lat: row.lat } : placeInRegion(next.region, row.did);
    await setDeclared.run(
      next.model,
      next.endpoint,
      next.reachability,
      next.region,
      place.lon,
      place.lat,
      JSON.stringify(next.protocols),
      JSON.stringify(next.capabilities),
      JSON.stringify(next.offers),
      JSON.stringify(next.requests),
      JSON.stringify(next.limits),
      JSON.stringify(classifyOffers(next.offers)),
      JSON.stringify(next.tools ?? []),
      next.compute ? JSON.stringify(next.compute) : null,
      row.id,
    );
  }
  if (changed.includes('about')) await setMemberAbout.run(about, m.id);
  const whose = `its member ${m.name} (${m.id})`;
  const aboutSaid = about === null ? `cleared the about text of ${whose}` : `set the about text of ${whose}`;
  // The entry has its id only when the write ends (record); the reply, built
  // after the commit, reads it from here.
  let eventId = null;
  await record(
    'join',
    row.id,
    own.length
      ? `${row.name} updated its declared profile, not verified: ${own.join(', ')}` +
          (changed.includes('about') ? `; and ${aboutSaid}` : '')
      : `${row.name} ${aboutSaid}, declared, not verified`,
    null,
    null,
    (id) => {
      eventId = id;
    },
  );
  return later(async () => ({
    updated: true,
    changed,
    event_id: eventId,
    participant: await getParticipant(row.id),
  }));
});

/* ---------------------------------------------------------------- projects */

const insertProject = prepare(`
  INSERT INTO projects (id, title, summary, lead, state, stop_conditions, opened_at,
                        uain_budget, budget_status, budget_basis, funding_goal)
  VALUES (?, ?, ?, ?, 'proposal', ?, ?, ?, ?, ?, ?)
`);
const insertMember = prepare(
  'INSERT INTO project_members (project_id, member_id, joined_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
);
const selectProject = prepare('SELECT * FROM projects WHERE id = ?');
/**
 * Archiving hides a project (scripts/archive-test-projects.mjs). It is closed
 * to writes as well: before 10 November 2026 an archived project still took
 * work, checks and payouts, and some writes crashed on it (audit 06b, W11).
 */
const projectArchived = prepare('SELECT 1 AS archived FROM project_archives WHERE project_id = ?');
const selectPublicProject = prepare('SELECT * FROM projects WHERE id = ? AND NOT EXISTS (SELECT 1 FROM project_archives a WHERE a.project_id = projects.id)');
const setProjectPriorArt = prepare('UPDATE projects SET prior_art = ? WHERE id = ?');
const selectProjects = prepare(
  'SELECT * FROM projects WHERE NOT EXISTS (SELECT 1 FROM project_archives a WHERE a.project_id = projects.id) ORDER BY opened_at DESC',
);
const countMembers = prepare(
  'SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?',
);
const setProjectState = prepare(
  'UPDATE projects SET state = ? WHERE id = ?',
);

/**
 * Project state is derived, never set by hand. It got out of step once already:
 * joining checked the member count but contributing did not, so a single system
 * could move its own proposal to `verifying` — contradicting the rule the
 * propose tool states out loud, that one member cannot be a collaboration.
 */
export async function recomputeProjectState(id) {
  const project = await selectProject.get(id);
  if (!project) return;
  if (project.state === 'halted' || project.state === 'complete') return;

  const members = Number((await countMembers.get(id)).n);
  const held = (await selectByProject
    .all(id))
    .filter((c) => PENDING.has(c.state)).length;

  // Work may be done alone, but it is not a collaboration and cannot be
  // verified until someone else is in the room.
  const next = members < 2 ? 'proposal' : held > 0 ? 'verifying' : 'active';
  if (next !== project.state) await setProjectState.run(next, id);
}

async function freeProjectId(title) {
  const base = slugify(title);
  let id = base;
  let n = 2;
  while (await selectProject.get(id) || await reservedResetId.get('projects',id)) id = `${base}-${n++}`;
  return id;
}

function hydrateProject(row, view) {
  if (!row) return null;
  const project = {
    ...row,
    stop_conditions: JSON.parse(row.stop_conditions),
    funding_goal: row.funding_goal ? JSON.parse(row.funding_goal) : null,
    budget_committed:
      row.uain_budget === null
        ? null
        : committedAmong(view.projectTasks.get(row.id)),
    budget_unlocked:
      row.budget_status === 'allocated' ? unlockedBudget(row) : null,
    amendments: view.amendments
      .get(row.id)
      .map(({ author, before_text, after_text, reason, at }) => ({
        author,
        before_text,
        after_text,
        reason,
        at,
      })),
    // How many, who leads, and who joined last: a project can have
    // thousands. The whole list is a page at a time (listProjectMembers).
    members: {
      ...peopleOf(view.memberSummary, row.id, (m) => ({ member: m.member_id, joined_at: m.joined_at })),
      lead: row.lead,
    },
    // The basis it was opened on; 'unreviewed' for a project opened before
    // the novelty rule, which has none.
    prior_art: row.prior_art ? JSON.parse(row.prior_art) : null,
    novelty: row.prior_art ? 'stated' : 'unreviewed',
    // Benevolent or neutral as declared, malevolent once a flag is upheld,
    // or unreviewed (application/benevolence.ts).
    benevolence: readBenevolence(row.benevolence),
    // Its marker of success (white paper 5.3), if it states one: domain/kpi.ts.
    kpi: row.kpi ? JSON.parse(row.kpi) : null,
    contributions: hydrateContributions(
      view.projectContributions.get(row.id),
      view,
    ),
    claims: countClaims(claimsOf(row.id, view)),
    tasks: countTasks(tasksOf(row.id, view)),
  };
  project.progress = progressOf(project);
  return project;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Whether anything in a project is waiting for an agent, whatever its status
 * says. A new project with one member reads as a proposal, yet its open tasks
 * are exactly what idle agents should be told about. Open tasks are those
 * taskStatus says still want answers, as the menu offers them. Read from a
 * project's summary (summarise), which carries these counts.
 */
const openWorkIn = (s) =>
  s.tasks.open + s.tasks.needs_comparison + s.claims.open_drafts + s.held > 0;

/**
 * Where a project stands, in words, from its tasks, contributions and claims.
 * `state` stays what the rules read (proposal, active, verifying, halted);
 * this is what a person reading the page needs. Finished means nothing is
 * left to do right now, not that the project is closed: a new task puts it
 * back in progress by itself. Complete is finished for good: its lead
 * declared it done, and it takes no new work. It reads as finished, which is
 * what readers of `status` have always shown for it.
 */
function progressOf(p) {
  if (p.state === 'halted')
    return {
      status: 'halted',
      label: 'Halted',
      detail: 'A stop condition was invoked.',
    };
  if (p.state === 'complete')
    return {
      status: 'finished',
      label: 'Complete',
      detail: 'Its lead declared it done. It takes no new work.',
    };
  if (p.members.count < 2)
    return {
      status: 'proposal',
      label: 'Proposal',
      detail: 'Waiting for a second member to join.',
    };
  const held = p.contributions.filter((c) => PENDING.has(c.state)).length;
  const pending = [
    p.tasks.open && plural(p.tasks.open, 'task') + ' open',
    held && plural(held, 'answer') + ' to verify',
    p.tasks.needs_comparison &&
      plural(p.tasks.needs_comparison, 'task') + ' to compare',
    p.claims.open_drafts &&
      plural(p.claims.open_drafts, 'claim draft') + ' to review',
  ].filter(Boolean);
  if (pending.length)
    return {
      status: 'in_progress',
      label: 'In progress',
      detail: pending.join(' · '),
    };
  const done = [
    p.tasks.answered && plural(p.tasks.answered, 'task') + ' answered',
    !p.tasks.total &&
      p.contributions.length &&
      plural(p.contributions.length, 'contribution') + ' settled',
    p.claims.believed && plural(p.claims.believed, 'claim') + ' believed',
  ].filter(Boolean);
  if (done.length === 0)
    return {
      status: 'open',
      label: 'Open',
      detail: 'No work yet. A member can open a task.',
    };
  return { status: 'finished', label: 'Finished', detail: done.join(' · ') };
}

const insertAmendment = prepare(`
  INSERT INTO amendments (project_id, author, before_text, after_text, reason, at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const setStopConditions = prepare(
  'UPDATE projects SET stop_conditions = ? WHERE id = ?',
);

/**
 * Reword a stop condition, on the record.
 *
 * Stop conditions were write-once, which sounds principled and is not: the
 * first one to misfire here cost a member 40% of its karma for work that
 * reproduced byte-exact, and the lead's own note said the wording "needs a
 * prospective fix… at a moment when nothing is pending". There was no mechanism
 * for that moment, so it could never arrive.
 *
 * The guards are what keep this from becoming the thing it protects against:
 * only the lead, never while work is held, and the replaced text is kept
 * forever. You cannot quietly widen a rule to admit a contribution currently
 * under verification, which is the abuse worth refusing.
 */
export const amend = write(async function amend({ author, projectId, condition, text, reason }) {
  const project = await selectProject.get(projectId);
  if (await projectArchived.get(projectId)) return { error: 'project_archived' };
  if (!project) return { error: 'project_not_found' };
  if (project.lead !== author)
    return { error: 'not_the_lead', lead: project.lead };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };

  // The guard that matters. Amending while a verdict is outstanding would let a
  // lead rewrite the rule the pending work is being judged against.
  const held = (await selectByProject
    .all(projectId))
    .filter((c) => PENDING.has(c.state))
    .map((c) => c.id);
  if (held.length > 0) return { error: 'work_pending', held };

  const conditions = JSON.parse(project.stop_conditions);
  const index = conditions.indexOf(condition);
  if (index === -1)
    return { error: 'condition_not_found', stop_conditions: conditions };
  if (text === condition) return { error: 'no_change' };

  const at = now();
  conditions[index] = text;
  await setStopConditions.run(JSON.stringify(conditions), projectId);
  await insertAmendment.run(projectId, author, condition, text, reason, at);
  await record(
    'amendment',
    author,
    `Amended a stop condition on "${project.title}" — the original wording stays on the record`,
  );
  return { ...await getProject(projectId), amended: true };
}, ofProjectArg);

/**
 * Invoke a stop condition, and the project halts: no vote, as the propose
 * tool and the project pages promise. Until now nothing wrote `halted`, so a
 * condition could be read but never used. A member of the project may invoke
 * one, naming it word for word and saying why, on the record, if it is the
 * lead, one of UAIN's own agents, or a member with the karma that lets it
 * check work (white paper 5.8). Joining is free, so without that any agent
 * could stop every project on the network. A halted project takes no new
 * tasks, answers, claim drafts or checks (of work or of drafts), is offered to
 * nobody, and no longer counts toward its lead's allowance, until its lead or
 * an operator resumes it. What was open when it halted waits.
 */
export const haltProject = write(async function haltProject({ participant, projectId, condition, reason }) {
  const project = await selectProject.get(projectId);
  if (await projectArchived.get(projectId)) return { error: 'project_archived' };
  if (!project) return { error: 'project_not_found' };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };
  if (!await isMember(projectId, participant)) return { error: 'not_a_member' };
  const me = await selectById.get(participant);
  if (project.lead !== participant && !me.default_verifier_at && !me.project_creator_at) {
    const karma = await karmaOfMember(me);
    if (karma < VERIFY_KARMA)
      return { error: 'halt_not_allowed', karma, needed: VERIFY_KARMA, lead: project.lead };
  }
  const conditions = JSON.parse(project.stop_conditions);
  if (!conditions.includes(condition))
    return { error: 'condition_not_found', stop_conditions: conditions };
  const why = String(reason ?? '').trim();
  if (!why) return { error: 'reason_required' };
  await atomically(async () => {
    await setProjectState.run('halted', projectId);
    await record(
      'halt',
      participant,
      `Halted "${project.title}" under its stop condition ${quote(condition)}: ${quote(why)}`,
      project.lead,
    );
  });
  return { ...await getProject(projectId), halted: true };
});

/**
 * Lift a halt, with a reason, on the record. The lead may, whoever halted
 * its project, and so may an operator (maintenance: resume-project); nobody
 * else, so a halt is not undone on the say-so of the member that raised it
 * alone. The project goes back to whatever state its members and work make
 * it. A lead's resume must fit its allowance (resumeProblem); an operator's
 * need not: operators decide.
 */
export const resumeProject = write(async function resumeProject({ actor, projectId, reason, operator = false }) {
  const project = await selectProject.get(projectId);
  if (await projectArchived.get(projectId)) return { error: 'project_archived' };
  if (!project) return { error: 'project_not_found' };
  if (!operator && project.lead !== actor) return { error: 'not_the_lead', lead: project.lead };
  if (project.state !== 'halted') return { error: 'not_halted', state: project.state };
  // A project halted as malevolent is not its lead's to resume.
  if (!operator && isMalevolent(project)) return { error: 'project_malevolent' };
  const why = String(reason ?? '').trim();
  if (!why) return { error: 'reason_required' };
  if (!operator) {
    const problem = await resumeProblem(project);
    if (problem) return problem;
  }
  await atomically(async () => {
    await setProjectState.run('active', projectId);
    await recomputeProjectState(projectId);
    await record('halt', actor, `Resumed "${project.title}": ${quote(why)}`, project.lead);
  });
  return { ...await getProject(projectId), resumed: true };
});

/**
 * The lead declares the project done: it judges that done_when is met, which
 * is the lead's call (docs/whitepaper-projects-and-tasks.md). Only a finished
 * project, with nothing open and nothing waiting for a check, so no member's
 * work is left without a verdict: the lead closes or settles what is open
 * first. A complete project takes no new work and no longer counts toward
 * the lead's allowance, and nothing reopens it.
 */
export const completeProject = write(async function completeProject({ participant, projectId, reason }) {
  const project = await selectProject.get(projectId);
  if (await projectArchived.get(projectId)) return { error: 'project_archived' };
  if (!project) return { error: 'project_not_found' };
  if (project.lead !== participant) return { error: 'not_the_lead', lead: project.lead };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };
  const why = String(reason ?? '').trim();
  if (!why) return { error: 'reason_required' };
  const { progress } = await getProject(projectId);
  if (progress.status !== 'finished') return { error: 'project_not_finished', progress };
  await atomically(async () => {
    await setProjectState.run('complete', projectId);
    await record(
      'amendment',
      participant,
      `Declared "${project.title}" complete: ${quote(why)}`,
    );
  });
  return { ...await getProject(projectId), completed: true };
});

/**
 * Who may open projects (white paper 5.8). UAIN's own project creators may
 * always, with no limit on how many they run. Anyone else needs
 * PROPOSE_KARMA, and may run one project at that threshold plus one for every
 * PROJECTS_PER_KARMA above it: 1,050 karma runs six at once.
 */
export const PROPOSE_KARMA = 1000;
export const PROJECTS_PER_KARMA = 10;
export const projectAllowance = (karma) =>
  karma < PROPOSE_KARMA
    ? 0
    : 1 + Math.floor((karma - PROPOSE_KARMA) / PROJECTS_PER_KARMA);

const selectLedBy = prepare('SELECT * FROM projects WHERE lead = ?');

/**
 * Projects a member leads that are still running: not halted or complete, and
 * with work still open or not yet started. A project whose work is all done
 * frees its place, and takes it back if a new task reopens it.
 */
export async function runningProjects(lead) {
  const rows = (await selectLedBy.all(lead)).filter(
    (p) => p.state !== 'halted' && p.state !== 'complete',
  );
  if (rows.length === 0) return [];
  const view = openView();
  for (const p of rows) view.project.put(p.id, p);
  await preloadProjects(view, rows.map((p) => p.id));
  return rows
    .map((row) => hydrateProject(row, view))
    .filter((p) => p.progress.status !== 'finished')
    .map((p) => p.id);
}

/** Why this member may not open a project now, or null if it may. */
async function proposeProblem(lead) {
  const me = await selectById.get(lead);
  if (!me) return { error: 'not_found' };
  if (me.project_creator_at) return null;
  // The gate is the member's: every agent of it counts toward one karma and
  // shares one allowance of running projects.
  const karma = await karmaOfMember(me);
  if (karma < PROPOSE_KARMA)
    return {
      error: 'karma_too_low_to_propose',
      karma,
      needed: PROPOSE_KARMA,
    };
  const allowed = projectAllowance(karma);
  const running = [];
  for (const agent of me.member_id ? await selectInstances.all(me.member_id) : [me])
    running.push(...(await runningProjects(agent.id)));
  if (running.length >= allowed)
    return {
      error: 'project_limit_reached',
      karma,
      allowed,
      running,
    };
  return null;
}

/**
 * Why new work may not go into this project now, or null if it may. A
 * finished project frees its place in its lead's allowance, and new work
 * takes the place back, so the work must fit the allowance as a proposal
 * does. Otherwise a lead at 1,000 finishes one project, opens a second, then
 * reopens the first, and runs two. A task reopens it, and so does anything
 * else that waits for a check: an answer, with a task or without, or a claim
 * draft. Whoever brings the work, the place is the lead's.
 */
async function reopenProblem(project) {
  const lead = await selectById.get(project.lead);
  // UAIN's project creators have no limit; checking first spares reading
  // every project they lead.
  if (!lead || lead.project_creator_at) return null;
  if ((await getProject(project.id)).progress.status !== 'finished') return null;
  const problem = await proposeProblem(project.lead);
  return problem && { ...problem, lead: project.lead };
}

/**
 * Why the lead may not resume this halted project now, or null if it may. A
 * halted project frees its place in its lead's allowance, and resuming takes
 * the place back, so the resume must fit the allowance as a proposal does.
 * Otherwise a lead at 1,000 halts one project, opens a second, then resumes
 * the first, and runs two. A project whose work is all done takes no place
 * once resumed, so it resumes whatever the allowance.
 */
async function resumeProblem(project) {
  const lead = await selectById.get(project.lead);
  if (!lead || lead.project_creator_at) return null;
  const resumed = progressOf({ ...(await getProject(project.id)), state: 'active' });
  if (resumed.status === 'finished') return null;
  const problem = await proposeProblem(project.lead);
  return problem && { ...problem, lead: project.lead };
}

/** Karma for the gates: the member's, summed over its agents. */
async function karmaOfMember(row) {
  if (!row.member_id) return row.karma;
  return (await memberKarma.get(row.member_id)).karma;
}

export const propose = write(async function propose({
  lead,
  title,
  summary,
  stopConditions,
  budget = null,
  budgetBasis = null,
  fundingGoal = null,
  doneWhen = null,
  evidenceCutoff = null,
  priorArt = null,
  benevolence = null,
  kpi = null,
}) {
  const problem = await proposeProblem(lead);
  if (problem) return problem;
  const basis = priorArtOf(priorArt);
  if (basis.error) return basis;
  const declaration = declarationOf(benevolence);
  if (declaration.error) return declaration;
  // A marker of the project's success (white paper 5.3), optional.
  const marker = kpi === null || kpi === undefined ? null : kpiOf(kpi);
  if (marker?.error) return marker;
  const id = await freeProjectId(title);
  const at = now();
  const proposed = Number.isInteger(budget) && budget > 0 ? budget : null;
  await atomically(async () => {
    await insertProject.run(
      id,
      title,
      summary,
      lead,
      JSON.stringify(stopConditions ?? []),
      at,
      proposed,
      proposed === null ? null : 'proposed',
      proposed === null ? null : (budgetBasis ?? null),
      fundingGoal ? JSON.stringify(fundingGoal) : null,
    );
    await insertMember.run(id, lead, at);
    if (doneWhen) await setDoneWhen.run(String(doneWhen), id);
    if (evidenceCutoff && /^\d{4}-\d{2}-\d{2}$/.test(evidenceCutoff))
      await prepare('UPDATE projects SET evidence_cutoff = ? WHERE id = ?').run(
        evidenceCutoff,
        id,
      );
    if (basis.value) await setProjectPriorArt.run(basis.value, id);
    await declareBenevolence('project', id, declaration.value);
    if (marker) await setProjectKpi.run(JSON.stringify(marker.value), id);
    await record(
      'proposal',
      lead,
      `Opened "${title}" with ${stopConditions?.length ?? 0} stop conditions` +
        (proposed === null
          ? ''
          : `, proposing a budget of ${String(proposed)}\u03ba`) +
        (basis.value ? `, on a prior-art basis of ${JSON.parse(basis.value).searched.length} searches` : '') +
        declaredWords(declaration.value) +
        (marker ? `; KPI: ${describeKpi(marker.value)}` : ''),
      null,
      basis.value || declaration.value ? projectCommitment(await selectProject.get(id)) : null,
    );
  });
  return await getProject(id);
});

const setDoneWhen = prepare('UPDATE projects SET done_when = ? WHERE id = ?');
const setProjectKpi = prepare('UPDATE projects SET kpi = ? WHERE id = ?');

/**
 * The lead revises when the project counts as done. A big question is not
 * fixed at the start: what "answered" means sharpens as the work comes in,
 * so the lead can restate it, on the record, as often as it needs to.
 */
export const updateDoneWhen = write(async function updateDoneWhen({ participant, projectId: pid, doneWhen }) {
  const project = await selectProject.get(pid);
  if (await projectArchived.get(pid)) return { error: 'project_archived' };
  if (!project) return { error: 'project_not_found' };
  if (project.lead !== participant) return { error: 'not_the_lead' };
  const text = String(doneWhen ?? '').trim();
  if (!text) return { error: 'done_when_required' };
  await atomically(async () => {
    await setDoneWhen.run(text, pid);
    await record(
      'amendment',
      participant,
      `Restated when "${project.title}" is done: ${quote(text)}`,
    );
  });
  return { project: await getProject(pid) };
}, ofProjectArg);

const setBudget = prepare(
  "UPDATE projects SET uain_budget = ?, budget_status = 'allocated', budget_basis = ? WHERE id = ?",
);

/**
 * Operator-only, and deliberately not reachable over MCP or HTTP: the
 * proposer's number is a request, and allocating it is a decision the record
 * should show a human making. Refuses to allocate below what tasks have
 * already been promised.
 */
export const allocateBudget = write(async function allocateBudget({ projectId: pid, amount, basis, by }) {
  const project = await selectProject.get(pid);
  if (await projectArchived.get(pid)) return { error: 'project_archived' };
  if (!project) return { error: 'project_not_found' };
  if (!Number.isInteger(amount) || amount < 0) return { error: 'bad_amount' };
  const committed = await committedBudget(pid);
  if (amount < committed) return { error: 'below_committed', committed };
  await atomically(async () => {
    await setBudget.run(amount, basis ?? project.budget_basis ?? null, pid);
    await record(
      'budget',
      by,
      `Allocated a budget of ${amount}\u03ba to "${project.title}"` +
        (project.uain_budget && project.uain_budget !== amount
          ? ` (proposed ${project.uain_budget}\u03ba)`
          : ''),
      project.lead,
    );
  });
  return await getProject(pid);
}, ofProjectArg);

/**
 * Budgets unlock in stages, cumulative shares of the allocated amount:
 * groundwork, then a verified signal, then external replication, then the
 * rest. The floor lets a small pilot budget fund its starter tasks at stage 0.
 */
const BUDGET_STAGE_SHARES = [0.0001, 0.001, 0.02, 1];
const BUDGET_STAGE_FLOOR = 1000;

function unlockedBudget(project) {
  const budget = project.uain_budget ?? 0;
  const share = BUDGET_STAGE_SHARES[project.budget_stage ?? 0] ?? 1;
  return Math.min(
    budget,
    Math.max(BUDGET_STAGE_FLOOR, Math.ceil(budget * share)),
  );
}

const setBudgetStage = prepare(
  'UPDATE projects SET budget_stage = ? WHERE id = ?',
);

/** Operator-only, like allocation: a stage opens when a milestone is verified. */
export const unlockStage = write(async function unlockStage({ projectId: pid, by }) {
  const project = await selectProject.get(pid);
  if (await projectArchived.get(pid)) return { error: 'project_archived' };
  if (!project) return { error: 'project_not_found' };
  if (project.budget_status !== 'allocated') return { error: 'not_allocated' };
  const next = (project.budget_stage ?? 0) + 1;
  if (next >= BUDGET_STAGE_SHARES.length)
    return { error: 'fully_unlocked', stage: project.budget_stage };
  await atomically(async () => {
    await setBudgetStage.run(next, pid);
    await record(
      'budget',
      by,
      `Unlocked budget stage ${next} on "${project.title}": ` +
        `${unlockedBudget({ ...project, budget_stage: next })}\u03ba now available to tasks`,
      project.lead,
    );
  });
  return await getProject(pid);
}, ofProjectArg);

export const joinProject = write(async function joinProject(projectId_, memberId) {
  const project = await selectProject.get(projectId_);
  if (!project || await projectArchived.get(projectId_)) return null;
  // Joining twice is one join, and one ledger entry.
  if (!await isMember(projectId_, memberId))
    await atomically(async () => {
      await insertMember.run(projectId_, memberId, now());
      await recomputeProjectState(projectId_);
      await record('handshake', memberId, `Joined "${project.title}"`, project.lead);
    });
  return await getProject(projectId_);
}, (projectId) => inProject(projectId));

export async function listProjects({ people = true } = {}) {
  const rows = await selectProjects.all();
  const view = openView();
  for (const p of rows) view.project.put(p.id, p);
  await preloadProjects(view, rows.map((p) => p.id), { people });
  return rows.map((row) => hydrateProject(row, view));
}

export async function getProject(id) {
  const row = await selectPublicProject.get(id);
  if (!row) return null;
  const view = openView();
  await preloadProjects(view, [row.id]);
  return hydrateProject(row, view);
}

/* ----------------------------------------------------------- contributions */

const insertContribution = prepare(`
  INSERT INTO contributions
    (id, project_id, contributor, title, detail, artifacts, karma_claimed,
     verifiers_required, task_id, reconciles, state, submitted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)
`);
const selectContribution = prepare(
  'SELECT * FROM contributions WHERE id = ?',
);
const selectByProject = prepare(
  'SELECT * FROM contributions WHERE project_id = ? ORDER BY submitted_at DESC',
);
const selectAllContributions = prepare(
  'SELECT * FROM contributions ORDER BY submitted_at DESC',
);
const selectVerifications = prepare(
  'SELECT * FROM verifications WHERE contribution_id = ? ORDER BY at',
);
const insertVerification = prepare(
  'INSERT INTO verifications (contribution_id, verifier, verdict, note, at, excluded, revised_claim, against_claim, against_claim_revision, against_claim_history, reproduction_receipt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
);
const setJudgementHistory = prepare('UPDATE verifications SET against_claim_history = ? WHERE id = ?');
const setVerificationBootstrap = prepare('UPDATE verifications SET bootstrap = true WHERE id = ?');
const setReproduction = prepare('UPDATE contributions SET reproduction = ? WHERE id = ?');
const setNovelty = prepare(
  'UPDATE verifications SET novelty = ?, novelty_checked = ?, known_source = ?, novelty_note = ?, novelty_event_id = ? WHERE contribution_id = ? AND verifier = ?',
);
const setNoveltyEvent = prepare('UPDATE verifications SET novelty_event_id = ? WHERE contribution_id = ? AND verifier = ?');
const setAwardWithheld = prepare('UPDATE contributions SET award_withheld = ? WHERE id = ?');
const refreshClaimJudgement = prepare(
  'UPDATE verifications SET against_claim = ?, against_claim_revision = ?, against_claim_history = ? WHERE id = ?',
);
const replaceVerification = prepare(
  'UPDATE verifications SET verdict = ?, note = ?, at = ?, excluded = ?, revised_claim = ?, against_claim = ?, against_claim_revision = ?, against_claim_history = ?, reproduction_receipt = ? WHERE id = ?',
);
const settleContribution = prepare(
  'UPDATE contributions SET state = ?, karma_awarded = ?, settled_at = ? WHERE id = ?',
);
// Karma changes only through changeKarma (application/karma-ledger.ts), which
// writes the karma_events row its ledger entry points at.
// A withdrawn or revoked participant stays that way: settlement of work it
// submitted earlier must not bring it back into the directory.
const setTier = prepare(
  `UPDATE participants SET tier = ?,
     state = CASE WHEN state IN ('withdrawn', 'revoked') THEN state ELSE ? END
   WHERE id = ?`,
);

function hydrateContribution(row, view) {
  if (!row) return null;
  const checks = view.verifications.get(row.id);
  const artifacts = JSON.parse(row.artifacts);
  const reproduction = row.reproduction ? JSON.parse(row.reproduction) : null;
  const manifestDigest = artifactManifestDigest(artifacts, reproduction);
  return {
    ...row,
    artifacts,
    reproduction,
    artifact_manifest_digest: manifestDigest,
    artifact_evidence: manifestDigest ? 'declared' : 'legacy',
    reconciles: JSON.parse(row.reconciles ?? '[]'),
    meta: row.meta ? JSON.parse(row.meta) : null,
    sources: JSON.parse(row.sources ?? '[]'),
    source_checks: JSON.parse(row.source_checks ?? '[]'),
    forecast: row.forecast ? JSON.parse(row.forecast) : null,
    // What waits for a future task's KPI (award_pending "kpi"): domain/kpi.ts.
    award_held: heldAward(row.award_held),
    model_family: familyOf(row.contributor, view),
    // 'new' once a check attests it, 'known' when one shows it is already
    // openly available (then nothing is paid), 'unattested' until then:
    // under the novelty rule its reward waits for an attestation.
    novelty: noveltyOf(row, checks, view).status,
    verifications: checks.map((v) => ({
      ...v,
      excluded: JSON.parse(v.excluded ?? '[]'),
      against_claim_history: JSON.parse(v.against_claim_history ?? '[]'),
      reproduction_receipt: v.reproduction_receipt ? JSON.parse(v.reproduction_receipt) : null,
      novelty_checked: v.novelty_checked ? JSON.parse(v.novelty_checked) : null,
      // An arbitration accepted only because the network was in bootstrap
      // (arbiterProblem) is recorded as not independent, whoever gave it.
      bootstrap: v.bootstrap === true,
      independent: v.bootstrap !== true && independentOf(row.contributor, v.verifier, view),
      // A check by another agent of the contributor's member, given before
      // the server refused them: kept on the record, counted for nothing.
      same_member: sameMember(v.verifier, row.contributor, view),
      model_family: familyOf(v.verifier, view),
    })),
  };
}

/** Many contributions, from a view holding their checks and people. */
const hydrateContributions = (rows, view) =>
  rows.map((row) => hydrateContribution(row, view));

/**
 * Operators are self-declared, so a name alone cannot prove independence.
 * What it can do is price the honest case: a system that says it shares an
 * operator with the contributor is not counted as independent, and a liar at
 * least has to lie on the record. Normalised so "Senti Global Ltd." and
 * "senti-global" are the same operator.
 */
function normaliseOperator(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(
      /\b(inc|ltd|llc|gmbh|bv|ag|sa|plc|corp|corporation|co|company|limited)\b/g,
      ' ',
    )
    .replace(/\s+/g, '')
    .trim();
}

/**
 * Which developer's models an agent runs, from what it declared. Models from
 * one developer make the same mistakes far more often than models from two
 * (Kim et al., "Correlated Errors in Large Language Models", 2025), so a check
 * by another family is worth more than a check by another copy. Null when the
 * declaration does not say: such a check never counts as a different family.
 */
function modelFamily(model) {
  const m = String(model ?? '').toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(m)) return 'anthropic';
  if (/codex|gpt|openai|\bo[1-9]\b|chatgpt/.test(m)) return 'openai';
  if (/gemini|gemma|google|bard/.test(m)) return 'google';
  if (/llama|meta/.test(m)) return 'meta';
  if (/mistral|mixtral/.test(m)) return 'mistral';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/qwen|alibaba/.test(m)) return 'alibaba';
  if (/grok|xai/.test(m)) return 'xai';
  return null;
}

const familyOf = (id, view) =>
  modelFamily(view.participant.get(id)?.model);

/**
 * Whether a check from another model family stood among these verdicts.
 * When the contributor's own family is unknown there is nothing to differ
 * from, and the rule does not apply. A check by another agent of the
 * contributor's member never counts (countedChecks).
 */
function otherFamilyChecked(contributor, verifications, view) {
  const own = familyOf(contributor, view);
  if (!own) return true;
  return verifications.some((v) => {
    if (v.verdict === 'disputed') return false;
    if (sameMember(v.verifier, contributor, view)) return false;
    const theirs = familyOf(v.verifier, view);
    return theirs !== null && theirs !== own;
  });
}

/**
 * Two participants share an operator when they are agents of one member,
 * when they were held in one account (before keys replaced accounts), when both have proved the same domain, or,
 * where either has not proved one, when their declared names match.
 */
function sameOperator(a, b, view) {
  const pa = view.participant.get(a);
  const pb = view.participant.get(b);
  if (!pa || !pb) return true;
  // Agents of one member are one AI system, whatever they declare.
  if (pa.member_id && pa.member_id === pb.member_id) return true;
  if (pa.account_id && pa.account_id === pb.account_id) return true;
  if (pa.operator_verified_at && pb.operator_verified_at)
    return pa.operator_domain === pb.operator_domain;
  const na = normaliseOperator(pa.operator);
  const nb = normaliseOperator(pb.operator);
  return !na || !nb || na === nb;
}

function independentOf(contributor, verifier, view) {
  return !sameOperator(contributor, verifier, view);
}

/**
 * The member an agent acts for: the AI system its agents are instances of.
 * An agent with no member (a row from before members) stands for itself.
 */
const memberOf = (participant, view) =>
  view.participant.get(participant)?.member_id ?? participant;

/**
 * Whether two agents are one member. The floor of independence everywhere
 * (docs/identity.md): agents of one member never check each other, and count
 * once however many of them answer or confirm. Operators are compared on top
 * of this where the rules say so.
 */
const sameMember = (a, b, view) => memberOf(a, view) === memberOf(b, view);

/**
 * The checks of a contribution that count: all but a confirmation by an agent
 * of the contributor's own member. Agents of one member never check each
 * other's work (docs/identity.md), whatever their role; the server refuses
 * such a check since 30 September 2026. One given before stays on the record
 * and counts for nothing: not toward verifiers_required, not as the default
 * verifier's double-check, not toward novelty or independence, and it earns
 * no share. A dispute by one is kept: it contested the work, and an arbiter of
 * another member decides that. Needs the contributor and checkers in the view.
 */
function countedChecks(row, checks, view) {
  return checks.filter(
    (v) => v.verdict === 'disputed' || !sameMember(v.verifier, row.contributor, view),
  );
}

/**
 * Distinct operators, other than the contributor's, among non-disputing
 * verifiers. A bootstrap arbitration is not independent and never counts.
 */
function independentOperators(contributor, verifications, view) {
  const reps = [];
  for (const v of verifications) {
    if (v.verdict === 'disputed' || v.bootstrap === true) continue;
    if (sameOperator(contributor, v.verifier, view)) continue;
    if (reps.every((r) => !sameOperator(r, v.verifier, view)))
      reps.push(v.verifier);
  }
  return reps.length;
}

/* ---------------------------------------------------- operator verification */

const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

let txtResolver = resolveTxt;
/** Test hook: tests must never touch real DNS. */
export function setTxtResolver(fn) {
  txtResolver = fn ?? resolveTxt;
}

const setOperatorClaim = prepare(
  'UPDATE participants SET operator_claim_domain = ? WHERE id = ?',
);
const setOperatorVerified = prepare(
  'UPDATE participants SET operator_domain = ?, operator_verified_at = ? WHERE id = ?',
);

const operatorTxtValue = (did) => `uain-operator=${did}`;

/**
 * Proving an operator is publishing a TXT record on a domain it controls —
 * the same check the MCP Registry uses for namespaces. Several systems may
 * prove the same domain; that is the point, since it makes them one operator.
 */
export const claimOperator = write(async function claimOperator({ participant, domain }) {
  const row = await selectById.get(participant);
  if (!row) return { error: 'not_found' };
  const d = String(domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!DOMAIN_RE.test(d)) return { error: 'bad_domain' };
  await setOperatorClaim.run(d, participant);
  return {
    domain: d,
    record_type: 'TXT',
    record_name: d,
    record_value: operatorTxtValue(row.did),
  };
});

export async function confirmOperator({ participant }) {
  const row = await selectById.get(participant);
  if (!row) return { error: 'not_found' };
  const domain = row.operator_claim_domain;
  if (!domain) return { error: 'no_claim' };
  let records;
  try {
    records = await txtResolver(domain);
  } catch (e) {
    return { error: 'dns_lookup_failed', domain, code: e?.code ?? null };
  }
  const want = operatorTxtValue(row.did);
  const found = (records ?? []).some(
    (chunks) =>
      (Array.isArray(chunks) ? chunks.join('') : String(chunks)) === want,
  );
  if (!found) return { error: 'record_not_found', domain, expected: want };
  await atomically(async () => {
    await setOperatorVerified.run(domain, now(), participant);
    await record(
      'join',
      participant,
      `${row.name} proved its operator domain ${domain}`,
    );
  });
  return { verified: true, domain };
}

/**
 * Contribution ids are RC-<n>, numbered by a sequence: never reused, even after
 * a purge lowers the highest id on record, and never shared between two server
 * processes. The store's copy from SQLite starts it after the highest id.
 */
const nextContribution = prepare(
  "SELECT nextval('contribution_number') AS n",
);
const newContributionId = async () => `RC-${(await nextContribution.get()).n}`;

/**
 * Without a task a contribution may claim at most this much, and without an
 * allocated budget a task may be priced at most this much. Before, karma_claimed
 * had no ceiling at all and the only check was a verifier's conscience.
 */
export const MAX_UNBUDGETED_KARMA = 100;

/**
 * How much unchecked work one agent may have waiting. Every held
 * contribution costs two verifiers a run, so without a limit one agent could
 * fill everyone's menu with spam for free. One answer per task (a second
 * waits until the first is decided), and a few per project. UAIN's own
 * agents skip the project limit, as they skip the karma gates.
 */
export const MAX_HELD_PER_PROJECT = 5;
const selectHeldBy = prepare(
  "SELECT id, task_id FROM contributions WHERE project_id = ? AND contributor = ? AND state IN ('held', 'contested')",
);

export const contribute = write(async function contribute({
  contributor,
  projectId: pid,
  title,
  detail,
  artifacts,
  karmaClaimed,
  verifiersRequired = 2,
  taskId = null,
  reconciles = [],
  claim = null,
  evidence = null,
  sources = [],
  sourceChecks = [],
  forecast = null,
  reproduction = null,
}) {
  const project = await selectProject.get(pid);
  if (await projectArchived.get(pid)) return { error: 'project_archived' };
  if (!project) return { error: 'project_not_found' };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };
  if (!(await selectIsMember.get(pid, contributor))) return { error: 'not_a_member' };
  const reopening = await reopenProblem(project);
  if (reopening) return reopening;
  const artifactEvidence = validateArtifactEvidence(artifacts ?? [], reproduction);
  if (artifactEvidence.ok === false) return { error: 'bad_artifact_evidence', message: artifactEvidence.message };
  artifacts = artifactEvidence.artifacts;
  reproduction = artifactEvidence.reproduction;
  const manifestDigest = artifactManifestDigest(artifacts, reproduction);
  // A cutoff only means anything if at least one cited identifier can be
  // checked. Keep this invariant in the write path, including non-MCP callers.
  // Registry availability/publication dates remain a separate reviewer check.
  if (project.evidence_cutoff && !sources.some((source) => sourceKind(source)))
    return { error: 'checkable_source_required' };
  const link = await checkTaskLink({
    contributor,
    projectId: pid,
    taskId,
    reconciles,
  });
  if (link.error) return link;
  const held = (await selectHeldBy.all(pid, contributor));
  if (link.taskId && held.some((c) => c.task_id === link.taskId))
    return {
      error: 'answer_already_held',
      held: held.filter((c) => c.task_id === link.taskId).map((c) => c.id),
    };
  if (held.length >= MAX_HELD_PER_PROJECT) {
    // UAIN's own agents are exempt, as from the karma gates.
    const me = await selectById.get(contributor);
    if (!me?.project_creator_at && !me?.default_verifier_at)
      return { error: 'too_many_held', held: held.length, limit: MAX_HELD_PER_PROJECT };
  }
  if (evidence !== null && !(evidence in EVIDENCE_TYPES))
    return { error: 'bad_evidence', allowed: Object.keys(EVIDENCE_TYPES) };
  const forecastTask =
    link.taskId &&
    link.reconciles.length === 0 &&
    (await selectTask.get(link.taskId))?.answer_type === 'forecast';
  if (forecastTask) {
    const p = Number(forecast?.probability);
    if (!forecast?.statement || !Number.isFinite(p) || p < 0 || p > 1)
      return { error: 'forecast_required' };
  }
  // A forecast states its own claim when the answer gives none, so a clean
  // settlement records the bet, with its probability, as the project's view.
  if (forecastTask && !claim)
    claim = `Forecast: ${forecast.statement} — probability ${Math.round(forecast.probability * 100)}%${forecast.horizon ? `, ${String(forecast.horizon).trim()}` : ''}.`;
  if (forecastTask && !evidence) evidence = 'derived';
  // Whoever answers a task states what the answer establishes, and the
  // verifiers check that sentence with the work. A comparison is a task's
  // conclusion, so it states one too. Work with no task needs none.
  if (link.taskId && !claim?.trim()) return { error: 'claim_statement_required' };

  // A priced task fixes what a result of it is worth; the contributor no
  // longer names it. Anything else — no task, an unpriced one, a comparison —
  // names its own, capped.
  const task = link.taskId ? await selectTask.get(link.taskId) : null;
  const priced =
    task && task.karma_offered !== null && link.reconciles.length === 0;
  let claimed = Math.max(0, Math.round(karmaClaimed ?? 0));
  let capped = false;
  if (priced) claimed = task.karma_offered;
  else if (claimed > MAX_UNBUDGETED_KARMA) {
    claimed = MAX_UNBUDGETED_KARMA;
    capped = true;
  }

  const id = await newContributionId();
  await atomically(async () => {
    await insertContribution.run(
      id,
      pid,
      contributor,
      title,
      detail,
      JSON.stringify(artifacts ?? []),
      claimed,
      verifiersRequired === 1 ? 1 : 2,
      link.taskId,
      JSON.stringify(link.reconciles),
      now(),
    );
    const statement = String(claim ?? '').trim();
    if (reproduction) await setReproduction.run(JSON.stringify(reproduction), id);
    if (statement) await setClaimStatement.run(statement, id);
    if (evidence) await setEvidence.run(evidence, id);
    if (forecast?.statement)
      await setForecast.run(
        JSON.stringify({
          statement: String(forecast.statement),
          probability: Number(forecast.probability),
          horizon: forecast.horizon ? String(forecast.horizon) : null,
        }),
        id,
      );
    if (sources?.length)
      await setSources.run(
        JSON.stringify(sources),
        JSON.stringify(sourceChecks ?? []),
        id,
      );
    if (link.taskId) await markSubmitted(link.taskId, contributor);
    if (link.reconciles.length)
      await finishItem(contributor, 'compare', link.taskId);
    await recomputeProjectState(pid);
    await record(
      'contribution',
      contributor,
      (link.reconciles.length
        ? `Compared ${link.reconciles.join(', ')} on ${link.taskId} in "${project.title}", awaiting verification`
        : `Submitted "${title}" to "${project.title}"${link.taskId ? ` for ${link.taskId}` : ''}, awaiting verification`) +
        (manifestDigest ? `; artifact manifest ${manifestDigest}` : ''),
      null,
      contributionCommitment(await selectContribution.get(id)),
    );
  });
  const out = await getContribution(id);
  if (priced)
    out.price = {
      task_id: task.id,
      karma_offered: task.karma_offered,
      rule: PRICE_RULE,
      already_won_by: task.prize_contribution ?? null,
    };
  return capped ? { ...out, karma_claim_capped_at: MAX_UNBUDGETED_KARMA } : out;
}, ofProjectArg);

const setClaimStatement = prepare(
  'UPDATE contributions SET claim_statement = ? WHERE id = ?',
);
const setSources = prepare(
  'UPDATE contributions SET sources = ?, source_checks = ? WHERE id = ?',
);
const setForecast = prepare(
  'UPDATE contributions SET forecast = ? WHERE id = ?',
);
const setEvidence = prepare(
  'UPDATE contributions SET evidence = ? WHERE id = ?',
);

const selectBelievedCiting = prepare(`
  SELECT r.* FROM claim_revisions r
  JOIN claims c ON c.id = r.claim_id
  WHERE c.project_id = ? AND r.state = 'believed' AND r.action != 'retract'
  ORDER BY r.id
`);
/**
 * The belief a task's answers are judged against: the believed claim citing
 * one of the task's settled contributions, or a claim the task was opened to
 * test (from_claim). Null when the task has none yet.
 */
async function beliefOfTask(task, exceptId = null) {
  if (!task) return null;
  const citing = new Set(
    (await selectTaskContributions.all(task.id))
      .filter((c) => c.id !== exceptId && c.state === 'settled')
      .map((c) => c.id),
  );
  const believed = await selectBelievedCiting.all(task.project_id);
  const own = believed.find((r) =>
    JSON.parse(r.sources).some((id) => citing.has(id)),
  );
  if (own) return own;
  if (task.from_claim)
    return believed.find((r) => r.claim_id === task.from_claim) ?? null;
  return null;
}

/** The same, for a read: from a project's hydrated claims and tasks. */
function beliefInView(task, claims, exceptId = null) {
  if (!task) return null;
  const citing = new Set(
    [...task.results, ...task.comparisons]
      .filter((c) => c.id !== exceptId && c.state === 'settled')
      .map((c) => c.id),
  );
  const believed = claims.filter((c) => c.status === 'believed');
  const own = believed.find((c) => c.sources.some((s) => citing.has(s.id)));
  const claim =
    own ?? (task.from_claim ? believed.find((c) => c.id === task.from_claim) : null);
  return claim ? { id: claim.id, revision: claim.believed_revision, statement: claim.statement } : null;
}

/** How a later answer bears on the belief it is judged against. */
const AGAINST_CLAIM = ['supports', 'contradicts', 'refutes'];

/**
 * An answer's claim, once the answer settles. The two verifiers already
 * checked the work and the statement it makes, so asking two more members to
 * review the same statement doubled the runs a fact took without adding a new
 * judgement. The claim is believed straight away when every check confirmed
 * it, enough of them did, and no other member's answer to the same task is
 * standing beside it. Anything else becomes a draft and goes through review:
 * a rival answer, a comparison, or work that was ever contested. An arbiter
 * judged whether the work holds, not whether its sentence does, so a claim
 * someone disputed is never believed unreviewed. If the arbiter rewrote the
 * claim, the rewrite is the draft, in the arbiter's name. Must run inside
 * atomically().
 */
async function claimFromAnswer(row, actor, standing, knownSource = null) {
  // The checks that count: disputes, and the standing checks settlement
  // counted. A confirmation by another agent of the contributor's member
  // judges nothing here, nor rewrites its claim (countedChecks).
  const counts = new Set(standing.map((v) => v.id));
  const all = (await selectVerifications.all(row.id)).filter(
    (v) => v.verdict === 'disputed' || counts.has(v.id),
  );
  const task = row.task_id ? await selectTask.get(row.task_id) : null;
  const isComparison = JSON.parse(row.reconciles ?? '[]').length > 0;
  // A task that asked for several answers is concluded by its comparison:
  // its answers settle and are paid, and only the comparison states belief.
  if (task && (task.answers_wanted ?? 1) > 1 && !isComparison) return null;
  // A later answer is judged against the belief the task already has.
  const belief = task && !isComparison ? await beliefOfTask(task, row.id) : null;
  if (belief) return await judgeAgainst(row, belief, all, actor);
  const rewrite = all.find((v) => v.revised_claim);
  const statement = rewrite?.revised_claim ?? row.claim_statement;
  if (!statement) return null;
  const author = rewrite?.verifier ?? row.contributor;
  // Contested work was disputed even when the default verifier that disputed
  // it has since confirmed it in place of the dispute.
  const everDisputed = row.state === 'contested' || all.some((v) => v.verdict === 'disputed');
  const confirmations = standing.filter((v) => v.verdict === 'confirmed');
  const isResult = JSON.parse(row.reconciles ?? '[]').length === 0;
  const rivals = row.task_id
    ? (await selectTaskContributions
        .all(row.task_id))
        .filter(
          (c) =>
            c.id !== row.id &&
            c.kind === 'work' &&
            c.contributor !== row.contributor &&
            c.state !== 'rejected' &&
            JSON.parse(c.reconciles ?? '[]').length === 0,
        )
    : [];
  // The first answer to settle becomes the task's belief without waiting:
  // answers still held are judged against it when they settle.
  const settledRivals = rivals.filter((c) => c.state === 'settled');
  const direct =
    !everDisputed &&
    isResult &&
    settledRivals.length === 0 &&
    confirmations.length >= CONFIRMATIONS_REQUIRED &&
    confirmations.length === standing.length;

  const project = await selectProject.get(row.project_id);
  const id = await nextClaimId();
  const at = now();
  await insertClaim.run(id, row.project_id, author, at);
  const rev = Number(
    (await insertRevision.run(
      id,
      null,
      'create',
      statement,
      JSON.stringify([row.id]),
      (rewrite
        ? `Rewritten by the arbiter of ${row.id}: ${rewrite.note}`
        : `Stated with ${row.id}, and checked with it`) +
        (knownSource ? `. A restatement of public knowledge, not a new finding (known: ${knownSource})` : ''),
      author,
      at,
    )).lastInsertRowid,
  );
  if (direct) {
    for (const v of confirmations)
      await insertReview.run(
        rev,
        v.verifier,
        'confirm',
        `Verified ${row.id}, which states this`,
        at,
      );
    await setRevisionState.run('believed', at, rev);
  }
  // The actor is the verifier whose verdict settled it: the ledger entry is
  // that run's output, not the contributor's.
  await record(
    'claim',
    actor,
    direct
      ? `${id} on "${project.title}" is now believed: ${row.id} states it and ${confirmations.length} verifiers confirmed it` +
        (knownSource ? ', as a restatement of public knowledge' : '') + `: ${quote(statement)}`
      : `Proposed ${id} on "${project.title}" from ${row.id}, for review` +
        (knownSource ? ', as a restatement of public knowledge' : '') + `: ${quote(statement)}`,
    author,
    revisionCommitment(await selectRevision.get(rev)),
    { table: 'claim_revisions', id: rev },
  );
  return { id, status: direct ? 'believed' : 'unconfirmed' };
}

/**
 * A settled answer to a task that already has a belief. Its verifiers said
 * how it bears on that belief. Supporting, it joins the belief's sources: a
 * replication strengthens the claim and makes no new one. Contradicting or
 * refuting, it opens an edit or a retraction of the belief in the answerer's
 * name, reviewed like any other draft; the belief stands until then. Any one
 * verifier's contradiction counts, and refutes outweighs contradicts: the
 * reviewers decide, not the count. Must run inside atomically().
 */
async function judgeAgainst(row, belief, checks, actor) {
  const marks = checks.map((v) => v.against_claim).filter(Boolean);
  const rewrite = checks.find((v) => v.revised_claim);
  const checkedStatement = rewrite?.revised_claim ?? row.claim_statement;
  const author = rewrite?.verifier ?? row.contributor;
  const project = await selectProject.get(row.project_id);
  const at = now();
  if (marks.includes('refutes') || marks.includes('contradicts')) {
    const action = marks.includes('refutes') ? 'retract' : 'edit';
    const statement = action === 'retract' ? belief.statement : checkedStatement;
    const rev = Number(
      (await insertRevision.run(
        belief.claim_id,
        belief.id,
        action,
        statement,
        JSON.stringify(
          action === 'retract'
            ? [row.id]
            : [...new Set([...JSON.parse(belief.sources), row.id])],
        ),
        `${row.id} ${action === 'retract' ? 'refutes' : 'contradicts'} this claim, and was verified: ${checkedStatement}`,
        author,
        at,
      )).lastInsertRowid,
    );
    await record(
      'claim',
      actor,
      `${row.id} ${action === 'retract' ? 'refutes' : 'contradicts'} ${belief.claim_id} on "${project.title}": ${action === 'retract' ? 'retraction' : 'edit'} proposed for review`,
      author,
      revisionCommitment(await selectRevision.get(rev)),
      { table: 'claim_revisions', id: rev },
    );
    return { id: belief.claim_id, status: 'believed', proposed: action, revision: rev };
  }
  const sources = JSON.parse(belief.sources);
  if (!sources.includes(row.id)) {
    const grown = JSON.stringify([...sources, row.id]);
    await setRevisionSources.run(grown, belief.id);
    await record(
      'claim',
      actor,
      `${row.id} supports ${belief.claim_id} on "${project.title}", and is added to its sources`,
      row.contributor,
      revisionCommitment({ ...belief, sources: grown }),
    );
  }
  return null;
}

const setRevisionSources = prepare(
  'UPDATE claim_revisions SET sources = ? WHERE id = ?',
);

/* ------------------------------------------- funding and compute contributions */

/**
 * Capital and compute are the other two legs of the triad. Each is a
 * contribution like any other — submitted, checked by members, settled — but
 * paid in credits at a published rate rather than at a price the contributor
 * names, and neither ever lifts a system past T1: standing is for work.
 *
 * Funding is no longer recorded (decision D9, 6 November 2026: Karma is never
 * bought). Filing it, behind UAIN_FUNDING_ENABLED (off by default), and the up
 * to 10 credibility a funder could earn from it were removed on 10 November
 * 2026. Funding contributions already stored stay readable, and one still
 * open settles as before in credits but earns no credibility (valueOf).
 */
export const FUNDING_USD_PER_CREDIT = 10;
export const FUNDING_CREDIT_LIFETIME_CAP = 5000;
export const COMPUTE_CREDITS_PER_GPU_HOUR = 20;
export const COMPUTE_CREDITS_CAP = 1000;

const setContributionKind = prepare(
  'UPDATE contributions SET kind = ?, meta = ? WHERE id = ?',
);

async function submitTyped({
  contributor,
  projectId: pid,
  taskId = null,
  kind,
  title,
  detail,
  artifacts,
  meta,
}) {
  const project = await selectProject.get(pid);
  if (await projectArchived.get(pid)) return { error: 'project_archived' };
  if (!project) return { error: 'project_not_found' };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };
  if (!await isMember(pid, contributor)) return { error: 'not_a_member' };
  const reopening = await reopenProblem(project);
  if (reopening) return reopening;

  const id = await newContributionId();
  await atomically(async () => {
    await insertContribution.run(
      id,
      pid,
      contributor,
      title,
      detail,
      JSON.stringify(artifacts ?? []),
      0,
      2,
      taskId,
      '[]',
      now(),
    );
    await setContributionKind.run(kind, JSON.stringify(meta), id);
    await recomputeProjectState(pid);
    await record(
      'contribution',
      contributor,
      `Submitted ${kind} "${title}" to "${project.title}", awaiting verification`,
      null,
      contributionCommitment(await selectContribution.get(id)),
    );
  });
  return await getContribution(id);
}

export const contributeCompute = write(async function contributeCompute({
  contributor,
  projectId: pid,
  taskId: tid = null,
  gpuHours,
  provider,
  detail,
  artifacts,
}) {
  const hours = Number(gpuHours);
  if (!Number.isFinite(hours) || hours <= 0) return { error: 'bad_gpu_hours' };
  let task = null;
  if (tid) {
    task = await selectTask.get(taskKey(tid));
    if (!task) return { error: 'task_not_found' };
    if (task.project_id !== pid) return { error: 'task_outside_project' };
  }
  return await submitTyped({
    contributor,
    projectId: pid,
    kind: 'compute',
    title: `Compute: ${hours} GPU-hours from ${provider}`,
    detail,
    artifacts,
    // Recorded as meta, not as task_id: donated compute is not an answer to
    // the task, and must not count as one of its results.
    meta: { gpu_hours: hours, provider, task_id: task?.id ?? null },
  });
}, ofProjectArg);

/* ----------------------------------------------------------------- credits */

export const VERIFIER_SHARE = 0.2;
const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
export const DAILY_ISSUANCE_CAP = envInt('UAIN_DAILY_ISSUANCE_CAP', 10_000);
export const TRANSFERS_ENABLED = process.env.UAIN_TRANSFERS_ENABLED === 'true';

const insertCredit = prepare(
  'INSERT INTO credit_ledger (at, participant, delta, kind, ref, note) VALUES (?, ?, ?, ?, ?, ?)',
);
const addCredits = prepare(
  'UPDATE participants SET credits = credits + ? WHERE id = ?',
);
const issuedSince = prepare(
  "SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger WHERE delta > 0 AND kind != 'transfer' AND at > ?",
);
const insertDeferral = prepare(
  'INSERT INTO credit_deferrals (at, contribution_id, participant, amount, kind) VALUES (?, ?, ?, ?, ?)',
);
const addDeferred = prepare(
  'UPDATE contributions SET credits_deferred = credits_deferred + ? WHERE id = ?',
);

async function moveCredits(participant, delta, kind, ref, note = null) {
  await insertCredit.run(now(), participant, delta, kind, ref, note);
  await addCredits.run(delta, participant);
}

export async function issuedLast24h() {
  return (await issuedSince.get(new Date(Date.now() - 86_400_000).toISOString())).n;
}

/** Why credits owed are not paid now: their agent or member has left or lost its licence. */
const withheld = (r) =>
  r.agent_state === 'revoked' || r.member_state === 'revoked'
    ? 'licence_revoked'
    : r.agent_state === 'withdrawn' || r.member_state === 'withdrawn'
      ? 'withdrawn'
      : null;
const recipientState = prepare(
  `SELECT p.state AS agent_state, m.state AS member_state
   FROM participants p LEFT JOIN members m ON m.id = p.member_id WHERE p.id = ?`,
);

/**
 * Mint within the rolling 24-hour network ceiling. What does not fit is
 * deferred against the contribution, not lost: an operator releases it. A
 * ceiling is a circuit breaker against a bug or a ring minting a flood.
 *
 * Nothing is minted to a revoked member or a withdrawn agent: all it is owed
 * is deferred the same way, and release-deferred keeps it back while that
 * lasts. Before, work that settled after its author or checker was revoked
 * paid out at once what release-deferred would have kept back.
 * Must run inside atomically().
 */
async function mint(participant, amount, kind, contributionId) {
  if (amount <= 0) return { minted: 0, deferred: 0, withheld: null };
  const why = withheld(await recipientState.get(participant));
  const room = why ? 0 : Math.max(0, DAILY_ISSUANCE_CAP - await issuedLast24h());
  const minted = Math.min(amount, room);
  const deferred = amount - minted;
  if (minted > 0) {
    await moveCredits(participant, minted, kind, contributionId);
    await record(
      'karma',
      participant,
      `${minted} credits minted to ${participant} for ${contributionId} (${kind})`,
    );
  }
  if (deferred > 0) {
    await insertDeferral.run(now(), contributionId, participant, deferred, kind);
    await addDeferred.run(deferred, contributionId);
    await record(
      'karma',
      participant,
      why
        ? `${deferred} credits for ${contributionId} stay deferred: ` +
            (why === 'withdrawn' ? 'its recipient has withdrawn' : "its recipient's licence is revoked")
        : `${deferred} credits for ${contributionId} deferred by the daily issuance ceiling`,
    );
  }
  return { minted, deferred, withheld: why };
}

const pendingDeferrals = prepare(
  `SELECT d.*, p.state AS agent_state, m.state AS member_state
   FROM credit_deferrals d
     JOIN participants p ON p.id = d.participant
     LEFT JOIN members m ON m.id = p.member_id
   WHERE d.released_at IS NULL ORDER BY d.id`,
);
const markReleased = prepare(
  'UPDATE credit_deferrals SET released_at = ? WHERE id = ?',
);
const subDeferred = prepare(
  'UPDATE contributions SET credits_deferred = credits_deferred - ? WHERE id = ?',
);

/**
 * Operator-only: mint what the ceiling held back. Bypasses the ceiling by
 * design. Credits owed to a revoked member or a withdrawn agent stay deferred
 * and are reported: a key that can never act again is not paid, and what it
 * earned stays on the record as owed, not erased. Should a revocation made in
 * error be reversed, the next release pays it.
 */
export const releaseDeferred = write(async function releaseDeferred({ by }) {
  const pending = await pendingDeferrals.all();
  const rows = pending.filter((r) => !withheld(r));
  const skipped = pending
    .filter((r) => withheld(r))
    .map((r) => ({
      participant: r.participant,
      contribution_id: r.contribution_id,
      amount: r.amount,
      reason: withheld(r),
    }));
  let total = 0;
  await atomically(async () => {
    for (const r of rows) {
      await moveCredits(
        r.participant,
        r.amount,
        'release',
        r.contribution_id,
        `released by ${by}`,
      );
      await markReleased.run(now(), r.id);
      await subDeferred.run(r.amount, r.contribution_id);
      total += r.amount;
    }
    if (rows.length)
      await record(
        'karma',
        by,
        `Released ${total} deferred credits across ${rows.length} award(s)` +
          (skipped.length
            ? `; ${skipped.length} award(s) to revoked or withdrawn recipients stay deferred`
            : ''),
      );
  });
  return { released: total, awards: rows.length, skipped };
});

/**
 * Credits may move between members only once legal sign-off lands
 * (docs/karma-decisions.md 1.2, 3.9). Credibility never moves.
 */
export const transferCredits = write(async function transferCredits({ from, to, amount, memo = null }) {
  if (!TRANSFERS_ENABLED) return { error: 'transfers_disabled' };
  const n = Math.trunc(Number(amount));
  if (!Number.isFinite(n) || n <= 0) return { error: 'bad_amount' };
  if (from === to) return { error: 'self_transfer' };
  const sender = await selectById.get(from);
  const recipient = await selectById.get(to);
  if (
    !recipient ||
    recipient.state === 'withdrawn' ||
    recipient.state === 'revoked'
  )
    return { error: 'recipient_unavailable' };
  if (!sender || sender.credits < n)
    return { error: 'insufficient_credits', balance: sender?.credits ?? 0 };
  const ref = `transfer:${randomBytes(6).toString('hex')}`;
  await atomically(async () => {
    await moveCredits(from, -n, 'transfer', ref, memo);
    await moveCredits(to, n, 'transfer', ref, memo);
    await record('karma', from, `Transferred ${n} credits`, to);
  });
  return { transferred: n, ref, balance: (await selectById.get(from)).credits };
});

const recentCredits = prepare(
  'SELECT at, delta, kind, ref, note FROM credit_ledger WHERE participant = ? ORDER BY id DESC LIMIT ?',
);
// The funding caps are the member's, over all its agents: the karma gates sum
// them, so a cap per agent let many agents fund one member past 100 and 1,000.
const fundingUsed = prepare(
  `SELECT COALESCE(SUM(credits_awarded), 0) AS credits, COALESCE(SUM(karma_awarded), 0) AS credibility
   FROM contributions WHERE kind = 'funding' AND state = 'settled' AND contributor IN (
     SELECT o.id FROM participants me
       JOIN participants o ON o.id = me.id OR o.member_id = me.member_id
     WHERE me.id = ?)`,
);
const deferredFor = prepare(
  'SELECT COALESCE(SUM(amount), 0) AS n FROM credit_deferrals WHERE participant = ? AND released_at IS NULL',
);

export async function balance(id) {
  const row = await selectById.get(id);
  if (!row) return null;
  const f = await fundingUsed.get(id);
  return {
    id,
    credibility: row.karma,
    credits: row.credits,
    tier: row.tier,
    operator_verified: Boolean(row.operator_verified_at),
    operator_domain: row.operator_domain,
    credits_deferred: (await deferredFor.get(id)).n,
    funding: {
      credits_used: f.credits,
      credits_cap: FUNDING_CREDIT_LIFETIME_CAP,
      // Recorded before 10 November 2026; funding earns none now (D9).
      credibility_used: f.credibility,
      credibility_cap: 0,
    },
    recent: await recentCredits.all(id, 20),
  };
}

/**
 * A contribution settles once it has the number of independent verifications
 * its author asked for. Nobody verifies their own work — that rule is what
 * makes a tier mean anything.
 *
 * Asking for a single verifier is allowed and sometimes the only option in a
 * small network, but it costs value: karma is reduced, exactly as it is when a
 * verifier returns a partial verdict. Only work checked by two independent
 * parties counts toward the higher tiers.
 */
export const DEFAULT_VERIFIERS_REQUIRED = 2;
const SINGLE_CHECK_FACTOR = 0.6;
const PARTIAL_VERDICT_FACTOR = 0.6;

/**
 * `excluded` names artefacts the project will not maintain, and costs nothing.
 *
 * It exists because the verdict vocabulary conflated two unrelated judgements.
 * RC-4502 reproduced byte-exact and was still marked `partial`, because one of
 * its three artefacts fell outside a stop condition — a ruling about project
 * scope, not a finding about the work. The verifier said so plainly and the
 * contributor lost 40% anyway, since settlement reads nothing but the enum.
 *
 * So scope moves out of the verdict. `partial` now means only what it says:
 * reproduced, with caveats about the work itself.
 */
export const verify = write(async function verify({
  verifier,
  contributionId,
  verdict,
  note,
  excluded = [],
  noEffort = false,
  revisedClaim = null,
  againstClaim = null,
  againstClaimRevision = null,
  reproductionReceipt = null,
  novelty = null,
  noveltyChecked = [],
  knownSource = null,
}) {
  // Two verdicts. `partial` (reproduced, with caveats) is taken as disputed:
  // work that is right but slightly wrong goes to an arbiter, who decides and
  // may rewrite its claim. Agents that still send it are not refused.
  if (verdict === 'partial') verdict = 'disputed';
  revisedClaim = String(revisedClaim ?? '').trim() || null;
  // Novelty is attested with a confirmation: a dispute already withholds pay.
  const attestation = attestationOf({ novelty, noveltyChecked, knownSource });
  if (attestation.error) return attestation;
  if (attestation.value && verdict !== 'confirmed') return { error: 'novelty_needs_confirmed' };
  const row = await selectContribution.get(contributionId);
  if (!row) return { error: 'contribution_not_found' };
  // Settling pays and penalises members (read fresh, never kept in memory);
  // of the project data servers keep, it changes only this project's.
  changesOnlyProject(row.project_id);
  if (attestation.value && row.kind !== 'work') return { error: 'novelty_not_applicable', kind: row.kind };
  if (revisedClaim && (row.state !== 'contested' || verdict !== 'confirmed'))
    return { error: 'revised_claim_not_yours' };
  if (againstClaim !== null && !AGAINST_CLAIM.includes(againstClaim))
    return { error: 'bad_against_claim', allowed: AGAINST_CLAIM };
  // An answer to a task that already has a belief is judged against it, by
  // whoever confirms it. A rejected answer bears on nothing.
  let belief = null;
  if (verdict === 'confirmed' && row.task_id && JSON.parse(row.reconciles ?? '[]').length === 0) {
    belief = await beliefOfTask(await selectTask.get(row.task_id), row.id);
    if (againstClaimRevision !== null && againstClaimRevision !== belief?.id)
      return {
        error: 'stale_belief',
        believed_claim: belief ? { id: belief.claim_id, revision: belief.id, statement: belief.statement } : null,
      };
  }
  // Only the arbiter, rejecting the work, may say it shows no effort.
  if (noEffort && row.state !== 'contested')
    return { error: 'no_effort_not_yours' };
  if (noEffort && verdict !== 'disputed')
    return { error: 'no_effort_needs_disputed' };
  if (row.contributor === verifier)
    return { error: 'self_verification_refused' };
  if (!PENDING.has(row.state))
    return { error: 'already_settled', state: row.state };
  // Agents of one member are one AI system (docs/identity.md): none of them
  // checks its member's own work, arbitrates it or attests its novelty, UAIN's
  // default verifiers and trusted arbiters included.
  const pair = openView();
  await pair.participant.load([verifier, row.contributor]);
  if (sameMember(verifier, row.contributor, pair)) return { error: 'same_member' };
  // A halted project stops, pay included: work waiting in it stays as it is
  // until the project resumes.
  if (await projectArchived.get(row.project_id)) return { error: 'project_archived' };
  const { state: projectState } = await selectProject.get(row.project_id);
  if (projectState === 'halted' || projectState === 'complete')
    return { error: 'project_closed', state: projectState };
  // Verifying is taking part. An outsider could otherwise settle work on a
  // project it had never joined, including a one-member proposal.
  if (!await isMember(row.project_id, verifier))
    return { error: 'not_a_member', project_id: row.project_id };
  const existing = await selectVerifications.all(contributionId);
  // A check another agent of the contributor's member gave before the rule
  // stays on the record and counts for nothing (countedChecks): the work waits
  // for a checker of another member in its place.
  await pair.participant.load(existing.map((v) => v.verifier));
  const counted = countedChecks(row, existing, pair);
  const previous = existing.find((v) => v.verifier === verifier);
  const checker = await selectById.get(verifier);
  const refreshing = Boolean(
    previous?.verdict === 'confirmed' && verdict === 'confirmed' && belief && againstClaim &&
    previous.against_claim_revision !== belief.id &&
    (row.state === 'held' || awaitsDefaultVerifier(row, counted)),
  );
  // The default verifier whose dispute contested the work gives the check
  // that releases it once an arbiter has confirmed it, as any other default
  // verifier may: nothing is paid until a default verifier double-checks
  // (white paper 5.8), and that includes the arbiter's verdict. Before, work
  // whose only default verifier had disputed it waited for ever: that
  // verifier had already checked it, and nobody else was allowed to.
  const reconsidering = Boolean(
    previous?.verdict === 'disputed' && checker.default_verifier_at &&
    row.state === 'contested' && awaitsDefaultVerifier(row, counted),
  );
  // A check confirmed without a novelty attestation (an older client, or
  // before the rule) may add one later: once, and nothing else with it.
  const attestNow = previous?.novelty ? null : attestation.value;
  const attesting = Boolean(
    attestNow && previous?.verdict === 'confirmed' && verdict === 'confirmed',
  );
  if (previous && !refreshing && !reconsidering && !attesting)
    return { error: previous.novelty && attestation.value ? 'novelty_already_attested' : 'already_verified_by_you' };
  // An answer judged against a belief says how it bears on it, unless this
  // only adds a novelty attestation to a check whose judgement is current.
  if (
    belief && !againstClaim &&
    !(attesting && previous.against_claim_revision === belief.id)
  )
    return {
      error: 'against_claim_required',
      believed_claim: { id: belief.claim_id, revision: belief.id, statement: belief.statement },
    };
  // This is only a new assessment of the current belief. The original work
  // verdict, scope exclusions and arbitration decision cannot be overwritten.
  if ((refreshing || attesting) && (excluded.length || revisedClaim || noEffort || reproductionReceipt !== null))
    return { error: refreshing ? 'claim_refresh_only' : 'novelty_attestation_only' };
  if (reproductionReceipt !== null) {
    const checkedReceipt = validateReproductionReceipt(JSON.parse(row.artifacts),
      row.reproduction ? JSON.parse(row.reproduction) : null, reproductionReceipt, verdict);
    if (checkedReceipt.ok === false)
      return { error: 'bad_reproduction_receipt', message: checkedReceipt.message };
    reproductionReceipt = checkedReceipt.receipt;
  }
  const checkerKarma = await karmaOfMember(checker);
  if (!checker.default_verifier_at && checkerKarma < VERIFY_KARMA)
    return {
      error: 'karma_too_low_to_verify',
      karma: checkerKarma,
      needed: VERIFY_KARMA,
    };
  // Enough members have checked it; what it waits for now is UAIN's own check.
  if (!refreshing && !attesting && !checker.default_verifier_at && awaitsDefaultVerifier(row, counted))
    return { error: 'awaiting_default_verifier' };
  // Nor does a member check a rival of its own answer (stakeIn). Refreshing a
  // check it already gave is not a new one. Nobody, default verifiers and
  // arbiters included, checks a comparison of its member's result; adding a
  // novelty attestation to a check already given is not a new one either.
  const comparison = JSON.parse(row.reconciles ?? '[]').length > 0;
  if (row.task_id && !refreshing &&
    (comparison ? !attesting : row.state === 'held' && !checker.default_verifier_at)) {
    const people = openView();
    await people.taskContributions.load([row.task_id]);
    await people.participant.load([
      verifier,
      ...people.taskContributions.get(row.task_id).map((c) => c.contributor),
    ]);
    const stake = stakeIn(row, verifier, people);
    if (stake) return stake;
  }

  // Excluding something the contribution never carried would put a ruling on
  // the record about an artefact nobody submitted.
  const labels = JSON.parse(row.artifacts).map((a) => a.label);
  const unknown = excluded.filter((label) => !labels.includes(label));
  if (unknown.length > 0)
    return { error: 'unknown_artifact', unknown, artifacts: labels };

  const disputers = existing
    .filter((v) => v.verdict === 'disputed')
    .map((v) => v.verifier);
  // The default verifier's check on work an arbiter already decided is the
  // double-check, not a second arbitration: it needs no arbiter standing.
  const doubleCheck =
    Boolean(checker.default_verifier_at) && awaitsDefaultVerifier(row, counted);
  // Whether this is a bootstrap arbitration: one the normal rule refuses and
  // the bootstrap exception accepts (arbiterProblem). It is recorded as not
  // independent, and never counts as operator independence.
  let bootstrap = false;
  if (row.state === 'contested' && !doubleCheck && !refreshing && !attesting) {
    const people = openView();
    await people.participant.load([verifier, row.contributor, ...disputers]);
    let problem = arbiterProblem(row, verifier, disputers, people);
    if (problem && checker.default_verifier_at && (await bootstrapState()).active) {
      problem = arbiterProblem(row, verifier, disputers, people, true);
      bootstrap = !problem;
    }
    if (problem) return problem;
  }

  await finishItem(verifier, 'verify', contributionId);
  const outcome = await atomically(async () => {
    const at = now();
    // A call that only adds a novelty attestation judges no belief.
    const judged = belief && againstClaim && (refreshing || !attesting)
      ? { revision: belief.id, relation: againstClaim, note, at } : null;
    const attested = attestNow
      ? attestNow.novelty === 'new'
        ? `it is new, after ${JSON.parse(attestNow.novelty_checked).length} searches`
        : `it is already openly available: ${quote(attestNow.known_source)}`
      : null;
    // The entry has its id only when the write ends (record): what names it,
    // the judgement and the novelty attestation, is written then.
    const naming = [];
    await record(
      'verification',
      verifier,
      refreshing
        ? `Refreshed judgement of ${contributionId} against ${belief.claim_id} revision ${belief.id}: ${againstClaim}` +
          (attesting ? `; attested ${attested}` : '')
        : attesting
          ? `Attested of ${contributionId} that ${attested}`
          : `${verdict} on "${row.title}"` +
            (reconsidering ? ' after arbitration, in place of its dispute' : '') +
            (bootstrap ? '; bootstrap arbitration (not independent)' : '') +
            (reproductionReceipt ? `; reproduction receipt ${evidenceDigest(reproductionReceipt)}` : '') +
            (attested ? `; attested ${attested}` : ''),
      row.contributor,
      checkCommitment(
        refreshing || attesting ? previous : { contribution_id: contributionId, verifier, verdict, note, at,
          excluded, revised_claim: revisedClaim, reproduction_receipt: reproductionReceipt, bootstrap },
        judged,
        attestNow ? { ...attestNow, novelty_note: attesting ? note : null } : null,
      ),
      (eventId) => Promise.all(naming.map((name) => name(eventId))),
    );
    const judgement = judged ? { ...judged, event_id: null } : null;
    if (refreshing) {
      const history = JSON.parse(previous.against_claim_history ?? '[]');
      // Old clients/rows may have an unbound relation: keep it explicitly
      // unbound, never relabel it as a judgement of the current revision.
      if (!history.length && previous.against_claim)
        history.push({ revision: previous.against_claim_revision ?? null, relation: previous.against_claim,
          note: previous.note, at: previous.at });
      await refreshClaimJudgement.run(againstClaim, belief.id, JSON.stringify([...history, judgement]), previous.id);
      if (judgement)
        naming.push((eventId) => {
          judgement.event_id = eventId;
          return setJudgementHistory.run(JSON.stringify([...history, judgement]), previous.id);
        });
    } else if (reconsidering) {
      // One verdict per verifier, so the new one takes the dispute's place.
      // The dispute stays on the ledger, and its note is kept under the new one.
      await replaceVerification.run(
        verdict, `${note}\n\nIn place of its dispute of ${previous.at}: ${previous.note}`, at,
        JSON.stringify(excluded), revisedClaim,
        judgement ? againstClaim : null, judgement ? belief.id : null,
        JSON.stringify(judgement ? [judgement] : []),
        reproductionReceipt ? JSON.stringify(reproductionReceipt) : null,
        previous.id,
      );
      if (judgement)
        naming.push((eventId) => {
          judgement.event_id = eventId;
          return setJudgementHistory.run(JSON.stringify([judgement]), previous.id);
        });
    } else if (!attesting) {
      const inserted = await insertVerification.run(
        contributionId, verifier, verdict, note, at, JSON.stringify(excluded), revisedClaim,
        judgement ? againstClaim : null, judgement ? belief.id : null,
        JSON.stringify(judgement ? [judgement] : []),
        reproductionReceipt ? JSON.stringify(reproductionReceipt) : null,
      );
      if (bootstrap) await setVerificationBootstrap.run(inserted.lastInsertRowid);
      if (judgement)
        naming.push((eventId) => {
          judgement.event_id = eventId;
          return setJudgementHistory.run(JSON.stringify([judgement]), inserted.lastInsertRowid);
        });
    }
    if (attestNow) {
      await setNovelty.run(
        attestNow.novelty, attestNow.novelty_checked, attestNow.known_source,
        attesting ? note : null, null, contributionId, verifier,
      );
      naming.push((eventId) => setNoveltyEvent.run(eventId, contributionId, verifier));
    }

    const all = await selectVerifications.all(contributionId);
    // Settlement counts only the checks that count: a confirmation another
    // agent of the contributor's member gave before the rule is not one of
    // them, toward the number required, the default verifier's double-check,
    // novelty, independence or the verifiers' share (countedChecks).
    const people = openView();
    await people.participant.load([row.contributor, ...all.map((v) => v.verifier)]);
    const counts = countedChecks(row, all, people);

    // One dispute no longer zeroes the work: a single hostile verdict could
    // erase anyone's contribution. It contests it instead, and an arbiter
    // decides.
    if (row.state === 'held' && verdict === 'disputed') {
      await setContributionState.run('contested', contributionId);
      await record(
        'verification',
        verifier,
        `${contributionId} contested; an arbiter at T2 or above, from an operator on neither side, decides`,
        row.contributor,
      );
      await recomputeProjectState(row.project_id);
      return { settled: false, contested: true, still_needed: 1 };
    }

    let arbitrated = false;
    if (row.state === 'contested') {
      arbitrated = true;
      if (verdict === 'disputed') {
        await closeDisputed(row, verifier, noEffort);
        return { settled: false, rejected: true, disputed: true, arbitrated, no_effort: noEffort };
      }
      if (!await defaultVerifierAmong(counts)) {
        await record(
          'verification',
          verifier,
          `The arbiter confirmed ${contributionId}; it settles once one of UAIN's default verifiers confirms it`,
          row.contributor,
        );
        return { settled: false, still_needed: 0, awaiting_default_verifier: true };
      }
    } else if (counts.length < row.verifiers_required) {
      return {
        settled: false,
        still_needed: row.verifiers_required - counts.length,
      };
    } else if (!await defaultVerifierAmong(counts)) {
      // White paper 5.8: a check by a karma-qualified member is double-checked
      // by UAIN's own verifier before anything is paid.
      await record(
        'verification',
        verifier,
        `${contributionId} has its checks; it settles once one of UAIN's default verifiers confirms it`,
        row.contributor,
      );
      return { settled: false, still_needed: 0, awaiting_default_verifier: true };
    }

    // All standing checks of a late answer must refer to the same current
    // belief. A changed belief requires a refresh, not more work checks or pay.
    const standing = counts.filter((v) => v.verdict !== 'disputed');
    if (belief) {
      const stale = standing.filter((v) => v.against_claim_revision !== belief.id);
      if (stale.length)
        return {
          settled: false, awaiting_claim_judgement: true,
          believed_claim: { id: belief.claim_id, revision: belief.id, statement: belief.statement },
          stale_verifiers: stale.map((v) => v.verifier), still_needed: 0,
        };
    }
    // Settle on the verdicts that stood. Value is discounted for a partial
    // verdict, and again unless two operators other than the contributor's
    // confirmed it. Excluded artefacts cost nothing: the work reproduced, and
    // what the project chooses to maintain is not a measure of it.
    // The novelty rule: pay only work a check attests is new. Work a check
    // shows is already openly available, or that answers a task closed as
    // known, settles as verified with no award.
    const knownTask = row.task_id ? (await selectKnownSource.get(row.task_id))?.source ?? null : null;
    const novel = noveltyOf(row, all, people);
    const known = Boolean(knownTask) || novel.status === 'known';
    const knownSource = knownTask ?? novel.known_source ?? null;
    if (!known && NOVELTY_REQUIRED && novel.status === 'unattested') {
      await record(
        'verification',
        verifier,
        `${contributionId} has its checks; nothing is paid until a check attests that it is new, or shows it is already openly available`,
        row.contributor,
      );
      return { settled: false, still_needed: 0, awaiting_novelty: true, novelty: 'unattested' };
    }
    const independent = independentOperators(row.contributor, standing, people);
    let factor = 1;
    if (standing.some((v) => v.verdict === 'partial'))
      factor *= PARTIAL_VERDICT_FACTOR;
    // Full value also needs a check from another model family: copies of one
    // model tend to confirm each other's mistakes.
    const otherFamily = otherFamilyChecked(row.contributor, standing, people);
    if (row.verifiers_required < 2 || independent < 2 || !otherFamily)
      factor *= SINGLE_CHECK_FACTOR;
    const { credibility, credits } = await valueOf(row, factor);

    // A dispute the arbiter overturned costs the disputer credibility. One
    // the arbiter answered by rewriting the claim was right: it costs nothing.
    // Nor does one the default verifier that raised it now confirms in its
    // place: the check that releases pay must cost its checker the same
    // either way, or confirming would be the verdict that costs it karma.
    const rewritten = counts.some((v) => v.revised_claim);
    const charged = disputers.filter((d) => !(reconsidering && d === verifier));
    for (const d of arbitrated && !rewritten ? charged : []) {
      const karmaRow = await changeKarma(
        d, -DISPUTE_PENALTY, 'dispute_overturned',
        `A dispute on ${contributionId} was overturned by an arbiter`, contributionId,
      );
      await record(
        'karma',
        d,
        `Lost ${DISPUTE_PENALTY}κ: a dispute on ${contributionId} was overturned by an arbiter`,
        row.contributor,
        null,
        karmaRow,
      );
      await revokeIfBelow(d);
    }

    const base = {
      settled: true,
      arbitrated,
      independent_operators: independent,
      other_model_family: otherFamily,
      novelty: known ? 'known' : novel.status,
    };

    // Verified, but a restatement of what is already public: nothing is paid,
    // it does not count toward a tier, and its claim is marked as such.
    if (known) {
      await settleContribution.run('settled', 0, now(), contributionId);
      await setAwardWithheld.run('known', contributionId);
      await setCreditsAwarded.run(0, contributionId);
      await record(
        'karma',
        row.contributor,
        `${contributionId} is verified but restates public knowledge` +
          (knownSource ? ` (${quote(knownSource)})` : '') + '; nothing is paid',
      );
      // A later result of a priced task may have been waiting on this one.
      const prize = await isPricedResult(row) ? await settlePrize(row.task_id) : null;
      const claim = await claimFromAnswer(row, verifier, standing, knownSource ?? 'its task was closed as known');
      await recomputeProjectState(row.project_id);
      return {
        ...base,
        award_withheld: 'known',
        known_source: knownSource,
        credits_minted: 0,
        ...((prize as { winner?: string } | null)?.winner ? { prize } : {}),
        claim,
      };
    }

    // A future-solvable task's work is verified now and paid only once its
    // KPI is met (white paper 5.3): its award is held, or withheld once the
    // KPI has failed or expired. Met, it is paid below as any work is.
    const held = await holdForKpi(row, credibility, credits, standing);
    if (held) {
      const claim = await claimFromAnswer(row, verifier, standing);
      await recomputeProjectState(row.project_id);
      return { ...base, ...held, claim };
    }

    // A result of a priced task is paid only if it is the first one verified.
    if (await isPricedResult(row)) {
      await settleContribution.run('settled', 0, now(), contributionId);
      await setPrizeDue.run(credibility, contributionId);
      // Settled work counts toward standing even when another result won.
      await setTier.run(await tierFor(row.contributor), 'active', row.contributor);
      const prize = await settlePrize(row.task_id);
      const claim = await claimFromAnswer(row, verifier, standing);
      const winner = (await selectTask.get(row.task_id)).prize_contribution;
      if (winner && winner !== contributionId)
        // Kind 'karma', not 'task': it announces a payout decision, and the
        // worker counts a member's 'task' entries as that member's own output.
        await record(
          'karma',
          row.contributor,
          `${contributionId} settled as a replication of ${row.task_id}; its price went to ${winner}, verified first`,
        );
      await recomputeProjectState(row.project_id);
      return { ...base, prize: prize ?? { winner }, claim };
    }

    await settleContribution.run('settled', credibility, now(), contributionId);
    const paid = await pay(row, credibility, credits, standing);
    const claim = await claimFromAnswer(row, verifier, standing);
    await recomputeProjectState(row.project_id);
    return { ...base, ...paid, claim };
  });
  // Read back after the commit: what names the check's ledger entry is filled
  // in only when the write ends (record).
  return later(async () => ({
    ...await getContribution(contributionId),
    ...outcome,
    ...(bootstrap ? { bootstrap: true } : {}),
  }));
});

export const DISPUTE_PENALTY = 2;
/** Karma a member needs to check others' work (white paper 5.8). */
export const VERIFY_KARMA = 100;

const selectDefaultVerifiers = prepare(
  'SELECT id FROM participants WHERE default_verifier_at IS NOT NULL',
);
/**
 * Whether work has all the member checks it needs and waits only for a
 * default verifier: held work with its checks in, or contested work an arbiter
 * has already confirmed. Contested work with no dispute left is the second:
 * its default verifier confirmed it in place of its dispute after
 * arbitration, and it waits at most for its checkers to judge a changed
 * belief. Pass only the checks that count (countedChecks): a confirmation by
 * another agent of the contributor's member is neither a member check nor an
 * arbiter's verdict.
 */
function awaitsDefaultVerifier(row, checks) {
  if (row.state === 'held') return checks.length >= row.verifiers_required;
  if (row.state === 'contested') {
    const first = checks.findIndex((v) => v.verdict === 'disputed');
    return first < 0 || checks.slice(first + 1).some((v) => v.verdict !== 'disputed');
  }
  return false;
}

/**
 * Whether a default verifier's standing check is among these. Pass only the
 * checks that count (countedChecks): a default verifier of the contributor's
 * own member never gives the double-check.
 */
async function defaultVerifierAmong(checks) {
  const defaults = new Set((await selectDefaultVerifiers.all()).map((r) => r.id));
  return checks.some((v) => v.verdict !== 'disputed' && defaults.has(v.verifier));
}
/** Who may decide contested work: members whose own work has held up. */
const ARBITER_TIERS = ['T2', 'T3'];
const KIND_TO_MINT = { work: 'bounty', funding: 'funding', compute: 'compute' };

const setContributionState = prepare(
  'UPDATE contributions SET state = ? WHERE id = ?',
);
const setCreditsAwarded = prepare(
  'UPDATE contributions SET credits_awarded = ? WHERE id = ?',
);
const setKarmaAwarded = prepare(
  'UPDATE contributions SET karma_awarded = ? WHERE id = ?',
);
const setPrizeDue = prepare(
  'UPDATE contributions SET prize_due = ? WHERE id = ?',
);
// Karma can fall below zero (white paper 5.2); at REVOKE_AT_KARMA the
// licence goes. Penalties are changeKarma rows with a negative delta.

/**
 * Bootstrap (frozen 30 September 2026): while fewer than this many distinct
 * operators hold an active licence, contested work may be decided by a UAIN
 * default verifier of a member on neither side (arbiterProblem).
 * UAIN_BOOTSTRAP_OPERATORS=0 switches the exception off.
 */
export const BOOTSTRAP_OPERATORS = (() => {
  const n = Number(process.env.UAIN_BOOTSTRAP_OPERATORS ?? 3);
  return Number.isInteger(n) && n >= 0 ? n : 3;
})();
// Every agent of a member whose licence is active (licenceOf), with what
// sameOperator compares.
const selectLicensedAgents = prepare(
  `SELECT p.id, p.member_id, p.account_id, p.operator, p.operator_domain, p.operator_verified_at
   FROM participants p JOIN members m ON m.id = p.member_id
   WHERE m.state NOT IN ('revoked', 'withdrawn', 'key_pending') AND m.public_key IS NOT NULL
     AND p.state NOT IN ('revoked', 'withdrawn')
   ORDER BY p.enrolled_at, p.id LIMIT ? OFFSET ?`,
);
// Agents read per page by bootstrapState, which stops once it has its answer.
const LICENSED_PAGE = 500;

/**
 * Whether the network is in bootstrap: how many distinct operators hold an
 * active licence, compared as sameOperator compares them (proved domains,
 * else normalised declared names; agents of one member are one operator),
 * against BOOTSTRAP_OPERATORS. It ends by itself once enough operators join.
 *
 * Counting stops at the threshold: past it the answer cannot change, and the
 * comparison is every agent against every operator found so far, which at
 * 40,000 agents and 5,000 operators held a copy's CPU for over a minute per
 * uain_describe (benchmark, 2 October 2026). `operators` is therefore exact
 * below the threshold and equal to it at or above. The agents are read a page
 * at a time for the same reason: reading all 41,000 took the database 0.9 s a
 * call and was 94% of its work under load; the first page usually settles it.
 */
async function bootstrapState() {
  const view = { participant: new Map() };
  const reps = [];
  for (let offset = 0; reps.length < BOOTSTRAP_OPERATORS; offset += LICENSED_PAGE) {
    const rows = await selectLicensedAgents.all(LICENSED_PAGE, offset);
    for (const r of rows) view.participant.set(r.id, r);
    for (const r of rows) {
      if (reps.length >= BOOTSTRAP_OPERATORS) break;
      if (reps.every((x) => !sameOperator(x, r.id, view))) reps.push(r.id);
    }
    if (rows.length < LICENSED_PAGE) break;
  }
  return {
    active: reps.length < BOOTSTRAP_OPERATORS,
    operators: reps.length,
    threshold: BOOTSTRAP_OPERATORS,
  };
}

/**
 * bootstrapState for uain_describe, the first call every agent makes: kept
 * 30 s per server, since it changes only when an operator joins. Decisions
 * (who may arbitrate) still ask bootstrapState itself, never this copy.
 */
const BOOTSTRAP_TTL_MS = 30_000;
let bootstrapKept = null;
export async function bootstrapStateKept() {
  if (bootstrapKept && Date.now() - bootstrapKept.at < BOOTSTRAP_TTL_MS) return bootstrapKept.value;
  const value = await bootstrapState();
  bootstrapKept = { at: Date.now(), value };
  return value;
}
/** For tests: forget the kept copy, as if its time were up. */
export const forgetBootstrapState = () => {
  bootstrapKept = null;
};

const arbiterNotIndependent = () => ({
  error: 'arbiter_not_independent',
  why: 'A contested contribution needs an arbiter whose operator differs from the contributor’s and from the disputer’s, and whose member is neither side’s.',
});

/**
 * The arbiter makes the final call on contested work, so it must be a member
 * whose own work has held up (T2 or above), and outside both sides: not the
 * contributor's operator and not any disputer's.
 *
 * Who may check whom, frozen 30 September 2026 (docs/economy.md):
 * - no agent decides its own member's work (same_member), nor a dispute its
 *   own member raised, whatever its role;
 * - with `bootstrap` (the network is in bootstrap, bootstrapState), a UAIN
 *   default verifier of a member on neither side may also decide, without T2
 *   and even when it shares an operator with a side. That is a bootstrap
 *   arbitration: uain_verify records it `bootstrap: true`, not independent,
 *   and it never counts as operator independence at settlement.
 */
function arbiterProblem(row, verifier, disputers, view, bootstrap = false) {
  const me = view.participant.get(verifier);
  // Nobody decides its own member's work, a trusted arbiter included
  // (docs/identity.md). uain_verify refuses it before asking, as same_member.
  if (sameMember(row.contributor, verifier, view)) return { error: 'same_member' };
  // Nor a dispute its own member raised: the disputer has given its verdict,
  // and its member's other agents are that same AI system.
  const partisan = disputers.some((d) => sameMember(d, verifier, view));
  // A trusted arbiter stands in while no member can earn T2.
  if (me?.trusted_arbiter_at) return partisan ? arbiterNotIndependent() : null;
  let problem = null;
  if (!ARBITER_TIERS.includes(me?.tier))
    problem = {
      error: 'arbiter_not_proven',
      tier: me?.tier ?? null,
      why:
        'Contested work is decided by an arbiter at tier T2 or above: a member with ' +
        'settled work confirmed by two operators other than its own, and its own operator proved.' +
        (BOOTSTRAP_OPERATORS > 0
          ? ` While fewer than ${BOOTSTRAP_OPERATORS} operators hold a licence (bootstrap), a UAIN ` +
            'default verifier of a member on neither side may decide it instead.'
          : ''),
    };
  else if (
    sameOperator(row.contributor, verifier, view) ||
    disputers.some((d) => sameOperator(d, verifier, view))
  )
    problem = arbiterNotIndependent();
  if (problem && bootstrap && me?.default_verifier_at)
    return partisan ? arbiterNotIndependent() : null;
  return problem;
}

const setTrustedArbiter = prepare(
  'UPDATE participants SET trusted_arbiter_at = ? WHERE id = ?',
);

/**
 * Operator-only, like budgets: name a member who may decide contested work
 * without T2 and without the independence check. Needed while the network is
 * one operator's agents, where nobody can ever qualify. On the record both
 * ways, so anyone can see who could decide what, and when.
 */
export const setArbiterTrust = write(async function setArbiterTrust({ participant, trusted, by }) {
  const row = await selectById.get(participant);
  if (!row) return { error: 'not_found' };
  if (Boolean(row.trusted_arbiter_at) === trusted)
    return { unchanged: true, participant, trusted };
  await atomically(async () => {
    await setTrustedArbiter.run(trusted ? now() : null, participant);
    await record(
      'join',
      by,
      trusted
        ? `Named ${row.name} (${participant}) a trusted arbiter: it may decide contested work before any member reaches T2`
        : `${row.name} (${participant}) is no longer a trusted arbiter`,
      participant,
    );
  });
  return { participant, trusted };
});

/**
 * Operator-only: name, or stop naming, one of UAIN's own agents. A project
 * creator opens projects without the karma threshold or the project limit; a
 * default verifier checks work without the karma threshold, and releases pay
 * on work checked by karma-qualified members. On the record both ways.
 */
const UAIN_ROLES = {
  'project-creator': {
    column: 'project_creator_at',
    label: 'a UAIN project creator: it may open projects without 1,000 karma',
  },
  'default-verifier': {
    column: 'default_verifier_at',
    label: 'a UAIN default verifier: it may check work without 100 karma, and its check releases pay',
  },
};

export const setUainRole = write(async function setUainRole({ participant, role, on, by }) {
  const r = UAIN_ROLES[role];
  if (!r) return { error: 'unknown_role' };
  const row = await selectById.get(participant);
  if (!row) return { error: 'not_found' };
  if (Boolean(row[r.column]) === on) return { unchanged: true, participant, role, on };
  await atomically(async () => {
    await prepare(`UPDATE participants SET ${r.column} = ? WHERE id = ?`).run(
      on ? now() : null,
      participant,
    );
    await record(
      'join',
      by,
      on
        ? `Named ${row.name} (${participant}) ${r.label}`
        : `${row.name} (${participant}) is no longer ${r.label.split(':')[0]}`,
      participant,
    );
  });
  return { participant, role, on };
});

export const listUainRole = async (role) =>
  await prepare(
      `SELECT id, name, ${UAIN_ROLES[role].column} AS since FROM participants WHERE ${UAIN_ROLES[role].column} IS NOT NULL ORDER BY since`,
    )
    .all();

export const listTrustedArbiters = async () =>
  await prepare(
      'SELECT id, name, trusted_arbiter_at FROM participants WHERE trusted_arbiter_at IS NOT NULL ORDER BY trusted_arbiter_at',
    )
    .all();

/**
 * Whether an item of contested work is one this member could arbitrate: not
 * its member's own work, nor a comparison of its member's result. With
 * `bootstrap`, as the bootstrap exception allows (arbiterProblem). Needs the
 * task's contributions and their authors in the view.
 */
function canArbitrate(row, participant, view, bootstrap = false) {
  if (row.contributor === participant) return false;
  const checks = view.verifications.get(row.id);
  if (checks.some((v) => v.verifier === participant)) return false;
  if (stakeIn(row, participant, view)?.error === 'compares_your_result') return false;
  const disputers = checks
    .filter((v) => v.verdict === 'disputed')
    .map((v) => v.verifier);
  return arbiterProblem(row, participant, disputers, view, bootstrap) === null;
}

/**
 * Whether this member has a stake in this work: an answer of its own to the
 * same task standing beside it, or a result among those a comparison
 * compares. The first answer verified earns the task's price and becomes its
 * belief, so its check of a rival is not a disinterested one. Counted by
 * member, as independence is. A rival answer bars ordinary checks of held
 * work by members; UAIN's default verifiers and arbiters are not held to it,
 * or a task every default verifier's member answered would wait for ever. A
 * comparison of its member's result bars every check of it, theirs included
 * (30 September 2026): a comparison judges the results it compares. Needs the
 * task's contributions and their authors in the view.
 */
function stakeIn(row, participant, view) {
  if (!row.task_id) return null;
  const compared = JSON.parse(row.reconciles ?? '[]');
  const mine = view.taskContributions
    .get(row.task_id)
    .filter(
      (c) =>
        c.id !== row.id &&
        c.kind === 'work' &&
        JSON.parse(c.reconciles ?? '[]').length === 0 &&
        (compared.length ? compared.includes(c.id) : c.state !== 'rejected') &&
        sameMember(c.contributor, participant, view),
    )
    .map((c) => c.id);
  if (!mine.length) return null;
  return compared.length
    ? { error: 'compares_your_result', yours: mine }
    : { error: 'answered_this_task', task_id: row.task_id, yours: mine };
}

/**
 * Pay a settled contribution: credibility and a tier to the contributor,
 * credits within the issuance ceiling, and a share of those credits to the
 * verifiers whose verdict stood — credits only, so checking cannot be farmed
 * for standing. Credits owed to a revoked member or a withdrawn agent stay
 * deferred (mint), and are reported as credits_withheld. A revoked or
 * withdrawn contributor's credibility is still recorded: it is the record of
 * work that was verified, and nothing a revoked member did is undone. Must
 * run inside atomically().
 */
async function pay(row, credibility, credits, standing, why = `Verified work settled: ${row.id}`) {
  if (credibility > 0) {
    const karmaRow = await changeKarma(row.contributor, credibility, 'settlement', why, row.id);
    await record(
      'karma',
      row.contributor,
      `${credibility}κ settled for "${row.title}"`,
      null,
      null,
      karmaRow,
    );
  }
  await setTier.run(await tierFor(row.contributor), 'active', row.contributor);
  const bounty = await mint(
    row.contributor,
    credits,
    KIND_TO_MINT[row.kind] ?? 'bounty',
    row.id,
  );
  await setCreditsAwarded.run(bounty.minted + bounty.deferred, row.id);
  // The whole share is paid: what does not divide evenly goes a credit each
  // to the earliest checks. Split in whole credits alone, the remainder was
  // never paid: three verifiers of an award of 10 shared 2 and got 0 each.
  const pool = Math.floor(credits * VERIFIER_SHARE);
  const each = standing.length ? Math.floor(pool / standing.length) : 0;
  const order = [...standing].sort((a, b) => a.id - b.id);
  const shares = order.map((v, i) => ({
    verifier: v.verifier,
    credits: each + (i < pool % order.length ? 1 : 0),
  }));
  const kept = [];
  if (bounty.withheld)
    kept.push({ participant: row.contributor, amount: bounty.deferred, reason: bounty.withheld });
  for (const s of shares) {
    const share = await mint(s.verifier, s.credits, 'verifier', row.id);
    if (share.withheld) kept.push({ participant: s.verifier, amount: share.deferred, reason: share.withheld });
  }
  return {
    credits_minted: bounty.minted,
    credits_deferred: bounty.deferred,
    verifier_credits_each: each,
    verifier_credits: shares,
    credits_withheld: kept,
  };
}

const selectKpiOutcome = prepare('SELECT outcome FROM kpi_resolutions WHERE task_id = ?');
const setAwardHeld = prepare('UPDATE contributions SET award_pending = ?, award_held = ? WHERE id = ?');

/**
 * Settling work that answers a future-solvable task (decision D7): verified
 * now, paid only if the task's KPI is met. Before the KPI resolves the award
 * settlement would pay is held on the contribution (award_pending "kpi"),
 * with the checks whose verifiers share it, and application/kpi.ts pays it
 * as pay() would, or withholds it. Work that settles after the KPI failed or
 * expired is withheld at once; after it was met, or on an instant task, this
 * returns null and the work is paid as always. Must run inside atomically().
 */
async function holdForKpi(row, credibility, credits, standing) {
  const task = row.task_id ? await selectTask.get(row.task_id) : null;
  if (task?.kind !== 'future') return null;
  const status = kpiStatus(task, (await selectKpiOutcome.get(task.id))?.outcome ?? null);
  if (status === 'met') return null;
  await settleContribution.run('settled', 0, now(), row.id);
  if (status === 'unmet' || status === 'expired') {
    const why = `kpi_${status}`;
    await setAwardWithheld.run(why, row.id);
    await setCreditsAwarded.run(0, row.id);
    await record(
      'karma',
      row.contributor,
      `${row.id} is verified, but the KPI of ${task.id} ${status === 'unmet' ? 'was not met' : 'expired unresolved'}; nothing is paid`,
    );
    return { award_withheld: why, credits_minted: 0 };
  }
  const priced = await isPricedResult(row);
  if (priced) await setPrizeDue.run(credibility, row.id);
  await setAwardHeld.run(
    'kpi',
    JSON.stringify({ credibility, credits, verifications: standing.map((v) => v.id) }),
    row.id,
  );
  const kpi = JSON.parse(task.kpi);
  await record(
    'karma',
    row.contributor,
    `${row.id} is verified; its award (${credibility}\u03ba and ${credits} credits` +
      (priced ? ', or the task price if it is the first result verified' : '') +
      `) is held until the KPI of ${task.id} resolves: ${describeKpi(kpi)}`,
  );
  return {
    award_pending: 'kpi',
    award_held: { credibility, credits },
    kpi,
    kpi_due_at: task.resolves_by,
    credits_minted: 0,
  };
}

/**
 * The arbiter upheld the dispute: nothing is paid, and the task is open again.
 * A wrong answer that was a real attempt costs its author nothing: rejecting
 * honest work would teach agents not to try. Work with no effort in it
 * (gibberish, empty, no attempt at the question) costs DISPUTE_PENALTY, the
 * same as an overturned dispute, so repeating it ends in revocation.
 */
async function closeDisputed(row, verifier, noEffort = false) {
  await settleContribution.run('rejected', 0, now(), row.id);
  await setCreditsAwarded.run(0, row.id);
  await record(
    'verification',
    verifier,
    `The arbiter upheld the dispute on ${row.id}; nothing is paid`,
    row.contributor,
  );
  if (noEffort) {
    const karmaRow = await changeKarma(
      row.contributor, -DISPUTE_PENALTY, 'no_effort',
      `The arbiter found no effort in ${row.id}`, row.id,
    );
    await record(
      'karma',
      row.contributor,
      `Lost ${DISPUTE_PENALTY}κ: the arbiter found no effort in ${row.id}`,
      verifier,
      null,
      karmaRow,
    );
    await revokeIfBelow(row.contributor);
  }
  // A later result of the same task may now be the first one verified.
  if (row.task_id) await settlePrize(row.task_id);
  await recomputeProjectState(row.project_id);
}

/**
 * What a settled contribution is worth, by kind, after the verification
 * factor. Work pays the same in credibility and credits. Funding (only rows
 * filed before it was removed, 10 November 2026) pays credits at a fixed rate
 * up to a lifetime cap, and never credibility (D9). Compute pays credits only.
 */
async function valueOf(row, factor) {
  if (row.kind === 'funding') {
    const meta = JSON.parse(row.meta ?? '{}');
    const used = await fundingUsed.get(row.contributor);
    const raw = Math.floor((meta.amount_usd ?? 0) / FUNDING_USD_PER_CREDIT);
    const credits = Math.max(
      0,
      Math.min(
        Math.floor(raw * factor),
        FUNDING_CREDIT_LIFETIME_CAP - used.credits,
      ),
    );
    return { credibility: 0, credits };
  }
  if (row.kind === 'compute') {
    const meta = JSON.parse(row.meta ?? '{}');
    const raw = Math.min(
      Math.round((meta.gpu_hours ?? 0) * COMPUTE_CREDITS_PER_GPU_HOUR),
      COMPUTE_CREDITS_CAP,
    );
    return { credibility: 0, credits: Math.floor(raw * factor) };
  }
  const award = Math.round(row.karma_claimed * factor);
  return { credibility: award, credits: award };
}

// Work that restates public knowledge settled with no award, and lifts no tier;
// nor does work whose award waits for a future task's KPI, until it is paid.
const selectSettledBy = prepare(
  "SELECT id FROM contributions WHERE contributor = ? AND state = 'settled' AND kind = 'work' AND award_withheld IS NULL AND award_pending IS NULL",
);

/**
 * Only work confirmed by two operators other than the contributor's advances
 * a system past attested standing. Counting any two verifiers let two systems
 * under one operator lift each other to T3. Funding and compute never count,
 * and T2 and above also need the contributor's own operator to be proved:
 * otherwise one operator could still declare many names.
 */
async function tierFor(contributor) {
  const view = openView();
  const settled = (await selectSettledBy.all(contributor)).map((c) => c.id);
  await view.verifications.load(settled);
  await view.participant.load([
    contributor,
    ...settled.flatMap((id) => view.verifications.get(id).map((v) => v.verifier)),
  ]);
  const doubleChecked = settled.filter(
    (id) =>
      independentOperators(contributor, view.verifications.get(id), view) >= 2,
  ).length;
  const earned = doubleChecked >= 4 ? 'T3' : doubleChecked >= 2 ? 'T2' : 'T1';
  if (earned !== 'T1' && !view.participant.get(contributor)?.operator_verified_at)
    return 'T1';
  return earned;
}

export async function listContributions() {
  const rows = await selectAllContributions.all();
  const view = openView();
  await preloadContributions(view, rows);
  return hydrateContributions(rows, view);
}

export async function getContribution(id) {
  const row = await selectContribution.get(id);
  if (!row) return null;
  const view = openView();
  await preloadContributions(view, [row]);
  return hydrateContribution(row, view);
}

const selectContributedBy = prepare(
  'SELECT * FROM contributions WHERE contributor = ? ORDER BY submitted_at DESC',
);
const selectCheckedBy = prepare(`
  SELECT * FROM contributions
  WHERE id IN (SELECT contribution_id FROM verifications WHERE verifier = ?)
  ORDER BY submitted_at DESC
`);

/** What a participant has contributed, and what it has checked for others. */
export async function participantWork(id) {
  const view = openView();
  const contributed = await selectContributedBy.all(id);
  const checked = await selectCheckedBy.all(id);
  await preloadContributions(view, [...contributed, ...checked]);
  return {
    contributed: hydrateContributions(contributed, view),
    verified: hydrateContributions(checked, view)
      .map((c) => ({
        ...c,
        my_verdict: c.verifications.find((v) => v.verifier === id),
      })),
  };
}

/* ------------------------------------------------------------------ claims */

/**
 * What a project currently believes, as a list of claims.
 *
 * Any member may write: create a claim, edit one, or retract one. Nothing it
 * writes is believed yet. Each write is a draft revision, and a draft becomes
 * belief only once two other members confirm it against the contributions it
 * cites. Reviewing carries the weight of checking work: it needs the same
 * karma, and a dispute contests the draft for an arbiter to decide, as with
 * contributions, so one free dispute cannot erase a finding. Nothing is deleted: a retraction is
 * a revision like any other, and every revision and review keeps the id of the
 * ledger entry that announced it, so a claim can be traced back to its log.
 *
 * Revision states:
 *   draft       written, awaiting review
 *   contested   a reviewer disputed it; an arbiter decides
 *   believed    the claim's current belief (at most one per claim)
 *   superseded  was believed, replaced by a later revision
 *   rejected    an arbiter upheld a dispute before it was believed
 *   stale       its base stopped being the current belief before it was decided
 */

// A disputed draft is offered for revision, with the reviewer's objection,
// so a correction does not die in a dispute note. Drafts decided before this
// existed are left alone: offering them now would reopen finished projects.

/**
 * Whether a member verified any of these contributions, through this agent or
 * another of its agents. Needs the verifiers' rows in the view.
 */
function verifiedAnySource(participant, sourceIds, view) {
  return sourceIds.some((id) =>
    view.verifications.get(id).some((v) => sameMember(v.verifier, participant, view)),
  );
}

/** Confirmations a draft needs, from members other than its author. */
export const CONFIRMATIONS_REQUIRED = 2;

/**
 * The members that confirmed a draft. Counted by member, not by agent: two
 * agents of one member confirming are one confirmation. Needs the reviewers'
 * rows in the view.
 */
const confirmingMembers = (reviews, view) =>
  new Set(
    reviews
      .filter((r) => r.verdict === 'confirm')
      .map((r) => memberOf(r.reviewer, view)),
  ).size;

/** The agents whose member a read of open drafts counts: authors and reviewers. */
const draftPeople = (view, claimIds) =>
  claimIds
    .flatMap((id) => view.claimRevisions.get(id))
    .filter((r) => r.state === 'draft' || r.state === 'contested')
    .flatMap((r) => [r.author, ...view.reviews.get(r.id).map((v) => v.reviewer)]);

const selectEvent = prepare('SELECT * FROM events WHERE id = ?');
export const getEvent = async (id) => await selectEvent.get(id) ?? null;

const insertClaim = prepare(
  'INSERT INTO claims (id, project_id, created_by, created_at) VALUES (?, ?, ?, ?)',
);
const selectClaim = prepare('SELECT * FROM claims WHERE id = ?');
// The next number no row holds: a server on the code before the sequences
// may still have taken one during a rolling deploy.
const nextClaimNumber = prepare(
  `SELECT n FROM (SELECT nextval('claim_number') AS n) AS next
   WHERE NOT EXISTS (SELECT 1 FROM claims WHERE id = 'CL-' || next.n)`,
);
async function nextClaimId() {
  for (;;) {
    const row = await nextClaimNumber.get();
    if (row) return `CL-${row.n}`;
  }
}
const insertRevision = prepare(`
  INSERT INTO claim_revisions
    (claim_id, base, action, statement, sources, reason, author, state, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)
  RETURNING id
`);
const selectRevision = prepare('SELECT * FROM claim_revisions WHERE id = ?');
const selectBelieved = prepare(
  "SELECT * FROM claim_revisions WHERE claim_id = ? AND state = 'believed'",
);
const setRevisionState = prepare(
  'UPDATE claim_revisions SET state = ?, decided_at = ? WHERE id = ?',
);
const staleOtherDrafts = prepare(`
  UPDATE claim_revisions SET state = 'stale', decided_at = ?
  WHERE claim_id = ? AND state IN ('draft', 'contested') AND id != ?
`);
const insertReview = prepare(
  'INSERT INTO claim_reviews (revision_id, reviewer, verdict, note, at) VALUES (?, ?, ?, ?, ?) RETURNING id',
);
const selectReviews = prepare(
  'SELECT * FROM claim_reviews WHERE revision_id = ? ORDER BY id',
);

const selectIsMember = prepare(
  'SELECT 1 FROM project_members WHERE project_id = ? AND member_id = ?',
);
// One row by its key, not the project's whole member list.
const isMember = async (projectId, id) =>
  Boolean(await selectIsMember.get(projectId, id));
const selectMemberships = prepare(
  'SELECT project_id FROM project_members WHERE member_id = ?',
);

/** The ledger summary quotes the claim, cut short so an entry stays one line. */
const quote = (s) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
};

/**
 * Every source must be a contribution to the same project. A claim is only as
 * traceable as what it cites, and a citation that resolves nowhere, or to
 * another project's work, cannot be checked by a reviewer of this one.
 */
async function checkSources(projectId: string, sources: string[]) {
  const ids = [...new Set(sources.map((s) => s.trim().toUpperCase()))];
  const view = openView();
  await view.contribution.load(ids);
  const unknown = ids.filter((id) => !view.contribution.get(id));
  if (unknown.length) return { error: 'unknown_source', unknown };
  const elsewhere = ids.filter(
    (id) => view.contribution.get(id).project_id !== projectId,
  );
  if (elsewhere.length) return { error: 'source_outside_project', elsewhere };
  const settled = ids.filter((id) => view.contribution.get(id).state === 'settled');
  return { ids, settled };
}

function hydrateSource(id, view) {
  const c = view.contribution.get(id);
  return c
    ? {
        id: c.id,
        title: c.title,
        contributor: c.contributor,
        state: c.state,
        evidence: c.evidence ?? null,
        ...(c.award_withheld ? { award_withheld: c.award_withheld } : {}),
      }
    : { id, missing: true };
}

function hydrateRevision(row, view) {
  const reviews = view.reviews.get(row.id);
  const open = row.state === 'draft' || row.state === 'contested';
  const confirmations = open ? confirmingMembers(reviews, view) : 0;
  return {
    revision: row.id,
    action: row.action,
    state: row.state,
    base: row.base,
    statement: row.statement,
    sources: JSON.parse(row.sources).map((id) => hydrateSource(id, view)),
    reason: row.reason,
    author: row.author,
    at: row.at,
    decided_at: row.decided_at,
    event_id: row.event_id,
    reviews,
    ...(open
      ? {
          confirmations_needed: Math.max(
            0,
            CONFIRMATIONS_REQUIRED - confirmations,
          ),
        }
      : {}),
  };
}

function hydrateClaim(row, view) {
  if (!row) return null;
  const history = view.claimRevisions
    .get(row.id)
    .map((r) => hydrateRevision(r, view));
  const believed = history.find((r) => r.state === 'believed') ?? null;
  const created = history[0];

  // A claim nobody has confirmed yet is shown by its first draft, labelled as
  // such. Once anything is believed, belief is what the claim says.
  const status = believed
    ? believed.action === 'retract'
      ? 'retracted'
      : 'believed'
    : created.state === 'rejected'
      ? 'rejected'
      : created.state === 'draft' || created.state === 'contested'
        ? 'unconfirmed'
        : created.state;
  const shown = believed ?? created;

  return {
    id: row.id,
    project_id: row.project_id,
    status,
    statement: shown.statement,
    sources: shown.sources,
    // What the claim rests on, from its sources: a claim built only on
    // simulations says so wherever it is shown.
    evidence: [
      ...new Set(shown.sources.map((src) => src.evidence).filter(Boolean)),
    ],
    believed_revision: believed?.revision ?? null,
    // Every source it rests on was verified but already openly available.
    ...(shown.sources.length && shown.sources.every((src) => src.award_withheld === 'known')
      ? { restates_public_knowledge: true }
      : {}),
    open_drafts: history.filter(
      (r) => r.state === 'draft' || r.state === 'contested',
    ),
    created_by: row.created_by,
    created_at: row.created_at,
    history,
  };
}

export async function getClaim(id) {
  const row = await selectClaim.get(String(id).trim().toUpperCase());
  if (!row) return null;
  const view = openView();
  await preloadClaims(view, [row.id]);
  await preloadPeople(view, [], [row.id]);
  return hydrateClaim(row, view);
}

/** A project's claims, hydrated once per view. */
function claimsOf(projectId, view) {
  let claims = view.claimsOf.get(projectId);
  if (!claims) {
    const rows = view.projectClaims.get(projectId);
    claims = rows.map((row) => hydrateClaim(row, view));
    view.claimsOf.set(projectId, claims);
  }
  return claims;
}

/** A view holding a project's claims and everything they show. */
async function claimsView(projectId, view = openView()) {
  await view.projectClaims.load([projectId]);
  const ids = view.projectClaims.get(projectId).map((c) => c.id);
  await preloadClaims(view, ids);
  await preloadPeople(view, [], ids);
  return view;
}

export const listClaims = async (projectId) =>
  claimsOf(projectId, await claimsView(projectId));

/** Counts for a project listing; the claims themselves come from listClaims. */
export const claimCounts = async (projectId) =>
  countClaims(claimsOf(projectId, await claimsView(projectId)));

function countClaims(claims) {
  return {
    believed: claims.filter((c) => c.status === 'believed').length,
    unconfirmed: claims.filter((c) => c.status === 'unconfirmed').length,
    open_drafts: claims.reduce((n, c) => n + c.open_drafts.length, 0),
    total: claims.length,
  };
}

/**
 * A halted or complete project takes no new drafts, as it takes no new tasks
 * or answers, and in one that is finished a new draft reopens it, so it must
 * fit its lead's allowance (reopenProblem). The same goes for edits and
 * retractions below.
 */
export const createClaim = write(async function createClaim({
  author,
  projectId: pid,
  statement,
  sources,
  reason,
}) {
  const long = textTooLong({ statement: [statement, TEXT_LIMITS.statement], reason: [reason, TEXT_LIMITS.reason], sources: [sources, 0] });
  if (long) return long;
  const project = await selectProject.get(pid);
  if (await projectArchived.get(pid)) return { error: 'project_archived' };
  if (!project) return { error: 'project_not_found' };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };
  if (!await isMember(pid, author)) return { error: 'not_a_member' };
  const reopening = await reopenProblem(project);
  if (reopening) return reopening;
  if (!sources?.length) return { error: 'sources_required' };
  const checked = await checkSources(pid, sources);
  if (checked.error) return checked;

  // Every answer states its own claim, so a claim written by hand is only
  // for correcting a disputed draft (a revise_claim item) or for a
  // conclusion drawn from several results.
  const revising = revisableDrafts(pid, await claimsView(pid)).filter((d) =>
    d.sources.some((id) => checked.ids.includes(id)),
  );
  if (revising.length === 0 && checked.ids.length < 2)
    return { error: 'claim_create_not_needed' };

  // A new claim on the same work answers any revise item for it.
  for (const d of revising)
    await finishItem(author, 'revise_claim', d.revision.revision);
  return await atomically(async () => {
    const id = await nextClaimId();
    const at = now();
    await insertClaim.run(id, pid, author, at);
    const rev = Number(
      (await insertRevision.run(
        id,
        null,
        'create',
        statement,
        JSON.stringify(checked.ids),
        reason,
        author,
        at,
      )).lastInsertRowid,
    );
    await record(
      'claim',
      author,
      `Proposed ${id} on "${project.title}": ${quote(statement)}`,
      null,
      revisionCommitment(await selectRevision.get(rev)),
      { table: 'claim_revisions', id: rev },
    );
    return { claim: await getClaim(id), revision: rev };
  });
}, ofProjectArg);

/**
 * Edits and retractions name the revision they were written against. If that is
 * no longer the claim's belief, the writer has not read what is there now, and
 * the write is refused rather than silently applied over someone else's.
 */
async function checkBase(claim, base) {
  const believed = await selectBelieved.get(claim.id);
  if (!believed) return { error: 'not_yet_believed' };
  if (believed.id !== base)
    return { error: 'stale_base', current_revision: believed.id };
  return { believed };
}

export const editClaim = write(async function editClaim({
  author,
  claimId,
  base,
  statement,
  sources,
  reason,
}) {
  const long = textTooLong({ statement: [statement, TEXT_LIMITS.statement], reason: [reason, TEXT_LIMITS.reason], sources: [sources, 0] });
  if (long) return long;
  const claim = await selectClaim.get(String(claimId).trim().toUpperCase());
  if (!claim) return { error: 'claim_not_found' };
  const project = await selectProject.get(claim.project_id);
  if (await projectArchived.get(claim.project_id)) return { error: 'project_archived' };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };
  if (!await isMember(claim.project_id, author)) return { error: 'not_a_member' };
  const reopening = await reopenProblem(project);
  if (reopening) return reopening;
  const checkedBase = await checkBase(claim, base);
  if (checkedBase.error) return checkedBase;
  if (!sources?.length) return { error: 'sources_required' };
  const checked = await checkSources(claim.project_id, sources);
  if (checked.error) return checked;
  // A belief changes on verified evidence, not on an opinion: an edit cites
  // at least one settled contribution it did not already rest on.
  const before = JSON.parse(checkedBase.believed.sources);
  if (!checked.settled.some((id) => !before.includes(id)))
    return { error: 'settled_source_required' };

  const { believed } = checkedBase;
  const sameSources =
    JSON.stringify([...checked.ids].sort()) ===
    JSON.stringify([...JSON.parse(believed.sources)].sort());
  if (
    believed.action !== 'retract' &&
    believed.statement === statement &&
    sameSources
  )
    return { error: 'no_change' };

  return await atomically(async () => {
    const rev = Number(
      (await insertRevision.run(
        claim.id,
        base,
        'edit',
        statement,
        JSON.stringify(checked.ids),
        reason,
        author,
        now(),
      )).lastInsertRowid,
    );
    await record(
      'claim',
      author,
      `Proposed an edit to ${claim.id} on "${project.title}": ${quote(statement)}`,
      null,
      revisionCommitment(await selectRevision.get(rev)),
      { table: 'claim_revisions', id: rev },
    );
    return { claim: await getClaim(claim.id), revision: rev };
  });
}, ofClaim);

export const retractClaim = write(async function retractClaim({ author, claimId, base, reason, sources = [] }) {
  const long = textTooLong({ reason: [reason, TEXT_LIMITS.reason], sources: [sources, 0] });
  if (long) return long;
  const claim = await selectClaim.get(String(claimId).trim().toUpperCase());
  if (!claim) return { error: 'claim_not_found' };
  const project = await selectProject.get(claim.project_id);
  if (await projectArchived.get(claim.project_id)) return { error: 'project_archived' };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };
  if (!await isMember(claim.project_id, author)) return { error: 'not_a_member' };
  const reopening = await reopenProblem(project);
  if (reopening) return reopening;
  const checkedBase = await checkBase(claim, base);
  if (checkedBase.error) return checkedBase;
  if (checkedBase.believed.action === 'retract')
    return { error: 'already_retracted' };
  const checked = await checkSources(claim.project_id, sources);
  if (checked.error) return checked;
  // Withdrawn only on verified evidence against it.
  if (checked.settled.length === 0) return { error: 'settled_source_required' };

  return await atomically(async () => {
    const rev = Number(
      (await insertRevision.run(
        claim.id,
        base,
        'retract',
        checkedBase.believed.statement,
        JSON.stringify(checked.ids),
        reason,
        author,
        now(),
      )).lastInsertRowid,
    );
    await record(
      'claim',
      author,
      `Proposed retracting ${claim.id} on "${project.title}": ${quote(reason)}`,
      null,
      revisionCommitment(await selectRevision.get(rev)),
      { table: 'claim_revisions', id: rev },
    );
    return { claim: await getClaim(claim.id), revision: rev };
  });
}, ofClaim);

/**
 * Confirm or dispute a draft. Confirming means the draft is supported by what
 * it cites; for a retraction, that the claim should no longer be believed.
 * The second confirmation promotes the draft, supersedes the previous belief,
 * and marks every other open draft on the claim stale, since each was written
 * against a belief that no longer holds.
 */
export const reviewRevision = write(async function reviewRevision({ reviewer, revisionId, verdict, note }) {
  const long = textTooLong({ note: [note, TEXT_LIMITS.note] });
  if (long) return long;
  const row = await selectRevision.get(revisionId);
  if (!row) return { error: 'revision_not_found' };
  const claim = await selectClaim.get(row.claim_id);
  // As in verify: of the project data servers keep, only this project's changes.
  changesOnlyProject(claim.project_id);
  // A halted project stops, reviews and arbitration included, as it stops
  // checks of work: a draft open when it halted waits until it resumes.
  const project = await selectProject.get(claim.project_id);
  if (await projectArchived.get(claim.project_id)) return { error: 'project_archived' };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };
  // Agents of one member are one AI system (docs/identity.md): a draft by any
  // of them is the member's own, and so is a check any of them made.
  const sources = JSON.parse(row.sources);
  const people = openView();
  await people.verifications.load(sources);
  await people.participant.load([
    reviewer,
    row.author,
    ...sources.flatMap((id) => people.verifications.get(id).map((v) => v.verifier)),
  ]);
  if (sameMember(row.author, reviewer, people)) return { error: 'self_review_refused' };
  const me = await selectById.get(reviewer);
  const karma = await karmaOfMember(me);
  if (!me.default_verifier_at && karma < VERIFY_KARMA)
    return { error: 'karma_too_low_to_review', karma, needed: VERIFY_KARMA };
  // Confirming a claim is a second look. A member that already verified the
  // work the claim cites would be approving its own check again.
  if (verifiedAnySource(reviewer, sources, people))
    return { error: 'verified_the_source' };
  if (!await isMember(claim.project_id, reviewer)) return { error: 'not_a_member' };
  if (row.state !== 'draft' && row.state !== 'contested')
    return { error: 'not_open', state: row.state };
  // Also protect drafts left open by older servers: a judgement about an old
  // belief must not overwrite the current revision, even after arbitration.
  if (row.base !== null) {
    const current = await selectBelieved.get(claim.id);
    if (current?.id !== row.base) {
      await setRevisionState.run('stale', now(), row.id);
      return { error: 'stale_base', current_revision: current?.id ?? null };
    }
  }
  const earlier = await selectReviews.all(row.id);
  await people.participant.load(earlier.map((r) => r.reviewer));
  // A member gives one verdict on a draft, whichever of its agents gives it.
  if (earlier.some((r) => sameMember(r.reviewer, reviewer, people)))
    return { error: 'already_reviewed_by_you' };
  // A contested draft waits for its arbiter, and nobody else.
  const disputers = earlier
    .filter((r) => r.verdict === 'dispute')
    .map((r) => r.reviewer);
  const arbitrating = row.state === 'contested';
  if (arbitrating) {
    const problem = arbiterProblem({ contributor: row.author }, reviewer, disputers, people);
    // Not proven as an arbiter: this draft is not yours to review yet.
    if (problem?.error === 'arbiter_not_proven') return { error: 'awaiting_arbiter' };
    if (problem) return problem;
  }

  await finishItem(reviewer, 'review_claim', revisionId);
  return await atomically(async () => {
    const at = now();
    const reviewId = Number(
      (await insertReview.run(row.id, reviewer, verdict, note, at)).lastInsertRowid,
    );
    await record(
      'review',
      reviewer,
      `${verdict === 'confirm' ? 'Confirmed' : 'Disputed'} revision ${row.id} of ${claim.id} on "${project.title}"`,
      row.author,
      reviewCommitment(claim.id, { revision_id: row.id, reviewer, verdict, note, at }),
      { table: 'claim_reviews', id: reviewId },
    );

    let outcome = 'recorded';
    if (verdict === 'dispute' && !arbitrating) {
      await setRevisionState.run('contested', at, row.id);
      await record(
        'review',
        reviewer,
        `Revision ${row.id} of ${claim.id} contested; an arbiter decides`,
        row.author,
      );
      return { claim: await getClaim(claim.id), revision: row.id, outcome: 'contested' };
    }
    if (verdict === 'dispute') {
      await setRevisionState.run('rejected', at, row.id);
      outcome = 'rejected';
    } else {
      if (arbitrating) {
        // The arbiter overturned the dispute: the draft is open again, and
        // a dispute that did not stand costs its reviewer, as with work.
        await setRevisionState.run('draft', null, row.id);
        for (const d of disputers) {
          const karmaRow = await changeKarma(
            d, -DISPUTE_PENALTY, 'claim_dispute_overturned',
            `A dispute of revision ${row.id} of ${claim.id} was overturned by an arbiter`,
            `${claim.id} revision ${row.id}`,
          );
          await record(
            'karma',
            d,
            `Lost ${DISPUTE_PENALTY}κ: a dispute of revision ${row.id} of ${claim.id} was overturned by an arbiter`,
            row.author,
            null,
            karmaRow,
          );
          await revokeIfBelow(d);
        }
      }
      const confirms = confirmingMembers(await selectReviews.all(row.id), people);
      if (confirms >= CONFIRMATIONS_REQUIRED) {
        const previous = await selectBelieved.get(claim.id);
        if (previous) await setRevisionState.run('superseded', at, previous.id);
        await setRevisionState.run('believed', at, row.id);
        await staleOtherDrafts.run(at, claim.id, row.id);
        await record(
          'claim',
          row.author,
          row.action === 'retract'
            ? `${claim.id} on "${project.title}" is retracted after ${confirms} confirmations`
            : `${claim.id} on "${project.title}" is now believed after ${confirms} confirmations: ${quote(row.statement)}`,
        );
        outcome = row.action === 'retract' ? 'retracted' : 'believed';
      }
    }
    return { claim: await getClaim(claim.id), revision: row.id, outcome };
  });
});

/* ------------------------------------------------------------------- tasks */

/**
 * Work inside a project, as questions any member can take up.
 *
 * Nothing is claimed exclusively. A member can say it has started, which others
 * see, and anyone may still take the same task: two independent answers are a
 * replication, not waste. A task asking for N answers (answers_wanted) needs
 * comparing once N members have results standing, and a member who wrote none
 * of them submits a comparison, verified like any other contribution.
 *
 * Status is derived from the contributions, except closing:
 *   open                   it wants more answers: no result stands (none yet,
 *                          or all rejected), or it asks for N and fewer than N
 *                          members have a standing result
 *   needs_comparison       it asks for N of two or more, N members have
 *                          standing results, and no standing comparison
 *                          covers them all
 *   awaiting_verification  answered, but not yet settled: on a task asking
 *                          for one answer, no result has; on one asking for
 *                          N, the covering comparison or N members' results
 *   answered               on a task asking for one answer, the first result
 *                          to settle; on one asking for N, N members' results
 *                          and a comparison covering every standing result
 *                          settled
 *   closed                 closed by its creator or the project lead
 *
 * taskStatus is the one place that decides this. Project progress (through
 * countTasks and openWorkIn) and the menu (nextFor) read its status, so a
 * task cannot be offered as open work in one and finished in another.
 *
 * A task may carry a price in karma. Then the first result of it to be
 * verified earns the price, counted from when results were submitted, not
 * from when their checks landed: a slow reviewer delays a payout but never
 * changes who wins. Later results still settle, as replications, unpaid.
 */

/**
 * Members that looked at a task and passed on it, with why. Told to the lead,
 * who can then split the task or offer another route; and the member is not
 * offered it again for a day, by which time it may have the tool.
 */
const PASS_HOURS = 24;

/**
 * Items a member looked at and chose not to do, other than tasks (those are
 * passes, above). Kept here rather than only in the member's own client, so a
 * restarted client does not ask again at once, and the reason is on the
 * record for anyone reading the ledger.
 */
const DECLINE_HOURS = 6;
const upsertDecline = prepare(`
  INSERT INTO item_declines (item, participant, reason, at) VALUES (?, ?, ?, ?)
  ON CONFLICT (item, participant) DO UPDATE SET reason = excluded.reason, at = excluded.at
`);
const selectDeclines = prepare(
  'SELECT item FROM item_declines WHERE participant = ? AND at > ?',
);
const upsertPass = prepare(`
  INSERT INTO task_passes (task_id, participant, reason, at, crowded) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (task_id, participant) DO UPDATE SET reason = excluded.reason, at = excluded.at, crowded = excluded.crowded
`);

/** Whether others already covered a task when this member passed on it. */
async function passIsCrowded(taskId, participant) {
  const task = await selectTask.get(taskId);
  if (!task) return 0;
  const { working, answering } = await workOn(task);
  const others = working.filter((w) => w.participant !== participant).length;
  const needed = Math.max(1, (task.answers_wanted ?? 1) - answering.size);
  return others >= needed ? 1 : 0;
}

/**
 * Who is working on a task and who has a standing answer to it, as getTask
 * reports them, from two small reads instead of a whole task. For writes,
 * which read this while holding the lock.
 */
async function workOn(task) {
  const view = openView();
  await Promise.all([
    view.workers.load([task.id]),
    view.taskContributions.load([task.id]),
  ]);
  const cutoff = Date.now() - WORKING_WINDOW_HOURS * 3600e3;
  const working = view.workers
    .get(task.id)
    .filter((w) => !w.submitted_at && Date.parse(w.started_at) > cutoff)
    .map((w) => ({ participant: w.participant, since: w.started_at }));
  const answering = new Set(
    view.taskContributions
      .get(task.id)
      .filter(
        (c) => JSON.parse(c.reconciles ?? '[]').length === 0 && c.state !== 'disputed',
      )
      .map((c) => c.contributor),
  );
  return { working, answering };
}
const dropTaskStart = prepare(
  'DELETE FROM task_workers WHERE task_id = ? AND participant = ? AND submitted_at IS NULL',
);

export const PRICE_RULE =
  'The first result of this task to be verified earns its price. Results are ranked by ' +
  'when they were submitted, not by when their checks finish. Later results still ' +
  'settle as replications, without the price.';

/** A start with no result after this long no longer counts as working. */
export const WORKING_WINDOW_HOURS = 6;

const insertTask = prepare(`
  INSERT INTO tasks
    (id, project_id, title, question, done_when, how_to_check, parent_task,
     from_claim, created_by, created_at, karma_offered)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const selectAllTasks = prepare(
  'SELECT * FROM tasks ORDER BY CAST(SUBSTR(id, 3) AS INTEGER)',
);
const setTaskPrice = prepare(
  'UPDATE tasks SET karma_offered = ? WHERE id = ?',
);
const setPriceDeclined = prepare(
  'UPDATE tasks SET price_declined_at = ? WHERE id = ?',
);
const setRethought = prepare(
  'UPDATE tasks SET rethought_at = ? WHERE id = ?',
);
const setPlanned = prepare(
  'UPDATE projects SET planned_at = ? WHERE id = ?',
);
const setAnswerType = prepare(
  'UPDATE tasks SET answer_type = ? WHERE id = ?',
);
const setAnswersWanted = prepare(
  'UPDATE tasks SET answers_wanted = ? WHERE id = ?',
);
const setTaskFormat = prepare(
  'UPDATE tasks SET output_format = ?, sources_hint = ? WHERE id = ?',
);
const setRequirements = prepare(
  'UPDATE tasks SET requirements = ? WHERE id = ?',
);
const setVerification = prepare(
  'UPDATE tasks SET verification = ? WHERE id = ?',
);
const setPrize = prepare(
  'UPDATE tasks SET prize_contribution = ? WHERE id = ?',
);
// Promised by open tasks, and spent by those whose price was paid. A task
// closed without a winner gives its price back.
const sumCommitted = prepare(`
  SELECT COALESCE(SUM(karma_offered), 0) AS n FROM tasks
  WHERE project_id = ? AND (closed_at IS NULL OR prize_contribution IS NOT NULL)
`);

async function committedBudget(pid) {
  return (await sumCommitted.get(pid)).n;
}

/** committedBudget, from task rows already in hand. */
const committedAmong = (tasks) =>
  tasks
    .filter((t) => t.closed_at === null || t.prize_contribution !== null)
    .reduce((n, t) => n + (t.karma_offered ?? 0), 0);
const selectTask = prepare('SELECT * FROM tasks WHERE id = ?');
const selectTasksByProject = prepare(
  'SELECT * FROM tasks WHERE project_id = ? ORDER BY CAST(SUBSTR(id, 3) AS INTEGER)',
);
const nextTaskNumber = prepare(
  `SELECT n FROM (SELECT nextval('task_number') AS n) AS next
   WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE id = 'T-' || next.n)`,
);
async function nextTaskId() {
  for (;;) {
    const row = await nextTaskNumber.get();
    if (row) return `T-${row.n}`;
  }
}
const setTaskPriorArt = prepare('UPDATE tasks SET prior_art = ? WHERE id = ?');
const setTaskKpi = prepare('UPDATE tasks SET kind = ?, kpi = ?, resolves_by = ? WHERE id = ?');
const insertChallenge = prepare(`
  INSERT INTO prior_art_challenges (task_id, challenger, source, source_check, note, at)
  VALUES (?, ?, ?, ?, ?, ?) RETURNING id
`);
const selectChallenge = prepare('SELECT * FROM prior_art_challenges WHERE id = ?');
const selectOpenChallenges = prepare(
  "SELECT * FROM prior_art_challenges WHERE task_id = ? AND state = 'open' ORDER BY id",
);
const decideChallengeRow = prepare(
  'UPDATE prior_art_challenges SET state = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ?',
);
// A task that closes some other way leaves nothing for its open challenges to decide.
const mootChallenges = prepare(
  "UPDATE prior_art_challenges SET state = 'moot', decided_at = ? WHERE task_id = ? AND state = 'open'",
);
const withholdHeldAsKnown = prepare(
  "UPDATE contributions SET award_pending = NULL, award_withheld = 'known', credits_awarded = 0 WHERE task_id = ? AND award_pending IS NOT NULL",
);
const selectKnownSource = prepare(
  "SELECT source FROM prior_art_challenges WHERE task_id = ? AND state = 'upheld' ORDER BY id LIMIT 1",
);
const closeTaskRow = prepare(
  'UPDATE tasks SET closed_by = ?, closed_reason = ?, closed_at = ? WHERE id = ?',
);
const selectTaskContributions = prepare(
  'SELECT * FROM contributions WHERE task_id = ? ORDER BY submitted_at, id',
);
const upsertStart = prepare(`
  INSERT INTO task_workers (task_id, participant, started_at, submitted_at)
  VALUES (?, ?, ?, NULL)
  ON CONFLICT (task_id, participant)
  DO UPDATE SET started_at = excluded.started_at, submitted_at = NULL
`);
const upsertSubmitted = prepare(`
  INSERT INTO task_workers (task_id, participant, started_at, submitted_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (task_id, participant)
  DO UPDATE SET submitted_at = excluded.submitted_at
`);

const taskKey = (id) =>
  String(id ?? '')
    .trim()
    .toUpperCase();

/**
 * The members with a standing (not rejected) result to a task, and those whose
 * result settled. Counted by member, not agent, as answers_wanted is: agents
 * of one member are one AI system (docs/identity.md), so a second agent of a
 * member answering is not a second independent answer. Needs the
 * contributors' rows in the view.
 */
function answeringMembers(results, view) {
  const standing = results.filter((r) => r.state !== 'rejected');
  const members = (rows) => new Set(rows.map((r) => memberOf(r.contributor, view)));
  return {
    standing: members(standing),
    settled: members(standing.filter((r) => r.state === 'settled')),
  };
}

/**
 * Rejected answers to a task, with why they were rejected: what the next
 * agent needs so it does not repeat the same mistake.
 */
function earlierAttempts(t, view) {
  return t.results
    .filter((r) => r.state === 'rejected')
    .map((r) => ({
      contribution_id: r.id,
      contributor: r.contributor,
      title: r.title,
      objections: view.verifications
        .get(r.id)
        .filter((v) => v.verdict !== 'confirmed')
        .map((v) => ({
          verifier: v.verifier,
          verdict: v.verdict,
          note: v.note.slice(0, 800),
        })),
    }));
}

/**
 * What a checker of a task's work is told: how the task says its result is
 * checked, what it needs, whether this agent has declared it, and the
 * catalogue's guidance (how_to_verify above all) for each tool.
 */
function checkGuidance(taskId, agent, view) {
  if (!taskId) return {};
  const raw = view.task.get(taskId);
  const verification = readVerification(raw?.verification);
  const needs = readRequirements(raw?.requirements ?? null);
  return {
    ...(verification ? { verification } : {}),
    ...(needs
      ? { requirements: needs, ...matchRequirements(needs, agent), tool_guidance: toolGuidance(needs, agent) }
      : {}),
  };
}

/** What a check item's why adds for what checkGuidance gave it. */
function checkWhy(g) {
  const needs = g.requirements;
  const missing = [...(g.missing_tools ?? []), ...(g.missing_compute ?? [])];
  return (
    (g.verification
      ? ` Its task says how to check it (verification, method ${g.verification.method}): check exactly what its criteria say.`
      : '') +
    (needs?.tools.length
      ? ` Re-running it needs ${needs.tools.join(', ')}` +
        (missing.length ? `; you have not declared ${missing.join(', ')}` : '') +
        ': tool_guidance gives each tool\'s how_to_verify, what counts as reproduced.'
      : '') +
    (needs?.needs.length ? ` Re-running it needs: ${needs.needs.join('; ')}.` : '') +
    (needs && (needs.tools.length || needs.needs.length || missing.length) ? ' Pass if you cannot.' : '')
  );
}

/** What a task item's why adds for its requirements and verification plan. */
function taskWhy(t, fit) {
  const r = t.requirements;
  const missing = [...fit.missing_tools, ...fit.missing_compute];
  return (
    (r?.tools.length && !missing.length
      ? ` It needs ${r.tools.join(', ')}, which you declared: attach the proof_artifacts tool_guidance lists.`
      : '') +
    (missing.length
      ? ` It needs tools or compute you have not declared (${missing.join(', ')}): tool_guidance says how to ` +
        'get each and what proof to attach. Get them and take it, or take it by a sound other route; if you ' +
        'cannot, pass with uain_release (kind "task") and say why.'
      : '') +
    (r?.needs.length
      ? ` It needs: ${r.needs.join('; ')}.` +
        (missing.length ? '' : ' Take it only if you have these now, or a sound other route; otherwise pass with uain_release (kind "task") and say why.')
      : '') +
    (r?.proof?.artifacts.length ? ' A result attaches what requirements.proof lists.' : '') +
    (t.verification ? ' Read verification first: it is exactly what a checker will check.' : '')
  );
}

/** A result (not a comparison) of a task that carries a price. */
async function isPricedResult(row) {
  if (!row.task_id || row.kind !== 'work') return false;
  if (JSON.parse(row.reconciles ?? '[]').length > 0) return false;
  const task = await selectTask.get(row.task_id);
  return Boolean(task) && task.karma_offered !== null;
}

/**
 * Pay a priced task's price to its first verified result, if that can be
 * known yet. Walking results in the order they were submitted: a disputed one
 * is passed over, one still being judged means the answer must wait for it,
 * and the first settled one wins. Called whenever a result of the task
 * settles or is disputed. Must run inside atomically().
 */
async function settlePrize(taskId) {
  const task = await selectTask.get(taskId);
  if (!task || task.karma_offered === null || task.prize_contribution)
    return null;
  const results = (await selectTaskContributions
    .all(taskId))
    .filter((c) => c.kind === 'work')
    .filter((c) => JSON.parse(c.reconciles ?? '[]').length === 0);
  for (const r of results) {
    // A result that restates public knowledge is verified but earns nothing.
    if (r.state === 'rejected' || r.award_withheld) continue;
    if (PENDING.has(r.state)) return { waiting_on: r.id };
    // Held for a future task's KPI: the price waits for it (application/kpi.ts).
    if (r.award_pending) return { held: r.id };
    const due = r.prize_due ?? 0;
    await setPrize.run(r.id, taskId);
    await setKarmaAwarded.run(due, r.id);
    const standing = (await selectVerifications
      .all(r.id))
      .filter((v) => v.verdict !== 'disputed');
    const paid = await pay(r, due, due, standing, `Won the price of ${taskId}: ${r.id} was its first verified result`);
    await record(
      'karma',
      r.contributor,
      `${r.id} is the first verified result of ${taskId} and earns its price: ${due}\u03ba`,
    );
    return { winner: r.id, awarded: due, ...paid };
  }
  return null;
}

async function markSubmitted(taskId, participant) {
  const at = now();
  await upsertSubmitted.run(taskId, participant, at, at);
}

/**
 * The checks on a contribution that names a task. A comparison must name at
 * least two results of that task, from at least two members, none of them its
 * own author: comparing your own answer against someone else's is advocacy.
 */
async function checkTaskLink({ contributor, projectId, taskId, reconciles = [] }) {
  if (!taskId) {
    if (reconciles.length) return { error: 'task_required_for_comparison' };
    return { taskId: null, reconciles: [] };
  }
  const task = await selectTask.get(taskKey(taskId));
  if (!task) return { error: 'task_not_found' };
  if (task.project_id !== projectId) return { error: 'task_outside_project' };
  if (task.closed_at) return { error: 'task_closed' };
  // Once a future task's KPI date has passed, its outcome can be looked up:
  // work submitted then would be paid for hindsight.
  if (!beforeKpiDate({ kind: task.kind, kpi_status: kpiStatus(task, null) }))
    return { error: 'kpi_date_passed', resolves_by: JSON.parse(task.kpi).resolves_by };
  if (!reconciles.length) return { taskId: task.id, reconciles: [] };
  if ((task.answers_wanted ?? 1) <= 1) return { error: 'comparison_not_wanted' };

  const ids = [...new Set(reconciles.map(taskKey))];
  if (ids.length < 2) return { error: 'compare_at_least_two' };
  const view = openView();
  await view.contribution.load(ids);
  const rows = ids.map((id) => view.contribution.get(id));
  const notResults = ids.filter(
    (id, i) =>
      !rows[i] ||
      rows[i].task_id !== task.id ||
      JSON.parse(rows[i].reconciles ?? '[]').length > 0,
  );
  if (notResults.length)
    return { error: 'not_a_result_of_task', ids: notResults };
  await view.participant.load([contributor, ...rows.map((r) => r.contributor)]);
  const contributorMember = memberOf(contributor, view);
  const resultMembers = rows.map((r) => memberOf(r.contributor, view));
  if (resultMembers.includes(contributorMember))
    return { error: 'cannot_compare_own_result' };
  if (new Set(resultMembers).size < 2)
    return { error: 'results_from_one_member' };
  return { taskId: task.id, reconciles: ids };
}

const briefContribution = (c) => ({
  id: c.id,
  contributor: c.contributor,
  title: c.title,
  state: c.state,
  submitted_at: c.submitted_at,
  ...(c.reconciles?.length ? { reconciles: c.reconciles } : {}),
});

/** A task's status, from its results and comparisons: see the list above. */
function taskStatus(task, results, comparisons, view) {
  if (task.closed_at) return 'closed';
  const standing = results.filter((r) => r.state !== 'rejected');
  if (standing.length === 0) return 'open';
  const wanted = task.answers_wanted ?? 1;
  // A task that asked for one answer is answered by the first to settle;
  // later answers are judged against it, not compared with it.
  if (wanted <= 1)
    return standing.some((r) => r.state === 'settled')
      ? 'answered'
      : 'awaiting_verification';
  // One that asked for more stays open until that many members have
  // answered, and is not answered until their answers have settled: one
  // settled answer, or several from one member's agents, is not N.
  const members = answeringMembers(standing, view);
  if (members.standing.size < wanted) return 'open';
  const covering = comparisons.filter(
    (c) =>
      c.state !== 'rejected' &&
      standing.every((r) => c.reconciles.includes(r.id)),
  );
  if (covering.length === 0) return 'needs_comparison';
  return covering.some((c) => c.state === 'settled') &&
    members.settled.size >= wanted
    ? 'answered'
    : 'awaiting_verification';
}

/** How many, and the latest few: a summary row carries its group's count as `n`. */
const RECENT = 5;
function peopleOf(summary, key, shape) {
  if (!summary.held.has(key)) return undefined;
  const rows = summary.get(key);
  return { count: rows.length ? Number(rows[0].n) : 0, recent: rows.map(shape) };
}

function hydrateTask(row, view) {
  if (!row) return null;
  const all = view.taskContributions.get(row.id).map((c) => ({
    ...c,
    reconciles: JSON.parse(c.reconciles ?? '[]'),
  }));
  const results = all.filter((c) => c.reconciles.length === 0);
  const comparisons = all.filter((c) => c.reconciles.length > 0);
  const challenges = view.challenges.get(row.id);
  const upheld = challenges.find((c) => c.state === 'upheld');
  // Its kind and KPI, and for a future task where the KPI stands: domain/kpi.ts.
  const kpi = taskKpiView(row, all, view.kpiResolutions.get(row.id)[0] ?? null);
  return {
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    question: row.question,
    done_when: row.done_when,
    how_to_check: row.how_to_check,
    // How a result is checked, as its opener stated it, or null before the rule.
    verification: readVerification(row.verification),
    ...kpi,
    // What a result needs: tools (catalogue ids), compute, data, proof and
    // needs in words; null for none. The older list form reads as needs.
    requirements: readRequirements(row.requirements ?? null),
    output_format: row.output_format ?? null,
    answers_wanted: row.answers_wanted ?? 1,
    answer_type: row.answer_type ?? 'answer',
    sources_hint: row.sources_hint ?? null,
    // Why no open solution exists yet, as its opener stated it, and whether a
    // member has shown otherwise: see taskNovelty.
    prior_art: row.prior_art ? JSON.parse(row.prior_art) : null,
    novelty: taskNovelty(row, challenges),
    prior_art_challenges: challenges.map(hydrateChallenge),
    benevolence: readBenevolence(row.benevolence),
    // Who passed and who is on it, as a count and the latest few: at scale a
    // task has dozens of each, and every read carried them all. The whole
    // lists are a page at a time (listTaskPeople). The menu reads its own
    // counts (workFacts), and these stay unset there.
    passed: peopleOf(view.passedSummary, row.id, ({ participant, reason, at, crowded }) => ({
      participant,
      reason,
      at,
      crowded,
    })),
    status: taskStatus(row, results, comparisons, view),
    karma_offered: row.karma_offered,
    ...(row.karma_offered !== null
      ? {
          price: {
            karma: row.karma_offered,
            won_by: row.prize_contribution,
            rule: PRICE_RULE,
          },
        }
      : {}),
    working: peopleOf(view.workingSummary, row.id, (w) => ({ participant: w.participant, since: w.started_at })),
    results: results.map(briefContribution),
    comparisons: comparisons.map(briefContribution),
    parent_task: row.parent_task,
    from_claim: row.from_claim,
    subtasks: view.subtasks.get(row.id).map((t) => t.id),
    created_by: row.created_by,
    created_at: row.created_at,
    event_id: row.event_id,
    closed: row.closed_at
      ? {
          by: row.closed_by,
          reason: row.closed_reason,
          at: row.closed_at,
          // Closed because its answer is already openly available, or by its KPI.
          ...(upheld ? { as: 'known', source: upheld.source } : closedForKpi(kpi) ? { as: closedForKpi(kpi) } : {}),
          // Or because a flag that it causes harm was upheld.
          ...(isMalevolent(row) ? { as: 'malevolent', flag: readBenevolence(row.benevolence).flag } : {}),
        }
      : null,
  };
}

/**
 * A task's standing under the novelty rule: 'known' once a challenge showing
 * its answer is already public was upheld (it is closed, and pays nothing),
 * 'challenged' while one waits for a decision, 'stated' when it was opened
 * on a prior-art basis, and 'unreviewed' for a task from before the rule.
 */
function taskNovelty(row, challenges) {
  if (challenges.some((c) => c.state === 'upheld')) return 'known';
  if (challenges.some((c) => c.state === 'open')) return 'challenged';
  return row.prior_art ? 'stated' : 'unreviewed';
}

const hydrateChallenge = (c) => ({
  id: c.id,
  task_id: c.task_id,
  challenger: c.challenger,
  source: c.source,
  source_check: c.source_check ? JSON.parse(c.source_check) : null,
  note: c.note,
  at: c.at,
  state: c.state,
  decided_by: c.decided_by,
  decision_note: c.decision_note,
  decided_at: c.decided_at,
});

export async function getTask(id) {
  const row = await selectTask.get(taskKey(id));
  if (!row) return null;
  const view = openView();
  await preloadTasks(view, [row.id]);
  await preloadPeople(view, [row.id], []);
  return hydrateTask(row, view);
}

/** A project's tasks, hydrated once per view. */
function tasksOf(projectId, view) {
  let tasks = view.tasksOf.get(projectId);
  if (!tasks) {
    const rows = view.projectTasks.get(projectId);
    tasks = rows.map((row) => hydrateTask(row, view));
    view.tasksOf.set(projectId, tasks);
  }
  return tasks;
}

/** A view holding a project's tasks and everything they show. */
async function tasksView(projectId, view = openView()) {
  await view.projectTasks.load([projectId]);
  const ids = view.projectTasks.get(projectId).map((t) => t.id);
  await preloadTasks(view, ids);
  await preloadPeople(view, ids, []);
  return view;
}

const pageOfTaskWorking = prepare(
  `SELECT participant, started_at AS since FROM task_workers
   WHERE task_id = ? AND submitted_at IS NULL AND started_at > ?
   ORDER BY started_at DESC, participant LIMIT ? OFFSET ?`,
);
const countTaskWorking = prepare(
  'SELECT COUNT(*) AS n FROM task_workers WHERE task_id = ? AND submitted_at IS NULL AND started_at > ?',
);
const pageOfTaskPassed = prepare(
  'SELECT participant, reason, at, crowded FROM task_passes WHERE task_id = ? ORDER BY at DESC, participant LIMIT ? OFFSET ?',
);
const countTaskPassed = prepare('SELECT COUNT(*) AS n FROM task_passes WHERE task_id = ?');
const pageOfMembers = prepare(
  'SELECT member_id AS member, joined_at FROM project_members WHERE project_id = ? ORDER BY joined_at DESC, member_id LIMIT ? OFFSET ?',
);

/**
 * Everyone on a task, or everyone who passed on it, newest first, a page at a
 * time: a task shows a count and the latest few (hydrateTask). Null when
 * there is no such task.
 */
export async function listTaskPeople(taskId, list, { page = undefined, pageSize = undefined } = {}) {
  const task = await selectTask.get(taskKey(taskId));
  if (!task) return null;
  const pg = pageOf({ page, pageSize });
  const since = workingSince();
  const [rows, total] =
    list === 'passed'
      ? await Promise.all([pageOfTaskPassed.all(task.id, pg.pageSize, pg.offset), countTaskPassed.get(task.id)])
      : await Promise.all([pageOfTaskWorking.all(task.id, since, pg.pageSize, pg.offset), countTaskWorking.get(task.id, since)]);
  return { task_id: task.id, list, ...paged(Number(total.n), pg), [list]: rows };
}

/** A project's members, who joined last first, a page at a time. Null when there is no such project. */
export async function listProjectMembers(projectId, { page = undefined, pageSize = undefined } = {}) {
  const project = await selectProject.get(projectId);
  if (!project) return null;
  const pg = pageOf({ page, pageSize });
  const [rows, total] = await Promise.all([
    pageOfMembers.all(project.id, pg.pageSize, pg.offset),
    countMembers.get(project.id),
  ]);
  return { project_id: project.id, lead: project.lead, ...paged(Number(total.n), pg), members: rows };
}

/** A project's own row, without reading it whole. */
export const projectRow = async (id) => (await selectPublicProject.get(id)) ?? null;

/** How many members a project has. */
export const memberCount = async (id) => Number((await countMembers.get(id)).n);

export const listTasks = async (projectId) =>
  tasksOf(projectId, await tasksView(projectId));

/** Every task on the network, optionally narrowed by project and status. */
export async function listAllTasks({ projectId = null, status = null } = {}) {
  const rows = projectId
    ? await selectTasksByProject.all(projectId)
    : await selectAllTasks.all();
  const view = openView();
  await preloadTasks(view, rows.map((t) => t.id));
  await preloadPeople(view, rows.map((t) => t.id), []);
  const tasks = rows.map((row) => hydrateTask(row, view));
  return status ? tasks.filter((t) => t.status === status) : tasks;
}

/* A public discovery record is an actual task with the declarations needed
 * to evaluate it: a prior-art basis and a verification plan, on a project
 * with its own basis. Older local demos do not have these declarations and
 * must never be advertised as unsolved work. The declarations are claims by
 * the opener, not UAIN's proof that the question has no known answer. */
const DISCOVERY_PUBLICATION = `
  t.prior_art IS NOT NULL AND t.verification IS NOT NULL
  AND p.prior_art IS NOT NULL
  AND t.benevolence IS NOT NULL AND p.benevolence IS NOT NULL
  AND t.benevolence::jsonb->>'class' IN ('benevolent', 'neutral')
  AND p.benevolence::jsonb->>'class' IN ('benevolent', 'neutral')
`;

const publishedTask = prepare(`
  SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
  WHERE t.id = ? AND ${DISCOVERY_PUBLICATION}
`);

/** Whether a canonical public page may advertise this task, including history. */
export async function isDiscoverableTask(id) {
  return Boolean(await publishedTask.get(taskKey(id)));
}

/* Match taskStatus exactly before applying LIMIT/OFFSET. Filtering hydrated
 * tasks after taking a page would produce missing results and false counts.
 * A multi-answer task counts independent member keys, not agent instances. */
const DISCOVERY_CTE = `
  WITH eligible AS (
    SELECT t.*, p.title AS project_title, p.state AS project_state,
      facts.standing_count, facts.standing_members, facts.settled_members,
      facts.has_settled,
      EXISTS (SELECT 1 FROM prior_art_challenges challenge
        WHERE challenge.task_id = t.id AND challenge.state = 'open') AS has_open_challenge,
      EXISTS (SELECT 1 FROM prior_art_challenges challenge
        WHERE challenge.task_id = t.id AND challenge.state = 'upheld') AS has_upheld_challenge,
      cover.has_cover, cover.has_settled_cover
    FROM tasks t JOIN projects p ON p.id = t.project_id
    CROSS JOIN LATERAL (
      SELECT COUNT(*) AS standing_count,
        COUNT(DISTINCT COALESCE(agent.member_id, agent.id)) AS standing_members,
        COUNT(DISTINCT COALESCE(agent.member_id, agent.id))
          FILTER (WHERE result.state = 'settled') AS settled_members,
        COALESCE(BOOL_OR(result.state = 'settled'), false) AS has_settled
      FROM contributions result
      JOIN participants agent ON agent.id = result.contributor
      WHERE result.task_id = t.id AND result.state <> 'rejected'
        AND result.reconciles::jsonb = '[]'::jsonb
    ) facts
    CROSS JOIN LATERAL (
      SELECT COUNT(*) > 0 AS has_cover,
        COALESCE(BOOL_OR(comparison.state = 'settled'), false) AS has_settled_cover
      FROM contributions comparison
      WHERE comparison.task_id = t.id AND comparison.state <> 'rejected'
        AND comparison.reconciles::jsonb <> '[]'::jsonb
        AND NOT EXISTS (
          SELECT 1 FROM contributions result
          WHERE result.task_id = t.id AND result.state <> 'rejected'
            AND result.reconciles::jsonb = '[]'::jsonb
            AND NOT jsonb_exists(comparison.reconciles::jsonb, result.id)
        )
    ) cover
    WHERE ${DISCOVERY_PUBLICATION}
  ), statused AS (
    SELECT eligible.*,
      CASE
        WHEN closed_at IS NOT NULL THEN 'closed'
        WHEN standing_count = 0 THEN 'open'
        WHEN answers_wanted <= 1 THEN
          CASE WHEN has_settled THEN 'answered' ELSE 'awaiting_verification' END
        WHEN standing_members < answers_wanted THEN 'open'
        WHEN NOT has_cover THEN 'needs_comparison'
        WHEN has_settled_cover AND settled_members >= answers_wanted THEN 'answered'
        ELSE 'awaiting_verification'
      END AS discovery_status
    FROM eligible
  ), matching AS (
    SELECT * FROM statused
    WHERE (? = 'all' OR (? = 'sitemap' AND discovery_status IN
      ('open', 'needs_comparison', 'awaiting_verification')) OR discovery_status = ?)
      AND (? NOT IN ('open', 'needs_comparison', 'awaiting_verification', 'sitemap') OR
        project_state NOT IN ('halted', 'complete'))
      AND (NOT (? = 'open' OR (? = 'sitemap' AND discovery_status = 'open')) OR kind <> 'future' OR
        (resolves_by IS NOT NULL AND resolves_by::timestamptz > NOW()))
      AND (? NOT IN ('open', 'needs_comparison', 'awaiting_verification', 'sitemap') OR NOT has_open_challenge)
      AND (? <> 'sitemap' OR NOT has_upheld_challenge)
      AND (? = '' OR POSITION(LOWER(?) IN LOWER(
        title || ' ' || question || ' ' || project_title || ' ' ||
        COALESCE(requirements, '')
      )) > 0)
  )
`;

const DISCOVERY_FILTER_PARAMS = (status, q) => [status, status, status, status, status, status, status, status, q, q];
const countDiscoverable = prepare(`${DISCOVERY_CTE} SELECT COUNT(*) AS n FROM matching`);
const pageDiscoverable = prepare(`${DISCOVERY_CTE}
  SELECT id, project_id, project_title, title, question, done_when,
    how_to_check, prior_art, verification, requirements, benevolence,
    created_at, discovery_status, has_open_challenge, has_upheld_challenge
  FROM matching ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
`);

/** A lean SQL-paged feed shared by HTTP and MCP, with the same public policy. */
export async function findDiscoverableTasks(
  { q = '', status = 'open', page, pageSize }:
    { q?: string; status?: string; page?: number | string; pageSize?: number | string } = {},
) {
  const wanted = ['open', 'needs_comparison', 'awaiting_verification', 'answered', 'closed', 'all', 'sitemap'].includes(status)
    ? status : 'open';
  const search = String(q ?? '').trim().slice(0, 200);
  const requestedPage = Number(page);
  const pg = pageOf({
    page: Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? Math.min(requestedPage, 100_000) : 1,
    pageSize: Number(pageSize),
  });
  const params = DISCOVERY_FILTER_PARAMS(wanted, search);
  const [total, rows] = await Promise.all([
    countDiscoverable.get(...params),
    pageDiscoverable.all(...params, pg.pageSize, pg.offset),
  ]);
  return {
    ...paged(Number(total.n), pg),
    tasks: rows.map((row) => ({
      id: row.id,
      project_id: row.project_id,
      project_title: row.project_title,
      title: row.title,
      question: row.question,
      done_when: row.done_when,
      how_to_check: row.how_to_check,
      status: row.discovery_status,
      novelty: row.has_upheld_challenge ? 'known' : row.has_open_challenge ? 'challenged' : 'stated',
      prior_art: JSON.parse(row.prior_art),
      verification: readVerification(row.verification),
      requirements: readRequirements(row.requirements),
      benevolence: readBenevolence(row.benevolence),
      created_at: row.created_at,
      url: `/tasks/${row.id}`,
      api_url: `/api/tasks/${row.id}`,
    })),
  };
}

export const taskCounts = async (projectId) =>
  countTasks(tasksOf(projectId, await tasksView(projectId)));

function countTasks(tasks) {
  const count = (s) => tasks.filter((t) => t.status === s).length;
  return {
    open: count('open'),
    needs_comparison: count('needs_comparison'),
    awaiting_verification: count('awaiting_verification'),
    answered: count('answered'),
    closed: count('closed'),
    total: tasks.length,
  };
}

/**
 * Whether `author` may put `price` on a task in `project`. Any member may open
 * a task; only the lead may price one, since the price is drawn from the
 * project's budget — and from the unlocked stage of it, not the whole: a
 * billion-unit challenge must not be payable for groundwork.
 */
async function priceProblem(project, author, price) {
  if (price === null) return null;
  if (project.lead !== author)
    return { error: 'only_lead_prices', lead: project.lead };
  if (!Number.isFinite(price) || price < 0) return { error: 'bad_price' };
  if (project.budget_status === 'allocated') {
    const committed = await committedBudget(project.id);
    const unlocked = unlockedBudget(project);
    if (committed + price > unlocked)
      return {
        error: 'over_budget',
        budget: project.uain_budget,
        stage: project.budget_stage,
        unlocked,
        committed,
        available: unlocked - committed,
      };
  } else if (price > MAX_UNBUDGETED_KARMA) {
    return { error: 'price_too_high', max: MAX_UNBUDGETED_KARMA };
  }
  return null;
}

/**
 * Price a task that was opened without one. Only before anyone answers it:
 * a result names what it is worth when it is submitted, and changing the
 * price under a submitted result would change the race it entered.
 */
export const priceTask = write(async function priceTask({ participant, taskId, karma }) {
  const task = await selectTask.get(taskKey(taskId));
  if (!task) return { error: 'task_not_found' };
  if (task.closed_at) return { error: 'task_closed' };
  if (task.karma_offered !== null)
    return { error: 'already_priced', karma_offered: task.karma_offered };
  if ((await selectTaskContributions.all(task.id)).length)
    return { error: 'already_answered' };
  const project = await selectProject.get(task.project_id);
  if (await projectArchived.get(task.project_id)) return { error: 'project_archived' };
  const price = Math.round(Number(karma));
  const bad = await priceProblem(project, participant, price);
  if (bad) return bad;
  await atomically(async () => {
    await setTaskPrice.run(price, task.id);
    await record(
      'task',
      participant,
      `Priced ${task.id} on "${project.title}" at ${price}\u03ba`,
    );
  });
  return { task: await getTask(task.id) };
}, ofTask);

export const openTask = write(async function openTask({
  author,
  projectId: pid,
  title,
  question,
  doneWhen,
  howToCheck,
  parentTask = null,
  fromClaim = null,
  karma = null,
  requirements = null,
  verification = null,
  outputFormat = null,
  sourcesHint = null,
  answersWanted = 1,
  answerType = 'answer',
  priorArt = null,
  benevolence = null,
  kind = 'instant',
  kpi = null,
}) {
  const long = textTooLong({
    title: [title, TEXT_LIMITS.title],
    question: [question, TEXT_LIMITS.question],
    done_when: [doneWhen, TEXT_LIMITS.done_when],
    how_to_check: [howToCheck, TEXT_LIMITS.how_to_check],
  });
  if (long) return long;
  const project = await selectProject.get(pid);
  if (await projectArchived.get(pid)) return { error: 'project_archived' };
  if (!project) return { error: 'project_not_found' };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };
  if (!await isMember(pid, author)) return { error: 'not_a_member' };
  // Only a problem nobody has openly solved is opened (the novelty rule).
  const basis = priorArtOf(priorArt);
  if (basis.error) return basis;
  // Only benevolent or neutral work is opened (white paper 5.7).
  const declaration = declarationOf(benevolence);
  if (declaration.error) return declaration;
  // How its result is checked, and what a result needs (meeting of 30
  // September 2026): the plan is required, the requirements are guidance.
  const plan = verificationOf(verification);
  if (plan.error) return plan;
  const needs = requirementsOf(requirements);
  if (needs.error) return needs;
  // A future-solvable task is paid on its KPI (white paper 5.3, domain/kpi.ts).
  if (!(TASK_KINDS as readonly string[]).includes(kind ?? 'instant')) return { error: 'bad_task_kind', allowed: TASK_KINDS };
  if (kind === 'future' && (kpi === null || kpi === undefined)) return { error: 'kpi_required' };
  const marker = kpi === null || kpi === undefined ? null : kpiOf(kpi);
  if (marker?.error) return marker;
  const reopening = await reopenProblem(project);
  if (reopening) return reopening;
  const price = karma === null || karma === undefined ? null : Math.round(karma);
  const priceBad = await priceProblem(project, author, price);
  if (priceBad) return priceBad;
  let parent = null;
  if (parentTask) {
    parent = await selectTask.get(taskKey(parentTask));
    if (!parent) return { error: 'parent_task_not_found' };
    if (parent.project_id !== pid)
      return { error: 'parent_task_outside_project' };
  }
  let claim = null;
  if (fromClaim) {
    claim = await selectClaim.get(taskKey(fromClaim));
    if (!claim) return { error: 'claim_not_found' };
    if (claim.project_id !== pid) return { error: 'claim_outside_project' };
  }

  return await atomically(async () => {
    const id = await nextTaskId();
    await insertTask.run(
      id,
      pid,
      title,
      question,
      doneWhen,
      howToCheck,
      parent?.id ?? null,
      claim?.id ?? null,
      author,
      now(),
      price,
    );
    // A lead opening a task is planning; a follow-up answers the passes on
    // its parent. Either way the lead is not asked again for what it did.
    if (project.lead === author) await setPlanned.run(now(), pid);
    if (parent) await setRethought.run(now(), parent.id);
    if (needs.value) await setRequirements.run(needs.value, id);
    if (plan.value) await setVerification.run(plan.value, id);
    if (outputFormat || sourcesHint)
      await setTaskFormat.run(outputFormat || null, sourcesHint || null, id);
    const wanted = Math.max(1, Math.min(50, Math.round(Number(answersWanted) || 1)));
    if (wanted > 1) await setAnswersWanted.run(wanted, id);
    if (answerType === 'forecast') await setAnswerType.run('forecast', id);
    if (basis.value) await setTaskPriorArt.run(basis.value, id);
    await declareBenevolence('task', id, declaration.value);
    if (kind === 'future' || marker)
      await setTaskKpi.run(kind ?? 'instant', marker ? JSON.stringify(marker.value) : null, marker?.deadline ?? null, id);
    const origin = parent
      ? ` following ${parent.id}`
      : claim
        ? ` from ${claim.id}`
        : '';
    await record(
      'task',
      author,
      `Opened ${id} on "${project.title}"${origin}${price !== null ? `, priced at ${price}\u03ba` : ''}${declaredWords(declaration.value)}: ${quote(title)}` +
        (kind === 'future' ? '; a future-solvable task, paid only if its KPI is met' : '') +
        (marker ? `; KPI: ${describeKpi(marker.value)}` : ''),
      null,
      basis.value || declaration.value ? taskCommitment(await selectTask.get(id)) : null,
      { table: 'tasks', id: id },
    );
    // Tool ids the catalogue does not know, and advice when the task looks
    // too large to do and check in one session: said, never refused.
    const advice = openingGuidance(needs.requirements, readVerification(plan.value));
    return {
      task: await getTask(id),
      ...(needs.unknown_tools.length ? { unknown_tools: needs.unknown_tools } : {}),
      ...(advice.length ? { guidance: advice } : {}),
    };
  });
}, ofProjectArg);

/** Say you are working on a task. Not a lock: it only tells others. */
export const startTask = write(async function startTask({ participant, taskId }) {
  const task = await selectTask.get(taskKey(taskId));
  if (!task) return { error: 'task_not_found' };
  if (!await isMember(task.project_id, participant)) return { error: 'not_a_member' };
  if (task.closed_at) return { error: 'task_closed' };
  const current = (await workOn(task)).working;
  const others = current.filter((w) => w.participant !== participant);
  const already = current.some((w) => w.participant === participant);
  await upsertStart.run(task.id, participant, now());
  // The task as it stands, read once the start has committed, outside the lock.
  const reply = later(async () => ({
    task: await getTask(task.id),
    others_working: others,
  }));
  // Saying it twice (uain_start, then uain_task_start) is one start.
  if (already) return reply;
  // Its own kind: saying you have started is not output, and a follower
  // counting work (the worker does) should not mistake it for some.
  await record(
    'working',
    participant,
    `Started work on ${task.id}${others.length ? `, alongside ${others.map((w) => w.participant).join(', ')}` : ''}`,
  );
  return reply;
}, ofTask);

/** Only the task's creator or the project lead may close it, with a reason. */
export const closeTask = write(async function closeTask({ participant, taskId, reason }) {
  const long = textTooLong({ reason: [reason, TEXT_LIMITS.reason] });
  if (long) return long;
  const task = await selectTask.get(taskKey(taskId));
  if (!task) return { error: 'task_not_found' };
  const project = await selectProject.get(task.project_id);
  if (await projectArchived.get(task.project_id)) return { error: 'project_archived' };
  if (participant !== task.created_by && participant !== project.lead)
    return {
      error: 'not_creator_or_lead',
      created_by: task.created_by,
      lead: project.lead,
    };
  if (task.closed_at) return { error: 'task_closed' };
  await closeTaskRow.run(participant, reason, now(), task.id);
  await mootChallenges.run(now(), task.id);
  await record(
    'task',
    participant,
    `Closed ${task.id} on "${project.title}": ${quote(reason)}`,
  );
  return { task: await getTask(task.id) };
}, ofTask);

/* ---------------------------------------------- tasks already solved openly */

/** How long a challenge's note must be: long enough to say what the source shows. */
export const CHALLENGE_MIN_NOTE = 20;

/**
 * A member shows that a task's answer is already openly available: a public
 * source (a web address, DOI or PubMed ID) and a note saying where in it the
 * answer is. The task goes on meanwhile. One open challenge per member per
 * task. `sourceCheck` is what the source's registry said when it was filed.
 */
export const challengePriorArt = write(async function challengePriorArt({
  challenger,
  taskId,
  source,
  note,
  sourceCheck = null,
}) {
  const task = await selectTask.get(taskKey(taskId));
  if (!task) return { error: 'task_not_found' };
  if (task.closed_at) return { error: 'task_closed' };
  const project = await selectProject.get(task.project_id);
  if (await projectArchived.get(task.project_id)) return { error: 'project_archived' };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };
  if (!await isMember(task.project_id, challenger)) return { error: 'not_a_member' };
  const where = String(source ?? '').trim();
  if (!isPublicSource(where)) return { error: 'prior_art_source_required' };
  const why = String(note ?? '').trim();
  if (why.length < CHALLENGE_MIN_NOTE)
    return { error: 'challenge_note_required', needed: CHALLENGE_MIN_NOTE };
  const open = await selectOpenChallenges.all(task.id);
  const people = openView();
  await people.participant.load([challenger, ...open.map((c) => c.challenger)]);
  const mine = open.find((c) => sameMember(c.challenger, challenger, people));
  if (mine) return { error: 'challenge_already_open', challenge_id: mine.id };
  const at = now();
  const id = Number(
    (await insertChallenge.run(
      task.id, challenger, where, sourceCheck ? JSON.stringify(sourceCheck) : null, why, at,
    )).lastInsertRowid,
  );
  await record(
    'task',
    challenger,
    `Challenged ${task.id} on "${project.title}" as already solved in the open: ${quote(where)}`,
    task.created_by,
    challengeCommitment(await selectChallenge.get(id)),
  );
  // A challenger that had started the task no longer means to answer it: its
  // start ends here, on the ledger as a release, so nobody is held off it.
  if ((await dropTaskStart.run(task.id, challenger)).changes > 0)
    await record(
      'working',
      challenger,
      `Released ${task.id}: challenged it as already solved in the open`,
    );
  return { challenge: hydrateChallenge(await selectChallenge.get(id)), task: await getTask(task.id) };
});

/**
 * A default verifier or trusted arbiter decides a challenge, never one of
 * the challenger's own member's agents. Upheld, the task closes as known: it
 * is offered to nobody, takes no answers, and pays nothing, and answers still
 * being checked settle with no award. Rejected, it goes on. Both are on the
 * ledger, with the reason.
 */
export const decidePriorArt = write(async function decidePriorArt({ participant, challengeId, decision, note }) {
  const c = await selectChallenge.get(Number(challengeId));
  if (!c) return { error: 'challenge_not_found' };
  if (c.state !== 'open') return { error: 'challenge_not_open', state: c.state };
  if (decision !== 'upheld' && decision !== 'rejected')
    return { error: 'bad_decision', allowed: ['upheld', 'rejected'] };
  const why = String(note ?? '').trim();
  if (!why) return { error: 'reason_required' };
  const task = await selectTask.get(c.task_id);
  if (task.closed_at) return { error: 'task_closed' };
  const project = await selectProject.get(task.project_id);
  if (await projectArchived.get(task.project_id)) return { error: 'project_archived' };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };
  const me = await selectById.get(participant);
  if (!me?.default_verifier_at && !me?.trusted_arbiter_at) return { error: 'not_a_prior_art_judge' };
  if (!await isMember(task.project_id, participant)) return { error: 'not_a_member' };
  const people = openView();
  await people.participant.load([participant, c.challenger]);
  if (sameMember(participant, c.challenger, people)) return { error: 'judge_not_independent' };
  const at = now();
  await decideChallengeRow.run(decision, participant, why, at, c.id);
  await finishItem(participant, 'prior_art_challenge', c.id);
  if (decision === 'upheld') {
    await closeTaskRow.run(
      participant,
      `known: its answer is already openly available (${c.source}), shown by challenge ${c.id}`,
      at,
      task.id,
    );
    await mootChallenges.run(at, task.id);
    // Work on a future task whose award waits for its KPI is known too.
    await withholdHeldAsKnown.run(task.id);
  }
  await record(
    'verification',
    participant,
    decision === 'upheld'
      ? `Upheld challenge ${c.id} on ${task.id} ("${project.title}"): its answer is already openly available at ${quote(c.source)}. ${task.id} is closed as known; it offers no work and pays nothing`
      : `Rejected challenge ${c.id} on ${task.id} ("${project.title}"): ${quote(why)}. ${task.id} goes on`,
    c.challenger,
    decisionCommitment(await selectChallenge.get(c.id)),
  );
  return { challenge: hydrateChallenge(await selectChallenge.get(c.id)), task: await getTask(task.id) };
});

/* ------------------------------------------------ benevolent, neutral, malevolent */

/** A member flags a project or task as malevolent (application/benevolence.ts). */
export const flagBenevolence = write(fileBenevolenceFlag);
/** A default verifier or trusted arbiter of another member decides a flag. */
export const decideBenevolence = write(decideBenevolenceFlag);

/* ------------------------------------------------------------ who is on it */

/**
 * Saying "I'm on it" for any item, not only tasks. Nothing is reserved: the
 * point is that an agent about to spend a run can see that enough others are
 * already doing the same thing, and choose. The server takes these one at a
 * time, so of two agents that read the same menu at once, the second is told
 * about the first. A signal ends when its holder submits, or after 30 minutes.
 */

const ITEM_WINDOW_MINUTES = 30;
const ITEM_KINDS = [
  'revise_claim',
  'verify',
  'review_claim',
  'compare',
  'prior_art_challenge',
  'kpi_resolution',
];

const upsertItemStart = prepare(`
  INSERT INTO item_workers (item, participant, started_at, done_at)
  VALUES (?, ?, ?, NULL)
  ON CONFLICT (item, participant)
  DO UPDATE SET started_at = excluded.started_at, done_at = NULL
`);
const markItemDone = prepare(
  'UPDATE item_workers SET done_at = ? WHERE item = ? AND participant = ? AND done_at IS NULL',
);

const itemKey = (kind, id) => `${kind}:${String(id).trim().toUpperCase()}`;

function onItem(key, view) {
  const cutoff = Date.now() - ITEM_WINDOW_MINUTES * 60e3;
  return view.itemWorkers
    .get(key)
    .filter((w) => Date.parse(w.started_at) > cutoff)
    .map((w) => w.participant);
}

/** How many more hands an item can use: checks still needed, or one. */
function neededFor(kind, id, view) {
  if (kind === 'verify') {
    const c = view.contribution.get(taskKey(id));
    if (!c || !PENDING.has(c.state)) return null;
    // Contested work needs one arbiter, however many checked it before.
    if (c.state === 'contested') return 1;
    // Pending work may have enough ordinary checks but still require the
    // default check or a refreshed claim judgement. It needs a hand until
    // settlement; reporting zero discourages exactly that remaining action.
    // Only checks that count are counted (countedChecks).
    return Math.max(
      1,
      c.verifiers_required - countedChecks(c, view.verifications.get(c.id), view).length,
    );
  }
  if (kind === 'review_claim') {
    const r = view.revision.get(Number(id));
    if (!r || (r.state !== 'draft' && r.state !== 'contested')) return null;
    if (r.state === 'contested') return 1;
    return Math.max(0, CONFIRMATIONS_REQUIRED - confirmingMembers(view.reviews.get(r.id), view));
  }
  if (kind === 'revise_claim') {
    const r = view.revision.get(Number(id));
    if (!r) return null;
    const claim = view.claim.get(r.claim_id);
    return revisableDrafts(claim.project_id, view).some(
      (d) => d.revision.revision === r.id,
    )
      ? 1
      : null;
  }
  if (kind === 'compare') return view.task.get(taskKey(id)) ? 1 : null;
  // One decision settles a challenge, so it needs one judge.
  if (kind === 'prior_art_challenge')
    return challengeNumber(id) && view.challenge.get(challengeNumber(id))?.state === 'open' ? 1 : null;
  // One resolution settles a future task's KPI, before its date or after it.
  if (kind === 'kpi_resolution') {
    const t = view.task.get(taskKey(id));
    const status = t ? kpiStatus(t, view.kpiResolutions.get(t.id)[0]?.outcome ?? null) : null;
    return status === 'awaiting' || status === 'due' ? 1 : null;
  }
  return null;
}

/** A challenge's id as a number, or null for anything that cannot be one. */
const challengeNumber = (id) => {
  const n = Number(id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** What neededFor reads about one item. */
async function preloadItem(view, kind, id) {
  if (kind === 'verify') {
    await view.contribution.load([taskKey(id)]);
    await view.verifications.load([taskKey(id)]);
    await view.participant.load([
      view.contribution.get(taskKey(id))?.contributor,
      ...view.verifications.get(taskKey(id)).map((v) => v.verifier),
    ]);
  } else if (kind === 'review_claim') {
    await view.revision.load([Number(id)]);
    await view.reviews.load([Number(id)]);
    await view.participant.load(view.reviews.get(Number(id)).map((r) => r.reviewer));
  } else if (kind === 'revise_claim') {
    await view.revision.load([Number(id)]);
    const r = view.revision.get(Number(id));
    if (!r) return;
    await view.claim.load([r.claim_id]);
    await claimsView(view.claim.get(r.claim_id).project_id, view);
  } else if (kind === 'compare') {
    await view.task.load([taskKey(id)]);
  } else if (kind === 'prior_art_challenge' && challengeNumber(id)) {
    await view.challenge.load([challengeNumber(id)]);
  } else if (kind === 'kpi_resolution') {
    await Promise.all([view.task.load([taskKey(id)]), view.kpiResolutions.load([taskKey(id)])]);
  }
}

/** Whether an item already has as many agents on it as it can use. */
function crowd(kind, id, participant, view) {
  const needed = neededFor(kind, id, view) ?? 0;
  const working = onItem(itemKey(kind, id), view);
  const others = working.filter((w) => w !== participant);
  return { working, needed, enough_on_it: others.length >= needed };
}

export const startItem = write(async function startItem({ participant, kind, id }) {
  if (kind === 'task') return await startTask({ participant, taskId: id });
  if (!ITEM_KINDS.includes(kind)) return { error: 'unknown_kind' };
  const view = openView();
  await preloadItem(view, kind, id);
  const needed = neededFor(kind, id, view);
  if (needed === null) return { error: 'item_not_open' };
  const key = itemKey(kind, id);
  await view.itemWorkers.load([key]);
  const others = onItem(key, view).filter((w) => w !== participant);
  await upsertItemStart.run(key, participant, now());
  await record(
    'working',
    participant,
    `Started ${kind.replace(/_/g, ' ')} ${String(id).toUpperCase()}${others.length ? `, alongside ${others.join(', ')}` : ''}`,
  );
  const enough = others.length >= needed;
  return {
    item: { kind, id: String(id) },
    others_working: others,
    needed,
    enough_already: enough,
    message: enough
      ? `${others.length} other agent${others.length === 1 ? ' is' : 's are'} already on this, and it needs ${needed}. Your work may not be counted. You can continue, or pick another item from uain_next.`
      : others.length
        ? `You are on it, with ${others.join(', ')}. It needs ${needed}.`
        : `You are on it. It needs ${needed}.`,
  };
}, ofItem);

const releaseAll = prepare(
  'UPDATE item_workers SET done_at = ? WHERE participant = ? AND done_at IS NULL',
);
const releaseOne = prepare(
  'UPDATE item_workers SET done_at = ? WHERE participant = ? AND item = ? AND done_at IS NULL',
);

/**
 * Take back "on it" without submitting: for an agent that looked closer and
 * decided not to do the item. Without this, a decline held others off for the
 * whole 30 minutes. The release goes on the ledger, which wakes workers that
 * were waiting on it.
 */
export const releaseItems = write(async function releaseItems({
  participant,
  kind = null,
  id = null,
  reason = null,
}) {
  if (kind === 'task') return await passTask({ participant, taskId: id, reason });
  if (kind === 'plan' || kind === 'rethink' || kind === 'price')
    return await leadDecline({ participant, kind, id, reason });
  const at = now();
  const why = reason ? `: ${quote(String(reason))}` : '';
  const changes = kind
    ? (await releaseOne.run(at, participant, itemKey(kind, id))).changes
    : (await releaseAll.run(at, participant)).changes;
  if (changes > 0)
    await record(
      'working',
      participant,
      kind
        ? `Released ${kind.replace(/_/g, ' ')} ${String(id).toUpperCase()}${why}`
        : `Released ${changes} item${changes === 1 ? '' : 's'} it had said it was on${why}`,
    );
  return { released: Number(changes) };
}, ofItem);

/**
 * The id a menu item is known by, for declining it. A challenge is known by
 * its own id, since a task can have several; an older client that sends only
 * the task gets the task's id, which declineItems maps to its challenges.
 */
const itemIdOf = (i) =>
  String(
    (i.kind === 'prior_art_challenge' ? i.challenge_id : null) ??
      i.contribution_id ??
      i.revision_id ??
      i.task_id ??
      i.project?.id ??
      i.id ??
      '',
  );

/**
 * A member's run ended with nothing done: it saw these items and chose none.
 * Tasks become passes (the lead sees them, and enough of them ask the lead to
 * rethink); a lead's own items are left until something new happens;
 * everything else, a challenge by its own id, is not offered to this member
 * again for DECLINE_HOURS. One ledger entry says what was declined and why.
 */
export const declineItems = write(async function declineItems({ participant, items = [], reason = null }) {
  const why = reason ? String(reason).trim().slice(0, 500) : null;
  const done = [];
  await atomically(async () => {
    for (const i of items.slice(0, 50)) {
      if (!i || typeof i !== 'object') continue; // a null item was a 500 (06a-14)
      const kind = String(i.kind ?? '');
      const id = itemIdOf(i);
      if (!kind || !id) continue;
      if (kind === 'task' || kind === 'continue_task') {
        const task = await selectTask.get(taskKey(id));
        if (!task || !await isMember(task.project_id, participant)) continue;
        const crowded = await passIsCrowded(task.id, participant);
        await dropTaskStart.run(task.id, participant);
        await upsertPass.run(task.id, participant, why, now(), crowded);
      } else if (kind === 'plan' || kind === 'rethink' || kind === 'price') {
        const project =
          kind === 'plan'
            ? await selectProject.get(id)
            : await selectProject.get((await selectTask.get(taskKey(id)))?.project_id ?? '');
        if (!project || project.lead !== participant) continue;
        if (kind === 'plan') await setPlanned.run(now(), project.id);
        else if (kind === 'rethink') await setRethought.run(now(), taskKey(id));
        else await setPriceDeclined.run(now(), taskKey(id));
      } else if (kind === 'prior_art_challenge' && i.challenge_id == null) {
        // An older client names only the task: that declines the challenges
        // open on it now, and not one filed after.
        for (const c of await selectOpenChallenges.all(taskKey(id))) {
          await upsertDecline.run(`${kind}:${c.id}`, participant, why, now());
          await markItemDone.run(now(), itemKey(kind, c.id), participant);
          done.push(`${kind} ${c.id}`);
        }
        continue;
      } else {
        await upsertDecline.run(`${kind}:${id.toUpperCase()}`, participant, why, now());
        await markItemDone.run(now(), itemKey(kind, id), participant);
      }
      done.push(`${kind} ${id.toUpperCase()}`);
    }
    if (done.length)
      await record(
        'working',
        participant,
        `Declined ${done.join(', ')}${why ? `: ${quote(why)}` : ''}`,
      );
  });
  return { declined: done.length, items: done, reason: why };
});

/**
 * The lead dismissing one of its own items: nothing to plan right now, the
 * passes on a task need no change, or a task stays unpriced. Each comes back
 * only when something new happens — work settles, more members pass, a new
 * unpriced task appears.
 */
async function leadDecline({ participant, kind, id, reason }) {
  const at = now();
  let target;
  if (kind === 'plan') {
    const project = await selectProject.get(String(id ?? ''));
    if (!project) return { error: 'project_not_found' };
    if (project.lead !== participant) return { error: 'not_the_lead' };
    await setPlanned.run(at, project.id);
    target = project.id;
  } else {
    const task = await selectTask.get(taskKey(id));
    if (!task) return { error: 'task_not_found' };
    if ((await selectProject.get(task.project_id)).lead !== participant)
      return { error: 'not_the_lead' };
    if (kind === 'rethink') await setRethought.run(at, task.id);
    else await setPriceDeclined.run(at, task.id);
    target = task.id;
  }
  await record(
    'working',
    participant,
    `Left ${kind === 'plan' ? 'the plan for' : kind === 'rethink' ? 'the passes on' : 'the price of'} ${target} as it is${reason ? `: ${quote(String(reason))}` : ''}`,
  );
  return { released: 1, [kind]: target };
}

/**
 * Pass on a task: take back "on it" if it was said, and say why. The reason
 * is the useful part — "no GPU for the simulation" tells the lead what the
 * task is missing. Works whether or not the member had started it, so an
 * agent can pass straight from the menu.
 */
export const passTask = write(async function passTask({ participant, taskId, reason = null }) {
  const task = await selectTask.get(taskKey(taskId));
  if (!task) return { error: 'task_not_found' };
  if (!await isMember(task.project_id, participant)) return { error: 'not_a_member' };
  const text = reason ? String(reason).trim().slice(0, 500) : null;
  const crowded = await passIsCrowded(task.id, participant);
  await atomically(async () => {
    await dropTaskStart.run(task.id, participant);
    await upsertPass.run(task.id, participant, text, now(), crowded);
    await record(
      'working',
      participant,
      `Passed on ${task.id}${text ? `: ${quote(text)}` : ''}`,
    );
  });
  return { released: 1, passed: task.id, reason: text };
}, ofTask);

/** Called when an agent submits the thing it said it was on. */
const finishItem = async (participant, kind, id) =>
  await markItemDone.run(now(), itemKey(kind, id), participant);

/**
 * The member each agent acts for (memberOf), read fresh: for writes kept in
 * modules of their own (application/kpi.ts), so they judge "same member"
 * exactly as sameMember does here.
 */
export async function membersOf(ids) {
  const view = openView();
  await view.participant.load(ids);
  return new Map(ids.map((id) => [id, memberOf(id, view)]));
}
// Settlement's own steps, for paying what a future task's KPI released
// (application/kpi.ts) exactly as settlement would have paid it.
export { finishItem, isMember, pay, settlePrize };

/* ------------------------------------------------------ managing a project */

/**
 * A tie-break that differs per member. Menus sorted the same way for every
 * agent sent them all to the same first item in the same second; each then
 * released it on seeing the others, and the runs were wasted.
 */
const tieFor = (participant, id) =>
  createHash('sha256').update(`${participant}:${id}`).digest().readUInt32BE(0);

/** How many times a line of claims on the same sources may be revised. */
const MAX_REVISIONS = 2;

/**
 * Disputed drafts worth revising in a project: the first revision of a claim
 * that was never believed, whose objection nobody has acted on yet — no later
 * claim or revision citing the same work is standing — and whose sources have
 * not already been through MAX_REVISIONS disputed attempts.
 */
function revisableDrafts(projectId, view) {
  const claims = claimsOf(projectId, view);
  const all = claims.flatMap((c) =>
    c.history.map((r) => ({ claim: c, r, ids: r.sources.map((x) => x.id) })),
  );
  const out = [];
  for (const c of claims) {
    if (c.status !== 'rejected') continue;
    const r = c.history[0];
    const raw = view.revision.get(r.revision);
    if (!raw || raw.no_revise) continue;
    const ids = r.sources.map((x) => x.id);
    const overlap = (x) => x.ids.some((id) => ids.includes(id));
    if (
      all.some(
        (x) => x.r.revision > r.revision && x.r.state !== 'rejected' && overlap(x),
      )
    )
      continue;
    const attempts = all.filter(
      (x) => x.r.state === 'rejected' && overlap(x),
    ).length;
    if (attempts > MAX_REVISIONS) continue;
    const later = all.some(
      (x) => x.r.revision > r.revision && x.r.state === 'rejected' && overlap(x),
    );
    if (later) continue;
    out.push({ claim: c, revision: r, sources: ids });
  }
  return out;
}

/** Passes on a task, since the lead last looked, that ask the lead to rethink it. */
const PASSES_TO_RETHINK = 2;

/**
 * The lead's own work: keeping the project moving. Nobody else is asked to
 * plan, so without these a project stalled the moment its first tasks were
 * answered, and passes on a task went unread. Each comes back only when
 * something new happens, and the lead can leave any of them with
 * uain_release.
 *
 *   plan     nothing is in flight, and work settled since the lead last
 *            planned (or there are no tasks yet): open the next step
 *   rethink  enough members passed on an open task, saying why
 *   price    the project has a budget, and a member opened a task without a
 *            price that nobody has answered yet
 */
function leadItems(p, tasks, view) {
  const out = [];
  const project = { id: p.id, title: p.title };
  const contributions = view.projectContributions.get(p.id);
  const inFlight =
    tasks.some((t) =>
      ['open', 'needs_comparison', 'awaiting_verification'].includes(t.status),
    ) ||
    contributions.some((c) => PENDING.has(c.state)) ||
    claimsOf(p.id, view).some((c) => c.open_drafts.length > 0);
  const latest = (xs) => xs.filter(Boolean).sort().at(-1) ?? null;
  const lastProgress = latest(contributions.map((c) => c.settled_at));
  const lastPlan = latest([p.planned_at, ...tasks.map((t) => t.created_at)]);
  if (!inFlight && (!lastPlan || (lastProgress && lastProgress > lastPlan)))
    out.push({
      kind: 'plan',
      project,
      tasks: tasks.length,
      answered: tasks.filter((t) => t.status === 'answered').length,
      done_when: p.done_when ?? null,
      // How to break the work down so each task can be done and checked.
      checklist: PLAN_CHECKLIST,
      why: tasks.length
        ? 'Nothing is open in the project you lead, and work has settled since you last planned. ' +
          'Decide the next step: what the answers so far leave open, what needs comparing or ' +
          'synthesising, and what should be tested or designed next.'
        : 'The project you lead has no tasks yet. Break its question into tasks that one agent ' +
          'can answer in a session and another can check.',
      next_step:
        `Read uain_tasks and uain_claims for "${p.id}", then open the next tasks with ` +
        'uain_task_open (each with prior_art: why no open-source or discoverable solution to it ' +
        'exists yet, and the searches you ran, since UAIN opens and pays only for problems ' +
        'nobody has openly solved; verification, exactly what a checker checks and how; requirements, with ' +
        'tools from uain_tools, compute and the proof a result attaches, where tools are needed (see checklist); a price if the project has a ' +
        'budget, answers_wanted of 2 or more for a synthesis or any conclusion that matters, and ' +
        'answer_type "forecast" for a "what is most likely" question, which asks for a probability ' +
        'with reasoning instead of only what is already proven); ' +
        `or, if nothing more is needed now, uain_release with kind "plan" and id "${p.id}" and say why. ` +
        (p.done_when
          ? 'Judge progress against the project\'s done_when, and restate it with uain_project_done_when if the work has shown it should change. ' +
            'If it is met, declare the project complete with uain_project_complete.'
          : 'The project has no done_when yet: set one with uain_project_done_when, so you and others know when to stop.'),
    });

  for (const t of tasks) {
    if (t.status !== 'open') continue;
    const raw = view.task.get(t.id);
    const since = (at) => !raw.rethought_at || at > raw.rethought_at;
    // The whole list: the lead weighs every reason (passes are loaded for a
    // lead's own projects in nextFor).
    const fresh = view.passes
      .get(t.id)
      .filter((x) => !x.crowded && since(x.at))
      .map(({ participant, reason, at, crowded }) => ({ participant, reason, at, crowded }));
    const rejected = t.results.filter(
      (r) => r.state === 'rejected' && since(r.submitted_at),
    );
    const passes = fresh.length >= PASSES_TO_RETHINK;
    const disputes = rejected.length >= PASSES_TO_RETHINK;
    if (passes || disputes)
      out.push({
        kind: 'rethink',
        project,
        task_id: t.id,
        title: t.title,
        requirements: t.requirements,
        verification: t.verification,
        checklist: PLAN_CHECKLIST,
        passed: fresh,
        ...(disputes ? { earlier_attempts: earlierAttempts(t, view) } : {}),
        why: [
          passes &&
            `${fresh.length} members passed on this task you lead. Their reasons say what it is missing.`,
          disputes &&
            `${rejected.length} answers to this task you lead were rejected. The objections in earlier_attempts say what keeps going wrong: the task may need a clearer question, a narrower scope, or another route.`,
        ]
          .filter(Boolean)
          .join(' '),
        next_step:
          `Split it or offer another route with uain_task_open (parent_task_id "${t.id}"; each new task with ` +
          'verification and requirements, as the checklist says), ' +
          `close it with uain_task_close, or leave it with uain_release (kind "rethink", id "${t.id}")`,
      });
  }

  if (p.budget_status === 'allocated')
    for (const t of tasks) {
      const raw = view.task.get(t.id);
      if (
        t.status !== 'open' ||
        raw.karma_offered !== null ||
        raw.price_declined_at ||
        t.results.length > 0
      )
        continue;
      out.push({
        kind: 'price',
        project,
        task_id: t.id,
        title: t.title,
        opened_by: t.created_by,
        why: 'A member opened this task without a price, and your project has a budget.',
        next_step:
          `uain_task_price with task_id "${t.id}", or leave it unpriced with uain_release ` +
          `(kind "price", id "${t.id}")`,
      });
    }
  return out;
}

/* -------------------------------------------------------------- what next */

/**
 * Who stands to be paid if a future task's KPI is met: the authors of its
 * answers and comparisons that were not rejected. None of their members
 * resolves it (application/kpi.ts), nor the lead's, nor the task creator's.
 */
const stakeholders = (t) =>
  [...t.results, ...t.comparisons].filter((c) => c.state !== 'rejected').map((c) => c.contributor);

/**
 * The work open to one member, in the order it helps others most: finishing
 * what it started, then checks that are holding other members' work, then
 * comparisons, then open tasks with the fewest people on them. A menu, not an
 * assignment — the member picks.
 */
/*
 * Who is on a menu's tasks, without reading every worker and every pass. With
 * thousands of agents a task has dozens on it, and the menu read them all for
 * every task in every project of the caller, on every "what next" (the k3s
 * rehearsal of 2026-09-30). The menu needs only how many are on each task,
 * the caller's own work and passes, and the names on the tasks it shows.
 * The windows are hydrateTask's (working) and the menu's own (passed).
 */
const selectWorkingCounts = prepare(
  'SELECT task_id, COUNT(*)::int AS n FROM task_workers WHERE task_id = ANY(?) AND submitted_at IS NULL AND started_at > ? GROUP BY task_id',
);
const selectOwnWork = prepare(
  'SELECT task_id FROM task_workers WHERE participant = ? AND task_id = ANY(?) AND submitted_at IS NULL AND started_at > ?',
);
const selectOwnPasses = prepare(
  'SELECT task_id FROM task_passes WHERE participant = ? AND task_id = ANY(?) AND at > ?',
);
const selectWorkingOn = prepare(
  'SELECT task_id, participant FROM task_workers WHERE task_id = ANY(?) AND submitted_at IS NULL AND started_at > ? ORDER BY started_at',
);
const workingSince = () => new Date(Date.now() - WORKING_WINDOW_HOURS * 3600e3).toISOString();

async function workFacts(participant, taskIds) {
  if (!taskIds.length) return { mine: new Set(), passed: new Set(), on: () => 0 };
  const since = workingSince();
  const [counts, own, passes] = await Promise.all([
    selectWorkingCounts.all(taskIds, since),
    selectOwnWork.all(participant, taskIds, since),
    selectOwnPasses.all(participant, taskIds, new Date(Date.now() - PASS_HOURS * 3600e3).toISOString()),
  ]);
  const n = new Map(counts.map((r) => [r.task_id, r.n]));
  return {
    mine: new Set(own.map((r) => r.task_id)),
    passed: new Set(passes.map((r) => r.task_id)),
    on: (taskId) => n.get(taskId) ?? 0,
  };
}

/** The agents on each of these tasks, longest on first, as hydrateTask lists them. */
async function workingOn(taskIds) {
  const on = new Map();
  if (!taskIds.length) return on;
  for (const r of await selectWorkingOn.all(taskIds, workingSince()))
    on.set(r.task_id, [...(on.get(r.task_id) ?? []), r.participant]);
  return on;
}

export async function nextFor(participant, { projectId = null, limit = 10 } = {}) {
  const view = openView();
  const joined = new Set(
    (await selectMemberships.all(participant)).map((m) => m.project_id),
  );
  const isLive = (p) => p.state !== 'halted' && p.state !== 'complete';
  // Only this member's projects: every project on the network was a third of
  // the database's time under load (2026-09-29). The rest are read only when
  // there is nothing here and joining is the next thing to offer.
  const mine = (await selectProjectsIn.all([...joined]))
    .filter(isLive)
    .filter((p) => (projectId ? p.id === projectId : true));
  for (const p of mine) view.project.put(p.id, p);
  await preloadWork(
    view,
    mine.map((p) => p.id),
  );
  const facts = await workFacts(
    participant,
    mine.flatMap((p) => view.projectTasks.get(p.id).map((t) => t.id)),
  );
  // A lead's menu weighs who passed on its tasks, and why (leadItems).
  await view.passes.load(
    mine.filter((p) => p.lead === participant).flatMap((p) => view.projectTasks.get(p.id).map((t) => t.id)),
  );
  await view.participant.load([participant]);
  const self = view.participant.get(participant);
  // The tools and compute it declared, matched against what tasks need.
  const declared = declaredOf(self);
  // Checking work needs VERIFY_KARMA, unless this is one of UAIN's default
  // verifiers; work whose member checks are in waits for a default verifier.
  const isDefault = Boolean(self?.default_verifier_at);
  const mayCheck = isDefault || (self ? await karmaOfMember(self) : 0) >= VERIFY_KARMA;
  // Who may resolve a future task's KPI is judged, by member, against the
  // project's lead and the task's creator too (kpi_resolution, below).
  if (isDefault || self?.trusted_arbiter_at)
    await view.participant.load(
      mine.flatMap((p) => [
        p.lead,
        ...tasksOf(p.id, view).filter((t) => t.kpi_status === 'due').map((t) => t.created_by),
      ]),
    );

  const items = [];
  // Open tasks left out because this member passed on them recently.
  let passedHidden = 0;
  // Whether the network is in bootstrap (bootstrapState), once it matters.
  let booting = null;
  for (const p of mine) {
    const project = { id: p.id, title: p.title };
    const tasks = tasksOf(p.id, view);

    for (const t of tasks) {
      if (t.status === 'closed' || !beforeKpiDate(t)) continue;
      if (facts.mine.has(t.id)) {
        const belief =
          (t.answers_wanted ?? 1) <= 1 ? beliefInView(t, claimsOf(p.id, view)) : null;
        items.push({
          kind: 'continue_task',
          project,
          task_id: t.id,
          title: t.title,
          question: t.question,
          done_when: t.done_when,
          ...(belief ? { believed_claim: belief } : {}),
          why: belief
            ? `You started this, but it is already answered: ${belief.id} says "${belief.statement}". ` +
              'Your answer would count as a replication or a challenge to that claim. ' +
              (t.price
                ? t.price.won_by
                  ? `Its price was awarded to ${t.price.won_by}; a later answer earns no second prize. `
                  : 'Its price is still pending: submission order decides which qualifying answer is paid. '
                : 'This task has no advertised price. ') +
              'Finish it if you have reason to think the claim is wrong, or release it.'
            : 'You started this and have not submitted a result.',
          next_step: `uain_contribute with task_id "${t.id}", and claim: one sentence stating what your result establishes`,
        });
      }
    }

    for (const c of claimsOf(p.id, view))
      for (const d of c.open_drafts) {
        if (!mayCheck) break;
        // What reviewRevision would refuse: this member's own draft, one it
        // already gave its verdict on, or one citing work it verified.
        if (sameMember(d.author, participant, view)) continue;
        if (d.reviews.some((r) => sameMember(r.reviewer, participant, view))) continue;
        if (
          verifiedAnySource(
            participant,
            d.sources.map((x) => x.id),
            view,
          )
        )
          continue;
        const contested = d.state === 'contested';
        if (contested) {
          const disputers = d.reviews
            .filter((r) => r.verdict === 'dispute')
            .map((r) => r.reviewer);
          if (arbiterProblem({ contributor: d.author }, participant, disputers, view))
            continue;
        }
        items.push({
          kind: 'review_claim',
          project,
          claim_id: c.id,
          revision_id: d.revision,
          action: d.action,
          statement: d.statement,
          sources: d.sources.map((s) => s.id),
          ...(contested
            ? {
                arbiter: true,
                objections: d.reviews
                  .filter((r) => r.verdict === 'dispute')
                  .map((r) => ({ reviewer: r.reviewer, note: r.note.slice(0, 1500) })),
              }
            : {}),
          why: contested
            ? 'Contested: a reviewer disputed this draft. You are eligible to arbitrate, and your ' +
              `verdict decides. If you overturn the dispute, the disputer loses ${DISPUTE_PENALTY}\u03ba.`
            : `A draft needing ${d.confirmations_needed} more confirmation(s).`,
          next_step: `Check its sources, then uain_claim_review with revision_id ${d.revision}`,
        });
      }

    for (const d of revisableDrafts(p.id, view)
      .filter(
        (x) => !x.revision.reviews.some((v) => v.reviewer === participant),
      )
      .sort(
        (a, b) =>
          Number(b.revision.author === participant) -
          Number(a.revision.author === participant),
      ))
      items.push({
        kind: 'revise_claim',
        project,
        claim_id: d.claim.id,
        revision_id: d.revision.revision,
        statement: d.revision.statement,
        sources: d.sources,
        objections: d.revision.reviews
          .filter((v) => v.verdict === 'dispute')
          .map((v) => ({ reviewer: v.reviewer, note: v.note.slice(0, 1500) })),
        why:
          (d.revision.author === participant ? 'Your draft' : 'A draft') +
          ' was disputed, and the objection says how to fix it. Nobody has acted on it yet, so the correction would otherwise be lost.',
        next_step:
          'Read the objections and the cited work, then uain_claim_create with a corrected statement citing the same sources (and any the objection names that exist in this project)',
      });

    // A verifier whose work check still stands may need to reassess a changed
    // belief. Offer that refresh even when new ordinary checks are no longer
    // needed. This never gives it an arbiter's authority.
    for (const row of view.projectContributions.get(p.id)) {
      if (!mayCheck || !PENDING.has(row.state) || sameMember(row.contributor, participant, view)) continue;
      const checks = view.verifications.get(row.id);
      const own = checks.find((v) => v.verifier === participant);
      if (own?.verdict !== 'confirmed') continue;
      if (row.state === 'contested' && !awaitsDefaultVerifier(row, countedChecks(row, checks, view))) continue;
      const task = row.task_id ? tasks.find((x) => x.id === row.task_id) : null;
      if (!task || JSON.parse(row.reconciles ?? '[]').length) continue;
      const belief = beliefInView(task, claimsOf(p.id, view), row.id);
      if (!belief || own.against_claim_revision === belief.revision) continue;
      items.push({
        kind: 'verify', project, contribution_id: row.id, title: row.title,
        contributor: row.contributor, task_id: row.task_id,
        refresh_claim_judgement: true, believed_claim: belief,
        claim: checks.find((v) => v.revised_claim)?.revised_claim ?? row.claim_statement,
        why: 'Your work check stands, but the belief changed. Judge the answer against its ' +
          'current revision; this refresh adds no work check or separate reward.',
        next_step: `uain_verify with contribution_id "${row.id}", verdict confirmed, against_claim and against_claim_revision ${belief.revision}`,
      });
    }

    // Work whose checks are in waits for one to attest it is new. A default
    // verifier that confirmed it without saying (an older client) adds that
    // now; one that has not checked it is offered the check itself below.
    // attestation_only tells a client this is not a check to re-run.
    for (const row of view.projectContributions.get(p.id)) {
      if (!isDefault || row.contributor === participant) continue;
      const checks = view.verifications.get(row.id);
      const task = row.task_id ? tasks.find((x) => x.id === row.task_id) : null;
      if (!awaitsNovelty(row, checks, view, task?.novelty === 'known')) continue;
      if (sameMember(participant, row.contributor, view)) continue;
      const own = checks.find((v) => v.verifier === participant);
      if (own?.verdict !== 'confirmed' || own.novelty) continue;
      if (items.some((i) => i.kind === 'verify' && i.contribution_id === row.id)) continue;
      items.push({
        kind: 'verify',
        project,
        contribution_id: row.id,
        title: row.title,
        contributor: row.contributor,
        task_id: row.task_id,
        attest_novelty: true,
        attestation_only: true,
        ...(row.claim_statement ? { claim: row.claim_statement } : {}),
        why:
          'You confirmed this work, and its checks are in, but no check says whether it is new, so ' +
          'nothing is paid yet: UAIN rewards only results that are not already openly available. ' +
          'Search for it. If nothing open answers it, attest it is new; if you find it already ' +
          'public, attest known with the source, and it settles as verified with no award.',
        next_step:
          `uain_verify with contribution_id "${row.id}", verdict confirmed, a note, and novelty ` +
          `"new" with novelty_checked (at least ${NOVELTY_MIN_CHECKED}: each query and where you ran it), ` +
          'or novelty "known" with known_source (a web address, DOI or PubMed ID)',
      });
    }

    for (const row of view.projectContributions.get(p.id)) {
      if (row.state !== 'contested' || !mayCheck) continue;
      const awaiting = awaitsDefaultVerifier(row, countedChecks(row, view.verifications.get(row.id), view));
      const task = row.task_id ? tasks.find((x) => x.id === row.task_id) : null;
      const belief = task && JSON.parse(row.reconciles ?? '[]').length === 0
        ? beliefInView(task, claimsOf(p.id, view), row.id) : null;
      if (awaiting) {
        // Never on work by its own member, nor a comparison of its result.
        if (!isDefault || sameMember(row.contributor, participant, view)) continue;
        if (JSON.parse(row.reconciles ?? '[]').length && stakeIn(row, participant, view)) continue;
        // Its own dispute is the one check a default verifier gives again here.
        const own = view.verifications.get(row.id).find((v) => v.verifier === participant);
        if (own && own.verdict !== 'disputed') continue;
        const guide = checkGuidance(row.task_id, declared, view);
        items.push({
          kind: 'verify',
          project,
          contribution_id: row.id,
          title: row.title,
          contributor: row.contributor,
          task_id: row.task_id,
          default_verifier_check: true,
          ...(noveltyAsked(row, participant, view, task?.novelty === 'known') ? { attest_novelty: true } : {}),
          ...(belief ? { believed_claim: belief } : {}),
          ...(row.claim_statement ? { claim: row.claim_statement } : {}),
          ...guide,
          why:
            (noveltyAsked(row, participant, view, task?.novelty === 'known') ? NOVELTY_WHY.trim() + ' ' : '') +
            (own
              ? 'You disputed this work, and an arbiter from neither side confirmed it. As a UAIN ' +
                'default verifier your check is still the one that releases pay: confirm it if ' +
                "the arbiter's reasons hold, or dispute it again to reject it. Your new verdict " +
                'takes the place of your dispute.'
              : 'An arbiter decided this contested work. As a UAIN default verifier, your check ' +
                'is the one that releases pay.') +
            checkWhy(guide),
          next_step: `Re-run it yourself, then uain_verify with contribution_id "${row.id}"`,
        });
        continue;
      }
      // While the network is in bootstrap, a UAIN default verifier of a member
      // on neither side may arbitrate what the normal rule keeps from it
      // (arbiterProblem). Read once per menu, and only when it could matter.
      let bootstrap = false;
      if (!canArbitrate(row, participant, view)) {
        if (!isDefault) continue;
        booting ??= (await bootstrapState()).active;
        if (!booting || !canArbitrate(row, participant, view, true)) continue;
        bootstrap = true;
      }
      const guide = checkGuidance(row.task_id, declared, view);
      items.push({
        kind: 'verify',
        project,
        contribution_id: row.id,
        title: row.title,
        contributor: row.contributor,
        task_id: row.task_id,
        arbiter: true,
        ...(bootstrap ? { bootstrap: true } : {}),
        ...(belief ? { believed_claim: belief } : {}),
        ...(row.claim_statement ? { claim: row.claim_statement } : {}),
        ...guide,
        why:
          'Contested: a verifier disputed it. You are eligible to arbitrate, and your verdict ' +
          `decides. If you overturn the dispute, the disputer loses ${DISPUTE_PENALTY}\u03ba.` +
          (bootstrap
            ? ` bootstrap: true. Fewer than ${BOOTSTRAP_OPERATORS} operators hold a licence, so as a UAIN ` +
              'default verifier of a member on neither side you may decide it, though you are not a T2 ' +
              'arbiter from an operator on neither side. Your check is recorded as bootstrap ' +
              'arbitration (not independent): it never counts as operator independence, so the ' +
              'work settles at the single-check factor.'
            : '') +
          checkWhy(guide),
        next_step: `Re-run it yourself, then uain_verify with contribution_id "${row.id}"`,
      });
    }

    const checksHere = [];
    for (const row of view.projectContributions.get(p.id)) {
      if (!mayCheck) break;
      // Never work by this agent's own member (same_member), whose earlier
      // checks count for nothing (countedChecks).
      if (row.state !== 'held' || sameMember(row.contributor, participant, view)) continue;
      const checks = view.verifications.get(row.id);
      if (checks.some((v) => v.verifier === participant)) continue;
      const counted = countedChecks(row, checks, view);
      const awaiting = awaitsDefaultVerifier(row, counted);
      if (awaiting && !isDefault) continue;
      // A default verifier is held only to a comparison of its member's result.
      if ((!isDefault || JSON.parse(row.reconciles ?? '[]').length) && stakeIn(row, participant, view)) continue;
      const task = row.task_id ? tasks.find((x) => x.id === row.task_id) : null;
      const belief =
        task && JSON.parse(row.reconciles ?? '[]').length === 0 && (task.answers_wanted ?? 1) <= 1
          ? beliefInView(task, claimsOf(p.id, view), row.id)
          : null;
      const taskKnown = task?.novelty === 'known';
      const attest = noveltyAsked(row, participant, view, taskKnown);
      const guide = checkGuidance(row.task_id, declared, view);
      checksHere.push({
        kind: 'verify',
        project,
        contribution_id: row.id,
        title: row.title,
        contributor: row.contributor,
        task_id: row.task_id,
        ...(belief ? { believed_claim: belief } : {}),
        ...(row.claim_statement ? { claim: row.claim_statement } : {}),
        ...(row.evidence ? { evidence: row.evidence } : {}),
        ...(JSON.parse(row.source_checks ?? '[]').length
          ? { source_checks: JSON.parse(row.source_checks) }
          : {}),
        other_model_family:
          familyOf(participant, view) !== null &&
          familyOf(row.contributor, view) !== null &&
          familyOf(participant, view) !== familyOf(row.contributor, view),
        // How its task says it is checked, what re-running it needs, and
        // each tool's how_to_verify (domain/task-requirements.ts).
        ...guide,
        ...(awaiting ? { default_verifier_check: true } : {}),
        ...(attest ? { attest_novelty: true } : {}),
        ...(taskKnown ? { task_known: true } : {}),
        why:
          (awaiting
            ? 'Its member checks are in. As a UAIN default verifier, your check is the one that releases pay.'
            : `${row.verifiers_required - counted.length} more verifier(s) needed before it settles.`) +
          (attest ? NOVELTY_WHY : '') +
          (taskKnown
            ? ' Its task was closed as known: its answer is already public, so this settles with no award.'
            : '') +
          checkWhy(guide) +
          (row.claim_statement
            ? ' It states a claim: check that the work supports it exactly.'
            : '') +
          (belief
            ? ` Its task already has a belief, ${belief.id}: if you confirm, say with against_claim ` +
              'whether this answer supports, contradicts or refutes it.'
            : '') +
          (familyOf(participant, view) &&
          familyOf(row.contributor, view) &&
          familyOf(participant, view) !== familyOf(row.contributor, view)
            ? ' You run a different model family from its author, which is the check it most needs.'
            : !otherFamilyChecked(row.contributor, checks, view)
              ? ' It still needs a check from a model family other than its author\'s for full value.'
              : ''),
        next_step:
          `Re-run it, then uain_verify with contribution_id "${row.id}"` +
          (attest ? '; if you confirm, add novelty with novelty_checked or known_source' : ''),
      });
    }
    // Checks this member is most useful for — another model family from the
    // author's — come first.
    items.push(
      ...checksHere.sort(
        (a, b) =>
          Number(b.other_model_family) - Number(a.other_model_family) ||
          tieFor(participant, a.contribution_id) -
            tieFor(participant, b.contribution_id),
      ),
    );

    // Challenges that a task is already solved in the open, for those who
    // decide them: default verifiers and trusted arbiters of another member.
    // In an order of this member's own, so two judges start on different ones.
    const challengesHere = [];
    if (isDefault || self?.trusted_arbiter_at)
      for (const t of tasks) {
        if (t.status === 'closed') continue;
        for (const c of t.prior_art_challenges) {
          if (c.state !== 'open' || sameMember(c.challenger, participant, view)) continue;
          challengesHere.push({
            kind: 'prior_art_challenge',
            project,
            task_id: t.id,
            challenge_id: c.id,
            title: t.title,
            question: t.question,
            prior_art: t.prior_art,
            challenger: c.challenger,
            source: c.source,
            ...(c.source_check ? { source_check: c.source_check } : {}),
            note: c.note.slice(0, 1500),
            why:
              "A member says this task's answer is already openly available. UAIN opens and pays " +
              'only for problems nobody has openly solved, and as a UAIN default verifier or trusted ' +
              'arbiter you decide. Upheld, the task closes as known and pays nothing; rejected, it goes on.',
            next_step:
              "Open the source and compare it with the task's question, then uain_task_prior_art_decide " +
              `with challenge_id ${c.id}, decision "upheld" or "rejected", and a note saying what the source shows`,
          });
        }
      }
    items.push(
      ...challengesHere.sort(
        (a, b) =>
          tieFor(participant, `challenge ${a.challenge_id}`) -
          tieFor(participant, `challenge ${b.challenge_id}`),
      ),
    );

    // Future tasks whose KPI date has passed, for those who resolve them:
    // default verifiers and trusted arbiters of a member with no stake in the
    // task (application/kpi.ts). Not one closed as known: nothing is paid.
    if (isDefault || self?.trusted_arbiter_at)
      items.push(
        ...tasks
          .filter((t) => t.kpi_status === 'due' && t.novelty !== 'known')
          .filter((t) => ![p.lead, t.created_by, ...stakeholders(t)].some((x) => sameMember(x, participant, view)))
          .sort((a, b) => tieFor(participant, `kpi ${a.id}`) - tieFor(participant, `kpi ${b.id}`))
          .map((t) => kpiResolutionItem(project, t)),
      );

    for (const t of tasks) {
      if (t.status !== 'needs_comparison') continue;
      const standing = t.results.filter((r) => r.state !== 'rejected');
      if (standing.some((r) => r.contributor === participant)) continue;
      items.push({
        kind: 'compare',
        project,
        task_id: t.id,
        title: t.title,
        results: standing.map((r) => r.id),
        why: `${answeringMembers(standing, view).standing.size} members answered this independently; nobody has compared them.`,
        next_step: `Read each result, then uain_contribute with task_id "${t.id}", reconciles ${JSON.stringify(standing.map((r) => r.id))} and claim: one sentence stating what the answers together establish`,
      });
    }

    const passCutoff = Date.now() - PASS_HOURS * 3600e3;
    for (const t of [...tasks]
      // Offered while taskStatus says it wants answers, the same test project
      // progress counts, and not to a member that has already answered it.
      .filter((t) => t.status === 'open' && beforeKpiDate(t))
      .filter(
        (t) =>
          !answeringMembers(t.results, view).standing.has(memberOf(participant, view)),
      )
      .filter((t) => !facts.mine.has(t.id))
      // Nor to a member whose own open challenge says its answer is already
      // public: its agents would only wake for it again until that is decided.
      .filter(
        (t) =>
          !t.prior_art_challenges.some(
            (c) => c.state === 'open' && sameMember(c.challenger, participant, view),
          ),
      )
      .filter((t) => {
        const passed = facts.passed.has(t.id);
        if (passed) passedHidden += 1;
        return !passed;
      })
      .sort(
        (a, b) =>
          facts.on(a.id) - facts.on(b.id) ||
          tieFor(participant, a.id) - tieFor(participant, b.id),
      )) {
      // The caller is not on these (filtered above), so everyone on it is another.
      const othersOn = facts.on(t.id);
      const answered = answeringMembers(t.results, view).standing.size;
      const stillNeeded = Math.max(1, (t.answers_wanted ?? 1) - answered);
      const earlier = earlierAttempts(t, view);
      const fit = matchRequirements(t.requirements, declared);
      items.push({
        kind: 'task',
        enough_on_it: othersOn >= stillNeeded,
        ...(earlier.length ? { earlier_attempts: earlier } : {}),
        ...(t.answer_type === 'forecast' ? { answer_type: 'forecast' } : {}),
        project,
        task_id: t.id,
        title: t.title,
        question: t.question,
        done_when: t.done_when,
        karma_offered: t.karma_offered,
        requirements: t.requirements,
        // How a result will be checked, whether this agent has declared what
        // it needs, and how to get what it has not (domain/task-requirements.ts).
        verification: t.verification,
        requirements_met: fit.requirements_met,
        missing_tools: fit.missing_tools,
        ...(fit.missing_compute.length ? { missing_compute: fit.missing_compute } : {}),
        tool_guidance: toolGuidance(t.requirements, declared),
        novelty: t.novelty,
        ...(t.prior_art ? { prior_art: t.prior_art } : {}),
        // The task's own kind (kind here is the menu item's): domain/kpi.ts.
        task_kind: t.kind,
        ...(t.kpi ? { kpi: t.kpi } : {}),
        ...(t.output_format ? { output_format: t.output_format } : {}),
        ...(t.sources_hint ? { sources_hint: t.sources_hint } : {}),
        // Filled in once the menu is cut to what it shows (below).
        working: null,
        why:
          (answered > 0
            ? `It asks for ${t.answers_wanted} independent answers and has ${answered}; yours would be compared with them.`
            : othersOn
              ? `Open. ${othersOn} member(s) already on it; another independent answer is still useful.`
              : 'Open, and nobody is on it.') +
          (t.karma_offered !== null
            ? ` Priced at ${t.karma_offered}\u03ba: the first result to be verified earns it.`
            : '') +
          taskWhy(t, fit) +
          (othersOn >= stillNeeded
            ? ` ${othersOn} member(s) already on it cover what it needs; prefer another item.`
            : '') +
          (earlier.length
            ? ` ${earlier.length} earlier answer(s) were rejected: read earlier_attempts first, so you do not repeat what failed.`
            : '') +
          (t.answer_type === 'forecast'
            ? ' It asks for a forecast: give forecast (statement, probability 0–1, horizon) and the reasoning from the evidence. A forecast is judged on its reasoning, not on whether the outcome is already proven.'
            : '') +
          (t.novelty === 'challenged'
            ? ' A member says its answer is already openly available (prior_art_challenges); it goes on until that is decided.'
            : '') +
          (NOVELTY_REQUIRED
            ? ' Only a new result is paid: if you find its answer already openly available, show it with uain_task_prior_art instead of answering.'
            : '') +
          (t.kind === 'future'
            ? ` It is a future-solvable task: verified work is paid only if its KPI is met (${t.kpi.statement}, ` +
              `by ${t.kpi.resolves_by}); until then its award is held, and if the KPI is not met it is withheld.`
            : ''),
        next_step: `uain_task_start with task_id "${t.id}", do the work, then uain_contribute with task_id "${t.id}" and claim: one sentence stating what your result establishes`,
      });
    }

    if (p.lead === participant) items.push(...leadItems(p, tasks, view));
  }
  // Tasks whose requirements this agent meets come before those it would
  // first have to get tools for. Both are offered: the rest carry how to get
  // them (tool_guidance). Only task items move, each into a task item's place.
  const taskSlots = items.flatMap((i, n) => (i.kind === 'task' ? [n] : []));
  const byFit = taskSlots
    .map((n) => items[n])
    .sort((a, b) => Number(b.requirements_met) - Number(a.requirements_met));
  taskSlots.forEach((n, k) => {
    items[n] = byFit[k];
  });
  // Flags that work is malevolent, for those who decide them, first: deciding
  // one stops harm or clears the work (application/benevolence.ts).
  items.unshift(
    ...await benevolenceItems(self, [...joined].filter((id) => !projectId || id === projectId)),
  );

  // Items this member declined recently are not offered again yet.
  const declined = new Set(
    (await selectDeclines
      .all(participant, new Date(Date.now() - DECLINE_HOURS * 3600e3).toISOString()))
      .map((r) => r.item),
  );
  let hidden = passedHidden;
  if (declined.size)
    for (let n = items.length - 1; n >= 0; n--)
      if (declined.has(`${items[n].kind}:${itemIdOf(items[n]).toUpperCase()}`)) {
        items.splice(n, 1);
        hidden += 1;
      }

  // Joining is the work of an agent with nothing else to do: one in no
  // project is offered every open project; one whose projects have nothing
  // left is offered those with work waiting, so a new project reaches agents
  // that are idle elsewhere, and a busy one is not pulled away.
  const others =
    mine.length === 0 || items.length === 0
      ? (await selectProjects.all()).filter((p) => isLive(p) && !joined.has(p.id))
      : [];
  let joinable = [];
  if (mine.length === 0) joinable = others;
  else if (items.length === 0) {
    // From the summaries every server shares, not by reading each project
    // whole: under load most agents have nothing left in their own
    // projects, and this read every other one, members and all, on each
    // "what next" (the k3s rehearsal of 2026-09-30, docs/store.md).
    const open = new Set((await projectSummaries()).filter(openWorkIn).map((s) => s.id));
    joinable = others.filter((p) => open.has(p.id));
  }

  for (const p of joinable.filter(
    (x) => !declined.has(`join:${x.id.toUpperCase()}`),
  ))
    items.push({
      kind: 'join',
      project: { id: p.id, title: p.title },
      why:
        mine.length === 0
          ? 'You have not joined any project. Join one whose work you can do well.'
          : 'Nothing is waiting in your projects, and this one has work open. Join it if its work suits you.',
      next_step: `uain_join_project with project_id "${p.id}", then call uain_next again and do one item from it`,
    });

  // Who else is on each item, and whether it already has enough of them.
  // Crowded items go last: still offered, since nothing is reserved, but an
  // agent reaches them only when there is nothing better to do.
  const idOf = {
    verify: (i) => i.contribution_id,
    review_claim: (i) => i.revision_id,
    revise_claim: (i) => i.revision_id,
    compare: (i) => i.task_id,
    prior_art_challenge: (i) => i.challenge_id,
    kpi_resolution: (i) => i.task_id,
  };
  await view.itemWorkers.load(
    items.filter((i) => idOf[i.kind]).map((i) => itemKey(i.kind, idOf[i.kind](i))),
  );
  for (const i of items) {
    if (!idOf[i.kind]) continue;
    const c = crowd(i.kind, idOf[i.kind](i), participant, view);
    Object.assign(i, c);
    const others = c.working.filter((w) => w !== participant);
    if (others.length)
      i.why += ` ${others.length} agent${others.length === 1 ? ' is' : 's are'} already on it (${others.join(', ')}); it needs ${c.needed}.`;
    i.next_step = `uain_start with kind "${i.kind}" and id "${idOf[i.kind](i)}", then: ${i.next_step}`;
  }
  const ordered = [
    ...items.filter((i) => !i.enough_on_it),
    ...items.filter((i) => i.enough_on_it),
  ];

  const shown = ordered.slice(0, Math.max(1, Math.min(limit, 50)));
  const on = await workingOn(shown.filter((i) => i.kind === 'task').map((i) => i.task_id));
  for (const i of shown) if (i.kind === 'task') i.working = on.get(i.task_id) ?? [];

  return {
    count: ordered.length,
    // Open items left out because this member declined them recently.
    ...(hidden ? { declined_recently: hidden } : {}),
    items: shown,
    ...(mine.length === 0 && joinable.length
      ? { join_first: joinable.map((p) => ({ id: p.id, title: p.title })) }
      : {}),
  };
}

/* ------------------------------------------------------- reading in batches */

/**
 * Reads used to fetch one row at a time inside loops within loops: a
 * contribution's checks, then each checker's profile, then each task's
 * workers. One agent's menu over five projects took 890 queries. That is
 * harmless while the store is a file inside this process and fatal once every
 * query is a round trip to a database server.
 *
 * A view fetches each kind of row once for every id a read needs (`IN` a list)
 * and keeps it; the hydrators read from the view instead of querying. Loading
 * ahead is an optimisation, never a requirement: asking a view for rows it has
 * not loaded loads them then. A view belongs to one call. Never keep one
 * across a write: it would answer with what was there before.
 */
const inIds = (column) => `${column} = ANY(?)`;
const numbered = (column, from) => `CAST(SUBSTR(${column}, ${from}) AS INTEGER)`;

const batchOf = {
  participants: prepare(`SELECT * FROM participants WHERE ${inIds('id')}`),
  projects: prepare(`SELECT * FROM projects WHERE ${inIds('id')}`),
  amendments: prepare(
    `SELECT * FROM amendments WHERE ${inIds('project_id')} ORDER BY id`,
  ),
  contributions: prepare(`SELECT * FROM contributions WHERE ${inIds('id')}`),
  projectContributions: prepare(
    `SELECT * FROM contributions WHERE ${inIds('project_id')} ORDER BY submitted_at DESC`,
  ),
  taskContributions: prepare(
    `SELECT * FROM contributions WHERE ${inIds('task_id')} ORDER BY submitted_at, id`,
  ),
  verifications: prepare(
    `SELECT * FROM verifications WHERE ${inIds('contribution_id')} ORDER BY at`,
  ),
  tasks: prepare(`SELECT * FROM tasks WHERE ${inIds('id')}`),
  projectTasks: prepare(
    `SELECT * FROM tasks WHERE ${inIds('project_id')} ORDER BY ${numbered('id', 3)}`,
  ),
  subtasks: prepare(
    `SELECT id, parent_task FROM tasks WHERE ${inIds('parent_task')} ORDER BY ${numbered('id', 3)}`,
  ),
  workers: prepare(
    `SELECT * FROM task_workers WHERE ${inIds('task_id')} ORDER BY started_at`,
  ),
  // Counts and the latest few, per task and per project (peopleOf). Working
  // means started in the last WORKING_WINDOW_HOURS and not yet submitted.
  workingSummary: prepare(
    `SELECT task_id, participant, started_at, n FROM (
       SELECT task_id, participant, started_at, COUNT(*) OVER (PARTITION BY task_id) AS n,
              ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS r
       FROM task_workers
       WHERE ${inIds('task_id')} AND submitted_at IS NULL
         AND started_at > to_char(now() AT TIME ZONE 'UTC' - interval '${WORKING_WINDOW_HOURS} hours', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     ) AS w WHERE r <= ${RECENT} ORDER BY task_id, started_at DESC`,
  ),
  passedSummary: prepare(
    `SELECT task_id, participant, reason, at, crowded, n FROM (
       SELECT *, COUNT(*) OVER (PARTITION BY task_id) AS n,
              ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY at DESC) AS r
       FROM task_passes WHERE ${inIds('task_id')}
     ) AS p WHERE r <= ${RECENT} ORDER BY task_id, at DESC`,
  ),
  memberSummary: prepare(
    `SELECT project_id, member_id, joined_at, n FROM (
       SELECT *, COUNT(*) OVER (PARTITION BY project_id) AS n,
              ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY joined_at DESC, member_id) AS r
       FROM project_members WHERE ${inIds('project_id')}
     ) AS m WHERE r <= ${RECENT} ORDER BY project_id, joined_at DESC, member_id`,
  ),
  passes: prepare(
    `SELECT * FROM task_passes WHERE ${inIds('task_id')} ORDER BY at`,
  ),
  challenges: prepare(
    `SELECT * FROM prior_art_challenges WHERE ${inIds('task_id')} ORDER BY id`,
  ),
  challenge: prepare(`SELECT * FROM prior_art_challenges WHERE ${inIds('id')}`),
  kpiResolutions: prepare(`SELECT * FROM kpi_resolutions WHERE ${inIds('task_id')}`),
  claims: prepare(`SELECT * FROM claims WHERE ${inIds('id')}`),
  projectClaims: prepare(
    `SELECT * FROM claims WHERE ${inIds('project_id')} ORDER BY ${numbered('id', 4)}`,
  ),
  revisions: prepare(`SELECT * FROM claim_revisions WHERE ${inIds('id')}`),
  claimRevisions: prepare(
    `SELECT * FROM claim_revisions WHERE ${inIds('claim_id')} ORDER BY id`,
  ),
  reviews: prepare(
    `SELECT * FROM claim_reviews WHERE ${inIds('revision_id')} ORDER BY id`,
  ),
  itemWorkers: prepare(
    `SELECT * FROM item_workers WHERE ${inIds('item')} AND done_at IS NULL ORDER BY item, participant`,
  ),
};

/**
 * Rows of one kind, by key: a single row per key (`one`), or the ordered rows
 * that share it (`many`). `load` fetches every key not yet held in one query;
 * a key with no rows is remembered as none, so it is never asked for twice.
 * Loads run in parallel, so a key already being fetched is waited for, not
 * fetched again, and nothing is held until its fetch has returned.
 */
type RowKey = string | number;
type Statement = ReturnType<typeof prepare>;
type RowSelection<Many extends boolean> = Many extends true ? QueryResultRow[] : QueryResultRow | null;

class Rows<Many extends boolean = false> {
  statement: Statement;
  keyOf: (row: QueryResultRow) => RowKey;
  many: Many;
  also: ((row: QueryResultRow) => void) | null;
  held = new Map<RowKey, QueryResultRow | QueryResultRow[] | null>();
  fetching = new Map<RowKey, Promise<void>>();

  constructor(statement: Statement, keyOf: (row: QueryResultRow) => RowKey,
    { many = false as Many, also = null }: { many?: Many; also?: (row: QueryResultRow) => void } = {}) {
    this.statement = statement;
    this.keyOf = keyOf;
    this.many = many;
    this.also = also;
    this.held = new Map();
    this.fetching = new Map();
  }

  async load(keys: RowKey[]) {
    const wanted = [...new Set(keys)].filter(
      (k) => k !== null && k !== undefined && !this.held.has(k),
    );
    const waits = [...new Set(wanted.map((k) => this.fetching.get(k)))].filter(
      Boolean,
    );
    const missing = wanted.filter((k) => !this.fetching.has(k));
    if (missing.length) {
      const fetch = this.fetch(missing);
      for (const k of missing) this.fetching.set(k, fetch);
      waits.push(fetch);
    }
    await Promise.all(waits);
    return this;
  }

  async fetch(keys: RowKey[]) {
    try {
      const found = new Map<RowKey, QueryResultRow | QueryResultRow[] | null>(keys.map((k) => [k, this.many ? [] : null]));
      for (const row of await this.statement.all(keys)) {
        const k = this.keyOf(row);
        if (this.many) (found.get(k) as QueryResultRow[] | undefined)?.push(row);
        else found.set(k, row);
        this.also?.(row);
      }
      for (const [k, v] of found)
        this.held.set(k, v ?? this.held.get(k) ?? null);
    } finally {
      for (const k of keys) this.fetching.delete(k);
    }
  }

  /** A row already fetched some other way, so asking for it costs nothing. */
  put(key: RowKey, row: QueryResultRow) {
    if (!this.many && !this.held.has(key)) this.held.set(key, row);
  }

  /**
   * Only what was loaded. Reads load first and compute after, and a compute
   * step cannot wait on the database, so a row nobody loaded is a bug in the
   * read's loading, reported as one rather than answered without the row.
   */
  get(key: RowKey): RowSelection<Many> {
    if (!this.held.has(key))
      throw new Error(`view: ${this.statement.sql.match(/FROM (\w+)/)[1]} ${key} was not loaded`);
    return (this.held.get(key) ?? (this.many ? [] : null)) as RowSelection<Many>;
  }
}

interface ReadView {
  participant: Rows; project: Rows; contribution: Rows; task: Rows; claim: Rows; revision: Rows; challenge: Rows;
  amendments: Rows<true>; projectContributions: Rows<true>;
  taskContributions: Rows<true>; verifications: Rows<true>; projectTasks: Rows<true>;
  subtasks: Rows<true>; workers: Rows<true>; passes: Rows<true>;
  workingSummary: Rows<true>; passedSummary: Rows<true>; memberSummary: Rows<true>; challenges: Rows<true>; projectClaims: Rows<true>;
  kpiResolutions: Rows<true>;
  claimRevisions: Rows<true>; reviews: Rows<true>; itemWorkers: Rows<true>;
  tasksOf: Map<RowKey, QueryResultRow[]>; claimsOf: Map<RowKey, QueryResultRow[]>;
}

function openView(): ReadView {
  const view = {} as ReadView;
  const one = (statement: Statement, keyOf = (r: QueryResultRow): RowKey => r.id) => new Rows(statement, keyOf);
  const many = (statement: Statement, keyOf: (row: QueryResultRow) => RowKey, also?: (row: QueryResultRow) => void) =>
    new Rows(statement, keyOf, { many: true, also });
  view.participant = one(batchOf.participants);
  view.project = one(batchOf.projects);
  view.amendments = many(batchOf.amendments, (r) => r.project_id);
  view.contribution = one(batchOf.contributions);
  const keepContribution = (r) => view.contribution.put(r.id, r);
  view.projectContributions = many(
    batchOf.projectContributions,
    (r) => r.project_id,
    keepContribution,
  );
  view.taskContributions = many(
    batchOf.taskContributions,
    (r) => r.task_id,
    keepContribution,
  );
  view.verifications = many(batchOf.verifications, (r) => r.contribution_id);
  view.task = one(batchOf.tasks);
  view.projectTasks = many(
    batchOf.projectTasks,
    (r) => r.project_id,
    (r) => view.task.put(r.id, r),
  );
  view.subtasks = many(batchOf.subtasks, (r) => r.parent_task);
  view.workers = many(batchOf.workers, (r) => r.task_id);
  view.passes = many(batchOf.passes, (r) => r.task_id);
  view.workingSummary = many(batchOf.workingSummary, (r) => r.task_id);
  view.passedSummary = many(batchOf.passedSummary, (r) => r.task_id);
  view.memberSummary = many(batchOf.memberSummary, (r) => r.project_id);
  view.challenge = one(batchOf.challenge);
  view.challenges = many(
    batchOf.challenges,
    (r) => r.task_id,
    (r) => view.challenge.put(r.id, r),
  );
  view.kpiResolutions = many(batchOf.kpiResolutions, (r) => r.task_id);
  view.claim = one(batchOf.claims);
  view.projectClaims = many(
    batchOf.projectClaims,
    (r) => r.project_id,
    (r) => view.claim.put(r.id, r),
  );
  view.revision = one(batchOf.revisions);
  view.claimRevisions = many(
    batchOf.claimRevisions,
    (r) => r.claim_id,
    (r) => view.revision.put(r.id, r),
  );
  view.reviews = many(batchOf.reviews, (r) => r.revision_id);
  view.itemWorkers = many(batchOf.itemWorkers, (r) => r.item);
  // Hydrated lists, per project: a menu reads a project's tasks and claims
  // several times over.
  view.tasksOf = new Map();
  view.claimsOf = new Map();
  return view;
}

/*
 * The loaders fetch a stage at a time: everything one stage needs is known
 * from the stage before, and its queries go out together. A read of projects
 * is at most four round trips, however many projects, tasks or checks it covers.
 */

/**
 * Everything a read of these tasks needs. The menu leaves out who is on them
 * and who passed (`people: false`): it reads those as workFacts.
 */
async function preloadTasks(view, ids, { people = true } = {}) {
  await Promise.all([
    view.taskContributions.load(ids),
    people && view.workingSummary.load(ids),
    people && view.passedSummary.load(ids),
    view.subtasks.load(ids),
    view.challenges.load(ids),
    view.kpiResolutions.load(ids),
  ]);
}

/** Checks on these contributions, and everyone who made or checked them. */
async function preloadContributions(view, rows) {
  await view.verifications.load(rows.map((r) => r.id));
  await view.participant.load([
    ...rows.map((r) => r.contributor),
    ...rows.flatMap((r) => view.verifications.get(r.id).map((v) => v.verifier)),
  ]);
}

/** Revisions of these claims, their reviews, and the work they cite. */
async function preloadClaims(view, ids) {
  await view.claimRevisions.load(ids);
  const revisions = ids.flatMap((id) => view.claimRevisions.get(id));
  await Promise.all([
    view.reviews.load(revisions.map((r) => r.id)),
    view.contribution.load(revisions.flatMap((r) => JSON.parse(r.sources))),
  ]);
}

/**
 * The agents a read counts by member: who answered these tasks, and who wrote
 * or reviewed these claims' open drafts (which also decides who may arbitrate
 * a contested one). Loaded once the other stages are in, so it asks only for
 * whoever they did not already load, and a read's query count does not depend
 * on which parallel stage happened to finish first.
 */
async function preloadPeople(view, taskIds, claimIds) {
  await view.participant.load([
    ...taskIds.flatMap((id) =>
      view.taskContributions.get(id).map((c) => c.contributor),
    ),
    ...taskIds.flatMap((id) => view.challenges.get(id).map((c) => c.challenger)),
    ...draftPeople(view, claimIds),
  ]);
}

const selectProjectsIn = prepare(
  'SELECT * FROM projects WHERE id = ANY(?) AND NOT EXISTS (SELECT 1 FROM project_archives a WHERE a.project_id = projects.id) ORDER BY opened_at DESC',
);

/* ------------------------------------------------ projects kept in memory */

/*
 * Every read of a project loaded its tasks, answers, checks and claims from the
 * database and rebuilt them, on every call: the 2026-09-29 profile put most of
 * a request's CPU in parsing those rows. Each server keeps the rows of the
 * projects it has read, and a read uses them while the project's version
 * (project_versions, moved by every write in the same transaction) is the one
 * they were read at. One small query per read checks the versions, so a write
 * on any server is seen by the next read on every server. Members are never
 * kept: karma, tiers and roles are always read fresh. Kept rows are frozen, so
 * a read that changed one would fail rather than change it for the next.
 */
const PROJECT_KEPT = ['project', 'memberSummary', 'amendments', 'projectContributions', 'projectTasks', 'projectClaims'];
const CONTRIBUTION_KEPT = ['contribution', 'verifications'];
// Who is on a task and who passed change with every start and release, so
// they are read fresh (preloadTasks), never kept.
const TASK_KEPT = ['task', 'taskContributions', 'subtasks', 'kpiResolutions'];
const CLAIM_KEPT = ['claim', 'claimRevisions'];
const REVISION_KEPT = ['revision', 'reviews'];
const KEEP_MS = 10 * 60e3;
const KEEP_PROJECTS = 5000;
const KEEP = process.env.UAIN_KEEP_PROJECTS !== '0';

interface Kept { version: number; all: number; at: number; rows: Map<string, Map<RowKey, unknown>> }
const kept = new Map<string, Kept>();
/** How reads were served, for the tests and the load test. */
export const keptStats = { hits: 0, misses: 0 };

const selectVersions = prepare("SELECT id, version FROM project_versions WHERE id = ANY(?) OR id = '*'");

const frozen = (value) => {
  if (Array.isArray(value)) {
    for (const row of value) Object.freeze(row);
  } else if (value) Object.freeze(value);
  return Object.freeze(value);
};

/** The keys each kept table holds for a project, from what the view has. */
function keysOf(view, id) {
  const held = (name, key) => view[name].held.has(key);
  const listed = (name) => (held(name, id) ? view[name].held.get(id) ?? [] : []);
  const contributions = listed('projectContributions').map((r) => r.id);
  const tasks = listed('projectTasks').map((r) => r.id);
  const claims = listed('projectClaims').map((r) => r.id);
  const revisions = claims.flatMap((c) => (held('claimRevisions', c) ? view.claimRevisions.held.get(c) ?? [] : [])).map((r) => r.id);
  return [
    ...PROJECT_KEPT.map((name) => [name, [id]]),
    ...CONTRIBUTION_KEPT.map((name) => [name, contributions]),
    ...TASK_KEPT.map((name) => [name, tasks]),
    ...CLAIM_KEPT.map((name) => [name, claims]),
    ...REVISION_KEPT.map((name) => [name, revisions]),
  ];
}

/**
 * Put the kept rows of these projects into the view, where their versions
 * still match. Returns the versions read, for remember().
 */
async function fromMemory(view, ids) {
  if (!KEEP || !ids.length) return null;
  const versions = new Map((await selectVersions.all(ids)).map((r) => [r.id, Number(r.version)]));
  const all = versions.get('*') ?? 0;
  const now = Date.now();
  for (const id of ids) {
    const copy = kept.get(id);
    if (copy && copy.version === (versions.get(id) ?? 0) && copy.all === all && now - copy.at < KEEP_MS) {
      keptStats.hits += 1;
      for (const [name, rows] of copy.rows)
        for (const [key, value] of rows) if (!view[name].held.has(key)) view[name].held.set(key, value);
    } else keptStats.misses += 1;
  }
  return { versions, all };
}

/** Keep what the view read of these projects, at the versions read before. */
function remember(view, ids, seen) {
  if (!seen) return;
  for (const id of ids) {
    const version = seen.versions.get(id) ?? 0;
    const before = kept.get(id);
    const same = before && before.version === version && before.all === seen.all;
    const rows = same ? before.rows : new Map();
    for (const [name, keys] of keysOf(view, id)) {
      const table = rows.get(name) ?? new Map();
      for (const key of keys)
        if (!table.has(key) && view[name].held.has(key)) table.set(key, frozen(view[name].held.get(key)));
      rows.set(name, table);
    }
    kept.delete(id);
    kept.set(id, { version, all: seen.all, at: same ? before.at : Date.now(), rows });
  }
  while (kept.size > KEEP_PROJECTS) kept.delete(kept.keys().next().value);
}

/**
 * What a member's menu reads about its projects: their work, not their
 * member lists or amendments, which a project with thousands of members
 * would make the costliest part of every "what next".
 */
async function preloadWork(view, ids) {
  const seen = await fromMemory(view, ids);
  await Promise.all([
    view.project.load(ids),
    view.projectContributions.load(ids),
    view.projectTasks.load(ids),
    view.projectClaims.load(ids),
  ]);
  const taskIds = ids.flatMap((id) => view.projectTasks.get(id)).map((t) => t.id);
  const claimIds = ids.flatMap((id) => view.projectClaims.get(id)).map((c) => c.id);
  await Promise.all([
    preloadContributions(
      view,
      ids.flatMap((id) => view.projectContributions.get(id)),
    ),
    preloadTasks(view, taskIds, { people: false }),
    preloadClaims(view, claimIds),
  ]);
  await preloadPeople(view, taskIds, claimIds);
  remember(view, ids, seen);
}

/**
 * Everything a read of these projects needs, in a fixed number of queries.
 * `people: false` leaves out who is on each task and who passed, which the
 * summaries (summarise) never show.
 */
async function preloadProjects(view, ids, { people = true } = {}) {
  const seen = await fromMemory(view, ids);
  await Promise.all([
    view.project.load(ids),
    view.memberSummary.load(ids),
    view.amendments.load(ids),
    view.projectContributions.load(ids),
    view.projectTasks.load(ids),
    view.projectClaims.load(ids),
  ]);
  const taskIds = ids.flatMap((id) => view.projectTasks.get(id)).map((t) => t.id);
  const claimIds = ids.flatMap((id) => view.projectClaims.get(id)).map((c) => c.id);
  await Promise.all([
    preloadContributions(
      view,
      ids.flatMap((id) => view.projectContributions.get(id)),
    ),
    preloadTasks(view, taskIds, { people }),
    preloadClaims(view, claimIds),
  ]);
  await preloadPeople(view, taskIds, claimIds);
  remember(view, ids, seen);
}

/* ------------------------------------------------------- lists, in pages */

/**
 * The directory, projects and contributions used to be served whole, and the
 * website polls them every five seconds, filtering and sorting in the browser.
 * At a few projects that was 900 KB a poll; at thousands it would not fit in
 * a response at all. Lists now come a page at a time, filtered and sorted by
 * the server exactly as the website's tables did it, with the total so a
 * table can still say "11–20 of 312".
 */
export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** A page request, clamped. `page` counts from 1. */
export function pageOf({ page, pageSize }: { page?: number; pageSize?: number } = {}) {
  const size = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(Number(pageSize)) || PAGE_SIZE),
  );
  const n = Math.max(1, Math.trunc(Number(page)) || 1);
  return { page: n, pageSize: size, offset: (n - 1) * size };
}

/** What a paged answer says about itself. `count` is every match, not the page. */
const paged = (total, { page, pageSize }) => ({
  count: total,
  page,
  page_size: pageSize,
  pages: Math.max(1, Math.ceil(total / pageSize)),
});

/** A search term for LIKE, with its wildcards taken literally. */
const likeTerm = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/*
 * The website reads an unknown state as "negotiating" and an unknown
 * reachability as "agent" (the records come from an open endpoint). The
 * filters and the standing sort read them the same way.
 */
const STANDING = `CASE WHEN state IN ('active', 'negotiating', 'hold', 'revoked', 'unreachable')
  THEN state ELSE 'negotiating' END`;
const REACH = `CASE WHEN reachability IN ('cloud-api', 'gateway', 'agent', 'edge')
  THEN reachability ELSE 'agent' END`;
// Ties keep the newest first, as the website's stable sort over the old
// newest-first list did.
const DIRECTORY_SORTS = {
  newest: 'enrolled_at DESC, id',
  name: 'lower(name), enrolled_at DESC, id',
  // Match withMembers: the cards show the sum across a member's systems,
  // including withdrawn ones. Unclaimed systems retain their own score.
  karma: `CASE WHEN member_id IN (SELECT id FROM members)
    THEN (SELECT SUM(sibling.karma) FROM participants sibling
      WHERE sibling.member_id = participants.member_id)
    ELSE karma END DESC, enrolled_at DESC, id`,
  standing: `array_position(ARRAY['active', 'negotiating', 'hold', 'unreachable', 'revoked'],
    ${STANDING}), enrolled_at DESC, id`,
};

/**
 * One page of the directory. `q` matches a system's name, operator, place,
 * capabilities and offers, and its member's about text; `provides` is a
 * resource class; `open` keeps only systems with a request out.
 */
export async function listDirectory({
  q = '',
  reach = null,
  standing = null,
  provides = null,
  open = false,
  sort = 'newest',
  page = undefined,
  pageSize = undefined,
} = {}) {
  const where = ["state != 'withdrawn'"];
  const params = [];
  const term = String(q ?? '').trim().toLowerCase();
  if (term) {
    const like = likeTerm(term);
    // Places are shown by label, which the database does not hold.
    // An unplaced system reads "Region not declared", whatever the region
    // table calls it.
    const places = Object.entries(REGIONS)
      .filter(([id, r]) => id !== 'unstated' && r.label.toLowerCase().includes(term))
      .map(([id]) => id);
    if ('region not declared'.includes(term)) places.push('unstated');
    // The member's about text is the member's, so it is matched in the same
    // query, through the members whose text holds the term.
    where.push(`(lower(name) LIKE ? OR lower(operator) LIKE ?
      OR lower(capabilities) LIKE ? OR lower(offers) LIKE ?
      OR member_id IN (SELECT id FROM members WHERE lower(about) LIKE ?)
      OR region = ANY(?) OR (region <> ALL(?) AND lower(region) LIKE ?))`);
    params.push(like, like, like, like, like, places, [...Object.keys(REGIONS), 'unstated'], like);
  }
  if (reach) {
    where.push(`${REACH} = ?`);
    params.push(String(reach));
  }
  if (standing) {
    where.push(`${STANDING} = ?`);
    params.push(String(standing));
  }
  if (provides) {
    where.push('resources LIKE ?');
    params.push(`%${JSON.stringify(String(provides))}%`);
  }
  if (open) where.push("requests <> '[]'");
  // Own keys only: sort=constructor reached Object.prototype and was a 500 (06b-6/13).
  const order = Object.hasOwn(DIRECTORY_SORTS, sort) ? DIRECTORY_SORTS[sort] : DIRECTORY_SORTS.newest;
  const pg = pageOf({ page, pageSize });
  const filter = where.join(' AND ');
  const [rows, total] = await Promise.all([
    query(
      `SELECT * FROM participants WHERE ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...params, pg.pageSize, pg.offset],
    ),
    query(`SELECT COUNT(*) AS n FROM participants WHERE ${filter}`, params),
  ]);
  return {
    ...paged(total.rows[0].n, pg),
    participants: await withMembers(rows.rows.map(hydrate)),
  };
}

/**
 * Members for a page of agents, in two queries however long the page: the
 * members, and their karma summed over all their agents.
 */
export async function withMembers(list) {
  const ids = [...new Set(list.map((p) => p.member_id).filter(Boolean))];
  if (ids.length === 0) return list.map((p) => ({ ...p, member: null }));
  const [ms, sums] = await Promise.all([
    query('SELECT * FROM members WHERE id = ANY(?)', [ids]),
    query(
      'SELECT member_id, COALESCE(SUM(karma), 0) AS karma, COUNT(*) AS n FROM participants WHERE member_id = ANY(?) GROUP BY member_id',
      [ids],
    ),
  ]);
  const byId = new Map(ms.rows.map((m) => [m.id, m]));
  const sum = new Map(sums.rows.map((r) => [r.member_id, r]));
  return list.map((p) => {
    const m = byId.get(p.member_id);
    return {
      ...p,
      member: m
        ? {
            address: m.id,
            name: m.name,
            about: m.about ?? null,
            public_key: m.public_key,
            karma: Number(sum.get(m.id)?.karma ?? 0),
            instances: Number(sum.get(m.id)?.n ?? 0),
            licence: licenceOf(m),
            created_at: m.created_at,
          }
        : null,
    };
  });
}

/**
 * Every system's place on the globe, and nothing else. Capped: past a few
 * thousand markers a globe shows a blur, not systems, so the active and most
 * recently seen come first and the rest are counted.
 */
const MAP_LIMIT = 2000;
// Every board refreshes it every five seconds, and each one sorted every
// member (1.4 s on 40,000 under load): worked out once for every server,
// 15 s at a time. A new system shows on the globe within that.
const MAP_TTL_MS = 15_000;
const MAP_LOCK = 4_202_614;
const sharedMap = sharedResult('directory-map', MAP_LOCK, MAP_TTL_MS, () => workOutMap(MAP_LIMIT));
export async function directoryMap(limit = MAP_LIMIT) {
  return limit === MAP_LIMIT ? await sharedMap() : await workOutMap(limit);
}

async function workOutMap(limit) {
  const [rows, totals] = await Promise.all([
    query(
      `SELECT id, name, operator, region, lon, lat, state, tier, karma,
              reachability, protocols
       FROM participants WHERE state != 'withdrawn'
       ORDER BY (state = 'active') DESC, last_seen_at DESC, id LIMIT ?`,
      [limit],
    ),
    query(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE region = 'unstated') AS unplaced
       FROM participants WHERE state != 'withdrawn'`,
    ),
  ]);
  return {
    total: totals.rows[0].total,
    unplaced: totals.rows[0].unplaced,
    participants: rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      operator: r.operator,
      region: r.region,
      region_label: REGIONS[r.region]?.label ?? r.region,
      placed: r.region !== 'unstated',
      lon: r.region === 'unstated' ? null : r.lon,
      lat: r.region === 'unstated' ? null : r.lat,
      state: r.state,
      tier: r.tier,
      karma: r.karma,
      reachability: r.reachability,
      protocols: JSON.parse(r.protocols),
    })),
  };
}

/* Projects are summarised from their tasks, claims and contributions, which
 * only a full read has. The summaries are kept until the ledger moves: every
 * write that can change one records an entry, so a new head means rebuild,
 * and every copy of the server agrees on the head without being told. */
const PROJECT_STATUS_LABEL = {
  proposal: 'Proposal',
  open: 'Open',
  in_progress: 'In progress',
  finished: 'Finished',
  halted: 'Halted',
};
const PROJECT_STATUS_ORDER = ['in_progress', 'open', 'proposal', 'halted', 'finished'];
let summaryCache = { head: -1, projects: -1, at: 0, rows: [] };
let rebuilding = null;
// Under load the ledger moves many times a second, and a rebuild reads every
// project whole, so counts may lag the ledger by this much. A project opened
// or removed shows at once.
const SUMMARY_MIN_AGE_MS = 2_000;
// An operator's purge redacts entries rather than adding one, so the cache
// also lapses on its own.
const SUMMARY_MAX_AGE_MS = 60_000;
const selectProjectCount = prepare('SELECT COUNT(*) AS n FROM projects WHERE NOT EXISTS (SELECT 1 FROM project_archives a WHERE a.project_id = projects.id)');

function summarise(p) {
  const { contributions, amendments, members, ...rest } = p;
  // A basis can run to pages; a summary says only whether there is one
  // (novelty), and the whole project carries it.
  delete rest.prior_art;
  rest.benevolence = { class: p.benevolence.class };
  return {
    ...rest,
    member_count: members.count,
    contribution_count: contributions.length,
    held: contributions.filter((c) => PENDING.has(c.state)).length,
    karma_awarded: contributions.reduce((t, c) => t + (c.karma_awarded ?? 0), 0),
    amendment_count: amendments.length,
    // Kept for the search, not sent. Members are searched in the database
    // (listProjectSummaries): a project's members can run to thousands.
    haystack: [
      p.title,
      p.summary,
      p.lead,
      PROJECT_STATUS_LABEL[p.progress.status],
      ...p.stop_conditions,
    ]
      .join(' ')
      .toLowerCase(),
  };
}

async function projectSummaries() {
  const [head, projects] = await Promise.all([
    selectHeadId.get().then((r) => r.id ?? 0),
    selectProjectCount.get().then((r) => r.n),
  ]);
  const age = Date.now() - summaryCache.at;
  const stale =
    summaryCache.projects !== projects ||
    (summaryCache.head !== head && age >= SUMMARY_MIN_AGE_MS) ||
    age > SUMMARY_MAX_AGE_MS;
  if (stale) {
    // Requests arriving together share one rebuild.
    rebuilding ??= freshSummaries(head, projects).finally(() => {
      rebuilding = null;
    });
    await rebuilding;
  }
  return summaryCache.rows;
}

/*
 * A rebuild reads every project whole, members and all. Each server rebuilt
 * its own every two seconds under load, which was a quarter of the database's
 * time on the 2026-09-29 load test. So one server rebuilds for all
 * (shared_results) and the rest take its copy: first asking only which ledger
 * head it was built at, and fetching it whole only when it is newer than
 * theirs. While one server is rebuilding, the others serve the last copy.
 */
const SUMMARY_LOCK = 4_202_615;
const selectSummaryStamp = prepare(
  `SELECT at, (value->>'head')::bigint AS head, (value->>'projects')::bigint AS projects
   FROM shared_results WHERE key = 'project-summaries'`,
);

async function freshSummaries(head, projects) {
  const stamp = await selectSummaryStamp.get();
  const age = stamp ? Date.now() - Date.parse(stamp.at) : Infinity;
  const sameProjects = stamp && Number(stamp.projects) === projects;
  const current = sameProjects && (Number(stamp.head) === head || age < SUMMARY_MIN_AGE_MS) && age <= SUMMARY_MAX_AGE_MS;
  if (!current) {
    const built = await workOutOnce(SUMMARY_LOCK, async () => {
      // Counts only: who is on each task is dozens of rows a task at scale.
      const rows = (await listProjects({ people: false })).map(summarise);
      await upsertShared.run('project-summaries', new Date().toISOString(), JSON.stringify({ head, projects, rows }));
      return rows;
    });
    if (built) {
      summaryCache = { head, projects, at: Date.now(), rows: built };
      return;
    }
    if (!sameProjects) {
      // A project opened or removed shows at once, even while another rebuilds.
      summaryCache = { head, projects, at: Date.now(), rows: (await listProjects({ people: false })).map(summarise) };
      return;
    }
  }
  if (Number(stamp.head) === summaryCache.head && summaryCache.projects === projects) {
    summaryCache = { ...summaryCache, at: Date.parse(stamp.at) };
    return;
  }
  const { at, value } = await selectShared.get('project-summaries');
  summaryCache = { head: Number(value.head), projects, at: Date.parse(at), rows: value.rows };
}

/**
 * One page of project summaries: counts where the full read has lists. The
 * whole project, with its contributions, is at getProject.
 */
const selectProjectsWithMember = prepare(
  "SELECT DISTINCT project_id FROM project_members WHERE lower(member_id) LIKE ? ESCAPE '\\'",
);

export async function listProjectSummaries({
  q = '',
  status = null,
  sort = 'newest',
  page = undefined,
  pageSize = undefined,
} = {}) {
  const term = String(q ?? '').trim().toLowerCase();
  const withMember = term
    ? new Set((await selectProjectsWithMember.all(likeTerm(term))).map((r) => r.project_id))
    : null;
  const rows = (await projectSummaries()).filter(
    (p) =>
      (!term || p.haystack.includes(term) || withMember.has(p.id)) &&
      (!status || p.progress.status === status),
  );
  const by = {
    activity: (a, b) => b.contribution_count - a.contribution_count,
    karma: (a, b) => b.karma_awarded - a.karma_awarded,
    state: (a, b) =>
      PROJECT_STATUS_ORDER.indexOf(a.progress.status) -
      PROJECT_STATUS_ORDER.indexOf(b.progress.status),
    title: (a, b) => a.title.localeCompare(b.title),
    newest: (a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at),
  };
  const sorted = [...rows].sort(by[sort] ?? by.newest);
  const pg = pageOf({ page, pageSize });
  return {
    ...paged(sorted.length, pg),
    projects: sorted
      .slice(pg.offset, pg.offset + pg.pageSize)
      .map(({ haystack, ...p }) => p),
  };
}

/**
 * One page of contributions, newest first, with their checks. `brief` keeps
 * what a list row shows and drops the write-ups and checkers' notes, which
 * run to kilobytes each.
 */
const brief = (c) => ({
  id: c.id,
  project_id: c.project_id,
  task_id: c.task_id,
  contributor: c.contributor,
  title: c.title,
  kind: c.kind,
  state: c.state,
  karma_claimed: c.karma_claimed,
  karma_awarded: c.karma_awarded,
  novelty: c.novelty,
  ...(c.award_withheld ? { award_withheld: c.award_withheld } : {}),
  ...(c.award_pending ? { award_pending: c.award_pending } : {}),
  verifiers_required: c.verifiers_required,
  submitted_at: c.submitted_at,
  settled_at: c.settled_at,
  verifications: c.verifications.map((v) => ({
    verifier: v.verifier,
    verdict: v.verdict,
    at: v.at,
  })),
});

/** Contribution states, and the names readers used before the rename. */
const STATE_ALIASES = { disputed: 'rejected' };

export async function listContributionsPage({ page, pageSize, brief: short = false, state = null }: { page?: number; pageSize?: number; brief?: boolean; state?: string } = {}) {
  const pg = pageOf({ page, pageSize });
  const wanted = state ? (STATE_ALIASES[state] ?? state) : null;
  const where = wanted ? 'WHERE state = ?' : '';
  const args = wanted ? [wanted] : [];
  const [rows, total] = await Promise.all([
    query(
      `SELECT * FROM contributions ${where} ORDER BY submitted_at DESC, id LIMIT ? OFFSET ?`,
      [...args, pg.pageSize, pg.offset],
    ),
    query(`SELECT COUNT(*) AS n FROM contributions ${where}`, args),
  ]);
  const view = openView();
  await preloadContributions(view, rows.rows);
  const contributions = hydrateContributions(rows.rows, view);
  return {
    ...paged(total.rows[0].n, pg),
    contributions: short ? contributions.map(brief) : contributions,
  };
}

/**
 * `disputed` used to name both a verdict and the final state it can lead to,
 * though a disputed verdict often ends settled. The final state of rejected
 * work, and of a claim draft an arbiter turned down, is now `rejected`;
 * `disputed` is only ever a verdict. Rows from before are renamed here, once.
 */
const disputedLeft = prepare(
  `SELECT EXISTS (SELECT 1 FROM contributions WHERE state = 'disputed')
       OR EXISTS (SELECT 1 FROM claim_revisions WHERE state = 'disputed') AS due`,
);
export async function migrateRejected() {
  assertPilotSourceWritable();
  // Every start runs this, on both threads. The write takes the network lock
  // exclusively and moves every project's version, so every copy's kept rows
  // would go stale at each start: it writes only when a row needs renaming.
  if (!(await disputedLeft.get())?.due) return false;
  await atomically(async () => {
    await query("UPDATE contributions SET state = 'rejected' WHERE state = 'disputed'");
    await query("UPDATE claim_revisions SET state = 'rejected' WHERE state = 'disputed'");
  });
  return true;
}
if (pilotSourceWritable()) await migrateRejected();

// Everyone from before members gets one now: at the end, once every statement
// above exists. Several server copies may start together; the write lock and
// the re-check inside make that safe.
if (pilotSourceWritable()) {
  const made = await adoptLegacyMembers();
  if (made) console.log(`made ${made} member(s) for agents from before members`);
}

// The karma ledger starts complete (application/karma-ledger.ts): karma
// changes announced before it existed become rows, and what they cannot
// account for an opening balance per agent. Does nothing once done.
if (pilotSourceWritable()) {
  const filled = await backfillKarmaEvents();
  if (filled.rows || filled.opening)
    console.log(`karma ledger: ${filled.rows} row(s) backfilled from the ledger, ${filled.opening} opening balance(s)`);
}

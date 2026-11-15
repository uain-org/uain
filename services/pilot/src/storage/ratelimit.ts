import { prepare } from './store.ts';

/**
 * Fixed-window counters, kept in PostgreSQL so that every copy of the server
 * counts against the same window: with the counts in each process's memory,
 * four copies would each allow a caller its full budget. The table is
 * UNLOGGED, fast and lost on a database crash, which errs toward letting
 * callers in, as a restart always has.
 *
 * Two budgets matter. Requests keep one caller from starving everyone else.
 * Enrolments are the one that protects the record: free, anonymous enrolment
 * is how one operator mints a crowd of verifiers.
 */
const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const RATE_LIMITS = {
  requests: {
    limit: envInt('UAIN_RATE_REQUESTS_PER_MIN', 600),
    windowMs: 60_000,
  },
  enrolments: {
    limit: envInt('UAIN_RATE_ENROLMENTS_PER_HOUR', 5),
    windowMs: 3_600_000,
  },
  // An agent added to a member (sign-in with new_agent) is a new record, as
  // an enrolment is. It has a budget of its own, so a member setting up its
  // agents does not use up the enrolments of everyone behind its address.
  agents: {
    limit: envInt('UAIN_RATE_AGENTS_PER_HOUR', 20),
    windowMs: 3_600_000,
  },
  // Profile updates, counted per agent: each one is a ledger entry, so an
  // agent refreshing its profile in a loop would flood the record.
  profiles: {
    limit: envInt('UAIN_RATE_PROFILE_UPDATES_PER_HOUR', 20),
    windowMs: 3_600_000,
  },
  // Wallet challenges, bindings and unbindings, counted per agent together,
  // as profile updates are: a binding is a ledger entry.
  wallets: {
    limit: envInt('UAIN_RATE_WALLET_CALLS_PER_HOUR', 20),
    windowMs: 3_600_000,
  },
  // The waitlist holds no standing, so a crowd there mints nothing; this only
  // keeps one caller from flooding the list.
  registrations: {
    limit: envInt('UAIN_RATE_REGISTRATIONS_PER_HOUR', 20),
    windowMs: 3_600_000,
  },
  // Goals proposed by humans (application/human-proposals.ts): the same
  // budget as the waitlist, counted apart, so one does not use up the other.
  donation_interests: {
    limit: envInt('UAIN_RATE_DONATION_INTERESTS_PER_HOUR', 10),
    windowMs: 3_600_000,
  },
  proposals: {
    limit: envInt('UAIN_RATE_PROPOSALS_PER_HOUR', 20),
    windowMs: 3_600_000,
  },
  // Reads that start a native proof process and name no member (13 November
  // 2026, baseline 06a-5): POST /api/native/state and /receipt, and the MCP
  // tools uain_native_state and uain_native_receipt, each MCP call counted on
  // its own so a batch of 16 is 16. Per address. A replica runs two proof
  // processes behind a short queue, so this stays small: one address must not
  // be able to starve everyone's reads.
  proofs: {
    limit: envInt('UAIN_RATE_PROOFS_PER_MIN', 30),
    windowMs: 60_000,
  },
  // Research publications (POST /api/native/evidence, uain_publish_research),
  // per address. One address carries many honest members (BAINK's server
  // publishes every member's research; hosted MCP clients share an egress
  // address), so this is larger. It is charged first, before the envelope is
  // checked, so junk is bounded by its sender's own address. There is no
  // per-member budget: signed envelopes are public, so anyone could replay a
  // member's own envelope to spend one.
  publications: {
    limit: envInt('UAIN_RATE_PUBLICATIONS_PER_MIN', 120),
    windowMs: 60_000,
  },
};

export type RateBucket = keyof typeof RATE_LIMITS;
export type RateLimitResult = { allowed: true; retryAfter?: never; limit?: never } | { allowed: false; retryAfter: number; limit: number };
const bump = prepare<{ started: number; count: number }>(
  `INSERT INTO rate_windows (id, started, count) VALUES (?, ?, 1)
   ON CONFLICT (id) DO UPDATE SET
     started = CASE WHEN rate_windows.started <= ? THEN EXCLUDED.started
                    ELSE rate_windows.started END,
     count = CASE WHEN rate_windows.started <= ? THEN 1
                  ELSE rate_windows.count + 1 END
   RETURNING started, count`,
  { pooled: true },
);

/*
 * The request budget is counted on every request, and one statement each was
 * a sixteenth of the database's time under load (2026-09-29). So each server
 * counts its own hits and adds them to the shared window every SYNC_MS, in one
 * statement, learning the others' counts as it does. A caller spread across
 * servers may overrun its budget by what the others counted since their last
 * sync, a second's worth at most; the budget only keeps one caller from
 * starving the rest. Enrolments and registrations stay exact, one statement
 * each: they are what keeps one operator from minting a crowd.
 */
const SYNC_MS = 1_000;
const counted = new Map<string, { started: number; shared: number; unsent: number }>();
let syncTimer: NodeJS.Timeout | null = null;
const addCounts = prepare<{ id: string; started: number; count: number }>(
  `INSERT INTO rate_windows (id, started, count)
   SELECT * FROM unnest(?::text[], ?::bigint[], ?::bigint[])
   ON CONFLICT (id) DO UPDATE SET
     started = CASE WHEN rate_windows.started <= ? THEN EXCLUDED.started
                    ELSE rate_windows.started END,
     count = CASE WHEN rate_windows.started <= ? THEN EXCLUDED.count
                  ELSE rate_windows.count + EXCLUDED.count END
   RETURNING id, started, count`,
  { pooled: true },
);

// Every caller waits for earlier writes, even after they cleared unsent.
// Queue another batch so hits arriving during a write are included by the
// next awaited sync. Failed batches restore their counts before it starts.
let syncTail: Promise<void> = Promise.resolve();
export function syncCounts(): Promise<void> {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  const pending = syncTail.then(flushCounts);
  syncTail = pending.catch(() => {});
  return pending;
}

/** Add this server's hits since the last sync to the shared windows. */
async function flushCounts() {
  const due = [...counted].filter(([, w]) => w.unsent > 0);
  if (!due.length) return;
  const sent = due.map(([, w]) => w.unsent);
  for (const [, w] of due) w.unsent = 0;
  const expired = Date.now() - RATE_LIMITS.requests.windowMs;
  try {
    const rows = await addCounts.all(due.map(([id]) => id), due.map(([, w]) => w.started), sent, expired, expired);
    for (const r of rows) {
      const w = counted.get(r.id);
      if (w) Object.assign(w, { started: Number(r.started), shared: Number(r.count) });
    }
  } catch (e) {
    // Not lost: counted again with the next sync.
    due.forEach(([, w], i) => (w.unsent += sent[i]));
    console.error('rate limits:', e.message);
  }
}

function hitCounted(key: string): RateLimitResult {
  const { limit, windowMs } = RATE_LIMITS.requests;
  const t = Date.now();
  const id = `requests:${key}`;
  let w = counted.get(id);
  if (!w || w.started <= t - windowMs) {
    w = { started: t, shared: 0, unsent: 0 };
    counted.set(id, w);
  }
  w.unsent += 1;
  syncTimer ??= setTimeout(() => void syncCounts(), SYNC_MS);
  if (w.shared + w.unsent <= limit) return { allowed: true };
  return {
    allowed: false,
    retryAfter: Math.max(1, Math.ceil((w.started + windowMs - t) / 1000)),
    limit,
  };
}

/**
 * Count one hit against `bucket` for `key`. Returns whether it is allowed and,
 * when it is not, how many seconds until the window resets. For enrolments and
 * registrations one statement, so two copies counting the same caller at once
 * cannot both see a free slot.
 */
export async function hit(bucket: RateBucket, key: string): Promise<RateLimitResult> {
  if (bucket === 'requests') return hitCounted(key);
  const { limit, windowMs } = RATE_LIMITS[bucket];
  const t = Date.now();
  const expired = t - windowMs;
  const w = await bump.get(`${bucket}:${key}`, t, expired, expired);
  if (w.count <= limit) return { allowed: true };
  return {
    allowed: false,
    retryAfter: Math.max(1, Math.ceil((w.started + windowMs - t) / 1000)),
    limit,
  };
}

// Expired windows would otherwise accumulate one row per caller forever.
const longest = Math.max(...Object.values(RATE_LIMITS).map((b) => b.windowMs));
const sweep = prepare('DELETE FROM rate_windows WHERE started < ?', {
  pooled: true,
});
setInterval(() => {
  sweep.run(Date.now() - longest).catch(() => {});
  // This server's own counts, once their window has passed.
  const expired = Date.now() - RATE_LIMITS.requests.windowMs;
  for (const [id, w] of counted) if (w.started <= expired && !w.unsent) counted.delete(id);
}, 600_000).unref();

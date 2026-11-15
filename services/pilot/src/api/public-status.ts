/**
 * What is working, for the website's /status page (GET /api/status,
 * 10 November 2026).
 *
 * It reports this server's own readiness and what BAINK already publishes:
 * its health, its reviewer's health and, once BAINK serves it, the public
 * review queue (GET /api/public/review-queue). BAINK refuses reads from
 * another site's pages, so a visitor's browser cannot ask it directly; this
 * server asks instead.
 *
 * Compute is short (ruling of 10 November 2026): no timer and no loop. BAINK
 * is asked only when someone opens the page and the answer held is older than
 * STATUS_TTL_MS; everyone in that minute gets the same answer, and at most one
 * question is in flight per copy. A failed read is reported as "not known",
 * never as healthy, and a figure BAINK does not publish is left out.
 */
export const STATUS_TTL_MS = 60_000;
const BAINK_ORIGIN = 'https://baink.money';
const MAX_BYTES = 64 * 1024;

type Fetch = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' },
) => Promise<{ status: number; text(): Promise<string> }>;
type Read = { ok: boolean; status: number | null; body: Record<string, unknown> | null; error?: string };

async function readJson(url: string, fetcher: Fetch): Promise<Read> {
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(4000),
      // A redirect from BAINK is a fault, never a place to follow (P2-6).
      redirect: 'error',
      headers: { accept: 'application/json', 'user-agent': 'uain-status-page' },
    });
    const text = await response.text();
    if (text.length > MAX_BYTES) return { ok: false, status: response.status, body: null, error: 'answer too large' };
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const record =
      body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    if (response.status !== 200) return { ok: false, status: response.status, body: record, error: `answered ${response.status}` };
    return record ? { ok: true, status: 200, body: record } : { ok: false, status: 200, body: null, error: 'unreadable answer' };
  } catch (e) {
    return {
      ok: false,
      status: null,
      body: null,
      error: (e as Error)?.name === 'TimeoutError' ? 'no answer in 4 seconds' : 'could not be reached',
    };
  }
}

const flag = (v: unknown) => (typeof v === 'boolean' ? v : null);
const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const text = (v: unknown, max = 400) => (typeof v === 'string' && v.length <= max ? v : null);

/** BAINK's public review queue, when it publishes one (status "available"); null otherwise. */
export function reviewQueue(read: Read): Record<string, unknown> | null {
  const b = read.ok ? read.body : null;
  if (!b || b.status !== 'available' || count(b.waiting) === null) return null;
  return {
    waiting: count(b.waiting),
    oldest_since: text(b.oldestSince, 40),
    as_of: text(b.asOf, 40),
    note: text(b.note),
  };
}

let held: { at: number; value: Record<string, unknown> } | null = null;
let asking: Promise<Record<string, unknown>> | null = null;

async function askBaink(fetcher: Fetch, origin: string, now: () => number) {
  const [health, review, queue] = await Promise.all([
    readJson(origin + '/api/health', fetcher),
    readJson(origin + '/api/native/review/health', fetcher),
    readJson(origin + '/api/public/review-queue', fetcher),
  ]);
  const broker = (review.body?.broker as { payload?: Record<string, unknown> } | undefined)?.payload ?? null;
  const available = flag(review.body?.available),
    brokerReady = flag(review.body?.brokerReady),
    rootReady = flag(broker?.rootReady ?? review.body?.rootReady);
  const value = {
    checked_at: new Date(now()).toISOString(),
    baink: {
      ok: health.ok ? health.body?.ok === true : null,
      storage: text(health.body?.storage, 40),
      ...(health.error ? { problem: health.error } : {}),
    },
    review: {
      // Reviewer readiness needs all three flags (docs-crucial/known-pitfalls.md, section 4).
      ok: review.ok ? available === true && brokerReady === true && rootReady === true : null,
      available,
      broker_ready: brokerReady,
      root_ready: rootReady,
      ...(review.error ? { problem: review.error } : {}),
    },
    review_queue: reviewQueue(queue),
  };
  held = { at: now(), value };
  return value;
}

export async function publicStatus({
  ready,
  fetcher = fetch as unknown as Fetch,
  now = Date.now,
  env = process.env,
}: {
  ready: () => Promise<boolean>;
  fetcher?: Fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
}) {
  let uain: boolean | null = null;
  try {
    uain = await ready();
  } catch {
    uain = null;
  }
  const origin = /^https:\/\/[a-z0-9.-]+$/.test(env.UAIN_STATUS_BAINK_ORIGIN ?? '')
    ? env.UAIN_STATUS_BAINK_ORIGIN!
    : BAINK_ORIGIN;
  const fresh = held && now() - held.at < STATUS_TTL_MS;
  const outside = fresh
    ? held!.value
    : await (asking ??= askBaink(fetcher, origin, now).finally(() => {
        asking = null;
      }));
  return {
    uain: { ok: uain, checked_at: new Date(now()).toISOString() },
    ...outside,
    held_for_seconds: STATUS_TTL_MS / 1000,
  };
}

/** Forget the held answer (tests). */
export function resetPublicStatus() {
  held = null;
  asking = null;
}

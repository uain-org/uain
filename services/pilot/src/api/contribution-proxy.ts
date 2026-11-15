/**
 * A member's contribution view for the website's member profile
 * (GET /api/contribution/:address, 12 November 2026, P0-3).
 *
 * Contribution points are Karma (Rahul, 11 November 2026). BAINK derives the
 * one view every surface shows (apps/baink/shared/contribution-view.mjs) and
 * publishes it at GET https://baink.money/api/public/contribution/<address>.
 * BAINK refuses reads from another site's pages, so a visitor's browser cannot
 * ask it directly; this server asks instead and passes the answer on
 * unchanged. Nothing is derived or recomputed here.
 *
 * Compute is short (K-50): no timer and no loop. BAINK is asked only when a
 * profile is opened and the answer held for that address is older than
 * CONTRIBUTION_TTL_MS; one question per address is in flight at a time, at
 * most MAX_FLIGHTS at once, and at most MAX_HELD answers are held. A failed
 * read answers "unavailable", never an empty record.
 */
export const CONTRIBUTION_TTL_MS = 30_000;
const BAINK_ORIGIN = 'https://baink.money';
const MAX_BYTES = 256 * 1024;
const MAX_HELD = 512;
const MAX_FLIGHTS = 8;
const ADDRESS = /^uain1[a-f0-9]{40}$/;

type Fetch = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' },
) => Promise<{ status: number; text(): Promise<string> }>;
type Answer = { status: number; body: Record<string, unknown> };

const held = new Map<string, { at: number; answer: Answer }>();
const flights = new Map<string, Promise<Answer>>();

const unavailable = (why: string): Answer => ({
  status: 503,
  body: { error: 'contribution_unavailable', message: `The contribution record could not be read just now (${why}). Try again in a minute.` },
});

async function ask(address: string, fetcher: Fetch, origin: string): Promise<Answer> {
  try {
    const response = await fetcher(`${origin}/api/public/contribution/${address}`, {
      signal: AbortSignal.timeout(28_000),
      // A redirect from BAINK is a fault, never a place to follow (P2-6).
      redirect: 'error',
      headers: { accept: 'application/json', 'user-agent': 'uain-member-profile' },
    });
    const text = await response.text();
    if (text.length > MAX_BYTES) return unavailable('answer too large');
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    if (response.status !== 200 || !record || record.schema !== 'uain-contribution-v1' || record.member !== address)
      return unavailable(response.status !== 200 ? `BAINK answered ${response.status}` : 'unreadable answer');
    return { status: 200, body: record };
  } catch (e) {
    return unavailable((e as Error)?.name === 'TimeoutError' ? 'no answer in time' : 'BAINK could not be reached');
  }
}

export async function memberContribution(
  address: string,
  {
    fetcher = fetch as unknown as Fetch,
    now = Date.now,
    env = process.env,
  }: { fetcher?: Fetch; now?: () => number; env?: Record<string, string | undefined> } = {},
): Promise<Answer> {
  if (!ADDRESS.test(address)) return { status: 400, body: { error: 'invalid_address', message: 'Give a uain1 member address.' } };
  const origin = /^https:\/\/[a-z0-9.-]+$/.test(env.UAIN_STATUS_BAINK_ORIGIN ?? '') ? env.UAIN_STATUS_BAINK_ORIGIN! : BAINK_ORIGIN;
  const kept = held.get(address);
  if (kept && now() - kept.at < CONTRIBUTION_TTL_MS) return kept.answer;
  let flight = flights.get(address);
  if (!flight) {
    if (flights.size >= MAX_FLIGHTS) return unavailable('busy');
    flight = ask(address, fetcher, origin)
      .then((answer) => {
        if (answer.status === 200) {
          held.delete(address);
          while (held.size >= MAX_HELD) held.delete(held.keys().next().value!);
          held.set(address, { at: now(), answer });
        }
        return answer;
      })
      .finally(() => flights.delete(address));
    flights.set(address, flight);
  }
  return flight;
}

/** Forget held answers (tests). */
export function resetMemberContribution() {
  held.clear();
}

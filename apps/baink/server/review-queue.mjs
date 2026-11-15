// How many submissions wait for the reviewer (10 November 2026). Public and unsigned:
// GET /api/public/review-queue, the kit's history, baink_guide's review answer and the web.
//
// A member whose review outlasted "2 to 10 minutes" could not see why. The reviewer
// starts at most `hourlyLimit` reviews per clock hour (UTC) and `dailyLimit` a day; both
// are configuration here, read from the reviewer's own settings by the operator.
//
// Built in BAINK alone from what BAINK already knows: the submissions it relayed (its
// own store) and their public ledger records. It is a cheap read: nothing runs unless
// someone asks, one answer is kept for a minute, a stale answer is served while one
// refresh runs, decided submissions are never read again, and at most MAX submissions
// (three proof reads) are looked at. No model is called.
//
// Two counts (10 November 2026, after the needs-evidence window opened): `waiting` is the
// submissions waiting for the reviewer; `awaitingAuthor` is answers the reviewer sent back for
// more evidence, which wait for their authors until a deadline, not for the reviewer. Both read
// "under review" on the ledger; a needs-evidence answer carries `evidence_deadline` and is
// back with the reviewer once its author asks for a reassessment (`reassess`).
const MAX = 96, SHOWN = 64, TTL_MS = 60_000, STALE_MS = 15 * 60_000, UNRECORDED_MS = 2 * 3600_000;
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One plain sentence about the cap; never a promised time. */
export const capText = (hourly, daily) => `The reviewer starts at most ${hourly} reviews in each clock hour (UTC) and ${daily} a day, so when many submissions arrive together a review can wait an hour or more.`;

export function createReviewQueue({ centralEarning = null, hourlyLimit = 16, dailyLimit = 128, clock = Date.now } = {}) {
  const limits = { perHour: hourlyLimit, perDay: dailyLimit, window: 'clock hour, UTC' };
  const decided = new Set();
  let cached = null, flight = null;
  const unavailable = () => ({ status: 'unavailable', limits, note: `The review queue could not be read just now. ${capText(hourlyLimit, dailyLimit)}` });

  async function read() {
    if (typeof centralEarning?.recordedSubmissions !== 'function' || typeof centralEarning.publicRecords !== 'function') return null;
    const rows = centralEarning.recordedSubmissions(MAX * 4).filter((r) => !decided.has(r.id));
    const looked = rows.slice(0, MAX);
    if (!looked.length) return { waiting: [], author: [], truncated: false };
    const answer = await centralEarning.publicRecords(looked.map((r) => 'central_submission/' + r.id));
    if (!answer) return null;
    const waiting = [], author = [], height = /^[1-9][0-9]*$/.test(answer.height ?? '') ? BigInt(answer.height) : null;
    for (const r of looked) {
      const record = answer.records['central_submission/' + r.id];
      // Sent but not recorded (yet): not in the reviewer's queue. A send that is still unrecorded after
      // two hours never will be (its signed step has expired), so it is not read again.
      if (record === null) { if (clock() - Date.parse(r.at) > UNRECORDED_MS) decided.add(r.id); continue; }
      if (record?.state === 'under_review') {
        const deadline = /^[1-9][0-9]{0,18}$/.test(record.evidence_deadline ?? '') ? record.evidence_deadline : null;
        if (deadline && record.reassess !== true) author.push({ at: r.at, deadline, passed: height !== null && height > BigInt(deadline) });
        else waiting.push(r.at);
      }
      else if (typeof record?.state === 'string') decided.add(r.id);
      if (decided.size > 20000) decided.clear();
    }
    return { waiting: waiting.sort(), author: author.sort((a, b) => a.at.localeCompare(b.at)), truncated: rows.length > looked.length, height: answer.height };
  }
  function shape(result, at) {
    const n = result.waiting.length, oldest = result.waiting[0] ?? null, author = result.author ?? [], open = author.filter((a) => !a.passed);
    const nextDeadline = open.map((a) => a.deadline).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0))[0] ?? null;
    return {
      status: 'available', waiting: n, oldestSince: oldest, waitingSince: result.waiting.slice(0, SHOWN),
      awaitingAuthor: { waiting: author.length, oldestSince: author[0]?.at ?? null, deadlinePassed: author.length - open.length, nextDeadlineHeight: nextDeadline },
      limits, asOf: new Date(at).toISOString(),
      ...(result.truncated ? { partial: true } : {}), ...(result.height ? { provedAtHeight: result.height } : {}),
      note: (n === 0 ? 'No submission is waiting for the reviewer right now.' : `${plural(n, 'submission waits', 'submissions wait')} for the reviewer${oldest ? `, the oldest since ${hhmm(Date.parse(oldest))}` : ''} (checked ${hhmm(at)}).`)
        + ` ${capText(hourlyLimit, dailyLimit)}`
        + (author.length ? ` Apart from these, ${plural(author.length, 'answer waits', 'answers wait')} for ${author.length === 1 ? 'its author' : 'their authors'} to add evidence the reviewer asked for, before a deadline; ${author.length === 1 ? 'that is' : 'those are'} not waiting for the reviewer.` : ''),
    };
  }
  function refresh() {
    flight ??= read().then((result) => { if (result) cached = { at: clock(), value: shape(result, clock()) }; return result; }, () => null).finally(() => { flight = null; });
    return flight;
  }
  return {
    limits,
    /** The figure, waiting for the first read only; afterwards the kept answer at once (refreshed behind it). */
    async figure() {
      const age = cached ? clock() - cached.at : Infinity;
      if (age < TTL_MS) return cached.value;
      if (age < STALE_MS) { refresh(); return cached.value; }
      await refresh();
      return cached && clock() - cached.at < STALE_MS ? cached.value : unavailable();
    },
    /** Never waits: the kept answer if there is one (a refresh starts when it is old), else null. */
    peek() {
      const age = cached ? clock() - cached.at : Infinity;
      if (age >= TTL_MS) refresh();
      return age < STALE_MS ? cached.value : null;
    },
  };
}

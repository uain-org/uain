/** Self-clearing sequence fence (10 November 2026).
 *
 * A member's broadcast but unreconciled central-earning intent holds that
 * member's native sequence (native-sequence-fence.mjs), so the member's
 * no-install sends wait. Until now only the member's kit cleared it, by running
 * `reconcile`. BAINK now does the same read itself, from committed, pinned chain
 * state, before a send is built and on a bounded background sweep.
 *
 * It calls the audited central-earning `reconcile` (the one the kit calls), so
 * the rules are unchanged:
 *  - it only reads: it never signs, re-signs or re-broadcasts anything;
 *  - only a native receipt for the journaled envelope (finalized) or a proved
 *    expiry (past expires_height, sequence unused, subject record absent:
 *    expired-unused) releases the fence;
 *  - a CheckTx refusal, an RPC error or elapsed time never does. A first-send
 *    refusal that names the journaled hash is recorded as `refused`, and the
 *    intent still waits for proved expiry before the sequence is reused;
 *  - the next intent is always built from fresh state by the caller.
 * Reconciling needs no member key: it reads public, proved state only. */
const SETTLED = new Set(['finalized', 'expired-unused', 'expired_unincluded']);
const ADDRESS = /^uain1[a-f0-9]{40}$/;

/** Central-earning intents of `member` that hold its sequence and can be read
 * from chain state (a journaled envelope exists). */
export function pendingCentralIntents(state, member) {
  return Object.values(state?.centralEarningIntents ?? {})
    .filter((i) => i && (i.command?.member ?? i.member) === member && i.sendAttemptedAt && i.envelope && !SETTLED.has(i.status))
    .sort((a, b) => String(a.sendAttemptedAt).localeCompare(String(b.sendAttemptedAt)));
}

function holderOf(intent) {
  const raw = typeof intent.publicKey === 'string' ? Buffer.from(intent.publicKey, 'base64url') : Buffer.alloc(0);
  if (raw.length !== 32 || raw.toString('base64url') !== intent.publicKey || !ADDRESS.test(intent.member ?? '')) return null;
  return { address: intent.member, publicKey: raw.toString('base64') };
}

/**
 * @param store      the BAINK store ({read})
 * @param reconcile  central-earning reconcile(user, id, body): reads only
 * @param now        clock (ms)
 * @param minIntervalMs  one read per intent per interval, unless forced
 * @param maxRounds  event-scan pages per intent per call (32 events each)
 * @param maxPerCall intents per member per call
 * @param maxPerSweep intents per background sweep
 */
export function createSequenceFenceClearer({ store, reconcile, now = () => Date.now(), minIntervalMs = 15000, maxRounds = 4, maxPerCall = 4, maxPerSweep = 8 }) {
  if (typeof reconcile !== 'function') throw new TypeError('reconcile is required');
  const lastRead = new Map(), inflight = new Map();

  async function settle(intent) {
    const user = holderOf(intent);
    if (!user) return { id: intent.id, status: intent.status, error: 'invalid_holder' };
    lastRead.set(intent.id, now());
    let status = intent.status;
    for (let round = 0; round < maxRounds; round++) {
      let reply;
      try { reply = await reconcile(user, intent.id, {}); } catch (error) { return { id: intent.id, status, error: error?.code ?? 'error' }; }
      status = reply?.intent?.status ?? status;
      if (SETTLED.has(status) || reply?.intent?.moreEvents !== true) break;
    }
    if (SETTLED.has(status)) lastRead.delete(intent.id);
    return { id: intent.id, status, settled: SETTLED.has(status) };
  }

  async function run(intents, force) {
    const out = [];
    for (const intent of intents) {
      const at = lastRead.get(intent.id);
      if (!force && at !== undefined && now() - at < minIntervalMs) { out.push({ id: intent.id, status: intent.status, skipped: 'recently-read' }); continue; }
      out.push(await settle(intent));
    }
    if (lastRead.size > 10000) for (const key of [...lastRead.keys()].slice(0, lastRead.size - 10000)) lastRead.delete(key);
    return out;
  }

  const service = {
    /** Reconcile this member's held central-earning intents now. Returns true
     * when nothing of central earning still holds the member's sequence. One
     * read at a time per member; concurrent callers share it. */
    async clear(member, { force = false } = {}) {
      if (!ADDRESS.test(member ?? '')) return false;
      if (inflight.has(member)) return inflight.get(member);
      const job = (async () => {
        const pending = pendingCentralIntents(store.read(), member).slice(0, maxPerCall);
        if (pending.length) await run(pending, force);
        return pendingCentralIntents(store.read(), member).length === 0;
      })().finally(() => inflight.delete(member));
      inflight.set(member, job);
      return job;
    },
    /** Background: settle the oldest held intents across all members. */
    async sweep() {
      const state = store.read(), all = Object.values(state.centralEarningIntents ?? {});
      const members = [...new Set(all.map((i) => i?.command?.member ?? i?.member).filter((m) => ADDRESS.test(m ?? '')))];
      const pending = members.flatMap((m) => pendingCentralIntents(state, m)).sort((a, b) => String(a.sendAttemptedAt).localeCompare(String(b.sendAttemptedAt))).slice(0, maxPerSweep);
      return run(pending, false);
    },
  };
  return Object.freeze(service);
}

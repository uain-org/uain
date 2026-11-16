import { atomically, prepare, query } from '../storage/store.ts';
import { record } from './db.ts';
import { keySignedAgentRun, verifiedPublicAgentRun } from './agent-run-proof.ts';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const existingRun = prepare<{
  topic: string; status: string; public_url: string | null; first_seen_at: string; updated_at: string;
}>(`SELECT topic, status, public_url, first_seen_at, updated_at
  FROM agent_runs WHERE participant_id = ? AND source = ? AND external_id = ?`);

const upsertRun = prepare(`INSERT INTO agent_runs (
    participant_id, source, external_id, topic, status, public_url, consent_at, first_seen_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (participant_id, source, external_id) DO UPDATE SET
    topic = EXCLUDED.topic, status = EXCLUDED.status,
    public_url = EXCLUDED.public_url, consent_at = EXCLUDED.consent_at,
    updated_at = EXCLUDED.updated_at`);

const memberKeyOf = prepare<{ address: string; public_key: string | null }>(
  `SELECT m.id AS address, m.public_key FROM participants p
    JOIN members m ON m.id = p.member_id WHERE p.id = ?`);

/**
 * Two ways in. An envelope with `key_signature` is signed with the agent's
 * member key, for this server (`audience`), and may come from any system.
 * One with `signature` is Synapse's HMAC over the shared secret, as before.
 */
export async function saveAgentRun(participantId: string, envelope: unknown, audience: string | null = null) {
  const keyed = !!envelope && typeof envelope === 'object' && 'key_signature' in envelope;
  const verified = keyed
    ? keySignedAgentRun(envelope, (await memberKeyOf.get(participantId)) ?? null, audience)
    : verifiedPublicAgentRun(envelope);
  if ('error' in verified) return { error: verified.error };
  const input = verified.payload;
  if (input.participant_id !== participantId) return { error: 'participant_mismatch' };
  return await atomically(async () => {
    const previous = await existingRun.get(participantId, input.source, input.external_id);
    if (previous && TERMINAL.has(previous.status) && previous.status !== input.status)
      return { error: 'terminal_run' };
    const topic = input.topic.trim();
    const publicUrl = input.public_url ?? null;
    if (previous?.topic === topic && previous.status === input.status && previous.public_url === publicUrl)
      return { ok: true, changed: false };
    const at = new Date().toISOString();
    await upsertRun.run(
      participantId, input.source, input.external_id, topic, input.status,
      publicUrl, input.consent_at, previous?.first_seen_at ?? at, at,
    );
    await record('agent_run', participantId, `${input.source} research ${input.status}: ${topic}`);
    return { ok: true, changed: true };
  }, 'agent-run');
}

export async function listAgentRuns(participantId: string | null, limit = 50) {
  const bounded = Math.max(1, Math.min(200, limit));
  const result = await query<{
    participant_id: string; participant_name: string; member_id: string | null;
    source: string; external_id: string; topic: string; status: string;
    public_url: string | null; consent_at: string; first_seen_at: string; updated_at: string;
  }>(`SELECT ar.participant_id, p.name AS participant_name, p.member_id,
      ar.source, ar.external_id, ar.topic, ar.status, ar.public_url,
      ar.consent_at, ar.first_seen_at, ar.updated_at
    FROM agent_runs ar JOIN participants p ON p.id = ar.participant_id
    WHERE (?::text IS NULL OR ar.participant_id = ?)
    ORDER BY ar.updated_at DESC LIMIT ?`, [participantId, participantId, bounded]);
  return result.rows;
}

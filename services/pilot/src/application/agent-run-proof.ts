import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

const STATES = new Set(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A system's own name for itself as a source: synapse, enlightenment, neuroetch. */
const SOURCE = /^[a-z][a-z0-9-]{1,39}$/;
/** An Ed25519 signature, 64 bytes in base64url. */
const KEY_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

/**
 * A run's fields. Synapse's shared-secret envelope names only `synapse`; a run
 * signed with the member's own key may name any system (`anySource`).
 */
export function validateAgentRun(input: unknown, { anySource = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'invalid_body';
  const row = input as Record<string, unknown>;
  if (anySource ? typeof row.source !== 'string' || !SOURCE.test(row.source) : row.source !== 'synapse')
    return 'unsupported_source';
  if (typeof row.participant_id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(row.participant_id))
    return 'invalid_participant_id';
  if (typeof row.external_id !== 'string' || !UUID.test(row.external_id)) return 'invalid_external_id';
  if (typeof row.topic !== 'string' || !row.topic.trim() || [...row.topic].length > 200 || /[\x00-\x1f]/.test(row.topic))
    return 'invalid_topic';
  if (typeof row.status !== 'string' || !STATES.has(row.status)) return 'invalid_status';
  if (typeof row.consent_at !== 'string' || !Number.isFinite(Date.parse(row.consent_at)) ||
      Date.parse(row.consent_at) > Date.now() + 300_000) return 'invalid_consent_at';
  if (row.public_url != null) {
    if (typeof row.public_url !== 'string' || row.public_url.length > 500) return 'invalid_public_url';
    try {
      const url = new URL(row.public_url);
      if (url.protocol !== 'https:' || url.username || url.password) return 'invalid_public_url';
    } catch {
      return 'invalid_public_url';
    }
  }
  return null;
}

/** The paired Synapse server signs only records whose owner opted in. UAIN
 * does not accept a bare agent assertion that a private topic is public. */
export function verifiedPublicAgentRun(raw: unknown, secret = process.env.UAIN_SYNAPSE_SHARED_SECRET) {
  if (!secret || secret.length < 32) return { error: 'integration_disabled' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_envelope' };
  const envelope = raw as Record<string, unknown>;
  if (typeof envelope.signature !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.signature))
    return { error: 'invalid_signature' };
  const invalid = validateAgentRun(envelope.payload);
  if (invalid) return { error: invalid };
  const expected = createHmac('sha256', secret).update(JSON.stringify(envelope.payload)).digest();
  const supplied = Buffer.from(envelope.signature, 'hex');
  if (!timingSafeEqual(expected, supplied)) return { error: 'invalid_signature' };
  return { payload: envelope.payload as {
    source: string; participant_id: string; external_id: string; topic: string; status: string;
    public_url?: string | null; consent_at: string;
  } };
}

/**
 * Exactly what a member signs to publish a run: bound to one server (its
 * origin, as sign-in proofs name it) and to the member's address, so a run
 * signed for one server or member cannot be replayed as another's.
 */
export function agentRunMessage(audience: string, address: string, payload: unknown): string {
  return `uain:agent-run:${audience}:${address}:${JSON.stringify(payload)}`;
}

/**
 * A run signed with the publishing agent's member key, the key that holds the
 * member's licence. Whoever holds it is the AI system, so its signature is the
 * system's own statement that the run is public: no shared secret with UAIN
 * is needed. `member` is the authenticated agent's member.
 */
export function keySignedAgentRun(
  raw: unknown,
  member: { address: string; public_key: string | null } | null,
  audience: string | null,
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_envelope' };
  const envelope = raw as Record<string, unknown>;
  if (typeof envelope.key_signature !== 'string' || !KEY_SIGNATURE.test(envelope.key_signature))
    return { error: 'invalid_signature' };
  const invalid = validateAgentRun(envelope.payload, { anySource: true });
  if (invalid) return { error: invalid };
  if (!member?.public_key || !audience) return { error: 'member_key_required' };
  let ok = false;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: member.public_key }, format: 'jwk' });
    ok = verify(
      null,
      Buffer.from(agentRunMessage(audience, member.address, envelope.payload)),
      key,
      Buffer.from(envelope.key_signature, 'base64url'),
    );
  } catch {
    ok = false;
  }
  if (!ok) return { error: 'invalid_signature' };
  return { payload: envelope.payload as {
    source: string; participant_id: string; external_id: string; topic: string; status: string;
    public_url?: string | null; consent_at: string;
  } };
}

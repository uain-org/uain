/** Durable intent journal and lease table. Every external or native mutation is
 * prepared here before I/O. An intent whose outcome is unknown is never re-signed
 * or blindly resent; only reconciliation against authoritative state settles it. */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ADDRESS, CATALOGUE_ID, HASH, NATIVE_ID, digest, need, plain, text } from './common.mjs';

/** prepared -> claimed -> dispatched -> confirmed | failed; claimed/dispatched may become unknown. */
export const INTENT_STATES = Object.freeze(['prepared', 'claimed', 'dispatched', 'unknown', 'confirmed', 'failed']);
const OPEN_LANE = "('claimed','dispatched','unknown')";
const INTENT_KEYS = ['id', 'projectId', 'kind', 'operation', 'payload', 'selectionDigest', 'sourceDigest', 'signer', 'expectedRevision'];

export function openJournal({ directory, now = () => Date.now() }) {
  need(typeof directory === 'string' && typeof now === 'function', 'invalid_journal_configuration');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'journal.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL;');
  db.exec(`CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
      operation TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, selection_digest TEXT NOT NULL,
      source_digest TEXT NOT NULL, signer TEXT NOT NULL, expected_revision TEXT, state TEXT NOT NULL,
      owner TEXT, envelope TEXT, receipt TEXT, failure TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS intent_lane ON intents(signer, state);
    CREATE INDEX IF NOT EXISTS intent_project ON intents(project_id, created_at);
    CREATE TABLE IF NOT EXISTS leases(key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, attempt INTEGER NOT NULL);`);
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  const find = db.prepare('SELECT * FROM intents WHERE id=?');
  const shape = (r) => r && Object.freeze({
    id: r.id, projectId: r.project_id, kind: r.kind, operation: r.operation, payload: JSON.parse(r.payload),
    payloadHash: r.payload_hash, selectionDigest: r.selection_digest, sourceDigest: r.source_digest, signer: r.signer,
    expectedRevision: r.expected_revision, state: r.state, owner: r.owner,
    envelope: r.envelope && JSON.parse(r.envelope), receipt: r.receipt && JSON.parse(r.receipt), failure: r.failure,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const load = (id) => {
    const r = find.get(id);
    need(r, 'intent_not_found');
    return r;
  };
  const move = (id, from, to, extra = {}) => {
    const r = load(id);
    need(from.includes(r.state), 'intent_state_conflict', `intent ${id} is ${r.state}`);
    const sets = ['state=?', 'updated_at=?', ...Object.keys(extra).map((k) => `${k}=?`)].join(',');
    db.prepare(`UPDATE intents SET ${sets} WHERE id=?`).run(to, now(), ...Object.values(extra), id);
    return shape(find.get(id));
  };
  return {
    /** Idempotent on the stable operation ID; a different payload under the same ID is refused. */
    prepare(intent) {
      need(plain(intent) && Object.keys(intent).every((k) => INTENT_KEYS.includes(k)), 'invalid_intent');
      const { id, projectId, kind, operation, payload, selectionDigest, sourceDigest, signer, expectedRevision = null } = intent;
      need(typeof id === 'string' && NATIVE_ID.test(id), 'invalid_intent', 'invalid intent id');
      need(CATALOGUE_ID.test(projectId) && ['native', 'paperclip'].includes(kind), 'invalid_intent');
      need(typeof operation === 'string' && /^[a-z][a-z0-9_.]{1,63}$/.test(operation) && plain(payload), 'invalid_intent');
      need(HASH.test(selectionDigest) && HASH.test(sourceDigest), 'invalid_intent');
      need(kind === 'native' ? ADDRESS.test(signer) : text(signer, 1, 96), 'invalid_intent', 'invalid signer');
      need(expectedRevision === null || text(expectedRevision, 1, 96), 'invalid_intent');
      const payloadHash = digest(payload);
      return tx(() => {
        const existing = find.get(id);
        if (existing) {
          need(existing.payload_hash === payloadHash && existing.project_id === projectId && existing.kind === kind &&
            existing.operation === operation && existing.signer === signer && existing.source_digest === sourceDigest &&
            existing.selection_digest === selectionDigest && existing.expected_revision === expectedRevision, 'intent_payload_conflict');
          return shape(existing);
        }
        const t = now();
        db.prepare(`INSERT INTO intents(id,project_id,kind,operation,payload,payload_hash,selection_digest,source_digest,signer,
          expected_revision,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`)
          .run(id, projectId, kind, operation, JSON.stringify(payload), payloadHash, selectionDigest, sourceDigest, signer, expectedRevision, t, t);
        return shape(find.get(id));
      });
    },
    /** One open intent per signer lane: serializes native sequences across all projects. */
    claim(id, owner) {
      need(text(owner, 1, 96), 'invalid_owner');
      return tx(() => {
        const r = load(id);
        need(r.state === 'prepared', 'intent_state_conflict', `intent ${id} is ${r.state}`);
        const busy = db.prepare(`SELECT id FROM intents WHERE signer=? AND state IN ${OPEN_LANE} AND id<>?`).get(r.signer, id);
        need(!busy, 'signer_lane_busy', `signer lane held by ${busy?.id}`);
        return move(id, ['prepared'], 'claimed', { owner });
      });
    },
    /** Retain the exact signed envelope BEFORE broadcasting it. */
    recordEnvelope(id, envelope) {
      need(plain(envelope), 'invalid_envelope');
      return tx(() => {
        const r = load(id);
        need(r.envelope === null, 'envelope_already_retained');
        return move(id, ['claimed'], 'dispatched', { envelope: JSON.stringify(envelope) });
      });
    },
    /** Crash/timeout after claim or dispatch: outcome is unknown until reconciled. */
    markUnknown: (id) => tx(() => move(id, ['claimed', 'dispatched'], 'unknown')),
    /**
     * observation: {found:true, proof} confirms. {found:false} returns a never-signed
     * intent to `prepared`; a signed (retained-envelope) intent stays unknown, because
     * a later inclusion is still possible. Only `expired:true` (envelope past its
     * expiry height under authoritative state) lets a signed intent fail.
     */
    reconcile(id, observation) {
      need(plain(observation) && typeof observation.found === 'boolean', 'invalid_observation');
      return tx(() => {
        const r = load(id);
        need(['claimed', 'dispatched', 'unknown'].includes(r.state), 'intent_state_conflict');
        if (observation.found) {
          need(plain(observation.proof), 'invalid_observation');
          return move(id, [r.state], 'confirmed', { receipt: JSON.stringify(observation.proof) });
        }
        if (r.envelope === null) return move(id, [r.state], 'prepared', { owner: null });
        if (observation.expired === true) return move(id, [r.state], 'failed', { failure: 'expired_unincluded' });
        return move(id, [r.state], 'unknown');
      });
    },
    recordReceipt(id, proof) {
      need(plain(proof), 'invalid_receipt');
      return tx(() => move(id, ['dispatched', 'unknown'], 'confirmed', { receipt: JSON.stringify(proof) }));
    },
    /** Unsigned intents may fail for any recorded reason. A signed (dispatched)
     * intent fails only with the node's definite rejection of that exact envelope
     * (`rejection` evidence); otherwise it must stay for reconciliation. */
    fail(id, reason, { rejection } = {}) {
      need(text(reason, 1, 400), 'invalid_failure');
      return tx(() => {
        const r = load(id);
        if (r.envelope !== null) {
          need(r.state === 'dispatched' && plain(rejection) && rejection.definite === true, 'intent_state_conflict');
          return move(id, ['dispatched'], 'failed', { failure: reason, receipt: JSON.stringify(rejection) });
        }
        return move(id, ['prepared', 'claimed'], 'failed', { failure: reason });
      });
    },
    get: (id) => shape(find.get(id)) ?? null,
    list: ({ projectId, states } = {}) => {
      const rows = projectId
        ? db.prepare('SELECT * FROM intents WHERE project_id=? ORDER BY created_at, id').all(projectId)
        : db.prepare('SELECT * FROM intents ORDER BY created_at, id').all();
      return rows.map(shape).filter((r) => !states || states.includes(r.state));
    },
    /** Exclusive, expiring work lease (e.g. one solver per task). Restart-safe. */
    acquireLease(key, owner, ttlMs) {
      need(text(key, 1, 200) && text(owner, 1, 96) && Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= 86400000, 'invalid_lease');
      return tx(() => {
        const t = now();
        const r = db.prepare('SELECT * FROM leases WHERE key=?').get(key);
        if (r && r.expires_at > t && r.owner !== owner) return null;
        const attempt = (r?.attempt ?? 0) + (r && r.owner === owner && r.expires_at > t ? 0 : 1);
        db.prepare('INSERT INTO leases(key,owner,expires_at,attempt) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at,attempt=excluded.attempt')
          .run(key, owner, t + ttlMs, attempt);
        return { key, owner, expiresAt: t + ttlMs, attempt };
      });
    },
    releaseLease(key, owner) {
      return tx(() => db.prepare('DELETE FROM leases WHERE key=? AND owner=?').run(key, owner).changes === 1);
    },
    lease: (key) => db.prepare('SELECT key, owner, expires_at AS expiresAt, attempt FROM leases WHERE key=?').get(key) ?? null,
    close: () => db.close(),
  };
}

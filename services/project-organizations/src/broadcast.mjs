/** Operator broadcast for the fleet's manager / evaluator / guardian / solver operations.
 *
 * BAINK's `broadcastCentral` (apps/baink/server/central-earning-transport.mjs) accepts only
 * `central_submit` and `project_join`, and `broadcastResearch` (native-asset.mjs) only the
 * pilot research operations. This module submits an envelope that custody has ALREADY
 * signed, for exactly the fleet operations below. It never signs, never builds a command,
 * never chooses an endpoint and never retries on its own.
 *
 * Every envelope is checked before any byte leaves the process:
 * - central operations with BAINK's `verifyCentralEnvelope` (typed payload, Ed25519 over
 *   native SigningBytes, member address bound to the public key, pinned chain id);
 * - `open_project` with `verifyOpenProjectEnvelope` from bootstrap.mjs.
 *
 * Rebroadcast is byte-identical only: one (member, sequence) lane carries one transaction
 * hash, so a re-signed or altered envelope for an already-broadcast sequence is refused
 * (`rebroadcast_not_identical`). With `requireRetained` (see `retainedInJournal`) an
 * envelope is sent only when the durable journal already retains those exact bytes.
 *
 * Wire format: the same `broadcast_tx_sync` JSON-RPC body, `JSON.stringify(envelope)` bytes,
 * 64 KiB bounds and `hash == sha256(bytes)` check as BAINK's transports and
 * ops/custody/native_admission.py `Runtime.broadcast`. The poster is injected
 * (`transport.postTx`); `createRpcTransport({rpc})` provides that poster for an operator-
 * supplied native RPC origin (public HTTPS or owned loopback, the rule BAINK's
 * `validatedConfig` applies). No production endpoint is named here.
 *
 * Outcome mapping (CheckTx of chain/app/app.go executes the command on an isolated cache, so
 * a non-zero code means this node refused to admit the transaction):
 * - code 0                       -> {accepted: true,  definite: false}; settle by reconciliation;
 * - code > 0, first send         -> {accepted: false, definite: true, rejection} for journal.fail.
 *   `broadcast_tx_sync` answers only after CheckTx, and a refused transaction is neither kept
 *   in this node's mempool nor gossiped, so those exact bytes can never be included unless
 *   someone resends them; the journal never does after a definite failure. This includes
 *   native federation refusals, which the 0.3.9 daemon reports as codespace `undefined`
 *   code 1 (Cosmos SDK ABCIInfo of an unregistered error);
 * - code > 0 on a rebroadcast, or a mempool-cache / mempool-capacity / I/O / recovered-panic
 *   code                         -> {definite: false}; the bytes may still be (or become) pending;
 * - transport failure, JSON-RPC error (e.g. "tx already exists in cache") or a reply whose
 *   hash differs                 -> throws; the outcome is unknown and only reconciliation
 *   may settle it. */
import { createHash } from 'node:crypto';
import { verifyCentralEnvelope } from '../../../apps/baink/server/central-earning-command.mjs';
import { verifyOpenProjectEnvelope } from './bootstrap.mjs';
import { OrganizationError, exactKeys, need, plain, refuse } from './common.mjs';

/** The fleet operations this transport may carry; `operations` can only narrow it. */
export const FLEET_BROADCAST_OPERATIONS = Object.freeze([
  'central_fund_plan', 'central_fund_plan_review', 'central_fund_apply', 'central_fund_decide', 'central_fund_close',
  'central_task_open', 'central_task_fund', 'central_project_start', 'central_fund_configure',
  'open_project', 'project_join', 'central_submit',
]);
export const MAX_ENVELOPE_BYTES = 65536;
const MAX_RESPONSE_BYTES = 65536;
const CHAIN = /^[A-Za-z0-9._-]{1,96}$/;
const SEQUENCE = /^(0|[1-9][0-9]{0,19})$/;
const CODESPACE = /^[A-Za-z0-9_]{0,64}$/;
/** CheckTx codes that say nothing definite about this envelope (Cosmos SDK
 * types/errors: 19 tx already in mempool cache, 20 mempool full, 39 I/O; `undefined`
 * codespace 111222 recovered panic). `undefined:1` is NOT here: on the native daemon it is
 * every federation refusal of the command (qualified on 0.3.9), a definite CheckTx refusal. */
const NOT_DEFINITE = new Set(['sdk:19', 'sdk:20', 'sdk:39', 'undefined:111222']);
const MAX_LOG = 400;
/** The node's CheckTx log, bounded and stripped of control characters (evidence only). */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const boundedLog = (log) => (typeof log === 'string' ? log.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_LOG) : '');

const transactionHashOf = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase();

/** Verifies an envelope exactly as native would accept it for one allowed operation. */
export function verifyFleetEnvelope(envelope, { chainId, operations = FLEET_BROADCAST_OPERATIONS } = {}) {
  need(exactKeys(envelope, ['command', 'public_key', 'signature']) && plain(envelope.command), 'invalid_operator_envelope');
  const c = envelope.command;
  need(c.chain_id === chainId, 'operator_envelope_chain_mismatch');
  need(typeof c.operation === 'string' && operations.includes(c.operation), 'operator_operation_not_allowed', String(c.operation).slice(0, 64));
  try {
    if (c.operation === 'open_project') verifyOpenProjectEnvelope(envelope, { chainId });
    else verifyCentralEnvelope(envelope, { chainId, operations: [c.operation] });
  } catch {
    refuse('invalid_operator_envelope', `${c.operation} envelope signature or payload refused`);
  }
  need(typeof c.sequence === 'string' && SEQUENCE.test(c.sequence), 'invalid_operator_envelope');
  return true;
}

/**
 * @param transport `{postTx({bytes, transactionHash, timeoutMs}) -> JSON-RPC response}`
 * @param chainId the chain the envelopes must be signed for
 * @param productionChainId the reviewed production pin; broadcasting to it needs `allowProduction`
 * @param operations subset of FLEET_BROADCAST_OPERATIONS
 * @param requireRetained optional `(envelope) => boolean|Promise<boolean>`; false refuses the send
 */
export function createOperatorBroadcast({
  transport, chainId, productionChainId, operations = FLEET_BROADCAST_OPERATIONS, allowProduction = false,
  requireRetained = null, maxLanes = 4096, maxTimeoutMs = 10000,
} = {}) {
  need(transport && typeof transport.postTx === 'function', 'invalid_operator_broadcast', 'transport.postTx required');
  need(typeof chainId === 'string' && CHAIN.test(chainId) && typeof productionChainId === 'string' && CHAIN.test(productionChainId),
    'invalid_operator_broadcast', 'chainId and productionChainId are required');
  need(Array.isArray(operations) && operations.length > 0 && new Set(operations).size === operations.length &&
    operations.every((op) => FLEET_BROADCAST_OPERATIONS.includes(op)), 'invalid_operator_broadcast', 'operations');
  need(requireRetained === null || typeof requireRetained === 'function', 'invalid_operator_broadcast', 'requireRetained');
  need(Number.isSafeInteger(maxLanes) && maxLanes >= 1 && maxLanes <= 1000000, 'invalid_operator_broadcast');
  need(Number.isInteger(maxTimeoutMs) && maxTimeoutMs >= 1 && maxTimeoutMs <= 60000, 'invalid_operator_broadcast');
  const allowed = Object.freeze([...operations]);
  const production = chainId === productionChainId;
  /** `${member}/${sequence}` -> transaction hash of the only bytes that lane may carry. */
  const lanes = new Map();

  /** `rebroadcast: true` marks a resend of retained bytes (e.g. after a restart lost the
   * in-memory lane), whose refusal is never definite. */
  async function broadcast(envelope, { timeoutMs = 3000, rebroadcast: resend = false } = {}) {
    need(Number.isInteger(timeoutMs) && timeoutMs >= 1 && typeof resend === 'boolean', 'invalid_operator_broadcast', 'timeoutMs');
    need(!production || allowProduction === true, 'production_broadcast_not_enabled');
    verifyFleetEnvelope(envelope, { chainId, operations: allowed });
    const bytes = Buffer.from(JSON.stringify(envelope));
    need(bytes.length <= MAX_ENVELOPE_BYTES, 'operator_envelope_too_large');
    const transactionHash = transactionHashOf(bytes);
    const c = envelope.command;
    const lane = `${c.member}/${c.sequence}`;
    const prior = lanes.get(lane);
    need(prior === undefined || prior === transactionHash, 'rebroadcast_not_identical', `lane ${lane} already carries another envelope`);
    if (requireRetained !== null) need((await requireRetained(structuredClone(envelope))) === true, 'operator_envelope_not_retained');
    const rebroadcast = resend || prior !== undefined;
    if (prior === undefined) {
      if (lanes.size >= maxLanes) lanes.delete(lanes.keys().next().value);
      lanes.set(lane, transactionHash);
    }

    let reply;
    try {
      reply = await transport.postTx({ bytes: Buffer.from(bytes), transactionHash, timeoutMs: Math.min(timeoutMs, maxTimeoutMs) });
    } catch {
      refuse('broadcast_outcome_unknown', 'native RPC did not answer');
    }
    const r = plain(reply) && plain(reply.result) ? reply.result : null;
    need(plain(reply) && reply.error === undefined && r !== null, 'broadcast_outcome_unknown', 'native RPC returned an error or no result');
    need(Number.isInteger(r.code) && r.code >= 0 && typeof r.hash === 'string' && r.hash.toUpperCase() === transactionHash,
      'broadcast_outcome_unknown', 'native RPC result differs from the sent bytes');
    const codespace = typeof r.codespace === 'string' && CODESPACE.test(r.codespace) ? r.codespace : '';
    const base = { accepted: r.code === 0, code: r.code, txHash: transactionHash, operation: c.operation, rebroadcast };
    if (r.code === 0) return { ...base, definite: false };
    const definite = !rebroadcast && !NOT_DEFINITE.has(`${codespace}:${r.code}`);
    // A first send refused by CheckTx (any code > 0) was not admitted to the mempool and consumed
    // no sequence, so its lane is released: once the journal settles that intent (definitely, or
    // by expiry) a later intent may sign this sequence. Bytes already in the mempool come back as
    // a JSON-RPC error, which throws above and keeps the lane. Qualified on the real 0.3.9 daemon,
    // where every federation refusal is codespace `undefined` code 1: a refused
    // central_task_open, failed at once in the journal, followed by central_task_fund at the
    // same manager sequence.
    if (!rebroadcast && lanes.get(lane) === transactionHash) lanes.delete(lane);
    return {
      ...base, codespace, definite,
      ...(definite ? { rejection: { definite: true, code: r.code, codespace, log: boundedLog(r.log), txHash: transactionHash, chainId, operation: c.operation } } : {}),
    };
  }

  return Object.freeze({ chainId, production, operations: allowed, broadcast });
}

/** For `journal.fail(id, reason, {rejection})`: the reason (`node_rejected:<code>`) and
 * evidence of a definite rejection, or null when the outcome must stay for reconciliation.
 * With `envelope`, the rejection must name exactly that envelope's transaction hash and
 * operation; anything else is null (not definite for this intent). */
export function definiteRejection(result, { envelope = null } = {}) {
  if (!plain(result) || result.definite !== true || !plain(result.rejection) || result.rejection.definite !== true) return null;
  const r = result.rejection;
  if (!Number.isInteger(r.code) || r.code <= 0 || r.code !== result.code || typeof r.txHash !== 'string') return null;
  if (envelope !== null) {
    if (!plain(envelope) || !plain(envelope.command)) return null;
    if (r.txHash.toUpperCase() !== transactionHashOf(Buffer.from(JSON.stringify(envelope))) || r.operation !== envelope.command.operation) return null;
  }
  return { reason: `node_rejected:${r.code}`, rejection: structuredClone(r) };
}

/** `requireRetained` predicate: the journal holds an open intent whose retained envelope
 * serializes to exactly these bytes (journal.mjs `recordEnvelope` runs before broadcast). */
export function retainedInJournal(journal) {
  need(typeof journal?.list === 'function', 'invalid_operator_broadcast', 'journal.list required');
  return (envelope) => {
    const bytes = JSON.stringify(envelope);
    return journal.list({ states: ['dispatched', 'unknown'] }).some((i) => i.envelope !== null && JSON.stringify(i.envelope) === bytes);
  };
}

/** Bounded `broadcast_tx_sync` poster for an operator-supplied native RPC origin. */
export function createRpcTransport({ rpc, fetchImpl = globalThis.fetch, id = 'uain-project-organizations' } = {}) {
  let url;
  try {
    url = new URL(rpc);
  } catch {
    refuse('invalid_native_rpc');
  }
  need(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))),
  'invalid_native_rpc', 'public HTTPS or owned loopback native RPC required');
  need(typeof fetchImpl === 'function' && typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id), 'invalid_native_rpc');
  const origin = url.origin;
  return Object.freeze({
    origin,
    async postTx({ bytes, transactionHash, timeoutMs }) {
      need(Buffer.isBuffer(bytes) && bytes.length <= MAX_ENVELOPE_BYTES && transactionHashOf(bytes) === transactionHash, 'invalid_native_rpc');
      need(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000, 'invalid_native_rpc');
      const response = await fetchImpl(origin, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'broadcast_tx_sync', params: { tx: bytes.toString('base64') } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response?.ok || !response.body) throw new OrganizationError('native_rpc_unavailable');
      const reader = response.body.getReader();
      const parts = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_RESPONSE_BYTES) throw new OrganizationError('native_rpc_response_too_large');
          parts.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    },
  });
}

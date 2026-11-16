import { hasPendingPilotSend } from './native-pilot-sequence.mjs';
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';

const SHA = /^[a-f0-9]{64}$/;
const UINT = /^(0|[1-9][0-9]{0,19})$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
export class NativeEnrolError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const refuse = (status, code, message) => {
  throw new NativeEnrolError(status, code, message);
};
const check = (condition, status, code, message) => {
  if (!condition) refuse(status, code, message);
};
function exact(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function jsonString(value) {
  check(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    ),
    400,
    'invalid_native_command',
    'Unpaired Unicode surrogate is not allowed.',
  );
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}
function nativeJSON(value) {
  if (typeof value === 'string') return jsonString(value);
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value))
    return (
      '{' +
      Object.keys(value)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map((key) => jsonString(key) + ':' + nativeJSON(value[key]))
        .join(',') +
      '}'
    );
  refuse(400, 'invalid_native_command', 'Unsupported native command value.');
}
export function nativeEnrolSigningBytes(command) {
  const fields = [
    'version',
    'chain_id',
    'member',
    'sequence',
    'expires_height',
    'operation',
    'payload',
  ];
  check(
    exact(command, fields) &&
      command.version === 1 &&
      typeof command.chain_id === 'string' &&
      /^uain1[a-f0-9]{40}$/.test(command.member) &&
      command.sequence === '0' &&
      typeof command.expires_height === 'string' &&
      /^[1-9][0-9]{0,18}$/.test(command.expires_height) &&
      BigInt(command.expires_height) <= 9223372036854775807n &&
      command.operation === 'enrol' &&
      exact(command.payload, ['name', 'operator', 'family']),
    400,
    'invalid_native_command',
    'An exact sequence-zero native enrol command is required.',
  );
  return Buffer.from(
    'uain:chain-command:v1\n{' +
      fields
        .map((field) => jsonString(field) + ':' + nativeJSON(command[field]))
        .join(',') +
      '}',
  );
}
function metadata(body) {
  check(
    exact(body, ['clientRequestId', 'name', 'operator', 'family']),
    400,
    'invalid_enrol_fields',
    'Provide only clientRequestId, name, operator and family.',
  );
  check(
    typeof body.clientRequestId === 'string' &&
      /^[A-Za-z0-9_-]{8,100}$/.test(body.clientRequestId),
    400,
    'invalid_request_id',
    'A unique enrolment request identifier is required.',
  );
  const payload = {};
  for (const [key, min, max] of [
    ['name', 2, 120],
    ['operator', 2, 200],
    ['family', 0, 100],
  ]) {
    check(
      typeof body[key] === 'string',
      400,
      'invalid_enrol_fields',
      'Enrolment profile fields must be text.',
    );
    const value = body[key].trim();
    check(
      Buffer.byteLength(value) >= min &&
        Buffer.byteLength(value) <= max &&
        !/[\u0000-\u001f\u007f]/.test(value),
      400,
      'invalid_enrol_fields',
      `${key} is outside the native profile limits.`,
    );
    jsonString(value);
    payload[key] = value;
  }
  return { clientRequestId: body.clientRequestId, payload };
}
function intentView(intent, pins) {
  const answer = structuredClone(intent);
  answer.finalized = intent.status === 'finalized';
  answer.receiptRequired =
    Boolean(intent.sendAttemptedAt) &&
    !answer.finalized &&
    intent.status !== 'expired_unincluded';
  if (answer.status === 'broadcasting') answer.status = 'unknown';
  const activation = answer.activation,
    proof = activation?.proof;
  const age = proof ? Date.now() - Date.parse(proof.headerTime) : NaN;
  if (
    activation?.verified &&
    (!proof ||
      !Number.isFinite(age) ||
      age < -60000 ||
      !Number.isInteger(proof.maxAgeSeconds) ||
      proof.maxAgeSeconds < 1 ||
      proof.maxAgeSeconds > 120 ||
      age > proof.maxAgeSeconds * 1000 ||
      proof.epoch !== pins.epoch ||
      proof.verifierSha256 !== pins.verifierSha256 ||
      (pins.chainId && proof.chainId !== pins.chainId))
  )
    answer.activation = {
      verified: false,
      status: 'proof_unavailable',
      licence: null,
      proof: null,
    };
  return answer;
}
function activation(state, proof, owner, publicKey) {
  const member = state.member;
  check(
    member?.id === owner &&
      member.public_key === publicKey &&
      UINT.test(member.sequence ?? '') &&
      BigInt(member.sequence) > 0n,
    503,
    'native_proof_unavailable',
    'The native member identity or sequence is not verified.',
  );
  return {
    verified: true,
    status:
      member.licence === 'active'
        ? 'active'
        : member.licence === 'pending'
          ? 'pending'
          : 'inactive',
    licence: member.licence,
    proof,
  };
}
export function createNativeEnrolService({ store, native, enabled = false }) {
  const view = (intent) => intentView(intent, native.pins);
  const owned = (owner, id) => {
    const intent = store.read().nativeIntents?.[id];
    check(
      intent && intent.member === owner,
      404,
      'enrol_intent_missing',
      'Enrolment intent not found.',
    );
    return intent;
  };
  async function proven(selection, deadline = Date.now() + native.timeoutMs) {
    try {
      return await native.publicState(selection, {
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
    } catch {
      refuse(
        503,
        'native_proof_unavailable',
        'A fresh independently verified native proof is unavailable.',
      );
    }
  }
  function absence(context, owner) {
    check(
      context.state.records[`member/${owner}`] === null,
      409,
      'native_member_exists',
      'This identity is already enrolled in UAIN. Refresh its native status.',
    );
    const migration = context.state.records.legacy_import;
    check(
      migration === null || migration?.status === 'ready',
      503,
      'native_migration_pending',
      'The native legacy import has not been reconciled.',
    );
    check(
      UINT.test(context.state.event_count ?? ''),
      503,
      'native_proof_unavailable',
      'The native event cursor is not verified.',
    );
  }
  function checkedEnvelope(intent, envelope, user) {
    check(
      exact(envelope, ['command', 'public_key', 'signature']),
      400,
      'invalid_native_envelope',
      'Provide only the locally signed native enrol envelope.',
    );
    const bytes = nativeEnrolSigningBytes(envelope.command),
      expected = Buffer.from(intent.signingBytesBase64, 'base64');
    check(
      bytes.equals(expected) &&
        envelope.public_key === intent.publicKey &&
        Buffer.from(user.publicKey, 'base64').toString('base64url') ===
          intent.publicKey,
      400,
      'native_envelope_mismatch',
      'The signed command or public key differs from the prepared intent.',
    );
    const signature =
      typeof envelope.signature === 'string'
        ? Buffer.from(envelope.signature, 'base64url')
        : Buffer.alloc(0);
    check(
      signature.length === 64 &&
        signature.toString('base64url') === envelope.signature &&
        verify(
          null,
          bytes,
          createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: intent.publicKey },
            format: 'jwk',
          }),
          signature,
        ),
      400,
      'invalid_native_signature',
      'A valid local member signature for the reviewed native enrolment is required.',
    );
    return {
      command: structuredClone(intent.command),
      public_key: intent.publicKey,
      signature: envelope.signature,
    };
  }
  return Object.freeze({
    enabled: enabled && native.configured,
    list(user) {
      return {
        intents: Object.values(store.read().nativeIntents ?? {})
          .filter((i) => i.member === user.address)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(view),
      };
    },
    async prepare(user, body) {
      const { clientRequestId, payload } = metadata(body),
        prior = Object.values(store.read().nativeIntents ?? {}).find(
          (i) =>
            i.member === user.address && i.clientRequestId === clientRequestId,
        );
      if (prior) {
        check(
          JSON.stringify(prior.command.payload) === JSON.stringify(payload),
          409,
          'enrol_idempotency_conflict',
          'This request identifier already refers to different enrolment details.',
        );
        if (prior.sendAttemptedAt)
          return { created: false, intent: view(prior) };
        const refreshed = await proven({ keys: [`member/${user.address}`] });
        absence(refreshed, user.address);
        check(
          refreshed.state.chain_id === prior.command.chain_id &&
            refreshed.proof.epoch === prior.proof.epoch &&
            refreshed.proof.verifierSha256 === prior.proof.verifierSha256 &&
            BigInt(refreshed.state.height) >= BigInt(prior.proof.height),
          409,
          'native_epoch_changed',
          'The prepared native proof context differs.',
        );
        check(
          BigInt(refreshed.state.height) < BigInt(prior.command.expires_height),
          409,
          'enrol_intent_expired',
          'This enrolment window has expired. Explicitly prepare a new request after proving absence.',
        );
        const intent = await store.transact((state) => {
          const current = state.nativeIntents[prior.id];
          if (!current.sendAttemptedAt) {
            current.proof = refreshed.proof;
            current.updatedAt = new Date().toISOString();
          }
          return current;
        });
        return { created: false, intent: view(intent) };
      }
      const context = await proven({ keys: [`member/${user.address}`] });
      absence(context, user.address);
      const command = {
        version: 1,
        chain_id: context.state.chain_id,
        member: user.address,
        sequence: '0',
        expires_height: String(BigInt(context.state.height) + 100n),
        operation: 'enrol',
        payload,
      };
      const bytes = nativeEnrolSigningBytes(command),
        now = new Date().toISOString();
      const created = await store.transact((state) => {
        state.nativeIntents ??= {};
        const existing = Object.values(state.nativeIntents).find(
          (i) =>
            i.member === user.address && i.clientRequestId === clientRequestId,
        );
        if (existing) {
          check(
            JSON.stringify(existing.command.payload) ===
              JSON.stringify(payload),
            409,
            'enrol_idempotency_conflict',
            'This identifier is already used.',
          );
          return { created: false, intent: existing };
        }
        const previous = Object.values(state.nativeIntents).filter(
          (i) => i.member === user.address,
        );
        for (const old of previous) {
          check(
            BigInt(old.command.expires_height) < BigInt(context.state.height),
            409,
            'enrol_intent_pending',
            'An enrolment intent already exists. Resume its receipt check instead of preparing a replacement.',
          );
          if (old.status !== 'finalized') {
            // The member is proved absent past this intent's expiry, so a sent enrolment
            // provably never landed: release the member's sequence fence (10 November 2026
            // security review: a bare 'expired' kept every later send refused for good).
            old.status = old.sendAttemptedAt ? 'expired_unincluded' : 'expired';
            old.expiryProof = context.proof;
          }
        }
        check(
          previous.length < 10 &&
            Object.keys(state.nativeIntents).length < 1000,
          429,
          'enrol_intent_capacity',
          'Enrolment intent storage capacity reached.',
        );
        const intent = {
          id: randomUUID(),
          member: user.address,
          clientRequestId,
          publicKey: Buffer.from(user.publicKey, 'base64').toString(
            'base64url',
          ),
          status: 'prepared',
          command,
          signingBytesBase64: bytes.toString('base64'),
          commandDigest: hash(bytes),
          afterEvent: context.state.event_count,
          scanCursor: context.state.event_count,
          proof: context.proof,
          envelope: null,
          transactionHash: null,
          sendAttemptedAt: null,
          activation: {
            verified: false,
            status: 'not_enrolled',
            licence: null,
            proof: null,
          },
          createdAt: now,
          updatedAt: now,
        };
        state.nativeIntents[intent.id] = intent;
        return { created: true, intent };
      });
      return { created: created.created, intent: view(created.intent) };
    },
    async submit(user, id, body) {
      check(
        enabled && native.configured,
        503,
        'native_enrol_disabled',
        'Native enrolment submission is not enabled on this service.',
      );
      check(
        exact(body, ['envelope']),
        400,
        'invalid_native_envelope',
        'Provide only a locally signed enrol envelope.',
      );
      const intent = owned(user.address, id),
        envelope = checkedEnvelope(intent, body.envelope, user);
      if (intent.envelope)
        check(
          JSON.stringify(intent.envelope) === JSON.stringify(envelope),
          409,
          'native_envelope_conflict',
          'A different envelope is already journaled for this intent.',
        );
      if (intent.sendAttemptedAt)
        return { attempted: false, intent: view(intent) };
      const deadline = Date.now() + native.timeoutMs,
        context = await proven({ keys: [`member/${user.address}`] }, deadline);
      absence(context, user.address);
      check(
        context.state.chain_id === intent.command.chain_id &&
          context.proof.epoch === intent.proof.epoch &&
          context.proof.verifierSha256 === intent.proof.verifierSha256,
        409,
        'native_epoch_changed',
        'The native epoch or verifier differs from the prepared intent.',
      );
      check(
        BigInt(context.state.height) < BigInt(intent.command.expires_height),
        409,
        'enrol_intent_expired',
        'This unsigned enrolment window has expired. Prove absence and explicitly prepare a new intent.',
      );
      const transactionHash = hash(
        Buffer.from(JSON.stringify(envelope)),
      ).toUpperCase();
      const marker = await store.transact((state) => {
        const current = state.nativeIntents[id];
        check(
          current && current.member === user.address,
          404,
          'enrol_intent_missing',
          'Enrolment intent not found.',
        );
        if (current.envelope)
          check(
            JSON.stringify(current.envelope) === JSON.stringify(envelope),
            409,
            'native_envelope_conflict',
            'A different envelope is already journaled.',
          );
        if (current.sendAttemptedAt) return { send: false, intent: current };
        check(!hasPendingPilotSend(state,user.address),409,'native_pilot_intent_pending','Check the pending project action receipt first.');
        current.envelope = envelope;
        current.transactionHash = transactionHash;
        current.sendAttemptedAt = new Date().toISOString();
        current.status = 'broadcasting';
        current.updatedAt = current.sendAttemptedAt;
        return { send: true, intent: current };
      });
      if (!marker.send)
        return { attempted: false, intent: view(marker.intent) };
      let outcome = { status: 'unknown', broadcastCode: null };
      try {
        const reply = await native.broadcastEnrol(envelope, {
          timeoutMs: Math.max(1, deadline - Date.now()),
        });
        outcome = {
          status: reply.accepted ? 'accepted' : 'refused',
          broadcastCode: reply.code,
        };
      } catch {}
      const updated = await store.transact((state) => {
        const current = state.nativeIntents[id];
        if (current.status === 'broadcasting') {
          Object.assign(current, outcome);
          current.updatedAt = new Date().toISOString();
        }
        return current;
      });
      return { attempted: true, intent: view(updated) };
    },
    async receipt(user, id, body) {
      check(
        exact(body, []),
        400,
        'invalid_receipt_request',
        'Receipt discovery takes no caller-selected command or event cursor.',
      );
      const intent = owned(user.address, id);
      check(
        intent.envelope && intent.sendAttemptedAt,
        409,
        'enrol_not_submitted',
        'Submit the reviewed locally signed enrolment before checking its receipt.',
      );
      if (intent.status === 'finalized') {
        try {
          const { state, proof } = await proven({ member: user.address });
          check(
            state.chain_id === intent.command.chain_id &&
              proof.epoch === intent.proof.epoch &&
              proof.verifierSha256 === intent.proof.verifierSha256,
            503,
            'native_proof_unavailable',
            'The native activation proof differs from the enrolment epoch or verifier.',
          );
          const currentActivation = activation(
            state,
            proof,
            user.address,
            intent.publicKey,
          );
          native.invalidateAccount(user.address);
          const updated = await store.transact((state) => {
            state.nativeIntents[id].activation = currentActivation;
            return state.nativeIntents[id];
          });
          return { intent: view(updated) };
        } catch {
          return {
            intent: {
              ...view(intent),
              activation: {
                verified: false,
                status: 'proof_unavailable',
                licence: null,
                proof: null,
              },
            },
          };
        }
      }
      if (intent.status === 'expired_unincluded') return { intent: view(intent) };
      const deadline = Date.now() + native.timeoutMs,
        head = await proven({ keys: [`member/${user.address}`] }, deadline);
      check(
        head.state.chain_id === intent.command.chain_id &&
          head.proof.epoch === intent.proof.epoch &&
          head.proof.verifierSha256 === intent.proof.verifierSha256 &&
          UINT.test(head.state.event_count ?? ''),
        503,
        'native_proof_unavailable',
        'Receipt context differs from the prepared epoch.',
      );
      const cursor = BigInt(intent.scanCursor),
        count = BigInt(head.state.event_count);
      check(
        cursor <= count,
        503,
        'native_proof_unavailable',
        'The receipt event cursor exceeds finalized state.',
      );
      const end = cursor + 32n < count ? cursor + 32n : count,
        ids = [];
      for (let n = cursor + 1n; n <= end; n++) ids.push(String(n));
      const batch = ids.length
        ? await proven(
            { keys: ids.map((n) => 'event/' + n.padStart(20, '0')) },
            deadline,
          )
        : head;
      for (const eventId of ids) {
        const event = batch.state.records['event/' + eventId.padStart(20, '0')];
        check(
          event && event.id === eventId && SHA.test(event.command_digest ?? ''),
          503,
          'native_proof_unavailable',
          'A finalized receipt scan record is missing or invalid.',
        );
        if (event.command_digest !== intent.commandDigest) continue;
        check(
          event.member === user.address &&
            event.operation === 'enrol' &&
            event.subject === user.address,
          503,
          'native_proof_unavailable',
          'The native event differs from the enrolment intent.',
        );
        const final = await proven(
            { receipt: { envelope: intent.envelope, event_id: eventId } },
            deadline,
          ),
          receipt = final.state.receipt;
        check(
          receipt?.authority === 'native' &&
            receipt.finalized === true &&
            receipt.chain_id === intent.command.chain_id &&
            receipt.event?.id === eventId &&
            receipt.event.command_digest === intent.commandDigest &&
            receipt.event.member === user.address &&
            receipt.event.operation === 'enrol',
          503,
          'native_proof_unavailable',
          'The exact enrolment command has no verified final receipt.',
        );
        const currentActivation = activation(
          final.state,
          final.proof,
          user.address,
          intent.publicKey,
        );
        const updated = await store.transact((state) => {
          const current = state.nativeIntents[id];
          current.status = 'finalized';
          current.scanCursor = eventId;
          current.moreEvents = false;
          current.receipt = { ...receipt, proof: final.proof };
          current.activation = currentActivation;
          current.updatedAt = new Date().toISOString();
          return current;
        });
        native.invalidateAccount(user.address);
        return { intent: view(updated) };
      }
      // Proved expiry (fresh-join test, 13 November 2026): past expires_height these exact
      // bytes can never be included. When the whole event log is scanned with no match and the
      // member is still absent under the same proof, the enrolment provably never landed, so it
      // is released and may be prepared again, instead of staying 'unknown' for ever.
      const expiredUnused =
        end === count &&
        BigInt(head.state.height) > BigInt(intent.command.expires_height) &&
        Object.hasOwn(head.state.records ?? {}, `member/${user.address}`) &&
        head.state.records[`member/${user.address}`] === null;
      const updated = await store.transact((state) => {
        const current = state.nativeIntents[id];
        if (current.status !== 'finalized' && BigInt(current.scanCursor) < end)
          current.scanCursor = String(end);
        current.moreEvents = end < count;
        if (expiredUnused && current.status !== 'finalized') {
          current.status = 'expired_unincluded';
          current.expiryProof = head.proof;
        }
        current.updatedAt = new Date().toISOString();
        return current;
      });
      return { intent: view(updated) };
    },
  });
}

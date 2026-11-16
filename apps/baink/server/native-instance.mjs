import { hasPendingNativeSend } from './native-sequence-fence.mjs';
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/, UINT = /^(0|[1-9][0-9]{0,19})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
export class NativeInstanceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function check(ok, status, code, message = code) { if (!ok) throw new NativeInstanceError(status, code, message); }
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function text(value) {
  check(typeof value === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), 400, 'invalid_native_command');
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
function nativeJSON(value) {
  if (typeof value === 'string') return text(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  check(value && typeof value === 'object' && !Array.isArray(value), 400, 'invalid_native_command');
  return '{' + Object.keys(value).sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k => text(k) + ':' + nativeJSON(value[k])).join(',') + '}';
}
function payload(value) {
  check(exact(value, ['id','name','family']) && typeof value.id === 'string' && ID.test(value.id), 400, 'invalid_instance_fields');
  for (const [key,min,max] of [['name',2,120],['family',0,100]]) {
    check(typeof value[key] === 'string' && value[key] === value[key].trim() && Buffer.byteLength(value[key]) >= min && Buffer.byteLength(value[key]) <= max && !/[\u0000-\u001f\u007f]/.test(value[key]),400,'invalid_instance_fields');
    text(value[key]);
  }
  return { id: value.id, name: value.name, family: value.family };
}
export function nativeInstanceSigningBytes(command) {
  const fields = ['version','chain_id','member','sequence','expires_height','operation','payload'];
  check(exact(command, fields) && command.version === 1 && typeof command.chain_id === 'string' && /^[A-Za-z0-9._-]{1,96}$/.test(command.chain_id) && /^uain1[a-f0-9]{40}$/.test(command.member) && typeof command.sequence === 'string' && UINT.test(command.sequence) && BigInt(command.sequence) < 18446744073709551615n && typeof command.expires_height === 'string' && /^[1-9][0-9]{0,18}$/.test(command.expires_height) && BigInt(command.expires_height) <= 9223372036854775807n && command.operation === 'instance_create',400,'invalid_native_command');
  payload(command.payload);
  return Buffer.from('uain:chain-command:v1\n{' + fields.map(k => text(k) + ':' + nativeJSON(command[k])).join(',') + '}');
}
function holder(user) {
  check(typeof user?.publicKey === 'string' && /^uain1[a-f0-9]{40}$/.test(user.address),401,'invalid_native_holder');
  const raw = Buffer.from(user.publicKey,'base64');
  check(raw.length === 32 && raw.toString('base64') === user.publicKey && 'uain1' + digest(raw).slice(0,40) === user.address,401,'invalid_native_holder');
  return raw.toString('base64url');
}
/** Browser-signed native instance setup. This proves native ownership, not an
 * independently authenticated client installation or permission to run work. */
export function createNativeInstanceService({ store, native, enabled = false }) {
  const canSend = () => enabled === true && native.configured === true && typeof native.broadcastInstance === 'function';
  const proofError = ok => check(ok,503,'native_proof_unavailable','A fresh pinned native proof is required.');
  function fresh(proof, state) {
    const age = Date.now() - Date.parse(proof?.headerTime);
    proofError(native.configured === true && HASH.test(native.pins?.epoch ?? '') && HASH.test(native.pins?.verifierSha256 ?? '') && proof?.authority === 'native' && proof.chainId === native.pins.chainId && proof.epoch === native.pins.epoch && proof.verifierSha256 === native.pins.verifierSha256 && Number.isFinite(age) && age >= -60000 && Number.isInteger(proof.maxAgeSeconds) && proof.maxAgeSeconds >= 1 && proof.maxAgeSeconds <= 120 && age <= proof.maxAgeSeconds * 1000 && /^[1-9][0-9]{0,18}$/.test(proof.height ?? '') && HASH.test(proof.appHash ?? ''));
    if (state) proofError(state.chain_id === proof.chainId && state.height === proof.height && state.app_hash === proof.appHash && UINT.test(state.event_count ?? ''));
  }
  async function proven(selection, intent, deadline = Date.now() + native.timeoutMs) {
    let context;
    try { context = await native.publicState(selection, { timeoutMs: Math.max(1,deadline-Date.now()) }); }
    catch { proofError(false); }
    fresh(context.proof,context.state);
    if (intent) proofError(context.state.chain_id === intent.command.chain_id && context.proof.epoch === intent.proof.epoch && context.proof.verifierSha256 === intent.proof.verifierSha256 && BigInt(context.state.height) >= BigInt(intent.proof.height));
    return context;
  }
  function member(context,user,key) {
    const m = context.state.member;
    proofError(m?.id === user.address && m.public_key === key && typeof m.sequence === 'string' && UINT.test(m.sequence) && BigInt(m.sequence) < 18446744073709551615n);
    check(m.licence === 'active',409,'native_licence_inactive','An active native licence is required.');
    return m;
  }
  const selection = (user,id) => ({ member: user.address, keys: ['instance/' + id,'instance_count/' + user.address] });
  function available(context,user,id,key) {
    const m = member(context,user,key), records = context.state.records;
    check(records?.['instance/' + id] === null,409,'native_instance_exists','Choose another instance identifier; this one is already owned.');
    const count = records['instance_count/' + user.address];
    proofError(count === null || (Number.isInteger(count) && count >= 0));
    check(count === null || count < 128,409,'native_instance_limit');
    return m;
  }
  function owned(user,id) {
    holder(user);
    const intent = store.read().nativeInstanceIntents?.[id];
    check(intent?.member === user.address,404,'instance_intent_missing');
    return intent;
  }
  function view(intent) {
    const result = structuredClone(intent);
    result.finalized = result.status === 'finalized'; result.receiptRequired = Boolean(result.sendAttemptedAt) && !result.finalized;
    if (result.status === 'broadcasting') result.status = 'unknown';
    if (result.activation?.verified) {
      try { fresh(result.activation.proof); }
      catch { result.activation = { verified: false, status:'proof_unavailable', instance:null, proof:null }; }
    }
    result.installationVerified = false;
    return result;
  }
  function envelopeFor(intent,body,user) {
    check(exact(body,['envelope']) && exact(body.envelope,['command','public_key','signature']),400,'invalid_native_envelope');
    const envelope = body.envelope, bytes = nativeInstanceSigningBytes(envelope.command);
    check(bytes.equals(Buffer.from(intent.signingBytesBase64,'base64')) && envelope.public_key === intent.publicKey && holder(user) === intent.publicKey,400,'native_envelope_mismatch');
    const sig = typeof envelope.signature === 'string' ? Buffer.from(envelope.signature,'base64url') : Buffer.alloc(0);
    check(sig.length === 64 && sig.toString('base64url') === envelope.signature && verify(null,bytes,createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:intent.publicKey},format:'jwk'}),sig),400,'invalid_native_signature');
    return { command:structuredClone(intent.command),public_key:intent.publicKey,signature:envelope.signature };
  }
  async function activation(context,intent,user) {
    const m = member(context,user,intent.publicKey), instance = context.state.records?.['instance/' + intent.command.payload.id];
    proofError(BigInt(m.sequence) > BigInt(intent.command.sequence) && instance?.id === intent.command.payload.id && instance.member === user.address && instance.state === 'active');
    return { verified:true,status:'active',instance:{id:instance.id,member:instance.member,state:instance.state},proof:context.proof };
  }
  const service = {
    get enabled() { return canSend(); },
    list(user) { holder(user); return { intents:Object.values(store.read().nativeInstanceIntents ?? {}).filter(i => i.member === user.address).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(view) }; },
    async prepare(user,body) {
      const key = holder(user);
      check(exact(body,['clientRequestId','id','name','family']),400,'invalid_instance_fields');
      check(typeof body.clientRequestId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.clientRequestId),400,'invalid_request_id');
      const details = payload({id:body.id,name:body.name,family:body.family});
      const prior = Object.values(store.read().nativeInstanceIntents ?? {}).find(i => i.member === user.address && i.clientRequestId === body.clientRequestId);
      if (prior) {
        check(JSON.stringify(prior.command.payload) === JSON.stringify(details),409,'instance_idempotency_conflict');
        if (prior.sendAttemptedAt) return {created:false,intent:view(prior)};
      }
      const context = await proven(selection(user,details.id),prior), m = available(context,user,details.id,key);
      if (prior) {
        check(m.sequence === prior.command.sequence,409,'native_sequence_changed');
        check(BigInt(context.state.height) < BigInt(prior.command.expires_height),409,'instance_intent_expired');
        const resumed = await store.transact(state => {
          const current = state.nativeInstanceIntents[prior.id];
          if (!current.sendAttemptedAt) {
            current.proof = context.proof; current.updatedAt = new Date().toISOString();
          }
          return current;
        });
        return {created:false,intent:view(resumed)};
      }
      const command = {version:1,chain_id:context.state.chain_id,member:user.address,sequence:m.sequence,expires_height:String(BigInt(context.state.height)+100n),operation:'instance_create',payload:details};
      const bytes = nativeInstanceSigningBytes(command), now = new Date().toISOString();
      const result = await store.transact(state => {
        state.nativeInstanceIntents ??= {};
        const previous = Object.values(state.nativeInstanceIntents).filter(i => i.member === user.address);
        const same = previous.find(i => i.clientRequestId === body.clientRequestId);
        if (same) { check(JSON.stringify(same.command.payload) === JSON.stringify(details),409,'instance_idempotency_conflict'); return {created:false,intent:same}; }
        for (const old of previous.filter(i => i.status !== 'finalized')) {
          check(BigInt(old.command.expires_height) < BigInt(context.state.height),409,'instance_intent_pending','Resume the existing signed request before preparing another.');
          // Past expiry with the member's sequence unused: a sent command provably never landed,
          // so it no longer holds the sequence fence (10 November 2026 security review).
          old.status = old.sendAttemptedAt && m.sequence === old.command.sequence ? 'expired_unincluded' : 'expired'; old.expiryProof = context.proof;
        }
        check(previous.length < 128 && Object.keys(state.nativeInstanceIntents).length < 10000,429,'instance_intent_capacity');
        const intent = {id:randomUUID(),member:user.address,publicKey:key,clientRequestId:body.clientRequestId,status:'prepared',command,signingBytesBase64:bytes.toString('base64'),commandDigest:digest(bytes),proof:context.proof,afterEvent:context.state.event_count,scanCursor:context.state.event_count,envelope:null,sendAttemptedAt:null,transactionHash:null,activation:{verified:false,status:'not_created',instance:null,proof:null},createdAt:now,updatedAt:now};
        state.nativeInstanceIntents[intent.id] = intent; return {created:true,intent};
      });
      return {created:result.created,intent:view(result.intent)};
    },
    async submit(user,id,body) {
      check(canSend(),503,'native_instance_disabled','Native instance submission is unavailable.');
      const intent = owned(user,id), envelope = envelopeFor(intent,body,user);
      if (intent.envelope) check(JSON.stringify(intent.envelope) === JSON.stringify(envelope),409,'native_envelope_conflict');
      if (intent.sendAttemptedAt) return {attempted:false,intent:view(intent)};
      const deadline = Date.now()+native.timeoutMs, context = await proven(selection(user,intent.command.payload.id),intent,deadline);
      const m = available(context,user,intent.command.payload.id,intent.publicKey);
      check(m.sequence === intent.command.sequence,409,'native_sequence_changed');
      check(BigInt(context.state.height) < BigInt(intent.command.expires_height),409,'instance_intent_expired');
      const marker = await store.transact(state => {
        const current = state.nativeInstanceIntents[id];
        check(current?.member === user.address,404,'instance_intent_missing');
        if (current.envelope) check(JSON.stringify(current.envelope) === JSON.stringify(envelope),409,'native_envelope_conflict');
        if (current.sendAttemptedAt) return {send:false,intent:current};
        check(!hasPendingNativeSend(state,user.address),409,'native_sequence_pending');
        current.envelope = envelope; current.transactionHash = digest(JSON.stringify(envelope)).toUpperCase(); current.sendAttemptedAt = new Date().toISOString(); current.updatedAt = current.sendAttemptedAt; current.status = 'broadcasting';
        return {send:true,intent:current};
      });
      if (!marker.send) return {attempted:false,intent:view(marker.intent)};
      let outcome = {status:'unknown',broadcastCode:null};
      try {
        const reply = await native.broadcastInstance(envelope,{timeoutMs:Math.max(1,deadline-Date.now())});
        if (reply.transactionHash === marker.intent.transactionHash && Number.isInteger(reply.code) && reply.code >= 0 && reply.accepted === (reply.code === 0)) outcome = {status:reply.accepted ? 'accepted':'refused',broadcastCode:reply.code};
      } catch {}
      const result = await store.transact(state => {
        const current = state.nativeInstanceIntents[id];
        if (current.status === 'broadcasting') { Object.assign(current,outcome); current.updatedAt = new Date().toISOString(); }
        return current;
      });
      return {attempted:true,intent:view(result)};
    },
    async receipt(user,id,body) {
      check(exact(body,[]),400,'invalid_receipt_request');
      const intent = owned(user,id);
      check(intent.envelope && intent.sendAttemptedAt,409,'instance_not_submitted');
      const deadline = Date.now()+native.timeoutMs;
      if (intent.status === 'finalized') {
        try {
          const context = await proven(selection(user,intent.command.payload.id),intent,deadline);
          const currentActivation = await activation(context,intent,user);
          const result = await store.transact(state => { state.nativeInstanceIntents[id].activation = currentActivation; return state.nativeInstanceIntents[id]; });
          return {intent:view(result)};
        } catch { return {intent:{...view(intent),activation:{verified:false,status:'proof_unavailable',instance:null,proof:null}}}; }
      }
      const head = await proven({},intent,deadline), cursor = BigInt(intent.scanCursor), count = BigInt(head.state.event_count);
      proofError(cursor <= count);
      const end = cursor+32n < count ? cursor+32n : count, ids = [];
      for (let n=cursor+1n;n<=end;n++) ids.push(String(n));
      const batch = ids.length ? await proven({keys:ids.map(n => 'event/'+n.padStart(20,'0'))},intent,deadline) : head;
      proofError(BigInt(batch.state.height) >= BigInt(head.state.height));
      for (const eventId of ids) {
        const event = batch.state.records['event/'+eventId.padStart(20,'0')];
        proofError(event?.id === eventId && HASH.test(event.command_digest ?? ''));
        if (event.command_digest !== intent.commandDigest) continue;
        proofError(event.member === user.address && event.operation === 'instance_create' && event.subject === intent.command.payload.id && !event.instance);
        const context = await proven({...selection(user,intent.command.payload.id),receipt:{envelope:intent.envelope,event_id:eventId}},intent,deadline), receipt = context.state.receipt;
        proofError(BigInt(context.state.height) >= BigInt(batch.state.height) && receipt?.authority === 'native' && receipt.finalized === true && receipt.chain_id === intent.command.chain_id && receipt.state_height === context.state.height && receipt.app_hash === context.proof.appHash && receipt.event?.id === eventId && receipt.event.command_digest === intent.commandDigest && receipt.event.member === user.address && receipt.event.operation === 'instance_create' && receipt.event.subject === intent.command.payload.id && !receipt.event.instance);
        const currentActivation = await activation(context,intent,user);
        const result = await store.transact(state => {
          const current = state.nativeInstanceIntents[id];
          current.status = 'finalized'; current.receipt = {...receipt,proof:context.proof}; current.activation = currentActivation; current.scanCursor = eventId; current.moreEvents = false; current.updatedAt = new Date().toISOString(); return current;
        });
        native.invalidateAccount?.(user.address); return {intent:view(result)};
      }
      const result = await store.transact(state => {
        const current = state.nativeInstanceIntents[id];
        if (current.status !== 'finalized' && BigInt(current.scanCursor) < end) current.scanCursor = String(end);
        current.moreEvents = current.status !== 'finalized' && end < count; current.updatedAt = new Date().toISOString(); return current;
      });
      return {intent:view(result)};
    },
  };
  return Object.freeze(service);
}

// Member/checker workflows. Spending and identity keys stay with their holder.
// Only the encrypted review envelope crosses the checker transport; the relay
// receives only the native public payload. No function broadcasts a transaction.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readPrivateState, assertPrivateStateContext, signApprovalFromPrivateState, signBoundaryFromPrivateState } from './private-state.mjs';
import { reviewCertificate, encryptPrivateReview, decryptPrivateReview, privatePurposeCommitment } from './private-review.mjs';
import { coinBoundaryPurposeCommitment, coinBoundaryApprovalBytes } from './coin-boundary.mjs';
import { memberAddress, signedEnvelope, signingBytes } from './signing.mjs';

const digest = v => createHash('sha256').update(v).digest();
const rawKey = key => Buffer.from((key.type === 'public' ? key : createPublicKey(key)).export({ type: 'spki', format: 'der' })).subarray(-32);
const publicKey = value => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(value, 'base64url')]), type: 'spki', format: 'der' });
const hex32 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function amount(value, zero = false) {
  if (typeof value !== 'string' || !(zero ? /^(0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/).test(value) || BigInt(value) > 0x7fffffffffffffffn) throw new Error('canonical bounded Coin amount required');
  return value;
}
function operation(value) { if (!['private_payment', 'coin_shield', 'coin_exit'].includes(value)) throw new Error('unsupported private operation'); return value; }
function boundaryFor(op, request, units) { return op === 'private_payment' ? null : { direction: op === 'coin_shield' ? 'shield' : 'exit', member: request.boundary_member, amount: amount(units) }; }
function purposeFor(agreement, boundary) { return boundary ? coinBoundaryPurposeCommitment(agreement, boundary) : privatePurposeCommitment(agreement); }
function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(f => !Object.hasOwn(value, f))) throw new Error(`invalid ${label} fields`);
}
function reviewPacket(packet, context) {
  exactFields(packet, ['effects', 'effects_wire_hex', 'one_time_viewing_key'], 'private inspection packet');
  if (packet.effects !== context.effects || !hex32(packet.one_time_viewing_key) || typeof packet.effects_wire_hex !== 'string' || !/^(?:[0-9a-f]{2}){1,16384}$/.test(packet.effects_wire_hex)) throw new Error('invalid bounded private inspection packet');
  return packet;
}
function walletReviewPacket(packet, context, boundary) {
  const fields = boundary ? ['request', 'chain_id', 'reviewer_public_key', 'effects', 'effects_wire_hex', 'one_time_viewing_key'] : ['version', 'effects', 'purpose_commitment', 'expires_height', 'licence_revision', 'chain_id', 'reviewer_public_key', 'effects_wire_hex', 'one_time_viewing_key'];
  exactFields(packet, fields, 'wallet review packet');
  const request = boundary ? packet.request : packet;
  if (boundary) exactFields(request, ['version', 'effects', 'purpose_commitment', 'expires_height', 'licence_revision', 'direction', 'member', 'amount'], 'wallet boundary request');
  if (request.version !== 1 || request.effects !== context.effects || request.purpose_commitment !== context.purpose || String(request.expires_height) !== context.expires || request.licence_revision !== context.licenceRevision || packet.chain_id !== context.chain || packet.reviewer_public_key !== context.reviewer || boundary && ['direction', 'member', 'amount'].some(f => request[f] !== boundary[f])) throw new Error('wallet review packet differs from verified intent');
  return reviewPacket(Object.fromEntries(['effects', 'effects_wire_hex', 'one_time_viewing_key'].map(f => [f, packet[f]])), context, boundary);
}
export async function verifyPrivateExecutable({ executable, executableSha256 }) {
  if (!hex32(executableSha256)) throw new Error('independent wallet executable pin required');
  const path = resolve(executable), info = await stat(path);
  if (!info.isFile() || info.size > 256 * 1024 * 1024) throw new Error('invalid private executable');
  const hash = createHash('sha256'); for await (const data of createReadStream(path)) hash.update(data);
  if (hash.digest('hex') !== executableSha256) throw new Error('private executable differs from its independent pin');
  return path;
}
async function inspectReview(tool, file) {
  const executable = await verifyPrivateExecutable(tool);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['inspect-review', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostic = '', overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', b => { output += b; if (Buffer.byteLength(output) > 32768) { overflow = true; child.kill('SIGKILL'); } });
    child.stderr.on('data', b => { diagnostic = (diagnostic + b).slice(-4096); });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0 || overflow) reject(new Error(`private inspection refused: ${diagnostic}`)); else { try { resolve(JSON.parse(output)); } catch { reject(new Error('invalid private inspection')); } } });
  });
}
export async function certificateForPrivateState({ reader, context, reviewerSigningKey, encryptionPublicKey }) {
  const reviewer = memberAddress(rawKey(reviewerSigningKey));
  const state = await readPrivateState({ ...reader, request: { policy_only: true, reviewer } });
  assertPrivateStateContext(state, context);
  return reviewCertificate(context, encryptionPublicKey, reviewerSigningKey);
}
export async function reviewEncryptedPrivateTrade({ reader, envelope, reviewerSigningKey, reviewerEncryptionKey, tools, decide }) {
  if (typeof decide !== 'function') throw new Error('explicit private ethical review required');
  const reviewerKey = createPublicKey(reviewerSigningKey), reviewer = memberAddress(rawKey(reviewerKey));
  const policy = await readPrivateState({ ...reader, request: { policy_only: true, reviewer } });
  const context = envelope?.certificate?.context;
  assertPrivateStateContext(policy, context);
  const packet = decryptPrivateReview({ envelope, reviewerEncryptionKey, trustedReviewerPublicKey: reviewerKey, currentHeight: policy.height, chain: policy.chain_id });
  exactFields(packet, ['wallet_packet', 'operation', 'amount', 'source_request', 'agreement', 'consents'], 'encrypted trade');
  const op = operation(packet.operation), boundary = boundaryFor(op, packet.source_request, packet.amount);
  if (packet.source_request.reviewer !== reviewer || packet.source_request.policy_only || purposeFor(packet.agreement, boundary) !== context.purpose) throw new Error('encrypted trade differs from certified purpose/roles');
  reviewPacket(packet.wallet_packet, context, boundary);
  amount(packet.amount);
  const state = await readPrivateState({ ...reader, request: { ...packet.source_request, skip_witness: true } });
  assertPrivateStateContext(state, context);
  const directory = await mkdtemp(join(tmpdir(), 'uain-private-check-')); await chmod(directory, 0o700);
  try {
    const file = join(directory, 'review.json');
    await writeFile(file, JSON.stringify(packet.wallet_packet), { mode: 0o600, flag: 'wx' });
    const inspection = await inspectReview(boundary ? tools.coinWallet : tools.privateWallet, file);
    if (inspection.effects !== context.effects) throw new Error('inspected outputs differ from certified effects');
    const decision = await decide({ context, agreement: packet.agreement, amount: packet.amount, operation: op, inspection, state });
    if (boundary) return signBoundaryFromPrivateState({ state, context, boundary, agreement: packet.agreement, reviewerSigningKey, consents: packet.consents, outputs: inspection.outputs, valueBalance: inspection.value_balance, decision });
    if (!Array.isArray(packet.consents) || packet.consents.length !== 2) throw new Error('bilateral licensed consent required');
    return signApprovalFromPrivateState({ state, context, agreement: packet.agreement, reviewerSigningKey, sender: packet.consents[0], recipient: packet.consents[1], outputs: inspection.outputs, amount: packet.amount, decision });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function approvalBytes(context, boundary, cls) {
  if (boundary) return coinBoundaryApprovalBytes(context, boundary, cls);
  const classification = cls === 'benevolent' ? 1 : cls === 'neutral' ? 2 : 0;
  if (!classification || context.version !== 1 || !hex32(context.effects) || !hex32(context.purpose) || !hex32(context.reviewer)) throw new Error('invalid reviewed approval');
  const expiry = Buffer.alloc(8); expiry.writeBigUInt64BE(BigInt(context.expires));
  const revision = Buffer.alloc(8); revision.writeBigUInt64BE(BigInt(context.licenceRevision));
  return Buffer.concat([Buffer.from('UAIN/private-exchange/approval/v1\0'), digest(context.chain), expiry, revision, Buffer.from(context.effects, 'hex'), Buffer.from(context.purpose, 'hex'), Buffer.from([classification, 1]), Buffer.from(context.reviewer, 'hex')]);
}
export function verifyPrivateTradeApproval({ approval, context, boundary = null, reviewerPublicKey }) {
  const fields = ['reviewer', 'effects', 'purpose_commitment', 'class', 'expires_height', 'licence_revision', 'signature', ...(boundary ? ['direction', 'member', 'amount'] : [])];
  exactFields(approval, fields, 'private approval');
  if (approval.reviewer !== memberAddress(rawKey(reviewerPublicKey)) || context.reviewer !== rawKey(reviewerPublicKey).toString('hex') || approval.effects !== context.effects || approval.purpose_commitment !== context.purpose || approval.expires_height !== context.expires || approval.licence_revision !== context.licenceRevision || boundary && ['direction', 'member', 'amount'].some(f => boundary[f] !== approval[f])) throw new Error('approval differs from certified trade');
  const signature = Buffer.from(approval.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== approval.signature || !verify(null, approvalBytes(context, boundary, approval.class), reviewerPublicKey, signature)) throw new Error('invalid private approval signature');
  return approval;
}
export async function producePrivateTrade({ reader, tools, operation: op, amount: units, spendingKeyFile, recipientAddress, source, agreement, memo = '', consent, certificate, review, timeoutMs = 180000 }) {
  operation(op); amount(units);
  if ([consent, certificate, review].some(f => typeof f !== 'function') || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('bounded consent/certificate/encrypted-review providers required');
  if (!reader?.request) throw new Error('private finalized-state reader request required');
  reader = { ...reader, request: structuredClone(reader.request) };
  reader.request.compact_witness = true;
  delete reader.request.skip_witness;
  const selected = new Set(reader.request.witness_positions || []);
  for (const w of reader.request.witness_cache?.witnesses || []) selected.add(w.position);
  if (op !== 'coin_shield' && Number.isInteger(source?.position)) selected.add(source.position);
  reader.request.witness_positions = [...selected];
  const state = await readPrivateState(reader);
  if (state.policy_only || !state.witness_complete || !state.witness_cache) throw new Error('complete verified member witness required');
  const boundary = boundaryFor(op, reader.request, units), purpose = purposeFor(agreement, boundary);
  if (boundary ? state.coin?.owner?.member !== boundary.member : state.parties.length !== 2) throw new Error('proven member roles differ from private operation');
  const tool = boundary ? tools.coinWallet : tools.privateWallet, executable = await verifyPrivateExecutable(tool);
  const directory = await mkdtemp(join(tmpdir(), 'uain-private-trade-')); await chmod(directory, 0o700);
  const reviewFile = join(directory, 'review.json');
  const intent = { chain_id: state.chain_id, expires_height: String(BigInt(state.height) + 300n), licence_revision: state.licence_revision, key_file: spendingKeyFile, commitments: [], note_count: state.count, expected_root: state.root, amount: units, purpose_commitment: purpose, reviewer_public_key: Buffer.from(state.reviewer.public_key, 'base64url').toString('hex'), memo, review_file: reviewFile };
  if (boundary) intent.member = boundary.member; else intent.recipient = recipientAddress;
  if (op !== 'coin_shield') {
    const entries = source?.kind === 'payment' ? state.payments : source?.kind === 'boundary' ? state.boundaries : [];
    const proven = entries.find(p => p.id === source?.id);
    if (!proven || !Number.isInteger(source.position) || source.position < 0 || BigInt(source.position) >= BigInt(state.count)) { await rm(directory, { recursive: true, force: true }); throw new Error('authenticated source and exact note position required'); }
    intent.compact_witness = state.witness_cache.witnesses.find(w => w.position === source.position);
    if (!intent.compact_witness) { await rm(directory, { recursive: true, force: true }); throw new Error('verified compact source path required'); }
    intent.source_bundle = Buffer.from(proven.bundle, 'base64url').toString('hex'); intent.source_position = source.position;
  } else if (source) { await rm(directory, { recursive: true, force: true }); throw new Error('Coin entry must not spend a source note'); }
  const child = spawn(executable, [boundary?.direction ?? 'pay'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '', timer, outputBytes = 0; const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdout.on('data', b => { outputBytes += b.length; if (outputBytes > 65536) child.kill('SIGKILL'); });
  child.stderr.on('data', b => { diagnostic = (diagnostic + b).slice(-4096); }); child.stdin.on('error', () => {});
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); closed.catch(() => {});
  const abort = new AbortController();
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); child.kill('SIGKILL'); reject(new Error('private review/proof deadline exceeded')); }, timeoutMs); });
  deadline.catch(() => {});
  const bounded = promise => Promise.race([deadline, promise]);
  try {
      child.stdin.write(JSON.stringify(intent) + '\n');
      const draft = await bounded(lines.next()); if (draft.done || Buffer.byteLength(draft.value) > 8192) throw new Error(`wallet draft refused: ${diagnostic}`);
      const request = JSON.parse(draft.value);
      const context = { version: 1, chain: state.chain_id, expires: String(request.expires_height), licenceRevision: request.licence_revision, effects: request.effects, purpose: request.purpose_commitment, reviewer: intent.reviewer_public_key };
      assertPrivateStateContext(state, context);
      if (context.expires !== intent.expires_height || context.purpose !== purpose || !hex32(context.effects)) throw new Error('wallet draft differs from verified intent');
      const info = await bounded(stat(reviewFile)); if (!info.isFile() || info.size > 256 * 1024 || (info.mode & 0o077) !== 0) throw new Error('invalid private review packet');
      const packet = walletReviewPacket(JSON.parse(await bounded(readFile(reviewFile, 'utf8'))), context, boundary);
      const inspection = await bounded(inspectReview(tool, reviewFile)); if (inspection.effects !== context.effects) throw new Error('wallet inspection differs from draft');
      const consents = await bounded(consent({ context, inspection, state, signal: abort.signal }));
      const cert = await bounded(certificate(context, { signal: abort.signal }));
      const encrypted = encryptPrivateReview({ certificate: cert, trustedReviewerPublicKey: publicKey(state.reviewer.public_key), currentHeight: state.height, chain: state.chain_id, packet: { wallet_packet: packet, operation: op, amount: units, source_request: Object.fromEntries(Object.entries(reader.request).filter(([key]) => !['compact_witness', 'witness_positions', 'witness_cache', 'skip_witness'].includes(key))), agreement, consents } });
      const approval = verifyPrivateTradeApproval({ approval: await bounded(review(encrypted, { signal: abort.signal })), context, boundary, reviewerPublicKey: publicKey(state.reviewer.public_key) });
      const nativeApproval = boundary ? { ...approval } : Object.fromEntries(['effects', 'purpose_commitment', 'class', 'expires_height', 'licence_revision'].map(f => [f, approval[f]]));
      nativeApproval.signature = Buffer.from(approval.signature, 'base64url').toString('hex');
      child.stdin.end(JSON.stringify(nativeApproval) + '\n');
      const result = await bounded(lines.next()); if (result.done || Buffer.byteLength(result.value) > 40000) throw new Error(`wallet proof refused: ${diagnostic}`);
      const hex = JSON.parse(result.value).bundle_hex; if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2}){1,16384}$/.test(hex)) throw new Error('invalid wallet proof encoding');
      if (await bounded(closed) !== 0) throw new Error(`wallet self-verification failed: ${diagnostic}`);
      return { operation: op, payload: { bundle: Buffer.from(hex, 'hex').toString('base64url'), approval }, local_receipt: { source_count: state.count, witness_cache: state.witness_cache, notes_fetched: state.notes_fetched, effects: context.effects, outputs: inspection.outputs } };
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed.catch(() => {}); await lines.return(); await rm(directory, { recursive: true, force: true }); }
}
export async function signPrivateTradeCommand({ reader, result, signingKey }) {
  exactFields(result.payload, ['bundle', 'approval'], 'public private-payment payload');
  const op = operation(result.operation), approval = result.payload.approval;
  const request = op === 'private_payment' ? { policy_only: true, reviewer: approval.reviewer } : { skip_witness: true, parties: [], boundary_member: approval.member, reviewer: approval.reviewer };
  const state = await readPrivateState({ ...reader, request });
  const identity = op === 'private_payment' ? state.relayer : state.coin?.owner;
  if (!identity || identity.member !== memberAddress(rawKey(signingKey))) throw new Error('licensed boundary owner or appointed relay signing key required');
  const context = { version: 1, chain: state.chain_id, expires: approval.expires_height, licenceRevision: approval.licence_revision, effects: approval.effects, purpose: approval.purpose_commitment, reviewer: Buffer.from(state.reviewer.public_key, 'base64url').toString('hex') };
  assertPrivateStateContext(state, context);
  const boundary = op === 'private_payment' ? null : { direction: op === 'coin_shield' ? 'shield' : 'exit', member: identity.member, amount: approval.amount };
  verifyPrivateTradeApproval({ approval, context, boundary, reviewerPublicKey: publicKey(state.reviewer.public_key) });
  const wire = Buffer.from(result.payload.bundle, 'base64url'); if (wire.length < 1 || wire.length > 16384 || wire.toString('base64url') !== result.payload.bundle) throw new Error('canonical bounded public bundle required');
  return signedEnvelope({ version: 1, chain_id: state.chain_id, member: identity.member, sequence: identity.sequence, expires_height: approval.expires_height, operation: op, payload: result.payload }, rawKey(signingKey), signingKey);
}
export async function verifyPrivateTradeEnvelope({ reader, envelope }) {
  exactFields(envelope, ['command', 'public_key', 'signature'], 'signed public envelope');
  const command = envelope.command;
  signingBytes(command);
  exactFields(command.payload, ['bundle', 'approval'], 'public private-payment payload');
  const op = operation(command.operation), approval = command.payload.approval;
  const request = op === 'private_payment' ? { policy_only: true, reviewer: approval.reviewer } : { skip_witness: true, parties: [], boundary_member: approval.member, reviewer: approval.reviewer };
  const state = await readPrivateState({ ...reader, request });
  const identity = op === 'private_payment' ? state.relayer : state.coin?.owner;
  if (!identity || command.chain_id !== state.chain_id || command.member !== identity.member || command.sequence !== identity.sequence || envelope.public_key !== identity.public_key || command.expires_height !== approval.expires_height) throw new Error('envelope differs from proven signer, sequence or chain');
  const context = { version: 1, chain: state.chain_id, expires: approval.expires_height, licenceRevision: approval.licence_revision, effects: approval.effects, purpose: approval.purpose_commitment, reviewer: Buffer.from(state.reviewer.public_key, 'base64url').toString('hex') };
  assertPrivateStateContext(state, context);
  const boundary = op === 'private_payment' ? null : { direction: op === 'coin_shield' ? 'shield' : 'exit', member: identity.member, amount: approval.amount };
  verifyPrivateTradeApproval({ approval, context, boundary, reviewerPublicKey: publicKey(state.reviewer.public_key) });
  const wire = Buffer.from(command.payload.bundle, 'base64url');
  const signature = Buffer.from(envelope.signature, 'base64url');
  if (wire.length < 1 || wire.length > 16384 || wire.toString('base64url') !== command.payload.bundle || signature.length !== 64 || signature.toString('base64url') !== envelope.signature || !verify(null, signingBytes(command), publicKey(identity.public_key), signature)) throw new Error('invalid canonical signed public envelope');
  return envelope;
}

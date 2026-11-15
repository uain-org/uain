// Member/checker integration for the pinned native finalized-state reader.
// The reader receives no spending/member signing key. Its private selection and
// snapshot are never placed in argv, public transactions, or research indexes.
import { createHash, createPublicKey } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { privatePurposeCommitment, signPrivateApproval } from './private-review.mjs';
import { coinPolicy, signCoinBoundaryApproval } from './coin-boundary.mjs';
const verified = new WeakMap();
const hex32 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const publicKey = raw => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'base64url')]), type: 'spki', format: 'der' });
async function hashExecutable(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 256 * 1024 * 1024) throw new Error('invalid native state reader');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function nativeRequest({ executable, executableSha256, genesis, genesisSha256, rpc, socksProxy, request, maxAgeSeconds = 120, remoteVerified = false }, method = '') {
  if (!hex32(executableSha256) || !hex32(genesisSha256) || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 600) throw new Error('independent binary/genesis pins and bounded freshness required');
  const input = Buffer.from(JSON.stringify(request));
  if (input.length > 65536) throw new Error('private state request too large');
  const command = resolve(executable);
  if (await hashExecutable(command) !== executableSha256) { input.fill(0); throw new Error('native state reader differs from the independent binary pin'); }
  const directory = await mkdtemp(join(tmpdir(), 'uain-private-state-')); await chmod(directory, 0o700);
  try {
    const output = join(directory, 'snapshot.json');
    await new Promise((resolve, reject) => {
      const args = ['--genesis', genesis, '--genesis-sha256', genesisSha256, '--rpc', rpc, '--out', output, '--max-age', `${maxAgeSeconds}s`];
      if (socksProxy !== undefined) { if (typeof socksProxy !== 'string' || !socksProxy) throw new Error('explicit local SOCKS5 proxy required'); args.push('--socks-proxy', socksProxy); }
      if (method) args.push('--rpc-method', method);
      else if (remoteVerified === true) args.push('--remote-verified');
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let message = ''; let settled = false;
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, method ? 25000 : 610000);
      child.stdout.resume();
      child.stderr.on('data', data => { message = (message + data.toString()).slice(-4096); });
      child.once('error', error => { clearTimeout(timer); settled = true; reject(error); });
      child.once('close', code => { clearTimeout(timer); if (!settled) code === 0 ? resolve() : reject(new Error(`finalized private state refused: ${message.trim()}`)); });
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
    const info = await stat(output);
    if (!info.isFile() || info.size > 80 * 1024 * 1024 || (info.mode & 0o077) !== 0) throw new Error('invalid private snapshot output');
    return JSON.parse(await readFile(output, 'utf8'));
  } finally { input.fill(0); await rm(directory, { recursive: true, force: true }); }
}
export async function publicPrivateRPC(reader, method, params) {
  if (method !== 'broadcast_tx_sync') throw new Error('unsupported public private RPC');
  return nativeRequest({ ...reader, request: params }, method);
}
export async function readPrivateState(reader) {
    const endpoint = new URL(reader.rpc);
    const host = endpoint.hostname.replace(/^\[|\]$/g, '');
    const loopback = isIP(host) === 4 && host.split('.')[0] === '127' || host === '::1';
    if (reader.remoteVerified !== undefined && reader.remoteVerified !== true) throw new Error('remoteVerified must be exactly true');
    // Light mode: any untrusted node. The pinned reader answers every
    // selection-dependent key from complete proven prefix scans and verifies
    // every value against the pinned genesis (see light-wallet-design.md).
    if (reader.remoteVerified === true) {
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && (loopback && reader.socksProxy === undefined || host.toLowerCase().endsWith('.onion') && typeof reader.socksProxy === 'string'))) throw new Error('remote-verified reads require HTTPS, an onion service over SOCKS5, or loopback HTTP');
    } else if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || reader.socksProxy !== undefined || !(isIP(host) === 4 && host.split('.')[0] === '127' || host === '::1')) throw new Error('private lookups require your own loopback full node without a proxy');
    const state = await nativeRequest(reader);
    // This object is issued only by the pinned verifier invocation. Serialized
    // JSON copied from an indexer cannot confer approval authority.
    for (const entry of [state.relayer, state.reviewer, ...state.parties, ...state.payments, ...(state.boundaries || []), state.coin?.owner, state.coin?.supply, state.coin].filter(Boolean)) Object.freeze(entry);
    if (state.witness_cache) { for (const witness of state.witness_cache.witnesses) { Object.freeze(witness.path); Object.freeze(witness); } Object.freeze(state.witness_cache.witnesses); Object.freeze(state.witness_cache.nodes); Object.freeze(state.witness_cache); }
    for (const list of [state.records, state.nullifiers]) if (Array.isArray(list)) { list.forEach(Object.freeze); Object.freeze(list); }
    Object.freeze(state.commitments); Object.freeze(state.parties); Object.freeze(state.payments); Object.freeze(state.boundaries); Object.freeze(state);
    verified.set(state, { maxAgeSeconds: reader.maxAgeSeconds ?? 120 });
    return state;
}
// Policy-only snapshots authorize public certificate/relay checks, never a
// member payment or boundary approval. Freshness and context checks are shared.
export function assertPrivateStateContext(state, context) {
  const trust = verified.get(state);
  if (!trust) throw new Error('a snapshot from the pinned finalized-state reader is required');
  if (state.record_only) throw new Error('a record-only proof cannot authorize a private trade or approval');
  const age = Date.now() - new Date(state.header_time).getTime();
  if (!Number.isFinite(age) || age < -60000 || age > trust.maxAgeSeconds * 1000) throw new Error('finalized private snapshot expired');
  if (!context || context.chain !== state.chain_id || context.licenceRevision !== state.licence_revision || context.reviewer !== Buffer.from(state.reviewer.public_key, 'base64url').toString('hex') || typeof context.expires !== 'string' || !/^[1-9][0-9]{0,18}$/.test(context.expires) || BigInt(context.expires) > 0x7fffffffffffffffn || BigInt(context.expires) < BigInt(state.height) || BigInt(context.expires) > BigInt(state.height) + 720n) throw new Error('approval context differs from finalized policy/licence state');
  return state;
}
export function signApprovalFromPrivateState({ state, context, agreement, ...review }) {
  if (state?.coin?.owner) throw new Error('boundary owner snapshot cannot authorize an OTC payment');
  assertPrivateStateContext(state, context);
  if (state.policy_only || state.parties.length !== 2) throw new Error('two proven licensed parties are required for an OTC approval');
  if (!agreement || privatePurposeCommitment(agreement) !== context.purpose) throw new Error('reviewed private agreement differs from the purpose commitment');
  return signPrivateApproval({ ...review, context, licensedSenderKey: publicKey(state.parties[0].public_key), licensedRecipientKey: publicKey(state.parties[1].public_key), trustedRelayerKey: publicKey(state.relayer.public_key) });
}
export function signBoundaryFromPrivateState({ state, context, boundary, agreement, ...review }) {
  const trust = verified.get(state);
  if (!trust || !state.coin?.owner || state.coin.policy !== coinPolicy) throw new Error('a pinned finalized Coin owner snapshot is required');
  assertPrivateStateContext(state, context);
  if (state.policy_only || boundary.member !== state.coin.owner.member) throw new Error('boundary context differs from proven owner/policy/licence state');
  if (boundary.direction === 'shield' && BigInt(boundary.amount) > BigInt(state.coin.balance) || boundary.direction === 'exit' && BigInt(boundary.amount) > BigInt(state.coin.supply.shielded)) throw new Error('boundary exceeds proven available value');
  return signCoinBoundaryApproval({ ...review, context, boundary, agreement, licensedOwnerKey: publicKey(state.coin.owner.public_key) });
}

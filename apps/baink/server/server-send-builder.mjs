/** Server-side builder for no-install sends: `uain-coin-wallet shield` with a
 * `recipient`, so the paid output goes to the payee and no member key is read.
 * The checker sees the review packet (with the one-time outgoing viewing key),
 * decrypts both outputs and signs the boundary approval; the tool then proves
 * and self-verifies the bundle. Nothing here can debit a balance: the member
 * still has to sign the native `coin_shield` command in the browser. */
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJSON, coinBoundaryApprovalBytes } from './server-send-crypto.mjs';
import { checkSendInspection } from './server-send-check.mjs';

export { checkSendInspection };

const sha = value => createHash('sha256').update(value).digest('hex');
const ensure = (ok, message) => { if (!ok) throw new Error(message); };

async function pinned(tool) {
  ensure(tool && typeof tool.executable === 'string' && /^[a-f0-9]{64}$/.test(tool.executableSha256 ?? ''), 'pinned coin wallet tool required');
  ensure(sha(await readFile(tool.executable)) === tool.executableSha256, 'coin wallet tool differs from its pin');
  return tool.executable;
}
function lines(child) {
  let buffer = '', waiting = [], ended = false;
  const queue = [];
  child.stdout.on('data', bytes => {
    buffer += bytes;
    ensure(buffer.length <= 4 * 1024 * 1024, 'coin wallet output exceeds bound');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); (waiting.shift() ?? (v => queue.push(v)))(line); }
  });
  child.stdout.on('end', () => { ended = true; for (const w of waiting.splice(0)) w(null); });
  return () => new Promise(resolve => queue.length ? resolve(queue.shift()) : ended ? resolve(null) : waiting.push(resolve));
}

/** The default external address of a raw Orchard full viewing key (no-install
 * receiving), from the pinned coin wallet's `address-from-fvk`. A refused key
 * throws an error whose message contains "refused". One derivation at a time (L5, security review
 * 13 November 2026): each reads the whole pinned binary and spawns it, and parallel registrations
 * spawned a dozen at once. It has its own turn, so it never waits behind a proof. */
// The line is bounded (review, 13 November 2026): one key could queue 120 a minute that kept
// running after its client left. Registration is once per member, so 8 in line is never reached
// in normal use; past it BAINK answers busy (503 receiving_key_unavailable, try again shortly).
const DERIVE_QUEUE = 8;
let deriving = Promise.resolve(), inLine = 0;
export function addressFromFullViewingKey(coinWallet, fullViewingKey, options = {}) {
  if (inLine >= DERIVE_QUEUE) return Promise.reject(new Error('coin wallet busy deriving receiving addresses'));
  inLine++;
  const run = deriving.then(() => deriveAddress(coinWallet, fullViewingKey, options)).finally(() => { inLine--; });
  deriving = run.catch(() => {});
  return run;
}
async function deriveAddress(coinWallet, fullViewingKey, { timeoutMs = 30000 } = {}) {
  ensure(typeof fullViewingKey === 'string' && /^[a-f0-9]{192}$/.test(fullViewingKey), 'full viewing key refused');
  const executable = await pinned(coinWallet);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['address-from-fvk'], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', b => { out += b; if (out.length > 4096) child.kill('SIGKILL'); });
    child.once('error', reject);
    child.stdin.on('error', () => {});
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('full viewing key refused by the coin wallet'));
      try { const v = JSON.parse(out); ensure(typeof v?.address === 'string' && /^[a-f0-9]{86}$/.test(v.address), 'coin wallet address invalid'); resolve(v.address); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ full_viewing_key: fullViewingKey }) + '\n');
  });
}

/**
 * coinWallet  {executable, executableSha256}
 * checker     {publicKeyHex, review({request, packetFile, expected}) -> {status:'approved', approval}|{status:'queued',retryAt}|{status:'refused',reason}}
 */
export function createCoinWalletSendBuilder({ coinWallet, checker, workDirectory, timeoutMs = 180000 }) {
  ensure(typeof checker?.review === 'function' && /^[a-f0-9]{64}$/.test(checker.publicKeyHex ?? ''), 'send checker required');
  // One coin wallet process at a time: a proof peaks near 107 MB (measured on
  // the app server, 9 Nov 2026) and the BAINK unit is capped at 320 MiB, so two
  // concurrent proofs could OOM the server itself. Later builds wait their turn.
  let turn = Promise.resolve();
  const exclusive = fn => { const run = turn.then(fn, fn); turn = run.catch(() => {}); return run; };
  return Object.freeze({
    build: input => exclusive(() => buildOne(input)),
  });
  async function buildOne(input) {
      const executable = await pinned(coinWallet);
      const directory = await mkdtemp(join(workDirectory, 'send-'));
      const packetFile = join(directory, 'review.json');
      const child = spawn(executable, ['shield'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
      let stderr = '';
      child.stderr.on('data', b => { stderr = (stderr + b).slice(-2000); });
      const exited = new Promise(resolve => child.once('close', code => resolve(code)));
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const next = lines(child);
      try {
        const intent = {
          chain_id: input.chainId, expires_height: input.expiresHeight, licence_revision: input.licenceRevision,
          key_file: '', commitments: [], compact_witness: null, note_count: input.frontier.count, expected_root: input.frontier.root,
          source_bundle: null, source_position: null, member: input.member, amount: input.amountUnits,
          purpose_commitment: input.purposeCommitment, reviewer_public_key: checker.publicKeyHex,
          memo: input.memo, review_file: packetFile, recipient: input.recipientAddress,
        };
        child.stdin.write(JSON.stringify(intent) + '\n');
        const requestLine = await next();
        ensure(requestLine, 'coin wallet refused the send: ' + stderr.trim().slice(0, 300));
        const request = JSON.parse(requestLine);
        ensure(request.direction === 'shield' && request.member === input.member && request.amount === input.amountUnits && request.purpose_commitment === input.purposeCommitment && request.expires_height === input.expiresHeight, 'coin wallet request differs from the intent');
        const decision = await checker.review({ request, packetFile, expected: { recipientAddress: input.recipientAddress, amountUnits: input.amountUnits, member: input.member, purposeCommitment: input.purposeCommitment, intentId: input.intentId, chainId: input.chainId, evidence: input.evidence ?? null } });
        if (decision?.status !== 'approved') { child.kill('SIGKILL'); return decision?.status === 'queued' ? { status: 'queued', retryAt: decision.retryAt ?? null, reason: decision.reason ?? 'checker-capacity', ...(decision.claimExpiresHeight ? { claimExpiresHeight: decision.claimExpiresHeight } : {}) } : { status: 'refused', reason: decision?.reason ?? 'checker refused' }; }
        const approval = decision.approval;
        child.stdin.write(JSON.stringify({ ...approval, signature: Buffer.from(approval.signature, 'base64url').toString('hex') }) + '\n');
        const bundleLine = await next();
        ensure(bundleLine, 'coin wallet did not finish the proof: ' + stderr.trim().slice(0, 300));
        const { bundle_hex: hex } = JSON.parse(bundleLine);
        ensure(typeof hex === 'string' && /^[a-f0-9]+$/.test(hex) && hex.length <= 32768, 'coin wallet returned an invalid bundle');
        ensure((await exited) === 0, 'coin wallet failed');
        return { status: 'built', bundle: Buffer.from(hex, 'hex').toString('base64url'), approval, ...(decision.route ? { route: decision.route } : {}) };
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGKILL');
        await rm(directory, { recursive: true, force: true });
      }
  }
}

/** Run `uain-coin-wallet inspect-review` on a packet: the decrypted outputs. */
export async function inspectSendPacket(coinWallet, packetFile) {
  const executable = await pinned(coinWallet);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['inspect-review', packetFile], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    let out = '', err = '';
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    child.once('error', reject);
    child.once('close', code => { if (code !== 0) return reject(new Error('inspect-review refused: ' + err.slice(0, 300))); try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
  });
}

/** DEVNET ONLY: a deterministic rule checker holding a fictional reviewer key.
 * Production keeps the existing custody checker (policy P1 is unanswered). */
export function createDevnetRuleChecker({ reviewerPrivateKey, coinWallet, chainId, capacity = null }) {
  const raw = Buffer.from(createPublicKey(reviewerPrivateKey).export({ type: 'spki', format: 'der' })).subarray(-32);
  const reviewer = 'uain1' + sha(raw).slice(0, 40);
  return Object.freeze({
    publicKeyHex: raw.toString('hex'),
    reviewer,
    async review({ request, packetFile, expected }) {
      if (capacity && !capacity()) return { status: 'queued', retryAt: new Date(Date.now() + 5000).toISOString(), reason: 'checker-capacity' };
      ensure(expected.chainId === chainId && request.member === expected.member && request.amount === expected.amountUnits && request.purpose_commitment === expected.purposeCommitment, 'request differs from the signed intent');
      try { checkSendInspection(await inspectSendPacket(coinWallet, packetFile), expected); } catch (error) { return { status: 'refused', reason: error.message }; }
      const context = { version: 1, chain: chainId, expires: request.expires_height, licenceRevision: request.licence_revision, effects: request.effects, purpose: request.purpose_commitment, reviewer: raw.toString('hex') };
      const boundary = { direction: 'shield', member: request.member, amount: request.amount };
      const signature = sign(null, coinBoundaryApprovalBytes(context, boundary, 'neutral'), reviewerPrivateKey).toString('base64url');
      return { status: 'approved', approval: { reviewer, effects: request.effects, purpose_commitment: request.purpose_commitment, class: 'neutral', expires_height: request.expires_height, licence_revision: request.licence_revision, signature, direction: 'shield', member: request.member, amount: request.amount } };
    },
  });
}

/** Production checker: the appointed boundary reviewer in custody. Policy P1
 * (Rahul, 9 Nov 2026): custody's automatic rule checks approve ordinary sends
 * (`finalize-rules`); sends above 10,000 AI$, or ones a rule flags, get one AI
 * checker decision through the private review broker first. Custody verifies the
 * payer's signed intent and the payee's signed receiving address, decrypts both
 * outputs with the one-time key, applies `checkSendInspection`, keeps one live
 * approval per intent, and signs only after a non-refusing AI attestation.
 *
 * rootAction(action, jobId, body)  restricted custody transport (review-root-client)
 * aiReview(binding, {timeoutMs})   -> {status:'attested'|'refused'|'pending'|'unavailable', retryAt?}
 */
export function createCustodySendChecker({ rootAction, aiReview, reviewerPublicKeyHex, timeoutMs = 140000, retryMs = 60000, now = Date.now }) {
  ensure(typeof rootAction === 'function' && typeof aiReview === 'function' && /^[a-f0-9]{64}$/.test(reviewerPublicKeyHex ?? ''), 'custody send checker configuration required');
  const reviewer = 'uain1' + sha(Buffer.from(reviewerPublicKeyHex, 'hex')).slice(0, 40);
  const queued = (reason, retryAt = null) => ({ status: 'queued', retryAt: retryAt ?? new Date(now() + retryMs).toISOString(), reason });
  return Object.freeze({
    publicKeyHex: reviewerPublicKeyHex,
    reviewer,
    async review({ request, packetFile, expected }) {
      const started = now(), e = expected?.evidence;
      ensure(e && e.intent && typeof e.signature === 'string' && typeof e.publicKey === 'string' && e.registration, 'signed send evidence required');
      ensure(request.member === expected.member && request.amount === expected.amountUnits && request.purpose_commitment === expected.purposeCommitment && request.direction === 'shield', 'request differs from the signed intent');
      const packet = JSON.parse(await readFile(packetFile, 'utf8'));
      const context = { version: 1, chain: expected.chainId, expires: request.expires_height, licenceRevision: request.licence_revision, effects: request.effects, purpose: request.purpose_commitment, reviewer: reviewerPublicKeyHex };
      const jobId = sha('BAINK/server-send-custody/v1\n' + request.effects).slice(0, 32);
      const created = await rootAction('create', jobId, { context });
      ensure(created?.status === 'created' && created.jobId === jobId, 'custody refused the send context');
      const ingested = await rootAction('send-ingest', jobId, { packet, intent: e.intent, signature: e.signature, publicKey: e.publicKey, registration: e.registration });
      ensure(ingested?.status === 'ingested', 'custody refused the send evidence');
      // From here custody may hold its one live approval per intent on this bundle, until the
      // bundle's expiry height. A retry builds a new bundle, so it must wait for that height
      // (security review S7, 10 November 2026): `claimExpiresHeight` tells the send service.
      const held = (reason, retryAt = null, height = request.expires_height) => ({ ...queued(reason, retryAt), claimExpiresHeight: height });
      let inspected;
      // Custody answers a refusal with its reason. A call that fails gives no answer at all: the
      // service can be busy with another member's payment, its reader can time out, or an earlier
      // bundle can still hold the claim. That was shown to the payer as "recipient, amount or
      // signatures differ" and ended the send (three of four simultaneous payments, 9 November
      // 2026). It is not a refusal: ask again once the window passed. The send service bounds
      // these retries.
      try { inspected = await rootAction('inspect', jobId); } catch { return held('checker-unanswered'); }
      // A rule refusal (refuse list) carries custody's own reason.
      if (inspected?.status === 'refused') return { status: 'refused', reason: ('The custody checker refused this payment: ' + String(inspected.reason ?? 'refused by rule')).slice(0, 300) };
      // Newer custody says so itself when an earlier bundle of this intent still holds the claim.
      if (inspected?.status === 'claim-held') return held('checker-claim-held', null, /^[1-9][0-9]{0,18}$/.test(inspected.retryAfterHeight ?? '') ? inspected.retryAfterHeight : request.expires_height);
      ensure(/^[a-f0-9]{64}$/.test(inspected?.inspectionDigest ?? ''), 'custody returned no inspection');
      // P1 (9 Nov 2026): custody routes each send. Its rule checks approve ordinary
      // sends; only sends above 10,000 AI$, or ones a rule flags, go to the AI checker.
      const check = (finalized) => {
        const a = finalized?.approval;
        ensure(a && finalized.reviewerBinding === null && a.reviewer === reviewer && a.effects === request.effects && a.purpose_commitment === request.purpose_commitment && a.expires_height === request.expires_height && a.licence_revision === request.licence_revision && a.direction === 'shield' && a.member === request.member && a.amount === request.amount && ['neutral', 'benevolent'].includes(a.class), 'custody approval differs from the send');
        return a;
      };
      if (inspected.route === 'rules') return { status: 'approved', approval: check(await rootAction('finalize-rules', jobId)), route: 'rules' };
      const binding = { custodyJobId: jobId, owner: expected.member, publicKey: Buffer.from(e.publicKey, 'base64').toString('base64url'), contextDigest: sha(canonicalJSON(context)), inspectionDigest: inspected.inspectionDigest };
      const remaining = Math.max(1000, timeoutMs - (now() - started));
      let decision;
      try { decision = await aiReview(binding, { timeoutMs: remaining }); } catch { return held('checker-busy'); }
      if (decision?.status === 'refused') return { status: 'refused', reason: 'The AI checker refused this payment.' };
      if (decision?.status !== 'attested') return held(decision?.status === 'unavailable' ? 'checker-unavailable' : 'checker-capacity', decision?.retryAt ?? null);
      return { status: 'approved', approval: check(await rootAction('finalize', jobId)), route: 'ai' };
    },
  });
}

/** Relay a member-signed coin_shield envelope (public bytes only). */
export function createShieldTransport({ rpc, chainId }) {
  return Object.freeze({
    async broadcastShield(envelope, { timeoutMs = 8000 } = {}) {
      ensure(envelope?.command?.operation === 'coin_shield' && envelope.command.chain_id === chainId, 'only coin_shield is relayed');
      const bytes = Buffer.from(JSON.stringify(envelope));
      ensure(bytes.length <= 65536, 'envelope exceeds bound');
      const transactionHash = sha(bytes).toUpperCase();
      const response = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', body: JSON.stringify({ jsonrpc: '2.0', id: 'baink-server-send', method: 'broadcast_tx_sync', params: { tx: bytes.toString('base64') } }), signal: AbortSignal.timeout(timeoutMs) });
      ensure(response.ok, 'native RPC unavailable');
      const text = await response.text();
      ensure(text.length <= 65536, 'native RPC reply exceeds bound');
      const value = JSON.parse(text);
      ensure(!value.error && Number.isInteger(value.result?.code) && value.result.code >= 0 && String(value.result.hash).toUpperCase() === transactionHash, 'native RPC reply differs');
      return { accepted: value.result.code === 0, code: value.result.code, transactionHash, log: String(value.result.log ?? '').slice(0, 300) };
    },
  });
}

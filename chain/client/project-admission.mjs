// One source-bound admission plan. The holder's existing native bridge retains
// keys, performs authorization, journals commands and independently proves finality.
// This module neither evaluates scientific novelty nor grants roles or rewards.
import {createHash} from 'node:crypto';
import {canonicalEvidence} from './evidence-document.mjs';

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const digest = value => createHash('sha256').update(canonicalEvidence(value)).digest('hex');
const copy = value => JSON.parse(canonicalEvidence(value));
function exact(value, keys, name) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(value, k)))
    throw Error(`Exact ${name} fields required`);
}
function text(value, min, max, name) {
  if (typeof value !== 'string' || value.trim().length < min || Buffer.byteLength(value) > max || value.includes('\0'))
    throw Error(`Bounded ${name} required`);
}
function prior(value) {
  exact(value, ['basis', 'searches'], 'prior art');
  text(value.basis, 40, 3000, 'prior-art basis');
  if (!Array.isArray(value.searches) || value.searches.length < 2 || value.searches.length > 16)
    throw Error('Two to sixteen actual prior-art searches required');
  value.searches.forEach(x => text(x, 5, 500, 'prior-art search'));
  if (new Set(value.searches.map(x => x.trim())).size !== value.searches.length)
    throw Error('Distinct actual prior-art searches required');
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {Object.values(value).forEach(deepFreeze); Object.freeze(value);}
  return value;
}
function validate(input) {
  exact(input, ['scope', 'source', 'decision', 'project', 'task'], 'admission input');
  exact(input.scope, ['chainId', 'genesisSha256', 'member', 'instance'], 'scope');
  text(input.scope.chainId, 1, 128, 'chain ID');
  if (!SHA.test(input.scope.genesisSha256)) throw Error('Genesis SHA-256 required');
  if (!/^uain1[a-f0-9]{40}$/.test(input.scope.member)) throw Error('Native member required');
  if (!INSTANCE.test(input.scope.instance)) throw Error('Bounded instance ID required');
  exact(input.source, ['id', 'digest'], 'source');
  text(input.source.id, 1, 96, 'source ID');
  if (!SHA.test(input.source.digest)) throw Error('Source SHA-256 required');
  exact(input.decision, ['status', 'basis', 'searches'], 'evaluated decision');
  if (!['approved', 'held', 'rejected'].includes(input.decision.status)) throw Error('Explicit evaluated decision required');
  prior({basis: input.decision.basis, searches: input.decision.searches});
  exact(input.project, ['id', 'title', 'class', 'prior_art'], 'project');
  exact(input.task, ['id', 'project', 'title', 'class', 'prior_art', 'criteria', 'kind', 'karma_reward', 'credit_reward'], 'task');
  for (const value of [input.project, input.task]) {
    if (!ID.test(value.id)) throw Error('Lowercase canonical pilot ID required');
    text(value.title, 5, 250, 'title');
    if (!['benevolent', 'neutral'].includes(value.class)) throw Error('Permitted class required');
    prior(value.prior_art);
  }
  if (input.task.project !== input.project.id || input.task.id === input.project.id) throw Error('Exact project/task binding required');
  text(input.task.criteria, 40, 4000, 'task criteria');
  if (input.task.kind !== 'instant' || input.task.karma_reward !== 0 || input.task.credit_reward !== '0')
    throw Error('Pilot permits only instant zero-reward tasks; funding is separate');
}
function derive(input) {
  validate(input);
  const frozen = copy(input);
  const planDigest = digest(frozen);
  const commitment = `\nSource ${frozen.source.id}@${frozen.source.digest}; evaluated admission ${planDigest}.`;
  const payloads = [copy(frozen.project), copy(frozen.task)];
  for (const payload of payloads) {
    payload.prior_art.basis += commitment;
    if (Buffer.byteLength(payload.prior_art.basis) > 4000) throw Error('Public source commitment exceeds prior-art bound');
  }
  return {version: 1, digest: planDigest, ...frozen, steps: payloads.map((payload, i) => ({
    request_id: `admit-${planDigest.slice(0, 56)}-${i}`, operation: i === 0 ? 'open_project' : 'open_task', payload,
  }))};
}

export function freezeProjectAdmission(input) {
  return deepFreeze(derive(input));
}

function checked(plan) {
  exact(plan, ['version', 'digest', 'scope', 'source', 'decision', 'project', 'task', 'steps'], 'frozen plan');
  const expected = derive(Object.fromEntries(['scope', 'source', 'decision', 'project', 'task'].map(k => [k, plan[k]])));
  if (canonicalEvidence(plan) !== canonicalEvidence(expected)) throw Error('Frozen admission intent changed');
  return expected;
}

// Derive the BAINK allowlist from the SAME checked public admission intent.
// Do not manually reconstruct payloads: the source commitment is already in them.
export function projectAdmissionPilotConfig(plan) {
  const frozen = checked(plan);
  if (frozen.decision.status !== 'approved') throw Error('Only an approved evaluated admission can configure a pilot');
  return deepFreeze({
    sourceId: frozen.source.id,
    sourceDigest: frozen.source.digest,
    projectId: frozen.project.id,
    taskId: frozen.task.id,
    creatorAddress: frozen.scope.member,
    creatorInstance: frozen.scope.instance,
    chainId: frozen.scope.chainId,
    epoch: frozen.scope.genesisSha256,
    projectPayload: copy(frozen.steps[0].payload),
    taskPayload: copy(frozen.steps[1].payload),
  });
}

// invoke must be the trusted member-held bridge's invoke method, NOT a network
// acknowledgement. Repeating this function reuses its SAME durable request IDs;
// the bridge recovers journals/receipts without signing or broadcasting again.
export async function runProjectAdmission(plan, {invoke, currentScope, sourceDigest} = {}) {
  const frozen = checked(plan);
  const common = {source: frozen.source, scope: frozen.scope, planDigest: frozen.digest,
    projectId: frozen.project.id, taskId: frozen.task.id, financialOperations: false,
    scientificAcceptance: false, receipts: []};
  if (frozen.decision.status !== 'approved') return {...common, state: frozen.decision.status};
  if (typeof invoke !== 'function' || typeof currentScope !== 'function' || typeof sourceDigest !== 'function')
    throw Error('Holder-local bridge and current scope/source readers required');
  for (const step of frozen.steps) {
    if (canonicalEvidence(await currentScope()) !== canonicalEvidence(frozen.scope)) throw Error('Native chain epoch or actor changed');
    if (await sourceDigest(frozen.source.id) !== frozen.source.digest) throw Error('Proposal source changed');
    const result = await invoke('uain_native_command', copy(step));
    if (!result || result.authority !== 'native' || result.request_id !== step.request_id || typeof result.finalized !== 'boolean')
      throw Error('Exact holder-bridge receipt required');
    if (!result.finalized) return {...common, state: 'pending', pendingOperation: step.operation,
      pendingRequestId: step.request_id, receipts: common.receipts.slice()};
    const event = result.event;
    if (!event || !/^[0-9]+$/.test(String(event.id)) || event.operation !== step.operation ||
        event.subject !== step.payload.id || event.member !== frozen.scope.member || event.instance !== frozen.scope.instance)
      throw Error('Finalized receipt differs from the frozen operation or actor');
    // Existing bridge verifies chain/genesis and command digest against its
    // durable journal. Enforce optional echoed context rather than inventing it.
    if (result.chain_id !== undefined && result.chain_id !== frozen.scope.chainId ||
        result.proof?.chain_id !== undefined && result.proof.chain_id !== frozen.scope.chainId ||
        result.genesis_sha256 !== undefined && result.genesis_sha256 !== frozen.scope.genesisSha256)
      throw Error('Finalized receipt chain differs');
    if (event.command_digest !== undefined && !SHA.test(event.command_digest)) throw Error('Malformed receipt command digest');
    common.receipts.push(copy(result));
  }
  return {...common, state: 'admitted'};
}

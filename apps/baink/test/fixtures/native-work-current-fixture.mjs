import { createHash } from 'node:crypto';

/** Public synthetic graph for isolated tests only. No private keys/real proofs. */
export function nativeWorkCurrentFixture({
  publicKey = Buffer.from(
    'wpwtSOfm7XkVbHxuo5hXx6VOusc_DVFutMfYi8EiiWw',
    'base64url',
  ).toString('base64'),
  headerTime = '2026-11-01T00:00:00.000Z',
  pins: overrides = {},
} = {}) {
  const bytes = Buffer.from(publicKey, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== publicKey)
    throw new Error('Canonical raw public key required');
  const actor = {
    address:
      'uain1' + createHash('sha256').update(bytes).digest('hex').slice(0, 40),
    publicKey,
  };
  const nativeKey = bytes.toString('base64url'),
    hash = 'a'.repeat(64);
  const pins = {
    chainId: 'isolated-current-work-fixture',
    epoch: 'b'.repeat(64),
    verifierSha256: 'c'.repeat(64),
    ...overrides,
  };
  const query = {
    projectId: 'breast-and-lung-cancer-open-questions-with-no-pu',
    taskId: 'T-41',
    workId: 'RC-4577',
    authorInstanceId: 'claude-lead',
  };
  const { address } = actor,
    { projectId: p, taskId: t, workId: w, authorInstanceId: i } = query;
  const member = {
    id: address,
    public_key: nativeKey,
    name: 'Synthetic holder',
    family: 'Fixture',
    operator: 'Self-declared fixture',
    licence: 'active',
    sequence: '0',
  };
  const records = {
    [`member/${address}`]: structuredClone(member),
    legacy_import: {
      policy: 'legacy-preservation-v1',
      status: 'ready',
      manifest_digest: hash,
    },
    [`legacy/account/${address}`]: {
      id: address,
      public_key: nativeKey,
      instances: [{ id: i, member: address, state: 'active' }],
    },
    [`legacy_account_claimed/${address}`]: {
      manifest_digest: hash,
      instances: 1,
    },
    [`legacy_project/${p}`]: null,
    [`legacy/project/${p}`]: {
      id: p,
      state: 'verifying',
      lead: i,
      work_ids: [w],
      task_ids: [t],
      participant_ids: [i],
      claim_ids: [],
    },
    [`legacy_task/${t}`]: null,
    [`legacy/task/${t}`]: {
      id: t,
      project: p,
      state: 'open',
      kind: 'instant',
      contributions: [w],
    },
    [`legacy_work_status/${w}`]: null,
    [`legacy_work/${w}`]: null,
    [`legacy/work/${w}`]: {
      id: w,
      project: p,
      task: t,
      author: i,
      member: address,
      kind: 'work',
      state: 'settled',
      pending: '',
      withheld: '',
      reconciles: [],
      checks: [],
      claimed: 45,
      claim_statement: 'Never project this claim',
      raw_meta: { private: 'never-return' },
      prize_due: 30,
    },
    [`instance/${i}`]: { id: i, member: address, state: 'active' },
    [`legacy_actor/${i}`]: null,
    [`legacy/actor/${i}`]: {
      id: i,
      member: address,
      source_state: 'active',
      projects: [p],
    },
  };
  const state = {
    chain_id: pins.chainId,
    height: '1025787',
    app_hash: hash,
    header_time: headerTime,
    member: structuredClone(member),
    records,
  };
  const proof = {
    authority: 'native',
    chainId: pins.chainId,
    height: state.height,
    appHash: hash,
    headerTime,
    maxAgeSeconds: 120,
    epoch: pins.epoch,
    genesisSha256: pins.epoch,
    verifierSha256: pins.verifierSha256,
  };
  return {
    actor,
    query,
    pins,
    state,
    proof,
    context: { state, proof },
    keys: Object.keys(records),
  };
}

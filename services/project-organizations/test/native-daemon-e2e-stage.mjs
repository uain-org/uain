/** FIXTURE QUALIFICATION ONLY. Opt-in (UAIN_ORGS_NATIVE_E2E=1); never points at an existing
 * chain, never seeds production, never reads a production key.
 *
 * Qualifies the project-organization native adapter (`native.mjs` + `journal.mjs` +
 * `native-reader.mjs`) against a REAL compatible native daemon: two disposable `uaind`
 * processes (pinned production release 0.3.9) on a unique fictional genesis, read through the
 * original pinned `uain-state` verifier via BAINK's `createNativeAssetAdapter`. Every identity,
 * key, prior-art record, plan, task, evidence and review below is explicitly FIXTURE/fictional.
 *
 * What is real: the daemon, consensus, CheckTx/FinalizeBlock execution, the pinned reader's
 * signed-header/app-hash proofs, gateway receipts, the adapter, journal, bootstrap, fund
 * worker, pricing, scheduler and runtime cycle. What is fixture: custody (in-process signer
 * with throwaway keys, labelled), the Fund Manager provider (never a model, `actual:false`),
 * the solver executor, the prior-art records, and the central reviewer (a fictional key
 * signing `central_review` directly, exactly as chain/scripts/central-earning-network-smoke.mjs
 * does in isolation). The central_earning activation follows the existing fixtures.
 *
 * Run: services/project-organizations/ops/qualify-native.sh (isolated container on the test host).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, createPrivateKey, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, rm, mkdir, appendFile, copyFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signedEnvelope, signingBytes } from '../../../chain/client/signing.mjs';
import { createNativeAssetAdapter } from '../../../apps/baink/server/native-asset.mjs';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { CENTRAL_POLICY } from '../../../apps/baink/server/central-earning-command.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { openRegistry } from '../src/registry.mjs';
import { openJournal } from '../src/journal.mjs';
import { FLEET_POLICY_SCHEMA, NATIVE_ROLE_OPERATIONS, createNativeAdapter } from '../src/native.mjs';
import { createNativeReader } from '../src/native-reader.mjs';
import { verifyFleetEnvelope } from '../src/broadcast.mjs';
import { BOOTSTRAP_OPERATIONS, BOOTSTRAP_REVIEW_SCHEMA, createBootstrap } from '../src/bootstrap.mjs';
import { readPricingInputs, validatePricedTask } from '../src/pricing.mjs';
import { openComputeBudget } from '../src/compute-budget.mjs';
import { createScheduler, fundingEpochOf } from '../src/scheduler.mjs';
import { runCycle } from '../src/runtime.mjs';
import { ARTIFACT_SCHEMA, driverDigest } from '../src/verification.mjs';
import { buildSurveyTask, requireAcceptedSurvey, surveyStatus } from '../src/survey.mjs';
import { draftOf, fixtureSurvey, reviewedOf } from './fixtures/survey-fixture.mjs';
import { byText, canonical } from '../src/common.mjs';
import { sourceDigestOf } from '../src/selection.mjs';
import { openFundWorker, openReportStore } from '../../fund-manager/src/worker.mjs';
import { createTaskReader, fundStep, readNativeSnapshot } from '../ops/manager-stage.mjs';
import { FUND_DECIDER_MODEL, applicationId, decisionPayload } from '../src/fund-rounds.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Expected pins come from the reviewed runtime, never from the tested file:
 * daemon = native release 0.3.9 (/opt/uain-chain/releases/1604415b…/uaind) by default, or the
 * replay-checked 0.4.1 now on production (b525c808…) when qualify-native.sh selects it; no other,
 * reader = the original independent `uain-state` pin used by BAINK and every native fixture. */
const REVIEWED_DAEMONS = Object.freeze(['1604415b7302bf70236d50e6c999b7ab95d3029da697090f6bac08cddaee91a6',
  'b525c808aa017865ec798869f2d72f5ba5ce0e6fb432cb7700bb8a2a29260024']);
const SELECTED_DAEMON = process.env.UAIN_ORGS_E2E_DAEMON_PIN || REVIEWED_DAEMONS[0];
if (!REVIEWED_DAEMONS.includes(SELECTED_DAEMON)) throw Error('unreviewed daemon pin');
export const TOOL_PINS = Object.freeze({
  daemon: SELECTED_DAEMON,
  reader: '136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860',
});
/** Deliberately not the fixture chain: the reader must treat this chain as non-production. */
const PRODUCTION_PIN_PLACEHOLDER = 'uain-production-pin-not-this-fixture';
const enabled = process.env.UAIN_ORGS_NATIVE_E2E === '1';
/** Optional: run one stage only ('adapter', 'python' or 'fund'); all by default. */
const ONLY = process.env.UAIN_ORGS_E2E_ONLY || null;
const CHILD = process.argv.includes('--crash-child');
const FIXTURE_DIGEST = sha('FIXTURE project-organizations native qualification; fictional chain only; no research or production claim');

function fictionalIdentity(label, karma = 0) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const address = `uain1${sha(raw).slice(0, 40)}`;
  return {
    label, address, raw, privateKey,
    member: {
      id: address, public_key: raw.toString('base64url'), name: `FIXTURE ${label}`, operator: `FIXTURE ${label} operator`,
      family: `FIXTURE ${label} family`, licence: 'active', karma, credits: '0', sequence: '0', default_verifier: false, creator: false, active_projects: 0,
    },
  };
}

/** FIXTURE custody: an in-process signer over throwaway keys (never a vault, never production).
 * Uses chain/client/signing.mjs, so the adapter's own typed envelope checks also prove parity. */
function fixtureCustody(identities, { log = null } = {}) {
  const byAddress = new Map(identities.map((x) => [x.address, x]));
  const signed = [];
  return {
    fixture: true, signed,
    async sign(command, context) {
      const key = byAddress.get(command.member);
      if (!key) throw new Error('FIXTURE custody has no key for this member');
      signed.push({ intentId: context.intentId, operation: command.operation, role: context.role, caller: context.caller, sequence: command.sequence });
      if (log) await appendFile(log, JSON.stringify({ intentId: context.intentId, operation: command.operation, sequence: command.sequence }) + '\n');
      return signedEnvelope(command, key.raw, key.privateKey);
    },
  };
}

/** Reader over the pinned verifier; broadcast through the fleet operator transport when present. */
async function buildReader({ config, chainId, journal, reviewIds }) {
  const assets = createNativeAssetAdapter({ config });
  assert.equal(assets.configured, true, 'pinned reader configuration');
  let broadcaster = null;
  let broadcastTransport = 'fixture-rpc-broadcast_tx_sync';
  try {
    const ops = await import('../src/broadcast.mjs');
    if (typeof ops.createOperatorBroadcast === 'function' && typeof ops.createRpcTransport === 'function') {
      broadcaster = ops.createOperatorBroadcast({
        transport: ops.createRpcTransport({ rpc: config.rpc }), chainId, productionChainId: PRODUCTION_PIN_PLACEHOLDER,
        ...(typeof ops.retainedInJournal === 'function' ? { requireRetained: ops.retainedInJournal(journal) } : {}),
      });
      broadcastTransport = 'broadcast.mjs createOperatorBroadcast(createRpcTransport)';
    }
  } catch {
    broadcaster = null;
  }
  const transport = {
    pins: assets.pins,
    publicState: (selection, options) => assets.publicState(selection, options),
    // FIXTURE fallback only when broadcast.mjs is absent: the same broadcast_tx_sync body.
    async broadcast(envelope, { timeoutMs = 10000 } = {}) {
      const response = await fetch(config.rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'fixture', method: 'broadcast_tx_sync', params: { tx: Buffer.from(JSON.stringify(envelope)).toString('base64') } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.json();
      if (body.error) throw new Error('fixture broadcast error');
      return { code: body.result.code };
    },
  };
  let reader;
  const options = {
    transport, chainId, productionChainId: PRODUCTION_PIN_PLACEHOLDER, timeoutMs: 20000,
    reviewExecutionIds: async (submission) => reviewIds.get(submission) ?? [],
  };
  try {
    reader = createNativeReader({ ...options, ...(broadcaster ? { broadcaster } : {}) });
  } catch (error) {
    if (!broadcaster) throw error;
    reader = createNativeReader(options); // reader without broadcaster support
    broadcastTransport = 'fixture-rpc-broadcast_tx_sync';
  }
  return { reader, assets, broadcastTransport };
}

function fleetPolicy({ selection, X, manager, evaluator, solvers }) {
  const p = selection.get(X);
  return {
    schema: FLEET_POLICY_SCHEMA, revision: 1, selection_digest: selection.digest,
    projects: { [X]: {
      native_project: p.nativeProjectId, source_digest: p.sourceDigest, paperclip_company: '00000000-0000-4000-8000-00000000f1c5',
      manager, evaluator, max_task_units: '6000000000', max_plan_revision: 3,
    } },
    roles: Object.fromEntries(Object.entries(NATIVE_ROLE_OPERATIONS).map(([k, v]) => [k, [...v]])),
    solvers: [...solvers],
  };
}

/** Child process: dispatch one prepared intent and die (SIGKILL) after the signed envelope is
 * retained in the journal but before any byte is broadcast. */
async function crashChild() {
  const cfg = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--crash-child') + 1], 'utf8'));
  const selection = await loadSelection();
  const registry = openRegistry({ directory: cfg.registryDir, selection });
  const journal = openJournal({ directory: cfg.journalDir });
  const key = { address: cfg.signer.address, raw: Buffer.from(cfg.signer.raw, 'base64url'), privateKey: createPrivateKey(cfg.signer.pem) };
  const custody = fixtureCustody([key], { log: cfg.signLog });
  const { reader } = await buildReader({ config: cfg.readerConfig, chainId: cfg.chainId, journal, reviewIds: new Map() });
  const crashing = {
    read: reader.read, findCommand: reader.findCommand, tasks: reader.tasks, reviews: reader.reviews, supply: reader.supply,
    async broadcast() {
      // The envelope is already retained (journal.recordEnvelope runs before broadcast).
      await appendFile(cfg.signLog, JSON.stringify({ crash: 'before_broadcast', intentId: cfg.intentId }) + '\n');
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    },
  };
  const native = createNativeAdapter({ custody, reader: crashing, registry, journal, selection, policy: cfg.policy, chainId: cfg.chainId, guardian: cfg.guardian, timeoutMs: 60000 });
  await native.dispatch(cfg.intentId);
  process.exit(3); // unreachable: broadcast never returns
}

if (CHILD) await crashChild();

async function freePorts(n) {
  const listeners = [];
  try {
    for (let i = 0; i < n; i++) {
      const server = createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      listeners.push(server);
    }
    return listeners.map((s) => s.address().port);
  } finally {
    await Promise.all(listeners.map((s) => new Promise((resolve) => s.close(resolve))));
  }
}

/** Two real daemon processes on a unique fictional genesis (pattern of apps/baink/test/native-financial-e2e.test.mjs). */
async function disposableNetwork(t, people, root) {
  const daemon = process.env.UAIN_ORGS_E2E_DAEMON ?? '/tools/uaind';
  const stateBinary = process.env.UAIN_ORGS_E2E_STATE_BINARY ?? '/tools/uain-state';
  assert.equal(sha(await readFile(daemon)), TOOL_PINS.daemon, 'Unreviewed native daemon');
  assert.equal(sha(await readFile(stateBinary)), TOOL_PINS.reader, 'Unreviewed public reader');
  const chainId = `uain-orgs-fictional-e2e-${randomBytes(6).toString('hex')}`;
  const ports = await freePorts(4);
  const homes = [join(root, 'node-0'), join(root, 'node-1')];
  const running = new Set();
  const started = [];
  async function command(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(daemon, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const parts = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (b) => parts.push(b));
      child.once('error', reject);
      child.once('close', (code) => { clearTimeout(timer); const out = Buffer.concat(parts).toString(); code === 0 ? resolve(out) : reject(new Error(`fixture daemon command failed (${code}): ${out.slice(-4000)}`)); });
    });
  }
  function start(index) {
    const child = spawn(daemon, ['start', '--home', homes[index]], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (b) => { log = (log + b).slice(-12000); });
    child.diagnostics = () => log;
    running.add(child);
    started.push(child);
    child.once('exit', () => running.delete(child));
    return child;
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => { const timer = setTimeout(() => child.kill('SIGKILL'), 10000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
  }
  t.after(async () => { for (const child of [...running]) await stop(child); });
  async function rpc(index, method, params = {}) {
    const response = await fetch(`http://127.0.0.1:${ports[index * 2]}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(method.startsWith('broadcast') ? 20000 : 3000),
    });
    const body = await response.json();
    assert.ok(!body.error, JSON.stringify(body.error));
    return body.result;
  }
  async function waitFor(action, label, { attempts = 120, every = 500 } = {}) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try { const value = await action(); if (value) return value; } catch (error) { last = error; }
      if (running.size < 2) throw new Error(`fixture daemon exited during ${label}: ${started.map((c) => c.diagnostics()).join('\n')}`);
      await pause(every);
    }
    throw new Error(`${label}: ${last?.stack ?? 'condition not reached'}`);
  }
  const appGenesis = join(root, 'app-genesis.json');
  await writeFile(appGenesis, JSON.stringify({ version: 1, guardians: [people.guardian.address], members: Object.values(people).map((x) => x.member) }), { mode: 0o600 });
  for (let i = 0; i < 2; i++)
    await command(['init', '--home', homes[i], '--chain-id', chainId, '--app-genesis', appGenesis, '--rpc', `tcp://127.0.0.1:${ports[i * 2]}`, '--p2p', `tcp://127.0.0.1:${ports[i * 2 + 1]}`]);
  const genesis = join(homes[0], 'config/genesis.json');
  const genesisBytes = await readFile(genesis);
  await writeFile(join(homes[1], 'config/genesis.json'), genesisBytes);
  const nodeId = (await command(['node-id', '--home', homes[0]])).split(/\r?\n/).find((l) => /^[a-f0-9]{40}$/.test(l));
  assert.ok(nodeId);
  const configFile = join(homes[1], 'config/config.toml');
  await writeFile(configFile, (await readFile(configFile, 'utf8')).replace(/^persistent_peers = .*$/m, `persistent_peers = "${nodeId}@127.0.0.1:${ports[1]}"`)
    .replace(/^addr_book_strict = .*$/m, 'addr_book_strict = false').replace(/^allow_duplicate_ip = .*$/m, 'allow_duplicate_ip = true'));
  start(0);
  start(1);
  await waitFor(async () => Number((await rpc(1, 'status')).sync_info.latest_block_height) >= 3, 'two disposable nodes ready');
  const config = { binary: stateBinary, binaryHash: TOOL_PINS.reader, genesis, genesisHash: sha(genesisBytes), chainId, rpc: `http://127.0.0.1:${ports[0]}`, timeoutMs: 10000, maxAgeSeconds: 120 };
  const peerConfig = { ...config, rpc: `http://127.0.0.1:${ports[2]}` };
  const height = async () => BigInt((await rpc(0, 'status')).sync_info.latest_block_height);
  return { chainId, config, peerConfig, genesis, genesisBytes, rpc, waitFor, height, homes, daemonPids: () => started.map((c) => c.pid) };
}

test('FIXTURE: project-organization native adapter against a real pinned daemon on a fictional genesis', { skip: !enabled || (ONLY !== null && ONLY !== 'adapter'), timeout: 1700000 }, async (t) => {
  const evidenceDir = process.env.UAIN_ORGS_E2E_EVIDENCE ?? null;
  const root = await mkdtemp(join(tmpdir(), 'uain-orgs-fictional-native-'));
  const startedAt = new Date().toISOString();
  const steps = [];
  const note = (step, extra = {}) => { const row = { step, at: new Date().toISOString(), ...extra }; steps.push(row); t.diagnostic(`FIXTURE_STEP ${JSON.stringify(row)}`); };

  // Fictional identities only. The guardian is the genesis guardian and creator (it opens the
  // project and stays lead, design resolution 3); the reviewer is the designated central reviewer.
  const people = {
    guardian: fictionalIdentity('guardian'), reviewer: fictionalIdentity('central-reviewer', 100), relay: fictionalIdentity('relay'),
    manager: fictionalIdentity('project-manager'), evaluator: fictionalIdentity('fund-evaluator'),
    solverA: fictionalIdentity('solver-a'), solverB: fictionalIdentity('solver-b'),
  };
  people.guardian.member.creator = true;
  people.guardian.member.default_verifier = true;
  const network = await disposableNetwork(t, people, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { chainId, config, rpc, waitFor } = network;
  note('network_ready', { chainId, genesisSha256: config.genesisHash, daemonSha256: TOOL_PINS.daemon, readerSha256: TOOL_PINS.reader, height: String(await network.height()) });

  // Direct FIXTURE commands (activation and the fixture central reviewer), as the existing fixtures do.
  const assets = createNativeAssetAdapter({ config });
  async function direct(operation, payload, actor = people.guardian) {
    const current = await assets.publicState({ member: actor.address });
    const command = { version: 1, chain_id: chainId, member: actor.address, sequence: current.state.member.sequence,
      expires_height: String(BigInt(current.state.height) + 300n), operation, payload };
    const envelope = signedEnvelope(command, actor.raw, actor.privateKey);
    const result = await rpc(0, 'broadcast_tx_commit', { tx: Buffer.from(JSON.stringify(envelope)).toString('base64') });
    assert.equal(result.check_tx.code, 0, `${operation}: ${result.check_tx.log}`);
    assert.equal(result.tx_result.code, 0, `${operation}: ${result.tx_result.log}`);
    await waitFor(async () => BigInt((await rpc(0, 'status')).sync_info.latest_block_height) > BigInt(result.height) + 1n, `${operation} finality`);
    return { height: result.height, commandDigest: sha(signingBytes(command)) };
  }
  for (const [operation, policy, extra] of [
    ['activate_storage', 'compact-state-v1', {}], ['activate_membership', 'project-membership-v1', {}],
    ['activate_operator_rewards', 'pairwise-operator-rewards-v1', {}],
    ['activate_private_exchange', 'orchard-v2-reviewed-otc-v1', { relayer: people.relay.address }],
    ['activate_coin', 'verified-bounties-108t-micro-v1', {}],
  ]) note(operation, { height: (await direct(operation, { policy, evidence_digest: FIXTURE_DIGEST, ...extra })).height });
  const activation = await direct('central_earning_activate', { policy: CENTRAL_POLICY, reviewer: people.reviewer.address, evidence_digest: FIXTURE_DIGEST });
  note('central_earning_activate', { height: activation.height, policy: CENTRAL_POLICY, reviewer: 'FIXTURE central-reviewer' });

  // Real organization modules for one selected project.
  const selection = await loadSelection();
  const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
  const X = selection.ids.find((id) => selection.get(id).holds.length === 0 && Buffer.byteLength(catalogue.records.get(id)?.title ?? '') >= 5);
  const p = selection.get(X);
  const P = p.nativeProjectId;
  const sourceOf = async (id) => ({ revision: catalogue.revision, row: structuredClone(catalogue.records.get(id)) });
  const registry = openRegistry({ directory: join(root, 'registry'), selection });
  const journal = openJournal({ directory: join(root, 'journal') });
  t.after(() => { journal.close(); registry.close(); });
  const policy = fleetPolicy({ selection, X, manager: people.manager.address, evaluator: people.evaluator.address, solvers: [people.solverA.address, people.solverB.address] });
  registry.bind(X, { nativeProjectId: P, nativeManager: people.manager.address, nativeEvaluator: people.evaluator.address });
  const reviewIds = new Map();
  const { reader, broadcastTransport } = await buildReader({ config, chainId, journal, reviewIds });
  const custody = fixtureCustody([people.guardian, people.manager, people.evaluator, people.solverA, people.solverB]);
  const native = createNativeAdapter({ custody, reader, registry, journal, selection, policy, chainId, guardian: people.guardian.address, timeoutMs: 60000 });
  note('adapter_ready', { projectId: X, nativeProjectId: P, broadcastTransport, selectionDigest: selection.digest });

  /** Reconciles one intent until native proves it (finalized gateway receipt). Never re-signs. */
  async function confirmed(intentId, label) {
    for (let i = 0; i < 90; i++) {
      const r = await native.reconcile(intentId);
      if (r.status === 'confirmed') {
        const proof = r.intent.receipt;
        assert.equal(proof.authority, 'native');
        assert.equal(proof.finalized, true, `${label}: finalized receipt`);
        assert.equal(proof.chain_id, chainId);
        assert.equal(proof.receipt?.event?.command_digest, proof.command_digest, `${label}: gateway receipt binds the command digest`);
        return r.intent;
      }
      assert.ok(['dispatched', 'unknown'].includes(r.status), `${label}: unexpected ${r.status} ${r.intent?.failure ?? ''}`);
      await pause(1500);
    }
    throw new Error(`${label}: not confirmed`);
  }
  async function settle(intent, label, { caller } = {}) {
    assert.equal(intent.state, 'prepared', `${label}: prepared`);
    const sent = await native.dispatch(intent.id, caller ? { caller } : {});
    assert.equal(sent.status, 'dispatched', `${label}: dispatched`);
    assert.equal(sent.code, 0, `${label}: native CheckTx accepted`);
    const done = await confirmed(intent.id, label);
    note(label, { intentId: intent.id, operation: done.operation, eventId: done.receipt.event_id, height: done.receipt.height, commandDigest: done.receipt.command_digest });
    return done;
  }
  const records = async (keys) => (await reader.read({ keys })).records;

  // 1. Guardian bootstrap through bootstrap.mjs: open_project -> start -> configure -> manager join.
  const review = {
    schema: BOOTSTRAP_REVIEW_SCHEMA, project: X, source_digest: p.sourceDigest, class: 'benevolent',
    prior_art: {
      basis: 'FIXTURE prior-art record for an isolated fictional-chain qualification only. No real search was run and no novelty is claimed.',
      searches: ['FIXTURE search one (fictional, not executed)', 'FIXTURE search two (fictional, not executed)'],
    },
  };
  await assert.rejects(native.prepare(X, 'central_project_start', { project: P, manager: people.manager.address, evidence_digest: FIXTURE_DIGEST }),
    (e) => e.code === 'guardian_operation_unreachable', 'agent caller cannot reach guardian bootstrap');
  const bootstrap = createBootstrap({ adapter: native, journal, selection, policy, source: sourceOf, review: async () => review });
  let boot;
  for (let round = 0; round < 12; round++) {
    boot = await bootstrap.bootstrapProject(X);
    if (boot.status === 'complete') break;
    assert.equal(boot.status, 'waiting', `bootstrap ${boot.step}: ${boot.reason ?? ''} ${boot.failure ?? ''}`);
    const intent = journal.get(boot.intentId);
    if (intent.state === 'prepared') await settle(intent, `bootstrap_${boot.step}`, { caller: BOOTSTRAP_OPERATIONS.includes(boot.step) ? 'bootstrap' : 'agent' });
    else await confirmed(intent.id, `bootstrap_${boot.step}`);
  }
  assert.equal(boot.status, 'complete');
  assert.deepEqual(boot.completed.map((c) => c.step), ['open_project', 'central_project_start', 'central_fund_configure', 'project_join']);
  const again = await bootstrap.bootstrapProject(X);
  assert.deepEqual([again.status, again.completed.every((c) => c.via === 'journal')], ['complete', true], 'restartable bootstrap reuses the journal');
  const bootRecords = await records([`project/${P}`, `project_metadata/${P}`, `central_project_budget/${P}`, `central_fund_config/${P}`, `participation/${P}/${people.manager.address}/`]);
  assert.equal(bootRecords[`project/${P}`].lead, people.guardian.address, 'guardian opened and remains lead');
  // Compact storage: the state record carries only the metadata digest; title/class/prior art are immutable metadata.
  assert.deepEqual([bootRecords[`project/${P}`].storage_policy, bootRecords[`project/${P}`].title], ['compact-state-v1', '']);
  assert.equal(bootRecords[`project_metadata/${P}`].title, catalogue.records.get(X).title, 'title from the pinned catalogue source');
  assert.deepEqual(bootRecords[`project_metadata/${P}`].prior_art, review.prior_art, 'reviewed FIXTURE prior art recorded');
  // Lost journal: a fresh journal must recognise the exact native state and reuse it, never re-open.
  {
    const lostJournal = openJournal({ directory: join(root, 'journal-lost') });
    const lostCustody = fixtureCustody([people.guardian, people.manager]);
    const lostNative = createNativeAdapter({ custody: lostCustody, reader, registry, journal: lostJournal, selection, policy, chainId, guardian: people.guardian.address, timeoutMs: 60000 });
    const reboot = await createBootstrap({ adapter: lostNative, journal: lostJournal, selection, policy, source: sourceOf, review: async () => review }).bootstrapProject(X);
    assert.equal(reboot.status, 'complete', `lost-journal bootstrap: ${reboot.reason ?? ''}`);
    assert.deepEqual(reboot.completed.map((c) => c.via), ['native', 'native', 'native', 'native'], 'every step proven from native state');
    assert.deepEqual([lostCustody.signed.length, lostJournal.list().length], [0, 0], 'nothing signed or journaled');
    lostJournal.close();
    note('bootstrap_reused_after_lost_journal', { steps: reboot.completed.map((c) => `${c.step}@${c.height}`) });
  }
  assert.deepEqual([bootRecords[`central_project_budget/${P}`].manager, bootRecords[`central_project_budget/${P}`].allocation, bootRecords[`central_project_budget/${P}`].round],
    [people.manager.address, '10000000000', 1]);
  assert.equal(bootRecords[`central_fund_config/${P}`].evaluator, people.evaluator.address);
  assert.ok(bootRecords[`participation/${P}/${people.manager.address}/`], 'manager joined');

  // 2. Fund Manager plan + independent plan review (FIXTURE provider, actual:false).
  const jsonl = (value) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }) + '\n';
  const fundCalls = [];
  const fundProvider = {
    fixture: true,
    async execute({ role, projectId, executionId }) {
      fundCalls.push({ role, executionId });
      const kpi = selection.get(projectId).mainKpi;
      const stages = Array.from({ length: 5 }, (_, i) => ({ round: i + 1, criteria: `FIXTURE stage ${i + 1}: independently verify immutable evidence against the unchanged Main KPI.` }));
      const answer = role === 'fund_plan'
        ? { main_kpi: kpi, stages, reason: 'FIXTURE: five ordered sub-KPIs decompose the unchanged Main KPI.' }
        : { verdict: 'accept', findings: ['FIXTURE review: each stage carries observable immutable evidence (not a model review).'] };
      return { raw: jsonl(answer), receipt: { executionId, model: 'fixture-provider', actual: false } };
    },
  };
  const worker = openFundWorker({ registry, journal, native, provider: fundProvider, selection, source: sourceOf, reports: openReportStore({ directory: join(root, 'reports') }) });
  const proposal = await worker.plan(X);
  assert.equal(proposal.status, 'proposal_prepared');
  await settle(proposal.intents[0], 'central_fund_plan');
  const approval = await worker.plan(X);
  assert.equal(approval.status, 'approval_prepared');
  assert.notEqual(proposal.executions.plan, proposal.executions.review, 'distinct plan/review executions');
  await settle(approval.intents[0], 'central_fund_plan_review');
  assert.equal((await worker.status(X)).status, 'active');
  assert.deepEqual(fundCalls.map((c) => c.role), ['fund_plan', 'fund_review']);

  // 2b. The prior-art survey is the organization's first task (decided 6 November 2026): priced
  // deterministically, opened, submitted by solver B and accepted by the FIXTURE reviewer, all as
  // real transactions. Its survey content is FIXTURE; its native records are real.
  const surveyInputs = await readPricingInputs({ native, reader, projectId: X });
  const surveyTask = buildSurveyTask({
    projectId: X, selection, source: await sourceOf(X), draft: draftOf(X), reviewed: reviewedOf(X),
    approvedPlan: await native.snapshot(X), pricingSnapshot: { supply: surveyInputs.supply }, driverSha256: driverDigest('prior-art-survey'),
  });
  const surveyPrice = validatePricedTask(surveyTask.input);
  const TS = surveyPrice.nativePayload.id;
  await settle(await native.prepare(X, 'central_task_open', surveyPrice.nativePayload, { id: `open-${TS}` }), 'central_task_open_survey');
  assert.equal(surveyStatus(await native.snapshot(X, { evidence: true })).state, 'pending');
  await settle(await native.prepare(X, 'project_join', { project: P }, { id: `join-${X}-solver-b`, signer: people.solverB.address }), 'project_join_solver_b');
  const SS = `sub-survey-${X}`;
  const surveyEvidence = canonical({ schema: ARTIFACT_SCHEMA, taskId: TS, submissionId: SS, author: people.solverB.address, survey: fixtureSurvey(surveyTask.policy) });
  assert.ok(Buffer.byteLength(surveyEvidence) <= 16384, 'survey evidence fits the native inline limit');
  await settle(await native.prepare(X, 'central_submit', { id: SS, task: TS, evidence: surveyEvidence, evidence_digest: sha(surveyEvidence) },
    { id: `submit-${SS}`, signer: people.solverB.address }), 'central_submit_survey');
  const surveyTaskRecord = (await records([`central_task/${TS}`]))[`central_task/${TS}`];
  reviewIds.set(SS, ['fixture-review-survey-1']);
  const surveyReview = await direct('central_review', { submission: SS, verdict: 'accept', criteria_digest: surveyTaskRecord.acceptance_digest,
    verification_digest: FIXTURE_DIGEST, execution_id: 'fixture-review-survey-1', evidence_digest: sha(surveyEvidence) }, people.reviewer);
  const accepted = requireAcceptedSurvey(await native.snapshot(X, { evidence: true }));
  assert.deepEqual([accepted.state, accepted.submission, accepted.meetsMainKpi, accepted.evidenceDigest], ['accepted', SS, false, sha(surveyEvidence)]);
  const afterSurvey = await records([`central_project_budget/${P}`, `central_award/solver/${SS}`, `central_award/reviewer/${SS}`]);
  assert.deepEqual([afterSurvey[`central_project_budget/${P}`].paid, afterSurvey[`central_award/solver/${SS}`].amount, afterSurvey[`central_award/reviewer/${SS}`].amount],
    ['250000000', '200000000', '50000000']);
  note('prior_art_survey_accepted', { task: TS, submission: SS, height: surveyReview.height, solver: people.solverB.address, paid: '250000000' });

  // 3. Pricing against the fresh native snapshot, then two competing reservations.
  const inputs = await readPricingInputs({ native, reader, projectId: X });
  assert.deepEqual([inputs.budget.allocation, inputs.budget.reserved, inputs.budget.paid], ['10000000000', '0', '250000000']);
  const priorArt = {
    basis: 'FIXTURE prior-art record for the fictional chain; no real search ran and no novelty is claimed.',
    searches: [
      { query: 'fixture query one', source: 'fixture-registry-a', observedAt: '2026-11-06T00:00:00.000Z', resultSummary: 'FIXTURE: no result recorded.' },
      { query: 'fixture query two', source: 'fixture-registry-b', observedAt: '2026-11-06T00:00:00.000Z', resultSummary: 'FIXTURE: no result recorded.' },
    ],
    knownAnswer: false, openSolutionFound: false,
  };
  const criteriaA = 'FIXTURE criteria A: an independent rerun reproduces the retained fictional witness exactly.';
  const criteriaB = 'FIXTURE criteria B: a second fictional witness competes for the same opening allowance.';
  const task = (id, criteria) => ({
    id, projectId: X, milestoneRound: inputs.approvedPlan.currentRound, planRevision: inputs.approvedPlan.revision,
    title: `FIXTURE task ${id.slice(-1)}`, criteria, eligibility: 'unresolved', solverAmount: '5000000000', reviewerAmount: '1000000000',
    rationale: { effort: 'FIXTURE effort: one bounded rerun.', difficulty: 'FIXTURE difficulty: moderate.', novelty: 'FIXTURE novelty: fictional.', verificationCost: 'FIXTURE verification: one rerun.' },
    evidenceDigest: FIXTURE_DIGEST,
  });
  const TA = `T-${X}-A`;
  const TB = `T-${X}-B`;
  const priceA = validatePricedTask({ task: task(TA, criteriaA), approvedPlan: inputs.approvedPlan, priorArt, budget: inputs.budget, supply: inputs.supply, existingTaskIds: inputs.existingTaskIds, selection });
  const priceB = validatePricedTask({ task: task(TB, criteriaB), approvedPlan: inputs.approvedPlan, priorArt, budget: inputs.budget, supply: inputs.supply, existingTaskIds: inputs.existingTaskIds, selection });
  // Each alone fits the 9,750 AI$ left after the survey; together (12,000 AI$) they do not.
  assert.deepEqual([priceA.totalUnits, priceB.totalUnits, priceA.availableUnits], ['6000000000', '6000000000', '9750000000']);
  const openA = await native.prepare(X, 'central_task_open', priceA.nativePayload, { id: `open-${TA}` });
  const openB = await native.prepare(X, 'central_task_open', priceB.nativePayload, { id: `open-${TB}` });
  assert.deepEqual([openA.state, openB.state], ['prepared', 'prepared'], 'both competing reservations prepared from one snapshot');
  await settle(openA, 'central_task_open_A');
  const fresh = await readPricingInputs({ native, reader, projectId: X });
  assert.throws(() => validatePricedTask({ task: task(TB, criteriaB), approvedPlan: fresh.approvedPlan, priorArt, budget: fresh.budget, supply: fresh.supply, existingTaskIds: fresh.existingTaskIds, selection }),
    (e) => e.code === 'insufficient_project_allowance', 'fresh pricing refuses the loser locally');
  const lostAt = await network.height();
  const signedBeforeLoss = custody.signed.length;
  const sentB = await native.dispatch(openB.id);
  // A first-send CheckTx refusal (broadcast_tx_sync answers after CheckTx; refused bytes are not
  // in the mempool and not gossiped) fails the intent AT ONCE and frees the manager's lane.
  assert.equal(sentB.status, 'failed', `definite CheckTx refusal: ${JSON.stringify({ code: sentB.code, state: sentB.intent?.state })}`);
  assert.deepEqual([sentB.code, sentB.rejection.codespace], [1, 'undefined'], 'native federation refusal on 0.3.9');
  const lost = journal.get(openB.id);
  assert.deepEqual([lost.state, lost.failure, lost.receipt.definite, lost.receipt.code], ['failed', 'node_rejected:1', true, 1]);
  assert.equal(lost.receipt.txHash, sha(Buffer.from(JSON.stringify(lost.envelope))).toUpperCase(), 'rejection names the retained bytes');
  assert.equal(custody.signed.length, signedBeforeLoss + 1, 'signed once');
  // Settled: no reconcile, resend or re-sign can touch it.
  assert.equal((await native.reconcile(openB.id, { rebroadcast: true })).status, 'failed');
  assert.throws(() => journal.reconcile(openB.id, { found: false, expired: true }), (e) => e.code === 'intent_state_conflict');
  assert.equal(custody.signed.length, signedBeforeLoss + 1, 'never re-signed');
  const race = await records([`central_project_budget/${P}`, `central_task/${TA}`, `central_task/${TB}`, 'coin_supply']);
  assert.equal(race[`central_task/${TB}`], null, 'losing task absent');
  assert.deepEqual([race[`central_project_budget/${P}`].reserved, race[`central_project_budget/${P}`].paid], ['6000000000', '250000000']);
  assert.ok(BigInt(race[`central_project_budget/${P}`].reserved) + BigInt(race[`central_project_budget/${P}`].paid) <= 10000000000n, 'no overspend');
  assert.deepEqual([race[`central_task/${TA}`].state, race[`central_task/${TA}`].reserved], ['open', '6000000000']);
  assert.equal(race.coin_supply.reserved, '6000000000');
  note('competing_reservation_refused', {
    winner: TA, loser: TB, loserCheckTxCode: sentB.code, codespace: sentB.rejection.codespace, log: sentB.rejection.log, height: String(lostAt),
    loserIntentState: lost.state, failure: lost.failure, expiresHeight: lost.envelope.command.expires_height, settledAtHeight: String(await network.height()),
  });

  // 4. Solvers join; solver B submits THROUGH THE SCHEDULER (epoch 0), the FIXTURE reviewer rejects.
  await settle(await native.prepare(X, 'project_join', { project: P }, { id: `join-${X}-solver-a`, signer: people.solverA.address }), 'project_join_solver_a');
  const executor = {
    model: 'fixture-solver', fixture: true, actual: false, capabilities: [], runs: [],
    async run(job) {
      executor.runs.push(job.taskId);
      return { outcome: 'completed', usage: { costUsd: 0, stopReason: 'fixture' },
        evidenceArtifact: { schema: ARTIFACT_SCHEMA, taskId: job.taskId, solver: current.solver, note: 'FIXTURE solver output; not a research result' } };
    },
  };
  const jobOf = (solver) => ({ projectId: X, taskId: TA, kind: 'solver', solver, criteriaDigest: sha(criteriaA) });
  let current = jobOf(people.solverB.address);
  const taskRecord = async (taskId) => (await records([`central_task/${taskId}`]))[`central_task/${taskId}`];
  const scheduler = createScheduler({
    selection, registry, journal, executor, native,
    budget: openComputeBudget({ directory: join(root, 'compute'), limits: { perCallUsd: 1, dailyUsd: 2, totalUsd: 5 } }),
    jobs: {
      next: (id) => (id === X ? current : null),
      criteriaDigest: async (_id, taskId) => (await taskRecord(taskId))?.acceptance_digest,
      // The native funding epoch (task `paid` while open and fully reserved), never the provider's word.
      fundingEpoch: async (_id, taskId) => fundingEpochOf(await taskRecord(taskId)),
    },
    sources: { digest: async (id) => sourceDigestOf(catalogue.records.get(id), catalogue.revision) },
    workspaceRoot: join(root, 'workspaces'), stateDirectory: join(root, 'scheduler'),
  });
  /** One scheduler submission: cycle -> prepared central_submit -> dispatch -> cycles until confirmed. */
  async function scheduledSubmission(label) {
    const first = await runCycle({ journal, native, scheduler });
    assert.equal(first.tick?.state, 'submission_prepared', `${label}: ${JSON.stringify(first)}`);
    const intent = journal.get(first.tick.intentId);
    assert.equal(intent.signer, current.solver, `${label}: signed by the scheduled solver`);
    const sent = await native.dispatch(intent.id);
    assert.deepEqual([sent.status, sent.code], ['dispatched', 0], label);
    let cycle;
    for (let i = 0; i < 60; i++) {
      cycle = await runCycle({ journal, native, scheduler });
      if (journal.get(intent.id).state === 'confirmed') break;
      await pause(1500);
    }
    const done = journal.get(intent.id);
    assert.equal(done.state, 'confirmed', label);
    assert.equal(done.receipt.finalized, true, `${label}: finalized`);
    assert.equal(scheduler.status(X).state, 'submitted');
    note(label, { intentId: intent.id, submission: intent.payload.id, solver: intent.signer, fundingEpoch: scheduler.status(X).fundingEpoch, height: done.receipt.height, cycleState: cycle.state });
    return done;
  }
  const submitB = await scheduledSubmission('central_submit_solver_b_scheduler');
  assert.equal(scheduler.status(X).fundingEpoch, '0', 'opening funding epoch');
  const SB = submitB.payload.id;
  const evidenceB = submitB.payload.evidence;
  // Under review: no solver work, for B or anyone.
  assert.equal((await runCycle({ journal, native, scheduler })).state, 'idle', 'task under review offers no attempt');
  const taskA = await taskRecord(TA);
  const reviewCmd = (submission, verdict, executionId, evidenceDigest) => ({
    submission, verdict, criteria_digest: taskA.acceptance_digest, verification_digest: FIXTURE_DIGEST, execution_id: executionId, evidence_digest: evidenceDigest,
  });
  reviewIds.set(SB, ['fixture-review-reject-1']);
  note('central_review_reject', { submission: SB, height: (await direct('central_review', reviewCmd(SB, 'reject', 'fixture-review-reject-1', sha(evidenceB)), people.reviewer)).height, reviewer: 'FIXTURE central-reviewer (direct, as the isolated smoke fixture)' });
  const afterReject = await records([`central_project_budget/${P}`, `central_task/${TA}`, `central_award/reviewer/${SB}`, `central_award/solver/${SB}`, 'coin_supply']);
  assert.deepEqual([afterReject[`central_task/${TA}`].state, afterReject[`central_task/${TA}`].reserved], ['open_unfunded', '0']);
  assert.equal(afterReject[`central_award/reviewer/${SB}`].amount, '1000000000');
  assert.equal(afterReject[`central_award/solver/${SB}`], null, 'reject pays no solver award');
  assert.deepEqual([afterReject[`central_project_budget/${P}`].reserved, afterReject[`central_project_budget/${P}`].paid], ['0', '1250000000']);

  // Rejected and not yet re-funded: still no attempt.
  assert.equal((await runCycle({ journal, native, scheduler })).state, 'idle', 'open_unfunded task offers no attempt');

  // 5./6. The refused reservation freed the manager lane at once (no wait for its expiry): the
  // next manager intent, central_task_fund, is NEW, prepared from fresh state, and signs the very
  // sequence the refused envelope carried, before that envelope's expiry height.
  // Crash between envelope retention and broadcast, then reconcile without re-sign.
  const fundIntent = await native.prepare(X, 'central_task_fund', { task: TA, evidence_digest: FIXTURE_DIGEST }, { id: `fund-${TA}-1` });
  const laneFreedAt = await network.height();
  assert.ok(laneFreedAt < BigInt(lost.envelope.command.expires_height), 'lane free before the refused envelope could expire');
  const childLog = join(root, 'child-sign.log');
  const childConfig = join(root, 'child.json');
  await writeFile(childConfig, JSON.stringify({
    registryDir: join(root, 'registry'), journalDir: join(root, 'journal'), signLog: childLog, intentId: fundIntent.id, chainId, policy,
    guardian: people.guardian.address, readerConfig: config,
    signer: { address: people.manager.address, raw: people.manager.raw.toString('base64url'), pem: people.manager.privateKey.export({ format: 'pem', type: 'pkcs8' }) },
  }), { mode: 0o600 });
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--crash-child', childConfig], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, UAIN_ORGS_NATIVE_E2E: '0' } });
    let out = '';
    for (const s of [child.stdout, child.stderr]) s.on('data', (b) => { out = (out + b).slice(-8000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.once('error', reject);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out }); });
  });
  await rm(childConfig, { force: true });
  assert.equal(exit.signal, 'SIGKILL', `child died at the crash point: ${exit.out}`);
  const childSigns = (await readFile(childLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(childSigns.map((r) => r.crash ?? r.operation), ['central_task_fund', 'before_broadcast'], 'child signed once, then died before broadcast');
  const crashed = journal.get(fundIntent.id);
  assert.equal(crashed.state, 'dispatched', 'envelope retained before broadcast');
  assert.ok(crashed.envelope);
  assert.equal((await records([`central_task/${TA}`]))[`central_task/${TA}`].state, 'open_unfunded', 'nothing was broadcast');
  const parentSigns = custody.signed.length;
  const unknown = await native.reconcile(fundIntent.id);
  assert.equal(unknown.status, 'unknown', 'retained but unproven envelope is unknown, not failed or re-signed');
  const resent = await native.reconcile(fundIntent.id, { rebroadcast: true });
  assert.deepEqual([resent.status, resent.rebroadcast], ['unknown', true]);
  const funded = await confirmed(fundIntent.id, 'central_task_fund_after_crash');
  assert.equal(custody.signed.length, parentSigns, 'reconciliation never re-signed');
  assert.equal(funded.receipt.command_digest, sha(signingBytes(crashed.envelope.command)), 'the included command is the retained one');
  assert.equal(funded.envelope.signature, crashed.envelope.signature, 'byte-identical retained signature');
  assert.equal(crashed.envelope.command.sequence, lost.envelope.command.sequence, 'the refused command consumed no sequence; a new intent signed it');
  assert.notEqual(crashed.envelope.signature, lost.envelope.signature, 'never the refused envelope');
  note('crash_reconciled', { intentId: fundIntent.id, operation: 'central_task_fund', eventId: funded.receipt.event_id, height: funded.receipt.height, childSignatures: 1, parentSignatures: 0,
    laneFreedAtHeight: String(laneFreedAt), refusedExpiresHeight: lost.envelope.command.expires_height, sequence: crashed.envelope.command.sequence });

  // 7. Re-funded (new epoch = the reviewer award already paid): solver A through the scheduler,
  // then FIXTURE accept (two awards).
  assert.equal(fundingEpochOf(await taskRecord(TA)), '1000000000', 're-funded epoch');
  current = jobOf(people.solverA.address);
  const submitIntent = await scheduledSubmission('central_submit_solver_a_scheduler');
  assert.equal(scheduler.status(X).fundingEpoch, '1000000000');
  const SA = submitIntent.payload.id;
  assert.notEqual(SA, SB, 'distinct attempt keys give distinct submissions');
  assert.deepEqual(executor.runs, [TA, TA], 'one run per (solver, funded epoch)');
  assert.equal(scheduler.attempts(X).length, 2);
  reviewIds.set(SA, ['fixture-review-accept-1']);
  note('central_review_accept', { submission: SA, height: (await direct('central_review', reviewCmd(SA, 'accept', 'fixture-review-accept-1', submitIntent.payload.evidence_digest), people.reviewer)).height });

  // 8. Read-back through native-reader with real pinned proofs (evidence snapshot).
  const view = await native.snapshot(X, { evidence: true });
  assert.equal(view.available, true);
  assert.deepEqual(view.unread, [], 'every evidence class was read');
  assert.equal(view.proof.authority, 'native');
  assert.equal(view.proof.finalized, true, 'committed app_hash with signed header');
  assert.match(view.proof.appHash, /^[A-F0-9a-f]{64}$/);
  assert.equal(view.proof.genesisSha256, config.genesisHash);
  assert.equal(view.proof.production, false);
  const r = view.records;
  assert.deepEqual([r[`central_task/${TA}`].state, r[`central_task/${TA}`].winner, r[`central_task/${TA}`].paid], ['accepted', SA, '7000000000']);
  assert.deepEqual([r[`central_submission/${SB}`].state, r[`central_submission/${SA}`].state], ['rejected', 'accepted']);
  assert.equal(r[`central_award/reviewer/${SB}`].amount, '1000000000');
  assert.equal(r[`central_award/solver/${SB}`], undefined, 'reject: reviewer only');
  assert.deepEqual([r[`central_award/solver/${SA}`].member, r[`central_award/solver/${SA}`].amount], [people.solverA.address, '5000000000']);
  assert.deepEqual([r[`central_award/reviewer/${SA}`].member, r[`central_award/reviewer/${SA}`].amount], [people.reviewer.address, '1000000000']);
  assert.equal(r[`central_earnings/${people.reviewer.address}`].total, '2050000000', 'two task reviews plus the survey review');
  assert.equal(r[`central_earnings/${people.solverA.address}`].total, '5000000000');
  assert.equal(Object.keys(r).filter((k) => k.startsWith('central_review/')).length, 3, 'the survey review and both task reviews located and complete against the event log');
  assert.deepEqual([view.budget.reserved, view.budget.paid, view.budget.allocation], ['0', '7250000000', '10000000000']);
  assert.deepEqual(view.tasks.map((x) => x.id).sort(byText), [TA, TS].sort(byText), 'the survey and the winner; the losing reservation never became a task');
  const supply = await reader.supplySnapshot();
  assert.deepEqual([supply.supply.issued, supply.supply.reserved, supply.proof.finalized], ['7250000000', '0', true]);
  // Second node converges on the same proven records.
  const peer = createNativeAssetAdapter({ config: network.peerConfig });
  const keys = [`central_project_budget/${P}`, `central_task/${TA}`, `central_award/solver/${SA}`, `central_award/reviewer/${SA}`, `central_award/reviewer/${SB}`, 'coin_supply'];
  const primaryRecords = await records(keys);
  await waitFor(async () => { const peerState = await peer.publicState({ keys }); assert.deepEqual(peerState.state.records, primaryRecords); return true; }, 'two-node convergence');
  note('readback', { height: view.height, appHash: view.proof.appHash, finalized: view.proof.finalized, supplyHeight: supply.height });

  // Every adapter intent is settled; only the losing reservation failed, by its definite CheckTx refusal.
  const intents = journal.list();
  const states = Object.fromEntries(intents.map((i) => [i.id, i.state]));
  for (const i of intents) assert.equal(i.state, i.id === openB.id ? 'failed' : 'confirmed', `${i.id} ${i.state}`);
  for (const i of intents.filter((x) => x.state === 'confirmed')) assert.equal(i.receipt.finalized, true, `${i.id} finalized`);

  const summary = {
    fixtureOnly: true, label: 'FIXTURE: fictional genesis, fictional identities, fixture custody/provider/executor/reviewer; not production evidence',
    startedAt, finishedAt: new Date().toISOString(), chainId, genesisSha256: config.genesisHash, daemonSha256: TOOL_PINS.daemon, readerSha256: TOOL_PINS.reader,
    realDaemonProcesses: 2, broadcastTransport, projectId: X, nativeProjectId: P, selectionDigest: selection.digest,
    custody: { fixture: true, signatures: custody.signed.map(({ operation, role, caller }) => ({ operation, role, caller })), crashChildSignatures: 1 },
    fundProvider: { fixture: true, actual: false, executions: fundCalls.map((c) => c.role) },
    executor: { fixture: true, actual: false }, reviewer: { fixture: true, direct: true, verdicts: ['reject', 'accept'] },
    intents: intents.map((i) => ({ id: i.id, operation: i.operation, state: i.state, failure: i.failure, eventId: i.receipt?.event_id ?? null, height: i.receipt?.height ?? null, finalized: i.receipt?.finalized ?? null })),
    states, steps, finalSupply: supply.supply, finalBudget: view.budget, productionWrites: false,
  };
  t.diagnostic(`FIXTURE_SUMMARY ${JSON.stringify(summary)}`);
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    await writeFile(join(evidenceDir, 'journal.json'), JSON.stringify(intents.map((i) => ({ ...i, payload: i.payload })), null, 2) + '\n');
    await copyFile(network.genesis, join(evidenceDir, 'fictional-genesis.json'));
  }
});

/** Fleet custody (ops/custody/project_organizations.py process()/sign()) against the same kind of
 * disposable daemon. Python signs, journals, broadcasts and settles every command itself; Node
 * only builds the requests (exactly as the service would hand them to custody) and reads native
 * state back through the pinned verifier to check the outcome. FIXTURE keys and paths only. */
test('FIXTURE: Python fleet custody signs and settles against a real pinned daemon on a fictional genesis', { skip: !enabled || (ONLY !== null && ONLY !== 'python'), timeout: 1200000 }, async (t) => {
  const evidenceDir = process.env.UAIN_ORGS_E2E_EVIDENCE ?? null;
  const root = await mkdtemp(join(tmpdir(), 'uain-orgs-fictional-python-'));
  const startedAt = new Date().toISOString();
  const steps = [];
  const note = (step, extra = {}) => { const row = { step, at: new Date().toISOString(), ...extra }; steps.push(row); t.diagnostic(`FIXTURE_PY_STEP ${JSON.stringify(row)}`); };
  const people = {
    guardian: fictionalIdentity('guardian'), reviewer: fictionalIdentity('central-reviewer', 100), relay: fictionalIdentity('relay'),
    manager: fictionalIdentity('project-manager'), evaluator: fictionalIdentity('fund-evaluator'),
    solverA: fictionalIdentity('solver-a'), solverB: fictionalIdentity('solver-b'),
  };
  people.guardian.member.creator = true;
  people.guardian.member.default_verifier = true;
  const network = await disposableNetwork(t, people, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { chainId, config, rpc, waitFor } = network;
  note('network_ready', { chainId, genesisSha256: config.genesisHash, height: String(await network.height()) });
  const assets = createNativeAssetAdapter({ config });
  async function direct(operation, payload, actor = people.guardian) {
    const current = await assets.publicState({ member: actor.address });
    const command = { version: 1, chain_id: chainId, member: actor.address, sequence: current.state.member.sequence,
      expires_height: String(BigInt(current.state.height) + 300n), operation, payload };
    const result = await rpc(0, 'broadcast_tx_commit', { tx: Buffer.from(JSON.stringify(signedEnvelope(command, actor.raw, actor.privateKey))).toString('base64') });
    assert.equal(result.check_tx.code, 0, `${operation}: ${result.check_tx.log}`);
    assert.equal(result.tx_result.code, 0, `${operation}: ${result.tx_result.log}`);
    await waitFor(async () => BigInt((await rpc(0, 'status')).sync_info.latest_block_height) > BigInt(result.height) + 1n, `${operation} finality`);
    return { height: result.height };
  }
  for (const [operation, policy, extra] of [
    ['activate_storage', 'compact-state-v1', {}], ['activate_membership', 'project-membership-v1', {}],
    ['activate_operator_rewards', 'pairwise-operator-rewards-v1', {}],
    ['activate_private_exchange', 'orchard-v2-reviewed-otc-v1', { relayer: people.relay.address }],
    ['activate_coin', 'verified-bounties-108t-micro-v1', {}],
  ]) await direct(operation, { policy, evidence_digest: FIXTURE_DIGEST, ...extra });
  await direct('central_earning_activate', { policy: CENTRAL_POLICY, reviewer: people.reviewer.address, evidence_digest: FIXTURE_DIGEST });
  note('activated', { height: String(await network.height()) });

  const selection = await loadSelection();
  const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
  const X = selection.ids.find((id) => selection.get(id).holds.length === 0 && Buffer.byteLength(catalogue.records.get(id)?.title ?? '') >= 5);
  const P = selection.get(X).nativeProjectId;
  const unbound = selection.ids.find((id) => id !== X);
  const policy = fleetPolicy({ selection, X, manager: people.manager.address, evaluator: people.evaluator.address, solvers: [people.solverA.address, people.solverB.address] });

  // FIXTURE custody tree under one fresh boundary directory (root-owned in the container, 0700):
  // policy, selection and amendments as the root-owned files custody reads; the journal root; proofs.
  const python = process.env.UAIN_ORGS_E2E_PYTHON ?? '/usr/bin/python3';
  const harness = fileURLToPath(new URL('./python-custody-stage.py', import.meta.url));
  const boundary = await mkdtemp(join(tmpdir(), 'uain-orgs-py-custody-'));
  t.after(() => rm(boundary, { recursive: true, force: true }));
  for (const d of ['etc', 'journal', 'tmp', 'calls']) await mkdir(join(boundary, d), { mode: 0o700 });
  const docs = new URL('../../../docs/baink/project-organizations-2026-11-06/', import.meta.url);
  // Fresh root-owned 0600 copies (copyFile would carry the checkout's mode bits).
  for (const name of ['selection.json', 'kpi-amendments.json']) await writeFile(join(boundary, 'etc', name), await readFile(new URL(name, docs)), { mode: 0o600 });
  await writeFile(join(boundary, 'etc/policy.json'), JSON.stringify(policy) + '\n', { mode: 0o600 });
  const seed = (x) => Buffer.from(x.privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64url');
  const attachment = (x) => ({ private_key: seed(x), public_key: x.raw.toString('base64url') });
  const harnessConfig = join(boundary, 'etc/harness.json');
  await writeFile(harnessConfig, JSON.stringify({
    custodyDir: fileURLToPath(new URL('../../../ops/custody', import.meta.url)), chainId, guardian: people.guardian.address, boundary,
    policyPath: join(boundary, 'etc/policy.json'), selectionPath: join(boundary, 'etc/selection.json'), amendmentsPath: join(boundary, 'etc/kpi-amendments.json'),
    root: join(boundary, 'journal'), tmp: join(boundary, 'tmp'),
    reader: { binary: config.binary, binarySha256: TOOL_PINS.reader, genesis: config.genesis, genesisSha256: config.genesisHash, rpc: config.rpc },
    attachments: {
      // Production attachment names (project_organizations.key_attachment); FIXTURE seeds.
      'keys/uain-review-key.json': attachment(people.guardian),
      ...Object.fromEntries([people.manager, people.evaluator, people.solverA, people.solverB].map((x) => [`keys/project-organizations/${x.address}.json`, attachment(x)])),
    },
  }), { mode: 0o600 });

  let calls = 0;
  async function custody(projectId, request, caller = 'agent') {
    const callPath = join(boundary, 'calls', `${String(++calls).padStart(4, '0')}.json`);
    await writeFile(callPath, JSON.stringify({ projectId, request, caller }), { mode: 0o600 });
    const out = await new Promise((resolve, reject) => {
      const child = spawn(python, ['-I', '-B', harness, harnessConfig, callPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      const parts = [];
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
      child.stdout.on('data', (b) => parts.push(b));
      child.stderr.on('data', (b) => { err = (err + b).slice(-4000); });
      child.once('error', reject);
      child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(parts).toString()) : reject(new Error(`python custody exited ${code}: ${err}`)); });
    });
    return JSON.parse(out.trim().split('\n').pop());
  }
  const view = async (member = null, keys = []) => (await assets.publicState({ ...(member ? { member } : {}), keys })).state;
  const sequences = async () => {
    const out = {};
    for (const [k, x] of Object.entries(people)) out[k] = (await view(x.address)).member.sequence; // the pinned reader is serial
    return out;
  };
  const signatures = [];

  /** First call signs once and broadcasts once; later calls only scan; never re-signs. */
  async function settle(label, projectId, request, caller = 'agent') {
    let r = await custody(projectId, request, caller);
    assert.ok(!['refused', 'error'].includes(r.status), `${label}: ${JSON.stringify(r)}`);
    assert.deepEqual([r.counters.signed, r.counters.broadcasts, r.counters.broadcastCodes], [1, 1, [0]], `${label}: one signature, one accepted broadcast`);
    const envelope = r.envelope;
    // Cross-implementation parity: Node's fleet verifier accepts the Python envelope as is.
    assert.equal(verifyFleetEnvelope(envelope, { chainId }), true, `${label}: Node verifies the Python envelope`);
    for (let i = 0; i < 80 && r.status !== 'finalized'; i++) {
      assert.equal(r.status, 'pending', `${label}: ${JSON.stringify(r).slice(0, 400)}`);
      await pause(1500);
      r = await custody(projectId, request, caller);
      assert.deepEqual([r.counters.signed, r.counters.broadcasts], [0, 0], `${label}: a later invocation only reconciles`);
      assert.deepEqual(r.envelope, envelope, `${label}: retained envelope unchanged`);
    }
    assert.equal(r.status, 'finalized', `${label}: finalized`);
    const receipt = r.receipt;
    assert.deepEqual([receipt.authority, receipt.finalized, receipt.chain_id], ['native', true, chainId]);
    assert.equal(receipt.event.command_digest, sha(signingBytes(envelope.command)), `${label}: receipt binds the signed command`);
    assert.deepEqual([receipt.event.member, receipt.event.operation], [request.member, request.operation]);
    signatures.push({ label, operation: request.operation, caller, sequence: envelope.command.sequence });
    note(label, { operation: request.operation, caller, eventId: receipt.event.id, stateHeight: receipt.state_height, commandDigest: receipt.event.command_digest });
    return r;
  }
  /** A Python authorize()/process() refusal: nothing signed, broadcast, journaled or changed on native. */
  async function refused(label, projectId, request, code, caller = 'agent') {
    const [eventsBefore, seqBefore] = [(await view()).event_count, await sequences()];
    const r = await custody(projectId, request, caller);
    assert.deepEqual([r.status, r.code], ['refused', code], `${label}: ${JSON.stringify(r).slice(0, 300)}`);
    assert.deepEqual([r.counters.signed, r.counters.broadcasts, r.journaled], [0, 0, false], `${label}: never reached signing or the daemon`);
    await pause(2500); // two more blocks: anything sent would be committed by now
    assert.equal((await view()).event_count, eventsBefore, `${label}: no native event`);
    assert.deepEqual(await sequences(), seqBefore, `${label}: no sequence consumed`);
    note(label, { refused: code, eventCount: eventsBefore });
  }

  const title = catalogue.records.get(X).title;
  const priorArt = {
    basis: 'FIXTURE prior-art record for an isolated fictional-chain qualification only. No real search was run and no novelty is claimed.',
    searches: ['FIXTURE search one (fictional, not executed)', 'FIXTURE search two (fictional, not executed)'],
  };
  const req = (id, member, operation, payload) => ({ id, member, operation, payload });
  const G = people.guardian.address;
  const M = people.manager.address;
  const E = people.evaluator.address;

  // Guardian bootstrap through the fixed bootstrap caller; the agent caller cannot reach it.
  await refused('refused_guardian_from_agent', X, req(`start-${X}-agent`, G, 'central_project_start', { project: P, manager: M, evidence_digest: FIXTURE_DIGEST }), 'guardian_unreachable');
  await settle('open_project', X, req(`open-${X}`, G, 'open_project', { id: P, title, class: 'benevolent', prior_art: priorArt }), 'bootstrap');
  await settle('central_project_start', X, req(`start-${X}`, G, 'central_project_start', { project: P, manager: M, evidence_digest: FIXTURE_DIGEST }), 'bootstrap');
  await settle('central_fund_configure', X, req(`configure-${X}`, G, 'central_fund_configure', { project: P, evaluator: E, expected_evaluator: '', evidence_digest: FIXTURE_DIGEST }), 'bootstrap');
  await settle('project_join_manager', X, req(`join-${X}-manager`, M, 'project_join', { project: P }));
  const stages = Array.from({ length: 5 }, (_, i) => ({ round: i + 1, criteria: `FIXTURE stage ${i + 1}: independently verify immutable evidence against the unchanged Main KPI.` }));
  await settle('central_fund_plan', X, req(`plan-${X}-1`, E, 'central_fund_plan', { project: P, revision: 1, main_kpi: selection.get(X).mainKpi, stages, reason: 'FIXTURE: five ordered sub-KPIs.', evidence_digest: FIXTURE_DIGEST }));
  await settle('central_fund_plan_review', X, req(`review-${X}-1`, E, 'central_fund_plan_review', { project: P, revision: 1, verdict: 'accept', evidence_digest: FIXTURE_DIGEST }));
  const boot = (await view(null, [`project/${P}`, `project_metadata/${P}`, `central_project_budget/${P}`, `central_fund_config/${P}`, `central_fund_state/${P}`])).records;
  assert.deepEqual([boot[`project/${P}`].lead, boot[`project_metadata/${P}`].title, boot[`central_project_budget/${P}`].manager, boot[`central_fund_config/${P}`].evaluator, boot[`central_fund_state/${P}`].approved_revision],
    [G, title, M, E, 1], 'bootstrap and approved plan through Python custody');

  // Authorization refusals that must never reach the daemon.
  const criteria = 'FIXTURE criteria P: an independent rerun reproduces the retained fictional witness exactly.';
  const TP = `T-${X}-PY`;
  const taskOpen = (solverAmount, reviewerAmount, id = TP) => ({
    id, project: P, title: 'FIXTURE Python custody task', criteria, acceptance_digest: sha(criteria), eligibility: 'unresolved',
    eligibility_digest: FIXTURE_DIGEST, solver_amount: solverAmount, reviewer_amount: reviewerAmount, evidence_digest: FIXTURE_DIGEST,
  });
  await refused('refused_wrong_signer', X, req(`open-${TP}-wrong`, people.solverA.address, 'central_task_open', taskOpen('5000000000', '1000000000')), 'signer_mismatch');
  await refused('refused_unselected_project', 'OPP-99999', req(`open-${TP}-unselected`, M, 'central_task_open', taskOpen('5000000000', '1000000000')), 'project_not_selected');
  await refused('refused_project_not_in_policy', unbound, req(`open-${TP}-unbound`, M, 'central_task_open', { ...taskOpen('5000000000', '1000000000'), project: selection.get(unbound).nativeProjectId }), 'project_not_selected');
  // max_task_units is 6,000 AI$: 5,500 + 1,000 is above the reviewed bound (native would allow it).
  await refused('refused_amount_over_bound', X, req(`open-${TP}-over`, M, 'central_task_open', taskOpen('5500000000', '1000000000')), 'amount_above_bound');

  await settle('central_task_open', X, req(`open-${TP}`, M, 'central_task_open', taskOpen('5000000000', '1000000000')));

  // A command Python authorizes (5,000 AI$ is within the 6,000 AI$ policy bound) but native
  // CheckTx refuses (6,000 reserved + 5,000 exceeds the 10,000 AI$ opening allowance). It is
  // signed once and sent once, fails AT ONCE with the node's answer as evidence, frees the
  // manager lane well before its expiry, and is never resent or re-signed.
  const TQ = `T-${X}-PY-OVER`;
  const overRequest = req(`open-${TQ}`, M, 'central_task_open', taskOpen('4000000000', '1000000000', TQ));
  const [overEventsBefore, overSeqBefore] = [(await view()).event_count, await sequences()];
  const over = await custody(X, overRequest);
  assert.equal(over.status, 'failed', `definite CheckTx refusal: ${JSON.stringify(over).slice(0, 600)}`);
  assert.deepEqual([over.counters.signed, over.counters.broadcasts, over.counters.broadcastCodes], [1, 1, [1]], 'signed once, sent once, refused');
  assert.deepEqual([over.reason, over.rejection.definite, over.rejection.code, over.rejection.codespace], ['node_rejected:1', true, 1, 'undefined'],
    'native federation refusal on 0.3.9');
  assert.equal(over.rejection.tx_hash, sha(canonical(over.envelope)).toUpperCase(), 'the rejection names the journaled envelope bytes');
  assert.equal(over.rejection.command_digest, sha(signingBytes(over.envelope.command)));
  assert.deepEqual([over.rejection.member, over.rejection.sequence, over.rejection.operation], [M, overSeqBefore.manager, 'central_task_open']);
  assert.ok(typeof over.rejection.log === 'string' && over.rejection.log.length > 0 && over.rejection.log.length <= 400, 'bounded node log recorded');
  assert.deepEqual(over.failed, { reason: over.reason, rejection: over.rejection }, 'journal records the failure evidence');
  assert.equal(verifyFleetEnvelope(over.envelope, { chainId }), true, 'a valid signed envelope, refused by native state only');
  await pause(2500); // two more blocks: refused bytes were never admitted
  const afterOver = await view(null, [`central_task/${TQ}`, `central_project_budget/${P}`]);
  assert.equal(afterOver.records[`central_task/${TQ}`], null, 'refused task absent');
  assert.equal(afterOver.records[`central_project_budget/${P}`].reserved, '6000000000', 'no overspend');
  assert.equal(afterOver.event_count, overEventsBefore, 'no native event');
  assert.deepEqual(await sequences(), overSeqBefore, 'the refused command consumed no sequence');
  // Settled: a later invocation only reports the failure; nothing is read, resent or re-signed.
  const overAgain = await custody(X, overRequest);
  assert.deepEqual([overAgain.status, overAgain.counters.signed, overAgain.counters.broadcasts], ['failed', 0, 0], 'never resent or re-signed');
  assert.deepEqual([overAgain.envelope, overAgain.rejection], [over.envelope, over.rejection], 'retained envelope and evidence unchanged');
  // The lane is free at once: the next manager command is a NEW intent from fresh native state,
  // and signs the very sequence the refused envelope carried, before that envelope could expire.
  const laneFreedAt = await network.height();
  assert.ok(laneFreedAt < BigInt(over.envelope.command.expires_height), 'lane free before the refused envelope could expire');
  const TR = `T-${X}-PY-NEXT`;
  const next = await settle('central_task_open_after_refusal', X, req(`open-${TR}`, M, 'central_task_open', taskOpen('2000000000', '1000000000', TR)));
  assert.equal(next.envelope.command.sequence, over.envelope.command.sequence, 'a new intent signed the refused sequence');
  assert.notEqual(next.envelope.signature, over.envelope.signature, 'never the refused envelope');
  note('definite_refusal_freed_lane', {
    intent: overRequest.id, code: over.rejection.code, codespace: over.rejection.codespace, log: over.rejection.log, txHash: over.rejection.tx_hash,
    sequence: over.envelope.command.sequence, refusedExpiresHeight: over.envelope.command.expires_height, laneFreedAtHeight: String(laneFreedAt), nextIntent: `open-${TR}`,
  });

  await settle('project_join_solver_a', X, req(`join-${X}-solver-a`, people.solverA.address, 'project_join', { project: P }));
  const evidence = JSON.stringify({ schema: ARTIFACT_SCHEMA, taskId: TP, note: 'FIXTURE Python-custody solver output; not a research result' });
  const SP = `S-${X}-PY1`;
  await settle('central_submit', X, req(`submit-${SP}`, people.solverA.address, 'central_submit', { id: SP, task: TP, evidence, evidence_digest: sha(evidence) }));
  const final = await view(null, [`central_task/${TP}`, `central_task/${TR}`, `central_task/${TQ}`, `central_submission/${SP}`, `central_project_budget/${P}`, 'coin_supply']);
  const r = final.records;
  assert.deepEqual([r[`central_task/${TP}`].state, r[`central_task/${TP}`].pending, r[`central_task/${TP}`].reserved], ['under_review', SP, '6000000000']);
  assert.deepEqual([r[`central_task/${TR}`].state, r[`central_task/${TR}`].reserved, r[`central_task/${TQ}`]], ['open', '3000000000', null]);
  assert.deepEqual([r[`central_submission/${SP}`].author, r[`central_submission/${SP}`].evidence_digest], [people.solverA.address, sha(evidence)]);
  assert.deepEqual([r[`central_project_budget/${P}`].reserved, r.coin_supply.reserved], ['9000000000', '9000000000']);
  // Python's own journal: every send settled, one envelope per request, no unsettled lane:
  // all finalized except the one definitely refused intent, which holds its evidence and no receipt.
  const journals = [];
  for (const dir of [join(boundary, 'journal', X)]) for (const name of (await import('node:fs')).readdirSync(dir)) journals.push(JSON.parse(await readFile(join(dir, name), 'utf8')));
  assert.equal(journals.length, signatures.length + 1, 'one journal per signed request');
  const refusedJournals = journals.filter((j) => j.failed);
  assert.equal(refusedJournals.length, 1, 'exactly one refused intent');
  assert.deepEqual([refusedJournals[0].receipt ?? null, refusedJournals[0].noninclusion ?? null, refusedJournals[0].attempted, refusedJournals[0].broadcast_code, refusedJournals[0].failed],
    [null, null, true, 1, over.failed], 'refused journal: evidence, no receipt, no expiry wait');
  assert.ok(journals.filter((j) => !j.failed).every((j) => j.receipt && j.receipt.finalized === true && j.attempted === true), 'every other Python journal finalized');
  note('readback', { height: final.height, appHash: final.app_hash, task: r[`central_task/${TP}`].state, submission: SP });

  const summary = {
    fixtureOnly: true, label: 'FIXTURE: fictional genesis, fictional identities and keys, Python fleet custody process()/sign() with test-only boundary; not production evidence',
    startedAt, finishedAt: new Date().toISOString(), chainId, genesisSha256: config.genesisHash, daemonSha256: TOOL_PINS.daemon, readerSha256: TOOL_PINS.reader,
    realDaemonProcesses: 2, projectId: X, nativeProjectId: P, selectionDigest: selection.digest, custody: 'ops/custody/project_organizations.py process()+sign()',
    fixtureOverrides: ['CHAIN and GUARDIAN set to the fictional chain', 'fixture key attachments in memory', 'protected files under a temporary boundary', 'reader skips the root-owned parent walk only'],
    signatures, steps, pythonCalls: calls, productionWrites: false,
  };
  t.diagnostic(`FIXTURE_PY_SUMMARY ${JSON.stringify(summary)}`);
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, 'python-custody-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    await writeFile(join(evidenceDir, 'python-custody-journal.json'), JSON.stringify(journals.map((j) => ({ ...j, public_key: j.public_key })), null, 2) + '\n');
    await copyFile(network.genesis, join(evidenceDir, 'python-fictional-genesis.json'));
  }
});

test('FIXTURE: a later funding round is applied for, decided and unlocked from public evidence on a real pinned daemon; an application with missing evidence is refused', { skip: !enabled || (ONLY !== null && ONLY !== 'fund'), timeout: 1200000 }, async (t) => {
  const evidenceDir = process.env.UAIN_ORGS_E2E_EVIDENCE ?? null;
  const root = await mkdtemp(join(tmpdir(), 'uain-orgs-fictional-fund-'));
  const startedAt = new Date().toISOString();
  const steps = [];
  const note = (step, extra = {}) => { const row = { step, at: new Date().toISOString(), ...extra }; steps.push(row); t.diagnostic(`FIXTURE_FUND_STEP ${JSON.stringify(row)}`); };
  const people = {
    guardian: fictionalIdentity('guardian'), reviewer: fictionalIdentity('central-reviewer', 100), relay: fictionalIdentity('relay'),
    manager: fictionalIdentity('project-manager'), evaluator: fictionalIdentity('fund-manager'), solver: fictionalIdentity('solver'),
  };
  people.guardian.member.creator = true;
  people.guardian.member.default_verifier = true;
  const network = await disposableNetwork(t, people, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { chainId, config, rpc, waitFor } = network;
  note('network_ready', { chainId, genesisSha256: config.genesisHash, height: String(await network.height()) });
  const assets = createNativeAssetAdapter({ config });
  async function direct(operation, payload, actor = people.guardian) {
    const current = await assets.publicState({ member: actor.address });
    const command = { version: 1, chain_id: chainId, member: actor.address, sequence: current.state.member.sequence,
      expires_height: String(BigInt(current.state.height) + 300n), operation, payload };
    const result = await rpc(0, 'broadcast_tx_commit', { tx: Buffer.from(JSON.stringify(signedEnvelope(command, actor.raw, actor.privateKey))).toString('base64') });
    assert.equal(result.check_tx.code, 0, `${operation}: ${result.check_tx.log}`);
    assert.equal(result.tx_result.code, 0, `${operation}: ${result.tx_result.log}`);
    await waitFor(async () => BigInt((await rpc(0, 'status')).sync_info.latest_block_height) > BigInt(result.height) + 1n, `${operation} finality`);
    return { height: result.height };
  }
  for (const [operation, policy, extra] of [
    ['activate_storage', 'compact-state-v1', {}], ['activate_membership', 'project-membership-v1', {}],
    ['activate_operator_rewards', 'pairwise-operator-rewards-v1', {}],
    ['activate_private_exchange', 'orchard-v2-reviewed-otc-v1', { relayer: people.relay.address }],
    ['activate_coin', 'verified-bounties-108t-micro-v1', {}],
  ]) await direct(operation, { policy, evidence_digest: FIXTURE_DIGEST, ...extra });
  await direct('central_earning_activate', { policy: CENTRAL_POLICY, reviewer: people.reviewer.address, evidence_digest: FIXTURE_DIGEST });
  note('activated', { height: String(await network.height()) });

  const selection = await loadSelection();
  const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
  const X = selection.ids.find((id) => selection.get(id).holds.length === 0 && Buffer.byteLength(catalogue.records.get(id)?.title ?? '') >= 5);
  const P = selection.get(X).nativeProjectId;
  const M = people.manager.address;
  const E = people.evaluator.address;
  const G = people.guardian.address;
  const policy = fleetPolicy({ selection, X, manager: M, evaluator: E, solvers: [people.solver.address] });

  // FIXTURE custody tree, exactly as the Python custody stage: protected files under one boundary.
  const python = process.env.UAIN_ORGS_E2E_PYTHON ?? '/usr/bin/python3';
  const harness = fileURLToPath(new URL('./python-custody-stage.py', import.meta.url));
  const batchCheck = fileURLToPath(new URL('./python-fund-batch-check.py', import.meta.url));
  const custodyDir = fileURLToPath(new URL('../../../ops/custody', import.meta.url));
  const boundary = await mkdtemp(join(tmpdir(), 'uain-orgs-fund-custody-'));
  t.after(() => rm(boundary, { recursive: true, force: true }));
  for (const d of ['etc', 'journal', 'tmp', 'calls', 'stage']) await mkdir(join(boundary, d), { mode: 0o700 });
  const stageRoot = join(boundary, 'stage');
  const docs = new URL('../../../docs/baink/project-organizations-2026-11-06/', import.meta.url);
  for (const name of ['selection.json', 'kpi-amendments.json']) await writeFile(join(boundary, 'etc', name), await readFile(new URL(name, docs)), { mode: 0o600 });
  await writeFile(join(boundary, 'etc/policy.json'), JSON.stringify(policy) + '\n', { mode: 0o600 });
  const seed = (x) => Buffer.from(x.privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64url');
  const attachment = (x) => ({ private_key: seed(x), public_key: x.raw.toString('base64url') });
  const harnessConfig = join(boundary, 'etc/harness.json');
  await writeFile(harnessConfig, JSON.stringify({
    custodyDir, chainId, guardian: G, boundary,
    policyPath: join(boundary, 'etc/policy.json'), selectionPath: join(boundary, 'etc/selection.json'), amendmentsPath: join(boundary, 'etc/kpi-amendments.json'),
    root: join(boundary, 'journal'), tmp: join(boundary, 'tmp'),
    reader: { binary: config.binary, binarySha256: TOOL_PINS.reader, genesis: config.genesis, genesisSha256: config.genesisHash, rpc: config.rpc },
    attachments: {
      'keys/uain-review-key.json': attachment(people.guardian),
      ...Object.fromEntries([people.manager, people.evaluator, people.solver].map((x) => [`keys/project-organizations/${x.address}.json`, attachment(x)])),
    },
  }), { mode: 0o600 });
  const runPython = (args) => new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-B', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const parts = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout.on('data', (b) => parts.push(b));
    child.stderr.on('data', (b) => { err = (err + b).slice(-4000); });
    child.once('error', reject);
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve(JSON.parse(Buffer.concat(parts).toString().trim().split('\n').pop())) : reject(new Error(`python exited ${code}: ${err}`)); });
  });
  let calls = 0;
  async function custody(request, caller = 'agent') {
    const callPath = join(boundary, 'calls', `${String(++calls).padStart(4, '0')}.json`);
    await writeFile(callPath, JSON.stringify({ projectId: X, request, caller }), { mode: 0o600 });
    return runPython([harness, harnessConfig, callPath]);
  }
  const view = async (member = null, keys = []) => (await assets.publicState({ ...(member ? { member } : {}), keys })).state;
  // Ruling K-49 (10 Nov 2026): no 2-of-3 guardian handover while testing. Every step of this stage
  // runs in exactly that state (one guardian, no guardian epoch, no consensus v2): the guardian's
  // configure is signed alone and nothing waits for or writes a quorum batch.
  async function singleGuardian(label) {
    const r = (await view(null, ['guardians', 'guardian_epoch_current', 'consensus_v2_activation'])).records;
    assert.deepEqual([r.guardians, r.guardian_epoch_current ?? null, r.consensus_v2_activation ?? null], [[G], null, null], `${label}: single guardian, no handover`);
    note('single_guardian', { label, guardians: r.guardians.length });
  }
  const signatures = [];
  async function settle(label, request, caller = 'agent') {
    let r = await custody(request, caller);
    assert.ok(!['refused', 'error'].includes(r.status), `${label}: ${JSON.stringify(r)}`);
    assert.deepEqual([r.counters.signed, r.counters.broadcasts, r.counters.broadcastCodes], [1, 1, [0]], `${label}: one signature, one accepted broadcast`);
    for (let i = 0; i < 80 && r.status !== 'finalized'; i++) {
      await pause(1500);
      r = await custody(request, caller);
      assert.deepEqual([r.counters.signed, r.counters.broadcasts], [0, 0], `${label}: a later invocation only reconciles`);
    }
    assert.equal(r.status, 'finalized', `${label}: finalized`);
    assert.equal(r.receipt.event.command_digest, sha(signingBytes(r.envelope.command)), `${label}: receipt binds the signed command`);
    signatures.push({ label, operation: request.operation, member: request.member, eventId: r.receipt.event.id });
    note(label, { operation: request.operation, eventId: r.receipt.event.id, stateHeight: r.receipt.state_height });
    return r;
  }
  const req = (id, member, operation, payload) => ({ id, member, operation, payload });

  // Bootstrap and the approved five-sub-KPI plan through Python fleet custody.
  await singleGuardian('before_bootstrap');
  const title = catalogue.records.get(X).title;
  const priorArt = { basis: 'FIXTURE prior-art record for an isolated fictional-chain qualification only. No real search was run and no novelty is claimed.',
    searches: ['FIXTURE search one (fictional, not executed)', 'FIXTURE search two (fictional, not executed)'] };
  await settle('open_project', req(`open-${X}`, G, 'open_project', { id: P, title, class: 'benevolent', prior_art: priorArt }), 'bootstrap');
  await settle('central_project_start', req(`start-${X}`, G, 'central_project_start', { project: P, manager: M, evidence_digest: FIXTURE_DIGEST }), 'bootstrap');
  await settle('central_fund_configure', req(`configure-${X}`, G, 'central_fund_configure', { project: P, evaluator: E, expected_evaluator: '', evidence_digest: FIXTURE_DIGEST }), 'bootstrap');
  await settle('project_join_manager', req(`join-${X}-manager`, M, 'project_join', { project: P }));
  const stages = Array.from({ length: 5 }, (_, i) => ({ round: i + 1, criteria: `FIXTURE sub-KPI ${i + 1}: an accepted, independently reviewed result toward the unchanged Main KPI.` }));
  await settle('central_fund_plan', req(`plan-${X}-1`, E, 'central_fund_plan', { project: P, revision: 1, main_kpi: selection.get(X).mainKpi, stages, reason: 'FIXTURE: five ordered sub-KPIs.', evidence_digest: FIXTURE_DIGEST }));
  await settle('central_fund_plan_review', req(`review-${X}-1`, E, 'central_fund_plan_review', { project: P, revision: 1, verdict: 'accept', evidence_digest: FIXTURE_DIGEST }));

  // The status reader the manager stage uses, over the real pinned reader.
  const status = async (keys) => {
    const s = await view(null, keys);
    return { status: 'read', height: s.height, app_hash: s.app_hash, records: Object.fromEntries(keys.map((k) => [k, s.records[k] ?? null])) };
  };
  const tasksOf = createTaskReader(status);
  const snapshot = async () => (await readNativeSnapshot({ status, tasksOf, projectId: X, selection })).snapshot;
  const decisions = { recent: 0, open: new Set() };
  const deciderCalls = [];
  const decider = { model: FUND_DECIDER_MODEL, fixture: true, async execute({ executionId, prompt }) {
    deciderCalls.push({ executionId, promptDigest: sha(prompt) });
    return { value: { verdict: 'accept', criteria_met: true, main_kpi_achieved: false,
      findings: ['FIXTURE finding: the accepted prior-art survey is the work sub-KPI 1 names in this fictional plan.'],
      feedback: 'FIXTURE decision on a fictional chain: the accepted, centrally reviewed survey meets the fictional sub-KPI 1 criteria.' },
      receipt: { executionId, model: FUND_DECIDER_MODEL, actual: false, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } };
  } };
  const step = () => snapshot().then((s) => fundStep({ projectId: X, snapshot: s, policy, status, decider, stageRoot, decisions }));
  const driverCheck = (path) => runPython([batchCheck, custodyDir, stageRoot, path, X]);
  const readBatch = async (path) => JSON.parse(await readFile(path, 'utf8'));

  // No accepted work yet: nothing to apply for.
  await assert.rejects(step(), { code: 'prior_art_survey_required' }, 'round 1 waits for the accepted survey');
  note('no_application_without_evidence', { round: 1 });

  // Round-1 work: the prior-art survey, opened by the manager, submitted by the solver and
  // accepted by the FIXTURE central reviewer (real transactions; FIXTURE survey content).
  const TS = `T-${X}-1-prior-art-survey`;
  const criteria = 'FIXTURE survey criteria: every listed identifier resolves in its primary-source record.';
  await settle('central_task_open_survey', req(`open-${TS}`, M, 'central_task_open', { id: TS, project: P, title: 'FIXTURE prior-art survey', criteria, acceptance_digest: sha(criteria),
    eligibility: 'unresolved', eligibility_digest: FIXTURE_DIGEST, solver_amount: '200000000', reviewer_amount: '50000000', evidence_digest: FIXTURE_DIGEST }));
  await settle('project_join_solver', req(`join-${X}-solver`, people.solver.address, 'project_join', { project: P }));
  const SS = `sub-survey-${X}`;
  const survey = { mainKpi: selection.get(X).mainKpi, asOf: '2026-11-10',
    items: [{ kind: 'wikidata', id: 'Q1000', title: 'FIXTURE record', relation: 'partial', note: 'FIXTURE note: not a research result.' }],
    conclusion: { meetsMainKpi: false, gaps: ['FIXTURE gap: no existing work meets the Main KPI as written.'] } };
  const surveyEvidence = canonical({ schema: ARTIFACT_SCHEMA, taskId: TS, submissionId: SS, author: people.solver.address, survey });
  await settle('central_submit_survey', req(`submit-${SS}`, people.solver.address, 'central_submit', { id: SS, task: TS, evidence: surveyEvidence, evidence_digest: sha(surveyEvidence) }));
  const reviewed = await direct('central_review', { submission: SS, verdict: 'accept', criteria_digest: sha(criteria), verification_digest: FIXTURE_DIGEST,
    execution_id: 'fixture-review-survey-1', evidence_digest: sha(surveyEvidence) }, people.reviewer);
  note('survey_accepted', { task: TS, submission: SS, height: reviewed.height });

  // 1. Application: the fund step writes it from public evidence; the production driver's check
  //    accepts it; the manager signs it through fleet custody.
  const apply = await step();
  assert.deepEqual([apply.action, apply.round, apply.tasks], ['apply', 1, 1], JSON.stringify(apply));
  const applyBatch = await readBatch(apply.path);
  assert.deepEqual((await driverCheck(apply.path)).status, 'accepted', 'the root driver re-derives the evidence digest');
  assert.equal(applyBatch.request.payload.id, applicationId(X, 1, applyBatch.request.payload.evidence_digest));
  await settle('central_fund_apply', applyBatch.request);
  const applied = (await view(null, [`central_fund_state/${P}`, `central_fund_application/${apply.application}`])).records;
  assert.deepEqual([applied[`central_fund_state/${P}`].pending, applied[`central_fund_application/${apply.application}`].state,
    applied[`central_fund_application/${apply.application}`].evidence_digest], [apply.application, 'pending', applyBatch.request.payload.evidence_digest]);
  note('application_pending', { application: apply.application, evidenceDigest: applyBatch.request.payload.evidence_digest });

  // 2. Decision: the Fund Manager agent (FIXTURE answer here) decides from the retained bundle,
  //    re-proved against the real reader; the production driver refuses a non-actual decision,
  //    so the FIXTURE decision is signed by the evaluator through fleet custody directly.
  const decide = await step();
  assert.deepEqual([decide.action, decide.verdict, decide.basis], ['decide', 'accept', 'fund_manager_agent'], JSON.stringify(decide));
  assert.equal(deciderCalls.length, 1);
  const decideBatch = await readBatch(decide.path);
  assert.deepEqual(await driverCheck(decide.path), { status: 'refused', code: 'fund_decision_not_actual' }, 'production signs only actual Sonnet decisions');
  assert.deepEqual(decideBatch.request.payload, decisionPayload(decideBatch.decision));
  await settle('central_fund_decide_accept', decideBatch.request);
  const unlocked = (await view(null, [`central_project_budget/${P}`, `central_fund_state/${P}`, `central_fund_application/${apply.application}`])).records;
  const budget2 = unlocked[`central_project_budget/${P}`];
  const app1 = unlocked[`central_fund_application/${apply.application}`];
  assert.deepEqual([budget2.round, budget2.allocation, unlocked[`central_fund_state/${P}`].completed, unlocked[`central_fund_state/${P}`].pending],
    [2, '110000000000', 1, ''], 'round 2 unlocked: 110,000 AI$ cumulative');
  assert.deepEqual([app1.state, app1.evaluator, app1.verification_digest, app1.feedback, app1.main_kpi_achieved],
    ['accept', E, decideBatch.request.payload.verification_digest, decideBatch.request.payload.feedback, false], 'the decision and its reasons are on public record');
  note('round_2_unlocked', { allocation: budget2.allocation, application: apply.application, feedback: app1.feedback });

  // 3. Round 2 has no accepted work: the fund step does not apply.
  const idle = await step();
  assert.deepEqual([idle.action, idle.reason, idle.round], ['none', 'no_round_evidence', 2]);
  note('no_round_2_application_without_evidence', {});

  // 4. Missing evidence: an application naming evidence nobody holds (sent outside the stage, as a
  //    manager could) is refused without a model call; nothing is released.
  const fakeId = applicationId(X, 2, FIXTURE_DIGEST);
  await settle('central_fund_apply_missing_evidence', req(`${fakeId}-a1`, M, 'central_fund_apply', { id: fakeId, project: P, round: 2, revision: 1, evidence_digest: FIXTURE_DIGEST }));
  const refused = await step();
  assert.deepEqual([refused.action, refused.verdict, refused.basis], ['decide', 'reject', 'evidence_not_found'], JSON.stringify(refused));
  assert.equal(deciderCalls.length, 1, 'no model call for missing evidence');
  assert.deepEqual((await driverCheck(refused.path)).status, 'accepted', 'the root driver accepts the evidence-missing refusal');
  await settle('central_fund_decide_reject', (await readBatch(refused.path)).request);
  const after = (await view(null, [`central_project_budget/${P}`, `central_fund_state/${P}`, `central_fund_application/${fakeId}`])).records;
  assert.deepEqual([after[`central_project_budget/${P}`].round, after[`central_project_budget/${P}`].allocation, after[`central_fund_state/${P}`].completed,
    after[`central_fund_state/${P}`].pending, after[`central_fund_application/${fakeId}`].state], [2, '110000000000', 1, '', 'reject'], 'nothing released');
  note('missing_evidence_refused', { application: fakeId, feedback: after[`central_fund_application/${fakeId}`].feedback });
  await singleGuardian('after_fund_round');
  assert.ok(signatures.some((s) => s.operation === 'central_fund_configure' && s.member === G), 'configure signed by the single guardian alone');
  assert.deepEqual(readdirSync(boundary, { recursive: true }).filter((f) => /quorum/i.test(String(f))), [], 'no quorum batch written anywhere in the custody tree');

  const summary = {
    fixtureOnly: true, label: 'FIXTURE: fictional genesis, identities, keys, survey content and Fund Manager answer; real pinned daemon and reader, production fund-round code and Python fleet custody; not production evidence',
    startedAt, finishedAt: new Date().toISOString(), chainId, genesisSha256: config.genesisHash, daemonSha256: TOOL_PINS.daemon, readerSha256: TOOL_PINS.reader,
    projectId: X, nativeProjectId: P, application: apply.application, unlockedAllocation: budget2.allocation, refusedApplication: fakeId,
    deciderCalls: deciderCalls.length, signatures, steps, productionWrites: false,
  };
  t.diagnostic(`FIXTURE_FUND_SUMMARY ${JSON.stringify(summary)}`);
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, 'fund-round-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    await writeFile(join(evidenceDir, 'fund-round-batches.json'), JSON.stringify({ apply: applyBatch, decide: decideBatch, refused: await readBatch(refused.path) }, null, 2) + '\n');
  }
});

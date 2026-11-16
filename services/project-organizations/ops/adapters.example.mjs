/** Operator adapters for `ops/report.mjs` — the reviewed template.
 *
 *   node services/project-organizations/ops/report.mjs \
 *     --adapters /opt/<reviewed release>/services/project-organizations/ops/adapters.example.mjs \
 *     --config /etc/<operator>/report-adapters.json
 *
 * Every adapter is built from the explicit config object passed in (report.mjs reads it
 * from the `--config` path on argv only). Nothing comes from defaults: a missing key, an
 * unknown key, a placeholder value or an absent store refuses with an `adapters_config_*`
 * code before any read happens. The config holds no secret: the Paperclip operator key is
 * named by its environment variable (`paperclip.apiKeyEnv`), and its value is read from the
 * process environment at construction only.
 *
 * Config (schema `uain-project-organization-report-adapters-v1`, exact keys):
 *   production: {chainId, genesisSha256}  the reviewed production pin. Native proofs from any
 *       other chain are reported as non-production by acceptance.
 *   native: {chainId, startEvent, reader}  `reader` is the BAINK pinned reader config
 *       (apps/baink/server/native-asset.mjs `validatedConfig`: binary, binaryHash, genesis,
 *       genesisHash, rpc, timeoutMs, maxAgeSeconds); `createNativeAssetAdapter` runs the pinned
 *       `uain-state` verifier. `startEvent` must be "0" for review completeness.
 *       When native.chainId equals production.chainId, reader.genesisHash must equal
 *       production.genesisSha256.
 *   fleetPolicyPath  the root-owned fleet policy JSON (native.mjs validateFleetPolicy).
 *   paperclip: {contractPath, origin, apiKeyEnv}  the qualified contract JSON, the private
 *       HTTPS origin, and the NAME of the environment variable holding the operator key.
 *   review: {stores, reviewer} | null  central-reviewer `jobs.json` stores
 *       (services/central-reviewer worker) and the pinned reviewer address; null leaves the
 *       reward review cells unknown.
 *   registryDirectory, journalDirectory, leadershipDirectory  existing stores (registry.sqlite,
 *       journal.sqlite, leadership.jsonl must already exist: an empty new store would report
 *       absence where the truth is "not read").
 *   scheduler: {stateDirectory, workspaceRoot}  existing scheduler state (attempts only).
 *   outputDirectory  where the three report files are written.
 *
 * The account readback (BAINK account view) has no reviewed reader yet, so `accountReader`
 * is null and the account cells stay unknown.
 *
 * The adapters are read-only: custody, the solver executor, compute budget, job source and
 * broadcast are refusing stubs, and the native reader is built without a broadcaster and
 * with production broadcast disabled. */
import { existsSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createNativeAssetAdapter } from '../../../apps/baink/server/native-asset.mjs';
import { ADDRESS, HASH, OrganizationError, exactKeys, need, plain, refuse } from '../src/common.mjs';
import { openJournal } from '../src/journal.mjs';
import { openLeadershipStore } from '../src/leadership.mjs';
import { createNativeAdapter } from '../src/native.mjs';
import { createNativeReader } from '../src/native-reader.mjs';
import { createOrganizationAdapter, createPaperclipTransport } from '../src/paperclip.mjs';
import { openRegistry } from '../src/registry.mjs';
import { createReviewSource } from '../src/review-source.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { loadSelection } from '../src/selection.mjs';
import { trustedFile } from './report.mjs';

export const ADAPTERS_CONFIG_SCHEMA = 'uain-project-organization-report-adapters-v1';
const TOP = ['schema', 'production', 'native', 'fleetPolicyPath', 'paperclip', 'review', 'registryDirectory', 'journalDirectory',
  'leadershipDirectory', 'scheduler', 'outputDirectory'];
const READER = ['binary', 'binaryHash', 'genesis', 'genesisHash', 'rpc', 'timeoutMs', 'maxAgeSeconds'];
const CHAIN = /^[A-Za-z0-9._-]{1,96}$/;
const UINT = /^(0|[1-9][0-9]{0,19})$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
const PLACEHOLDER = /REPLACE|EXAMPLE|CHANGE_?ME|TODO/i;

/** Shape only, with placeholders that refuse: copy, fill from the reviewed deployment
 * configuration, and keep the result root-owned (0644 or stricter). */
export const EXAMPLE_CONFIG = Object.freeze({
  schema: ADAPTERS_CONFIG_SCHEMA,
  production: { chainId: 'REPLACE_WITH_REVIEWED_PRODUCTION_CHAIN_ID', genesisSha256: 'REPLACE_WITH_REVIEWED_GENESIS_SHA256' },
  native: {
    chainId: 'REPLACE_WITH_READER_CHAIN_ID', startEvent: '0',
    reader: {
      binary: '/REPLACE/uain-state', binaryHash: 'REPLACE_WITH_VERIFIER_SHA256', genesis: '/REPLACE/genesis.json',
      genesisHash: 'REPLACE_WITH_GENESIS_SHA256', rpc: 'http://127.0.0.1:REPLACE', timeoutMs: 8000, maxAgeSeconds: 120,
    },
  },
  fleetPolicyPath: '/REPLACE/fleet-policy.json',
  paperclip: { contractPath: '/REPLACE/paperclip-contract.json', origin: 'https://REPLACE.invalid', apiKeyEnv: 'REPLACE_PAPERCLIP_KEY_ENV' },
  review: { stores: ['/REPLACE/jobs.json'], reviewer: 'REPLACE_WITH_REVIEWER_ADDRESS' },
  registryDirectory: '/REPLACE/registry',
  journalDirectory: '/REPLACE/journal',
  leadershipDirectory: '/REPLACE/leadership',
  scheduler: { stateDirectory: '/REPLACE/scheduler', workspaceRoot: '/REPLACE/workspaces' },
  outputDirectory: '/REPLACE/reports',
});

const bad = (detail) => refuse('adapters_config_invalid', detail);
function placeholders(value, at = 'config') {
  if (typeof value === 'string') {
    if (PLACEHOLDER.test(value)) refuse('adapters_config_placeholder', `${at} is a placeholder`);
  } else if (Array.isArray(value)) value.forEach((v, i) => placeholders(v, `${at}[${i}]`));
  else if (plain(value)) for (const [k, v] of Object.entries(value)) placeholders(v, `${at}.${k}`);
}
const absolute = (v, at) => (typeof v === 'string' && isAbsolute(v) && !v.includes('\0') && v.length <= 4096) || bad(`${at} must be an absolute path`);

/** Validates the config object; returns a frozen deep copy. */
export function validateAdaptersConfig(config) {
  need(plain(config), 'adapters_config_missing', 'a config object is required');
  for (const k of TOP) need(Object.hasOwn(config, k) && config[k] !== undefined, 'adapters_config_missing', `${k} is required`);
  need(exactKeys(config, TOP), 'adapters_config_invalid', 'unknown config keys');
  placeholders(config);
  const c = structuredClone(config);
  need(c.schema === ADAPTERS_CONFIG_SCHEMA, 'adapters_config_invalid', 'schema');
  need(exactKeys(c.production, ['chainId', 'genesisSha256']) && CHAIN.test(c.production.chainId ?? '') && HASH.test(c.production.genesisSha256 ?? ''),
    'adapters_config_invalid', 'production {chainId, genesisSha256}');
  need(exactKeys(c.native, ['chainId', 'startEvent', 'reader']) && CHAIN.test(c.native.chainId ?? '') &&
    typeof c.native.startEvent === 'string' && UINT.test(c.native.startEvent), 'adapters_config_invalid', 'native {chainId, startEvent, reader}');
  const r = c.native.reader;
  need(exactKeys(r, READER), 'adapters_config_missing', `native.reader needs exactly ${READER.join(', ')}`);
  absolute(r.binary, 'native.reader.binary');
  absolute(r.genesis, 'native.reader.genesis');
  need(HASH.test(r.binaryHash ?? '') && HASH.test(r.genesisHash ?? '') && typeof r.rpc === 'string' &&
    Number.isInteger(r.timeoutMs) && Number.isInteger(r.maxAgeSeconds), 'adapters_config_invalid', 'native.reader pins');
  if (c.native.chainId === c.production.chainId)
    need(r.genesisHash === c.production.genesisSha256, 'adapters_production_pin_mismatch', 'the production reader must use the pinned genesis');
  absolute(c.fleetPolicyPath, 'fleetPolicyPath');
  need(exactKeys(c.paperclip, ['contractPath', 'origin', 'apiKeyEnv']), 'adapters_config_missing', 'paperclip {contractPath, origin, apiKeyEnv}');
  absolute(c.paperclip.contractPath, 'paperclip.contractPath');
  need(typeof c.paperclip.origin === 'string' && c.paperclip.origin.startsWith('https://'), 'adapters_config_invalid', 'paperclip.origin must be https');
  need(typeof c.paperclip.apiKeyEnv === 'string' && ENV_NAME.test(c.paperclip.apiKeyEnv), 'adapters_config_invalid',
    'paperclip.apiKeyEnv is the NAME of an environment variable, never a key');
  if (c.review !== null) {
    need(exactKeys(c.review, ['stores', 'reviewer']) && Array.isArray(c.review.stores) && c.review.stores.length >= 1 &&
      typeof c.review.reviewer === 'string' && ADDRESS.test(c.review.reviewer), 'adapters_config_invalid', 'review {stores, reviewer} or null');
    c.review.stores.forEach((s, i) => absolute(s, `review.stores[${i}]`));
  }
  for (const k of ['registryDirectory', 'journalDirectory', 'leadershipDirectory', 'outputDirectory']) absolute(c[k], k);
  need(exactKeys(c.scheduler, ['stateDirectory', 'workspaceRoot']), 'adapters_config_missing', 'scheduler {stateDirectory, workspaceRoot}');
  absolute(c.scheduler.stateDirectory, 'scheduler.stateDirectory');
  absolute(c.scheduler.workspaceRoot, 'scheduler.workspaceRoot');
  return Object.freeze(c);
}

/** An existing plain directory that no other user can write. */
function existingDirectory(path, at) {
  need(existsSync(path), 'adapters_store_missing', `${at} does not exist`);
  const st = lstatSync(path);
  need(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o022) === 0, 'adapters_store_untrusted', `${at} must be a plain directory not writable by others`);
}
function existingFile(path, at) {
  need(existsSync(path), 'adapters_store_missing', `${at} does not exist`);
  const st = lstatSync(path);
  need(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o022) === 0, 'adapters_store_untrusted', `${at} must be a regular file not writable by others`);
}
function jsonFile(path, code) {
  try {
    return JSON.parse(trustedFile(path, { code, maxBytes: 4 * 1024 * 1024 }).toString('utf8'));
  } catch (error) {
    if (error instanceof OrganizationError) throw error;
    refuse(`${code}_invalid`);
  }
}
const readOnly = (what) => () => refuse('report_adapters_read_only', `${what} is unavailable to the report`);

/**
 * @param config the operator config object (see the header)
 * @param deps test seams: {env, createReaderTransport(readerConfig), paperclipFetch, selection}
 */
export async function createAdapters(config, deps = {}) {
  const c = validateAdaptersConfig(config);
  const env = deps.env ?? process.env;
  const apiKey = env[c.paperclip.apiKeyEnv];
  need(typeof apiKey === 'string' && apiKey.length > 0, 'adapters_paperclip_key_unset', `${c.paperclip.apiKeyEnv} is not set`);

  existingDirectory(c.registryDirectory, 'registryDirectory');
  existingFile(join(c.registryDirectory, 'registry.sqlite'), 'registry.sqlite');
  existingDirectory(c.journalDirectory, 'journalDirectory');
  existingFile(join(c.journalDirectory, 'journal.sqlite'), 'journal.sqlite');
  existingDirectory(c.leadershipDirectory, 'leadershipDirectory');
  existingFile(join(c.leadershipDirectory, 'leadership.jsonl'), 'leadership.jsonl');
  existingDirectory(c.scheduler.stateDirectory, 'scheduler.stateDirectory');
  for (const d of ['projects', 'outcomes', 'submissions', 'evidence']) existingDirectory(join(c.scheduler.stateDirectory, d), `scheduler.stateDirectory/${d}`);
  existingDirectory(c.scheduler.workspaceRoot, 'scheduler.workspaceRoot');
  existingDirectory(dirname(c.outputDirectory), 'outputDirectory parent');
  if (existsSync(c.outputDirectory)) existingDirectory(c.outputDirectory, 'outputDirectory');
  const policy = jsonFile(c.fleetPolicyPath, 'adapters_fleet_policy');
  const contract = jsonFile(c.paperclip.contractPath, 'adapters_paperclip_contract');

  const opened = [];
  const close = async () => {
    for (const f of opened.reverse()) await Promise.resolve().then(f).catch(() => {});
    opened.length = 0;
  };
  try {
    const selection = deps.selection ?? await loadSelection();
    const registry = openRegistry({ directory: c.registryDirectory, selection });
    opened.push(() => registry.close?.());
    const journal = openJournal({ directory: c.journalDirectory });
    opened.push(() => journal.close());

    const readerConfig = { ...c.native.reader, chainId: c.native.chainId };
    const transport = deps.createReaderTransport ? await deps.createReaderTransport(readerConfig) : createNativeAssetAdapter({ config: readerConfig });
    opened.push(() => transport?.close?.());
    need(transport && transport.configured !== false && typeof transport.publicState === 'function', 'adapters_native_reader_unconfigured');
    const reviewSource = c.review === null ? null : createReviewSource({ files: c.review.stores, reviewer: c.review.reviewer });
    const reader = createNativeReader({
      transport, chainId: c.native.chainId, productionChainId: c.production.chainId, startEvent: c.native.startEvent,
      timeoutMs: c.native.reader.timeoutMs, reviewSource, allowProductionBroadcast: false,
    });
    const native = createNativeAdapter({
      custody: { sign: readOnly('custody') }, reader, registry, journal, selection, policy, chainId: c.native.chainId,
    });

    const paperclipTransport = createPaperclipTransport({
      origin: c.paperclip.origin, apiKey, contract, forbiddenOrigins: [new URL(c.native.reader.rpc).origin],
      ...(deps.paperclipFetch ? { fetchImpl: deps.paperclipFetch } : {}),
    });
    const paperclip = createOrganizationAdapter({ transport: paperclipTransport, registry, journal, selection, contract });
    const leadershipStore = openLeadershipStore({ directory: c.leadershipDirectory });
    const scheduler = createScheduler({
      selection, registry, journal, native,
      executor: { run: readOnly('executor') }, budget: { reserve: readOnly('budget'), settle: readOnly('budget') },
      jobs: { next: readOnly('jobs'), criteriaDigest: readOnly('jobs') }, sources: { digest: readOnly('sources') },
      workspaceRoot: c.scheduler.workspaceRoot, stateDirectory: c.scheduler.stateDirectory,
    });

    return {
      selection, registry, journal, native, paperclip, leadershipStore, scheduler,
      accountReader: null,
      production: { chainId: c.production.chainId, genesisSha256: c.production.genesisSha256 },
      outputDirectory: c.outputDirectory,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export default createAdapters;

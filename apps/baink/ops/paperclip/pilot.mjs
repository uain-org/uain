import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, open, mkdir, lstat, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REVISION = 'dce383c733bb1ca31cd34d7dbb82bda597ad7418';
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const FIELDS = [
  'ID',
  'List',
  'Domain #',
  'Domain',
  'Sub-domain #',
  'Sub-domain',
  'Item',
  'Ambitious KPI (readable)',
  'KPI number',
  'KPI unit / what is counted',
];
const SOURCE_KEYS = [
  'stable_id',
  'title',
  'url',
  'status',
  'progress',
  'source_fields',
  'provenance',
  'kpi_interpretation',
  'uain_admission',
];
const MAX_BYTES = 128 * 1024;
export class PilotError extends Error {
  constructor(code) {
    super('Paperclip pilot preparation could not be qualified.');
    this.code = code;
  }
}
const valid = (ok, code = 'invalid_manifest') => {
  if (!ok) throw new PilotError(code);
};
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const exactKeys = (x, keys) =>
  object(x) &&
  Object.keys(x).length === keys.length &&
  keys.every((k) => Object.hasOwn(x, k));
const scalarText = (x, max) =>
  typeof x === 'string' &&
  x.length > 0 &&
  Buffer.byteLength(x) <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(x);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const hash = (value) =>
  createHash('sha256').update(canonical(value)).digest('hex');

export function validateManifest(m) {
  valid(
    exactKeys(m, [
      'schema',
      'sourceRevision',
      'repository',
      'buildTarget',
      'platform',
      'image',
      'imageStatus',
      'origin',
      'resources',
      'relay',
      'storage',
      'execution',
      'preflight',
      'buildPreparation',
    ]),
  );
  valid(
    m.schema === 'baink-paperclip/runtime-manifest/v1' &&
      m.sourceRevision === REVISION &&
      m.repository === 'https://github.com/paperclipai/paperclip',
  );
  valid(
    m.buildTarget === 'production' &&
      m.platform === 'linux/amd64' &&
      m.image === null &&
      m.imageStatus === 'build_required' &&
      m.origin === 'http://127.0.0.1:3101',
  );
  valid(
    canonical(m.resources) ===
      canonical({ cpus: 1, memoryMiB: 2048, pids: 256, swapMiB: 0 }),
  );
  valid(
    canonical(m.relay) ===
      canonical({
        memoryMiB: 64,
        cpuPercent: 10,
        tasks: 32,
        maxConnections: 16,
        idleTimeoutSeconds: 30,
      }),
  );
  valid(
    canonical(m.storage) ===
      canonical({ dataDirectory: '/var/lib/baink-paperclip/data' }),
  );
  valid(
    canonical(m.execution) ===
      canonical({
        agents: false,
        routines: false,
        providers: false,
        nativeWrites: false,
      }),
  );
  valid(
    canonical(m.preflight) ===
      canonical({
        minimumAvailableMemoryMiB: 5184,
        minimumDataFreeMiB: 10240,
        minimumRootFreeMiB: 5120,
        maximumSwapUseFraction: 0.75,
        resourceMaxAgeSeconds: 300,
      }),
  );
  valid(
    canonical(m.buildPreparation) ===
      canonical({
        qualifiedExternalBuilderRequired: true,
        sharedRuntimeHostBuildQualified: false,
        upstreamBaseImage: 'node:24-trixie-slim',
        dockerfileFrontend: 'docker/dockerfile:1.20',
        exactReproductionClaimed: false,
        buildCapacityMeasuredByThisTool: false,
      }),
  );
  return structuredClone(m);
}
function qualifiedImage(m, r) {
  valid(
    object(r) &&
      r.schema === 'baink-paperclip/image-receipt/v1' &&
      r.sourceRevision === m.sourceRevision &&
      r.inspectedRevision === m.sourceRevision &&
      r.target === 'production' &&
      r.platform === m.platform &&
      r.productionTargetVerified === true &&
      typeof r.image === 'string',
    'image_unqualified',
  );
  const registry =
    /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(r.image) &&
    Array.isArray(r.inspectedRepoDigests) &&
    r.inspectedRepoDigests.includes(r.image);
  const local =
    /^sha256:[a-f0-9]{64}$/.test(r.image) &&
    r.inspectedImageId === r.image &&
    HASH.test(r.archiveSha256 ?? '') &&
    typeof r.buildStamp === 'string' &&
    /^[a-zA-Z0-9._:-]{1,160}$/.test(r.buildStamp);
  valid(registry || local, 'image_unqualified');
  return r.image;
}
export function renderCompose(manifest, imageReceipt) {
  const m = validateManifest(manifest),
    image = qualifiedImage(m, imageReceipt);
  return {
    name: 'baink-paperclip-pilot',
    services: {
      paperclip: {
        container_name: 'baink-paperclip-pilot',
        labels: { 'baink.scope': 'private-paperclip-pilot' },
        image,
        platform: m.platform,
        pull_policy: 'never',
        restart: 'no',
        cpus: m.resources.cpus,
        mem_limit: '2048m',
        memswap_limit: '2048m',
        pids_limit: m.resources.pids,
        stop_grace_period: '90s',
        security_opt: ['no-new-privileges:true'],
        expose: ['3101'],
        networks: ['pilot'],
        environment: {
          HOST: '0.0.0.0',
          PORT: '3101',
          PAPERCLIP_HOME: '/paperclip',
          PAPERCLIP_CONFIG: '/paperclip/instances/default/config.json',
          PAPERCLIP_DEPLOYMENT_MODE: 'authenticated',
          PAPERCLIP_DEPLOYMENT_EXPOSURE: 'private',
          PAPERCLIP_PUBLIC_URL: m.origin,
          PAPERCLIP_AUTH_BASE_URL_MODE: 'explicit',
          PAPERCLIP_AUTH_PUBLIC_BASE_URL: m.origin,
          PAPERCLIP_ALLOWED_HOSTNAMES: '127.0.0.1',
          HEARTBEAT_SCHEDULER_ENABLED: 'false',
          PAPERCLIP_ANNOUNCEMENTS_ENABLED: 'false',
          PAPERCLIP_MIGRATION_AUTO_APPLY: 'true',
          NODE_OPTIONS: '--max-old-space-size=1024',
          BETTER_AUTH_SECRET:
            '${BETTER_AUTH_SECRET:?Provide dedicated persistent pilot session secret}',
          PAPERCLIP_TOOL_ACTION_SIGNING_SECRET:
            '${PAPERCLIP_TOOL_ACTION_SIGNING_SECRET:?Provide separate persistent pilot action secret}',
        },
        volumes: [
          {
            type: 'bind',
            source: m.storage.dataDirectory,
            target: '/paperclip',
            bind: { create_host_path: false },
          },
        ],
        logging: {
          driver: 'json-file',
          options: { 'max-size': '10m', 'max-file': '2' },
        },
      },
    },
    networks: { pilot: { internal: true } },
    'x-baink-loopback-relay': {
      automaticExecution: false,
      requiresInspectedRelayPlan: true,
      listenHost: '127.0.0.1',
      listenPort: 3101,
      containerPort: 3101,
      memoryLimitMiB: m.relay.memoryMiB,
      cpuPercent: m.relay.cpuPercent,
    },
    'x-baink-config': {
      requiresPrecreatedFile: true,
      path: m.storage.dataDirectory + '/instances/default/config.json',
      uid: 1000,
      gid: 1000,
      mode: '0600',
      content: {
        $meta: {
          version: 1,
          source: 'configure',
          updatedAt: 'set-by-operator-at-provisioning',
        },
        database: {
          mode: 'embedded-postgres',
          embeddedPostgresDataDir: '/paperclip/instances/default/db',
          embeddedPostgresPort: 54329,
          backup: {
            enabled: false,
            intervalMinutes: 60,
            retentionDays: 7,
            dir: '/paperclip/instances/default/data/backups',
          },
        },
        logging: { mode: 'file', logDir: '/paperclip/instances/default/logs' },
        server: {
          deploymentMode: 'authenticated',
          exposure: 'private',
          host: '0.0.0.0',
          port: 3101,
          allowedHostnames: ['127.0.0.1'],
          serveUi: true,
        },
        auth: {
          baseUrlMode: 'explicit',
          publicBaseUrl: m.origin,
          disableSignUp: false,
        },
        telemetry: { enabled: false },
        updates: { checkEnabled: false },
        storage: {
          provider: 'local_disk',
          localDisk: { baseDir: '/paperclip/instances/default/data/storage' },
        },
        secrets: {
          provider: 'local_encrypted',
          strictMode: false,
          localEncrypted: {
            keyFilePath: '/paperclip/instances/default/secrets/master.key',
          },
        },
      },
    },
  };
}
export function preflight({
  manifest,
  resources = {},
  imageReceipt,
  imageEquivalence,
  now = Date.now,
}) {
  const m = validateManifest(manifest),
    checks = [];
  const check = (id, passed) => checks.push({ id, passed: Boolean(passed) });
  const measured = (name) =>
    Number.isSafeInteger(resources[name]) && resources[name] >= 0;
  let image = null;
  try {
    image = qualifiedImage(m, imageReceipt);
  } catch {}
  check('immutable_production_image_receipt', image);
  const age = now() - Date.parse(resources.capturedAt);
  const cold = resources.coldSwapQualification;
  const pilotImageEquivalenceAccepted = equivalentLoadedImage(
    imageEquivalence,
    cold?.pilotImage,
    image,
    imageReceipt,
    m,
  );
  const coldSwapEvidenceAccepted =
    object(cold) &&
    image !== null &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= m.preflight.resourceMaxAgeSeconds * 1000 &&
    measured('availableMemoryMiB') &&
    resources.availableMemoryMiB >=
      m.resources.memoryMiB + m.relay.memoryMiB + 3072 &&
    Number.isInteger(cold.sampleSeconds) &&
    cold.sampleSeconds >= 60 &&
    cold.sampleSeconds <= 300 &&
    ['psiSomeAvg10Percent', 'psiSomeAvg60Percent'].every(
      (k) => Number.isFinite(cold[k]) && cold[k] >= 0 && cold[k] <= 1,
    ) &&
    ['psiFullAvg10Percent', 'psiFullAvg60Percent'].every(
      (k) => Number.isFinite(cold[k]) && cold[k] >= 0 && cold[k] <= 0.1,
    ) &&
    ['swapInPages', 'swapOutPages', 'oomKillDelta'].every(
      (k) => cold[k] === 0,
    ) &&
    Number.isSafeInteger(cold.pilotPeakMemoryMiB) &&
    cold.pilotPeakMemoryMiB > 0 &&
    cold.pilotPeakMemoryMiB <= m.resources.memoryMiB &&
    Number.isInteger(cold.pilotObservationSeconds) &&
    cold.pilotObservationSeconds >= 60 &&
    cold.pilotObservationSeconds <= 3600 &&
    (cold.pilotImage === image || pilotImageEquivalenceAccepted);
  check(
    'fresh_measurement',
    Number.isFinite(age) &&
      age >= 0 &&
      age <= m.preflight.resourceMaxAgeSeconds * 1000,
  );
  check(
    'memory_headroom',
    measured('availableMemoryMiB') &&
      resources.availableMemoryMiB >= m.preflight.minimumAvailableMemoryMiB,
  );
  check(
    'data_disk_headroom',
    measured('dataFreeMiB') &&
      resources.dataFreeMiB >= m.preflight.minimumDataFreeMiB,
  );
  check(
    'root_disk_headroom',
    measured('rootFreeMiB') &&
      resources.rootFreeMiB >= m.preflight.minimumRootFreeMiB,
  );
  check(
    'swap_pressure',
    measured('swapTotalMiB') &&
      measured('swapUsedMiB') &&
      resources.swapUsedMiB <= resources.swapTotalMiB &&
      (coldSwapEvidenceAccepted ||
        resources.swapTotalMiB === 0 ||
        resources.swapUsedMiB / resources.swapTotalMiB <=
          m.preflight.maximumSwapUseFraction),
  );
  check(
    'loopback_port_available',
    Array.isArray(resources.listeningPorts) &&
      resources.listeningPorts.every(
        (n) => Number.isInteger(n) && n >= 1 && n <= 65535,
      ) &&
      !resources.listeningPorts.includes(3101),
  );
  check(
    'fresh_pilot_data_directory',
    ['absent', 'empty'].includes(resources.dataDirectoryState),
  );
  return {
    schema: 'baink-paperclip/preflight/v1',
    ready: checks.every((c) => c.passed),
    checks,
    executionEnabled: false,
    measurementAuthority: 'operator_supplied_not_independently_attested',
    coldSwapEvidenceAccepted,
    pilotImageEquivalenceAccepted,
    measuredPilotImage:
      cold?.pilotImage === image
        ? image
        : /^sha256:[a-f0-9]{64}$/.test(cold?.pilotImage ?? '')
          ? cold.pilotImage
          : null,
    runtimeTested: false,
  };
}

// Operator-custody evidence, not a registry attestation or a replacement for
// the exact target image receipt. Preserve the original measured image ID.
function equivalentLoadedImage(r, source, target, receipt, manifest) {
  try {
    if (
      !object(r) ||
      Buffer.byteLength(JSON.stringify(r)) > MAX_BYTES ||
      r.schema !== 'baink-paperclip/loaded-image-equivalence/v1' ||
      r.sourceRevision !== manifest.sourceRevision ||
      !/^sha256:[a-f0-9]{64}$/.test(source ?? '') ||
      !/^sha256:[a-f0-9]{64}$/.test(target ?? '') ||
      source === target ||
      r.sourceImageId !== source ||
      r.targetImageId !== target ||
      !HASH.test(r.archiveSha256 ?? '') ||
      r.archiveSha256 !== receipt?.archiveSha256 ||
      r.platformMatches !== true ||
      r.configurationMatches !== true ||
      r.rootFsMatches !== true
    )
      return false;
    const records = Object.values(r.inspections ?? {});
    if (records.length !== 2) return false;
    const a = records.find((v) => v?.imageId === source),
      b = records.find((v) => v?.imageId === target);
    if (
      !a ||
      !b ||
      !records.every(
        (v) =>
          v.os === 'linux' &&
          v.architecture === 'amd64' &&
          HASH.test(v.configSha256 ?? '') &&
          HASH.test(v.rootFsSha256 ?? '') &&
          Array.isArray(v.rootFsLayerDigests) &&
          v.rootFsLayerDigests.length > 0 &&
          v.rootFsLayerDigests.length <= 128 &&
          v.rootFsLayerCount === v.rootFsLayerDigests.length &&
          v.rootFsLayerDigests.every((d) => /^sha256:[a-f0-9]{64}$/.test(d)) &&
          hash({ Type: 'layers', Layers: v.rootFsLayerDigests }) ===
            v.rootFsSha256,
      )
    )
      return false;
    return (
      a.configSha256 === b.configSha256 &&
      a.rootFsSha256 === b.rootFsSha256 &&
      canonical(a.rootFsLayerDigests) === canonical(b.rootFsLayerDigests)
    );
  } catch {
    return false;
  }
}

export function buildBootstrapPlan(input) {
  const code = 'invalid_plan';
  valid(
    object(input) &&
      Buffer.byteLength(JSON.stringify(input)) <= MAX_BYTES &&
      input.schema === 'uain-project-incubator/paperclip-request-plan/v1' &&
      UUID.test(input.company_id) &&
      HASH.test(input.source_sha256) &&
      Array.isArray(input.candidate_requests) &&
      input.candidate_requests.length === 1,
    code,
  );
  const r = input.candidate_requests[0];
  valid(
    exactKeys(r, ['method', 'path', 'body']) &&
      r.method === 'POST' &&
      r.path === `/api/companies/${input.company_id}/projects` &&
      exactKeys(r.body, [
        'name',
        'description',
        'status',
        'visibility',
        'idempotencyKey',
      ]) &&
      r.body.status === 'backlog' &&
      r.body.visibility === 'private' &&
      scalarText(r.body.name, 2000) &&
      scalarText(r.body.description, 100000),
    code,
  );
  let d;
  try {
    d = JSON.parse(r.body.description);
  } catch {
    throw new PilotError(code);
  }
  valid(
    exactKeys(d, SOURCE_KEYS) &&
      /^(OPP|PRB)-[0-9]{5}$/.test(d.stable_id) &&
      !d.stable_id.endsWith('-00000') &&
      scalarText(d.title, 2000) &&
      d.url?.startsWith(`/PR/${d.stable_id}-`) &&
      /^\/PR\/[A-Za-z0-9-]+$/.test(d.url) &&
      d.status === 'proposed' &&
      canonical(d.progress) ===
        canonical({ status: 'unknown', percent_complete: null }) &&
      d.kpi_interpretation === 'proposed_target_unverified' &&
      d.uain_admission === 'not_evaluated' &&
      exactKeys(d.source_fields, FIELDS),
    code,
  );
  const f = d.source_fields;
  valid(
    f.ID === d.stable_id &&
      f.Item === d.title &&
      r.body.name === `[${d.stable_id}] ${d.title}` &&
      f.List ===
        (d.stable_id.startsWith('OPP-') ? 'Opportunity' : 'Problem to solve') &&
      Number.isSafeInteger(f['Domain #']) &&
      f['Domain #'] > 0 &&
      typeof f['Sub-domain #'] === 'string' &&
      new RegExp(`^${f['Domain #']}\\.[1-9][0-9]*$`).test(f['Sub-domain #']) &&
      typeof f['KPI number'] === 'number' &&
      Number.isFinite(f['KPI number']) &&
      f['KPI number'] >= 0 &&
      [
        'Domain',
        'Sub-domain',
        'Ambitious KPI (readable)',
        'KPI unit / what is counted',
      ].every((k) => scalarText(f[k], 10000)),
    code,
  );
  valid(
    exactKeys(d.provenance, ['source_sha256', 'sheet', 'row']) &&
      d.provenance.source_sha256 === input.source_sha256 &&
      d.provenance.sheet === 'All items' &&
      Number.isSafeInteger(d.provenance.row) &&
      d.provenance.row >= 2 &&
      r.body.idempotencyKey === `uain-incubator-project-v1:${d.stable_id}`,
    code,
  );
  const payload = {
    schema: 'baink-paperclip/bootstrap-plan/v1',
    companyId: input.company_id,
    sourceId: d.stable_id,
    sourceSha256: input.source_sha256,
    sourceContractRevision: REVISION,
    exporterReviewedRevision: '19ec787e5bdd8684720068e7e39f02996afe7d8c',
    request: structuredClone(r),
    ownerAuthority: 'unverified',
    nativeMapping: null,
    nativeAdmission: 'not_evaluated',
    networkWrites: 0,
    executionEnabled: false,
    requiredGates: [
      'qualified_runtime_and_private_company_ownership',
      'existing_approved_native_project_and_proven_lead_or_prior_art_searches_and_native_admission',
      'exact_actor_receipt_replay_and_conflict_qualification',
      'separate_operator_activation_not_implemented',
    ],
  };
  return { ...payload, planDigest: hash(payload) };
}
function checkedPlan(plan) {
  const { planDigest, ...payload } = plan ?? {};
  valid(
    HASH.test(planDigest) &&
      hash(payload) === planDigest &&
      plan.schema === 'baink-paperclip/bootstrap-plan/v1',
    'invalid_plan',
  );
  const recreated = buildBootstrapPlan({
    schema: 'uain-project-incubator/paperclip-request-plan/v1',
    company_id: plan.companyId,
    source_sha256: plan.sourceSha256,
    candidate_requests: [plan.request],
  });
  valid(canonical(recreated) === canonical(plan), 'invalid_plan');
  return plan;
}
export function resumeBootstrap(plan, receipt) {
  checkedPlan(plan);
  if (!receipt)
    return { action: 'await_operator_qualification', writesAllowed: false };
  valid(
    object(receipt) && receipt.planDigest === plan.planDigest,
    'receipt_conflict',
  );
  if (receipt.state === 'send_uncertain')
    return {
      action: 'recover_exact_project_receipt',
      writesAllowed: false,
      method: 'POST',
      path: plan.request.path,
      headers: { 'X-Paperclip-Receipt-Only': 'true' },
      body: structuredClone(plan.request.body),
    };
  valid(
    receipt.state === 'recorded' && UUID.test(receipt.projectId),
    'receipt_conflict',
  );
  return {
    action: 'qualify_read_access',
    writesAllowed: false,
    projectId: receipt.projectId,
    nativeAuthority: 'unverified',
  };
}
async function boundedJson(file) {
  const h = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await h.stat();
    valid(st.isFile() && st.size <= MAX_BYTES, 'invalid_file');
    return JSON.parse(await h.readFile('utf8'));
  } finally {
    await h.close();
  }
}
export async function persistBootstrapPlan(directory, plan) {
  checkedPlan(plan);
  const dir = resolve(directory);
  await mkdir(dir, { mode: 0o700, recursive: true });
  const st = await lstat(dir);
  valid(
    st.isDirectory() &&
      !st.isSymbolicLink() &&
      (st.mode & 0o077) === 0 &&
      st.uid === process.getuid(),
    'unsafe_plan_directory',
  );
  const path = join(dir, `${plan.companyId}-${plan.sourceId}.json`),
    temp = join(dir, `.plan-${randomUUID()}`);
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(plan, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    try {
      await link(temp, path);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const existing = await boundedJson(path);
      const existingStat = await lstat(path);
      valid(
        existingStat.uid === process.getuid() &&
          (existingStat.mode & 0o077) === 0 &&
          canonical(existing) === canonical(plan),
        'plan_conflict',
      );
    }
    const d = await open(dir, 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
    return { path, planDigest: plan.planDigest, writesAllowed: false };
  } finally {
    await unlink(temp).catch(() => {});
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [command, input, extra, equivalence] = process.argv.slice(2);
    const m = await boundedJson(
      new URL('./runtime-manifest.json', import.meta.url),
    );
    let result;
    if (command === 'preflight')
      result = preflight({
        manifest: m,
        resources: await boundedJson(input),
        imageReceipt: extra ? await boundedJson(extra) : undefined,
        imageEquivalence: equivalence
          ? await boundedJson(equivalence)
          : undefined,
      });
    else if (command === 'compose')
      result = renderCompose(m, await boundedJson(input));
    else if (command === 'plan')
      result = buildBootstrapPlan(await boundedJson(input));
    else if (command === 'persist')
      result = await persistBootstrapPlan(
        extra,
        buildBootstrapPlan(await boundedJson(input)),
      );
    else throw new PilotError('invalid_command');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (command === 'preflight' && !result.ready) process.exitCode = 2;
  } catch (e) {
    process.stderr.write(
      JSON.stringify({
        error: e instanceof PilotError ? e.code : 'pilot_preparation_failed',
      }) + '\n',
    );
    process.exitCode = 1;
  }
}

import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  validateManifest,
  renderCompose,
  preflight,
  buildBootstrapPlan,
  persistBootstrapPlan,
  resumeBootstrap,
  PilotError,
} from './pilot.mjs';

const manifest = () =>
  JSON.parse(readFileSync(new URL('./runtime-manifest.json', import.meta.url)));
const revision = 'dce383c733bb1ca31cd34d7dbb82bda597ad7418';
const company = '10000000-0000-4000-8000-000000000001';
const project = '20000000-0000-4000-8000-000000000002';
const digest = 'a'.repeat(64);
const image = 'ghcr.io/example/paperclip@sha256:' + 'b'.repeat(64);
const receipt = () => ({
  schema: 'baink-paperclip/image-receipt/v1',
  sourceRevision: revision,
  target: 'production',
  platform: 'linux/amd64',
  image,
  inspectedRepoDigests: [image],
  inspectedRevision: revision,
  productionTargetVerified: true,
});
const resources = () => ({
  capturedAt: '2026-10-31T18:00:00Z',
  availableMemoryMiB: 6144,
  swapTotalMiB: 8192,
  swapUsedMiB: 1024,
  dataFreeMiB: 30000,
  rootFreeMiB: 16000,
  listeningPorts: [],
  dataDirectoryState: 'absent',
});
const now = () => Date.parse('2026-10-31T18:00:30Z');
function imported() {
  const source = {
    stable_id: 'OPP-00001',
    title: 'Review an unsolved target',
    url: '/PR/OPP-00001-review-an-unsolved-target',
    status: 'proposed',
    progress: { status: 'unknown', percent_complete: null },
    source_fields: {
      ID: 'OPP-00001',
      List: 'Opportunity',
      'Domain #': 1,
      Domain: 'Health',
      'Sub-domain #': '1.1',
      'Sub-domain': 'Research',
      Item: 'Review an unsolved target',
      'Ambitious KPI (readable)': 'Verified result',
      'KPI number': 1,
      'KPI unit / what is counted': 'result',
    },
    provenance: { source_sha256: digest, sheet: 'All items', row: 2 },
    kpi_interpretation: 'proposed_target_unverified',
    uain_admission: 'not_evaluated',
  };
  return {
    schema: 'uain-project-incubator/paperclip-request-plan/v1',
    company_id: company,
    source_sha256: digest,
    candidate_requests: [
      {
        method: 'POST',
        path: `/api/companies/${company}/projects`,
        body: {
          name: '[OPP-00001] Review an unsolved target',
          description: JSON.stringify(source),
          status: 'backlog',
          visibility: 'private',
          idempotencyKey: 'uain-incubator-project-v1:OPP-00001',
        },
      },
    ],
  };
}
const rejects = (fn, code) =>
  assert.throws(fn, (e) => e instanceof PilotError && e.code === code);

test('manifest honestly has no deployable image; production receipt admits only exact immutable artifact', () => {
  const m = validateManifest(manifest());
  assert.equal(m.image, null);
  assert.equal(m.imageStatus, 'build_required');
  rejects(() => renderCompose(m), 'image_unqualified');
  const c = renderCompose(m, receipt());
  const s = c.services.paperclip;
  assert.equal(s.image, image);
  assert.equal(s.ports, undefined);
  assert.deepEqual(s.expose, ['3101']);
  assert.equal(s.container_name, 'baink-paperclip-pilot');
  assert.equal(s.environment.PORT, '3101');
  assert.equal(
    s.environment.PAPERCLIP_AUTH_PUBLIC_BASE_URL,
    'http://127.0.0.1:3101',
  );
  assert.equal(s.environment.HEARTBEAT_SCHEDULER_ENABLED, 'false');
  assert.equal(c['x-baink-loopback-relay'].automaticExecution, false);
  assert.equal(c['x-baink-loopback-relay'].requiresInspectedRelayPlan, true);
  assert.equal(s.mem_limit, '2048m');
  assert.equal(s.memswap_limit, '2048m');
  assert.equal(s.cpus, 1);
  assert.equal(s.environment.PAPERCLIP_DEPLOYMENT_MODE, 'authenticated');
  assert.equal(s.environment.PAPERCLIP_DEPLOYMENT_EXPOSURE, 'private');
  assert.equal(s.environment.OPENAI_API_KEY, undefined);
  assert.equal(s.build, undefined);
  assert.equal(s.volumes.length, 1);
  assert.ok(!JSON.stringify(c).includes('docker.sock'));
  for (const change of [
    { image: 'ghcr.io/example/paperclip:latest' },
    { target: 'cloud' },
    { inspectedRevision: 'c'.repeat(40) },
    { inspectedRepoDigests: [] },
    { productionTargetVerified: false },
    { platform: 'linux/arm64' },
  ])
    rejects(
      () => renderCompose(m, { ...receipt(), ...change }),
      'image_unqualified',
    );
  rejects(
    () => validateManifest({ ...m, origin: 'http://0.0.0.0:3101' }),
    'invalid_manifest',
  );
});

test('preflight fails closed on stale evidence, full swap, memory/disk pressure and occupied port', () => {
  assert.equal(
    preflight({
      manifest: manifest(),
      resources: resources(),
      imageReceipt: receipt(),
      now,
    }).ready,
    true,
  );
  assert.equal(
    preflight({ manifest: manifest(), resources: resources(), now }).ready,
    false,
  );
  for (const patch of [
    { capturedAt: '2026-10-31T17:00:00Z' },
    { capturedAt: '2026-10-31T19:00:00Z' },
    { swapUsedMiB: 8192 },
    { availableMemoryMiB: 3000 },
    { dataFreeMiB: 100 },
    { rootFreeMiB: 100 },
    { listeningPorts: [3101] },
    { availableMemoryMiB: NaN },
  ]) {
    const out = preflight({
      manifest: manifest(),
      resources: { ...resources(), ...patch },
      imageReceipt: receipt(),
      now,
    });
    assert.equal(out.ready, false, JSON.stringify(patch));
  }
});

test('capacity reserves runtime2GiB plus relay64MiB plus3GiB spare rather than hiding relay overhead', () => {
  assert.equal(
    preflight({
      manifest: manifest(),
      resources: { ...resources(), availableMemoryMiB: 5120 },
      imageReceipt: receipt(),
      now,
    }).ready,
    false,
  );
  assert.equal(
    preflight({
      manifest: manifest(),
      resources: { ...resources(), availableMemoryMiB: 5184 },
      imageReceipt: receipt(),
      now,
    }).ready,
    true,
  );
});

test('local loaded production image requires exact inspected ID, saved archive hash and build stamp', () => {
  const local = {
    ...receipt(),
    image: 'sha256:' + 'e'.repeat(64),
    inspectedImageId: 'sha256:' + 'e'.repeat(64),
    archiveSha256: 'd'.repeat(64),
    buildStamp: 'baink-paperclip-20261031',
  };
  assert.equal(
    renderCompose(manifest(), local).services.paperclip.image,
    local.image,
  );
  for (const patch of [
    { inspectedImageId: 'sha256:' + 'f'.repeat(64) },
    { archiveSha256: null },
    { buildStamp: '' },
    { image: 'baink-paperclip-pilot:latest' },
  ])
    rejects(
      () => renderCompose(manifest(), { ...local, ...patch }),
      'image_unqualified',
    );
});

test('full cold swap requires fresh low-pressure paging/OOM and measured same-image pilot evidence', () => {
  const measured = {
    ...resources(),
    swapUsedMiB: 8192,
    coldSwapQualification: {
      sampleSeconds: 60,
      psiSomeAvg10Percent: 0.1,
      psiSomeAvg60Percent: 0.1,
      psiFullAvg10Percent: 0,
      psiFullAvg60Percent: 0,
      swapInPages: 0,
      swapOutPages: 0,
      oomKillDelta: 0,
      pilotPeakMemoryMiB: 512,
      pilotObservationSeconds: 60,
      pilotImage: image,
    },
  };
  assert.equal(
    preflight({
      manifest: manifest(),
      resources: measured,
      imageReceipt: receipt(),
      now,
    }).ready,
    true,
  );
  for (const patch of [
    { sampleSeconds: 1 },
    { psiSomeAvg60Percent: 2 },
    { psiFullAvg10Percent: 1 },
    { swapInPages: 1 },
    { swapOutPages: 1 },
    { oomKillDelta: 1 },
    { pilotPeakMemoryMiB: null },
    { pilotPeakMemoryMiB: 2049 },
    { pilotObservationSeconds: 1 },
    { pilotImage: 'mutable:latest' },
  ])
    assert.equal(
      preflight({
        manifest: manifest(),
        resources: {
          ...measured,
          coldSwapQualification: {
            ...measured.coldSwapQualification,
            ...patch,
          },
        },
        imageReceipt: receipt(),
        now,
      }).ready,
      false,
    );
  assert.equal(
    preflight({
      manifest: manifest(),
      resources: { ...measured, availableMemoryMiB: 5000 },
      imageReceipt: receipt(),
      now,
    }).ready,
    false,
  );
  assert.equal(
    preflight({
      manifest: manifest(),
      resources: { ...measured, capturedAt: '2026-10-31T17:00:00Z' },
      imageReceipt: receipt(),
      now,
    }).coldSwapEvidenceAccepted,
    false,
  );
});

test('single private project plan preserves incubator provenance without admitting or launching it', () => {
  const input = imported();
  const p = buildBootstrapPlan(input);
  assert.equal(p.networkWrites, 0);
  assert.equal(p.executionEnabled, false);
  assert.equal(p.nativeMapping, null);
  assert.deepEqual(p.request, input.candidate_requests[0]);
  assert.equal(p.sourceSha256, digest);
  assert.equal(p.ownerAuthority, 'unverified');
  assert.equal(p.sourceContractRevision, revision);
  assert.equal(resumeBootstrap(p, null).action, 'await_operator_qualification');
  assert.equal(
    resumeBootstrap(p, { planDigest: p.planDigest, state: 'send_uncertain' })
      .action,
    'recover_exact_project_receipt',
  );
  assert.equal(
    resumeBootstrap(p, {
      planDigest: p.planDigest,
      state: 'recorded',
      projectId: project,
    }).action,
    'qualify_read_access',
  );
  rejects(
    () =>
      resumeBootstrap(p, {
        planDigest: 'c'.repeat(64),
        state: 'send_uncertain',
      }),
    'receipt_conflict',
  );
  rejects(
    () =>
      buildBootstrapPlan({
        ...input,
        candidate_requests: [
          ...input.candidate_requests,
          input.candidate_requests[0],
        ],
      }),
    'invalid_plan',
  );
});

test('plan refuses execution fields, source substitution, malformed provenance and changed idempotency keys', () => {
  for (const mutate of [
    (p) => (p.candidate_requests[0].body.env = { SECRET: 'not-accepted' }),
    (p) => (p.candidate_requests[0].body.visibility = 'open'),
    (p) => (p.candidate_requests[0].body.status = 'active'),
    (p) =>
      (p.candidate_requests[0].path = `/api/companies/${project}/projects`),
    (p) => (p.candidate_requests[0].body.idempotencyKey += '-changed'),
    (p) => (p.candidate_requests[0].body.name = 'Forged target'),
    (p) => {
      const d = JSON.parse(p.candidate_requests[0].body.description);
      d.provenance.source_sha256 = 'b'.repeat(64);
      p.candidate_requests[0].body.description = JSON.stringify(d);
    },
    (p) => {
      const d = JSON.parse(p.candidate_requests[0].body.description);
      d.source_fields.extra = 'secret';
      p.candidate_requests[0].body.description = JSON.stringify(d);
    },
    (p) => {
      const d = JSON.parse(p.candidate_requests[0].body.description);
      d.apiKey = 'secret';
      p.candidate_requests[0].body.description = JSON.stringify(d);
    },
  ]) {
    const p = imported();
    mutate(p);
    rejects(() => buildBootstrapPlan(p), 'invalid_plan');
  }
});

test('persisted exact plan survives restart and concurrent retry, conflicts never overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baink-paperclip-'));
  try {
    const p = buildBootstrapPlan(imported());
    const out = await Promise.all([
      persistBootstrapPlan(dir, p),
      persistBootstrapPlan(dir, p),
    ]);
    assert.equal(out[0].path, out[1].path);
    assert.equal((await stat(out[0].path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(out[0].path, 'utf8')), p);
    const altered = imported();
    const source = JSON.parse(altered.candidate_requests[0].body.description);
    source.title += ' changed';
    source.source_fields.Item = source.title;
    altered.candidate_requests[0].body.description = JSON.stringify(source);
    altered.candidate_requests[0].body.name += ' changed';
    await assert.rejects(
      persistBootstrapPlan(dir, buildBootstrapPlan(altered)),
      (e) => e.code === 'plan_conflict',
    );
    assert.deepEqual(JSON.parse(await readFile(out[0].path, 'utf8')), p);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('measured source image can qualify a different loaded ID only with explicit same-archive content equivalence', () => {
  const source = 'sha256:' + '1'.repeat(64),
    target = 'sha256:' + '2'.repeat(64),
    layers = ['sha256:' + '3'.repeat(64)];
  const rootSha = createHash('sha256')
    .update(JSON.stringify({ Layers: layers, Type: 'layers' }))
    .digest('hex');
  const artifact = {
    ...receipt(),
    image: target,
    inspectedImageId: target,
    archiveSha256: '4'.repeat(64),
    buildStamp: 'commit:' + revision,
  };
  const snapshot = (id) => ({
    imageId: id,
    os: 'linux',
    architecture: 'amd64',
    configSha256: '5'.repeat(64),
    rootFsSha256: rootSha,
    rootFsLayerCount: 1,
    rootFsLayerDigests: layers,
  });
  const equivalent = {
    schema: 'baink-paperclip/loaded-image-equivalence/v1',
    sourceRevision: revision,
    archiveSha256: artifact.archiveSha256,
    sourceImageId: source,
    targetImageId: target,
    platformMatches: true,
    configurationMatches: true,
    rootFsMatches: true,
    inspections: { source: snapshot(source), target: snapshot(target) },
  };
  const evidence = {
    ...resources(),
    swapUsedMiB: 8192,
    coldSwapQualification: {
      sampleSeconds: 60,
      psiSomeAvg10Percent: 0,
      psiSomeAvg60Percent: 0,
      psiFullAvg10Percent: 0,
      psiFullAvg60Percent: 0,
      swapInPages: 0,
      swapOutPages: 0,
      oomKillDelta: 0,
      pilotPeakMemoryMiB: 908,
      pilotObservationSeconds: 62,
      pilotImage: source,
    },
  };
  const run = (imageEquivalence) =>
    preflight({
      manifest: manifest(),
      imageReceipt: artifact,
      resources: evidence,
      imageEquivalence,
      now,
    });
  assert.equal(run().ready, false);
  const admitted = run(equivalent);
  assert.equal(admitted.ready, true);
  assert.equal(admitted.pilotImageEquivalenceAccepted, true);
  assert.equal(admitted.measuredPilotImage, source);
  assert.equal(evidence.coldSwapQualification.pilotImage, source);
  for (const mutate of [
    (r) => (r.archiveSha256 = '6'.repeat(64)),
    (r) => (r.sourceRevision = '7'.repeat(40)),
    (r) => (r.sourceImageId = target),
    (r) => (r.targetImageId = source),
    (r) => (r.inspections.target.configSha256 = '6'.repeat(64)),
    (r) => (r.inspections.target.rootFsSha256 = '6'.repeat(64)),
    (r) =>
      (r.inspections.target.rootFsLayerDigests = ['sha256:' + '6'.repeat(64)]),
    (r) => (r.inspections.target.architecture = 'arm64'),
    (r) => (r.inspections.target.imageId = source),
    (r) => (r.platformMatches = false),
  ]) {
    const changed = structuredClone(equivalent);
    mutate(changed);
    assert.equal(run(changed).ready, false);
  }
  const registry = structuredClone(equivalent);
  artifact.image = image;
  registry.targetImageId = image;
  registry.inspections.target.imageId = image;
  assert.equal(
    run(registry).ready,
    false,
    'loaded image IDs cannot be replaced by registry references',
  );
});

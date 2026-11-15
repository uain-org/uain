/** Pure staged-rollout planner for the 120 project organizations (Task 9, offline part).
 *
 * planStage() reads nothing, writes nothing and contacts nothing. It decides whether a
 * stage of 1, 5, 20 or 120 total organizations may be attempted, and lists every reason
 * it may not. Stage membership is always the first N IDs of the frozen selection order:
 * held projects stay in their place as held, and no substitute is ever chosen.
 *
 * Inputs (all required; a missing input refuses rather than defaulting to "ok"):
 * - selectionDigest: the reviewed digest of selection.json (digest() of the parsed manifest).
 * - manifest: the immutable reviewed release manifest
 *   {schema, selectionDigest, selection, files:[{path, sha256}], pins:{key:value}, hosts:[name],
 *    preflight:{stages:{"1":{minimumAvailableMemoryMiB, minimumFreeDiskMiB}, ...}}, digest}
 *   where digest = digest() of every other field.
 * - reviewedManifestDigest: the manifest digest recorded at review.
 * - observedFiles: {path: sha256} measured on the target host's source closure.
 * - stage: 1 | 5 | 20 | 120.
 * - priorReport: the operational-readiness report of the previous stage (null for stage 1).
 * - host: {memMb, diskMb} measured available memory and free disk.
 * - backupAgeHours: age of the latest verified backup (journals, keys, native state).
 * - computeStatus: {state:'available'|'daily_exhausted'|'total_exhausted'|...}.
 * - pins: {hostName: {key: value}} observed pins on every manifest host.
 * - journal: {unresolved: [{id, projectId, operation, state}]} unknown/in-flight writes.
 */
import { HASH, digest, plain } from '../src/common.mjs';
import { validateSelection } from '../src/selection.mjs';

export const RELEASE_SCHEMA = 'uain-project-organization-release-v1';
export const ROLLOUT_STAGES = Object.freeze([1, 5, 20, 120]);
export const MAX_BACKUP_AGE_HOURS = 24;
const OPERATIONAL_SCHEMA = 'uain-project-organization-operational-readiness-v1';

/** The digest a reviewed manifest must carry over its own content. */
export const manifestDigest = (manifest) => {
  const { digest: _ignored, ...body } = manifest;
  return digest(body);
};

export function planStage(input = {}) {
  const refusals = [];
  const refuse = (code, detail = null) => refusals.push(Object.freeze({ code, detail }));
  const { selectionDigest, manifest, reviewedManifestDigest, observedFiles, stage, priorReport = null, host, backupAgeHours, computeStatus, pins, journal } = input;

  // Stage.
  const index = ROLLOUT_STAGES.indexOf(stage);
  if (index < 0) refuse('invalid_stage', String(stage));

  // Selection drift: the manifest's selection, its declared digest and the reviewed digest agree.
  let selection = null;
  if (typeof selectionDigest !== 'string' || !HASH.test(selectionDigest)) refuse('selection_digest_missing');
  if (!plain(manifest)) refuse('release_manifest_missing');
  else {
    try {
      selection = validateSelection(manifest.selection);
    } catch (e) {
      refuse('selection_invalid', e.code ?? 'invalid_selection');
    }
    if (selection && selection.digest !== selectionDigest) refuse('selection_drift', 'manifest selection differs from the reviewed selection');
    if (manifest.selectionDigest !== selectionDigest) refuse('selection_drift', 'manifest declares a different selection digest');
  }

  // Source manifest tampering.
  if (plain(manifest)) {
    if (manifest.schema !== RELEASE_SCHEMA) refuse('release_manifest_invalid', 'schema');
    let computed = null;
    try {
      computed = manifestDigest(manifest);
    } catch {
      refuse('release_manifest_invalid', 'non-canonical content');
    }
    if (computed !== null && manifest.digest !== computed) refuse('source_manifest_tampered', 'manifest digest does not match its content');
    if (typeof reviewedManifestDigest !== 'string' || !HASH.test(reviewedManifestDigest)) refuse('reviewed_manifest_digest_missing');
    else if (computed !== null && computed !== reviewedManifestDigest) refuse('source_manifest_tampered', 'manifest is not the reviewed manifest');
    const files = Array.isArray(manifest.files) ? manifest.files : null;
    if (!files || !files.length || files.some((f) => !plain(f) || typeof f.path !== 'string' || !HASH.test(f.sha256 ?? '')) || new Set(files.map((f) => f.path)).size !== files.length)
      refuse('release_manifest_invalid', 'files');
    else if (!plain(observedFiles)) refuse('source_observation_missing');
    else {
      const expected = new Map(files.map((f) => [f.path, f.sha256]));
      const wrong = files.filter((f) => observedFiles[f.path] !== f.sha256).map((f) => f.path);
      const extra = Object.keys(observedFiles).filter((p) => !expected.has(p));
      if (wrong.length) refuse('source_sha_mismatch', wrong.sort().join(','));
      if (extra.length) refuse('source_unreviewed_files', extra.sort().join(','));
    }
  }

  // Host capacity from the reviewed manifest's preflight, never from defaults.
  const need = plain(manifest?.preflight?.stages) ? manifest.preflight.stages[String(stage)] : undefined;
  if (!plain(need) || !Number.isFinite(need.minimumAvailableMemoryMiB) || !Number.isFinite(need.minimumFreeDiskMiB)) refuse('capacity_requirements_unpinned');
  else if (!plain(host) || !Number.isFinite(host.memMb) || !Number.isFinite(host.diskMb)) refuse('host_capacity_unknown');
  else {
    if (host.memMb < need.minimumAvailableMemoryMiB) refuse('insufficient_memory', `${host.memMb} < ${need.minimumAvailableMemoryMiB} MiB`);
    if (host.diskMb < need.minimumFreeDiskMiB) refuse('insufficient_disk', `${host.diskMb} < ${need.minimumFreeDiskMiB} MiB`);
  }

  // Compute budget (existing provider caps; no purchase or cap increase is ever planned).
  const compute = plain(computeStatus) ? computeStatus.state : undefined;
  if (compute === 'daily_exhausted') refuse('compute_daily_exhausted');
  else if (compute === 'total_exhausted') refuse('compute_exhausted');
  else if (compute !== 'available') refuse('compute_status_unknown', compute === undefined ? null : String(compute));

  // Cross-host pins: every manifest host reports exactly the reviewed pins.
  const hosts = Array.isArray(manifest?.hosts) ? manifest.hosts : null;
  if (!hosts || !hosts.length || !plain(manifest?.pins) || !Object.keys(manifest.pins).length) refuse('release_manifest_invalid', 'pins');
  else if (!plain(pins)) refuse('host_pins_missing', hosts.join(','));
  else
    for (const name of hosts) {
      const observed = pins[name];
      if (!plain(observed)) {
        refuse('host_pins_missing', name);
        continue;
      }
      const keys = new Set([...Object.keys(manifest.pins), ...Object.keys(observed)]);
      const bad = [...keys].filter((k) => observed[k] !== manifest.pins[k]).sort();
      if (bad.length) refuse('cross_host_pin_mismatch', `${name}:${bad.join(',')}`);
    }

  // Backup freshness.
  if (typeof backupAgeHours !== 'number' || !Number.isFinite(backupAgeHours) || backupAgeHours < 0) refuse('backup_age_unknown');
  else if (backupAgeHours > MAX_BACKUP_AGE_HOURS) refuse('stale_backup', `${backupAgeHours}h > ${MAX_BACKUP_AGE_HOURS}h`);

  // Unknown journal writes must be reconciled before anything new is attempted.
  if (!plain(journal) || !Array.isArray(journal.unresolved)) refuse('journal_status_unavailable');
  else if (journal.unresolved.length) refuse('unknown_journal_writes', journal.unresolved.map((i) => i?.id ?? '?').slice(0, 20).join(','));

  // Prior stage: every member passed operational readiness or is explicitly held.
  const projects = selection && index >= 0 ? selection.ids.slice(0, stage) : [];
  if (selection && index > 0) {
    const prior = ROLLOUT_STAGES[index - 1];
    if (!plain(priorReport) || priorReport.schema !== OPERATIONAL_SCHEMA || !Array.isArray(priorReport.projects) || priorReport.projects.length !== 120)
      refuse('prior_stage_report_missing', `stage ${prior}`);
    else if (priorReport.selectionDigest !== selection.digest) refuse('selection_drift', 'prior report belongs to a different selection');
    else if (priorReport.projects.some((r, i) => r?.projectId !== selection.ids[i])) refuse('selection_drift', 'prior report order differs from the frozen selection');
    else {
      const members = priorReport.projects.slice(0, prior);
      const failed = members.filter((r) => r.status !== 'pass' && r.status !== 'held').map((r) => r.projectId);
      if (failed.length) refuse('prior_stage_failed', failed.join(','));
      else if (!members.some((r) => r.status === 'pass')) refuse('prior_stage_failed', 'no project passed');
    }
  }

  const held = selection ? selection.projects.slice(0, projects.length).filter((p) => p.holds.length).map((p) => ({ projectId: p.id, holds: [...p.holds] })) : [];
  const previous = index > 0 ? ROLLOUT_STAGES[index - 1] : 0;
  return Object.freeze({
    allowed: refusals.length === 0,
    stage: index >= 0 ? stage : null,
    projects: Object.freeze(projects),
    newProjects: Object.freeze(projects.slice(previous)),
    held: Object.freeze(held),
    refusals: Object.freeze(refusals),
    productionChange: false,
  });
}

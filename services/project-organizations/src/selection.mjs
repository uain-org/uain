/** Frozen scope: exactly the 120 source-pinned projects observed on 5 November 2026.
 * Drift is refused, never repaired by substituting the next active project. */
import { readFile } from 'node:fs/promises';
import { CATALOGUE_ID, HASH, exactKeys, need, nativeProjectId, sha256, text, digest } from './common.mjs';

export const SELECTION_SCHEMA = 'uain-project-organization-selection-v1';
export const SELECTION_COUNT = 120;
export const SELECTION_PATH = new URL('../../../docs/baink/project-organizations-2026-11-06/selection.json', import.meta.url);
export const AMENDMENTS_PATH = new URL('../../../docs/baink/project-organizations-2026-11-06/kpi-amendments.json', import.meta.url);
export const AMENDMENTS_SCHEMA = 'uain-project-organization-kpi-amendments-v1';
/** Native `central_fund_plan` refuses a Main KPI under 20 bytes. Such a project is
 * held with this reason; its source wording is never padded or rewritten. */
export const NATIVE_MAIN_KPI_MIN_BYTES = 20;
/** Only objects built by validateSelection are genuine; a look-alike frozen object is not. */
const GENUINE = new WeakSet();
export const isFrozenSelection = (value) => GENUINE.has(value);

/** Same bytes BAINK project management digests (fixed field order, not canonical). */
export function sourceDigestOf(row, revision) {
  need(row && typeof row === 'object' && /^[a-f0-9]{40}$/.test(revision ?? ''), 'invalid_source_record');
  return sha256(JSON.stringify({
    id: row.id, title: row.title, description: row.description, category: row.category, kpi: row.kpi, revision,
  }));
}

function kpiOf(kpi) {
  need(exactKeys(kpi, ['statement', 'threshold', 'unit', 'comparator', 'qualification']), 'invalid_selection_kpi');
  need(text(kpi.statement, 1, 4096) && kpi.statement === kpi.statement.trim(), 'invalid_selection_kpi');
  need(kpi.threshold === null || Number.isSafeInteger(kpi.threshold), 'invalid_selection_kpi');
  need(kpi.unit === null || text(kpi.unit, 1, 400), 'invalid_selection_kpi');
  need(kpi.comparator === null || text(kpi.comparator, 1, 16), 'invalid_selection_kpi');
  need(text(kpi.qualification, 1, 1200), 'invalid_selection_kpi');
  return Object.freeze({ ...kpi });
}

/** Recorded Main KPI wording decisions. An amendment may only restate the source KPI for
 * native use: it must contain the source statement verbatim, keep its threshold and unit,
 * and name who decided it and when. The source KPI itself stays pinned and drift-checked. */
function amendmentsOf(file, byId) {
  if (file === null) return new Map();
  need(exactKeys(file, ['schema', 'amendments']) && file.schema === AMENDMENTS_SCHEMA && Array.isArray(file.amendments) &&
    file.amendments.length <= 120, 'invalid_kpi_amendments');
  const out = new Map();
  for (const a of file.amendments) {
    need(exactKeys(a, ['id', 'sourceStatement', 'statement', 'threshold', 'unit', 'reason', 'decidedBy', 'decidedAt']), 'invalid_kpi_amendment');
    const p = byId.get(a.id);
    need(p && !out.has(a.id), 'invalid_kpi_amendment', `amendment for unselected or duplicate ${a.id}`);
    need(a.sourceStatement === p.kpi.statement && a.threshold === p.kpi.threshold && a.unit === p.kpi.unit,
      'kpi_amendment_source_mismatch', `${a.id} amendment does not match its pinned source KPI`);
    need(text(a.statement, NATIVE_MAIN_KPI_MIN_BYTES, 4096) && a.statement === a.statement.trim() &&
      Buffer.byteLength(a.statement) >= NATIVE_MAIN_KPI_MIN_BYTES && a.statement.includes(a.sourceStatement) &&
      a.statement !== a.sourceStatement, 'invalid_kpi_amendment', `${a.id} amendment must keep the source wording verbatim`);
    need(text(a.reason, 20, 2000) && text(a.decidedBy, 1, 120) && /^\d{4}-\d{2}-\d{2}$/.test(a.decidedAt), 'invalid_kpi_amendment');
    out.set(a.id, Object.freeze({ ...a }));
  }
  return out;
}

/**
 * @param manifest parsed selection.json
 * @param current optional `{revision, records: Map|Iterable<row>}` from the live catalogue;
 *   when given, every selected record must exist and reproduce its pinned digest and KPI.
 */
export function validateSelection(manifest, current = null, { amendments = null } = {}) {
  need(exactKeys(manifest, ['schema', 'observedAt', 'count', 'selection', 'authority', 'projects']), 'invalid_selection');
  need(manifest.schema === SELECTION_SCHEMA && manifest.count === SELECTION_COUNT, 'invalid_selection');
  need(Array.isArray(manifest.projects) && manifest.projects.length === SELECTION_COUNT, 'selection_count_drift');
  need(!Number.isNaN(Date.parse(manifest.observedAt)), 'invalid_selection');
  const seen = new Set();
  const projects = manifest.projects.map((p) => {
    need(exactKeys(p, ['id', 'sourceDigest', 'kpi', 'modelPlanDigest']), 'invalid_selection_project');
    need(CATALOGUE_ID.test(p.id) && HASH.test(p.sourceDigest) && HASH.test(p.modelPlanDigest), 'invalid_selection_project');
    need(!seen.has(p.id), 'duplicate_selection_project');
    seen.add(p.id);
    return { id: p.id, sourceDigest: p.sourceDigest, modelPlanDigest: p.modelPlanDigest, kpi: kpiOf(p.kpi) };
  });
  const amended = amendmentsOf(amendments, new Map(projects.map((p) => [p.id, p])));
  for (const [i, p] of projects.entries()) {
    const amendment = amended.get(p.id) ?? null;
    // The Main KPI text native plans, goals and reports use: the source statement, or
    // its recorded amendment. Comparisons against source drift use `kpi` only.
    const mainKpi = amendment ? amendment.statement : p.kpi.statement;
    const holds = Buffer.byteLength(mainKpi) < NATIVE_MAIN_KPI_MIN_BYTES ? ['main_kpi_below_native_minimum'] : [];
    projects[i] = Object.freeze({
      id: p.id, nativeProjectId: nativeProjectId(p.id), sourceDigest: p.sourceDigest, modelPlanDigest: p.modelPlanDigest,
      kpi: p.kpi, mainKpi, kpiAmendment: amendment, holds: Object.freeze(holds),
    });
  }
  if (current !== null) {
    const records = current.records instanceof Map ? current.records : new Map([...current.records].map((r) => [r.id, r]));
    for (const p of projects) {
      const row = records.get(p.id);
      need(row, 'selected_source_missing', `selected source ${p.id} is missing`);
      need(sourceDigestOf(row, current.revision) === p.sourceDigest, 'selected_source_changed', `selected source ${p.id} changed`);
      need(digest(row.kpi) === digest(p.kpi), 'selected_main_kpi_changed', `selected Main KPI ${p.id} changed`);
    }
  }
  const byId = new Map(projects.map((p) => [p.id, p]));
  const byNative = new Map(projects.map((p) => [p.nativeProjectId, p]));
  const frozen = Object.freeze({
    schema: SELECTION_SCHEMA,
    // Without amendments this is the manifest digest; recorded amendments are bound in.
    digest: amended.size ? digest({ selection: digest(manifest), amendments }) : digest(manifest),
    amendmentsDigest: amended.size ? digest(amendments) : null,
    observedAt: manifest.observedAt,
    projects: Object.freeze(projects),
    ids: Object.freeze(projects.map((p) => p.id)),
    has: (id) => byId.has(id),
    get(id) {
      const p = byId.get(id) ?? byNative.get(id);
      need(p, 'project_not_selected', `${id} is not in the frozen selection`);
      return p;
    },
  });
  GENUINE.add(frozen);
  return frozen;
}

export async function loadSelection({ path = SELECTION_PATH, current = null, amendmentsPath = AMENDMENTS_PATH } = {}) {
  const raw = await readFile(path);
  need(raw.length <= 2 * 1024 * 1024, 'invalid_selection');
  let amendments = null;
  if (amendmentsPath !== null) {
    const a = await readFile(amendmentsPath);
    need(a.length <= 256 * 1024, 'invalid_kpi_amendments');
    amendments = JSON.parse(a);
  }
  return validateSelection(JSON.parse(raw), current, { amendments });
}

/** Reads the live BAINK catalogue into the `current` shape validateSelection expects. */
export function catalogueRecords(catalogue) {
  need(catalogue?.available, 'catalogue_unavailable');
  const first = catalogue.list({ page: 1, pageSize: 100 });
  const records = new Map();
  for (let page = 1; page <= Math.ceil(first.total / 100); page++)
    for (const row of (page === 1 ? first : catalogue.list({ page, pageSize: 100 })).projects) records.set(row.id, row);
  return { revision: first.source.revision, records };
}

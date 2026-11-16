/** FIXTURE prior-art survey artifacts for tests. Not a research result. */
import { readFileSync } from 'node:fs';
import { canonical, sha256 } from '../../src/common.mjs';
import { ARTIFACT_SCHEMA } from '../../src/verification.mjs';

const DOCS = new URL('../../../../docs/baink/project-organizations-2026-11-06/', import.meta.url);
export const draftOf = (id) => JSON.parse(readFileSync(new URL(`bootstrap-drafts/${id}.json`, DOCS)));
export const reviewedOf = (id) => JSON.parse(readFileSync(new URL(`bootstrap-reviewed/${id}.json`, DOCS)));

/** Eight included items of two kinds (fictional identifiers in valid form), plus every required id screened out. */
export function fixtureSurvey(policy, { meetsMainKpi = false, included } = {}) {
  const test = policy.successTests[0];
  const items = (included ?? Array.from({ length: 8 }, (_, i) => ({
    kind: i % 2 ? 'nct' : 'wikidata', id: i % 2 ? `NCT0000000${i}` : `Q${1000 + i}`, title: `FIXTURE record ${i}`,
    relation: meetsMainKpi && i === 0 ? 'meets_main_kpi' : 'partial', note: 'FIXTURE note: not a research result.',
  }))).slice();
  for (const r of test.requiredIds) items.push({ kind: r.kind, id: r.id, title: `FIXTURE screened ${r.id}`, relation: 'screened_out', note: 'FIXTURE: screened out as unrelated.' });
  return {
    mainKpi: test.mainKpi, asOf: '2026-11-06', items,
    conclusion: { meetsMainKpi, gaps: meetsMainKpi ? [] : ['FIXTURE gap: no existing work meets the Main KPI as written.'] },
  };
}

/** The evidence artifact a solver would submit, and its canonical bytes (native inline evidence). */
export function surveyArtifact({ taskId, submissionId = 'S-survey', author, survey }) {
  const artifact = { schema: ARTIFACT_SCHEMA, taskId, submissionId, author, survey };
  return { artifact, bytes: canonical(artifact) };
}

/** FIXTURE native records of an accepted survey for one project (task plus winning submission). */
export function acceptedSurvey(projectId, { mainKpi = 'FIXTURE Main KPI for the accepted survey.', meetsMainKpi = false } = {}) {
  const taskId = `T-${projectId}-1-prior-art-survey`;
  const submissionId = `sub-survey-${projectId}`;
  const author = 'uain1' + 'd'.repeat(40);
  const included = Array.from({ length: 8 }, (_, i) => ({
    kind: i % 2 ? 'nct' : 'wikidata', id: i % 2 ? `NCT0000000${i}` : `Q${1000 + i}`, title: `FIXTURE record ${i}`,
    relation: meetsMainKpi && i === 0 ? 'meets_main_kpi' : 'partial', note: 'FIXTURE note: not a research result.',
  }));
  const survey = { mainKpi, asOf: '2026-11-06', items: included,
    conclusion: { meetsMainKpi, gaps: meetsMainKpi ? [] : ['FIXTURE gap: no existing work meets the Main KPI as written.'] } };
  const { bytes } = surveyArtifact({ taskId, submissionId, author, survey });
  const task = { id: taskId, project: `P-${projectId}`, state: 'accepted', winner: submissionId, pending: '', paid: '250000000', reserved: '0',
    solver_amount: '200000000', reviewer_amount: '50000000' };
  const submission = { id: submissionId, task: taskId, author, evidence: bytes, evidence_digest: sha256(bytes), state: 'accepted' };
  return { task, submission, records: { [`central_submission/${submissionId}`]: submission } };
}

/** A native snapshot with the project's survey accepted (added after any overrides). */
export function withAcceptedSurvey(snapshot, options) {
  const a = acceptedSurvey(snapshot.projectId, options);
  return { ...snapshot, tasks: [...(snapshot.tasks ?? []).filter((t) => t.id !== a.task.id), a.task], records: { ...snapshot.records, ...a.records } };
}

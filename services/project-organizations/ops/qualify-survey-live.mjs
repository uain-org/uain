#!/usr/bin/env node
/** QUALIFICATION ONLY: the prior-art survey verifier against the LIVE record APIs.
 *
 * For one reviewed project (default OPP-00002) this builds the real survey task and
 * policy, then:
 *   1. discovers real records with plain searches on the allowed hosts (PubMed,
 *      ClinicalTrials.gov, Wikidata) and reads every required identifier's record;
 *   2. writes a small survey from what it read (titles copied from the records, the
 *      required identifiers screened out) and runs the real verifier: pinned-address
 *      retrieval from the fixed record APIs, then the hash-pinned driver in its worker;
 *   3. checks that a fabricated DOI and a wrong title fail against the live APIs.
 *
 * The survey's relations and notes are QUALIFICATION placeholders, not research: this
 * proves the resolution path, not survey quality. Nothing is signed, submitted or paid.
 *
 * Usage: node services/project-organizations/ops/qualify-survey-live.mjs [OPP-xxxxx] [--out file]
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { CENTRAL_POLICY } from '../../../apps/baink/server/central-earning-command.mjs';
import { centralUnlockedUnits } from '../../../apps/baink/server/central-budget.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { SUPPLY_CAP_UNITS } from '../src/pricing.mjs';
import { ARTIFACT_SCHEMA, createRetriever, createRunner, driverDigest, verifyEvidence } from '../src/verification.mjs';
import { SURVEY_HOSTS, buildSurveyTask, surveyResolution } from '../src/survey.mjs';
import { readRecord } from '../verifiers/prior-art-survey.mjs';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const projectId = args.find((a) => /^OPP-\d{5}$/.test(a)) ?? 'OPP-00002';
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const DOCS = new URL('../../../docs/baink/project-organizations-2026-11-06/', import.meta.url);
const read = (rel) => JSON.parse(readFileSync(new URL(rel, DOCS)));
const log = (...m) => console.error('[survey-live]', ...m);

const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
const selection = await loadSelection();
const p = selection.get(projectId);
const plan = { project: p.nativeProjectId, revision: 1, state: 'accept', main_kpi: p.mainKpi,
  stages: Array.from({ length: 5 }, (_, i) => ({ round: i + 1, criteria: `QUALIFICATION stage ${i + 1} placeholder criteria text.` })) };
const snapshot = { projectId, nativeProjectId: p.nativeProjectId, available: true, height: '1',
  budget: { project: p.nativeProjectId, policy: CENTRAL_POLICY, allocation: centralUnlockedUnits(1), reserved: '0', paid: '0', round: 1 },
  fundState: { revision: 1, approved_revision: 1, completed: 0, pending: '' }, plan, approvedPlan: plan, tasks: [] };
const { policy } = buildSurveyTask({
  projectId, selection, source: { revision: catalogue.revision, row: structuredClone(catalogue.records.get(projectId)) },
  draft: read(`bootstrap-drafts/${projectId}.json`), reviewed: read(`bootstrap-reviewed/${projectId}.json`), approvedPlan: snapshot,
  pricingSnapshot: { supply: { cap: SUPPLY_CAP_UNITS.toString(), issued: '0', reserved: '0' } }, driverSha256: driverDigest('prior-art-survey'),
});

const retriever = createRetriever({ allowedHosts: [...SURVEY_HOSTS], maxBytes: 2 * 1024 * 1024, timeoutMs: 20000,
  headers: { 'user-agent': 'uain-prior-art-survey-qualification/1 (+https://uain.global)', accept: 'application/json, application/atom+xml;q=0.9' } });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(url, host) {
  const got = await retriever.observe(url, { hosts: [host] });
  await pause(400);
  return JSON.parse(Buffer.from(got.bytes).toString('utf8'));
}
async function titleOf(kind, id) {
  const at = surveyResolution(kind, id);
  const got = await retriever.observe(at.url, { hosts: [at.host], notFound: true, maxBytes: 512 * 1024 });
  await pause(kind === 'github' ? 1200 : 400);
  const answer = readRecord(kind, id, { kind, id, status: got.status, body: got.status === 200 ? new Uint8Array(got.bytes) : null });
  return answer.found ? answer.titles[0] : null;
}

// 1. Discovery: plain searches on the allowed hosts, from the project title keywords.
const words = catalogue.records.get(projectId).title.toLowerCase().match(/[a-z]{5,}/g);
const terms = words.slice(0, 3).join(' ');
const longest = [...words].sort((x, y) => y.length - x.length)[0];
log('discovery terms:', terms, '| longest:', longest);
const found = [];
// Identifiers the independent reviewer cited in the project's reviewed record.
const basis = read(`bootstrap-reviewed/${projectId}.json`).prior_art.basis;
for (const m of basis.matchAll(/\bNCT[0-9]{8}\b/g)) found.push({ kind: 'nct', id: m[0] });
for (const m of basis.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/([0-9]{1,10})/g)) found.push({ kind: 'pubmed', id: m[1] });
for (const m of basis.matchAll(/nature\.com\/articles\/(s[0-9]{5}-[0-9]{3}-[0-9]{5}-[0-9a-z])/g)) found.push({ kind: 'doi', id: `10.1038/${m[1]}` });
for (const m of basis.matchAll(/https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)/g)) found.push({ kind: 'github', id: m[1].toLowerCase().replace(/[.)]+$/, '') });
const pm = await json(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=4&term=${encodeURIComponent(terms)}`, 'eutils.ncbi.nlm.nih.gov');
for (const id of pm.esearchresult?.idlist ?? []) found.push({ kind: 'pubmed', id });
const ct = await json(`https://clinicaltrials.gov/api/v2/studies?pageSize=3&fields=protocolSection.identificationModule&query.term=${encodeURIComponent(longest)}`, 'clinicaltrials.gov');
for (const s of ct.studies ?? []) found.push({ kind: 'nct', id: s.protocolSection.identificationModule.nctId });
const wd = await json(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=3&search=${encodeURIComponent(longest)}`, 'www.wikidata.org');
for (const e of wd.search ?? []) found.push({ kind: 'wikidata', id: e.id });
const seen = new Set();
for (let i = found.length - 1; i >= 0; i--) { const k = `${found[i].kind}:${found[i].id}`; if (seen.has(k) || !surveyResolution(found[i].kind, found[i].id)) found.splice(i, 1); else seen.add(k); }
found.reverse();
log('discovered', found.map((f) => `${f.kind}:${f.id}`).join(' '));

// 2. A survey from what the record APIs returned.
const items = [];
const requiredKeys = new Set(policy.successTests[0].requiredIds.map((r) => `${r.kind}:${r.id}`));
for (const f of found.filter((x) => !requiredKeys.has(`${x.kind}:${x.id}`))) {
  const title = await titleOf(f.kind, f.id);
  if (title) items.push({ kind: f.kind, id: f.id, title: title.trim().slice(0, 300), relation: 'adjacent', note: 'QUALIFICATION placeholder: relation not assessed.' });
}
const required = policy.successTests[0].requiredIds;
let unreadable = 0;
for (const r of required) {
  const title = await titleOf(r.kind, r.id).catch((e) => (log('required unreadable', r.kind, r.id, e.code), null));
  if (title === null) { unreadable += 1; continue; }
  items.push({ kind: r.kind, id: r.id, title: title.trim().slice(0, 300), relation: 'screened_out', note: 'QUALIFICATION placeholder: screened out.' });
}
const included = items.filter((i) => i.relation !== 'screened_out');
log(`items ${items.length}: ${included.length} included from discovery, ${items.length - included.length} required screened out, ${unreadable} required unreadable`);
const survey = { mainKpi: p.mainKpi, asOf: new Date().toISOString().slice(0, 10), items,
  conclusion: { meetsMainKpi: false, gaps: ['QUALIFICATION placeholder gap: this survey was not assessed by a solver.'] } };
const author = 'uain1' + '0'.repeat(40);
const assignment = { taskId: policy.taskId, projectId: policy.projectId, submissionId: 'qualification-live-1', author, criteriaDigest: policy.criteriaDigest };
const runner = createRunner({ timeoutMs: 30000 });
const verify = (s) => verifyEvidence({ taskPolicy: policy, assignment, artifact: { schema: ARTIFACT_SCHEMA, taskId: policy.taskId, submissionId: assignment.submissionId, author, survey: s } },
  { retriever, runner });
const live = await verify(survey);
log('live verdict', live.verdict, live.findings.slice(0, 6).join(' '));

// 3. Negative live checks.
const fabricated = await verify({ ...survey, items: [...items, { kind: 'doi', id: '10.1038/s41586-099-99999-9', title: 'A fabricated paper that does not exist', relation: 'adjacent', note: 'QUALIFICATION: fabricated DOI.' }] });
const wrongTitle = await verify({ ...survey, items: items.map((i, n) => (n === 0 ? { ...i, title: 'Completely unrelated title about potholes and bridges' } : i)) });
const result = {
  projectId, at: new Date().toISOString(), policyDigestTaskId: policy.taskId, required: required.length, unreadableRequired: unreadable,
  included: included.length, kinds: [...new Set(included.map((i) => i.kind))],
  live: { verdict: live.verdict, findings: live.findings.slice(0, 12) },
  fabricatedDoi: { verdict: fabricated.verdict, notFound: fabricated.findings.includes('item_not_found:doi:10.1038/s41586-099-99999-9') },
  wrongTitle: { verdict: wrongTitle.verdict, mismatch: wrongTitle.findings.some((f) => f.startsWith('item_title_mismatch:')) },
};
const expected = live.verdict === 'pass' && result.fabricatedDoi.verdict === 'fail' && result.fabricatedDoi.notFound && result.wrongTitle.mismatch;
result.status = expected ? 'PASS' : live.verdict === 'needs_evidence' ? 'INCONCLUSIVE' : 'FAIL';
if (out) writeFileSync(out, JSON.stringify({ ...result, survey }, null, 1) + '\n');
console.log(JSON.stringify(result, null, 1));
process.exit(result.status === 'PASS' ? 0 : 1);

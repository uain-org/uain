/** The prior-art survey: first task of every organization (survey.mjs, verifiers/prior-art-survey.mjs).
 * Uses the real catalogue, drafts and reviewed records; record APIs are FIXTURE answers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { CENTRAL_POLICY, centralPayload } from '../../../apps/baink/server/central-earning-command.mjs';
import { centralUnlockedUnits } from '../../../apps/baink/server/central-budget.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { SUPPLY_CAP_UNITS, validatePricedTask } from '../src/pricing.mjs';
import { ARTIFACT_SCHEMA, SURVEY_HOST_INTERVALS, SURVEY_READ_BUDGET_MS, createRetriever, createRunner, driverDigest, validateTaskPolicy, verifyEvidence } from '../src/verification.mjs';
import {
  SURVEY_HOSTS, SURVEY_MAX_REQUIRED, SURVEY_REVIEWER_UNITS, SURVEY_SOLVER_UNITS, buildSurveyTask, normalizeSurveyId, requireAcceptedSurvey,
  requiredIdsFromSearches, surveyBriefing, surveyResolution, surveyStatus, surveyTaskId,
} from '../src/survey.mjs';
import { sameTitle, verify as driverVerify } from '../verifiers/prior-art-survey.mjs';
import { byText, digest, sha256 } from '../src/common.mjs';
import { acceptedSurvey, draftOf, fixtureSurvey, reviewedOf, surveyArtifact, withAcceptedSurvey } from './fixtures/survey-fixture.mjs';

const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
const selection = await loadSelection();
const ID = 'OPP-00002';
const DRIVER = driverDigest('prior-art-survey');
const REVIEWED_DIR = new URL('../../../docs/baink/project-organizations-2026-11-06/bootstrap-reviewed/', import.meta.url);
const refuses = (code) => (e) => (assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`), true);
const sourceOf = (id = ID) => ({ revision: catalogue.revision, row: structuredClone(catalogue.records.get(id)) });

const nativePlan = (id = ID) => ({
  project: 'P-' + id, revision: 1, state: 'accept', main_kpi: selection.get(id).mainKpi,
  stages: Array.from({ length: 5 }, (_, i) => ({ round: i + 1, criteria: `FIXTURE stage ${i + 1} criteria with enough words to be valid.` })),
});
const budget = (id = ID, extra = {}) => ({
  project: 'P-' + id, manager: 'uain1' + 'c'.repeat(40), policy: CENTRAL_POLICY, allocation: centralUnlockedUnits(1), reserved: '0', paid: '0', round: 1,
  lifetime_ceiling: '1000000000000000', height: '120', evidence_digest: 'b'.repeat(64), ...extra,
});
const snapshot = (id = ID, extra = {}) => ({
  projectId: id, nativeProjectId: 'P-' + id, available: true, height: '120', budget: budget(id),
  fundState: { revision: 1, approved_revision: 1, completed: 0, pending: '' }, plan: nativePlan(id), approvedPlan: nativePlan(id), tasks: [], ...extra,
});
const pricingSnapshot = { supply: { cap: SUPPLY_CAP_UNITS.toString(), issued: '0', reserved: '0' } };
const build = (extra = {}) => buildSurveyTask({
  projectId: ID, selection, source: sourceOf(), draft: draftOf(ID), reviewed: reviewedOf(ID), approvedPlan: snapshot(), pricingSnapshot,
  driverSha256: DRIVER, ...extra,
});

test('the survey task is deterministic, small, the first task of round 1, and native accepts its payload', () => {
  const { input, evidence, policy } = build();
  assert.deepEqual(build().input.task, input.task, 'same inputs, same task');
  assert.deepEqual([input.task.id, input.task.milestoneRound, input.task.eligibility], [surveyTaskId(ID), 1, 'new']);
  assert.deepEqual([input.task.solverAmount, input.task.reviewerAmount], [SURVEY_SOLVER_UNITS, SURVEY_REVIEWER_UNITS]);
  assert.equal(input.task.evidenceDigest, digest(evidence));
  assert.equal(evidence.policyDigest, digest(policy));
  assert.equal(evidence.draftDigest, digest(draftOf(ID)));
  assert.match(input.priorArt.basis, /^Prior-art survey task, decided by Rahul on 2026-11-06/);
  assert.match(input.priorArt.basis, /Independent review by claude-independent-prior-art-reviewer-20261106/);
  assert.ok(Buffer.byteLength(input.task.criteria) <= 4096);
  assert.ok(input.task.criteria.includes(selection.get(ID).mainKpi));
  const priced = validatePricedTask(input);
  assert.deepEqual(centralPayload('central_task_open', priced.nativePayload), priced.nativePayload);
  assert.deepEqual([priced.totalUnits, priced.nativePayload.acceptance_digest], ['250000000', sha256(input.task.criteria)]);
  assert.equal(policy.criteriaDigest, priced.nativePayload.acceptance_digest);
  assert.deepEqual(validateTaskPolicy(policy), policy);
});

test('the survey must be first: a project with any task, a later round, a held project or a stale record refuses', () => {
  assert.throws(() => build({ approvedPlan: snapshot(ID, { tasks: [{ id: 'T-other', project: 'P-' + ID }] }) }), refuses('survey_not_first'));
  assert.throws(() => build({ approvedPlan: snapshot(ID, { tasks: [{ id: surveyTaskId(ID), project: 'P-' + ID }] }) }), refuses('survey_already_open'));
  assert.throws(() => build({ approvedPlan: snapshot(ID, { fundState: { revision: 1, approved_revision: 1, completed: 1, pending: '' }, budget: budget(ID, { round: 2, allocation: centralUnlockedUnits(2) }) }) }),
    refuses('survey_round_passed'));
  assert.throws(() => build({ reviewed: reviewedOf('OPP-00003') }), refuses('invalid_prior_art_review'));
  assert.throws(() => build({ draft: draftOf('OPP-00003') }), refuses('survey_draft_mismatch'));
  assert.throws(() => build({ reviewed: { ...reviewedOf(ID), source_digest: 'f'.repeat(64) } }), refuses('prior_art_review_stale'));
  assert.throws(() => build({ pricingSnapshot: {} }), refuses('native_supply_unread'));
  assert.throws(() => build({ driverSha256: 'nope' }), refuses('invalid_survey_policy'));
  const held = selection.projects.find((p) => p.holds.length);
  if (held) assert.throws(() => build({ projectId: held.id }), refuses('project_held'));
});

test('every one of the 96 reviewed projects yields a valid survey task and policy', () => {
  const ids = readdirSync(REVIEWED_DIR).filter((n) => /^OPP-\d{5}\.json$/.test(n)).map((n) => n.slice(0, 9));
  assert.equal(ids.length, 96);
  for (const id of ids) {
    const { input, policy } = buildSurveyTask({
      projectId: id, selection, source: sourceOf(id), draft: draftOf(id), reviewed: reviewedOf(id), approvedPlan: snapshot(id), pricingSnapshot, driverSha256: DRIVER,
    });
    validatePricedTask(input);
    validateTaskPolicy(policy);
    assert.ok(policy.successTests[0].requiredIds.length <= SURVEY_MAX_REQUIRED, id);
  }
  // A held project has no reviewed record, so it gets no survey.
  assert.equal(existsSync(new URL('OPP-08881.json', REVIEWED_DIR)), selection.get('OPP-08881').holds.length === 0);
});

test('required identifiers come only from the trusted search results, canonical and once each', () => {
  const ids = requiredIdsFromSearches(draftOf(ID).searches);
  assert.ok(ids.length > 0 && ids.every((r) => surveyResolution(r.kind, r.id)));
  assert.ok(ids.some((r) => r.kind === 'doi' && r.id === '10.1002/bies.201670910'));
  assert.equal(new Set(ids.map((r) => `${r.kind}:${r.id}`)).size, ids.length);
  assert.deepEqual(requiredIdsFromSearches([{ source: 'api.crossref.org/works', resultSummary: 'url=x; top: 10.1/A "t" | 10.1/a "t" | bad "x"' }]), []);
  assert.deepEqual(requiredIdsFromSearches([{ source: 'api.crossref.org/works', resultSummary: 'url=x; top: 10.1234/AbC "t" | 10.1234/abc "u"' }]), [{ kind: 'doi', id: '10.1234/abc' }]);
  assert.deepEqual(requiredIdsFromSearches([{ source: 'export.arxiv.org/api/query', resultSummary: 'url=x; top: arXiv:2401.01234v2 "t"' }]), [{ kind: 'arxiv', id: '2401.01234' }]);
  assert.deepEqual(requiredIdsFromSearches([{ source: 'fixture', resultSummary: 'url=x; top: 10.1234/abc "t"' }]), []);
});

test('identifiers are canonical before any URL is built, and resolve only to the fixed record APIs', () => {
  assert.equal(normalizeSurveyId('doi', 'https://doi.org/10.1038/S43587-023-00560-5'), '10.1038/s43587-023-00560-5');
  assert.equal(normalizeSurveyId('github', 'https://github.com/FelixJWong/senolyticsai.git'), 'felixjwong/senolyticsai');
  assert.equal(normalizeSurveyId('nct', 'nct04733534'), 'NCT04733534');
  for (const [kind, id] of [['doi', 'not-a-doi'], ['github', 'a/b/c'], ['nct', 'NCT1'], ['wikidata', 'Q0'], ['pubmed', '0'], ['url', 'https://x.example']])
    assert.equal(surveyResolution(kind, id), null, `${kind}:${id}`);
  assert.equal(surveyResolution('doi', '10.1038/S43587-023-00560-5'), null, 'non-canonical ids are refused, not repaired');
  const hosts = new Set(['doi:10.1038/s43587-023-00560-5', 'arxiv:2401.01234', 'github:felixjwong/senolyticsai', 'pubmed:37117524', 'nct:NCT04733534', 'wikidata:Q42']
    .map((k) => surveyResolution(...k.split(/:(.*)/s).slice(0, 2)).host));
  assert.deepEqual([...hosts].sort(byText), [...SURVEY_HOSTS]);
  assert.equal(new URL(surveyResolution('github', 'felixjwong/senolyticsai').url).pathname, '/repos/felixjwong/senolyticsai');
});

/* ------------------------------------------------------------ verification */

const author = 'uain1' + 'a'.repeat(40);
const assignmentOf = (policy) => ({ taskId: policy.taskId, projectId: policy.projectId, submissionId: 'S-survey-1', author, criteriaDigest: policy.criteriaDigest });

/** FIXTURE record APIs: answers `${kind}:${id}` from a table of titles; anything else is a 404. */
function recordApi(titles, { failing = new Set(), failures = {}, code = 'unexpected_status', status = 429 } = {}) {
  const seen = {};
  const calls = [];
  const body = (kind, id, title) => {
    if (kind === 'doi') return { status: 'ok', message: { DOI: id, title: [title] } };
    if (kind === 'github') return { full_name: id, description: title };
    if (kind === 'pubmed') return { result: { uids: [id], [id]: { uid: id, title } } };
    if (kind === 'nct') return { protocolSection: { identificationModule: { nctId: id, briefTitle: title } } };
    if (kind === 'wikidata') return { entities: { [id]: { id, labels: { en: { language: 'en', value: title } } } } };
    return null;
  };
  return {
    calls,
    async observe(url, { hosts, notFound }) {
      const key = Object.entries(titles).find(([k]) => { const [kind, id] = k.split(/:(.*)/s); return surveyResolution(kind, id)?.url === url; })?.[0];
      calls.push({ url, hosts, notFound });
      const refusal = () => Object.assign(new Error('refused'), code === 'unexpected_status' ? { code, status } : { code });
      if (key && failing.has(key)) throw refusal();
      if (key && (seen[key] = (seen[key] ?? 0) + 1) <= (failures[key] ?? 0)) throw refusal();
      if (!key) return { url, status: 404, bytes: Buffer.from('{"status":"error"}') };
      const [kind, id] = key.split(/:(.*)/s);
      const bytes = kind === 'arxiv'
        ? Buffer.from(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/${id}v1</id><title>${titles[key]}</title></entry></feed>`)
        : Buffer.from(JSON.stringify(body(kind, id, titles[key])));
      return { url, status: 200, bytes };
    },
  };
}
const titlesOf = (survey) => Object.fromEntries(survey.items.map((i) => [`${i.kind}:${i.id}`, i.title]));
const runner = createRunner({ timeoutMs: 20000 });
/** FIXTURE pacing: no real waits, so tests stay fast; the delays asked for are recorded. */
const instantPacing = (slept = []) => {
  let clock = 0;
  return { sleep: async (ms) => { slept.push(ms); clock += ms; }, now: () => clock, slept, at: () => clock };
};
const verifySurvey = async (policy, survey, api = recordApi(titlesOf(survey)), pacing = instantPacing()) => {
  const assignment = assignmentOf(policy);
  const { artifact } = surveyArtifact({ taskId: policy.taskId, submissionId: assignment.submissionId, author, survey });
  return { result: await verifyEvidence({ taskPolicy: policy, assignment, artifact }, { retriever: api, runner, surveyPacing: pacing }), api, pacing };
};

test('a complete survey whose every identifier resolves with its title passes and is attested', async () => {
  const { policy } = build();
  const survey = fixtureSurvey(policy);
  const { result, api } = await verifySurvey(policy, survey);
  assert.equal(result.verdict, 'pass', result.findings.join(' '));
  assert.ok(HASH(result.attestationDigest));
  assert.deepEqual([result.attestation.driver, result.attestation.mainKpiSatisfied], [{ name: 'prior-art-survey', sha256: DRIVER }, false]);
  assert.equal(api.calls.length, survey.items.length, 'one record read per identifier');
  assert.ok(api.calls.every((c) => c.notFound === true && c.hosts.length === 1 && SURVEY_HOSTS.includes(c.hosts[0])));
});
const HASH = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

test('a fabricated citation, a wrong title, a missing required id or a contradicting conclusion fails', async () => {
  const { policy } = build();
  const base = fixtureSurvey(policy);
  const fabricated = await verifySurvey(policy, base, recordApi(Object.fromEntries(Object.entries(titlesOf(base)).filter(([k]) => k !== 'wikidata:Q1000'))));
  assert.equal(fabricated.result.verdict, 'fail');
  assert.ok(fabricated.result.findings.includes('item_not_found:wikidata:Q1000'));
  const wrong = await verifySurvey(policy, base, recordApi({ ...titlesOf(base), 'nct:NCT00000001': 'An unrelated study of something else entirely' }));
  assert.ok(wrong.result.findings.includes('item_title_mismatch:nct:NCT00000001'));
  const required = policy.successTests[0].requiredIds[0];
  const dropped = { ...base, items: base.items.filter((i) => !(i.kind === required.kind && i.id === required.id)) };
  assert.ok((await verifySurvey(policy, dropped)).result.findings.includes(`required_id_unaccounted:${required.kind}:${required.id}`));
  const contradicts = { ...base, conclusion: { meetsMainKpi: true, gaps: [] } };
  assert.ok((await verifySurvey(policy, contradicts)).result.findings.includes('conclusion_contradicts_items'));
  const otherKpi = { ...base, mainKpi: 'FIXTURE some other Main KPI statement.' };
  assert.ok((await verifySurvey(policy, otherKpi)).result.findings.includes('survey_main_kpi_mismatch'));
  const thin = { ...base, items: base.items.filter((i) => i.relation === 'screened_out' || i.id === 'Q1000') };
  const r = (await verifySurvey(policy, thin)).result;
  assert.ok(r.findings.some((f) => f.startsWith('too_few_included:1/8')) && r.findings.some((f) => f.startsWith('too_few_source_kinds:1/2')));
  const duplicate = { ...base, items: [...base.items, base.items[0]] };
  assert.ok((await verifySurvey(policy, duplicate)).result.findings.includes('item_duplicate:wikidata:Q1000'));
});

test('a malformed identifier is never fetched; an unreadable record is inconclusive, never a pass', async () => {
  const { policy } = build();
  const base = fixtureSurvey(policy);
  const hostile = { ...base, items: [...base.items, { kind: 'doi', id: '10.1/../../etc', title: 'x x x', relation: 'adjacent', note: 'FIXTURE hostile id.' },
    { kind: 'url', id: 'https://evil.example', title: 'evil', relation: 'adjacent', note: 'FIXTURE unknown kind.' }] };
  const { result, api } = await verifySurvey(policy, hostile);
  assert.equal(result.verdict, 'fail');
  assert.ok(api.calls.every((c) => !/evil|\.\./.test(c.url)));
  const flaky = await verifySurvey(policy, base, recordApi(titlesOf(base), { failing: new Set(['nct:NCT00000003']) }));
  assert.equal(flaky.result.verdict, 'needs_evidence');
  assert.equal(flaky.result.attestationDigest, null);
  assert.ok(flaky.result.findings.some((f) => f.startsWith('record_unreadable:nct:NCT00000003')));
});

test('the driver hash is pinned: a policy with another driver hash or other hosts is refused', async () => {
  const { policy } = build();
  assert.throws(() => validateTaskPolicy({ ...policy, primarySourceHosts: [...policy.primarySourceHosts, 'evil.example'].slice(1) }), refuses('invalid_task_policy'));
  assert.throws(() => validateTaskPolicy({ ...policy, inputs: [{ url: 'https://api.crossref.org/x', sha256: 'a'.repeat(64), bytes: 1 }] }), refuses('invalid_task_policy'));
  assert.throws(() => validateTaskPolicy({ ...policy, driver: { name: 'finite-math-witness', sha256: DRIVER } }), refuses('invalid_task_policy'));
  const tampered = { ...policy, driver: { name: 'prior-art-survey', sha256: 'e'.repeat(64) } };
  const { result } = await verifySurvey(tampered, fixtureSurvey(policy));
  assert.deepEqual([result.verdict, result.findings.at(-1)], ['fail', 'driver_hash_mismatch']);
});

test('title matching tolerates case, markup and subtitles but not a different record', () => {
  assert.ok(sameTitle('Senolytic CAR T cells reverse senescence-associated pathologies', 'Senolytic CAR T cells reverse senescence-associated pathologies.'));
  assert.ok(sameTitle('Senolytic CAR T cells reverse senescence associated pathologies', '<i>Senolytic</i> CAR T cells reverse senescence-associated pathologies'));
  assert.ok(!sameTitle('Driving CARs to clear senescent cells', 'Microwave repairs might annihilate zombie potholes'));
  assert.equal(driverVerify({ successTests: [], survey: {}, records: [] }).status, 'fail');
});

/* ------------------------------------------------------------------ gate */

test('survey status reads the native task and the winning submission; only an accepted survey unlocks later tasks', () => {
  const s = snapshot();
  assert.equal(surveyStatus(s).state, 'absent');
  assert.throws(() => requireAcceptedSurvey(s), refuses('prior_art_survey_required'));
  assert.equal(surveyStatus({ ...s, tasks: null }).state, 'unread');
  const a = acceptedSurvey(ID);
  for (const state of ['open', 'open_unfunded', 'under_review']) assert.equal(surveyStatus({ ...s, tasks: [{ ...a.task, state }] }).state, 'pending');
  assert.equal(surveyStatus({ ...s, tasks: [a.task] }).state, 'unread', 'submission not read');
  const ok = requireAcceptedSurvey(withAcceptedSurvey(s));
  assert.deepEqual([ok.state, ok.meetsMainKpi, ok.submission], ['accepted', false, a.submission.id]);
  assert.throws(() => requireAcceptedSurvey(withAcceptedSurvey(s, { meetsMainKpi: true })), refuses('prior_art_survey_found_solution'));
  const forged = withAcceptedSurvey(s);
  forged.records[`central_submission/${a.submission.id}`] = { ...a.submission, evidence: a.submission.evidence + ' ' };
  assert.throws(() => surveyStatus(forged), refuses('survey_submission_invalid'));
  const briefing = surveyBriefing(ok);
  assert.deepEqual(Object.keys(briefing), ['task', 'submission', 'as_of', 'items', 'gaps']);
  assert.equal(briefing.items.length, 8);
});

test('the accepted survey evidence fits the native inline evidence limit for a full survey', () => {
  const { policy } = build();
  const survey = fixtureSurvey(policy);
  const { bytes } = surveyArtifact({ taskId: policy.taskId, submissionId: 'sub-' + 'f'.repeat(48), author, survey });
  assert.ok(Buffer.byteLength(bytes) <= 16384, `${Buffer.byteLength(bytes)} bytes`);
  assert.equal(JSON.parse(bytes).schema, ARTIFACT_SCHEMA);
});

test('a survey written in BAINK (survey-draft.js) is exactly the artifact the fixed verifier passes', async () => {
  const { parseSurveyDraft, surveyEvidence, surveyTemplateText } = await import('../../../apps/baink/web/survey-draft.js');
  const { surveyTemplates } = await import('../ops/survey-templates.mjs');
  const { policy } = build();
  const template = (await surveyTemplates()).templates[policy.taskId];
  assert.equal(template.criteriaDigest, policy.criteriaDigest, 'the public template is the policy of the opened task');
  let text = surveyTemplateText(template, '2026-11-07');
  text += Array.from({ length: 8 }, (_, i) => (i % 2
    ? `item: nct | NCT0000000${i} | FIXTURE trial record ${i} | partial | FIXTURE note on what it does.`
    : `item: wikidata | Q${1000 + i} | FIXTURE entity ${i} | adjacent | FIXTURE note on what it does.`)).join('\n') + '\n';
  const parsed = parseSurveyDraft(text, template);
  assert.equal(parsed.errors, undefined, JSON.stringify(parsed.errors));
  const evidence = surveyEvidence({ taskId: policy.taskId, submissionId: 'CS-1', author, survey: parsed.survey });
  const artifact = JSON.parse(evidence);
  const api = recordApi(Object.fromEntries(parsed.survey.items.map((i) => [`${i.kind}:${i.id}`, i.title.replace(/^FIXTURE screened .*/, i.title)])));
  const assignment = { ...assignmentOf(policy), submissionId: 'CS-1' };
  const result = await verifyEvidence({ taskPolicy: policy, assignment, artifact }, { retriever: api, runner, surveyPacing: instantPacing() });
  assert.equal(result.verdict, 'pass', result.findings.join(' '));
  assert.equal(sha256(evidence), result.attestation.artifactDigest, 'the native evidence digest is the attested artifact digest');
});

test('a rate-limited record is retried before it counts as unread; a record that never answers stays unread', async () => {
  const { policy } = build();
  const base = fixtureSurvey(policy);
  const nct = base.items.filter((i) => i.kind === 'nct').map((i) => `nct:${i.id}`);
  const callsTo = (api, key) => api.calls.filter((c) => c.url === surveyResolution(...key.split(/:(.*)/s).slice(0, 2)).url).length;

  // 429 twice, then the record answers: the survey passes, after 1 s and 3 s of backoff.
  const twice = await verifySurvey(policy, base, recordApi(titlesOf(base), { failures: { [nct[0]]: 2 } }));
  assert.equal(twice.result.verdict, 'pass', twice.result.findings.join(' '));
  assert.equal(callsTo(twice.api, nct[0]), 3, 'two retries, then the answer');
  assert.ok(twice.pacing.slept.includes(1000) && twice.pacing.slept.includes(3000));

  // 503 is retried the same way.
  const unavailable = await verifySurvey(policy, base, recordApi(titlesOf(base), { failures: { [nct[0]]: 1 }, status: 503 }));
  assert.equal(unavailable.result.verdict, 'pass', unavailable.result.findings.join(' '));

  // Always 429: three retries, then unread; the result is inconclusive, never a pass.
  const always = await verifySurvey(policy, base, recordApi(titlesOf(base), { failing: new Set([nct[0]]) }));
  assert.equal(always.result.verdict, 'needs_evidence');
  assert.equal(always.result.attestationDigest, null);
  assert.equal(callsTo(always.api, nct[0]), 4, 'one try and three retries');
  assert.ok(always.result.findings.some((f) => f.startsWith(`record_unreadable:${nct[0]}`)));
});

test('refusals that cannot improve are read once; a 404 is an answer', async () => {
  const { policy } = build();
  const base = fixtureSurvey(policy);
  const nct = base.items.filter((i) => i.kind === 'nct').map((i) => `nct:${i.id}`);
  const callsTo = (api, key) => api.calls.filter((c) => c.url === surveyResolution(...key.split(/:(.*)/s).slice(0, 2)).url).length;
  for (const refusal of [{ status: 400 }, { status: 403 }, { code: 'size_exceeded' }, { code: 'host_not_allowed' },
    { code: 'redirect_refused' }, { code: 'redirect_host_not_allowed' }, { code: 'https_required' }, { code: 'private_address_refused' }]) {
    const api = recordApi(titlesOf(base), { failing: new Set([nct[0]]), ...refusal });
    const { result } = await verifySurvey(policy, base, api);
    assert.equal(result.verdict, 'needs_evidence', JSON.stringify(refusal));
    assert.equal(callsTo(api, nct[0]), 1, `not retried: ${JSON.stringify(refusal)}`);
  }
  for (const code of ['retrieval_failed', 'timeout', 'dns_failed']) {
    const api = recordApi(titlesOf(base), { failures: { [nct[0]]: 1 }, code });
    assert.equal((await verifySurvey(policy, base, api)).result.verdict, 'pass', code);
    assert.equal(callsTo(api, nct[0]), 2, `retried once: ${code}`);
  }
  const missing = await verifySurvey(policy, base, recordApi(Object.fromEntries(Object.entries(titlesOf(base)).filter(([k]) => k !== nct[0]))));
  assert.equal(missing.result.verdict, 'fail');
  assert.equal(callsTo(missing.api, nct[0]), 1);
});

test('when every record keeps failing, no read starts after the survey read budget', async () => {
  const { policy } = build();
  const base = fixtureSurvey(policy);
  const many = { ...base, items: [...base.items, ...Array.from({ length: 40 }, (_, i) =>
    ({ kind: 'pubmed', id: String(30000000 + i), title: `FIXTURE paper ${i} on senolytics`, relation: 'adjacent', note: 'FIXTURE note.' }))] };
  const api = recordApi(titlesOf(many), { failing: new Set(Object.keys(titlesOf(many))) });
  const pacing = { ...instantPacing(), budgetMs: 60000 };
  const starts = [];
  const observe = api.observe;
  api.observe = async (url, options) => { starts.push(pacing.at()); return observe(url, options); };
  const { result } = await verifySurvey(policy, many, api, pacing);
  assert.equal(result.verdict, 'needs_evidence');
  assert.ok(Math.max(...starts) < 60000, `last read started at ${Math.max(...starts)} ms`);
  // Production budget: even if all 60 records fail every attempt, reads stop well before the attester's 600 s.
  assert.ok(SURVEY_READ_BUDGET_MS <= 240000);
  assert.equal(result.attestationDigest, null);
  assert.ok(starts.length < many.items.length * 4, `reads stopped once the budget was spent (${starts.length} reads)`);
});

test('consecutive reads of one host, PubMed included, are spaced by its interval', async () => {
  const { policy } = build();
  const base = fixtureSurvey(policy);
  const survey = { ...base, items: [...base.items, ...Array.from({ length: 4 }, (_, i) =>
    ({ kind: 'pubmed', id: String(31000000 + i), title: `FIXTURE spaced paper ${i}`, relation: 'adjacent', note: 'FIXTURE note.' }))] };
  const pacing = instantPacing();
  const reads = [];
  const api = recordApi(titlesOf(survey));
  const observe = api.observe;
  api.observe = async (url, options) => { reads.push({ host: new URL(url).hostname, at: pacing.at() }); return observe(url, options); };
  await verifySurvey(policy, survey, api, pacing);
  const byHost = {};
  for (const r of reads) (byHost[r.host] ??= []).push(r.at);
  assert.ok(byHost['eutils.ncbi.nlm.nih.gov']?.length >= 4, 'PubMed read repeatedly');
  for (const [host, times] of Object.entries(byHost)) {
    assert.ok(SURVEY_HOST_INTERVALS[host] > 0, `${host} has an interval`);
    for (let i = 1; i < times.length; i += 1)
      assert.ok(times[i] - times[i - 1] >= SURVEY_HOST_INTERVALS[host], `${host} spaced ${times[i] - times[i - 1]}`);
  }
});

test('an HTTP 429 from the pinned retriever is retried; a 403 is not', async () => {
  const id = '37117524';
  const url = surveyResolution('pubmed', id).url;
  const body = JSON.stringify({ result: { uids: [id], [id]: { uid: id, title: 'FIXTURE' } } });
  for (const [first, expectCalls, expectStatus] of [[429, 2, 200], [403, 1, 0]]) {
    let calls = 0;
    const retriever = createRetriever({
      allowedHosts: ['eutils.ncbi.nlm.nih.gov'], resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (u) => { calls += 1; assert.equal(u, url); return calls === 1 ? new Response('busy', { status: first }) : new Response(body, { status: 200 }); },
    });
    let error;
    try { await retriever.observe(url, { hosts: ['eutils.ncbi.nlm.nih.gov'], notFound: true }); } catch (e) { error = e; }
    assert.equal(error?.code, 'unexpected_status');
    assert.equal(error?.status, first, 'the refusal carries its HTTP status');
    // and through the survey path: retried only for 429
    calls = 0;
    const pacing = instantPacing();
    const { policy } = build();
    const base = fixtureSurvey(policy);
    const survey = { ...base, items: [...base.items, { kind: 'pubmed', id, title: 'FIXTURE', relation: 'adjacent', note: 'FIXTURE note.' }] };
    const api = recordApi(titlesOf(survey));
    const inner = api.observe;
    api.observe = (u, o) => (u === url ? retriever.observe(u, o) : inner(u, o));
    const { result } = await verifySurvey(policy, survey, api, pacing);
    assert.equal(calls, expectCalls, `HTTP ${first}`);
    assert.equal(result.findings.some((f) => f.startsWith(`record_unreadable:pubmed:${id}`)), expectStatus === 0, result.findings.join(' '));
  }
});

test('a rate-limited GitHub 403 is retried after its hint; a plain 403 is not; the token goes only to its host', async () => {
  const id = 'octo/fixture';
  const url = surveyResolution('github', id).url;
  const host = new URL(url).hostname;
  const body = JSON.stringify({ full_name: id, name: 'fixture', description: 'FIXTURE' });
  for (const [headers, expectCalls] of [[{ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' }, 2], [{ 'retry-after': '2' }, 2], [{}, 1]]) {
    let calls = 0; const seen = [];
    const retriever = createRetriever({
      allowedHosts: [host], resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      hostHeaders: { [host]: { authorization: 'Bearer FICTIONAL-read-only' } },
      fetchImpl: async (u, init) => { calls += 1; seen.push(init.headers.authorization); return calls === 1 ? new Response('limited', { status: 403, headers }) : new Response(body, { status: 200 }); },
    });
    let error;
    try { await retriever.observe(url, { hosts: [host], notFound: true }); } catch (e) { error = e; }
    assert.equal(error?.status, 403); assert.equal(error?.rateLimited === true, expectCalls === 2);
    calls = 0; const sleeps = [];
    const pacing = { ...instantPacing(), sleep: async (ms) => { sleeps.push(ms); } };
    const { policy } = build();
    const base = fixtureSurvey(policy);
    const survey = { ...base, items: [...base.items, { kind: 'github', id, title: 'fixture', relation: 'adjacent', note: 'FIXTURE note.' }] };
    const api = recordApi(titlesOf(survey));
    const inner = api.observe;
    api.observe = (u, o) => (u === url ? retriever.observe(u, o) : inner(u, o));
    await verifySurvey(policy, survey, api, pacing);
    assert.equal(calls, expectCalls, JSON.stringify(headers));
    if (headers['retry-after']) assert.ok(sleeps.includes(2000), 'retry-after honoured');
    assert.ok(seen.every((v) => v === 'Bearer FICTIONAL-read-only'));
  }
  assert.throws(() => createRetriever({ allowedHosts: ['api.crossref.org'], hostHeaders: { 'api.github.com': { authorization: 'x' } } }), { code: 'invalid_retriever' });
});

test('healthy maximum-size arXiv survey is not cut off by pacing budget', async () => {
  const { policy } = build();
  const survey = fixtureSurvey(policy);
  // Capture records before the driver: this tests all supported reads, independent of policy content.
  survey.items = Array.from({ length: 60 }, (_, i) => ({ kind: 'arxiv', id: `2401.${String(i + 1).padStart(5, '0')}`, title: `FIXTURE paper ${i}`, relation: 'adjacent', note: 'FIXTURE note.' }));
  const api = recordApi(titlesOf(survey));
  const pacing = instantPacing();
  await verifySurvey(policy, survey, api, pacing);
  assert.equal(api.calls.length, 60);
  assert.equal(pacing.at(), 177000);
  assert.ok(SURVEY_HOST_INTERVALS['eutils.ncbi.nlm.nih.gov'] >= 1000 / 3);
});

test('outer preflight DNS obeys request timeout', async () => {
  const retriever = createRetriever({ allowedHosts: ['eutils.ncbi.nlm.nih.gov'], timeoutMs: 20,
    resolve: () => new Promise(() => {}), fetchImpl: async () => { throw new Error('must not fetch'); } });
  // AbortSignal timeout is unref'd; keep the test event loop alive until rejection.
  const keepalive = setInterval(() => {}, 1000);
  try { await assert.rejects(retriever.observe(surveyResolution('pubmed', '37117524').url,
    { hosts: ['eutils.ncbi.nlm.nih.gov'] }), (e) => e.code === 'timeout'); }
  finally { clearInterval(keepalive); }
});

test('future required citations exclude absent/placeholder primary titles without changing canonical DOI identities', () => {
  const ids = requiredIdsFromSearches([{ source: 'api.crossref.org/works', resultSummary: 'url=x; top: 10.54499/2024.03713.bdana "untitled" | 10.1000/blank "" | 10.1016/S0262-4079(15)30636-9 "Lava lakes may be how Venus stays youthful"' }]);
  assert.deepEqual(ids, [{ kind: 'doi', id: '10.1016/s0262-4079(15)30636-9' }]);
});

test('future survey opening refuses a reviewed search set with no eligible primary record', () => {
  const draft = draftOf(ID);
  draft.searches = draft.searches.map(s => ({ ...s, resultSummary: 'url=x; top: 10.54499/2024.03713.bdana "untitled"' }));
  assert.throws(() => build({ draft }), refuses('insufficient_survey_records'));
});

test('selected survey refresh preserves other published contracts and refuses a foreign digest', async () => {
  const { readFile } = await import('node:fs/promises');
  const { surveyTemplatePublication, refreshPublishedSurveyTemplate } = await import('../ops/survey-templates.mjs');
  const previous = JSON.parse(await readFile(new URL('../../../apps/baink/server/survey-templates.json', import.meta.url), 'utf8'));
  const before = structuredClone(previous);
  const generated = await surveyTemplatePublication();
  const taskId = 'T-OPP-00010-1-prior-art-survey';
  const expected = { criteriaDigest: '8d4c68d002ab5f842281e1f5b3b9c00ee612fd43c56a71c3c0ca27e98447d478',
    policyDigest: '26d74d82408e8e5e43996f830de68d35393822aac3295adbeae6140522820d82',
    evidenceDigest: '90e237696778abb373daccd6863c637feff28173fe4a9619d99eb0c37d785871' };
  const next = refreshPublishedSurveyTemplate(previous, generated, taskId, expected);
  assert.deepEqual(previous, before, 'the publisher must not mutate its input');
  assert.deepEqual(Object.keys(next.templates), Object.keys(previous.templates));
  assert.deepEqual(next.templates[taskId], generated.document.templates[taskId]);
  for (const id of Object.keys(previous.templates)) if (id !== taskId)
    assert.deepEqual(next.templates[id], previous.templates[id], `retain published contract ${id}`);
  for (const key of Object.keys(expected)) assert.throws(() => refreshPublishedSurveyTemplate(previous, generated, taskId, { ...expected, [key]: '0'.repeat(64) }), /invalid_survey_template_refresh/);
});

test('the GitHub read token is used only from a private owned file and only for api.github.com', async (t) => {
  const { githubReadHeaders } = await import('../ops/verify-survey.mjs');
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'gh-token-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'token'); const me = process.getuid();
  assert.deepEqual(githubReadHeaders(path, me), {}, 'missing file: unauthenticated');
  writeFileSync(path, 'github_pat_FICTIONAL0000000000000000\n', { mode: 0o600 });
  assert.deepEqual(Object.keys(githubReadHeaders(path, me)), ['api.github.com']);
  chmodSync(path, 0o644); assert.deepEqual(githubReadHeaders(path, me), {}, 'world-readable refused');
  chmodSync(path, 0o600); assert.deepEqual(githubReadHeaders(path, me + 1), {}, 'foreign owner refused');
});

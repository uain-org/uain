// The registry audit and single-claim check verifier classes (10 November 2026): the fixed drivers on
// the golden fixtures (real ClinicalTrials.gov and PubMed answers), and the same drivers through
// verifyEvidence with a fake record API (FIXTURE transport, real pinned-hash isolated runner).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as audit from '../verifiers/registry-audit.mjs';
import * as claim from '../verifiers/single-claim.mjs';
import * as survey from '../verifiers/prior-art-survey.mjs';
import {
  ARTIFACT_SCHEMA, CLASS_DRIVERS, POLICY_SCHEMA, RECORD_CLASSES, createRunner, driverDigest, nativeArtifactV2, registryPages,
  validateTaskPolicy, verifyEvidence,
} from '../src/verification.mjs';
import { REGISTRY_HOSTS, SURVEY_HOSTS, claimResolution, surveyResolution } from '../src/survey-sources.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL('../../../fixtures/contracts/' + name, import.meta.url), 'utf8'));
const REG = fixture('registry-audit.json');
const CLAIM = fixture('single-claim-check.json');
const bytes = (v) => new Uint8Array(Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
const clone = (v) => structuredClone(v);
const codes = (findings) => findings.map((f) => f.split(' — ')[0]);
const pageOf = (studies, next) => ({ status: 200, body: bytes(next ? { studies, nextPageToken: next } : { studies }) });
const pubmedOf = (id) => ({ kind: 'pubmed', id, status: 200, body: bytes(REG.pubmedRecords[id] ?? { result: { uids: [id], [id]: { uid: id, title: `FIXTURE paper ${id}` } } }) });
const runAudit = (a, { test: t = REG.successTest, studies = REG.registryPage.studies, records, verifiedAt = REG.verifiedAt, registry } = {}) =>
  audit.verify({ successTests: [t], audit: a, registry: registry ?? [pageOf(studies)], verifiedAt,
    records: records ?? [...new Set(a.rows.flatMap((r) => r.publications ?? []))].map(pubmedOf) });
const study = (id) => clone(REG.registryPage.studies.find((s) => s.protocolSection.identificationModule.nctId === id));

/* ------------------------------------------------------------ registry audit, driver */

test('registry audit golden cases: the complete real audit passes, each defect fails with its row named', () => {
  for (const c of REG.cases) {
    const r = runAudit(c.audit);
    assert.equal(r.status, c.status, c.name);
    if (c.findings) assert.deepEqual(r.findings, c.findings, c.name);
    for (const code of c.findingCodes ?? []) assert.ok(codes(r.findings).includes(code), `${c.name}: ${r.findings.join(' | ')}`);
  }
});

test('every registry audit finding is a code and a plain reason that fits the driver result limit', () => {
  const a = clone(REG.cases[0].audit);
  a.rows[0].whyStopped = 'x';
  a.rows[1].quote = 'Not in the record at all';
  a.rows.push({ nct: 'NCT09999999', publications: [] });
  a.summary.unreported = '2';
  const r = runAudit(a);
  assert.equal(r.status, 'fail');
  for (const f of r.findings) {
    assert.match(f, /^[a-z_]+:\S+ — \S/);
    assert.ok(Buffer.byteLength(f) <= 512);
  }
  assert.ok(codes(r.findings).includes('row_not_in_query:NCT09999999'));
  assert.ok(codes(r.findings).includes('row_quote_not_in_registry:NCT01913301.quote'));
  assert.ok(r.findings.some((f) => f.includes('something that is not a count')), 'a submitted value is never echoed');
});

test('only studies first posted by observedAt count; a later one is neither required nor allowed', () => {
  const late = study('NCT01913301');
  late.protocolSection.identificationModule.nctId = 'NCT09000001';
  late.protocolSection.statusModule.studyFirstPostDateStruct.date = '2026-11-10';
  const studies = [...REG.registryPage.studies, late];
  const base = clone(REG.cases[0].audit);
  base.observedAt = '2026-11-09T12:00:00Z';
  assert.equal(runAudit(base, { studies }).status, 'pass');
  const extra = clone(base);
  extra.rows.push({ ...clone(base.rows[1]), nct: 'NCT09000001' });
  extra.summary.unreported = 3;
  assert.ok(codes(runAudit(extra, { studies }).findings).includes('row_posted_after_observed:NCT09000001'));
});

test('a record updated after observedAt may differ: reported, not failed', () => {
  const changed = study('NCT01913301');
  changed.protocolSection.statusModule.whyStopped = 'Sponsor lost funding (updated)';
  changed.protocolSection.statusModule.lastUpdatePostDateStruct.date = '2026-11-10';
  const studies = REG.registryPage.studies.map((s) => (s.protocolSection.identificationModule.nctId === 'NCT01913301' ? changed : s));
  const a = clone(REG.cases[0].audit);
  a.observedAt = '2026-11-09T23:00:00Z';
  const r = runAudit(a, { studies });
  assert.equal(r.status, 'pass');
  assert.ok(r.findings.includes('copy_changed_since_observed:NCT01913301.whyStopped'));
});

test('a RESULT reference the registry lists must be among the publications; listed PubMed IDs must exist', () => {
  const withRef = study('NCT01913301');
  withRef.protocolSection.referencesModule = { references: [{ pmid: '24400341', type: 'RESULT', citation: 'FIXTURE' }, { pmid: '11571237', type: 'BACKGROUND' }] };
  const studies = REG.registryPage.studies.map((s) => (s.protocolSection.identificationModule.nctId === 'NCT01913301' ? withRef : s));
  const r = runAudit(REG.cases[0].audit, { studies });
  assert.deepEqual(codes(r.findings), ['row_result_reference_missing:NCT01913301:24400341']);
  const a = clone(REG.cases[0].audit);
  a.rows[0].publications = ['24400341', '99999999'];
  const missing = runAudit(a, { records: [pubmedOf('24400341'), { kind: 'pubmed', id: '99999999', status: 200, body: bytes({ result: { uids: [], 99999999: { uid: '99999999', error: 'cannot get document summary' } } }) }] });
  assert.ok(codes(missing.findings).includes('publication_not_found:pubmed:99999999'));
  a.rows[0].publications = ['024400341'];
  assert.ok(codes(runAudit(a).findings).includes('row_publications_invalid:NCT01417663.publications'));
});

test('unread query pages or PubMed records are unverifiable, never a pass or a fail', () => {
  const ok = REG.cases[0].audit;
  assert.equal(runAudit(ok, { registry: [{ status: 0, body: null, error: 'timeout' }] }).status, 'unverifiable');
  assert.equal(runAudit(ok, { registry: [pageOf(REG.registryPage.studies, 'NEXT')] }).findings[0], 'registry_unreadable:registry_more_pages_than_read');
  assert.equal(runAudit(ok, { records: [{ kind: 'pubmed', id: '24400341', status: 0, body: null, error: 'rate_limited' }] }).status, 'unverifiable');
  // A wrong row still fails while a record is unread: the submitter can fix it now.
  assert.equal(runAudit(REG.cases[1].audit, { records: [] }).status, 'fail');
});

test('observedAt must be a recent UTC time and query the pinned URL', () => {
  const a = clone(REG.cases[0].audit);
  a.observedAt = '2026-10-01T00:00:00Z';
  assert.ok(codes(runAudit(a).findings).includes('observed_at_too_old:observedAt'));
  a.observedAt = '2026-11-12T00:00:00Z';
  assert.ok(codes(runAudit(a).findings).includes('observed_at_in_future:observedAt'));
  a.observedAt = '10 Nov 2026';
  assert.ok(codes(runAudit(a).findings).includes('observed_at_invalid:observedAt'));
  const q = clone(REG.cases[0].audit);
  q.query += '&filter.overallStatus=COMPLETED';
  assert.ok(codes(runAudit(q).findings).includes('query_mismatch:query'));
});

test('census summaries count a nested field, and no_publication rows are exact', () => {
  const t = { ...clone(REG.successTest), copy: ['hasResults'], publications: false, registryQuotes: ['outcomes[].quote'],
    summary: { field: 'outcomes[].category', values: ['exercise', 'vascular', 'other'], noPublication: null } };
  const rows = [
    { nct: 'NCT01417663', hasResults: false, outcomes: [{ category: 'vascular', quote: '0 and 12 months' }] },
    { nct: 'NCT01913301', hasResults: false, outcomes: [{ category: 'exercise', quote: 'Exercise Tolerance' }] },
    { nct: 'NCT00662116', hasResults: false, outcomes: [{ category: 'exercise', quote: '6 Minute Walk Test' }, { category: 'other', quote: 'week 24' }] },
  ];
  const census = { observedAt: '2026-11-10T00:00:00Z', query: t.query, rows, summary: { exercise: 2, vascular: 1, other: 1 } };
  assert.deepEqual(runAudit(census, { test: t }).status, 'pass');
  census.rows[2].outcomes[1].category = 'mood';
  assert.ok(codes(runAudit(census, { test: t }).findings).includes('row_value_invalid:NCT00662116.outcomes[].category'));

  const v = { ...clone(REG.successTest), summary: { field: 'verdict', values: ['match', 'changed', 'no_publication'], noPublication: 'no_publication' } };
  const base = clone(REG.cases[0].audit);
  base.rows = base.rows.map((r) => ({ ...r, verdict: r.publications.length ? 'match' : 'no_publication' }));
  base.summary = { match: 1, changed: 0, no_publication: 2 };
  assert.equal(runAudit(base, { test: v }).status, 'pass');
  base.rows[1].verdict = 'changed';
  base.summary = { match: 1, changed: 1, no_publication: 1 };
  assert.ok(codes(runAudit(base, { test: v }).findings).includes('row_value_invalid:NCT01913301.verdict'));
});

test('a policy test pins a plain v2 studies query and only known copy fields', () => {
  const t = REG.successTest;
  assert.equal(audit.checkTest(t), null);
  for (const query of [t.query + '&fields=NCTId', t.query + '&pageToken=x', t.query.replace('https://', 'http://'),
    'https://clinicaltrials.gov/api/v2/studies/NCT01913301', 'https://evil.example/api/v2/studies?x=1', 'https://clinicaltrials.gov/api/v2/studies?'])
    assert.equal(audit.checkTest({ ...t, query }), 'invalid_success_test', query);
  assert.equal(audit.checkTest({ ...t, copy: ['briefTitle'] }), 'invalid_success_test');
  assert.equal(audit.checkTest({ ...t, maxAgeDays: 90 }), 'invalid_success_test');
  assert.equal(audit.checkTest({ ...t, registryQuotes: ['hasResults'] }), 'invalid_success_test');
  assert.equal(audit.checkTest({ ...t, summary: { ...t.summary, noPublication: 'none' } }), 'invalid_success_test');
  assert.equal(audit.checkTest({ ...t, extra: 1 }), 'invalid_success_test');
});

/* ------------------------------------------------------------ single claim, driver */

const claimRecords = () => Object.entries(CLAIM.records).map(([key, json]) => {
  const [kind, id] = key.split(/:(.*)/s);
  return { kind, id, status: 200, body: bytes(json) };
});
const runClaim = (check, { t = CLAIM.successTest, records = claimRecords() } = {}) => claim.verify({ successTests: [t], check, records });

test('single-claim golden cases: one real record, quoted word for word where its text is returned', () => {
  for (const c of CLAIM.cases) {
    const r = runClaim(c.check);
    assert.equal(r.status, c.status, c.name);
    if (c.findings) assert.deepEqual(r.findings, c.findings, c.name);
    for (const code of c.findingCodes ?? []) assert.ok(codes(r.findings).includes(code), `${c.name}: ${r.findings.join(' | ')}`);
  }
});

test('single-claim refusals name what to fix', () => {
  const ok = CLAIM.cases[0].check;
  const cases = [
    [{ ...ok, claim: ok.claim + ' Extra.' }, 'claim_mismatch:claim'],
    [{ ...ok, verdict: 'maybe' }, 'verdict_invalid:verdict'],
    [{ ...ok, quote: 'short' }, 'quote_invalid:quote'],
    [{ ...ok, note: 'x' }, 'note_invalid:note'],
    [{ ...ok, record: { ...ok.record, id: 'nct01913301' } }, 'record_id_invalid:nct'],
    [{ ...ok, record: { kind: 'github', id: 'a/b', title: 'a/b' } }, 'record_kind_not_allowed:github'],
    [{ ...ok, record: { ...ok.record, title: 'Something else entirely about diabetes' } }, 'record_title_mismatch:nct:NCT01913301'],
    [{ ...ok, record: { kind: 'nct', id: 'NCT09999999', title: 'FIXTURE missing' } }, 'record_not_found:nct:NCT09999999'],
  ];
  for (const [check, code] of cases) {
    const records = [...claimRecords(), { kind: 'nct', id: 'NCT09999999', status: 404, body: null }];
    const r = runClaim(check, { records });
    assert.equal(r.status, 'fail', code);
    assert.ok(codes(r.findings).includes(code), `${code}: ${r.findings.join(' | ')}`);
    for (const f of r.findings) assert.ok(Buffer.byteLength(f) <= 512);
  }
  assert.equal(runClaim(ok, { records: [] }).status, 'unverifiable');
  assert.equal(runClaim({ ...ok, extra: 1 }).status, 'fail');
});

test('SV-3: a quote the checker cannot read never passes (PubMed esummary, a DOI without a Crossref abstract)', () => {
  const t = { ...CLAIM.successTest, excludedIds: [] };
  const enc = (o) => bytes(o);
  const fake = 'This randomized trial of drug X in adults with condition Y met its primary endpoint (fabricated).';
  const pubmed = { kind: 'pubmed', id: '12345678', status: 200, body: enc({ result: { 12345678: { uid: '12345678', title: 'An unrelated cohort study of something else entirely' } } }) };
  const doi = { kind: 'doi', id: '10.1000/xyz123', status: 200, body: enc({ status: 'ok', message: { DOI: '10.1000/xyz123', title: ['An unrelated paper title here'] } }) };
  for (const [rec, title] of [[pubmed, 'An unrelated cohort study of something else entirely'], [doi, 'An unrelated paper title here']]) {
    const r = runClaim({ claim: t.claim, verdict: 'refutes', record: { kind: rec.kind, id: rec.id, title }, quote: fake, note: 'The quoted trial refutes the claim directly.' }, { t, records: [rec] });
    assert.equal(r.status, 'fail', rec.kind);
    assert.ok(codes(r.findings).includes(`quote_not_checkable:${rec.kind}:${rec.id}`), r.findings.join(' | '));
    assert.equal(r.outputs.quoteChecked, false);
  }
  // A DOI whose Crossref answer carries the abstract is still checked and passes when the quote is in it.
  const withAbstract = { ...doi, body: enc({ status: 'ok', message: { DOI: '10.1000/xyz123', title: ['An unrelated paper title here'], abstract: 'We report that ' + fake } }) };
  const ok = runClaim({ claim: t.claim, verdict: 'refutes', record: { kind: 'doi', id: '10.1000/xyz123', title: 'An unrelated paper title here' }, quote: fake, note: 'The quoted trial refutes the claim directly.' }, { t, records: [withAbstract] });
  assert.equal(ok.status, 'pass');
  assert.ok(ok.findings.includes('quote_checked:true'));
});

test('single-claim identifier and title rules equal the prior-art survey driver', () => {
  const samples = [['doi', 'https://doi.org/10.1038/S43587-023-00560-5'], ['arxiv', 'arXiv:2401.01234v2'], ['github', 'https://github.com/A/B.git'],
    ['pubmed', '037'], ['pubmed', '37117524'], ['nct', 'nct04733534'], ['wikidata', 'q42'], ['doi', 'not a doi'], ['url', 'x']];
  for (const [kind, id] of samples) assert.equal(claim.normalizeId(kind, id), survey.normalizeId(kind, id), `${kind}:${id}`);
  for (const [a, b] of [['Alagebrium in heart failure', 'alagebrium in Heart-Failure'], ['A study', 'Another thing'], ['One two three four five', 'One two three four']])
    assert.equal(claim.sameTitle(a, b), survey.sameTitle(a, b), `${a} / ${b}`);
  for (const r of claimRecords()) {
    const ours = claim.readRecord(r.kind, r.id, r);
    const theirs = survey.readRecord(r.kind, r.id, r);
    assert.deepEqual(ours.titles, theirs.titles, r.id);
    assert.equal(ours.found, theirs.found);
  }
  assert.deepEqual(claim.KINDS, survey.KINDS);
});

/* ------------------------------------------------- through verifyEvidence (FIXTURE transport) */

const author = 'uain1' + 'b'.repeat(40);
const policyOf = (klass, successTest) => ({
  schema: POLICY_SCHEMA, class: klass, taskId: `T-OPP-00006-2-${klass.replace(/_/g, '-')}`, projectId: 'P-OPP-00006', criteriaDigest: 'c'.repeat(64),
  inputs: [], primarySourceHosts: klass === 'registry_audit' ? [...REGISTRY_HOSTS] : [...SURVEY_HOSTS],
  driver: { name: CLASS_DRIVERS[klass], sha256: driverDigest(CLASS_DRIVERS[klass]) }, successTests: [clone(successTest)],
});
const assignmentOf = (p) => ({ taskId: p.taskId, projectId: p.projectId, submissionId: 'CS-claim-1', author, criteriaDigest: p.criteriaDigest });
const artifactOf = (p, field, value) => ({ schema: ARTIFACT_SCHEMA, taskId: p.taskId, submissionId: 'CS-claim-1', author, [field]: value });
/** FIXTURE record API: exact URL -> JSON body; anything else is a 404. */
const fakeApi = (table) => {
  const calls = [];
  return {
    calls,
    async observe(url, { hosts, maxBytes }) {
      calls.push({ url, hosts, maxBytes });
      if (!Object.hasOwn(table, url)) return { url, status: 404, bytes: Buffer.from('{}') };
      const v = table[url];
      if (v instanceof Error) throw v;
      return { url, status: 200, bytes: Buffer.from(JSON.stringify(v)) };
    },
  };
};
const instant = () => {
  let clock = 0;
  const slept = [];
  return { sleep: async (ms) => { slept.push(ms); clock += ms; }, now: () => clock, slept };
};
const runner = createRunner({ timeoutMs: 20000 });

test('a registry audit runs end to end: pinned query reread, PubMed resolved, the hash-pinned driver decides', async () => {
  const policy = policyOf('registry_audit', REG.successTest);
  assert.deepEqual(validateTaskPolicy(policy), policy);
  const table = { [REG.successTest.query]: REG.registryPage, [surveyResolution('pubmed', '24400341').url]: REG.pubmedRecords['24400341'] };
  const api = fakeApi(table);
  const pacing = instant();
  const result = await verifyEvidence({ taskPolicy: policy, assignment: assignmentOf(policy), artifact: artifactOf(policy, 'audit', REG.cases[0].audit) },
    { retriever: api, runner, surveyPacing: pacing, clock: () => Date.parse(REG.verifiedAt) });
  assert.equal(result.verdict, 'pass', result.findings.join(' | '));
  assert.equal(result.attestation.driver.name, 'registry-audit');
  assert.equal(result.mainKpiSatisfied, false);
  assert.deepEqual(api.calls.map((c) => new URL(c.url).hostname), ['clinicaltrials.gov', 'eutils.ncbi.nlm.nih.gov']);
  assert.equal(api.calls[0].maxBytes, 16 * 1024 * 1024);
  const failed = await verifyEvidence({ taskPolicy: policy, assignment: assignmentOf(policy), artifact: artifactOf(policy, 'audit', REG.cases[1].audit) },
    { retriever: fakeApi(table), runner, surveyPacing: instant(), clock: () => Date.parse(REG.verifiedAt) });
  assert.equal(failed.verdict, 'fail');
  assert.ok(failed.attestationDigest, 'a decided fail is attested');
});

test('a registry outage holds the result for the service; it never fails the submitter', async () => {
  const policy = policyOf('registry_audit', REG.successTest);
  const down = Object.assign(new Error('busy'), { code: 'unexpected_status', status: 503 });
  const pacing = instant();
  const result = await verifyEvidence({ taskPolicy: policy, assignment: assignmentOf(policy), artifact: artifactOf(policy, 'audit', REG.cases[0].audit) },
    { retriever: fakeApi({ [REG.successTest.query]: down, [surveyResolution('pubmed', '24400341').url]: REG.pubmedRecords['24400341'] }), runner,
      surveyPacing: pacing, clock: () => Date.parse(REG.verifiedAt) });
  assert.equal(result.verdict, 'needs_evidence');
  assert.equal(result.attestationDigest, null);
  assert.ok(result.findings.some((f) => f.startsWith('verification_service_waiting:')));
  assert.deepEqual(pacing.slept.slice(0, 3), [1000, 3000, 8000], 'retried with backoff');
});

test('query pages follow nextPageToken, at most the page limit, and PubMed reads keep NCBI pacing', async () => {
  const [a, b, c] = REG.registryPage.studies;
  const q = REG.successTest.query;
  const api = fakeApi({ [q]: { studies: [a], nextPageToken: 'T2' }, [`${q}&pageToken=T2`]: { studies: [b], nextPageToken: 'T3' }, [`${q}&pageToken=T3`]: { studies: [c] } });
  const pages = await registryPages(q, api, { sleep: async () => {} });
  assert.equal(pages.length, 3);
  assert.deepEqual(audit.readRegistry(pages).byId.size, 3);
  const capped = await registryPages(q, fakeApi({ [q]: { studies: [a], nextPageToken: 'T2' }, [`${q}&pageToken=T2`]: { studies: [b], nextPageToken: 'T3' } }), { sleep: async () => {}, maxPages: 2 });
  assert.equal(audit.readRegistry(capped).unreadable, 'registry_more_pages_than_read');

  const policy = policyOf('registry_audit', REG.successTest);
  const rows = clone(REG.cases[0].audit);
  rows.rows[1].publications = ['31000001', '31000002'];
  rows.rows[1].reporting = 'published_only';
  rows.summary = { posted_and_published: 0, posted_only: 0, published_only: 2, unreported: 1 };
  const table = { [q]: REG.registryPage };
  for (const id of ['24400341', '31000001', '31000002']) table[surveyResolution('pubmed', id).url] = pubmedOf(id).body && JSON.parse(Buffer.from(pubmedOf(id).body).toString());
  const timed = fakeApi(table);
  const pacing = instant();
  const reads = [];
  const observe = timed.observe;
  timed.observe = async (url, o) => { reads.push({ host: new URL(url).hostname, at: pacing.now() }); return observe(url, o); };
  const result = await verifyEvidence({ taskPolicy: policy, assignment: assignmentOf(policy), artifact: artifactOf(policy, 'audit', rows) },
    { retriever: timed, runner, surveyPacing: pacing, clock: () => Date.parse(REG.verifiedAt) });
  assert.equal(result.verdict, 'pass', result.findings.join(' | '));
  const ncbi = reads.filter((r) => r.host === 'eutils.ncbi.nlm.nih.gov').map((r) => r.at);
  assert.equal(ncbi.length, 3);
  for (let i = 1; i < ncbi.length; i += 1) assert.ok(ncbi[i] - ncbi[i - 1] >= 334, `NCBI reads ${ncbi[i] - ncbi[i - 1]} ms apart (limit 3 a second)`);
});

test('a single-claim check runs end to end, reading a trial in full so its quote can be checked', async () => {
  const policy = policyOf('single_claim_check', CLAIM.successTest);
  assert.deepEqual(validateTaskPolicy(policy), policy);
  const url = claimResolution('nct', 'NCT01913301').url;
  assert.equal(new URL(url).search, '', 'the full record, not the identification module');
  assert.notEqual(url, surveyResolution('nct', 'NCT01913301').url);
  const api = fakeApi({ [url]: CLAIM.records['nct:NCT01913301'] });
  const result = await verifyEvidence({ taskPolicy: policy, assignment: assignmentOf(policy), artifact: artifactOf(policy, 'check', CLAIM.cases[0].check) },
    { retriever: api, runner, surveyPacing: instant() });
  assert.equal(result.verdict, 'pass', result.findings.join(' | '));
  assert.ok(result.findings.includes('quote_checked:true'));
  assert.equal(api.calls.length, 1);
  const wrong = await verifyEvidence({ taskPolicy: policy, assignment: assignmentOf(policy), artifact: artifactOf(policy, 'check', CLAIM.cases[2].check) },
    { retriever: fakeApi({ [url]: CLAIM.records['nct:NCT01913301'] }), runner, surveyPacing: instant() });
  assert.equal(wrong.verdict, 'fail');
});

test('policies of the new classes are strict, and a submitter cannot choose what runs', async () => {
  const bad = (klass, test, patch) => () => validateTaskPolicy({ ...policyOf(klass, test), ...patch });
  assert.throws(bad('registry_audit', REG.successTest, { primarySourceHosts: [...SURVEY_HOSTS] }), { code: 'invalid_task_policy' });
  assert.throws(bad('registry_audit', REG.successTest, { inputs: [{ url: 'https://clinicaltrials.gov/x', sha256: 'a'.repeat(64), bytes: 1 }] }), { code: 'invalid_task_policy' });
  assert.throws(bad('registry_audit', { ...REG.successTest, query: REG.successTest.query + '&fields=x' }, {}), { code: 'invalid_task_policy' });
  assert.throws(bad('single_claim_check', CLAIM.successTest, { primarySourceHosts: [...REGISTRY_HOSTS] }), { code: 'invalid_task_policy' });
  assert.throws(bad('single_claim_check', { ...CLAIM.successTest, kinds: ['url'] }, {}), { code: 'invalid_task_policy' });
  assert.throws(bad('single_claim_check', CLAIM.successTest, { driver: { name: 'prior-art-survey', sha256: driverDigest('prior-art-survey') } }), { code: 'invalid_task_policy' });
  const policy = policyOf('single_claim_check', CLAIM.successTest);
  const artifact = { ...artifactOf(policy, 'check', CLAIM.cases[0].check), driver: 'finite-math-witness', verdict: 'pass' };
  const result = await verifyEvidence({ taskPolicy: policy, assignment: assignmentOf(policy), artifact }, { retriever: fakeApi({}), runner, surveyPacing: instant() });
  assert.equal(result.verdict, 'fail');
  assert.ok(result.findings.includes('artifact_supplied_attestation_rejected:verdict'));
});

test('version-2 native attestations cover every record class', () => {
  assert.deepEqual([...RECORD_CLASSES], ['prior_art_survey', 'registry_audit', 'single_claim_check']);
  const policy = policyOf('single_claim_check', CLAIM.successTest);
  const network = { chainId: 'uain-shadow-20261008-1', genesisSha256: '54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff' };
  const nativeEvidence = JSON.stringify(artifactOf(policy, 'check', CLAIM.cases[0].check));
  const facts = nativeArtifactV2({ policy, assignment: assignmentOf(policy), nativeEvidence, network });
  assert.equal(facts.artifact.check.verdict, 'supports');
});

/* ------------------------------------------------- claim-check tasks from an accepted survey */

test('each gap of an accepted survey becomes one small claim-check task the fixed verifier decides', async () => {
  const { buildClaimCheckPayloads, parseClaimTaskId, splitClaimCriteria, CLAIM_MARKER, CLAIM_SOLVER_UNITS, CLAIM_REVIEWER_UNITS } = await import('../src/claim-tasks.mjs');
  const { SURVEY_PART_SOLVER_UNITS_PER_RECORD, SURVEY_PART_REVIEWER_UNITS } = await import('../src/survey.mjs');
  const accepted = {
    mainKpi: 'FIXTURE Main KPI: alagebrium restores exercise tolerance in diastolic heart failure.', asOf: '2026-11-10',
    items: [{ kind: 'nct', id: 'NCT00662116', title: 'BREAK-DHF-I', relation: 'partial', note: 'FIXTURE terminated trial.' },
      { kind: 'pubmed', id: '24400341', title: 'Crosslink breaker and exercise', relation: 'adjacent', note: 'FIXTURE vascular study.' }],
    conclusion: { meetsMainKpi: false, gaps: [CLAIM.successTest.claim, 'No trial has reported long-term safety of alagebrium beyond 24 weeks.', 'short'] },
  };
  const built = buildClaimCheckPayloads({ projectId: 'OPP-00006', title: 'Break the crosslinks that stiffen aging tissue', surveyTask: 'T-OPP-00006-1-prior-art-survey',
    survey: accepted, submissionDigest: 'e'.repeat(64), driverSha256: driverDigest('single-claim'), start: 1 });
  assert.equal(built.length, 2, 'a gap under 20 bytes is not a claim');
  for (const [i, { payload, policy, evidence }] of built.entries()) {
    assert.deepEqual(parseClaimTaskId(payload.id), { projectId: 'OPP-00006', n: i + 1 });
    assert.deepEqual(validateTaskPolicy(policy), policy);
    assert.equal(policy.criteriaDigest, payload.acceptance_digest);
    assert.ok(Buffer.byteLength(payload.criteria) <= 4096 && Buffer.byteLength(payload.title) <= 240);
    assert.deepEqual(policy.successTests[0].excludedIds, [{ kind: 'nct', id: 'NCT00662116' }, { kind: 'pubmed', id: '24400341' }]);
    assert.ok(!policy.successTests[0].kinds.includes('pubmed') && !/PubMed/.test(payload.criteria), 'SV-3: a kind whose quote cannot be checked is not offered');
    // SV-4: the member-written gap sits only at the end, after the fixed marker, as one JSON string.
    const split = splitClaimCriteria(payload.criteria);
    assert.equal(split.claim, policy.successTests[0].claim);
    assert.ok(!split.trusted.includes(policy.successTests[0].claim), 'no gap text in the trusted part');
    assert.equal(split.trusted + CLAIM_MARKER + JSON.stringify(split.claim), payload.criteria);
    // The C1 rate of a one-record survey part.
    assert.equal(BigInt(payload.solver_amount), SURVEY_PART_SOLVER_UNITS_PER_RECORD);
    assert.equal(payload.reviewer_amount, SURVEY_PART_REVIEWER_UNITS);
    assert.deepEqual([payload.solver_amount, payload.reviewer_amount], [CLAIM_SOLVER_UNITS, CLAIM_REVIEWER_UNITS]);
    assert.equal(evidence.policyDigest.length, 64);
  }
  // The golden check, aimed at the first built task, passes the pinned driver end to end.
  const [first] = built;
  const url = claimResolution('nct', 'NCT01913301').url;
  const result = await verifyEvidence({ taskPolicy: first.policy,
    assignment: { taskId: first.policy.taskId, projectId: first.policy.projectId, submissionId: 'CS-claim-2', author, criteriaDigest: first.policy.criteriaDigest },
    artifact: { schema: ARTIFACT_SCHEMA, taskId: first.policy.taskId, submissionId: 'CS-claim-2', author, check: CLAIM.cases[0].check } },
  { retriever: fakeApi({ [url]: CLAIM.records['nct:NCT01913301'] }), runner, surveyPacing: instant() });
  assert.equal(result.verdict, 'pass', result.findings.join(' | '));
  // A record the survey cites is refused; a survey that met the Main KPI opens no claim checks.
  const cited = await verifyEvidence({ taskPolicy: first.policy,
    assignment: { taskId: first.policy.taskId, projectId: first.policy.projectId, submissionId: 'CS-claim-3', author, criteriaDigest: first.policy.criteriaDigest },
    artifact: { schema: ARTIFACT_SCHEMA, taskId: first.policy.taskId, submissionId: 'CS-claim-3', author, check: CLAIM.cases[3].check } },
  { retriever: fakeApi({ [claimResolution('nct', 'NCT00662116').url]: { protocolSection: { identificationModule: { nctId: 'NCT00662116', briefTitle: CLAIM.cases[3].check.record.title } } } }), runner, surveyPacing: instant() });
  assert.equal(cited.verdict, 'fail');
  assert.equal(splitClaimCriteria('FIXTURE criteria without a claim marker'), null);
  assert.equal(splitClaimCriteria(`x${CLAIM_MARKER}not json`), null);
  assert.throws(() => buildClaimCheckPayloads({ projectId: 'OPP-00006', title: 'x', surveyTask: 'T-OPP-00006-1-prior-art-survey',
    survey: { ...accepted, conclusion: { meetsMainKpi: true, gaps: [] } }, submissionDigest: 'e'.repeat(64), driverSha256: driverDigest('single-claim') }), { code: 'survey_found_solution' });
  assert.throws(() => buildClaimCheckPayloads({ projectId: 'OPP-00006', title: 'x', surveyTask: 'T-OPP-00007-1-prior-art-survey',
    survey: accepted, submissionDigest: 'e'.repeat(64), driverSha256: driverDigest('single-claim') }), { code: 'invalid_claim_task' });
});

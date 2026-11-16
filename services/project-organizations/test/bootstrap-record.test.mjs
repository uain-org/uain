import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { buildOpenProjectPayload, validateBootstrapReview } from '../src/bootstrap.mjs';
import { createPriorArtSearch, PRIOR_ART_PRODUCER_ID } from '../src/prior-art.mjs';
import { BOOTSTRAP_DRAFTER_ID, PROMOTION_HOLDS, promoteDraft, validateDraft } from '../src/bootstrap-record.mjs';
import { draftProject, pacedRetriever, runDrafter, summarizeDrafts } from '../ops/draft-bootstrap.mjs';
import { OrganizationError, sha256 } from '../src/common.mjs';

/* All retrievals below are FIXTURES; no network is used. */
const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
const selection = await loadSelection({ current: catalogue });
const ID = 'OPP-00002';
const SOURCES = ['github_repositories', 'arxiv', 'crossref_works'];
const NOW = Date.parse('2026-11-06T12:00:00Z');
let tick = 0;
const clock = () => NOW + (tick += 1000);

const BODIES = {
  'api.github.com': () => JSON.stringify({ total_count: 1, items: [{ full_name: 'lab/senolytics', description: 'Senolytic helpers' }] }),
  'api.crossref.org': () => JSON.stringify({ message: { 'total-results': 1, items: [{ DOI: '10.1000/abc', title: ['Senescent cell clearance'] }] } }),
  'export.arxiv.org': () => '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2601.00001v1</id><title>Zombie cells</title></entry></feed>',
};
function fakeRetriever({ fail = {}, calls = [] } = {}) {
  return {
    calls,
    async observe(url, { hosts }) {
      const host = new URL(url).hostname;
      calls.push(url);
      assert.deepEqual(hosts, [host]);
      if (fail[host]) throw new OrganizationError(fail[host]);
      const bytes = Buffer.from(BODIES[host]());
      return { url, bytes, sha256: sha256(bytes) };
    },
  };
}
const searchWith = (retriever) => createPriorArtSearch({ sources: SOURCES, retriever, clock });
const project = selection.get(ID);
const row = catalogue.records.get(ID);
const draftOf = (retriever = fakeRetriever()) => draftProject({ project, row, revision: catalogue.revision, search: searchWith(retriever), clock, sources: SOURCES });
const review = (a = {}, cls = 'benevolent') => ({
  class: cls,
  assessment: { openSolutionFound: false, knownAnswer: false, reviewer: 'reviewer-independent-9',
    rationale: 'Read every listed repository and paper; none delivers a yearly senolytic treatment.', ...a },
});
const refuses = (fn, code) => assert.throws(fn, (e) => (assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`), true));
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'bootstrap-drafts-'));
  dirs.push(d);
  return d;
};

test('a draft binds the exact catalogue title and every search to URL+sha256, and decides nothing', async () => {
  const retriever = fakeRetriever();
  const draft = await draftOf(retriever);
  assert.equal(draft.status, 'assessment_required');
  assert.equal(draft.title, row.title);
  assert.equal(draft.source_digest, project.sourceDigest);
  assert.equal(draft.native_project, 'P-' + ID);
  assert.equal(draft.class, null);
  assert.equal(draft.assessment, null);
  assert.ok(!('openSolutionFound' in draft) && !('knownAnswer' in draft));
  assert.match(draft.note, /independent reviewer/);
  assert.equal(draft.producer.criteriaDigest, sha256(row.description));
  assert.equal(draft.searches.length, 6);
  for (const [i, s] of draft.searches.entries()) {
    const r = draft.retrievals[i];
    assert.ok(s.resultSummary.startsWith(`url=${r.finalUrl}; sha256=${r.sha256}; `));
    assert.equal(r.sha256, sha256(Buffer.from(BODIES[new URL(r.url).hostname]())));
  }
  // Queries come only from the catalogue title and description, and Semantic Scholar is never called.
  assert.deepEqual(draft.queries, [...new Set(draft.searches.map((s) => s.query))]);
  assert.ok(retriever.calls.every((u) => !u.includes('semanticscholar')));
});

test('failures are recorded per source; under two successful searches the draft is insufficient', async () => {
  const partial = await draftOf(fakeRetriever({ fail: { 'api.github.com': 'unexpected_status' } }));
  assert.equal(partial.status, 'assessment_required');
  assert.deepEqual(partial.failures.map((f) => [f.source, f.code]), [['github_repositories', 'unexpected_status'], ['github_repositories', 'unexpected_status']]);
  const none = await draftOf(fakeRetriever({ fail: { 'api.github.com': 'unexpected_status', 'export.arxiv.org': 'timeout', 'api.crossref.org': 'timeout' } }));
  assert.equal(none.status, 'insufficient_searches');
  assert.equal(none.searches.length, 0);
  refuses(() => promoteDraft(none, review()), 'insufficient_searches');
});

test('a changed catalogue row is refused before any search', async () => {
  const calls = [];
  await assert.rejects(draftProject({ project, row: { ...row, title: 'Another title entirely' }, revision: catalogue.revision,
    search: searchWith(fakeRetriever({ calls })), clock, sources: SOURCES }), (e) => e.code === 'selected_source_changed');
  assert.equal(calls.length, 0);
});

test('the drafter is resume-safe: drafted projects are skipped, insufficient ones retried', async () => {
  const out = tmp();
  const only = ['OPP-00002', 'OPP-00003'];
  const first = await runDrafter({ selection, catalogue, search: searchWith(fakeRetriever()), out, sources: SOURCES, only, clock });
  assert.deepEqual(first.map((o) => o.outcome), ['drafted', 'drafted']);
  const before = readFileSync(join(out, 'OPP-00002.json'), 'utf8');
  // Make OPP-00003 insufficient; the next run redrafts only it.
  const weak = await draftProject({ project: selection.get('OPP-00003'), row: catalogue.records.get('OPP-00003'), revision: catalogue.revision,
    search: searchWith(fakeRetriever({ fail: { 'api.github.com': 'timeout', 'export.arxiv.org': 'timeout', 'api.crossref.org': 'timeout' } })), clock, sources: SOURCES });
  writeFileSync(join(out, 'OPP-00003.json'), JSON.stringify(weak));
  const calls = [];
  const second = await runDrafter({ selection, catalogue, search: searchWith(fakeRetriever({ calls })), out, sources: SOURCES, only, clock });
  assert.deepEqual(second.map((o) => [o.id, o.outcome]), [['OPP-00002', 'skipped'], ['OPP-00003', 'drafted']]);
  assert.equal(readFileSync(join(out, 'OPP-00002.json'), 'utf8'), before);
  assert.equal(calls.length, 6);
  // A corrupt file is redrafted, not trusted.
  writeFileSync(join(out, 'OPP-00002.json'), '{"schema":"x"}');
  const third = await runDrafter({ selection, catalogue, search: searchWith(fakeRetriever()), out, sources: SOURCES, only, clock });
  assert.deepEqual(third.map((o) => o.outcome), ['drafted', 'skipped']);
  const summary = summarizeDrafts(out);
  assert.deepEqual([summary.drafts, summary.assessment_required, summary.searches], [2, 2, 12]);
  assert.deepEqual(summary.successBySource, { github_repositories: 4, arxiv: 4, crossref_works: 4 });
});

test('pacing spaces each host by its interval and retries a refused request once', async () => {
  let t = 0;
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
    t += ms;
  };
  let n = 0;
  const base = { async observe(url) {
    n += 1;
    if (n === 2) throw new OrganizationError('unexpected_status');
    if (n === 4) throw new OrganizationError('host_not_allowed');
    return { url };
  } };
  const paced = pacedRetriever(base, { intervals: { 'api.github.com': 6500 }, retryDelays: { 'api.github.com': 65000 }, sleep, now: () => t });
  await paced.observe('https://api.github.com/a', {});
  await paced.observe('https://api.github.com/b', {}); // refused once, retried after the backoff
  // The backoff already exceeds the interval, so the retry itself does not wait again.
  assert.deepEqual(sleeps, [6500, 65000]);
  await assert.rejects(paced.observe('https://api.github.com/c', {}), (e) => e.code === 'host_not_allowed'); // not retryable
  assert.deepEqual(sleeps, [6500, 65000, 6500]);
  assert.equal(n, 4);
});

test('promotion builds the exact reviewed record bootstrap.mjs accepts', async () => {
  const draft = await draftOf();
  const record = promoteDraft(draft, review({ searchesDigest: draft.searches_digest }), { selection });
  assert.deepEqual(Object.keys(record), ['schema', 'project', 'source_digest', 'class', 'prior_art']);
  assert.equal(record.class, 'benevolent');
  assert.equal(record.prior_art.searches.length, 6);
  for (const [i, s] of record.prior_art.searches.entries()) {
    assert.ok(s.includes(`url=${draft.retrievals[i].finalUrl}`) && s.endsWith(`sha256=${draft.retrievals[i].sha256}`));
  }
  assert.ok(record.prior_art.basis.startsWith('Independent review by reviewer-independent-9:'));
  assert.ok(record.prior_art.basis.includes(draft.searches_digest));
  validateBootstrapReview(record, project);
  const payload = buildOpenProjectPayload({ selection, projectId: ID, source: { row, revision: catalogue.revision }, review: record });
  assert.equal(payload.title, row.title);
  assert.equal(payload.class, 'benevolent');
  assert.deepEqual(payload.prior_art.searches, record.prior_art.searches);
  assert.equal(promoteDraft(draft, review({}, 'neutral')).class, 'neutral');
});

test('promotion refuses the drafting step, the proposing model, short rationale and tampered searches', async () => {
  const draft = await draftOf();
  refuses(() => promoteDraft(draft, review({ reviewer: PRIOR_ART_PRODUCER_ID })), 'reviewer_not_independent');
  refuses(() => promoteDraft(draft, review({ reviewer: BOOTSTRAP_DRAFTER_ID })), 'reviewer_not_independent');
  refuses(() => promoteDraft(draft, review({ reviewer: 'manager-model-1' }), { excludedReviewers: ['manager-model-1'] }), 'reviewer_not_independent');
  refuses(() => promoteDraft(draft, review({ rationale: 'looks new to me' })), 'invalid_assessment');
  refuses(() => promoteDraft(draft, review({ knownAnswer: 'false' })), 'invalid_assessment');
  refuses(() => promoteDraft(draft, review({ extra: true })), 'invalid_assessment');
  refuses(() => promoteDraft(draft, review({ searchesDigest: 'f'.repeat(64) })), 'assessment_digest_mismatch');
  refuses(() => promoteDraft(draft, review({}, 'harmful')), 'invalid_review');
  refuses(() => promoteDraft(draft, { ...review(), note: 'x' }), 'invalid_review');
  refuses(() => promoteDraft({ ...draft, class: 'benevolent' }, review()), 'draft_already_assessed');
  const tampered = structuredClone(draft);
  tampered.searches[0].query = 'a different query';
  tampered.retrievals[0].query = 'a different query';
  refuses(() => promoteDraft(tampered, review()), 'draft_digest_mismatch');
  const rebound = structuredClone(draft);
  rebound.retrievals[0].sha256 = 'e'.repeat(64);
  refuses(() => promoteDraft(rebound, review()), 'draft_binding_mismatch');
  const stale = structuredClone(draft);
  stale.source_digest = 'd'.repeat(64);
  refuses(() => promoteDraft(stale, review(), { selection }), 'prior_art_review_stale');
  // Under two searches is never promotable.
  const one = structuredClone(draft);
  one.searches = one.searches.slice(0, 1);
  one.retrievals = one.retrievals.slice(0, 1);
  refuses(() => promoteDraft(one, review()), 'draft_digest_mismatch');
});

test('an open solution or a known answer returns a hold, never a record', async () => {
  const draft = await draftOf();
  const open = promoteDraft(draft, review({ openSolutionFound: true }, null));
  assert.equal(open.status, 'held');
  assert.equal(open.reason, 'prior_art_open_solution_found');
  assert.ok(!('schema' in open) && !('prior_art' in open));
  const known = promoteDraft(draft, review({ knownAnswer: true }));
  assert.equal(known.reason, 'prior_art_known_answer');
  assert.ok(PROMOTION_HOLDS.includes(open.reason) && PROMOTION_HOLDS.includes(known.reason));
  // Without a promoted record the bootstrap holds the project.
  refuses(() => validateBootstrapReview(null, project), 'prior_art_review_required');
  // The hold check still requires an independent reviewer.
  refuses(() => promoteDraft(draft, review({ openSolutionFound: true, reviewer: PRIOR_ART_PRODUCER_ID })), 'reviewer_not_independent');
  assert.equal(validateDraft(draft), draft);
});

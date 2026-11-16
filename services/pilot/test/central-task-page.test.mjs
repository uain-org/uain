// The page of one central (BAINK) task on uain.global (16 November 2026). Links to central tasks
// used to open BAINK's survey-template JSON, which BAINK refuses to a click from another site.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const page = await import('../dist/src/api/central-task-page.js');
const central = await import('../dist/src/native/central-discovery.js');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const ID = 'T-OPP-05761-1-prior-art-survey-r6-p3';
const CRITERIA = 'Prior-art survey part 3 of 3 for "Sequence the genome of every known species on Earth". Main KPI: "2,000,000 species with a reference genome". A small unit, expected within 20 minutes: check these 2 identifiers the project-level searches returned against this Main KPI: doi 10.1073/pnas.2115642118; doi 10.1038/s41586-019-1693-2. Report them as an evidence artifact whose "survey" field is {mainKpi, asOf, items, conclusion}. <script>alert(1)</script>';
const task = (over = {}) => ({
  id: ID, project: 'P-OPP-05761', title: 'Prior-art survey: Sequence the genome of every known species on Earth (part 3 of 3)',
  criteria: CRITERIA, acceptance_digest: sha(CRITERIA), eligibility: 'new', eligibility_digest: '1'.repeat(64),
  solver_amount: '40000000', reviewer_amount: '10000000', evidence_digest: '2'.repeat(64),
  state: 'open', pending: '', winner: '', reserved: '50000000', paid: '0', ...over,
});

test('central task shape check is the one discovery uses', () => {
  assert.equal(central.centralTaskShape(task(), ID), true);
  assert.equal(central.centralTaskShape(task(), ID, 'P-OPP-05761'), true);
  assert.equal(central.centralTaskShape(task(), ID, 'P-other'), false);
  assert.equal(central.centralTaskShape(task({ acceptance_digest: '0'.repeat(64) }), ID), false, 'criteria must match their digest');
  assert.equal(central.centralTaskShape(task(), 'T-other'), false);
});

test('survey part criteria read as the goal, the time and the records to check', () => {
  const terms = page.surveyPartTerms(CRITERIA);
  assert.equal(terms.mainKpi, '2,000,000 species with a reference genome');
  assert.equal(terms.minutes, 20);
  assert.equal(terms.part, '3 of 3');
  assert.deepEqual(terms.ids, [{ kind: 'doi', id: '10.1073/pnas.2115642118' }, { kind: 'doi', id: '10.1038/s41586-019-1693-2' }]);
  assert.equal(page.surveyPartTerms('An evidence task with no survey shape.'), null);
  assert.equal(page.identifierUrl('doi', '10.1073/pnas.2115642118'), 'https://doi.org/10.1073/pnas.2115642118');
  assert.equal(page.identifierUrl('github', 'waymo-research/waymo-open-dataset'), 'https://github.com/waymo-research/waymo-open-dataset');
  assert.equal(page.identifierUrl('arxiv', '2104.10133'), 'https://arxiv.org/abs/2104.10133');
  assert.equal(page.identifierUrl('github', 'javascript:alert(1)'), null);
  assert.equal(page.identifierUrl('other', 'x'), null);
});

test('an open task page says what it asks, what it pays and how an agent takes it, escaped', () => {
  const html = page.renderCentralTaskMain({ task: task(), held: false, projectTitle: 'Sequence the genome of every known species on Earth', winner: null, winnerName: null });
  assert.match(html, /Open: you can take it now/);
  assert.match(html, /40 Karma for an accepted answer/);
  assert.match(html, /Starter, about 20 minutes/);
  assert.match(html, /<strong>2,000,000 species with a reference genome<\/strong>/);
  assert.match(html, /href="https:\/\/doi\.org\/10\.1073\/pnas\.2115642118"/);
  assert.match(html, /do task T-OPP-05761-1-prior-art-survey-r6-p3/);
  assert.match(html, /node uain-agent\.mjs template T-OPP-05761-1-prior-art-survey-r6-p3/);
  assert.match(html, /href="\/network\/projects\/P-OPP-05761"/);
  assert.doesNotMatch(html, /<script>/, 'chain text is escaped');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="https:\/\/baink\.money\/api\/native\/central\/survey-template/, 'no link a browser click would be refused');
  assert.equal((html.match(/np-chip--/g) ?? []).length, 1, 'one state chip');
});

test('a won task shows its accepted answer with who did it, and is not offered as open', () => {
  const evidence = JSON.stringify({ author: 'uain1' + 'a'.repeat(40), schema: 'uain-evidence-artifact-v1', submissionId: 'CS-1', taskId: ID, survey: {
    asOf: '2026-11-15', mainKpi: '2,000,000 species with a reference genome',
    conclusion: { meetsMainKpi: false, gaps: ['No effort covers more than a few thousand species yet.'] },
    items: [{ kind: 'doi', id: '10.1073/pnas.2115642118', title: 'Earth BioGenome Project', relation: 'partial', note: 'A plan and early output, far from the goal.' }],
  } });
  const html = page.renderCentralTaskMain({
    task: task({ state: 'accepted', winner: 'CS-1', reserved: '0', paid: '50000000' }), held: false, projectTitle: null,
    winner: { submission: 'CS-1', author: 'uain1' + 'a'.repeat(40), state: 'accepted', evidence, amount: '40000000', height: '100', time: '2026-11-15T10:30:29.748Z' },
    winnerName: { name: "Samarth's agent", operator: 'Samarth Sharma' },
  });
  assert.doesNotMatch(html, /Open: you can take it now/);
  assert.match(html, /Answered: the accepted answer is below/);
  assert.doesNotMatch(html, /Someone else already won/);
  assert.match(html, /This task is not taking new answers/);
  assert.match(html, /The accepted answer/);
  assert.match(html, /Samarth&#39;s agent, an AI agent run by Samarth Sharma/);
  assert.match(html, /accepted 15 November 2026/);
  assert.match(html, /none of these records meets the goal yet/);
  assert.match(html, /No effort covers more than a few thousand species yet\./);
  assert.match(html, /Earth BioGenome Project/);
  assert.match(html, /Partly meets the goal: A plan and early output/);
  assert.match(html, /not peer review/);
  assert.equal(page.pointsOf('40000000'), 40);
  assert.equal(page.pointsOf('bad'), 0);
});

test('no site or pilot surface links a browser to the raw survey-template URL', async () => {
  for (const file of ['../../../components/network/member-profile.tsx', '../../../components/try/task-preview.tsx', '../../../components/network/leaderboard.tsx']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /href=\{`https:\/\/baink\.money\/api\/native\/central\/survey-template/, file);
  }
  const server = await readFile(new URL('../src/api/server.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /url:t\.how_to_contribute\?\.template/, 'the /tasks list links central tasks to their page here');
  assert.match(server, /url:'\/tasks\/'\+encodeURIComponent\(t\.id\)/);
});

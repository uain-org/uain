// FIXTURE only (P1-2, 11 November 2026): capacity boundaries of the central research reviewer.
// Local worker with fictional submissions; no native node, custody key, model, signing or network.
// Released with the worker (P1-2 archive, lineage bound and timeout re-queue, 12 November 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, stat, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openWorker, canonical, digest, verificationStatementDigest, ARCHIVE_FILE, ARCHIVE_AFTER_MS, KEEP_ENTRIES} from '../src/worker.mjs';
import {acquireTestLock} from './test-lock.mjs';

const criteria = 'FIXTURE: capacity criteria';
const X = 'uain1' + '1'.repeat(40), Y = 'uain1' + '2'.repeat(40);
const lock = process.platform === 'linux' ? {} : {acquireLock: acquireTestLock};

function world({hourly = 16, daily = 128, start = '2026-11-11T00:00:00.000Z'} = {}) {
  const subs = new Map();
  let now = Date.parse(start), providerCalls = 0;
  const evidenceOf = s => Buffer.from(subs.get(s).evidence);
  const assignment = s => {const v = subs.get(s);return {submission: s, task: v.task, reviewer: 'reviewer', author: v.author, criteria, criteria_digest: digest(Buffer.from(criteria)), evidence_digest: digest(evidenceOf(s)), proof: {verified: true}, state: 'under_review', solver_amount: '60000000', reviewer_amount: '10000000', ...(v.revises ? {revises: v.revises} : {})};};
  const statement = s => {const a = assignment(s), v = subs.get(s);return {schema: 'uain-fleet-verification-attestation-v1', domain: 'UAIN/fleet-verification-attestation/v1', environment: 'production', submission: s, author: v.author, task: v.task, project: 'P-OPP-05281', evidenceClass: 'prior_art_survey', criteriaDigest: a.criteria_digest, evidenceDigest: a.evidence_digest, policyDigest: 'a'.repeat(64), driver: {name: 'prior-art-survey', sha256: 'b'.repeat(64)}, verdict: 'pass', reproductionAttestationDigest: null, verificationDigest: 'c'.repeat(64), mainKpiSatisfied: false, attestedAt: '2026-11-10T07:00:00Z'};};
  const receiptFor = (executionId, commandDigest, decisionDigest, subject) => ({verified: true, status: 'finalized', executionId, commandDigest, decisionDigest, nativeCommandDigest: 'f'.repeat(64), receipt: {authority: 'native', finalized: true, event: {operation: 'central_review', subject, member: 'reviewer', command_digest: 'f'.repeat(64)}}});
  const answer = {assess: async () => {providerCalls++;return {verdict: 'accept', findings: ['FIXTURE model finding']};}};
  const deps = (directory, provider = answer, extra = {}) => ({directory, reviewer: 'reviewer', hourlyAttempts: hourly, dailyAttempts: daily, clock: () => new Date(now).toISOString(), ...lock, ...extra,
    source: {read: async s => structuredClone(assignment(s)), fetchEvidence: async ({submission}) => ({bytes: evidenceOf(submission), owner: subs.get(submission).author, digest: digest(evidenceOf(submission)), immutable: true, authenticated: true})},
    provider,
    custody: {readiness: async ({submission}) => {const st = statement(submission);return {ready: true, required: true, submission, attestationDigest: verificationStatementDigest(st), trusted_verification: st};},
      submitCentralReview: async body => receiptFor(body.executionId, digest(Buffer.from(canonical(body.command))), body.command.payload.verification_digest, body.decision.submission),
      readOnlyReceipt: async r => receiptFor(r.executionId, r.commandDigest, r.decisionDigest, 'x')}});
  const add = (id, author, extra = {}) => subs.set(id, {author, task: 'T-CAP-' + (subs.size + 1), evidence: '{"FIXTURE":"' + id + '"}', ...extra});
  return {subs, deps, add, tick: ms => {now += ms;}, at: () => new Date(now).toISOString(), get providerCalls() {return providerCalls;}, countCall: () => {providerCalls++;}};
}
async function dir(t) {const d = await mkdtemp(join(tmpdir(), 'reviewer-capacity-'));t.after(() => rm(d, {recursive: true, force: true}));return d;}
async function open(t, w, provider, extra) {const d = await dir(t), worker = await openWorker(w.deps(d, provider, extra));t.after(() => worker.close().catch(() => {}));return {worker, directory: d};}
const sized = n => {const head = '{"FIXTURE":"', tail = '"}';return head + 'x'.repeat(n - head.length - tail.length) + tail;};

test('evidence of exactly 16,384 bytes is reviewed; 16,385 bytes is refused before any model call or budget use (FIXTURE)', async t => {
  const w = world({hourly: 1});
  w.add('S-edge', X, {evidence: sized(16384)});w.add('S-over', Y, {evidence: sized(16385)});
  assert.equal(Buffer.byteLength(w.subs.get('S-edge').evidence), 16384);assert.equal(Buffer.byteLength(w.subs.get('S-over').evidence), 16385);
  const {worker} = await open(t, w);
  await worker.enqueue('S-over');
  await assert.rejects(worker.run('S-over'), /owned immutable evidence/);
  assert.equal(w.providerCalls, 0);assert.equal(worker.status('S-over').state, 'queued', 'refused evidence leaves the job queued, no verdict');
  // The one attempt of the hour is still free: the refused job did not spend it.
  await worker.enqueue('S-edge');const job = await worker.run('S-edge');
  assert.equal(job.state, 'completed');assert.equal(w.providerCalls, 1);
});

test('retry storm: a revision whose provider never answers uses at most 8 model calls a day and 24 in all, signs nothing, then waits for the operator (FIXTURE)', async t => {
  const w = world();
  w.add('S-storm', X, {revises: 'S-earlier'});
  // A provider that never answers and ignores the abort: the worker's own timer decides.
  const hang = {assess: () => {w.countCall();return new Promise(() => {});}};
  const {worker} = await open(t, w, hang, {timeoutMs: 5});
  await worker.enqueue('S-storm');
  const perHour = new Map(), perDay = new Map();let last;
  // Run the job every 2 minutes for 4 days (the live loop runs about every 30 seconds).
  for (let i = 0; i < 4 * 24 * 30; i++) {
    const before = w.providerCalls;last = await worker.run('S-storm');
    if (w.providerCalls > before) {const h = w.at().slice(0, 13), d = h.slice(0, 10);perHour.set(h, (perHour.get(h) ?? 0) + 1);perDay.set(d, (perDay.get(d) ?? 0) + 1);}
    w.tick(120000);
  }
  assert.ok([...perHour.values()].every(n => n <= 16), 'hourly cap holds: ' + JSON.stringify([...perHour]));
  assert.ok([...perDay.values()].every(n => n <= 8), 'lineage day bound holds: ' + JSON.stringify([...perDay]));
  assert.equal(w.providerCalls, 24, 'lineage total bound');
  assert.equal(last.state, 'uncertain');assert.equal(last.phase, 'provider');assert.equal(last.reason, 'provider_attempts_exhausted');
  assert.equal(last.decision, undefined, 'a timeout signs nothing');
  t.diagnostic(`one stuck revision used ${JSON.stringify([...perDay])} model calls a day, 24 in all`);
});

test('one submission cannot take the whole day of model calls (FIXTURE)', async t => {
  const w = world();
  w.add('S-storm', X, {revises: 'S-earlier'});w.add('S-other', Y);
  const calls = new Map();
  const provider = {assess: (input, {signal}) => {w.countCall();const s = input.trusted_verification.submission;calls.set(s, (calls.get(s) ?? 0) + 1);if (s === 'S-other') return Promise.resolve({verdict: 'accept', findings: ['FIXTURE']});return new Promise(() => {});}};
  const {worker} = await open(t, w, provider, {timeoutMs: 5});
  await worker.enqueue('S-storm');
  for (let i = 0; i < 20 * 30; i++) {await worker.run('S-storm');w.tick(120000);}
  await worker.enqueue('S-other');const other = await worker.run('S-other');
  assert.equal(other.state, 'completed', 'another member is still reviewed the same day');
  assert.ok((calls.get('S-storm') ?? 0) <= 8);
});

// Measured 11 November 2026 (Node 22): the CLI provider rejects as soon as the abort kills its child,
// and that rejection settles the timeout race first, so a timeout used to end as `uncertain` and wait
// for an operator. Since 12 November the worker knows its own timer fired: the timeout signs nothing
// and the job is tried again after a wait (15 minutes, doubling), within the lineage bound.
test('a provider that rejects on abort: the timeout is recognised, signs nothing and is retried after a wait (FIXTURE)', async t => {
  const w = world();
  w.add('S-cli', X, {revises: 'S-earlier'});
  const cliLike = {assess: (_input, {signal}) => {w.countCall();return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('provider refused or ambiguous'))));}};
  const {worker} = await open(t, w, cliLike, {timeoutMs: 5});
  await worker.enqueue('S-cli');
  const first = await worker.run('S-cli');
  assert.equal(first.state, 'queued');assert.equal(first.blocked_reason, 'provider_timeout');assert.equal(w.providerCalls, 1);
  assert.equal((await worker.run('S-cli')).blocked_reason, 'provider_timeout');assert.equal(w.providerCalls, 1, 'waits before the next try');
  w.tick(15 * 60000);await worker.run('S-cli');assert.equal(w.providerCalls, 2, 'tried again after 15 minutes');
  w.tick(15 * 60000);await worker.run('S-cli');assert.equal(w.providerCalls, 2, 'the second wait is 30 minutes');
  w.tick(15 * 60000);await worker.run('S-cli');assert.equal(w.providerCalls, 3);
  assert.equal(worker.status('S-cli').decision, undefined);assert.deepEqual(worker.pendingReconciliations(), []);
  // A provider that fails on its own (no timeout) is still ambiguous: uncertain after one call, never retried.
  w.add('S-own', Y);const own = await open(t, w, {assess: async () => {w.countCall();throw Error('provider refused or ambiguous');}});
  await own.worker.enqueue('S-own');const before = w.providerCalls;
  for (let i = 0; i < 20; i++) {await own.worker.run('S-own');w.tick(30 * 60000);}
  assert.equal(own.worker.status('S-own').state, 'uncertain');assert.equal(own.worker.status('S-own').reason, 'provider_outcome_unknown');assert.equal(w.providerCalls - before, 1);
});

test('restart in the middle of a burst: the interrupted review is never rerun and the spent attempts still count (FIXTURE)', async t => {
  const w = world({hourly: 3, daily: 6});
  for (let i = 0; i < 5; i++) w.add('S-b' + i, i % 2 ? Y : X);
  const d = await dir(t);
  let worker = await openWorker(w.deps(d));
  for (let i = 0; i < 5; i++) await worker.enqueue('S-b' + i);
  assert.equal((await worker.run('S-b0')).state, 'completed');assert.equal((await worker.run('S-b1')).state, 'completed');
  await worker.close();
  // Crash while S-b2's model call was running: the durable marker and its reserved attempt are on disk.
  const file = join(d, 'jobs.json'), db = JSON.parse(await readFile(file, 'utf8'));
  db.jobs['S-b2'].state = 'running';db.jobs['S-b2'].phase = 'provider';db.attempts.hourCount = 3;db.attempts.dayCount = 3;
  await writeFile(file, JSON.stringify(db), {mode: 0o600});
  worker = await openWorker(w.deps(d));t.after(() => worker.close().catch(() => {}));
  assert.equal(worker.status('S-b2').state, 'uncertain');assert.equal(worker.status('S-b2').reason, 'process_interrupted');
  assert.equal((await worker.run('S-b2')).state, 'uncertain', 'never rerun automatically');
  const held = await worker.run('S-b3');assert.equal(held.state, 'queued');assert.equal(held.blocked_reason, 'provider_attempt_budget');
  assert.equal(w.providerCalls, 2, 'no model call after the restart within the spent hour');
  w.tick(3600000);
  assert.equal((await worker.run('S-b3')).state, 'completed');assert.equal((await worker.run('S-b4')).state, 'completed');
  assert.equal(w.providerCalls, 4);
});

test('lifetime growth: past the old cap every review still runs; finished jobs move to write-once archive files and jobs.json stays bounded (FIXTURE)', async t => {
  const w = world({hourly: 128, daily: 1024});
  const cap = 256 * 1024 + 64 * 1024; // the 256 KiB start headroom plus 64 KiB of jobs
  const {worker, directory} = await open(t, w, undefined, {maxDatabaseBytes: cap});
  // Before 12 November about 35 of these fixture jobs filled the cap and every later review waited on database_headroom for good.
  for (let n = 0; n < 200; n++) {
    w.add('S-l' + n, n % 2 ? X : Y);await worker.enqueue('S-l' + n);const job = await worker.run('S-l' + n);
    assert.equal(job.state, 'completed', 'job ' + n + ' ' + job.blocked_reason);
    w.tick(60000);
  }
  const db = JSON.parse(await readFile(join(directory, 'jobs.json'), 'utf8'));
  assert.ok((await stat(join(directory, 'jobs.json'))).size <= cap);
  const files = (await readdir(directory)).filter(n => ARCHIVE_FILE.test(n)), archived = {};
  assert.ok(files.length > 0);
  for (const name of files) {const a = JSON.parse(await readFile(join(directory, name), 'utf8'));assert.equal(a.version, 1);for (const [k, v] of Object.entries(a.jobs)) {assert.equal(archived[k], undefined);archived[k] = v;}}
  let located = 0;
  for (let n = 0; n < 200; n++) {
    const sub = 'S-l' + n, entry = db.jobs[sub];
    assert.ok(entry || archived[sub]?.state === 'completed', 'every job is kept: ' + sub);
    if (entry?.state === 'archived') {located++;assert.equal(archived[sub].execution_id, entry.execution_id);assert.equal(archived[sub].state, 'completed');assert.ok(files.includes(entry.archive));}
    else if (entry) assert.equal(entry.state, 'completed');
  }
  assert.ok(db.jobs['S-l199'] && located > 0, 'custody\'s feedback locator finds the newest jobs');
  // An archived submission offered again is never reviewed again.
  const calls = w.providerCalls, again = Object.keys(db.jobs).find(k => db.jobs[k].state === 'archived');
  assert.equal((await worker.enqueue(again)).state, 'archived');assert.equal((await worker.run(again)).state, 'archived');assert.equal(w.providerCalls, calls);
});

test('time-based archive: completed jobs older than 7 days leave at the daily pass; queued and awaiting jobs never do (FIXTURE)', async t => {
  const w = world();
  w.add('S-old', X);w.add('S-new', Y);w.add('S-wait', X);
  const d = await dir(t);let worker = await openWorker(w.deps(d));t.after(() => worker.close().catch(() => {}));
  await worker.enqueue('S-old');assert.equal((await worker.run('S-old')).state, 'completed');await worker.enqueue('S-wait');
  w.tick(ARCHIVE_AFTER_MS);w.add('S-next', Y);await worker.enqueue('S-new');assert.equal((await worker.run('S-new')).state, 'completed');
  w.tick(86400000);await worker.enqueue('S-next');await worker.run('S-next');
  assert.equal(worker.status('S-old').state, 'archived');assert.equal(worker.status('S-new').state, 'completed');assert.equal(worker.status('S-wait').state, 'queued');
  await worker.close();worker = await openWorker(w.deps(d));
  assert.equal(worker.status('S-old').state, 'archived', 'a restart keeps the locator');assert.equal(worker.status('S-new').state, 'completed', 'one day old');
  await worker.close();w.tick(ARCHIVE_AFTER_MS);worker = await openWorker(w.deps(d));
  assert.equal(worker.status('S-new').state, 'archived', 'the start-up pass archives what is now old enough');
  assert.equal(worker.archiveStatus().error, null);
});

test('jobs.json stays under the 10,000-entry limit: above 9,000 entries the oldest locators leave, their records stay in the archive files (FIXTURE)', async t => {
  const w = world(), d = await dir(t), jobs = {}, old = '2026-10-01T00:00:00.000Z';
  for (let i = 0; i < 9100; i++) {const s = 'S-e' + i;jobs[s] = {submission: s, state: 'completed', execution_id: 'x-' + i, created_at: old, started_at: old, reconciled_at: new Date(Date.parse(old) + i * 1000).toISOString(), decision: {verdict: 'accept', completed_at: old}, command: {operation: 'central_review'}, receipt: {verified: true}};}
  await writeFile(join(d, 'jobs.json'), JSON.stringify({version: 1, jobs, attempts: {}}), {mode: 0o600});
  const worker = await openWorker(w.deps(d));t.after(() => worker.close().catch(() => {}));
  const db = JSON.parse(await readFile(join(d, 'jobs.json'), 'utf8')), entries = Object.keys(db.jobs);
  assert.ok(entries.length <= KEEP_ENTRIES && entries.length >= KEEP_ENTRIES - 1, String(entries.length));
  assert.ok(entries.every(k => db.jobs[k].state === 'archived'));assert.equal(db.jobs['S-e9099'].execution_id, 'x-9099', 'the newest locators stay');assert.equal(db.jobs['S-e0'], undefined, 'the oldest locator left');
  let kept = 0;for (const name of (await readdir(d)).filter(n => ARCHIVE_FILE.test(n))) kept += Object.keys(JSON.parse(await readFile(join(d, name), 'utf8')).jobs).length;
  assert.equal(kept, 9100, 'every record is in an archive file');
  w.add('S-fresh', X);await worker.enqueue('S-fresh');assert.equal((await worker.run('S-fresh')).state, 'completed', 'new reviews still run');
});

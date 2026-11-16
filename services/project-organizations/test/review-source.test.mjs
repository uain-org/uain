/** FIXTURE reviewer store only. The store is written by the REAL central-reviewer worker
 * (services/central-reviewer/src/worker.mjs) driven by fictional source/provider/custody
 * fakes, so the records are in exactly the format the reviewer writes. No native node,
 * keys, provider or production store is touched. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorker, canonical, digest } from '../../central-reviewer/src/worker.mjs';
import { acquireTestLock } from '../../central-reviewer/test/test-lock.mjs';
import { sha256 } from '../src/common.mjs';
import { createNativeReader } from '../src/native-reader.mjs';
import { createReviewSource, readStore } from '../src/review-source.mjs';

const refuses = (code) => (e) => (assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`), true);
const dirs = [];
const tempDir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'uain-review-source-')));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const REVIEWER = 'uain1' + 'ab'.repeat(20);
const AUTHOR = 'uain1' + 'cd'.repeat(20);
const SUB = 'S-recovery';
const evidence = Buffer.from('FICTIONAL fixed submission evidence');
const assignment = {
  submission: SUB, task: 'T-recovery', reviewer: REVIEWER, author: AUTHOR, criteria: 'Check the fixed fictional evidence',
  criteria_digest: digest(Buffer.from('Check the fixed fictional evidence')), evidence_digest: digest(evidence), proof: { verified: true }, state: 'under_review',
};
const basis = {
  schema: 'uain-trusted-reproduction-v1', digest: 'a'.repeat(64), native_binary_sha256: 'b'.repeat(64), live_source_sha256: 'c'.repeat(64),
  corrected_source_sha256: 'd'.repeat(64), reproducer_sha256: 'e'.repeat(64), before_outcome: 'failed', after_outcome: 'passed',
  reviewed_at: '2026-11-05T21:00:00.000Z', review_notes: 'FICTIONAL independently reviewed reproduction; not a live attestation',
};
const finalized = (executionId, commandDigest, decisionDigest) => ({
  verified: true, status: 'finalized', executionId, commandDigest, decisionDigest, nativeCommandDigest: 'f'.repeat(64),
  receipt: { authority: 'native', finalized: true, chain_id: 'FICTIONAL-only', event: { id: '1', height: '100', operation: 'central_review', subject: SUB, member: REVIEWER, command_digest: 'f'.repeat(64) } },
});

/** Runs the real worker: needs_evidence, then a re-review on a new basis (history kept),
 * plus a second submission left queued. Returns the store path and the execution IDs. */
async function reviewerStore() {
  const directory = join(tempDir(), 'reviewer');
  let now = '2026-11-05T20:00:00.000Z';
  let ready = null;
  let calls = 0;
  const worker = await openWorker({
    directory, reviewer: REVIEWER, clock: () => now, ...(process.platform === 'linux' ? {} : { acquireLock: acquireTestLock }),
    source: {
      read: async (id) => ({ ...structuredClone(assignment), submission: id }),
      fetchEvidence: async () => ({ bytes: evidence, owner: AUTHOR, digest: assignment.evidence_digest, immutable: true, authenticated: true }),
    },
    provider: { assess: async () => ({ verdict: ++calls === 1 ? 'needs_evidence' : 'accept', findings: ['FICTIONAL criterion finding'] }) },
    custody: {
      readiness: async () => ({ ready: true, required: !!ready, submission: SUB, criteriaDigest: assignment.criteria_digest, evidenceDigest: assignment.evidence_digest,
        attestationDigest: ready?.digest ?? null, trusted_reproduction: ready ? structuredClone(ready) : null }),
      submitCentralReview: async (body) => finalized(body.executionId, digest(Buffer.from(canonical(body.command))), body.command.payload.verification_digest),
      readOnlyReceipt: async (r) => finalized(r.executionId, r.commandDigest, r.decisionDigest),
    },
  });
  try {
    await worker.enqueue(SUB);
    const first = await worker.run(SUB);
    assert.equal(first.state, 'awaiting_evidence');
    ready = basis;
    now = '2026-11-05T21:00:01.000Z';
    const second = await worker.run(SUB);
    assert.equal(second.state, 'completed');
    assert.equal(second.history.length, 1);
    const queued = await worker.enqueue('S-queued');
    return { path: join(directory, 'jobs.json'), first: first.execution_id, second: second.execution_id, queued: queued.execution_id };
  } finally {
    await worker.close();
  }
}

test('execution IDs come from the reviewer store: current plus every historical execution', async () => {
  const s = await reviewerStore();
  const source = createReviewSource({ files: [s.path], reviewer: REVIEWER });
  assert.deepEqual(await source.executionIds(SUB), [s.first, s.second]);
  assert.deepEqual(await source.executionIds('S-queued'), [s.queued], 'a queued job has an execution that may never reach native');
  assert.deepEqual(await source.executionIds('S-unknown'), []);
  await assert.rejects(source.executionIds('bad:id'), refuses('invalid_native_submission'));
  // A different pinned reviewer refuses the record instead of trusting it.
  await assert.rejects(createReviewSource({ files: [s.path], reviewer: AUTHOR }).executionIds(SUB), refuses('review_record_reviewer_mismatch'));
});

test('store files are opened read-only and refused when symlinked, writable by others, oversized or malformed', async () => {
  const s = await reviewerStore();
  const before = readFileSync(s.path);
  const dir = tempDir();
  const link = join(dir, 'jobs-link.json');
  symlinkSync(s.path, link);
  await assert.rejects(createReviewSource({ files: [link] }).executionIds(SUB), refuses('review_store_symlink'));
  const loose = join(dir, 'loose.json');
  writeFileSync(loose, before);
  chmodSync(loose, 0o666);
  await assert.rejects(createReviewSource({ files: [loose] }).executionIds(SUB), refuses('review_store_untrusted'));
  await assert.rejects(createReviewSource({ files: [s.path], maxBytes: 16 }).executionIds(SUB), refuses('review_store_too_large'));
  await assert.rejects(createReviewSource({ files: [join(dir, 'absent.json')] }).executionIds(SUB), refuses('review_store_unreadable'));

  const write = (name, value) => {
    const p = join(dir, name);
    writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    return p;
  };
  const db = JSON.parse(before);
  await assert.rejects(createReviewSource({ files: [write('v2.json', { ...db, version: 2 })] }).executionIds(SUB), refuses('invalid_review_store'));
  await assert.rejects(createReviewSource({ files: [write('text.json', 'not json')] }).executionIds(SUB), refuses('invalid_review_store'));
  const swapped = structuredClone(db);
  swapped.jobs[SUB].decision.execution_id = 'another-execution';
  await assert.rejects(createReviewSource({ files: [write('swap.json', swapped)] }).executionIds(SUB), refuses('invalid_review_record'));
  const foreign = structuredClone(db);
  foreign.jobs[SUB].submission = 'S-other';
  await assert.rejects(createReviewSource({ files: [write('foreign.json', foreign)] }).executionIds(SUB), refuses('invalid_review_record'));
  const colon = structuredClone(db);
  colon.jobs['S-queued'].execution_id = 'not:native';
  await assert.rejects(createReviewSource({ files: [write('colon.json', colon)] }).executionIds('S-queued'), refuses('invalid_review_record'));
  // A malformed record only blocks its own submission.
  assert.deepEqual(await createReviewSource({ files: [write('colon2.json', colon)] }).executionIds(SUB), [s.first, s.second]);
  assert.deepEqual(readFileSync(s.path), before, 'the reviewer store is never written');

  for (const bad of [[], ['relative.json'], [s.path, s.path], Array(5).fill(0).map((_, i) => `/x/${i}`)])
    assert.throws(() => createReviewSource({ files: bad }), refuses('invalid_review_source'));
  assert.throws(() => createReviewSource({ files: [s.path], reviewer: 'reviewer' }), refuses('invalid_review_source'));
});

test('an unchanged store is not re-read; an atomic replacement is observed', async () => {
  const s = await reviewerStore();
  let reads = 0;
  const source = createReviewSource({
    files: [s.path],
    readFileImpl: async (p, max, known) => {
      const r = await readStore(p, max, known);
      if (r.bytes) reads++;
      return r;
    },
  });
  await source.executionIds(SUB);
  await source.executionIds(SUB);
  assert.equal(reads, 1);
  const db = JSON.parse(readFileSync(s.path));
  db.jobs['S-new'] = { submission: 'S-new', state: 'queued', execution_id: 'f0e1d2c3-0000-4000-8000-000000000001', created_at: '2026-11-06T00:00:00.000Z' };
  const temp = s.path + '.tmp';
  writeFileSync(temp, JSON.stringify(db), { mode: 0o600 });
  renameSync(temp, s.path);
  assert.deepEqual(await source.executionIds('S-new'), ['f0e1d2c3-0000-4000-8000-000000000001']);
  assert.equal(reads, 2);
});

/** FIXTURE native transport with an event log and review records only. */
function reviewChain({ chain, submission, executions, extraEvents = 0 }) {
  const pad = (n) => String(n).padStart(20, '0');
  const store = {};
  let n = 0;
  const event = (operation, subject) => {
    n++;
    store[`event/${pad(n)}`] = { id: String(n), height: '10', member: REVIEWER, operation, subject, command_digest: sha256('event ' + n) };
  };
  for (const x of executions) {
    event('central_review', submission);
    store[`central_review/${submission}/${sha256(x)}`] = { submission, execution_id: x, verdict: 'accept', reviewer: REVIEWER };
  }
  for (let i = 0; i < extraEvents; i++) event('central_review', submission);
  return {
    async publicState(selection) {
      const keys = selection.keys ?? [];
      return {
        state: { chain_id: chain, height: '20', header_time: new Date().toISOString(), event_count: String(n), app_hash: 'a'.repeat(64),
          records: Object.fromEntries(keys.map((k) => [k, structuredClone(store[k] ?? null)])) },
      };
    },
  };
}

test('native reader reviews() is supplied by the review source and still checks completeness', async () => {
  const s = await reviewerStore();
  const reviewSource = createReviewSource({ files: [s.path], reviewer: REVIEWER });
  const chain = 'uain-fixture-review-chain';
  const both = createNativeReader({ transport: reviewChain({ chain, submission: SUB, executions: [s.first, s.second] }), chainId: chain, productionChainId: 'uain-fixture-prod', reviewSource });
  assert.deepEqual((await both.reviews(SUB)).map((r) => r.execution_id), [s.first, s.second]);
  // A native review the store does not know about makes the list incomplete, never partial.
  const extra = createNativeReader({ transport: reviewChain({ chain, submission: SUB, executions: [s.first, s.second], extraEvents: 1 }), chainId: chain, productionChainId: 'uain-fixture-prod', reviewSource });
  await assert.rejects(extra.reviews(SUB), refuses('native_reviews_incomplete'));
  assert.throws(() => createNativeReader({ transport: reviewChain({ chain, submission: SUB, executions: [] }), chainId: chain, productionChainId: 'uain-fixture-prod',
    reviewSource, reviewExecutionIds: async () => [] }), refuses('invalid_native_reader_configuration'));
});

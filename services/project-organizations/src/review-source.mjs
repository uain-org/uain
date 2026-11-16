/** Read-only source of central-review execution IDs for `native-reader.mjs` `reviews()`.
 *
 * Native keys a review as `central_review/<submission>/<sha256(execution_id)>` and has no
 * review index, so the reader needs candidate execution IDs. The central reviewer
 * (services/central-reviewer/src/worker.mjs `openWorker`) records them in its store file
 * `<directory>/jobs.json` (production directory `/var/lib/uain-central-reviewer`, fixed by
 * services/central-reviewer/src/config.mjs), written atomically (temp + fsync + rename):
 *
 *   {version: 1, attempts: {...}, jobs: {<submission>: {
 *     submission, state, execution_id, created_at,
 *     assignment?, decision?: {execution_id, submission, reviewer, ...},
 *     command?: {operation: 'central_review', payload: {submission, execution_id, ...}},
 *     receipt?, rereview_count?, history?: [{execution_id, decision, command, ...}] }}}
 *
 * `execution_id` is the current execution (assigned at enqueue, replaced on an evidence
 * re-review); `history[]` keeps every earlier execution. All of them are candidates. A
 * candidate that never produced a native review reads as proven absence, and the reader
 * checks completeness against the native `central_review` events, so this source can make
 * `reviews()` refuse (incomplete) but can never make it pass on its own.
 *
 * The file is opened read-only with O_NOFOLLOW, must be a single-link regular file that is
 * not group/world-writable, at most `maxBytes` (the worker's own 64 MiB bound), and every
 * record used is validated. Parsed content is cached per (dev, inode, size, mtime, ctime), so
 * an atomic rename by the worker is observed on the next call. Nothing is ever written. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ADDRESS, NATIVE_ID, need, plain, refuse } from './common.mjs';

export const REVIEWER_STORE_VERSION = 1;
const MAX_FILES = 4;
const MAX_JOBS = 10000; // worker.mjs enqueue: queue capacity
const MAX_HISTORY = 16;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024; // worker.mjs maxDatabaseBytes

function executionOf(value) {
  need(typeof value === 'string' && NATIVE_ID.test(value), 'invalid_review_record', 'execution_id');
  return value;
}

/** Candidate IDs of one job, or a refusal code when the record is malformed. */
function jobCandidates(job, submission, reviewer) {
  need(plain(job) && job.submission === submission, 'invalid_review_record', 'submission binding');
  const current = executionOf(job.execution_id);
  const bound = (decision, command, id) => {
    if (decision !== undefined) {
      need(plain(decision) && decision.execution_id === id && decision.submission === submission, 'invalid_review_record', 'decision binding');
      if (reviewer !== null) need(decision.reviewer === reviewer, 'review_record_reviewer_mismatch');
    }
    if (command !== undefined) {
      need(plain(command) && command.operation === 'central_review' && plain(command.payload) &&
        command.payload.execution_id === id && command.payload.submission === submission, 'invalid_review_record', 'command binding');
    }
  };
  bound(job.decision, job.command, current);
  const out = [];
  if (job.history !== undefined) {
    need(Array.isArray(job.history) && job.history.length <= MAX_HISTORY, 'invalid_review_record', 'history');
    for (const h of job.history) {
      need(plain(h), 'invalid_review_record', 'history entry');
      const id = executionOf(h.execution_id);
      bound(h.decision, h.command, id);
      out.push(id);
    }
  }
  out.push(current);
  return [...new Set(out)];
}

/**
 * @param files absolute paths of central-reviewer `jobs.json` stores (1..4)
 * @param reviewer optional pinned reviewer address; decisions by anyone else are refused
 * @param readFileImpl test seam: `(path, maxBytes, knownIdentity) => {identity, bytes}` where
 *   `bytes` is null when the file still has `knownIdentity`
 */
export function createReviewSource({ files, reviewer = null, maxBytes = DEFAULT_MAX_BYTES, maxCandidates = 64, readFileImpl = readStore } = {}) {
  need(Array.isArray(files) && files.length >= 1 && files.length <= MAX_FILES && new Set(files).size === files.length &&
    files.every((f) => typeof f === 'string' && isAbsolute(f)), 'invalid_review_source', 'files');
  need(reviewer === null || (typeof reviewer === 'string' && ADDRESS.test(reviewer)), 'invalid_review_source', 'reviewer');
  need(Number.isSafeInteger(maxBytes) && maxBytes >= 2 && maxBytes <= DEFAULT_MAX_BYTES, 'invalid_review_source', 'maxBytes');
  need(Number.isSafeInteger(maxCandidates) && maxCandidates >= 1 && maxCandidates <= 512, 'invalid_review_source', 'maxCandidates');
  need(typeof readFileImpl === 'function', 'invalid_review_source');
  const cache = new Map(); // path -> {identity, jobs}

  async function jobsOf(path) {
    const hit = cache.get(path);
    const { bytes, identity } = await readFileImpl(path, maxBytes, hit?.identity ?? null);
    if (hit && hit.identity === identity && bytes === null) return hit.jobs;
    need(Buffer.isBuffer(bytes), 'review_store_unreadable');
    let db;
    try {
      db = JSON.parse(bytes.toString('utf8'));
    } catch {
      refuse('invalid_review_store', 'reviewer store is not JSON');
    }
    need(plain(db) && db.version === REVIEWER_STORE_VERSION && plain(db.jobs), 'invalid_review_store', 'reviewer store format');
    need(Object.keys(db.jobs).length <= MAX_JOBS, 'invalid_review_store', 'reviewer store exceeds the queue capacity');
    cache.set(path, { identity, jobs: db.jobs });
    return db.jobs;
  }

  return Object.freeze({
    files: Object.freeze([...files]),
    /** Every recorded execution ID for `submissionId`, current and historical, deduplicated. */
    async executionIds(submissionId) {
      need(typeof submissionId === 'string' && NATIVE_ID.test(submissionId), 'invalid_native_submission');
      const ids = [];
      for (const path of files) {
        const jobs = await jobsOf(path);
        if (!Object.hasOwn(jobs, submissionId)) continue;
        ids.push(...jobCandidates(jobs[submissionId], submissionId, reviewer));
      }
      const unique = [...new Set(ids)];
      need(unique.length <= maxCandidates, 'invalid_review_record', 'too many execution IDs for one submission');
      return unique;
    },
  });
}

/** Opens one store read-only and returns a change identity plus its bytes (null when the
 * identity equals `knownIdentity`, so an unchanged store is not re-read). */
export async function readStore(path, maxBytes, knownIdentity = null) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    refuse(error?.code === 'ELOOP' ? 'review_store_symlink' : 'review_store_unreadable', 'reviewer store could not be opened');
  }
  try {
    const st = await handle.stat();
    need(st.isFile() && st.nlink === 1, 'review_store_untrusted', 'reviewer store is not a single-link regular file');
    need((st.mode & 0o022) === 0, 'review_store_untrusted', 'reviewer store is group- or world-writable');
    need(st.size <= maxBytes, 'review_store_too_large');
    const identity = [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':');
    if (identity === knownIdentity) return { identity, bytes: null };
    const bytes = await handle.readFile();
    need(bytes.length === st.size, 'review_store_changed', 'reviewer store changed while it was read');
    return { identity, bytes };
  } finally {
    await handle.close();
  }
}

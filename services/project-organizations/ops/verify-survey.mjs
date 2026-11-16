#!/usr/bin/env node
/** Run the fixed verifier of a record class on one submission (root, for ops/custody/survey_attester.py):
 * the prior-art survey and its parts, and since 10 November 2026 registry audits and single-claim checks
 * (src/verification.mjs RECORD_CLASSES). The driver is the one the policy pins, by name and hash.
 *
 * stdin:  {policy, assignment, artifact}  (the root-owned task policy, the native submission
 *         binding custody read, and the submitted evidence artifact)
 * stdout: {verdict, findings, attestation, attestationDigest, driverSha256}
 *
 * Retrieval is the pinned-address retriever, limited to the fixed record API hosts; the
 * driver is the policy's hash-pinned file under verifiers/, run in its isolated worker. This
 * process decides nothing on trust: custody recomputes and re-checks every binding. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REGISTRY_PAGE_MAX_BYTES, SURVEY_HOSTS } from '../src/survey-sources.mjs';
import { createRetriever, createRunner, driverDigest, verifyEvidence, verifyEvidenceV2 } from '../src/verification.mjs';

/** Optional read-only GitHub token (no repository scopes; it only raises the public read quota
 * from 60 to 5000 requests an hour). Root-owned 0600 regular file; anything else is ignored and the
 * reads stay unauthenticated, with rate-limited 403s retried. Never logged or passed to the driver. */
export const GITHUB_TOKEN_PATH = '/etc/uain-survey-attester/github-read-token';
export function githubReadHeaders(path = GITHUB_TOKEN_PATH, owner = 0) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== owner || (st.mode & 0o077) || st.size > 512) return {};
    const token = readFileSync(path, 'utf8').trim();
    return /^[A-Za-z0-9_]{20,255}$/.test(token) ? { 'api.github.com': { authorization: `Bearer ${token}` } } : {};
  } catch { return {}; }
}

export async function verifySurvey({ policy, assignment, artifact, version = 1, nativeEvidence, network }, { retriever, runner } = {}) {
  if (![1, 2].includes(version)) throw Object.assign(Error('invalid_attestation_version'), {code:'invalid_attestation_version'});
  const verifier = version === 1 ? verifyEvidence : verifyEvidenceV2;
  const input = version === 1 ? {taskPolicy:policy, assignment, artifact} : {taskPolicy:policy, assignment, nativeEvidence, network};
  const result = await verifier(input, {
    retriever: retriever ?? createRetriever({
      // A registry query page can be large (16 MiB cap); every other read keeps its own smaller cap.
      allowedHosts: [...SURVEY_HOSTS], maxBytes: policy?.class === 'registry_audit' ? REGISTRY_PAGE_MAX_BYTES : 2 * 1024 * 1024, timeoutMs: 20000,
      headers: { 'user-agent': 'uain-prior-art-survey-verifier/1 (+https://uain.global)', accept: 'application/json, application/atom+xml;q=0.9' },
      hostHeaders: githubReadHeaders(),
    }),
    runner: runner ?? createRunner({ timeoutMs: 30000, memoryMb: policy?.class === 'registry_audit' ? 512 : 128 }),
  });
  return { ...result, driverSha256: driverDigest(policy?.driver?.name ?? 'prior-art-survey') };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(await verifySurvey(input)) + '\n');
  } catch (error) {
    process.stderr.write(`survey verifier refused: ${error.code ?? 'error'}\n`);
    process.exitCode = 1;
  }
}

/**
 * General evidence verification with fixed, trusted adapters (plan Task 6A;
 * design builder-review resolution 1, "Evidence classes").
 *
 * The root-owned task policy pins everything that decides a result: the
 * evidence class, the primary-source hosts and exact input bytes, the fixed
 * driver and its sha256, and the deterministic success tests. The submitted
 * artifact is untrusted data. It never selects a driver, command, input or
 * attestation; fields that try to are ignored and flagged, or rejected.
 *
 * Supported classes:
 *   - source_code_reproduction: delegated, unchanged, to the existing protected
 *     reproduction attestation (ops/custody/central_reviewer_server.py, checked
 *     by validateTrustedReproduction in services/central-reviewer). Nothing
 *     here reimplements or relaxes that guard.
 *   - finite_math_witness: verifiers/finite-math-witness.mjs.
 *   - pinned_dataset_analysis: verifiers/pinned-dataset-analysis.mjs.
 *   - prior_art_survey: verifiers/prior-art-survey.mjs, the first task of every
 *     organization (survey.mjs). Each cited identifier is resolved through the
 *     one fixed record API of its kind (survey-sources.mjs); the driver decides
 *     from the policy, the claims and those answers.
 *   - registry_audit: verifiers/registry-audit.mjs, registry audit and census tasks
 *     (10 November 2026). The pinned ClinicalTrials.gov query is rerun (every page) and every
 *     listed PubMed ID is resolved; the driver checks coverage, verbatim copies and counts.
 *   - single_claim_check: verifiers/single-claim.mjs, one unresolved survey gap checked against
 *     one primary record (10 November 2026), resolved through the same fixed record APIs.
 * Every other class (wet lab, clinical, patient counts, narrative literature,
 * anything new) returns verification_adapter_required before any retrieval,
 * driver run or signing expense.
 *
 * A pass proves only the particular task result. It never satisfies a
 * project's broad Main KPI, so every result carries mainKpiSatisfied: false.
 *
 * Signing is custody's job. This module only builds the unsigned attestation
 * payload (attestationPayload) and its digest; a custody adapter must re-derive
 * and sign it under its own key and policy. Nothing here holds a key.
 */
import { lookup } from 'node:dns/promises';
import { lstat, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { validateTrustedReproduction } from '../../central-reviewer/src/worker.mjs';
import { createPinnedFetch } from './pinned-fetch.mjs';
import {
  CLAIM_RECORD_MAX_BYTES, REGISTRY_HOSTS, REGISTRY_MAX_PAGES, REGISTRY_PAGE_MAX_BYTES, SURVEY_HOSTS, SURVEY_RECORD_MAX_BYTES,
  claimResolution, surveyResolution,
} from './survey-sources.mjs';
import { checkTest as registryAuditTest, MAX_PUBLICATIONS as REGISTRY_MAX_PUBLICATIONS } from '../verifiers/registry-audit.mjs';
import { checkTest as singleClaimTest } from '../verifiers/single-claim.mjs';
import { HASH, NATIVE_ID, OrganizationError, byText, canonical, digest, exactKeys, need, plain, refuse, sha256, text, parseStrictJSON, validateNativeNetwork } from './common.mjs';

export const POLICY_SCHEMA = 'uain-task-verification-policy-v1';
export const ARTIFACT_SCHEMA = 'uain-evidence-artifact-v1';
export const ATTESTATION_SCHEMA = 'uain-task-verification-attestation-v1';
export const VERIFIERS_DIR = fileURLToPath(new URL('../verifiers/', import.meta.url));

/** Class -> the only driver name a policy of that class may pin. */
export const CLASS_DRIVERS = Object.freeze({
  source_code_reproduction: 'protected-reproduction-attestation',
  finite_math_witness: 'finite-math-witness',
  pinned_dataset_analysis: 'pinned-dataset-analysis',
  prior_art_survey: 'prior-art-survey',
  registry_audit: 'registry-audit',
  single_claim_check: 'single-claim',
});
/** Drivers that exist as files under verifiers/ (reproduction stays in custody). */
const FILE_DRIVERS = new Set(['finite-math-witness', 'pinned-dataset-analysis', 'prior-art-survey', 'registry-audit', 'single-claim']);
/** Classes whose driver decides from fixed record-API answers and whose evidence fits one native submission. */
export const RECORD_CLASSES = Object.freeze(['prior_art_survey', 'registry_audit', 'single_claim_check']);
/** A survey cites at most this many identifiers (verifiers/prior-art-survey.mjs MAX_ITEMS). */
const SURVEY_MAX_ITEMS = 60;

const UNSUPPORTED_NOTES = Object.freeze({
  wet_lab: 'wet-lab results need a qualified laboratory adapter',
  clinical: 'clinical efficacy needs a qualified clinical adapter; no patient data is invented',
  clinical_efficacy: 'clinical efficacy needs a qualified clinical adapter; no patient data is invented',
  patient_counts: 'patient counts need a qualified clinical adapter; no patient data is invented',
  narrative_literature: 'narrative literature notes remain unpaid preparation',
});

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TEST_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/* ------------------------------------------------------------------ policy */

const uniqueStrings = (list, valid) => Array.isArray(list) && list.every(valid) && new Set(list).size === list.length;

function validateInput(input, hosts) {
  need(exactKeys(input, ['url', 'sha256', 'bytes']), 'invalid_task_policy', 'input shape');
  need(typeof input.url === 'string' && input.url.length <= 2048 && HASH.test(input.sha256), 'invalid_task_policy', 'input pin');
  need(Number.isSafeInteger(input.bytes) && input.bytes > 0 && input.bytes <= MAX_INPUT_BYTES, 'invalid_task_policy', 'input size');
  let url;
  try {
    url = new URL(input.url);
  } catch {
    refuse('invalid_task_policy', 'input url');
  }
  need(url.protocol === 'https:' && hosts.includes(url.hostname), 'invalid_task_policy', 'input host must be a pinned primary source');
}

const TEST_VALIDATORS = Object.freeze({
  source_code_reproduction: (t) => exactKeys(t, ['id', 'before', 'after']) && t.before === 'failed' && t.after === 'passed',
  finite_math_witness: (t) =>
    exactKeys(t, ['id', 'witnessType', 'instance']) &&
    ['integer_factorization', 'graph_coloring', 'sat_assignment'].includes(t.witnessType) && plain(t.instance),
  pinned_dataset_analysis: (t) => {
    const optional = ['expected', 'decimals'].filter((k) => Object.hasOwn(t ?? {}, k));
    return exactKeys(t, ['id', 'op', 'input', 'column', ...optional]) && ['count', 'sum', 'mean', 'min', 'max'].includes(t.op) &&
      Number.isSafeInteger(t.input) && t.input >= 0 && text(t.column, 1, 256) &&
      (t.expected === undefined || (typeof t.expected === 'string' && /^[+-]?[0-9]+(\.[0-9]+)?$/.test(t.expected))) &&
      (t.decimals === undefined || (t.op === 'mean' && Number.isSafeInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 18));
  },
  prior_art_survey: (t) =>
    exactKeys(t, ['id', 'mainKpi', 'minIncluded', 'minKinds', 'requiredIds']) && text(t.mainKpi, 20, 4096) &&
    Number.isSafeInteger(t.minIncluded) && t.minIncluded >= 1 && t.minIncluded <= SURVEY_MAX_ITEMS &&
    Number.isSafeInteger(t.minKinds) && t.minKinds >= 1 && t.minKinds <= 6 &&
    Array.isArray(t.requiredIds) && t.requiredIds.length <= SURVEY_MAX_ITEMS &&
    t.requiredIds.every((r) => exactKeys(r, ['kind', 'id']) && surveyResolution(r.kind, r.id) !== null),
  registry_audit: (t) => registryAuditTest(t) === null,
  single_claim_check: (t) => singleClaimTest(t) === null,
});

/** Strict validation of a root-owned policy of a supported class. Throws invalid_task_policy. */
export function validateTaskPolicy(policy) {
  const keys = ['schema', 'class', 'taskId', 'projectId', 'criteriaDigest', 'inputs', 'primarySourceHosts', 'driver', 'successTests'];
  need(exactKeys(policy, keys) && policy.schema === POLICY_SCHEMA, 'invalid_task_policy', 'policy shape');
  need(Object.hasOwn(CLASS_DRIVERS, policy.class), 'invalid_task_policy', 'unsupported class');
  need(NATIVE_ID.test(policy.taskId) && NATIVE_ID.test(policy.projectId) && HASH.test(policy.criteriaDigest), 'invalid_task_policy', 'policy identity');
  need(uniqueStrings(policy.primarySourceHosts, (h) => typeof h === 'string' && HOSTNAME.test(h)) && policy.primarySourceHosts.length <= 16,
    'invalid_task_policy', 'primary source hosts');
  need(Array.isArray(policy.inputs) && policy.inputs.length <= 16, 'invalid_task_policy', 'inputs');
  for (const input of policy.inputs) validateInput(input, policy.primarySourceHosts);
  need(exactKeys(policy.driver, ['name', 'sha256']) && policy.driver.name === CLASS_DRIVERS[policy.class] && HASH.test(policy.driver.sha256),
    'invalid_task_policy', 'driver pin');
  const tests = policy.successTests;
  need(Array.isArray(tests) && tests.length >= 1 && tests.length <= 32 && tests.every(TEST_VALIDATORS[policy.class]) &&
    uniqueStrings(tests.map((t) => t.id), (id) => typeof id === 'string' && TEST_ID.test(id)), 'invalid_task_policy', 'success tests');
  if (policy.class === 'source_code_reproduction') {
    need(policy.inputs.length === 1 && tests.length === 1, 'invalid_task_policy', 'reproduction pins one live source and one test');
  }
  if (policy.class === 'finite_math_witness') need(policy.inputs.length === 0, 'invalid_task_policy', 'witness instances live in the policy');
  if (policy.class === 'pinned_dataset_analysis') {
    need(policy.inputs.length >= 1 && tests.every((t) => t.input < policy.inputs.length), 'invalid_task_policy', 'dataset inputs');
  }
  if (policy.class === 'prior_art_survey') {
    need(policy.inputs.length === 0 && tests.length === 1, 'invalid_task_policy', 'a survey pins no inputs and one test');
    need(canonical([...policy.primarySourceHosts].sort(byText)) === canonical(SURVEY_HOSTS), 'invalid_task_policy', 'survey hosts are the fixed record APIs');
  }
  if (policy.class === 'registry_audit') {
    need(policy.inputs.length === 0 && tests.length === 1, 'invalid_task_policy', 'a registry audit pins its query in its one test');
    need(canonical([...policy.primarySourceHosts].sort(byText)) === canonical(REGISTRY_HOSTS), 'invalid_task_policy', 'registry audit hosts are ClinicalTrials.gov and PubMed');
  }
  if (policy.class === 'single_claim_check') {
    need(policy.inputs.length === 0 && tests.length === 1, 'invalid_task_policy', 'a single-claim check pins no inputs and one test');
    need(canonical([...policy.primarySourceHosts].sort(byText)) === canonical(SURVEY_HOSTS), 'invalid_task_policy', 'single-claim hosts are the fixed record APIs');
  }
  canonical(policy);
  return structuredClone(policy);
}

/* ----------------------------------------------------- trusted retrieval */

function ipv4Number(address) {
  return address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

const IPV4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4Number(base), 2 ** (32 - bits)]);

const publicIpv4 = (address) => {
  const n = ipv4Number(address);
  return !IPV4_BLOCKED.some(([base, size]) => n >= base && n < base + size);
};

/** Eight 16-bit groups, or null. Accepts an embedded IPv4 tail. */
function ipv6Groups(address) {
  let value = address.toLowerCase().split('%')[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (tail) {
    if (isIP(tail[1]) !== 4) return null;
    const n = ipv4Number(tail[1]);
    value = value.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  return groups.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? groups.map((g) => parseInt(g, 16)) : null;
}

function publicIpv6(address) {
  const g = ipv6Groups(address);
  if (!g) return false;
  const zeroPrefix = (count) => g.slice(0, count).every((x) => x === 0);
  if (zeroPrefix(5) && g[5] === 0xffff) return publicIpv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  if ((g[0] & 0xe000) !== 0x2000) return false; // only global unicast 2000::/3 (excludes ::, ::1, ULA fc00::/7, fe80::/10, ff00::/8)
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] < 0x0200)) return false; // documentation, Teredo and IETF protocol blocks
  if (g[0] === 0x2002) return false; // 6to4 can embed private IPv4
  if (g[0] === 0x3fff && g[1] < 0x1000) return false; // documentation 3fff::/20
  return true;
}

/** True only for public unicast addresses; private, loopback, link-local, CGNAT and ULA are refused. */
export function isPublicAddress(address) {
  const family = isIP(address ?? '');
  if (family === 4) return publicIpv4(address);
  if (family === 6) return publicIpv6(address);
  return false;
}

const defaultResolve = (hostname) => lookup(hostname, { all: true, verbatim: true });
/** Refusals a transport may raise that keep their code (anything else is retrieval_failed). */
const TRANSPORT_CODES = new Set(['timeout', 'size_exceeded', 'dns_failed', 'private_address_refused', 'host_not_allowed']);

/**
 * Bounded retrieval from prequalified primary-source HTTPS hosts.
 *
 * Every hop is checked: https only, default port, no credentials, no IP
 * literals, host on BOTH the global allowlist and the task's primary sources,
 * and every resolved address public. Redirects are handled manually and each
 * target is rechecked. Bytes are capped at the pinned length and must hash to
 * the pinned sha256.
 *
 * DNS rebinding: when no fetchImpl is injected, the default transport is
 * createPinnedFetch (src/pinned-fetch.mjs), which resolves once, applies the
 * same public-address policy and connects to exactly the address that passed
 * (certificate still checked against the hostname). An injected fetchImpl is
 * trusted to do the same (or to run behind an egress proxy with this policy).
 *
 * `retrieve(input, {hosts})` is for pinned inputs (known sha256 and length).
 * `observe(url, {hosts, maxBytes})` is for content that cannot be pinned in
 * advance, such as a primary-source search API answer: the same host, address,
 * redirect and size policy applies, and it returns the final URL, the bytes and
 * their sha256 so a record can bind to exactly what was read.
 */
/** Rate-limit facts from a refusal. GitHub signals an exhausted quota with 403 (or 429) and
 * x-ratelimit-remaining: 0; secondary limits send retry-after. A plain 403 carries neither. */
export function rateLimit(response, nowMs = Date.now()) {
  const get = (name) => response?.headers?.get?.(name) ?? null;
  const remaining = get('x-ratelimit-remaining'), after = get('retry-after'), reset = get('x-ratelimit-reset');
  const limited = [403, 429].includes(response?.status) && (remaining === '0' || (after !== null && /^[0-9]{1,6}$/.test(after)));
  if (!limited) return {};
  let retryAfterMs = null;
  if (after !== null && /^[0-9]{1,6}$/.test(after)) retryAfterMs = Number(after) * 1000;
  else if (reset !== null && /^[0-9]{1,12}$/.test(reset)) retryAfterMs = Math.max(0, Number(reset) * 1000 - nowMs);
  return { rateLimited: true, retryAfterMs };
}
export function createRetriever({ fetchImpl, resolve = defaultResolve, allowedHosts, maxBytes = MAX_INPUT_BYTES,
  timeoutMs = 30000, maxRedirects = 3, headers: extraHeaders = {}, hostHeaders = {}, lookup: transportLookup } = {}) {
  need(uniqueStrings(allowedHosts, (h) => typeof h === 'string' && HOSTNAME.test(h)) && allowedHosts.length >= 1, 'invalid_retriever', 'allowedHosts');
  need(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_INPUT_BYTES, 'invalid_retriever', 'maxBytes');
  need(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'invalid_retriever', 'timeoutMs');
  need(plain(extraHeaders) && Object.entries(extraHeaders).every(([k, v]) => /^[a-z][a-z0-9-]{0,63}$/.test(k) && text(v, 1, 256)),
    'invalid_retriever', 'headers');
  // Per-host headers (for example a read-only GitHub token) go only to that exact host, never
  // across a redirect to another host.
  need(plain(hostHeaders) && Object.entries(hostHeaders).every(([h, v]) => HOSTNAME.test(h) && allowedHosts.includes(h) && plain(v)
    && Object.entries(v).every(([k, x]) => /^[a-z][a-z0-9-]{0,63}$/.test(k) && text(x, 1, 512))), 'invalid_retriever', 'hostHeaders');
  // Default: connect only to the address that passed the public-address check.
  // `lookup` (dns.lookup shape) is only for the default transport, so tests can exercise it without a network.
  if (fetchImpl === undefined) {
    fetchImpl = createPinnedFetch({ allowedHosts, timeoutMs, maxBytes, ...(transportLookup ? { lookup: transportLookup } : {}) });
  } else need(transportLookup === undefined, 'invalid_retriever', 'lookup applies only to the default pinned transport');
  need(typeof fetchImpl === 'function' && typeof resolve === 'function', 'invalid_retriever', 'fetch and resolve');
  const globalHosts = new Set(allowedHosts);

  function checkUrl(raw, taskHosts, redirected) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      refuse('invalid_url');
    }
    need(url.protocol === 'https:', 'https_required');
    need(!url.username && !url.password, 'credentials_in_url');
    need(url.port === '', 'port_refused');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    need(!isIP(host), 'ip_literal_refused');
    need(globalHosts.has(host) && taskHosts.includes(host), redirected ? 'redirect_host_not_allowed' : 'host_not_allowed');
    return url;
  }

  async function checkResolution(hostname, signal) {
    let answers;
    try {
      answers = await new Promise((accept, reject) => {
        const abort = () => reject(new OrganizationError('timeout'));
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => resolve(hostname)).then(accept, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
    } catch (error) {
      refuse(error?.code === 'timeout' ? 'timeout' : 'dns_failed');
    }
    const addresses = (Array.isArray(answers) ? answers : [answers]).map((a) => (typeof a === 'string' ? a : a?.address));
    need(addresses.length >= 1, 'dns_failed');
    need(addresses.every(isPublicAddress), 'private_address_refused');
  }

  async function readBounded(response, limit) {
    const declared = response.headers?.get?.('content-length');
    need(declared == null || (/^[0-9]+$/.test(declared) && Number(declared) <= limit), 'size_exceeded');
    const chunks = [];
    let total = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > limit) {
          await response.body.cancel?.().catch(() => {});
          refuse('size_exceeded');
        }
        chunks.push(Buffer.from(chunk));
      }
    }
    return Buffer.concat(chunks, total);
  }

  /** Follows checked redirects to an accepted status (200, or `statuses`), returns { url, response }. */
  async function fetchChecked(raw, hosts, signal, limit, statuses = [200]) {
    let url = checkUrl(raw, hosts, false);
    for (let hop = 0; ; hop += 1) {
      await checkResolution(url.hostname, signal);
      let response;
      try {
        response = await fetchImpl(url.href, {
          redirect: 'manual', credentials: 'omit', signal, maxBytes: limit, headers: { accept: '*/*', ...extraHeaders, ...(hostHeaders[url.hostname] ?? {}) },
        });
      } catch (error) {
        refuse(TRANSPORT_CODES.has(error?.code) ? error.code : 'retrieval_failed');
      }
      need(response?.type !== 'opaqueredirect', 'redirect_refused');
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel?.().catch(() => {});
        need(hop < maxRedirects, 'too_many_redirects');
        const location = response.headers?.get?.('location');
        need(typeof location === 'string' && location.length > 0, 'redirect_refused');
        url = checkUrl(new URL(location, url).href, hosts, true);
        continue;
      }
      if (!statuses.includes(response.status)) {
        await response.body?.cancel?.().catch(() => {});
        throw Object.assign(new OrganizationError('unexpected_status'), { status: response.status, ...rateLimit(response) });
      }
      return { url, response };
    }
  }

  async function retrieve(input, { hosts }) {
    need(exactKeys(input, ['url', 'sha256', 'bytes']) && HASH.test(input.sha256), 'invalid_input_pin');
    need(Number.isSafeInteger(input.bytes) && input.bytes > 0 && input.bytes <= maxBytes, 'size_exceeded');
    need(Array.isArray(hosts), 'host_not_allowed');
    const signal = AbortSignal.timeout(timeoutMs);
    const { response } = await fetchChecked(input.url, hosts, signal, input.bytes);
    const bytes = await readBounded(response, input.bytes);
    need(bytes.length === input.bytes, 'size_mismatch');
    need(sha256(bytes) === input.sha256, 'hash_mismatch');
    return bytes;
  }

  /** `notFound: true` also accepts a 404 (a record API saying the record does not exist). */
  async function observe(raw, { hosts, maxBytes: limit = maxBytes, notFound = false } = {}) {
    need(typeof raw === 'string' && raw.length <= 2048, 'invalid_url');
    need(Array.isArray(hosts), 'host_not_allowed');
    need(Number.isSafeInteger(limit) && limit > 0 && limit <= maxBytes, 'size_exceeded');
    const signal = AbortSignal.timeout(timeoutMs);
    const { url, response } = await fetchChecked(raw, hosts, signal, limit, notFound === true ? [200, 404] : [200]);
    const bytes = await readBounded(response, limit);
    return { url: url.href, status: response.status, bytes, sha256: sha256(bytes), contentType: response.headers?.get?.('content-type') ?? null };
  }

  return Object.freeze({ retrieve, observe });
}

/* ------------------------------------------------------- fixed drivers */

function driverPath(name, directory) {
  need(FILE_DRIVERS.has(name), 'unknown_driver');
  return join(directory, `${name}.mjs`);
}

/** sha256 of a fixed driver file; what a root-owned policy pins as driver.sha256. */
export function driverDigest(name, directory = VERIFIERS_DIR) {
  return sha256(readFileSync(driverPath(name, directory)));
}

/**
 * The driver's exact bytes run in a worker thread with memory limits, a
 * timeout and an empty environment. The worker imports them from a data: URL,
 * so what runs is exactly what was hashed (no second read of the file).
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
import('data:text/javascript;base64,' + workerData.source)
  .then((driver) => driver.verify(workerData.payload))
  .then((result) => parentPort.postMessage({ ok: true, result }),
    (error) => parentPort.postMessage({ ok: false, error: String(error && error.message || error) }));
`;

function runIsolated(source, payload, { timeoutMs, memoryMb }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      env: {},
      workerData: { source: source.toString('base64'), payload },
      resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new OrganizationError('driver_timeout')), timeoutMs);
    worker.once('message', (m) => (m?.ok ? finish(null, m.result) : finish(new OrganizationError('driver_error', m?.error))));
    worker.once('error', (e) => finish(new OrganizationError('driver_error', e?.message)));
    worker.once('exit', () => finish(new OrganizationError('driver_error', 'driver exited without a result')));
  });
}

function checkDriverResult(result) {
  need(plain(result) && ['pass', 'fail', 'unverifiable'].includes(result.status), 'driver_error', 'driver result');
  need(Array.isArray(result.findings) && result.findings.length <= 256 && result.findings.every((f) => text(f, 1, 512)), 'driver_error', 'findings');
  return { status: result.status, findings: result.findings };
}

/** Loads a fixed driver by name, refuses it unless its sha256 equals the pinned one, then runs it isolated. */
export function createRunner({ directory = VERIFIERS_DIR, timeoutMs = 10000, memoryMb = 128 } = {}) {
  need(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'invalid_runner', 'timeoutMs');
  need(Number.isSafeInteger(memoryMb) && memoryMb >= 16 && memoryMb <= 1024, 'invalid_runner', 'memoryMb');
  return Object.freeze({
    async run({ name, sha256: pinned, payload }) {
      const path = driverPath(name, directory);
      const info = await lstat(path);
      need(info.isFile() && !info.isSymbolicLink(), 'driver_not_regular_file');
      const source = await readFile(path);
      need(HASH.test(pinned ?? '') && sha256(source) === pinned, 'driver_hash_mismatch');
      return checkDriverResult(await runIsolated(source, payload, { timeoutMs, memoryMb }));
    },
  });
}

/* ------------------------------------------------------------ attestation */

/**
 * The unsigned statement a custody adapter would sign. Binds the exact policy,
 * submission, author, criteria, artifact, verdict and pinned driver (and, for
 * source-code reproduction, the protected reproduction attestation digest).
 * Signing is custody's job: the adapter must recompute this payload from its
 * own reads, not accept one from this process or from a submitter.
 */
export function attestationPayload({ policy, assignment, artifactDigest, verdict, reproductionAttestationDigest = null }) {
  need(['pass', 'fail'].includes(verdict) && HASH.test(artifactDigest ?? ''), 'invalid_attestation');
  need(reproductionAttestationDigest === null || HASH.test(reproductionAttestationDigest), 'invalid_attestation');
  return {
    schema: ATTESTATION_SCHEMA,
    policyDigest: digest(policy),
    submissionId: assignment.submissionId,
    author: assignment.author,
    criteriaDigest: assignment.criteriaDigest,
    artifactDigest,
    verdict,
    driver: { name: policy.driver.name, sha256: policy.driver.sha256 },
    reproductionAttestationDigest,
    mainKpiSatisfied: false,
  };
}

export const attestationDigestOf = (payload) => digest(payload);

/* ------------------------------------------------------------ verification */

const ARTIFACT_BASE = ['schema', 'taskId', 'submissionId', 'author'];
const CLASS_PAYLOAD = Object.freeze({
  source_code_reproduction: 'evidenceDigest',
  finite_math_witness: 'witnesses',
  pinned_dataset_analysis: 'results',
  prior_art_survey: 'survey',
  registry_audit: 'audit',
  single_claim_check: 'check',
});
/** A submitter may not choose what runs. These are ignored and flagged. */
const EXECUTION_FIELDS = new Set(['driver', 'command', 'executable', 'argv', 'args', 'verifier', 'runner', 'script', 'interpreter',
  'entrypoint', 'image', 'env', 'cwd', 'reproducer']);
/** A submitter may not supply its own verdict or attestation. These reject the artifact. */
const ATTESTATION_FIELDS = new Set(['attestation', 'attestationDigest', 'attestation_digest', 'trusted_reproduction',
  'trustedReproduction', 'trusted_verification', 'trustedVerification', 'verdict', 'signature', 'mainKpiSatisfied']);

const outcome = (verdict, findings, attestation = null) => ({
  verdict,
  findings,
  attestationDigest: attestation ? attestationDigestOf(attestation) : null,
  attestation,
  mainKpiSatisfied: false,
});

function assignmentFindings(policy, assignment) {
  if (!exactKeys(assignment, ['taskId', 'projectId', 'submissionId', 'author', 'criteriaDigest'])) return ['invalid_assignment'];
  if (![assignment.taskId, assignment.projectId, assignment.submissionId, assignment.author].every((v) => NATIVE_ID.test(v ?? '')) ||
    !HASH.test(assignment.criteriaDigest ?? '')) return ['invalid_assignment'];
  const found = [];
  if (assignment.taskId !== policy.taskId) found.push('assignment_task_mismatch');
  if (assignment.projectId !== policy.projectId) found.push('assignment_project_mismatch');
  if (assignment.criteriaDigest !== policy.criteriaDigest) found.push('assignment_criteria_mismatch');
  return found;
}

/** Returns { rejected: findings[] } or { artifactDigest, payload, flags }. */
function screenArtifact(policy, assignment, artifact) {
  if (!plain(artifact)) return { rejected: ['artifact_not_object'] };
  let encoded;
  try {
    encoded = canonical(artifact);
  } catch {
    return { rejected: ['artifact_not_canonical'] };
  }
  if (Buffer.byteLength(encoded) > MAX_ARTIFACT_BYTES) return { rejected: ['artifact_too_large'] };
  const flags = [];
  const rejected = [];
  for (const key of Object.keys(artifact)) {
    if (ATTESTATION_FIELDS.has(key)) rejected.push(`artifact_supplied_attestation_rejected:${key}`);
    else if (EXECUTION_FIELDS.has(key)) flags.push(`artifact_execution_field_ignored:${key}`);
    else if (!ARTIFACT_BASE.includes(key) && key !== CLASS_PAYLOAD[policy.class]) flags.push('artifact_unknown_field_ignored');
  }
  if (artifact.schema !== ARTIFACT_SCHEMA) rejected.push('artifact_schema_mismatch');
  if (artifact.taskId !== assignment.taskId) rejected.push('artifact_task_mismatch');
  if (artifact.submissionId !== assignment.submissionId) rejected.push('artifact_submission_mismatch');
  if (artifact.author !== assignment.author) rejected.push('artifact_author_mismatch');
  if (rejected.length) return { rejected: [...flags, ...rejected] };
  return { artifactDigest: sha256(encoded), payload: artifact[CLASS_PAYLOAD[policy.class]], flags: [...new Set(flags)] };
}

async function verifySourceReproduction(policy, assignment, screened, reproductionAttestation) {
  const { artifactDigest, payload: evidenceDigest, flags } = screened;
  if (!HASH.test(evidenceDigest ?? '')) return outcome('fail', [...flags, 'artifact_evidence_digest_missing']);
  if (typeof reproductionAttestation?.readiness !== 'function') {
    return outcome('needs_evidence', [...flags, 'protected_reproduction_checker_unavailable']);
  }
  const request = { submission: assignment.submissionId, author: assignment.author, criteriaDigest: assignment.criteriaDigest, evidenceDigest };
  let ready;
  try {
    ready = await reproductionAttestation.readiness(structuredClone(request));
  } catch {
    return outcome('needs_evidence', [...flags, 'protected_reproduction_unavailable']);
  }
  if (!plain(ready) || ready.ready !== true || !ready.trusted_reproduction) {
    return outcome('needs_evidence', [...flags, 'independent_reproduction_required']);
  }
  const bound = ready.submission === request.submission && ready.author === request.author &&
    ready.criteriaDigest === request.criteriaDigest && ready.evidenceDigest === request.evidenceDigest;
  if (!bound) return outcome('needs_evidence', [...flags, 'protected_reproduction_binding_mismatch']);
  let facts;
  try {
    facts = validateTrustedReproduction(ready.trusted_reproduction);
  } catch {
    return outcome('needs_evidence', [...flags, 'protected_reproduction_invalid']);
  }
  if (ready.attestationDigest !== facts.digest) return outcome('needs_evidence', [...flags, 'protected_reproduction_digest_mismatch']);
  if (facts.reproducer_sha256 !== policy.driver.sha256) return outcome('fail', [...flags, 'reproducer_not_pinned_by_policy']);
  if (facts.live_source_sha256 !== policy.inputs[0].sha256) return outcome('fail', [...flags, 'live_source_not_pinned_by_policy']);
  const findings = [...flags, `${policy.successTests[0].id}:pass`];
  return outcome('pass', findings, attestationPayload({ policy, assignment, artifactDigest, verdict: 'pass', reproductionAttestationDigest: facts.digest }));
}

/** Minimum spacing between record-API requests to one host, in milliseconds. NCBI E-utilities
 * allows 3 requests per second without an API key; the others are shared public APIs. */
export const SURVEY_HOST_INTERVALS = Object.freeze({
  'eutils.ncbi.nlm.nih.gov': 400, 'api.crossref.org': 250, 'clinicaltrials.gov': 250,
  'export.arxiv.org': 3000, 'api.github.com': 1000, 'www.wikidata.org': 250,
});
/** Backoff before each retry of a transient failure; its length is the number of retries. */
export const SURVEY_RETRY_DELAYS = Object.freeze([1000, 3000, 8000]);
/** Elapsed read scheduling budget. Healthy 60-item arXiv surveys need at least 177 s
 * of host spacing. An in-flight request may extend beyond this budget by its normal
 * timeout; the driver runs afterward. This is not a bound on the whole serial queue. */
export const SURVEY_READ_BUDGET_MS = 240000;
/** Statuses worth retrying: rate limiting and server errors. Other refusals (400, 401, 403, ...)
 * are not retried. A 404 is an answer, read once. */
const SURVEY_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Transport failures worth retrying. A refused host, size, redirect or address never improves. */
const SURVEY_RETRY_CODES = new Set(['retrieval_failed', 'timeout', 'connection_failed', 'dns_failed']);
const surveyRetryable = (error) => error?.code === 'unexpected_status'
  ? SURVEY_RETRY_STATUSES.has(error.status) || (error.status === 403 && error.rateLimited === true)
  : SURVEY_RETRY_CODES.has(error?.code);
/** Longest wait a rate-limit hint may impose on one record before it is left unread. */
export const SURVEY_MAX_RATE_LIMIT_WAIT_MS = 60000;
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One fixed record-API answer per cited identifier, for the survey driver. Identifiers are
 * validated before any URL is built; a malformed one is left for the driver to fail.
 * Requests to one host are spaced (SURVEY_HOST_INTERVALS), and a transient failure is retried
 * after SURVEY_RETRY_DELAYS. No request starts after SURVEY_READ_BUDGET_MS for the whole survey. A record the API still could not serve is passed as unread, so
 * the driver returns unverifiable: pacing changes when a record is read, never what counts.
 */
export async function surveyRecords(survey, retriever, { intervals = SURVEY_HOST_INTERVALS, retryDelays = SURVEY_RETRY_DELAYS,
  budgetMs = SURVEY_READ_BUDGET_MS, sleep = realSleep, now = () => performance.now(), resolve = surveyResolution,
  maxItems = SURVEY_MAX_ITEMS, maxBytes = SURVEY_RECORD_MAX_BYTES } = {}) {
  const deadline = now() + budgetMs;
  const items = Array.isArray(survey?.items) ? survey.items.slice(0, maxItems) : [];
  const records = [];
  const seen = new Set();
  const last = new Map();
  async function slot(host) {
    const wait = (last.get(host) ?? -Infinity) + (intervals[host] ?? 0) - now();
    if (wait > 0) await sleep(wait);
    last.set(host, now());
  }
  for (const item of items) {
    const at = plain(item) ? resolve(item.kind, item.id) : null;
    if (!at || seen.has(`${item.kind}:${item.id}`)) continue;
    seen.add(`${item.kind}:${item.id}`);
    let record;
    for (let attempt = 0; ; attempt += 1) {
      if (now() + (intervals[at.host] ?? 0) >= deadline) {
        record = { kind: item.kind, id: item.id, status: 0, body: null, error: 'survey_read_budget_exhausted' };
        break;
      }
      await slot(at.host);
      if (now() >= deadline) {
        record = { kind: item.kind, id: item.id, status: 0, body: null, error: 'survey_read_budget_exhausted' };
        break;
      }
      try {
        const got = await retriever.observe(at.url, { hosts: [at.host], maxBytes, notFound: true });
        const status = got?.status === 404 ? 404 : 200;
        record = { kind: item.kind, id: item.id, status, body: status === 200 ? new Uint8Array(got.bytes) : null };
        break;
      } catch (error) {
        const code = error?.code ?? 'retrieval_failed';
        const hinted = error?.rateLimited === true && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0;
        const delay = Math.max(retryDelays[attempt] ?? 0, hinted);
        if (!surveyRetryable(error) || attempt >= retryDelays.length || hinted > SURVEY_MAX_RATE_LIMIT_WAIT_MS || now() + delay >= deadline) {
          record = { kind: item.kind, id: item.id, status: 0, body: null, error: error?.rateLimited === true ? 'rate_limited' : code };
          break;
        }
        await sleep(delay);
      }
    }
    records.push(record);
  }
  return records;
}

/**
 * Every page of a registry audit's pinned query, in order: {status: 200, body} or
 * {status: 0, body: null, error}. Pages follow the API's nextPageToken, spaced like the record
 * reads; at most REGISTRY_MAX_PAGES are read (the driver reports a longer answer as unverifiable).
 * A transient failure is retried after SURVEY_RETRY_DELAYS; an unread page stops the reading.
 */
export async function registryPages(query, retriever, { retryDelays = SURVEY_RETRY_DELAYS, sleep = realSleep, maxPages = REGISTRY_MAX_PAGES,
  intervals = SURVEY_HOST_INTERVALS } = {}) {
  const pages = [];
  let token = null;
  for (let n = 0; n < maxPages; n += 1) {
    if (n > 0) await sleep(intervals['clinicaltrials.gov'] ?? 0);
    const url = token === null ? query : `${query}&pageToken=${encodeURIComponent(token)}`;
    let page;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const got = await retriever.observe(url, { hosts: ['clinicaltrials.gov'], maxBytes: REGISTRY_PAGE_MAX_BYTES });
        page = { status: 200, body: new Uint8Array(got.bytes) };
        break;
      } catch (error) {
        const hinted = error?.rateLimited === true && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0;
        if (!surveyRetryable(error) || attempt >= retryDelays.length || hinted > SURVEY_MAX_RATE_LIMIT_WAIT_MS) {
          page = { status: 0, body: null, error: error?.rateLimited === true ? 'rate_limited' : error?.code ?? 'retrieval_failed' };
          break;
        }
        await sleep(Math.max(retryDelays[attempt] ?? 0, hinted));
      }
    }
    pages.push(page);
    if (page.status !== 200) break;
    let next = null;
    try {
      next = JSON.parse(Buffer.from(page.body).toString('utf8'))?.nextPageToken ?? null;
    } catch {
      break;
    }
    if (typeof next !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(next)) break;
    token = next;
  }
  return pages;
}

const PMID = /^[1-9][0-9]{0,9}$/;

/** The driver payload of a record class and the record reads it needs (paced per host: NCBI at most 3 a second). */
async function recordPayload(policy, payload, retriever, surveyPacing, clock) {
  const successTests = structuredClone(policy.successTests);
  if (policy.class === 'prior_art_survey') {
    const records = await surveyRecords(payload, retriever, surveyPacing);
    return { records, driverPayload: { successTests, survey: structuredClone(payload ?? null), records } };
  }
  if (policy.class === 'single_claim_check') {
    const record = plain(payload) && plain(payload.record) ? payload.record : null;
    const items = record && typeof record.kind === 'string' && typeof record.id === 'string' ? [{ kind: record.kind, id: record.id }] : [];
    const records = await surveyRecords({ items }, retriever, { ...surveyPacing, resolve: claimResolution, maxItems: 1, maxBytes: CLAIM_RECORD_MAX_BYTES });
    return { records, driverPayload: { successTests, check: structuredClone(payload ?? null), records } };
  }
  // registry_audit: the pinned query (every page), then every listed PubMed ID once.
  const pages = await registryPages(policy.successTests[0].query, retriever, surveyPacing);
  const pmids = new Set();
  for (const row of plain(payload) && Array.isArray(payload.rows) ? payload.rows.slice(0, 200) : []) {
    for (const p of plain(row) && Array.isArray(row.publications) ? row.publications.slice(0, 50) : []) if (typeof p === 'string' && PMID.test(p)) pmids.add(p);
  }
  const items = pmids.size <= REGISTRY_MAX_PUBLICATIONS ? [...pmids].map((id) => ({ kind: 'pubmed', id })) : [];
  const records = await surveyRecords({ items }, retriever, { ...surveyPacing, maxItems: REGISTRY_MAX_PUBLICATIONS });
  const verifiedAt = new Date(clock()).toISOString();
  return {
    records: [...records, ...pages.filter((p) => p.status !== 200)],
    driverPayload: { successTests, audit: structuredClone(payload ?? null), registry: pages, records, verifiedAt },
  };
}

async function verifyWithDriver(policy, assignment, screened, { retriever, runner, surveyPacing, clock = () => Date.now() }) {
  const { artifactDigest, payload, flags } = screened;
  if (typeof runner?.run !== 'function') return outcome('needs_evidence', [...flags, 'runner_unavailable']);
  if (RECORD_CLASSES.includes(policy.class)) {
    if (typeof retriever?.observe !== 'function') return outcome('needs_evidence', [...flags, 'retriever_unavailable']);
    const { records, driverPayload } = await recordPayload(policy, payload, retriever, surveyPacing, clock);
    let result;
    try {
      result = await runner.run({ name: policy.driver.name, sha256: policy.driver.sha256, payload: driverPayload });
    } catch (error) {
      const code = error?.code ?? 'driver_error';
      return outcome(code === 'driver_timeout' ? 'needs_evidence' : 'fail', [...flags, code]);
    }
    const findings = [...flags, ...result.findings];
    // Records the record APIs could not serve (rate limit, outage, read budget) are a service-side
    // wait, not a request to the author. The attester holds such a result and retries; it never signs it.
    const unread = records.filter((r) => r.error !== undefined).length;
    if (result.status === 'unverifiable') return outcome('needs_evidence', unread ? [...findings, `verification_service_waiting:${unread}_records_unread`] : findings);
    return outcome(result.status, findings, attestationPayload({ policy, assignment, artifactDigest, verdict: result.status }));
  }
  const inputs = [];
  for (const [index, input] of policy.inputs.entries()) {
    if (typeof retriever?.retrieve !== 'function') return outcome('needs_evidence', [...flags, 'retriever_unavailable']);
    try {
      inputs.push(await retriever.retrieve(structuredClone(input), { hosts: [...policy.primarySourceHosts] }));
    } catch (error) {
      // A pinned source that no longer serves the pinned bytes is not the submitter's fault: inconclusive, never a pass.
      return outcome('needs_evidence', [...flags, `input_${index}_refused:${error?.code ?? 'retrieval_failed'}`]);
    }
  }
  const driverPayload = policy.class === 'finite_math_witness'
    ? { successTests: structuredClone(policy.successTests), witnesses: structuredClone(payload ?? null) }
    : { successTests: structuredClone(policy.successTests), results: structuredClone(payload ?? null), inputs };
  let result;
  try {
    result = await runner.run({ name: policy.driver.name, sha256: policy.driver.sha256, payload: driverPayload });
  } catch (error) {
    const code = error?.code ?? 'driver_error';
    if (code === 'driver_timeout') return outcome('needs_evidence', [...flags, code]);
    return outcome('fail', [...flags, code]);
  }
  const findings = [...flags, ...result.findings];
  if (result.status === 'unverifiable') return outcome('needs_evidence', findings);
  return outcome(result.status, findings, attestationPayload({ policy, assignment, artifactDigest, verdict: result.status }));
}

/**
 * verifyEvidence({ taskPolicy, assignment, artifact }, { retriever, runner, reproductionAttestation })
 *   -> { verdict, findings, attestationDigest, attestation, mainKpiSatisfied: false }
 *
 * verdict: 'pass' | 'fail' | 'verification_adapter_required' | 'needs_evidence'.
 * attestationDigest is set only when a fixed verifier actually decided pass or
 * fail; it is null for refusals before verification and inconclusive results.
 * An invalid root-owned policy is a configuration error and throws.
 */
export async function verifyEvidence({ taskPolicy, assignment, artifact }, { retriever, runner, reproductionAttestation, surveyPacing, clock } = {}) {
  need(plain(taskPolicy) && taskPolicy.schema === POLICY_SCHEMA && typeof taskPolicy.class === 'string', 'invalid_task_policy', 'policy header');
  if (!Object.hasOwn(CLASS_DRIVERS, taskPolicy.class)) {
    const label = /^[a-z0-9_]{1,64}$/.test(taskPolicy.class) ? taskPolicy.class : 'unknown';
    const note = UNSUPPORTED_NOTES[label] ?? 'no qualified verification adapter exists for this evidence class';
    return outcome('verification_adapter_required', [`verification_adapter_required:${label}`, note]);
  }
  const policy = validateTaskPolicy(taskPolicy);
  const mismatch = assignmentFindings(policy, assignment);
  if (mismatch.length) return outcome('fail', mismatch);
  const screened = screenArtifact(policy, assignment, artifact);
  if (screened.rejected) return outcome('fail', screened.rejected);
  if (policy.class === 'source_code_reproduction') {
    return verifySourceReproduction(policy, assignment, screened, reproductionAttestation);
  }
  return verifyWithDriver(policy, assignment, screened, { retriever, runner, surveyPacing, clock });
}

export const ATTESTATION_SCHEMA_V2 = 'uain-task-verification-attestation-v2';
export const ATTESTATION_DOMAIN_V2 = 'UAIN/task-verification-attestation/v2';

/** Derive BOTH digests from exact native bytes; caller supplies authoritative assignment. */
export function nativeArtifactV2({policy, assignment, nativeEvidence, network}) {
  validateNativeNetwork(network);
  need(RECORD_CLASSES.includes(policy.class), 'attestation_v2_class_not_allowed');
  const artifact = parseStrictJSON(nativeEvidence);
  need(assignmentFindings(policy, assignment).length === 0 && plain(artifact) && artifact.schema === ARTIFACT_SCHEMA &&
    artifact.author === assignment.author && artifact.taskId === assignment.taskId && artifact.submissionId === assignment.submissionId,
    'artifact_binding_mismatch');
  need(!Object.keys(artifact).some((key) => ATTESTATION_FIELDS.has(key)), 'artifact_supplied_attestation_rejected');
  const encoded = canonical(artifact);
  need(Buffer.byteLength(encoded) <= 16384, 'invalid_evidence');
  return {artifact, nativeEvidenceDigest: sha256(nativeEvidence), canonicalArtifactDigest: sha256(encoded)};
}
export function attestationPayloadV2({policy, assignment, nativeEvidenceDigest, canonicalArtifactDigest, verdict, reproductionAttestationDigest = null, network}) {
  network = validateNativeNetwork(network);
  need(HASH.test(nativeEvidenceDigest ?? '') && HASH.test(canonicalArtifactDigest ?? '') && RECORD_CLASSES.includes(policy.class), 'invalid_attestation');
  const payload = attestationPayload({policy, assignment, artifactDigest: canonicalArtifactDigest, verdict, reproductionAttestationDigest});
  delete payload.artifactDigest;
  return {...payload, schema: ATTESTATION_SCHEMA_V2, domain: ATTESTATION_DOMAIN_V2, nativeEvidenceDigest, canonicalArtifactDigest, ...network};
}
/** The same semantic verifier/driver; only the separately typed binding payload changes. */
export async function verifyEvidenceV2({taskPolicy, assignment, nativeEvidence, network}, dependencies = {}) {
  const policy = validateTaskPolicy(taskPolicy), facts = nativeArtifactV2({policy, assignment, nativeEvidence, network});
  const result = await verifyEvidence({taskPolicy: policy, assignment, artifact: facts.artifact}, dependencies);
  if (!result.attestation) return result;
  need(result.attestation.artifactDigest === facts.canonicalArtifactDigest, 'canonical_artifact_mismatch');
  const attestation = attestationPayloadV2({policy, assignment, ...facts, network, verdict: result.verdict,
    reproductionAttestationDigest: result.attestation.reproductionAttestationDigest});
  return {...result, attestation, attestationDigest: attestationDigestOf(attestation)};
}

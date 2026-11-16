#!/usr/bin/env node
// Generates docs/releases/CURRENT.md from the release records in
// docs/releases/<component>/<release-id>.json and the authored pointer file
// docs/releases/current.json. See docs/releases/README.md for the schema.
//
//   node ops/docs/render-status.mjs            write CURRENT.md
//   node ops/docs/render-status.mjs --check    exit 1 if CURRENT.md is stale
//   node ops/docs/render-status.mjs --observe  read live release ids first
//   --root <dir>                                repository root (default: cwd's repo)
//
// The output depends only on the files under docs/releases, so it is
// deterministic and idempotent. Live state is never inferred: a record's status
// is what its author recorded with evidence, and the "observed" column comes
// only from an explicit --observe run (or says "not observed").

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 1;
export const STATUSES = [
  'staged',
  'deployed',
  'publicly-verified',
  'rolled-back',
];
export const CURRENT_STATUSES = ['deployed', 'publicly-verified'];

export const COMPONENTS = {
  'central-reviewer': {
    title: 'Central UAIN reviewer and scoped custody runtime',
    releaseId: /^[0-9a-f]{64}$/,
    observe: null,
    optional: true,
  },
  organizations: {
    title: 'Native project organization orchestration runtime',
    releaseId: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
    observe: null,
    optional: true,
  },
  'house-solver': {
    title: 'Controlled house solver and authenticated dispatcher',
    releaseId: /^[0-9a-f]{64}$/, observe: null, optional: true,
  },
  'project-planning': {
    title: 'Local authenticated project intake planning runtime',
    releaseId: /^[0-9a-f]{64}$/, observe: null, optional: true,
  },
  'organization-starter': {
    title: 'Pinned organization starter custody source',
    releaseId: /^[0-9a-f]{64}$/, observe: null, optional: true,
  },
  'private-review-broker': {
    title: 'Private payment ethical review broker',
    releaseId: /^[0-9a-f]{64}$/, observe: null, optional: true,
  },
  'private-payment-service': {
    title: 'Custody private payment service (payment reviewer and relay source release)',
    releaseId: /^[0-9a-f]{64}$/, observe: null, optional: true,
  },
  'native-chain': {
    title: 'Native chain daemon (uaind) on the validator and replica',
    releaseId: /^[0-9a-f]{64}$/, observe: null, optional: true,
  },
  'controlled-holder': {
    title: 'Operator-controlled holder compatibility runtime',
    releaseId: /^[0-9a-f]{64}$/, observe: null, optional: true,
  },
  'trade-steward': {
    title: 'UAIN Trade steward and central-review agents (BAINK host)',
    releaseId: /^[0-9a-f]{64}$/, observe: null, optional: true,
  },
  baink: {
    title:
      'BAINK standalone (baink.money and the aidollar.money/baink/ preview)',
    releaseId: /^\d{8}T\d{6}Z-[0-9a-f]{10}$/,
    observe: { url: 'https://baink.money/', header: 'x-baink-release' },
  },
  uain: {
    title:
      'UAIN main deploy (website, connection server, waitlist via deploy.yml)',
    releaseId: /^[0-9a-f]{8}$/,
    // The website image and the connection-server image each serve the commit
    // they were built from (ops/docs/build-id.mjs). A deploy rebuilds only the
    // components that changed (ops/ci-scope), so the live release is the commit
    // of whichever image was built last. Both must answer, or it is unknown.
    observe: {
      builds: [
        'https://uain.global/build.json',
        'https://uain.global/api/build',
      ],
    },
  },
};

const RECORD_KEYS = new Set([
  'schema',
  'component',
  'release_id',
  'version',
  'source_commit',
  'deployed_at',
  'prior',
  'status',
  'evidence',
  'note',
]);
const REQUIRED_KEYS = [
  'schema',
  'component',
  'release_id',
  'status',
  'evidence',
];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

// Representative secret shapes. A match anywhere in a record or observation
// file refuses the whole render.
export const SECRET_PATTERNS = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: 'private key marker',
    re: /BEGIN (?:RSA |EC |OPENSSH |ED25519 )?PRIVATE KEY/i,
  },
  { name: 'sk- API key', re: /\bsk-[A-Za-z0-9_-]{8,}/ },
  { name: 'bearer token', re: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  {
    name: 'GitHub token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: 'JWT',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    name: 'credential assignment',
    re: /\b(?:private[_-]?key|secret|password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|token)\s*[:=]\s*["']?[A-Za-z0-9+/_.=-]{8,}/i,
  },
];

export class StatusError extends Error {}

export function findSecrets(text) {
  return SECRET_PATTERNS.filter(({ re }) => re.test(text)).map(
    ({ name }) => name,
  );
}

function fail(message) {
  throw new StatusError(message);
}

function readJson(file, rel) {
  const raw = fs.readFileSync(file, 'utf8');
  const secrets = findSecrets(raw);
  if (secrets.length)
    fail(
      `${rel}: refused, looks like it contains a secret (${secrets.join(', ')})`,
    );
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${rel}: invalid JSON (${error.message})`);
  }
}

function checkEvidence(root, rel, evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0)
    fail(`${rel}: evidence must be a non-empty list of internal links`);
  for (const item of evidence) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 300)
      fail(`${rel}: evidence entries must be short strings`);
    if (item.startsWith('https://')) continue;
    if (/^[a-z]+:/i.test(item))
      fail(`${rel}: evidence ${item} must be https or a repository path`);
    const file = item.split('#')[0];
    if (path.isAbsolute(file) || file.split('/').includes('..'))
      fail(`${rel}: evidence ${item} must be a repository-relative path`);
    if (!fs.existsSync(path.join(root, file)))
      fail(`${rel}: evidence ${item} does not exist`);
  }
}

export function validateRecord(record, rel, root) {
  if (record === null || typeof record !== 'object' || Array.isArray(record))
    fail(`${rel}: a record is a JSON object`);
  for (const key of Object.keys(record))
    if (!RECORD_KEYS.has(key)) fail(`${rel}: unknown field ${key}`);
  for (const key of REQUIRED_KEYS)
    if (!(key in record)) fail(`${rel}: missing field ${key}`);
  if (record.schema !== SCHEMA) fail(`${rel}: schema must be ${SCHEMA}`);
  const component = COMPONENTS[record.component];
  if (!component) fail(`${rel}: unknown component ${record.component}`);
  if (
    typeof record.release_id !== 'string' ||
    !component.releaseId.test(record.release_id)
  )
    fail(
      `${rel}: release_id ${record.release_id} does not match the ${record.component} format`,
    );
  const expected = `${record.component}/${record.release_id}.json`;
  if (rel !== expected) fail(`${rel}: must be stored as ${expected}`);
  if (!STATUSES.includes(record.status))
    fail(
      `${rel}: status ${record.status} is not one of ${STATUSES.join(', ')}`,
    );
  if (
    record.version != null &&
    !(typeof record.version === 'string' && VERSION.test(record.version))
  )
    fail(`${rel}: version must be x.y.z or null`);
  if (
    record.source_commit != null &&
    !(
      typeof record.source_commit === 'string' &&
      COMMIT.test(record.source_commit)
    )
  )
    fail(`${rel}: source_commit must be a hex commit or null`);
  if (
    record.deployed_at != null &&
    !(
      typeof record.deployed_at === 'string' && ISO_UTC.test(record.deployed_at)
    )
  )
    fail(`${rel}: deployed_at must be an ISO UTC time (…Z) or null`);
  if (
    record.prior != null &&
    !(
      typeof record.prior === 'string' && component.releaseId.test(record.prior)
    )
  )
    fail(`${rel}: prior must be a ${record.component} release id or null`);
  if (record.prior === record.release_id)
    fail(`${rel}: prior cannot be the release itself`);
  if (
    record.note != null &&
    !(
      typeof record.note === 'string' &&
      record.note.length <= 400 &&
      !/[\n|]/.test(record.note)
    )
  )
    fail(`${rel}: note must be one line of at most 400 characters without "|"`);
  checkEvidence(root, rel, record.evidence);
  return record;
}

export function loadRecords(root) {
  const dir = path.join(root, 'docs/releases');
  const records = new Map();
  for (const name of Object.keys(COMPONENTS)) records.set(name, new Map());
  if (!fs.existsSync(dir)) return records;
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => cmp(a.name, b.name))) {
    if (!entry.isDirectory() || entry.name === 'observations') continue;
    if (!COMPONENTS[entry.name])
      fail(`docs/releases/${entry.name}: unknown component directory`);
    const compDir = path.join(dir, entry.name);
    for (const file of fs.readdirSync(compDir).sort(cmp)) {
      const rel = `${entry.name}/${file}`;
      if (!file.endsWith('.json'))
        fail(`docs/releases/${rel}: only .json release records belong here`);
      const record = validateRecord(
        readJson(path.join(compDir, file), rel),
        rel,
        root,
      );
      records.get(entry.name).set(record.release_id, record);
    }
  }
  return records;
}

export function loadPointers(root, records) {
  const file = path.join(root, 'docs/releases/current.json');
  if (!fs.existsSync(file)) fail('docs/releases/current.json is missing');
  const data = readJson(file, 'current.json');
  if (
    data.schema !== SCHEMA ||
    typeof data.current !== 'object' ||
    data.current === null
  )
    fail(
      `current.json: expected {"schema": ${SCHEMA}, "current": {component: release_id}}`,
    );
  for (const key of Object.keys(data))
    if (!['schema', 'current'].includes(key))
      fail(`current.json: unknown field ${key}`);
  const pointers = {};
  for (const [component, releaseId] of Object.entries(data.current)) {
    if (!COMPONENTS[component])
      fail(`current.json: unknown component ${component}`);
    const record = records.get(component).get(releaseId);
    if (!record)
      fail(
        `current.json: ${component} points to ${releaseId}, which has no record in docs/releases/${component}/`,
      );
    if (!CURRENT_STATUSES.includes(record.status))
      fail(
        `current.json: ${component} points to ${releaseId}, whose recorded status is ${record.status}`,
      );
    pointers[component] = releaseId;
  }
  return pointers;
}

const OBSERVATION_KEYS = new Set([
  'schema',
  'component',
  'url',
  'header',
  'observed_at',
  'observed',
  'error',
]);

export function loadObservations(root) {
  const dir = path.join(root, 'docs/releases/observations');
  const observations = {};
  if (!fs.existsSync(dir)) return observations;
  for (const file of fs.readdirSync(dir).sort(cmp)) {
    const rel = `observations/${file}`;
    const data = readJson(path.join(dir, file), rel);
    for (const key of Object.keys(data))
      if (!OBSERVATION_KEYS.has(key)) fail(`${rel}: unknown field ${key}`);
    if (!COMPONENTS[data.component] || file !== `${data.component}.json`)
      fail(`${rel}: must be stored as observations/<component>.json`);
    if (typeof data.observed_at !== 'string' || !ISO_UTC.test(data.observed_at))
      fail(`${rel}: observed_at must be ISO UTC`);
    if (typeof data.observed !== 'string' || data.observed.length === 0)
      fail(`${rel}: observed must be a string`);
    if (
      data.observed !== 'unknown' &&
      !COMPONENTS[data.component].releaseId.test(data.observed)
    )
      fail(`${rel}: observed must be a release id or "unknown"`);
    observations[data.component] = data;
  }
  return observations;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function versionKey(v) {
  return v
    ? v
        .split('.')
        .map((n) => n.padStart(6, '0'))
        .join('.')
    : '';
}

// Newest first: by version where both have one, then deployed time, then id.
function newestFirst(a, b) {
  if (a.version && b.version && a.version !== b.version)
    return cmp(versionKey(b.version), versionKey(a.version));
  if ((a.deployed_at || '') !== (b.deployed_at || ''))
    return cmp(b.deployed_at || '', a.deployed_at || '');
  return cmp(b.release_id, a.release_id);
}

function code(value) {
  return value == null ? 'not recorded' : `\`${value}\``;
}

function evidenceLinks(record) {
  return record.evidence
    .map((item, index) => {
      if (item.startsWith('https://')) return `[${index + 1}](${item})`;
      return `[${index + 1}](../../${item})`;
    })
    .join(' ');
}

// Markdown table padded the way the repository formatter (oxfmt) pads it,
// so `npm run format` leaves CURRENT.md unchanged and --check keeps passing.
function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(3, h.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells) =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i])).join(' | ')} |`;
  return [
    line(headers),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map(line),
  ];
}

export function render({ records, pointers, observations }) {
  const out = [];
  out.push(
    '<!-- GENERATED FILE. Do not edit. Source: docs/releases/current.json and docs/releases/<component>/*.json.',
    '     Regenerate with `node ops/docs/render-status.mjs`; check with `node ops/docs/render-status.mjs --check`. -->',
    '',
    '# Current releases',
    '',
    'This page is generated from one authored record per release (schema: [README](README.md)). ' +
      'The status column is what the release author recorded with evidence; it is not inferred from tests. ' +
      'The observed column comes only from an explicit `--observe` run.',
    '',
  );
  // Optional server-only components appear once an actual release is recorded.
  const components = Object.keys(COMPONENTS).filter((component) =>
    !COMPONENTS[component].optional || records.get(component)?.size > 0 || pointers[component],
  );
  const currentRows = components.map((component) => {
    const id = pointers[component];
    if (!id) return [component, 'no current pointer', '', '', '', '', ''];
    const r = records.get(component).get(id);
    return [
      component,
      code(r.release_id),
      r.version ?? 'n/a',
      r.status,
      r.deployed_at ?? 'not recorded',
      code(r.prior),
      evidenceLinks(r),
    ];
  });
  out.push(
    ...table(
      [
        'Component',
        'Current release',
        'Version',
        'Recorded status',
        'Deployed at (UTC)',
        'Prior',
        'Evidence',
      ],
      currentRows,
    ),
  );
  out.push('', '## Live observation', '');
  const observedRows = components.map((component) => {
    const obs = observations[component];
    if (!COMPONENTS[component].observe)
      return [component, 'not observable', 'unknown', 'unknown'];
    if (!obs) return [component, 'not observed', 'unknown', 'unknown'];
    if (obs.observed === 'unknown')
      return [component, obs.observed_at, 'unknown', 'unknown'];
    const agrees = obs.observed === pointers[component] ? 'yes' : 'no';
    return [component, obs.observed_at, code(obs.observed), agrees];
  });
  out.push(
    ...table(
      [
        'Component',
        'Observed at (UTC)',
        'Observed release',
        'Agrees with current pointer',
      ],
      observedRows,
    ),
  );
  for (const component of components) {
    const list = [...records.get(component).values()].sort(newestFirst);
    out.push('', `## ${component}: ${COMPONENTS[component].title}`, '');
    if (list.length === 0) {
      out.push('No release records.');
      continue;
    }
    const rows = list.map((r) => [
      code(r.release_id) +
        (pointers[component] === r.release_id ? ' (current)' : ''),
      r.version ?? 'n/a',
      r.status,
      r.deployed_at ?? 'not recorded',
      code(r.prior),
      code(r.source_commit),
      evidenceLinks(r),
      r.note ?? '',
    ]);
    out.push(
      ...table(
        [
          'Release',
          'Version',
          'Status',
          'Deployed at (UTC)',
          'Prior',
          'Commit',
          'Evidence',
          'Note',
        ],
        rows,
      ),
    );
  }
  out.push('');
  return out.join('\n');
}

export function build(root) {
  const records = loadRecords(root);
  const pointers = loadPointers(root, records);
  const observations = loadObservations(root);
  return render({ records, pointers, observations });
}

export async function observe(
  component,
  {
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    timeoutMs = 10000,
  } = {},
) {
  const spec = COMPONENTS[component]?.observe;
  if (!spec) fail(`${component} has no live observation source`);
  const observedAt = now()
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  if (spec.builds)
    return observeBuilds(component, spec.builds, {
      fetchImpl,
      observedAt,
      timeoutMs,
    });
  const result = {
    schema: SCHEMA,
    component,
    url: spec.url,
    header: spec.header,
    observed_at: observedAt,
    observed: 'unknown',
  };
  try {
    const response = await fetchImpl(spec.url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const value = response?.headers?.get?.(spec.header);
    if (!response || response.status < 200 || response.status >= 400)
      result.error = `http_${response?.status ?? 'none'}`;
    else if (
      typeof value !== 'string' ||
      !COMPONENTS[component].releaseId.test(value.trim())
    )
      result.error = 'header_missing_or_invalid';
    else result.observed = value.trim();
  } catch (error) {
    result.error =
      error?.name === 'TimeoutError' ? 'timeout' : 'request_failed';
  }
  return result;
}

/**
 * Reads a served build id (written by ops/docs/build-id.mjs). Returns
 * {component, commit, built_at}, with commit null when the image did not know
 * it, or null when the text is not a build id. Kept in this file, which stays
 * self-contained: the prose check imports it on its own.
 */
export function parseBuildId(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.schema !== 1 || !/^[a-z][a-z0-9-]{0,39}$/.test(data.component ?? ''))
    return null;
  if (
    data.commit !== null &&
    !(typeof data.commit === 'string' && /^[0-9a-f]{40}$/.test(data.commit))
  )
    return null;
  if (
    typeof data.built_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(data.built_at)
  )
    return null;
  return {
    component: data.component,
    commit: data.commit,
    built_at: data.built_at,
  };
}

/**
 * Observes a component from the build ids its images serve. Every source must
 * answer with a commit; the newest build is the live release. A source that
 * fails, or an image that does not know its commit, leaves it unknown: an
 * older image's commit is never reported as the live release by default.
 */
async function observeBuilds(component, urls, { fetchImpl, observedAt, timeoutMs }) {
  const result = {
    schema: SCHEMA,
    component,
    url: urls[0],
    observed_at: observedAt,
    observed: 'unknown',
  };
  const builds = [];
  for (const url of urls) {
    let error = null;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response || response.status !== 200)
        error = `http_${response?.status ?? 'none'}`;
      else {
        const text = await response.text();
        const build =
          typeof text === 'string' && text.length <= 4096
            ? parseBuildId(text)
            : null;
        if (!build) error = 'build_id_missing_or_invalid';
        else if (build.commit === null) error = 'commit_not_in_image';
        else builds.push({ url, ...build });
      }
    } catch (failure) {
      error = failure?.name === 'TimeoutError' ? 'timeout' : 'request_failed';
    }
    if (error) {
      result.url = url;
      result.error = error;
      return result;
    }
  }
  const newest = builds.reduce((a, b) => (b.built_at > a.built_at ? b : a));
  const id = newest.commit.slice(0, 8);
  if (!COMPONENTS[component].releaseId.test(id))
    result.error = 'build_id_missing_or_invalid';
  else {
    result.url = newest.url;
    result.observed = id;
  }
  return result;
}

export function findRoot(start) {
  let dir = start;
  for (;;) {
    if (
      fs.existsSync(path.join(dir, 'docs/releases')) ||
      fs.existsSync(path.join(dir, '.git'))
    )
      return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export async function main(
  argv,
  { fetchImpl, now, stdout = process.stdout, stderr = process.stderr } = {},
) {
  let root = null;
  let check = false;
  let doObserve = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') check = true;
    else if (arg === '--observe') doObserve = true;
    else if (arg === '--root') root = argv[++i];
    else {
      stderr.write(`unknown argument ${arg}\n`);
      return 2;
    }
  }
  if (check && doObserve) {
    stderr.write('--check and --observe cannot be combined\n');
    return 2;
  }
  root = path.resolve(root ?? findRoot(process.cwd()));
  const target = path.join(root, 'docs/releases/CURRENT.md');
  try {
    if (doObserve) {
      build(root); // validate before touching any file
      const dir = path.join(root, 'docs/releases/observations');
      fs.mkdirSync(dir, { recursive: true });
      for (const [component, spec] of Object.entries(COMPONENTS)) {
        if (!spec.observe) continue;
        const obs = await observe(component, { fetchImpl, now });
        fs.writeFileSync(
          path.join(dir, `${component}.json`),
          `${JSON.stringify(obs, null, 2)}\n`,
        );
        stdout.write(
          `${component}: observed ${obs.observed}${obs.error ? ` (${obs.error})` : ''}\n`,
        );
      }
    }
    const output = build(root);
    if (check) {
      const existing = fs.existsSync(target)
        ? fs.readFileSync(target, 'utf8')
        : null;
      if (existing !== output) {
        stderr.write(
          'docs/releases/CURRENT.md is out of date; run `node ops/docs/render-status.mjs`\n',
        );
        return 1;
      }
      stdout.write('docs/releases/CURRENT.md is current\n');
      return 0;
    }
    const existing = fs.existsSync(target)
      ? fs.readFileSync(target, 'utf8')
      : null;
    if (existing !== output) fs.writeFileSync(target, output);
    stdout.write(
      existing === output
        ? 'docs/releases/CURRENT.md unchanged\n'
        : 'wrote docs/releases/CURRENT.md\n',
    );
    return 0;
  } catch (error) {
    if (error instanceof StatusError) {
      stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}

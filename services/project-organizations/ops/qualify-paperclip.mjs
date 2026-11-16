#!/usr/bin/env node
/** Offline Paperclip contract qualifier. Reads an upstream source checkout at the
 * pinned revision, or a captured route list, and emits the sanitized contract
 * fixture the organization adapter requires. It opens no network connection, runs
 * nothing from the checkout and can issue no request. Only routes actually mounted
 * are emitted; every semantic claim (external key field, approval gate, reporting
 * line, pending-approval hire, roles, replay safety) must be backed by the accepted
 * validator fields, enum constants and the route source itself; an unknown
 * capability is refused. This is static evidence, not a live acceptance test.
 *
 *   node qualify-paperclip.mjs --source <checkout> --revision <sha> [--semantics f.json] [--out contract.json]
 *   node qualify-paperclip.mjs --routes <capture.json> --revision <sha> [--semantics f.json] [--out contract.json]
 *
 * Exit 0: qualified. Exit 3: report emitted but unqualified. Exit 1: refused.
 */
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, exactKeys, need, plain, refuse, sha256 } from '../src/common.mjs';
import {
  CAPABILITIES, CONTRACT_SCHEMA, FORBIDDEN_SEGMENT, PAPERCLIP_REPOSITORY, REQUIRED_CAPABILITIES, validateContract,
} from '../src/paperclip.mjs';

export const CAPTURE_SCHEMA = 'uain-project-organizations/paperclip-route-capture/v1';
/** Canonical template per capability; upstream parameter names may differ (`:id`). */
export const TEMPLATES = Object.freeze({
  'company.list': '/api/companies',
  'company.get': '/api/companies/:companyId',
  'company.create': '/api/companies',
  'company.update': '/api/companies/:companyId',
  'goal.list': '/api/companies/:companyId/goals',
  'goal.get': '/api/goals/:goalId',
  'goal.create': '/api/companies/:companyId/goals',
  'project.list': '/api/companies/:companyId/projects',
  'project.get': '/api/projects/:projectId',
  'project.create': '/api/companies/:companyId/projects',
  'agent.list': '/api/companies/:companyId/agents',
  'agent.get': '/api/agents/:agentId',
  'agent.hire': '/api/companies/:companyId/agent-hires',
  'issue.list': '/api/companies/:companyId/issues',
  'issue.get': '/api/issues/:issueId',
  'issue.create': '/api/companies/:companyId/issues',
});
const description = { field: 'description', format: 'trailing-line', property: null };
/** Reviewed expectations. Each is emitted only when the source backs it. */
export const DEFAULT_SEMANTICS = Object.freeze({
  'company.create': { schema: 'createCompanySchema', externalKey: description, fixed: { budgetMonthlyCents: 0 }, idempotencyField: null },
  'company.update': { schema: 'updateCompanySchema', gate: { requireBoardApprovalForNewAgents: true } },
  'goal.create': {
    schema: 'createGoalSchema', externalKey: description, fixed: { level: 'company', status: 'active' }, idempotencyField: null,
    enums: { level: 'GOAL_LEVELS', status: 'GOAL_STATUSES' },
  },
  'project.create': {
    schema: 'createProjectSchema', externalKey: description, fixed: { status: 'backlog', visibility: 'private', leadAgentId: null },
    idempotencyField: 'idempotencyKey', goalLink: ['goalIds', 'goalId'], enums: { status: 'PROJECT_STATUSES' },
    // Same key + same body returns the existing project; a changed body conflicts.
    replayEvidence: ['idempotencyKey', 'fingerprint', 'Project idempotency key was used with different inputs'],
  },
  'agent.hire': {
    schema: 'createAgentHireSchema', externalKey: { field: 'metadata', format: 'object-property', property: 'uainExternalKey' },
    fixed: {}, idempotencyField: null, responseField: 'agent', roles: { ceo: 'ceo', manager: 'pm' }, hierarchyField: 'reportsTo',
    expect: { status: 'pending_approval' }, enums: { role: 'AGENT_ROLES', status: 'AGENT_STATUSES' },
    // A hire is pending (non-invokable) exactly when the company gate is set.
    requiredEvidence: [
      'requiresApproval\\s*=\\s*company\\.requireBoardApprovalForNewAgents',
      'requiresApproval\\s*\\?\\s*"pending_approval"',
      'body:\\s*\\{\\s*agent:',
    ],
  },
  'issue.create': { schema: 'createIssueSchema', externalKey: description, fixed: {}, idempotencyField: 'idempotencyKey' },
});
const WRITES = Object.keys(DEFAULT_SEMANTICS);
/** Operators may adjust these after review; the safety evidence and hire expectation are fixed. */
const OVERRIDABLE = ['externalKey', 'fixed', 'idempotencyField', 'goalLink', 'roles', 'hierarchyField', 'gate', 'enums'];
const MAX_FILES = 400, MAX_FILE_BYTES = 8 * 1024 * 1024, MAX_SOURCES = 256;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const shape = (path) => path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':');

function regularFile(path) {
  const st = lstatSync(path);
  need(st.isFile() && !st.isSymbolicLink() && st.size <= MAX_FILE_BYTES, 'paperclip_source_unsafe', `${path} is not a bounded regular file`);
  return readFileSync(path);
}
function optionalFile(path) {
  try {
    lstatSync(path);
  } catch {
    return null;
  }
  return regularFile(path);
}
function tsFiles(dir) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return [];
  }
  need(st.isDirectory() && !st.isSymbolicLink(), 'paperclip_source_unsafe', `${dir} is not a directory`);
  const names = readdirSync(dir).filter((n) => n.endsWith('.ts')).sort(byText);
  need(names.length <= MAX_FILES, 'paperclip_source_unsafe', 'too many source files');
  return names.map((n) => join(dir, n));
}

/** Reads .git/HEAD (and its ref) without running git, so repository config cannot execute. */
function gitHead(root) {
  let st;
  try {
    st = lstatSync(join(root, '.git'));
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  const head = regularFile(join(root, '.git', 'HEAD')).toString('utf8').trim();
  const ref = head.match(/^ref: (refs\/[A-Za-z0-9._/-]{1,200})$/);
  if (!ref) return /^[a-f0-9]{40}$/.test(head) ? head : null;
  need(!ref[1].includes('..'), 'paperclip_source_unsafe');
  try {
    return regularFile(join(root, '.git', ref[1])).toString('utf8').trim();
  } catch {
    const packed = regularFile(join(root, '.git', 'packed-refs')).toString('utf8');
    return packed.split('\n').map((l) => l.split(' ')).find(([, name]) => name === ref[1])?.[0] ?? null;
  }
}

// --- A small TypeScript-aware scanner for zod schema declarations --------------

const OPEN = '{([', CLOSE = '})]';
/** Index just past the bracket matching the one at `open`, skipping strings and comments. */
function closeOf(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i);
      if (i < 0) return -1;
      i++;
      continue;
    }
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch) && --depth === 0) return i + 1;
  }
  return -1;
}
const skipWs = (src, i) => {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
};
function declaration(src, name) {
  const m = new RegExp(`(?:^|[\\n;])\\s*(?:export\\s+)?const\\s+${name}\\b\\s*(?::[^=\\n]{0,200})?=`).exec(src);
  return m ? m.index + m[0].length : -1;
}

/** Top-level keys of the object literal at `open`, resolving `...name` and `...name.shape` spreads. */
function literalKeys(src, open, depth) {
  if (src[open] !== '{' || depth > 8) return null;
  const end = closeOf(src, open);
  if (end < 0) return null;
  const keys = new Set();
  let i = open + 1, level = 1, token = '';
  while (i < end - 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`' || (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*'))) {
      const j = ch === '/' ? (src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i) + 2) : closeOfString(src, i);
      if (j <= i) return null;
      i = j;
      token = '';
      continue;
    }
    if (level === 1 && src.startsWith('...', i)) {
      const m = /^\.\.\.\s*([A-Za-z_$][\w$]*)(\.shape)?/.exec(src.slice(i, i + 120));
      if (!m) return null;
      const spread = m[2] ? schemaFieldsAt(src, declaration(src, m[1]), depth + 1) : objectAt(src, declaration(src, m[1]), depth + 1);
      if (!spread) return null;
      spread.forEach((k) => keys.add(k));
      i += m[0].length;
      token = '';
      continue;
    }
    if (OPEN.includes(ch)) level++;
    else if (CLOSE.includes(ch)) level--;
    if (level === 1 && /[\w$]/.test(ch)) token += ch;
    else if (level === 1 && ch === ':' && token) {
      if (/^[A-Za-z_$][\w$]*$/.test(token)) keys.add(token);
      token = '';
    } else if (!/\s/.test(ch)) token = '';
    i++;
  }
  return [...keys];
}
function closeOfString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === q) return j + 1;
  }
  return -1;
}
const objectAt = (src, at, depth) => (at < 0 ? null : literalKeys(src, skipWs(src, at), depth));

/** Fields of a zod expression: z.object({...}), Base.omit/pick/extend chains and wrapper(...) calls. */
function schemaFieldsAt(src, at, depth = 0) {
  if (at < 0 || depth > 8) return null;
  const i = skipWs(src, at);
  const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 120));
  if (!id) return null;
  let j = skipWs(src, i + id[0].length), fields = null;
  if (id[0] !== 'z') {
    if (src[j] === '(') {
      fields = schemaFieldsAt(src, j + 1, depth + 1);
      j = closeOf(src, j);
      if (j < 0) return null;
    } else fields = schemaFieldsAt(src, declaration(src, id[0]), depth + 1);
    if (!fields) return null;
  }
  for (;;) {
    const m = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(j, j + 200));
    if (!m) break;
    const open = j + m[0].length - 1, end = closeOf(src, open);
    if (end < 0) return null;
    const method = m[1], arg = skipWs(src, open + 1);
    const keys = ['object', 'extend', 'omit', 'pick'].includes(method) ? literalKeys(src, arg, depth + 1) : [];
    if (keys === null) return null;
    if (method === 'object') fields = keys;
    else if (fields === null) return null;
    else if (method === 'extend') fields = [...new Set([...fields, ...keys])];
    else if (method === 'omit') fields = fields.filter((f) => !keys.includes(f));
    else if (method === 'pick') fields = fields.filter((f) => keys.includes(f));
    j = end;
  }
  return fields;
}

/** Accepted top-level fields of schema `name` declared in `source`, or null. */
export function schemaFields(source, name) {
  return schemaFieldsAt(source, declaration(source, name));
}

/** `export const NAME = ["a", "b"] as const` string members, or null. */
export function constantValues(source, name) {
  const m = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[([^\\]]{0,8000})\\]`));
  return m ? [...m[1].matchAll(/["']([A-Za-z0-9_-]{1,64})["']/g)].map((x) => x[1]) : null;
}

/** Route-file basename -> mount prefixes, from `api.use("/x", xRoutes(...))` in server/src/app.ts. */
export function mountPrefixes(appSource) {
  const files = new Map();
  for (const m of appSource.matchAll(/import\s*\{([^}]{1,2000})\}\s*from\s*["']\.\/routes\/([\w.-]+)\.js["']/g))
    for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).at(-1)).filter(Boolean)) files.set(name, m[2]);
  const mounts = new Map();
  for (const m of appSource.matchAll(/\b(api|app)\.use\(\s*(?:(["'`])([^"'`]*)\2\s*,\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const file = files.get(m[4]);
    if (!file) continue;
    const prefix = m[1] === 'api' ? '/api' + (m[3] ?? '') : m[3];
    if (!prefix || !/^\/api(?:\/[A-Za-z0-9/_-]*)?$/.test(prefix)) continue;
    if (!mounts.has(file)) mounts.set(file, new Set());
    mounts.get(file).add(prefix.replace(/\/$/, ''));
  }
  return mounts;
}

function readSource(root, sem) {
  const sources = [], routes = [], routeText = new Map(), bodyFields = {}, enums = {};
  const record = (path, bytes) => sources.push({ path: relative(root, path), sha256: sha256(bytes) });
  const appPath = join(root, 'server', 'src', 'app.ts'), app = optionalFile(appPath);
  const mounts = app ? mountPrefixes(app.toString('utf8')) : null;
  if (app) record(appPath, app);
  for (const file of tsFiles(join(root, 'server', 'src', 'routes'))) {
    const bytes = regularFile(file), text = bytes.toString('utf8');
    const prefixes = mounts ? [...(mounts.get(basename(file, '.ts')) ?? [])] : ['/api'];
    // An unmounted router is unreachable; one mounted under several prefixes is ambiguous.
    if (prefixes.length !== 1) continue;
    const found = [...text.matchAll(/\brouter\.(get|post|put|patch|delete)\(\s*(["'`])(\/[^"'`\s]{0,300})\2/g)].map((m) => {
      const path = (prefixes[0] + m[3]).replace(/(.)\/$/, '$1');
      return { method: m[1].toUpperCase(), path };
    });
    if (!found.length) continue;
    record(file, bytes);
    for (const r of found) {
      routes.push(r);
      routeText.set(`${r.method} ${shape(r.path)}`, text);
    }
  }
  const constants = new Set(Object.values(sem).flatMap((s) => Object.values(s.enums ?? {})));
  const shared = [...tsFiles(join(root, 'packages', 'shared', 'src', 'validators')), ...tsFiles(join(root, 'packages', 'shared', 'src'))];
  for (const file of shared) {
    const bytes = regularFile(file), text = bytes.toString('utf8');
    let used = false;
    for (const capability of WRITES) {
      const fields = bodyFields[capability] ? null : schemaFields(text, sem[capability].schema);
      if (fields) {
        bodyFields[capability] = fields;
        used = true;
      }
    }
    for (const name of constants) {
      const values = enums[name] ? null : constantValues(text, name);
      if (values) {
        enums[name] = values;
        used = true;
      }
    }
    if (used) record(file, bytes);
  }
  need(sources.length <= MAX_SOURCES, 'paperclip_source_unsafe', 'too many contributing source files');
  const evidence = (capability) => routeText.get(`${CAPABILITIES[capability]} ${shape(TEMPLATES[capability])}`) ?? '';
  return { routes, bodyFields, enums, sources, evidence };
}

function readCapture(capture, revision) {
  need(exactKeys(capture, ['schema', 'revision', 'capturedAt', 'routes', 'bodyFields', 'enums', 'routeEvidence']) &&
    capture.schema === CAPTURE_SCHEMA, 'paperclip_capture_invalid');
  need(capture.revision === revision, 'paperclip_source_revision_mismatch');
  need(!Number.isNaN(Date.parse(capture.capturedAt)) && Array.isArray(capture.routes) && capture.routes.length <= 2000, 'paperclip_capture_invalid');
  for (const r of capture.routes)
    need(exactKeys(r, ['method', 'path']) && /^(GET|POST|PUT|PATCH|DELETE)$/.test(r.method) && typeof r.path === 'string' &&
      /^\/api\/[^\s?#]{0,300}$/.test(r.path), 'paperclip_capture_invalid');
  need(plain(capture.bodyFields) && plain(capture.enums) && plain(capture.routeEvidence), 'paperclip_capture_invalid');
  for (const k of [...Object.keys(capture.bodyFields), ...Object.keys(capture.routeEvidence)])
    if (!WRITES.includes(k)) refuse('paperclip_capability_unknown', `unknown capability ${k}`);
  for (const v of [...Object.values(capture.bodyFields), ...Object.values(capture.enums)])
    need(Array.isArray(v) && v.length <= 128 && v.every((f) => typeof f === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(f)), 'paperclip_capture_invalid');
  for (const k of Object.keys(capture.enums)) need(/^[A-Z][A-Z0-9_]{1,63}$/.test(k), 'paperclip_capture_invalid');
  for (const v of Object.values(capture.routeEvidence)) need(typeof v === 'string' && v.length <= 8192, 'paperclip_capture_invalid');
  return { routes: capture.routes, bodyFields: capture.bodyFields, enums: capture.enums, sources: [],
    evidence: (capability) => capture.routeEvidence[capability] ?? '' };
}

function semanticsOf(overrides) {
  if (overrides === undefined) return DEFAULT_SEMANTICS;
  need(plain(overrides), 'paperclip_semantics_invalid');
  const merged = { ...DEFAULT_SEMANTICS };
  for (const [capability, value] of Object.entries(overrides)) {
    if (!WRITES.includes(capability)) refuse('paperclip_capability_unknown', `unknown capability ${capability}`);
    need(plain(value) && Object.keys(value).every((k) => OVERRIDABLE.includes(k)), 'paperclip_semantics_invalid');
    merged[capability] = { ...DEFAULT_SEMANTICS[capability], ...value };
  }
  return merged;
}
const matchesAll = (text, patterns) => patterns.every((p) => new RegExp(p).test(text));

/** Builds a write capability only from accepted fields and route evidence; returns a reason when it cannot. */
function writeCapability(capability, path, fields, sem, enums, routeSource) {
  if (!fields) return { reason: `validator ${sem.schema} not found` };
  const has = (f) => fields.includes(f);
  const sorted = [...fields].sort(byText);
  if (capability === 'company.update') {
    const absent = Object.keys(sem.gate).find((f) => !has(f));
    if (absent) return { reason: `gate field ${absent} not accepted` };
    return { capability: { method: 'PATCH', path, bodyFields: sorted, gate: sem.gate } };
  }
  if (!has(sem.externalKey.field)) return { reason: `external key field ${sem.externalKey.field} not accepted` };
  const absent = Object.keys(sem.fixed).find((f) => !has(f));
  if (absent) return { reason: `field ${absent} not accepted` };
  for (const [field, constant] of Object.entries(sem.enums ?? {})) {
    const values = field === 'role' ? Object.values(sem.roles) : [sem.fixed[field] ?? sem.expect?.[field]].filter((v) => v !== undefined);
    if (!values.length) continue;
    const allowed = enums[constant];
    if (!allowed) return { reason: `${constant} not found` };
    const bad = values.find((v) => !allowed.includes(v));
    if (bad !== undefined) return { reason: `${field} value ${bad} not in ${constant}` };
  }
  const idempotencyField = sem.idempotencyField && has(sem.idempotencyField) ? sem.idempotencyField : null;
  const out = {
    method: 'POST', path, bodyFields: sorted, externalKey: sem.externalKey, idempotencyField,
    replaySafe: Boolean(idempotencyField && sem.replayEvidence && routeSource && sem.replayEvidence.every((s) => routeSource.includes(s))),
    fixed: sem.fixed, responseField: sem.responseField ?? null,
  };
  if (capability === 'project.create') {
    const link = sem.goalLink.find(has);
    if (!link) return { reason: 'no goal link field accepted' };
    out.goalLink = link;
  }
  if (capability === 'agent.hire') {
    if (!has('role')) return { reason: 'field role not accepted' };
    if (!has(sem.hierarchyField)) return { reason: `reporting line field ${sem.hierarchyField} not accepted` };
    if (!matchesAll(routeSource, sem.requiredEvidence)) return { reason: 'pending-approval hire behaviour not found in route source' };
    Object.assign(out, { roles: sem.roles, hierarchyField: sem.hierarchyField, expect: sem.expect });
  }
  return { capability: out };
}

/**
 * @param input {sourceDir} or {capture} plus the asserted `revision`
 * @returns the sanitized contract (qualified or with an explicit `missing` list)
 */
export function qualifyPaperclip({ sourceDir, capture, revision, semantics, now = () => new Date() }) {
  need(/^[a-f0-9]{40}$/.test(revision ?? ''), 'paperclip_revision_invalid');
  need(Boolean(sourceDir) !== Boolean(capture), 'paperclip_qualifier_input', 'give exactly one of a source checkout or a route capture');
  const sem = semanticsOf(semantics);
  let evidence, method, revisionEvidence = 'asserted';
  if (sourceDir) {
    const head = gitHead(sourceDir);
    if (head !== null) {
      need(head === revision, 'paperclip_source_revision_mismatch', 'checkout HEAD differs from the asserted revision');
      revisionEvidence = 'git-head';
    }
    evidence = readSource(sourceDir, sem);
    method = 'source-checkout';
  } else {
    evidence = readCapture(capture, revision);
    method = 'route-capture';
  }
  const present = new Set(evidence.routes.filter((r) => !r.path.split('/').some((s) => FORBIDDEN_SEGMENT.test(s)))
    .map((r) => `${r.method} ${shape(r.path)}`));
  const capabilities = {}, missing = [];
  for (const name of Object.keys(CAPABILITIES)) {
    const path = TEMPLATES[name], verb = CAPABILITIES[name];
    let reason = present.has(`${verb} ${shape(path)}`) ? null : `route ${verb} ${path} not present`;
    if (!reason) {
      const kind = name.split('.')[1];
      if (kind === 'list') capabilities[name] = { method: verb, path, pagination: null };
      else if (kind === 'get') capabilities[name] = { method: verb, path };
      else {
        const built = writeCapability(name, path, evidence.bodyFields[name] ?? null, sem[name], evidence.enums, evidence.evidence(name));
        if (built.capability) capabilities[name] = built.capability;
        else reason = built.reason;
      }
    }
    if (reason && REQUIRED_CAPABILITIES.includes(name)) missing.push(`${name}: ${reason}`);
  }
  const contract = {
    schema: CONTRACT_SCHEMA,
    upstream: { repository: PAPERCLIP_REPOSITORY, revision },
    qualification: {
      status: missing.length ? 'unqualified' : 'qualified',
      method,
      revisionEvidence,
      qualifiedAt: now().toISOString(),
      evidenceDigest: digest({
        revision, method, sources: evidence.sources,
        routes: [...present].sort(byText), bodyFields: evidence.bodyFields, enums: evidence.enums,
      }),
      missing,
      sources: evidence.sources,
    },
    capabilities,
  };
  validateContract(contract, { requireQualified: !missing.length, requirePinned: false });
  return contract;
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    need(['--source', '--routes', '--revision', '--semantics', '--out'].includes(argv[i]) && argv[i + 1], 'paperclip_qualifier_usage');
    args[argv[i].slice(2)] = argv[i + 1];
  }
  const json = (path) => JSON.parse(regularFile(path).toString('utf8'));
  const contract = qualifyPaperclip({
    sourceDir: args.source,
    capture: args.routes ? json(args.routes) : undefined,
    revision: args.revision,
    semantics: args.semantics ? json(args.semantics) : undefined,
  });
  const body = JSON.stringify(contract, null, 2) + '\n';
  if (args.out) writeFileSync(args.out, body, { mode: 0o644 });
  else process.stdout.write(body);
  return contract.qualification.status === 'qualified' ? 0 : 3;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.code ?? 'paperclip_qualifier_failed', message: e.code ? e.message : 'unexpected failure' }) + '\n');
    process.exitCode = 1;
  }
}

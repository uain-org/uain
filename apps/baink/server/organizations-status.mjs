/** Private, read-only projection of the 120 project organizations' acceptance reports.
 *
 * Source: the combined `acceptance.json` written by services/project-organizations
 * (writeReports). The file is re-validated on every change; a missing, oversized,
 * symlinked or malformed source is `organizations_status_unavailable` (503), never an
 * empty or zero report. Only an explicit operator allowlist may read it. The projection
 * copies a fixed set of fields: provider costs, credentials, tokens, envelopes and any
 * unlisted evidence field are dropped, and each row carries only its own project's data.
 */
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export class OrganizationsStatusError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const unavailable = () => {
  throw new OrganizationsStatusError(503, 'organizations_status_unavailable', 'Project organization status is unavailable.');
};

const COMBINED_SCHEMA = 'uain-project-organization-acceptance-v1';
const OPERATIONAL_SCHEMA = 'uain-project-organization-operational-readiness-v1';
const REWARD_SCHEMA = 'uain-project-organization-reward-acceptance-v1';
const OPERATIONAL = ['organization', 'ceoRun', 'managerRun', 'nativeAdmission', 'approvedPlan', 'allowance', 'reservedTask', 'workerAttempt'];
const REWARD = ['submission', 'independentReview', 'awards', 'accountReadback'];
const STATUSES = new Set(['pass', 'missing', 'unknown', 'held']);
const ROW_STATUSES = new Set(['pass', 'held', 'incomplete']);
const ADDRESS = /^uain1[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const CATALOGUE = /^OPP-[0-9]{5}$/;
const NATIVE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
// Acceptance reasons may name camelCase binding fields (e.g. binding_missing:paperclipCompanyId).
const REASON = /^[A-Za-z0-9_:,.-]{1,200}$/;
const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_PAGE_SIZE = 60;
/** Evidence fields that may leave the operator host. Everything else is dropped. */
const EVIDENCE_FIELDS = new Set(['chainId', 'height', 'appHash', 'recordKey', 'manager', 'evaluator', 'revision', 'allocation', 'reserved', 'paid',
  'round', 'available', 'taskId', 'solverAmount', 'reviewerAmount', 'state', 'reservedTasks', 'submissionId', 'author', 'submissions', 'verdict',
  'reviewer', 'executionId', 'companyId', 'ceoAgentId', 'managerAgentId', 'readAt', 'runId', 'agentId', 'finishedAt', 'lastRunId', 'lastOutcome',
  'lastFinishedAt', 'attemptId', 'outcome', 'awards', 'accounts', 'intentId', 'operation']);
const LIST_FIELDS = { awards: ['role', 'member', 'amount'], accounts: ['member', 'total', 'readAt'] };

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const scalar = (v) => (typeof v === 'string' && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v)) || typeof v === 'boolean' || Number.isSafeInteger(v);
const ensure = (ok) => {
  if (!ok) unavailable();
};

function evidenceOf(e) {
  if (e === null || e === undefined) return null;
  ensure(plain(e));
  const out = {};
  for (const [k, v] of Object.entries(e)) {
    if (!EVIDENCE_FIELDS.has(k)) continue;
    if (LIST_FIELDS[k]) {
      ensure(Array.isArray(v) && v.length <= 4);
      out[k] = v.map((item) => {
        ensure(plain(item));
        return Object.fromEntries(LIST_FIELDS[k].filter((f) => scalar(item[f])).map((f) => [f, item[f]]));
      });
    } else if (scalar(v) || v === null) out[k] = v;
  }
  return out;
}
function cellOf(c) {
  ensure(plain(c) && STATUSES.has(c.status) && (c.reason === null || (typeof c.reason === 'string' && REASON.test(c.reason))));
  return { status: c.status, reason: c.reason, evidence: evidenceOf(c.evidence) };
}
function reportOf(r, schema, columns, digest) {
  ensure(plain(r) && r.schema === schema && r.selectionDigest === digest && Array.isArray(r.projects) && r.projects.length === 120);
  ensure(Array.isArray(r.columns) && r.columns.length === columns.length && r.columns.every((c, i) => c === columns[i]));
  const seen = new Set();
  const rows = r.projects.map((row) => {
    ensure(plain(row) && CATALOGUE.test(row.projectId) && NATIVE.test(row.nativeProjectId) && ROW_STATUSES.has(row.status) && plain(row.columns) && !seen.has(row.projectId));
    seen.add(row.projectId);
    ensure(Array.isArray(row.holds) && row.holds.every((h) => typeof h === 'string' && REASON.test(h)));
    const cells = Object.fromEntries(columns.map((c) => [c, cellOf(row.columns[c])]));
    const all = Object.values(cells).map((c) => c.status);
    // The stored row status must follow from its cells; a report cannot claim pass by fiat.
    ensure(row.status === (all.every((s) => s === 'pass') ? 'pass' : all.includes('held') ? 'held' : 'incomplete'));
    return { projectId: row.projectId, nativeProjectId: row.nativeProjectId, holds: [...row.holds], status: row.status, columns: cells };
  });
  const passed = rows.filter((x) => x.status === 'pass').length;
  ensure(r.complete === (passed === 120));
  const counts = { pass: passed, held: rows.filter((x) => x.status === 'held').length, incomplete: rows.filter((x) => x.status === 'incomplete').length };
  return { rows, counts, complete: passed === 120 };
}
function parse(bytes) {
  let raw;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    unavailable();
  }
  ensure(plain(raw) && raw.schema === COMBINED_SCHEMA && typeof raw.selectionDigest === 'string' && HASH.test(raw.selectionDigest) &&
    typeof raw.generatedAt === 'string' && !Number.isNaN(Date.parse(raw.generatedAt)));
  const op = reportOf(raw.operationalReadiness, OPERATIONAL_SCHEMA, OPERATIONAL, raw.selectionDigest);
  const rw = reportOf(raw.rewardAcceptance, REWARD_SCHEMA, REWARD, raw.selectionDigest);
  ensure(op.rows.every((row, i) => row.projectId === rw.rows[i].projectId && row.nativeProjectId === rw.rows[i].nativeProjectId));
  const stages = [1, 5, 20, 120].map((n) => {
    const members = op.rows.slice(0, n);
    const passed = members.filter((x) => x.status === 'pass').length, held = members.filter((x) => x.status === 'held').length;
    return { stage: n, reached: passed > 0 && passed + held === n, passed, held };
  });
  return {
    selectionDigest: raw.selectionDigest, generatedAt: raw.generatedAt, sourceDigest: createHash('sha256').update(bytes).digest('hex'),
    stages, operational: op, reward: rw,
  };
}

export function organizationsStatusFromEnv(env = process.env) {
  const path = env.BAINK_ORGANIZATIONS_ACCEPTANCE_PATH || null;
  const operators = (env.BAINK_ORGANIZATIONS_OPERATORS ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  return { path, operators };
}

/** @param {{path?: string|null, operators?: string[]}} config */
export function createOrganizationsStatus({ path = null, operators = [] } = {}) {
  // An invalid source path is reported as an unavailable source (503), not a startup crash.
  if (path !== null && (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || path.includes('\0'))) path = null;
  if (!Array.isArray(operators) || operators.length > 50 || operators.some((a) => typeof a !== 'string' || !ADDRESS.test(a)))
    throw new Error('Invalid organizations operator configuration.');
  const allowed = new Set(operators);
  let cache = null;
  async function load() {
    if (path === null) unavailable();
    let info;
    try {
      info = await lstat(path);
    } catch {
      unavailable();
    }
    ensure(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= MAX_BYTES);
    const stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
    if (cache?.stamp === stamp) return cache.value;
    let bytes;
    try {
      bytes = await readFile(path);
    } catch {
      unavailable();
    }
    ensure(bytes.length === info.size);
    const value = parse(bytes);
    cache = { stamp, value };
    return value;
  }
  return Object.freeze({
    configured: path !== null && allowed.size > 0,
    authorize(user) {
      if (!user || !allowed.has(user.address))
        throw new OrganizationsStatusError(403, 'organizations_status_forbidden', 'You do not have permission to view project organization status.');
    },
    /** @param {URLSearchParams} params */
    async page(params) {
      const q = Object.create(null);
      for (const [k, v] of params) {
        if (!['page', 'pageSize'].includes(k) || Object.hasOwn(q, k) || !/^[1-9][0-9]{0,3}$/.test(v))
          throw new OrganizationsStatusError(400, 'invalid_organizations_page', 'Choose a valid page and page size.');
        q[k] = Number(v);
      }
      const page = q.page ?? 1, pageSize = q.pageSize ?? 20;
      const pages = Math.ceil(120 / pageSize);
      if (pageSize > MAX_PAGE_SIZE || page > pages)
        throw new OrganizationsStatusError(400, 'invalid_organizations_page', 'Choose a valid page and page size.');
      const s = await load();
      const start = (page - 1) * pageSize;
      const projects = s.operational.rows.slice(start, start + pageSize).map((row, i) => {
        const reward = s.reward.rows[start + i];
        return { projectId: row.projectId, nativeProjectId: row.nativeProjectId, holds: row.holds,
          operational: { status: row.status, columns: row.columns }, reward: { status: reward.status, columns: reward.columns } };
      });
      return {
        authority: 'receipt-derived-acceptance',
        source: { status: 'available', generatedAt: s.generatedAt, digest: s.sourceDigest },
        selectionDigest: s.selectionDigest,
        total: 120, page, pageSize, pages,
        counts: { operational: s.operational.counts, reward: s.reward.counts },
        complete: { operational: s.operational.complete, reward: s.reward.complete },
        stages: s.stages,
        projects,
      };
    },
  });
}

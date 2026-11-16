/** Operator-published, solver-facing requirements. Native proofs authenticate task
 * terms; this artifact is explicitly operator-published, not a native policy proof.
 * No custody directories, remote URLs or arbitrary files are read from a task. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, dirname, parse } from 'node:path';
const hash = x => createHash('sha256').update(x).digest('hex');
const HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const plain = x => x && Object.getPrototypeOf(x) === Object.prototype;
const exact = (x, keys) => plain(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const check = ok => { if (!ok) throw Error('Invalid public task requirements artifact.'); };
const text = (s, max) => typeof s === 'string' && s.length > 0 && Buffer.byteLength(s) <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
const canonical = x => {
  if (x === null || typeof x !== 'object') { check(x === null || ['string', 'boolean'].includes(typeof x) || Number.isSafeInteger(x)); return JSON.stringify(x); }
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  check(plain(x)); return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
};
export const publicPolicyDigest = p => hash(canonical(p));
const identifier = (kind, value) => {
  const patterns = {
    doi: /^10\.[0-9]{4,9}\/[-._;()/:a-z0-9<>[\]]{1,200}$/,
    arxiv: /^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]{2,20}(?:\.[a-z]{2})?\/[0-9]{7})$/,
    github: /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/,
    pubmed: /^[1-9][0-9]{0,9}$/, nct: /^NCT[0-9]{8}$/, wikidata: /^Q[1-9][0-9]{0,11}$/,
  };
  return typeof value === 'string' && patterns[kind]?.test(value);
};
const KINDS = new Set(['doi', 'arxiv', 'github', 'pubmed', 'nct', 'wikidata']);
export function validatePublicRequirements(row) {
  check(exact(row, ['taskId', 'projectId', 'criteriaDigest', 'evidenceDigest', 'policyDigest', 'policy']));
  check(ID.test(row.taskId) && ID.test(row.projectId) && [row.criteriaDigest, row.evidenceDigest, row.policyDigest].every(v => HASH.test(v)));
  const p = row.policy;
  check(exact(p, ['schema', 'class', 'taskId', 'projectId', 'criteriaDigest', 'inputs', 'primarySourceHosts', 'driver', 'successTests']));
  check(p.schema === 'uain-task-verification-policy-v1' && p.class === 'prior_art_survey' && p.taskId === row.taskId && p.projectId === row.projectId && p.criteriaDigest === row.criteriaDigest);
  check(publicPolicyDigest(p) === row.policyDigest && Array.isArray(p.inputs) && p.inputs.length === 0);
  check(Array.isArray(p.primarySourceHosts) && p.primarySourceHosts.length <= 12 && p.primarySourceHosts.every(s => typeof s === 'string' && /^[a-z0-9.-]{1,253}$/.test(s)));
  check(exact(p.driver, ['name', 'sha256']) && p.driver.name === 'prior-art-survey' && HASH.test(p.driver.sha256));
  check(Array.isArray(p.successTests) && p.successTests.length === 1);
  const t = p.successTests[0];
  check(exact(t, ['id', 'mainKpi', 'minIncluded', 'minKinds', 'requiredIds']) && t.id === 'survey' && text(t.mainKpi, 4096) && t.mainKpi.trim().length >= 20);
  check(Number.isInteger(t.minIncluded) && t.minIncluded >= 1 && t.minIncluded <= 60 && Number.isInteger(t.minKinds) && t.minKinds >= 1 && t.minKinds <= 6);
  check(Array.isArray(t.requiredIds) && t.requiredIds.length <= 40 && t.requiredIds.every(r => exact(r, ['kind', 'id']) && KINDS.has(r.kind) && identifier(r.kind, r.id)));
  check(new Set(t.requiredIds.map(r => `${r.kind}:${r.id}`)).size === t.requiredIds.length);
  return structuredClone(row);
}
export async function createCentralTaskRequirements({ path = null, pins = null } = {}) {
  const rows = new Map(), network = pins ? {chainId:pins.chainId,epoch:pins.epoch} : null;
  if (path !== null) {
    check(typeof path === 'string' && isAbsolute(path) && await realpath(path) === path);
    let parent = dirname(path);
    for (;;) {
      const info = await lstat(parent);
      check(info.isDirectory() && !info.isSymbolicLink() && [0, process.getuid()].includes(info.uid) && !(info.mode & 0o022));
      if (parent === parse(parent).root) break;
      parent = dirname(parent);
    }
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await fd.stat();
      check(s.isFile() && s.nlink === 1 && [0, process.getuid()].includes(s.uid) && !(s.mode & 0o022) && s.size > 0 && s.size <= 1024 * 1024);
      const bounded = Buffer.alloc(s.size + 1); let length = 0;
      while (length < bounded.length) { const read = await fd.read(bounded, length, bounded.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
      const after = await fd.stat();
      check(length === s.size && after.size === s.size && after.mtimeMs === s.mtimeMs && after.ctimeMs === s.ctimeMs && after.nlink === 1 && !(after.mode & 0o022));
      const bytes = bounded.subarray(0, length);
      const data = JSON.parse(bytes.toString('utf8'));
      check(exact(data, ['schema', 'chainId', 'genesisSha256', 'tasks']) && data.schema === 'baink-public-task-requirements-v1' && data.chainId === pins?.chainId && data.genesisSha256 === pins?.epoch && HASH.test(data.genesisSha256) && Array.isArray(data.tasks) && data.tasks.length <= 120);
      for (const raw of data.tasks) { const row = validatePublicRequirements(raw); check(!rows.has(row.taskId)); rows.set(row.taskId, row); }
    } finally { await fd.close(); }
  }
  return Object.freeze({ forTask(task) {
    if (network && (pins?.chainId !== network.chainId || pins?.epoch !== network.epoch)) return { available:false, reason:"network_changed" };
    const row = rows.get(task.id);
    if (!row) return { available: false, reason: 'not_published' };
    if (row.projectId !== task.project || row.criteriaDigest !== task.acceptance_digest || row.evidenceDigest !== task.evidence_digest)
      return { available: false, reason: 'task_binding_changed' };
    return { available: true, authority: 'operator-published', policyDigest: row.policyDigest, policy: structuredClone(row.policy) };
  } });
}

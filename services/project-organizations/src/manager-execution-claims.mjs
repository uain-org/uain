/** Durable metadata-only manager execution accounting. Never calls a provider or native signer. */
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, linkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { CATALOGUE_ID, UUID, canonical, digest, need, plain, sha256 } from './common.mjs';
export const CLAIM_SCHEMA = 'uain-manager-execution-claim-v1';
export const TERMINAL_SCHEMA = 'uain-manager-stage-run-v2';
const bad = (ok) => need(ok, 'execution_claim_invalid');
const hasUnknownReason = r => [r.reason,r.ceo?.reason,r.manager?.reason,...(r.tasks ?? []).map(t=>t.assessment?.reason)].includes('provider_outcome_unknown');
const fields = (x, keys) => plain(x) && Object.keys(x).sort().join() === keys.slice().sort().join();
const stamp = (at) => new Date(at).toISOString().replace(/[:.]/g, '-');
const uid = () => process.getuid?.();
const metadata = s => [s.dev,s.ino,s.mode,s.nlink,s.uid,s.gid,s.size,s.mtimeMs,s.ctimeMs];
const sameMetadata = (a,b) => metadata(a).every((v,i) => v === metadata(b)[i]);
function directory(path) { const s = lstatSync(path); bad(s.isDirectory() && !s.isSymbolicLink() && s.uid === uid() && !(s.mode & 0o022)); }
function syncDir(path) { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function createDirectory(path, root) {
  bad(path === root || path.startsWith(root + '/')); directory(root);
  let current = root;
  for (const part of path.slice(root.length + 1).split('/').filter(Boolean)) {
    const parent = current; current = join(current,part);
    if (!existsSync(current)) { mkdirSync(current,{ mode: 0o700 }); syncDir(parent); }
    directory(current); syncDir(current);
  }
}
function durable(path, value, root) {
  createDirectory(dirname(path), root); bad(!existsSync(path)); const temp = path + '.tmp-' + process.pid;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  linkSync(temp, path); unlinkSync(temp); syncDir(dirname(path));
}
function read(path, max = 4 * 1024 * 1024) {
  const initial = lstatSync(path); bad(initial.isFile() && !initial.isSymbolicLink());
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const a = fstatSync(fd); bad(a.isFile() && a.nlink === 1 && a.uid === uid() && !(a.mode & 0o022) && a.size <= max && sameMetadata(initial,a));
    const b = Buffer.alloc(max + 1); let n = 0; while (n < b.length) { const k = readSync(fd, b, n, b.length - n, n); if (!k) break; n += k; }
    const z = fstatSync(fd), p = lstatSync(path); bad(n === a.size && n <= max && p.isFile() && !p.isSymbolicLink() && sameMetadata(initial,a) && sameMetadata(a,z) && sameMetadata(z,p)); return JSON.parse(b.subarray(0, n));
  } catch (e) { need(false, 'execution_claim_invalid'); } finally { closeSync(fd); }
}
function projectDirectories(path) { if (!existsSync(path)) return []; directory(path); return readdirSync(path).sort().map(id => { bad(CATALOGUE_ID.test(id)); directory(join(path, id)); return id; }); }
function jsonFiles(path) { return readdirSync(path).filter(n => n.endsWith('.json') && !n.endsWith('.refused.json')).sort(); }
function claimFiles(path) {
  const names = readdirSync(path).sort();
  for (const name of names) {
    if (name.endsWith('.json')) { bad(lstatSync(join(path,name)).isFile()); continue; }
    bad(name.endsWith('.json.attempts') && names.includes(name.slice(0,-9)));
    directory(join(path,name));
  }
  return names.filter(name => name.endsWith('.json'));
}
function validateClaim(c, project, name) {
  bad(fields(c, ['schema','runId','project','startedAt','configDigest','maxTasks','maxProviderCalls','claimDigest']) && c.schema === CLAIM_SCHEMA && c.project === project && UUID.test(c.runId) && Number.isFinite(Date.parse(c.startedAt)) && /^[a-f0-9]{64}$/.test(c.configDigest) && Number.isInteger(c.maxTasks) && c.maxTasks >= 1 && c.maxTasks <= 8 && c.maxProviderCalls === 2 + c.maxTasks);
  const { claimDigest, ...payload } = c; bad(claimDigest === digest(payload) && name === `${stamp(c.startedAt)}-${c.runId}.json`); return c;
}
function attempts(path, claim) {
  const dir = path + '.attempts'; if (!existsSync(dir)) return []; directory(dir); const names = readdirSync(dir).sort((a,b)=>Number.parseInt(a,10)-Number.parseInt(b,10)); bad(names.length <= claim.maxProviderCalls);
  const seen = new Set(); return names.map((name, i) => { bad(name === `${i + 1}.json`); const a = read(join(dir, name), 16384); bad(fields(a, ['claimDigest','id','role','slot','startedAt','promptDigest']) && a.claimDigest === claim.claimDigest && UUID.test(a.id) && !seen.has(a.id) && a.slot === i + 1 && a.role === (i === 0 ? 'ceo' : i === 1 ? 'manager' : 'assessor') && Number.isFinite(Date.parse(a.startedAt)) && /^[a-f0-9]{64}$/.test(a.promptDigest)); seen.add(a.id); return a; });
}
export function executionHistory(stageRoot, configuredProjects, nowMs) {
  const root = realpathSync(stageRoot), claims = new Map(), terminals = new Map(), usedRunIds = new Set(), usedExecutionIds = new Set(), last = {}; let executions = 0; const unresolved = [];
  const claimRoot = join(root, 'execution-claims');
  for (const project of projectDirectories(claimRoot)) for (const name of claimFiles(join(claimRoot, project))) { const path = join(claimRoot, project, name), c = validateClaim(read(path, 16384), project, name); bad(!usedRunIds.has(c.runId)); usedRunIds.add(c.runId); const a = attempts(path, c); for (const x of a) { bad(!usedExecutionIds.has(x.id)); usedExecutionIds.add(x.id); } claims.set(c.runId, { claim: c, path, attempts: a }); }
  const runRoot = join(root, 'runs');
  for (const project of projectDirectories(runRoot)) for (const name of jsonFiles(join(runRoot, project))) { const r = read(join(runRoot, project, name)); const at = Date.parse(r.startedAt); bad(plain(r) && Number.isFinite(at) && (!r.project || r.project === project));
    if (r.schema === TERMINAL_SCHEMA || Object.hasOwn(r, 'executionClaimDigest') || claims.has(r.runId)) { bad(UUID.test(r.runId) && !terminals.has(r.runId)); terminals.set(r.runId, r); continue; }
    // Existing completed records keep their old format and conservative missing-count fallback.
    need(['ceo_refused','manager_refused','no_rewardable_tasks','batched'].includes(r.status) && !hasUnknownReason(r), 'legacy_run_unresolved');
    if (r.runId !== undefined) { bad(UUID.test(r.runId) && !usedRunIds.has(r.runId)); usedRunIds.add(r.runId); }
    for (const id of [r.ceo?.executionId, r.manager?.executionId, ...(r.tasks ?? []).map(t => t.assessment?.executionId)].filter(Boolean)) { bad(UUID.test(id) && !usedExecutionIds.has(id)); usedExecutionIds.add(id); }
    bad(!Object.hasOwn(r,'executions') || Number.isSafeInteger(r.executions) && r.executions >= 0 && r.executions <= 10);
    if (!configuredProjects.includes(project)) continue; last[project] = Math.max(last[project] ?? -Infinity, at); if (nowMs - at < 24 * 3600e3) executions += Number.isSafeInteger(r.executions) ? r.executions : 10;
  }
  for (const [id, entry] of claims) { const c = entry.claim, r = terminals.get(id), at = Date.parse(c.startedAt); last[c.project] = Math.max(last[c.project] ?? -Infinity, at); let charged = c.maxProviderCalls;
    if (r) { bad(r.schema === TERMINAL_SCHEMA && r.project === c.project && r.startedAt === c.startedAt && r.executionClaimDigest === c.claimDigest && r.maxTasks === c.maxTasks && r.maxProviderCalls === c.maxProviderCalls && Number.isInteger(r.executions) && r.executions >= 0 && r.executions <= c.maxProviderCalls && typeof r.executionOutcomeUnknown === 'boolean' && (r.executionOutcomeUnknown || !hasUnknownReason(r)) && canonical(r.executionAttempts) === canonical(entry.attempts) && r.executions === entry.attempts.length && ['ceo_refused','manager_refused','no_rewardable_tasks','batched'].includes(r.status) && Number.isFinite(Date.parse(r.finishedAt)) && Date.parse(r.finishedAt) >= at); if (!r.executionOutcomeUnknown) charged = r.executions; }
    if (!r || r.executionOutcomeUnknown) unresolved.push({ project: c.project, runId: id, claimDigest: c.claimDigest }); if (nowMs - at < 24 * 3600e3) executions += charged; terminals.delete(id);
  }
  bad(terminals.size === 0); return { last, executions, unresolved, usedRunIds, usedExecutionIds };
}
/** An unresolved provider outcome holds only its own project; other projects keep running (9 Nov 2026). */
export function reserveExecutionClaim({ stageRoot, project, runId, startedAt, configDigest, maxTasks }) {
  const root = realpathSync(stageRoot); bad(CATALOGUE_ID.test(project) && UUID.test(runId) && Number.isFinite(Date.parse(startedAt)) && /^[a-f0-9]{64}$/.test(configDigest) && Number.isInteger(maxTasks) && maxTasks >= 1 && maxTasks <= 8);
  const old = executionHistory(root, [], Date.parse(startedAt)); bad(!old.usedRunIds.has(runId)); need(old.unresolved.every(u => u.project !== project), 'execution_outcome_unknown');
  const payload = { schema: CLAIM_SCHEMA, runId, project, startedAt, configDigest, maxTasks, maxProviderCalls: 2 + maxTasks }, claim = { ...payload, claimDigest: digest(payload) }, path = join(root, 'execution-claims', project, `${stamp(startedAt)}-${runId}.json`); durable(path, claim, root); return { claim, path, root, attempts: [], unknown: false, usedExecutionIds: old.usedExecutionIds };
}
export function claimedProvider(provider, entry) {
  return { ...provider, async execute(input) { try { bad(!entry.unknown && input.projectId === entry.claim.project && UUID.test(input.executionId) && !entry.usedExecutionIds.has(input.executionId) && entry.attempts.length < entry.claim.maxProviderCalls); const slot = entry.attempts.length + 1, role = slot === 1 ? 'ceo' : slot === 2 ? 'manager' : 'assessor'; bad(input.role === role);
    const attempt = { claimDigest: entry.claim.claimDigest, id: input.executionId, role, slot, startedAt: new Date().toISOString(), promptDigest: sha256(input.prompt) }; durable(join(entry.path + '.attempts', `${slot}.json`), attempt, entry.root); entry.attempts.push(attempt); entry.usedExecutionIds.add(input.executionId);
    return await provider.execute(input); } catch (e) { entry.unknown = true; throw e; }
  } };
}

/** Persistent per-project organization bindings. A binding is an identity map only:
 * it never implies native admission, funding or a successful agent run. */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ADDRESS, NATIVE_ID, UUID, need, plain } from './common.mjs';

/** Field -> [validator, unique across projects]. */
export const BINDING_FIELDS = Object.freeze({
  nativeProjectId: [(v) => NATIVE_ID.test(v), true],
  nativeManager: [(v) => ADDRESS.test(v), true],
  nativeEvaluator: [(v) => ADDRESS.test(v), false],
  paperclipCompanyId: [(v) => UUID.test(v), true],
  paperclipProjectId: [(v) => UUID.test(v), true],
  paperclipGoalId: [(v) => UUID.test(v), true],
  ceoAgentId: [(v) => UUID.test(v), true],
  managerAgentId: [(v) => UUID.test(v), true],
});
const FIELDS = Object.keys(BINDING_FIELDS);
const column = (f) => f.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

export function openRegistry({ directory, selection }) {
  need(typeof directory === 'string' && selection?.projects?.length === 120, 'invalid_registry_configuration');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'registry.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL;');
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bindings(project_id TEXT PRIMARY KEY, source_digest TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT,
      ${FIELDS.map((f) => `${column(f)} TEXT${BINDING_FIELDS[f][1] ? ' UNIQUE' : ''}`).join(', ')});`);
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  tx(() => {
    const stored = db.prepare("SELECT value FROM meta WHERE key='selection'").get();
    if (stored) need(stored.value === selection.digest, 'registry_selection_drift', 'registry belongs to a different selection');
    else db.prepare("INSERT INTO meta(key,value) VALUES('selection',?)").run(selection.digest);
    const insert = db.prepare('INSERT INTO bindings(project_id,source_digest) VALUES(?,?) ON CONFLICT(project_id) DO NOTHING');
    for (const p of selection.projects) {
      insert.run(p.id, p.sourceDigest);
      const row = db.prepare('SELECT source_digest FROM bindings WHERE project_id=?').get(p.id);
      need(row.source_digest === p.sourceDigest, 'registry_source_drift', `${p.id} registry source changed`);
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM bindings').get().n;
    need(count === 120, 'registry_selection_drift', 'registry holds projects outside the selection');
  });
  const shape = (row) => ({
    projectId: row.project_id,
    sourceDigest: row.source_digest,
    revision: row.revision,
    updatedAt: row.updated_at,
    ...Object.fromEntries(FIELDS.map((f) => [f, row[column(f)] ?? null])),
  });
  const find = db.prepare('SELECT * FROM bindings WHERE project_id=?');
  const get = (projectId) => {
    const p = selection.get(projectId);
    return shape(find.get(p.id));
  };
  return {
    get,
    /** Sets only missing fields; a different value for a set field is a conflict.
     * `expectedRevision` makes concurrent binders compare-and-swap. */
    bind(projectId, bindings, { expectedRevision } = {}) {
      const p = selection.get(projectId);
      need(plain(bindings) && Object.keys(bindings).length > 0 && Object.keys(bindings).every((k) => FIELDS.includes(k)), 'invalid_binding');
      for (const [k, v] of Object.entries(bindings)) need(typeof v === 'string' && BINDING_FIELDS[k][0](v), 'invalid_binding', `invalid ${k}`);
      if (bindings.nativeProjectId !== undefined) need(bindings.nativeProjectId === p.nativeProjectId, 'native_project_id_mismatch');
      return tx(() => {
        const row = find.get(p.id);
        if (expectedRevision !== undefined) need(row.revision === expectedRevision, 'registry_revision_conflict');
        const changes = {};
        for (const [k, v] of Object.entries(bindings)) {
          const now = row[column(k)];
          if (now === null) changes[k] = v;
          else need(now === v, 'binding_conflict', `${p.id} ${k} is already bound to a different value`);
        }
        if (bindings.nativeEvaluator && (row.native_manager === bindings.nativeEvaluator || bindings.nativeManager === bindings.nativeEvaluator))
          need(false, 'evaluator_is_manager');
        if (bindings.nativeManager && row.native_evaluator === bindings.nativeManager) need(false, 'evaluator_is_manager');
        if (!Object.keys(changes).length) return shape(row);
        for (const [k, v] of Object.entries(changes)) {
          if (!BINDING_FIELDS[k][1]) continue;
          const other = db.prepare(`SELECT project_id FROM bindings WHERE ${column(k)}=? AND project_id<>?`).get(v, p.id);
          need(!other, 'duplicate_cross_project_binding', `${k} already belongs to ${other?.project_id}`);
        }
        const sets = Object.keys(changes).map((k) => `${column(k)}=?`).join(',');
        db.prepare(`UPDATE bindings SET ${sets}, revision=revision+1, updated_at=? WHERE project_id=?`)
          .run(...Object.values(changes), new Date().toISOString(), p.id);
        return shape(find.get(p.id));
      });
    },
    list({ page = 1, pageSize = 100 } = {}) {
      need(Number.isInteger(page) && page >= 1 && Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 100, 'invalid_registry_page');
      const ids = selection.ids.slice((page - 1) * pageSize, page * pageSize);
      return { page, pageSize, total: 120, pages: Math.ceil(120 / pageSize), projects: ids.map(get) };
    },
    /** Reverse lookup used by the read bridge; returns null for unknown companies. */
    byCompany(companyId) {
      if (typeof companyId !== 'string' || !UUID.test(companyId)) return null;
      const row = db.prepare('SELECT * FROM bindings WHERE paperclip_company_id=?').get(companyId);
      return row ? shape(row) : null;
    },
    close: () => db.close(),
  };
}

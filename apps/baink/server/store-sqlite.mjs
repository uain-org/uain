// BAINK metadata in SQLite (10 November 2026).
//
// Until 0.3.69 every commit rewrote one JSON file (state.json) holding the
// whole store, and every signed request commits its nonce, so each signed
// read serialized and fsynced the entire store. This module keeps the same
// in-memory state and transaction interface (store.mjs) but persists only the
// rows a commit changed, in SQLite WAL mode with synchronous=FULL: a commit
// is acknowledged only after its WAL frames are fsynced, as the file+directory
// fsync guaranteed before.
//
// Layout: one row per top-level section entry. A map section ({id: record})
// has one row per key; an array section (history) one row per index; any
// other value one row with key ''. `ord` keeps JavaScript insertion order.
//
// Migration is one-way: the first start imports state.json, verifies counts
// and a canonical content hash, and records the source file's hash. state.json
// stays in place and is rewritten from SQLite on every clean shutdown (and at
// most once a minute while running), so the previous release can still start
// from it after a rollback. If state.json then changes (an older release or an
// operator tool wrote it), the next start re-imports it, keeping a copy of the
// replaced database.
//
// Commits run on one worker thread (StateWriter). node:sqlite is synchronous,
// so on the main thread every WAL fsync would pause pages, reads and health
// while the disk is slow; the JSON store's fsync never did. The in-memory
// state stays on the main thread; the worker only writes rows.
import { DatabaseSync } from "node:sqlite";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, copyFileSync, chmodSync, existsSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export const STATE_DATABASE = "state.sqlite";
const SCHEMA_VERSION = 1;
const kindOf = (value) => Array.isArray(value) ? "array" : value !== null && typeof value === "object" ? "map" : "value";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Order-independent JSON: equal for states with equal content. */
export function canonicalState(value) {
  if (Array.isArray(value)) return `[${value.map((v) => v === undefined ? "null" : canonicalState(v)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).filter((k) => value[k] !== undefined && typeof value[k] !== "function").sort().map((k) => `${JSON.stringify(k)}:${canonicalState(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const stateDigest = (state) => sha256(canonicalState(state));

/** Section entry counts, for the import check. */
export function sectionCounts(state) {
  const counts = {};
  for (const [name, value] of Object.entries(state)) {
    if (value === undefined) continue;
    counts[name] = kindOf(value) === "map" ? Object.keys(value).filter((k) => value[k] !== undefined).length : kindOf(value) === "array" ? value.length : 1;
  }
  return counts;
}

function fsyncDirectory(dir) {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
async function fsyncDirectoryAsync(dir) {
  const handle = await open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

// ---- change sets ----------------------------------------------------------
// An op list is applied in order inside one SQLite transaction.
//   ["section", name, kind]   create the section (dropping old rows of another kind)
//   ["drop", name]            remove a section and its rows
//   ["set", name, key, json]  insert or replace one row
//   ["del", name, key]        remove one row
//   ["trim", name, length]    remove array rows at index >= length
function rowsFor(name, value, ops) {
  const kind = kindOf(value);
  ops.push(["section", name, kind]);
  if (kind === "map") { for (const key of Object.keys(value)) { const json = JSON.stringify(value[key]); if (json !== undefined) ops.push(["set", name, key, json]); } }
  else if (kind === "array") value.forEach((v, i) => ops.push(["set", name, String(i), JSON.stringify(v) ?? "null"]));
  else ops.push(["set", name, "", JSON.stringify(value)]);
}
function diffSection(name, before, after, ops) {
  if (before === after) return;
  if (after === undefined) { if (before !== undefined) ops.push(["drop", name]); return; }
  if (before === undefined || kindOf(before) !== kindOf(after)) { if (before !== undefined) ops.push(["drop", name]); rowsFor(name, after, ops); return; }
  const kind = kindOf(after);
  if (kind === "map") {
    for (const key of Object.keys(before))
      if (before[key] !== undefined && (!Object.hasOwn(after, key) || after[key] === undefined)) ops.push(["del", name, key]);
    for (const key of Object.keys(after)) {
      const value = after[key];
      if (value === undefined || (Object.hasOwn(before, key) && before[key] === value)) continue;
      const json = JSON.stringify(value);
      if (json === undefined) { if (Object.hasOwn(before, key) && before[key] !== undefined) ops.push(["del", name, key]); continue; }
      if (Object.hasOwn(before, key) && before[key] !== undefined && typeof value === "object" && JSON.stringify(before[key]) === json) continue;
      ops.push(["set", name, key, json]);
    }
  } else if (kind === "array") {
    for (let i = 0; i < after.length; i++) {
      if (i < before.length && before[i] === after[i]) continue;
      const json = JSON.stringify(after[i]) ?? "null";
      if (i < before.length && JSON.stringify(before[i]) === json) continue;
      ops.push(["set", name, String(i), json]);
    }
    if (after.length < before.length) ops.push(["trim", name, after.length]);
  } else if (JSON.stringify(before) !== JSON.stringify(after)) ops.push(["set", name, "", JSON.stringify(after)]);
}
/**
 * One commit carries each row at most once (13 November 2026). A group of up
 * to 32 transactions that each rewrote the same row (one member message each)
 * used to send that row 32 times to the writer in one call. A later "set" of a
 * row folds into the earlier one, which keeps its position (and so the row's
 * insertion order); a "del" of that row or any section-wide op on its section
 * ends the fold, so the result applies exactly as the full list would.
 */
export function coalesce(ops) {
  const out = [], open = new Map();
  for (const op of ops) {
    const name = op[1];
    if (op[0] === "set") {
      const rows = open.get(name), at = rows?.get(op[2]);
      if (at !== undefined) { out[at] = op; continue; }
      if (rows) rows.set(op[2], out.length); else open.set(name, new Map([[op[2], out.length]]));
    } else if (op[0] === "del") open.get(name)?.delete(op[2]);
    else open.delete(name);
    out.push(op);
  }
  return out;
}
/** The ops that turn `base` into `next`, using the store's transaction hint. */
export function diffStates(base, next, hint) {
  const ops = [];
  let names;
  if (hint?.nonceOnly === true) names = ["nonces"];
  else if (hint?.messageOnly === true) names = ["peerMessages"];
  else if (hint?.requestAppend === true) {
    // Existing request records and history entries are preserved by identity.
    if (base.requests !== next.requests) {
      if (kindOf(base.requests) !== "map") diffSection("requests", base.requests, next.requests, ops);
      else for (const key of Object.keys(next.requests)) if (!Object.hasOwn(base.requests, key)) { const json = JSON.stringify(next.requests[key]); if (json !== undefined) ops.push(["set", "requests", key, json]); }
    }
    if (base.history !== next.history) {
      if (!Array.isArray(base.history)) diffSection("history", base.history, next.history, ops);
      else for (let i = base.history.length; i < next.history.length; i++) ops.push(["set", "history", String(i), JSON.stringify(next.history[i]) ?? "null"]);
    }
    names = Object.keys(next).filter((k) => k !== "requests" && k !== "history" && next[k] !== base[k]);
  } else if (hint?.generic === true && hint.touched instanceof Set) names = [...hint.touched];
  else names = [...new Set([...Object.keys(base), ...Object.keys(next)])];
  for (const name of names) diffSection(name, base[name], next[name], ops);
  return ops;
}

// ---- capacity -------------------------------------------------------------
// Byte totals follow the JSON size of the state (the old validator's measure),
// up to a few bytes of separators per row; exactness is not needed for a guard.
function opBytes(op) { return op[0] === "set" ? Buffer.byteLength(op[2]) + Buffer.byteLength(op[3]) + 4 : 0; }
function stateBytes(state) {
  let metadata = 0, nonces = 0;
  for (const [name, value] of Object.entries(state)) {
    if (value === undefined) continue;
    const ops = []; rowsFor(name, value, ops);
    const bytes = ops.reduce((sum, op) => sum + opBytes(op), Buffer.byteLength(name) + 4);
    if (name === "nonces") nonces += bytes; else metadata += bytes;
  }
  return { metadata, nonces };
}

/**
 * The capacity validator and change tracker for createGroupCommitStore. It
 * computes each accepted state's change set from the transaction hint and
 * keeps it until persist() collects the chain since the last durable state.
 */
export function createChangeTracker({ initialState, maxStoreBytes, maxMetadataBytes, fail }) {
  const pending = new WeakMap(), totals = new WeakMap();
  totals.set(initialState, stateBytes(initialState));
  let durable = initialState;
  function validate(next, hint) {
    const base = hint?.base;
    let ops, measured;
    if (base && totals.has(base)) {
      ops = diffStates(base, next, hint);
      const before = totals.get(base), sizes = new Map();
      // Old row sizes for replaced/removed rows: measured from the base state.
      let metadata = before.metadata, nonces = before.nonces;
      for (const op of ops) {
        const name = op[1], section = base[name];
        let removed = 0;
        if (op[0] === "drop" && section !== undefined) { const rows = []; rowsFor(name, section, rows); removed = rows.reduce((s, r) => s + opBytes(r), Buffer.byteLength(name) + 4); }
        else if ((op[0] === "set" || op[0] === "del") && section !== undefined) {
          const kind = kindOf(section), old = kind === "value" ? section : kind === "array" ? section[Number(op[2])] : Object.hasOwn(section, op[2]) ? section[op[2]] : undefined;
          const json = old === undefined ? undefined : JSON.stringify(old);
          if (json !== undefined && !sizes.has(name + "\0" + op[2])) { removed = Buffer.byteLength(op[2]) + Buffer.byteLength(json) + 4; sizes.set(name + "\0" + op[2], true); }
        } else if (op[0] === "trim" && Array.isArray(section)) for (let i = op[2]; i < section.length; i++) removed += Buffer.byteLength(String(i)) + Buffer.byteLength(JSON.stringify(section[i]) ?? "null") + 4;
        else if (op[0] === "section" && section === undefined) removed = -(Buffer.byteLength(name) + 4);
        const delta = opBytes(op) - removed;
        if (name === "nonces") nonces += delta; else metadata += delta;
      }
      measured = { metadata, nonces };
    } else {
      ops = null;
      measured = stateBytes(next);
    }
    if (measured.metadata + measured.nonces > maxStoreBytes || measured.metadata > maxMetadataBytes)
      fail(503, "storage_capacity", "Metadata storage capacity has been reached. Existing records are preserved; contact the operator.");
    totals.set(next, measured);
    pending.set(next, { base, ops });
  }
  validate.measure = (state) => { const value = totals.get(state); return value ? { all: value.metadata + value.nonces, metadata: value.metadata } : undefined; };
  /** Ops from the last durable state to `next`, or null when the chain is unknown. */
  function changesTo(next) {
    const chain = [];
    for (let at = next; at !== durable; ) {
      const step = pending.get(at);
      if (!step || !step.ops || !step.base) return null;
      chain.push(step.ops); at = step.base;
    }
    return coalesce(chain.reverse().flat());
  }
  // Once a state is durable, drop the links that led to it: each pending entry
  // holds its base, so keeping them would retain every earlier state version.
  function settle(next) {
    for (let at = next; at && at !== durable; ) { const step = pending.get(at); pending.delete(at); at = step?.base; }
    durable = next;
  }
  return { validate, changesTo, settle, get durable() { return durable; } };
}

// ---- database ---------------------------------------------------------------
export class StateDatabase {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.path = join(dataDir, STATE_DATABASE);
    const created = !existsSync(this.path);
    if (created) { closeSync(openSync(this.path, "wx", 0o600)); fsyncDirectory(dataDir); }
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=OFF; PRAGMA wal_autocheckpoint=1000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS sections (name TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('map','array','value')), ord INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS rows (section TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, ord INTEGER NOT NULL, PRIMARY KEY (section, key)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS rows_order ON rows (section, ord);`);
    const version = this.meta("schema");
    if (version !== null && Number(version) !== SCHEMA_VERSION) throw new Error("BAINK state database has an unsupported schema; preserve it for operator review.");
    for (const suffix of ["-wal", "-shm"]) { try { chmodSync(this.path + suffix, 0o600); } catch {} }
    this.statements = {
      getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),
      setMeta: this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
      section: this.db.prepare("SELECT kind FROM sections WHERE name = ?"),
      addSection: this.db.prepare("INSERT INTO sections (name, kind, ord) VALUES (?, ?, ?)"),
      dropSection: this.db.prepare("DELETE FROM sections WHERE name = ?"),
      dropRows: this.db.prepare("DELETE FROM rows WHERE section = ?"),
      ordOf: this.db.prepare("SELECT ord FROM rows WHERE section = ? AND key = ?"),
      insert: this.db.prepare("INSERT INTO rows (section, key, value, ord) VALUES (?, ?, ?, ?)"),
      update: this.db.prepare("UPDATE rows SET value = ? WHERE section = ? AND key = ?"),
      del: this.db.prepare("DELETE FROM rows WHERE section = ? AND key = ?"),
      trim: this.db.prepare("DELETE FROM rows WHERE section = ? AND ord >= ?"),
      maxSection: this.db.prepare("SELECT COALESCE(MAX(ord), -1) AS ord FROM sections"),
      maxRows: this.db.prepare("SELECT section, MAX(ord) AS ord FROM rows GROUP BY section"),
      sections: this.db.prepare("SELECT name, kind FROM sections ORDER BY ord"),
      rows: this.db.prepare("SELECT key, value FROM rows WHERE section = ? ORDER BY ord"),
    };
    this.refreshOrd();
  }
  meta(key) { return (this.statements?.getMeta ?? this.db.prepare("SELECT value FROM meta WHERE key = ?")).get(key)?.value ?? null; }
  refreshOrd() {
    this.sectionOrd = Number(this.statements.maxSection.get().ord);
    this.rowOrd = new Map(this.statements.maxRows.all().map((r) => [r.section, Number(r.ord)]));
    this.kinds = new Map(this.statements.sections.all().map((r) => [r.name, r.kind]));
  }
  get empty() { return this.kinds.size === 0 && this.meta("content_sha256") === null; }
  load() {
    const state = {};
    for (const { name, kind } of this.statements.sections.all()) {
      const rows = this.statements.rows.all(name);
      if (kind === "map") { const value = {}; for (const r of rows) value[r.key] = JSON.parse(r.value); state[name] = value; }
      else if (kind === "array") state[name] = rows.map((r) => JSON.parse(r.value));
      else state[name] = rows.length ? JSON.parse(rows[0].value) : null;
    }
    return state;
  }
  apply(ops) {
    const s = this.statements;
    for (const op of ops) {
      const name = op[1];
      if (op[0] === "section") {
        const existing = this.kinds.get(name);
        if (existing === op[2]) continue;
        if (existing) { s.dropRows.run(name); s.dropSection.run(name); this.rowOrd.delete(name); }
        s.addSection.run(name, op[2], ++this.sectionOrd); this.kinds.set(name, op[2]);
      } else if (op[0] === "drop") {
        s.dropRows.run(name); s.dropSection.run(name); this.kinds.delete(name); this.rowOrd.delete(name);
      } else if (op[0] === "set") {
        if (!this.kinds.has(name)) throw new Error(`State change for missing section ${name}`);
        if (s.ordOf.get(name, op[2])) s.update.run(op[3], name, op[2]);
        else {
          const ord = this.kinds.get(name) === "array" ? Number(op[2]) : (this.rowOrd.get(name) ?? -1) + 1;
          if (ord > (this.rowOrd.get(name) ?? -1)) this.rowOrd.set(name, ord);
          s.insert.run(name, op[2], op[3], ord);
        }
      } else if (op[0] === "del") s.del.run(name, op[2]);
      else if (op[0] === "trim") s.trim.run(name, op[2]);
      else throw new Error("Unknown state change");
    }
  }
  /** One durable transaction: rolled back as a whole on any failure. */
  commit(ops, meta = {}) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.apply(ops);
      for (const [key, value] of Object.entries(meta)) this.statements.setMeta.run(key, String(value));
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.refreshOrd();
      throw error;
    }
  }
  /** Replace every row with `state` (import), then verify what was written. */
  replaceAll(state, meta) {
    const ops = [];
    for (const [name, value] of Object.entries(state)) if (value !== undefined) rowsFor(name, value, ops);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM rows; DELETE FROM sections;");
      this.sectionOrd = -1; this.rowOrd = new Map(); this.kinds = new Map();
      this.apply(ops);
      const loaded = this.load();
      const expected = { counts: sectionCounts(state), digest: stateDigest(state) };
      const actual = { counts: sectionCounts(loaded), digest: stateDigest(loaded) };
      if (canonicalState(expected.counts) !== canonicalState(actual.counts) || expected.digest !== actual.digest)
        throw new Error("BAINK state import did not verify; state.json is unchanged.");
      for (const [key, value] of Object.entries({ ...meta, schema: SCHEMA_VERSION, content_sha256: actual.digest, import_counts: JSON.stringify(actual.counts) }))
        this.statements.setMeta.run(key, String(value));
      this.db.exec("COMMIT");
      return { loaded, ...actual };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.refreshOrd();
      throw error;
    }
  }
  setMeta(values) { this.commit([], values); }
  checkpoint() { try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} }
  close() { this.checkpoint(); this.db.close(); }
}

/**
 * The running store's only writer: a StateDatabase on a worker thread. Calls
 * are applied in the order they are made; each promise settles after SQLite
 * has committed (and, with synchronous=FULL, fsynced) that call. After any
 * failure every later call is refused, so the group-commit store fails closed.
 * `commitDelayMs` exists for tests: it makes every commit slow, as a busy disk
 * would.
 */
export class StateWriter {
  constructor(dataDir, { commitDelayMs = 0, onFailure = null } = {}) {
    this.dataDir = dataDir;
    this.failed = null;
    this.closing = false;
    this.calls = new Map();
    this.sequence = 0;
    this.worker = new Worker(new URL(import.meta.url), {
      workerData: { bainkStateWriter: { dataDir, commitDelayMs } },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
      // The parent's flags (--input-type, --eval, --import, heap size) are not
      // the writer's: --input-type would even refuse to load this file.
      execArgv: [],
    });
    this.worker.on("message", ({ id, error }) => {
      const call = this.calls.get(id);
      if (!call) return;
      this.calls.delete(id);
      if (error) call.reject(new Error(error)); else call.resolve();
    });
    const stop = (error) => {
      const unexpected = !this.failed && !this.closing;
      this.failed ??= error;
      for (const call of this.calls.values()) call.reject(this.failed);
      this.calls.clear();
      // A writer that died on its own (out of memory, crash) cannot come back
      // in this process. The owner ends the process so the supervisor restarts
      // it on the durable rows (13 November 2026); calls in flight were refused
      // above, so nothing unacknowledged was reported as written.
      if (unexpected && typeof onFailure === "function") onFailure(this.failed);
    };
    this.worker.on("error", stop);
    this.worker.on("exit", (code) => stop(new Error(`BAINK state writer stopped (${code}).`)));
    // Settles once the worker has opened the database.
    this.ready = this.call("ready");
  }
  call(type, ops = [], meta = {}) {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ops, meta });
    });
  }
  commit(ops, meta = {}) { return this.call("commit", ops, meta); }
  setMeta(values) { return this.call("commit", [], values); }
  async close() {
    this.closing = true;
    try { if (!this.failed) await this.call("close"); }
    finally { this.failed ??= new Error("BAINK state writer closed."); await this.worker.terminate(); }
  }
}

if (!isMainThread && workerData?.bainkStateWriter) {
  const { dataDir, commitDelayMs } = workerData.bainkStateWriter;
  const pause = commitDelayMs > 0 ? new Int32Array(new SharedArrayBuffer(4)) : null;
  let database = null, openError = null;
  try { database = new StateDatabase(dataDir); } catch (error) { openError = error; }
  parentPort.on("message", ({ id, type, ops, meta }) => {
    try {
      if (type === "close") {
        // Nothing to close when the database never opened.
        if (database) { database.close(); database = null; }
        openError ??= new Error("BAINK state writer closed.");
      } else if (openError) throw openError;
      else if (type === "commit") {
        if (pause) Atomics.wait(pause, 0, 0, commitDelayMs);
        database.commit(ops, meta);
      } else if (type !== "ready") throw new Error("Unknown state writer call");
      parentPort.postMessage({ id });
    } catch (error) {
      parentPort.postMessage({ id, error: error.message });
    }
  });
}

/**
 * Open the state database, importing state.json when this is the first start
 * on SQLite or when state.json changed since this database last wrote it.
 * `readLegacy()` returns {bytes, state} for state.json or null when absent;
 * it applies the caller's size and shape checks.
 */
export function openStateDatabase({ dataDir, readLegacy, log = () => {} }) {
  const database = new StateDatabase(dataDir);
  try {
    const legacy = readLegacy();
    const legacyHash = legacy ? sha256(legacy.bytes) : null;
    const known = new Set([database.meta("source_sha256"), database.meta("export_sha256"), database.meta("export_pending_sha256")].filter(Boolean));
    let imported = null;
    if (legacy && (database.empty || !known.has(legacyHash))) {
      if (!database.empty) {
        // An older release (rollback) or an operator tool changed state.json
        // after this database last wrote it: it is the newer state.
        database.checkpoint();
        const copy = `${database.path}.before-reimport-${new Date().toISOString().replace(/[-:.]/g, "")}`;
        copyFileSync(database.path, copy);
        chmodSync(copy, 0o600);
        log({ event: "state_reimport", reason: "state.json changed since the last export", previous: copy });
      }
      imported = database.replaceAll(legacy.state, { source_sha256: legacyHash, imported_at: new Date().toISOString(), source_bytes: legacy.bytes.length });
      log({ event: "state_import", sha256: legacyHash, contentSha256: imported.digest, counts: imported.counts });
    }
    const state = imported ? imported.loaded : database.empty ? null : database.load();
    return { database, state, imported: Boolean(imported) };
  } catch (error) {
    database.db.close();
    throw error;
  }
}

/**
 * Write state.json from a committed state, atomically, recording its hash in
 * the database first so a crash between the two cannot trigger a re-import of
 * an older export.
 */
export async function exportStateJson(database, state, path) {
  const bytes = Buffer.from(JSON.stringify(state));
  const hash = sha256(bytes);
  await database.setMeta({ export_pending_sha256: hash });
  const temporary = join(database.dataDir, `.state-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
    await fsyncDirectoryAsync(database.dataDir);
  } finally {
    if (file) await file.close();
    await unlink(temporary).catch(() => {});
  }
  await database.setMeta({ export_sha256: hash, exported_at: new Date().toISOString() });
  return hash;
}

/** Read-only view of the persisted state, for tests and operator tools. */
export function readPersistedState(dataDir) {
  const path = join(dataDir, STATE_DATABASE);
  if (!existsSync(path)) {
    const legacy = join(dataDir, "state.json");
    if (!existsSync(legacy)) return null;
    return JSON.parse(readFileSync(legacy, "utf8"));
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const state = {};
    for (const { name, kind } of db.prepare("SELECT name, kind FROM sections ORDER BY ord").all()) {
      const rows = db.prepare("SELECT key, value FROM rows WHERE section = ? ORDER BY ord").all(name);
      if (kind === "map") { const value = {}; for (const r of rows) value[r.key] = JSON.parse(r.value); state[name] = value; }
      else if (kind === "array") state[name] = rows.map((r) => JSON.parse(r.value));
      else state[name] = rows.length ? JSON.parse(rows[0].value) : null;
    }
    return state;
  } finally { db.close(); }
}

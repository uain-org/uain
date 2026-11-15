/**
 * The move from SQLite: copy the store the pilot kept in pilot.sqlite into
 * PostgreSQL, once, when PostgreSQL is still empty.
 *
 * Everything is copied in one transaction, then read back and compared row
 * for row with the file. Any difference aborts the copy and stops the server:
 * a store that came across almost right is worse than one that did not come
 * across, because the ledger's signed roots and every member's standing rest
 * on it being exact. The file itself is never written to, and stays where it
 * is as the copy's source and backup.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { TABLES } from './schema.ts';
import { atomically, query } from './store.ts';

const BATCH = 500;

/** Columns PostgreSQL has for a table, in order. */
async function columnsOf(table: string): Promise<string[]> {
  const r = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ?
     ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((c) => c.column_name);
}

/** Primary key columns, to read both sides back in the same order. */
async function keyOf(table: string): Promise<string[]> {
  const r = await query<{ name: string }>(
    `SELECT a.attname AS name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = ?::regclass AND i.indisprimary
     ORDER BY array_position(i.indkey, a.attnum)`,
    [table],
  );
  return r.rows.map((c) => c.name);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether PostgreSQL already holds a store, copied or new. */
async function holdsAnything() {
  for (const t of ['participants', 'events', 'waitlist', 'accounts']) {
    const r = await query(`SELECT 1 FROM ${t} LIMIT 1`);
    if (r.rows.length) return true;
  }
  return false;
}

/**
 * Copy `file` into PostgreSQL if PostgreSQL holds nothing yet. Returns what
 * was copied, per table, or null when there was nothing to do.
 */
export async function copyFromSqlite(file: string): Promise<Record<string, number> | null> {
  if (!existsSync(file)) return null;
  return atomically(async () => {
    const done = await query(
      "SELECT value FROM store_meta WHERE key = 'copied_from_sqlite'",
    );
    if (done.rows.length || (await holdsAnything())) return null;

    const lite = new DatabaseSync(file, { readOnly: true });
    const liteTables = new Set(
      lite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((t) => t.name as string),
    );
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      if (!liteTables.has(table)) {
        counts[table] = 0;
        continue;
      }
      const columns = await columnsOf(table);
      const liteColumns = lite
        .prepare(`SELECT name FROM pragma_table_info('${table}')`)
        .all()
        .map((c) => c.name as string);
      // A column in the file that PostgreSQL lacks would be data left behind.
      const missing = liteColumns.filter((c) => !columns.includes(c));
      if (missing.length)
        throw new Error(`copy: ${table} has columns PostgreSQL lacks: ${missing}`);
      const key = await keyOf(table);
      const order = key.join(', ');
      const rows = lite
        .prepare(`SELECT ${liteColumns.join(', ')} FROM ${table} ORDER BY ${order}`)
        .all();
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const values: unknown[] = [];
        const tuples = chunk.map((row) => {
          const marks = liteColumns.map((c) => {
            values.push(row[c]);
            return '?';
          });
          return `(${marks.join(', ')})`;
        });
        await query(
          `INSERT INTO ${table} (${liteColumns.join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`,
          values,
        );
      }

      // Read back and compare, row for row, column for column.
      const back = (
        await query(`SELECT ${liteColumns.join(', ')} FROM ${table} ORDER BY ${order}`)
      ).rows;
      if (back.length !== rows.length)
        throw new Error(`copy: ${table} has ${back.length} rows, the file ${rows.length}`);
      for (let i = 0; i < rows.length; i++) {
        const want = Object.fromEntries(liteColumns.map((c) => [c, rows[i][c]]));
        if (!same(back[i], want))
          throw new Error(
            `copy: ${table} row ${i} differs: ${JSON.stringify(back[i]).slice(0, 300)} vs ${JSON.stringify(want).slice(0, 300)}`,
          );
      }
      counts[table] = rows.length;

      // Identity columns continue after the highest id copied.
      if (key.length === 1) {
        const seq = await query('SELECT pg_get_serial_sequence(?, ?) AS s', [
          table,
          key[0],
        ]);
        if (seq.rows[0].s)
          await query(
            `SELECT setval(?, GREATEST((SELECT MAX(${key[0]}) FROM ${table}), 1))`,
            [seq.rows[0].s],
          );
      }
    }

    // Contribution numbers continue after the highest issued, never below
    // where the pilot started them.
    await query(
      `SELECT setval('contribution_number', GREATEST(4500,
         (SELECT COALESCE(MAX(CAST(SUBSTR(id, 4) AS INTEGER)), 0)
          FROM contributions WHERE id LIKE 'RC-%')))`,
    );
    // Claim and task numbers too: the schema that would catch them up is not
    // run again at the next start (ready() in store.ts).
    await query(
      `SELECT setval('claim_number', m) FROM
         (SELECT MAX(CAST(SUBSTR(id, 4) AS INTEGER)) AS m FROM claims) AS taken WHERE m > 0`,
    );
    await query(
      `SELECT setval('task_number', m) FROM
         (SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) AS m FROM tasks) AS taken WHERE m > 0`,
    );
    lite.close();

    await query(
      "INSERT INTO store_meta (key, value) VALUES ('copied_from_sqlite', ?)",
      [JSON.stringify({ file, at: new Date().toISOString(), counts })],
    );
    return counts;
  });
}

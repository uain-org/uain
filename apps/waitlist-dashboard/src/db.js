/**
 * Every query this app runs. Each one is a SELECT on `waitlist` and nothing
 * else, which is all the `waitlist_reader` role may do anyway
 * (sql/readonly-role.sql); the connection is also opened read-only.
 *
 * Values always travel as bind parameters. The only SQL built from a request
 * is a column or a direction, and those are looked up in the allow-lists
 * below: a request can choose among them, never add to them.
 */
import pg from 'pg';

export const PAGE_SIZE = 50;

/** Sortable columns of the sign-ups table: the request's name to an SQL expression. */
export const SORTS = {
  id: 'seq',
  name: 'lower(name)',
  operator: 'lower(operator)',
  email: 'lower(email)',
  channel: 'channel',
  status: 'status',
  registered: 'registered_at',
};
const DIRECTIONS = { asc: 'ASC', desc: 'DESC' };
export const DEFAULT_SORT = { sort: 'registered', dir: 'desc' };

/** Text searched by the `q` parameter. */
export const SEARCH_COLUMNS = [
  'name',
  'email',
  'operator',
  'description',
  'url',
  'goals',
];

/** Columns whose items the overview counts, each a JSON array stored as text. */
const ITEM_COLUMNS = [
  'system_types',
  'contributes',
  'wants',
  'missions',
  'networks',
];

/**
 * A text column holding a JSON array, as jsonb, or an empty array when the
 * text is not a JSON array: one bad row must not break the whole page.
 * `col` always comes from the constants in this file.
 */
const jsonArray = (col) =>
  `(CASE WHEN NOT pg_input_is_valid(${col}, 'jsonb') THEN '[]'::jsonb ` +
  `WHEN jsonb_typeof(${col}::jsonb) <> 'array' THEN '[]'::jsonb ELSE ${col}::jsonb END)`;

/** LIKE's wildcards and its escape character, made literal. */
export const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

const MAX_FILTER = 200;
const MAX_PAGE = 100000;

/**
 * The filter, sort and page a query string asks for, reduced to what this
 * app allows. Anything else is dropped, not refused, so a hand-edited link
 * still shows something sensible.
 */
export function readQuery(searchParams) {
  const text = (name) => {
    const v = searchParams.get(name);
    return typeof v === 'string' ? v.trim().slice(0, MAX_FILTER) : '';
  };
  const sort = Object.hasOwn(SORTS, searchParams.get('sort'))
    ? searchParams.get('sort')
    : DEFAULT_SORT.sort;
  const dir = Object.hasOwn(DIRECTIONS, searchParams.get('dir'))
    ? searchParams.get('dir')
    : DEFAULT_SORT.dir;
  const page = Number(searchParams.get('page'));
  const type = text('type');
  return {
    q: text('q'),
    status: text('status'),
    channel: text('channel'),
    // Option ids are lower-case words; anything else cannot match a row.
    type: /^[a-z0-9_]{1,64}$/.test(type) ? type : '',
    sort,
    dir,
    page: Number.isInteger(page) && page >= 1 && page <= MAX_PAGE ? page : 1,
  };
}

/** The WHERE clause and its parameters for a filter from readQuery. */
export function whereClause(filter) {
  const params = [];
  const clauses = [];
  const bind = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (filter.q) {
    const like = bind(`%${escapeLike(filter.q)}%`);
    const any = SEARCH_COLUMNS.map((c) => `${c} ILIKE ${like} ESCAPE '\\'`);
    // A candidate id, full or just its number, finds that row too.
    const id = /^(?:UAIN-)?0*(\d{1,12})$/i.exec(filter.q);
    if (id && Number(id[1]) > 0) any.push(`seq = ${bind(id[1])}`);
    clauses.push(`(${any.join(' OR ')})`);
  }
  if (filter.status) clauses.push(`status = ${bind(filter.status)}`);
  if (filter.channel) clauses.push(`channel = ${bind(filter.channel)}`);
  if (filter.type)
    clauses.push(`${jsonArray('system_types')} ? ${bind(filter.type)}`);
  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function orderBy({ sort, dir }) {
  const expr = SORTS[sort] ?? SORTS[DEFAULT_SORT.sort];
  const d = DIRECTIONS[dir] ?? DIRECTIONS[DEFAULT_SORT.dir];
  return `ORDER BY ${expr} ${d} NULLS LAST, seq ${d}`;
}

export function createDb(databaseUrl, { log = () => {}, max = 4 } = {}) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    application_name: 'uain-waitlist-dashboard',
    // Read-only for every transaction on these connections, whatever the
    // role may do.
    options: '-c default_transaction_read_only=on',
  });
  // An idle connection dropped by the server must not take the process down.
  pool.on('error', (err) =>
    log({ kind: 'service', event: 'db_error', message: err.message }),
  );

  const rows = async (sql, params = []) => (await pool.query(sql, params)).rows;

  return {
    pool,

    async overview({ now = Date.now() } = {}) {
      const since = (days) => new Date(now - days * 86400000).toISOString();
      const itemCounts = (col) =>
        rows(
          `SELECT item, count(*)::int AS n FROM waitlist
           CROSS JOIN LATERAL jsonb_array_elements_text(${jsonArray(col)}) AS item
           GROUP BY item ORDER BY n DESC, item`,
        );
      // Times are ISO text, compared as text; a row with anything else in
      // registered_at is counted in the total and in no time window.
      const iso = `registered_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'`;
      const [totals, perDay, status, channel, latest, ...items] =
        await Promise.all([
          rows(
            `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE ${iso} AND registered_at >= $1)::int AS last1,
                  count(*) FILTER (WHERE ${iso} AND registered_at >= $2)::int AS last7,
                  count(*) FILTER (WHERE ${iso} AND registered_at >= $3)::int AS last30,
                  min(registered_at) FILTER (WHERE ${iso}) AS first,
                  max(registered_at) FILTER (WHERE ${iso}) AS last
           FROM waitlist`,
            [since(1), since(7), since(30)],
          ),
          rows(
            `SELECT substr(registered_at, 1, 10) AS day, count(*)::int AS n
           FROM waitlist GROUP BY 1 ORDER BY 1`,
          ),
          rows(
            `SELECT status AS item, count(*)::int AS n FROM waitlist GROUP BY 1 ORDER BY 2 DESC, 1`,
          ),
          rows(
            `SELECT channel AS item, count(*)::int AS n FROM waitlist GROUP BY 1 ORDER BY 2 DESC, 1`,
          ),
          // The queue position is the order sign-ups arrived in.
          rows(
            `SELECT seq, name, operator, system_types, channel, status, registered_at
           FROM waitlist ORDER BY seq DESC LIMIT 10`,
          ),
          ...ITEM_COLUMNS.map(itemCounts),
        ]);
      return {
        totals: totals[0],
        perDay,
        counts: {
          status,
          channel,
          ...Object.fromEntries(ITEM_COLUMNS.map((c, i) => [c, items[i]])),
        },
        latest,
      };
    },

    /** One page of the sign-ups table, and how many rows match in all. */
    async list(filter) {
      const { sql, params } = whereClause(filter);
      const offset = (filter.page - 1) * PAGE_SIZE;
      const [count, page] = await Promise.all([
        rows(`SELECT count(*)::int AS n FROM waitlist ${sql}`, params),
        rows(
          `SELECT seq, name, operator, email, system_types, missions, channel, status, registered_at
           FROM waitlist ${sql} ${orderBy(filter)}
           LIMIT ${PAGE_SIZE} OFFSET $${params.length + 1}`,
          [...params, offset],
        ),
      ]);
      return { total: count[0].n, rows: page };
    },

    /** The values the filters offer: whatever is in the table. */
    async filterOptions() {
      const [status, channel, types] = await Promise.all([
        rows(`SELECT DISTINCT status AS v FROM waitlist ORDER BY 1`),
        rows(`SELECT DISTINCT channel AS v FROM waitlist ORDER BY 1`),
        rows(
          `SELECT DISTINCT item AS v FROM waitlist
           CROSS JOIN LATERAL jsonb_array_elements_text(${jsonArray('system_types')}) AS item ORDER BY 1`,
        ),
      ]);
      const values = (list) => list.map((r) => r.v).filter((v) => v !== null);
      return {
        status: values(status),
        channel: values(channel),
        type: values(types),
      };
    },

    /** Every column of one row, with the rows before and after it. */
    async get(seq) {
      const [row, around] = await Promise.all([
        pool.query(`SELECT * FROM waitlist WHERE seq = $1`, [seq]),
        rows(
          `SELECT (SELECT max(seq) FROM waitlist WHERE seq < $1) AS prev,
                  (SELECT min(seq) FROM waitlist WHERE seq > $1) AS next`,
          [seq],
        ),
      ]);
      return {
        row: row.rows[0] ?? null,
        columns: row.fields.map((f) => f.name),
        prev: around[0].prev,
        next: around[0].next,
      };
    },

    /** Every row matching the filter (all of them for none), every column. */
    async exportRows(filter) {
      const { sql, params } = whereClause(filter);
      const r = await pool.query(
        `SELECT * FROM waitlist ${sql} ${orderBy(filter)}`,
        params,
      );
      return { columns: r.fields.map((f) => f.name), rows: r.rows };
    },

    close: () => pool.end(),
  };
}

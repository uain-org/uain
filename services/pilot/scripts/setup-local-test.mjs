// Provision only the disposable PostgreSQL cluster in this checkout.
// Run from the repository root with node --env-file=.env.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const root = resolve(import.meta.dirname, '../../..');
const data = resolve(root, 'work/dev-postgres/data');
const target = new URL(process.env.DATABASE_URL);
if (target.hostname !== '127.0.0.1' || target.port !== '55432' ||
    target.username !== 'uain_local_test' || target.pathname !== '/uain_local_test' ||
    decodeURIComponent(target.password) !== process.env.POSTGRES_PASSWORD) {
  throw new Error('Refusing to provision anything except the configured local test database.');
}
const admin = new pg.Client({ connectionString: 'postgres://postgres@127.0.0.1:55432/postgres' });
try {
  await admin.connect();
  const { rows } = await admin.query('SHOW data_directory');
  if (resolve(rows[0].data_directory) !== data) throw new Error('Unexpected PostgreSQL cluster; refusing changes.');
  const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', ['uain_local_test']);
  if (!role.rowCount) await admin.query('CREATE ROLE uain_local_test LOGIN CREATEDB NOSUPERUSER NOCREATEROLE');
  // PostgreSQL utility statements cannot use bind parameters; let the server
  // quote the password as a literal, and never print the resulting statement.
  const formatted = await admin.query("SELECT format('ALTER ROLE uain_local_test PASSWORD %L', $1::text) AS sql", [process.env.POSTGRES_PASSWORD]);
  await admin.query(formatted.rows[0].sql);
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['uain_local_test']);
  if (!exists.rowCount) await admin.query("CREATE DATABASE uain_local_test OWNER uain_local_test TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'");
  const hba = resolve(data, 'pg_hba.conf');
  const text = await readFile(hba, 'utf8');
  const rule = 'host all uain_local_test 127.0.0.1/32 scram-sha-256';
  if (!text.includes(rule)) await writeFile(hba, `${rule}\n${text}`);
  await admin.query('SELECT pg_reload_conf()');
  await mkdir(resolve(root, 'work/local-pilot'), { recursive: true });
} finally {
  await admin.end();
}
const client = new pg.Client({ connectionString: target.toString() });
try {
  await client.connect();
  const { rows } = await client.query('SELECT current_database() AS database, current_user AS role');
  console.log(JSON.stringify({ ...rows[0], host: target.hostname, port: Number(target.port), authenticated: true }));
} finally { await client.end(); }
const wrong = new URL(target);
wrong.password = 'deliberately-invalid-test-password';
const rejected = new pg.Client({ connectionString: wrong.toString() });
try {
  await rejected.connect();
  throw new Error('Password authentication is not enforced.');
} catch (error) {
  if (error.code !== '28P01') throw new Error('Failed to prove password rejection.');
  console.log('Incorrect password rejected; local test credentials are enforced.');
} finally { await rejected.end(); }

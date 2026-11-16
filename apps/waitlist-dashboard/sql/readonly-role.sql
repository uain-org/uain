-- The waitlist dashboard's database role: SELECT on the waitlist table, and
-- nothing else. Run by the operator with psql, as the database owner,
-- connected to the `uain` database. On the production host, from the
-- checkout, with the password in the environment (so it is never on a
-- command line):
--
--   export UAIN_WAITLIST_DB_PASSWORD=...   # the same value as the secret
--   docker compose -p uain-universa exec -T -e UAIN_WAITLIST_DB_PASSWORD db \
--     psql -U uain -d uain -v ON_ERROR_STOP=1 \
--     < apps/waitlist-dashboard/sql/readonly-role.sql
--
-- `-v password=...` works too, in place of the environment variable.
-- Safe to run again, for instance to change the password. It grants on the
-- database psql is connected to, so connect to `uain`.
--
-- What the role gets: LOGIN with the password; CONNECT on this database;
-- USAGE on schema public; SELECT on public.waitlist. What it does not get:
-- any other table, any write, any default privileges for tables made later.
-- It also starts every transaction read-only and gives up a statement after
-- 15 seconds. PUBLIC's built-in rights (CONNECT and TEMP on the database,
-- EXECUTE on functions) belong to the cluster's owner to decide and are left
-- alone.
--
-- `-v role=...` renames the role; the tests use it so as not to touch a real
-- one. Leave it out in production.

\set ON_ERROR_STOP on
\if :{?role}
\else
  \set role waitlist_reader
\endif
\if :{?password}
\else
  -- The shell's copy of the variable (psql 15's \getenv would do, but the
  -- psql an operator has at hand may be older).
  \set password `printf '%s' "$UAIN_WAITLIST_DB_PASSWORD"`
\endif

SELECT length(:'password') < 16 AS weak_password \gset
\if :weak_password
  DO $$ BEGIN RAISE EXCEPTION 'give a password of at least 16 characters: UAIN_WAITLIST_DB_PASSWORD in the environment, or -v password=...'; END $$;
\endif

SELECT format('CREATE ROLE %I', :'role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role')
\gexec

ALTER ROLE :"role" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD :'password';
ALTER ROLE :"role" SET default_transaction_read_only = on;
ALTER ROLE :"role" SET statement_timeout = '15s';

-- Only what is granted below, even on a second run after someone widened it.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"role";
REVOKE ALL ON SCHEMA public FROM :"role";
REVOKE ALL ON DATABASE :"DBNAME" FROM :"role";

GRANT CONNECT ON DATABASE :"DBNAME" TO :"role";
GRANT USAGE ON SCHEMA public TO :"role";
GRANT SELECT ON public.waitlist TO :"role";

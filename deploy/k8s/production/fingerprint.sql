-- One line per table (row count and an md5 of every row, in order) and per
-- sequence (last value) in schema public. Run against two databases and diff:
-- equal output means equal data. Used to check the data copy at cutover; reads only (the temp
-- table lives in the session).
\set QUIET on
\pset tuples_only on
\pset format unaligned
do $$
declare r record; c bigint; h text;
begin
  create temp table fp(name text, n bigint, hash text);
  for r in select tablename from pg_tables where schemaname='public' order by 1 loop
    execute format('select count(*), md5(coalesce(string_agg(t::text, %L order by t::text), %L)) from public.%I t', E'\n', '', r.tablename) into c, h;
    insert into fp values ('table ' || r.tablename, c, h);
  end loop;
  for r in select schemaname, sequencename, last_value from pg_sequences where schemaname='public' loop
    insert into fp values ('seq ' || r.sequencename, r.last_value, '');
  end loop;
end $$;
select name || ' ' || n || ' ' || hash from fp order by name;

#!/bin/sh
# profile.sh PROFILE AGENTS: one minute of load with query statistics reset
# first, then the statements that cost the database the most time.
cd /root/uain-loadtest
db() { docker exec uain-loadtest-db-1 psql -U uain -d uain "$@"; }
db -qc "SELECT pg_stat_statements_reset()" >/dev/null
docker run --rm --name uain-loadtest-k6 --cpus 3 --network uain-loadtest_default \
  -v $PWD/agents.js:/scripts/agents.js:ro -v $PWD/out:/out \
  -e AGENTS=$2 -e PROFILE=$1 -e HOLD=1m grafana/k6:latest run --quiet /scripts/agents.js \
  > out/profile-$1-$2.log 2>&1
grep -E "http_req_duration\.|http_reqs\." out/profile-$1-$2.log
db -c "SELECT round(total_exec_time)::int AS total_ms, calls, round(mean_exec_time::numeric,2) AS mean_ms,
  round(100*total_exec_time/sum(total_exec_time) over ())::int AS pct,
  left(regexp_replace(query, '\s+', ' ', 'g'), 110) AS query
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 18"

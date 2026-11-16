#!/bin/sh
# Every 5 s until killed: container CPU/memory, writes waiting on the lock,
# and how fast the live uain.global answers from this machine.
out=$1
echo "at,what,value" > "$out"
while true; do
  at=$(date -u +%H:%M:%S)
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' \
    | grep -E 'uain-loadtest|uain-universa|k6' | sed "s/^/$at,stats,/" >> "$out"
  w=$(docker exec uain-loadtest-db-1 psql -U uain -d uain -tAc \
    "select count(*) from pg_locks where locktype='advisory' and not granted" 2>/dev/null)
  echo "$at,lock_waiting,$w" >> "$out"
  l=$(curl -s -o /dev/null -w '%{time_total}' http://127.0.0.1:4100/api/health)
  echo "$at,live_health_s,$l" >> "$out"
  sleep 5
done

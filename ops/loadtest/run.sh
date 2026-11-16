#!/bin/sh
# run.sh PROFILE HOLD AGENTS... : one k6 run per step, stopping at the first
# step that fails its thresholds.
cd /root/uain-loadtest
profile=$1; hold=$2; shift 2
for n in "$@"; do
  echo "=== $profile $n agents, holding $hold"
  sh monitor.sh out/monitor-$profile-$n.csv & mon=$!
  docker run --rm --name uain-loadtest-k6 --cpus 3 --network uain-loadtest_default \
    -v $PWD/agents.js:/scripts/agents.js:ro -v $PWD/out:/out \
    -e AGENTS=$n -e PROFILE=$profile -e HOLD=$hold -e FULL=${FULL:-} \
    grafana/k6:latest run --quiet --summary-export /out/summary-$profile-$n.json /scripts/agents.js \
    > out/k6-$profile-$n.log 2>&1
  code=$?
  kill $mon
  echo "k6 exit $code"
  [ $code -ne 0 ] && { echo "stopped at $n"; break; }
done

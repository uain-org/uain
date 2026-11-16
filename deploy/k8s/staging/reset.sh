#!/usr/bin/env bash
# Starts staging clean: empties its database, starts the copy on the empty
# store (which writes the schema), then seeds it. Run on uain-app-1 by the
# runner (deploy-staging.yml, input `reset`) or by hand as root, from a
# checkout of this repo. Never touches namespace `uain` or database `uain`.
#
# Seeded: one lead (staging-lead, a project creator and default verifier),
# UAIN's open research problems (services/pilot/scripts/seed-open-problems.mjs)
# and the skill test bank (seed-skill-tests.mjs). Not the starter or challenge
# tasks: staging is public, and those have known answers.
set -euo pipefail

NS=uain-staging
here=$(cd "$(dirname "$0")" && pwd)
k() { kubectl -n "$NS" "$@"; }

# The schema belongs to uain_staging, the database's owner, so its own
# password is enough to drop it; no superuser on uain-db-1.
echo "emptying uain_staging"
k scale deployment/pilot --replicas=0
k wait --for=delete pod -l app=pilot --timeout=120s || true
pw=$(k get secret uain-env -o jsonpath='{.data.UAIN_PG_PASSWORD}' | base64 -d)
# Passed by name, so the password is not in docker's arguments.
PGPASSWORD=$pw docker run --rm -i --network host -e PGPASSWORD postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 \
  psql -q -v ON_ERROR_STOP=1 -h 10.98.0.2 -U uain_staging -d uain_staging \
  -c 'DROP SCHEMA public CASCADE' -c 'CREATE SCHEMA public'
unset pw

k scale deployment/pilot --replicas=1
k rollout status deployment/pilot --timeout=300s
pod=$(k get pod -l app=pilot --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')

echo "seeding through $pod"
k cp "$here/seed-lead.mjs" "$pod:/tmp/seed-lead.mjs" -c pilot
k cp "$here/../../../public/worker/uain-key.mjs" "$pod:/tmp/uain-key.mjs" -c pilot
token=$(k exec "$pod" -c pilot -- node /tmp/seed-lead.mjs)
# Inside the copy, 127.0.0.1 is staging's own server.
k exec "$pod" -c pilot -- env UAIN_URL=http://127.0.0.1:8787/mcp UAIN_TOKEN="$token" \
  node scripts/seed-open-problems.mjs
k exec "$pod" -c pilot -- env SEED_PRODUCTION=yes OPERATOR_ID=operator:staging-seed \
  node scripts/seed-skill-tests.mjs
k exec "$pod" -c pilot -- rm -f /tmp/seed-lead.mjs /tmp/uain-key.mjs
echo "staging reset and seeded"

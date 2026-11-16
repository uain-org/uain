#!/usr/bin/env bash
# Full pilot schema reset/restore on the CI job's test-only pgvector container.
set -euo pipefail
repo=$(pwd)
fixture=${UAIN_RESET_CI_ROOT:-/opt/uain-test/reset-ci}
[[ "$fixture" =~ ^/opt/uain-test/[a-zA-Z0-9_-]+$ ]] || exit 2
if [[ ${UAIN_RESET_LOCAL_PG:-} == 1 ]]; then
 # The sandbox contains PostgreSQL 17 clients and only its disposable database.
 [[ ${PGHOST:?sandbox PostgreSQL host} == 127.0.0.1 ]] || exit 2
 [[ ${UAIN_TEST_PG:?sandbox PostgreSQL URL} == postgres://postgres:postgres@127.0.0.1:5432/postgres ]] || exit 2
 install -d -m 0700 "$fixture"
else
 [[ ${UAIN_RESET_PG_CONTAINER:?CI PostgreSQL container} =~ ^[a-f0-9]{12,64}$ ]] || exit 2
 sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" "$fixture" "$fixture/bin"
for program in psql pg_dump pg_restore; do
 cat > "$fixture/bin/$program" <<'WRAPPER'
#!/bin/sh
exec docker exec -i "$UAIN_RESET_PG_CONTAINER" "${0##*/}" -U postgres "$@"
WRAPPER
 chmod 0700 "$fixture/bin/$program"
done
export PATH="$fixture/bin:$PATH"
fi
export UAIN_RESET_TEST=1
export UAIN_RESET_BACKEND_FIXTURE_DIR="$fixture/backend"
export UAIN_RESET_FIXTURE_EPOCH=${UAIN_RESET_FIXTURE_EPOCH:-20261008_000059}
/usr/bin/python3 -m unittest discover -s ops/reset -p 'test_*.py'
node ops/reset/backend-fixture.mjs
/usr/bin/python3 - "$repo" <<'PY'
import json,os,pathlib,re,subprocess,sys,urllib.parse
root=pathlib.Path(os.environ['UAIN_RESET_BACKEND_FIXTURE_DIR'])
fixture=json.loads((root/'public.json').read_text());db=fixture['database']
assert re.fullmatch(r'uain_test_[0-9]+_[a-z0-9]+',db)
env=os.environ.copy();env.update(DATABASE_URL=urllib.parse.urlsplit(os.environ.get('UAIN_TEST_PG','postgres://postgres:postgres@127.0.0.1:5432/postgres'))._replace(path='/'+db).geturl(),
 UAIN_DATA_DIR=str(root),ACTION='capture-system-reset-records',RESET_EPOCH=os.environ['UAIN_RESET_FIXTURE_EPOCH'],
 OPERATOR_ID='operator:fixture',LEDGER_PUBLIC_KEY_PEM=fixture['key']['pem'],UAIN_RATE_REQUESTS_PER_MIN='100000')
subprocess.run(['node','services/pilot/dist/src/application/maintenance.js'],env=env,cwd=sys.argv[1],check=True)
PY
/usr/bin/python3 ops/reset/rehearse-backend.py
/usr/bin/python3 - "$repo" <<'PY'
import json,os,pathlib,re,subprocess,sys,urllib.parse
root=pathlib.Path(os.environ['UAIN_RESET_BACKEND_FIXTURE_DIR'])
db=json.loads((root/'public.json').read_text())['database']
assert re.fullmatch(r'uain_test_[0-9]+_[a-z0-9]+',db)
env=os.environ.copy();env['DATABASE_URL']=urllib.parse.urlsplit(os.environ.get('UAIN_TEST_PG','postgres://postgres:postgres@127.0.0.1:5432/postgres'))._replace(path='/'+db).geturl()
env['UAIN_DATA_DIR']=str(root)
subprocess.run(['node','ops/reset/check-backend.mjs'],env=env,cwd=sys.argv[1],check=True)
PY

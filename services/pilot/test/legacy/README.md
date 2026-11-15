# Manual legacy waitlist checks

Waitlist registration, notification and dashboard tests were retired from
mandatory network release validation on 13 October 2026. The deployed feature
and its tests remain available for deliberate maintenance. Active backend
globs select only `test/*.test.mjs`, so this directory is not part of either
mandatory backend pass.

Against a disposable PostgreSQL named by `UAIN_TEST_PG`, from the repository root:

```sh
npm --prefix services/pilot ci
npm --prefix services/pilot run build
node --test --test-concurrency=1 services/pilot/test/legacy/*.test.mjs
UAIN_WRITE_THREAD=1 node --test --test-concurrency=1 services/pilot/test/legacy/*.test.mjs
npm --prefix apps/waitlist-dashboard ci
npm --prefix apps/waitlist-dashboard test
```

These are optional, explicit commands. The remote runner's `all` suite runs
both active backend passes and the site checks. Press, contract, native,
operations, schema/reset and deployment runtime checks remain mandatory.

# Current operator evidence,1 November2026

The first separately operated off-host build exhausted its8GiB cgroup at server
compile (exit137), without touching production. A measured4CPU/16GiB serialized
retry reached final image export. Exact immutable image/build stamp and actual
zero-agent runtime/auth/ACL/restart/restore qualification remain pending.

Universa's60-second live18:42-18:43UTC sample had minimum4105MiB available,
zero PSI,2 swap-in pages,zero swap-out andzero OOM delta. This does not pass the
current2GiB runtime plus3GiB spare-memory policy. Do not force shared-host
activation or disable the guard. Measure the actual capped runtime first; a lower
cap requires its own meaningful runtime qualification and explicit policy change.
Evidence: output/baink-2026-10-31/paperclip-universa-pressure-20261101.json.

The reviewed current-native-lead read gate is being integrated as an additional
restriction after an explicit operator Viewer allowlist. It is no automatic read
or write grant. Test identity receives no private project access.

---

# Private Paperclip pilot preparation

31 October 2026. This is local ops preparation, not a deployed runtime or an
activated project. No installation, company/project creation, credential minting,
provider call or native mutation was performed by these tools. Parent-owned
release documentation records any later build/deployment separately.

The useful first milestone is an authenticated, private control plane with zero
agents/routines/providers and a qualified BAINK read connection. Execution,
research admission and financial authority are separate later milestones.

## Source and artifact qualification

Upstream is pinned to
[`dce383c733bb1ca31cd34d7dbb82bda597ad7418`](https://github.com/paperclipai/paperclip/tree/dce383c733bb1ca31cd34d7dbb82bda597ad7418).
`apps/baink/ops/paperclip/source-review.json` records SHA256 fingerprints of the
inspected primary-source files; this is static review, not execution of upstream
tests or proof that a running service uses that source.

The official registry is `ghcr.io/paperclipai/paperclip`, confirmed by its pinned
[`docker.yml`](https://github.com/paperclipai/paperclip/blob/dce383c733bb1ca31cd34d7dbb82bda597ad7418/.github/workflows/docker.yml).
Anonymous authorized manifest reads for both `sha-dce383c` and the full
`sha-dce383c733bb1ca31cd34d7dbb82bda597ad7418` returned **404** during this review.
This is a dated absence observation, not a claim that publication can never occur.
The manifest therefore retains `image: null`, `imageStatus: build_required`.
Neither `latest`, a guessed digest nor an uninspected local tag is deployable input.

The pinned [Dockerfile](https://github.com/paperclipai/paperclip/blob/dce383c733bb1ca31cd34d7dbb82bda597ad7418/Dockerfile)
uses frontend `docker/dockerfile:1.20` and base `node:24-trixie-slim`. It requires
BuildKit/buildx support including `COPY --parents`, Node/Corepack/pnpm, OS build
packages and the Rust runner toolchain/cargo-chef pipeline. It builds the UI,
server and runtime bundle; the server build sets a **4096 MiB Node heap ceiling**.
The production layer installs multiple CLI tools using `@latest`, and dependency
resolution regenerates a lock before installing it. A source commit alone thus
does **not** establish a reproducible image or immutable build materials.

Build the exact `production` target; the later `cloud` stage is the implicit
default otherwise. Supply the full `PAPERCLIP_BUILD_COMMIT` and a recorded
`PAPERCLIP_BUILD_VERSION`, then inspect the resulting build stamp, image ID,
platform and source/target receipts. [Official Docker reference](https://docs.paperclip.ing/reference/deploy/docker/)

A qualified external builder is required. Do not infer that the pilot runtime's
2 GiB ceiling is enough to build this image. A builder needs its own measured
memory/CPU/disk headroom, process and concurrency controls, no additional swap,
and no production secrets or Docker socket exposed to the finished runtime.
Set BuildKit maximum parallelism to one; cap the dedicated builder's cgroup and
record the actual limits. Do not change the global Docker builder or shared Node.
No builder is created by this code. Parent's separately operated build and its
actual outcome are outside this tool's evidence.

`renderCompose(manifest, receipt)` accepts either:

- Registry: immutable `repository@sha256:<64hex>` and the identical value in
  `inspectedRepoDigests`.
- Local loaded image: `image: sha256:<64hex>`, identical `inspectedImageId`, a
  verified saved-image `archiveSha256` and a nonempty `buildStamp` receipt ID.

Both require schema `baink-paperclip/image-receipt/v1`, exact `sourceRevision`
and `inspectedRevision`, target `production`, platform `linux/amd64`, and
`productionTargetVerified: true`. Receipts are operator-supplied evidence records,
not cryptographic attestations manufactured by this validator. Verify archive
bytes before loading, inspect the loaded ID and build stamp independently, and
retain the builder log/material hashes. The tool itself neither loads images nor
reads a Docker socket. Registry signing/provenance verification remains a separate
operator check. No real receipt/image has been committed here.

## Files and commands

Tools require Node 22.13+ and builtins only. Runtime Paperclip's Node 24 requirement
is supplied by its container, independently of BAINK's host Node.

```sh
node --test apps/baink/ops/paperclip/*.test.mjs apps/baink/integrations/paperclip-api.test.mjs
node apps/baink/ops/paperclip/pilot.mjs preflight /private/resources.json /private/image-receipt.json
node apps/baink/ops/paperclip/pilot.mjs compose /private/image-receipt.json
node apps/baink/ops/paperclip/pilot.mjs plan /private/incubator-plan.json
node apps/baink/ops/paperclip/pilot.mjs persist /private/incubator-plan.json /private/bootstrap-journal
node apps/baink/ops/paperclip/qualify-read.mjs /private/read-selection.json
```

These are operator instructions, not commands run against production in this
task. CLI errors contain only safe codes. `compose` prints JSON (valid Compose
YAML), not secret values; `plan` intentionally prints the reviewed source record.
Use an owner-only output file for these private artifacts. Qualifier credentials
come only from the caller's `BAINK_PAPERCLIP_API_KEY`, never CLI arguments or its
selection JSON. No tool executes Compose or sends POST/PATCH/DELETE requests.

Preflight resource JSON fields are `capturedAt` (ISO time),
`availableMemoryMiB`, `swapTotalMiB`, `swapUsedMiB`, `dataFreeMiB`, `rootFreeMiB`,
`listeningPorts` (numbers), and `dataDirectoryState` (`absent` or `empty`). Evidence
must be at most five minutes old with no future timestamp. Minimum available RAM
is 5120 MiB, data disk 10240 MiB, root disk 5120 MiB; the ordinary swap-use path
requires at most 75%, and loopback port 3101 must be unused. Inputs are operator measurements, not host
attestations. Check mount/device paths and process pressure independently.
Exit 2 means a preflight/qualification is incomplete; exit 1 is invalid input.

Full swap can contain cold pages and does not alone prove active pressure. An
optional `coldSwapQualification` object qualifies that case through measured
evidence: `sampleSeconds` 60–300, `psiSomeAvg10Percent` and
`psiSomeAvg60Percent` each 0–1%, `psiFullAvg10Percent` and
`psiFullAvg60Percent` each 0–0.1%, zero `swapInPages`, `swapOutPages` and
`oomKillDelta` over that sample, and at least runtime RAM + 3072 MiB available.
It also requires actual `pilotPeakMemoryMiB` (whole-container measured peak,
including PostgreSQL, greater than zero and within 2048 MiB),
`pilotObservationSeconds` 60–3600, and `pilotImage` identical to the admitted
immutable image. These are measurements from an isolated zero-agent startup
qualification, not values copied from proposed limits. All metrics belong to
the fresh resource snapshot. Missing data, paging, PSI/OOM pressure, a different
image or insufficient headroom fails qualification. This is a measured
alternative, not a flag that disables resource checks or asks for user approval.

The Universa read-only sample had 8 CPUs, ~5.7 GiB available RAM, fully used
8 GiB swap, ~22 GiB root free and ~80 GiB Docker-volume free. It lacks those
PSI/paging/OOM and same-image pilot measurements, so remains unqualified.
This sample is not a current readiness receipt and was not committed as one.
Preflight is for a **fresh** pilot. Existing data requires an explicit recovery
review; passing an invented empty-directory measurement is not a restore plan.

Generated runtime constraints are one CPU, 2048 MiB RAM with the same total
memory+swap limit (no extra swap), 256 PIDs, bounded logs, no automatic restart,
90-second stop grace, `pull_policy: never`, and `127.0.0.1:3101:3100` only.
Its internal Docker network denies external egress. Only the dedicated
`/var/lib/baink-paperclip/data` bind is mounted, with automatic path creation
disabled. No repository/home/SSH/provider credentials or Docker socket are
mounted. Only two dedicated persistent auth-secret substitutions are passed.
Provider credentials are absent. Create owner-only storage with the image's
qualified runtime UID; embedded PostgreSQL must not run as root. Startup,
internal-network reachability, effective limits and UID behavior still need a
real isolated qualification. The ceilings are proposed acceptance constraints,
not measured adequate capacity.

## Bounded operator bootstrap and recovery

The tools deliberately do not automate powerful bootstrap writes. The pinned
[access routes](https://github.com/paperclipai/paperclip/blob/dce383c733bb1ca31cd34d7dbb82bda597ad7418/server/src/routes/access.ts)
provide this concrete sequence for a separately qualified operator session:

1. Start a fresh private/authenticated instance only after image, resource,
   secret persistence, storage and restore prerequisites are qualified. Access
   its loopback UI through an authenticated SSH tunnel, not a public proxy.
2. Sign in with the intended dedicated bootstrap operator's browser session.
   `POST /api/bootstrap/claim` claims the first instance admin only in private,
   authenticated mode, with session authentication. It atomically refuses a
   different later claimant. The CLI alternative is the **pinned**
   `paperclipai auth bootstrap-ceo --config <exact-config> --base-url
   http://127.0.0.1:3101`; it creates a secret one-time invite, not an agent.
   Its actual packaged invocation still needs image qualification. Never use
   unpinned `npx ...@latest`, print invite URLs into shared logs, or use `--force`
   to overwrite an existing administrator during routine recovery.
3. A separate operator action may create one company (`POST /api/companies`),
   which requires instance-admin authority. Record its exact returned UUID and
   owner membership. This endpoint has no qualified company-creation receipt
   mechanism here: after a lost response, inspect/reconcile with the original
   operator rather than blindly creating again. Company creation grants no
   native project admission, Coin allowance or legal-entity status.
4. Create a separate dedicated Viewer user, with exactly one active company
   membership and no instance-admin role. Explicitly choose Viewer; an ordinary
   invite defaults to Operator. Have the owner inspect its explicit grants
   (the pinned Viewer default includes `commentary:view`, despite the simpler
   docs table). Keep bootstrap-owner keys separate and revoke temporary keys
   after qualification. Never grant the existing release-QA identity access.
5. Mint a board key for that Viewer through the CLI challenge flow:
   `POST /api/cli-auth/challenges` accepts `command`, `clientName`,
   `requestedAccess: board`, `requestedCompanyId`. Approve the exact challenge
   in that **Viewer's** signed-in browser with
   `POST /api/cli-auth/challenges/:id/approve` and its challenge token. The
   create response contains sensitive `boardApiToken`/challenge material;
   persist it directly into private storage, never reports. Requested company
   is an approval/activity context, **not** a hard token scope: a board key
   inherits its user's memberships. Recheck them on every qualification.
6. A private project has a separate read ACL. Company Viewer membership does
   not prove private-project access. The qualified owner can add that exact
   Viewer through `POST /api/projects/:id/access-members` with
   `{subjectType: user, subjectId: <viewer-user-id>}`. No roster, unrelated
   company, agent or global access is granted by this tooling.

Persisted plans consume the existing incubator schema
`uain-project-incubator/paperclip-request-plan/v1`. The JS adapter accepts exactly
one private backlog request, retains all ten source fields/types, stable source
ID, workbook hash, original description bytes and original idempotency key.
It rejects environment/workspace/repository/execution fields and extra source
fields. It validates self-consistency, not the authenticity of an arbitrary
caller-supplied workbook digest. Original exporter review was `19ec787e...`;
the candidate request and receipt contract were re-read at the pinned revision.

**No actual new project/task may be created from a catalogue row merely because
it is a private backlog.** Activation requires either an existing admitted native
project with proven lead/mapping or documented prior-art searches establishing
no open/discoverable solution and the owning native admission requirements.
Unreviewed/Gemini-generated novelty claims are not attestations. Draft source
plans remain `nativeAdmission: not_evaluated`, `ownerAuthority: unverified`,
`nativeMapping: null`, `networkWrites: 0`, `executionEnabled: false`.

`persistBootstrapPlan` atomically links a fully written/fsynced 0600 plan into
an owner-only journal directory. Company/source-ID retries return the exact
existing plan; changed inputs conflict without overwrite, including concurrent
calls and restarts. Before any future approved project write, persist this exact
request and record the **actor identity**, runtime revision/company, intent
digest and send marker in a private operator journal. The upstream receipt key
is scoped to company, actor and context; switching owner/Viewer tokens does not
recover another actor's receipt.

`resumeBootstrap(plan, receipt)` is pure guidance and always returns
`writesAllowed: false`. For `send_uncertain`, it returns the exact original body
and `X-Paperclip-Receipt-Only: true` recovery descriptor. Upstream's pinned route
returns an existing matching receipt, conflicts on changed inputs, and does not
create when that header has no existing receipt. This tool never sends it. A
`recorded` receipt requires the same plan digest and project UUID, then directs
read qualification; it does not attest that receipt or authorize execution.
Lost company bootstrap remains manual reconciliation. Never delete retained
data or rotate durable secrets to resolve uncertainty.

For recovery, stop gracefully; retain the qualified image ID/archive, both auth
secrets and the entire dedicated data mount. Embedded PostgreSQL, uploads, local
secrets and workspaces persist there. Use a consistent PostgreSQL backup or a
stopped snapshot, restore into a different isolated directory and perform a real
restore qualification before production use. Do not copy a live database folder
and call it a backup. Restart with the same source/image/secret bindings; inspect
health and existing admin/company/receipt identities before any retry. No
automatic migration rollback or deletion is supplied.

## Read qualification and native ownership boundary

`createPilotQualifier({manifest, apiKey, companyId, projectId, nativeProjectId,
expectedViewerUserId, deniedCompanyId, deniedProjectId, fetchImpl?})` returns
`qualify()`. Selection JSON contains only those six identity fields, excluding
manifest/key/fetch. Denial fixture IDs must differ from the permitted IDs;
for meaningful cross-tenant proof, the operator must know those denied objects
exist in a separate test tenant. A 404 against a random nonexistent ID is only
a non-disclosure check, not evidence of real tenant isolation.

The reader performs only bounded GETs: health, its own board identity, exact
company/private project, empty agent/routine lists, denied permission roster,
denied company/project, anonymous company denial, and scoped issues/costs. It
requires the pinned commit, authenticated/private ready status and an exact
non-admin board-key identity with one active Viewer membership. Source documents
are bounded to one MiB each, redirects refused and errors sanitized. Default
whole-job deadline is four seconds, maximum eight; one actual upstream job is
admitted per qualifier, even after a timeout or ignored abort. Materialized
documents pass through the existing BAINK bridge for projection compatibility;
its internal timeout cannot free admission while a real fetch remains running.

Output states are `not-configured`, `unavailable`, `qualified-read-only`.
The latter qualifies these read checks only: `executionEnabled: false`,
`nativeAuthority: unverified`, `ownershipMapping: operator_supplied_not_attested`,
`writeDenialTested: false`. It does not audit all explicit grants or prove every
write path denies the Viewer. Machine evidence explicitly reports denial **probes**,
`crossTenantIsolationVerified: false`, `privateAclIsolationVerified: false` and
`explicitGrantInventoryVerified: false`; an unknown404 cannot prove an existing
object was protected. Bind separately owner-readable known-existing fixtures
before claiming real tenant/ACL isolation. Owner grant review and any separately authorized
isolated permission-write tests remain separate. Missing cost rows stay
`not-reported`, never fabricated zero spend. No CEO, jobs or rewards are invented.

An unsigned public project HTTP response does not prove private ownership or
permission to map a native project. A real mapping needs fresh pinned native
project/lead proof plus an authenticated, authorized lead/operator action binding
that exact native project to the exact private Paperclip tenant/project and BAINK
viewer addresses. None is currently provisioned by this package. Do not install
its provisional IDs into BAINK production config automatically. Native project
budgets start at zero; Paperclip roles confer no guardian allocation/unlock or
AI$ issuance/spending authority. The governing white paper/FAQ are unchanged.

## Validation and remaining qualification

TDD: both implementation modules first failed because they were absent. Focused
regressions subsequently failed for missing response-stream cancellation and
late ignored-abort admission retention, then passed after fixes. Tests exercise
artifact identity/target/platform/archive binding, stale/resource/port evidence,
source substitution, durable concurrent retries/conflicts, broad/admin keys,
private ACL denial, active workload refusal, bounds, redaction and deadlines.
Final focused verification: **15 new ops tests plus 12 existing bridge tests,
27/27 passing**. The existing BAINK app suite separately passed **159/159**;
its default glob does not discover the new ops subdirectory. Run the explicit
ops command above. No frontend build or production write was performed.

Not completed: qualified image receipt, runtime startup, effective UID/limits,
consistent backup/restore, actual operator/Viewer provisioning, known-existing
cross-tenant fixtures, native lead mapping, admission/novelty review and live
project receipt replay/conflict. Provider execution and Coin activation remain
outside this pilot.

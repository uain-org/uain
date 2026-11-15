# One-source native project pilot

This opt-in pilot uses the existing UAIN commands `open_project`, `open_task`, `project_join`, `submit`, and `verify`. UAIN remains the project and research authority; BAINK stores only holder intents and their proved receipts. It adds no consensus rule, reviewer role, reward, or funding authority.

## Scope and configuration

Leave both variables absent in ordinary deployments. Nothing is enabled by default.

- `BAINK_NATIVE_PROJECT_PILOT_ENABLED=1`
- `BAINK_NATIVE_PROJECT_PILOT_JSON`: one operator-reviewed object with exactly `sourceId`, `sourceDigest`, `projectId`, `taskId`, `creatorAddress`, `creatorInstance`, `chainId`, `epoch`, `projectPayload`, and `taskPayload`.

`sourceDigest` is SHA-256 of portable canonical JSON of `catalogue.detail(sourceId)` (both the exact project and source provenance). The deployed catalogue is already hash-validated and immutable for that process. A changed source/release requires a newly evaluated configuration. `projectPayload` is the exact existing `open_project` payload. `taskPayload` is the exact `open_task` payload, bound to the project, `kind: instant`, `karma_reward: 0`, `credit_reward: "0"`. No production example identity or executable configuration is seeded.

An AI admission evaluator must actually inspect current prior art and produce an explicit approved/held/rejected decision. `chain/client/project-admission.mjs` freezes that decision with one source and generates two stable existing-holder-bridge intents. `runProjectAdmission` runs only approved plans, checks current source/chain/actor scope before each operation, and stops on pending or refused authorization. Its injected bridge is the existing member-held native capability, not a server key. A transport error does not permit another signature. Approval is an evaluator's recorded decision, not proof of novelty; the native Creator/Karma gate still applies. Do not copy known-answer test fixtures into production.

`projectAdmissionPilotConfig(plan)` derives the exact frozen BAINK configuration from an approved plan, preserving the source/decision commitment in the public payloads. Held/rejected or tampered plans cannot produce a configuration. The browser pilot takes that evaluated configuration. Its configured creator must already have Creator authority or the existing Karma allowance. Being a licensed member or owning an instance does not grant creation/reviewer powers. Before production activation, compare the configured payloads/source digest to the evaluated plan; configuration is a deployment trust boundary, not a public admission API.

## Automatic AI evaluation of one source

`apps/baink/ops/project-admission-worker.mjs` loads one actual validated catalogue row and asks the existing Claude CLI (Opus 5.5) to scope one small question and two search queries. It then retrieves those queries from fixed Crossref endpoints and at most two primary articles from Europe PMC, retaining exact UTF-8 bytes, SHA-256, URLs and times. A second isolated model call evaluates that supplied evidence. Source and paper text are untrusted data; tools and ambient MCP servers are disabled, a minimal system prompt and private temporary working directory prevent unrelated repository context, and each call has bounded output/time/cost.

Only grounded approved/held/rejected decisions with real citation IDs survive validation. Metadata-only results, incomplete retrieval, absent primary support, uncertainty or evaluation failure are held; known answers may be rejected. The exact question is included in the native task criteria. This is a bounded admission assessment, not proof that all global prior art is absent. A held outcome is a correct safe result, not permission to manufacture a demo approval.

```sh
BAINK_ADMISSION_CLAUDE=/absolute/path/to/claude node apps/baink/ops/project-admission-worker.mjs OPP-00002 public-scope.json /absolute/private/evaluation-output
```

`public-scope.json` has exactly `chainId`, `genesisSha256`, `member`, and `instance` (public metadata only). The CLI evaluates only and never signs or broadcasts. `runEvaluatedAdmission` can feed a separately provisioned existing holder bridge after verifying the expected evaluation digest, retained evidence, a 15-minute freshness window, current source/epoch/actor and a trusted `currentEvaluationDigest(sourceId)` pointer before each operation. Newer held/rejected decisions therefore supersede earlier approval. The caller owns that current-decision registry and the member signing capability; no server key or new authority is created. Production activation and reviewer/reward decisions remain separate.

## Holder flow

Work displays the panel only when a pilot configuration exists. It reads canonical project/task/contribution records from the pinned native reader. The holder selects an owned active instance and prepares one action; preparation does not broadcast. The exact payload is displayed and must be acknowledged before local signing. The server independently checks the signature, source, actor, instance, project, task, sequence and current proof before recording a durable send marker and broadcasting once.

- Creator: open the one configured project, then its one configured task.
- Participants: join that project, then submit one public contribution bound to that task.
- Eligible checkers: verify a task-bound contribution, never their own. Native checker/operator/family/settlement rules remain authoritative. A signed check is not itself proof of independence or a reward.

The portable codec is tested against `chain/client/signing.mjs`; nested evidence is hashed using the existing `uain:research-evidence:v1` domain. Pilot prepare bodies are limited to 12 KB inside the existing 16 KB HTTP limit. The UI recommends public source links for larger evidence. `verify` accepts a conservative public HTTPS known-source URL, at most 500 bytes and without credentials.

CheckTx is only a submission response. Only the exact signed command's proved event and resulting bound records make an intent final. An uncertain response is never automatically resent. Explicit recovery scans at most 32 events per request; only a complete proof-backed scan after the command expiry can release a nonincluded intent for a new deliberate action. Finality recovery remains possible after catalogue drift. Local sequence fences prevent an unresolved pilot send from racing the other BAINK native flows; a different device remains subject to native sequence rejection.

Historical recovery is bound to each saved command and its original chain/epoch, rather than the current pilot configuration. Changing or removing the pilot configuration retains the holder's history and browser recovery actions. The configured native reader must still independently pin the original network; a different chain or genesis cannot clear an old send. Finalized submission evidence can still be explicitly published using its original body/event after the pilot is disabled or replaced. This never authorizes an old signature for another broadcast. Multiline prior-art basis and acceptance criteria retain the native CLI's exact signing bytes; titles and search entries remain single-line.

For native `submit`, the final chain command commits to the public body's digest. A separate explicit **Publish evidence** action sends that exact journaled body/envelope/final event to the existing UAIN `/api/native/evidence` publication boundary. Publication and chain finality have separate status. Failed publication does not erase finality and never creates a replacement chain command. The independent UAIN publication endpoint validates the finalized event again.

For the one enabled pilot source, the older management evidence POST rejects new local review intake and directs the holder to the UAIN pilot panel. Historical evidence GET and coordinator chat remain readable; other sources are unchanged. No existing BAINK preparation evidence is automatically published, deleted, relabelled accepted, or turned into native work. A later migration must obtain explicit owner consent and retain original attribution/time/IDs. This change does not complete that migration or bulk-admit the catalogue.

## Endpoints

All routes require existing signed BAINK account authentication; there is no public generic broadcaster.

- `GET /api/native/project-pilot`: configuration and this holder's intents only.
- `POST /api/native/project-pilot/snapshot`: `{}` or `{contributionId}` for the configured native project/task.
- `POST /api/native/project-pilot/prepare`: `{clientRequestId, sourceDigest, operation, instance, payload, body?}`.
- `POST /api/native/project-pilot/:id/submit`: exact holder-signed `{envelope}`.
- `POST /api/native/project-pilot/:id/receipt`, `/recover`, `/publish`: empty objects, own intents only.

New database field `nativeProjectPilotIntents` is additive. Other native flow send markers refuse unresolved pilot sends. No live metadata or chain history is rewritten.

## Qualification and rollout

Run the focused browser/HTTP/service/codec/admission tests, both BAINK builds, and the native federation tests. The local browser harness is synthetic and exercises real holder signatures/service receipts but does not replace consensus proof verification. The Go Keeper tests exercise actual signed native state transitions with in-memory synthetic actors, not a running network. Existing end-to-end chain tests require explicit isolated binaries; never point tests at production RPC or existing private identities.

Ship the feature disabled. Before any production pilot, choose one genuinely unresolved scoped question, verify an existing authorized creator and eligible independent participants, qualify fresh pinned reader/publication connectivity, and prove the entire path on an isolated network. Independent review, PR merge and the existing root-operated standalone release process are separate from source publication. The branch incorporates the published 0.3.27/0.3.28 storage-lock changes; recheck for newer source before release.

Rollback disables the pilot and restores application code while retaining journals. Finalized native events are not erased. This PR does not issue funds or establish earning, autonomous scientific execution, or a working paid project.

### Local commands

```sh
node --test chain/client/project-admission.test.mjs chain/client/native-bridge.test.mjs
node --test apps/baink/test/native-project-pilot*.test.mjs apps/baink/test/native-pilot-sequence.test.mjs apps/baink/web/native-project-pilot.test.mjs apps/baink/integrations/native-research-codec.test.mjs
node --test --test-concurrency=1 apps/baink/test/*.test.mjs apps/baink/integrations/*.test.mjs apps/baink/web/*.test.mjs apps/baink/holder/*.test.mjs apps/baink/holder/runtime/*.test.mjs
BAINK_BASE_PATH=/ npm --prefix apps/baink run build
BAINK_BASE_PATH=/baink/ npm --prefix apps/baink run build -- --outDir dist-preview
cd chain && go test ./federation -count=1
```

The stock parallel app test command can overload short-deadline subprocess fixtures on this Mac. Run serially and record any residual failures honestly rather than loosening production deadlines. Focused tests must be green. Native tests use only generated synthetic keys and isolated state.

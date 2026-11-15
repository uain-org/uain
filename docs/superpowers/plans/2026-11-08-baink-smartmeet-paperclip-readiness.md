# BAINK integrations: qualified reads before execution

Date: 8 November 2026. Scope: source/runtime plan; no client registration, grant, meeting, notification, agent hire/approval, provider activation or integration configuration was performed. The authored change note and later canonical release records own delivery status.

## Actual state and boundaries

- The running BAINK process has no SmartMeet API origin, integration key or member allowlist, and no Paperclip origin, credential, project map, viewer map or native-lead configuration. Presence was checked inside the owning process without printing values. Source wiring already exists; missing configuration is not missing routes.
- The private Paperclip service, loopback relay and container are active. Fresh existing-Viewer GETs returned200 for its identity, projects and agents: exactly its expected company, three projects, zero agents. The retained mirror journal covers three historical projects and fourteen issues; it is not proof that today's native projects or tasks are mirrored. No writes or execution were requested.
- Dedicated BAINK SmartMeet client registration remains unverified. An absent BAINK key does not prove that no registration exists. Existing source scopes a nonlegacy key to its platform client, with `X-Platform-Name: BAINK` filtering. BAINK's allowed members currently receive the same platform-client meeting list.
- SmartMeet's repository deliberately permits open context within its own authenticated testing environment. This work does not add security layers there. A BAINK native key does not by itself establish a SmartMeet account association or a Paperclip project-viewer grant. Existing cross-product boundaries must not be removed or populated with guessed associations.
- BAINK's adapter only lists meetings; meeting creation can notify participants and summary retrieval can invoke/persist model output. The Paperclip organization adapter expressly excludes approval, wake/run/provider/payment routes and requires hires to remain pending approval. Organization reconciliation and a Viewer dashboard do not establish a working execution crew.

## Small source correction

The SmartMeet projection formerly accepted a valid SmartMeet meeting URL pointing at a different meeting than its returned ID. Bind navigation to that exact returned ID, retain stripping of query/fragment credentials, and return no link when it differs. This changes no access policy and configures no integration. Actual-shaped mismatch regression was observed RED→GREEN; the focused SmartMeet/Paperclip adapter suite passes25tests. Deployment and authenticated round-trip remain separate.

## SmartMeet: explicit integration qualification

1. Locate the owning production API/source/database through its maintained operations configuration. Run a reviewed read-only aggregate probe for active BAINK platform-client registration and known platform-name association; emit booleans/counts only, never API-key hashes, contact details or meeting records. Do not assume registration absence from BAINK's empty environment.
2. If a dedicated registration already exists, qualify its custody/rotation and nonlegacy platform scope. Otherwise prepare the exact normal registration operation for operator review. Do not borrow the reporter's key or a legacy global key; no credential belongs in a browser or repository.
3. Establish the intended association using a verified existing SmartMeet principal/project relationship and BAINK signed native identity. A holder's unrelated local profile and an organizer-email query are not identity proof. Document whether this client is an intentionally shared operator calendar or offers holder/project-specific results before populating membership configuration. Preserve current SmartMeet open-context policy and existing BAINK integration grants; do not silently grant every new BAINK member access to historical integration data.
4. Backend implementation files are `server/index.mjs`, `server/app.mjs`, `server/routes/management.mjs` and `integrations/smartmeet-api.mjs`, with route/adapter tests. Add only the explicit approved association contract needed by step3; missing mappings remain honestly unavailable. Test two fictional native identities and two meeting/project associations, query pagination, missing/changed association, upstream failure and omitted private fields. No generic upstream URL, credential forwarding or arbitrary meeting ID is accepted from a caller.
5. Inject reviewed origin/key/membership configuration through the owning protected environment; independently check only presence and the exact dedicated-client scope. Release BAINK through normal combined tests and immutable guarded activation. An authenticated list round-trip must distinguish not configured, denied, upstream error and a genuinely empty list. Validate the exact displayed meeting URL; do not create a meeting or request a summary to demonstrate listing.

## Paperclip: current native mapping and private project reads

1. Requalify the pinned private runtime and its existing Viewer using the GET-only qualifier. Keep its company boundary and private project visibility; preserve complete prior bootstrap/mirror journals. Source and relay health alone do not prove that a current native project is mapped.
2. Obtain original-reader proofs of the current project, native roles/membership, task policy and approved plan. Match these to a separately approved Paperclip company/project mapping by stable IDs, never display names or guessed ordinal IDs. A mirror status cannot approve a native KPI, mint AI$, close a task or pay an invoice.
3. Prepare a deterministic mapping dossier for the intended current projects. If mirrors are missing, use the existing journaled organization reconciliation under its normal manager/custody authority, preserving pending-approval hires and existing resource limits. Do not edit private runtime databases or create an active agent directly.
4. Prepare BAINK's protected `BAINK_PAPERCLIP_*` bridge settings, explicit `VIEWERS_JSON` and existing native-lead associations only after the underlying mappings/access have been approved. Qualification needs one allowed and one denied identity/project, plus unmapped/error cases and proof that no upstream call occurs before access checks. Never make the private company/project projection public to satisfy equal member capability.
5. Activate reviewed settings and release code only if needed through the normal path. Perform signed BAINK operations reads against the actual mapped project and validate the exact Viewer readback; no hires, issue writes, provider calls or wake/run operations belong in this acceptance. Keep configured, connected, mirrored and executing as distinct states.

## Paperclip execution: separate future contract

Execution requires a separate reviewed runner; do not extend the existing organization capability allowlist to admit arbitrary wake/run/approval paths. Proposed separate source: `services/project-organizations/src/paperclip-execution.mjs` with a fixed actor/project/role/provider-profile contract and tests, plus an operator-only custody runner and a read-only BAINK status projection.

Before activation require: an explicit normal board approval for the named agent/role; current native project/manager/approved-plan binding; qualified first-party subscription CLI profile or unchanged explicit API admission; fixed resource/time/output/process bounds; deterministic run ID; immutable intent before dispatch; no retry of unknown outcome; and independently checked results. Original signing keys stay with their owner. Task discovery and submissions use the existing typed holder/agent interfaces and their native receipts; central UAIN review, novelty/survey contracts and Fund Manager gates remain authoritative. Reward-only project money does not fund arbitrary operating spend.

Tests must cover foreign project/actor/provider substitution, stale plan/role approval, unsupported routes, unavailable credentials, cancellation and process reaping, duplicate/unknown dispatch, fabricated completion and attempted native/financial side effects. Qualify one isolated nonfinancial run, independent refutation, then an actual current task submission/review/award under the normal gates. Do not describe the current zero-agent mirror as this execution acceptance.

## Practical order and remaining evidence

1. Review/release the small navigation correction alongside other BAINK source work; it grants nothing and is useful without configured credentials.
2. Finish owning SmartMeet registration/association discovery and current native-to-Paperclip mapping dossiers in parallel, without notifications or runtime writes.
3. Qualify and activate only the approved GET integrations, with two-identity/project acceptance and honest disconnected states.
4. Design/review the separate narrow execution contract, then stage it with an isolated run before any normal approval or provider activation.

No remaining item in this plan is answered by broadening access, replacing private keys, opening forbidden execution routes, inventing memberships or treating a source test as live acceptance.

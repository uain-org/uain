# Canonical BAINK proposal pages implementation plan

> For agentic workers: execute the scoped tasks with TDD and independent review.

Goal: make existing validated inactive proposals shareable as initial HTML and
machine-readable documents without admitting native projects, publishing TREE
organizations, funding or changing UAIN's existing native-project SEO routes.

Architecture: serve BAINK-only `/proposals/<stable-id>-<slug>` documents from the
already loaded catalogue. Stable ID is authoritative, slug is presentation and
stale/id-only paths redirect. A separate full-document revision binds KPI and
provenance; existing work-selection digests never change. Actual Claude owns
the script-free HTML presentation. HTTP integration keeps Host/Origin/CSP guards
and private data unchanged. Preview links retain `/baink/`; no new nginx scope.

Tech: existing dependency-free Node HTTP, catalogue, SHA256 and server rendering.

- [x] New source-model/path module and unit tests: known OPP/PRB, deterministic
  bounded slug, exact source/KPI document, revision change on content changes,
  no native/financial authority, absent404 and unavailable503.
- [x] Actual Claude Opus5.5: one script-free renderer file with self-contained
  accessible responsive layout, escaped source values, plain inactive/KPI-target/
  unfunded qualifications, canonical and JSON links, no third-party assets.
- [x] HTTP tests and integration:200 HTML/JSON, id-only/stale slug308, true missing
 404/source503, HEAD/GET safety, denied writes/unknown queries/unsafe origin,
  canonical origin from verified audience, bounded paths/encoded attacks, and no
  persisted state changes. JSON uses explicit `?format=json` same canonical route.
- [x] Expose stable page links in existing public proposal projections and a
  minimal existing project-detail link (actual Claude presentation ownership).
  Preserve canonical path versus absolute URL semantics and preview base.
- [x] Independent review, full app tests/both builds, isolated browser mobile/
  desktop and real initial-HTML verification without production test records.
- [x] Immutable standalone0.3.10 release, expected-prior/hash/state/ingress checks,
  public primary+preview+SDK acceptance; no UAIN main push.
- [x] Detailed root/app changelog, context, implementation/task/intent/delivery
  registers and private poll/source checkpoint; SmartMeet reporter delivery and
  actual bot readback, no repeated unanswered decisions this run.

Authorization: Rahul's continued implementation/standalone deployment request and
S4-10 acceptance in docs/kenneth/existing-work-audit-2026-11-01.md. The earlier
offline TREE-site publication boundary remains: this is a BAINK catalogue detail
view, not deployment of organizations or native project sites. Existing directory
source stays unchanged. Native SEO owning chat has been notified of distinct scope.

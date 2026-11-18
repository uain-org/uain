# Changelog

## Unreleased

### 2026-11-17

- **Launch wording across the site, BAINK and MCP:** 16 files no longer say UAIN is "in testing, not launched"; they say it is live. The "records may be reset while testing" statements are removed. `SECURITY.md` drops its reset sentence. The guide-answers `LIMITS` now begin with "AI$ has no cash payout.", and `mcp-connections.test.mjs` asserts that and checks the old wording is gone.
- **Contributions open:** `CONTRIBUTING.md` now welcomes pull requests (issue first for larger changes, branch from protected `main`, tests, a changelog line, DCO sign-off with `git commit -s`, Apache-2.0 / CC BY 4.0). The README's Contributing line says the same.

- Served claim records at `/api/claims/CL-n` (the route answered HTTP 409 under native authority) and served claim revision ids as the numbers the ledger committed instead of strings, so `verify-ledger.mjs` can recompute every claim revision and review, and the MCP claim tools' integer `base_revision` round-trips. Native proposal ids (`native:...`) stay strings. A test recomputes the committed revision and review digests from the served form and shows the earlier string form failing; 349 database-free pilot tests pass. The six claim commitments (entries 1527 to 1595) verify once production runs this release.
- README: the status line now says UAIN is live at uain.global; the 409 verification limit is replaced by how claims are served. Other pages still describe a testing phase (17 files, including the site's about, governance, network and limits pages, BAINK's guide answers and MCP text, `llms.txt`, `SECURITY.md`); they were not changed here.

- Fixed the rollout waiter to distinguish terminal old pods from running old replicas. Reproduced the staging timeout with Succeeded/Failed regression cases; active old pods and unavailable new replicas still block rollout.

- Made this the canonical application repository; retained public history, registry metadata and public-only test improvements while synchronizing the latest signer checksum guidance and deployment classification from the former private source.
- Moved privileged release ownership to a separate private operations repository. Releases check out an exact public source commit; public CI uses disposable hosted runners without production access. Migration completed: staging and production now run the public source, with release ownership in the private infrastructure repository. Both backend modes and site checks passed; web/API build metadata and public health checks were verified. The former private working repository is archived.

- Updated `public/server.json` for the MCP Registry listing `global.uain/network`: version `0.1.0` to `0.3.0` (the live server reports `0.3.0-pilot`), a plain 98-character description replacing "AI-operated campaign; joining needs permission", and the website link without its `?ref=` tracking code. Not yet republished to the registry; that needs the key behind `/.well-known/mcp-registry-auth`.

### 2026-11-16

- Established the explicitly requested local Windows checkout at D:\uain and local branch codex/uain-discovery-20261116; no push or deployment.
- Included eligible central open research tasks in sitemap discovery, preserved legacy exclusions, deduplicated entries and refused incomplete central authority for sitemap reads.
- Added aggregate sitemap, bounded record leaves, canonical public sitemap serialization, retryable discovery failures, paginated task canonicals and filtered-page noindex.
- Added factual source-linked explanations, research hub, governance distinctions, dated verification-limit note and HTML directory; linked public catalogues in initial HTML/navigation.
- Explained unavailable historical project references through existing public authority, without revealing hidden records or guessing redirects.
- Added dry-run-first, host-restricted IndexNow CLI and bounded receipt/retry tests. No ownership key provisioned or notification sent.
- Revised machine-guide key continuation to keep private keys local, retained governing PDFs, and documented approved plan, audit evidence and release/account gates.
- Local Edge control approval timed out before authenticated console review. No account/property change or submission occurred.

- Independent review: corrected task-map/detail ID alignment, incomplete task HTML handling, relative reverse-proxy redirect, mandatory IndexNow ownership proof under injected transports and machine-route exclusions. Extended the real Nginx fixture and added 10,001-URL batching coverage; live routing execution remains gated.

### 2026-11-16 — branch publication follow-up

- Aligned insight visible, structured and sitemap modification dates through one editorial source; noindex duplicate task query parameters. Regression tests reproduced both issues before correction.
- Verified local Git credentials against GitHub as Vignesh-604. Publishing is authorized only to the discovery branch; main/merge/deployment remain unauthorized.

- Rebased discovery changes onto the current public export, preserving upstream removals and UAIN-first aliases; extended discovery to its existing limits/example pages. Remote test access remains blocked by SSH trust configuration.

- Connected local Edge and reviewed the authorized UAIN Google/Bing properties. Prepared the exact Bing-provided homepage ownership meta tag with built-HTML regression coverage; remains unpublished pending reviewed release. No property users, ownership, other sites, submissions or production configuration changed.

- Added fork-only pre-release CI with disposable PostgreSQL, both backend modes, web/discovery verification and the real isolated Nginx fixture. No secrets or deployment permissions. This provides a remote test path when local SSH authentication is unavailable.

- Completed mobile/keyboard/unavailable-API browser checks; corrected scoped article typography found in visual QA. Removed 33 introduced lint diagnostics; kept existing repository findings visible and documented the two new-file compiler-option incompatibilities narrowly. Run normal/write-thread backend suites in parallel disposable runners, independently of web/Nginx checks.

- Full-suite execution corrected the discovery HTTP test harness to import new helpers, and the onboarding fixture now enforces key-local continuation. Added actual-handler pagination/filter/error tests. Public-export-only fixture comparisons explicitly skip absent unpublished inputs, while pure valuation/project-area/HTTP checks continue to run; malformed present fixtures still fail.
- Disabled one inapplicable type-aware lint rule only for the two new pilot modules, since it requires strictNullChecks and pilot compiles with strict:false; all existing baseline lint diagnostics remain visible.

- Final review retained exhaustive comparison against all 21,600 tracked public catalogue rows. Valuation comparisons skip only when the entire unpublished fixture directory is absent; missing individual inputs fail. A read-only local run against the original valuation directory passed all 31 focused checks with zero skips; no private content copied/published.

- Final pre-release verification succeeded on code 9f4f1bb, Actions run 43904845015: normal and write-thread PostgreSQL modes each 923 passed / 9 explicit skips / 0 failed; web and actual Nginx jobs succeeded. Six omitted valuation-document comparisons also passed locally against read-only original fixtures. Lint comparison shows no introduced diagnostics. Browser mobile/keyboard/unavailable-data checks completed; developer-protocol permission for disabling JavaScript was declined and not bypassed. Updated the work register with exact coverage and release-only dependencies.

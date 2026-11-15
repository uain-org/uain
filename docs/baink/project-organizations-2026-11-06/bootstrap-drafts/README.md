# Bootstrap prior-art drafts (120 projects)

These files are **drafts**. Each `OPP-xxxxx.json` holds the project-level prior-art
searches for one project in the frozen selection (`../selection.json`). A draft is not
a reviewed bootstrap record, and `bootstrap.mjs` does not accept it. Every project
stays held as `prior_art_review_required` until an independent reviewer promotes its
draft.

## What a draft holds

- `project`, `native_project` (`P-<id>`), `source_digest` and `source_revision`. The
  catalogue row reproduced its pinned source digest before any search ran.
- `title`: the exact catalogue title, never rewritten.
- `queries`: derived from the catalogue title and description by
  `prior-art.mjs` `deriveQueries`. The derivation is deterministic and uses no model.
- `searches` and `retrievals`: one entry per successful search. Each `resultSummary`
  starts with the exact `url=` and the `sha256=` of the bytes read, and each matches a
  retrieval. The sources are GitHub repositories, arXiv and Crossref. Semantic Scholar is
  excluded because it returns 429 without a key.
- `failures`: each search that failed, with its source and code. A failure is never
  counted as a search.
- `searches_digest`: the digest of the subject, searches and retrievals. A reviewer can
  bind an assessment to it with `searchesDigest`.
- `class: null` and `assessment: null`. The drafting step never sets class or novelty.
  It makes no novelty claim, and zero results do not mean a problem is open.
- `status`: `assessment_required` when there are at least two successful searches,
  otherwise `insufficient_searches`. An insufficient draft is redrafted on the next run.

## Next step: independent assessment

The reviewer must not be the drafting step (`uain-trusted-prior-art-search-v1`,
`uain-project-organization-bootstrap-drafter-v1`) and must not be the proposing model.
The reviewer reads the listed results, follows the bound URLs if needed, and decides:

- `class`: `benevolent` or `neutral`
- `assessment`: `{openSolutionFound, knownAnswer, reviewer, rationale}`. Both flags are
  explicit booleans, and the rationale is at least 20 characters.

Then `promoteDraft(draft, {class, assessment}, {selection, excludedReviewers})` in
`services/project-organizations/src/bootstrap-record.mjs` either:

- returns the exact reviewed bootstrap record (`uain-project-organization-bootstrap-review-v1`)
  that `buildOpenProjectPayload` accepts, with native bounds checked: a basis of 40 to 4000
  bytes and 2 to 20 distinct searches, each bound to its URL and sha256; or
- returns a hold (`prior_art_open_solution_found` or `prior_art_known_answer`) when an
  open solution or a known answer exists. Such a project is not opened as new work
  (CLAUDE.md rule of 29 September 2026).

It refuses a reviewer who is not independent, a short rationale, fewer than two
searches, tampered or rebound searches, and a draft for a source that is no longer
pinned.

Promoted records must still be pinned root-owned so Python custody can re-derive the
title and prior art (`remaining_work.md`). This is not done.

## Regenerating

```
node services/project-organizations/ops/draft-bootstrap.mjs            # resume-safe; skips drafted projects
node services/project-organizations/ops/draft-bootstrap.mjs --summary  # counts only, no network
```

The drafter waits at least 6.5 s between GitHub requests, because GitHub allows 10
unauthenticated requests a minute. It waits 3.5 s for arXiv and 1 s for Crossref. A
refused request is retried once after a backoff. Only public HTTPS GETs to the
allowlisted search APIs are made.

## Run of 6 November 2026

The run took 00:04 to 00:32 UTC, about 28 minutes. It made public read-only GETs only.

- **120 of 120** projects were drafted, and all have status `assessment_required`, with at
  least two successful searches each. The draft ids match `../selection.json` exactly.
  Every catalogue row reproduced its pinned source digest.
- **719 searches** succeeded: GitHub 240, arXiv 239 and Crossref 240. 119 projects have
  6 searches. OPP-00003 has 5.
- **1 search failed**: arXiv `unexpected_status`, for the second query of OPP-00003,
  after one retry. Two arXiv requests needed a retry (one timeout, one refused status).
  GitHub had no failures, and neither did Crossref.

**Read this before assessing.** The deterministic queries are narrow: up to six AND-ed
keywords, and the second query adds the catalogue domain words. GitHub returned 0
results for 225 of 240 searches, and arXiv for 209 of 239. Crossref is relevance-ranked,
so it always returned results, but many are only loosely related. **Zero results are not
evidence that a problem is open.** These drafts give the reviewer a bound starting point
and do not replace the reviewer's own search. If a reviewer finds an open solution or a
known answer elsewhere, they record it as `openSolutionFound` or `knownAnswer`, and the
project is held.

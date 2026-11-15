# Prior-art survey: live record-API qualification

`OPP-00002-live-20261106.json` is the output of
`node services/project-organizations/ops/qualify-survey-live.mjs OPP-00002 --out …`, run on
6 November 2026 from a workstation against the live APIs. It is a qualification of the
verifier, not a survey: the relations, notes and gap are placeholders, and the titles were
copied from the record APIs.

What it shows:

- The survey task and policy were built from the real draft, reviewed record and catalogue.
- All 9 identifiers the project-level searches returned resolved through Crossref, arXiv or
  GitHub with matching titles.
- 12 discovered items (from the reviewer's cited identifiers plus PubMed, ClinicalTrials.gov and
  Wikidata searches) resolved through 5 kinds of record API. The real verifier used
  pinned-address retrieval, then the hash-pinned driver in its isolated worker. Verdict `pass`.
- A fabricated DOI was reported `item_not_found` by Crossref, and a wrong title was refused
  (`item_title_mismatch`). Both verdicts were `fail`.

Nothing was signed, submitted, opened or paid.

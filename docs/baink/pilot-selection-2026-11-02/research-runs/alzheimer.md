# Alzheimer's stage-one source audit: T-35 / RC-4579

**Run:** 2 November 2026. **Result:** existing work needs independent evidence
retrieval and protocol reconciliation; this run is not a scientific reproduction
or a registered native-agent action.

## Existing task and actual result inspected

Read the current public [native task T-35](https://uain.global/api/tasks/T-35),
including its question, acceptance, provenance, result RC-4579, artifact manifests,
reproduction declaration and review projection. It is the existing Alzheimer's
project `alzheimer-s-disease-open-questions-answered-from`, mapped provisionally
to [PRB-00505](https://baink.money/proposals/PRB-00505). Do not create a duplicate.

- Task status: **awaiting_verification**. One result, RC-4579, is **held**.
- The result projection requires two verifiers and currently lists no
  verifications. This is an observed source state, not a fresh judgement about
  contributor or reviewer identity.
- The submitted claim reports no multiple-testing-significant enrichment among
  112 qualifying SEA-AD gene sets in either APOE-region condition. This audit has
  **not** verified that scientific claim.
- The task already fixes the GWAS identifier, SEA-AD split, MAGMA version,
  gene-set construction, coordinate window and statistical criteria. A new task
  copying that question would duplicate existing work rather than create a new
  prior-art-qualified problem.
- Reported price is60Karma, not60AI$. No award, balance, payment or native write
  was created by this audit.

## Concrete evidence and reproduction gaps

1. **Four key outputs are advertised only as local artifact labels.** The
   response supplies hashes for `pipeline.py`, `nebula_inputs.csv`,
   `magma_cps_sets.csv` and `genes.genes.out`, but no retrievable artifact URI for
   those four. The API also reports evidence_available=true; that flag does not
   itself supply their bytes. They may exist in an approved operator archive;
   this audit did not search private disks or independently retrieve them.
   Obtain the exact allowed files through the existing evidence workflow, verify
   complete hashes, and preserve their original provenance before reproduction.
2. **The post-exclusion eligibility rule needs explicit reconciliation.** The
   task requires a minimum ten mapped genes. RC-4579's own narrative says one
   early L2/3 IT_3 down set falls to nine after APOE exclusion but was still
   tested, with112tests; dropping it would leave111. The summary/reproduction
   declaration still uses112for both conditions. This is a specific protocol/
   denominator ambiguity, not a proven numerical error: determine whether the
   threshold is applied before or after exclusion, then independently reproduce
   the accepted rule and correct/qualify the claim if needed. Do not silently
   change the task or claim that the reported conclusion is reproduced.
3. **Build/identifier matching requires a real audit.** The task names a build38
   GWAS file but a build37reference/gene-location workflow. It specifies rsID
   matching, which can support the intended mapping; that does not automatically
   make the workflow wrong or prove it right. Inspect actual identifiers,
   synonym handling, duplicate choices, reference coordinates, and the APOE
   exclusion list against the submitted code and inputs.
4. **Independent run evidence is absent from this audit.** The response describes
   a macOS/Rosetta MAGMA run and expected metrics; descriptions/hashes are not
   an executed reproduction. Obtain a compatible authorised environment,
   establish bounded capacity, rerun the exact pinned inputs and compare the
   actual set counts/coefficients/p-values to task tolerances. Downloaded inputs
   advertised in the response exceed1.2GBbefore the other files; this run made
   no such download and did not launch compute.

## Primary sources actually consulted

- [MAGMA developer documentation](https://cncr.nl/research/magma/), read2November.
  It documents version1.10, separate reference/gene-location resources and
  conditional gene-set methods. It also distinguishes the licensing of older
  MAGMAv1.0 (GPLv3) from later releases. Do not assume the1.10binary can be redistributed
  in a pilot package; use its actual licence and approved acquisition path.
- [GWAS Catalog study page GCST90027158](https://www.ebi.ac.uk/gwas/studies/GCST90027158),
  read2November. The text response exposed mostly unpopulated application
  placeholders. It did **not** independently validate the pinned summary-file
  metadata, published attribution or MD5. Use the task's exact source plus a
  qualified metadata/file check for that later step; do not treat the page's
  unpopulated “not available” text as proof that the data are absent.
- Attempted the [original SEA-AD paper](https://doi.org/10.1038/s41593-024-01774-5);
  the browser tool could not follow Nature's identity redirect. The paper was
  **not** read in this run.
- Attempted a bounded one-key S3 listing of the task's Early Donors/CPS prefix;
  the browser tool reported that URL inaccessible. No listing, CSV availability,
  snapshot count or per-file hash was verified. This client failure is not proof
  that the bucket or data are unavailable to another supported client.

The earlier stage-one briefs separately consulted SEA-AD's public data/code
pages. Neither those resource links nor this bounded run exhaust the exact
question's prior art. No fresh novelty attestation is issued here.

## Actionable handoff

1. Re-read current T-35/RC-4579 claim/review state before taking a native role.
2. Recover the four exact submitted files from approved evidence storage and
   verify their hashes; record retrieval failure explicitly if inaccessible.
3. Resolve and document the post-APOE ten-gene threshold/denominator interpretation
   against the unchanged task and actual result CSV.
4. Independently execute the pinned analysis only in a qualified bounded
   environment, preserving original source data and author attribution.
5. Use the native independent-check workflow for an actual attestation; do not
   mark Paperclip's done status as proof, auto-reward the submitter or seed a
   second copy of this problem.

## Source receipt and limits

Current task response SHA-256: `d22b3128a6a6e8acb84a2b5602f7fca3b5bf898259cdda72f0ecb385b189e0a5`.
API-reported epoch: `54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff`.
API-reported state height: `1096884`; app hash: `efcb2f625440fdb4f95fe06a3abb4ca0385de5b29289c5b08703300801cb6563`;
finalized events: `466`. The API labels its source independently verified
native state; **this agent did not independently verify a cryptographic proof**.
The earlier project/list snapshots may carry an earlier height; this audit keeps
its exact current receipt distinct rather than overwriting the selection manifest.

Only this safe source-audit note was added. No private messages, private keys,
credentials, signed task/review mutation, scientific result, model/provider job,
payment or production configuration was created or changed.

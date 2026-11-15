# Holder-private research selections

NEXT-04 is project interest, not commissioned work. It replaces the older
device-wide bookmark list with signed durable metadata under the same holder
identity. Old localStorage records are retained locally but are not silently
attributed to whoever next opens the browser.

## Contract

- Public `GET /api/work/source?kind=proposals|projects&projectId=<id>` returns a
  normalized summary snapshot and its SHA-256 review digest. Supported proposal
  IDs are OPP-/PRB- followed by five digits; live project IDs follow the existing
  lowercase/digit/hyphen route. Query duplicates/unsupported fields are rejected.
- Signed `GET /api/work/selections?page=1&pageSize=25&availability=selected`
  returns only this existing local account's choices. `all`/`withdrawn` include
  retained history; pagination occurs after holder filtering.
- Signed `POST /api/work/selections` accepts only clientRequestId, kind,
  projectId and sourceDigest. Current source summary must match what was reviewed.
  Snapshot is retained immutably with owner and timestamps. A local signed
  account is required; this does not establish native licensing/eligibility.
- Signed `POST /api/work/selections/:uuid/withdraw` accepts an empty object and
  is idempotent. Another holder receives not-found. Withdrawal releases the
  active choice but preserves its intent/history. Explicit reselection uses a
  new intent. Retrying the original withdrawn intent never resurrects it.

The summary contains kind, projectId, title, description, category, status,
sourceRevision, sourceAuthority, sourceUrl, sourceAvailable and taskCount.
Fetched time/private configuration/unrelated source fields are excluded. This
hash binds that summary, not every KPI/task or a native state root. Proposals
use validated source revision; live HTTP projections have no invented revision
or independent proof. Existing project-detail cache is at most60 seconds.

## Failure and resource rules

Missing source is404; unavailable/unvalidated source is503; changed reviewed
summary is409. No selection is persisted on those failures. Existing accepted
intent is checked before another upstream read, so a lost response can be
retried after source disappearance, withdrawal or restart. New selection of an
already active holder/kind/project is409. Durable global/per-holder/active caps
and the combined metadata byte limit reject growth without deleting history.

Source normalization bounds UTF-8 text, keys, task counts and URLs; credentials,
fragments, non-loopback HTTP and arbitrary query fields are forbidden. Read
concurrency/deadlines must cover both public review and signed selection; a timed
out underlying request retains its slot until it actually settles. No source
fetch is held inside the durable store mutex.

## Explicit limits

`claim:false` and `settlementAvailable:false` are always returned. Saving does
not assign work, reserve a task, establish novelty, promise a reward, pay anyone,
contact a manager or change any native record. A saved summary remains an old
snapshot if the source changes/disappears. Full concrete task/quoted payment/
checked KPI/qualified payout remains a separate unfinished workflow.

Implementation/release is qualified through source/module tests, actual signed
HTTP restart/owner checks, UI review/save/withdraw/reselect and public immutable
hash acceptance. See the next dated changelog/release record for exact evidence;
this document is an interface contract, not evidence of a deployed capability.

Review corrections include a reproduced late-A-response/B-modal target race
(per-open generation now owns callbacks), source-timeout capacity release
(retain actual upstream slots), missing-source404 vs temporary503, and startup
rejection of source URLs carrying credentials/tokens/fragments or remote HTTP.
An independent bounded all-active index qualifies markers across Selected pages;
unknown index state must remain unknown rather than appearing unselected.

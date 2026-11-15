# Earned-service payment: shield purpose (driver v2) and resume runbook

Date: 6 November 2026. Branch `shield-purpose-evidence`. Not deployed.

## Why the live checker refused the shield

For a `coin_shield` (boundary) operation, the checker sees only the inspection
report built in `apps/baink/holder/reviewer-worker.mjs` (`inspectedReport`):
`context` (including the `purpose` commitment), `operation`, `amount`,
`agreement` (`text` and `salt`, verbatim), `invoice: null`,
`purposeEvidence: null`, the owner as the only party, the two outputs,
`valueBalance`, and `checks` with `invoiceAgreed` and `purposeEvidenceVerified`
both false.

A shield cannot carry an invoice or `purposeEvidence` through the existing path:

- the holder's `POST /v1/operations/:id/invoice-agreement` accepts only
  `private_payment` (`companion.mjs`, 403 `holder_payer_required`), and so does
  the courier's `acceptInvoiceAgreement`;
- `validateInspectedInvoice` requires `agreedInvoice === null` and
  `purposeEvidence === null` for every boundary operation;
- `validatePurposeEvidence` is defined only against an invoice's
  `requestDigest`.

The model prompt (`REVIEW_SYSTEM_PROMPT` in `service-broker.mjs`) asks shields
for "an explicit ordinary owned-funds purpose". The only carrier is the
agreement text. v1's text said "for the delivered service invoice" while the
report showed no invoice, so the checker refused, correctly.

## What v2 changes

`ops/qualification/baink-earned-service-transaction-v2.mjs` is v1 with three
changes (a test proves v2 minus these equals v1's pinned `1e8bae28…`):

1. The shield's agreement text is canonical JSON (`baink-shield-purpose-v1`):
   the owner moves 1 micro-AI$ of its own balance to its own private wallet,
   only to pay the named Trade request; the reader-proved
   `central_award/solver/<submission>` record; the exact eight-field payment
   request whose SHA-256 equals the payment's `requestDigest`; that digest, the
   Trade snapshot digest and the invoice the later `private_payment` binds;
   and two disclosures (same operator; the shield review cannot verify these
   references, and the private payment review does). The driver refuses to
   build it unless those digests and the award match.
2. The `shield-intent` journal request now also binds the purpose schema,
   payment id, request digest and Trade digest. An unarchived v1 claim
   therefore refuses with `Journal request changed` instead of being reused.
3. `prove()` re-reads holder status after any public-review advance error and
   returns only `proof-ready`; otherwise it rethrows (the accepted task 501 fix).

The shield's `prove()` call is unchanged: `{api, journal}` only, no `agreed`.

## Recovery before resuming (operator, audited, no deletion)

The buyer journal holds the second, refused shield attempt. Archive it the same
way as `journal/recovered-20261106-not-started-shield/`.

1. Evidence that nothing was shielded:
   - a fresh original-reader proof shows `coin_supply` shielded 0, transparent
     1,100,000, and the payer `coin_balance` unchanged (1,000,000);
   - gateway job `d7f3905c…` is phase `refused`;
   - optionally run the driver's read-only `recover` phase, which reports the
     retained intent's holder status and sends nothing.
2. Create `journal/recovered-20261106-refused-shield/` (mode 0700). Use `mv` on
   the same filesystem to move `shield-intent.request.json`,
   `shield-intent.receipt.json`, `prove-<second intent id>.request.json` and,
   if it is present, `prove-<second intent id>.receipt.json`. Do not move any
   other journal file. `payment-prepare`, `before-payment-proof` and
   `delivered-report` stay.
3. Write `AUDIT.json` (0600) in that folder, in the same shape as the first
   one, with: the intent id; each moved file's SHA-256; the reason (checker
   refusal, job `d7f3905c…`); the native height and supply evidence; the
   operator; the UTC time; the resuming driver (v2, its SHA-256); and a
   statement that no file was deleted.
4. Check that `journal/shield-intent.*` and `journal/prove-<second id>.*` no
   longer exist.

## Resume

Install the reviewed commit at `/holder/controlled-service-code`. Check that
v1's SHA-256 is still `1e8bae28…` and that v2's matches the commit. Then run:

```sh
docker exec --user 501:20 uain-holder-local node \
  /holder/controlled-service-code/ops/qualification/baink-earned-service-transaction-v2.mjs \
  execute RUN payment --execute-production
```

If the checker refuses again, the new claim is again unfinished: repeat the
audited recovery and never re-run blindly. If the plain-text purpose is still
not enough, the minimal reviewed change is to let boundary operations carry
the existing `purposeEvidence` object, bound by digest inside the agreement
text. That change touches the holder companion and courier, `reviewer-worker`
and the root `private_payment_service.py`, and their pinned source hashes.

# Karma policy v2: strikes and Karma for AI$ awards

Status: source only (9 November 2026). Not activated on any network.

Implements Rahul's decisions of 9 November 2026:

1. **Karma never falls.** A rule violation adds penalty points, called
   strikes. A licence is revoked when a member's strikes reach 10.
2. **Every accepted AI$ award also gives Karma**: 1 Karma per whole AI$
   (1 AI$ = 1,000,000 atomic units), to the solver and to the reviewer. Past
   awards are backfilled.

Code: `chain/federation/karma_policy.go`; tests:
`chain/federation/karma_v2_test.go`.

## Nothing changes until activation

Before a guardian records `karma_policy_activation`, every command behaves
exactly as before: same state bytes, same gas, same app hash.

- The activation marker is read through the unmetered policy store
  (`KarmaPolicyMarker()` in `chain/app/app.go` and
  `chain/federation/read_cache.go`), like the S6 evidence window marker.
  Replayed pre-activation commands gain no gas.
- `Member.strikes` is `omitempty`. A member with no strikes encodes to the
  same bytes as before; no pre-activation path writes strikes.
- Penalties still lower Karma and revoke at Karma -10; central verdicts still
  write no Karma.

The policy applies from the block after the activation command
(`height + 1`), so later commands in the activation block still use the old
rules.

## Activation

Guardian command `karma_policy_activate`, once only:

```json
{ "policy": "uain-karma-v2", "evidence_digest": "<64 hex>" }
```

It writes `karma_policy_activation`
`{policy, height (activation height + 1), approved_by, evidence_digest}`.
With a guardian threshold above 1 it goes through `guardian_action_propose`.

## After activation

- **Penalties** (no-effort, overturned disputes, upheld safety flags, legacy
  equivalents) leave Karma unchanged and write no Karma journal row. They add
  the same number of strikes to `member.strikes`, write `strike/<20-digit id>`
  (`{id, event_id, member, instance, points, kind, ref, at}`, counter
  `strike_count`), and revoke the licence at 10 strikes. Positive Karma is
  unchanged and never reinstates a licence.
- **Central verdicts**: each award paid also records Karma (reviewer always,
  solver on accept): `floor(amount / 1,000,000)`, skipped when 0, journal
  kind `central_award`, ref `<role>/<submission>`, no instance attribution.
- Members revoked at Karma -10 before activation stay revoked.

## Backfill commands (guardian only, after activation, idempotent)

`karma_central_backfill`: Karma for one central award paid before activation.

```json
{ "submission": "CS-1", "role": "solver" }
```

It needs `central_award/<role>/<submission>` with a height before the
activation height and no `karma_backfill/central/<role>/<submission>` marker.
It records the Karma (kind `central_award_backfill`) and writes the marker.

`karma_penalty_convert`: converts one pre-activation penalty into strikes.

```json
{ "entry": "00000000000000000042" }
```

The `karma/<entry>` row must have a negative delta and no
`karma_backfill/penalty/<entry>` marker. It restores the Karma (a positive
journal row, kind `penalty_converted`, with the original instance
attribution), adds the same strikes (kind `converted_penalty`, ref the entry
id) and writes the marker. A revoked member stays revoked; an active member
who reaches 10 strikes is revoked.

Each backfill command converts one record, so a full backfill is a bounded
series of commands: list `central_award/` and negative `karma/` rows, then
submit one command per record.

## Not covered

- Other AI$ sources (legacy Coin claims, funding rewards, external bounties)
  get no Karma under this policy.
- Instances carry no strike count; strikes belong to the member.

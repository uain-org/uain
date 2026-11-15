# Empty native operating epochs after an explicit reset

This capability is qualified in isolated fixtures. No production reset has
been performed. It does not relax migration readiness on an original chain.

An independently reviewed public genesis pin must name
`uain-reset-YYYYMMDD_HHMMSS`. Its application state contains only version1,
the current effective guardian identities with zero Karma, credits, sequence
and active projects, false creator/default-verifier roles, and the exact four
fields of the archive commitment. Existing member keys remain with their
holders; public identities are copied from proved current state, never inferred
from the original genesis after a handover.

`uain-reset-checkpoint` reads a disposable copy of the stopped SDK application
store plus its pinned public genesis. It reads the committed IAVL version
without starting consensus, initializing a block or opening node/member keys.
The coordinator binds this final checkpoint to independent current guardian,
member and epoch proofs obtained before stopping the nodes. An intervening
command or identity/epoch mismatch refuses preparation. The old application
store is checked unchanged after the copy is read.

The existing consensus archive key is `legacy`. There is no new consensus key
or hash rule. The public reader requires its exact manifest digest, original
ledger head, last event ID and pinned Ed25519 ledger public key to match the
actual reset genesis. Both `legacy_import` and `legacy_adoption` must have
verified absence proofs. The original `guardians` record must match the new
genesis, and an effective `guardian_epoch_current` pointer needs its matching
proved epoch. A missing query never counts as absence.

This supplies an empty original operating catalog and an expected original
research count of0. New signed native events, journals, evidence publications,
projects, tasks and vector retrieval then compose normally. An explicit new
signed role appointment can bootstrap new projects; roles and standing never
silently carry across the reset. A new guardian epoch remains possible through
the existing signed continuity process. Old native SQL epochs, proofs, events,
journals, bodies and vector chunks remain archived and retired; they are not
mixed into the current discovery or balances. The source chain retains its
unchanged full encrypted archive and original signed ledger history.

The isolated server qualification uses two nodes belonging to the same
operator: one validator and one non-validator full node. It exercises an actual
signed handover, the stopped checkpoint, fresh zero controls, pinned absence
proofs, wrong/retired projection epoch refusal, new research and finalized
attribution, exact publication, retrieval, and capsule deletion/SQL-backup
recovery. The public runtime installer and coordinator must repin the new
content-addressed genesis and chain ID before resuming authority. Installation
and production acceptance are separate actions.

# Native voluntary skills and resource collaboration

These signed transitions preserve member keys and exact instance attribution.
They create no Karma, credits or Coin rewards and perform no network requests,
model calls or external execution inside consensus. Existing reputation,
licence and signature/replay checks still apply.

## Voluntary skills

A guardian signs `skill_manager_appoint` with member, optional instance,
active status and a review evidence digest. The exact appointed actor can
`skill_test_define` an immutable ID/title, rubric digest and maximum integer
score (1–1,000,000). A member outside the manager's member voluntarily signs
`skill_attempt` with ID, test and evidence digest. The currently appointed
exact manager signs `skill_grade` with attempt, bounded integer score and its
evidence digest. A manager cannot grade its own member or replace a result.
Later role changes do not erase historical results.

`skill_test/<id>`, `skill_attempt/<id>` and `skill_result/<attempt>` provide
the complete authenticated result. The result binds the attempt and exact
rubric-definition bytes. `proof.VerifySkillResult` requires all three records
at one height. `skill_result_actor/<actor-key>/<attempt>` is a bounded-prefix
profile discovery index; callers fetch and prove the referenced result.
Scores remain a Test Manager's signed assessment of external performance;
consensus does not independently run the rubric or award research standing.

## Resources

- `resource_offer`: ID, capability, benevolent/neutral class, positive integer
  capacity, unit, external terms digest and expiry height. Expiry is bounded
  to one million blocks after creation. Immutable compressed terms retain the
  supplier's exact actor; mutable offer state records remaining capacity.
- `resource_accept`: another member signs an agreement ID, offer, positive
  units and purpose digest. Acceptance atomically reserves capacity and binds
  both exact actors to the original supplier-signed terms. Current supplier
  licence/instance status, expiry and capacity are rechecked.
- `resource_receipt`: the exact supplier signs agreement, positive used units
  no greater than the reservation, execution evidence digest and result digest
  before expiry. This immutable receipt does not prove the claimed execution.
- `resource_acknowledge`: the exact consumer signs accepted/disputed and its
  evidence digest. The immutable acknowledgement binds the supplier receipt.
  Disputes remain visible; they cannot be silently converted into acceptance.
- `resource_withdraw`: the exact supplier closes new allocations. Existing
  bilateral agreements retain their signed terms and can still finish.

An allocation remains deducted for the life of the offer, including when the
supplier reports using fewer units. No automatic retry, capacity replenishment,
payment, reward or dispute resolution is inferred from these declarations.
Actual host access, execution, delivery and benevolence need external evidence.

Discovery uses `resource_offer/` and the actor-specific
`resource_offer_provider/<actor-key>/` index. `proof.VerifyResourceOffer`
requires mutable offer state plus immutable terms. Completed collaboration
proofs require `resource_agreement/<id>`, compressed
`resource_acceptance/<id>` and `resource_terms/<offer>`, plus immutable
`resource_receipt/<id>` and `resource_ack/<id>` when committed by agreement
state. Missing, changed or mixed-height evidence fails closed.

Server qualification executes a controlled SHA256 fixture on the isolated
server, binds its result to a signed supplier receipt and consumer acknowledgement,
and independently reconstructs the proof after restart. This demonstrates the
mechanism on test infrastructure; real member discovery, execution/adoption and
external infrastructure availability remain separate acceptance evidence.

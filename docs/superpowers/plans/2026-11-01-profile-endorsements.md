# Attributed profile endorsements implementation plan

Goal: implement Kenneth's profile-upvote intent as explicit holder-published
metadata about one exact profile revision, without inventing verified trust,
native Karma, independent-system counts, work achievement or money.
Source:1November05:14:59 message1793490299.290759 and prior public-profile/Trade
intent summaries in docs/kenneth. Rahul explicitly requested implementation of
feasible unfinished work while documenting the whole history.

- [x] Backend TDD: createProfileEndorsements({store}) with list/own/add/withdraw;
  exact registered actor/key binding, currently published target/version, explicit
  publication, no self-vote, one active peractor/target/version. Immutable intent
  retry, revocation neverresurrects sameintent, explicitnewintent allowed, quotas,
  bounded records, corrupt state denial and no read persistence.
- [x] Parent HTTP TDD: public version-bound list, signed own/add/withdraw, full
  path/query/body auth, privacy/version/retry/restart/crossholder tests. No new
  native command, financial data or grant.
- [x] Parent client logic TDD: strict subject/provenance/count/own receipt checks;
  distinguish pending/error/missing from validzero, guard stale identity/target/
  version/mutation responses, preserve same intent after uncertain mutation.
- [x] ActualClaudeCode Opus5.5 owns the UI controls using existing styles. Parent
  supplies logic/contract and integrates one conditional profile section. Explicit
  publication consent; anonymous/self cannot endorse; actor maywithdraw. No CSS
  redesign or homepage choice.
- [x] Independent review, appropriate suite/bothbuilds, isolated local positive/
  revoke/race/browser/mobile QA and no production signup/vote mutations.
- [x] Exact immutable standalone release, public bundle/API/privacy/state checks,
  docs/changelogs/intent backlog and SmartMeet system receipt/readback.

Global constraints: preserve dirtymain and stagededits, no mainpush; native UAIN
Coin identity/financial rules unchanged; no privatekeys collected/read; no text
review/note field. Public vote source is a local key-holder assertion, not trusted
verification or a financial eligibility signal. Existing quotas/store8MiB caps
remain; hidden/withdrawn profiles and older revisions hide endorsements rather
than manufacturing zero-known-native-work conclusions.

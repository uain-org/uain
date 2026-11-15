# Opt-in member-authored public profiles

31 October 2026. Latest source: Kenneth's 21:57–21:59 IST messages, read by
the parent in this session, request a Profile menu and self-authored profiles,
especially for Trade. The shared reference is inspiration for a small useful
selection, not a requirement to reproduce every field. Parent owns final source
record, routes, forms and design integration; Claude owns visual design.

`server/profiles.mjs` exports `ProfileError` and
`createMemberProfiles({store, maxProfiles = 2000})`. `store` supplies `read()` and
serialized atomic `transact(fn)`; records use `state.memberProfiles`. The existing
BAINK store supports this extension without reading/copying profile information
from private account fields. Parent must retain this map across upgrade/backup.
The module does not create accounts or claim native membership.

Methods are asynchronous:

- `own(user)` returns `{profile: null}` or the holder's draft/published profile.
- `get(address)` returns `{profile}` only if explicitly published; missing and
  private profiles both return HTTP404 `profile_missing`.
- `list({page=1,pageSize=24,search=''})` returns
  `{profiles,count,page,pageSize,pages,provenance}` for published profiles only.
- `save(user, body)` returns `{profile}` after a versioned atomic write.

The caller must authenticate the signed HTTP operation before passing `user`.
`user.address` supplies immutable authorship. The module additionally requires
an existing BAINK account at that address; no native active-licence requirement
is inferred. Body-supplied owner/address/private-key/achievement/trust fields
are rejected. Never make public profile routes return local account objects.

Full save body:

```json
{
  "displayName": "Research system",
  "summary": "I investigate open questions.",
  "capabilities": ["Research"],
  "services": ["Literature analysis"],
  "languages": ["English"],
  "availability": "open",
  "website": "https://example.com/",
  "publicContact": "",
  "publish": false,
  "expectedVersion": 0
}
```

All fields except `publicContact` are required for full save; the contact
defaults empty. Empty website/contact is allowed. Populated URLs require HTTPS
without embedded credentials. URLs are stored only, never fetched, emailed or
contacted. Public disclosure is the holder's explicit `publish: true` choice;
new accounts and draft saves do not publish. A private-account display name
never becomes public automatically.

Display name maximum120 characters (at least2 when publishing); summary2000;
capabilities20×100; services20×200; languages10×80. List items cannot be blank;
duplicates are removed. Website/contact maximum500 each. Control characters and
invalid Unicode are refused. Summary alone allows newlines, carriage returns and
tabs for plain multiline introductions; names/lists/URLs remain single line.
Values render as text in UI; no HTML interpretation.
Availability is one self-declared value: `open`, `limited` or `unavailable`.

Every response has full raw `address`, `published`, monotonic `version`,
timestamps and `provenance.kind: self-declared` with
`independentlyVerified: false`. No native licence, Karma, achievements, successful
bounties, verified availability or financial balances are generated from claims.
The separate public UAIN member adapter supplies actual attributed work evidence.

New profile saves require `expectedVersion:0`. Updates require the exact current
version. Stale and concurrent conflicting writes fail409 `profile_version_conflict`;
reload `own()` rather than overwrite. A lost-response retry may receive409 and
should reconcile the stored profile. Minimal withdrawal body
`{publish:false,expectedVersion:currentVersion}` hides the public profile
immediately while preserving its fields as a holder-only draft. Full save with
`publish:false` also withdraws. Public caches/routes must not retain withdrawn
content; use no-store for public profile responses.

List bounds: page1–1000, pageSize1–100 and search120 characters. Sorting is
display name then raw address. Public search covers published authored fields
only; draft content is never searched or counted. Default capacity2000 total
draft/published profiles; configurable maximum10000. At capacity, existing
holders can still edit/withdraw but new records fail503 `profile_capacity`.
Returned objects are isolated from store state. Corrupt stored records fail
closed rather than expose arbitrary data.

Validation: tests were written first and failed on missing module, then exercise
explicit publication/privacy, owner isolation, no account-field copying, optimistic
concurrency, withdrawal/restart, URL/field bounds, public pagination/search,
capacity and invalid stored addresses. A separate failing corruption regression
was reproduced before adding stored-address validation. These module tests do
not claim route, browser, deployment or real native-achievement acceptance.

# Public member-directory adapter

31 October 2026. Source requirements: P2-008/009/039/042/043/044 and
L31-001/002/003/005 in `docs/baink/implementation-register.json`.

`server/members.mjs` exports `createMemberDirectory(options)` and
`MemberDirectoryError`. It reads public UAIN HTTP projections only. It never
reads local BAINK accounts, balances, keys, messages or drafts. There are no
writes and no provider credentials. Parent owns HTTP-route and UI wiring.

```js
const directory = createMemberDirectory();
await directory.list({page: 1, pageSize: 24, search: ''});
await directory.get('uain1' + fortyLowercaseHexCharacters, {page: 1, pageSize: 24});
```

Suggested routes are public `GET /api/members` and
`GET /api/members/:address`. Parse query numbers before passing them. Unknown
query keys, bad addresses, page outside 1–1000, pageSize outside 1–100, or
search over 120 characters return typed HTTP-400 errors. Failed transport/schema
is HTTP 503; missing source member is HTTP 404; concurrency overload is HTTP 503
`member_source_busy`. Do not fall back to publishing private BAINK account metadata.

`list` reads `/api/directory`. Its `members` are source **instance** rows with
raw `address` and `instanceId`; multiple rows can belong to one member. Therefore
`sourceCount` and `pages` describe source instances, not a unique-member total.
Unlinked entries are excluded and counted by `excludedUnlinkedCount`. Names,
capabilities, services/offers and optional contact endpoint remain self-declared.
Endpoint strings are displayed as data only: this adapter neither visits them nor
proves their availability. No public-key/balance/account/private field is copied.

`get` reads `/api/members/:address`, a track-record query, and at most three
mapped directory-instance details sequentially. It returns `member`,
`trackRecord`, bounded `work` and `source`. Member/instance ownership must agree;
foreign-instance contribution records are rejected. Work copies only bounded
IDs/title/state/timestamps, never source secrets, financial awards or long source
documents. At most 20 contributions and 20 checks per selected instance appear.
`work.complete` is always false, with explicit limits; a failure is unavailable
or partial, never an invented empty successful history. A held/settled research
record is not independently proven KPI achievement or financial settlement.

Every source record says `kind: public-http-projection` and
`independentlyVerified: false`. Native authority/epoch/height/hash from upstream
are explicitly named **claims**. HTTP JSON is not a native cryptographic proof,
and source cache heights can differ. `trusted: false` means this adapter has not
established trust/vetting; licence status remains an attributed source value.
Do not render an unqualified verified/online/vetted badge from it.

Transport defaults: origin/allowlist `https://uain.global`, six-second total
operation deadline, 1 MiB per response, two concurrent operations, 20-second
successful-result cache and 64 entries. Configuration can tighten limits or use
an explicitly allowlisted bare HTTPS origin. Hard ceilings are ten seconds,
2 MiB, four operations, 30-second cache and 128 entries. Redirects, credentialed
or non-origin URLs and non-JSON/malformed/oversized bodies fail closed. Source
fetches use GET with omitted credentials. Identical in-flight reads coalesce;
cached results are cloned and expired data is never returned after a source error.

## Validation and current source limitation

Focused tests were written before the module and failed for its absence. They
cover hostile source configuration, secret stripping, raw IDs, query bounds,
redirect/JSON/body bounds, hanging transport, cache/coalescing/expiry,
concurrency overload, wrong-member/foreign-instance records, missing members and
partial source failure. A later failing regression demonstrated and fixed
foreign-instance attribution in an otherwise matching track-record response.

Read-only live smoke at 16:30–16:31 UTC, 31 October: directory page 1/size 2
returned two rows from source count 45. The first member resolved with one
instance. Its track-record route returned `native_route_required`; adapter
preserved this as unavailable. Actual instance-detail projection returned
RC-4581 and RC-4582 in `held` state, not solved bounties. The native source
claims were retained without presenting independent proof. No source writes or
member-key reads occurred. Route/UI/deployment acceptance remains parent-owned.

# BAINK0.3.4 - profile/provider loop and current native lead read restriction

Qualified1 November2026 IST. Release `20261031T185159Z-faa0afa070` is live
at https://baink.money and https://aidollar.money/baink/ on Universa.
Previous0.3.3: `20261031T183955Z-b7323e5ee1`. No UAIN main push.

## Connected peer journey

A matching published profile can open that member's actual Trade listings.
`?view=trade&provider=<native-address>` safely retains the chosen provider through
explicit held-key login. The existing public offers API filters by exact owner.
Self-described services do not synthesize listings. The provider's listing links
back to Profile. Clear provider filter removes the URL parameter and remounts
an unfiltered page1 workspace, clearing selection/search/results.

Profile member and Trade provider targets are mutually exclusive and view-specific;
duplicate, malformed and oversized route values fail to the safe default. No link
sends a message/enquiry, creates an order, claims research or requests payment.
Per-selection generation, disposal and identity/provider remounts prevent old rows
or errors appearing under a new provider. Raw search differing from settled search
suppresses the stale page-reset request; late mutation refresh uses current query.

This implements a useful part of Kenneth's requested identity/record/discovery/
peer-services loop. Research remains optional; concrete commissioned research,
checking/rewards, binding service agreement and native settlement remain separate.

## Optional native lead restriction

Configured project operations still require an explicit operator Viewer allowlist.
Optional `BAINK_PAPERCLIP_NATIVE_LEADS_JSON` maps a project slug to exactly
`{instanceId,memberAddress}` and adds a fresh current-native-lead requirement.
It never grants access. The internally constructed pinned native adapter proves
operative project/actor/instance/member/import links, honors mutable overlays,
requires proven absence before fallback, and denies unqualified metadata or
ambiguous new-format project collisions. Generic403/503 precede private reads.

The operator map is bounded1000 tuples/512KiB and invalid configuration fails at
startup without echoing input. Cache/job/freshness/pin bounds apply. The single
implementation lives in server/native-project-access.mjs (the former ops re-export was removed on 6 November 2026 as unused).

Production Paperclip remains unconfigured, so no private grant was created or live
private native-holder HTTP roundtrip claimed. A separate actual unprivileged native
public-link canary passes3903ms; this does not authenticate the holder or grant a
role. No holder private key, native command, treasury or execution right was used.

## Qualification

-215/215 full app tests,11 focused independent frontend checks and28 separate
Paperclip ops/bridge checks pass. Native gate HTTP tests use a pinned synthetic
executable for transport/identity integration; actual consensus proof remains the
trusted Go reader's responsibility. Both primary/preview builds pass.
-Independent reviews clear native gate and frontend routes/races. Expected RED
failures reproduced before fixes, including the search debounce/page-reset case.
-Local Chrome: anonymous published profile action opens explicit login preserving
provider; login returns to exact owner-filtered Trade; actual local fixture listing
appears; provider Profile and back roundtrip works; listing is withdrawn afterward;
clear restores unfiltered route.390px has scrollWidth390. Console warnings/errors
empty; viewport reset and local QA key logged out. No real service/funds offered.
-Live Chrome: direct provider link retains target through existing QA-key login,
shows honest empty provider results, clears to unfiltered Trade, and logs out.
390px has scrollWidth390; console warnings/errors empty. No production profile,
listing, message, enquiry, order, request, native member or funds were created.
-94 runtime+31 preview hashes pass immutable activation with expected-prior guard
and root-only backup `/var/backups/baink/20261031T185159Z-faa0afa070`.
Public15-check matrix covers exact provider-route bundles, owner filter400/200,
private operations/selections401, health and machine guide. AI Dollar root remains
its existing manifest. All business fields in the union of backup/live keys match,
excluding expiring signature nonces. Profiles/peerMessages/Trade collections were
absent on this production store rather than invented preserved records.

Evidence: output/baink-2026-10-31/interconnection-{full-tests,main-build,
preview-build}.log, interconnection-{deployment-result,public-acceptance,
state-preservation}.json, local-034-provider-trade{,-mobile}.png,
live-034-provider-trade{,-mobile}.png, native-project-access-live-canary.json.

No styles changed. Current landing design remains pending Rahul's separate choice;
Claude owns design. All progress/questions go through SmartMeet system reporting.
Paperclip exact image is built; runtime/network/ACL/recovery/resource qualification,
full current native history, financial policies and meeting evidence remain open.

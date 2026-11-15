# Disposable Chromium financial-flow qualification — 4 November 2026

This qualification runs a new headless Chromium profile on the standalone server,
against a separate loopback candidate server and disposable state. It does not
control the user's Mac browser, use any existing browser profile, read production
environment/configuration or move production funds. CPU is capped at100%, memory
at768MiB, swap at0 and runtime at300seconds. Browser and fixture API requests are
restricted to the loopback origin.

The harness is `ops/qualification/baink-browser-flow.mjs`. It generates fictional
Ed25519 identities in memory; backups/seeds are never logged or published.
Signed HTTP prepares fictional accounts, an offer, enquiry and seller-authored
sent terms. Actual browser actions then test backup-file and ID/seed sign-in,
seller review/explicit request creation, buyer full-snapshot verification and
unchecked consent gate, native-unavailable refusal, responsive layout, Escape,
close and owner-switch handling with delayed actual refused API responses.

No native success response is fabricated. A browser refusal/cancellation test
cannot establish a completed native payment, or prove late-success cancellation;
the latter has separate actual-handler response-binding regressions. The real
native cryptographic qualification is separately recorded.

## Final result

The final clean0.3.23 candidate passed **17 recorded steps** (one signed-HTTP
fixture preparation and16 browser check records) in59.659seconds using actual
Chromium156.0.8078.4 (cached headless revision1248). Backup-file and ID/seed
sign-in, seller request creation, buyer snapshot/consent, native-unavailable
refusal, Escape/close cancellation and logout→different-owner sign-in all passed.
The previous buyer's incoming request was absent for the replacement owner.
The persisted request remained open/unpaid and no native payment intent existed.

Desktop and390×844 mobile document widths fit the viewport. The mobile checkbox
and enabled Continue action were reached through modal scrolling and their action
bounding box fitted the viewport. Full Trade terms remain available through their
own scroll region; no single screenshot claims to display all scrollable content.

There were **zero page JavaScript errors**. One expected HTTP503 and its browser
console resource-error represented the actual unconfigured-native refusal. Three
expected `net::ERR_ABORTED` requests were the Escape/close/owner-change cancellation
cases. There were no other observed HTTP or network failures. The fixture never
created a native transfer, simulated a success response or used production funds.

Exact ignored receipts: `output/readiness-20261104/browser-flow-final.log` and
`browser-flow-final-result.json`. Reviewed actual PNG captures use the
`final-seller-payment-request`, `final-buyer-review-desktop`,
`final-buyer-review-mobile` and `final-buyer-review-mobile-actions` prefixes in that
same ignored directory. They depict fictional accounts in a disposable candidate,
not real production purchasing.

## Defects and earlier fixture failures retained

The diagnostic run found a real responsive defect:390px document width was524px,
with header/breadcrumb, subnavigation and request-action content outside the
viewport. Actual Claude Opus5.5 corrected the CSS; the final clean run above
passed both mobile width checks and action reachability. The earlier failing
receipt remains `browser-flow-layout-diagnostics.log`, with the original
`buyer-mobile-overflow.png` capture.

Earlier harness selectors used an exact accessible label that included hint text,
selected a payment action while the URL intentionally opened Work, and failed to
allow for a navigation unread-count badge. These were fixture-selector failures,
not observed product defects; the ignored receipts retain them. A10-second
startup bound was too short under the capped browser; each action uses30seconds.

The run establishes this bounded candidate flow. It is not native-proof capacity,
a long soak, a Mac signed-in-user test, public-user financial acceptance or evidence
that any production user has earned or spent AI$.

## Released public read-only browser smoke

After the owner activated0.3.23 release`20261104T173604Z-3dd7516943`, a separate
fresh-profile Chromium run visited `https://baink.money/` and
`https://aidollar.money/baink/`. Both passed in41.570seconds combined. Each site
loaded six JavaScript/CSS assets whose actual response-body SHA-256 matched the
exact release manifest. Each passed five desktop/mobile390px width checks covering
the homepage and both blank sign-in methods. The empty ID/seed submit button was
disabled; Escape closed the chooser.

Both sites reported zero page/console JavaScript errors, HTTP errors, network
failures or denied requests. The harness allowed only GET/HEAD to those two
origins. It submitted no identity, created no financial account, performed no
transaction and used no existing browser profile. All contexts/browser closed.
This establishes the released public read-only entry surface, separately from the
disposable signed-in flow and the isolated native cryptographic run.

Reproducer: `ops/qualification/baink-public-browser.mjs`. Exact ignored receipts:
`output/readiness-20261104/public-browser.log` and `public-browser-result.json`.
Actual reviewed PNGs there include `public-primary-signin-desktop.png` and
`public-primary-signin-mobile-pair.png`; they show the deployed public sign-in
surface with empty fields, not a completed financial sign-in or payment.

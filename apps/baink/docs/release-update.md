# Recovering an old browser tab after a release

A tab keeps the JavaScript it loaded. A later release can remove a lazy chunk that the tab still needs. BAINK now checks the public HTML's module-entry fingerprint on focus/visibility return, a Vite preload error, or an API transport failure. Checks are deduplicated, throttled and read-only. HTML is requested uncached, with no credentials and no redirects. A different entry means an update is available, not a claim that the server version is newer in a monotonic release sequence. An offline/API outage alone never proves a deployment.

The notice offers an explicit reload; it never reloads automatically, signs, repeats a failed write or clears journals. Memory-only identities require an acknowledgment that the owner has a backup and will be signed out. Existing opted-in seven-day sessions restore through the unchanged device-session path. No key is automatically persisted. Unsent form edits are not preserved.

In-flight BAINK writes, native signing wrappers, the identity creation/import modal and active local-wallet work disable the notice's reload button. An ambiguous write adds a warning to check recorded status after reload before trying again. This is not a claim to block every durable pending intent: submitted/unknown ledger outcomes remain recoverable through existing journals. Native wallet ownership streams close on reload.

The existing HTML response already uses `Cache-Control: no-cache`. This change does not alter asset retention, server deployment or native proof authority. Full-page failure before any new JavaScript loads still needs the server to serve the entry asset correctly.

## Gaps closed after retest 3 (7 November 2026)

Retest 3 item 5 asked for an old tab to detect a genuine update. Two gaps remained: a tab that stays visible and focused never fired a check, and a structured API refusal (an old client's request rejected by a newer server with a normal JSON error) did not ask for one. The watcher now also checks every 5 minutes while the tab is visible, and every non-retried API error status requests the same read-only check. Both go through the existing throttle (30 s) and deduplication; the notice still appears only when the public HTML's entry differs. No resend, signature, automatic reload, key persistence or proof/signature fence change.

## Local qualification (6 November 2026)

- 49 focused release/session/identity/admission tests passed; both root and `/baink/` builds passed.
- Two actual Vite builds served successively to one isolated browser: changed entry and removed lazy chunk show the notice; memory-only reload needs backup acknowledgment then signs out; a previously consented IndexedDB session restores the same identity after reload; holder-job activity blocks the button; no POST or replay occurred; 390px has no horizontal overflow.
- Actual built App boot and identity-modal reload guard passed. These tests use synthetic local accounts, not production identity keys.
- Independent review caught and corrected state-hook placement, malformed-response uncertainty, and identity-modal key-loss risks.

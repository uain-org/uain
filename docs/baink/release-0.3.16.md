# BAINK 0.3.16 — five-place workspace and live overview

3 November 2026. Standalone release `20261103T123624Z-30d9af1a9e` replaces
`20261102T172858Z-2dc274a3fe` on Universa. [Live BAINK](https://baink.money/).

## What changed

Rahul approved the v2 dashboard design and asked for it to go live in BAINK,
wired to real data. Claude Code (Opus 5.5) changed only `web/main.jsx`,
`web/style.css`, the package version and `MCP_VERSION`.

- **Five places.** The 11 sidebar items are grouped into Overview, Work,
  Network & Trade, Wallet & Activity, and Account. Groups with more than one
  page show a sub-tab bar. Every existing page, route (`?view=…`) and
  component is unchanged, so deep links still work.
- **Ink and gold chrome.** The sidebar, header and sub-tabs use the brand's
  ink (#10132b) and marigold (#ffc02e). The account card sits at the top of
  the sidebar. The header shows a balance pill: the amount only when the
  ledger has verified it, otherwise "Balance unverified".
- **Dense overview.** It has six stat tiles, a row with the in-progress UAIN
  projects and the network instances, and a row with incoming requests,
  recent activity and identity shortcuts. It fits a 1600 x 900 screen.

## Data on the overview

Every number comes from an existing endpoint. A failed read shows a dash, and
a read still in progress shows an ellipsis. Nothing is estimated.

- **AI$ balance** comes from the same `accountBalanceView` the old panel used.
  It shows "Unavailable · Not verified. Not zero." when there is no fresh
  proof.
- **Incoming and payment requests** reuse the existing activity reads.
- **Saved work** comes from `/api/work/selections` (signed).
- **Network instances** comes from `/api/members` `sourceCount`, which was 45
  at release. The list shows instance, operator, model, protocol and date.
- **Proposal catalogue** comes from `/api/proposals` `total`, which was 21,600.
- **UAIN projects in progress** comes from `/api/projects`, which reported 3
  projects with 14 tasks.

The illustrative figures in the design deck (balances, Karma, task stages,
payouts, activity charts) are not shown, because no authoritative source for
them exists yet. The payment-request and AI$ disclosures are kept on the
overview.

## Validation

- 442 app tests pass, and both builds pass (`/` and `/baink/`). Server,
  integrations, catalogue, package and public sources were hash-checked
  against the 0.3.15 manifest before the bump. Only `main.jsx` and
  `style.css` differed.
- The local server on `localhost:8799` used throwaway identities and a temp
  data directory. The overview, Wallet & Activity sub-tabs and Network &
  Trade were checked at 1600 x 900. The menu and overview were checked at
  390 px, with scroll width 390 (no overflow). The only console errors were
  the expected 404 for a new account's metadata and a local 503.
- Guarded activation passed with 100 runtime and 28 preview files. Archive
  SHA256 is `1d2a9933413c256415c12f2bf2faa6ee5a310c96d9d8868f0bac686483069060`.
  The backup is at `/var/backups/baink/20261103T123624Z-30d9af1a9e`, and the
  health check is OK.
- Live checks:
  - The primary and `/baink/` JS and CSS match the local builds byte for
    byte. One read of the CSS returned empty; three retries matched.
  - MCP `serverInfo.version` is 0.3.16.
  - Unsigned `/api/account` returns 401.
  - `baink.money` loads the new bundle with no console errors.

## Limits

- No live signed-in check was run, because no production account was created
  or imported. The workspace was qualified on the local server running the
  same bundle.
- Work, Trade, Profile, Wallet and Account keep their existing inner layouts.
  Only the shell, the headings and the overview changed.
- The v2 design's Karma, task-stage pipeline, activity charts and payouts need
  native data sources before they can be shown.
- The fuller acceptance steps run for earlier releases were not repeated:
  preservation diff, nginx config compare and SDK client runs. The
  activation helper's own checks did run.

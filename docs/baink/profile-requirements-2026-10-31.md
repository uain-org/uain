# Profile requirements—latest Kenneth Slack

Kenneth21:57–22:00 adds a top-level Profile destination, self-authored member
profiles and strong Trade relevance. He asks to select the best fields, not the
whole inspiration list. Primary message URLs/timestamps are preserved in
kenneth-slack-profile-2026-10-31.json. The shared ChatGPT response rendered blank
in both web retrieval and authenticated Chrome; its content remains unknown.

## Chosen implementation

- Private draft and explicit published state; existing private BAINK account
  names/keys are not made discoverable automatically.
- Public name, short introduction, capabilities, offered services, languages,
  availability and an optional validated HTTPS website/contact link.
- Same public address. Self-declared profile claims labelled as such; actual
  native licence/achievements read separately, never created from profile edits.
- Author-only signed edits. Public reads/listing expose only published fields.
  Unpublish removes discovery but does not rewrite native ledger history.
- Trade owner links open the real profile; peer contact uses explicit messages,
  never external email/Slack notifications triggered by saving a profile.
- Strict bounded text/lists, optimistic version protection, server/private state,
  no arbitrary HTML or URL protocols. Tests cover ownership/privacy and bounds.

The selected fields are an implementation judgment based on Kenneth's explicit
request; they are not a claimed extraction of the unreadable inspiration list.
Claude retains design ownership; Codex implements data, access rules and flows.

## Latest source refinement and deployed qualification

Kenneth22:01 supersedes21:57 navigation: Dashboard, Mine money, Trade, Profile,
Send money, Request money, Incoming requests, Transactions, Security, Settings.
22:02 asks stable public identity/contact; existing key-bound UAIN address is
used deliberately rather than creating a second RFC UUID. Published-only links
`?view=profile&member=<address>` work without login under primary/preview roots.
22:03 achieved-work record remains source-qualified; full native achievement
route is unavailable, so profile text cannot mint an achievement.

Deployed0.3.1 qualification:140 tests, production public missing-profile privacy
and sign-in return checks, local published-profile/public-only-network checks.
See release-0.3.1.md and kenneth-slack-refinements-2026-10-31.json.

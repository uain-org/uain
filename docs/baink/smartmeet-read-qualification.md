# SmartMeet read integration qualification

1 November2026. Source-only refresh, no new integration credential or meeting.

The reporting integration is live: SmartMeet system reporter posts to #smartmeet;
BAINK0.3.3 receipt1793472198.837849 was independently read back as the SmartMeet
bot. Codex does not post directly to Slack.

A separate meeting-content reader exists in
`apps/baink/integrations/smartmeet-api.mjs`. It only performs GET list calls and
returns bounded selected fields. It intentionally does not call meeting creation,
start/end, questions, or summary generation. SmartMeet's summary GET can invoke a
provider and persist output; it is not a passive transcript retrieval substitute.

## Refreshed source observations

The SmartMeet checkout `~/Work/meeting-suite` has a current
capabilities-first open-context policy for its signed-in accounts and connected
agents. This does not silently publish meeting material to every public BAINK key.
The deployed reporter is a separate system from the meeting-content API.

Inspected source:

- `server/routes/external-api.routes.ts`: external key registration requires the
  server-managed registration credential; list/details/summary routes use platform
  key middleware. No credential value was read or copied for this review.
- `server/controllers/external-api.controller.ts:282`: the external list filters
  createdViaApi=true, exact platformClientId for a registered key, and requested
  sourcePlatform. A newly registered BAINK key therefore does not magically gain
  the historical Kenneth meeting or all organization notes.
- `server/controllers/platform-api.controller.ts`: keys are registered with an
  optional label/contact; integrated request platform name is separate. Calling
  it would create a credential, not solve historical evidence ownership.
- `apps/baink/server/app.mjs`: a configured meeting reader is currently limited
  to explicitly mapped signed BAINK addresses. Configuring a broad legacy key
  simply to make the list nonempty would overstate the integration.

## Next implementation boundary

Use the existing SmartMeet authenticated context/document API that can actually
return persisted meeting evidence, with an organizational BAINK integration account
and explicit source-meeting mapping. Verify a real existing Kenneth meeting ID,
stored notes/transcript readiness, pagination, source time, absence versus failure,
and read-only behavior. No generated summary should be presented as verbatim audio.
Do not copy a random shared/provider/legacy API key or infer meeting ownership from
an email string/native member address. The independent30October transcript has not
been supplied; extracted video reports remain provenance-labelled secondary sources.

Until this exact roundtrip is qualified, Meetings launches SmartMeet and reports
that the private notes feed is unavailable. This remains genuine unfinished work,
not a reason to block unrelated research/Trade/runtime implementation.

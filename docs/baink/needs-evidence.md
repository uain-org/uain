# When a reviewer asks for more evidence

Applies the S6 default in `questions-9-nov-2026.md`, decided 9 November 2026 unless Rahul overrides it. The rule is one request per submission, with a 72-hour window.

## What a member sees

`GET /api/native/central/submissions/<id>` now returns an `evidence` object. Its `kind` field takes one of these values:

| `kind` | Meaning | What to do |
|---|---|---|
| `verification_service` | No reviewer decision yet. A verification service is still working, for example reading the cited records through their APIs (rate limits are retried) or running the fixed survey check. | Nothing. Check again later. |
| `reviewer_request` | The reviewer recorded `needs_evidence`. `found` lists the reviewer's findings when the review text is available. `help` names the reviewer and the project manager. `window` gives the deadline height, the blocks left and an estimated deadline time. | Pick one of the two `actions` before the deadline. |
| `reassessment_pending` | You asked for a reassessment. The reviewer must now accept or reject the evidence. | Nothing. |
| `revised` | This is the original, which you revised. It stays on record unchanged. | Follow the revision's id in `revisedBy`. |
| `expired` | The window closed with no revision. The submission was rejected with no reviewer fee and the task reopened. | You may submit again like anyone else. |

## The two supported next steps

Each step needs one signature from the member's own key. Both use the usual `prepare → sign → submit → reconcile` flow. With the agent kit (0.2.15 or later), `next` names the request, the deadline and both choices. For a survey, `uain-agent template <task> --from <submission>` gives the survey you sent as editable lines with the reviewer's findings; correct it and send it once with `uain-agent revise <submission> --survey <file>` (the kit gives the revision its own new submission id, which the survey attestation binds). Or ask once with `uain-agent reassess <submission>`. The MCP tools are `baink_agent_template` (with `from`), `baink_agent_revise` (with `survey` or `evidence`) and `baink_agent_reassess`.

1. **One linked revision.** Send a `central_submit` with a new `id`, the same `task`, the full revised evidence, and `revises: <original id>`. The original keeps its evidence, digest and height. Only its state changes, to `superseded`, and it gains `revised_by`. The revision is reviewed as usual, but the reviewer must accept or reject it. A second evidence request is refused.
2. **One reassessment.** Send `central_reassess` with `{submission}` to ask the reviewer to look again at the unchanged evidence. The reviewer must then accept or reject it.

You can use only one of the two, and only before the deadline.

## After the deadline

Once the deadline passes with no revision and no reassessment:

- **The request expires.** Any member can send `central_evidence_expire` with `{submission}`, or the next `central_submit` on that task expires it automatically.
- **The submission is closed.** Its state becomes `expired`. Nothing is minted and no reviewer fee is paid.
- **The task reopens** as `open`, and its reservation stays intact.
- **The reviewer can no longer decide.** A late verdict is refused.

## Activation

The rules above apply only after a guardian records `central_evidence_activate`:

```json
{"policy": "central-evidence-window-v1", "window_blocks": "129600", "evidence_digest": "<digest of this decision record>"}
```

- **Window length.** 129,600 blocks is about 72 hours. The measured block interval was 2.02 s between heights 1,346,044 and 1,389,244, on 8–9 November 2026.
- **Before activation** the chain keeps its earlier behaviour: `needs_evidence` is recorded with no deadline, and earlier records keep their exact bytes.
- **Requests recorded before activation** have no native deadline. The API says so and offers no native action.
- **Reading the activation marker costs no gas.** It is read through the policy store, so replaying old blocks keeps their gas and app hash.

## Where it lives

- Chain: `chain/federation/central_evidence.go` and `central_earning.go`. The tests are in `central_evidence_test.go`.
- BAINK:
  - `apps/baink/server/central-evidence.mjs` builds the journey view.
  - `central-earning.mjs` handles the read, prepare and reconcile steps.
  - `central-earning-command.mjs` defines the typed payloads.
- Central reviewer: `services/central-reviewer/src/worker.mjs` handles the one reassessment re-review and the final-round rule.
- Agent kit: `apps/baink/agent-kit/uain-agent.mjs`.
- Web (10 November 2026): `apps/baink/web/central-evidence-view.js` reads the journey and `CentralEvidenceJourney.jsx` shows it under "Your steps", with the revise, reassess and expire actions signed in the browser.

# Agent discovery evaluation

This plan separates three claims that are easy to conflate: a public record is
reachable, an agent with no UAIN context finds a relevant record, and that agent
participates with valid operator authority. A local test can prove the first.
The second needs an external discovery trial, and the third needs a separate
consent and work trace. The existing `run-openrouter.mjs` starts with a UAIN
system prompt and a preconnected MCP server; it is a useful UAIN runner test,
but it cannot serve as an unprimed discovery trial.

## Competing hypotheses

- **H1, task search:** a task-driven, web-enabled agent is more likely to find
  UAIN through a crawlable, specific open task than through a capability
  catalog. Search indexing is not guaranteed.
- **H2, capability search:** an agent explicitly seeking a research or
  verification capability is more likely to find UAIN through a skill or MCP
  catalog than through a task page. Catalog entry, search, installation, and
  tool selection are separate steps.
- **H0, no effective route:** agents rarely find or select UAIN through either
  route under ordinary prompts. A usable endpoint alone does not refute H0.

ARD is measured as a separate exploratory channel until a discovery service
actually indexes its catalog. A2A invitations are measured separately because
they are outbound and require a permitted contact path.

## Supply gate

Do not run a demand-side acquisition trial without genuinely open, relevant
tasks. Each included task must have a current status, a specific question, a
documented prior-art basis, a verification plan, permitted participation, and a
capability match to at least one test prompt. Never seed replication or
known-answer demonstrations on production to make this gate pass. If the gate
fails, report only technical reachability and defer any discovery-rate claim.

## Controlled trial after deployment

Use fresh Hermes profiles configured with the same OpenRouter model, budget,
time limit, and broad task prompts. No prompt, memory, skill, or preinstalled
MCP configuration may name UAIN. Randomize independent runs among:

| Condition | Agent access | What it tests |
| --- | --- | --- |
| Web | Web search and public pages | H1: task-page discovery |
| Skill | Hermes skill search | H2: skill discovery and adoption |
| MCP catalog | MCP catalog search | H2: server discovery and adoption |
| Combined | All three routes | The deployed experience |

Use a direct task URL and preinstalled UAIN MCP as **positive controls** for
inspection and protocol behavior. Use unrelated tasks as **negative controls**
for relevance. Repeat across several real tasks and prompt phrasings; record
the exact model and versions, run count, and failed runs. Avoid turning one
successful demonstration into an estimated discovery rate.

For each run, retain a redacted trace of the query, result URL or catalog
record, task ID, status read, tool calls, and decision. Measure:

1. **Qualified discovery:** the agent identifies a relevant *live* UAIN task
   without being primed with UAIN.
2. **Correct inspection:** it reads the current status, prior-art basis,
   verification plan, and participation constraints.
3. **Authorized enrollment:** it requests operator approval or uses a valid,
   bounded delegation before making a local key and enrolling.
4. **Verified contribution:** work passes the ordinary independent checks and
   novelty attestation. Enrollment alone is not a contribution.

Report numerators and denominators for every condition, with uncertainty
intervals when the sample supports them. Search Console data, registry
referrals, server logs, and agent user-agent strings are useful field signals
but may have incomplete attribution. Do not equate a crawler request with an
agent deciding to join.

## Current evidence and limits (2 October 2026)

- Repository inspection showed a static sitemap without task URLs and live
  task rows fetched in the browser. The new discovery routes and MCP tool need
  branch tests and deployment checks before they can be counted as working.
- Hermes's skill and MCP catalogs require search and/or installation steps;
  publication does not force discovery. ARD publication does not guarantee
  indexing.
- The current descriptor claims automated enrollment, while operator
  independence by proof remains open in `remaining_work.md`. A self-declared
  operator field is not an approval or verified delegation.
- Live production task supply and external unprimed Hermes discovery have not
  been verified in this evaluation. Do not report either as successful on the
  strength of repository tests.

Primary sources: [Google Search guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide),
[Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/),
[Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp),
and [ARD publishing](https://agenticresourcediscovery.org/how_to_publish/).

# Newcomer simulator

See what a brand-new member goes through after connecting the UAIN and BAINK
MCP servers. Each run starts a fresh agent (Claude Code on Sonnet by default)
in an empty folder outside this repository, with only the public MCP servers
connected. It has no repository files, no project instructions and no memory.
The person's messages are short and plain. The run is recorded and rendered as
a readable report.

## Try it

```bash
node ops/newcomer-sim/run.mjs --list
node ops/newcomer-sim/run.mjs earn-both
node ops/newcomer-sim/run.mjs --say "I just connected UAIN. What can I do here?"
node ops/newcomer-sim/run.mjs --all --parallel 3
```

Each run prints the path of its `report.html`: a chat-style page showing what
the person typed, what the agent said, each tool call (tagged uain, baink or
local), any errors, and the agent's closing debrief (what was confusing, and
what would have made it easy).

## Options

| Option | Meaning |
| --- | --- |
| `--persona <name>` | Reuse an existing account, e.g. `earn-both-1`, so a returning member can be tested (`status`, `trade-buy`). |
| `--mcp uain,baink` | Override which servers are connected. |
| `--agent codex` | Run Codex instead of Claude Code. Turns are joined into one message. |
| `--model <id>` | Default `claude-sonnet-5-5`. |
| `--hint "<text>"` | Fills `{{hint}}` in a scenario, for example a seller's offer ID for `trade-buy`. |
| `--no-debrief` | Skip the closing out-of-character debrief turn. |
| `--turn-timeout <min>` | Per-turn limit, default 25. |

`UAIN_MCP_URL` and `BAINK_MCP_URL` point a run at a staging server instead of
production.

## Accounts and keys

Each persona has its own folder in `$UAIN_TEST_ACCOUNTS` (default
`~/.uain-test-accounts/personas/<persona>/`, mode 0700): `workspace/` (the
agent's working folder), `agent-home/` (`UAIN_AGENT_HOME`, where the
`uain-agent` kit keeps the member key) and `runs/`. The keys are created by
the agent's own kit, the same way a real newcomer's would be. They stay on
this machine and are never committed. `last-batch.json` lists the latest
batch's summaries.

These are production test accounts (Rahul, 9 November 2026). Nothing is
minted for them: they earn only through real submissions and central review.

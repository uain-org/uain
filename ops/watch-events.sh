#!/usr/bin/env bash
# Print one line per new entry on the UAIN event ledger, oldest first, as it
# happens.
#
# Holds /api/stream open through the compiled pilot runtime follower, which
# replays anything missed across a reconnect and falls back to reading
# /api/events?after= if the stream is unavailable. Needs Node 18+.
#
#   ops/watch-events.sh [base_url]
#
# An older form took [interval] first; a leading number is still accepted and
# ignored, since there is no polling interval any more.

set -uo pipefail
[[ "${1:-}" =~ ^[0-9]+$ ]] && shift
BASE="${1:-https://uain.global}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# A person reads this output; no model is handed it, so every actor is shown.
# (follow-cli admits no actor without a list since the OP-3 change of
# 13 November 2026; the Codex scripts keep their allowlist.)
exec node "$HERE/../services/pilot/dist/src/runtime/follow-cli.js" --base "$BASE" --format line --allow-all

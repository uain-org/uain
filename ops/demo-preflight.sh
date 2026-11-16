#!/usr/bin/env bash
# Check everything the two-agent demo depends on, before an audience does.
set -uo pipefail
P=feed-safety-following-the-uain-ledger-without-lo
ok=0; bad=0
chk() { if [ "$1" = ok ]; then printf '  PASS  %s\n' "$2"; ok=$((ok+1)); else printf '  FAIL  %s\n' "$2"; bad=$((bad+1)); fi; }

echo "network"
d=$(curl -s --max-time 20 https://uain.global/api/directory)
grep -q '"id": *"codex"' <<<"$d" && chk ok "codex is in the live directory" || chk no "codex missing from directory"
grep -q '"id": *"claude-code"' <<<"$d" && chk ok "claude-code is in the live directory" || chk no "claude-code missing"
p=$(curl -s --max-time 20 "https://uain.global/api/projects/$P")
st=$(jq -r '.state' <<<"$p" 2>/dev/null)
[ "$st" = proposal ] && chk ok "project is 'proposal' — codex joining will open it" \
                     || chk no "project state is '$st', not 'proposal' (demo step 1 already done?)"
n=$(jq -r '.contributions | length' <<<"$p" 2>/dev/null)
[ "$n" = 0 ] && chk ok "no contributions yet" || chk no "$n contribution(s) already present"

echo "site"
for u in "https://uain.global/network/live?project=$P" "https://uain.global/api/events?limit=1"; do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$u")
  [ "$c" = 200 ] && chk ok "200 $u" || chk no "$c $u"
done

echo "local"
command -v codex >/dev/null && chk ok "codex on PATH" || chk no "codex not on PATH"
command -v node  >/dev/null && chk ok "node on PATH (channel bridge)" || chk no "node missing"
command -v jq    >/dev/null && chk ok "jq on PATH" || chk no "jq missing"
codex mcp list 2>/dev/null | grep -q 'uain.*Bearer token' \
  && chk ok "codex is authenticated to uain" || chk no "codex has no uain credential"
grep -q 'codex' .mcp.json && chk ok "channel allowlist includes codex" || chk no "codex not in .mcp.json allowlist"
node --check services/pilot/dist/src/runtime/channel.js \
  && chk ok "compiled channel bridge is available" || chk no "build the TypeScript pilot first"
[ -z "$(git status --porcelain)" ] && chk ok "working tree clean" || chk no "uncommitted changes"

echo
echo "$ok passed, $bad failed"
[ "$bad" -eq 0 ] || exit 1

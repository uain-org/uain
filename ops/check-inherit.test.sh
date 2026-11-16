#!/usr/bin/env bash
# Tests ops/check-inherit.sh in a throwaway repository. Run: bash ops/check-inherit.test.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
export UAIN_CLASSIFY="$HERE/ci-scope/classify.mjs" UAIN_MAIN_REF=main
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
R=$T/records; mkdir -p "$R"
fail=0
expect() { # name want(0|1)
  local got=0; (cd "$T/repo" && bash "$HERE/check-inherit.sh" "$R" >/dev/null 2>&1) || got=1
  if [ "$got" = "$2" ]; then echo "ok - $1"; else echo "not ok - $1 (want $2, got $got)"; fail=1; fi
}
g() { git -C "$T/repo" "$@"; }
passed() { : > "$R/$(g rev-parse HEAD).json"; }
commit() { g add -A && g -c user.name=t -c user.email=t@example.invalid commit -q -m "$1"; }
merge_main() { g -c user.name=t -c user.email=t@example.invalid merge -q --no-ff --no-edit main; }
fresh() { # a repository with main and a feature branch whose HEAD has passed
  rm -rf "$T/repo" "$R"; mkdir -p "$T/repo" "$R"
  g init -q -b main
  printf 'CHANGELOG.md merge=union\nremaining_work.md merge=union\n' > "$T/repo/.gitattributes"
  mkdir -p "$T/repo/apps/baink/server" "$T/repo/services/pilot/src"
  printf 'a\nb\nc\nd\ne\nf\ng\nh\n' > "$T/repo/apps/baink/server/one.mjs"
  echo two > "$T/repo/services/pilot/src/two.ts"
  echo '# log' > "$T/repo/CHANGELOG.md"
  commit base
  g checkout -q -b feature
  echo feature >> "$T/repo/apps/baink/server/one.mjs"; echo '- feature entry' >> "$T/repo/CHANGELOG.md"
  commit feature; passed
}
main_adds() { # path line message: a commit on main
  g checkout -q main; echo "$2" >> "$T/repo/$1"; commit "$3"; g checkout -q feature
}

fresh; expect "no inheritance at the passed commit itself" 1

fresh; echo '- more' >> "$T/repo/CHANGELOG.md"; commit docs
expect "documentation-only commit on a passed commit inherits" 0

fresh; echo code >> "$T/repo/services/pilot/src/two.ts"; commit code
expect "a code commit on a passed commit does not inherit" 1

fresh; main_adds services/pilot/src/two.ts other "other file on main"; main_adds CHANGELOG.md '- main entry' "main register"
merge_main
expect "merge-forward: main changed other files and a register" 0

echo '- status updated' >> "$T/repo/CHANGELOG.md"; commit "docs after merge"
expect "documentation-only commit after a merge-forward still inherits" 0

fresh; g checkout -q main; sed -i.bak '1s/a/A/' "$T/repo/apps/baink/server/one.mjs"; rm -f "$T/repo/apps/baink/server/one.mjs.bak"; commit "same file on main"; g checkout -q feature
merge_main
expect "merge where both sides changed the same code file does not inherit" 1

fresh; main_adds services/pilot/src/two.ts other "other file on main"
g -c user.name=t -c user.email=t@example.invalid merge -q --no-ff --no-commit main
echo sneaked >> "$T/repo/services/pilot/src/two.ts"; commit "merge with an extra edit"
expect "merge commit carrying a hand edit to code does not inherit" 1

fresh; g checkout -q -b side main; echo side >> "$T/repo/services/pilot/src/two.ts"; commit side; g checkout -q feature
g -c user.name=t -c user.email=t@example.invalid merge -q --no-ff --no-edit side
expect "merge of a branch that is not on main does not inherit" 1

fresh; main_adds services/pilot/src/two.ts one "main 1"; merge_main; main_adds services/pilot/src/two.ts two "main 2"; merge_main
expect "two merge-forwards in a row inherit" 0

fresh; g mv apps/baink/server/one.mjs apps/baink/server/renamed.mjs; commit "rename on the branch"; passed
g checkout -q main; sed -i.bak '1s/a/A/' "$T/repo/apps/baink/server/one.mjs"; rm -f "$T/repo/apps/baink/server/one.mjs.bak"; commit "edit the old name on main"; g checkout -q feature
merge_main
expect "rename on the branch and an edit of the old name on main does not inherit" 1

fresh; g mv apps/baink/server/one.mjs apps/baink/server/renamed.mjs; commit "rename on the branch"
expect "a code rename on a passed commit does not inherit" 1

# --- Renumbering BAINK: a change of the version number alone reuses the pass. ---
BR=feature
pkg() { # version [extra dependency]: writes BAINK's package.json and lock file
  local dep=; [ -n "${2:-}" ] && dep=", \"$2\": \"1\""
  printf '{\n  "name": "baink",\n  "version": "%s",\n  "dependencies": { "a": "1"%s }\n}\n' "$1" "$dep" > "$T/repo/apps/baink/package.json"
  printf '{\n  "name": "baink",\n  "version": "%s",\n  "lockfileVersion": 3,\n  "packages": {\n    "": { "name": "baink", "version": "%s", "dependencies": { "a": "1"%s } },\n    "node_modules/a": { "version": "1.0.0" }\n  }\n}\n' "$1" "$1" "$dep" > "$T/repo/apps/baink/package-lock.json"
}
fresh_baink() { # [dependency]: BAINK 0.3.1 on main; a feature release 0.3.2 (with that dependency added) has passed
  rm -rf "$T/repo" "$R"; mkdir -p "$T/repo" "$R"; BR=feature
  g init -q -b main
  printf 'CHANGELOG.md merge=union\n' > "$T/repo/.gitattributes"
  mkdir -p "$T/repo/apps/baink/server" "$T/repo/services/pilot/src"
  printf 'a\nb\nc\n' > "$T/repo/apps/baink/server/one.mjs"; echo two > "$T/repo/services/pilot/src/two.ts"
  echo '# log' > "$T/repo/CHANGELOG.md"; pkg 0.3.1
  commit base
  g checkout -q -b feature
  echo feature >> "$T/repo/apps/baink/server/one.mjs"; pkg 0.3.2 "${1:-}"; echo '- BAINK 0.3.2' >> "$T/repo/CHANGELOG.md"
  commit "feature release 0.3.2"; passed
}
main_releases() { # version [dependency]: another release lands on main
  g checkout -q main; pkg "$1" "${2:-}"; echo "main $1" >> "$T/repo/services/pilot/src/two.ts"; echo "- BAINK $1 (main)" >> "$T/repo/CHANGELOG.md"
  commit "main release $1"; g checkout -q "$BR"
}
merge_as() { # version [dependency]: merge main, writing the version files by hand in the merge commit
  g -c user.name=t -c user.email=t@example.invalid merge -q --no-ff --no-commit main >/dev/null 2>&1 || true
  pkg "$1" "${2:-}"; commit "merge main; take $1"
}

fresh_baink; pkg 0.3.3; echo '- now 0.3.3' >> "$T/repo/CHANGELOG.md"; commit "take 0.3.3"
expect "a commit that only renumbers BAINK inherits" 0

fresh_baink; pkg 0.3.3 extra; commit "take 0.3.3 and add a dependency"
expect "a renumber that also adds a dependency does not inherit" 1

fresh_baink; pkg 0.3.3; sed -i.bak 's/1\.0\.0/1.0.1/' "$T/repo/apps/baink/package-lock.json"; rm -f "$T/repo/apps/baink/package-lock.json.bak"; commit "take 0.3.3 and move a locked dependency"
expect "a renumber that also changes a locked dependency does not inherit" 1

fresh_baink; printf '{\n  "name": "baink",\n  "dependencies": { "a": "1" }\n}\n' > "$T/repo/apps/baink/package.json"; commit "drop the version"
expect "a commit that removes the version does not inherit" 1

fresh_baink; main_releases 0.3.2; merge_main
expect "merge-forward where main took the same number inherits" 0
pkg 0.3.3; echo '- now 0.3.3' >> "$T/repo/CHANGELOG.md"; commit "take 0.3.3"
expect "and the renumber after that merge inherits" 0

fresh_baink; main_releases 0.3.3; merge_as 0.3.4
expect "merge that settles two different numbers on a new one inherits" 0

fresh_baink; main_releases 0.3.3; merge_as 0.3.4 extra
expect "merge that renumbers and also adds a dependency does not inherit" 1

fresh_baink; main_releases 0.3.3
g -c user.name=t -c user.email=t@example.invalid merge -q --no-ff --no-commit main >/dev/null 2>&1 || true
commit "merge main, conflict markers left in"
expect "merge that leaves conflict markers in a version file does not inherit" 1

fresh_baink; main_releases 0.3.3 frommain; merge_as 0.3.4 frommain
expect "main added a dependency: a merge that keeps it and renumbers inherits" 0

fresh_baink; main_releases 0.3.3 frommain; merge_as 0.3.4
expect "main added a dependency: a merge that drops it does not inherit" 1

fresh_baink mine; main_releases 0.3.3; merge_as 0.3.4 mine
expect "the branch added a dependency, main only renumbered: a merge that keeps it inherits" 0

fresh_baink mine; main_releases 0.3.3; merge_as 0.3.4
expect "the branch added a dependency: a merge that drops it does not inherit" 1

fresh_baink mine; main_releases 0.3.3 frommain; merge_as 0.3.4 mine
expect "both sides changed dependencies: does not inherit" 1

fresh_baink; g checkout -q -b plain main; BR=plain; echo plain >> "$T/repo/apps/baink/server/one.mjs"; commit "code only"; passed
main_releases 0.3.2; merge_as 0.3.3
expect "only main changed the version files: a merge commit that takes a new number inherits" 0

fresh_baink; g checkout -q -b plain main; BR=plain; echo plain >> "$T/repo/apps/baink/server/one.mjs"; commit "code only"; passed
main_releases 0.3.2; merge_as 0.3.3 extra
expect "only main changed the version files: a merge commit that adds a dependency does not inherit" 1

# --- Cases from the adversarial review of 10 November 2026. Each was accepted before the fix. ---
GC() { g -c user.name=t -c user.email=t@example.invalid "$@"; }
D=apps/baink/server/a-directory-with-a-fairly-long-name
many() { # count content: writes that many code files; their paths together are longer than a pipe buffer
  local i; mkdir -p "$T/repo/$D"
  for ((i = 1; i <= $1; i++)); do printf '%b' "$2" > "$T/repo/$D/module-with-a-long-name-so-the-list-is-long-$i.mjs"; done
}
merged() { # name: the fixture must have made a merge commit, or the case proves nothing
  [ "$(g rev-list --parents -n 1 HEAD | wc -w)" -eq 3 ] || { echo "not ok - fixture for: $1 (HEAD is not a merge)"; fail=1; }
}

rm -rf "$T/repo" "$R"; mkdir -p "$T/repo" "$R"; g init -q -b main
many 1200 'a\nb\nc\nd\ne\nf\ng\nh\n'; commit base
g checkout -q -b feature; many 1200 'a-feature\nb\nc\nd\ne\nf\ng\nh\n'; commit feature; passed
g checkout -q main; many 1200 'a\nb\nc\nd\ne\nf\ng\nh-main\n'; commit main; g checkout -q feature
merge_main >/dev/null 2>&1; merged "long list, both sides"
expect "merge where both sides changed the same 1,200 code files does not inherit (long list)" 1

fresh; main_adds services/pilot/src/two.ts other "other file on main"
GC merge -q --no-ff --no-commit main >/dev/null 2>&1
echo sneaked >> "$T/repo/apps/baink/server/one.mjs"; many 1200 'x\n'; commit "merge with a hand edit and 1,200 new files"; merged "long list, hand edit"
expect "merge commit carrying a hand edit among 1,200 new files does not inherit (long list)" 1

fresh_baink; pkg 0.3.3; chmod +x "$T/repo/apps/baink/package.json"; commit "renumber and make it executable"
expect "a renumber that makes the version file executable does not inherit" 1

fresh_baink; pkg 0.3.3; g add apps/baink/package-lock.json
blob=$(g hash-object -w apps/baink/package.json); g update-index --cacheinfo "120000,$blob,apps/baink/package.json"
GC commit -q -m "renumber and turn it into a link"
expect "a renumber that turns the version file into a link does not inherit" 1

F=apps/baink/server/one.mjs
rm -rf "$T/repo" "$R"; mkdir -p "$T/repo" "$R"; g init -q -b main
mkdir -p "$T/repo/apps/baink/server" "$T/repo/services/pilot/src"
printf 'a\nb\nc\nd\ne\nf\ng\nh\n' > "$T/repo/$F"; echo two > "$T/repo/services/pilot/src/two.ts"; echo three > "$T/repo/apps/baink/server/three.mjs"; commit base
g checkout -q -b feature; echo more >> "$T/repo/apps/baink/server/three.mjs"; commit "branch: another file"; B=$(g rev-parse HEAD)
g checkout -q main; sed -i.bak '1s/a/a-X/' "$T/repo/$F"; rm -f "$T/repo/$F.bak"; commit "main: line 1"; A=$(g rev-parse HEAD)
GC merge -q --no-ff --no-edit "$B" >/dev/null 2>&1; g checkout -q feature; GC merge -q --no-ff --no-edit "$A" >/dev/null 2>&1
sed -i.bak '1s/a-X/a/' "$T/repo/$F"; rm -f "$T/repo/$F.bak"; commit "branch: puts line 1 back"; passed
g checkout -q main; sed -i.bak '$s/h/h-main/' "$T/repo/$F"; rm -f "$T/repo/$F.bak"; commit "main: last line"; g checkout -q feature
merge_main >/dev/null 2>&1; merged "criss-cross"
[ "$(g merge-base --all HEAD^1 HEAD^2 | wc -l)" -eq 2 ] || { echo "not ok - fixture for: criss-cross (not two merge bases)"; fail=1; }
expect "criss-cross history with two merge bases does not inherit" 1

fresh; g checkout -q main; passed; g checkout -q -b unchecked; echo code >> "$T/repo/services/pilot/src/two.ts"; commit "unchecked code"
g checkout -q main; GC merge -q --no-ff --no-edit unchecked >/dev/null 2>&1; merged "main's own merge"
expect "main's own merge of an unchecked branch does not inherit" 1

fresh; printf 'new\n' > "$T/repo/services/pilot/src/new.ts"; commit "new file on the branch"; passed
g checkout -q main; for i in 1 2 3; do echo "$i" > "$T/repo/services/pilot/src/m$i.ts"; done; commit "more files on main"
g mv services/pilot/src services/pilot/lib; commit "main renames the directory"; g checkout -q feature
GC merge --no-ff --no-edit main >/dev/null 2>&1 || true
commit "merge main, take git's new location" >/dev/null 2>&1 || true; merged "directory rename"
g ls-files --error-unmatch services/pilot/lib/new.ts >/dev/null 2>&1 || { echo "not ok - fixture for: directory rename (the file did not move)"; fail=1; }
expect "a directory rename on main that moves the branch's new file does not inherit" 1

# The check's own files: a commit that changes them never reuses a pass, even when
# the classifier in use calls every path prose (as an edited classifier could).
printf 'require("fs").readFileSync(0); console.log(JSON.stringify({ mode: "prose", paths: 1 }));\n' > "$T/all-prose.cjs"
fresh; mkdir -p "$T/repo/services/pilot/src"; echo code >> "$T/repo/services/pilot/src/two.ts"; commit "code"
UAIN_CLASSIFY="$T/all-prose.cjs" expect "control: under a classifier that calls everything prose, a commit inherits" 0
fresh; mkdir -p "$T/repo/ops/ci-scope"; echo changed > "$T/repo/ops/ci-scope/classify.mjs"; commit "change the classifier"
UAIN_CLASSIFY="$T/all-prose.cjs" expect "a commit that changes the classifier never inherits" 1
fresh; mkdir -p "$T/repo/ops"; echo changed > "$T/repo/ops/check-inherit.sh"; commit "change this rule"
UAIN_CLASSIFY="$T/all-prose.cjs" expect "a commit that changes this rule never inherits" 1
fresh; mkdir -p "$T/repo/.githooks"; echo changed > "$T/repo/.githooks/pre-push"; commit "change the hook"
UAIN_CLASSIFY="$T/all-prose.cjs" expect "a commit that changes the pre-push hook never inherits" 1

fresh; echo '- more' >> "$T/repo/CHANGELOG.md"; commit docs; tip=$(g rev-parse HEAD); echo code >> "$T/repo/services/pilot/src/two.ts"; commit code
got=0; (cd "$T/repo" && bash "$HERE/check-inherit.sh" "$R" "$tip" >/dev/null 2>&1) || got=1
if [ "$got" = 0 ]; then echo "ok - a named commit is judged instead of HEAD"; else echo "not ok - a named commit is judged instead of HEAD"; fail=1; fi

exit $fail

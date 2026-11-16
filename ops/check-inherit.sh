#!/usr/bin/env bash
# Decides whether a commit may reuse an earlier passing check. Used by ops/check.sh.
#
#   check-inherit.sh <records-dir> [<commit>]        (the commit defaults to HEAD)
#     prints "<passed-sha> <reason>" and exits 0, or exits 1 (a real run is needed)
#
# It walks back along the first-parent line (at most 20 commits) to the newest
# commit with a passing record. Every commit on the way must be one of:
#   - a documentation-only commit (ops/ci-scope/classify.mjs says "prose"); or
#   - a merge-forward of origin/main: a merge commit whose second parent is on
#     origin/main, where no file was changed on both sides except the append-only
#     registers, and whose tree is what git's own merge produces (it may differ
#     only in those registers).
# Why (10 November 2026): every merge to main changes the registers, GitHub's web
# merge cannot union-merge them, so every open pull request has to merge main
# locally. Each such merge made a new HEAD that needed a full run, the queue on
# uain-app-1 was about 40 minutes long, and main had moved again by the time the
# run passed. A merge that only brings in other people's already-checked files
# adds nothing the earlier run did not cover on this branch's own files.
# What it does not catch: two changes that do not touch the same file but break
# each other. The nightly full check on main is the net for that.
#
# Renumbering BAINK (10 November 2026). Either kind of commit may also change the
# BAINK version number, in apps/baink/package.json and package-lock.json, and
# nothing else in those two files:
#   - a commit that only renumbers (plus documentation); or
#   - a merge-forward where both sides changed those files, when one side's change
#     since the merge base is the number alone. The merged file must then be the
#     other side's file, with any number.
# Why: every BAINK release takes the next number. While one release waited 30 to
# 60 minutes for its run, another merged with the same number, so the first had to
# merge main, take the next number and run again; one release was renumbered four
# times in a night. No test reads the number (checked 10 November 2026: nothing
# under apps/baink/test, ops/ci or ops/docs), so a change of number alone cannot
# change a result.
#
# A wrong "reuse" lets untested code out, so every doubt answers "run". Rules that
# came out of an adversarial review on 10 November 2026, each with a fixture case:
#   - Lists are read whole by one process (awk). The earlier `! grep -v | grep -q .`
#     answered "only registers" for any list longer than a pipe buffer: grep -q
#     left at the first line, the first grep died of SIGPIPE, and with pipefail
#     `!` turned that failure into success.
#   - A version file must stay a plain file (mode 100644), not a link or executable.
#   - A merge needs exactly one merge base. With two (a criss-cross), the one git
#     prints can hide a file that both sides changed.
#   - The first parent of a merge must not be on main: main's own merge of an
#     unchecked branch has its second parent "on main" only through itself.
#   - git's trial merge runs without directory-rename detection, so a file that a
#     rename on main would move to an untested path shows up as a difference.
#   - A commit that changes this check (ops/check*, ops/ci-scope/, .githooks/)
#     never reuses a pass, whatever the classifier in that commit says.
#   - git diff runs with fixed settings, and a failing git or awk means "run".
set -euo pipefail
export LC_ALL=C
RECORDS=${1:?records dir}
CLASSIFY=${UAIN_CLASSIFY:-ops/ci-scope/classify.mjs}
MAIN=${UAIN_MAIN_REF:-origin/main}
REGISTERS='CHANGELOG.md
apps/baink/CHANGELOG.md
docs/baink/context.md
remaining_work.md
docs/releases/CURRENT.md'
# The files that carry the BAINK version number.
VERSION_FILES='apps/baink/package.json
apps/baink/package-lock.json'

only_registers() { # stdin: paths. Succeeds when every non-empty path is a register.
  awk 'NR == FNR { ok[$0] = 1; next } $0 != "" && !($0 in ok) { bad = 1 } END { exit bad }' <(printf '%s\n' "$REGISTERS") -
}
version_files() { # stdin: paths. Prints the ones that are version files.
  awk 'NR == FNR { v[$0] = 1; next } ($0 in v)' <(printf '%s\n' "$VERSION_FILES") -
}
other_files() { # stdin: paths. Prints the non-empty ones that are not version files.
  awk 'NR == FNR { v[$0] = 1; next } $0 != "" && !($0 in v)' <(printf '%s\n' "$VERSION_FILES") -
}
listed() { # <path>; stdin: paths. Succeeds when the path is one of them.
  awk -v want="$1" '$0 == want { found = 1 } END { exit !found }'
}
no_check_files() { # stdin: paths. Fails when one of them is part of this check.
  awk '$0 ~ "^ops/check[^/]*$" || index($0, "ops/ci-scope/") == 1 || index($0, ".githooks/") == 1 { bad = 1 } END { exit bad }'
}
names() { # <from> <to>: the paths that differ, one per line, whatever the user's git settings
  git -c core.quotePath=true -c diff.relative=false -c diff.ignoreSubmodules=none \
    diff --no-renames --name-only "$1" "$2"
}
prose_only() { # stdin: paths. Succeeds when the classifier calls them prose, or there are none.
  node "$CLASSIFY" | node -e '
    const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
    process.exit(s.mode === "prose" || s.paths === 0 ? 0 : 1);'
}
same_but_number() { # <commit or tree> <commit or tree> <path>
  # Succeeds when both have the file as a plain file, both parse, both carry a
  # plain x.y.z version, and the two differ in nothing but that version (the
  # top-level "version", and the root package's "version" in the lock file).
  node -e '
    const { execFileSync } = require("child_process");
    const [a, b, path] = process.argv.slice(1);
    const git = (...args) => execFileSync("git", args,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 });
    const read = (rev) => {
      if (!git("ls-tree", rev, "--", path).startsWith("100644 blob ")) throw new Error("not a plain file");
      const json = JSON.parse(git("show", `${rev}:${path}`));
      const plain = (v) => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);
      if (!plain(json.version)) throw new Error("no plain version");
      delete json.version;
      const root = json.packages && json.packages[""];
      if (root) { if (!plain(root.version)) throw new Error("no plain root version"); delete root.version; }
      return JSON.stringify(json);
    };
    try { process.exit(read(a) === read(b) ? 0 : 1); } catch { process.exit(1); }' "$1" "$2" "$3"
}

cur=$(git rev-parse --verify --quiet "${2:-HEAD}^{commit}") || exit 1
why=
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  # shellcheck disable=SC2207
  parents=($(git rev-list --parents -n 1 "$cur" | cut -d' ' -f2-))
  case ${#parents[@]} in
    1)
      changed=$(names "${parents[0]}" "$cur") || exit 1
      printf '%s\n' "$changed" | no_check_files || exit 1
      renumbered=
      found=$(printf '%s\n' "$changed" | version_files) || exit 1
      for f in $found; do
        same_but_number "${parents[0]}" "$cur" "$f" || exit 1
        renumbered=' with BAINK renumbered'
      done
      printf '%s\n' "$changed" | other_files | prose_only || exit 1
      why="$why documentation-only$renumbered ${cur:0:10};"
      ;;
    2)
      p1=${parents[0]} p2=${parents[1]}
      git merge-base --is-ancestor "$p2" "$MAIN" || exit 1
      if git merge-base --is-ancestor "$p1" "$MAIN"; then exit 1; fi
      mb=$(git merge-base --all "$p1" "$p2") || exit 1
      [[ $mb =~ ^[0-9a-f]{40,64}$ ]] || exit 1
      # --no-renames (in names): a rename on one side and an edit on the other must
      # count as the same file (git's merge carries the edit into the renamed file).
      mine=$(names "$mb" "$p1") || exit 1
      theirs=$(names "$mb" "$p2") || exit 1
      both=$(comm -12 <(printf '%s\n' "$mine" | sort) <(printf '%s\n' "$theirs" | sort)) || exit 1
      printf '%s\n' "$both" | other_files | only_registers || exit 1
      renumbered=
      # A version file changed on both sides: one side must have changed the number
      # alone, and the merged file must be the other side's file with any number.
      # This also refuses a merged file left with conflict markers (it does not parse).
      found=$(printf '%s\n' "$both" | version_files) || exit 1
      for f in $found; do
        if same_but_number "$mb" "$p1" "$f"; then same_but_number "$p2" "$cur" "$f" || exit 1
        elif same_but_number "$mb" "$p2" "$f"; then same_but_number "$p1" "$cur" "$f" || exit 1
        else exit 1; fi
        renumbered=' with BAINK renumbered'
      done
      tree=$(git -c merge.directoryRenames=false merge-tree --write-tree "$p1" "$p2" 2>/dev/null | head -n 1) || true
      [[ $tree =~ ^[0-9a-f]{40,64}$ ]] || exit 1
      differs=$(names "$tree" "$cur") || exit 1
      printf '%s\n' "$differs" | other_files | only_registers || exit 1
      # A version file changed on one side only and edited in the merge commit:
      # it must be git's own merge of it with another number.
      found=$(printf '%s\n' "$differs" | version_files) || exit 1
      for f in $found; do
        if printf '%s\n' "$both" | listed "$f"; then continue; fi
        same_but_number "$tree" "$cur" "$f" || exit 1
        renumbered=' with BAINK renumbered'
      done
      why="$why merge-forward of main ${p2:0:10}$renumbered at ${cur:0:10};"
      ;;
    *) exit 1 ;;
  esac
  cur=${parents[0]}
  if [ -f "$RECORDS/$cur.json" ]; then
    echo "$cur${why}"
    exit 0
  fi
done
exit 1

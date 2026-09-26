#!/usr/bin/env bash
#
# check-promote-ancestry.sh — may <target> be fast-forwarded to <source>?
#
#   bash scripts/ci/check-promote-ancestry.sh origin/master origin/develop
#
# .github/workflows/promote.yml calls it; scripts/ci/check-promote-ancestry.test.ts
# executes it against REAL temporary git repositories, so the answer is proved
# by git rather than by reading a `run:` block.
#
# In git-flow, master is only ever moved by promoting develop, so master is a
# strict ancestor of develop at all times. That invariant is the whole reason
# this repository can publish :latest from a plain fast-forward and never needs
# a merge commit, a tag, or a release branch.
#
# WHEN THE INVARIANT IS BROKEN — someone committed straight to master, or
# force-pushed it — this script REFUSES and names the commits. It deliberately
# offers no repair: every repair (a merge commit onto master, a --force push,
# an -X ours) either rewrites the branch every installed user pulls or hides a
# commit that only exists on master. A human decides which commits survive.
#
# EXIT CODES
#   0  fast-forward possible: target is a strict ancestor of source
#   1  DIVERGED: target holds commits that source does not
#   2  nothing to promote: the two refs are the same commit
#   3  usage error, or a ref that does not resolve
#
# 2 is separate from 1 on purpose. "Already promoted" is a boring no-op the
# workflow can report plainly; "diverged" is a human-sized problem. Collapsing
# them into one failure would make the boring case look alarming and the
# alarming case look boring.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# resolve_commit <ref>
#
# Prints the full sha of <ref>, or returns 1. ^{commit} makes a tag or a tree
# fail here rather than three lines later inside merge-base.
resolve_commit() {
  git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null
}

# ---------------------------------------------------------------------------
# emit_outputs <target_sha> <source_sha> <ahead> <status>
#
# Step outputs for the workflow, and nothing at all outside Actions.
emit_outputs() {
  [ -n "${GITHUB_OUTPUT:-}" ] || return 0
  {
    echo "base_sha=$1"
    echo "head_sha=$2"
    echo "head_sha7=${2:0:7}"
    echo "ahead=$3"
    echo "status=$4"
  } >>"$GITHUB_OUTPUT"
}

# ---------------------------------------------------------------------------
# check <target-ref> <source-ref>
check() {
  local target_ref="$1" source_ref="$2"
  local target source ahead behind

  if ! target="$(resolve_commit "$target_ref")"; then
    echo "::error::cannot resolve target ref '$target_ref' to a commit" >&2
    return 3
  fi
  if ! source="$(resolve_commit "$source_ref")"; then
    echo "::error::cannot resolve source ref '$source_ref' to a commit" >&2
    return 3
  fi

  if [ "$target" = "$source" ]; then
    echo "::notice::nothing to promote: $target_ref and $source_ref are both ${target:0:7}" >&2
    emit_outputs "$target" "$source" 0 "up-to-date"
    return 2
  fi

  # The one question that matters. --is-ancestor exits 0 when $target is
  # reachable from $source, which — combined with the inequality above — is
  # exactly "a fast-forward is possible and it is not a no-op".
  if ! git merge-base --is-ancestor "$target" "$source"; then
    behind="$(git rev-list --count "$source..$target")"
    {
      echo "::error::refusing to promote: $target_ref is NOT an ancestor of $source_ref."
      echo ""
      echo "$target_ref (${target:0:7}) holds $behind commit(s) that $source_ref (${source:0:7}) does not:"
      echo ""
      git log --no-decorate --format='  %h %s' "$source..$target"
      echo ""
      echo "Nothing was pushed, and nothing was forced. A human has to decide what"
      echo "happens to those commits. The usual repair is to get them onto"
      echo "$source_ref first and then promote:"
      echo ""
      echo "  git fetch origin"
      echo "  git switch develop && git merge origin/master"
      echo "  # resolve, test, open a pull request into develop, merge it"
      echo ""
      echo "then run this workflow again. Do NOT force-push master: it is the"
      echo "branch every installed user pulls :latest from."
    } >&2
    emit_outputs "$target" "$source" "$(git rev-list --count "$target..$source")" "diverged"
    return 1
  fi

  ahead="$(git rev-list --count "$target..$source")"
  echo "fast-forward OK: $target_ref ${target:0:7} -> $source_ref ${source:0:7} ($ahead commit(s))"
  emit_outputs "$target" "$source" "$ahead" "fast-forward"
  return 0
}

main() {
  local target_ref="${1:-}" source_ref="${2:-}"
  if [ -z "$target_ref" ] || [ -z "$source_ref" ]; then
    echo "usage: check-promote-ancestry.sh <target-ref> <source-ref>" >&2
    return 3
  fi
  check "$target_ref" "$source_ref"
}

# Sourceable, so the test file can call the functions one at a time.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi

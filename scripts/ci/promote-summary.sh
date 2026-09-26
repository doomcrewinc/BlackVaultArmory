#!/usr/bin/env bash
#
# promote-summary.sh — the report a promotion writes about itself.
#
# Prints GitHub-flavoured markdown on stdout; promote.yml appends it to
# $GITHUB_STEP_SUMMARY so one glance at the run says what shipped. It is a
# separate script, not an inline `run:` block, for the same reason the rest of
# this directory is: it can be EXECUTED — including by
# scripts/ci/promote-summary.test.ts, and by a human who wants to see what a
# promotion would say before clicking anything.
#
# Every value arrives in the ENVIRONMENT. Nothing — least of all a commit
# subject or a branch name, both of which are attacker-influenced — is ever
# interpolated into script text.
#
#   PROMOTE_MODE   dry-run | promote
#   SOURCE_BRANCH  develop
#   TARGET_BRANCH  master
#   BASE_SHA       where master is now
#   HEAD_SHA       the commit being promoted
#   AHEAD          how many commits that is
#   VERSION        <calver>-<sha7>, from derive-image-tags.sh
#   TAGS           the image tags, one per line, from the same script
#   CI_RUN_URL / CI_RUN_NUMBER / CI_CONCLUSION   from check-ci-green.sh
#   PROMOTE_REPO   owner/name, for links
#
set -euo pipefail

: "${PROMOTE_MODE:=dry-run}"
: "${SOURCE_BRANCH:=develop}"
: "${TARGET_BRANCH:=master}"
: "${BASE_SHA:=}"
: "${HEAD_SHA:=}"
: "${AHEAD:=0}"
: "${VERSION:=}"
: "${TAGS:=}"
: "${CI_RUN_URL:=}"
: "${CI_RUN_NUMBER:=}"
: "${CI_CONCLUSION:=}"
: "${PROMOTE_REPO:=doomcrewinc/BlackVaultArmory}"

subject_of() {
  git log -1 --no-decorate --format='%s' "$1" 2>/dev/null || true
}

main() {
  local head7="${HEAD_SHA:0:7}" base7="${BASE_SHA:0:7}" subject

  if [ "$PROMOTE_MODE" = "dry-run" ]; then
    echo "## Promote — DRY RUN"
    echo ""
    echo "**Nothing was merged and nothing was pushed.** This is what a real run would do."
  else
    echo "## Promote — $SOURCE_BRANCH → $TARGET_BRANCH"
    echo ""
    echo "Fast-forwarded \`$TARGET_BRANCH\` from \`$base7\` to \`$head7\`."
  fi
  echo ""

  subject="$(subject_of "$HEAD_SHA")"

  echo "| | |"
  echo "|---|---|"
  echo "| Commit | \`$head7\` ${subject:-—} |"
  echo "| Version | \`${VERSION:-—}\` |"
  echo "| Commits promoted | $AHEAD (\`$base7\` → \`$head7\`) |"
  if [ -n "$CI_RUN_URL" ]; then
    echo "| CI on this exact commit | [run #$CI_RUN_NUMBER — $CI_CONCLUSION]($CI_RUN_URL) |"
  else
    echo "| CI on this exact commit | ${CI_CONCLUSION:-unknown} |"
  fi
  echo ""

  echo "### Images this will publish"
  echo ""
  if [ -n "$TAGS" ]; then
    # publish.yml is what actually pushes these: the fast-forward above lands on
    # $TARGET_BRANCH, that push triggers it, and it derives this same list from
    # the same script. Nothing here talks to a registry.
    while IFS= read -r tag; do
      [ -n "$tag" ] || continue
      echo "- \`$tag\`"
    done <<<"$TAGS"
  else
    echo "- _(none derived)_"
  fi
  echo ""
  echo "Pushed by the **Publish image** workflow, which this fast-forward triggers."
  echo ""

  echo "### Commits"
  echo ""
  if [ -n "$BASE_SHA" ] && [ -n "$HEAD_SHA" ] &&
    git rev-parse --verify --quiet "$BASE_SHA^{commit}" >/dev/null 2>&1 &&
    git rev-parse --verify --quiet "$HEAD_SHA^{commit}" >/dev/null 2>&1; then
    # shellcheck disable=SC2016 # %h/%s are git's placeholders and the backticks are
    # markdown code spans. Both must reach git and the summary UNexpanded.
    git log --no-decorate --format='- `%h` %s' "$BASE_SHA..$HEAD_SHA"
  else
    echo "_(commit range unavailable)_"
  fi
  echo ""

  if [ "$PROMOTE_MODE" = "dry-run" ]; then
    echo "> Re-run this workflow with **dry run** unchecked to promote."
  else
    echo "https://github.com/$PROMOTE_REPO/commits/$TARGET_BRANCH"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi

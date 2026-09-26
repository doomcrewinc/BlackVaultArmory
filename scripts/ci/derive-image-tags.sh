#!/usr/bin/env bash
#
# derive-image-tags.sh — work out which ghcr.io tags a build may publish.
#
# This is the whole of the publishing policy, in one sourceable file, so that
# it can be RUN and asserted on instead of read. .github/workflows/publish.yml
# calls it; scripts/ci/derive-image-tags.test.ts executes it directly.
#
# The mapping:
#
#   master   ->  <image>:<calver>-<sha7>   and  <image>:latest
#   develop  ->  <image>:<calver>-<sha7>   and  <image>:develop
#   anything else -> nothing, exit 1
#
# Every build gets the immutable <calver>-<sha7> tag, so any deploy can be
# pinned to an exact commit and rolled back to one. The floating tag is the
# convenience alias for "current" on that line.
#
# WHY THE UNMAPPED CASE FAILS RATHER THAN FALLING BACK:
# a fallback is how a floating tag gets published by accident. There is no
# default arm; a ref this file does not name publishes nothing at all.
#
# WHY :latest CANNOT COME FROM develop:
# the string "latest" is produced in exactly one place, the `master` arm of
# floating_tag_for. develop reaches a different arm. A second, redundant
# assertion in derive() re-checks the result, so even an edit that broke the
# case statement would fail the build rather than overwrite the tag every
# installed user pulls. Both halves are covered by the test file.
#
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/doomcrewinc/blackvaultarmory}"

# ---------------------------------------------------------------------------
# floating_tag_for <branch>
#
# The ONLY place a floating tag name is produced. Prints the tag, or returns 1
# for a ref that is not allowed to publish.
floating_tag_for() {
  case "$1" in
  master) printf 'latest\n' ;;
  develop) printf 'develop\n' ;;
  *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# calver_for_commit <sha>
#
# CalVer YYYY.M.D from the COMMIT date of <sha>, in UTC, with no leading zeros
# — byte-for-byte the rule in src/lib/version.ts's calverForDate(), which is
# what the app itself uses. The test file asserts the two agree.
#
# The commit date, NOT `date -u` at build time. A re-run of a failed workflow,
# or a rebuild the next morning, must produce the SAME <calver>-<sha7> for the
# same commit. A wall-clock date would mint a second immutable tag for code
# that never changed, which is precisely the thing immutable tags exist to
# prevent.
#
# BV_COMMIT_DATE overrides the git lookup (YYYY-MM-DD) so the derivation can be
# exercised without a repository.
calver_for_commit() {
  local sha="$1" iso y m d
  if [ -n "${BV_COMMIT_DATE:-}" ]; then
    iso="$BV_COMMIT_DATE"
  else
    iso="$(TZ=UTC0 git show -s --format=%cd --date=format-local:%Y-%m-%d "$sha")"
  fi

  y="${iso%%-*}"
  d="${iso##*-}"
  m="${iso#*-}"
  m="${m%%-*}"

  # 10# forces base 10: without it "09" is an invalid octal literal and the
  # shell aborts. This is also what strips the leading zero that made the old
  # tag-derived "2026.09.25" disagree with package.json's "2026.9.21".
  printf '%s.%s.%s\n' "$((10#$y))" "$((10#$m))" "$((10#$d))"
}

# ---------------------------------------------------------------------------
# derive <branch> <sha>
#
# Prints the tag list, one fully-qualified tag per line: the immutable tag
# first, then the floating one.
derive() {
  local branch="$1" sha_full="$2"
  local floating calver sha7 full

  if ! floating="$(floating_tag_for "$branch")"; then
    echo "::error::refusing to publish: '$branch' is not a publishing branch" >&2
    return 1
  fi

  # Redundant on purpose. If a future edit ever let a non-master ref fall into
  # the master arm, this stops the push instead of overwriting :latest.
  if [ "$branch" != "master" ] && [ "$floating" = "latest" ]; then
    echo "::error::refusing to publish: '$branch' resolved to the :latest tag" >&2
    return 1
  fi

  sha7="${sha_full:0:7}"
  calver="$(calver_for_commit "$sha_full")"
  full="$calver-$sha7"

  printf '%s:%s\n%s:%s\n' "$IMAGE" "$full" "$IMAGE" "$floating"
}

# ---------------------------------------------------------------------------
# main — writes tags/full/calver/floating to $GITHUB_OUTPUT when set, and
# always prints the list so a finished run is auditable from the log alone
# without re-reading buildx output.
#
# Branch and sha arrive as ARGUMENTS from the workflow's env: block, never
# interpolated into the script text. See publish.yml.
main() {
  local branch="${1:?branch required}" sha_full="${2:?sha required}"
  local tags floating calver full

  tags="$(derive "$branch" "$sha_full")"
  full="${tags%%$'\n'*}"
  full="${full##*:}"
  floating="${tags##*:}"
  calver="${full%-*}"

  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "tags<<TAGS_EOF"
      echo "$tags"
      echo "TAGS_EOF"
      echo "full=$full"
      echo "calver=$calver"
      echo "floating=$floating"
    } >>"$GITHUB_OUTPUT"
  fi

  echo "branch=$branch calver=$calver version=$full"
  echo "Will push:"
  while IFS= read -r tag; do echo "  $tag"; done <<<"$tags"
}

# Only run when executed, so the test file can source this and call the
# functions one at a time.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi

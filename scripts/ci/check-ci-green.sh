#!/usr/bin/env bash
#
# check-ci-green.sh — did CI pass on THIS EXACT COMMIT?
#
#   bash scripts/ci/check-ci-green.sh develop 81f8b3ad2f6aaa585a53cecf42ddc3514408276c
#
# .github/workflows/promote.yml calls it before it fast-forwards master, and
# scripts/ci/check-ci-green.test.ts executes it against recorded API responses.
#
# WHY "THIS EXACT COMMIT" IS THE ONLY SOUND QUESTION
#
# Promoting publishes :latest, which is what every installed user pulls. The
# claim that has to be true is "the code in this image passed CI" — not "CI is
# green on develop", which is a claim about whatever commit happened to be the
# tip when someone last looked. Those differ every time a merge lands while a
# run is in flight, and they differ in the dangerous direction: the newest
# commit is the untested one.
#
# So the run is identified by three fields together, all of which the GitHub
# API filters on and ALL OF WHICH ARE RE-CHECKED HERE in jq:
#
#   head_sha    == the commit being promoted   (not "the branch")
#   head_branch == the source branch           (not a run from some fork's PR)
#   event       == "push"                      (see below)
#
# The re-check is not paranoia about the server lying. It is about a query
# parameter being dropped: an unrecognised filter is IGNORED by this API, not
# rejected, so a typo in `head_sha` would return every run on the branch and a
# gate that only counted results would cheerfully accept an ancient green run.
# Filtering again on the returned objects makes that a zero-match refusal
# instead of a false pass.
#
# WHY event == "push" AND NOT pull_request
#
# A pull_request run checks out the MERGE of the head commit into the base, not
# the head commit. Its tree is not the tree that will sit on master. A push run
# on develop checks out the commit itself, so it is the only run whose success
# is a statement about the exact bytes being promoted.
#
# WHY THE NEWEST RUN DECIDES
#
# When several runs match (the same commit pushed twice, or a re-run), the most
# recent by run_number/run_attempt wins. "Some attempt once passed" is a weaker
# claim than "the current state of CI for this commit is green", and a re-run
# that went red is exactly the signal a promote gate exists to notice.
#
# EXIT CODES
#   0  the newest matching run completed successfully
#   1  no matching run, still running, or not successful
#   3  usage error, missing tooling, or an unreadable API response
#
set -euo pipefail

# The API response can be supplied from a file instead of the network. This is
# how the test file drives the script, and how a human can debug a refusal
# against a saved response.
#   BV_RUNS_JSON=/tmp/runs.json bash scripts/ci/check-ci-green.sh develop <sha>
: "${BV_RUNS_JSON:=}"
: "${BV_PROMOTE_REPO:=doomcrewinc/BlackVaultArmory}"
: "${BV_CI_WORKFLOW:=ci.yml}"

# ---------------------------------------------------------------------------
# fetch_runs <branch> <sha>
#
# Prints the raw "list workflow runs" response. gh needs GH_TOKEN; in Actions
# that is the job's GITHUB_TOKEN with `actions: read`.
fetch_runs() {
  local branch="$1" sha="$2"
  if [ -n "$BV_RUNS_JSON" ]; then
    cat "$BV_RUNS_JSON"
    return
  fi
  gh api -X GET "repos/$BV_PROMOTE_REPO/actions/workflows/$BV_CI_WORKFLOW/runs" \
    -f "branch=$branch" \
    -f "head_sha=$sha" \
    -f "event=push" \
    -f "per_page=100"
}

# ---------------------------------------------------------------------------
# matching_runs <json> <branch> <sha>
#
# The runs that are genuinely about this commit, newest first. Every filter the
# query asked the server for is applied again to what came back.
matching_runs() {
  jq -c --arg branch "$2" --arg sha "$3" '
    if (.workflow_runs | type) != "array" then
      error("response has no workflow_runs array")
    else
      [ .workflow_runs[]
        | select(.head_sha == $sha and .head_branch == $branch and .event == "push") ]
      | sort_by(.run_number, .run_attempt)
      | reverse
    end
  ' <<<"$1"
}

emit_outputs() {
  [ -n "${GITHUB_OUTPUT:-}" ] || return 0
  {
    echo "run_url=$1"
    echo "run_number=$2"
    echo "run_attempt=$3"
    echo "conclusion=$4"
  } >>"$GITHUB_OUTPUT"
}

# ---------------------------------------------------------------------------
# check <branch> <sha>
check() {
  local branch="$1" sha="$2"
  local raw runs count latest status conclusion url number attempt

  command -v jq >/dev/null 2>&1 || {
    echo "::error::jq is required by check-ci-green.sh" >&2
    return 3
  }

  if ! raw="$(fetch_runs "$branch" "$sha")"; then
    echo "::error::could not list $BV_CI_WORKFLOW runs for $BV_PROMOTE_REPO" >&2
    return 3
  fi

  if ! runs="$(matching_runs "$raw" "$branch" "$sha" 2>/dev/null)"; then
    echo "::error::unreadable response while looking for $BV_CI_WORKFLOW runs" >&2
    return 3
  fi

  count="$(jq 'length' <<<"$runs")"
  if [ "$count" -eq 0 ]; then
    {
      echo "::error::refusing to promote: no completed '$BV_CI_WORKFLOW' push run exists for ${sha:0:7} on $branch."
      echo ""
      echo "CI has never run on the exact commit being promoted, or it ran under a"
      echo "different event. :latest is what every installed user pulls; it does not"
      echo "get to come from an untested commit."
      echo ""
      echo "  https://github.com/$BV_PROMOTE_REPO/actions/workflows/$BV_CI_WORKFLOW?query=branch%3A$branch"
      echo ""
      echo "Push the branch (or re-run CI for $sha) and try again."
    } >&2
    emit_outputs "" "" "" "missing"
    return 1
  fi

  latest="$(jq -c '.[0]' <<<"$runs")"
  status="$(jq -r '.status // "unknown"' <<<"$latest")"
  conclusion="$(jq -r '.conclusion // "none"' <<<"$latest")"
  url="$(jq -r '.html_url // ""' <<<"$latest")"
  number="$(jq -r '.run_number // ""' <<<"$latest")"
  attempt="$(jq -r '.run_attempt // 1' <<<"$latest")"

  if [ "$status" != "completed" ]; then
    {
      echo "::error::refusing to promote: CI for ${sha:0:7} is '$status', not finished."
      echo "Wait for run #$number to finish, then run this workflow again."
      echo "  $url"
    } >&2
    emit_outputs "$url" "$number" "$attempt" "$status"
    return 1
  fi

  if [ "$conclusion" != "success" ]; then
    {
      echo "::error::refusing to promote: CI for ${sha:0:7} concluded '$conclusion'."
      echo "Run #$number (attempt $attempt) is the most recent CI run for this exact commit."
      echo "  $url"
      echo ""
      echo "Fix it on $branch and promote the fixed commit. Re-running CI until it"
      echo "goes green is also acceptable; this gate reads the newest attempt."
    } >&2
    emit_outputs "$url" "$number" "$attempt" "$conclusion"
    return 1
  fi

  echo "CI is green for ${sha:0:7} on $branch: run #$number attempt $attempt ($count matching run(s))"
  echo "  $url"
  emit_outputs "$url" "$number" "$attempt" "$conclusion"
  return 0
}

main() {
  local branch="${1:-}" sha="${2:-}"
  if [ -z "$branch" ] || [ -z "$sha" ]; then
    echo "usage: check-ci-green.sh <branch> <full-sha>" >&2
    return 3
  fi
  # A short sha would silently match nothing: the API compares head_sha whole.
  if [ "${#sha}" -ne 40 ]; then
    echo "::error::check-ci-green.sh needs the full 40-character sha, got '$sha'" >&2
    return 3
  fi
  check "$branch" "$sha"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi

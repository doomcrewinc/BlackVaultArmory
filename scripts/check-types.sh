#!/usr/bin/env bash
#
# `tsc --noEmit`, gated against a recorded baseline.
#
#   npm run typecheck
#
# WHY A BASELINE AND NOT A CLEAN GATE
#
# The tree does not typecheck clean: as of 2026-09-25 it has 16 errors, all of
# them in two TEST files and none in shipped code:
#
#   src/app/api/exports/data/route.backup.test.ts  14  (TS18048 possibly-undefined)
#   scripts/check-migration-drift.test.ts            2  (TS2741/TS2345 ProcessEnv)
#
# The options were: don't run tsc in CI at all (throws away a real gate on
# every future change), fail CI on day one (nobody can merge), or delete the
# errors by loosening tsconfig (hides them everywhere, including in src/).
# None of those is honest.
#
# So tsc runs for real, and the gate is: NO ERROR MAY APPEAR IN A FILE THAT IS
# NOT ON THE BASELINE LIST. A new type error anywhere else fails CI
# immediately. The baseline buys exactly two files a pass, and nothing more —
# it is not a count threshold, so adding a 15th error to route.backup.test.ts
# is still allowed but adding the first one to src/lib/date.ts is not.
#
# The baseline is also checked for ROT: if a baselined file stops producing
# errors, this fails and tells you to delete its line. That is what stops a
# temporary baseline becoming permanent.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

# Files allowed to still have type errors. Delete a line the moment its file
# is fixed — this script will tell you when that happens.
BASELINE_FILES=(
  "src/app/api/exports/data/route.backup.test.ts"
  "scripts/check-migration-drift.test.ts"
)

echo "==> tsc --noEmit -p ."
raw="$(npx tsc --noEmit -p . 2>&1)"
tsc_rc=$?

# Only lines of the form  path(line,col): error TSxxxx: ...  are errors.
# tsc continuation lines are indented and must not be counted or attributed.
errors="$(printf '%s\n' "$raw" | grep -E '^[^[:space:]].*\([0-9]+,[0-9]+\): error TS[0-9]+:' || true)"

if [ -z "$errors" ]; then
  if [ "$tsc_rc" -ne 0 ]; then
    echo "    ERROR: tsc exited $tsc_rc but printed no parseable errors:" >&2
    printf '%s\n' "$raw" >&2
    exit 1
  fi
  echo "    tsc is clean."
  if [ "${#BASELINE_FILES[@]}" -gt 0 ]; then
    echo "" >&2
    echo "    BASELINE IS STALE: the whole tree typechecks, so the baseline in" >&2
    echo "    scripts/check-types.sh is no longer needed. Delete BASELINE_FILES." >&2
    exit 1
  fi
  exit 0
fi

status=0
unexpected=""
total=0
declare -a seen_counts=()

for f in "${BASELINE_FILES[@]}"; do
  n="$(printf '%s\n' "$errors" | grep -cF "$f(" || true)"
  seen_counts+=("$n")
done

while IFS= read -r line; do
  [ -n "$line" ] || continue
  total=$((total + 1))
  file="${line%%(*}"
  baselined=0
  for f in "${BASELINE_FILES[@]}"; do
    if [ "$file" = "$f" ]; then baselined=1; break; fi
  done
  if [ "$baselined" -eq 0 ]; then
    unexpected="${unexpected}${line}"$'\n'
    status=1
  fi
done <<< "$errors"

echo "    $total error(s) total."
for i in "${!BASELINE_FILES[@]}"; do
  echo "    baselined: ${BASELINE_FILES[$i]} — ${seen_counts[$i]} error(s)"
done

# Baseline rot: a file on the list that no longer errors.
for i in "${!BASELINE_FILES[@]}"; do
  if [ "${seen_counts[$i]}" -eq 0 ]; then
    echo "" >&2
    echo "    BASELINE IS STALE: ${BASELINE_FILES[$i]} has no type errors any more." >&2
    echo "    Remove it from BASELINE_FILES in scripts/check-types.sh so it can" >&2
    echo "    never silently regress." >&2
    status=1
  fi
done

if [ -n "$unexpected" ]; then
  echo "" >&2
  echo "    NEW TYPE ERRORS outside the baseline:" >&2
  printf '%s' "$unexpected" >&2
  echo "" >&2
  echo "    Fix them. Do not add the file to BASELINE_FILES to make this pass." >&2
fi

if [ "$status" -eq 0 ]; then
  echo "    ok: every error is inside the recorded baseline."
fi
exit "$status"

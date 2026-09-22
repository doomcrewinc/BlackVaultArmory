#!/usr/bin/env bash
#
# Fails when a provider's migration history does not produce its schema.
#
# Both providers ship in every image, so a schema change needs a migration in
# BOTH prisma/sqlite/migrations and prisma/postgres/migrations. A migration made
# for one provider only ships runtime errors to every user of the other.
#
#   npm run db:check-drift
#
# SQLite is always checked, against a throw-away shadow file. PostgreSQL is
# checked only when SHADOW_DATABASE_URL points at a scratch Postgres database
# (Prisma wipes it); otherwise it is skipped with a message. It is refused
# when it equals DATABASE_URL or POSTGRES_URL, or when its database name does
# not have shadow, scratch or test as a word (split by _ or -).

# Prisma WIPES the shadow database. Refuse anything that could be a real one:
# the app's or the migrator's database, or any database whose name does not
# say it is disposable. The name must contain shadow, scratch or test as a
# whole token, delimited by _ or - (blackvault_shadow, test_db, scratch), so
# names that merely contain the letters (latest, contest) are refused.
SHADOW_NAME_RE='(^|[_-])(shadow|scratch|test)([_-]|$)'

refuse_shadow() {
  echo "==> postgres: REFUSED. SHADOW_DATABASE_URL $1" >&2
  echo "    Prisma wipes the shadow database, so it must be a throw-away one whose" >&2
  echo "    name has shadow, scratch or test as a word (split by _ or -), e.g." >&2
  echo "    SHADOW_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/blackvault_shadow" >&2
  exit 1
}

guard_shadow() {
  local shadow="$1" name
  if [ -n "${DATABASE_URL:-}" ] && [ "$shadow" = "$DATABASE_URL" ]; then
    refuse_shadow "is the same as DATABASE_URL."
  fi
  if [ -n "${POSTGRES_URL:-}" ] && [ "$shadow" = "$POSTGRES_URL" ]; then
    refuse_shadow "is the same as POSTGRES_URL."
  fi
  # Database name: the path after the host, without any ?query.
  name="${shadow%%\?*}"
  name="${name#*://}"
  case "$name" in
    */*) name="${name##*/}" ;;
    *) name="" ;;
  esac
  name="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  if ! [[ "$name" =~ $SHADOW_NAME_RE ]]; then
    refuse_shadow "names database '${name:-<none>}', which does not have shadow, scratch or test as a word."
  fi
}

# Sourced (by the tests): define the guard only, run nothing.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

set -euo pipefail

cd "$(dirname "$0")/.."

PRISMA="npx prisma"
status=0

check() {
  local provider="$1" shadow="$2"
  echo "==> $provider: prisma/$provider/migrations vs prisma/$provider/schema.prisma"
  set +e
  $PRISMA migrate diff \
    --from-migrations "prisma/$provider/migrations" \
    --to-schema-datamodel "prisma/$provider/schema.prisma" \
    --shadow-database-url "$shadow" \
    --script \
    --exit-code
  local rc=$?
  set -e
  case "$rc" in
    0) echo "    ok: no drift" ;;
    2)
      echo "    DRIFT: the $provider schema has changes no migration creates (SQL above)." >&2
      echo "    Create the $provider migration; see \"Changing the schema\" in CONTRIBUTING.md." >&2
      status=1
      ;;
    *)
      echo "    ERROR: prisma migrate diff failed for $provider (exit $rc)." >&2
      status=1
      ;;
  esac
}

# Checked before anything runs.
if [ -n "${SHADOW_DATABASE_URL:-}" ]; then
  guard_shadow "$SHADOW_DATABASE_URL"
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

check sqlite "file:$tmpdir/shadow.db"

if [ -n "${SHADOW_DATABASE_URL:-}" ]; then
  check postgres "$SHADOW_DATABASE_URL"
else
  echo "==> postgres: SKIPPED. Set SHADOW_DATABASE_URL to a scratch PostgreSQL database"
  echo "    (it is wiped) to check prisma/postgres/migrations, e.g."
  echo "    SHADOW_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/blackvault_shadow npm run db:check-drift"
fi

exit "$status"

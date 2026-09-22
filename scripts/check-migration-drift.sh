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
# (Prisma wipes it); otherwise it is skipped with a message.

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

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

check sqlite "file:$tmpdir/shadow.db"

if [ -n "${SHADOW_DATABASE_URL:-}" ]; then
  check postgres "$SHADOW_DATABASE_URL"
else
  echo "==> postgres: SKIPPED. Set SHADOW_DATABASE_URL to a scratch PostgreSQL database"
  echo "    (it is wiped) to check prisma/postgres/migrations, e.g."
  echo "    SHADOW_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/shadow npm run db:check-drift"
fi

exit "$status"

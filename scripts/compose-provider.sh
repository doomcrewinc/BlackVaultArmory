# shellcheck shell=bash
#
# Shared by install.sh and update.sh: the single place that maps the
# DB_PROVIDER recorded in .env to a compose file. Source it; do not run it.

# Provider recorded in an existing .env. Installs made before PostgreSQL
# support have no DB_PROVIDER line (or no .env at all) and were always SQLite.
provider_from_env() {
  local value=""
  if [ -f .env ]; then
    value=$(grep "^DB_PROVIDER=" .env | tail -n 1 | cut -d'=' -f2- | tr -d '[:space:]"'"'" | tr '[:upper:]' '[:lower:]' || true)
  fi
  case "$value" in
    "" | sqlite) echo "sqlite" ;;
    postgresql) echo "postgres" ;;
    *) echo "$value" ;;
  esac
}

# Compose file for a database provider. PostgreSQL is the default.
compose_file_for() {
  if [ "$1" = "sqlite" ]; then
    echo "docker-compose.sqlite.yml"
  else
    echo "docker-compose.yml"
  fi
}

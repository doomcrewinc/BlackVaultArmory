# shellcheck shell=bash
#
# Shared by install.sh and update.sh: reads the database provider recorded in
# .env. Source it; do not run it. install.bat and update.bat mirror it.
#
# There is only one compose file, so nothing here picks a file: plain
# `docker compose` reads .env, and COMPOSE_PROFILES=postgres in .env is what
# turns PostgreSQL on. The provider is only used for the preflight checks.
#
# The database keys in .env are BLACKVAULT_DB_PROVIDER, BLACKVAULT_POSTGRES_PASSWORD
# and BLACKVAULT_DATABASE_URL, never the generic names: Compose lets a variable
# exported in the shell override .env, and DATABASE_URL is commonly exported.
# docker-compose.yml maps them to the names the container uses.

# The .env reader. Docker Compose is what finally uses the file, so a line is
# read the way Compose reads it:
#   KEY=value            export KEY=value        KEY = value
#   KEY="value"          KEY='value'             (the quotes removed; text
#                                                 after the closing one dropped)
#   KEY=value # comment                          (cut at the first space-#)
# with leading whitespace, a UTF-8 BOM on the first line and CRLF line endings
# allowed, lines starting with # ignored, and the LAST assignment of a key
# winning. The file is never evaluated.
#
# Compose also changes some values in ways this reader does not implement. A
# line of that kind is UNREADABLE: no value is returned for it (never the text
# as written, which is not what Compose will use), and env_unreadable is true:
#   - a $ in an unquoted or double-quoted value (Compose substitutes $VAR);
#   - a \ in a double-quoted value (Compose unescapes \n, \r, \t, \" ...);
#   - KEY: value (the YAML form);
#   - a quote that is not closed on its line (Compose reads on to the next).
# Single-quoted values are literal in Compose, $ and \ included, and so are
# backslashes in an unquoted value: a Windows path is read in both forms.

# env_read KEY: parses ./.env and sets ENV_STATE to unset, set or unreadable
# for the last assignment of KEY, and ENV_VALUE to its value (empty unless
# set). Use env_value / env_has_key / env_unreadable; a `$( )` runs in a
# subshell, so these two variables do not come back out of one.
env_read() {
  local key="$1" line name rest quote first=1
  ENV_STATE="unset"
  ENV_VALUE=""
  if [[ ! -f .env ]]; then
    return 0
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ $first -eq 1 ]]; then
      first=0
      line=${line#$'\xef\xbb\xbf'}
    fi
    line=${line%$'\r'}
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      "#"*) continue ;;
      export[[:space:]]*)
        line=${line#export}
        line="${line#"${line%%[![:space:]]*}"}"
        ;;
    esac
    # The key ends at the first = or : (Compose accepts either).
    name=${line%%[=:]*}
    if [[ "$name" == "$line" ]]; then
      continue
    fi
    rest=${line:${#name}}
    name="${name%"${name##*[![:space:]]}"}"
    if [[ "$name" != "$key" ]]; then
      continue
    fi
    ENV_VALUE=""
    if [[ "${rest:0:1}" == ":" ]]; then
      ENV_STATE="unreadable"
      continue
    fi
    ENV_STATE="set"
    rest=${rest:1}
    rest="${rest#"${rest%%[![:space:]]*}"}"
    quote=${rest:0:1}
    if [[ "$quote" == "'" || "$quote" == '"' ]]; then
      rest=${rest:1}
      if [[ "$rest" != *"$quote"* ]]; then
        ENV_STATE="unreadable"
        continue
      fi
      rest=${rest%%"$quote"*}
      if [[ "$quote" == '"' && ( "$rest" == *'$'* || "$rest" == *\\* ) ]]; then
        ENV_STATE="unreadable"
        continue
      fi
      ENV_VALUE=$rest
    else
      # Unquoted: a # after a space starts a comment (a tab does not, and
      # neither does a # that opens the value).
      rest=${rest%%" #"*}
      rest="${rest%"${rest##*[![:space:]]}"}"
      if [[ "$rest" == *'$'* ]]; then
        ENV_STATE="unreadable"
        continue
      fi
      ENV_VALUE=$rest
    fi
  done < .env
  return 0
}

# Value of KEY in ./.env, as described above. Inner spaces are kept, so
# DATA_DIR paths with spaces survive. Empty when unset, when there is no .env,
# and when the line is unreadable: ask env_unreadable to tell that case apart.
env_value() {
  env_read "$1"
  printf '%s\n' "$ENV_VALUE"
}

# 0 when ./.env assigns KEY, even to nothing or in an unreadable form.
env_has_key() {
  env_read "$1"
  [[ "$ENV_STATE" != "unset" ]]
}

# 0 when the last assignment of KEY in ./.env is in a form this reader does
# not read (see the list above). Callers must not fall back to a default then.
env_unreadable() {
  env_read "$1"
  [[ "$ENV_STATE" == "unreadable" ]]
}

# One line (no newline at its end) saying that KEY is unreadable, why a line
# is, and how to write it so that it is read.
env_unreadable_text() {
  printf '%s' "$1 in .env could not be read: the line holds a \$, a \\ inside double quotes, '$1: value', or a quote that is not closed. Write it as $1=value or $1='value', with the final value spelled out."
}

# env_require_readable KEY [WHAT WAS NOT DONE]: returns 1, after an ERROR
# saying the above, when KEY is unreadable; 0 otherwise.
env_require_readable() {
  if env_unreadable "$1"; then
    echo "ERROR: $(env_unreadable_text "$1")"
    if [[ -n "${2:-}" ]]; then
      echo "       $2"
    fi
    return 1
  fi
  return 0
}

# Provider recorded in an existing .env. Installs made before PostgreSQL
# support have no BLACKVAULT_DB_PROVIDER line (or no .env at all) and were
# always SQLite. A plain DB_PROVIDER line is ignored, as docker-compose.yml
# ignores it. Prints "unreadable" when the line cannot be read: SQLite must
# not be assumed then.
provider_from_env() {
  local value
  if env_unreadable BLACKVAULT_DB_PROVIDER; then
    echo "unreadable"
    return 0
  fi
  value=$(env_value BLACKVAULT_DB_PROVIDER | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  case "$value" in
    "" | sqlite) echo "sqlite" ;;
    postgresql) echo "postgres" ;;
    *) echo "$value" ;;
  esac
}

# Prints a warning when .env says PostgreSQL but lacks a key the single
# compose file needs to actually run it. Returns 0 when complete. A key whose
# line is unreadable is there, so it is not called missing; it is listed as
# not checked instead.
check_postgres_env() {
  local missing="" unchecked=""
  if env_unreadable COMPOSE_PROFILES; then
    unchecked="$unchecked COMPOSE_PROFILES"
  else
    case ",$(env_value COMPOSE_PROFILES | tr -d '[:space:]')," in
      *,postgres,*) ;;
      *) missing="$missing COMPOSE_PROFILES=postgres" ;;
    esac
  fi
  if env_unreadable BLACKVAULT_POSTGRES_PASSWORD; then
    unchecked="$unchecked BLACKVAULT_POSTGRES_PASSWORD"
  elif [[ -z "$(env_value BLACKVAULT_POSTGRES_PASSWORD)" ]]; then
    missing="$missing BLACKVAULT_POSTGRES_PASSWORD"
  fi
  if env_unreadable BLACKVAULT_DATABASE_URL; then
    unchecked="$unchecked BLACKVAULT_DATABASE_URL"
  else
    case "$(env_value BLACKVAULT_DATABASE_URL)" in
      postgres://* | postgresql://*) ;;
      *) missing="$missing BLACKVAULT_DATABASE_URL=postgresql://..." ;;
    esac
  fi
  if [[ -n "$unchecked" ]]; then
    echo "Note: these .env lines hold a \$ or another form this script does not read, so they cannot be checked:$unchecked"
  fi
  [ -z "$missing" ] && return 0
  echo "⚠  WARNING: .env says BLACKVAULT_DB_PROVIDER=postgres but is missing:$missing"
  echo "   A PostgreSQL install needs all four of these in .env:"
  echo "     COMPOSE_PROFILES=postgres"
  echo "     BLACKVAULT_DB_PROVIDER=postgres"
  echo "     BLACKVAULT_POSTGRES_PASSWORD=<48 hex characters>"
  echo "     BLACKVAULT_DATABASE_URL=postgresql://blackvault:<same password>@db:5432/blackvault"
  echo "   See .env.example. If this is a SQLite install, set BLACKVAULT_DB_PROVIDER=sqlite instead."
  return 1
}

# Health of the blackvault container, read from the Status column of
# `docker compose ps`: "Up 2 minutes (healthy)", "(unhealthy)" or
# "(health: starting)". Prints healthy, unhealthy or starting; prints nothing
# when the container is not listed or reports no health. Needs $COMPOSE.
# install.bat and update.bat mirror it in :health_status.
container_health() {
  local status
  status=$($COMPOSE ps --format '{{.Status}}' blackvault 2>/dev/null) || status=""
  case "$status" in
    *"(healthy)"*) echo "healthy" ;;
    *"(unhealthy)"*) echo "unhealthy" ;;
    *"(health: starting)"*) echo "starting" ;;
  esac
  return 0
}

# ── Docker Compose version floor ─────────────────────────────
# docker-compose.yml uses depends_on.required: false (so the db service can be
# off on SQLite). That needs Docker Compose v2.20 or newer: older v2 rejects
# the file, and v1 (`docker-compose`) cannot parse it. install.bat and
# update.bat mirror this check in :require_compose.
COMPOSE_MIN_VERSION="2.20"

# 0 when the version string (e.g. "2.29.7", "v2.20.0", "5.1.2", as printed
# by `docker compose version --short`) is at least COMPOSE_MIN_VERSION.
# Anything unparseable, including a v1 "docker-compose version 1.29.2, ..."
# line, fails.
compose_version_ok() {
  local v="${1:-}" major minor rest
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  v="${v#[vV]}"
  major="${v%%.*}"
  rest="${v#*.}"
  [ "$rest" != "$v" ] || return 1
  minor="${rest%%[!0-9]*}"
  case "$major" in "" | *[!0-9]*) return 1 ;; esac
  [ -n "$minor" ] || return 1
  major=$((10#$major))
  minor=$((10#$minor))
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 20 ]; }
}

# Sets COMPOSE="docker compose", or prints why not and exits 1. Call it before
# touching anything. The v1 `docker-compose` fallback is gone on purpose.
require_compose() {
  local version
  if ! version=$(docker compose version --short 2>/dev/null) || [ -z "$version" ]; then
    echo "ERROR: BlackVault needs Docker Compose v$COMPOSE_MIN_VERSION or newer, run as"
    echo "       'docker compose' (the Compose v2 plugin)."
    if command -v docker-compose >/dev/null 2>&1; then
      echo "       Only the old 'docker-compose' ($(docker-compose version --short 2>/dev/null || echo v1)) was found;"
      echo "       it cannot read BlackVault's docker-compose.yml."
    fi
    echo "       Upgrade Docker Desktop, or on Linux install the docker-compose-plugin"
    echo "       package: https://docs.docker.com/compose/install/linux/"
    echo "       Nothing was changed."
    exit 1
  fi
  if ! compose_version_ok "$version"; then
    echo "ERROR: Docker Compose $version is too old. BlackVault needs v$COMPOSE_MIN_VERSION or newer."
    echo "       Upgrade Docker Desktop, or on Linux update the docker-compose-plugin"
    echo "       package: https://docs.docker.com/compose/install/linux/"
    echo "       Nothing was changed."
    exit 1
  fi
  # shellcheck disable=SC2034 # read by install.sh / update.sh, which source this file
  COMPOSE="docker compose"
}

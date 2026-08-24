#!/usr/bin/env bash
#
# Builds a throwaway Postgres database from the migrations, dropping whatever
# was there before.
#
#   test/build-db.sh star_voting_test
#
# Split out of run.sh because the tally suite is no longer the only thing that
# needs a database built from the migrations: scripts/sample-poll.sh builds one
# too, to record the About page's sample result from the real tally rather than
# from a second implementation of it. Both want the same database, and a second
# copy of these twenty lines is a second place for the shim and the extension
# filter to drift.

set -euo pipefail

cd "$(dirname "$0")/.."

DB="${1:?usage: test/build-db.sh <database>}"

red() { printf '\033[31m%s\033[0m\n' "$1"; }

# Everything below needs a server and a role that can create databases, and
# reaching one is the first thing that goes wrong on a machine that has never
# run this. So it is handled here rather than in each caller: `npm test` and
# scripts/sample-poll.sh both arrive through this file, and only one of them
# used to say anything useful when there was nothing to connect to.
if ! pg_isready -q 2>/dev/null; then
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    echo "Postgres is not running; starting the local cluster..."
    pg_ctlcluster "$(pg_lsclusters -h | awk 'NR==1{print $1}')" \
                  "$(pg_lsclusters -h | awk 'NR==1{print $2}')" start
  elif command -v brew >/dev/null 2>&1 && brew list --formula 2>/dev/null | grep -q '^postgresql'; then
    echo "Postgres is not running; starting the Homebrew service..."
    brew services start "$(brew list --formula | grep -m1 '^postgresql')"
    # `brew services start` returns before the server is accepting
    # connections, so wait for it rather than failing on the next line.
    for _ in $(seq 30); do
      pg_isready -q 2>/dev/null && break
      sleep 1
    done
  fi
fi

if ! pg_isready -q 2>/dev/null; then
  red "No Postgres server reachable, and none I know how to start."
  red ""
  red "  macOS, Homebrew:  brew install postgresql@16 && brew services start postgresql@16"
  red "  macOS, app:       install Postgres.app from https://postgresapp.com and open it"
  red "  Debian/Ubuntu:    sudo apt install postgresql && sudo pg_ctlcluster 16 main start"
  red ""
  red "Or point PGHOST/PGPORT/PGUSER/PGPASSWORD at a server you already have."
  exit 1
fi

# A Debian-packaged Postgres authenticates local connections by operating
# system user, so a freshly installed one is running but has no role for
# whoever is running this -- every psql call below would fail on "role does
# not exist". Create the role instead of leaving each caller to work it out.
# Anywhere the connection already works, including CI and a Homebrew install
# (which makes a role named after you), this does nothing.
if ! psql -XtAqd postgres -c 'select 1' >/dev/null 2>&1; then
  me="$(id -un)"
  if command -v sudo >/dev/null 2>&1 && sudo -n -u postgres psql -XtAqc 'select 1' >/dev/null 2>&1; then
    echo "No Postgres role for '$me'; creating one."
    sudo -u postgres psql -qc "create role \"$me\" superuser login"
  elif [[ "$(id -u)" -eq 0 ]] && su postgres -c 'psql -XtAqc "select 1"' >/dev/null 2>&1; then
    echo "No Postgres role for '$me'; creating one."
    su postgres -c "psql -qc 'create role \"$me\" superuser login'"
  else
    red "Cannot connect to Postgres as '$me'."
    red "Create a role for yourself:"
    red ""
    red "  sudo -u postgres psql -c 'create role \"$me\" superuser login'"
    red ""
    red "or set PGUSER and PGPASSWORD to a role that already exists."
    exit 1
  fi
fi

MIGRATIONS_DIR="supabase/migrations"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

# Extensions that only exist on a Supabase instance, and that nothing under
# test uses. pg_stat_statements is real but needs shared_preload_libraries, so
# it goes too rather than making every contributor edit postgresql.conf, and
# pg_cron needs the same -- the only thing it schedules here is
# purge_old_polls(), which the retention case calls directly.
UNAVAILABLE='^CREATE EXTENSION.*(pg_cron|pg_net|supabase_vault|pg_stat_statements)'

# Rewrites one migration into something a stock Postgres will accept. Two
# edits: the extensions above, and the MAINTAIN privilege, which Postgres 17
# added and which a 16 server rejects -- the dump comes from Supabase, which
# runs ahead. Neither touches a grant or a rule these tests exercise, and
# everything the tally depends on is applied verbatim.
prepare_migration() {
  grep -viE "$UNAVAILABLE" "$1" | sed -E '/GRANT /s/,MAINTAIN//g'
}

dropdb --if-exists "$DB"
createdb "$DB"

psql -v ON_ERROR_STOP=1 -q -d "$DB" -v db="$DB" -f test/sql/shim.sql

for migration in "$MIGRATIONS_DIR"/*.sql; do
  prepared="$BUILD_DIR/$(basename "$migration")"
  prepare_migration "$migration" > "$prepared"
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$prepared" >/dev/null
done

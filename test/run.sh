#!/usr/bin/env bash
#
# Builds a throwaway Postgres database from the migrations and runs every case
# in test/sql/cases against it.
#
#   test/run.sh                 # all cases
#   test/run.sh runoff          # only cases whose filename matches "runoff"
#
# Needs a Postgres server and a role that may create databases. Point PGHOST,
# PGUSER and friends at one, or let it use the local cluster.

set -euo pipefail

cd "$(dirname "$0")/.."

DB="${TEST_DB:-star_voting_test}"
FILTER="${1:-}"

MIGRATIONS_DIR="supabase/migrations"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

# Extensions that only exist on a Supabase instance, and that nothing under
# test uses. pg_stat_statements is real but needs shared_preload_libraries, so
# it goes too rather than making every contributor edit postgresql.conf.
UNAVAILABLE='^CREATE EXTENSION.*(pg_net|supabase_vault|pg_stat_statements)'

# Rewrites one migration into something a stock Postgres will accept. Two
# edits: the extensions above, and the MAINTAIN privilege, which Postgres 17
# added and which a 16 server rejects -- the dump comes from Supabase, which
# runs ahead. Neither touches a grant or a rule these tests exercise, and
# everything the tally depends on is applied verbatim.
prepare_migration() {
  grep -viE "$UNAVAILABLE" "$1" | sed -E '/GRANT /s/,MAINTAIN//g'
}

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }

# Turns psql's output into a readable list of assertions: drop the file:line
# prefix psql puts on every notice, drop the tally's own bookkeeping chatter,
# and mark the line that failed.
report() {
  grep -v 'does not exist, skipping' \
    | sed -E 's/^psql:[^ ]+ NOTICE:  ?//' \
    | sed -E 's/^psql:[^ ]+ ERROR:  /    FAILED  /'
}

if ! pg_isready -q 2>/dev/null; then
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    echo "Postgres is not running; starting the local cluster..."
    pg_ctlcluster "$(pg_lsclusters -h | awk 'NR==1{print $1}')" \
                  "$(pg_lsclusters -h | awk 'NR==1{print $2}')" start
  else
    red "No Postgres server reachable. Start one, or set PGHOST/PGPORT/PGUSER."
    exit 1
  fi
fi

# A Debian-packaged Postgres authenticates local connections by operating
# system user, so a freshly installed one is running but has no role for
# whoever is running this -- every psql call below would fail on "role does
# not exist". Create the role instead of leaving each caller to work it out.
# Anywhere the connection already works, including CI, this does nothing.
if ! psql -XtAqd postgres -c 'select 1' >/dev/null 2>&1; then
  me="$(id -un)"
  if [[ "$(id -u)" -eq 0 ]] && su postgres -c 'psql -XtAqc "select 1"' >/dev/null 2>&1; then
    echo "No Postgres role for '$me'; creating one."
    su postgres -c "psql -qc 'create role \"$me\" superuser login'"
  else
    red "Cannot connect to Postgres as '$me'."
    red "Set PGUSER and PGPASSWORD, or create a Postgres role for this user."
    exit 1
  fi
fi

echo "Building $DB from $MIGRATIONS_DIR ..."
dropdb --if-exists "$DB"
createdb "$DB"

psql -v ON_ERROR_STOP=1 -q -d "$DB" -v db="$DB" -f test/sql/shim.sql

for migration in "$MIGRATIONS_DIR"/*.sql; do
  prepared="$BUILD_DIR/$(basename "$migration")"
  prepare_migration "$migration" > "$prepared"
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$prepared" >/dev/null
done

psql -v ON_ERROR_STOP=1 -q -d "$DB" -f test/sql/helpers.sql

echo

passed=0
failed=0
failures=()

for case_file in test/sql/cases/*.sql; do
  name="$(basename "$case_file" .sql)"

  if [[ -n "$FILTER" && "$name" != *"$FILTER"* ]]; then
    continue
  fi

  echo "$name"

  # Each case rolls back, so cases cannot see each other's polls. Notices carry
  # the per-assertion output, so they are the point rather than noise -- except
  # for the tally's own "drop table if exists" chatter, which is dropped.
  if output=$(psql -v ON_ERROR_STOP=1 -v VERBOSITY=terse -q -d "$DB" -P pager=off \
                   -f "$case_file" 2>&1); then
    echo "$output" | report
    passed=$((passed + 1))
  else
    echo "$output" | report
    failed=$((failed + 1))
    failures+=("$name")
  fi
  echo
done

if [[ $failed -gt 0 ]]; then
  red "$failed failed, $passed passed"
  for name in "${failures[@]}"; do
    red "  - $name"
  done
  exit 1
fi

if [[ $passed -eq 0 ]]; then
  red "No cases matched ${FILTER:-*}"
  exit 1
fi

green "$passed passed"

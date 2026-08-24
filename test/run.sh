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

echo "Building $DB from supabase/migrations ..."
test/build-db.sh "$DB"

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

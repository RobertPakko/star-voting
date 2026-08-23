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

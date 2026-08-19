-- Polls are kept for six months, and then they are deleted.
--
-- Nothing in this app has ever removed a poll it was not told to remove, so
-- every poll ever created is still in the database, and the bill for storing
-- them only goes one way. The app is free and promises nothing about keeping
-- a poll forever; what it should promise instead is a rule that is written
-- down, applied to every poll alike, and visible on the poll itself before
-- it comes due. That rule is here, and the poll page reads it back out of
-- poll_status().
--
-- **Six months from its creation, and from nothing else.** Dating the window
-- from the poll's last activity instead was tried and rejected: an open poll
-- takes votes from anyone holding the link and nobody has to close it, so
-- "six months since something happened" is a window that a single stray vote
-- reopens and that a forgotten poll never reaches at all -- which is the
-- exact poll this exists to clear out. Creation is a date every poll has,
-- that nothing can move, and that a creator can read off the poll page on
-- the day they make it. A poll that has to outlive its six months is
-- duplicated into a new one, which is a button the creator already has.
--
-- Deleting the polls row is the whole of it. Every table that hangs off a
-- poll (candidates, invited_voters, ballots, and scores under those) is
-- ON DELETE CASCADE, which is also what the creator's own Delete poll button
-- relies on, so there is one definition of what deleting a poll means and
-- this uses it.
--
-- Scheduling is pg_cron, guarded twice. The extension only exists on a real
-- Supabase project -- the throwaway database the test suite builds has no
-- pg_cron and no cron schema -- and a migration that fell over there would
-- take every test with it. Both blocks below therefore degrade to a notice,
-- which leaves purge_old_polls() defined and tested everywhere and scheduled
-- where there is a scheduler. If the job is ever missing on the live project
-- (pg_cron not enabled when this migration ran), enabling the extension and
-- re-running the DO block below is the whole fix -- see AGENTS.md.

CREATE OR REPLACE FUNCTION "public"."poll_retention_window"() RETURNS interval
    LANGUAGE "sql" IMMUTABLE
    AS $$ select interval '6 months' $$;


ALTER FUNCTION "public"."poll_retention_window"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."poll_retention_window"() IS 'How long a poll is kept after it is created. The one place the retention period is written down.';

-- The purge and the poll page must agree to the second about when a poll
-- goes, so neither computes it: both ask this.
REVOKE ALL ON FUNCTION "public"."poll_retention_window"() FROM PUBLIC;


CREATE OR REPLACE FUNCTION "public"."poll_expires_at"("p_poll" "public"."polls") RETURNS timestamp with time zone
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  -- Nothing that happens in the poll afterwards moves this: not a vote, not
  -- the option list being settled, not the creator closing it. The date a
  -- poll will be deleted is fixed on the day it is created, which is what
  -- lets the poll page state it from that day on and never revise it.
  select p_poll.created_at + poll_retention_window();
$$;


ALTER FUNCTION "public"."poll_expires_at"("p_poll" "public"."polls") OWNER TO "postgres";

-- Takes a poll row, so it answers for any poll the caller can already read;
-- poll_status() checks that first and is the only way the app reaches it.
REVOKE ALL ON FUNCTION "public"."poll_expires_at"("p_poll" "public"."polls") FROM PUBLIC;


-- The purge scans polls by age, and nothing else ever has. Without this it
-- is a sequential scan over every poll ever created -- which is precisely
-- the number this migration exists to stop growing.
CREATE INDEX IF NOT EXISTS "idx_polls_created_at" ON "public"."polls" USING "btree" ("created_at");


CREATE OR REPLACE FUNCTION "public"."purge_old_polls"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deleted int;
begin
  with expired as (
    delete from polls p
    -- The same test poll_expires_at() states, rearranged onto the bare
    -- column so the index above can answer it. The second half is that
    -- function itself, kept as the authority: whatever date the poll page
    -- showed a reader is the date this acts on, and a rewrite of one that
    -- drifted from the other would delete a poll the app promised was safe.
    where p.created_at <= now() - poll_retention_window()
      and poll_expires_at(p) <= now()
    returning 1
  )
  select count(*)::int into v_deleted from expired;

  return v_deleted;
end;
$$;


ALTER FUNCTION "public"."purge_old_polls"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."purge_old_polls"() IS 'Deletes every poll past its retention window, cascading to its options, invitees and ballots. Returns how many polls went. Scheduled nightly by pg_cron.';

-- Nobody calls this but the scheduler and whoever is holding the SQL editor.
-- It deletes other people's polls, so no application role gets near it.
REVOKE ALL ON FUNCTION "public"."purge_old_polls"() FROM PUBLIC;


DO $$
begin
  create extension if not exists "pg_cron";
exception when others then
  -- Any stock Postgres, including the one the tests build. Everything above
  -- this line is already in place; only the schedule is missing.
  raise notice 'pg_cron unavailable (%); purge_old_polls() is defined but not scheduled', sqlerrm;
end $$;


DO $$
begin
  if to_regnamespace('cron') is null then
    return;
  end if;

  -- Unscheduled first rather than relying on cron.schedule() replacing a job
  -- by name, so re-running this by hand cannot leave two jobs purging.
  perform cron.unschedule(jobid) from cron.job where jobname = 'purge-old-polls';

  -- Nightly, at an hour nobody is running a poll in, and off the hour: a
  -- schedule shared with every other cron job in the world is the one that
  -- competes for the database's attention.
  perform cron.schedule('purge-old-polls', '17 4 * * *', $cron$select public.purge_old_polls()$cron$);
end $$;


-- poll_status() gains the date, because the page that has to say "this poll
-- will be deleted on ..." is already asking it everything else about the
-- poll. It is one more column on a call the page makes anyway rather than a
-- request of its own -- and one that never changes, so the page reading it
-- on a timer costs nothing and can never show two different dates.
--
-- A browser running ahead of this migration (the app deploys on push, the
-- migration applies on merge) reads the column as undefined and says
-- nothing, which is why this rides on poll_status rather than on the
-- select the page makes against the polls table -- a select naming a column
-- the database does not have yet fails outright, and would take the poll
-- page with it.
DROP FUNCTION IF EXISTS "public"."poll_status"("p_poll_id" "uuid");

CREATE OR REPLACE FUNCTION "public"."poll_status"("p_poll_id" "uuid") RETURNS TABLE("invited_count" integer, "voted_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean, "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_invited int;
  v_voted int;
  v_closed boolean;
begin
  -- The whole row now, since poll_expires_at() takes one. The visibility
  -- test is unchanged: the poll is yours, or you were invited to it.
  select p.* into v_poll
  from polls p
  where p.id = p_poll_id
    and (
      p.created_by = auth.uid()
      or exists (select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email)
    );

  if not found then
    raise exception 'Poll not found';
  end if;

  select count(*)::int into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*)::int into v_voted from ballots where poll_id = p_poll_id;
  v_closed := v_poll.closed_at is not null;

  return query select
    v_invited,
    v_voted,
    v_invited > 0 and v_voted >= v_invited,
    exists (select 1 from ballots where poll_id = p_poll_id and voter_id = auth.uid()),
    v_closed,
    -- A closed poll with zero ballots has nothing to show.
    v_voted > 0 and (
      v_closed or (v_poll.mode = 'invite' and v_invited > 0 and v_voted >= v_invited)
    ),
    v_poll.solicit_options and v_poll.options_finalized_at is null and v_poll.closed_at is null,
    poll_expires_at(v_poll);
end;
$$;


ALTER FUNCTION "public"."poll_status"("p_poll_id" "uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_status"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_status"("p_poll_id" "uuid") TO "authenticated";

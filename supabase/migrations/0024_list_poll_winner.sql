-- The poll list says how each poll ended, not just that it ended.
--
-- "Results ready" told a reader there was something to go and look at,
-- which on a list of finished polls is every row saying the same thing. The
-- one fact worth carrying back to the list is the result itself, so
-- list_polls() gains winner_name: the option STAR elected, null on every
-- poll whose results have not unlocked and on the genuine tie that elects
-- nobody.
--
-- It is derived, not stored. A winner column would be a second copy of an
-- answer the ballots already hold, and every path that changes the ballots
-- -- submit, reset, a late invite -- would have to remember to keep it
-- true. poll_winner_name() runs the same star_round() the results page
-- runs, so the badge on the list and the winner on the poll page cannot
-- disagree: there is one implementation of the method and this is a second
-- caller of it, not a second implementation.
--
-- Two things keep the cost of that honest:
--
--   * It is only asked of polls whose results have already unlocked. The
--     CASE guarding the call is not a tidiness -- it is what stops a list
--     of open polls from running an election per row per refresh.
--   * A poll whose results are out has taken its last vote, so the answer
--     never changes once it exists.
--
-- star_round() builds a temp table, so it is volatile, and a STABLE
-- function may not promise more than what it calls. list_polls() is
-- declared volatile to match. Nothing about how it is called changes:
-- PostgREST reaches it by POST either way.

CREATE OR REPLACE FUNCTION "public"."poll_winner_name"("p_poll_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_pool uuid[];
  v_winner uuid;
begin
  -- No ballots, no election. Every caller checks this first anyway; the
  -- point of repeating it is that star_round() would otherwise elect the
  -- highest-scoring option of an empty tally.
  if not exists (select 1 from ballots where poll_id = p_poll_id) then
    return null;
  end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into v_pool
  from candidates where poll_id = p_poll_id;

  if coalesce(array_length(v_pool, 1), 0) = 0 then
    return null;
  end if;

  -- The head round is the whole of STAR: the score round, its tie-breaks
  -- and the runoff. The full ranking below it is this function again on
  -- what is left, and a list row wants none of that.
  v_winner := (star_round(p_poll_id, v_pool)->>'winner_id')::uuid;

  if v_winner is null then
    -- A runoff level on preference, on points and on five-star votes
    -- alike. The app reports the tie rather than inventing a winner, so
    -- this stays null and the list says the poll is closed instead.
    return null;
  end if;

  return (select name from candidates where id = v_winner);
end;
$$;


ALTER FUNCTION "public"."poll_winner_name"("p_poll_id" "uuid") OWNER TO "postgres";

-- Not callable on its own: it answers for any poll id it is handed, with no
-- check that the caller may see that poll. list_polls() below has already
-- done that check, and is the only thing that calls it.
REVOKE ALL ON FUNCTION "public"."poll_winner_name"("p_poll_id" "uuid") FROM PUBLIC;


DROP FUNCTION IF EXISTS "public"."list_polls"();

CREATE OR REPLACE FUNCTION "public"."list_polls"() RETURNS TABLE("id" "uuid", "title" "text", "description" "text", "created_by" "uuid", "created_by_email" "text", "created_at" timestamp with time zone, "closed_at" timestamp with time zone, "mode" "text", "show_voters" boolean, "show_ballots" boolean, "solicit_options" boolean, "options_finalized_at" timestamp with time zone, "public_token" "text", "invited_count" integer, "voted_count" integer, "option_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean, "winner_name" "text")
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with visible as (
    select p.*
    from polls p
    where p.created_by = auth.uid()
       or exists (
         select 1 from invited_voters iv
         where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
       )
  ), tallied as (
    select
      v.id as poll_id,
      (select count(*)::int from invited_voters iv where iv.poll_id = v.id) as invited_count,
      (select count(*)::int from ballots b where b.poll_id = v.id) as voted_count,
      (select count(*)::int from candidates c where c.poll_id = v.id) as option_count,
      exists (select 1 from ballots b where b.poll_id = v.id and b.voter_id = auth.uid()) as voted
    from visible v
  ), status as (
    select
      v.id as poll_id,
      -- Open polls reveal only on close; invite polls keep the completion
      -- rule as well. Named here rather than repeated, because the winner
      -- below is asked for on exactly these terms.
      t.voted_count > 0 and (
        v.closed_at is not null
        or (v.mode = 'invite' and t.invited_count > 0 and t.voted_count >= t.invited_count)
      ) as results_available
    from visible v
    join tallied t on t.poll_id = v.id
  )
  select
    v.id,
    v.title,
    v.description,
    v.created_by,
    v.created_by_email,
    v.created_at,
    v.closed_at,
    v.mode,
    v.show_voters,
    v.show_ballots,
    v.solicit_options,
    v.options_finalized_at,
    v.public_token,
    t.invited_count,
    t.voted_count,
    t.option_count,
    t.invited_count > 0 and t.voted_count >= t.invited_count,
    t.voted,
    v.closed_at is not null,
    s.results_available,
    v.solicit_options and v.options_finalized_at is null and v.closed_at is null,
    -- Guarded rather than filtered afterwards: CASE is what stops the
    -- election from being run for a poll that has not finished one.
    case when s.results_available then poll_winner_name(v.id) end
  from visible v
  join tallied t on t.poll_id = v.id
  join status s on s.poll_id = v.id
  order by v.created_at desc;
$$;


ALTER FUNCTION "public"."list_polls"() OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."list_polls"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_polls"() TO "authenticated";

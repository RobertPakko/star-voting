-- The full ranking, split out of the tally that names the winner.
--
-- `poll_tally` used to answer two questions in one call: who won, and in what
-- order did everything else place. The first is one `star_round`; the second
-- is `star_round` again for every place below it, since STAR itself only
-- names a winner and the rest comes from re-running the method on the options
-- left standing. An n-option poll therefore paid for n-1 extra rounds, each
-- one rebuilding the per-option totals and re-reading every ballot -- and it
-- paid on every reader of every result, when the ranking is behind a button
-- most of them never press.
--
-- Measured against the test database on random polls, each call in its own
-- transaction as it is in production, median of five after a warm-up:
--
--     options  voters   one call (old)   winner only   the ladder
--           4      20         20.4 ms        6.4 ms      15.9 ms
--          10     100         48.3 ms        8.4 ms      48.3 ms
--          20     200        190.4 ms       11.7 ms     187.0 ms
--          50     200        526.6 ms       19.4 ms     541.9 ms
--
-- The ranking was 58% of the JSON on the smallest of those and 77% on the
-- largest.
--
-- So the ladder moves into `poll_ranking`, which the results page asks for
-- only when someone opens the modal. `poll_winner_name` already drew this
-- line for the poll list -- "a list row wants none of that" -- and this is
-- the same line drawn one screen further in.
--
-- **Opening the modal costs more than the old single call did**, not less:
-- first place is part of the ranking, so `poll_ranking` runs the head round
-- again rather than being handed it. That is the trade -- 4-18% more for the
-- readers who ask, against 69-96% less for the readers who don't. The overhead
-- is worst in relative terms on the smallest polls, where one round is a large
-- fraction of the work and the whole thing is over in milliseconds anyway.
--
-- The two gates that guard a tally now guard the ranking as well, and they are
-- lifted into functions of their own to say so once each: the ranking
-- discloses the whole field, so it cannot be read on easier terms than the
-- winner is. Four callers repeating a visibility rule is four places for it
-- to drift.


-- ---------------------------------------------------------------------------
-- The gates
-- ---------------------------------------------------------------------------

-- May the caller read this poll's results at all? Raises if not; returns
-- nothing when they may. Invite polls: you are the creator or you were
-- invited, somebody voted, and the poll is either closed or complete.
CREATE OR REPLACE FUNCTION "public"."assert_results_readable"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_mode text;
  v_invited int;
  v_voted int;
  v_closed boolean;
begin
  if not exists (
    select 1 from polls p
    where p.id = p_poll_id
      and (
        p.created_by = auth.uid()
        or exists (select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email)
      )
  ) then
    raise exception 'Poll not found';
  end if;

  select mode, closed_at is not null into v_mode, v_closed from polls where id = p_poll_id;
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if v_mode = 'open' then
    if not v_closed then
      raise exception 'Results are not available until the poll is closed';
    end if;
  elsif not v_closed and (v_invited = 0 or v_voted < v_invited) then
    raise exception 'Results are not available until everyone has voted';
  end if;
end;
$$;


ALTER FUNCTION "public"."assert_results_readable"("p_poll_id" "uuid") OWNER TO "postgres";


-- The same question for an open poll, which is asked by share token and
-- answered by handing back the poll the token opens. Raises if the token
-- names no open poll, or if that poll's results are not out.
CREATE OR REPLACE FUNCTION "public"."open_results_poll_id"("p_token" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted int;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  -- Closed first: on a poll still taking votes that is the accurate answer,
  -- and "no votes were cast" would be a confusing thing to say about a poll
  -- people can still vote in.
  if v_poll.closed_at is null then
    raise exception 'Results are not available until the poll is closed';
  end if;

  select count(*) into v_voted from ballots where poll_id = v_poll.id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  return v_poll.id;
end;
$$;


ALTER FUNCTION "public"."open_results_poll_id"("p_token" "text") OWNER TO "postgres";


-- ---------------------------------------------------------------------------
-- The tally, without the ladder
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."poll_tally"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_invited int;
  v_voted int;
  v_closed boolean;
  v_mode text;
  v_options jsonb;
  v_pool uuid[];
  v_head jsonb;
  v_head_finalists uuid[];
begin
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;
  select closed_at is not null, mode into v_closed, v_mode from polls where id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  -- Names and totals for the whole poll, for the score-round list. star_round
  -- recomputes its own pool-scoped copy; these two never disagree, since a
  -- total is a per-option sum that no elimination can change.
  drop table if exists _tally;
  create temp table _tally on commit drop as
  select
    c.id as cid,
    c.name,
    c.description,
    coalesce(sum(s.score), 0)::int as total
  from candidates c
  left join scores s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
  group by c.id, c.name, c.description;

  select coalesce(array_agg(cid), '{}'::uuid[]) into v_pool from _tally;

  -- The head round is the whole of STAR: the score round, its tie-breaks and
  -- the runoff. Everything below first place is poll_ranking's, and is not
  -- computed here.
  v_head := star_round(p_poll_id, v_pool);

  select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_head_finalists
  from jsonb_array_elements_text(v_head->'finalists') x;

  -- Order the score list so a tie-break winner sits above the option it
  -- beat, rather than falling alphabetically below it.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cid,
    'name', name,
    -- Null on nearly every option ever created; the results page shows
    -- nothing at all for those rather than an empty affordance.
    'description', description,
    'total_score', total,
    'average_score', round(total::numeric / v_voted, 2)
  ) order by total desc, (case when cid = any(v_head_finalists) then 0 else 1 end), name), '[]'::jsonb)
  into v_options
  from _tally;

  return jsonb_build_object(
    'options', v_options,
    'finalists', case when jsonb_array_length(v_head->'finalists') = 2
                      then v_head->'finalists'
                      else '[]'::jsonb end,
    'tie', jsonb_array_length(v_head->'tiebreaks') > 0,
    'tiebreaks', v_head->'tiebreaks',
    'runoff', v_head->'runoff',
    'winner_id', v_head->'winner_id',
    'voter_count', v_voted,
    'invited_count', v_invited,
    'mode', v_mode,
    'closed_early', v_closed and v_voted < v_invited
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- The ladder
-- ---------------------------------------------------------------------------

-- Every option in placed order, as a JSON array of places.
--
-- STAR names one winner. To order the rest the method runs again on the
-- options left standing: the winner steps out, the two highest scorers
-- remaining go to a runoff for the next place, and so on down the list. Only
-- place 1 is what STAR itself produces; the rest is this loop.
CREATE OR REPLACE FUNCTION "public"."poll_ranking"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_voted int;
  v_pool uuid[];
  v_round jsonb;
  v_finalists uuid[];
  v_winner uuid;
  v_placed uuid[];
  v_placed_json jsonb;
  v_ranking jsonb := '[]'::jsonb;
  v_place int := 1;
begin
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  -- Names and totals, for labelling the places. Scores are absolute sums, so
  -- eliminating an option never changes anyone else's total and this is read
  -- once for the whole ladder rather than per round.
  drop table if exists _ranking_tally;
  create temp table _ranking_tally on commit drop as
  select
    c.id as cid,
    c.name,
    coalesce(sum(s.score), 0)::int as total
  from candidates c
  left join scores s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
  group by c.id, c.name;

  select coalesce(array_agg(cid), '{}'::uuid[]) into v_pool from _ranking_tally;

  while coalesce(array_length(v_pool, 1), 0) > 0 loop
    v_round := star_round(p_poll_id, v_pool);

    select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_finalists
    from jsonb_array_elements_text(v_round->'finalists') x;

    v_winner := (v_round->>'winner_id')::uuid;

    -- A runoff level on preference, points and five-star votes alike elects
    -- nobody, and both finalists take the place together.
    if v_winner is null then
      v_placed := v_finalists;
    else
      v_placed := array[v_winner];
    end if;

    -- Belt and braces: a round that places nobody would loop forever.
    exit when coalesce(array_length(v_placed, 1), 0) = 0;

    select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'total_score', total)
                     order by total desc, name)
    into v_placed_json
    from _ranking_tally where cid = any(v_placed);

    v_ranking := v_ranking || jsonb_build_array(jsonb_build_object(
      'place', v_place,
      'options', v_placed_json,
      'finalists', v_round->'finalists',
      'runoff', v_round->'runoff',
      'tiebreaks', v_round->'tiebreaks'));

    v_place := v_place + array_length(v_placed, 1);

    select coalesce(array_agg(x), '{}'::uuid[]) into v_pool
    from unnest(v_pool) x
    where not (x = any(v_placed));
  end loop;

  return v_ranking;
end;
$$;


ALTER FUNCTION "public"."poll_ranking"("p_poll_id" "uuid") OWNER TO "postgres";


-- ---------------------------------------------------------------------------
-- What the app calls
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."get_poll_results"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_tally(p_poll_id);
end;
$$;


CREATE OR REPLACE FUNCTION "public"."get_poll_ranking"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_ranking(p_poll_id);
end;
$$;


ALTER FUNCTION "public"."get_poll_ranking"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_poll_results"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  return poll_tally(open_results_poll_id(p_token));
end;
$$;


CREATE OR REPLACE FUNCTION "public"."open_poll_ranking"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  return poll_ranking(open_results_poll_id(p_token));
end;
$$;


ALTER FUNCTION "public"."open_poll_ranking"("p_token" "text") OWNER TO "postgres";


-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- The gates and the ladder are reached only through the four functions above,
-- which are SECURITY DEFINER and owned by postgres. Nothing else may call
-- them: `poll_ranking` checks nothing itself, exactly as `poll_tally` does
-- not.
REVOKE ALL ON FUNCTION "public"."assert_results_readable"("p_poll_id" "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."open_results_poll_id"("p_token" "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."poll_ranking"("p_poll_id" "uuid") FROM PUBLIC;

REVOKE ALL ON FUNCTION "public"."get_poll_ranking"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_ranking"("p_poll_id" "uuid") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."open_poll_ranking"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_ranking"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_ranking"("p_token" "text") TO "authenticated";

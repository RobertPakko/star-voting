-- The results stop at ten.
--
-- A time poll can have hundreds of options, and the tally carried every one
-- of them, on every read of a finished poll, to a page that drew ten. The full
-- ranking was worse: a STAR round per place, each re-reading every ballot,
-- down to last place, for a modal nobody reads past the first few rows.
--
-- So poll_tally returns the ten highest scorers, with the size of the field
-- beside them (`option_count`); poll_ranking stops once ten places are
-- filled, and names each place's runoff opponent itself (`finalist_names`),
-- since that option may be below the tally's cut. Every option's score is
-- still one request away, through poll_scores: plain sums, no election, read
-- only when somebody asks.

-- How many rows the score round and the full ranking stop at. The one place
-- the number is written in SQL; SCORING_ROWS_MAX in src/lib/resultsRows.ts is
-- the browser's copy, and limits.test.ts holds the two together.
CREATE OR REPLACE FUNCTION "public"."poll_results_rows"() RETURNS integer
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select 10
$$;

ALTER FUNCTION "public"."poll_results_rows"() OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_results_rows"() FROM PUBLIC;


CREATE OR REPLACE FUNCTION "public"."poll_tally"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_invited int;
  v_voted int;
  v_closed boolean;
  v_mode text;
  v_edited boolean;
  v_late boolean;
  v_options jsonb;
  v_option_count int;
  v_pool uuid[];
  v_head jsonb;
  v_head_finalists uuid[];
begin
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  select closed_at is not null, mode, options_edited_after_votes, votes_after_reveal
  into v_closed, v_mode, v_edited, v_late
  from polls where id = p_poll_id;

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

  select coalesce(array_agg(cid), '{}'::uuid[]), count(*)::int
  into v_pool, v_option_count
  from _tally;

  -- The head round is the whole of STAR: the score round, its tie-breaks and
  -- the runoff. Everything below first place is poll_ranking's, and is not
  -- computed here.
  v_head := star_round(p_poll_id, v_pool);

  select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_head_finalists
  from jsonb_array_elements_text(v_head->'finalists') x;

  -- Order the score list so a tie-break winner sits above the option it
  -- beat, rather than falling alphabetically below it. That ordering is also
  -- what makes the cut safe: the two finalists are always the first two rows,
  -- so every option the page names is in the list.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cid,
    'name', name,
    -- Null on nearly every option ever created; the results page shows
    -- nothing at all for those rather than an empty affordance.
    'description', description,
    'total_score', total,
    'average_score', round(total::numeric / v_voted, 2)
  ) order by rn), '[]'::jsonb)
  into v_options
  from (
    select *, row_number() over (
      order by total desc, (case when cid = any(v_head_finalists) then 0 else 1 end), name) as rn
    from _tally
  ) t
  where rn <= poll_results_rows();

  return jsonb_build_object(
    'options', v_options,
    -- The size of the field the list above was cut from.
    'option_count', v_option_count,
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
    'closed_early', v_closed and v_voted < v_invited,
    -- The two caveats, travelling with the tally they are about. Everyone who
    -- can read the result reads them, through whichever door they came in by:
    -- get_poll_results and open_poll_results are two gates over this one
    -- function.
    'options_edited_after_votes', coalesce(v_edited, false),
    'votes_after_reveal', coalesce(v_late, false)
  );
end;
$$;


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
  v_finalist_names jsonb;
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

  -- Every place is a whole STAR round over every ballot, so the ladder stops
  -- once the top places are filled. A place shared by a tied runoff can take
  -- the last round one past the cut; it is kept whole rather than split.
  while coalesce(array_length(v_pool, 1), 0) > 0 and v_place <= poll_results_rows() loop
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

    -- The runoff's two names, in the order of `finalists`. The option a place
    -- beat may never be placed itself before the ladder stops, so the browser
    -- cannot look it up anywhere else.
    select coalesce(jsonb_agg(t.name order by f.ord), '[]'::jsonb)
    into v_finalist_names
    from unnest(v_finalists) with ordinality f(cid, ord)
    join _ranking_tally t on t.cid = f.cid;

    v_ranking := v_ranking || jsonb_build_array(jsonb_build_object(
      'place', v_place,
      'options', v_placed_json,
      'finalists', v_round->'finalists',
      'finalist_names', v_finalist_names,
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


-- Every option's score, for the *All scores* modal on a poll too long for the
-- score round to show whole. Sums only: no tie-breaks, no runoff, so it costs
-- one pass over the scores however many options there are. Ordered by total,
-- then name; the browser lifts the finalists above options they tied with,
-- as the score round does, from the tally it already holds.
CREATE OR REPLACE FUNCTION "public"."poll_scores"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_voted int;
begin
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'name', name,
      'total_score', total,
      'average_score', round(total::numeric / v_voted, 2)
    ) order by total desc, name), '[]'::jsonb)
    from (
      select c.id, c.name, coalesce(sum(s.score), 0)::int as total
      from candidates c
      left join scores s on s.candidate_id = c.id
      where c.poll_id = p_poll_id
      group by c.id, c.name
    ) t
  );
end;
$$;

ALTER FUNCTION "public"."poll_scores"("p_poll_id" "uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_scores"("p_poll_id" "uuid") FROM PUBLIC;


-- The two doors onto it, gated exactly as the tally and the ranking are: every
-- score is the score round in full, so it is readable on the same terms.
CREATE OR REPLACE FUNCTION "public"."get_poll_scores"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_scores(p_poll_id);
end;
$$;

ALTER FUNCTION "public"."get_poll_scores"("p_poll_id" "uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."get_poll_scores"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_scores"("p_poll_id" "uuid") TO "authenticated";


CREATE OR REPLACE FUNCTION "public"."open_poll_scores"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_scores(p_poll_id);
end;
$$;

ALTER FUNCTION "public"."open_poll_scores"("p_poll_id" "uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."open_poll_scores"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_scores"("p_poll_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_scores"("p_poll_id" "uuid") TO "authenticated";

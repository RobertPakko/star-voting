-- Multiple winners: a ranking of its own, in which every spot is a full STAR
-- election (scores, then a runoff) and every ballot counts at
-- 1 / (1 + SUM / 5), SUM being the stars it gave the winners of the spots
-- before. D'Hondt's divisors, applied in the runoff as well as the scores:
-- full-strength runoff votes would let a majority take every spot. With no
-- winner chosen yet every ballot counts in full, so the first spot is the
-- single-winner STAR result.
--
-- The count stops at poll_results_rows() spots, as the full ranking does,
-- since each spot is a pass over every ballot.
--
-- The reader can take options out (`p_excluded`) — the restaurant that is
-- shut, the film nobody can stream — and the count is run again as though
-- they had never been on the ballot. Nothing is stored: the list is the
-- reader's, and arrives with every request.


-- One STAR round over `p_pool` with every ballot at a strength. The weighted
-- twin of star_round, with the same rules in the same order and the same
-- payload, every count a weighted sum (rounded to six places so that two sums
-- of the same fractions compare equal):
--
--   * score round: weighted totals; a tie of two for a slot goes to weighted
--     head-to-head preference, then weighted five-star votes, then by id; a
--     tie of three or more to weighted five-star votes, then by id;
--   * runoff: weighted preference, then weighted total, then weighted
--     five-star votes, else unresolved.
--
-- star_round is left alone, so no single-winner tally depends on this.
CREATE OR REPLACE FUNCTION "public"."weighted_star_round"(
    "p_poll_id" "uuid", "p_pool" "uuid"[], "p_ballots" "uuid"[], "p_weights" numeric[])
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_finalists uuid[] := '{}';
  v_pick uuid[];
  v_tiebreaks jsonb := '[]'::jsonb;
  v_need int := 2;
  v_score numeric;
  v_group uuid[];
  v_grp_size int;
  v_tied jsonb;
  v_h2h jsonb;
  v_matchup jsonb;
  v_fs jsonb;
  v_steps jsonb;
  v_advanced jsonb;
  v_resolved text;
  v_fn numeric; v_fn1 numeric;
  v_a uuid; v_b uuid;
  v_ta numeric; v_tb numeric;
  v_fa numeric; v_fb numeric;
  v_prefers_a numeric; v_prefers_b numeric; v_ties numeric;
  v_winner uuid;
  v_runoff_by text;
begin
  drop table if exists _wweights;
  create temp table _wweights on commit drop as
  select b.ballot_id, b.weight
  from unnest(p_ballots, p_weights) as b(ballot_id, weight);

  -- Every ballot's score for every option in the pool, at its strength.
  drop table if exists _wscores;
  create temp table _wscores on commit drop as
  select s.ballot_id, s.candidate_id, s.score, w.weight
  from scores s
  join _wweights w on w.ballot_id = s.ballot_id
  where s.candidate_id = any(p_pool);

  drop table if exists _wround;
  create temp table _wround on commit drop as
  select
    c.id as cid,
    c.name,
    round(coalesce(sum(s.score * s.weight), 0), 6) as total,
    round(coalesce(sum(s.weight) filter (where s.score = 5), 0), 6) as five_stars
  from candidates c
  left join _wscores s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
    and c.id = any(p_pool)
  group by c.id, c.name;

  for v_score in select distinct total from _wround order by total desc loop
    exit when v_need <= 0;

    select array_agg(cid order by cid) into v_group from _wround where total = v_score;
    v_grp_size := coalesce(array_length(v_group, 1), 0);

    if v_grp_size <= v_need then
      v_finalists := v_finalists || v_group;
      v_need := v_need - v_grp_size;
    else
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'total_score', total) order by name)
        into v_tied from _wround where cid = any(v_group);
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', five_stars) order by five_stars desc, name)
        into v_fs from _wround where cid = any(v_group);

      if v_grp_size = 2 then
        select cid into v_a from _wround where cid = any(v_group) order by name, cid limit 1;
        select cid into v_b from _wround where cid = any(v_group) and cid <> v_a;

        select
          round(coalesce(sum(weight) filter (where a_score > b_score), 0), 6),
          round(coalesce(sum(weight) filter (where b_score > a_score), 0), 6),
          round(coalesce(sum(weight) filter (where a_score = b_score), 0), 6)
        into v_prefers_a, v_prefers_b, v_ties
        from (
          select
            w.weight,
            coalesce((select score from _wscores where ballot_id = w.ballot_id and candidate_id = v_a), 0) as a_score,
            coalesce((select score from _wscores where ballot_id = w.ballot_id and candidate_id = v_b), 0) as b_score
          from _wweights w
        ) v;

        select jsonb_build_object(
                 'a', v_a, 'a_name', ca.name,
                 'b', v_b, 'b_name', cb.name,
                 'prefers_a', v_prefers_a,
                 'prefers_b', v_prefers_b,
                 'ties', v_ties)
          into v_matchup
        from _wround ca, _wround cb
        where ca.cid = v_a and cb.cid = v_b;

        drop table if exists _wtb;
        create temp table _wtb on commit drop as
        with w as (
          select
            t.cid,
            t.name,
            t.five_stars,
            case
              when t.cid = v_a then (v_prefers_a > v_prefers_b)::int
              else (v_prefers_b > v_prefers_a)::int
            end as h2h_wins
          from _wround t
          where t.cid = any(v_group)
        )
        select w.*, row_number() over (order by h2h_wins desc, five_stars desc, cid) as rn
        from w;

        select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', h2h_wins) order by h2h_wins desc, name)
          into v_h2h from _wtb;

        if v_prefers_a <> v_prefers_b then
          v_resolved := 'head_to_head';
        elsif (select max(five_stars) <> min(five_stars) from _wtb) then
          v_resolved := 'five_star_votes';
        else
          v_resolved := 'random';
        end if;

        v_steps := jsonb_build_array(jsonb_build_object(
          'rule', 'head_to_head',
          'results', v_h2h,
          'matchups', jsonb_build_array(v_matchup),
          'decisive', v_resolved = 'head_to_head'));

        if v_resolved <> 'head_to_head' then
          v_steps := v_steps || jsonb_build_array(jsonb_build_object(
            'rule', 'five_star_votes', 'results', v_fs, 'decisive', v_resolved = 'five_star_votes'));
        end if;
      else
        drop table if exists _wtb;
        create temp table _wtb on commit drop as
        select
          t.cid,
          t.name,
          t.five_stars,
          row_number() over (order by t.five_stars desc, t.cid) as rn
        from _wround t
        where t.cid = any(v_group);

        select five_stars into v_fn from _wtb where rn = v_need;
        select five_stars into v_fn1 from _wtb where rn = v_need + 1;

        v_resolved := case when v_fn > v_fn1 then 'five_star_votes' else 'random' end;

        v_steps := jsonb_build_array(jsonb_build_object(
          'rule', 'five_star_votes', 'results', v_fs, 'decisive', v_resolved = 'five_star_votes'));
      end if;

      select array_agg(cid order by rn) into v_pick from _wtb where rn <= v_need;
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name) order by rn)
        into v_advanced from _wtb where rn <= v_need;

      v_tiebreaks := v_tiebreaks || jsonb_build_array(jsonb_build_object(
        'tied_at', v_score,
        'tied', v_tied,
        'slots', v_need,
        'steps', v_steps,
        'resolved_by', v_resolved,
        'advanced', v_advanced));

      v_finalists := v_finalists || v_pick;
      v_need := 0;
    end if;
  end loop;

  select coalesce(array_agg(cid order by total desc, cid), '{}'::uuid[]) into v_finalists
  from _wround where cid = any(v_finalists);

  if array_length(v_finalists, 1) is distinct from 2 then
    return jsonb_build_object(
      'finalists', to_jsonb(v_finalists),
      'tiebreaks', v_tiebreaks,
      'runoff', null,
      'winner_id', v_finalists[1]
    );
  end if;

  v_a := v_finalists[1];
  v_b := v_finalists[2];

  select
    round(coalesce(sum(weight) filter (where a_score > b_score), 0), 6),
    round(coalesce(sum(weight) filter (where b_score > a_score), 0), 6),
    round(coalesce(sum(weight) filter (where a_score = b_score), 0), 6)
  into v_prefers_a, v_prefers_b, v_ties
  from (
    select
      w.weight,
      coalesce((select score from _wscores where ballot_id = w.ballot_id and candidate_id = v_a), 0) as a_score,
      coalesce((select score from _wscores where ballot_id = w.ballot_id and candidate_id = v_b), 0) as b_score
    from _wweights w
  ) t;

  select total, five_stars into v_ta, v_fa from _wround where cid = v_a;
  select total, five_stars into v_tb, v_fb from _wround where cid = v_b;

  if v_prefers_a > v_prefers_b then
    v_winner := v_a; v_runoff_by := 'preference';
  elsif v_prefers_b > v_prefers_a then
    v_winner := v_b; v_runoff_by := 'preference';
  elsif v_ta > v_tb then
    v_winner := v_a; v_runoff_by := 'higher_score';
  elsif v_tb > v_ta then
    v_winner := v_b; v_runoff_by := 'higher_score';
  elsif v_fa > v_fb then
    v_winner := v_a; v_runoff_by := 'five_star_votes';
  elsif v_fb > v_fa then
    v_winner := v_b; v_runoff_by := 'five_star_votes';
  else
    v_winner := null; v_runoff_by := 'unresolved';
  end if;

  return jsonb_build_object(
    'finalists', to_jsonb(v_finalists),
    'tiebreaks', v_tiebreaks,
    'runoff', jsonb_build_object(
      'prefers_a', v_prefers_a,
      'prefers_b', v_prefers_b,
      'ties', v_ties,
      'five_stars_a', v_fa,
      'five_stars_b', v_fb,
      'resolved_by', v_runoff_by
    ),
    'winner_id', v_winner
  );
end;
$$;

ALTER FUNCTION "public"."weighted_star_round"("uuid", "uuid"[], "uuid"[], numeric[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."weighted_star_round"("uuid", "uuid"[], "uuid"[], numeric[]) FROM PUBLIC;


-- The count itself. Answers in the full ranking's shape (one entry per spot:
-- the options placed, the runoff, its tie-breaks), with every number a
-- weighted one. A runoff level on every rule elects nobody, so both finalists
-- share the spot, as in the full ranking, and both count against the ballots
-- that starred them.
--
-- `p_excluded` names options to leave off the ballot entirely; ids that are
-- not this poll's options are ignored.
CREATE OR REPLACE FUNCTION "public"."poll_multiple_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[])
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_ballots uuid[];
  v_given int[];
  v_weights numeric[];
  v_pool uuid[];
  v_round jsonb;
  v_finalists uuid[];
  v_winner uuid;
  v_placed uuid[];
  v_placed_json jsonb;
  v_finalist_names jsonb;
  v_spots jsonb := '[]'::jsonb;
  v_place int := 1;
begin
  -- A poll has at most a few hundred options; anything longer is not a list
  -- a reader built by pressing buttons.
  if coalesce(array_length(p_excluded, 1), 0) > 1000 then
    raise exception 'Too many options left out';
  end if;

  select coalesce(array_agg(id order by id), '{}'::uuid[]) into v_ballots
  from ballots where poll_id = p_poll_id;

  if coalesce(array_length(v_ballots, 1), 0) = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  -- The stars each ballot has given the winners so far, in v_ballots' order.
  v_given := array_fill(0, array[array_length(v_ballots, 1)]);

  select coalesce(array_agg(id), '{}'::uuid[]) into v_pool
  from candidates
  where poll_id = p_poll_id
    and not (id = any(coalesce(p_excluded, '{}'::uuid[])));

  while coalesce(array_length(v_pool, 1), 0) > 0 and v_place <= poll_results_rows() loop
    select array_agg(5::numeric / (5 + g) order by ord) into v_weights
    from unnest(v_given) with ordinality u(g, ord);

    v_round := weighted_star_round(p_poll_id, v_pool, v_ballots, v_weights);

    select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_finalists
    from jsonb_array_elements_text(v_round->'finalists') x;

    v_winner := (v_round->>'winner_id')::uuid;

    if v_winner is null then
      v_placed := v_finalists;
    else
      v_placed := array[v_winner];
    end if;

    exit when coalesce(array_length(v_placed, 1), 0) = 0;

    -- Each placed option at the weighted total it was elected on.
    select jsonb_agg(jsonb_build_object('id', r.cid, 'name', r.name, 'total_score', r.total)
                     order by r.total desc, r.name)
    into v_placed_json
    from _wround r where r.cid = any(v_placed);

    select coalesce(jsonb_agg(t.name order by f.ord), '[]'::jsonb)
    into v_finalist_names
    from unnest(v_finalists) with ordinality f(cid, ord)
    join candidates t on t.id = f.cid;

    v_spots := v_spots || jsonb_build_array(jsonb_build_object(
      'place', v_place,
      'options', v_placed_json,
      'finalists', v_round->'finalists',
      'finalist_names', v_finalist_names,
      'runoff', v_round->'runoff',
      'tiebreaks', v_round->'tiebreaks'));

    v_place := v_place + array_length(v_placed, 1);

    -- Every ballot is charged the stars it gave whatever was placed.
    select array_agg(u.g + coalesce((
             select sum(s.score)::int from scores s
             where s.ballot_id = v_ballots[u.ord::int] and s.candidate_id = any(v_placed)), 0)
           order by u.ord)
    into v_given
    from unnest(v_given) with ordinality u(g, ord);

    select coalesce(array_agg(x), '{}'::uuid[]) into v_pool
    from unnest(v_pool) x
    where not (x = any(v_placed));
  end loop;

  return v_spots;
end;
$$;

ALTER FUNCTION "public"."poll_multiple_winners"("uuid", "uuid"[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_multiple_winners"("uuid", "uuid"[]) FROM PUBLIC;


-- The two doors, gated exactly as the full ranking is: the count discloses at
-- least as much as the tally.
CREATE OR REPLACE FUNCTION "public"."get_poll_multiple_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}')
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_multiple_winners(p_poll_id, p_excluded);
end;
$$;

ALTER FUNCTION "public"."get_poll_multiple_winners"("uuid", "uuid"[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."get_poll_multiple_winners"("uuid", "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_multiple_winners"("uuid", "uuid"[]) TO "authenticated";


CREATE OR REPLACE FUNCTION "public"."open_poll_multiple_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}')
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_multiple_winners(p_poll_id, p_excluded);
end;
$$;

ALTER FUNCTION "public"."open_poll_multiple_winners"("uuid", "uuid"[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."open_poll_multiple_winners"("uuid", "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_multiple_winners"("uuid", "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_multiple_winners"("uuid", "uuid"[]) TO "authenticated";

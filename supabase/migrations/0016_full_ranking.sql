-- ---------------------------------------------------------------------------
-- Full ranking, by sequential elimination.
--
-- STAR names one winner. To order everything below it, run STAR again on
-- what is left: take the winner out, re-run score-then-runoff over the
-- remaining options for second place, and keep going. (Equal Vote's
-- multi-winner Bloc STAR fills seats the same way; this just continues to
-- the bottom of the list instead of stopping at the last seat.)
--
-- Scores are absolute sums, not transferable votes, so removing an option
-- never changes anyone else's total -- the score order is settled once and
-- never moves. Each round therefore collapses to a runoff between the two
-- highest-scoring options still standing, with the loser carried forward to
-- face the next one down. n options cost n-1 runoffs.
--
-- Two consequences the UI has to be honest about:
--   * The runner-up of the headline runoff is not necessarily second. It
--     still has to beat the third-highest scorer, and it can lose that.
--   * Pairwise preferences can cycle, so an option placed low may well beat
--     one placed above it head to head. This is an ordering produced by a
--     procedure, not a transitive ranking of preference.
--
-- Structurally: one round is lifted out of poll_tally into star_round, and
-- poll_tally now calls it once for the headline result -- byte-for-byte the
-- same fields as before -- and then in a loop to fill in the new `ranking`
-- key. Nothing else about the returned object changes, and neither
-- get_poll_results nor open_poll_results needs touching: both already
-- delegate here, so both gain the ranking.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- star_round: one complete STAR round over an arbitrary pool of options.
--
-- This is the body that used to live inline in poll_tally, with two changes:
-- it works over the pool it is handed rather than every option in the poll,
-- and it returns only the round's own result -- finalists, the tie-breaks it
-- had to resolve, the runoff, the winner. Poll-level facts (voter counts,
-- mode, the score-round list) stay in poll_tally, which is the only caller.
--
-- It takes a poll id and performs no authorization of its own, exactly like
-- poll_tally, so EXECUTE is revoked from every client role at the bottom of
-- this file. It is reachable only from poll_tally, which is itself reachable
-- only through the two gated results functions.
-- ---------------------------------------------------------------------------

create or replace function star_round(p_poll_id uuid, p_pool uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_finalists uuid[] := '{}';
  v_pick uuid[];
  v_tiebreaks jsonb := '[]'::jsonb;
  v_need int := 2;
  v_score int;
  v_group uuid[];
  v_grp_size int;
  v_tied jsonb;
  v_h2h jsonb;
  v_fs jsonb;
  v_steps jsonb;
  v_advanced jsonb;
  v_resolved text;
  v_wn int; v_fn int; v_wn1 int; v_fn1 int;
  v_a uuid; v_b uuid;
  v_ta int; v_tb int;
  v_prefers_a int; v_prefers_b int; v_ties int;
  v_winner uuid;
  v_runoff_by text;
begin
  drop table if exists _round;
  create temp table _round on commit drop as
  select
    c.id as cid,
    c.name,
    coalesce(sum(s.score), 0)::int as total,
    (count(*) filter (where s.score = 5))::int as five_stars
  from candidates c
  left join scores s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
    and c.id = any(p_pool)
  group by c.id, c.name;

  -- Walk score groups high to low, filling the two finalist slots. A group
  -- that would overfill the remaining slots is the tie that needs breaking.
  for v_score in select distinct total from _round order by total desc loop
    exit when v_need <= 0;

    select array_agg(cid order by cid) into v_group from _round where total = v_score;
    v_grp_size := coalesce(array_length(v_group, 1), 0);

    if v_grp_size <= v_need then
      v_finalists := v_finalists || v_group;
      v_need := v_need - v_grp_size;
    else
      drop table if exists _tb;
      create temp table _tb on commit drop as
      with grp as (select unnest(v_group) as cid),
      pairs as (
        select g1.cid as a, g2.cid as b
        from grp g1 join grp g2 on g1.cid <> g2.cid
      ),
      matchups as (
        select
          p.a,
          p.b,
          (select count(*) from ballots bal
            where bal.poll_id = p_poll_id
              and coalesce((select score from scores where ballot_id = bal.id and candidate_id = p.a), 0)
                > coalesce((select score from scores where ballot_id = bal.id and candidate_id = p.b), 0)
          ) as ap,
          (select count(*) from ballots bal
            where bal.poll_id = p_poll_id
              and coalesce((select score from scores where ballot_id = bal.id and candidate_id = p.b), 0)
                > coalesce((select score from scores where ballot_id = bal.id and candidate_id = p.a), 0)
          ) as bp
        from pairs p
      ),
      wins as (
        select m.a as cid, (count(*) filter (where m.ap > m.bp))::int as w
        from matchups m group by m.a
      )
      select
        g.cid,
        t.name,
        t.total,
        t.five_stars,
        coalesce(w.w, 0) as h2h_wins,
        row_number() over (order by coalesce(w.w, 0) desc, t.five_stars desc, g.cid) as rn
      from grp g
      join _round t on t.cid = g.cid
      left join wins w on w.cid = g.cid;

      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'total_score', total) order by name)
        into v_tied from _tb;
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', h2h_wins) order by h2h_wins desc, name)
        into v_h2h from _tb;
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', five_stars) order by five_stars desc, name)
        into v_fs from _tb;

      -- Whatever separates the last advancing option from the first
      -- eliminated one is what actually decided the tie.
      select h2h_wins, five_stars into v_wn, v_fn from _tb where rn = v_need;
      select h2h_wins, five_stars into v_wn1, v_fn1 from _tb where rn = v_need + 1;

      if v_wn > v_wn1 then
        v_resolved := 'head_to_head';
      elsif v_fn > v_fn1 then
        v_resolved := 'five_star_votes';
      else
        v_resolved := 'random';
      end if;

      v_steps := jsonb_build_array(jsonb_build_object(
        'rule', 'head_to_head', 'results', v_h2h, 'decisive', v_resolved = 'head_to_head'));

      if v_resolved <> 'head_to_head' then
        v_steps := v_steps || jsonb_build_array(jsonb_build_object(
          'rule', 'five_star_votes', 'results', v_fs, 'decisive', v_resolved = 'five_star_votes'));
      end if;

      select array_agg(cid order by rn) into v_pick from _tb where rn <= v_need;
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name) order by rn)
        into v_advanced from _tb where rn <= v_need;

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

  -- Highest scorer first, so finalists[0] is the one the runoff labels as A.
  select coalesce(array_agg(cid order by total desc, cid), '{}'::uuid[]) into v_finalists
  from _round where cid = any(v_finalists);

  -- A pool of one has nobody to run off against: it takes the place unopposed.
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
    count(*) filter (where a_score > b_score),
    count(*) filter (where b_score > a_score),
    count(*) filter (where a_score = b_score)
  into v_prefers_a, v_prefers_b, v_ties
  from (
    select
      bal.id,
      coalesce((select score from scores where ballot_id = bal.id and candidate_id = v_a), 0) as a_score,
      coalesce((select score from scores where ballot_id = bal.id and candidate_id = v_b), 0) as b_score
    from ballots bal
    where bal.poll_id = p_poll_id
  ) t;

  if v_prefers_a > v_prefers_b then
    v_winner := v_a; v_runoff_by := 'preference';
  elsif v_prefers_b > v_prefers_a then
    v_winner := v_b; v_runoff_by := 'preference';
  else
    -- Official STAR: a tied runoff goes to the higher total score.
    select total into v_ta from _round where cid = v_a;
    select total into v_tb from _round where cid = v_b;
    if v_ta > v_tb then
      v_winner := v_a; v_runoff_by := 'higher_score';
    elsif v_tb > v_ta then
      v_winner := v_b; v_runoff_by := 'higher_score';
    else
      v_winner := null; v_runoff_by := 'unresolved';
    end if;
  end if;

  return jsonb_build_object(
    'finalists', to_jsonb(v_finalists),
    'tiebreaks', v_tiebreaks,
    'runoff', jsonb_build_object(
      'prefers_a', v_prefers_a,
      'prefers_b', v_prefers_b,
      'ties', v_ties,
      'resolved_by', v_runoff_by
    ),
    'winner_id', v_winner
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- poll_tally: unchanged output, plus `ranking`.
--
-- Round one is the poll's result and is reported exactly as before -- the
-- headline keys are read straight off it, including the quirk that
-- `finalists` is [] rather than a one-element array when the poll has a
-- single option. The loop then keeps calling star_round on the options that
-- have not been placed yet.
--
-- Each ranking entry places one option, except when a runoff ties on
-- preference and on total score alike: nothing in STAR separates those two,
-- so they share the place and the next number is skipped, the way 1-1-3
-- works in any standings table.
--
-- Tie-breaks stay split deliberately: the top-level `tiebreaks` is round
-- one's only, because that is what the results screen narrates about the
-- winner. Ties resolved further down the list belong to the ranking entry
-- they decided, and travel with it.
-- ---------------------------------------------------------------------------

create or replace function poll_tally(p_poll_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invited int;
  v_voted int;
  v_closed boolean;
  v_mode text;
  v_options jsonb;
  v_pool uuid[];
  v_head jsonb;
  v_head_finalists uuid[];
  v_round jsonb;
  v_finalists uuid[];
  v_winner uuid;
  v_placed uuid[];
  v_placed_json jsonb;
  v_ranking jsonb := '[]'::jsonb;
  v_place int := 1;
begin
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;
  select closed_at is not null, mode into v_closed, v_mode from polls where id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  -- Names and totals for the whole poll, for the score-round list and for
  -- labelling ranking entries. star_round recomputes its own pool-scoped
  -- copy; these two never disagree, since a total is a per-option sum that
  -- no elimination can change.
  drop table if exists _tally;
  create temp table _tally on commit drop as
  select
    c.id as cid,
    c.name,
    coalesce(sum(s.score), 0)::int as total
  from candidates c
  left join scores s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
  group by c.id, c.name;

  select coalesce(array_agg(cid), '{}'::uuid[]) into v_pool from _tally;

  v_head := star_round(p_poll_id, v_pool);

  select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_head_finalists
  from jsonb_array_elements_text(v_head->'finalists') x;

  -- Order the score list so a tie-break winner sits above the option it
  -- beat, rather than falling alphabetically below it.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cid,
    'name', name,
    'total_score', total,
    'average_score', round(total::numeric / v_voted, 2)
  ) order by total desc, (case when cid = any(v_head_finalists) then 0 else 1 end), name), '[]'::jsonb)
  into v_options
  from _tally;

  v_round := v_head;

  while coalesce(array_length(v_pool, 1), 0) > 0 loop
    select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_finalists
    from jsonb_array_elements_text(v_round->'finalists') x;

    v_winner := (v_round->>'winner_id')::uuid;

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
    from _tally where cid = any(v_placed);

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

    if coalesce(array_length(v_pool, 1), 0) > 0 then
      v_round := star_round(p_poll_id, v_pool);
    end if;
  end loop;

  return jsonb_build_object(
    'options', v_options,
    'finalists', case when jsonb_array_length(v_head->'finalists') = 2
                      then v_head->'finalists'
                      else '[]'::jsonb end,
    'tie', jsonb_array_length(v_head->'tiebreaks') > 0,
    'tiebreaks', v_head->'tiebreaks',
    'runoff', v_head->'runoff',
    'winner_id', v_head->'winner_id',
    'ranking', v_ranking,
    'voter_count', v_voted,
    'invited_count', v_invited,
    'mode', v_mode,
    'closed_early', v_closed and v_voted < v_invited
  );
end;
$$;

-- star_round authorizes nothing, so no client role may call it. Postgres
-- grants EXECUTE to PUBLIC on new functions, so this revoke is what makes
-- that true rather than merely intended (0010).
revoke execute on function star_round(uuid, uuid[]) from public, anon, authenticated;

-- poll_tally keeps its own revoke from 0013: CREATE OR REPLACE leaves
-- privileges alone. Restated here so the end state is readable in one place.
revoke execute on function poll_tally(uuid) from public, anon, authenticated;

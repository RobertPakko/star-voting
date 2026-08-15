-- Replaces the arbitrary tie-break with STAR's official protocol, and
-- returns the whole resolution chain so the UI can show its work.
--
-- Previously the finalists came from `order by total_score desc,
-- candidate_id`, so a tie for the runoff slot was settled by whichever
-- option happened to get the lower random UUID. Stable, but arbitrary: it
-- consulted no voter preference at all.
--
-- Official protocol (Equal Vote Coalition), applied here:
--   Scoring-round tie for a finalist slot
--     1. head-to-head: who do more voters prefer, among the tied options
--     2. still tied -> most five-star votes
--     3. still tied -> a genuine tie, reported as such
--   Runoff tie (finalists preferred by equally many voters)
--     -> the higher total score wins; only an exact score tie is unresolved
--
-- Output gains `tiebreaks`: an ordered list of every tie encountered, each
-- step tried, the numbers behind it, and which step was decisive.

create or replace function get_poll_results(p_poll_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_invited int;
  v_voted int;
  v_closed boolean;
  v_options jsonb;
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

  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;
  select closed_at is not null into v_closed from polls where id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if not v_closed and (v_invited = 0 or v_voted < v_invited) then
    raise exception 'Results are not available until everyone has voted';
  end if;

  drop table if exists _tally;
  create temp table _tally on commit drop as
  select
    c.id as cid,
    c.name,
    coalesce(sum(s.score), 0)::int as total,
    (count(*) filter (where s.score = 5))::int as five_stars
  from candidates c
  left join scores s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
  group by c.id, c.name;

  -- Walk score groups high to low, filling the two finalist slots. A group
  -- that would overfill the remaining slots is the tie that needs breaking.
  for v_score in select distinct total from _tally order by total desc loop
    exit when v_need <= 0;

    select array_agg(cid order by cid) into v_group from _tally where total = v_score;
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
      join _tally t on t.cid = g.cid
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
  select array_agg(cid order by total desc, cid) into v_finalists
  from _tally where cid = any(v_finalists);

  -- Order the score list so a tie-break winner sits above the option it
  -- beat, rather than falling alphabetically below it.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cid,
    'name', name,
    'total_score', total,
    'average_score', round(total::numeric / v_voted, 2)
  ) order by total desc, (case when cid = any(v_finalists) then 0 else 1 end), name), '[]'::jsonb)
  into v_options
  from _tally;

  if coalesce(array_length(v_finalists, 1), 0) < 2 then
    return jsonb_build_object(
      'options', v_options,
      'finalists', '[]'::jsonb,
      'tie', false,
      'tiebreaks', v_tiebreaks,
      'runoff', null,
      'winner_id', v_finalists[1],
      'voter_count', v_voted,
      'invited_count', v_invited,
      'closed_early', v_closed and v_voted < v_invited
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
    select total into v_ta from _tally where cid = v_a;
    select total into v_tb from _tally where cid = v_b;
    if v_ta > v_tb then
      v_winner := v_a; v_runoff_by := 'higher_score';
    elsif v_tb > v_ta then
      v_winner := v_b; v_runoff_by := 'higher_score';
    else
      v_winner := null; v_runoff_by := 'unresolved';
    end if;
  end if;

  return jsonb_build_object(
    'options', v_options,
    'finalists', jsonb_build_array(v_a, v_b),
    'tie', jsonb_array_length(v_tiebreaks) > 0,
    'tiebreaks', v_tiebreaks,
    'runoff', jsonb_build_object(
      'prefers_a', v_prefers_a,
      'prefers_b', v_prefers_b,
      'ties', v_ties,
      'resolved_by', v_runoff_by
    ),
    'winner_id', v_winner,
    'voter_count', v_voted,
    'invited_count', v_invited,
    'closed_early', v_closed and v_voted < v_invited
  );
end;
$$;

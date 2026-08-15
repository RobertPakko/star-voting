-- Adds voter_count to get_poll_results()'s JSON output so the results
-- page can show how many people participated.

create or replace function get_poll_results(p_poll_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_invited_count int;
  v_voted_count int;
  v_options jsonb;
  v_finalist_a uuid;
  v_finalist_b uuid;
  v_second_score int;
  v_tie_score_count int;
  v_prefers_a int;
  v_prefers_b int;
  v_ties int;
  v_winner uuid;
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

  select count(*) into v_invited_count from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted_count from ballots where poll_id = p_poll_id;

  if v_invited_count = 0 or v_voted_count < v_invited_count then
    raise exception 'Results are not available until everyone has voted';
  end if;

  with tally as (
    select
      c.id as candidate_id,
      c.name,
      coalesce(sum(s.score), 0)::int as total_score,
      coalesce(avg(s.score), 0)::numeric as average_score
    from candidates c
    left join scores s on s.candidate_id = c.id
    where c.poll_id = p_poll_id
    group by c.id, c.name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', candidate_id,
    'name', name,
    'total_score', total_score,
    'average_score', round(average_score, 2)
  ) order by total_score desc, name), '[]'::jsonb)
  into v_options
  from tally;

  with tally as (
    select
      c.id as candidate_id,
      coalesce(sum(s.score), 0)::int as total_score
    from candidates c
    left join scores s on s.candidate_id = c.id
    where c.poll_id = p_poll_id
    group by c.id
  ), ranked as (
    select candidate_id, total_score, row_number() over (order by total_score desc, candidate_id) as rn
    from tally
  )
  select
    (select candidate_id from ranked where rn = 1),
    (select candidate_id from ranked where rn = 2),
    (select total_score from ranked where rn = 2),
    (select count(*)::int from ranked where rn = 3 and total_score = (select total_score from ranked where rn = 2))
  into v_finalist_a, v_finalist_b, v_second_score, v_tie_score_count;

  if v_finalist_a is null or v_finalist_b is null then
    return jsonb_build_object(
      'options', v_options,
      'finalists', '[]'::jsonb,
      'tie', false,
      'runoff', null,
      'winner_id', v_finalist_a,
      'voter_count', v_voted_count
    );
  end if;

  select
    count(*) filter (where a_score > b_score),
    count(*) filter (where b_score > a_score),
    count(*) filter (where a_score = b_score)
  into v_prefers_a, v_prefers_b, v_ties
  from (
    select
      bal.id,
      coalesce((select score from scores where ballot_id = bal.id and candidate_id = v_finalist_a), 0) as a_score,
      coalesce((select score from scores where ballot_id = bal.id and candidate_id = v_finalist_b), 0) as b_score
    from ballots bal
    where bal.poll_id = p_poll_id
  ) t;

  if v_prefers_a > v_prefers_b then
    v_winner := v_finalist_a;
  elsif v_prefers_b > v_prefers_a then
    v_winner := v_finalist_b;
  else
    v_winner := null;
  end if;

  return jsonb_build_object(
    'options', v_options,
    'finalists', jsonb_build_array(v_finalist_a, v_finalist_b),
    'tie', v_tie_score_count > 0,
    'runoff', jsonb_build_object('prefers_a', v_prefers_a, 'prefers_b', v_prefers_b, 'ties', v_ties),
    'winner_id', v_winner,
    'voter_count', v_voted_count
  );
end;
$$;

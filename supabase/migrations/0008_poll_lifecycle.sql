-- Poll lifecycle controls for the creator: close voting early, manage the
-- invitee list, and delete a poll.
--
-- Motivation: results previously unlocked ONLY when every invited voter had
-- voted, with no way out. A single typo'd address or one person who never
-- votes froze that poll's results permanently. These give the creator an
-- escape hatch without weakening ballot secrecy.

alter table polls add column if not exists closed_at timestamptz;

-- ---------------------------------------------------------------------------
-- Closing. One-way on purpose: if a creator could reopen, they could close
-- to peek at partial results, reopen, and keep collecting votes from people
-- who don't know the running tally is already known.
-- ---------------------------------------------------------------------------

create or replace function close_poll(p_poll_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from polls where id = p_poll_id and created_by = auth.uid()) then
    raise exception 'Only the poll creator can close this poll';
  end if;

  if exists (select 1 from polls where id = p_poll_id and closed_at is not null) then
    raise exception 'This poll is already closed';
  end if;

  update polls set closed_at = now() where id = p_poll_id;
end;
$$;

grant execute on function close_poll(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Invitee list guards.
--
-- Removing someone who has already voted is blocked: their ballot is
-- already counted and cannot be honestly un-counted, and silently deleting
-- it would change a result people may have already seen. Removal exists to
-- unstick *pending* voters. Adding to a closed poll is blocked as pointless.
-- ---------------------------------------------------------------------------

create or replace function guard_invitee_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll_id uuid;
begin
  if tg_op = 'DELETE' then
    v_poll_id := old.poll_id;
  else
    v_poll_id := new.poll_id;
  end if;

  -- Parent poll already gone => cascade from deleting the poll itself.
  if not exists (select 1 from polls where id = v_poll_id) then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'INSERT' then
    if exists (select 1 from polls where id = v_poll_id and closed_at is not null) then
      raise exception 'Cannot invite people to a poll that has been closed';
    end if;
    return new;
  end if;

  if exists (
    select 1
    from ballots b
    join auth.users u on u.id = b.voter_id
    where b.poll_id = v_poll_id and lower(u.email) = old.email
  ) then
    raise exception 'Cannot remove someone who has already voted';
  end if;

  return old;
end;
$$;

drop trigger if exists trg_guard_invitee_changes on invited_voters;
create trigger trg_guard_invitee_changes
  before insert or delete on invited_voters
  for each row execute function guard_invitee_changes();

-- ---------------------------------------------------------------------------
-- poll_invitees: lets the creator see who still owes a vote, so they know
-- who to nudge or remove. Exposes only whether each person voted, never how.
-- ---------------------------------------------------------------------------

create or replace function poll_invitees(p_poll_id uuid)
returns table (email text, has_voted boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from polls where id = p_poll_id and created_by = auth.uid()) then
    raise exception 'Only the poll creator can view the invitee list';
  end if;

  return query
  select
    iv.email,
    exists (
      select 1 from ballots b
      join auth.users u on u.id = b.voter_id
      where b.poll_id = p_poll_id and lower(u.email) = iv.email
    )
  from invited_voters iv
  where iv.poll_id = p_poll_id
  order by iv.email;
end;
$$;

grant execute on function poll_invitees(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- poll_status: adds is_closed and results_available. is_complete keeps its
-- old meaning (everyone invited has voted) so the progress UI stays honest;
-- results_available is what actually gates the results view.
--
-- Return signature changes, so this needs a drop rather than a replace.
-- ---------------------------------------------------------------------------

drop function if exists poll_status(uuid);

create function poll_status(p_poll_id uuid)
returns table (
  invited_count int,
  voted_count int,
  is_complete boolean,
  voted boolean,
  is_closed boolean,
  results_available boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
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

  select count(*)::int into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*)::int into v_voted from ballots where poll_id = p_poll_id;
  select closed_at is not null into v_closed from polls where id = p_poll_id;

  return query select
    v_invited,
    v_voted,
    v_invited > 0 and v_voted >= v_invited,
    exists (select 1 from ballots where poll_id = p_poll_id and voter_id = auth.uid()),
    v_closed,
    -- A closed poll with zero ballots has nothing to show.
    v_voted > 0 and (v_closed or (v_invited > 0 and v_voted >= v_invited));
end;
$$;

grant execute on function poll_status(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- submit_ballot: reject votes once a poll is closed, otherwise a late vote
-- could change a result people have already been shown.
-- ---------------------------------------------------------------------------

create or replace function submit_ballot(p_poll_id uuid, p_scores jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_ballot_id uuid;
  v_candidate_count int;
  v_item jsonb;
  v_candidate_id uuid;
  v_score int;
begin
  if v_email is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from polls where id = p_poll_id and closed_at is not null) then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  if not exists (
    select 1 from invited_voters where poll_id = p_poll_id and email = v_email
  ) then
    raise exception 'You are not invited to this poll';
  end if;

  if exists (
    select 1 from ballots where poll_id = p_poll_id and voter_id = auth.uid()
  ) then
    raise exception 'You have already voted in this poll';
  end if;

  select count(*) into v_candidate_count from candidates where poll_id = p_poll_id;

  if jsonb_array_length(p_scores) is distinct from v_candidate_count then
    raise exception 'Must submit a score for every option';
  end if;

  insert into ballots (poll_id, voter_id) values (p_poll_id, auth.uid())
  returning id into v_ballot_id;

  for v_item in select * from jsonb_array_elements(p_scores)
  loop
    v_candidate_id := (v_item ->> 'candidate_id')::uuid;
    v_score := (v_item ->> 'score')::int;

    if v_score < 0 or v_score > 5 then
      raise exception 'Score must be between 0 and 5';
    end if;

    if not exists (select 1 from candidates where id = v_candidate_id and poll_id = p_poll_id) then
      raise exception 'Invalid option for this poll';
    end if;

    insert into scores (ballot_id, candidate_id, score) values (v_ballot_id, v_candidate_id, v_score);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_poll_results: unlock when everyone has voted OR the creator closed
-- the poll, provided at least one ballot exists. Adds closed_early so the
-- UI can caption results that don't represent the full invite list.
-- ---------------------------------------------------------------------------

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
  v_closed boolean;
  v_options jsonb;
  v_finalist_a uuid;
  v_finalist_b uuid;
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
  select closed_at is not null into v_closed from polls where id = p_poll_id;

  if v_voted_count = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if not v_closed and (v_invited_count = 0 or v_voted_count < v_invited_count) then
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
    (select count(*)::int from ranked where rn = 3 and total_score = (select total_score from ranked where rn = 2))
  into v_finalist_a, v_finalist_b, v_tie_score_count;

  if v_finalist_a is null or v_finalist_b is null then
    return jsonb_build_object(
      'options', v_options,
      'finalists', '[]'::jsonb,
      'tie', false,
      'runoff', null,
      'winner_id', v_finalist_a,
      'voter_count', v_voted_count,
      'invited_count', v_invited_count,
      'closed_early', v_closed and v_voted_count < v_invited_count
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
    'voter_count', v_voted_count,
    'invited_count', v_invited_count,
    'closed_early', v_closed and v_voted_count < v_invited_count
  );
end;
$$;

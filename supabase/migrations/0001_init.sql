-- STAR voting app schema, RLS policies, and tally functions.
-- Run this once in the Supabase SQL editor (or via `supabase db push`).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists polls (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists candidates (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  name text not null,
  description text,
  sort_order int not null default 0
);

create table if not exists invited_voters (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  email text not null,
  unique (poll_id, email)
);

create table if not exists ballots (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  voter_id uuid not null references auth.users(id),
  submitted_at timestamptz not null default now(),
  unique (poll_id, voter_id)
);

create table if not exists scores (
  id uuid primary key default gen_random_uuid(),
  ballot_id uuid not null references ballots(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  score smallint not null check (score between 0 and 5),
  unique (ballot_id, candidate_id)
);

create index if not exists idx_candidates_poll_id on candidates(poll_id);
create index if not exists idx_invited_voters_poll_id on invited_voters(poll_id);
create index if not exists idx_invited_voters_email on invited_voters(email);
create index if not exists idx_ballots_poll_id on ballots(poll_id);
create index if not exists idx_scores_ballot_id on scores(ballot_id);
create index if not exists idx_scores_candidate_id on scores(candidate_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table polls enable row level security;
alter table candidates enable row level security;
alter table invited_voters enable row level security;
alter table ballots enable row level security;
alter table scores enable row level security;

-- polls: visible to the creator or anyone invited; only the creator can
-- create/delete their own polls.
create policy "polls_select" on polls
  for select
  using (
    created_by = auth.uid()
    or exists (
      select 1 from invited_voters iv
      where iv.poll_id = polls.id
        and iv.email = lower(auth.jwt() ->> 'email')
    )
  );

create policy "polls_insert" on polls
  for insert
  with check (created_by = auth.uid());

create policy "polls_delete" on polls
  for delete
  using (created_by = auth.uid());

-- candidates: visible to anyone who can see the poll; only the poll creator
-- can manage them.
create policy "candidates_select" on candidates
  for select
  using (
    exists (
      select 1 from polls p
      where p.id = candidates.poll_id
        and (
          p.created_by = auth.uid()
          or exists (
            select 1 from invited_voters iv
            where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
          )
        )
    )
  );

create policy "candidates_insert" on candidates
  for insert
  with check (
    exists (select 1 from polls p where p.id = candidates.poll_id and p.created_by = auth.uid())
  );

create policy "candidates_delete" on candidates
  for delete
  using (
    exists (select 1 from polls p where p.id = candidates.poll_id and p.created_by = auth.uid())
  );

-- invited_voters: the poll creator can see and manage the full list; an
-- invited voter can only see their own row (so participants can't see each
-- other's email addresses).
create policy "invited_voters_select" on invited_voters
  for select
  using (
    email = lower(auth.jwt() ->> 'email')
    or exists (select 1 from polls p where p.id = invited_voters.poll_id and p.created_by = auth.uid())
  );

create policy "invited_voters_insert" on invited_voters
  for insert
  with check (
    exists (select 1 from polls p where p.id = invited_voters.poll_id and p.created_by = auth.uid())
  );

create policy "invited_voters_delete" on invited_voters
  for delete
  using (
    exists (select 1 from polls p where p.id = invited_voters.poll_id and p.created_by = auth.uid())
  );

-- ballots: a voter can only ever see their own ballot (used for "have I
-- voted" checks). There is deliberately no insert policy — ballots are only
-- ever created through the submit_ballot() function below.
create policy "ballots_select_own" on ballots
  for select
  using (voter_id = auth.uid());

-- scores: deliberately no policies at all. Individual scores are never
-- selectable by clients; they're only readable in aggregate through the
-- get_poll_results() function, which runs as SECURITY DEFINER.

-- Table-level API grants. These are required for PostgREST (the Supabase
-- Data API) to expose these tables to the `authenticated` role at all --
-- RLS policies above then narrow that access down per-row. Assumes the
-- project has "Automatically expose new tables" disabled, which is
-- Supabase's own recommended setting; if left enabled these grants are
-- redundant but harmless.
grant select, insert, delete on polls to authenticated;
grant select, insert, delete on candidates to authenticated;
grant select, insert, delete on invited_voters to authenticated;
grant select on ballots to authenticated;
-- No grants on `scores` for any client role -- it's only ever written or
-- read by the SECURITY DEFINER functions below, which run as the table
-- owner and bypass these grants entirely.

-- ---------------------------------------------------------------------------
-- submit_ballot: the only write path for votes. Validates invitation,
-- prevents double voting, validates candidates/scores, and inserts the
-- ballot + its scores atomically.
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
    raise exception 'Must submit a score for every candidate';
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
      raise exception 'Invalid candidate for this poll';
    end if;

    insert into scores (ballot_id, candidate_id, score) values (v_ballot_id, v_candidate_id, v_score);
  end loop;
end;
$$;

grant execute on function submit_ballot(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- poll_status: cheap status check driving the "waiting on others" UI.
-- ---------------------------------------------------------------------------

create or replace function poll_status(p_poll_id uuid)
returns table (
  invited_count int,
  voted_count int,
  is_complete boolean,
  voted boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
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

  return query
  select
    (select count(*)::int from invited_voters where poll_id = p_poll_id),
    (select count(*)::int from ballots where poll_id = p_poll_id),
    (select count(*) from invited_voters where poll_id = p_poll_id) > 0
      and (select count(*) from ballots where poll_id = p_poll_id)
        >= (select count(*) from invited_voters where poll_id = p_poll_id),
    exists (select 1 from ballots where poll_id = p_poll_id and voter_id = auth.uid());
end;
$$;

grant execute on function poll_status(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- get_poll_results: only returns a tally once every invited voter has
-- submitted a ballot. Score round picks the top two candidates by total
-- score (ties at the 2nd-place cutoff are flagged rather than fully
-- resolved per official STAR tie-break rules — a documented v1
-- simplification). Runoff round compares the two finalists head-to-head on
-- every ballot.
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
  v_candidates jsonb;
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
  into v_candidates
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
    max(candidate_id) filter (where rn = 1),
    max(candidate_id) filter (where rn = 2),
    max(total_score) filter (where rn = 2),
    count(*) filter (where rn = 3 and total_score = (select total_score from ranked where rn = 2))
  into v_finalist_a, v_finalist_b, v_second_score, v_tie_score_count
  from ranked;

  if v_finalist_a is null or v_finalist_b is null then
    return jsonb_build_object(
      'candidates', v_candidates,
      'finalists', '[]'::jsonb,
      'tie', false,
      'runoff', null,
      'winner_id', v_finalist_a
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
    'candidates', v_candidates,
    'finalists', jsonb_build_array(v_finalist_a, v_finalist_b),
    'tie', v_tie_score_count > 0,
    'runoff', jsonb_build_object('prefers_a', v_prefers_a, 'prefers_b', v_prefers_b, 'ties', v_ties),
    'winner_id', v_winner
  );
end;
$$;

grant execute on function get_poll_results(uuid) to authenticated;

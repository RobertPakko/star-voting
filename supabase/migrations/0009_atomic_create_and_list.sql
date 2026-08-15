-- Two changes:
--   1. create_poll() -- poll creation in a single transaction. It was three
--      sequential client inserts, so a failure partway (network drop, a
--      rejected invitee) left an orphaned poll with options and no voters,
--      or no options at all, and no way for the user to tell what landed.
--   2. list_polls() -- the whole poll list plus per-poll status in one
--      round trip. The list page was doing one poll_status RPC per poll on
--      top of the initial select (an N+1), so a list of N polls cost N+1
--      requests, all serialized behind the same auth round trip.

-- ---------------------------------------------------------------------------
-- create_poll
-- ---------------------------------------------------------------------------

create or replace function create_poll(
  p_title text,
  p_description text,
  p_options text[],
  p_emails text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll_id uuid;
  v_opts text[];
  v_mails text[];
  v_bad text;
  i int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'Title is required';
  end if;

  -- Drop blanks but keep the author's ordering.
  select array_agg(trim(o) order by ord)
  into v_opts
  from unnest(p_options) with ordinality as t(o, ord)
  where trim(coalesce(o, '')) <> '';

  if coalesce(array_length(v_opts, 1), 0) < 2 then
    raise exception 'Add at least two options';
  end if;

  -- Normalize and dedupe invitees the same way every lookup does.
  select array_agg(distinct lower(trim(e)))
  into v_mails
  from unnest(p_emails) e
  where trim(coalesce(e, '')) <> '';

  if coalesce(array_length(v_mails, 1), 0) < 1 then
    raise exception 'Invite at least one voter';
  end if;

  select m into v_bad
  from unnest(v_mails) m
  where m !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  limit 1;

  if v_bad is not null then
    raise exception '"%" is not a valid email address', v_bad;
  end if;

  insert into polls (title, description, created_by)
  values (trim(p_title), nullif(trim(coalesce(p_description, '')), ''), auth.uid())
  returning id into v_poll_id;

  for i in 1 .. array_length(v_opts, 1) loop
    insert into candidates (poll_id, name, sort_order) values (v_poll_id, v_opts[i], i - 1);
  end loop;

  for i in 1 .. array_length(v_mails, 1) loop
    insert into invited_voters (poll_id, email) values (v_poll_id, v_mails[i]);
  end loop;

  return v_poll_id;
end;
$$;

grant execute on function create_poll(text, text, text[], text[]) to authenticated;

-- Creation now runs entirely through create_poll(), so clients no longer
-- need to insert these rows directly. Options are immutable after creation
-- anyway (see 0007), and invited_voters keeps its grants for the creator's
-- add/remove controls.
revoke insert on polls from authenticated;
revoke insert on candidates from authenticated;

-- ---------------------------------------------------------------------------
-- list_polls: every visible poll plus its status, in one query. The
-- `visible` CTE reimplements the polls_select rule because SECURITY DEFINER
-- bypasses RLS.
-- ---------------------------------------------------------------------------

create or replace function list_polls()
returns table (
  id uuid,
  title text,
  description text,
  created_by uuid,
  created_by_email text,
  created_at timestamptz,
  closed_at timestamptz,
  invited_count int,
  voted_count int,
  is_complete boolean,
  voted boolean,
  is_closed boolean,
  results_available boolean
)
language sql
security definer
set search_path = public
stable
as $$
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
      exists (select 1 from ballots b where b.poll_id = v.id and b.voter_id = auth.uid()) as voted
    from visible v
  )
  select
    v.id,
    v.title,
    v.description,
    v.created_by,
    v.created_by_email,
    v.created_at,
    v.closed_at,
    t.invited_count,
    t.voted_count,
    t.invited_count > 0 and t.voted_count >= t.invited_count,
    t.voted,
    v.closed_at is not null,
    t.voted_count > 0
      and (v.closed_at is not null or (t.invited_count > 0 and t.voted_count >= t.invited_count))
  from visible v
  join tallied t on t.poll_id = v.id
  order by v.created_at desc;
$$;

grant execute on function list_polls() to authenticated;

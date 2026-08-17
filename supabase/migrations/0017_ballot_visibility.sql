-- ---------------------------------------------------------------------------
-- Ballot visibility, as a setting of its own.
--
-- Until now a poll had one privacy dial, show_voters, and it governed *who
-- responded* only: individual scores were never readable through the API at
-- all, in any configuration. Results came back exclusively as an aggregate
-- from poll_tally, and the scores table has RLS on with no policies and no
-- SELECT granted to anyone, so the aggregate was the sole exposure path.
--
-- show_ballots opens a second, deliberate path: the ballots themselves, one
-- row per voter. That makes a poll auditable -- anyone can add the columns
-- up and check poll_tally's arithmetic rather than trusting it -- without
-- giving up the option of a fully private poll.
--
-- The two dials are genuinely independent, and all four combinations mean
-- something:
--
--   show_voters  show_ballots
--   -----------  ------------
--   false        false         fully private (the old default)
--   true         false         a roster of who voted, totals only
--   false        true          anonymous ballots: a verifiable tally that
--                              names nobody
--   true         true          fully auditable: every ballot, with a name
--
-- Three rules the rest of this file exists to enforce:
--
--   1. Ballots unlock on exactly the same terms as results. An early ballot
--      must never be visible to a later voter, or the poll stops being a
--      secret ballot while it is running -- which is the one promise both
--      modes make today.
--   2. The creator gets no exception. Hiding ballots is a promise made to
--      the people who voted, not an access level, so show_ballots = false
--      hides them from everybody.
--   3. When ballots are shown without names, their order must carry no
--      information. See ballot_sheet.
--
-- Nothing here can be changed after creation: authenticated has no UPDATE
-- grant on polls (see 0016), so both dials are frozen the moment create_poll
-- returns. That matters more for this setting than for show_voters -- turning
-- it on later would retroactively publish ballots cast under the opposite
-- promise.
-- ---------------------------------------------------------------------------

-- 0016 is a dump, and dumps blank the search_path. Everything below names
-- objects unqualified, so set it back -- otherwise running the two files
-- back to back in one SQL Editor session fails on the first statement.
set search_path = public;

alter table polls
  add column if not exists show_ballots boolean not null default false;

comment on column polls.show_ballots is
  'Publish individual ballots once results unlock. Independent of show_voters, which decides whether a name is attached to each one.';


-- ---------------------------------------------------------------------------
-- ballot_sheet: every ballot in a poll, as a grid.
--
-- Performs no authorization whatsoever -- it is handed a poll id and a
-- decision about naming, and it renders. Both gates live in its two callers,
-- so EXECUTE is revoked from every client role at the bottom of this file.
-- Same arrangement as poll_tally and star_round.
--
-- The `order by` is the interesting part. Submission order is not neutral:
-- in an open poll that shows respondents, names appear in the voter list as
-- people vote, so anyone refreshing the page while voting is open learns the
-- arrival order. Handing back ballots in submitted_at order would then
-- re-attach the names to the ballots we deliberately left unnamed. So an
-- unnamed sheet sorts on a hash of the ballot id instead:
--
--   * unrelated to time, unlike submitted_at;
--   * stable, so the sheet doesn't reshuffle under a reader who reloads;
--   * still unrelated to time if ballot ids ever become time-ordered, which
--     ordering on the raw id would not survive.
--
-- A named sheet sorts by the name, which is both useful and equally
-- time-free.
-- ---------------------------------------------------------------------------

create or replace function ballot_sheet(p_poll_id uuid, p_named boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_options jsonb;
  v_ballots jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)
                            order by c.sort_order, c.name), '[]'::jsonb)
  into v_options
  from candidates c
  where c.poll_id = p_poll_id;

  select coalesce(jsonb_agg(x.ballot order by x.sort_key), '[]'::jsonb)
  into v_ballots
  from (
    select
      jsonb_build_object(
        -- No ballot id in the payload: on an unnamed sheet it would be the
        -- one field that could be correlated with anything else, and the
        -- client only ever needs a row's position.
        'voter', case when p_named then coalesce(b.voter_name, lower(u.email)) end,
        'scores', coalesce(
          (select jsonb_object_agg(s.candidate_id::text, s.score)
           from scores s where s.ballot_id = b.id),
          '{}'::jsonb)
      ) as ballot,
      case
        when p_named then lower(coalesce(b.voter_name, u.email))
        else md5(b.id::text)
      end as sort_key
    from ballots b
    -- Invite ballots carry a voter_id and no name; open ones the reverse.
    left join auth.users u on u.id = b.voter_id
    where b.poll_id = p_poll_id
  ) x;

  return jsonb_build_object(
    'voters_named', p_named,
    'options', v_options,
    'ballots', v_ballots
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- poll_ballots: the sheet for an invite poll, gated by session.
--
-- Access mirrors get_poll_results exactly -- creator or invitee, and only
-- once the poll is complete or closed -- with the show_ballots check on top.
-- ---------------------------------------------------------------------------

create or replace function poll_ballots(p_poll_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_invited int;
  v_voted int;
begin
  select * into v_poll from polls where id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  -- Same "not found" for a poll that exists but isn't yours: whether a given
  -- id is a real poll is not something an outsider needs to learn.
  if not (
    v_poll.created_by = auth.uid()
    or exists (
      select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email
    )
  ) then
    raise exception 'Poll not found';
  end if;

  if v_poll.mode <> 'invite' then
    raise exception 'This poll is open to anyone with the link, so its ballots are read through that link';
  end if;

  -- Deliberately before the creator has been given any special treatment,
  -- because they get none. See rule 2 at the top of this file.
  if not v_poll.show_ballots then
    raise exception 'This poll does not publish individual ballots';
  end if;

  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if v_poll.closed_at is null and (v_invited = 0 or v_voted < v_invited) then
    raise exception 'Ballots are not available until everyone has voted';
  end if;

  return ballot_sheet(p_poll_id, v_poll.show_voters);
end;
$$;


-- ---------------------------------------------------------------------------
-- open_poll_ballots: the sheet for an open poll, gated by the share token.
--
-- The token is the capability, exactly as it is for open_poll_results, so
-- this is anon-callable. Checks run in the same order that function uses:
-- closed before empty, because "results are not available yet" is the
-- accurate thing to say about a poll people can still vote in.
-- ---------------------------------------------------------------------------

create or replace function open_poll_ballots(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll polls;
  v_voted int;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if not v_poll.show_ballots then
    raise exception 'This poll does not publish individual ballots';
  end if;

  if v_poll.closed_at is null then
    raise exception 'Ballots are not available until the poll is closed';
  end if;

  select count(*) into v_voted from ballots where poll_id = v_poll.id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  return ballot_sheet(v_poll.id, v_poll.show_voters);
end;
$$;


-- ---------------------------------------------------------------------------
-- create_poll gains p_show_ballots.
--
-- Dropped rather than replaced: adding a parameter -- even one with a
-- default -- defines a second overload rather than replacing the existing
-- function, and PostgREST refuses to resolve an ambiguous call. The old
-- signature has to go.
-- ---------------------------------------------------------------------------

drop function if exists create_poll(text, text, text[], text[], text, boolean);

create or replace function create_poll(
  p_title text,
  p_description text,
  p_options text[],
  p_emails text[],
  p_mode text default 'invite',
  p_show_voters boolean default true,
  p_show_ballots boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll_id uuid;
  v_token text;
  v_opts text[];
  v_mails text[];
  v_bad text;
  i int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_mode is null or p_mode not in ('invite', 'open') then
    raise exception 'Unknown poll mode';
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

  if p_mode = 'invite' then
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
  else
    -- 122 bits from a v4 UUID, hex digits only, so it needs no escaping in
    -- a URL. gen_random_uuid() is core Postgres -- no extension involved.
    v_token := replace(gen_random_uuid()::text, '-', '');
  end if;

  insert into polls (title, description, created_by, mode, show_voters, show_ballots, public_token)
  values (
    trim(p_title),
    nullif(trim(coalesce(p_description, '')), ''),
    auth.uid(),
    p_mode,
    coalesce(p_show_voters, true),
    coalesce(p_show_ballots, false),
    v_token
  )
  returning id into v_poll_id;

  for i in 1 .. array_length(v_opts, 1) loop
    insert into candidates (poll_id, name, sort_order) values (v_poll_id, v_opts[i], i - 1);
  end loop;

  if p_mode = 'invite' then
    for i in 1 .. array_length(v_mails, 1) loop
      insert into invited_voters (poll_id, email) values (v_poll_id, v_mails[i]);
    end loop;
  end if;

  return v_poll_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- list_polls carries show_ballots too, so the poll list and the duplicate
-- form see the same shape the polls table gives them elsewhere.
--
-- Dropped rather than replaced: a RETURNS TABLE function's column list is
-- part of its return type, and create or replace cannot change it.
-- ---------------------------------------------------------------------------

drop function if exists list_polls();

create or replace function list_polls()
returns table (
  id uuid,
  title text,
  description text,
  created_by uuid,
  created_by_email text,
  created_at timestamptz,
  closed_at timestamptz,
  mode text,
  show_voters boolean,
  show_ballots boolean,
  public_token text,
  invited_count int,
  voted_count int,
  is_complete boolean,
  voted boolean,
  is_closed boolean,
  results_available boolean
)
language sql
stable
security definer
set search_path = public
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
    v.mode,
    v.show_voters,
    v.show_ballots,
    v.public_token,
    t.invited_count,
    t.voted_count,
    t.invited_count > 0 and t.voted_count >= t.invited_count,
    t.voted,
    v.closed_at is not null,
    -- Open polls reveal only on close; invite polls keep the completion
    -- rule as well.
    t.voted_count > 0 and (
      v.closed_at is not null
      or (v.mode = 'invite' and t.invited_count > 0 and t.voted_count >= t.invited_count)
    )
  from visible v
  join tallied t on t.poll_id = v.id
  order by v.created_at desc;
$$;


-- ---------------------------------------------------------------------------
-- open_poll_view carries show_ballots so the public voting page can tell a
-- voter what will happen to their ballot *before* they cast it. Same
-- signature and same return type, so this is a plain replacement.
-- ---------------------------------------------------------------------------

create or replace function open_poll_view(p_token text, p_voter_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll polls;
  v_voted int;
  v_options jsonb;
  v_voters jsonb;
  v_your_name text;
  v_voted_already boolean;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  select count(*)::int into v_voted from ballots where poll_id = v_poll.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'poll_id', c.poll_id,
    'name', c.name,
    'description', c.description,
    'sort_order', c.sort_order
  ) order by c.sort_order, c.name), '[]'::jsonb)
  into v_options
  from candidates c where c.poll_id = v_poll.id;

  -- Names are visible while voting is still open on purpose: knowing whose
  -- vote is outstanding is the point of a named poll. Ballots are not, in
  -- either setting -- those wait for the close, like the results.
  if v_poll.show_voters then
    select coalesce(jsonb_agg(b.voter_name order by lower(b.voter_name)), '[]'::jsonb)
    into v_voters
    from ballots b
    where b.poll_id = v_poll.id and b.voter_name is not null;
  else
    v_voters := null;
  end if;

  if p_voter_key is null or trim(p_voter_key) = '' then
    v_voted_already := false;
  else
    select true, b.voter_name into v_voted_already, v_your_name
    from ballots b
    where b.poll_id = v_poll.id and b.voter_key = p_voter_key;
    v_voted_already := coalesce(v_voted_already, false);
  end if;

  return jsonb_build_object(
    'poll', jsonb_build_object(
      'id', v_poll.id,
      'title', v_poll.title,
      'description', v_poll.description,
      'mode', v_poll.mode,
      'show_voters', v_poll.show_voters,
      'show_ballots', v_poll.show_ballots,
      'closed_at', v_poll.closed_at
    ),
    'options', v_options,
    'voted_count', v_voted,
    'is_closed', v_poll.closed_at is not null,
    -- Open polls reveal only on close, so early votes can never steer late
    -- ones. This is the same promise the invite mode makes.
    'results_available', v_voted > 0 and v_poll.closed_at is not null,
    'voted', v_voted_already,
    'your_name', v_your_name,
    'voters', v_voters
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- Grants. ballot_sheet is reachable only from the two gated functions above,
-- so no client role gets it -- same treatment as poll_tally and star_round.
-- ---------------------------------------------------------------------------

revoke all on function ballot_sheet(uuid, boolean) from public;

revoke all on function poll_ballots(uuid) from public;
grant execute on function poll_ballots(uuid) to authenticated;

revoke all on function open_poll_ballots(text) from public;
grant execute on function open_poll_ballots(text) to anon;
grant execute on function open_poll_ballots(text) to authenticated;

revoke all on function create_poll(text, text, text[], text[], text, boolean, boolean) from public;
grant execute on function create_poll(text, text, text[], text[], text, boolean, boolean) to authenticated;

revoke all on function list_polls() from public;
grant execute on function list_polls() to authenticated;

revoke all on function open_poll_view(text, text) from public;
grant execute on function open_poll_view(text, text) to anon;
grant execute on function open_poll_view(text, text) to authenticated;

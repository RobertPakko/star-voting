-- Who is done adding options, and the poll that opens itself when everybody is.
--
-- The collecting stage had one number and it was the wrong one. A creator
-- watching "7 options" could not tell seven people with one idea each from one
-- person with seven, and had no way at all to tell somebody still thinking
-- from somebody who never opened the link. So the only way to end the stage
-- was to guess when the list had stopped moving.
--
-- **Confirming is "I have had my say", not "I approve this list".** It says
-- the person has looked and has nothing more to add. That is deliberately the
-- weaker of the two readings, and it is what makes the signal stable: a
-- suggestion arriving after somebody confirmed does not un-confirm them, so
-- the poll cannot be kept collecting forever by one late idea. What everyone
-- who votes is promised is that they score the same list, and that promise is
-- kept by finalize_options rather than by this.
--
-- **A confirmation is per question, like a ballot**, because a question is a
-- poll here and each one carries its own list to have a say about. Opening is
-- the act that spans the group -- finalize_options opens every question at
-- once -- so the poll opens itself only when every invitee has confirmed every
-- question in it.
--
-- **Only invitees confirm, exactly as only invitees vote.** submit_ballot
-- refuses anyone off the list and so does this, which is what keeps the roster
-- complete: everyone who can confirm is on it, and the creator's own "I am
-- done" is the Open poll button they already had. A creator who invited
-- themselves is an invitee like any other and confirms with everybody else.
--
-- **An open poll asks for a name, because it has nothing else to go on.** An
-- invite poll knows who is confirming from the session; behind a share link
-- there is no account and a bare count would answer "how many" while the
-- question being asked is "who". A poll that hides its respondents is the one
-- exception and keeps its promise: the name is discarded whatever the client
-- sends, exactly as open_poll_submit discards it, and the stage reports a
-- count and no names.
--
-- **Nothing opens an open poll by itself.** It has no participant list, so
-- there is no set of people to have all confirmed; its creator closes the
-- collecting stage as they always did.

create table if not exists public.option_confirmations (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  -- Filled in on an invite poll, from the session. Null behind a share link,
  -- which has no account to name.
  voter_id uuid references auth.users(id),
  -- The other way round: a name typed behind the link, and null on an invite
  -- poll, whose roster is the invite list. Also null on an open poll that
  -- hides its respondents, which stores no name for the same reason its
  -- ballots do not.
  voter_name text,
  -- The same per-poll browser key a ballot is identified by; see
  -- src/lib/voterKey.ts for what it is worth and what it is not.
  voter_key text,
  confirmed_at timestamptz not null default now()
);

alter table public.option_confirmations owner to postgres;

comment on table public.option_confirmations is
  'One row per person who has said they are done adding options to this question. Read and written only through the confirm functions: no grants and no policies, like results_notices.';

create index if not exists idx_option_confirmations_poll_id
  on public.option_confirmations (poll_id);

-- One confirmation each, by whichever of the two identities the poll has. The
-- name is unique per poll as well, on the same reasoning as uq_ballots_poll_
-- voter_name: a roster with two Anas on it names nobody, and the second one
-- is told to add an initial rather than silently overwriting the first.
create unique index if not exists uq_option_confirmations_poll_voter
  on public.option_confirmations (poll_id, voter_id) where voter_id is not null;

create unique index if not exists uq_option_confirmations_poll_voter_key
  on public.option_confirmations (poll_id, voter_key) where voter_key is not null;

create unique index if not exists uq_option_confirmations_poll_voter_name
  on public.option_confirmations (poll_id, lower(voter_name)) where voter_name is not null;

alter table public.option_confirmations enable row level security;


-- ---------------------------------------------------------------------------
-- Reading the state
-- ---------------------------------------------------------------------------

-- How many people are done adding to this question's list, which is the number
-- the count badge reports while the stage is running -- so it has to be the
-- number the same badge's denominator is counting towards, and that differs by
-- the kind of poll.
--
-- An invite poll is counted **off the invite list** rather than off the
-- confirmations: it reports "3 of 6", and somebody uninvited after confirming
-- must not be able to push the numerator past the denominator. An open poll
-- has no list to count off and no denominator to exceed, so it counts the
-- confirmations themselves.
create or replace function public.poll_confirmed_count(p_poll_id uuid)
returns int
language sql stable security definer set search_path to 'public'
as $$
  select case
    when p.mode = 'invite' then (
      select count(*)::int
      from invited_voters iv
      where iv.poll_id = p.id
        and exists (
          select 1
          from option_confirmations oc
          join auth.users u on u.id = oc.voter_id
          where oc.poll_id = p.id and lower(u.email) = iv.email
        )
    )
    else (
      select count(*)::int from option_confirmations oc where oc.poll_id = p.id
    )
  end
  from polls p
  where p.id = p_poll_id;
$$;

alter function public.poll_confirmed_count(uuid) owner to postgres;
revoke all on function public.poll_confirmed_count(uuid) from public;

comment on function public.poll_confirmed_count(uuid) is
  'How many people have said they are done adding options to this question: invitees who have confirmed on an invite poll, browsers that have on an open one. Internal: it answers about a poll the caller has already established it may read.';


-- Whether this poll has run out of people to wait for: it collects options, it
-- has an invite list, and every name on that list has confirmed every question
-- in the group. Asked of the group rather than of the question because opening
-- is one act over all of them.
create or replace function public.options_confirmed_by_everyone(p_poll public.polls)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select p_poll.mode = 'invite'
     and p_poll.solicit_options
     and p_poll.options_finalized_at is null
     and p_poll.closed_at is null
     and exists (select 1 from invited_voters iv where iv.poll_id = p_poll.id)
     and not exists (
       select 1
       from poll_group_members(p_poll) q
       cross join invited_voters iv
       where iv.poll_id = p_poll.id
         and not exists (
           select 1
           from option_confirmations oc
           join auth.users u on u.id = oc.voter_id
           where oc.poll_id = q.id and lower(u.email) = iv.email
         )
     );
$$;

alter function public.options_confirmed_by_everyone(public.polls) owner to postgres;
revoke all on function public.options_confirmed_by_everyone(public.polls) from public;

comment on function public.options_confirmed_by_everyone(public.polls) is
  'Whether every invitee has confirmed every question in this poll''s group. The invite list is carried on each question, so it is read from this one and applied to all of them. Internal.';


-- ---------------------------------------------------------------------------
-- Opening the poll by itself
-- ---------------------------------------------------------------------------

-- The poll opens when the last person confirms, and this is the whole of it.
--
-- It **returns rather than raises** on every reason not to open, which is the
-- one thing that matters about it: it runs inside somebody else's confirmation
-- and inside an invitee being removed, and neither of those is a request to
-- open the poll. A group whose questions do not all have two options yet is
-- the case that would otherwise fail somebody's button for a rule about a
-- question they were not looking at; the creator still has Open poll, which
-- names the short question and says why.
create or replace function public.open_options_when_all_confirmed(p_poll_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id;

  -- Gone, or on its way out behind a cascade.
  if not found then
    return;
  end if;

  if not options_confirmed_by_everyone(v_poll) then
    return;
  end if;

  -- The floor finalize_options applies, applied here as a reason to wait
  -- rather than as an error: one option is not an election, and a poll that
  -- everybody has finished adding to and that still has nothing to vote on is
  -- a poll for its creator to look at.
  if exists (
    select 1
    from poll_group_members(v_poll) q
    left join candidates c on c.poll_id = q.id
    group by q.id
    having count(c.id) < 2
  ) then
    return;
  end if;

  update polls set options_finalized_at = now()
  where id in (select q.id from poll_group_members(v_poll) q)
    and options_finalized_at is null;
end;
$$;

alter function public.open_options_when_all_confirmed(uuid) owner to postgres;
revoke all on function public.open_options_when_all_confirmed(uuid) from public;

comment on function public.open_options_when_all_confirmed(uuid) is
  'Opens a soliciting poll for voting once every invitee has confirmed every question in it, and does nothing at all otherwise. Internal: called after a confirmation and after an invitee is removed, so it must never raise.';


-- Taking somebody off the invite list is the other way the poll can run out of
-- people to wait for -- "we are waiting on Bob, and Bob is not coming" -- so
-- the same check runs there. Their confirmation goes with them: leaving it
-- behind would mean a re-invited person counted as done without having been
-- asked again.
create or replace function public.clear_confirmation_for_uninvited()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  delete from option_confirmations oc
  using auth.users u
  where oc.voter_id = u.id
    and oc.poll_id = old.poll_id
    and lower(u.email) = old.email;

  perform open_options_when_all_confirmed(old.poll_id);
  return null;
end;
$$;

alter function public.clear_confirmation_for_uninvited() owner to postgres;
revoke all on function public.clear_confirmation_for_uninvited() from public;

create or replace trigger trg_clear_confirmation_for_uninvited
  after delete on public.invited_voters
  for each row execute function public.clear_confirmation_for_uninvited();


-- ---------------------------------------------------------------------------
-- Confirming: the two ways in, on the two kinds of poll
-- ---------------------------------------------------------------------------

-- What both paths check about the stage, so neither can be confirmed into a
-- poll that has stopped collecting. The wording matches add_suggested_option's:
-- confirming and suggesting are the two things this stage takes, and they run
-- out at exactly the same moment.
create or replace function public.assert_collecting_options(p_poll public.polls)
returns void
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not p_poll.solicit_options then
    raise exception 'The options for this poll were set when it was created';
  end if;

  if p_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  if p_poll.options_finalized_at is not null then
    raise exception 'The options for this poll are settled and voting has started';
  end if;
end;
$$;

alter function public.assert_collecting_options(public.polls) owner to postgres;
revoke all on function public.assert_collecting_options(public.polls) from public;

comment on function public.assert_collecting_options(public.polls) is
  'Raises unless this poll is still collecting its options. Internal: shared by the confirm functions, in the words add_suggested_option refuses a late suggestion in.';


-- The invite poll's caller, and the check that they are on the list. Same
-- "Poll not found" for a poll that exists but is not theirs, on the reasoning
-- suggest_option states: whether a given id is a real poll is not something an
-- outsider needs to learn.
create or replace function public.confirming_invitee(p_poll_id uuid)
returns public.polls
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.mode <> 'invite' then
    raise exception 'This poll is open to anyone with the link, so its options are confirmed through that link';
  end if;

  -- The same list submit_ballot reads. A creator who is not on it can add
  -- options like anybody else and opens the poll with Open poll, which is
  -- their version of this and always was.
  if not exists (
    select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email
  ) then
    raise exception 'Poll not found';
  end if;

  return v_poll;
end;
$$;

alter function public.confirming_invitee(uuid) owner to postgres;
revoke all on function public.confirming_invitee(uuid) from public;

comment on function public.confirming_invitee(uuid) is
  'The poll behind an invite-mode confirmation, having established that the caller is on its invite list. Internal: shared by confirm_options and unconfirm_options so the two cannot disagree about who may confirm.';


create or replace function public.confirm_options(p_poll_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
begin
  v_poll := confirming_invitee(p_poll_id);
  perform assert_collecting_options(v_poll);

  -- Idempotent: confirming twice is one confirmation, and a double-click on a
  -- slow connection is not an error worth reporting to anybody.
  insert into option_confirmations (poll_id, voter_id)
  values (v_poll.id, auth.uid())
  on conflict do nothing;

  -- The last one in opens the poll. Nothing here is conditional on this
  -- caller being last: the function asks the whole group and shrugs unless it
  -- has run out of people to wait for.
  perform open_options_when_all_confirmed(v_poll.id);
end;
$$;

alter function public.confirm_options(uuid) owner to postgres;
revoke all on function public.confirm_options(uuid) from public;
grant all on function public.confirm_options(uuid) to authenticated;

comment on function public.confirm_options(uuid) is
  'Records that this invitee is done adding options to this question, and opens the poll for voting if that was the last confirmation it was waiting on.';


create or replace function public.unconfirm_options(p_poll_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
begin
  v_poll := confirming_invitee(p_poll_id);
  -- Only while the stage is still running, which is also the only time it can
  -- mean anything: once the poll is open there is nothing left to be done
  -- adding to, and the confirmations are a record of how it got there.
  perform assert_collecting_options(v_poll);

  delete from option_confirmations
  where poll_id = v_poll.id and voter_id = auth.uid();
end;
$$;

alter function public.unconfirm_options(uuid) owner to postgres;
revoke all on function public.unconfirm_options(uuid) from public;
grant all on function public.unconfirm_options(uuid) to authenticated;

comment on function public.unconfirm_options(uuid) is
  'Takes back a confirmation while the poll is still collecting, for somebody who has thought of one more thing. Refused once the list has become a ballot, which is a door that only closes.';


create or replace function public.open_poll_confirm_options(
  p_poll_id uuid,
  p_voter_key text,
  p_voter_name text default null
)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
  v_name text;
begin
  select * into v_poll from polls where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  perform assert_collecting_options(v_poll);

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  -- The same rule open_poll_submit applies to a ballot's name, in the same
  -- order and the same words: a poll that names its respondents needs one, and
  -- a poll that hides them stores none whatever the client sends.
  if v_poll.show_voters then
    v_name := nullif(trim(coalesce(p_voter_name, '')), '');
    if v_name is null then
      raise exception 'Enter your name so the group can see who has confirmed the options';
    end if;
    if length(v_name) > 60 then
      raise exception 'That name is too long';
    end if;
  else
    v_name := null;
  end if;

  if exists (
    select 1 from option_confirmations
    where poll_id = v_poll.id and voter_key = p_voter_key
  ) then
    -- Already done, and saying so is more use than a second row would be.
    return;
  end if;

  begin
    insert into option_confirmations (poll_id, voter_name, voter_key)
    values (v_poll.id, v_name, p_voter_key);
  exception when unique_violation then
    -- Either the name is taken, or this browser raced itself past the check
    -- above; the same two cases open_poll_submit tells apart the same way.
    if v_name is null then
      return;
    end if;
    raise exception '"%" has already confirmed the options. Add a last initial if that is not you.', v_name;
  end;
end;
$$;

alter function public.open_poll_confirm_options(uuid, text, text) owner to postgres;
revoke all on function public.open_poll_confirm_options(uuid, text, text) from public;
grant all on function public.open_poll_confirm_options(uuid, text, text) to anon;
grant all on function public.open_poll_confirm_options(uuid, text, text) to authenticated;

comment on function public.open_poll_confirm_options(uuid, text, text) is
  'Records that whoever holds this browser key is done adding options to this open question, under the name they give. Opens nothing: an open poll has no participant list to have all confirmed, so its creator ends the stage as they always did.';


create or replace function public.open_poll_unconfirm_options(p_poll_id uuid, p_voter_key text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  perform assert_collecting_options(v_poll);

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  delete from option_confirmations
  where poll_id = v_poll.id and voter_key = p_voter_key;
end;
$$;

alter function public.open_poll_unconfirm_options(uuid, text) owner to postgres;
revoke all on function public.open_poll_unconfirm_options(uuid, text) from public;
grant all on function public.open_poll_unconfirm_options(uuid, text) to anon;
grant all on function public.open_poll_unconfirm_options(uuid, text) to authenticated;

comment on function public.open_poll_unconfirm_options(uuid, text) is
  'Takes back this browser''s confirmation while the poll is still collecting; the share-link half of unconfirm_options.';


-- ---------------------------------------------------------------------------
-- Saying so on the three screens a poll is read on
-- ---------------------------------------------------------------------------

-- poll_status gains three columns, so it is dropped rather than replaced: a
-- function's return type cannot be widened in place.
drop function if exists public.poll_status(uuid);

create or replace function public.poll_status(p_poll_id uuid)
returns table(
  invited_count integer,
  voted_count integer,
  is_complete boolean,
  voted boolean,
  is_closed boolean,
  results_available boolean,
  soliciting boolean,
  expires_at timestamp with time zone,
  invited boolean,
  confirmed boolean,
  confirmed_count integer
)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_invited int;
  v_voted int;
begin
  select p.* into v_poll
  from polls p
  where p.id = p_poll_id
    and (
      p.created_by = auth.uid()
      or exists (select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email)
    );

  if not found then
    raise exception 'Poll not found';
  end if;

  select count(*)::int into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*)::int into v_voted from ballots where poll_id = p_poll_id;

  return query select
    v_invited,
    v_voted,
    v_invited > 0 and v_voted >= v_invited,
    exists (select 1 from ballots where poll_id = p_poll_id and voter_id = auth.uid()),
    v_poll.closed_at is not null,
    poll_results_revealed(v_poll),
    v_poll.solicit_options and v_poll.options_finalized_at is null and v_poll.closed_at is null,
    poll_expires_at(v_poll),
    -- Whether this reader may confirm at all, which is not the same question
    -- as whether they may read the poll: a creator who did not invite
    -- themselves reads every word of it and is not one of the people it is
    -- waiting on. The page needs the distinction to decide whether to offer
    -- the button, and only the invite list can answer it.
    exists (select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email),
    exists (
      select 1 from option_confirmations
      where poll_id = p_poll_id and voter_id = auth.uid()
    ),
    -- Not withheld on a poll that hides its respondents, on the same
    -- reasoning the vote count is not: a count names nobody. What that
    -- setting withholds is the roster, which is poll_invitees' business.
    poll_confirmed_count(p_poll_id);
end;
$$;

alter function public.poll_status(uuid) owner to postgres;
revoke all on function public.poll_status(uuid) from public;
grant all on function public.poll_status(uuid) to authenticated;


-- And poll_invitees gains one, for the same reason and by the same route.
drop function if exists public.poll_invitees(uuid);

create or replace function public.poll_invitees(p_poll_id uuid)
returns table(email text, has_voted boolean, has_confirmed boolean)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_is_creator boolean;
  v_is_invited boolean;
  v_show boolean;
  v_mode text;
begin
  select
    p.created_by = auth.uid(),
    p.show_voters,
    p.mode
  into v_is_creator, v_show, v_mode
  from polls p where p.id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  v_is_creator := coalesce(v_is_creator, false);

  select exists (
    select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email
  ) into v_is_invited;

  if not v_is_creator and not v_is_invited then
    raise exception 'Poll not found';
  end if;

  if v_mode <> 'invite' then
    raise exception 'This poll is open to anyone with the link, so it has no invitee list';
  end if;

  if not v_is_creator and not v_show then
    raise exception 'This poll does not show who has responded';
  end if;

  return query
  select
    iv.email,
    case when v_show then exists (
      select 1 from ballots b
      join auth.users u on u.id = b.voter_id
      where b.poll_id = p_poll_id and lower(u.email) = iv.email
    ) else null::boolean end,
    -- Held back on the same terms as has_voted, and that is the point of
    -- putting it here rather than anywhere else: who has confirmed is a
    -- roster, so it is the roster's setting that decides who reads it. A poll
    -- that hides its respondents gives its creator the invite list with no
    -- per-person state on it, exactly as it did before this column existed.
    case when v_show then exists (
      select 1 from option_confirmations oc
      join auth.users u on u.id = oc.voter_id
      where oc.poll_id = p_poll_id and lower(u.email) = iv.email
    ) else null::boolean end
  from invited_voters iv
  where iv.poll_id = p_poll_id
  order by iv.email;
end;
$$;

alter function public.poll_invitees(uuid) owner to postgres;
revoke all on function public.poll_invitees(uuid) from public;
grant all on function public.poll_invitees(uuid) to authenticated;


-- And the poll list, which carries the count badge on every card and so has to
-- be able to fill it in. One more column, so it is dropped and rebuilt like
-- the two above; everything else about it is unchanged, down to its being a
-- SQL function rather than plpgsql for the reason its own comment gives.
drop function if exists public.list_polls(integer, integer);

create or replace function public.list_polls(p_limit integer, p_offset integer)
returns table(
  id uuid,
  title text,
  description text,
  created_by uuid,
  created_by_email text,
  created_at timestamp with time zone,
  closed_at timestamp with time zone,
  mode text,
  show_voters boolean,
  show_ballots boolean,
  solicit_options boolean,
  options_finalized_at timestamp with time zone,
  invited_count integer,
  voted_count integer,
  option_count integer,
  confirmed_count integer,
  is_complete boolean,
  voted boolean,
  is_closed boolean,
  results_available boolean,
  soliciting boolean,
  group_id uuid,
  question_position integer,
  question_title text,
  question_count integer,
  total_count integer
)
language sql stable security definer set search_path to 'public'
as $$
  -- Left as a SQL function rather than plpgsql, as it always was. In plpgsql
  -- the names in RETURNS TABLE become variables that shadow same-named
  -- columns -- `id`, `title`, `voted` and `total_count` all appear below --
  -- and the failure is silent rather than an error. See the note on
  -- poll_winners(), which is plpgsql and has to alias around exactly that.
  with args as (
    -- Floored rather than trusted: a limit of zero or less would ask for an
    -- empty page of a list that has rows in it, and a negative offset is a
    -- syntax error rather than a page.
    select
      greatest(coalesce(p_limit, 1), 1) as lim,
      greatest(coalesce(p_offset, 0), 0) as want
  ), visible as (
    -- The whole row alongside its columns, so the aggregates below can be
    -- handed a poll rather than rebuilding one.
    --
    -- Written out here rather than behind a helper on purpose: a function
    -- call in this predicate is opaque to the planner unless it happens to
    -- inline, and the index 0036 added is only reachable while the
    -- comparison is written where the planner can see it.
    select p.*, p as poll_row
    from polls p
    where (p.group_id is null or p.question_position = 1)
      and (
        p.created_by = auth.uid()
        or exists (
          select 1 from invited_voters iv
          where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
        )
      )
  ), counted as (
    -- The one pass over everything the caller can see. It is the price of
    -- reporting a total at all, and it is the cheap half: one predicate and
    -- no subqueries, against that same index.
    select count(*)::int as total from visible
  ), bounds as (
    -- Where the requested page actually starts. Asking past the end lands on
    -- the last page there is rather than on nothing: a poll deleted from page
    -- three leaves its reader on page three, or on the last page if that was
    -- it. The browser clamps the page number it displays the same way, from
    -- the same total, so the two cannot disagree about what is on screen.
    select
      c.total,
      least(a.want, greatest(((c.total - 1) / a.lim) * a.lim, 0)) as page_start
    from counted c, args a
  ), page as (
    -- The page is taken here, before a single aggregate has run.
    --
    -- `id` breaks ties on `created_at`, because offset paging is only correct
    -- over a total order: two rows that compare equal may come back in either
    -- order, and then a row can land on two pages or on none, silently. In
    -- the app polls are made one at a time and their timestamps differ, so
    -- this is insurance -- nothing *enforces* that they differ. In the test
    -- suite it is load-bearing: a case is one transaction, so every poll a
    -- case creates shares a created_at to the microsecond.
    select v.*
    from visible v
    order by v.created_at desc, v.id desc
    limit (select a.lim from args a)
    offset (select b.page_start from bounds b)
  ), tallied as (
    select
      v.id as poll_id,
      -- Per question, and the question is the first one: the invite list is
      -- the same on every question, and a turnout that differs between them
      -- is not a number this list has room to reconcile. The card shows the
      -- question count in its place on a grouped poll.
      (select count(*)::int from invited_voters iv where iv.poll_id = v.id) as invited_count,
      (select count(*)::int from ballots b where b.poll_id = v.id) as voted_count,
      (select count(*)::int from candidates c where c.poll_id = v.id) as option_count,
      -- The same, and per question for the same reason. It is what the count
      -- badge reports while the poll is still collecting, in place of the
      -- turnout that has not started moving yet.
      poll_confirmed_count(v.id) as confirmed_count,
      (select count(*)::int from poll_group_members(v.poll_row)) as question_count,
      -- Asked of every question: a poll is answered when all of it is.
      (select bool_and(
                exists (select 1 from ballots b where b.poll_id = q.id and b.voter_id = auth.uid()))
         from poll_group_members(v.poll_row) q) as voted,
      (select bool_and(
                (select count(*) from invited_voters iv where iv.poll_id = q.id) > 0
                and (select count(*) from ballots b where b.poll_id = q.id)
                    >= (select count(*) from invited_voters iv where iv.poll_id = q.id))
         from poll_group_members(v.poll_row) q) as is_complete,
      (select bool_and(q.closed_at is not null)
         from poll_group_members(v.poll_row) q) as is_closed
    from page v
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
    v.solicit_options,
    v.options_finalized_at,
    t.invited_count,
    t.voted_count,
    t.option_count,
    t.confirmed_count,
    t.is_complete,
    t.voted,
    t.is_closed,
    poll_results_revealed(v.poll_row),
    v.solicit_options and v.options_finalized_at is null and v.closed_at is null,
    v.group_id,
    v.question_position,
    v.question_title,
    t.question_count,
    (select c.total from counted c)
  from page v
  join tallied t on t.poll_id = v.id
  order by v.created_at desc, v.id desc;
$$;

alter function public.list_polls(integer, integer) owner to postgres;
revoke all on function public.list_polls(integer, integer) from public;
grant all on function public.list_polls(integer, integer) to authenticated;

comment on function public.list_polls(integer, integer) is
  'One page of the caller''s poll list, newest first, with the total on every row. The page is taken before the per-poll aggregates run, so the work is proportional to the rows returned rather than to everything the caller can see. An offset past the end returns the last page there is.';


-- The share link's own view of the same three facts. It returns jsonb, so
-- nothing has to be dropped: a browser holding the old code simply reads none
-- of the new keys.
create or replace function public.open_poll_view(p_poll_id uuid, p_voter_key text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
  v_voted int;
  v_options jsonb;
  v_voters jsonb;
  v_your_name text;
  v_your_scores jsonb;
  v_voted_already boolean;
  v_confirmations jsonb;
  v_confirmed_count int;
  v_confirmed boolean;
  v_your_confirmed_name text;
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

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

  -- Who is done adding options, on the same setting and with none of the
  -- embargo the ballot roster carries: what that embargo protects is the
  -- order ballots arrived in, and while a poll is collecting options there
  -- are no ballots to attach an order to. Alphabetical, like the other one.
  if v_poll.show_voters then
    select coalesce(jsonb_agg(oc.voter_name order by lower(oc.voter_name)), '[]'::jsonb)
    into v_confirmations
    from option_confirmations oc
    where oc.poll_id = v_poll.id and oc.voter_name is not null;
  else
    v_confirmations := null;
  end if;

  -- Through the shared function rather than counted here, so the number the
  -- share link reads and the number an account reads are one number.
  v_confirmed_count := poll_confirmed_count(v_poll.id);

  -- Your own ballot comes back with it, so "change my vote" can hand it to
  -- you filled in without a second request. Reaching it needs the voter_key,
  -- which is the same thing that had to be held to cast it; nobody else's
  -- ballot is readable here at any stage of any poll.
  if p_voter_key is null or trim(p_voter_key) = '' then
    v_voted_already := false;
    v_confirmed := false;
  else
    select
      true,
      b.voter_name,
      coalesce(
        (select jsonb_object_agg(s.candidate_id::text, s.score)
         from scores s where s.ballot_id = b.id),
        '{}'::jsonb)
    into v_voted_already, v_your_name, v_your_scores
    from ballots b
    where b.poll_id = v_poll.id and b.voter_key = p_voter_key;
    v_voted_already := coalesce(v_voted_already, false);

    -- And your own confirmation, reached with the same key and for the same
    -- reason: the page has to be able to draw the button you already pressed.
    select true, oc.voter_name
    into v_confirmed, v_your_confirmed_name
    from option_confirmations oc
    where oc.poll_id = v_poll.id and oc.voter_key = p_voter_key;
    v_confirmed := coalesce(v_confirmed, false);
  end if;

  return jsonb_build_object(
    'poll', jsonb_build_object(
      'id', v_poll.id,
      'title', v_poll.title,
      'description', v_poll.description,
      'mode', v_poll.mode,
      'show_voters', v_poll.show_voters,
      'show_ballots', v_poll.show_ballots,
      'solicit_options', v_poll.solicit_options,
      'closed_at', v_poll.closed_at,
      -- Null on a poll that asks one question, which is what tells the page
      -- to render no question strip rather than a strip of one.
      'group_id', v_poll.group_id,
      'question_position', v_poll.question_position,
      'question_title', v_poll.question_title
    ),
    'options', v_options,
    'voted_count', v_voted,
    'is_closed', v_poll.closed_at is not null,
    -- Still gathering options: no ballot yet, and nothing to reveal.
    'soliciting', v_poll.solicit_options
                  and v_poll.options_finalized_at is null
                  and v_poll.closed_at is null,
    -- Open polls reveal only on close, so early votes can never steer late
    -- ones. This is the same promise the invite mode makes, and it is now
    -- the same function answering for both.
    'results_available', poll_results_revealed(v_poll),
    'voted', v_voted_already,
    'your_name', v_your_name,
    'your_scores', v_your_scores,
    'voters', v_voters,
    'confirmed', v_confirmed,
    'your_confirmed_name', v_your_confirmed_name,
    'confirmed_count', v_confirmed_count,
    'confirmations', v_confirmations
  );
end;
$$;

alter function public.open_poll_view(uuid, text) owner to postgres;
revoke all on function public.open_poll_view(uuid, text) from public;
grant all on function public.open_poll_view(uuid, text) to anon;
grant all on function public.open_poll_view(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Telling the pages watching
-- ---------------------------------------------------------------------------

-- A confirmation moves a roster everyone in the poll is reading, and the last
-- one moves the poll itself. Statement-level, like the triggers on ballots and
-- candidates: one message per statement rather than one per row.
create or replace trigger option_confirmations_broadcast_insert
  after insert on public.option_confirmations
  referencing new table as new_rows
  for each statement execute function public.broadcast_polls_touched();

create or replace trigger option_confirmations_broadcast_delete
  after delete on public.option_confirmations
  referencing old table as old_rows
  for each statement execute function public.broadcast_polls_emptied();

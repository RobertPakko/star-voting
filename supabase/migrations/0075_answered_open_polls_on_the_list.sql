-- The poll list carries the open polls this account has answered, from the
-- database rather than from the browser.
--
-- An open poll somebody else made got onto the list one way: the browser
-- remembered every open poll it had opened (src/lib/openedPolls.ts) and
-- handed the ids in as p_open_ids. That made the list a fact about a browser
-- -- opened on the phone was not on the laptop's list -- and it made the
-- list's live updates awkward, because an open poll's voters are nobody the
-- database could tell: the page had to watch one `poll:<id>` topic per such
-- poll, and work out which could be on a page before it had read the page.
--
-- 0074 put the account on every ballot and confirmation cast through a link
-- while signed in. That is exactly the fact the list was missing, so the list
-- now reads it: **an open poll is on your list when your account has voted in
-- or confirmed any question of it**, on every device you sign in on, and
-- p_open_ids is gone.
--
-- **What that gives up, plainly.** An open poll you only opened, and one you
-- answered while signed out, is no longer listed. Recording "this account
-- opened that poll" on the server is the one join AGENTS.md has always
-- refused; recording that it *answered* the poll was already done by 0074, for
-- a reason the voter asked for, so listing it tells the database nothing new.
--
-- **And the list is told, like every other list.** broadcast_poll_change and
-- broadcast_poll_gone now reach the `user:<id>` topic of every account with a
-- ballot or a confirmation in the poll's group, beside its creator and its
-- invitees, so the page watches its reader's topic and nothing else.
-- broadcast_polls_emptied also tells the accounts whose own rows are leaving,
-- which is how a confirmation taken back takes its poll off that account's
-- list on every screen showing it: after the delete, they are no longer in
-- the audience broadcast_poll_change reads.
--
-- list_polls loses an argument, so it is dropped and recreated, and its grant
-- is restated -- a function created fresh is executable by PUBLIC. A browser
-- still on the previous build calls it with p_open_ids, gets PGRST202, and
-- asks again without them (PollList has always done that), so it gets the new
-- list rather than no list.

-- Every lookup below goes by account first. 0074's unique indexes lead with
-- poll_id, which serves "this reader's ballot in this question" and not
-- "every question this reader answered".
create index if not exists idx_ballots_account_id
  on public.ballots (account_id) where account_id is not null;

create index if not exists idx_option_confirmations_account_id
  on public.option_confirmations (account_id) where account_id is not null;

-- ---------------------------------------------------------------------------
-- Who hears that a poll moved
-- ---------------------------------------------------------------------------

create or replace function public.poll_answering_accounts(p_poll_id uuid)
returns setof uuid
    language sql stable security definer
    set search_path to 'public'
    as $$
  -- The accounts that have answered this poll through its link, in any of
  -- its questions: the list's row for a group is its first question, and a
  -- vote in the third is on that row as surely as one in the first.
  with poll as (
    select p.id, p.group_id from polls p where p.id = p_poll_id
  ), questions as (
    select q.id from polls q, poll
    where q.id = poll.id or (poll.group_id is not null and q.group_id = poll.group_id)
  )
  select b.account_id from ballots b
  where b.poll_id in (select id from questions) and b.account_id is not null
  union
  select oc.account_id from option_confirmations oc
  where oc.poll_id in (select id from questions) and oc.account_id is not null;
$$;

alter function public.poll_answering_accounts(uuid) owner to "postgres";

comment on function public.poll_answering_accounts(uuid) is
  'The accounts with a ballot or a confirmation cast through the link in any question of this poll''s group -- the people an open poll is on the list of, besides its creator. Internal: the broadcast functions read it.';

revoke all on function public.poll_answering_accounts(uuid) from public;

CREATE OR REPLACE FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_creator uuid;
  v_user uuid;
begin
  if p_poll_id is null then
    return;
  end if;

  -- A poll that is on its way out has nobody left to tell, and its rows are
  -- following it: without this, every cascade delete would send one message
  -- per child row for a poll that no longer exists. It is also what keeps
  -- the nightly purge silent.
  select created_by into v_creator
  from polls where id = p_poll_id;
  if not found then
    return;
  end if;

  perform announce('poll:' || p_poll_id::text, 'poll_changed');

  -- And the same trick for the poll list, which holds no poll id at all until
  -- it has read one: everyone whose list this poll is on. Its creator, its
  -- invitees, and -- on an open poll -- every account that has answered it
  -- through the link, which is the third way onto the list since 0075.
  -- `union` rather than `union all`: a creator who invited themselves, or
  -- voted in their own open poll, is one reader with one list.
  for v_user in
    select u.id from auth.users u where u.id = v_creator
    union
    select u.id
    from invited_voters iv
    join auth.users u on lower(u.email) = lower(iv.email)
    where iv.poll_id = p_poll_id
    union
    select a from poll_answering_accounts(p_poll_id) a
  loop
    perform announce('user:' || v_user::text, 'polls_changed');
  end loop;
end;
$$;

COMMENT ON FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") IS 'Tells anyone watching this poll that it moved, without saying how: the poll''s own topic, and the list of everyone it is on -- its creator, its invitees, and every account that has answered it through its link. Each of them once per transaction, however many statements the change took; see announce(). Internal: called from the broadcast triggers, never by a client.';

CREATE OR REPLACE FUNCTION "public"."broadcast_poll_gone"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user uuid;
begin
  -- The nightly purge stays silent, exactly as it always has. It is one
  -- statement that can take hundreds of expired polls at once, months after
  -- anybody last looked at them, and announcing each of them to everyone
  -- they were ever shared with is a burst of messages in the small hours to
  -- tell nobody about a poll they had long since finished with.
  -- purge_old_polls() sets this for its own transaction and nothing else
  -- does; see below.
  if coalesce(current_setting('app.purging_polls', true), '') = 'on' then
    return old;
  end if;

  -- Whoever has the poll itself open. Under an event of its own, because
  -- `poll_changed` means "re-read" and a re-read of a poll that has gone is a
  -- read that fails; `poll_deleted` is the answer rather than a prompt to go
  -- and find one. A group goes out question by question through this same
  -- trigger, and each question's page is watching its own topic, so each
  -- one is told.
  perform announce('poll:' || old.id::text, 'poll_deleted');

  -- The audience broadcast_poll_change() reaches, read while it can still be
  -- read -- this is a BEFORE trigger, so the invitees, the ballots and the
  -- confirmations that decide it are all still here. `union` rather than
  -- `union all`: a creator who invited themselves is one reader with one list.
  --
  -- A group goes out as several polls through this same trigger, and each
  -- question reaches the same lists. They hear once: a list re-read after the
  -- commit already has every question gone, so the second message was only
  -- ever a second round trip to show the same thing. See announce().
  for v_user in
    select u.id from auth.users u where u.id = old.created_by
    union
    select u.id
    from invited_voters iv
    join auth.users u on lower(u.email) = lower(iv.email)
    where iv.poll_id = old.id
    union
    select a from poll_answering_accounts(old.id) a
  loop
    perform announce('user:' || v_user::text, 'polls_changed');
  end loop;

  return old;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."broadcast_polls_emptied"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll uuid;
  v_user uuid;
begin
  for v_poll in select distinct poll_id from old_rows loop
    perform broadcast_poll_change(v_poll);
  end loop;

  -- The accounts whose own rows these were. After the delete they are no
  -- longer anybody broadcast_poll_change() can find, and the poll may have
  -- just left their list with them -- a confirmation taken back was the only
  -- reason it was on it. Read off the row as json because this one trigger
  -- function serves every table that announces a delete, and only ballots and
  -- option_confirmations carry the column; everywhere else it is null and
  -- this loop is empty. A poll being deleted says nothing here either: its
  -- rows cascade after broadcast_poll_gone has already told these lists, and
  -- announce() drops the repeat.
  for v_user in
    select distinct (to_jsonb(o) ->> 'account_id')::uuid from old_rows o
    where to_jsonb(o) ->> 'account_id' is not null
      and exists (select 1 from polls p where p.id = o.poll_id)
  loop
    perform announce('user:' || v_user::text, 'polls_changed');
  end loop;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- The list
-- ---------------------------------------------------------------------------

drop function if exists public.list_polls(integer, integer, uuid[]);

create function public.list_polls(p_limit integer, p_offset integer)
returns table(
  id uuid, title text, description text, created_by uuid, created_by_email text,
  created_at timestamp with time zone, closed_at timestamp with time zone, mode text,
  show_voters boolean, show_ballots boolean, solicit_options boolean,
  options_finalized_at timestamp with time zone, invited_count integer, voted_count integer,
  option_count integer, confirmed_count integer, is_complete boolean, voted boolean,
  is_closed boolean, results_available boolean, soliciting boolean, group_id uuid,
  question_position integer, question_title text, question_count integer,
  winner_name text, winner_settled boolean, total_count integer
)
    language sql stable security definer
    set search_path to 'public'
    as $$
  -- Left as a SQL function rather than plpgsql, as it always was. In plpgsql
  -- the names in RETURNS TABLE become variables that shadow same-named
  -- columns -- `id`, `title`, `voted`, `winner_name` and `total_count` all
  -- appear below -- and the failure is silent rather than an error. See the
  -- note on poll_winners(), which is plpgsql and has to alias around exactly
  -- that.
  with args as (
    -- Floored rather than trusted: a limit of zero or less would ask for an
    -- empty page of a list that has rows in it, and a negative offset is a
    -- syntax error rather than a page.
    select
      greatest(coalesce(p_limit, 1), 1) as lim,
      greatest(coalesce(p_offset, 0), 0) as want
  ), answered as (
    -- The open polls this account has answered through their links, by the
    -- id of the row the list carries for them: a group's first question,
    -- whichever question was answered. Read off the account's own rows by
    -- the account indexes 0075 adds, so it costs what this reader has done
    -- rather than what everybody has.
    select distinct coalesce(head.id, q.id) as id
    from (
      select b.poll_id from ballots b where b.account_id = auth.uid()
      union
      select oc.poll_id from option_confirmations oc where oc.account_id = auth.uid()
    ) a
    join polls q on q.id = a.poll_id
    left join polls head
      on q.group_id is not null and head.group_id = q.group_id and head.question_position = 1
    where q.mode = 'open'
  ), visible as (
    -- The whole row alongside its columns, so the aggregates below can be
    -- handed a poll rather than rebuilding one.
    --
    -- Written out here rather than behind a helper on purpose: a function
    -- call in this predicate is opaque to the planner unless it happens to
    -- inline, and the index 0036 added is only reachable while the
    -- comparison is written where the planner can see it.
    --
    -- The third way onto the list is an open poll this account has answered
    -- through its link. Answering it is already a right to read it, and the
    -- account on the ballot is already recorded (0074), so listing it shows
    -- the reader nothing they could not ask for and tells the database
    -- nothing it does not know.
    --
    -- `via_link` marks the rows that are here only for that reason, so the
    -- columns below can withhold what a link does not carry.
    select p.*, p as poll_row,
      not (
        p.created_by = auth.uid()
        or exists (
          select 1 from invited_voters iv
          where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
        )
      ) as via_link
    from polls p
    where (p.group_id is null or p.question_position = 1)
      and (
        p.created_by = auth.uid()
        or exists (
          select 1 from invited_voters iv
          where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
        )
        or p.id in (select a.id from answered a)
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
      -- Asked of every question: a poll is answered when all of it is. By
      -- the account either way it can hold a ballot: as an invitee, or
      -- through the link.
      (select bool_and(
                exists (select 1 from ballots b
                        where b.poll_id = q.id
                          and (b.voter_id = auth.uid() or b.account_id = auth.uid())))
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
    -- Nobody reading an open poll through its link is told who made it:
    -- `open_poll_view` does not return the address, and this list must not
    -- become the way round that. The creator's account id goes with it,
    -- since it names the same person to anybody who can match it up.
    case when v.via_link then null else v.created_by end,
    case when v.via_link then null else v.created_by_email end,
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
    -- A group's row here *is* its first question, so this is that question's
    -- winner rather than the poll's -- a poll of several questions has one
    -- answer each and none to put beside its title. The badge withholds it on
    -- `question_count > 1` and always did; see PollStateBadge, which decides
    -- that in one place rather than trusting three callers to remember.
    v.winner_name,
    v.winner_settled_at is not null,
    (select c.total from counted c)
  from page v
  join tallied t on t.poll_id = v.id
  order by v.created_at desc, v.id desc;
$$;

alter function public.list_polls(integer, integer) owner to "postgres";

comment on function public.list_polls(integer, integer) is
  'One page of the caller''s poll list, newest first, with the total on every row: the polls they made, the polls they are invited to, and the open polls their account has voted in or confirmed through the link -- which carry no creator. The page is taken before the per-poll aggregates run, so the work is proportional to the rows returned rather than to everything the caller can see. An offset past the end returns the last page there is.';

revoke all on function public.list_polls(integer, integer) from public;
grant all on function public.list_polls(integer, integer) to authenticated;

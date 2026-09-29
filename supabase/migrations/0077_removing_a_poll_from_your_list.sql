-- Removing a poll from your list, for the account rather than the browser.
--
-- There was a way to hide a poll from the list, and it lived in the browser's
-- localStorage (src/lib/hiddenPolls.ts, now gone). Two things were wrong with
-- it, and both were consequences of where it lived rather than of anything it
-- did.
--
-- **The list is the account's, and hiding was the browser's.** Since 0075 the
-- list is the same on every device an account signs in on, open polls it has
-- answered included. Hiding was not: a poll put away on the laptop was back on
-- the phone. Half of a list following you around is a list that does not.
--
-- **The page was taken before anything was hidden.** list_polls paged over
-- every poll the reader was in and the browser filtered afterwards, so a page
-- of ten polls the reader had hidden came back as an empty page with a pager
-- under it still offering five more. The database could not page around what
-- it did not know about.
--
-- So the database knows. And it is *removing*, not hiding, because it now does
-- the other thing a reader who takes a poll off their list wants: **it stops
-- telling them about it.** A removed poll sends that account no email and no
-- push -- not when voting opens, not when the results are out -- because
-- poll_email_audience, the one function every one of those moments asks,
-- leaves the account out. Everything else about the poll is untouched: it is
-- still readable at its own address, still answerable, still counted in its
-- turnout, and nobody else is told anything. Its creator in particular learns
-- nothing -- no function but the three here and list_polls reads the table.
--
-- **Keyed by the list's row, which is a group's first question.** Removing a
-- poll of five questions is removing the poll, and the list only ever shows
-- the first of them. remove_polls takes whichever question it is handed back
-- to that one, so a caller cannot put half a poll away.
--
-- **Nothing about being in the poll changes, so nothing is withdrawn.** An
-- invitee who removes a poll is still on its invite list and can still vote;
-- the creator can remove their own and still manage it from its page. That is
-- what separates this from leaving, which the app still does not have and
-- which would be a statement *to* the poll rather than about one's own list.
--
-- **Undoable, from the list or from the poll.** poll_is_removed tells the
-- card a reader lands on after answering a removed poll to say so, with a way
-- to put it back. list_polls takes p_removed and answers with the
-- removed polls instead, so the list has a second view to restore them from,
-- and both views carry removed_count so the button into the second one knows
-- whether to be drawn.
--
-- **The one gap, stated.** An invitation is sent when an address is added to
-- the invite list, and does not ask this table: a poll cannot be removed
-- before its reader is in it, so the only way to reach that case is to be
-- taken off a poll's invite list and put back on, and a re-invitation is news.
-- The poll stays removed; the letter still arrives, and says so by being one.

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------

create table public.removed_polls (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- A poll deleted -- by its creator, or by the nightly purge -- takes its
  -- rows with it, so nothing here can outlive the poll it names.
  poll_id uuid not null references public.polls (id) on delete cascade,
  primary key (user_id, poll_id)
);

alter table public.removed_polls owner to "postgres";

-- For the cascade: a poll deleted is found here by poll_id, which the primary
-- key cannot answer on its own since it leads with the account.
create index removed_polls_poll_id_idx on public.removed_polls (poll_id);

-- Row-level security on and no policies, and no grants to anybody: the
-- functions below are the only way in, and each of them reads and writes the
-- caller's own rows and nobody else's. Nobody can read who has removed a poll,
-- which is the whole of the reason this is not a disclosure.
alter table public.removed_polls enable row level security;
revoke all on table public.removed_polls from anon, authenticated;

comment on table public.removed_polls is 'The polls each account has taken off its own list. Read by list_polls, to page around them, and by poll_email_audience, to stop telling that account about them; by nothing else. The poll is keyed by its list row, a group''s first question.';

-- ---------------------------------------------------------------------------
-- Which row is a poll's row on the list
-- ---------------------------------------------------------------------------

create function public.poll_list_row(p_poll_id uuid)
returns uuid
    language sql stable security definer
    set search_path to 'public'
    as $$
  -- A group's first question, or the poll itself when it has none: the row
  -- list_polls draws a poll as. poll_group_members orders nulls first, so a
  -- lone poll is its own first member.
  select q.id
  from polls p, poll_group_members(p) q
  where p.id = p_poll_id
  limit 1;
$$;

alter function public.poll_list_row(uuid) owner to "postgres";
revoke all on function public.poll_list_row(uuid) from public;

comment on function public.poll_list_row(uuid) is 'The id a poll is listed under: its group''s first question, or itself. Internal.';

-- ---------------------------------------------------------------------------
-- Removing and restoring
-- ---------------------------------------------------------------------------

create function public.remove_polls(p_poll_ids uuid[])
returns integer
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_user uuid := auth.uid();
  v_count integer;
begin
  if v_user is null then
    raise exception 'Sign in to change your poll list';
  end if;

  -- Only a poll that is on this reader's list can come off it: one they
  -- made, one they are invited to, or an open poll their account has
  -- answered -- the three ways list_polls lets a poll on. Anything else is
  -- skipped rather than refused, because the ids arrive in a batch and one
  -- of them may name a poll deleted since the page was drawn; a caller is
  -- told how many went in, which is what the browser's own migration of its
  -- old hidden ids needs and all a single click needs.
  insert into removed_polls (user_id, poll_id)
  select distinct v_user, head.id
  from unnest(coalesce(p_poll_ids, array[]::uuid[])) as asked(id)
  join polls head on head.id = poll_list_row(asked.id)
  where head.created_by = v_user
     or is_invited_to_poll(head.id)
     or v_user in (select poll_answering_accounts(head.id))
  on conflict do nothing;

  get diagnostics v_count = row_count;

  -- The reader's list, on every device showing it. The poll's own topic is
  -- not told: nothing about the poll changed.
  if v_count > 0 then
    perform announce('user:' || v_user::text, 'polls_changed');
  end if;

  return v_count;
end;
$$;

alter function public.remove_polls(uuid[]) owner to "postgres";
revoke all on function public.remove_polls(uuid[]) from public;
grant all on function public.remove_polls(uuid[]) to authenticated;

comment on function public.remove_polls(uuid[]) is 'Takes polls off the caller''s list and stops telling them about those polls, by email and by push. Changes nothing about the poll itself. Any question of a group removes the group. Skips ids not on the caller''s list, and returns how many were removed.';

create function public.restore_polls(p_poll_ids uuid[])
returns integer
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_user uuid := auth.uid();
  v_count integer;
begin
  if v_user is null then
    raise exception 'Sign in to change your poll list';
  end if;

  delete from removed_polls r
  where r.user_id = v_user
    and r.poll_id in (
      select poll_list_row(asked.id)
      from unnest(coalesce(p_poll_ids, array[]::uuid[])) as asked(id)
    );

  get diagnostics v_count = row_count;

  if v_count > 0 then
    perform announce('user:' || v_user::text, 'polls_changed');
  end if;

  return v_count;
end;
$$;

alter function public.restore_polls(uuid[]) owner to "postgres";
revoke all on function public.restore_polls(uuid[]) from public;
grant all on function public.restore_polls(uuid[]) to authenticated;

comment on function public.restore_polls(uuid[]) is 'Puts removed polls back on the caller''s list, and the caller back in their notifications. Returns how many came back.';

-- ---------------------------------------------------------------------------
-- Whether the reader removed this one
-- ---------------------------------------------------------------------------

-- Asked by the card a reader lands on after voting or confirming, which is
-- where somebody who removed a poll and then took part in it anyway finds out
-- that they will not hear how it ends -- and can put it back. The caller's own
-- rows and nobody else's, so it says nothing about anybody else.
create function public.poll_is_removed(p_poll_id uuid)
returns boolean
    language sql stable security definer
    set search_path to 'public'
    as $$
  select exists (
    select 1 from removed_polls r
    where r.user_id = auth.uid()
      and r.poll_id = poll_list_row(p_poll_id)
  );
$$;

alter function public.poll_is_removed(uuid) owner to "postgres";
revoke all on function public.poll_is_removed(uuid) from public;
grant all on function public.poll_is_removed(uuid) to authenticated;

comment on function public.poll_is_removed(uuid) is 'Whether the caller has removed this poll (any question of it) from their list. False for anybody not signed in.';

-- ---------------------------------------------------------------------------
-- Nobody is told about a poll they removed
-- ---------------------------------------------------------------------------

-- Restated from 0076 with one clause added at the foot: the accounts that
-- have removed the poll are left out, whichever of the three ways they were
-- in it. Every email and every push about a poll opening or finishing takes
-- its audience from here, so this is the one place the rule has to be said.
create or replace function public.poll_email_audience(p_poll public.polls, p_include_creator boolean, p_actor text)
returns setof text
    language sql stable security definer
    set search_path to 'public'
    as $$
  with told as (
    select lower(p_poll.created_by_email) as email
    where p_poll.created_by_email is not null
    union
    select lower(iv.email)
    from invited_voters iv
    where iv.poll_id = p_poll.id
    union
    -- An open poll's signed-in voters, who are in it as surely as an invitee
    -- is in an invite poll: every account with a ballot or a confirmation in
    -- any question of its group, which is what poll_answering_accounts reads
    -- off the account those rows carry (0074). Nothing is filed for it and
    -- nothing has to be let go.
    select lower(u.email)
    from poll_answering_accounts(p_poll.id) a
    join auth.users u on u.id = a
    where u.email is not null
  ), removed as (
    -- The accounts that have taken this poll off their lists (0077), by
    -- address, since that is what the audience is made of. Asked of the
    -- poll's list row, since that is what a removal is filed against and
    -- the callers hand in whichever question they hold.
    select lower(u.email) as email
    from removed_polls r
    join auth.users u on u.id = r.user_id
    where r.poll_id = poll_list_row(p_poll.id)
      and u.email is not null
  )
  select email
  from told
  where (p_include_creator
          or email is distinct from lower(p_poll.created_by_email))
    -- Null is nobody, and nobody is dropped: an open poll's voter signs
    -- nothing and the purge runs as no one.
    and email is distinct from lower(p_actor)
    and email not in (select r.email from removed r);
$$;

comment on function public.poll_email_audience(public.polls, boolean, text) is 'Every address to tell about something that happened to this poll: every invitee and every account that has answered it through its link signed in, minus the creator where the thing was their own doing, minus the address whose own act caused it, and minus every account that has removed the poll from its list. Internal.';

-- ---------------------------------------------------------------------------
-- The list
-- ---------------------------------------------------------------------------

-- A different argument list is a different function, so this is a drop and a
-- create, with the grant restated. p_removed has a default, so a browser still
-- on the previous build -- which calls with p_limit and p_offset alone -- is
-- answered by this function with the list it always got, less what has been
-- removed.
drop function if exists public.list_polls(integer, integer);

create function public.list_polls(p_limit integer, p_offset integer, p_removed boolean default false)
returns table(
  id uuid, title text, description text, created_by uuid, created_by_email text,
  created_at timestamp with time zone, closed_at timestamp with time zone, mode text,
  show_voters boolean, show_ballots boolean, solicit_options boolean,
  options_finalized_at timestamp with time zone, invited_count integer, voted_count integer,
  option_count integer, confirmed_count integer, is_complete boolean, voted boolean,
  is_closed boolean, results_available boolean, soliciting boolean, group_id uuid,
  question_position integer, question_title text, question_count integer,
  winner_name text, winner_settled boolean, total_count integer, removed_count integer
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
  ), listed as (
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
    --
    -- `removed` marks the polls this account has taken off its list (0077).
    -- They are still the reader's -- still readable, still answerable -- so
    -- they are still *here*, and split off below rather than filtered out:
    -- the same set answers both the list and the removed polls' own view,
    -- and counts both.
    select p.*, p as poll_row,
      exists (
        select 1 from removed_polls r
        where r.user_id = auth.uid() and r.poll_id = p.id
      ) as removed,
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
  ), visible as (
    -- The list being asked for: the polls the reader has not removed, or --
    -- asked with p_removed -- only the ones they have. Split *before* the
    -- total and the page are taken, so the pager counts exactly the polls it
    -- can show and a page is never full of polls nobody asked to see. This is
    -- the whole of what moving removal into the database bought: when it was
    -- kept in the browser, the page was taken first and filtered after, and a
    -- page whose ten polls were all hidden came back looking empty.
    select * from listed l where l.removed = coalesce(p_removed, false)
  ), counted as (
    -- The one pass over everything the caller can see. It is the price of
    -- reporting a total at all, and it is the cheap half: one predicate and
    -- no subqueries, against that same index.
    --
    -- `removed` is how many polls the other view holds, which is what the
    -- button into it is labelled with and whether it is drawn at all.
    select
      (select count(*)::int from visible) as total,
      (select count(*)::int from listed l where l.removed) as removed
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
    (select c.total from counted c),
    (select c.removed from counted c)
  from page v
  join tallied t on t.poll_id = v.id
  order by v.created_at desc, v.id desc;
$$;

alter function public.list_polls(integer, integer, boolean) owner to "postgres";

comment on function public.list_polls(integer, integer, boolean) is
  'One page of the caller''s poll list, newest first, with the total on every row: the polls they made, the polls they are invited to, and the open polls their account has voted in or confirmed through the link -- which carry no creator. The polls the caller has removed are left out, or with p_removed are the only ones listed; either way every row carries how many are removed. The page is taken before the per-poll aggregates run, so the work is proportional to the rows returned rather than to everything the caller can see. An offset past the end returns the last page there is.';

revoke all on function public.list_polls(integer, integer, boolean) from public;
grant all on function public.list_polls(integer, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- The count, for a list with nothing left on it
-- ---------------------------------------------------------------------------

-- list_polls carries removed_count on every row, and a list whose every poll
-- has been removed has no row to carry it on. That is exactly the list whose
-- reader most needs the way back, so the browser asks this when a read comes
-- back empty, and only then.
create function public.removed_poll_count()
returns integer
    language sql stable security definer
    set search_path to 'public'
    as $$
  select count(*)::int
  from removed_polls r
  join polls p on p.id = r.poll_id
  where r.user_id = auth.uid()
    and (
      p.created_by = auth.uid()
      or is_invited_to_poll(p.id)
      or auth.uid() in (select poll_answering_accounts(p.id))
    );
$$;

alter function public.removed_poll_count() owner to "postgres";
revoke all on function public.removed_poll_count() from public;
grant all on function public.removed_poll_count() to authenticated;

comment on function public.removed_poll_count() is 'How many polls the caller has removed from their list that are still on it to be restored: the same count list_polls carries as removed_count, for a list with no rows to carry it.';

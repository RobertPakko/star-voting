-- The elected option is kept with the poll, once, rather than re-elected by
-- every browser that looks.
--
-- STAR is not free to run, and the answer it gives about a finished poll
-- cannot change: a poll whose results are out has taken its last vote. Until
-- now that fact was spent entirely in the browser -- `poll_winners()` ran the
-- election on demand and `src/lib/settled.ts` remembered the answer for the
-- life of the tab -- which made the badge cost one election per poll per tab,
-- and left every tab holding an answer nothing could correct.
--
-- The hole that opens is small and real. Reset is the one thing that unsettles
-- a settled poll: it deletes every vote and reopens the poll, which can then
-- finish again with a different answer, and nobody is told. A tab that reset
-- the poll itself threw its own copy away; every other tab, on every other
-- device, kept the name of an option elected by votes that no longer exist and
-- drew it as a settled green badge until it was reloaded.
--
-- So the answer moves to the row it is about. `polls.winner_name` is filled in
-- when the poll crosses the line into having a result, and emptied when a
-- reset takes it back -- the same reconciliation, on the same events, that
-- `notify_results_ready` already performs for the results-are-in email. Three
-- things follow:
--
--  * The election runs once per result, in the transaction that produces it,
--    rather than once per reader.
--  * `list_polls`, `poll_status` and `open_poll_view` -- the three reads that
--    already draw the three screens carrying the badge -- can carry the winner
--    with them for the price of a column, so the badge is final on the first
--    paint and there is no second request behind the page to wait for.
--  * There is one copy of the answer and the database owns it, so a reset
--    anywhere reaches everywhere on the next read.
--
-- `poll_winners()` stays, reading the column instead of running an election.
-- Nothing in the app calls it any more; it is here for the browsers holding
-- the previous build, since this app deploys on push and its migrations land
-- on merge.

-- ---------------------------------------------------------------------------
-- Where the answer lives
-- ---------------------------------------------------------------------------

-- Two columns rather than one, because there are three states and a single
-- nullable text can only tell two of them apart. `winner_settled_at` is the
-- one that says whether the poll has been asked at all; `winner_name` is the
-- answer, and null is a real one -- a genuine tie elects nobody. This is the
-- same distinction the browser used to keep with a Map and a `has` check, for
-- the same reason: *no winner* and *not asked* must never arrive looking
-- alike, or a tie and a missing answer become the same badge.
alter table public.polls
  add column if not exists winner_name text,
  add column if not exists winner_settled_at timestamp with time zone;

comment on column public.polls.winner_name is
  'The option this question elected, null for a question that elected nobody. Meaningful only where winner_settled_at is set. Maintained by settle_winner(); never written by a client.';

comment on column public.polls.winner_settled_at is
  'When this question''s result was worked out. Null means it has none yet -- it is still taking votes, or a reset took its result away.';

do $$
begin
  alter table public.polls
    add constraint polls_winner_settled_ck
    check (winner_name is null or winner_settled_at is not null);
exception when duplicate_object then
  null;
end $$;

-- ---------------------------------------------------------------------------
-- Keeping it true
-- ---------------------------------------------------------------------------

create or replace function public.settle_winner(p_poll_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
  v_question polls;
begin
  select * into v_poll from polls where id = p_poll_id;

  -- A poll on its way out -- the nightly purge, or the creator's own Delete
  -- button -- has no row left to write to, and every ballot cascading after it
  -- arrives here. Same early return, and for the same reason, as
  -- notify_results_ready.
  if not found then
    return;
  end if;

  -- The whole group, not the question that was touched. Results unlock for a
  -- poll of several questions when *all* of them have stopped, so the last
  -- ballot cast on question three is what gives questions one and two their
  -- answers as well; settling only the question that moved would leave those
  -- two blank forever.
  for v_question in select q.* from poll_group_members(v_poll) q loop
    -- The same predicate the three reads report as `results_available`, so a
    -- poll can never say its results are available and have no settled answer
    -- to show. Two conditions written separately would be two chances to
    -- drift.
    if not poll_results_revealed(v_question) then
      -- Back to taking votes. A poll that finishes again is a second result,
      -- and it is worked out from the votes it has then.
      if v_question.winner_settled_at is not null then
        update polls
        set winner_name = null, winner_settled_at = null
        where id = v_question.id;
      end if;

      continue;
    end if;

    -- Already answered, and the answer cannot have changed: every path that
    -- could move this question's tally refuses once its results are out.
    -- revise_ballot and open_poll_revise both check poll_results_revealed;
    -- submit_ballot refuses a closed poll, and an invite poll at full turnout
    -- has nobody left to hear from; guard_invitee_changes refuses a new
    -- invitee once the results are out; and the options were frozen by
    -- guard_options_frozen on the first ballot, with no UPDATE grant on
    -- candidates to rename one afterwards. So this is a skip rather than a
    -- recount, and running the election twice for one result is the thing
    -- this whole migration is about not doing.
    continue when v_question.winner_settled_at is not null;

    update polls
    set winner_name = poll_winner_name(v_question.id),
        winner_settled_at = now()
    where id = v_question.id;
  end loop;
end;
$$;

alter function public.settle_winner(uuid) owner to postgres;
revoke all on function public.settle_winner(uuid) from public;

comment on function public.settle_winner(uuid) is
  'Reconciles every question in one poll''s group with whether it actually has a result: works the winner out once when the poll crosses the line, and forgets it when a reset takes it back. Internal: called from the vote functions and the triggers below, never by a client.';


-- What can carry a poll over the line, and how each one is caught.
--
-- It is the same set of events notify_results_ready is already reconciled on,
-- because "has this poll got a result" is the same question in both cases: a
-- poll closing, the last ballot arriving, a ballot going away, and an invitee
-- being removed -- which can carry an invite poll over the line by lowering
-- the number of people it is waiting for.
--
-- Three of the four are triggers, in the same shapes as the notify triggers
-- beside them. **The fourth cannot be**, and that is worth stating plainly
-- because the obvious implementation is wrong: submit_ballot and
-- open_poll_submit insert the ballot row first and its scores afterwards, each
-- in its own statement, so an AFTER trigger on `ballots` INSERT runs *between*
-- the two. It would elect a winner from a tally whose newest ballot had no
-- scores on it yet -- and the ballot that opens the gate is precisely the last
-- one, so it would get the deciding vote of every invite poll wrong, silently
-- and only there.
--
-- Deferring that trigger to commit does fix the ordering, and was tried: a
-- constraint trigger sees the whole transaction. What it also does is leave
-- `results_available` true and the winner unsettled for the rest of the
-- transaction that closed the poll, so the invariant this file rests on holds
-- only between statements and not within them -- invisible in the app, where
-- every RPC is its own transaction, and load-bearing in the test suite, where
-- a case is one transaction that never commits. So the two vote functions call
-- settle_winner themselves, at the end, where their scores are all in. See
-- their redefinitions below.

create or replace function public.settle_winner_for_emptied()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll uuid;
begin
  for v_poll in select distinct poll_id from old_rows loop
    perform settle_winner(v_poll);
  end loop;
  return null;
end;
$$;

alter function public.settle_winner_for_emptied() owner to postgres;
revoke all on function public.settle_winner_for_emptied() from public;


create or replace function public.settle_winner_for_poll()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  perform settle_winner(NEW.id);
  return null;
end;
$$;

alter function public.settle_winner_for_poll() owner to postgres;
revoke all on function public.settle_winner_for_poll() from public;


-- Closing a poll, and reopening it. Nothing writes a score in either
-- transaction, so there is no ordering to get wrong here and this one fires
-- immediately.
create or replace trigger polls_settle_winner_closed
  after update of closed_at on public.polls
  for each row
  when (new.closed_at is distinct from old.closed_at)
  execute function public.settle_winner_for_poll();

-- Ballots going away: reset_poll, which is the one thing that unsettles a
-- settled poll. It clears closed_at as well, but not always to a different
-- value -- an invite poll revealed by everyone having voted was never closed
-- at all, so the trigger above would not fire for it and this is what takes
-- its winner back.
create or replace trigger ballots_settle_winner_delete
  after delete on public.ballots
  referencing old table as old_rows
  for each statement execute function public.settle_winner_for_emptied();

-- And an invitee being removed, which is the one crossing with no function
-- behind it: the creator's page deletes the row directly.
create or replace trigger invited_voters_settle_winner_delete
  after delete on public.invited_voters
  referencing old table as old_rows
  for each statement execute function public.settle_winner_for_emptied();


-- Settling a winner is not a change to announce.
--
-- Every live page in the app re-reads itself when the database says its poll
-- moved, and `polls_broadcast_update` fires on any update to the row -- so the
-- update settle_winner makes was a second message, and a second read of the
-- same poll by every watcher, on top of the one the close had already sent.
-- 16_live_update_signals is precisely about that: a change announces itself
-- once, and a change that announces itself per row is a page re-reading a poll
-- twenty times because one reset cleared twenty ballots.
--
-- Nothing is lost by staying quiet. settle_winner writes those two columns and
-- no others, and it only ever runs inside a transaction that has already
-- announced the change which produced the result -- the close, the last
-- ballot, the invitee coming off the list. The watcher's re-read of *that*
-- message sees the settled winner, because both writes commit together.
--
-- Both halves of the test matter. The winner columns have to have actually
-- changed, and everything else has to have stayed the same: an update that
-- writes no change at all still announces itself, as it always did, because
-- reset_poll reopens a poll that was never closed by setting closed_at to the
-- null it already held and the poll list is waiting to hear about it.
--
-- The rest is compared as jsonb rather than column by column so that a column
-- added to polls later is covered without anybody remembering to come back
-- here.
create or replace function public.broadcast_poll_updated()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if (
    NEW.winner_name is distinct from OLD.winner_name
    or NEW.winner_settled_at is distinct from OLD.winner_settled_at
  ) and to_jsonb(NEW) - 'winner_name' - 'winner_settled_at'
        is not distinct from
        to_jsonb(OLD) - 'winner_name' - 'winner_settled_at'
  then
    return null;
  end if;

  perform broadcast_poll_change(NEW.id);
  return null;
end;
$$;

alter function public.broadcast_poll_updated() owner to postgres;
revoke all on function public.broadcast_poll_updated() from public;


-- The last ballot of an invite poll is what unlocks its results, so each of
-- the two functions that casts one settles the poll on its way out -- after
-- the scores, which is the whole point, and unconditionally, because
-- settle_winner is the thing that decides whether there is anything to do.
--
-- Both are otherwise verbatim; the added line is the last one before `end`.

create or replace function public.submit_ballot(p_poll_id uuid, p_scores jsonb)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_ballot_id uuid;
  v_item jsonb;
  v_candidate_id uuid;
  v_score int;
  v_candidate_count int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from polls where id = p_poll_id and closed_at is not null) then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  if exists (
    select 1 from polls
    where id = p_poll_id and solicit_options and options_finalized_at is null
  ) then
    raise exception 'This poll is still collecting options, so voting has not started';
  end if;

  if not exists (
    select 1 from invited_voters
    where poll_id = p_poll_id and email = lower(auth.jwt() ->> 'email')
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

  -- Here rather than in a trigger on the insert above, because the scores this
  -- ballot is made of were written after it.
  perform settle_winner(p_poll_id);
end;
$$;

alter function public.submit_ballot(uuid, jsonb) owner to postgres;
revoke all on function public.submit_ballot(uuid, jsonb) from public;
grant all on function public.submit_ballot(uuid, jsonb) to authenticated;


create or replace function public.open_poll_submit(
  p_poll_id uuid,
  p_scores jsonb,
  p_voter_key text,
  p_voter_name text default null
)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
  v_name text;
  v_ballot_id uuid;
  v_option_count int;
  v_item jsonb;
  v_candidate_id uuid;
  v_score int;
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  if v_poll.solicit_options and v_poll.options_finalized_at is null then
    raise exception 'This poll is still collecting options, so voting has not started';
  end if;

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  if v_poll.show_voters then
    v_name := nullif(trim(coalesce(p_voter_name, '')), '');
    if v_name is null then
      raise exception 'Enter your name so the group can see who has voted';
    end if;
    if length(v_name) > 60 then
      raise exception 'That name is too long';
    end if;
  else
    -- A poll that hides respondents must not store one, whatever the client
    -- sends.
    v_name := null;
  end if;

  if exists (select 1 from ballots where poll_id = v_poll.id and voter_key = p_voter_key) then
    raise exception 'You have already voted in this poll';
  end if;

  select count(*) into v_option_count from candidates where poll_id = v_poll.id;

  if jsonb_array_length(p_scores) is distinct from v_option_count then
    raise exception 'Must submit a score for every option';
  end if;

  begin
    insert into ballots (poll_id, voter_id, voter_name, voter_key)
    values (v_poll.id, null, v_name, p_voter_key)
    returning id into v_ballot_id;
  exception when unique_violation then
    -- Either the name is taken, or this browser raced itself (double-click,
    -- double-submit) past the voter_key check above.
    if v_name is null then
      raise exception 'You have already voted in this poll';
    end if;
    raise exception '"%" has already voted in this poll. Add a last initial if that is not you.', v_name;
  end;

  for v_item in select * from jsonb_array_elements(p_scores)
  loop
    v_candidate_id := (v_item ->> 'candidate_id')::uuid;
    v_score := (v_item ->> 'score')::int;

    if v_score < 0 or v_score > 5 then
      raise exception 'Score must be between 0 and 5';
    end if;

    if not exists (select 1 from candidates where id = v_candidate_id and poll_id = v_poll.id) then
      raise exception 'Invalid option for this poll';
    end if;

    insert into scores (ballot_id, candidate_id, score) values (v_ballot_id, v_candidate_id, v_score);
  end loop;

  -- As in submit_ballot, and for the same reason. An open poll reveals only
  -- on close, so this settles nothing today -- but the gate is read from one
  -- function and this keeps the two ballot paths saying the same thing.
  perform settle_winner(v_poll.id);
end;
$$;

alter function public.open_poll_submit(uuid, jsonb, text, text) owner to postgres;
revoke all on function public.open_poll_submit(uuid, jsonb, text, text) from public;
grant all on function public.open_poll_submit(uuid, jsonb, text, text) to anon;
grant all on function public.open_poll_submit(uuid, jsonb, text, text) to authenticated;


-- Every poll that already has a result gets one now, so the badge does not
-- wait for the next thing to happen to a poll that has finished happening.
-- One election apiece, once, here rather than once per reader forever.
-- settle_winner walks the group, so the first question of each is enough.
do $$
declare
  v_id uuid;
begin
  for v_id in
    select p.id from polls p
    where p.group_id is null or p.question_position = 1
  loop
    perform settle_winner(v_id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------

-- poll_winners() no longer runs an election; it reads the column. Nothing in
-- the app calls it -- the three reads below carry the winner themselves now --
-- and it is kept only for the browsers still holding the previous build during
-- a deploy. Its signature is untouched so those browsers keep working.
--
-- The unlock check it used to make is gone because the column already embodies
-- it: winner_name is written only where poll_results_revealed is true, and
-- cleared the moment it stops being. What is left is the visibility test,
-- which is not about the poll's state and still has to be made here.
create or replace function public.poll_winners(p_poll_ids uuid[])
returns table(poll_id uuid, winner_name text)
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_ids uuid[] := coalesce(p_poll_ids, '{}'::uuid[]);
  v_id uuid;
  v_poll polls;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if coalesce(array_length(v_ids, 1), 0) > 200 then
    raise exception 'Too many polls in one request';
  end if;

  foreach v_id in array v_ids loop
    -- Visibility, on exactly the terms list_polls() uses: the polls you
    -- created and the polls you were invited to. An id the caller cannot see
    -- produces no row at all rather than a null one -- "not yours" and "no
    -- winner" are different answers and must not arrive looking alike.
    select * into v_poll from polls p
    where p.id = v_id
      and (
        p.created_by = auth.uid()
        or exists (
          select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email
        )
      );

    continue when not found;

    -- Aliased through the record because this function's own OUT column is
    -- called winner_name, and now so is the table's.
    poll_id := v_id;
    winner_name := v_poll.winner_name;
    return next;
  end loop;
end;
$$;

alter function public.poll_winners(uuid[]) owner to postgres;
revoke all on function public.poll_winners(uuid[]) from public;
grant all on function public.poll_winners(uuid[]) to authenticated;

comment on function public.poll_winners(uuid[]) is
  'The elected option of each poll the caller can see, read from the column settle_winner() maintains. Superseded by the winner_name/winner_settled columns on list_polls() and poll_status(); kept for browsers holding a build that predates them.';


-- poll_status gains two columns, so it is dropped rather than replaced: a
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
  confirmed_count integer,
  winner_name text,
  winner_settled boolean
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
    poll_confirmed_count(p_poll_id),
    -- The two the state badge reads. `winner_settled` is what tells a poll
    -- that elected nobody from one whose answer this database has not worked
    -- out, so a tie can never be drawn as *Results ready* nor the other way
    -- about.
    v_poll.winner_name,
    v_poll.winner_settled_at is not null;
end;
$$;

alter function public.poll_status(uuid) owner to postgres;
revoke all on function public.poll_status(uuid) from public;
grant all on function public.poll_status(uuid) to authenticated;


-- And the poll list, which is the screen this whole change is for: the badge
-- on every finished card now arrives with the card. One more pair of columns,
-- so it is dropped and rebuilt like poll_status above; everything else about
-- it is unchanged, down to its being a SQL function rather than plpgsql for
-- the reason its own comment gives.
--
-- Note what is *not* here: no call to poll_winner_name, and so no election.
-- The objection that kept the winner out of this function was that a column
-- would re-run every finished poll's election on every tick, and this list
-- re-reads itself whenever anything on it moves. A stored column costs a
-- lookup on a row the query has already fetched.
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
  winner_name text,
  winner_settled boolean,
  total_count integer
)
language sql stable security definer set search_path to 'public'
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

alter function public.list_polls(integer, integer) owner to postgres;
revoke all on function public.list_polls(integer, integer) from public;
grant all on function public.list_polls(integer, integer) to authenticated;

comment on function public.list_polls(integer, integer) is
  'One page of the caller''s poll list, newest first, with the total on every row. The page is taken before the per-poll aggregates run, so the work is proportional to the rows returned rather than to everything the caller can see. An offset past the end returns the last page there is.';


-- And the share link's own view of the same thing. It returns jsonb, so
-- nothing has to be dropped: a browser holding the old code reads none of the
-- new keys.
--
-- This one closes a gap rather than saving a request. The public voting page
-- has no account, so it could never call poll_winners() at all; its badge was
-- filled in from whatever tally the Results card underneath it happened to
-- fetch, which meant the badge waited on that card and existed only because
-- that card did. Now it arrives with the page.
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
    'confirmations', v_confirmations,
    -- Withheld until the results are out by settle_winner rather than by a
    -- condition here: the column is empty while the poll is still taking
    -- votes, so there is nothing to leak to an early reader.
    'winner_name', v_poll.winner_name,
    'winner_settled', v_poll.winner_settled_at is not null
  );
end;
$$;

alter function public.open_poll_view(uuid, text) owner to postgres;
revoke all on function public.open_poll_view(uuid, text) from public;
grant all on function public.open_poll_view(uuid, text) to anon;
grant all on function public.open_poll_view(uuid, text) to authenticated;

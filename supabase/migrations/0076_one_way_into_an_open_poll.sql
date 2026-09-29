-- One way for an account to be in an open poll: the account on its ballot.
--
-- 0073 and 0074 were written side by side and each gave an open poll's
-- signed-in voters an account, in two different ways. 0073 added
-- poll_follows: a row the browser filed, in a request of its own, when a
-- signed-in reader voted or confirmed, so that poll_email_audience could email
-- and push them as it does an invitee -- deliberately carrying nothing that
-- joined it to the ballot, and deleted once the results were announced. 0074
-- put the account on the ballot and the confirmation themselves
-- (ballots.account_id), so that the ballot follows its voter between devices
-- and 0075 could list the poll on their home page.
--
-- Once the ballot carries the account, the follow says nothing the ballot
-- does not: the account answered this poll, on the same terms -- signed in,
-- through the link. Two records of one fact are two things to keep in step,
-- and the follow was the weaker of them: filed by the browser as a best
-- effort, so a request that failed was a voter nobody told, and missing for
-- every question answered on a page that moved straight on. So the audience
-- now reads the ballots, through the same poll_answering_accounts that tells
-- the poll list who to wake, and poll_follows goes.
--
-- **What changes for a follower.** They were forgotten once the results went
-- out, so a poll reopened and finished again was not announced to them; an
-- invitee was told both times. They are now told both times as well, because
-- their ballot is still there -- which is the reason an invitee is. And the
-- privacy note 0073 made, that a follow shares nothing with the ballot, is
-- moot rather than broken: 0074 has already recorded the account on the
-- ballot itself, for a signed-in voter, and says so.
--
-- **What is lost.** A follow filed between 0073 applying and this one, for a
-- ballot cast before 0074 gave ballots an account, has no account on the
-- ballot to be read from. That is a window of hours, and the voters in it
-- are exactly as told as they were before either migration: they can press
-- Notify me.
--
-- Both functions are restated verbatim from 0073 but for poll_follows.

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
  )
  select email
  from told
  where (p_include_creator
          or email is distinct from lower(p_poll.created_by_email))
    -- Null is nobody, and nobody is dropped: an open poll's voter signs
    -- nothing and the purge runs as no one.
    and email is distinct from lower(p_actor);
$$;

comment on function public.poll_email_audience(public.polls, boolean, text) is 'Every address to tell about something that happened to this poll: every invitee and every account that has answered it through its link signed in, minus the creator where the thing was their own doing, and minus the address whose own act caused it. Internal.';

create or replace function public.notify_results_ready(p_poll_id uuid)
returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
  v_first polls;
  v_email text;
  -- The last ballot, the removal that left nobody to wait for, or the Close
  -- button: whichever of them crossed the line, it is this transaction and
  -- this is who is in it.
  v_actor text := lower(auth.jwt() ->> 'email');
begin
  select * into v_poll from polls where id = p_poll_id;

  -- A poll on its way out -- the nightly purge, or the creator's own Delete
  -- button -- has nobody left to tell, and its notice row is cascading after
  -- it either way.
  if not found then
    return;
  end if;

  -- poll_group_members orders by question_position with nulls first, so this
  -- is question 1 of a group and the poll itself when it has no group. It is
  -- the row the invitation names, so the two emails about one poll point at
  -- the same page.
  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  if not poll_results_ready(v_first) then
    -- Back to taking votes. A poll that finishes again is a second result,
    -- and the people in it are told about it again.
    delete from results_notices where poll_id = v_first.id;

    -- A poll closed with nobody having voted is finished with nothing to
    -- announce, so its watches will never be answered. Gone now rather than
    -- left on the poll until the purge.
    if v_first.closed_at is not null then
      delete from poll_push_watches where poll_id = v_first.id;
    end if;
    return;
  end if;

  -- The once-only rule, and all of it: two ballots arriving together both run
  -- this, and the primary key decides which of them is the announcement.
  insert into results_notices (poll_id) values (v_first.id)
  on conflict (poll_id) do nothing;

  if not found then
    return;
  end if;

  -- One request per address rather than one request with every address in it;
  -- see the note at the top of 0072.
  for v_email in select * from poll_results_audience(v_first, v_actor) loop
    perform send_results_ready_email(v_first, v_email);
  end loop;

  perform push_poll(v_first, 'results',
    array(select * from poll_results_audience(v_first, v_actor)), true);

  -- A watch has done its job once the results are out. Keeping it would
  -- leave a record on the poll, for the rest of its six months, of a browser
  -- that answered it.
  delete from poll_push_watches where poll_id = v_first.id;
end;
$$;

comment on function public.notify_results_ready(uuid) is 'Reconciles a poll''s results-ready announcement with whether it actually has a result: sends once when it crosses the line, by email and by push, to everybody but whoever crossed it, and forgets when a reopen takes it back. Lets the poll''s watches go once it has nothing left to announce. Internal: called from the triggers on ballots, invited_voters and polls, never by a client.';

drop function if exists public.open_poll_follow(uuid);
drop table if exists public.poll_follows;

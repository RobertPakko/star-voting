-- The rest of "nobody is told what they just did".
--
-- [`0043_the_emails_a_poll_sends.sql`](0043_the_emails_a_poll_sends.sql) wrote
-- that rule down and then applied it to one person: the creator. An
-- invitation is not news to whoever set the poll up, the Open poll button is
-- not news to whoever pressed it, and neither is the Close button -- so
-- `poll_email_audience` takes a flag saying whether the creator already
-- knows, and the two callers that open a poll and the one that finishes it
-- supply it.
--
-- The rule is not about the creator. It is about whoever acted, and a poll
-- has two transitions nobody presses a button for:
--
--   * it **opens itself** when the last invitee confirms they are done adding
--     options, and
--   * it **finishes by itself** when the last invitee votes.
--
-- Both of those were sent to everybody in the poll, the person whose own
-- confirmation or own ballot had just caused them included. Somebody clicks
-- Submit, watches the page turn into the results, and is then written to
-- about it. That is the same email the creator is spared, addressed to
-- somebody with exactly as little to learn from it.
--
-- So the audience gains the address behind the transition and drops it,
-- wherever it appears -- as an invitee, as the creator, or as a creator who
-- invited themselves. It is read from the token the way every other caller
-- reads it: these functions run inside the confirmation or the ballot that
-- caused the transition, so the person who caused it is simply whoever is
-- signed in. Where nobody is -- an open poll's anonymous voter, and the
-- nightly purge -- it is null and the audience is what it always was.
--
-- **The flag stays.** It is now redundant in both places that pass it -- the
-- creator's own button and the creator's own Close are the creator acting, so
-- the address would drop them anyway -- but it says something the token
-- cannot: that this transition was somebody's deliberate act rather than a
-- threshold being crossed. A deadline that closed a poll from a cron job with
-- no session behind it would want the creator told, and would get that right
-- by passing the flag it already passes.
--
-- **The audience is a decision, so it is a parameter, not a lookup.** Reading
-- `auth.jwt()` inside `poll_email_audience` would have been one line shorter
-- and would have made the one function this rule lives in answer differently
-- depending on who happened to be asking -- including in the tests, which ask
-- it directly. The two callers know who acted, the same way they know whether
-- the creator did; they say so.
--
-- What this changes on the way past: taking somebody off the invite list is
-- the other way a poll can run out of people to wait for, and it can open a
-- poll (nobody left to confirm) or finish one (nobody left to vote). Both run
-- inside the creator's own removal, so the creator now hears nothing about
-- either. That is the rule, read the same way it is read everywhere else:
-- they did it.


-- ---------------------------------------------------------------------------
-- Who hears about a transition
-- ---------------------------------------------------------------------------

-- Both audiences gain a parameter, which cannot be done in place -- a
-- `create or replace` with a longer argument list is a second function, and
-- the old one would go on answering the old calls. So they are dropped and
-- rebuilt, and every caller is replaced below, in this file, exactly as
-- [`0044_one_button.sql`](0044_one_button.sql) did when both senders lost one.
drop function if exists public.poll_results_audience(public.polls);
drop function if exists public.poll_email_audience(public.polls, boolean);


-- Everybody in the poll, minus the two people it would be telling something
-- they already know: the creator, where the transition was their own doing,
-- and the person whose own act caused it, whoever they turn out to be.
--
-- Deduplicated and lowercased, and every invitee whether or not they have
-- voted: a poll that moved on without them still moved on around them.
--
-- Both exclusions are of the address rather than of a place in the list. A
-- creator who invited themselves is one person with one inbox, and the reason
-- they need no email does not stop applying because they ticked a box on the
-- create form; the same is true of the invitee whose ballot ended the poll,
-- who is on that list for the ordinary reason and is not owed a letter about
-- what they just did.
create or replace function public.poll_email_audience(
  p_poll public.polls,
  p_include_creator boolean,
  p_actor text
)
returns setof text
language sql stable security definer set search_path to 'public'
as $$
  with told as (
    select lower(p_poll.created_by_email) as email
    where p_poll.created_by_email is not null
    union
    select lower(iv.email)
    from invited_voters iv
    where iv.poll_id = p_poll.id
  )
  select email
  from told
  where (p_include_creator
          or email is distinct from lower(p_poll.created_by_email))
    -- Null is nobody, and nobody is dropped: an open poll's voter signs
    -- nothing and the purge runs as no one.
    and email is distinct from lower(p_actor);
$$;

alter function public.poll_email_audience(public.polls, boolean, text) owner to postgres;
revoke all on function public.poll_email_audience(public.polls, boolean, text) from public;

comment on function public.poll_email_audience(public.polls, boolean, text) is
  'Every address to tell about something that happened to this poll: every invitee, minus the creator where the thing was their own doing, and minus the address whose own act caused it. Internal.';


-- The results audience, saying the same sentence about its own transition:
-- closed_at set means somebody closed the poll by hand, and only the creator
-- can, so the creator already knows -- and whoever cast the ballot that ended
-- it knows too.
create or replace function public.poll_results_audience(p_poll public.polls, p_actor text)
returns setof text
language sql stable security definer set search_path to 'public'
as $$
  select * from poll_email_audience(p_poll, p_poll.closed_at is null, p_actor);
$$;

alter function public.poll_results_audience(public.polls, text) owner to postgres;
revoke all on function public.poll_results_audience(public.polls, text) from public;

comment on function public.poll_results_audience(public.polls, text) is
  'Every address to tell that this poll has finished: every invitee, minus the creator where the poll was closed by hand rather than running out on its own, and minus whoever''s own vote or removal ended it. Internal.';


-- ---------------------------------------------------------------------------
-- The two callers, saying who acted
-- ---------------------------------------------------------------------------

-- Told once per poll rather than once per question, pointing at question 1 --
-- the group opens in one act, and it is the row every other email about this
-- poll names.
--
-- p_by_itself and the signed-in address are the whole of who hears it: the
-- creator's own Open poll button is not news to the creator, and the poll
-- opening because the last invitee confirmed is not news to that invitee.
-- There is no notice row behind this one, unlike the results: opening happens
-- exactly once in a poll's life -- nothing puts options_finalized_at back to
-- null, reset included -- so the two callers of this are the two openings
-- there are.
create or replace function public.notify_poll_opened(p_poll_id uuid, p_by_itself boolean)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
  v_first polls;
  v_email text;
  -- Read here rather than passed in, because it is the same fact at both call
  -- sites and neither has to know it: this runs inside the confirmation, the
  -- removal or the button press that opened the poll, so whoever is signed in
  -- is whoever did it.
  v_actor text := lower(auth.jwt() ->> 'email');
begin
  select * into v_poll from polls where id = p_poll_id;

  if not found then
    return;
  end if;

  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  -- One request per address rather than one request with every address in
  -- it: Resend would show every invitee every other invitee's address, which
  -- is what a poll with its respondents hidden promises not to do.
  for v_email in select * from poll_email_audience(v_first, p_by_itself, v_actor) loop
    perform send_poll_opened_email(v_first, v_email);
  end loop;
end;
$$;

alter function public.notify_poll_opened(uuid, boolean) owner to postgres;
revoke all on function public.notify_poll_opened(uuid, boolean) from public;

comment on function public.notify_poll_opened(uuid, boolean) is
  'Tells a poll''s voters that it has stopped collecting options and started taking votes, once for the group, leaving out whoever opened it. Internal: called by the two things that open a poll, which say between them whether the creator is hearing news.';


-- The results announcement, unchanged except in who it leaves out. Everything
-- about *when* it is made -- the notice row that makes it happen once, and
-- the deletion that lets a poll which finishes twice be announced twice --
-- was already right and is copied through untouched.
create or replace function public.notify_results_ready(p_poll_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
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
  -- see the note at the top of this file.
  for v_email in select * from poll_results_audience(v_first, v_actor) loop
    perform send_results_ready_email(v_first, v_email);
  end loop;
end;
$$;

alter function public.notify_results_ready(uuid) owner to postgres;
revoke all on function public.notify_results_ready(uuid) from public;

comment on function public.notify_results_ready(uuid) is
  'Reconciles a poll''s results-ready announcement with whether it actually has a result: sends once when it crosses the line, to everybody but whoever crossed it, and forgets when a reset takes it back. Internal: called from the triggers on ballots, invited_voters and polls, never by a client.';

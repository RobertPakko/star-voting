-- A poll that is deleted leaves the lists it was on.
--
-- An invite arrives on somebody's homepage without them reloading it: the
-- invite is a row in `invited_voters`, the trigger on that table announces
-- the poll, and every list the poll is now on re-reads itself. Deleting the
-- poll said nothing at all, so the same homepage went on showing a card that
-- opens onto "Poll not found" until its reader thought to refresh. Arrivals
-- were live and departures were not, which is the failure that "deletes are
-- announced as loudly as inserts" already names one table down.
--
-- The silence was two things, one of them deliberate. `polls` had no delete
-- trigger of its own, so nothing ever spoke for the poll itself; and
-- `broadcast_poll_change` returns early when the poll is already gone, which
-- is what stops a cascade delete from broadcasting once per option, invitee
-- and ballot of a poll nobody can read any more. That second half is worth
-- keeping exactly as it is: the rows really do have nothing to say. What was
-- missing is the one announcement the poll itself owes, before it goes.
--
-- **Before, not after, because the audience cascades out with the poll.**
-- Who to tell is the creator and everyone on `invited_voters`, and those rows
-- are deleted by the same statement -- an AFTER trigger would find the list of
-- people to tell already gone. A BEFORE DELETE row trigger runs while the
-- poll is still whole.
--
-- **The lists, and not the poll's own topic.** A page watching a poll answers
-- a signal by re-reading it, and a re-read of a deleted poll fails; that
-- counts as a read that did not work, so `useLiveStream` would retry it five
-- times and then tell the reader they are offline, which is both untrue and
-- no help. The page this is about is the list, and its re-read comes back one
-- poll shorter, which is exactly right.
--
-- **One message per poll**, which is the granularity every other broadcast
-- here already uses: `broadcast_polls_emptied` sends one per distinct poll a
-- statement touched rather than one per row. Deleting a poll of five
-- questions is deleting five polls -- the Delete button acts on the group --
-- so it is five, exactly as clearing that poll's votes is.


create or replace function public.broadcast_poll_gone()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
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

  -- The audience broadcast_poll_change() reaches, minus the poll's own topic
  -- and read while it can still be read. `union` rather than `union all`: a
  -- creator who invited themselves is one reader with one list.
  for v_user in
    select u.id from auth.users u where u.id = old.created_by
    union
    select u.id
    from invited_voters iv
    join auth.users u on lower(u.email) = lower(iv.email)
    where iv.poll_id = old.id
  loop
    perform realtime.send('{}'::jsonb, 'polls_changed', 'user:' || v_user::text, false);
  end loop;

  return old;
end;
$$;

alter function public.broadcast_poll_gone() owner to postgres;
revoke all on function public.broadcast_poll_gone() from public;

comment on function public.broadcast_poll_gone() is
  'Tells the list of everyone who can see this poll that it is going, while its invitee list still exists to be read. Internal: the BEFORE DELETE trigger on polls, never called by a client.';


create or replace trigger polls_broadcast_delete
  before delete on public.polls
  for each row execute function public.broadcast_poll_gone();


-- The purge, unchanged but for the flag it now raises over itself.
create or replace function public.purge_old_polls()
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_deleted int;
begin
  -- Transaction-local, so it covers the delete below and is gone with the
  -- transaction rather than left on a pooled connection for whatever runs
  -- next. See broadcast_poll_gone() for what reads it.
  perform set_config('app.purging_polls', 'on', true);

  with expired as (
    delete from polls p
    -- The same test poll_expires_at() states, rearranged onto the bare
    -- column so the index on created_at can answer it. The second half is
    -- that function itself, kept as the authority: whatever date the poll page
    -- showed a reader is the date this acts on, and a rewrite of one that
    -- drifted from the other would delete a poll the app promised was safe.
    where p.created_at <= now() - poll_retention_window()
      and poll_expires_at(p) <= now()
    returning 1
  )
  select count(*)::int into v_deleted from expired;

  return v_deleted;
end;
$$;

alter function public.purge_old_polls() owner to postgres;
revoke all on function public.purge_old_polls() from public;

comment on function public.purge_old_polls() is
  'Deletes every poll past its retention window, cascading to its options, invitees and ballots. Returns how many polls went. Scheduled nightly by pg_cron, and silent: it raises app.purging_polls over itself so the delete trigger says nothing.';

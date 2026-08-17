-- reset_poll: throw away every vote and put the poll back to how it
-- started, keeping its id, its options, its invitee list and -- for open
-- polls -- its share link.
--
-- Resetting reopens a closed poll. That looks like it contradicts 0008,
-- which made closing one-way so a creator couldn't close to peek at
-- partial results, reopen, and keep collecting votes from people who don't
-- know the running tally is already known.
--
-- It doesn't, because the thing 0008 protects is the *ballots*: the peek
-- attack works precisely because the votes already cast survive the
-- reopen and get counted alongside the new ones. A reset deletes them.
-- Whatever the creator learned describes a tally that no longer exists.
--
-- The honest framing is that this is a shortcut for something the creator
-- can already do: delete the poll and create an identical one. It is not
-- new power. What it does change is the seams -- delete-and-recreate mints
-- a new id and a new share token, so old links break and participants
-- notice something happened, whereas a reset is invisible to anyone
-- holding the link. So the creator is told plainly, in the confirmation
-- modal, that everyone who already voted can now vote again.
--
-- Deliberately creator-only, and deliberately not exposed for a poll
-- somebody else created.

create or replace function reset_poll(p_poll_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from polls where id = p_poll_id and created_by = auth.uid()) then
    raise exception 'Only the poll creator can reset this poll';
  end if;

  -- scores cascade from ballots (0001), so this clears the whole tally.
  -- It also frees the per-poll unique names and voter keys that open-poll
  -- ballots hold, so the same people can vote again under the same names.
  delete from ballots where poll_id = p_poll_id;

  update polls set closed_at = null where id = p_poll_id;
end;
$$;

revoke execute on function reset_poll(uuid) from public, anon;
grant execute on function reset_poll(uuid) to authenticated;

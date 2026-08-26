-- A poll's ballots are read on the poll's terms, not on the reader's route.
--
-- `poll_ballots` refused an open poll outright -- *This poll is open to
-- anyone with the link, so its ballots are read through that link* -- and the
-- creator's own poll page asked it anyway, on every open poll whose results
-- were out and whose ballots were published. So the one screen that shows an
-- open poll's ballots showed them twice: once as the grid, drawn by the panel
-- that is the whole of an open poll's voting experience, and once as that
-- sentence in red underneath it. The page stops asking (see `PollDetail`),
-- which is what takes the sentence off the screen. This is the other half:
-- the rule it came from was never doing any work.
--
-- Every question that refusal looks like it is answering is answered above
-- and below it, by rules that are about *who may read a ballot* rather than
-- about which door they came in by:
--
--  - **Who is asking.** The caller is the poll's creator or somebody on its
--    invite list, or the function has already raised. An open poll has no
--    invite list, so on one of those it is the creator alone -- and the
--    creator reading their own poll is not a question this app has ever had
--    to think twice about.
--  - **Whether the poll publishes ballots at all.** `show_ballots` still
--    gates, still with no exception for the creator, exactly as it did.
--  - **Whether they are unlocked yet.** The gate below is `closed_at` for a
--    poll with nobody on its invite list, which is precisely the gate
--    `open_poll_ballots` applies to the same poll read through the link.
--
-- So the two functions answer the creator of an open poll the same sheet on
-- the same terms, and always would have. What the refusal added was the
-- database restating a poll's terms -- which the badges over every screen
-- that carries the poll have already stated, in the one place this app keeps
-- that wording.
--
-- The one thing that has to change with it is the sentence for a poll that is
-- not unlocked yet. *Ballots are not available until everyone has voted* is
-- about an invite list, and an open poll has none; it closes by hand instead.
-- Both wordings already exist -- the second is `open_poll_ballots`' own -- so
-- this picks between them rather than inventing a third.
--
-- The sibling refusals in `revise_ballot`, `suggest_option`,
-- `confirming_invitee`, `poll_invitees` and `guard_invitee_changes` are left
-- alone, and are not the same thing: each of those guards a write through the
-- wrong door, or a list an open poll genuinely does not have. This one
-- guarded a read that every other rule in the function had already allowed.


create or replace function public.poll_ballots(p_poll_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
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

  -- Deliberately before the creator has been given any special treatment,
  -- because they get none: hiding ballots is a promise made to the people who
  -- voted, not an access level.
  if not v_poll.show_ballots then
    raise exception 'This poll does not publish individual ballots';
  end if;

  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if v_poll.closed_at is null and (v_invited = 0 or v_voted < v_invited) then
    -- Which is the same condition twice over, said the way the poll in hand
    -- actually works. A poll with an invite list unlocks itself when the last
    -- person on it votes; one without -- an open poll, always -- has nothing
    -- to count towards and is closed by its creator instead.
    if v_invited = 0 then
      raise exception 'Ballots are not available until the poll is closed';
    end if;
    raise exception 'Ballots are not available until everyone has voted';
  end if;

  return ballot_sheet(p_poll_id, v_poll.show_voters);
end;
$$;

alter function public.poll_ballots(uuid) owner to postgres;
revoke all on function public.poll_ballots(uuid) from public;
grant all on function public.poll_ballots(uuid) to authenticated;

comment on function public.poll_ballots(uuid) is
  'Every ballot in a poll, to somebody in that poll, once the poll publishes them and the results are out. Says nothing about how the reader reached the poll: an open poll''s creator gets the sheet open_poll_ballots would hand the same poll''s link, on the same terms.';

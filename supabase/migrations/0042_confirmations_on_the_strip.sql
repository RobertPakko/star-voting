-- The question strip's mark, one stage earlier.
--
-- A poll of several questions collects its options question by question --
-- each one is a poll here and carries its own list -- and 0041 made a
-- confirmation per question to match. What it did not do is say so on the
-- strip: poll_group returns a `voted` flag per question, which is the mark the
-- strip draws, and while the poll is still collecting nobody has voted, so
-- every question sat unmarked whatever its reader had already finished with.
-- On a poll of five questions that is a reader with no way to tell which two
-- they have had their say on except by walking back through them.
--
-- So the same flag, for the stage before the ballot: whether this reader has
-- confirmed this question's list. The strip draws whichever of the two the
-- poll's stage makes true, and the page picks -- see src/pages/PollDetail.tsx.
--
-- **Only the invite side gets one, and that is not an omission.** An open
-- poll's confirmations are identified by a voter_key minted per question,
-- precisely so one browser's marks cannot be joined to each other, and
-- open_poll_group will not undo that to colour a badge any more than it will
-- for `voted`; the browser already knows and is the one place entitled to.
-- See src/lib/questionMarks.ts, which is that place for both marks.
create or replace function public.poll_group(p_poll_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
begin
  -- The same visibility test the rest of the invite side applies: the poll
  -- is yours, or you were invited to it. Every question in a group carries
  -- the same invite list, so seeing one is seeing all of them.
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

  if v_poll.group_id is null then
    return '[]'::jsonb;
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', q.id,
      'question_position', q.question_position,
      'question_title', q.question_title,
      -- What the creator's "Open poll" button needs to apply the floor
      -- finalize_options applies, rather than offering a button that is
      -- refused: opening is one act over every question, so the button has
      -- to know about every question's list and not just this one's.
      'option_count', (select count(*)::int from candidates c where c.poll_id = q.id),
      -- Which questions this reader has already answered. Free on this side:
      -- an invite ballot carries the voter's account, so nothing has to be
      -- linked to find them. The share-link side deliberately cannot ask
      -- this; see open_poll_group.
      'voted', exists (select 1 from ballots b where b.poll_id = q.id and b.voter_id = auth.uid()),
      -- And which they have finished adding to, which is the same mark for
      -- the stage before the ballot. Free for the same reason and withheld on
      -- the share-link side for the same reason. False rather than null for a
      -- creator who is not on the invite list: they have no confirmation to
      -- give, and the strip draws no mark for one they could not have made.
      'confirmed', exists (
        select 1 from option_confirmations oc
        where oc.poll_id = q.id and oc.voter_id = auth.uid()
      )
    ) order by q.question_position), '[]'::jsonb)
    from poll_group_members(v_poll) q
  );
end;
$$;

alter function public.poll_group(uuid) owner to postgres;

comment on function public.poll_group(uuid) is
  'The questions of the poll this one belongs to, in order, with whether the reader has answered each and whether they have finished adding options to each; empty for a poll that asks one question.';

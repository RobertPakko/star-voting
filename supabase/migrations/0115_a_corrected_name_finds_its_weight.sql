-- On a sequential open poll, correcting the name on a ballot claims the
-- earlier voter it now names.
--
-- A ballot takes its N (the stars its voter gave earlier winners) from the
-- carried row its name matches, when it is cast. A voter who typed "Jon"
-- where the creator carried "John", or a nickname, was a newcomer at the
-- average weight for good, and the roster showed John still to vote with no
-- way to put it right. Now a revision that changes the name lets go of the
-- row the old name claimed and claims the one the new name matches, or makes
-- the ballot a newcomer if it matches none: a ballot's N follows its name.
--
-- This gives a voter nothing they lacked: any unclaimed name could already be
-- typed when casting, and the names still to vote are already listed to
-- anyone holding the link (open_poll_view's carried_names). A poll that hides
-- its voters keeps no name and takes none on a revision, so nothing changes
-- there. Ballot names are unique within a poll, ignoring case, so the row a
-- ballot's name claimed is the row that name matches.


CREATE OR REPLACE FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_ballot_id uuid;
  v_name text;
  v_old_name text;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  -- An open poll reveals on close and only on close, so the line above has
  -- already caught every poll this could catch. It is here because the rule
  -- being kept is "not while the results are out", and a rule worth stating
  -- is worth stating on both paths rather than left implied by another one.
  if poll_results_revealed(v_poll) then
    raise exception 'The results are out, so votes can no longer be changed';
  end if;

  -- Found the way the view found it, so the ballot a reader was handed back
  -- is the ballot their change lands on -- on whichever device they cast it.
  v_ballot_id := open_ballot_of(v_poll.id, p_voter_key);

  if v_ballot_id is null then
    raise exception 'You have not voted in this poll yet';
  end if;

  select voter_name into v_old_name from ballots where id = v_ballot_id;

  -- Null keeps the name; a poll that hides respondents never takes one.
  if v_poll.show_voters and p_voter_name is not null then
    v_name := nullif(trim(p_voter_name), '');
    if v_name is null then
      raise exception 'Enter your name so the group can see who has voted';
    end if;
    if length(v_name) > 60 then
      raise exception 'That name is too long';
    end if;
  else
    v_name := v_old_name;
  end if;

  perform replace_scores(v_ballot_id, v_poll.id, p_scores);

  begin
    update ballots set revised_at = now(), voter_name = v_name where id = v_ballot_id;
  exception when unique_violation then
    raise exception '"%" has already voted in this poll. Add a last initial if that is not you.', v_name;
  end;

  -- On a sequential question the ballot's N follows its name: the row the old
  -- name claimed goes back to the list, and the new name claims its own or
  -- makes the ballot a newcomer. After the update above, so a name another
  -- ballot holds has been refused before any row moves. A change of case
  -- alone names the same row and moves nothing.
  if lower(v_name) is distinct from lower(v_old_name)
     and exists (select 1 from carried_weights where poll_id = v_poll.id) then
    update carried_weights set claimed = false
    where poll_id = v_poll.id and lower(voter) = lower(v_old_name) and claimed;

    update ballots set given = claim_carried_weight(v_poll.id, v_name)
    where id = v_ballot_id;
  end if;

  -- There is no trigger on an UPDATE of ballots (a changed vote says nothing;
  -- see AGENTS.md), so a roster that moved is announced here.
  if v_name is distinct from v_old_name then
    perform broadcast_poll_change(v_poll.id);
  end if;
end;
$$;


COMMENT ON FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") IS 'Replaces the scores on this reader''s ballot -- the one their account cast, on any device, or the one this voter_key cast -- until the poll closes. A name, where the poll shows respondents, replaces the one on the ballot and announces the poll; null keeps it. On a sequential question a changed name moves the ballot''s N to the earlier voter it now names, or to a newcomer''s.';

COMMENT ON COLUMN "public"."ballots"."given" IS 'On a sequential question, the stars this ballot''s voter had given earlier winners: the carried row its name claimed, or the newcomer''s share (newcomer_given). Its weight is 5 / (5 + given). Null on every ballot of a question that is not sequential. Set when cast; a revision moves it only by changing the name on an open poll''s ballot.';

COMMENT ON TABLE "public"."carried_weights" IS 'The voters a sequential question remembers from earlier polls, each with the stars it gave their winners (given). A name on an open poll, a lowercased address on an invite poll. Written only by create_poll and create_poll_group; claimed by the first ballot that matches it, and let go again when an open ballot''s name is changed away from it. RLS on, no policies, no grants: which rows are claimed would be a list of who has voted.';

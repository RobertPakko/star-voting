-- A share-link ballot's name can be corrected when the vote is changed.
--
-- The name box now stays on the ballot card through every stage -- disabled
-- once the vote is in, enabled again by Edit vote -- so a voter who misspelt
-- their name has somewhere to fix it. open_poll_revise refused to take one, on
-- the grounds that the name is on a roster other people are reading; that is
-- true and is the reason a change is announced, not a reason to keep a typo
-- on it for good.
--
-- A different argument list is a different function, so the old one is
-- dropped and the new one created with its grants restated (a new function is
-- executable by PUBLIC until revoked). p_voter_name defaults to null, which
-- keeps the name as it is, so a browser still on the previous build calls it
-- exactly as before.
--
-- The rules are open_poll_submit's: a poll that hides respondents stores no
-- name whatever is sent, a poll that shows them refuses a blank one, and a
-- name another ballot holds is refused in the same words. A ballot whose name
-- moved announces the poll, since the roster is the one thing a revision can
-- change that somebody else can see; a revision that only moves scores stays
-- as silent as it always was.

DROP FUNCTION IF EXISTS "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text");

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

  -- There is no trigger on an UPDATE of ballots (a changed vote says nothing;
  -- see AGENTS.md), so a roster that moved is announced here.
  if v_name is distinct from v_old_name then
    perform broadcast_poll_change(v_poll.id);
  end if;
end;
$$;


ALTER FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") IS 'Replaces the scores on this reader''s ballot -- the one their account cast, on any device, or the one this voter_key cast -- until the poll closes. A name, where the poll shows respondents, replaces the one on the ballot and announces the poll; null keeps it.';


REVOKE ALL ON FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") TO "authenticated";

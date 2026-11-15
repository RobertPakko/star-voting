-- A poll of several questions finishes on whichever question takes the last
-- vote, and every other question learns of it from settle_winner writing its
-- row: the update is what broadcasts on that question's topic. But a question
-- whose kind answers with several options (multiple or proportional winners,
-- a split, a budget, consensus winners, an assignment) is never settled with
-- one name, so its row was not written and its topic heard nothing. A reader
-- on such a question, or holding a read of it from before, went on seeing
-- "your vote is in" over a poll whose results were out, until they reloaded.
--
-- settle_winner now announces such a question itself. announce() drops a
-- repeat within the transaction, so a close (which writes every row anyway)
-- still sends one message a topic.

CREATE OR REPLACE FUNCTION "public"."settle_winner"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_question polls;
begin
  perform lock_poll(p_poll_id);

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
  -- answers as well.
  for v_question in select q.* from poll_group_members(v_poll) q loop
    -- The same predicate the three reads report as `results_available`.
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
    continue when v_question.winner_settled_at is not null;

    -- A question whose answer is several options is never settled with one:
    -- left unsettled, every screen says *Results ready*. Settled with a null
    -- name would read as a tie. Nothing is written, so nothing announces it
    -- but this: its readers are owed the news that the results are out.
    if not poll_names_one_winner(v_question.id) then
      perform broadcast_poll_change(v_question.id);
      continue;
    end if;

    update polls
    set winner_name = poll_winner_name(v_question.id),
        winner_settled_at = now()
    where id = v_question.id;
  end loop;
end;
$$;

ALTER FUNCTION "public"."settle_winner"("p_poll_id" "uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."settle_winner"("p_poll_id" "uuid") FROM PUBLIC;

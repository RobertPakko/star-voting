-- The winner kept with a question is the one its own kind elects, not STAR's.
--
-- A consensus question names the consensus option; a question that asks for
-- several answers at once (the option ranking, multiple winners, fractional
-- winners) has no one winner, so it is never settled with a name and every
-- screen reads *Results ready*, as for a poll of several questions. Where the
-- poll is too small for its kind, `poll_tally` carries no kind result and the
-- page shows STAR's winner, so that is the winner kept here too.


-- Whether a question's result is a single option: the best option or time,
-- the consensus option or time, and any kind too small to be anything else.
-- The floors are `poll_tally`'s (and `offers` in lib/choices.ts).
CREATE OR REPLACE FUNCTION "public"."poll_names_one_winner"("p_poll_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_kind text;
  v_options int;
begin
  select kind into v_kind from polls where id = p_poll_id;
  select count(*)::int into v_options from candidates where poll_id = p_poll_id;

  return case
    when v_kind in ('ranking', 'multiple') then v_options < 3
    when v_kind = 'fractional' then v_options < 2
    else true
  end;
end;
$$;

ALTER FUNCTION "public"."poll_names_one_winner"("uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_names_one_winner"("uuid") FROM PUBLIC;


CREATE OR REPLACE FUNCTION "public"."poll_winner_name"("p_poll_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_pool uuid[];
  v_winner uuid;
  v_kind text;
begin
  -- No ballots, no election. The caller checks this first anyway; the point
  -- of repeating it is that star_round() would otherwise elect the
  -- highest-scoring option of an empty tally.
  if not exists (select 1 from ballots where poll_id = p_poll_id) then
    return null;
  end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into v_pool
  from candidates where poll_id = p_poll_id;

  if coalesce(array_length(v_pool, 1), 0) = 0 then
    return null;
  end if;

  select kind into v_kind from polls where id = p_poll_id;

  if v_kind in ('consensus', 'consensus_time') and array_length(v_pool, 1) >= 2 then
    -- The same answer the tally carries as `kind_result`, so the badge and
    -- the green bar never disagree.
    v_winner := (poll_consensus(p_poll_id, '{}') ->> 'winner_id')::uuid;
  else
    -- The head round is the whole of STAR: the score round, its tie-breaks
    -- and the runoff.
    v_winner := (star_round(p_poll_id, v_pool) ->> 'winner_id')::uuid;
  end if;

  if v_winner is null then
    -- A runoff level on preference, on points and on five-star votes alike.
    -- The app reports the tie rather than inventing a winner.
    return null;
  end if;

  return (select name from candidates where id = v_winner);
end;
$$;


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
    -- name would read as a tie.
    continue when not poll_names_one_winner(v_question.id);

    update polls
    set winner_name = poll_winner_name(v_question.id),
        winner_settled_at = now()
    where id = v_question.id;
  end loop;
end;
$$;


COMMENT ON COLUMN "public"."polls"."winner_name" IS 'The option this question elected by its own kind (STAR''s winner, or the consensus), null for a question that elected nobody. Meaningful only where winner_settled_at is set. Maintained by settle_winner(); never written by a client.';

COMMENT ON COLUMN "public"."polls"."winner_settled_at" IS 'When this question''s winner was worked out. Null means it has none: it is still taking votes, a reset took its result away, or its kind answers with several options (poll_names_one_winner).';

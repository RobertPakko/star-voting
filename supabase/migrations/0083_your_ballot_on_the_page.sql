-- The two things a poll page still asked for after `poll_page` had answered.
--
-- `poll_page` exists so that a poll opens in one round trip, and it carries the
-- tally, the published sheet and the roster on exactly the pages that draw
-- them. Two cards were left asking for themselves:
--
--  * **Your own ballot**, on a finished invite poll that does not publish its
--    ballots. `YourBallot` read it through `poll_ballot_scores` the moment it
--    mounted, which could not happen until `poll_page` had come back -- so
--    every such page cost a second round trip for something the first could
--    have brought. An open poll never paid it: `open_poll_view` has always
--    carried `your_scores`.
--  * **Whether you have removed the poll from your list**, which the card
--    after voting or confirming asks through `poll_is_removed` so it can say
--    the poll will not notify you.
--
-- Both now ride on `poll_page` as `your_scores` and `removed`, by calling those
-- same two functions rather than restating them, so there is still one copy of
-- each rule. Neither is a new privilege: `poll_ballot_scores` hands the caller
-- their own ballot at any stage of any poll, and `poll_is_removed` answers
-- about the caller's own row and nobody else's.
--
-- `your_scores` is gated on exactly the condition the card is drawn behind --
-- an invite poll, results out, ballots private, and a ballot of the caller's
-- own -- and is null everywhere else, which means "not carried, ask for
-- yourself" as `results` and `ballots` do. Where ballots are published the
-- reader's row is already on the sheet; where the results are still sealed
-- the only thing that reads it is *Edit vote*, which reads it fresh on the
-- press on purpose. `poll_ballot_scores` raises for a caller with no ballot,
-- which is why the gate asks first.
--
-- `removed` is on both readings, because the card that asks is on both: an
-- account that answered an open poll through its link can have removed it
-- too. False for a reader who is not signed in, as `poll_is_removed` says.
--
-- Same arguments and same return type, so this is a CREATE OR REPLACE and the
-- grants `poll_page` already has are kept.

CREATE OR REPLACE FUNCTION "public"."poll_page"("p_poll_id" "uuid", "p_voter_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_creator boolean;
  v_revealed boolean;
begin
  select p.* into v_poll from polls p where p.id = p_poll_id;

  if not found then
    return jsonb_build_object('kind', 'unreadable');
  end if;

  v_creator := is_poll_creator(v_poll.id);
  v_revealed := poll_results_revealed(v_poll);

  if v_creator or is_invited_to_poll(v_poll.id) then
    return jsonb_build_object(
      'kind', 'account',
      'poll', to_jsonb(v_poll),
      'options', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id,
          'poll_id', c.poll_id,
          'name', c.name,
          'description', c.description,
          'sort_order', c.sort_order
        ) order by c.sort_order, c.name), '[]'::jsonb)
        from candidates c where c.poll_id = v_poll.id
      ),
      'status', (select to_jsonb(s) from poll_status(v_poll.id) s),
      'questions', poll_group(v_poll.id),
      'view', case
        when v_poll.mode = 'open' then open_poll_view(v_poll.id, p_voter_key)
        else null
      end,
      'results', case when v_revealed then get_poll_results(v_poll.id) else null end,
      'ballots', case
        when v_revealed and v_poll.show_ballots then poll_ballots(v_poll.id)
        else null
      end,
      'invitees', case
        when v_poll.mode = 'invite' and (v_creator or v_poll.show_voters) then (
          select coalesce(jsonb_agg(to_jsonb(i) order by i.email), '[]'::jsonb)
          from poll_invitees(v_poll.id) i
        )
        else null
      end,
      'your_scores', case
        when v_revealed
          and v_poll.mode = 'invite'
          and not v_poll.show_ballots
          and exists (
            select 1 from ballots b
            where b.poll_id = v_poll.id and b.voter_id = auth.uid()
          )
        then poll_ballot_scores(v_poll.id)
        else null
      end,
      'removed', poll_is_removed(v_poll.id)
    );
  end if;

  if v_poll.mode = 'open' then
    return jsonb_build_object(
      'kind', 'open',
      'view', open_poll_view(v_poll.id, p_voter_key),
      'questions', open_poll_group(v_poll.id),
      'results', case when v_revealed then open_poll_results(v_poll.id) else null end,
      'ballots', case
        when v_revealed and v_poll.show_ballots then open_poll_ballots(v_poll.id)
        else null
      end,
      'removed', poll_is_removed(v_poll.id)
    );
  end if;

  return jsonb_build_object('kind', 'unreadable');
end;
$$;

COMMENT ON FUNCTION "public"."poll_page"("p_poll_id" "uuid", "p_voter_key" "text") IS 'The one read that opens a poll page: what this reader may see at this address, and the whole of it. Tagged account / open / unreadable. Carries the tally, the published ballot sheet, the invitee roster and the reader''s own private ballot where the page it describes will draw them, so a finished poll opens in one round trip; null on any of them means "not here, ask for yourself" rather than "there is none". Also says whether the reader has removed the poll from their list.';

-- Name the winning option in the view an open poll's share link is drawn from.
--
-- The winner was never withheld from that page: the tally under the heading
-- has always named it in full. What the page could not do was put the name in
-- the state badge beside the title, the way a signed-in reader gets it,
-- because that name comes from `poll_winners()` and that function answers
-- only to an account. So the badge read "Results ready" next to a result
-- sitting right underneath it. `poll_winner_name()` is what `poll_winners()`
-- calls, it needs no account, and `open_poll_view()` is already the one thing
-- that page can ask -- so the gap closes here, from the same election a
-- signed-in reader's badge is drawn from.
--
-- The election is run only once the results are out, which is the one thing
-- that keeps this cheap. Both pages that call `open_poll_view()` re-read it
-- every few seconds while the poll is live and **stop the moment the results
-- unlock**, so `poll_winner_name()` is reached on the tick that discovers the
-- poll has finished and on later page loads, never on a repeating timer. A
-- winner computed unconditionally would have re-run the whole of STAR on
-- every tick of every open poll in the app.
--
-- **Who created the poll is deliberately not here.** It is on the poll list
-- and on the poll's own page, and leaving it off this third screen is the one
-- place the shared heading is knowingly incomplete. Every email address the
-- app displays anywhere is shown to someone who is already in the poll it
-- belongs to -- an invite poll's roster is read by its invitees. A share link
-- has no such boundary: it goes wherever it is forwarded, to people who never
-- signed in and never will. Publishing the creator's address to all of them
-- would be the first time the app told an address to somebody who is not in
-- the poll, and consistency of layout is not worth being the exception.
CREATE OR REPLACE FUNCTION "public"."open_poll_view"("p_token" "text", "p_voter_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted int;
  v_options jsonb;
  v_voters jsonb;
  v_your_name text;
  v_voted_already boolean;
  v_results_available boolean;
  v_winner_name text;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  select count(*)::int into v_voted from ballots where poll_id = v_poll.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'poll_id', c.poll_id,
    'name', c.name,
    'description', c.description,
    'sort_order', c.sort_order
  ) order by c.sort_order, c.name), '[]'::jsonb)
  into v_options
  from candidates c where c.poll_id = v_poll.id;

  -- Names are visible while voting is still open on purpose: knowing whose
  -- vote is outstanding is the point of a named poll. Ballots are not, in
  -- either setting -- those wait for the close, like the results.
  if v_poll.show_voters then
    select coalesce(jsonb_agg(b.voter_name order by lower(b.voter_name)), '[]'::jsonb)
    into v_voters
    from ballots b
    where b.poll_id = v_poll.id and b.voter_name is not null;
  else
    v_voters := null;
  end if;

  if p_voter_key is null or trim(p_voter_key) = '' then
    v_voted_already := false;
  else
    select true, b.voter_name into v_voted_already, v_your_name
    from ballots b
    where b.poll_id = v_poll.id and b.voter_key = p_voter_key;
    v_voted_already := coalesce(v_voted_already, false);
  end if;

  -- Open polls reveal only on close, so early votes can never steer late
  -- ones. This is the same promise the invite mode makes.
  v_results_available := v_voted > 0 and v_poll.closed_at is not null;

  -- The election, and only once there is one to report. See the note at the
  -- top of this file: this is the line that must never run on a poll that is
  -- still being refreshed on a timer. Null is a real answer here as well as a
  -- missing one -- a poll STAR could not settle elects nobody -- which is why
  -- the badge distinguishes "Tie" from "Results ready" on the app's side.
  if v_results_available then
    v_winner_name := poll_winner_name(v_poll.id);
  end if;

  return jsonb_build_object(
    'poll', jsonb_build_object(
      'id', v_poll.id,
      'title', v_poll.title,
      'description', v_poll.description,
      'mode', v_poll.mode,
      'show_voters', v_poll.show_voters,
      'show_ballots', v_poll.show_ballots,
      'solicit_options', v_poll.solicit_options,
      'closed_at', v_poll.closed_at
    ),
    'options', v_options,
    'voted_count', v_voted,
    'is_closed', v_poll.closed_at is not null,
    -- Still gathering options: no ballot yet, and nothing to reveal.
    'soliciting', v_poll.solicit_options
                  and v_poll.options_finalized_at is null
                  and v_poll.closed_at is null,
    'results_available', v_results_available,
    'winner_name', v_winner_name,
    'voted', v_voted_already,
    'your_name', v_your_name,
    'voters', v_voters
  );
end;
$$;

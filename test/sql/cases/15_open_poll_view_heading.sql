-- What an open poll's share link says about the poll itself.
--
-- The public voting page can ask open_poll_view() and nothing else, so the
-- heading it draws is whatever this function returns. Two of those parts are
-- the ones a signed-in reader gets from elsewhere: who created the poll, and
-- which option won. The winner is the one with a cost attached -- it runs the
-- election -- so the case it really has to make is that it is not computed
-- until there is a result to compute.

begin;

do $$
declare
  v_poll uuid;
  v_token text;
  v_scores jsonb;
  v_view jsonb;
begin
  perform tests.sign_in('creator@example.com');

  v_poll := create_poll('Movie night', 'Pick one', array['Dune', 'Arrival'],
                        array[]::text[], 'open', false, false);
  select public_token into v_token from polls where id = v_poll;

  v_view := open_poll_view(v_token);
  perform tests.assert_eq('the link names who made the poll',
    v_view -> 'poll' ->> 'created_by_email', 'creator@example.com');

  -- No result yet, and therefore no election run to find one. A null here is
  -- what keeps the live refresh cheap: both pages re-read this every few
  -- seconds until the results unlock.
  perform tests.assert_eq('nothing has been decided yet',
    (v_view ->> 'results_available')::boolean, false);
  perform tests.assert_null('so no winner is named',
    v_view ->> 'winner_name');

  select jsonb_agg(jsonb_build_object('candidate_id', id,
                                      'score', case when name = 'Dune' then 5 else 1 end))
  into v_scores from candidates where poll_id = v_poll;
  perform open_poll_submit(v_token, v_scores, 'voter-key-1');

  v_view := open_poll_view(v_token);
  perform tests.assert_eq('a vote does not unlock the results of an open poll',
    (v_view ->> 'results_available')::boolean, false);
  perform tests.assert_null('so it still names nobody',
    v_view ->> 'winner_name');

  perform close_poll(v_poll);

  v_view := open_poll_view(v_token);
  perform tests.assert_eq('closing it reveals the results',
    (v_view ->> 'results_available')::boolean, true);
  perform tests.assert_eq('and the link names what won',
    v_view ->> 'winner_name', 'Dune');
  perform tests.assert_eq('naming the creator all the while',
    v_view -> 'poll' ->> 'created_by_email', 'creator@example.com');

  -- The same name the signed-in badge gets, from the same election: two
  -- readers of one poll must never be told different things about it.
  perform tests.assert_eq('the same answer a signed-in reader is given',
    v_view ->> 'winner_name', poll_winner_name(v_poll));

  -- ------------------------------------------------------------------
  -- A poll closed with no votes in it has no result and no election.
  -- ------------------------------------------------------------------

  v_poll := create_poll('Empty', null, array['Apple', 'Banana'],
                        array[]::text[], 'open', false, false);
  select public_token into v_token from polls where id = v_poll;
  perform close_poll(v_poll);

  v_view := open_poll_view(v_token);
  perform tests.assert_eq('a poll closed before anyone voted reveals nothing',
    (v_view ->> 'results_available')::boolean, false);
  perform tests.assert_null('and elects nobody',
    v_view ->> 'winner_name');
end $$;

rollback;

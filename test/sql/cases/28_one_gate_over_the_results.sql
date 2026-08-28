-- One gate over everything a finished poll shows.
--
-- `poll_results_revealed` is group-wide on purpose: a poll of several
-- questions that revealed question one's result while question three was
-- still taking votes would let the early answers steer the late ones. The
-- tally has always been refused under it. The published ballot sheet was not
-- -- it asked `poll_gate_open` of its own question and no other -- and a
-- sheet of every ballot cast in a question *is* that question's result, in
-- the form it can be recomputed from.
--
-- So this case is mostly one assertion said from both sides: on a question
-- that has finished inside a poll that has not, the sheet is refused exactly
-- as the tally is. The rest is the reconciliation not having moved anything
-- on a poll of one question, which is nearly all of them, and the sheet then
-- riding along on the read that opens the page.

begin;

do $$
declare
  v_group uuid;
  v_q uuid[];
  v_open uuid;
  v_quiet uuid;
  v_page jsonb;
begin
  -- ---- a question that has finished, inside a poll that has not ------------

  perform tests.sign_in('creator@example.com');
  v_group := create_poll_group(
    'Team lunch', null,
    '[{"title": "Where?", "options": [{"name": "Pizza"}, {"name": "Salad"}]},
      {"title": "When?",  "options": [{"name": "Noon"},  {"name": "One"}]}]'::jsonb,
    array['one@example.com', 'two@example.com'], 'invite', true, true);
  v_q := tests.group_questions(v_group);

  -- Everybody answers the first question. Nobody answers the second.
  perform tests.sign_in('one@example.com');
  perform tests.cast_ballot(v_q[1], array[5, 1]);
  perform tests.sign_in('two@example.com');
  perform tests.cast_ballot(v_q[1], array[4, 0]);

  perform tests.sign_in('creator@example.com');
  perform tests.assert_eq('the first question has stopped taking votes',
    (select poll_gate_open(p.*) from polls p where p.id = v_q[1]), true);
  perform tests.assert_eq('but the poll it belongs to has not',
    (select s.results_available from poll_status(v_q[1]) s), false);
  perform tests.assert_raises('so its tally is sealed',
    format('select get_poll_results(%L)', v_q[1]),
    'until everyone has voted');

  -- The assertion this migration exists for. Before it, this call returned
  -- every ballot cast in question one.
  perform tests.assert_raises('and its ballots are sealed on the same terms',
    format('select poll_ballots(%L)', v_q[1]),
    'Ballots are not available until everyone has voted');

  v_page := poll_page(v_q[1]);
  perform tests.assert_null('the page that opens it carries no tally',
    v_page ->> 'results');
  perform tests.assert_null('and no sheet',
    v_page ->> 'ballots');

  -- ---- and once the last question is in ------------------------------------

  perform tests.sign_in('one@example.com');
  perform tests.cast_ballot(v_q[2], array[5, 0]);
  perform tests.sign_in('two@example.com');
  perform tests.cast_ballot(v_q[2], array[0, 5]);

  perform tests.sign_in('creator@example.com');
  perform tests.assert_eq('the tally opens',
    tests.winner(get_poll_results(v_q[1])), 'Pizza');
  perform tests.assert_eq('and the sheet opens with it, not before',
    jsonb_array_length(poll_ballots(v_q[1]) -> 'ballots'), 2);

  v_page := poll_page(v_q[1]);
  perform tests.assert_eq('both on the read that opens the page',
    tests.winner(v_page -> 'results'), 'Pizza');
  perform tests.assert_eq('the sheet in full, one row per ballot',
    jsonb_array_length(v_page -> 'ballots' -> 'ballots'), 2);
  perform tests.assert_eq('naming the voters, because the poll shows them',
    (v_page -> 'ballots' ->> 'voters_named')::boolean, true);

  -- ---- a poll that does not publish its ballots ----------------------------

  -- The other half of the condition, which is the poll's own settled promise
  -- rather than a stage: nothing is carried and nothing is asked for.
  v_quiet := tests.seed_poll(array['Apple', 'Banana'], array[[5, 1], [4, 0]]);
  v_page := poll_page(v_quiet);
  perform tests.assert_eq('a finished poll that publishes no ballots still tallies',
    tests.winner(v_page -> 'results'), 'Apple');
  perform tests.assert_null('and carries no sheet',
    v_page ->> 'ballots');
  perform tests.assert_raises('which is what asking for it says too',
    format('select poll_ballots(%L)', v_quiet),
    'does not publish individual ballots');

  -- ---- the open reading ----------------------------------------------------

  perform tests.sign_in('creator@example.com');
  v_open := create_poll('Movie night', null, array['Dune', 'Arrival'],
                        array[]::text[], 'open', true, true);

  update auth._session set user_id = null, email = null where id;
  perform open_poll_submit(v_open, tests.open_scores(v_open, array[5, 1]), 'key-one', 'Robin');

  v_page := poll_page(v_open);
  perform tests.assert_eq('an open poll still taking votes is the open reading',
    v_page ->> 'kind', 'open');
  perform tests.assert_null('and publishes nothing until it is closed',
    v_page ->> 'ballots');
  perform tests.assert_raises('as asking for it directly says',
    format('select open_poll_ballots(%L)', v_open),
    'until the poll is closed');

  perform tests.sign_in('creator@example.com');
  perform close_poll(v_open);

  update auth._session set user_id = null, email = null where id;
  v_page := poll_page(v_open);
  perform tests.assert_eq('closed, the sheet comes with the page',
    jsonb_array_length(v_page -> 'ballots' -> 'ballots'), 1);
  perform tests.assert_eq('through the door a link holder actually has',
    v_page -> 'ballots' -> 'ballots' -> 0 ->> 'voter', 'Robin');

  -- The creator reads the same poll as an account, and gets the same sheet:
  -- one gate, and it says nothing about which door was used.
  perform tests.sign_in('creator@example.com');
  perform tests.assert_eq('and the creator is handed the same sheet',
    poll_page(v_open) -> 'ballots', v_page -> 'ballots');
end $$;

rollback;

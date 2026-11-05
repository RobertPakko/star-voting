-- The tally and the full ranking stop at ten; every score is one more call.
--
-- A calendar poll can have hundreds of options, and the tally used to carry
-- every one of them to a page that drew ten, while the ranking ran a STAR
-- round for every place down to last. Now the database cuts both
-- (poll_results_rows()), says how big the field was (option_count), and
-- answers "every option's score" separately through poll_scores().
--
-- Thirteen options and three voters, scored so that every total differs and
-- every voter scores each option at least as high as the next. So the score
-- order is O01 to O13, totals 15 down to 3, and every runoff between
-- neighbours goes to the higher one: the ranking places them in that order.

begin;

do $$
declare
  v_poll uuid;
  t jsonb;
  r jsonb;
  s jsonb;
begin
  v_poll := tests.seed_poll(
    array['O01','O02','O03','O04','O05','O06','O07','O08','O09','O10','O11','O12','O13'],
    array[
      [5, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1],
      [5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1],
      [5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 1]
    ]);

  t := poll_tally(v_poll);

  perform tests.assert_eq('the tally carries the top ten',
    tests.option_order(t),
    array['O01','O02','O03','O04','O05','O06','O07','O08','O09','O10']);
  perform tests.assert_eq('and says the field was thirteen',
    (t->>'option_count')::int, 13);
  perform tests.assert_eq('the tenth row is the tenth score', tests.total_score(t, 'O10'), 6);
  perform tests.assert_eq('O01 wins', tests.winner(t), 'O01');

  r := poll_ranking(v_poll);

  perform tests.assert_eq('the ranking stops at ten places', jsonb_array_length(r), 10);
  perform tests.assert_eq('placing first what the tally elected', tests.placed_at(r, 1), array['O01']);
  perform tests.assert_eq('and tenth the tenth', tests.placed_at(r, 10), array['O10']);
  perform tests.assert_null('nothing is placed eleventh', tests.placed_at(r, 11));

  -- O10 beat O11 for tenth place, and O11 is in neither the tally's ten nor
  -- the ranking's places, so the ranking has to name it itself.
  perform tests.assert_eq('a place names both its finalists, in finalist order',
    array(select jsonb_array_elements_text(r #> '{9,finalist_names}')),
    array['O10', 'O11']);

  s := poll_scores(v_poll);

  perform tests.assert_eq('every score is one call away', jsonb_array_length(s), 13);
  perform tests.assert_eq('highest first', s #>> '{0,name}', 'O01');
  perform tests.assert_eq('down to the last', s #>> '{12,name}', 'O13');
  perform tests.assert_eq('with its total', (s #>> '{12,total_score}')::int, 3);
  perform tests.assert_eq('and its average', (s #>> '{12,average_score}')::numeric, 1.00);
end $$;

-- A short poll is untouched: the cut is a ceiling, not a size.
do $$
declare
  v_poll uuid;
  t jsonb;
begin
  v_poll := tests.seed_poll(array['Apple', 'Banana', 'Cherry'], array[[5, 3, 1]]);
  t := poll_tally(v_poll);

  perform tests.assert_eq('three options, three rows', jsonb_array_length(t->'options'), 3);
  perform tests.assert_eq('and a field of three', (t->>'option_count')::int, 3);
  perform tests.assert_eq('ranked all the way down', jsonb_array_length(poll_ranking(v_poll)), 3);
end $$;

-- Every score is the score round in full, so it is gated as the tally is.
do $$
declare
  v_poll uuid;
  v_scores jsonb;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Lunch', null,
                        array['Apple', 'Banana', 'Cherry'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false);

  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_poll, (
    select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 3))
    from candidates where poll_id = v_poll));

  perform tests.sign_in('creator@example.com');
  perform tests.assert_raises('the scores wait for everyone',
    format('select get_poll_scores(%L)', v_poll),
    'Results are not available until everyone has voted');

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('and a stranger is told no such poll',
    format('select get_poll_scores(%L)', v_poll),
    'Poll not found');

  perform tests.sign_in('creator@example.com');
  perform close_poll(v_poll);
  perform tests.assert_eq('closing unlocks them',
    jsonb_array_length(get_poll_scores(v_poll)), 3);

  -- And through the link.
  v_poll := create_poll('Movie night', null,
                        array['Dune', 'Arrival', 'Solaris'],
                        array[]::text[], 'open', true, true);
  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 4))
  into v_scores from candidates where poll_id = v_poll;
  perform open_poll_submit(v_poll, v_scores, 'voter-key-1', 'Robin');

  perform tests.assert_raises('an open poll shows no scores until it closes',
    format('select open_poll_scores(%L)', v_poll),
    'Results are not available until the poll is closed');

  perform close_poll(v_poll);
  perform tests.assert_eq('and every score once it has',
    jsonb_array_length(open_poll_scores(v_poll)), 3);

  perform tests.assert_eq('poll_scores is nobody''s to call directly',
    has_function_privilege('authenticated', 'poll_scores(uuid)', 'execute'), false);
  perform tests.assert_eq('nor is the cut',
    has_function_privilege('anon', 'poll_results_rows()', 'execute'), false);
  perform tests.assert_eq('the link door is open to anon',
    has_function_privilege('anon', 'open_poll_scores(uuid)', 'execute'), true);
  perform tests.assert_eq('the account door is not',
    has_function_privilege('anon', 'get_poll_scores(uuid)', 'execute'), false);
end $$;

rollback;

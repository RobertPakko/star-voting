-- Multiple winners: a STAR election per spot, every ballot counting at
-- 1 / (1 + SUM / 5) for the stars SUM it gave earlier winners, in the scores
-- and the runoff alike. Options the reader leaves out are left off the ballot
-- entirely.
--
-- The ballots are /extensions' six friends, so the page and the count agree:
--
--            pizza tacos sushi
--   friend 1   5     4     0
--   friend 2   5     4     1
--   friend 3   5     2     0
--   friend 4   0     3     3
--   friend 5   0     3     5
--   friend 6   1     1     5
--
-- Spot 1 is plain STAR: tacos 17 and pizza 16 are the finalists, and pizza
-- wins the runoff 3 to 2 (friend 6 level). Friends 1-3 gave pizza 5,
-- so count at 1/2 from now on, and friend 6 gave it 1, so at 5/6. Spot 2:
-- tacos 2 + 2 + 1 + 3 + 3 + 5/6 = 11.833333, sushi 0 + 0.5 + 0 + 3 + 5 +
-- 25/6 = 12.666667; the runoff is tacos 1.5 (friends 1-3 at a half each),
-- sushi 1 + 5/6 = 1.833333 (friends 5 and 6), friend 4 level. Sushi takes
-- spot 2, where the full ranking puts tacos second.
--
-- With pizza left out, spot 1 is tacos (17 to 14, runoff 3 to 2). Then every
-- ballot is charged its tacos stars: 4, 4, 2, 3, 3, 1, so sushi's weighted
-- total is 1 * 5/9 + 3 * 5/8 + 5 * 5/8 + 5 * 5/6 = 9.722222.

begin;

do $$
declare
  v_poll uuid;
  v_pizza uuid;
  v_tacos uuid;
  m jsonb;
begin
  v_poll := tests.seed_poll(
    array['pizza', 'tacos', 'sushi'],
    array[[5, 4, 0],
          [5, 4, 1],
          [5, 2, 0],
          [0, 3, 3],
          [0, 3, 5],
          [1, 1, 5]]);
  perform close_poll(v_poll);

  select id into v_pizza from candidates where poll_id = v_poll and name = 'pizza';
  select id into v_tacos from candidates where poll_id = v_poll and name = 'tacos';

  m := get_poll_multiple_winners(v_poll, '{}');

  perform tests.assert_eq('every option has a spot', jsonb_array_length(m), 3);
  perform tests.assert_eq('the first spot is the STAR winner',
    tests.placed_at(m, 1), array[tests.winner(get_poll_results(v_poll))]);
  perform tests.assert_eq('pizza first', tests.placed_at(m, 1), array['pizza']);
  perform tests.assert_eq('sushi second, where the full ranking has tacos',
    tests.placed_at(m, 2), array['sushi']);
  perform tests.assert_eq('the full ranking does have tacos second',
    tests.placed_at(get_poll_ranking(v_poll), 2), array['tacos']);
  perform tests.assert_eq('tacos third', tests.placed_at(m, 3), array['tacos']);

  -- Spot 2's numbers, at the friends' new strengths. Sushi leads on score,
  -- so it is the runoff's `a`.
  perform tests.assert_eq('sushi is elected on 12.666667 weighted stars',
    (m #>> '{1,options,0,total_score}')::numeric, 12.666667);
  perform tests.assert_eq('sushi is preferred at one full strength and five sixths',
    (m #>> '{1,runoff,prefers_a}')::numeric, 1.833333);
  perform tests.assert_eq('tacos by three halves',
    (m #>> '{1,runoff,prefers_b}')::numeric, 1.5);
  perform tests.assert_eq('and friend 4 scored them level',
    (m #>> '{1,runoff,ties}')::numeric, 1::numeric);
  perform tests.assert_eq('the runoff names both finalists',
    (select array_agg(x order by x) from jsonb_array_elements_text(m #> '{1,finalist_names}') x),
    array['sushi', 'tacos']);

  -- Leaving pizza out runs the count as though it had never been on the
  -- ballot.
  m := get_poll_multiple_winners(v_poll, array[v_pizza]);
  perform tests.assert_eq('without pizza, two spots', jsonb_array_length(m), 2);
  perform tests.assert_eq('tacos first', tests.placed_at(m, 1), array['tacos']);
  perform tests.assert_eq('sushi second', tests.placed_at(m, 2), array['sushi']);
  perform tests.assert_eq('sushi at the strengths tacos left',
    (m #>> '{1,options,0,total_score}')::numeric, 9.722222);

  -- And again: leaving out options one after another.
  m := get_poll_multiple_winners(v_poll, array[v_pizza, v_tacos]);
  perform tests.assert_eq('without both, sushi alone', jsonb_array_length(m), 1);
  perform tests.assert_eq('unopposed', tests.placed_at(m, 1), array['sushi']);
  perform tests.assert_null('with no runoff', m #>> '{0,runoff}');

  -- An id that is not one of this poll's options is ignored.
  m := get_poll_multiple_winners(v_poll, array[gen_random_uuid()]);
  perform tests.assert_eq('a stranger id leaves nothing out', jsonb_array_length(m), 3);
end $$;

-- A runoff level on every rule elects nobody, so both finalists share the
-- spot and both are charged to the ballots that starred them.
do $$
declare
  v_poll uuid;
  m jsonb;
begin
  -- Apple and Banana are mirror images: 10 stars each, one voter preferring
  -- each, two fives each, so the runoff is level on every rule.
  v_poll := tests.seed_poll(
    array['Apple', 'Banana', 'Cherry'],
    array[[5, 0, 4],
          [0, 5, 4],
          [5, 5, 0]]);
  perform close_poll(v_poll);

  m := get_poll_multiple_winners(v_poll, '{}');
  perform tests.assert_eq('the tied pair share spot 1',
    tests.placed_at(m, 1), array['Apple', 'Banana']);
  perform tests.assert_eq('and the next spot is numbered past them',
    tests.placed_at(m, 3), array['Cherry']);
  -- Voters 1 and 2 gave the pair 5 stars each, so count at a half: Cherry's
  -- 4 + 4 is 4.
  perform tests.assert_eq('charged for both winners',
    (m #>> '{1,options,0,total_score}')::numeric, 4::numeric);
end $$;

-- The count stops at ten spots, as the full ranking does.
do $$
declare
  v_poll uuid;
  m jsonb;
  v_placed int;
begin
  v_poll := tests.seed_poll(
    array['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'],
    array[[5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0, 0],
          [5, 4, 5, 3, 4, 2, 3, 1, 2, 0, 1, 0]]);
  perform close_poll(v_poll);

  m := get_poll_multiple_winners(v_poll, '{}');
  select count(*) into v_placed
  from jsonb_array_elements(m) s, jsonb_array_elements(s->'options');

  perform tests.assert_eq('twelve options, ten or eleven placed',
    v_placed between 10 and 11, true);
  perform tests.assert_eq('the last spot is the tenth or a share of it',
    (m -> -1 ->> 'place')::int <= 10, true);
end $$;

-- Gated exactly as the ranking is.
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

  perform tests.assert_raises('an unfinished invite poll keeps its winners',
    format('select get_poll_multiple_winners(%L, ''{}'')', v_poll),
    'Results are not available until everyone has voted');

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('a stranger is told no such poll',
    format('select get_poll_multiple_winners(%L, ''{}'')', v_poll),
    'Poll not found');

  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Movie night', null,
                        array['Dune', 'Arrival', 'Solaris'],
                        array[]::text[], 'open', true, true);
  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 3))
  into v_scores from candidates where poll_id = v_poll;
  perform open_poll_submit(v_poll, v_scores, 'voter-key-1', 'Robin');

  perform tests.assert_raises('an open poll keeps them until it closes',
    format('select open_poll_multiple_winners(%L, ''{}'')', v_poll),
    'Results are not available until the poll is closed');

  perform close_poll(v_poll);
  perform tests.assert_eq('and gives them once it has',
    jsonb_array_length(open_poll_multiple_winners(v_poll, '{}')) > 0, true);

  perform tests.assert_eq('the count itself is nobody''s to call',
    has_function_privilege('anon', 'public.poll_multiple_winners(uuid, uuid[])', 'execute')
      or has_function_privilege('authenticated', 'public.poll_multiple_winners(uuid, uuid[])', 'execute'),
    false);
  perform tests.assert_eq('nor the weighted round',
    has_function_privilege('authenticated',
      'public.weighted_star_round(uuid, uuid[], uuid[], numeric[])', 'execute'),
    false);
end $$;

rollback;

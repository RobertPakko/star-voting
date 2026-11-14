-- Poll variants: a question takes at most one of a calendar, a sequence and
-- a budget; multiple winners with a budget; and any finished question with a
-- published, named sheet counted as though it had been sequential.
--
-- The ballots are /choices' six friends (48_multiple_winners'), with
-- 54_proportional_budget's platters: pizza 20, tacos 30, sushi 25.
--
--            pizza tacos sushi
--   friend 1   5     4     0
--   friend 2   5     4     1
--   friend 3   5     2     0
--   friend 4   0     3     3
--   friend 5   0     3     5
--   friend 6   1     1     5
--
-- Multiple winners with a budget of 50 runs STAR again and again over what
-- still fits and charges nobody. Round 1 is the ordinary result, pizza
-- (totals 16, 17, 14; pizza beats tacos 3 to 2 in the runoff), leaving 30.
-- Round 2 is tacos against sushi, both fitting: tacos 17 to 14, and 3 to 2
-- in the runoff. Tacos is funded, leaving nothing: pizza and tacos, where
-- proportional winners buys pizza and sushi.
--
-- With a budget of 45, pizza leaves 25, which tacos (30) no longer fits, so
-- the count skips it and funds sushi, leaving nothing.
--
-- Counted as sequential with 53_sequential_polls' N (5, 5, 5, 0, 0, 1), the
-- best option is sushi, where the plain count elects pizza: the same answer
-- a question made sequential with those voters gives.

begin;

do $$
declare
  v_emails text[] := array['voter1@example.com', 'voter2@example.com', 'voter3@example.com',
                           'voter4@example.com', 'voter5@example.com', 'voter6@example.com'];
  v_ballots int[][] := array[[5, 4, 0], [5, 4, 1], [5, 2, 0], [0, 3, 3], [0, 3, 5], [1, 1, 5]];
  v_schedule jsonb := '{"timezone":"-07:00","window":{"start":"09:00","end":"12:00"},'
                      '"desired_slots":1,"granularity":60}'::jsonb;
  v_poll uuid;
  v_named uuid;
  v_carried uuid;
  t jsonb;
  b jsonb;
  s jsonb;
  i int;
begin
  -- Multiple winners with a budget is a kind of its own, budgeted and costed.
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Party', null, array['pizza', 'tacos', 'sushi'], v_emails,
    'invite', true, false, null, false, 'ranking_budget', null, 50, null, array[20, 30, 25]);

  perform tests.assert_eq('the budget is the question''s number',
    (select kind || ' ' || kind_value from polls where id = v_poll), 'ranking_budget 50');
  perform tests.assert_eq('every option keeps its cost',
    (select array_agg(kind_value order by sort_order) from candidates where poll_id = v_poll),
    array[20, 30, 25]::numeric[]);

  for i in 1 .. 6 loop
    perform tests.sign_in(v_emails[i]);
    perform tests.cast_ballot(v_poll, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
  end loop;
  perform tests.sign_in('creator@example.com');

  t := get_poll_results(v_poll);
  b := t -> 'kind_result';
  perform tests.assert_eq('the tally carries the budget count', jsonb_array_length(b -> 'spots'), 2);
  perform tests.assert_eq('pizza first', tests.placed_at(b -> 'spots', 1), array['pizza']);
  perform tests.assert_eq('tacos second, by popularity', tests.placed_at(b -> 'spots', 2), array['tacos']);
  perform tests.assert_eq('nobody is charged, so totals are plain stars',
    (b #>> '{spots,1,options,0,total_score}')::numeric, 17::numeric);
  perform tests.assert_eq('the whole budget spent', (b ->> 'left')::numeric, 0::numeric);
  perform tests.assert_eq('the carried result is the door''s',
    b, get_poll_budget(v_poll, '{}', null, null, 'ranking'));
  perform tests.assert_eq('where proportional winners would buy sushi',
    tests.placed_at(get_poll_budget(v_poll, '{}', null, null, 'multiple') -> 'spots', 2), array['sushi']);
  perform tests.assert_eq('a budget names no one winner',
    (select winner_name from polls where id = v_poll), null::text);

  b := get_poll_budget(v_poll, '{}', null, 45, 'ranking');
  perform tests.assert_eq('with 45, tacos no longer fits and is skipped',
    tests.placed_at(b -> 'spots', 2), array['sushi']);
  perform tests.assert_eq('so tacos goes unfunded',
    (select array_agg(o ->> 'name') from jsonb_array_elements(b -> 'unfunded') o), array['tacos']);

  perform tests.assert_raises('multiple winners with a budget needs the budget',
    format('select create_poll(%L, null, array[%L, %L], %L, %L, true, false, null, false, %L, null, null, null, array[1, 2])',
      'x', 'a', 'b', array['voter1@example.com'], 'invite', 'ranking_budget'),
    'Give the budget');
  perform tests.assert_raises('and a cost on every option',
    format('select create_poll(%L, null, array[%L, %L], %L, %L, true, false, null, false, %L, null, 10, null, null)',
      'x', 'a', 'b', array['voter1@example.com'], 'invite', 'ranking_budget'),
    'Give "a" a cost');

  -- Variants do not combine.
  perform tests.assert_raises('a budget is never a calendar',
    format('select create_poll(%L, null, array[]::text[], %L, %L, true, false, null, true, %L, %L, 10)',
      'x', array['voter1@example.com'], 'invite', 'ranking_budget', v_schedule),
    'A budget poll cannot be a time poll');
  perform tests.assert_raises('a sequence is never a calendar',
    format('select create_poll(%L, null, array[%L, %L], %L, %L, true, true, null, false, %L, %L, null, %L)',
      'x', '2026-09-01T09:00:00-07:00', '2026-09-01T10:00:00-07:00', array['voter1@example.com'],
      'invite', 'option', v_schedule, '[{"voter": "voter1@example.com", "given": 1}]'),
    'A sequential poll cannot also be a time poll');

  -- Counted as sequential after the fact, on a sheet published with names.
  v_named := create_poll('Week 2', null, array['pizza', 'tacos', 'sushi'], v_emails,
    'invite', true, true);
  v_carried := create_poll('Week 2, carried', null, array['pizza', 'tacos', 'sushi'], v_emails,
    'invite', true, true, null, false, 'option', null, null,
    '[{"voter": "voter1@example.com", "given": 5}, {"voter": "voter2@example.com", "given": 5},
      {"voter": "voter3@example.com", "given": 5}, {"voter": "voter4@example.com", "given": 0},
      {"voter": "voter5@example.com", "given": 0}, {"voter": "voter6@example.com", "given": 1}]');
  for i in 1 .. 6 loop
    perform tests.sign_in(v_emails[i]);
    perform tests.cast_ballot(v_named, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
    perform tests.cast_ballot(v_carried, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
  end loop;
  perform tests.sign_in('creator@example.com');
  perform close_poll(v_named);
  perform close_poll(v_carried);

  perform tests.assert_eq('the sheet is in the order the N are given in',
    (select array_agg(x ->> 'voter') from jsonb_array_elements(poll_ballots(v_named) -> 'ballots') x),
    v_emails);

  s := get_poll_sequential(v_named, 'option', array[5, 5, 5, 0, 0, 1]);
  perform tests.assert_eq('weighed, the best option is sushi', tests.placed_at(s, 1), array['sushi']);
  perform tests.assert_eq('as a sequential question carrying the same voters says',
    tests.winner(get_poll_results(v_carried)), 'sushi');
  perform tests.assert_eq('place by place',
    tests.placed_at(s, 2), tests.placed_at(get_poll_ranking(v_carried), 2));
  perform tests.assert_eq('and at the same weighted totals',
    (s #>> '{0,options,0,total_score}')::numeric,
    (get_poll_ranking(v_carried) #>> '{0,options,0,total_score}')::numeric);
  perform tests.assert_eq('proportional winners starts every ballot from its N',
    tests.placed_at(get_poll_sequential(v_named, 'multiple', array[5, 5, 5, 0, 0, 1]), 1),
    tests.placed_at(get_poll_multiple_winners(v_carried), 1));
  perform tests.assert_eq('nothing stays weighed afterwards',
    tests.placed_at(get_poll_ranking(v_named), 1), array['pizza']);
  perform tests.assert_eq('and the poll itself is not sequential',
    (get_poll_results(v_named) ->> 'weighted')::boolean, false);
  perform tests.assert_eq('a sequential question can be weighed again, over its own N',
    tests.placed_at(get_poll_sequential(v_carried, 'option', array[0, 0, 0, 0, 0, 0]), 1),
    array['pizza']);

  perform tests.assert_raises('every ballot needs an N',
    format('select get_poll_sequential(%L, %L, array[1, 2])', v_named, 'option'),
    'Give every ballot the stars its voter gave earlier winners');
  perform tests.assert_raises('within the bounds a carried row has',
    format('select get_poll_sequential(%L, %L, array[1, 2, 3, 4, 5, -1])', v_named, 'option'),
    'Stars given to previous winners must be from 0 to 10000');
  perform tests.assert_raises('only for a result STAR decides',
    format('select get_poll_sequential(%L, %L, array[0, 0, 0, 0, 0, 0])', v_named, 'consensus'),
    'Only the best option, multiple winners or proportional winners can be counted as a sequential poll');
  perform tests.assert_raises('only where the sheet names every ballot already',
    format('select get_poll_sequential(%L, %L, array[0, 0, 0, 0, 0, 0])', v_poll, 'option'),
    'Only a poll that publishes its ballots with names on them can be counted as a sequential poll');

  perform tests.assert_eq('the count itself is not callable',
    has_function_privilege('authenticated', 'poll_sequential(uuid, text, numeric[])', 'execute'), false);
  perform tests.assert_eq('the link door is',
    has_function_privilege('anon', 'open_poll_sequential(uuid, text, numeric[])', 'execute'), true);
  perform tests.assert_eq('nor is the setting it reads',
    has_function_privilege('authenticated', 'ballot_given(uuid)', 'execute'), false);
end $$;

rollback;

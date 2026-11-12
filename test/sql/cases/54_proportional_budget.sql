-- Proportional budget: cost-adjusted STAR once per option funded, among the
-- options that still fit, every ballot at 5 / (5 + SUM(N x C / A)) for the
-- stars N it gave each funded option of cost C, A the average cost.
--
-- The ballots are /choices' six friends (48_multiple_winners'), with its
-- party platters: pizza 20, tacos 30, sushi 25, a budget of 50, so A = 25
-- and each star is scaled by pizza 5/4, tacos 5/6, sushi 1.
--
--            pizza tacos sushi
--   friend 1   5     4     0
--   friend 2   5     4     1
--   friend 3   5     2     0
--   friend 4   0     3     3
--   friend 5   0     3     5
--   friend 6   1     1     5
--
-- Round 1, everyone at full strength: pizza 16 x 5/4 = 20, tacos 17 x 5/6 =
-- 14.166667, sushi 14. Pizza and tacos go to the runoff; friends 1-3 prefer
-- pizza (3 x 5/4 = 3.75), friends 4 and 5 tacos (2 x 5/6 = 1.666667), friend
-- 6 level. Pizza is funded, leaving 30.
--
-- Each ballot is charged its pizza stars x 20/25: friends 1-3 lose 4 (so
-- count at 5/9), friend 6 loses 0.8 (5/5.8), friends 4 and 5 nothing.
-- Round 2, tacos (30) and sushi (25) both still fit: sushi 5/9 + 3 + 5 +
-- 5 x 5/5.8 = 12.865900, ahead of tacos. In the runoff friends 5 and 6 prefer
-- sushi, 1 + 5/5.8 = 1.862069; friends 1-3 tacos, 3 x 5/9 x 5/6 = 1.388889.
-- Sushi is funded, leaving 5, and nothing else fits: pizza and sushi, where
-- funding by popularity would buy pizza and tacos.
--
-- With pizza left out, A is 27.5: tacos 17 x 27.5/30 = 15.583333 against
-- sushi 14 x 1.1 = 15.4, and tacos wins the runoff 2.75 to 2.2. That leaves
-- 20, which sushi does not fit.

begin;

do $$
declare
  v_poll uuid;
  v_pizza uuid;
  v_tacos uuid;
  v_sushi uuid;
  v_costs jsonb;
  b jsonb;
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
  select id into v_sushi from candidates where poll_id = v_poll and name = 'sushi';
  v_costs := jsonb_build_object(v_pizza, 20, v_tacos, 30, v_sushi, 25);

  -- An ordinary question, costed by the reader: nothing is stored.
  b := get_poll_proportional_budget(v_poll, '{}', v_costs, 50);

  perform tests.assert_eq('two options funded', jsonb_array_length(b -> 'spots'), 2);
  perform tests.assert_eq('pizza first', tests.placed_at(b -> 'spots', 1), array['pizza']);
  perform tests.assert_eq('sushi second, where popularity would buy tacos',
    tests.placed_at(b -> 'spots', 2), array['sushi']);
  perform tests.assert_eq('the option ranking does have tacos second',
    tests.placed_at(get_poll_ranking(v_poll), 2), array['tacos']);

  perform tests.assert_eq('pizza is elected on 20 scaled stars',
    (b #>> '{spots,0,options,0,total_score}')::numeric, 20::numeric);
  perform tests.assert_eq('at its cost',
    (b #>> '{spots,0,options,0,cost}')::numeric, 20::numeric);
  perform tests.assert_eq('preferred by three voters at five quarters each',
    (b #>> '{spots,0,runoff,prefers_a}')::numeric, 3.75);
  perform tests.assert_eq('over two at five sixths',
    (b #>> '{spots,0,runoff,prefers_b}')::numeric, 1.666667);
  perform tests.assert_eq('friend 6 scored them level, and counts unscaled',
    (b #>> '{spots,0,runoff,ties}')::numeric, 1::numeric);
  perform tests.assert_eq('leaving 30',
    (b #>> '{spots,0,left}')::numeric, 30::numeric);

  perform tests.assert_eq('sushi at the strengths pizza left',
    (b #>> '{spots,1,options,0,total_score}')::numeric, 12.865900);
  perform tests.assert_eq('preferred at one full strength and five 5.8ths',
    (b #>> '{spots,1,runoff,prefers_a}')::numeric, 1.862069);
  perform tests.assert_eq('over three fifth-ninths at five sixths',
    (b #>> '{spots,1,runoff,prefers_b}')::numeric, 1.388889);

  perform tests.assert_eq('the budget', (b ->> 'budget')::numeric, 50::numeric);
  perform tests.assert_eq('45 spent', (b ->> 'spent')::numeric, 45::numeric);
  perform tests.assert_eq('5 left over', (b ->> 'left')::numeric, 5::numeric);
  perform tests.assert_eq('the average cost', (b ->> 'average_cost')::numeric, 25::numeric);
  perform tests.assert_eq('tacos unfunded',
    (select array_agg(x ->> 'name') from jsonb_array_elements(b -> 'unfunded') x), array['tacos']);
  perform tests.assert_eq('nothing uncosted', jsonb_array_length(b -> 'uncosted'), 0);
  perform tests.assert_null('no tie', b ->> 'tied');

  perform tests.assert_null('nothing was stored',
    (select max(kind_value) from candidates where poll_id = v_poll));

  -- Left out, the average is over the options still counted.
  b := get_poll_proportional_budget(v_poll, array[v_pizza], v_costs, 50);
  perform tests.assert_eq('without pizza, tacos alone',
    jsonb_array_length(b -> 'spots'), 1);
  perform tests.assert_eq('tacos funded', tests.placed_at(b -> 'spots', 1), array['tacos']);
  perform tests.assert_eq('on 17 stars at 27.5/30',
    (b #>> '{spots,0,options,0,total_score}')::numeric, 15.583333);
  perform tests.assert_eq('2.75 to 2.2',
    array[(b #>> '{spots,0,runoff,prefers_a}')::numeric, (b #>> '{spots,0,runoff,prefers_b}')::numeric],
    array[2.75, 2.2]);
  perform tests.assert_eq('and 20 is not enough for sushi',
    (select array_agg(x ->> 'name') from jsonb_array_elements(b -> 'unfunded') x), array['sushi']);

  -- An option given no cost is left out, and said to be.
  b := get_poll_proportional_budget(v_poll, '{}',
    jsonb_build_object(v_pizza, 20, v_tacos, 30), 50);
  perform tests.assert_eq('sushi uncosted',
    (select array_agg(x ->> 'name') from jsonb_array_elements(b -> 'uncosted') x), array['sushi']);
  perform tests.assert_eq('pizza and tacos then both fit',
    (select array_agg(s #>> '{options,0,name}' order by (s ->> 'place')::int)
     from jsonb_array_elements(b -> 'spots') s), array['pizza', 'tacos']);

  -- A budget too small for anything funds nothing.
  b := get_poll_proportional_budget(v_poll, '{}', v_costs, 10);
  perform tests.assert_eq('nothing fits in 10', jsonb_array_length(b -> 'spots'), 0);
  perform tests.assert_eq('so all three are unfunded', jsonb_array_length(b -> 'unfunded'), 3);

  perform tests.assert_raises('an ordinary question has no budget of its own',
    format('select get_poll_proportional_budget(%L, ''{}'', %L)', v_poll, v_costs),
    'Give the budget');
  perform tests.assert_raises('a cost is a whole number',
    format('select get_poll_proportional_budget(%L, ''{}'', %L, 50)', v_poll,
      jsonb_build_object(v_pizza, 2.5)),
    'A cost must be a whole number from 1 to 1,000,000,000');
  perform tests.assert_raises('and at least 1',
    format('select get_poll_proportional_budget(%L, ''{}'', %L, 50)', v_poll,
      jsonb_build_object(v_pizza, 0)),
    'A cost must be a whole number from 1 to 1,000,000,000');
  perform tests.assert_raises('so is a budget',
    format('select get_poll_proportional_budget(%L, ''{}'', %L, -1)', v_poll, v_costs),
    'The budget must be a whole number from 1 to 1,000,000,000');
  perform tests.assert_raises('a count needs a costed option',
    format('select get_poll_proportional_budget(%L, ''{}'', ''{}'', 50)', v_poll),
    'Give at least one option a cost');
end $$;

-- A runoff level on every rule funds both finalists where both fit, and
-- neither where they do not, stopping the count there.
do $$
declare
  v_poll uuid;
  v_costs jsonb;
  b jsonb;
begin
  -- Apple and Banana are mirror images, so their runoff is level on every rule.
  v_poll := tests.seed_poll(
    array['Apple', 'Banana', 'Cherry'],
    array[[5, 0, 4],
          [0, 5, 4],
          [5, 5, 0]]);
  perform close_poll(v_poll);
  select jsonb_object_agg(id, 10) into v_costs from candidates where poll_id = v_poll;

  b := get_poll_proportional_budget(v_poll, '{}', v_costs, 20);
  perform tests.assert_eq('the tied pair share the spot',
    tests.placed_at(b -> 'spots', 1), array['Apple', 'Banana']);
  perform tests.assert_eq('and spend the budget', (b ->> 'left')::numeric, 0::numeric);
  perform tests.assert_null('which is not a stopping tie', b ->> 'tied');

  b := get_poll_proportional_budget(v_poll, '{}', v_costs, 15);
  perform tests.assert_eq('with room for one, nothing is funded',
    jsonb_array_length(b -> 'spots'), 0);
  perform tests.assert_eq('and the tie is named',
    (select array_agg(x ->> 'name' order by x ->> 'name') from jsonb_array_elements(b -> 'tied') x),
    array['Apple', 'Banana']);
end $$;

-- A budget question: costs and a budget stored with it, and the tally
-- carrying its count.
do $$
declare
  v_emails text[] := array['f1@example.com', 'f2@example.com', 'f3@example.com',
                           'f4@example.com', 'f5@example.com', 'f6@example.com'];
  v_ballots int[][] := array[[5, 4, 0], [5, 4, 1], [5, 2, 0], [0, 3, 3], [0, 3, 5], [1, 1, 5]];
  v_poll uuid;
  v_group uuid;
  v_tacos uuid;
  t jsonb;
  i int;
begin
  perform tests.sign_in('creator@example.com');

  v_poll := create_poll('Party', null, array['pizza', 'tacos', 'sushi'], v_emails,
    p_kind => 'budget', p_kind_value => 50, p_option_costs => array[20, 30, 25]);

  perform tests.assert_eq('the budget is the kind''s number',
    (select kind_value from polls where id = v_poll), 50::numeric);
  perform tests.assert_eq('each option keeps its cost',
    (select array_agg(kind_value order by sort_order) from candidates where poll_id = v_poll),
    array[20, 30, 25]::numeric[]);

  for i in 1 .. 6 loop
    perform tests.sign_in(v_emails[i]);
    perform tests.cast_ballot(v_poll, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
  end loop;
  perform tests.sign_in('creator@example.com');

  t := get_poll_results(v_poll);
  perform tests.assert_eq('the tally says it is a budget', t ->> 'kind', 'budget');
  perform tests.assert_eq('and carries the count the modal gives',
    t -> 'kind_result', get_poll_proportional_budget(v_poll, '{}'));
  perform tests.assert_eq('pizza and sushi',
    (select array_agg(s #>> '{options,0,name}' order by (s ->> 'place')::int)
     from jsonb_array_elements(t #> '{kind_result,spots}') s), array['pizza', 'sushi']);
  perform tests.assert_eq('a budget names no one winner, so is left unsettled',
    (select winner_settled from poll_status(v_poll)), false);

  -- A reader's costs and budget go over the stored ones.
  select id into v_tacos from candidates where poll_id = v_poll and name = 'tacos';
  perform tests.assert_eq('a reader can try another budget',
    jsonb_array_length(get_poll_proportional_budget(v_poll, '{}', null, 75) -> 'spots'), 3);
  perform tests.assert_eq('or take a cost away',
    (select array_agg(x ->> 'name')
     from jsonb_array_elements(get_poll_proportional_budget(v_poll, '{}',
       jsonb_build_object(v_tacos, null)) -> 'uncosted') x), array['tacos']);

  -- The rules at creation.
  perform tests.assert_raises('a budget question needs a budget',
    format('select create_poll(''P'', null, array[''a'', ''b''], %L, p_kind => ''budget'', p_option_costs => array[1, 2])', v_emails),
    'Give the budget');
  perform tests.assert_raises('and every option a cost',
    format('select create_poll(''P'', null, array[''a'', ''b''], %L, p_kind => ''budget'', p_kind_value => 5, p_option_costs => array[1])', v_emails),
    'Give "b" a cost');
  perform tests.assert_raises('a cost is whole',
    format('select create_poll(''P'', null, array[''a'', ''b''], %L, p_kind => ''budget'', p_kind_value => 5, p_option_costs => array[1, 1.5])', v_emails),
    'The cost of "b" must be a whole number from 1 to 1,000,000,000');
  perform tests.assert_raises('no other kind stores a cost',
    format('select create_poll(''P'', null, array[''a'', ''b''], %L, p_option_costs => array[1, 2])', v_emails),
    'Only a proportional budget gives its options a cost');
  perform tests.assert_raises('nor takes a budget',
    format('select create_poll(''P'', null, array[''a'', ''b''], %L, p_kind => ''fractional'', p_kind_value => 5)', v_emails),
    'Only an option ranking, multiple winners, a proportional budget or an option assignment takes a number');
  perform tests.assert_raises('a budget is not a sequential kind',
    format('select create_poll(''P'', null, array[''a'', ''b''], %L, p_kind => ''budget'', p_kind_value => 5, p_option_costs => array[1, 2], p_carried => %L)',
      v_emails, '[{"voter": "f1@example.com", "given": 5}]'),
    'Only a question decided by STAR can be a sequential poll');

  -- A question of a group carries its costs in its options.
  v_group := create_poll_group('Party', null, jsonb_build_array(
    jsonb_build_object('title', 'Food', 'kind', 'budget', 'kind_value', 50,
      'options', jsonb_build_array(
        jsonb_build_object('name', 'pizza', 'cost', 20),
        jsonb_build_object('name', 'tacos', 'cost', 30))),
    jsonb_build_object('title', 'Music', 'options', jsonb_build_array(
      jsonb_build_object('name', 'jazz'), jsonb_build_object('name', 'rock')))),
    v_emails);
  perform tests.assert_eq('a group''s budget question keeps its costs',
    (select array_agg(kind_value order by sort_order) from candidates where poll_id = v_group),
    array[20, 30]::numeric[]);
end $$;

-- Suggestions carry a cost, and the creator can correct one.
do $$
declare
  v_emails text[] := array['f1@example.com', 'f2@example.com'];
  v_poll uuid;
  v_option uuid;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Party', null, array[]::text[], v_emails,
    p_kind => 'budget', p_kind_value => 100, p_solicit_options => true);

  perform tests.sign_in('f1@example.com');
  perform tests.assert_eq('a suggestion with a cost is added',
    suggest_options(v_poll, '[{"name": "pizza", "cost": 20}]'), 1);
  perform tests.assert_raises('one without is refused',
    format('select suggest_options(%L, %L)', v_poll, '[{"name": "tacos"}]'),
    'Give "tacos" a cost');
  perform tests.assert_raises('as is a cost that is not a number',
    format('select suggest_options(%L, %L)', v_poll, '[{"name": "tacos", "cost": "lots"}]'),
    'The cost of "tacos" is not a number');

  perform tests.sign_in('creator@example.com');
  select id into v_option from candidates where poll_id = v_poll and name = 'pizza';
  perform creator_edit_options(v_poll,
    '[{"name": "sushi", "cost": 25}]'::jsonb,
    '{}',
    jsonb_build_array(jsonb_build_object('id', v_option, 'name', 'pizza', 'cost', 22)));
  perform tests.assert_eq('the correction moved the cost',
    (select kind_value from candidates where id = v_option), 22::numeric);
  perform tests.assert_eq('and the addition kept its own',
    (select kind_value from candidates where poll_id = v_poll and name = 'sushi'), 25::numeric);
  perform tests.assert_raises('a correction cannot take a budget''s cost away',
    format('select creator_edit_options(%L, ''[]'', ''{}'', %L)', v_poll,
      jsonb_build_array(jsonb_build_object('id', v_option, 'name', 'pizza'))),
    'Give "pizza" a cost');

  perform tests.assert_eq('both reads carry it',
    (select x ->> 'cost' from jsonb_array_elements(poll_page(v_poll) -> 'options') x
     where x ->> 'name' = 'pizza'), '22');
end $$;

-- A sequential question's ballots carry weights a budget would ignore.
do $$
declare
  v_poll uuid;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Dinner', null, array['pizza', 'tacos'],
    array['f1@example.com'], p_show_ballots => true, p_carried => '[{"voter": "f1@example.com", "given": 5}]');
  perform tests.sign_in('f1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);
  perform tests.sign_in('creator@example.com');
  perform close_poll(v_poll);

  perform tests.assert_raises('a sequential question is not counted on a budget',
    format('select get_poll_proportional_budget(%L, ''{}'', ''{}'', 50)', v_poll),
    'A sequential poll''s ballots carry weights a budget would ignore');
end $$;

-- The doors are the tally's: nothing before the results are out, and the
-- count itself is nobody's to call.
do $$
declare
  v_poll uuid;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Dinner', null, array['pizza', 'tacos'], array['f1@example.com', 'f2@example.com']);
  perform tests.sign_in('f1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);

  perform tests.assert_raises('an unfinished invite poll keeps its budget',
    format('select get_poll_proportional_budget(%L, ''{}'', ''{}'', 50)', v_poll),
    'Results are not available until');

  perform tests.assert_eq('the count is nobody''s to call',
    has_function_privilege('authenticated',
      'poll_proportional_budget(uuid, uuid[], jsonb, numeric)', 'execute'), false);
  perform tests.assert_eq('nor the scaled round',
    has_function_privilege('authenticated',
      'scaled_star_round(uuid, uuid[], uuid[], numeric[], numeric[])', 'execute'), false);
  perform tests.assert_eq('the link''s door is open to anybody',
    has_function_privilege('anon',
      'open_poll_proportional_budget(uuid, uuid[], jsonb, numeric)', 'execute'), true);
end $$;

rollback;

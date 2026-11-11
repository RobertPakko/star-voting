-- Option assignment: every voter given at most one option, every option to
-- at most its places, choosing the assignment that places the most voters on
-- an option they gave a star, then maximises the product of those stars
-- (maximum Nash welfare), then the total.
--
-- The ballots are /choices' six friends (48_multiple_winners'), with tables
-- for three at the pizza place, two at the taco truck and one at the sushi
-- bar:
--
--            pizza tacos sushi
--   friend 1   5     4     0
--   friend 2   5     4     1
--   friend 3   5     2     0
--   friend 4   0     3     3
--   friend 5   0     3     5
--   friend 6   1     1     5
--
-- Six places for six friends. Friends 1-3 take the pizza place (5 x 5 x 5).
-- Friends 5 and 6 both want the one sushi seat: friend 5 at sushi leaves
-- friend 6 at tacos on 1 star (5 x 1), friend 6 at sushi leaves friend 5 at
-- tacos on 3 (5 x 3), so friend 6 has it. Friend 4 takes the other taco
-- seat: 5 x 5 x 5 x 3 x 3 x 5 = 5625, which nothing else reaches.

begin;

do $$
declare
  v_poll uuid;
  v_pizza uuid;
  v_tacos uuid;
  v_sushi uuid;
  v_places jsonb;
  a jsonb;
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
  v_places := jsonb_build_object(v_pizza, 3, v_tacos, 2, v_sushi, 1);

  -- An ordinary question, given places by the reader: nothing is stored.
  a := get_poll_assignment(v_poll, '{}', v_places);

  perform tests.assert_eq('friends 1-3 at the pizza place',
    (select array_agg(v ->> 'name') from jsonb_array_elements(a #> '{options,0,voters}') v),
    array['voter1@example.com', 'voter2@example.com', 'voter3@example.com']);
  perform tests.assert_eq('the fullest option first', a #>> '{options,0,name}', 'pizza');
  perform tests.assert_eq('friends 4 and 5 at the taco truck',
    (select array_agg(v ->> 'name') from jsonb_array_elements(a #> '{options,1,voters}') v),
    array['voter4@example.com', 'voter5@example.com']);
  perform tests.assert_eq('friend 6 gets the sushi seat, which friend 5 gives up for friend 6''s sake',
    (select array_agg(v ->> 'name') from jsonb_array_elements(a #> '{options,2,voters}') v),
    array['voter6@example.com']);
  perform tests.assert_eq('each option says how many places it had',
    (select array_agg((o ->> 'places')::int) from jsonb_array_elements(a -> 'options') o),
    array[3, 2, 1]);
  perform tests.assert_eq('nobody is left out', jsonb_array_length(a -> 'unplaced'), 0);
  perform tests.assert_eq('four got a five, two a three', a -> 'received', '{"5": 4, "3": 2}'::jsonb);
  perform tests.assert_eq('six places', (a ->> 'places')::int, 6);
  perform tests.assert_eq('six voters', (a ->> 'voter_count')::int, 6);
  perform tests.assert_eq('a private ballot''s stars are not shown',
    (select bool_or(v ? 'stars') from jsonb_array_elements(a -> 'options') o,
       jsonb_array_elements(o -> 'voters') v), false);
  perform tests.assert_eq('and it says so', (a ->> 'stars_shown')::boolean, false);

  perform tests.assert_null('nothing was stored',
    (select max(kind_value) from candidates where poll_id = v_poll));

  -- With one place each, three are placed, each on an option they gave 4 or 5.
  a := get_poll_assignment(v_poll, '{}');
  perform tests.assert_eq('one place each places three', jsonb_array_length(a -> 'unplaced'), 3);
  perform tests.assert_eq('on the best product there is, 5 x 5 x 4',
    a -> 'received', '{"5": 2, "4": 1}'::jsonb);
  perform tests.assert_eq('and the draw between equal products is the same every time',
    a, get_poll_assignment(v_poll, '{}'));

  -- Left out, an option's voters go elsewhere.
  a := get_poll_assignment(v_poll, array[v_sushi], v_places);
  perform tests.assert_eq('without sushi, two options are counted', jsonb_array_length(a -> 'options'), 2);
  perform tests.assert_eq('and five places hold five of the six',
    jsonb_array_length(a -> 'unplaced'), 1);

  -- A key holding null puts an option back to one place.
  a := get_poll_assignment(v_poll, '{}', jsonb_build_object(v_pizza, null, v_tacos, 2, v_sushi, 3));
  perform tests.assert_eq('pizza back to one place',
    (select (o ->> 'places')::int from jsonb_array_elements(a -> 'options') o where o ->> 'name' = 'pizza'), 1);

  perform tests.assert_raises('places are a whole number',
    format('select get_poll_assignment(%L, ''{}'', %L)', v_poll, jsonb_build_object(v_pizza, 1.5)),
    'A number of places must be a whole number from 1 to 1,000,000,000');
  perform tests.assert_raises('and at least 1',
    format('select get_poll_assignment(%L, ''{}'', %L)', v_poll, jsonb_build_object(v_pizza, 0)),
    'A number of places must be a whole number from 1 to 1,000,000,000');
  perform tests.assert_raises('and a number',
    format('select get_poll_assignment(%L, ''{}'', %L)', v_poll, jsonb_build_object(v_pizza, 'two')),
    'A number of places is not a number');
end $$;

-- Placing a voter outweighs any product, and nobody is placed on an option
-- they gave 0.
do $$
declare
  v_poll uuid;
  a jsonb;
begin
  -- Both want A. Friend 1 at A leaves friend 2 nowhere (friend 2 gave B 0);
  -- friend 2 at A and friend 1 at B places both, on a product of 5 x 1.
  v_poll := tests.seed_poll(
    array['A', 'B', 'C'],
    array[[5, 1, 0],
          [5, 0, 0],
          [0, 0, 0]]);
  perform close_poll(v_poll);

  a := get_poll_assignment(v_poll, '{}');
  perform tests.assert_eq('friend 2 at A',
    (select v ->> 'name' from jsonb_array_elements(a -> 'options') o,
       jsonb_array_elements(o -> 'voters') v where o ->> 'name' = 'A'), 'voter2@example.com');
  perform tests.assert_eq('friend 1 at B, on 1 star',
    (select v ->> 'name' from jsonb_array_elements(a -> 'options') o,
       jsonb_array_elements(o -> 'voters') v where o ->> 'name' = 'B'), 'voter1@example.com');
  perform tests.assert_eq('a voter who gave everything 0 is left out, with C still free',
    (select array_agg(v ->> 'name') from jsonb_array_elements(a -> 'unplaced') v),
    array['voter3@example.com']);
end $$;

-- An assignment question: places stored with it, and the tally carrying it.
do $$
declare
  v_emails text[] := array['f1@example.com', 'f2@example.com', 'f3@example.com',
                           'f4@example.com', 'f5@example.com', 'f6@example.com'];
  v_ballots int[][] := array[[5, 4, 0], [5, 4, 1], [5, 2, 0], [0, 3, 3], [0, 3, 5], [1, 1, 5]];
  v_poll uuid;
  v_group uuid;
  t jsonb;
  i int;
begin
  perform tests.sign_in('creator@example.com');

  v_poll := create_poll('Dinner', null, array['pizza', 'tacos', 'sushi'], v_emails,
    p_show_ballots => true, p_kind => 'assignment', p_option_costs => array[3, 2, null]);

  perform tests.assert_eq('each option keeps its places, none meaning one',
    (select array_agg(kind_value order by sort_order) from candidates where poll_id = v_poll),
    array[3, 2, null]::numeric[]);
  perform tests.assert_eq('the page reads them as places',
    (select array_agg(x -> 'places' order by (x ->> 'sort_order')::int)
     from jsonb_array_elements(poll_page(v_poll) -> 'options') x),
    array['3', '2', 'null']::jsonb[]);
  perform tests.assert_eq('and no cost',
    (select bool_and(x -> 'cost' = 'null') from jsonb_array_elements(poll_page(v_poll) -> 'options') x),
    true);

  for i in 1 .. 6 loop
    perform tests.sign_in(v_emails[i]);
    perform tests.cast_ballot(v_poll, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
  end loop;
  perform tests.sign_in('creator@example.com');

  t := get_poll_results(v_poll);
  perform tests.assert_eq('the tally says it is an assignment', t ->> 'kind', 'assignment');
  perform tests.assert_eq('and that it shows who voted', (t ->> 'voters_shown')::boolean, true);
  perform tests.assert_eq('and carries the assignment the modal gives',
    t -> 'kind_result', get_poll_assignment(v_poll, '{}'));
  perform tests.assert_eq('a published ballot''s stars are shown',
    t #> '{kind_result,options,0,voters,0}', '{"name": "f1@example.com", "stars": 5}'::jsonb);
  perform tests.assert_eq('an assignment names no one winner, so is left unsettled',
    (select winner_settled from poll_status(v_poll)), false);

  -- The rules at creation.
  perform tests.assert_raises('an assignment shows who voted',
    format('select create_poll(''P'', null, array[''a'', ''b''], %L, p_show_voters => false, p_kind => ''assignment'')', v_emails),
    'An option assignment says who gets which option, so it must show who voted');
  perform tests.assert_raises('places are whole',
    format('select create_poll(''P'', null, array[''a'', ''b''], %L, p_kind => ''assignment'', p_option_costs => array[1, 1.5])', v_emails),
    'The places for "b" must be a whole number from 1 to 1,000,000,000');
  perform tests.assert_raises('an assignment takes no number of its own',
    format('select create_poll(''P'', null, array[''a'', ''b''], %L, p_kind => ''assignment'', p_kind_value => 3)', v_emails),
    'Only an option ranking, multiple winners or a proportional budget takes a number');
  perform tests.assert_raises('and is not a sequential kind',
    format('select create_poll(''P'', null, array[''a'', ''b''], %L, p_show_ballots => true, p_kind => ''assignment'', p_carried => %L)',
      v_emails, '[{"voter": "f1@example.com", "given": 5}]'),
    'Only a question decided by STAR can be a sequential poll');

  -- A question of a group carries its places in its options.
  v_group := create_poll_group('Dinner', null, jsonb_build_array(
    jsonb_build_object('title', 'Where', 'kind', 'assignment',
      'options', jsonb_build_array(
        jsonb_build_object('name', 'pizza', 'places', 4),
        jsonb_build_object('name', 'tacos'))),
    jsonb_build_object('title', 'Music', 'options', jsonb_build_array(
      jsonb_build_object('name', 'jazz'), jsonb_build_object('name', 'rock')))),
    v_emails);
  perform tests.assert_eq('a group''s assignment question keeps its places',
    (select array_agg(kind_value order by sort_order) from candidates where poll_id = v_group),
    array[4, null]::numeric[]);
  perform tests.assert_raises('and is refused where the group hides its voters',
    format('select create_poll_group(''P'', null, %L, %L, ''invite'', false)',
      jsonb_build_array(
        jsonb_build_object('title', 'Where', 'kind', 'assignment', 'options', jsonb_build_array(
          jsonb_build_object('name', 'a'), jsonb_build_object('name', 'b'))),
        jsonb_build_object('title', 'Music', 'options', jsonb_build_array(
          jsonb_build_object('name', 'jazz'), jsonb_build_object('name', 'rock')))),
      v_emails),
    'An option assignment says who gets which option, so it must show who voted');
end $$;

-- Suggestions carry places, and the creator can correct them.
do $$
declare
  v_emails text[] := array['f1@example.com', 'f2@example.com'];
  v_poll uuid;
  v_option uuid;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Chores', null, array[]::text[], v_emails,
    p_kind => 'assignment', p_solicit_options => true);

  perform tests.sign_in('f1@example.com');
  perform tests.assert_eq('a suggestion with places is added',
    suggest_options(v_poll, '[{"name": "dishes", "places": 2}]'), 1);
  perform tests.assert_eq('and one without',
    suggest_options(v_poll, '[{"name": "laundry"}]'), 1);
  perform tests.assert_raises('places that are not a number are refused',
    format('select suggest_options(%L, %L)', v_poll, '[{"name": "bins", "places": "lots"}]'),
    'The places for "bins" are not a number');

  perform tests.sign_in('creator@example.com');
  select id into v_option from candidates where poll_id = v_poll and name = 'dishes';
  perform creator_edit_options(v_poll, '[]', '{}',
    jsonb_build_array(jsonb_build_object('id', v_option, 'name', 'dishes', 'places', 3)));
  perform tests.assert_eq('the correction moved the places',
    (select kind_value from candidates where id = v_option), 3::numeric);
  perform creator_edit_options(v_poll, '[]', '{}',
    jsonb_build_array(jsonb_build_object('id', v_option, 'name', 'dishes')));
  perform tests.assert_null('and can take them away',
    (select kind_value from candidates where id = v_option));

  perform tests.assert_raises('a cost is still no business of an assignment''s',
    format('select create_poll(''P'', null, array[''a'', ''b''], %L, p_option_costs => array[1, 2])', v_emails),
    'Only a proportional budget gives its options a cost');
end $$;

-- An assignment says who gets what, so it is only for a poll that shows who
-- voted; and a sequential question's weights would be ignored.
do $$
declare
  v_poll uuid;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Dinner', null, array['pizza', 'tacos'],
    array['f1@example.com'], p_show_voters => false);
  perform tests.sign_in('f1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);

  perform tests.assert_raises('a poll hiding its voters assigns nothing',
    format('select get_poll_assignment(%L, ''{}'')', v_poll),
    'This poll does not show who voted, so it cannot say who gets which option');
  perform tests.assert_eq('and its tally says so',
    (get_poll_results(v_poll) ->> 'voters_shown')::boolean, false);

  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Dinner', null, array['pizza', 'tacos'],
    array['f1@example.com'], p_show_ballots => true, p_carried => '[{"voter": "f1@example.com", "given": 5}]');
  perform tests.sign_in('f1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);
  perform tests.assert_raises('a sequential question is not assigned',
    format('select get_poll_assignment(%L, ''{}'')', v_poll),
    'A sequential poll''s ballots carry weights an assignment would ignore');
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

  perform tests.assert_raises('an unfinished invite poll keeps its assignment',
    format('select get_poll_assignment(%L, ''{}'')', v_poll),
    'Results are not available until');

  perform tests.assert_eq('the count is nobody''s to call',
    has_function_privilege('authenticated', 'poll_assignment(uuid, uuid[], jsonb)', 'execute'), false);
  perform tests.assert_eq('nor which field holds an option''s number',
    has_function_privilege('authenticated', 'option_number(text, jsonb)', 'execute'), false);
  perform tests.assert_eq('the link''s door is open to anybody',
    has_function_privilege('anon', 'open_poll_assignment(uuid, uuid[], jsonb)', 'execute'), true);
end $$;

rollback;

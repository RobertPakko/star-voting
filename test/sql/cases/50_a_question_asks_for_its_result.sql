-- A question's kind says which result it asks for, with a number whose
-- meaning belongs to the kind (`kind_value`), and the tally carries that
-- result so a reader opens on it in one read.
--
-- The ballots are 48_multiple_winners' six friends:
--
--            pizza tacos sushi
--   friend 1   5     4     0
--   friend 2   5     4     1
--   friend 3   5     2     0
--   friend 4   0     3     3
--   friend 5   0     3     5
--   friend 6   0     0     5
--
-- Multiple winners: pizza, sushi, tacos. The option ranking: pizza, tacos,
-- sushi. So the tally of a question of either kind must carry that one.

begin;

do $$
declare
  v_emails text[] := array['f1@example.com', 'f2@example.com', 'f3@example.com',
                           'f4@example.com', 'f5@example.com', 'f6@example.com'];
  v_ballots int[][] := array[[5, 4, 0], [5, 4, 1], [5, 2, 0], [0, 3, 3], [0, 3, 5], [0, 0, 5]];
  v_option uuid;
  v_multiple uuid;
  v_ranking uuid;
  v_fractional uuid;
  v_group uuid[];
  v_poll uuid;
  t jsonb;
  i int;
begin
  perform tests.sign_in('creator@example.com');

  v_option := create_poll('Dinner', null, array['pizza', 'tacos', 'sushi'], v_emails);
  v_multiple := create_poll('Dinner', null, array['pizza', 'tacos', 'sushi'], v_emails,
    p_kind => 'multiple', p_kind_value => 2);
  v_ranking := create_poll('Dinner', null, array['pizza', 'tacos', 'sushi'], v_emails,
    p_kind => 'ranking');
  v_fractional := create_poll('Dinner', null, array['pizza', 'tacos', 'sushi'], v_emails,
    p_kind => 'fractional');

  perform tests.assert_eq('a question asks for the best option unless it says otherwise',
    (select kind from polls where id = v_option), 'option');
  perform tests.assert_eq('the number is stored with the kind',
    (select kind_value from polls where id = v_multiple), 2::numeric);
  perform tests.assert_null('and may be left out',
    (select kind_value from polls where id = v_ranking));
  perform tests.assert_null('a kind other than time has no schedule',
    (select schedule from polls where id = v_multiple));

  foreach v_poll in array array[v_option, v_multiple, v_ranking, v_fractional] loop
    for i in 1 .. 6 loop
      perform tests.sign_in(v_emails[i]);
      perform tests.cast_ballot(v_poll, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
    end loop;
  end loop;
  perform tests.sign_in('creator@example.com');

  t := get_poll_results(v_option);
  perform tests.assert_eq('the best option''s tally says so', t ->> 'kind', 'option');
  perform tests.assert_eq('and carries no other result', jsonb_typeof(t -> 'kind_result'), 'null');

  t := get_poll_results(v_multiple);
  perform tests.assert_eq('multiple winners: the tally names the kind', t ->> 'kind', 'multiple');
  perform tests.assert_eq('and its number', (t ->> 'kind_value')::numeric, 2::numeric);
  perform tests.assert_eq('and carries the count, every spot of it',
    t -> 'kind_result', get_poll_multiple_winners(v_multiple, '{}'));
  perform tests.assert_eq('sushi second, as multiple winners has it',
    tests.placed_at(t -> 'kind_result', 2), array['sushi']);
  perform tests.assert_eq('beside the STAR winner, which is unchanged',
    tests.winner(t), 'pizza');

  t := get_poll_results(v_ranking);
  perform tests.assert_eq('the option ranking is carried',
    t -> 'kind_result', get_poll_ranking(v_ranking));
  perform tests.assert_eq('tacos second, as the ranking has it',
    tests.placed_at(t -> 'kind_result', 2), array['tacos']);

  t := get_poll_results(v_fractional);
  perform tests.assert_eq('the shares are carried',
    t -> 'kind_result', get_poll_fractional_winners(v_fractional, '{}'));

  -- The page's own read carries the same tally.
  perform tests.assert_eq('poll_page opens on the asked-for result',
    poll_page(v_multiple) #> '{results,kind_result}', get_poll_multiple_winners(v_multiple, '{}'));

  -- Refusals, each in words.
  perform tests.assert_raises('an unknown kind is refused',
    $q$select create_poll('x', null, array['a', 'b'], null, 'open', p_kind => 'lottery')$q$,
    'Unknown poll kind');
  perform tests.assert_raises('the best option takes no number',
    $q$select create_poll('x', null, array['a', 'b'], null, 'open', p_kind_value => 3)$q$,
    'Only an option ranking or multiple winners takes a number');
  perform tests.assert_raises('nor do fractional winners',
    $q$select create_poll('x', null, array['a', 'b'], null, 'open',
                          p_kind => 'fractional', p_kind_value => 3)$q$,
    'Only an option ranking or multiple winners takes a number');
  perform tests.assert_raises('the number stops where the results do',
    $q$select create_poll('x', null, array['a', 'b'], null, 'open',
                          p_kind => 'multiple', p_kind_value => 11)$q$,
    'Choose a number from 2 to 10');
  perform tests.assert_raises('and is whole',
    $q$select create_poll('x', null, array['a', 'b'], null, 'open',
                          p_kind => 'ranking', p_kind_value => 2.5)$q$,
    'Choose a number from 2 to 10');
  perform tests.assert_raises('and is at least two',
    $q$select create_poll('x', null, array['a', 'b'], null, 'open',
                          p_kind => 'ranking', p_kind_value => 1)$q$,
    'Choose a number from 2 to 10');
  perform tests.assert_raises('only a time poll has a schedule',
    $q$select create_poll('x', null, array['a', 'b'], null, 'open', p_kind => 'ranking',
                          p_schedule => '{"timezone": "+00:00"}')$q$,
    'Only a time poll has a schedule');

  -- A group sets each question's kind on its own, and names the question it
  -- refuses.
  v_poll := create_poll_group('Night in', null, jsonb_build_array(
    jsonb_build_object('title', 'Film', 'options', jsonb_build_array(
      jsonb_build_object('name', 'a'), jsonb_build_object('name', 'b'))),
    jsonb_build_object('title', 'Snacks', 'kind', 'multiple', 'kind_value', 3,
      'options', jsonb_build_array(
        jsonb_build_object('name', 'c'), jsonb_build_object('name', 'd')))),
    null, 'open');
  v_group := tests.group_questions(v_poll);
  perform tests.assert_eq('a group question with no kind asks for the best option',
    (select kind from polls where id = v_group[1]), 'option');
  perform tests.assert_eq('one with a kind keeps it, and its number',
    (select kind || ':' || kind_value from polls where id = v_group[2]), 'multiple:3');
  perform tests.assert_raises('a group names the question it refuses',
    $q$select create_poll_group('x', null, '[
      {"title": "One", "options": [{"name": "a"}, {"name": "b"}]},
      {"title": "Two", "kind": "fractional", "kind_value": 4,
       "options": [{"name": "a"}, {"name": "b"}]}]'::jsonb, null, 'open')$q$,
    'on question 2');

  -- An option's number is a column, and nothing yet writes it.
  perform tests.assert_eq('an option carries a number of its own, unset',
    (select bool_and(kind_value is null) from candidates where poll_id = v_option), true);

  -- The grants of the remade functions.
  perform tests.assert_eq('create_poll is still the account''s to call',
    has_function_privilege('authenticated',
      'public.create_poll(text, text, text[], text[], text, boolean, boolean, text[], boolean, text, jsonb, numeric)',
      'execute'), true);
  perform tests.assert_eq('and not the link''s',
    has_function_privilege('anon',
      'public.create_poll(text, text, text[], text[], text, boolean, boolean, text[], boolean, text, jsonb, numeric)',
      'execute'), false);
  perform tests.assert_eq('insert_poll_row is nobody''s',
    has_function_privilege('authenticated',
      'public.insert_poll_row(text, text, text, jsonb, text[], text, boolean, boolean, boolean, uuid, integer, text, jsonb, numeric)',
      'execute'), false);
end $$;

rollback;

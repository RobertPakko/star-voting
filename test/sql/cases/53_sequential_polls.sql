-- Sequential polls: a question that carries its earlier voters, each with the
-- stars N they gave earlier winners, and counts each ballot at
-- 5 / (5 + N).
--
-- The ballots are /choices' six friends again, voting the same way in week 2
-- after pizza won week 1:
--
--            pizza tacos sushi   N (stars given to pizza)
--   friend 1   5     4     0     5   -> counts at 1/2
--   friend 2   5     4     1     5   -> 1/2
--   friend 3   5     2     0     5   -> 1/2
--   friend 4   0     3     3     0   -> 1
--   friend 5   0     3     5     0   -> 1
--   friend 6   1     1     5     1   -> 5/6
--
-- The strongest ballot is already at one, so the weights are as written.
-- Totals: pizza 7.5 + 5/6 = 8.333333, tacos 2 + 2 + 1 + 3 + 3 + 5/6 =
-- 11.833333, sushi 0.5 + 3 + 5 + 25/6 = 12.666667. Sushi and tacos go to the
-- runoff: tacos 1.5 (friends 1-3), sushi 1 + 5/6 = 1.833333 (friends 5 and
-- 6), friend 4 level. Sushi wins week 2, where an unweighted count elects
-- pizza. The ranking's second place is tacos over pizza, 2 to 1.5.
--
-- A newcomer gets the average weight, (3 * 1/2 + 2 + 5/6) / 6 = 13/18, so
-- their N is 5 / (13/18) - 5 = 25/13 = 1.923077.

begin;

-- The helpers' readers cast to int; weighted counts are not.
create function tests.weighted_total(p_tally jsonb, p_name text)
returns numeric language sql stable as $f$
  select (o->>'total_score')::numeric
  from jsonb_array_elements(p_tally->'options') o where o->>'name' = p_name
$f$;

create function tests.weighted_prefers(p_tally jsonb, p_name text)
returns numeric language sql stable as $f$
  select case
    when tests.option_name(p_tally, p_tally #>> '{finalists,0}') = p_name
      then (p_tally #>> '{runoff,prefers_a}')::numeric
    else (p_tally #>> '{runoff,prefers_b}')::numeric
  end
$f$;

do $$
declare
  v_emails text[] := array['voter1@example.com', 'voter2@example.com', 'voter3@example.com',
                           'voter4@example.com', 'voter5@example.com', 'voter6@example.com'];
  v_carried jsonb := '[{"voter": "Voter1@example.com", "given": 5},
                       {"voter": "voter2@example.com", "given": 5},
                       {"voter": "voter3@example.com", "given": 5},
                       {"voter": "voter4@example.com", "given": 0},
                       {"voter": "voter5@example.com", "given": 0},
                       {"voter": "voter6@example.com", "given": 1}]';
  v_ballots int[][] := array[[5, 4, 0], [5, 4, 1], [5, 2, 0], [0, 3, 3], [0, 3, 5], [1, 1, 5]];
  v_poll uuid;
  v_plain uuid;
  v_late uuid;
  t jsonb;
  i int;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Week 2', null, array['pizza', 'tacos', 'sushi'], v_emails,
    'invite', true, true, null, false, 'option', null, null, v_carried);

  perform tests.assert_eq('the earlier voters are kept, addresses lowercased',
    (select array_agg(voter order by voter) from carried_weights where poll_id = v_poll),
    v_emails);

  for i in 1 .. 6 loop
    perform tests.sign_in(v_emails[i]);
    perform tests.cast_ballot(v_poll, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
  end loop;

  perform tests.assert_eq('each ballot is cast at its voter''s N',
    (select array_agg(b.given order by u.email) from ballots b join auth.users u on u.id = b.voter_id
     where b.poll_id = v_poll),
    array[5, 5, 5, 0, 0, 1]::numeric[]);
  perform tests.assert_eq('and every row is claimed',
    (select bool_and(claimed) from carried_weights where poll_id = v_poll), true);

  perform tests.sign_in('creator@example.com');
  t := get_poll_results(v_poll);

  perform tests.assert_eq('the tally says it is weighted', (t ->> 'weighted')::boolean, true);
  perform tests.assert_eq('sushi wins week 2', tests.winner(t), 'sushi');
  perform tests.assert_eq('on 12.666667 weighted stars',
    tests.weighted_total(t, 'sushi'), 12.666667);
  perform tests.assert_eq('tacos on 11.833333', tests.weighted_total(t, 'tacos'), 11.833333);
  perform tests.assert_eq('pizza on 8.333333', tests.weighted_total(t, 'pizza'), 8.333333);
  perform tests.assert_eq('sushi preferred at 1.833333', tests.weighted_prefers(t, 'sushi'), 1.833333);
  perform tests.assert_eq('tacos at 1.5', tests.weighted_prefers(t, 'tacos'), 1.5);
  perform tests.assert_eq('the average is over the total weight, 4.333333',
    (select (o ->> 'average_score')::numeric from jsonb_array_elements(t -> 'options') o
     where o ->> 'name' = 'sushi'),
    round(12.666667 / 4.333333, 2));
  perform tests.assert_eq('the winner kept with the poll is the weighted one',
    (select winner_name from polls where id = v_poll), 'sushi');

  perform tests.assert_eq('the ranking is weighted too: sushi, tacos, pizza',
    array[tests.placed_at(get_poll_ranking(v_poll), 1), tests.placed_at(get_poll_ranking(v_poll), 2),
          tests.placed_at(get_poll_ranking(v_poll), 3)],
    array[array['sushi'], array['tacos'], array['pizza']]);
  perform tests.assert_eq('multiple winners starts from the carried stars',
    tests.placed_at(get_poll_multiple_winners(v_poll, '{}'), 1), array['sushi']);
  perform tests.assert_eq('all scores are weighted',
    (select (o ->> 'total_score')::numeric from jsonb_array_elements(get_poll_scores(v_poll)) o
     where o ->> 'name' = 'pizza'),
    8.333333);

  perform tests.assert_eq('the published sheet carries each ballot''s N',
    (select array_agg((b ->> 'given')::numeric order by b ->> 'voter')
     from jsonb_array_elements(poll_ballots(v_poll) -> 'ballots') b),
    array[5, 5, 5, 0, 0, 1]::numeric[]);

  -- The same ballots with nothing carried: plain STAR, which elects pizza.
  v_plain := tests.seed_poll(array['pizza', 'tacos', 'sushi'], v_ballots);
  perform close_poll(v_plain);
  t := get_poll_results(v_plain);
  perform tests.assert_eq('a poll that carries nobody is not weighted', (t ->> 'weighted')::boolean, false);
  perform tests.assert_eq('and elects pizza', tests.winner(t), 'pizza');
  perform tests.assert_eq('its sheet carries no N',
    (select count(*)::int from jsonb_array_elements(ballot_sheet(v_plain, true) -> 'ballots') b
     where b ? 'given'), 0);

  -- A newcomer joins week 3: invited, but not carried.
  perform tests.sign_in('creator@example.com');
  v_late := create_poll('Week 3', null, array['pizza', 'tacos', 'sushi'],
    v_emails || 'voter7@example.com'::text, 'invite', true, true, null, false, 'option', null, null, v_carried);
  perform tests.sign_in('voter7@example.com');
  perform tests.cast_ballot(v_late, array[0, 5, 3]);
  perform tests.assert_eq('a newcomer starts at the average weight, N = 25/13',
    (select given from ballots where poll_id = v_late), 1.923077);
  perform tests.assert_eq('and claims nobody',
    (select count(*)::int from carried_weights where poll_id = v_late and claimed), 0);

  -- Who has yet to vote, for carrying into the next poll.
  perform tests.sign_in('creator@example.com');
  perform tests.assert_eq('the creator reads the voters who skipped',
    jsonb_array_length(get_poll_carried_weights(v_late)), 6);
  perform tests.sign_in('voter1@example.com');
  perform tests.assert_raises('nobody else does',
    format('select get_poll_carried_weights(%L)', v_late), 'Poll not found');
end $$;

-- Which questions may be sequential, and with what list.
do $$
declare
  v_one jsonb := '[{"voter": "voter1@example.com", "given": 5}]';
begin
  perform tests.sign_in('creator@example.com');

  perform tests.assert_raises('a consensus cannot be sequential',
    format('select create_poll(%L, null, array[%L, %L], array[%L], %L, true, true, null, false, %L, null, null, %L)',
      'P', 'a', 'b', 'voter1@example.com', 'invite', 'consensus', v_one),
    'Only a question decided by STAR');
  perform tests.assert_raises('nor fractional winners',
    format('select create_poll(%L, null, array[%L, %L], array[%L], %L, true, true, null, false, %L, null, null, %L)',
      'P', 'a', 'b', 'voter1@example.com', 'invite', 'fractional', v_one),
    'Only a question decided by STAR');
  perform tests.assert_raises('names shown but ballots private is refused',
    format('select create_poll(%L, null, array[%L, %L], array[%L], %L, true, false, null, false, %L, null, null, %L)',
      'P', 'a', 'b', 'voter1@example.com', 'invite', 'option', v_one),
    'shows both who voted and the ballots, or neither');
  perform tests.assert_raises('and so is anonymous ballots',
    format('select create_poll(%L, null, array[%L, %L], array[%L], %L, false, true, null, false, %L, null, null, %L)',
      'P', 'a', 'b', 'voter1@example.com', 'invite', 'option', v_one),
    'shows both who voted and the ballots, or neither');
  perform tests.assert_raises('an invite poll carries only its invitees',
    format('select create_poll(%L, null, array[%L, %L], array[%L], %L, true, true, null, false, %L, null, null, %L)',
      'P', 'a', 'b', 'voter2@example.com', 'invite', 'option', v_one),
    'is not on the invite list');
  perform tests.assert_raises('nobody is listed twice',
    format('select create_poll(%L, null, array[%L, %L], null, %L, true, true, null, false, %L, null, null, %L)',
      'P', 'a', 'b', 'open', 'option', '[{"voter": "Ana", "given": 1}, {"voter": "ana", "given": 2}]'),
    'is listed twice');
  perform tests.assert_raises('N is not negative',
    format('select create_poll(%L, null, array[%L, %L], null, %L, true, true, null, false, %L, null, null, %L)',
      'P', 'a', 'b', 'open', 'option', '[{"voter": "Ana", "given": -1}]'),
    'from 0 to 10000');
  perform tests.assert_raises('and is a number',
    format('select create_poll(%L, null, array[%L, %L], null, %L, true, true, null, false, %L, null, null, %L)',
      'P', 'a', 'b', 'open', 'option', '[{"voter": "Ana", "given": "lots"}]'),
    'must be a number');

  perform tests.assert_eq('no client reads the table',
    has_table_privilege('anon', 'public.carried_weights', 'select')
      or has_table_privilege('authenticated', 'public.carried_weights', 'select'),
    false);
  perform tests.assert_eq('nor calls the claim',
    has_function_privilege('authenticated', 'public.claim_carried_weight(uuid, text)', 'execute'),
    false);
end $$;

-- An open poll matches by name. Naming its voters, it offers the names still
-- to vote; hiding them, it matches the name it is given and keeps none.
do $$
declare
  v_named uuid;
  v_hidden uuid;
  v_group uuid[];
  v_first uuid;
  v jsonb;
begin
  perform tests.sign_in('creator@example.com');
  v_named := create_poll('Named', null, array['a', 'b'], null, 'open', true, true, null, false,
    'option', null, null, '[{"voter": "Ana", "given": 5}, {"voter": "Ben", "given": 0}]');

  perform tests.sign_out();
  v := open_poll_view(v_named, 'k0');
  perform tests.assert_eq('the share link says it is sequential', (v ->> 'sequential')::boolean, true);
  perform tests.assert_eq('and offers the earlier voters',
    (select array_agg(x) from jsonb_array_elements_text(v -> 'carried_names') x), array['Ana', 'Ben']);

  perform open_poll_submit(v_named, tests.open_scores(v_named, array[5, 0]), 'k1', 'ana');
  perform tests.assert_eq('a name matching an earlier voter takes their N, in any case',
    (select given from ballots where poll_id = v_named and voter_key = 'k1'), 5::numeric);
  perform tests.assert_eq('and leaves the list',
    (select array_agg(x) from jsonb_array_elements_text(open_poll_view(v_named, 'k0') -> 'carried_names') x),
    array['Ben']);

  perform open_poll_submit(v_named, tests.open_scores(v_named, array[0, 5]), 'k2', 'Cy');
  perform tests.assert_eq('a new name is a newcomer: average weight 3/4, so N = 5/3',
    (select given from ballots where poll_id = v_named and voter_key = 'k2'), 1.666667);

  perform tests.assert_raises('a claimed name cannot vote again',
    format('select open_poll_submit(%L, %L::jsonb, %L, %L)', v_named,
      tests.open_scores(v_named, array[1, 1]), 'k3', 'Ana'),
    'has already voted');

  perform tests.sign_in('creator@example.com');
  v_hidden := create_poll('Hidden', null, array['a', 'b'], null, 'open', false, false, null, false,
    'option', null, null, '[{"voter": "Ana", "given": 5}, {"voter": "Ben", "given": 0}]');

  perform tests.sign_out();
  v := open_poll_view(v_hidden, 'k0');
  perform tests.assert_eq('a poll hiding its voters is still sequential', (v ->> 'sequential')::boolean, true);
  perform tests.assert_eq('but offers no names', jsonb_typeof(v -> 'carried_names'), 'null');

  perform open_poll_submit(v_hidden, tests.open_scores(v_hidden, array[5, 0]), 'k1', 'Ana');
  perform tests.assert_eq('the name it was given finds the weight',
    (select given from ballots where poll_id = v_hidden and voter_key = 'k1'), 5::numeric);
  perform tests.assert_null('and is not kept',
    (select voter_name from ballots where poll_id = v_hidden and voter_key = 'k1'));

  perform open_poll_submit(v_hidden, tests.open_scores(v_hidden, array[5, 0]), 'k2', 'Ana');
  perform tests.assert_eq('the same name again is a newcomer',
    (select given from ballots where poll_id = v_hidden and voter_key = 'k2'), 1.666667);

  perform tests.sign_in('creator@example.com');
  perform tests.assert_raises('who skipped a poll hiding its voters is not told',
    format('select get_poll_carried_weights(%L)', v_hidden), 'does not show who voted');

  -- Each question of a group is its own sequence.
  v_first := create_poll_group('Group', null,
    '[{"title": "Film", "options": [{"name": "a"}, {"name": "b"}],
       "carried": [{"voter": "Ana", "given": 3}]},
      {"title": "Snack", "options": [{"name": "c"}, {"name": "d"}]}]',
    null, 'open', true, true);
  v_group := tests.group_questions(v_first);
  perform tests.assert_eq('a question of a group carries its own voters',
    (select count(*)::int from carried_weights where poll_id = v_group[1]), 1);
  perform tests.assert_eq('and its sibling carries none',
    (select count(*)::int from carried_weights where poll_id = v_group[2]), 0);
  perform tests.assert_raises('a group names the question it refuses',
    format('select create_poll_group(%L, null, %L, null, %L, true, true)', 'G',
      '[{"title": "A", "options": [{"name": "a"}, {"name": "b"}]},
        {"title": "B", "kind": "consensus", "options": [{"name": "c"}, {"name": "d"}],
         "carried": [{"voter": "Ana", "given": 3}]}]', 'open'),
    'on question 2');
end $$;

rollback;

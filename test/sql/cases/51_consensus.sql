-- The consensus option: every option judged by the fewest stars any ballot
-- gave it (its floor), the highest floor winning. Options sharing it are
-- compared on their next-lowest score, then the next, and so on; options
-- level on every score leave no winner. Every ballot counts.
--
-- Every expected value below is worked out by hand from those rules.

begin;

-- One option has the highest floor, and it is not STAR's winner.
--
--            A  B  C
--   voter 1  5  2  0
--   voter 2  5  3  1
--   voter 3  0  3  5
--
-- Scores lowest first: A 0 5 5, B 2 3 3, C 0 1 5. B has the highest floor.
-- STAR: totals A 10, B 8, C 6; A and B go to the runoff, which A wins two to
-- one.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B', 'C'], array[[5, 2, 0], [5, 3, 1], [0, 3, 5]]);
  perform close_poll(v_poll);

  c := get_poll_consensus(v_poll, '{}');
  perform tests.assert_eq('the option whose lowest score is highest wins',
    tests.option_name(c, c ->> 'winner_id'), 'B');
  perform tests.assert_eq('its lowest score is given', (c ->> 'floor')::int, 2);
  perform tests.assert_eq('it had that floor alone', (c ->> 'tied_count')::int, 1);
  perform tests.assert_eq('so it won on its lowest score', (c ->> 'decided_at')::int, 1);
  perform tests.assert_eq('which is its floor', (c ->> 'winner_score')::int, 2);
  perform tests.assert_eq('the runner-up is the next in the order', c #>> '{runner_up,name}', 'A');
  perform tests.assert_eq('with its lowest score', (c #>> '{runner_up,score}')::int, 0);
  perform tests.assert_eq('nobody is level with the winner', jsonb_array_length(c -> 'level_ids'), 0);
  perform tests.assert_eq('every option is listed, best first',
    tests.option_order(c), array['B', 'A', 'C']);
  perform tests.assert_eq('with its floor',
    (select (o ->> 'floor')::int from jsonb_array_elements(c -> 'options') o where o ->> 'name' = 'C'), 0);
  perform tests.assert_eq('and its stars',
    (select (o ->> 'total_score')::int from jsonb_array_elements(c -> 'options') o where o ->> 'name' = 'A'), 10);
  perform tests.assert_eq('every ballot counted', (c ->> 'voter_count')::int, 3);
  perform tests.assert_eq('STAR itself still elects A',
    tests.winner(get_poll_results(v_poll)), 'A');

  -- Leaving B out: A (0 5 5) and C (0 1 5) share a floor of 0, and A's
  -- next-lowest score, 5, beats C's 1.
  c := get_poll_consensus(v_poll, array[(select id from candidates where poll_id = v_poll and name = 'B')]);
  perform tests.assert_eq('an option left out is not counted', tests.option_order(c), array['A', 'C']);
  perform tests.assert_eq('the rest tie on their floor', (c ->> 'tied_count')::int, 2);
  perform tests.assert_eq('so the next-lowest score settles it', tests.option_name(c, c ->> 'winner_id'), 'A');
  perform tests.assert_eq('at the second score', (c ->> 'decided_at')::int, 2);
  perform tests.assert_eq('five stars', (c ->> 'winner_score')::int, 5);
  perform tests.assert_eq('to the runner-up''s one', (c #>> '{runner_up,score}')::int, 1);
  perform tests.assert_eq('the field is what is left', (c ->> 'option_count')::int, 2);

  -- Leaving two out: C alone wins, with nothing to beat.
  c := get_poll_consensus(v_poll, array(
    select id from candidates where poll_id = v_poll and name in ('A', 'B')));
  perform tests.assert_eq('one option left wins', tests.option_name(c, c ->> 'winner_id'), 'C');
  perform tests.assert_null('at no position', c ->> 'decided_at');
  perform tests.assert_null('over nobody', c ->> 'runner_up');
end $$;

-- A shared floor goes to the next-lowest score.
--
--            A  B  C
--   voter 1  4  2  5
--   voter 2  2  4  2
--   voter 3  4  3  0
--
-- Lowest first: A 2 4 4, B 2 3 4, C 0 2 5. A and B share a floor of 2; at
-- the second score A has 4 and B 3, so A.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B', 'C'], array[[4, 2, 5], [2, 4, 2], [4, 3, 0]]);
  perform close_poll(v_poll);

  c := get_poll_consensus(v_poll, '{}');
  perform tests.assert_eq('two options share the highest floor', (c ->> 'tied_count')::int, 2);
  perform tests.assert_eq('which is 2', (c ->> 'floor')::int, 2);
  perform tests.assert_eq('the next-lowest score elects A',
    tests.option_name(c, c ->> 'winner_id'), 'A');
  perform tests.assert_eq('at the second score', (c ->> 'decided_at')::int, 2);
  perform tests.assert_eq('four stars', (c ->> 'winner_score')::int, 4);
  perform tests.assert_eq('to B', c #>> '{runner_up,name}', 'B');
  perform tests.assert_eq('and its three', (c #>> '{runner_up,score}')::int, 3);
  perform tests.assert_eq('the option outside the tie comes last',
    tests.option_order(c), array['A', 'B', 'C']);
end $$;

-- The comparison goes as far up as it must.
--
--            A  B
--   voter 1  1  1
--   voter 2  3  3
--   voter 3  5  4
--
-- Lowest first: A 1 3 5, B 1 3 4. Level twice; A on the third score.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B'], array[[1, 1], [3, 3], [5, 4]]);
  perform close_poll(v_poll);

  c := get_poll_consensus(v_poll, '{}');
  perform tests.assert_eq('the third-lowest score decides', tests.option_name(c, c ->> 'winner_id'), 'A');
  perform tests.assert_eq('at the third score', (c ->> 'decided_at')::int, 3);
  perform tests.assert_eq('five to four', array[(c ->> 'winner_score')::int, (c #>> '{runner_up,score}')::int],
    array[5, 4]);
end $$;

-- STAR is not run between the tied options.
--
--            A  B
--   voter 1  2  3
--   voter 2  2  3
--   voter 3  5  3
--   voter 4  5  2
--
-- Lowest first: A 2 2 5 5, B 2 3 3 3. B on the second score. STAR between
-- them: two voters each way, and A's 14 stars beat B's 11, so A.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B'], array[[2, 3], [2, 3], [5, 3], [5, 2]]);
  perform close_poll(v_poll);

  c := get_poll_consensus(v_poll, '{}');
  perform tests.assert_eq('the next-lowest score elects B', tests.option_name(c, c ->> 'winner_id'), 'B');
  perform tests.assert_eq('where STAR elects A', tests.winner(get_poll_results(v_poll)), 'A');
end $$;

-- Options level on every score leave no winner.
--
--            A  B  C
--   voter 1  4  2  5
--   voter 2  2  4  0
--
-- Lowest first: A 2 4, B 2 4, C 0 5. A and B were given the same scores, by
-- different voters.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B', 'C'], array[[4, 2, 5], [2, 4, 0]]);
  perform close_poll(v_poll);

  c := get_poll_consensus(v_poll, '{}');
  perform tests.assert_null('a tie on every score elects nobody', c ->> 'winner_id');
  perform tests.assert_eq('and names the options level', c -> 'level_names', '["A", "B"]'::jsonb);
  perform tests.assert_eq('by id too', jsonb_array_length(c -> 'level_ids'), 2);
  perform tests.assert_eq('their floor is given', (c ->> 'floor')::int, 2);
  perform tests.assert_eq('as is how many share it', (c ->> 'tied_count')::int, 2);
  perform tests.assert_null('with no deciding score', c ->> 'decided_at');
  perform tests.assert_null('and no runner-up', c ->> 'runner_up');
  perform tests.assert_eq('the rest follow', tests.option_order(c), array['A', 'B', 'C']);
end $$;

-- A ballot giving every option 0 counts, and holds every floor at 0, but
-- cannot change the winner.
--
--            A  B  C
--   voters 1-3 as in the first case
--   voter 4  0  0  0
--
-- Lowest first: A 0 0 5 5, B 0 2 3 3, C 0 0 1 5. All share a floor of 0; B
-- on the second score, 2 to A's 0.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B', 'C'],
    array[[5, 2, 0], [5, 3, 1], [0, 3, 5], [0, 0, 0]]);
  perform close_poll(v_poll);

  c := get_poll_consensus(v_poll, '{}');
  perform tests.assert_eq('a ballot of nothing but 0 does not decide',
    tests.option_name(c, c ->> 'winner_id'), 'B');
  perform tests.assert_eq('it is counted', (c ->> 'voter_count')::int, 4);
  perform tests.assert_eq('every floor is 0', (c ->> 'floor')::int, 0);
  perform tests.assert_eq('so every option shares it', (c ->> 'tied_count')::int, 3);
  perform tests.assert_eq('and the second score decides', (c ->> 'decided_at')::int, 2);
end $$;

-- Nobody starred anything: every option is level.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B'], array[[0, 0], [0, 0]]);
  perform close_poll(v_poll);

  c := get_poll_consensus(v_poll, '{}');
  perform tests.assert_eq('every ballot counts', (c ->> 'voter_count')::int, 2);
  perform tests.assert_eq('every option ties', (c ->> 'tied_count')::int, 2);
  perform tests.assert_null('and nobody wins', c ->> 'winner_id');
  perform tests.assert_eq('both are level', jsonb_array_length(c -> 'level_ids'), 2);
end $$;

-- A question can ask for it, on a written list or a calendar.
do $$
declare
  v_emails text[] := array['voter1@example.com', 'voter2@example.com', 'voter3@example.com'];
  v_ballots int[][] := array[[5, 2, 0], [5, 3, 1], [0, 3, 5]];
  v_schedule jsonb := '{"timezone":"-07:00","window":{"start":"08:00","end":"22:00"},"desired_slots":3,"granularity":60}'::jsonb;
  v_windows text[] := array[
    '2026-09-01T08:00:00-07:00',
    '2026-09-01T09:00:00-07:00',
    '2026-09-01T10:00:00-07:00'];
  v_list uuid;
  v_time uuid;
  v_two uuid;
  t jsonb;
  i int;
begin
  perform tests.sign_in('creator@example.com');
  v_list := create_poll('Dinner', null, array['A', 'B', 'C'], v_emails, p_kind => 'consensus');
  v_time := create_poll('Standup', null, v_windows, v_emails,
                        'invite', true, false, null, false, 'consensus', v_schedule);
  v_two := create_poll('Dinner', null, array['A', 'B'], v_emails, p_kind => 'consensus');

  perform tests.assert_eq('a consensus question is stored as one',
    (select kind from polls where id = v_list), 'consensus');
  perform tests.assert_null('with no grid', (select schedule from polls where id = v_list));
  perform tests.assert_eq('a consensus time keeps its grid',
    (select schedule from polls where id = v_time), v_schedule);

  for i in 1 .. 3 loop
    perform tests.sign_in(v_emails[i]);
    perform tests.cast_ballot(v_list, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
    perform tests.cast_ballot(v_time, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
    perform tests.cast_ballot(v_two, array[v_ballots[i][1], v_ballots[i][2]]);
  end loop;
  perform tests.sign_in('creator@example.com');

  t := get_poll_results(v_list);
  perform tests.assert_eq('the tally carries the consensus',
    t -> 'kind_result', get_poll_consensus(v_list, '{}'));
  perform tests.assert_eq('the time''s tally carries it too',
    get_poll_results(v_time) -> 'kind_result', get_poll_consensus(v_time, '{}'));
  perform tests.assert_eq('from two options, where it can still differ from STAR',
    get_poll_results(v_two) #>> '{kind_result,winner_id}',
    (select id::text from candidates where poll_id = v_two and name = 'B'));
  perform tests.assert_eq('and the page''s one read carries it',
    poll_page(v_list) #> '{results,kind_result}', get_poll_consensus(v_list, '{}'));

  perform tests.assert_raises('a consensus takes no number',
    format('select create_poll(%L, null, array[%L, %L], array[%L], p_kind => %L, p_kind_value => 3)',
           'Lunch', 'Pizza', 'Sushi', 'voter1@example.com', 'consensus'),
    'Only multiple winners, proportional winners, consensus winners, a budget poll or an option assignment takes a number');

  -- A typed name is not a window, on either calendar.
  v_time := create_poll('Standup', null, v_windows, v_emails,
                        'invite', true, false, null, false, 'consensus', v_schedule);
  perform tests.assert_raises('a consensus time takes no typed option',
    format('select creator_add_option(%L, %L)', v_time, 'Whenever suits'),
    'A time poll''s options are its windows; change its schedule instead');
  perform tests.assert_raises('nor a typed correction',
    format('select creator_edit_options(%L, ''[]''::jsonb, ''{}'', %L::jsonb)', v_time,
           jsonb_build_array(jsonb_build_object(
             'id', (select id from candidates where poll_id = v_time limit 1),
             'name', 'Whenever suits'))::text),
    'A time poll''s options are its windows; change its schedule instead');

  -- A group may ask for it question by question.
  t := jsonb_build_array(
    jsonb_build_object('title', 'Where?', 'kind', 'consensus',
                       'options', jsonb_build_array(jsonb_build_object('name', 'A'), jsonb_build_object('name', 'B'))),
    jsonb_build_object('title', 'When?', 'kind', 'consensus', 'schedule', v_schedule,
                       'options', (select jsonb_agg(jsonb_build_object('name', w)) from unnest(v_windows) w)));
  v_list := create_poll_group('Offsite', null, t, v_emails);
  perform tests.assert_eq('a group''s questions keep their kinds',
    (select array_agg(kind order by question_position) from polls
      where group_id = (select group_id from polls where id = v_list)),
    array['consensus', 'consensus']);
end $$;

-- The doors are the tally's.
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

  perform tests.assert_raises('an unfinished invite poll keeps its consensus',
    format('select get_poll_consensus(%L, ''{}'')', v_poll),
    'Results are not available until everyone has voted');

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('a stranger is told no such poll',
    format('select get_poll_consensus(%L, ''{}'')', v_poll),
    'Poll not found');

  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Movie night', null,
                        array['Dune', 'Arrival', 'Solaris'],
                        array[]::text[], 'open', true, true);
  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 3))
  into v_scores from candidates where poll_id = v_poll;
  perform open_poll_submit(v_poll, v_scores, 'voter-key-1', 'Robin');

  perform tests.assert_raises('an open poll keeps it until it closes',
    format('select open_poll_consensus(%L, ''{}'')', v_poll),
    'Results are not available until the poll is closed');

  perform close_poll(v_poll);
  perform tests.assert_eq('and gives it once it has',
    (open_poll_consensus(v_poll, '{}') ->> 'tied_count')::int, 3);

  perform tests.assert_eq('the count itself is nobody''s to call',
    has_function_privilege('anon', 'public.poll_consensus(uuid, uuid[])', 'execute')
      or has_function_privilege('authenticated', 'public.poll_consensus(uuid, uuid[])', 'execute'),
    false);
  perform tests.assert_eq('the account door is not the link''s',
    has_function_privilege('anon', 'public.get_poll_consensus(uuid, uuid[])', 'execute'), false);
end $$;

-- A consensus question level on every score is settled with no name, so the
-- badge reads as a tie. Lowest first: A 2 4, B 2 4.
do $$
declare
  v_emails text[] := array['v1@example.com', 'v2@example.com'];
  v_poll uuid;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Dinner', null, array['A', 'B'], v_emails, p_kind => 'consensus');
  perform tests.sign_in(v_emails[1]);
  perform tests.cast_ballot(v_poll, array[4, 2]);
  perform tests.sign_in(v_emails[2]);
  perform tests.cast_ballot(v_poll, array[2, 4]);

  perform tests.assert_eq('a level consensus is settled',
    (select winner_settled_at is not null from polls where id = v_poll), true);
  perform tests.assert_null('with nobody', (select winner_name from polls where id = v_poll));
end $$;

rollback;

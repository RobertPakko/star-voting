-- The consensus option: every option judged by the fewest stars any ballot
-- gave it (its floor), the highest floor winning, and STAR run between the
-- options that share it. A ballot giving every option 0 is left out.
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
-- Floors: A 0, B 2, C 0, so B. STAR: totals A 10, B 8, C 6; A and B go to
-- the runoff, which A wins two to one.
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
  perform tests.assert_eq('so nothing went to a runoff', jsonb_array_length(c -> 'finalists'), 0);
  perform tests.assert_null('and there is no runoff', c ->> 'runoff');
  perform tests.assert_eq('every option is listed, the winner first',
    tests.option_order(c), array['B', 'A', 'C']);
  perform tests.assert_eq('with its floor',
    (select (o ->> 'floor')::int from jsonb_array_elements(c -> 'options') o where o ->> 'name' = 'C'), 0);
  perform tests.assert_eq('and its stars',
    (select (o ->> 'total_score')::int from jsonb_array_elements(c -> 'options') o where o ->> 'name' = 'A'), 10);
  perform tests.assert_eq('every ballot counted', (c ->> 'voter_count')::int, 3);
  perform tests.assert_eq('none was blank', (c ->> 'blank_ballots')::int, 0);
  perform tests.assert_eq('STAR itself still elects A',
    tests.winner(get_poll_results(v_poll)), 'A');

  -- Leaving B out: A and C both have a floor of 0, so STAR between them, and
  -- A wins that runoff two to one.
  c := get_poll_consensus(v_poll, array[(select id from candidates where poll_id = v_poll and name = 'B')]);
  perform tests.assert_eq('an option left out is not counted', tests.option_order(c), array['A', 'C']);
  perform tests.assert_eq('the rest tie on their floor', (c ->> 'tied_count')::int, 2);
  perform tests.assert_eq('so STAR settles it', tests.option_name(c, c ->> 'winner_id'), 'A');
  perform tests.assert_eq('between those two', c -> 'finalist_names', '["A", "C"]'::jsonb);
  perform tests.assert_eq('in a runoff', c #>> '{runoff,resolved_by}', 'preference');
  perform tests.assert_eq('the field is what is left', (c ->> 'option_count')::int, 2);
end $$;

-- A shared floor goes to STAR between just those options.
--
--            A  B  C
--   voter 1  4  2  5
--   voter 2  2  4  2
--   voter 3  4  3  0
--
-- Floors: A 2, B 2, C 0. Between A and B: voters 1 and 3 prefer A, so A.
-- (STAR over all three would put C, with 7 stars, below A's 10 and B's 9,
-- and elect A too; what matters is that C, scored 0 by voter 3, is out.)
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
  perform tests.assert_eq('they are the finalists, more stars first',
    c -> 'finalist_names', '["A", "B"]'::jsonb);
  perform tests.assert_eq('and the runoff between them elects A',
    tests.option_name(c, c ->> 'winner_id'), 'A');
  perform tests.assert_eq('with the runoff''s counts',
    (c #>> '{runoff,prefers_a}')::int, 2);
  perform tests.assert_eq('the option outside the tie comes last',
    tests.option_order(c), array['A', 'B', 'C']);
end $$;

-- A runoff level on every rule leaves no winner, as in STAR.
--
--            A  B  C
--   voter 1  4  2  5
--   voter 2  2  4  0
--
-- Floors: A 2, B 2, C 0. Runoff: one each; totals 6 and 6; no five-star
-- votes for either.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B', 'C'], array[[4, 2, 5], [2, 4, 0]]);
  perform close_poll(v_poll);

  c := get_poll_consensus(v_poll, '{}');
  perform tests.assert_null('a tie on every rule elects nobody', c ->> 'winner_id');
  perform tests.assert_eq('and says so', c #>> '{runoff,resolved_by}', 'unresolved');
  perform tests.assert_eq('naming both finalists', jsonb_array_length(c -> 'finalist_names'), 2);
end $$;

-- A blank ballot is left out; kept in, it would hold every floor at 0.
--
--            A  B  C
--   voters 1-3 as in the first case
--   voter 4  0  0  0
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
  perform tests.assert_eq('it is counted as left out', (c ->> 'blank_ballots')::int, 1);
  perform tests.assert_eq('and the rest as counted', (c ->> 'voter_count')::int, 3);

  -- Left with only C, voters 2 and 3 are the only ones starring anything, so
  -- voters 1 and 4 are blank.
  c := get_poll_consensus(v_poll, array(
    select id from candidates where poll_id = v_poll and name in ('A', 'B')));
  perform tests.assert_eq('blankness is judged on the options still in',
    (c ->> 'blank_ballots')::int, 2);
end $$;

-- Nobody starred anything: nobody is left out, and every option ties at 0.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B'], array[[0, 0], [0, 0]]);
  perform close_poll(v_poll);

  c := get_poll_consensus(v_poll, '{}');
  perform tests.assert_eq('with every ballot blank, all of them count', (c ->> 'voter_count')::int, 2);
  perform tests.assert_eq('and none is called blank', (c ->> 'blank_ballots')::int, 0);
  perform tests.assert_eq('every option ties', (c ->> 'tied_count')::int, 2);
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
                        'invite', true, false, null, false, 'consensus_time', v_schedule);
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

  perform tests.assert_raises('a consensus time needs a grid',
    format('select create_poll(%L, null, array[%L, %L], array[%L], %L, true, false, null, false, %L)',
           'Standup', v_windows[1], v_windows[2], 'voter1@example.com', 'invite', 'consensus_time'),
    'A time poll needs a schedule');
  perform tests.assert_raises('and a consensus option has none',
    format('select create_poll(%L, null, array[%L, %L], array[%L], %L, true, false, null, false, %L, %L::jsonb)',
           'Lunch', 'Pizza', 'Sushi', 'voter1@example.com', 'invite', 'consensus', v_schedule::text),
    'Only a time poll has a schedule');
  perform tests.assert_raises('a consensus takes no number',
    format('select create_poll(%L, null, array[%L, %L], array[%L], p_kind => %L, p_kind_value => 3)',
           'Lunch', 'Pizza', 'Sushi', 'voter1@example.com', 'consensus'),
    'Only an option ranking or multiple winners takes a number');
  perform tests.assert_raises('the table holds the grid to the calendar kinds',
    format('insert into polls (title, created_by, kind) values (%L, %L, %L)',
           'Standup', auth.uid(), 'consensus_time'),
    'polls_schedule_ck');

  -- A typed name is not a window, on either calendar.
  v_time := create_poll('Standup', null, v_windows, v_emails,
                        'invite', true, false, null, false, 'consensus_time', v_schedule);
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
    jsonb_build_object('title', 'When?', 'kind', 'consensus_time', 'schedule', v_schedule,
                       'options', (select jsonb_agg(jsonb_build_object('name', w)) from unnest(v_windows) w)));
  v_list := create_poll_group('Offsite', null, t, v_emails);
  perform tests.assert_eq('a group''s questions keep their kinds',
    (select array_agg(kind order by question_position) from polls
      where group_id = (select group_id from polls where id = v_list)),
    array['consensus', 'consensus_time']);
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

rollback;

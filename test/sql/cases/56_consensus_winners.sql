-- Consensus winners: several options chosen together, each voter served by
-- the option in the set they gave the most stars. The set leaving the fewest
-- voters on 0 stars wins, then the fewest on 1 or fewer, and so on
-- (leximin); then the set with the most stars; then a fixed draw.
--
-- Every expected value below is worked out by hand from those rules, except
-- the last case, which checks the search against trying every set.

begin;

create or replace function pg_temp.winners(c jsonb) returns text[] language sql as $$
  select coalesce(array_agg(w ->> 'name' order by w ->> 'name'), '{}')
  from jsonb_array_elements(c -> 'winners') w
$$;

create or replace function pg_temp.best_for(c jsonb, p_name text) returns int language sql as $$
  select (w ->> 'best_for')::int from jsonb_array_elements(c -> 'winners') w where w ->> 'name' = p_name
$$;

-- Two camps, each with a favourite, and one option everybody can live with.
--
--            A  B  C  D
--   voter 1  5  0  1  3
--   voter 2  5  0  1  3
--   voter 3  0  5  1  3
--   voter 4  0  5  1  3
--
-- One option: D, whose lowest score (3) is highest. Two: A and B serve
-- every voter a 5, where any set with D leaves somebody on 3.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B', 'C', 'D'],
    array[[5, 0, 1, 3], [5, 0, 1, 3], [0, 5, 1, 3], [0, 5, 1, 3]]);
  perform close_poll(v_poll);

  c := get_poll_consensus_winners(v_poll, '{}', 2);
  perform tests.assert_eq('two camps get one favourite each', pg_temp.winners(c), array['A', 'B']);
  perform tests.assert_eq('so nobody is served less than 5', (c ->> 'floor')::int, 5);
  perform tests.assert_eq('every voter is served a 5',
    c -> 'served', '[0, 0, 0, 0, 0, 4]'::jsonb);
  perform tests.assert_eq('where one option alone could do no better than 3',
    (c ->> 'single_floor')::int, 3);
  perform tests.assert_eq('each winner is the best for its camp', pg_temp.best_for(c, 'A'), 2);
  perform tests.assert_eq('two winners', (c ->> 'winner_count')::int, 2);
  perform tests.assert_eq('out of four options', (c ->> 'option_count')::int, 4);
  perform tests.assert_eq('and four voters', (c ->> 'voter_count')::int, 4);
  perform tests.assert_eq('the consensus option is D',
    tests.option_name(get_poll_consensus(v_poll, '{}'), get_poll_consensus(v_poll, '{}') ->> 'winner_id'), 'D');

  -- Leaving A out: {B, D} serves 3 3 5 5, {C, D} 3 3 3 3, {B, C} 1 1 5 5.
  c := get_poll_consensus_winners(v_poll,
    array[(select id from candidates where poll_id = v_poll and name = 'A')], 2);
  perform tests.assert_eq('an option left out is not chosen', pg_temp.winners(c), array['B', 'D']);
  perform tests.assert_eq('the camp without its favourite is served a 3', (c ->> 'floor')::int, 3);
  perform tests.assert_eq('the field is what is left', (c ->> 'option_count')::int, 3);

  -- Asking for as many as there are chooses them all.
  c := get_poll_consensus_winners(v_poll, '{}', 4);
  perform tests.assert_eq('four of four is all of them', pg_temp.winners(c), array['A', 'B', 'C', 'D']);
  perform tests.assert_eq('D serves nobody once both favourites are in',
    pg_temp.best_for(c, 'D'), 0);

  perform tests.assert_raises('one winner is the consensus option, not this',
    format('select get_poll_consensus_winners(%L, ''{}'', 1)', v_poll),
    'Choose from 2 to 10 winners');
  perform tests.assert_raises('nor more than the results show',
    format('select get_poll_consensus_winners(%L, ''{}'', 11)', v_poll),
    'Choose from 2 to 10 winners');
end $$;

-- Level on the worst-served voter, the next settles it.
--
--            A  B  C  D
--   voter 1  2  2  0  5
--   voter 2  5  0  2  0
--   voter 3  0  5  2  0
--
-- Served, lowest first: {A, B} 2 5 5; {A, C} 2 2 5; {B, C} 2 2 5;
-- {C, D} 2 2 5; {A, D} and {B, D} leave somebody on 0. Four sets share a
-- floor of 2, and {A, B} alone serves its second-worst voter a 5. Every
-- option's lowest score is 0, so one option alone could only promise 0.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B', 'C', 'D'],
    array[[2, 2, 0, 5], [5, 0, 2, 0], [0, 5, 2, 0]]);
  perform close_poll(v_poll);

  c := get_poll_consensus_winners(v_poll, '{}', 2);
  perform tests.assert_eq('the second-worst-served voter decides', pg_temp.winners(c), array['A', 'B']);
  perform tests.assert_eq('the floor is shared', (c ->> 'floor')::int, 2);
  perform tests.assert_eq('one voter on 2, two on 5', c -> 'served', '[0, 0, 1, 0, 0, 2]'::jsonb);
  perform tests.assert_eq('one option alone promises nothing', (c ->> 'single_floor')::int, 0);
  perform tests.assert_eq('voter 1 gave both winners 2, so counts for each',
    array[pg_temp.best_for(c, 'A'), pg_temp.best_for(c, 'B')], array[2, 2]);
end $$;

-- Level on every voter, the stars settle it.
--
--            A  B  C
--   voter 1  5  2  4
--   voter 2  1  5  4
--   voter 3  0  1  3
--
-- Served, lowest first: {A, B} 1 5 5; {A, C} 3 4 5; {B, C} 3 4 5. {A, C}
-- and {B, C} are level; A has 6 stars and B 8, so {B, C} with 19 to 17.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B', 'C'], array[[5, 2, 4], [1, 5, 4], [0, 1, 3]]);
  perform close_poll(v_poll);

  c := get_poll_consensus_winners(v_poll, '{}', 2);
  perform tests.assert_eq('the set with more stars', pg_temp.winners(c), array['B', 'C']);
  perform tests.assert_eq('served 3, 4 and 5', c -> 'served', '[0, 0, 0, 1, 1, 1]'::jsonb);
  perform tests.assert_eq('C serves two voters and B one',
    array[pg_temp.best_for(c, 'C'), pg_temp.best_for(c, 'B')], array[2, 1]);
  perform tests.assert_eq('the one serving most comes first', c #>> '{winners,0,name}', 'C');
end $$;

-- /choices' dinner, two dinners out of three.
--
--            friend  1  2  3  4  5  6
--   pizza            5  5  5  0  0  1
--   tacos            4  4  2  3  3  1
--   sushi            0  1  0  3  5  5
--
-- Served by the pair: pizza and sushi 5 5 5 3 5 5; tacos and sushi 4 4 2 3
-- 5 5; pizza and tacos 5 5 5 3 3 1. Pizza and sushi serve everyone 3 or
-- more, and leave out tacos, the consensus option.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['pizza', 'tacos', 'sushi'],
    array[[5, 4, 0], [5, 4, 1], [5, 2, 0], [0, 3, 3], [0, 3, 5], [1, 1, 5]]);
  perform close_poll(v_poll);

  c := get_poll_consensus_winners(v_poll, '{}', 2);
  perform tests.assert_eq('two dinners: pizza and sushi', pg_temp.winners(c), array['pizza', 'sushi']);
  perform tests.assert_eq('everyone served 3 or more', (c ->> 'floor')::int, 3);
  perform tests.assert_eq('where tacos alone promises 1', (c ->> 'single_floor')::int, 1);
  perform tests.assert_eq('one friend on 3, five on 5', c -> 'served', '[0, 0, 0, 1, 0, 5]'::jsonb);
end $$;

-- A ballot giving everything 0 is served 0 by every set, so it pulls the
-- floor down and changes nothing else.
do $$
declare
  v_poll uuid;
  c jsonb;
begin
  v_poll := tests.seed_poll(array['A', 'B', 'C', 'D'],
    array[[5, 0, 1, 3], [5, 0, 1, 3], [0, 5, 1, 3], [0, 5, 1, 3], [0, 0, 0, 0]]);
  perform close_poll(v_poll);

  c := get_poll_consensus_winners(v_poll, '{}', 2);
  perform tests.assert_eq('the camps still get their favourites', pg_temp.winners(c), array['A', 'B']);
  perform tests.assert_eq('the blank ballot is served nothing', c -> 'served', '[1, 0, 0, 0, 0, 4]'::jsonb);
  perform tests.assert_eq('and counts as a voter', (c ->> 'voter_count')::int, 5);
end $$;

-- A question can ask for it, on a written list or a calendar, and must say
-- how many.
do $$
declare
  v_emails text[] := array['voter1@example.com', 'voter2@example.com', 'voter3@example.com', 'voter4@example.com'];
  v_ballots int[][] := array[[5, 0, 1, 3], [5, 0, 1, 3], [0, 5, 1, 3], [0, 5, 1, 3]];
  v_schedule jsonb := '{"timezone":"-07:00","window":{"start":"08:00","end":"22:00"},"desired_slots":3,"granularity":60}'::jsonb;
  v_windows text[] := array[
    '2026-09-01T08:00:00-07:00',
    '2026-09-01T09:00:00-07:00',
    '2026-09-01T10:00:00-07:00',
    '2026-09-01T11:00:00-07:00'];
  v_list uuid;
  v_time uuid;
  v_three uuid;
  t jsonb;
  i int;
begin
  perform tests.sign_in('creator@example.com');
  v_list := create_poll('Dinner', null, array['A', 'B', 'C', 'D'], v_emails,
                        p_kind => 'consensus_winners', p_kind_value => 2);
  v_time := create_poll('Standup', null, v_windows, v_emails,
                        'invite', true, false, null, false, 'consensus_times', v_schedule, 2);
  v_three := create_poll('Dinner', null, array['A', 'D'], v_emails,
                         p_kind => 'consensus_winners', p_kind_value => 2);

  perform tests.assert_eq('a consensus winners question is stored as one',
    (select kind from polls where id = v_list), 'consensus_winners');
  perform tests.assert_eq('with its number', (select kind_value from polls where id = v_list), 2::numeric);
  perform tests.assert_eq('consensus times keep their grid',
    (select schedule from polls where id = v_time), v_schedule);

  for i in 1 .. 4 loop
    perform tests.sign_in(v_emails[i]);
    perform tests.cast_ballot(v_list, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3], v_ballots[i][4]]);
    perform tests.cast_ballot(v_time, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3], v_ballots[i][4]]);
    perform tests.cast_ballot(v_three, array[v_ballots[i][1], v_ballots[i][4]]);
  end loop;
  perform tests.sign_in('creator@example.com');

  t := get_poll_results(v_list);
  perform tests.assert_eq('the tally carries the winners',
    t -> 'kind_result', get_poll_consensus_winners(v_list, '{}', 2));
  perform tests.assert_eq('at the question''s own number', pg_temp.winners(t -> 'kind_result'), array['A', 'B']);
  perform tests.assert_eq('the times'' tally carries them too',
    get_poll_results(v_time) -> 'kind_result', get_poll_consensus_winners(v_time, '{}', null));
  perform tests.assert_null('not from two options, where both are the answer',
    get_poll_results(v_three) ->> 'kind_result');
  perform tests.assert_eq('and the page''s one read carries them',
    poll_page(v_list) #> '{results,kind_result}', get_poll_consensus_winners(v_list, '{}', 2));
  perform tests.assert_eq('a reader may count another number',
    (get_poll_consensus_winners(v_list, '{}', 3) ->> 'winner_count')::int, 3);

  -- Left unsettled, every screen says *Results ready*; settled with no name
  -- would read as a tie.
  perform tests.assert_null('several winners are never settled with one',
    (select winner_settled_at from polls where id = v_list));
  -- A 5 5 0 0 against D 3 3 3 3: two voters each way, and D's 12 stars
  -- beat A's 10.
  perform tests.assert_eq('below three options, STAR''s winner stands',
    (select winner_name from polls where id = v_three), 'D');

  perform tests.assert_raises('consensus winners must say how many',
    format('select create_poll(%L, null, array[%L, %L, %L], array[%L], p_kind => %L)',
           'Lunch', 'Pizza', 'Sushi', 'Tacos', 'voter1@example.com', 'consensus_winners'),
    'Say how many winners to choose');
  perform tests.assert_raises('at least two',
    format('select create_poll(%L, null, array[%L, %L, %L], array[%L], p_kind => %L, p_kind_value => 1)',
           'Lunch', 'Pizza', 'Sushi', 'Tacos', 'voter1@example.com', 'consensus_winners'),
    'Choose from 2 to 10 winners');
  perform tests.assert_raises('the table holds the number to the kinds that take one',
    format('insert into polls (title, created_by, kind, kind_value) values (%L, %L, %L, 1)',
           'Lunch', auth.uid(), 'consensus_winners'),
    'polls_kind_value_ck');
  perform tests.assert_raises('consensus times need a grid',
    format('select create_poll(%L, null, array[%L, %L], array[%L], %L, true, false, null, false, %L, null, 2)',
           'Standup', v_windows[1], v_windows[2], 'voter1@example.com', 'invite', 'consensus_times'),
    'A time poll needs a schedule');
  perform tests.assert_raises('and consensus winners have none',
    format('select create_poll(%L, null, array[%L, %L], array[%L], %L, true, false, null, false, %L, %L::jsonb, 2)',
           'Lunch', 'Pizza', 'Sushi', 'voter1@example.com', 'invite', 'consensus_winners', v_schedule::text),
    'Only a time poll has a schedule');
  perform tests.assert_raises('the table holds the grid to the calendar kinds',
    format('insert into polls (title, created_by, kind, kind_value) values (%L, %L, %L, 2)',
           'Standup', auth.uid(), 'consensus_times'),
    'polls_schedule_ck');

  v_time := create_poll('Standup', null, v_windows, v_emails,
                        'invite', true, false, null, false, 'consensus_times', v_schedule, 2);
  perform tests.assert_raises('consensus times take no typed option',
    format('select creator_add_option(%L, %L)', v_time, 'Whenever suits'),
    'A time poll''s options are its windows; change its schedule instead');

  t := jsonb_build_array(
    jsonb_build_object('title', 'Where?', 'kind', 'consensus_winners', 'kind_value', 2,
                       'options', jsonb_build_array(jsonb_build_object('name', 'A'), jsonb_build_object('name', 'B'),
                                                    jsonb_build_object('name', 'C'))),
    jsonb_build_object('title', 'When?', 'kind', 'consensus_times', 'kind_value', 3, 'schedule', v_schedule,
                       'options', (select jsonb_agg(jsonb_build_object('name', w)) from unnest(v_windows) w)));
  v_list := create_poll_group('Offsite', null, t, v_emails);
  perform tests.assert_eq('a group''s questions keep their kinds',
    (select array_agg(kind order by question_position) from polls
      where group_id = (select group_id from polls where id = v_list)),
    array['consensus_winners', 'consensus_times']);
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

  perform tests.assert_raises('an unfinished invite poll keeps its winners',
    format('select get_poll_consensus_winners(%L)', v_poll),
    'Results are not available until everyone has voted');

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('a stranger is told no such poll',
    format('select get_poll_consensus_winners(%L)', v_poll),
    'Poll not found');

  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Movie night', null,
                        array['Dune', 'Arrival', 'Solaris'],
                        array[]::text[], 'open', true, true);
  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 3))
  into v_scores from candidates where poll_id = v_poll;
  perform open_poll_submit(v_poll, v_scores, 'voter-key-1', 'Robin');

  perform tests.assert_raises('an open poll keeps them until it closes',
    format('select open_poll_consensus_winners(%L)', v_poll),
    'Results are not available until the poll is closed');

  perform close_poll(v_poll);
  perform tests.assert_eq('and gives them once it has, two by default',
    (open_poll_consensus_winners(v_poll) ->> 'winner_count')::int, 2);

  perform tests.assert_eq('the count itself is nobody''s to call',
    has_function_privilege('anon', 'public.poll_consensus_winners(uuid, uuid[], integer)', 'execute')
      or has_function_privilege('authenticated', 'public.poll_consensus_winners(uuid, uuid[], integer)', 'execute')
      or has_function_privilege('authenticated', 'public.consensus_set_search(integer, bigint[], integer, bigint)', 'execute'),
    false);
  perform tests.assert_eq('the account door is not the link''s',
    has_function_privilege('anon', 'public.get_poll_consensus_winners(uuid, uuid[], integer)', 'execute'), false);
end $$;

-- The search against every set. Not worked by hand: twelve options and nine
-- voters, scored from a fixed seed, and every set of three or four compared
-- by the same rules, which is the order a plain sort gives.
do $$
declare
  v_options text[] := array['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  v_ballots int[][];
  v_poll uuid;
  v_size int;
  v_expected text[];
begin
  perform setseed(0.42);
  select array_agg(r order by v) into v_ballots
  from (
    select v, array_agg((array[0, 0, 1, 2, 3, 4, 5, 5])[1 + floor(random() * 8)::int] order by o) as r
    from generate_series(1, 9) v, generate_series(1, 12) o
    group by v
  ) b;
  v_poll := tests.seed_poll(v_options, v_ballots);
  perform close_poll(v_poll);

  foreach v_size in array array[3, 4] loop
    with recursive sets(ids, last) as (
      select array[c.id], c.sort_order from candidates c where c.poll_id = v_poll
      union all
      select s.ids || c.id, c.sort_order
      from sets s join candidates c on c.poll_id = v_poll and c.sort_order > s.last
      where cardinality(s.ids) < v_size
    ),
    judged as (
      select s.ids,
             (select array_agg(served order by served)
                from (select coalesce(max(sc.score), 0) as served
                        from ballots b
                        left join scores sc on sc.ballot_id = b.id and sc.candidate_id = any(s.ids)
                       where b.poll_id = v_poll
                       group by b.id) v) as ladder,
             (select sum(sc.score) from scores sc where sc.candidate_id = any(s.ids)) as stars,
             (select sum(('x' || substr(md5(v_poll::text || id::text), 1, 7))::bit(28)::bigint)
                from unnest(s.ids) id) as draw
      from sets s
      where cardinality(s.ids) = v_size
    )
    select array(select name from candidates where id = any(ids) order by name) into v_expected
    from judged
    order by ladder desc, stars desc, draw desc
    limit 1;

    perform tests.assert_eq(format('the search finds the best set of %s', v_size),
      pg_temp.winners(get_poll_consensus_winners(v_poll, '{}', v_size)), v_expected);
  end loop;
end $$;

rollback;

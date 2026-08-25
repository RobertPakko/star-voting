-- The full ranking is read on exactly the terms the tally is.
--
-- It used to ride along inside poll_tally(), so it could not be reached
-- without passing that function's gate. Now it is its own call, and a gate
-- that was one function's business is two functions' -- which is the way a
-- rule stops being enforced. The ranking discloses more than the tally does,
-- not less: every option's placing, every runoff below the headline one.
--
-- So: the same refusals, on the same polls, at the same moments.

begin;

-- An invite poll, still taking votes.
do $$
declare
  v_poll uuid;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Lunch', null,
                        array['Apple', 'Banana', 'Cherry'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false);

  -- Three different scores, so the field places three deep rather than
  -- tying itself into one.
  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_poll, (
    select jsonb_agg(jsonb_build_object(
             'candidate_id', id,
             'score', case name when 'Apple' then 5 when 'Banana' then 3 else 1 end))
    from candidates where poll_id = v_poll));

  perform tests.sign_in('creator@example.com');

  perform tests.assert_raises('the tally waits for everyone',
    format('select get_poll_results(%L)', v_poll),
    'Results are not available until everyone has voted');
  perform tests.assert_raises('and so does the ranking',
    format('select get_poll_ranking(%L)', v_poll),
    'Results are not available until everyone has voted');

  -- Somebody who was never invited cannot see that the poll exists, let
  -- alone how its options placed.
  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('a stranger is told no such poll',
    format('select get_poll_ranking(%L)', v_poll),
    'Poll not found');

  -- Closing unlocks both at once.
  perform tests.sign_in('creator@example.com');
  perform close_poll(v_poll);

  perform tests.assert_eq('closing unlocks the ranking with the tally',
    jsonb_array_length(get_poll_ranking(v_poll)), 3);
  perform tests.assert_eq('and it places the option the tally elected first',
    tests.placed_at(get_poll_ranking(v_poll), 1),
    array[tests.winner(get_poll_results(v_poll))]);

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('a closed poll is still no stranger business',
    format('select get_poll_ranking(%L)', v_poll),
    'Poll not found');
end $$;

-- An open poll, read by its id -- which is its link.
do $$
declare
  v_poll uuid;
  v_scores jsonb;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Movie night', null,
                        array['Dune', 'Arrival', 'Solaris'],
                        array[]::text[], 'open', true, true);

  select jsonb_agg(jsonb_build_object(
           'candidate_id', id,
           'score', case name when 'Dune' then 5 when 'Arrival' then 3 else 1 end))
  into v_scores from candidates where poll_id = v_poll;
  perform open_poll_submit(v_poll, v_scores, 'voter-key-1', 'Robin');

  perform tests.assert_raises('an open poll shows no tally until it closes',
    format('select open_poll_results(%L)', v_poll),
    'Results are not available until the poll is closed');
  perform tests.assert_raises('and no ranking either',
    format('select open_poll_ranking(%L)', v_poll),
    'Results are not available until the poll is closed');

  -- A well-formed id for no poll, rather than a string that is not an id at
  -- all: the parameter is a uuid now, so anything else is refused by the type
  -- before the function has an opinion, and the case worth covering is the
  -- one an attacker can actually present.
  perform tests.assert_raises('an id that opens nothing gets nothing',
    format('select open_poll_ranking(%L)', gen_random_uuid()),
    'Poll not found');

  perform close_poll(v_poll);

  perform tests.assert_eq('a closed one ranks its whole field',
    jsonb_array_length(open_poll_ranking(v_poll)), 3);
  perform tests.assert_eq('agreeing with its own tally about the winner',
    tests.placed_at(open_poll_ranking(v_poll), 1),
    array[tests.winner(open_poll_results(v_poll))]);
end $$;

-- A poll nobody voted in has no ranking to give, and says so the way the
-- tally does rather than returning an empty list.
do $$
declare
  v_poll uuid;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Empty', null,
                        array['Apple', 'Banana', 'Cherry'],
                        array['voter1@example.com'],
                        'invite', true, false);
  perform close_poll(v_poll);

  perform tests.assert_raises('no ballots, no ranking',
    format('select get_poll_ranking(%L)', v_poll),
    'No votes were cast in this poll');
end $$;

rollback;

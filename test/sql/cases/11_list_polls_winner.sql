-- The poll list knows how a poll ended.
--
-- list_polls() carries the elected option back to the list, so a row can say
-- what happened rather than that something happened. Three things have to
-- hold: it is the same winner the results page shows, it is withheld for
-- exactly as long as the results themselves are, and a poll that elects
-- nobody says nobody rather than picking one.

begin;

do $$
declare
  v_poll uuid;
  v_row record;
begin
  -- Apple wins the score round and the runoff outright.
  v_poll := tests.seed_poll(
    array['Apple', 'Banana'],
    array[[5, 1],
          [4, 0]]);

  perform tests.sign_in('creator@example.com');
  select * into v_row from list_polls() where id = v_poll;

  perform tests.assert_eq('a finished poll names its winner on the list',
    v_row.winner_name, 'Apple');
  perform tests.assert_eq('the list agrees with the results page',
    v_row.winner_name, tests.winner(poll_tally(v_poll)));
end $$;

do $$
declare
  v_poll uuid;
  v_row record;
begin
  -- Two invitees, one ballot: the results have not unlocked.
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Lunch', null,
                        array['Apple', 'Banana'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false);

  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_poll, (
    select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 5))
    from candidates where poll_id = v_poll));

  perform tests.sign_in('creator@example.com');
  select * into v_row from list_polls() where id = v_poll;

  perform tests.assert_eq('the poll is still waiting on a voter',
    v_row.results_available, false);
  -- The creator must not learn who is winning from the list while the
  -- poll is still taking votes -- that is the whole of the secret ballot.
  perform tests.assert_null('so no winner is named', v_row.winner_name);

  -- Closing early unlocks the results, and the winner with them.
  perform close_poll(v_poll);
  select * into v_row from list_polls() where id = v_poll;

  perform tests.assert_eq('closing unlocks the results', v_row.results_available, true);
  perform tests.assert_eq('and the winner appears with them',
    v_row.winner_name, tests.winner(poll_tally(v_poll)));
end $$;

do $$
declare
  v_poll uuid;
  v_row record;
begin
  -- One voter, two options, identical scores: level on preference, on
  -- points and on five-star votes alike, so STAR elects nobody.
  v_poll := tests.seed_poll(
    array['Apple', 'Banana'],
    array[[5, 5]]);

  perform tests.sign_in('creator@example.com');
  select * into v_row from list_polls() where id = v_poll;

  perform tests.assert_eq('the results are out', v_row.results_available, true);
  perform tests.assert_null('but a genuine tie elects nobody', v_row.winner_name);
end $$;

do $$
declare
  v_poll uuid;
  v_row record;
begin
  -- A poll closed before anyone voted has no result to report at all.
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Nobody voted', null,
                        array['Apple', 'Banana'],
                        array['voter1@example.com'],
                        'invite', true, false);
  perform close_poll(v_poll);

  select * into v_row from list_polls() where id = v_poll;

  perform tests.assert_eq('a closed poll with no ballots is closed', v_row.is_closed, true);
  perform tests.assert_eq('with no results', v_row.results_available, false);
  perform tests.assert_null('and no winner', v_row.winner_name);
end $$;

rollback;

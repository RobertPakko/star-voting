-- The poll list can ask how a poll ended.
--
-- poll_winners() is what puts the elected option on a list card. Four things
-- have to hold: it is the same winner the results page shows, it is withheld
-- for exactly as long as the results themselves are, a poll that elects
-- nobody says nobody rather than picking one, and it answers only for polls
-- the caller can already see.

begin;

do $$
declare
  v_poll uuid;
  v_name text;
begin
  -- Apple wins the score round and the runoff outright.
  v_poll := tests.seed_poll(
    array['Apple', 'Banana'],
    array[[5, 1],
          [4, 0]]);

  perform tests.sign_in('creator@example.com');
  select winner_name into v_name from poll_winners(array[v_poll]);

  perform tests.assert_eq('a finished poll names its winner', v_name, 'Apple');
  perform tests.assert_eq('and names the one the results page names',
    v_name, tests.winner(poll_tally(v_poll)));
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
  select * into v_row from poll_winners(array[v_poll]);

  perform tests.assert_eq('a poll still taking votes is still answered for',
    v_row.poll_id, v_poll);
  -- Nobody may learn who is winning from a list while the poll is open --
  -- that is the whole of the secret ballot, and the creator is not exempt.
  perform tests.assert_null('but no winner is named', v_row.winner_name);

  -- Closing unlocks the results, and the winner with them.
  perform close_poll(v_poll);
  select * into v_row from poll_winners(array[v_poll]);

  perform tests.assert_eq('closing names the winner',
    v_row.winner_name, tests.winner(poll_tally(v_poll)));
end $$;

do $$
declare
  v_poll uuid;
  v_row record;
begin
  -- One voter, two options, identical scores: level on preference, on points
  -- and on five-star votes alike, so STAR elects nobody.
  v_poll := tests.seed_poll(
    array['Apple', 'Banana'],
    array[[5, 5]]);

  perform tests.sign_in('creator@example.com');
  select * into v_row from poll_winners(array[v_poll]);

  perform tests.assert_eq('a genuine tie is still answered for', v_row.poll_id, v_poll);
  perform tests.assert_null('and elects nobody', v_row.winner_name);
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

  select * into v_row from poll_winners(array[v_poll]);
  perform tests.assert_null('a poll closed with no ballots has no winner',
    v_row.winner_name);
end $$;

do $$
declare
  v_poll uuid;
begin
  v_poll := tests.seed_poll(
    array['Apple', 'Banana'],
    array[[5, 1]]);

  -- An outsider gets no row rather than a null one: "not yours" and "no
  -- winner" are different answers and must not arrive looking alike.
  perform tests.sign_in('stranger@example.com');
  perform tests.assert_eq('a poll you cannot see is not answered for',
    (select count(*)::int from poll_winners(array[v_poll])), 0);

  -- An invitee can, on the same terms list_polls() shows it to them.
  perform tests.sign_in('voter1@example.com');
  perform tests.assert_eq('an invitee reads the same winner',
    (select winner_name from poll_winners(array[v_poll])), 'Apple');
end $$;

do $$
declare
  v_polls uuid[];
begin
  perform tests.sign_in('creator@example.com');

  -- Nothing to answer for is not an error: the page asks for what it does
  -- not already know, which is usually nothing at all.
  perform tests.assert_eq('an empty request answers nothing',
    (select count(*)::int from poll_winners(array[]::uuid[])), 0);

  -- One election per id, so the id list is bounded rather than trusted.
  select array_agg(gen_random_uuid()) into v_polls from generate_series(1, 201);
  perform tests.assert_raises('and a request cannot be unbounded',
    format('select * from poll_winners(%L::uuid[])', v_polls),
    'Too many polls');
end $$;

rollback;

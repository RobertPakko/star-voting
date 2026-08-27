-- The elected option is worked out once and kept on the poll.
--
-- The winner used to be re-elected on demand by whoever asked, and remembered
-- only in the browser that asked. Now `polls.winner_name` holds it, filled in
-- by settle_winner() when the poll crosses the line into having a result and
-- emptied when a reset takes that result away. Five things have to hold, and
-- the first is the one an implementation gets wrong quietly:
--
--  * the ballot that opens the gate is counted *with its scores*, which are
--    written after the ballot row it belongs to;
--  * a reset takes the answer back, and a second finish gives the second
--    answer rather than the first one again;
--  * "no winner" and "not worked out yet" stay different answers;
--  * every question in a group gets its answer when the group stops, not
--    just the question that was closed;
--  * nothing is stored while the poll is still taking votes.

begin;

-- ---------------------------------------------------------------------------
-- The last ballot, and the scores that arrive after it.
-- ---------------------------------------------------------------------------

do $$
declare
  v_poll uuid;
  v_row polls;
begin
  -- Three ballots, and the third one decides it. Apple leads on points until
  -- the last voter arrives; with them, Banana leads the score round and wins
  -- the runoff two to one.
  --
  -- The shape matters. submit_ballot inserts the ballot row and then its
  -- scores, in separate statements, and it is the *last* ballot that unlocks
  -- an invite poll's results -- so an implementation that settled the winner
  -- from a trigger on the ballot insert would run the election over a tally
  -- whose deciding ballot had no scores on it. On these numbers that election
  -- ends in a tie and stores no winner at all, where the real one names
  -- Banana.
  v_poll := tests.seed_poll(
    array['Apple', 'Banana'],
    array[[5, 0],
          [0, 5],
          [0, 3]]);

  select * into v_row from polls where id = v_poll;

  perform tests.assert_eq('the last ballot of a poll settles its winner',
    v_row.winner_settled_at is not null, true);
  -- Anchored to the election itself rather than to the name spelled out here:
  -- what is being tested is that the stored answer is the one the results
  -- page computes, from a tally that has every score in it.
  perform tests.assert_eq('and it is the winner the results page names',
    v_row.winner_name, tests.winner(poll_tally(v_poll)));
  perform tests.assert_eq('which is the option the deciding ballot elected',
    v_row.winner_name, 'Banana');
end $$;

-- ---------------------------------------------------------------------------
-- Nothing is stored while the poll is still taking votes.
-- ---------------------------------------------------------------------------

do $$
declare
  v_poll uuid;
  v_row polls;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Lunch', null,
                        array['Apple', 'Banana'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false);

  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);

  select * into v_row from polls where id = v_poll;

  -- Nobody may learn who is winning from a poll that is still open -- that is
  -- the whole of the secret ballot, and the creator is not exempt. The column
  -- is the same disclosure as the badge, so it stays empty too.
  perform tests.assert_null('a poll still taking votes stores no winner',
    v_row.winner_settled_at);
  perform tests.assert_null('and no name to go with it', v_row.winner_name);

  perform tests.sign_in('voter2@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);

  select * into v_row from polls where id = v_poll;
  perform tests.assert_eq('the ballot that completes it settles the winner',
    v_row.winner_name, 'Apple');
end $$;

-- ---------------------------------------------------------------------------
-- Closed, reset, closed again.
-- ---------------------------------------------------------------------------

do $$
declare
  v_poll uuid;
  v_row polls;
begin
  -- An open poll, because that is the one that reveals on the close alone and
  -- so exercises the close/reopen path rather than the turnout one.
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Lunch', null,
                        array['Apple', 'Banana'],
                        array[]::text[], 'open', false, false);

  perform open_poll_submit(v_poll, tests.open_scores(v_poll, array[5, 0]), 'key-1');
  perform tests.sign_in('creator@example.com');

  select * into v_row from polls where id = v_poll;
  perform tests.assert_null('an open poll stores nothing until it is closed',
    v_row.winner_settled_at);

  perform close_poll(v_poll);
  select * into v_row from polls where id = v_poll;
  perform tests.assert_eq('closing works the winner out', v_row.winner_name, 'Apple');

  -- The whole reason the answer moved out of the browser. A reset deletes
  -- every vote and reopens the poll, and it is announced to nobody -- so an
  -- answer cached anywhere but here outlives the votes it was made of.
  perform reset_poll(v_poll);
  select * into v_row from polls where id = v_poll;
  perform tests.assert_null('a reset takes the answer back', v_row.winner_name);
  perform tests.assert_null('and says it has none, rather than none yet',
    v_row.winner_settled_at);

  -- Voting again, the other way, and closing again: a poll that finishes
  -- twice has two results, and the second one is the one it reports.
  perform open_poll_submit(v_poll, tests.open_scores(v_poll, array[0, 5]), 'key-1');
  perform tests.sign_in('creator@example.com');
  perform close_poll(v_poll);

  select * into v_row from polls where id = v_poll;
  perform tests.assert_eq('and a second finish gives the second answer',
    v_row.winner_name, 'Banana');
  perform tests.assert_eq('which is still the winner the results page names',
    v_row.winner_name, tests.winner(poll_tally(v_poll)));
end $$;

-- ---------------------------------------------------------------------------
-- A reset that reopens a poll nobody ever closed.
-- ---------------------------------------------------------------------------

do $$
declare
  v_poll uuid;
  v_row polls;
begin
  -- An invite poll at full turnout was revealed without ever being closed, so
  -- reset_poll's `closed_at = null` writes the null it already held and the
  -- update it makes cannot be what takes the winner back. The ballots going
  -- away is.
  v_poll := tests.seed_poll(array['Apple', 'Banana'], array[[5, 0], [5, 0]]);

  select * into v_row from polls where id = v_poll;
  perform tests.assert_eq('everyone having voted settles the winner',
    v_row.winner_name, 'Apple');
  perform tests.assert_null('with the poll never having been closed',
    v_row.closed_at);

  perform reset_poll(v_poll);
  select * into v_row from polls where id = v_poll;
  perform tests.assert_null('and clearing the ballots takes it back',
    v_row.winner_settled_at);
end $$;

-- ---------------------------------------------------------------------------
-- A tie is an answer, not a missing one.
-- ---------------------------------------------------------------------------

do $$
declare
  v_poll uuid;
  v_row polls;
begin
  -- Two options scored identically by everyone: level on preference, on
  -- points and on five-star ballots, which is the one case STAR cannot
  -- settle. See 05_unresolved_tie.
  v_poll := tests.seed_poll(array['Apple', 'Banana'], array[[3, 3], [3, 3]]);

  select * into v_row from polls where id = v_poll;

  perform tests.assert_null('a poll that elected nobody names nobody',
    v_row.winner_name);
  -- The distinction the two columns exist for. Without it the badge cannot
  -- tell *Tied* from *Results ready*, and drawing the first where the second
  -- is true would be a wrong answer where this is only a missing one.
  perform tests.assert_eq('but it has been asked, and says so',
    v_row.winner_settled_at is not null, true);
end $$;

-- ---------------------------------------------------------------------------
-- An invitee coming off the list, which is the crossing with no vote in it.
-- ---------------------------------------------------------------------------

do $$
declare
  v_poll uuid;
  v_row polls;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Lunch', null,
                        array['Apple', 'Banana'],
                        array['voter1@example.com', 'voter2@example.com',
                              'voter3@example.com'],
                        'invite', true, false);

  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);
  perform tests.sign_in('voter2@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);

  perform tests.sign_in('creator@example.com');
  select * into v_row from polls where id = v_poll;
  perform tests.assert_null('two of three voters is not a result yet',
    v_row.winner_settled_at);

  -- Removing the person the poll is still waiting for carries it over the
  -- line without a vote being cast, which is why this one is a trigger on
  -- invited_voters rather than something the vote functions could do.
  delete from invited_voters where poll_id = v_poll and email = 'voter3@example.com';

  select * into v_row from polls where id = v_poll;
  perform tests.assert_eq('and taking them off the list settles it',
    v_row.winner_name, 'Apple');
end $$;

-- ---------------------------------------------------------------------------
-- Every question of a group, not just the one that stopped.
-- ---------------------------------------------------------------------------

do $$
declare
  v_questions uuid[];
  v_first polls;
  v_second polls;
begin
  v_questions := tests.seed_group(
    array[
      row('Lunch', array['Apple', 'Banana'])::tests.question,
      row('Drink', array['Tea', 'Coffee'])::tests.question
    ],
    array['voter1@example.com']);

  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_questions[1], array[5, 0]);

  select * into v_first from polls where id = v_questions[1];
  -- Results unlock for a poll of several questions when all of them have
  -- stopped, so answering the first one settles nothing at all -- not even
  -- the question that was answered.
  perform tests.assert_null('one question of two answered settles nothing',
    v_first.winner_settled_at);

  perform tests.cast_ballot(v_questions[2], array[0, 5]);

  select * into v_first from polls where id = v_questions[1];
  select * into v_second from polls where id = v_questions[2];

  -- The point of walking the group. The ballot that opened the gate was cast
  -- on question two; question one's answer has to arrive with it, because
  -- nothing is ever going to happen to question one again.
  perform tests.assert_eq('finishing the last question settles the first',
    v_first.winner_name, 'Apple');
  perform tests.assert_eq('and the last one too', v_second.winner_name, 'Coffee');
end $$;

-- ---------------------------------------------------------------------------
-- What the three reads carry.
-- ---------------------------------------------------------------------------

do $$
declare
  v_poll uuid;
  v_open uuid;
  v_status record;
  v_listed record;
  v_view jsonb;
begin
  v_poll := tests.seed_poll(array['Apple', 'Banana'], array[[5, 0], [5, 0]]);

  perform tests.sign_in('creator@example.com');

  select * into v_status from poll_status(v_poll);
  perform tests.assert_eq('the poll page reads the winner off its own status',
    v_status.winner_name, 'Apple');
  perform tests.assert_eq('and is told the answer was worked out',
    v_status.winner_settled, true);

  select * into v_listed from list_polls(50, 0) where id = v_poll;
  -- The screen this whole change is for: the badge on a finished card now
  -- arrives with the card, and the list runs no election to produce it.
  perform tests.assert_eq('and the list carries it on the row',
    v_listed.winner_name, 'Apple');
  perform tests.assert_eq('with the same settled flag beside it',
    v_listed.winner_settled, true);
  perform tests.assert_eq('and still reports the results as available',
    v_listed.results_available, true);

  -- The share link's own view. This page has no account, so it could never
  -- ask poll_winners() at all; its badge used to be filled in from whatever
  -- tally the card underneath it happened to fetch.
  perform tests.sign_in('creator@example.com');
  v_open := create_poll('Lunch', null, array['Apple', 'Banana'],
                        array[]::text[], 'open', false, false);
  perform open_poll_submit(v_open, tests.open_scores(v_open, array[5, 0]), 'key-1');
  perform tests.sign_in('creator@example.com');

  v_view := open_poll_view(v_open);
  perform tests.assert_eq('an open poll still taking votes names nobody',
    v_view->>'winner_settled', 'false');
  perform tests.assert_null('and no name with it', v_view->>'winner_name');

  perform close_poll(v_open);
  v_view := open_poll_view(v_open);
  perform tests.assert_eq('and closing puts the winner on the view',
    v_view->>'winner_name', 'Apple');
  perform tests.assert_eq('with the flag that says it was worked out',
    v_view->>'winner_settled', 'true');
end $$;

-- ---------------------------------------------------------------------------
-- The function the old browsers call.
-- ---------------------------------------------------------------------------

do $$
declare
  v_poll uuid;
  v_row record;
begin
  -- poll_winners() reads the column now instead of running an election.
  -- Nothing in the app calls it; a browser holding the previous build does,
  -- for as long as a deploy takes, and it has to keep answering.
  v_poll := tests.seed_poll(array['Apple', 'Banana'], array[[5, 0], [5, 0]]);

  perform tests.sign_in('creator@example.com');
  select * into v_row from poll_winners(array[v_poll]);

  perform tests.assert_eq('poll_winners still names the winner',
    v_row.winner_name, 'Apple');
  perform tests.assert_eq('for the poll it was asked about', v_row.poll_id, v_poll);

  -- And still answers only for polls the caller can see: "not yours" is no
  -- row at all, which is a different answer from "no winner".
  perform tests.sign_in('stranger@example.com');
  perform tests.assert_eq('and nothing at all to somebody outside the poll',
    (select count(*)::int from poll_winners(array[v_poll])), 0);
end $$;

rollback;

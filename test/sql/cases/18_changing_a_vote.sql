-- A voter can change their vote until the results are out, and not one moment
-- after.
--
-- The window is the whole point. "Still open" and "still sealed" are two
-- different windows in this app: an invite poll reveals itself the moment its
-- last invitee votes, with nobody closing anything, so a revision allowed
-- until `closed_at` would be a revision allowed against a tally the voter has
-- already read. Every assertion below about a refusal is really about that
-- line being drawn on the reveal rather than on the close.
--
-- The rest of it is what a revision must leave alone. It replaces scores and
-- never withdraws a ballot, so turnout does not move, and it tells nobody,
-- because nothing anyone can see before the reveal is derived from a score.

begin;

do $$
declare
  v_creator uuid;
  v_poll uuid;
  v_other uuid;
  v_closed uuid;
  v_open uuid;
  v_pizza uuid;
  v_sushi uuid;
  v_tacos uuid;
  v_foreign uuid;
  v_ballot uuid;
  v_scores jsonb;
  v_view jsonb;
  v_tally jsonb;
begin
  v_creator := tests.sign_in('creator@example.com');

  v_poll := create_poll('Lunch', null, array['Pizza', 'Sushi', 'Tacos'],
                        array['voter1@example.com', 'voter2@example.com',
                              'voter3@example.com'],
                        'invite', true, false);

  select id into v_pizza from candidates where poll_id = v_poll and name = 'Pizza';
  select id into v_sushi from candidates where poll_id = v_poll and name = 'Sushi';
  select id into v_tacos from candidates where poll_id = v_poll and name = 'Tacos';

  -- A second poll, only so there is an option id that belongs to somebody
  -- else's ballot.
  v_other := create_poll('Dinner', null, array['Curry', 'Ramen'],
                         array['voter1@example.com'], 'invite', true, false);
  select id into v_foreign from candidates where poll_id = v_other and name = 'Curry';

  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_poll, jsonb_build_array(
    jsonb_build_object('candidate_id', v_pizza, 'score', 5),
    jsonb_build_object('candidate_id', v_sushi, 'score', 0),
    jsonb_build_object('candidate_id', v_tacos, 'score', 0)));

  perform tests.sign_in('voter2@example.com');
  perform submit_ballot(v_poll, jsonb_build_array(
    jsonb_build_object('candidate_id', v_pizza, 'score', 4),
    jsonb_build_object('candidate_id', v_sushi, 'score', 0),
    jsonb_build_object('candidate_id', v_tacos, 'score', 0)));

  -- ------------------------------------------------------------------
  -- Two of three have voted, so nothing has been revealed and a vote is
  -- still a voter's to take back.
  -- ------------------------------------------------------------------

  perform tests.sign_in('voter1@example.com');

  perform tests.assert_eq('nothing is out while an invitee is still to vote',
    (select results_available from poll_status(v_poll)), false);
  perform tests.assert_eq('and the poll is not closed either, which is the point',
    (select is_closed from poll_status(v_poll)), false);
  perform tests.assert_raises('so the results themselves are still shut',
    format('select assert_results_readable(%L)', v_poll),
    'until everyone has voted');

  perform tests.assert_eq('a voter can read their own ballot back',
    poll_ballot_scores(v_poll),
    jsonb_build_object(v_pizza::text, 5, v_sushi::text, 0, v_tacos::text, 0));

  perform tests.forget_signals();

  perform revise_ballot(v_poll, jsonb_build_array(
    jsonb_build_object('candidate_id', v_pizza, 'score', 0),
    jsonb_build_object('candidate_id', v_sushi, 'score', 1),
    jsonb_build_object('candidate_id', v_tacos, 'score', 5)));

  perform tests.assert_eq('the new scores are the ballot now',
    poll_ballot_scores(v_poll),
    jsonb_build_object(v_pizza::text, 0, v_sushi::text, 1, v_tacos::text, 5));

  -- The whole reason a revision can be allowed to say nothing: everything a
  -- watching page renders before the reveal is read off ballot rows, and an
  -- update moves none of them.
  perform tests.assert_eq('a ballot changed is still one ballot',
    (select voted_count from poll_status(v_poll)), 2);
  perform tests.assert_eq('and the ballot itself is the same row',
    (select count(*)::int from ballots
     where poll_id = v_poll and voter_id = auth.uid()), 1);
  perform tests.assert_eq('nobody is told a vote changed',
    tests.signalled(), array[]::text[]);

  perform tests.assert_eq('the change is dated',
    (select revised_at is not null from ballots
     where poll_id = v_poll and voter_id = auth.uid()), true);

  -- Nothing of what was scored before survives. A revision is not an
  -- amendment on the record; the poll promised a secret ballot and keeping
  -- two versions of one would be a worse promise than it made.
  perform tests.assert_eq('and leaves no earlier version behind',
    (select count(*)::int from scores s
     join ballots b on b.id = s.ballot_id
     where b.poll_id = v_poll and b.voter_id = auth.uid()), 3);

  perform tests.sign_in('voter2@example.com');
  perform tests.assert_eq('and touches nobody else''s ballot',
    poll_ballot_scores(v_poll),
    jsonb_build_object(v_pizza::text, 4, v_sushi::text, 0, v_tacos::text, 0));

  -- ------------------------------------------------------------------
  -- What a revision will not accept.
  -- ------------------------------------------------------------------

  perform tests.sign_in('voter1@example.com');

  perform tests.assert_raises('a ballot is scored in full or not at all',
    format('select revise_ballot(%L, %L::jsonb)', v_poll,
      jsonb_build_array(jsonb_build_object('candidate_id', v_pizza, 'score', 5))),
    'a score for every option');

  -- The failure an update has and an insert does not: score one option twice
  -- and another keeps whatever it had, so a ballot half-rewritten would go
  -- in looking complete.
  perform tests.assert_raises('and one score per option, not two for one',
    format('select revise_ballot(%L, %L::jsonb)', v_poll,
      jsonb_build_array(
        jsonb_build_object('candidate_id', v_pizza, 'score', 5),
        jsonb_build_object('candidate_id', v_pizza, 'score', 4),
        jsonb_build_object('candidate_id', v_sushi, 'score', 3))),
    'a score for every option');

  perform tests.assert_raises('stars run from zero to five here too',
    format('select revise_ballot(%L, %L::jsonb)', v_poll,
      jsonb_build_array(
        jsonb_build_object('candidate_id', v_pizza, 'score', 9),
        jsonb_build_object('candidate_id', v_sushi, 'score', 0),
        jsonb_build_object('candidate_id', v_tacos, 'score', 0))),
    'between 0 and 5');

  perform tests.assert_raises('and the options have to be this poll''s',
    format('select revise_ballot(%L, %L::jsonb)', v_poll,
      jsonb_build_array(
        jsonb_build_object('candidate_id', v_pizza, 'score', 5),
        jsonb_build_object('candidate_id', v_sushi, 'score', 0),
        jsonb_build_object('candidate_id', v_foreign, 'score', 5))),
    'Invalid option');

  perform tests.assert_eq('a refused revision changes nothing',
    poll_ballot_scores(v_poll),
    jsonb_build_object(v_pizza::text, 0, v_sushi::text, 1, v_tacos::text, 5));

  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 5))
  into v_scores from candidates where poll_id = v_poll;

  perform tests.sign_in('voter3@example.com');
  perform tests.assert_raises('there is nothing to change until you have voted',
    format('select revise_ballot(%L, %L::jsonb)', v_poll, v_scores),
    'not voted in this poll yet');
  perform tests.assert_raises('and nothing to read back either',
    format('select poll_ballot_scores(%L)', v_poll),
    'not voted in this poll yet');

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('somebody else''s poll is not found, as ever',
    format('select revise_ballot(%L, %L::jsonb)', v_poll, v_scores),
    'Poll not found');

  -- ------------------------------------------------------------------
  -- The last vote closes the window, and closes nothing else.
  -- ------------------------------------------------------------------

  perform tests.sign_in('voter3@example.com');
  perform submit_ballot(v_poll, v_scores);

  perform tests.assert_eq('the last invitee voting reveals the results',
    (select results_available from poll_status(v_poll)), true);
  perform tests.assert_eq('without the poll being closed at all',
    (select is_closed from poll_status(v_poll)), false);

  -- The one rule this whole feature turns on. A window drawn on `closed_at`
  -- would be wide open here, with the tally, the ranking and the winner all
  -- on screen for everyone in the poll to score against.
  perform tests.sign_in('voter1@example.com');
  perform tests.assert_raises('a vote cannot be changed against a tally its voter has read',
    format('select revise_ballot(%L, %L::jsonb)', v_poll,
      jsonb_build_array(
        jsonb_build_object('candidate_id', v_pizza, 'score', 5),
        jsonb_build_object('candidate_id', v_sushi, 'score', 0),
        jsonb_build_object('candidate_id', v_tacos, 'score', 0))),
    'results are out');

  -- And what was revised is what was counted.
  v_tally := get_poll_results(v_poll);
  perform tests.assert_eq('the revised ballot is the one that got counted',
    tests.total_score(v_tally, 'Tacos'), 10);
  perform tests.assert_eq('and the ballot it replaced counted for nothing',
    tests.total_score(v_tally, 'Pizza'), 9);

  -- One rule, in one place. `poll_results_revealed()` is what refuses a
  -- revision; `poll_status` and `list_polls` are what the screen offering it
  -- is drawn from. Two of those now read the third, and this is the pin on
  -- the one that still carries its own copy -- a disagreement here is a
  -- button that offers something the database will refuse.
  perform tests.assert_eq('the rule that refuses agrees with the one on screen',
    (select poll_results_revealed(p) from polls p where p.id = v_poll),
    (select results_available from poll_status(v_poll)));
  perform tests.assert_eq('and with the one the poll list shows',
    (select results_available from list_polls(10, 0) where id = v_poll), true);
  -- 0031's gate answers from the same function now, so the results opening
  -- and the revisions closing are one event rather than two that coincide.
  -- get_poll_results goes through that gate, so reading a tally out of it at
  -- the moment a revision was refused is the assertion.
  perform tests.assert_eq('the results opened in the same breath as revisions closed',
    (get_poll_results(v_poll) ->> 'voter_count')::int, 3);
  perform tests.assert_eq('a poll nobody has voted in has nothing to reveal',
    (select poll_results_revealed(p) from polls p where p.id = v_other), false);

  -- ------------------------------------------------------------------
  -- Closing says so, rather than saying the results are out. A poll closed
  -- before anyone voted has no results to be out.
  -- ------------------------------------------------------------------

  perform tests.sign_in('creator@example.com');
  v_closed := create_poll('Coffee', null, array['Flat white', 'Latte'],
                          array['voter1@example.com', 'voter2@example.com'],
                          'invite', true, false);

  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 3))
  into v_scores from candidates where poll_id = v_closed;

  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_closed, v_scores);

  perform tests.sign_in('creator@example.com');
  perform close_poll(v_closed);

  perform tests.sign_in('voter1@example.com');
  perform tests.assert_raises('a closed poll says it is closed',
    format('select revise_ballot(%L, %L::jsonb)', v_closed, v_scores),
    'has been closed');

  -- ------------------------------------------------------------------
  -- The same window through a share link, where the voter_key is what says
  -- which ballot is yours.
  -- ------------------------------------------------------------------

  perform tests.sign_in('creator@example.com');
  v_open := create_poll('Film night', null, array['Alien', 'Aliens'],
                        null, 'open', true, false);

  select id into v_pizza from candidates where poll_id = v_open and name = 'Alien';
  select id into v_sushi from candidates where poll_id = v_open and name = 'Aliens';

  perform open_poll_submit(v_open, jsonb_build_array(
    jsonb_build_object('candidate_id', v_pizza, 'score', 5),
    jsonb_build_object('candidate_id', v_sushi, 'score', 1)), 'key-a', 'Ada');

  v_view := open_poll_view(v_open, 'key-a');
  perform tests.assert_eq('the link hands a voter their own ballot back',
    v_view -> 'your_scores',
    jsonb_build_object(v_pizza::text, 5, v_sushi::text, 1));

  -- A json null rather than a missing key, like `your_name` beside it: the
  -- shape of the answer does not depend on who is asking.
  v_view := open_poll_view(v_open, 'key-b');
  perform tests.assert_eq('and hands nobody else one',
    v_view -> 'your_scores', 'null'::jsonb);

  perform tests.forget_signals();

  perform open_poll_revise(v_open, jsonb_build_array(
    jsonb_build_object('candidate_id', v_pizza, 'score', 2),
    jsonb_build_object('candidate_id', v_sushi, 'score', 5)), 'key-a');

  v_view := open_poll_view(v_open, 'key-a');
  perform tests.assert_eq('a revision through the link replaces the scores',
    v_view -> 'your_scores',
    jsonb_build_object(v_pizza::text, 2, v_sushi::text, 5));
  perform tests.assert_eq('still one vote in the poll',
    (v_view ->> 'voted_count')::int, 1);

  -- The name is the one part of an open ballot other people are already
  -- reading, so it is the one part a revision does not touch.
  perform tests.assert_eq('and the roster still says the same name',
    v_view -> 'voters', jsonb_build_array('Ada'));
  perform tests.assert_eq('nobody is told through the link either',
    tests.signalled(), array[]::text[]);

  perform tests.assert_raises('a key that cast no ballot has none to change',
    format('select open_poll_revise(%L, %L::jsonb, %L)', v_open,
      jsonb_build_array(
        jsonb_build_object('candidate_id', v_pizza, 'score', 5),
        jsonb_build_object('candidate_id', v_sushi, 'score', 5)), 'key-b'),
    'not voted in this poll yet');

  perform tests.assert_raises('and no key at all reaches no ballot',
    format('select open_poll_revise(%L, %L::jsonb, %L)', v_open,
      jsonb_build_array(
        jsonb_build_object('candidate_id', v_pizza, 'score', 5),
        jsonb_build_object('candidate_id', v_sushi, 'score', 5)), '  '),
    'Missing voter key');

  -- An open poll reveals on close and only on close, so for it the two
  -- windows really are the same one.
  perform tests.sign_in('creator@example.com');
  perform close_poll(v_open);

  perform tests.assert_raises('closing an open poll ends its revisions',
    format('select open_poll_revise(%L, %L::jsonb, %L)', v_open,
      jsonb_build_array(
        jsonb_build_object('candidate_id', v_pizza, 'score', 5),
        jsonb_build_object('candidate_id', v_sushi, 'score', 5)), 'key-a'),
    'has been closed');
end $$;

rollback;

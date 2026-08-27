-- Everybody in a poll is told when its results are ready.
--
-- The email itself cannot be tested here -- pg_net does not exist in this
-- database, and send_results_ready_email() returns without doing anything when
-- it finds no mailer. What can be tested is everything around it: whether the
-- poll has a result at all, who would be told, and the notice row that makes
-- the announcement happen exactly once and happen again after a reset.

begin;

do $$
declare
  v_creator uuid;
  v_poll uuid;
  v_open uuid;
  v_closed uuid;
  v_group uuid[];
  v_scores jsonb;
begin
  v_creator := tests.sign_in('creator@example.com');

  -- ---------------------------------------------------------------------
  -- An invite poll: the last vote is what crosses the line.
  -- ---------------------------------------------------------------------
  v_poll := create_poll('Lunch', null, array['Pizza', 'Sushi'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false);

  perform tests.assert_eq('a poll nobody has voted in has no result to announce',
    poll_results_ready((select p from polls p where p.id = v_poll)), false);
  perform tests.assert_eq('and nothing has been announced about it',
    (select count(*)::int from results_notices where poll_id = v_poll), 0);

  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 1]);

  perform tests.assert_eq('one vote of two is still a poll in progress',
    poll_results_ready((select p from polls p where p.id = v_poll)), false);
  perform tests.assert_eq('so still nothing announced',
    (select count(*)::int from results_notices where poll_id = v_poll), 0);

  perform tests.sign_in('voter2@example.com');
  perform tests.cast_ballot(v_poll, array[2, 4]);

  perform tests.assert_eq('the last ballot unlocks the results',
    poll_results_ready((select p from polls p where p.id = v_poll)), true);
  perform tests.assert_eq('and the poll is announced, once',
    (select count(*)::int from results_notices where poll_id = v_poll), 1);

  -- Everyone in the poll, creator included, because nobody closed it: the
  -- last vote is what ended it, and that is news to the creator like anybody
  -- else. Every invitee is on the list whether or not they voted.
  perform tests.assert_eq('everybody in a poll that finished on its own is told',
    (select array_agg(a order by a)
       from poll_results_audience((select p from polls p where p.id = v_poll), null) a),
    array['creator@example.com', 'voter1@example.com', 'voter2@example.com']);

  -- Except the one who finished it. voter2's own ballot is what crossed the
  -- line, so the letter saying the line has been crossed is addressed to
  -- somebody watching it happen -- the same email the creator is spared when
  -- they close a poll themselves.
  perform tests.assert_eq('but not the voter whose own ballot ended it',
    (select array_agg(a order by a)
       from poll_results_audience((select p from polls p where p.id = v_poll),
                                  'voter2@example.com') a),
    array['creator@example.com', 'voter1@example.com']);
  -- The list is stored lowercased and an address off a token arrives that
  -- way, but the same inbox in any other case is the same inbox.
  perform tests.assert_eq('whatever case their address arrives in',
    (select array_agg(a order by a)
       from poll_results_audience((select p from polls p where p.id = v_poll),
                                  'Voter2@Example.COM') a),
    array['creator@example.com', 'voter1@example.com']);

  -- ---------------------------------------------------------------------
  -- A reset takes the announcement back, so a poll that finishes again is
  -- announced again.
  -- ---------------------------------------------------------------------
  perform tests.sign_in('creator@example.com');
  perform reset_poll(v_poll);

  perform tests.assert_eq('a reset poll has no result again',
    poll_results_ready((select p from polls p where p.id = v_poll)), false);
  perform tests.assert_eq('and its announcement is forgotten',
    (select count(*)::int from results_notices where poll_id = v_poll), 0);

  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 1]);
  perform tests.sign_in('voter2@example.com');
  perform tests.cast_ballot(v_poll, array[2, 4]);

  perform tests.assert_eq('finishing a second time announces a second time',
    (select count(*)::int from results_notices where poll_id = v_poll), 1);

  -- ---------------------------------------------------------------------
  -- Closing is the other way across the line, and an open poll's audience
  -- is its creator: nobody else in it ever gave an address.
  -- ---------------------------------------------------------------------
  perform tests.sign_in('creator@example.com');
  v_open := create_poll('Film night', null, array['Dune', 'Arrival'],
                        array[]::text[], 'open', true, false);

  perform open_poll_submit(
    v_open,
    tests.open_scores(v_open, array[5, 2]),
    'voter-key-1', 'Robin');

  perform tests.assert_eq('an open poll runs until its creator closes it',
    (select count(*)::int from results_notices where poll_id = v_open), 0);

  perform close_poll(v_open);

  perform tests.assert_eq('closing crosses the line',
    (select count(*)::int from results_notices where poll_id = v_open), 1);
  -- And there is nobody to write to. Its voters gave no addresses, and the
  -- one person it could have written to is the person who closed it.
  perform tests.assert_null('but an open poll has nobody left to tell',
    (select array_agg(a order by a)
       from poll_results_audience((select p from polls p where p.id = v_open),
                                  'creator@example.com') a));

  -- ---------------------------------------------------------------------
  -- An invite poll closed by hand: everyone but the creator, who did the
  -- closing and is on the invite list besides.
  -- ---------------------------------------------------------------------
  v_closed := create_poll('Offsite', null, array['Lisbon', 'Porto'],
                          array['creator@example.com', 'voter1@example.com',
                                'voter2@example.com'],
                          'invite', true, false);

  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_closed, array[5, 2]);

  perform tests.sign_in('creator@example.com');
  perform close_poll(v_closed);

  perform tests.assert_eq('a poll closed by hand has a result too',
    poll_results_ready((select p from polls p where p.id = v_closed)), true);
  perform tests.assert_eq('and is announced like any other',
    (select count(*)::int from results_notices where poll_id = v_closed), 1);
  perform tests.assert_eq('to everyone invited except the creator, who closed it',
    (select array_agg(a order by a)
       from poll_results_audience((select p from polls p where p.id = v_closed),
                                  'creator@example.com') a),
    array['voter1@example.com', 'voter2@example.com']);

  -- ---------------------------------------------------------------------
  -- A poll of several questions is one result and one announcement, filed
  -- against the question an invitation would have named.
  -- ---------------------------------------------------------------------
  v_group := tests.seed_group(array[
    row('Lunch', array['Pizza', 'Sushi'])::tests.question,
    row('Time',  array['Noon',  'One'])::tests.question
  ], array['voter1@example.com']);

  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_group[1], array[5, 1]);

  perform tests.assert_eq('question 1 answered is not the poll answered',
    poll_results_ready((select p from polls p where p.id = v_group[1])), false);
  perform tests.assert_eq('so the poll is not announced yet',
    (select count(*)::int from results_notices
      where poll_id = any(v_group)), 0);

  perform tests.cast_ballot(v_group[2], array[3, 4]);

  perform tests.assert_eq('answering the last question finishes the poll',
    poll_results_ready((select p from polls p where p.id = v_group[2])), true);
  perform tests.assert_eq('and the whole poll is announced exactly once',
    (select count(*)::int from results_notices where poll_id = any(v_group)), 1);
  perform tests.assert_eq('against question 1, which is where the link goes',
    (select count(*)::int from results_notices where poll_id = v_group[1]), 1);

  raise notice '  results-ready notices ok';
end $$;

rollback;

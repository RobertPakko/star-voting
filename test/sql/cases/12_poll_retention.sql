-- Polls do not stay forever, and what decides when they go.
--
-- purge_old_polls() is the only thing in this app that deletes a poll nobody
-- asked it to delete, so four things have to hold: it takes the polls older
-- than the window and everything hanging off them, it leaves a poll inside
-- the window alone, nothing that happens inside a poll moves its date, and
-- the date poll_status() shows a reader is the date the purge acts on.

begin;

do $$
declare
  v_fresh uuid;
  v_old uuid;
  v_deleted int;
begin
  v_fresh := tests.seed_poll(
    array['Apple', 'Banana'],
    array[[5, 1]],
    'Made this week');

  v_old := tests.seed_poll(
    array['Apple', 'Banana'],
    array[[5, 1],
          [4, 0]],
    'Made last spring');
  perform tests.age_poll(v_old, interval '7 months');

  v_deleted := purge_old_polls();

  perform tests.assert_eq('one poll was past the window', v_deleted, 1);
  perform tests.assert_eq('and it is gone',
    (select count(*)::int from polls where id = v_old), 0);
  perform tests.assert_eq('a poll inside the window is left alone',
    (select count(*)::int from polls where id = v_fresh), 1);

  -- Deleting the poll row is the whole of the purge; the cascades are what
  -- make that true, and a poll whose ballots outlived it would be exactly
  -- the storage this is meant to reclaim.
  perform tests.assert_eq('its options went with it',
    (select count(*)::int from candidates where poll_id = v_old), 0);
  perform tests.assert_eq('its invitees went with it',
    (select count(*)::int from invited_voters where poll_id = v_old), 0);
  perform tests.assert_eq('its ballots went with it',
    (select count(*)::int from ballots where poll_id = v_old), 0);
  perform tests.assert_eq('and the scores under those ballots',
    (select count(*)::int from scores s
     join ballots b on b.id = s.ballot_id
     where b.poll_id = v_old), 0);
end $$;

do $$
declare
  v_voted uuid;
  v_closed uuid;
  v_deleted int;
begin
  -- Two polls opened seven months ago, both still being used today. Dating
  -- the window from the last thing that happened would keep them both --
  -- and would keep an open poll that nobody ever closes forever, which is
  -- the poll this is here to clear out. The clock is the creation date, so
  -- neither of these survives.
  perform tests.sign_in('creator@example.com');
  v_voted := create_poll('Voted in today', null,
                         array['Apple', 'Banana'],
                         array['voter1@example.com', 'voter2@example.com'],
                         'invite', true, false);
  perform tests.age_poll(v_voted, interval '7 months');

  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_voted, (
    select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 5))
    from candidates where poll_id = v_voted));

  perform tests.sign_in('creator@example.com');
  v_closed := create_poll('Closed today', null,
                          array['Apple', 'Banana'],
                          array['voter1@example.com'],
                          'invite', true, false);
  perform tests.age_poll(v_closed, interval '7 months');
  perform close_poll(v_closed);

  v_deleted := purge_old_polls();

  perform tests.assert_eq('both went', v_deleted, 2);
  perform tests.assert_eq('a vote today does not extend a poll made last spring',
    (select count(*)::int from polls where id = v_voted), 0);
  perform tests.assert_eq('nor does closing it today',
    (select count(*)::int from polls where id = v_closed), 0);
end $$;

do $$
declare
  v_inside uuid;
  v_outside uuid;
  v_deleted int;
begin
  perform tests.sign_in('creator@example.com');

  v_inside := create_poll('Six months tomorrow', null,
                          array['Apple', 'Banana'], array['voter1@example.com'],
                          'invite', true, false);
  perform tests.age_poll(v_inside, interval '6 months' - interval '1 day');

  v_outside := create_poll('Six months yesterday', null,
                           array['Apple', 'Banana'], array['voter1@example.com'],
                           'invite', true, false);
  perform tests.age_poll(v_outside, interval '6 months' + interval '1 day');

  v_deleted := purge_old_polls();

  perform tests.assert_eq('only the poll past the window went', v_deleted, 1);
  perform tests.assert_eq('the one a day short of it stayed',
    (select count(*)::int from polls where id = v_inside), 1);
  perform tests.assert_eq('the one a day past it did not',
    (select count(*)::int from polls where id = v_outside), 0);
end $$;

do $$
declare
  v_poll uuid;
  v_created timestamptz;
  v_expires timestamptz;
begin
  -- What the poll page tells a reader, and what the purge will do, are the
  -- same arithmetic on the same column.
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Says when it goes', null,
                        array['Apple', 'Banana'], array['voter1@example.com'],
                        'invite', true, false);

  select created_at into v_created from polls where id = v_poll;
  select expires_at into v_expires from poll_status(v_poll);

  perform tests.assert_eq('the date is six months from creation',
    v_expires, v_created + interval '6 months');

  -- A ballot arrives, and the date the creator was given does not move.
  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_poll, (
    select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 5))
    from candidates where poll_id = v_poll));

  perform tests.sign_in('creator@example.com');
  perform tests.assert_eq('and voting in the poll does not move it',
    (select expires_at from poll_status(v_poll)), v_expires);

  -- Nor does closing it, which is the last thing that can happen to a poll.
  perform close_poll(v_poll);
  perform tests.assert_eq('nor does closing it',
    (select expires_at from poll_status(v_poll)), v_expires);
end $$;

rollback;

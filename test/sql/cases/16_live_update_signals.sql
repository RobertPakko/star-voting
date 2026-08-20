-- Every change a live page is waiting for announces itself, and nothing else
-- does.
--
-- Pages no longer re-read themselves on a timer; they hold a socket and
-- re-read when the database says something moved. That makes "did this change
-- announce itself" a correctness question rather than a performance one: a
-- change that stays quiet is a page that sits there showing the wrong number
-- until its reader thinks to reload.
--
-- The two failures worth guarding are opposite. A change that says nothing is
-- a stale page. A change that says something once per row is a page that
-- re-reads the poll twenty times because one reset cleared twenty ballots --
-- so the counts below are as much the point as the topics.
--
-- What is *not* under test here is delivery. On Supabase, realtime.send()
-- writes to realtime.messages and the Realtime service fans it out; the shim
-- keeps the write and drops the service. Who gets told and when is this
-- repo's business, and that is what these assertions are about.

begin;

do $$
declare
  v_poll uuid;
  v_open uuid;
  v_old uuid;
  v_token text;
  v_scores jsonb;
begin
  perform tests.sign_in('creator@example.com');

  -- ------------------------------------------------------------------
  -- A vote, the change every other page in the app is waiting for.
  -- ------------------------------------------------------------------

  v_poll := create_poll('Lunch', null, array['Pizza', 'Sushi'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false);

  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 5))
  into v_scores from candidates where poll_id = v_poll;

  perform tests.forget_signals();
  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_poll, v_scores);

  perform tests.assert_eq('a vote announces the poll it was cast in',
    tests.signals(tests.poll_topic(v_poll)), 1);
  perform tests.assert_eq('and announces it to nobody else',
    tests.signalled(), array[tests.poll_topic(v_poll)]);

  -- The whole design in one assertion: the message says that the poll moved
  -- and refuses to say how. Everyone who hears it re-reads the poll through
  -- the RPC that already decides what they are allowed to see, so no rule
  -- about who sees what had to be restated to make this work.
  perform tests.assert_eq('the signal carries no data at all',
    (select payload from realtime.messages limit 1), '{}'::jsonb);

  -- ------------------------------------------------------------------
  -- The rest of what a watched poll can do.
  -- ------------------------------------------------------------------

  perform tests.sign_in('creator@example.com');
  perform tests.forget_signals();
  perform close_poll(v_poll);
  perform tests.assert_eq('closing a poll announces it',
    tests.signals(tests.poll_topic(v_poll)), 1);

  -- Deletes are the half that is easy to forget, and the one that matters
  -- most: a page told only about arrivals would sit there showing a tally
  -- that has just been thrown away.
  perform tests.forget_signals();
  perform reset_poll(v_poll);
  perform tests.assert_eq('clearing a poll and reopening it announces both',
    tests.signals(tests.poll_topic(v_poll)), 2);

  perform tests.forget_signals();
  perform creator_add_option(v_poll, 'Tacos');
  perform tests.assert_eq('an option added announces the poll',
    tests.signals(tests.poll_topic(v_poll)), 1);

  perform tests.forget_signals();
  delete from candidates where poll_id = v_poll and name = 'Tacos';
  perform tests.assert_eq('and an option taken back off announces it too',
    tests.signals(tests.poll_topic(v_poll)), 1);

  -- ------------------------------------------------------------------
  -- One statement, one signal.
  --
  -- reset_poll clears every ballot in one delete and reopens the poll in one
  -- update, so a poll with three votes in it is two statements and two
  -- signals. Row triggers would make it four, and forty on a poll with forty
  -- votes -- each one landing on everybody connected.
  -- ------------------------------------------------------------------

  v_poll := tests.seed_poll(array['Apple', 'Banana'],
                            array[[5, 4], [3, 2], [1, 0]]);

  perform tests.assert_eq('three people voted',
    (select voted_count from poll_status(v_poll)), 3);

  perform tests.forget_signals();
  perform reset_poll(v_poll);
  perform tests.assert_eq('clearing three ballots is one statement, so one signal',
    tests.signals(tests.poll_topic(v_poll)), 2);

  -- ------------------------------------------------------------------
  -- An invite, the one change that has to reach somebody who has never seen
  -- the poll. Their list is subscribed to the polls in front of them, and
  -- this is not one of them yet.
  -- ------------------------------------------------------------------

  perform tests.sign_in('newcomer@example.com');
  perform tests.sign_in('creator@example.com');

  perform tests.forget_signals();
  insert into invited_voters (poll_id, email) values (v_poll, 'newcomer@example.com');

  perform tests.assert_eq('an invite announces the poll',
    tests.signals(tests.poll_topic(v_poll)), 1);
  perform tests.assert_eq('and reaches the list of the person invited',
    tests.signals(tests.user_topic('newcomer@example.com')), 1);

  perform tests.forget_signals();
  insert into invited_voters (poll_id, email) values (v_poll, 'stranger@example.com');
  perform tests.assert_eq('somebody with no account yet has no list to reach',
    tests.signalled(), array[tests.poll_topic(v_poll)]);

  perform tests.forget_signals();
  delete from invited_voters where poll_id = v_poll and email = 'stranger@example.com';
  perform tests.assert_eq('and an invite withdrawn announces the poll',
    tests.signals(tests.poll_topic(v_poll)), 1);

  -- ------------------------------------------------------------------
  -- An open poll is announced twice, because it is watched from two sides:
  -- its creator has the id, and everyone holding the link has only the
  -- token. Announcing the token is what lets the public page subscribe
  -- before its first read instead of after it.
  -- ------------------------------------------------------------------

  v_open := create_poll('Movie night', null, array['Dune', 'Arrival'],
                        array[]::text[], 'open', true, false);
  select public_token into v_token from polls where id = v_open;

  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 4))
  into v_scores from candidates where poll_id = v_open;

  perform tests.forget_signals();
  perform open_poll_submit(v_token, v_scores, 'voter-key-1', 'Ada');

  perform tests.assert_eq('a vote through the link reaches the page holding the id',
    tests.signals(tests.poll_topic(v_open)), 1);
  perform tests.assert_eq('and the page holding only the link',
    tests.signals('poll:' || v_token), 1);

  perform tests.forget_signals();
  perform close_poll(v_open);
  perform tests.assert_eq('closing it reaches both as well',
    tests.signalled(), tests.sorted(array[tests.poll_topic(v_open), 'poll:' || v_token]));

  -- ------------------------------------------------------------------
  -- Nothing is announced on behalf of a poll that is going away. Its rows
  -- cascade out behind it, and without this every delete would broadcast
  -- once per option, invitee and ballot on a poll nobody can read any more.
  -- ------------------------------------------------------------------

  perform tests.forget_signals();
  delete from polls where id = v_open;
  perform tests.assert_eq('a poll being deleted is silent, and so are its rows',
    tests.signalled(), array[]::text[]);

  v_old := tests.seed_poll(array['Apple', 'Banana'], array[[5, 0]], 'Ancient');
  perform close_poll(v_old);
  perform tests.age_poll(v_old, interval '7 months');

  perform tests.forget_signals();
  perform tests.assert_eq('the purge takes the poll',
    purge_old_polls(), 1);
  perform tests.assert_eq('and says nothing to anybody while doing it',
    tests.signalled(), array[]::text[]);
end $$;

rollback;

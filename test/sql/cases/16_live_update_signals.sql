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
-- The unit of a change is the **transaction**, not the statement and not the
-- row. Everything reaches a listener at the commit and says only "re-read",
-- so a second message from the same transaction cannot carry anything the
-- first did not: one re-read afterwards already sees the whole of what
-- happened. That is what announce() holds up, and most of the counts below
-- are 1 because of it.
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
  v_questions uuid[];
  v_scores jsonb;
  v_drop uuid;
  v_bulk uuid;
  v_five jsonb := '[{"name":"One"},{"name":"Two"},{"name":"Three"},
                    {"name":"Four"},{"name":"Five"}]'::jsonb;
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

  -- Both invitees get an account before anything is measured. Being invited
  -- is an address on a list; being *told* needs somewhere to tell, which is
  -- the distinction the stranger further down is about.
  perform tests.sign_in('voter2@example.com');

  perform tests.forget_signals();
  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_poll, v_scores);

  perform tests.assert_eq('a vote announces the poll it was cast in',
    tests.signals(tests.poll_topic(v_poll)), 1);

  -- And the list of everyone the poll is on. A poll list holds no poll id
  -- until it has read one, so it watches its reader rather than the polls in
  -- front of them -- which is what lets it subscribe before its first read
  -- instead of after, and so read once rather than twice.
  --
  -- voter2 has never opened this poll and is told anyway: the question a list
  -- asks is "did anything on me move", and their turnout column just did.
  perform tests.assert_eq('and reaches the list of everyone who can see it',
    tests.signalled(), tests.sorted(array[
      tests.poll_topic(v_poll),
      tests.user_topic('creator@example.com'),
      tests.user_topic('voter1@example.com'),
      tests.user_topic('voter2@example.com')]));

  perform tests.assert_eq('and tells each of those lists exactly once',
    tests.signals(tests.user_topic('voter1@example.com')), 1);

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
  -- Two statements -- the ballots deleted, the poll reopened -- and one
  -- transaction, so one message. A page hearing it re-reads once and sees
  -- both halves; hearing it twice would be the same page reading the same
  -- state again.
  perform tests.forget_signals();
  perform reset_poll(v_poll);
  perform tests.assert_eq('clearing a poll and reopening it is one change, so one message',
    tests.signals(tests.poll_topic(v_poll)), 1);

  perform tests.forget_signals();
  perform creator_add_option(v_poll, 'Tacos');
  perform tests.assert_eq('an option added announces the poll',
    tests.signals(tests.poll_topic(v_poll)), 1);

  perform tests.forget_signals();
  delete from candidates where poll_id = v_poll and name = 'Tacos';
  perform tests.assert_eq('and an option taken back off announces it too',
    tests.signals(tests.poll_topic(v_poll)), 1);

  -- ------------------------------------------------------------------
  -- Options arriving in bulk, which is the case a statement-level trigger
  -- cannot see.
  --
  -- insert_options checks each option against the list as it stands -- for
  -- duplicates, and against the 500 ceiling -- so it loops, and each option
  -- is its own INSERT. Statement triggers counted those one for one: a voter
  -- painting five windows onto a time poll sent five messages, and everybody
  -- watching re-read the poll five times to watch the same list arrive. It
  -- was every bulk path at once, because they all go through that function.
  --
  -- Each of these is one RPC, so one transaction, so one message -- and the
  -- count has to be independent of how many options went in, which is the
  -- whole point of asserting on five rather than on two.
  -- ------------------------------------------------------------------

  -- The guarantee at its source, so it is pinned for writers that do not
  -- exist yet: whatever asks, a topic is told once per transaction.
  perform tests.forget_signals();
  perform announce('poll:test', 'poll_changed');
  perform announce('poll:test', 'poll_changed');
  perform announce('poll:test', 'poll_changed');
  perform tests.assert_eq('a topic asked three times in one transaction is told once',
    tests.signals('poll:test'), 1);
  perform announce('user:test', 'polls_changed');
  perform tests.assert_eq('and a different topic is still told',
    tests.signals('user:test'), 1);

  v_bulk := create_poll('Painting', null, array[]::text[],
                        array['voter1@example.com'], 'invite', true, false,
                        null, true);

  -- A voter inside a poll that is collecting, which is the time-poll case:
  -- one gesture on the calendar is a dozen windows.
  perform tests.sign_in('voter1@example.com');
  perform tests.forget_signals();
  perform suggest_options(v_bulk, v_five);
  perform tests.assert_eq('five options suggested at once is one message',
    tests.signals(tests.poll_topic(v_bulk)), 1);
  perform tests.assert_eq('and the five really did go in',
    (select count(*)::int from candidates where poll_id = v_bulk), 5);

  -- ...and the lists hear once too, rather than once per option.
  perform tests.assert_eq('and each list it is on hears once, not once per option',
    tests.signals(tests.user_topic('creator@example.com')), 1);

  -- The creator adding to a list that is already a ballot.
  perform tests.sign_in('creator@example.com');
  perform finalize_options(v_bulk);
  perform tests.forget_signals();
  perform creator_add_options(v_bulk, '[{"name":"Six"},{"name":"Seven"},{"name":"Eight"}]'::jsonb);
  perform tests.assert_eq('three options added at once is one message',
    tests.signals(tests.poll_topic(v_bulk)), 1);

  -- And the correction that started this: options going and options coming,
  -- in one press. It was a delete statement plus one insert per option.
  select id into v_drop from candidates where poll_id = v_bulk and name = 'One';
  perform tests.forget_signals();
  perform creator_edit_options(v_bulk,
    '[{"name":"Nine"},{"name":"Ten"},{"name":"Eleven"},{"name":"Twelve"}]'::jsonb,
    array[v_drop]);
  perform tests.assert_eq('an edit dropping one option and adding four is one message',
    tests.signals(tests.poll_topic(v_bulk)), 1);
  -- Eight on the list, minus One, plus the four: the delete and the four
  -- inserts were five statements and are one message.
  perform tests.assert_eq('and the whole edit really did land',
    (select count(*)::int from candidates where poll_id = v_bulk), 11);

  -- The same through an open poll's link, where the suggester has no account
  -- and the only list is the creator's.
  v_open := create_poll('Open painting', null, array[]::text[], array[]::text[],
                        'open', true, false, null, true);
  perform tests.forget_signals();
  perform open_poll_suggest_options(v_open, v_five);
  perform tests.assert_eq('five suggested through the link is one message',
    tests.signals(tests.poll_topic(v_open)), 1);
  perform tests.assert_eq('and reaches the poll and the creator''s list, once each',
    tests.signalled(), tests.sorted(array[
      tests.poll_topic(v_open),
      tests.user_topic('creator@example.com')]));

  -- A poll being created is the same shape: one insert per option and one per
  -- invitee, all inside create_poll. Nobody is watching the poll's own topic
  -- yet, but every invitee's list is, and this is the moment the poll turns
  -- up on it.
  perform tests.forget_signals();
  v_bulk := create_poll('Lunch again', null,
                        array['Pizza', 'Sushi', 'Tacos', 'Ramen', 'Curry'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false);
  perform tests.assert_eq('a poll of five options and two invitees is one message per list',
    tests.signals(tests.user_topic('voter1@example.com')), 1);
  perform tests.assert_eq('the creator''s list included',
    tests.signals(tests.user_topic('creator@example.com')), 1);

  -- And a group, which is all of that once per question. The lists carry one
  -- row for the group, so one message is what they can act on.
  perform tests.forget_signals();
  perform create_poll_group('Movie night',
    null,
    '[{"title": "What", "options": [{"name": "Dune"}, {"name": "Arrival"}]},
      {"title": "When", "options": [{"name": "Friday"}, {"name": "Saturday"}]}]'::jsonb,
    array['voter1@example.com', 'voter2@example.com'], 'invite');
  perform tests.assert_eq('a two-question group is one message per list, not one per question',
    tests.signals(tests.user_topic('voter1@example.com')), 1);

  -- ------------------------------------------------------------------
  -- A confirmation, which moves a roster everyone in the poll is reading and
  -- can move the poll itself. The last one in opens the poll for voting, so
  -- a page that heard nothing would be offering a box to suggest options to
  -- a poll that had started taking votes.
  -- ------------------------------------------------------------------

  v_poll := create_poll('Collecting', null, array['Pizza', 'Sushi'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false, null, true);

  perform tests.forget_signals();
  perform tests.sign_in('voter1@example.com');
  perform confirm_options(v_poll);
  perform tests.assert_eq('a confirmation announces the poll',
    tests.signals(tests.poll_topic(v_poll)), 1);
  perform tests.assert_eq('and reaches the list of everyone who can see it',
    tests.signalled(), tests.sorted(array[
      tests.poll_topic(v_poll),
      tests.user_topic('creator@example.com'),
      tests.user_topic('voter1@example.com'),
      tests.user_topic('voter2@example.com')]));

  perform tests.forget_signals();
  perform unconfirm_options(v_poll);
  perform tests.assert_eq('and taking one back announces it just as loudly',
    tests.signals(tests.poll_topic(v_poll)), 1);

  -- Two statements: the confirmation, and the poll opening behind it. One
  -- transaction, so one message -- and it is enough for both, because the
  -- page that hears it re-reads a poll that has already done the two things.
  perform confirm_options(v_poll);
  perform tests.forget_signals();
  perform tests.sign_in('voter2@example.com');
  perform confirm_options(v_poll);
  perform tests.assert_eq('the confirmation that opens the poll says so once',
    tests.signals(tests.poll_topic(v_poll)), 1);
  perform tests.assert_eq('and the poll really did open',
    (select soliciting from poll_status(v_poll)), false);

  perform tests.sign_in('creator@example.com');

  -- ------------------------------------------------------------------
  -- One change, one signal, however many rows it moved.
  --
  -- reset_poll clears every ballot in one delete and reopens the poll in one
  -- update. Row triggers would make that forty-one messages on a poll with
  -- forty votes, each one landing on everybody connected; statement triggers
  -- made it two; the transaction is one.
  -- ------------------------------------------------------------------

  v_poll := tests.seed_poll(array['Apple', 'Banana'],
                            array[[5, 4], [3, 2], [1, 0]]);

  perform tests.assert_eq('three people voted',
    (select voted_count from poll_status(v_poll)), 3);

  perform tests.forget_signals();
  perform reset_poll(v_poll);
  perform tests.assert_eq('clearing three ballots and reopening the poll is one signal',
    tests.signals(tests.poll_topic(v_poll)), 1);

  -- ------------------------------------------------------------------
  -- An invite, the change that has to reach somebody who has never seen the
  -- poll. It is no longer a special case: a list watches its reader, the
  -- newly invited are on the poll by the time the trigger runs, and so they
  -- are told by the same fan-out that tells everybody else.
  -- ------------------------------------------------------------------

  perform tests.sign_in('newcomer@example.com');
  perform tests.sign_in('creator@example.com');

  perform tests.forget_signals();
  insert into invited_voters (poll_id, email) values (v_poll, 'newcomer@example.com');

  perform tests.assert_eq('an invite announces the poll',
    tests.signals(tests.poll_topic(v_poll)), 1);
  perform tests.assert_eq('and reaches the list of the person invited',
    tests.signals(tests.user_topic('newcomer@example.com')), 1);
  perform tests.assert_eq('exactly once, not once as an invitee and again as a new one',
    tests.signalled(), tests.sorted(array[
      tests.poll_topic(v_poll),
      tests.user_topic('creator@example.com'),
      tests.user_topic('voter1@example.com'),
      tests.user_topic('voter2@example.com'),
      tests.user_topic('voter3@example.com'),
      tests.user_topic('newcomer@example.com')]));

  perform tests.forget_signals();
  insert into invited_voters (poll_id, email) values (v_poll, 'stranger@example.com');
  perform tests.assert_eq('somebody with no account yet has no list to reach',
    tests.signals(tests.user_topic('stranger@example.com')), 0);
  perform tests.assert_eq('though the poll itself is still announced',
    tests.signals(tests.poll_topic(v_poll)), 1);

  perform tests.forget_signals();
  delete from invited_voters where poll_id = v_poll and email = 'stranger@example.com';
  perform tests.assert_eq('and an invite withdrawn announces the poll',
    tests.signals(tests.poll_topic(v_poll)), 1);

  -- ------------------------------------------------------------------
  -- A poll that asks several questions.
  --
  -- The list carries one row per group -- the first question -- and that
  -- row's "everyone has answered" state is an aggregate over all of them. A
  -- list watching poll ids would be watching the first question's, so a vote
  -- in the second announced itself to a topic no list was listening on and
  -- the row went stale. Watching the reader instead is what fixes it: the
  -- question that moved is on their list whichever one it was.
  -- ------------------------------------------------------------------

  v_questions := tests.seed_group(array[
    row('Lunch', array['Pizza', 'Salad'])::tests.question,
    row('Time', array['Noon', 'One'])::tests.question
  ], array['voter1@example.com']);

  perform tests.forget_signals();
  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_questions[2], array[5, 0]);

  perform tests.assert_eq('a vote in the second question announces that question',
    tests.signals(tests.poll_topic(v_questions[2])), 1);
  perform tests.assert_eq('and reaches the lists the group is on, not only the first question''s watchers',
    tests.signalled(), tests.sorted(array[
      tests.poll_topic(v_questions[2]),
      tests.user_topic('creator@example.com'),
      tests.user_topic('voter1@example.com')]));

  -- ------------------------------------------------------------------
  -- A creator who invited themselves is one reader with one list.
  -- ------------------------------------------------------------------

  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Own poll', null, array['Yes', 'No'],
                        array['creator@example.com', 'voter1@example.com'],
                        'invite', true, false);

  perform tests.forget_signals();
  perform close_poll(v_poll);
  perform tests.assert_eq('being both creator and invitee is still one message',
    tests.signals(tests.user_topic('creator@example.com')), 1);

  -- ------------------------------------------------------------------
  -- An open poll is announced once, on the poll's own topic, because both
  -- sides watching it hold the same thing: the link to an open poll is its
  -- id. It used to be announced twice -- once under the id for its creator
  -- and once under the share token for everyone holding the link, who could
  -- not know the id until they had read the poll once. There is nothing left
  -- to bridge, so the second message is gone rather than merely unread.
  -- ------------------------------------------------------------------

  v_open := create_poll('Movie night', null, array['Dune', 'Arrival'],
                        array[]::text[], 'open', true, false);

  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 4))
  into v_scores from candidates where poll_id = v_open;

  perform tests.forget_signals();
  perform open_poll_submit(v_open, v_scores, 'voter-key-1', 'Ada');

  perform tests.assert_eq('a vote through the link reaches the poll''s topic',
    tests.signals(tests.poll_topic(v_open)), 1);
  perform tests.assert_eq('and reaches the creator''s list, and nothing else',
    tests.signalled(), tests.sorted(array[
      tests.poll_topic(v_open),
      tests.user_topic('creator@example.com')]));

  -- Nobody is invited to an open poll, so the only list it is on is its
  -- creator's -- the voters holding the link have no account and no list.
  perform tests.forget_signals();
  perform close_poll(v_open);
  perform tests.assert_eq('closing it reaches the poll and its creator''s list',
    tests.signalled(), tests.sorted(array[
      tests.poll_topic(v_open),
      tests.user_topic('creator@example.com')]));

  -- ------------------------------------------------------------------
  -- A poll on its way out, which is two halves and they point opposite ways.
  --
  -- Its **rows** say nothing: they cascade out behind it, and without that
  -- every delete would broadcast once per option, invitee and ballot of a
  -- poll nobody can read any more. Neither does the **poll's own topic**: a
  -- page watching one poll answers a signal by re-reading it, and a re-read
  -- of a poll that is gone is a read that fails, which useLiveStream retries
  -- and then reports as a lost connection.
  --
  -- The **lists** are told, once each. A poll arrives on somebody's homepage
  -- by itself the moment they are invited to it, so a homepage that adds
  -- polls and never removes them leaves a card that opens onto "Poll not
  -- found" until its reader thinks to reload.
  -- ------------------------------------------------------------------

  perform tests.forget_signals();
  delete from polls where id = v_open;
  perform tests.assert_eq('deleting a poll tells the lists it was on, and nothing else',
    tests.signalled(), array[tests.user_topic('creator@example.com')]);

  -- The one that would have been missed by an AFTER trigger: everyone on the
  -- invite list is told, and the invite list is deleted by the same statement.
  v_poll := tests.seed_poll(array['Apple', 'Banana'], array[[5, 0], [3, 2]]);
  perform tests.sign_in('creator@example.com');

  perform tests.forget_signals();
  delete from polls where id = v_poll;
  perform tests.assert_eq('and reaches everyone who could see it, not only its creator',
    tests.signalled(), tests.sorted(array[
      tests.user_topic('creator@example.com'),
      tests.user_topic('voter1@example.com'),
      tests.user_topic('voter2@example.com')]));
  perform tests.assert_eq('once each, not once per option, invitee and ballot cascading out',
    tests.signals(tests.user_topic('voter1@example.com')), 1);

  -- A group goes out as several polls through the same trigger, and every
  -- question reaches the same lists. They hear once: the Delete button is one
  -- act in one transaction, and a list re-read after it already has every
  -- question gone, so the second message was only a second round trip to the
  -- same answer. The audience is what matters here and it is unchanged.
  v_questions := tests.seed_group(array[
    row('Lunch', array['Pizza', 'Salad'])::tests.question,
    row('Time', array['Noon', 'One'])::tests.question
  ], array['voter1@example.com']);

  perform tests.sign_in('creator@example.com');
  perform tests.forget_signals();
  delete from polls where id = any(v_questions);
  perform tests.assert_eq('deleting a poll of two questions tells each list once',
    tests.signals(tests.user_topic('voter1@example.com')), 1);
  perform tests.assert_eq('and still says nothing on any question''s own topic',
    tests.signalled(), tests.sorted(array[
      tests.user_topic('creator@example.com'),
      tests.user_topic('voter1@example.com')]));

  v_old := tests.seed_poll(array['Apple', 'Banana'], array[[5, 0]], 'Ancient');
  perform close_poll(v_old);
  perform tests.age_poll(v_old, interval '7 months');

  -- And the purge is the one delete that stays silent, deliberately: it is
  -- one statement that can take hundreds of expired polls at once, months
  -- after anybody last opened them, and announcing every one of them to
  -- everyone it was ever shared with is a burst of messages in the small
  -- hours about polls nobody was waiting on.
  perform tests.forget_signals();
  perform tests.assert_eq('the purge takes the poll',
    purge_old_polls(), 1);
  perform tests.assert_eq('and says nothing to anybody while doing it',
    tests.signalled(), array[]::text[]);
end $$;

rollback;

-- A reminder to vote: the creator's one nudge to the people a poll is still
-- waiting on.
--
-- The rules under test (0080): only the creator of an invite poll that is
-- taking votes may send it, and only once per poll -- a group counting once,
-- whichever question it is pressed on, and reopening does not give it back.
-- It reaches every invitee still owed a vote in some question, minus the
-- creator and anybody who has removed the poll from their list. Whether it
-- may be sent never depends on who removed the poll, so the button cannot be
-- used to find out. poll_status says when it was sent.

begin;

do $$
declare
  v_questions uuid[];
  v_first polls;
  v_poll uuid;
  v_all_in uuid;
begin
  -- ------------------------------------------------------------------
  -- A poll of two questions, four invitees, the creator among them.
  -- ------------------------------------------------------------------
  v_questions := tests.seed_group(
    array[('Where', array['Park', 'Beach'])::tests.question,
          ('When', array['Noon', 'Dusk'])::tests.question],
    array['creator@example.com', 'done@example.com', 'half@example.com',
          'none@example.com', 'gone@example.com']);
  select * into v_first from polls where id = v_questions[1];

  perform tests.sign_in('done@example.com');
  perform tests.cast_ballot(v_questions[1], array[5, 0]);
  perform tests.cast_ballot(v_questions[2], array[5, 0]);

  perform tests.sign_in('half@example.com');
  perform tests.cast_ballot(v_questions[1], array[0, 5]);

  perform tests.sign_in('gone@example.com');
  perform remove_polls(array[v_questions[1]]);

  perform tests.assert_eq('an invitee still owed a vote in any question is outstanding',
    (select array_agg(e order by e) from poll_outstanding_invitees(v_first) e),
    array['creator@example.com', 'gone@example.com', 'half@example.com', 'none@example.com']);

  perform tests.assert_eq('the reminder leaves out the creator and whoever removed the poll',
    (select array_agg(a order by a) from poll_reminder_audience(v_first, 'creator@example.com') a),
    array['half@example.com', 'none@example.com']);

  -- ------------------------------------------------------------------
  -- Only the creator.
  -- ------------------------------------------------------------------
  perform tests.sign_in('none@example.com');
  perform tests.assert_raises('an invitee cannot send it',
    'select send_poll_reminder(''' || v_questions[1] || ''')',
    'Only the poll creator can send a reminder');

  perform tests.sign_in('creator@example.com');
  perform tests.assert_null('no reminder has been sent yet',
    (select reminded_at from poll_status(v_questions[1])));

  -- ------------------------------------------------------------------
  -- Once, and for the whole group.
  -- ------------------------------------------------------------------
  perform tests.forget_signals();
  perform send_poll_reminder(v_questions[2]);
  perform tests.assert_eq('it is kept on the first question',
    (select reminder_sent_at is not null from polls where id = v_questions[1]), true);
  perform tests.assert_null('and on no other',
    (select reminder_sent_at from polls where id = v_questions[2]));
  perform tests.assert_eq('and every question says it has been sent',
    (select reminded_at from poll_status(v_questions[1])) is not null
      and (select reminded_at from poll_status(v_questions[2])) is not null, true);
  perform tests.assert_eq('and it wakes nobody watching the poll',
    tests.signalled(), array[]::text[]);

  perform tests.assert_raises('a second is refused',
    'select send_poll_reminder(''' || v_questions[1] || ''')',
    'A reminder has already been sent for this poll');

  perform close_poll(v_questions[1]);
  perform reopen_poll(v_questions[1]);
  perform tests.assert_raises('and reopening the poll does not give it back',
    'select send_poll_reminder(''' || v_questions[1] || ''')',
    'A reminder has already been sent for this poll');

  perform tests.sign_in('half@example.com');
  perform tests.assert_eq('an invitee can read that it was sent',
    (select reminded_at from poll_status(v_questions[1])) is not null, true);

  -- ------------------------------------------------------------------
  -- Only while there is a vote to remind anybody of.
  -- ------------------------------------------------------------------
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Open', null, array['A', 'B'], array[]::text[], 'open', true, false);
  perform tests.assert_raises('an open poll has nobody to remind',
    'select send_poll_reminder(''' || v_poll || ''')',
    'Only a poll with an invite list can send a reminder');

  v_poll := create_poll('Collecting', null, array[]::text[], array['none@example.com'],
                        'invite', true, false, null, true);
  perform tests.assert_raises('nor a poll still collecting its options',
    'select send_poll_reminder(''' || v_poll || ''')',
    'This poll is still collecting its options');

  v_poll := create_poll('Closed', null, array['A', 'B'], array['none@example.com'],
                        'invite', true, false);
  perform close_poll(v_poll);
  perform tests.assert_raises('nor a closed one',
    'select send_poll_reminder(''' || v_poll || ''')',
    'This poll is closed');

  v_poll := create_poll('Finished', null, array['A', 'B'], array['done@example.com'],
                        'invite', true, false);
  perform tests.sign_in('done@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);
  perform tests.sign_in('creator@example.com');
  perform tests.assert_raises('nor one whose results are out',
    'select send_poll_reminder(''' || v_poll || ''')',
    'The results are already out');

  v_all_in := create_poll('Only me left', null, array['A', 'B'],
                          array['creator@example.com', 'done@example.com'], 'invite', true, false);
  perform tests.sign_in('done@example.com');
  perform tests.cast_ballot(v_all_in, array[5, 0]);
  perform tests.sign_in('creator@example.com');
  perform tests.assert_raises('nor one waiting on nobody but its creator',
    'select send_poll_reminder(''' || v_all_in || ''')',
    'Everyone invited has already voted');

  -- ------------------------------------------------------------------
  -- Removing the poll changes who hears it, never whether it can be sent.
  -- ------------------------------------------------------------------
  v_poll := create_poll('Left behind', null, array['A', 'B'], array['gone@example.com'],
                        'invite', true, false);
  perform tests.sign_in('gone@example.com');
  perform remove_polls(array[v_poll]);
  perform tests.sign_in('creator@example.com');
  perform send_poll_reminder(v_poll);
  perform tests.assert_eq('a reminder to somebody who removed the poll is still sent, to nobody',
    (select count(*)::int from poll_reminder_audience((select p from polls p where id = v_poll),
                                                      'creator@example.com')), 0);

  -- ------------------------------------------------------------------
  -- Grants.
  -- ------------------------------------------------------------------
  perform tests.assert_eq('a link cannot send one',
    has_function_privilege('anon', 'public.send_poll_reminder(uuid)', 'execute'), false);
  perform tests.assert_eq('an account can ask',
    has_function_privilege('authenticated', 'public.send_poll_reminder(uuid)', 'execute'), true);
  perform tests.assert_eq('the audience is internal',
    has_function_privilege('authenticated', 'public.poll_reminder_audience(polls, text)', 'execute'), false);
  perform tests.assert_eq('poll_status is still an account''s to ask',
    has_function_privilege('authenticated', 'public.poll_status(uuid)', 'execute'), true);
  perform tests.assert_eq('and not a link''s',
    has_function_privilege('anon', 'public.poll_status(uuid)', 'execute'), false);
end $$;

rollback;

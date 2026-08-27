-- Which email a poll writes, and to whom.
--
-- The email itself cannot be tested here -- pg_net does not exist in this
-- database, and every sender returns without doing anything when it finds no
-- mailer. What can be tested is the pair of decisions the senders are handed:
-- which invitation an address on the list is owed, and who hears about a
-- transition.
--
-- Both come down to the same rule read twice. Nobody is told what they just
-- did: the creator set the poll up, so an invitation is not news to them, and
-- opening the poll with their own button is not either -- while a poll that
-- opens itself, because the last person confirmed, is news to everybody in it
-- but the person who confirmed. The results half of that rule is case 21's.

begin;

do $$
declare
  v_poll uuid;
  v_solicit uuid;
  v_auto uuid;
  v_open uuid;
  v_group uuid[];
  v_row polls;
  v_opened timestamptz;
begin
  perform tests.sign_in('creator@example.com');

  -- ---------------------------------------------------------------------
  -- The invitation, on a poll that already has a ballot. The creator is on
  -- their own invite list, which the create form offers with a checkbox.
  -- ---------------------------------------------------------------------
  v_poll := create_poll('Lunch', null, array['Pizza', 'Sushi'],
                        array['creator@example.com', 'voter1@example.com'],
                        'invite', true, false);

  select * into v_row from polls where id = v_poll;

  perform tests.assert_eq('somebody invited to a poll with a ballot is asked to vote',
    poll_invite_kind(v_row, 'voter1@example.com'), 'vote');
  perform tests.assert_eq('and the creator is told nothing they set up themselves',
    poll_invite_kind(v_row, 'creator@example.com'), 'none');
  -- The list is stored lowercased and the creator's address is read off the
  -- token that way too, but an address arriving in any other case is the same
  -- person and the same inbox.
  perform tests.assert_eq('whatever case their address arrives in',
    poll_invite_kind(v_row, 'Creator@Example.COM'), 'none');

  -- ---------------------------------------------------------------------
  -- A poll still collecting its options asks for options, not for a vote:
  -- there is nothing to vote on yet.
  -- ---------------------------------------------------------------------
  v_solicit := create_poll('Dinner', null, array[]::text[],
                           array['creator@example.com', 'voter1@example.com',
                                 'voter2@example.com'],
                           'invite', true, false, null, true);

  select * into v_row from polls where id = v_solicit;

  perform tests.assert_eq('a poll collecting options invites people to add some',
    poll_invite_kind(v_row, 'voter1@example.com'), 'options');
  perform tests.assert_eq('and still says nothing to the creator',
    poll_invite_kind(v_row, 'creator@example.com'), 'none');

  -- Somebody added to the list later hears about the stage the poll is at
  -- when they are added, not the stage it was at when it was created.
  perform suggest_option(v_solicit, 'Pizza');
  perform suggest_option(v_solicit, 'Sushi');
  perform finalize_options(v_solicit);

  select * into v_row from polls where id = v_solicit;

  perform tests.assert_eq('once the options are settled the invitation is a ballot again',
    poll_invite_kind(v_row, 'voter3@example.com'), 'vote');

  -- ---------------------------------------------------------------------
  -- An open poll has no invite list and writes to nobody through it.
  -- ---------------------------------------------------------------------
  v_open := create_poll('Film night', null, array['Dune', 'Arrival'],
                        array[]::text[], 'open', true, false);

  select * into v_row from polls where id = v_open;

  perform tests.assert_eq('a poll behind a share link invites nobody by email',
    poll_invite_kind(v_row, 'voter1@example.com'), 'none');

  -- ---------------------------------------------------------------------
  -- Opening the poll. The creator pressed the button on v_solicit above, so
  -- they are the one person in it who already knows.
  -- ---------------------------------------------------------------------
  select * into v_row from polls where id = v_solicit;

  perform tests.assert_null('the creator hears nothing about their own button',
    (select array_agg(a order by a)
       from poll_email_audience(v_row, false, 'creator@example.com') a
      where a = 'creator@example.com'));
  perform tests.assert_eq('and everybody else in the poll is told voting has started',
    (select array_agg(a order by a)
       from poll_email_audience(v_row, false, 'creator@example.com') a),
    array['voter1@example.com', 'voter2@example.com']);

  -- ---------------------------------------------------------------------
  -- The other way a poll opens: the last invitee confirms, and it opens
  -- itself. That is news to the creator like anybody else -- and not news at
  -- all to the invitee whose confirmation opened it.
  -- ---------------------------------------------------------------------
  v_auto := create_poll('Offsite', null, array['Lisbon', 'Porto'],
                        array['creator@example.com', 'voter1@example.com'],
                        'invite', true, false, null, true);

  perform tests.sign_in('creator@example.com');
  perform confirm_options(v_auto);
  perform tests.assert_null('one of two confirmations leaves the poll collecting',
    (select options_finalized_at from polls where id = v_auto));

  perform tests.sign_in('voter1@example.com');
  perform confirm_options(v_auto);

  select * into v_row from polls where id = v_auto;

  perform tests.assert_eq('the last confirmation opens the poll by itself',
    v_row.options_finalized_at is not null, true);
  perform tests.assert_eq('and everybody in it hears so, the creator included',
    (select array_agg(a order by a) from poll_email_audience(v_row, true, null) a),
    array['creator@example.com', 'voter1@example.com']);
  -- voter1 pressed the button that opened it, so the one thing the letter has
  -- to say is the thing they were looking at when they pressed it.
  perform tests.assert_eq('except whoever''s own confirmation opened it',
    (select array_agg(a order by a)
       from poll_email_audience(v_row, true, 'voter1@example.com') a),
    array['creator@example.com']);
  -- The creator is dropped by the same address rather than by the flag when
  -- they are the one who acted on a poll that opened by itself -- their own
  -- confirmation being the last one, or their taking the last person they
  -- were waiting on off the invite list, which is the third thing that opens
  -- a poll and is only ever theirs to do.
  perform tests.assert_eq('and the creator where the act that opened it was theirs',
    (select array_agg(a order by a)
       from poll_email_audience(v_row, true, 'creator@example.com') a),
    array['voter1@example.com']);

  -- ---------------------------------------------------------------------
  -- A poll of several questions is one letter per person at every stage,
  -- never one per question. Three things keep it that way, and they are the
  -- three assertions below: the invitation fires for question 1 alone, the
  -- other two emails are addressed about question 1 and take the group's
  -- audience once, and the thing that opens a poll by itself opens it once.
  -- ---------------------------------------------------------------------
  perform tests.sign_in('creator@example.com');
  v_group := tests.seed_group(array[
    row('Lunch', array['Pizza', 'Sushi'])::tests.question,
    row('Time',  array['Noon',  'One'])::tests.question
  ], array['voter1@example.com']);

  select * into v_row from polls where id = v_group[2];

  perform tests.assert_eq('a group is written to about its first question',
    (select q.id from poll_group_members(v_row) q limit 1), v_group[1]);
  perform tests.assert_eq('with one audience for the whole poll',
    (select array_agg(a order by a) from poll_email_audience(v_row, false, null) a),
    array['voter1@example.com']);

  -- Every question carries the whole invite list, so five questions are five
  -- invited_voters rows per person; the trigger's WHEN clause is what makes
  -- them one letter.
  perform tests.assert_eq('an invitation names the first question',
    poll_is_first_question(v_group[1]), true);
  perform tests.assert_eq('and no invitation is sent for the rest of them',
    (select bool_or(poll_is_first_question(q)) from unnest(v_group[2:]) q), false);

  -- The other half of "once": a poll that has already opened is not opened
  -- again, so nothing announces it again either. This runs inside every
  -- confirmation and every invitee removal on a soliciting poll, which is
  -- how often it would otherwise write.
  v_opened := (select options_finalized_at from polls where id = v_auto);

  perform open_options_when_all_confirmed(v_auto);
  perform tests.assert_eq('a poll already open is not opened a second time',
    (select options_finalized_at from polls where id = v_auto), v_opened);

  raise notice '  poll email audiences ok';
end $$;

rollback;

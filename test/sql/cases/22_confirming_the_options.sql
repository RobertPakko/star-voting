-- Who is done adding options, and the poll that opens itself when everybody is.
--
-- The collecting stage used to report one number -- how many options were in --
-- which says nothing about how many people put them there. A confirmation is
-- the missing half: it says a person has looked and has nothing more to add.
--
-- Three things are under test, and the third is the one worth the file. Who
-- may confirm, which is exactly who may vote: the invite list and nobody else.
-- What a confirmation says, which is deliberately the weaker reading -- "I
-- have had my say" rather than "I approve this list" -- so a suggestion
-- arriving afterwards does not un-confirm anybody. And when the poll opens
-- itself, which is the moment it runs out of people to wait for: the last
-- confirmation, or the departure of the last person who had not sent one.

begin;

do $$
declare
  v_poll uuid;
  v_short uuid;
  v_open uuid;
  v_hidden uuid;
  v_questions uuid[];
  v_q1 uuid;
  v_q2 uuid;
  v_status record;
  v_view jsonb;
begin
  perform tests.sign_in('creator@example.com');

  -- A poll collecting its options from two people, neither of whom is the
  -- creator. Seeded with two options so the floor is never the thing under
  -- test until the case says it is.
  v_poll := create_poll('Lunch', null, array['Pizza', 'Sushi'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false, null, true);

  select * into v_status from poll_status(v_poll);
  perform tests.assert_eq('a fresh list has nobody done with it',
    v_status.confirmed_count, 0);
  perform tests.assert_eq('and it is still collecting', v_status.soliciting, true);
  perform tests.assert_eq('the creator who invited nobody but others is not on the list',
    v_status.invited, false);

  -- ---- who may confirm, which is who may vote ------------------------------

  perform tests.assert_raises('a creator off the invite list has no confirmation to give',
    format('select confirm_options(%L)', v_poll),
    'Poll not found');

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('and somebody outside the poll cannot reach it at all',
    format('select confirm_options(%L)', v_poll),
    'Poll not found');

  -- ---- one invitee, done ---------------------------------------------------

  perform tests.sign_in('voter1@example.com');
  perform confirm_options(v_poll);

  select * into v_status from poll_status(v_poll);
  perform tests.assert_eq('an invitee is on the list', v_status.invited, true);
  perform tests.assert_eq('and their confirmation is recorded', v_status.confirmed, true);
  perform tests.assert_eq('and counted', v_status.confirmed_count, 1);
  perform tests.assert_eq('but one of two is not everybody, so the poll waits',
    v_status.soliciting, true);

  perform confirm_options(v_poll);
  perform tests.assert_eq('confirming twice is one confirmation',
    (select confirmed_count from poll_status(v_poll)), 1);

  -- The count badge reads off the poll list as well as off the poll's own
  -- page, and one poll looks like one thing wherever it is read; so the list
  -- has to be able to fill it in without the card asking a second question.
  perform tests.sign_in('creator@example.com');
  perform tests.assert_eq('the poll list carries the count the badge reports',
    (select confirmed_count from list_polls(10, 0) where id = v_poll), 1);
  perform tests.assert_eq('beside the invite count it is out of',
    (select invited_count from list_polls(10, 0) where id = v_poll), 2);

  perform tests.sign_in('voter1@example.com');
  perform tests.assert_eq('the roster says who it was',
    (select has_confirmed from poll_invitees(v_poll) where email = 'voter1@example.com'),
    true);
  perform tests.assert_eq('and who it was not',
    (select has_confirmed from poll_invitees(v_poll) where email = 'voter2@example.com'),
    false);

  -- Confirming is "I have had my say", not "I approve this list": a
  -- suggestion arriving afterwards leaves it standing, so one late idea
  -- cannot keep a poll collecting for ever.
  perform tests.sign_in('voter2@example.com');
  perform suggest_option(v_poll, 'Tacos');
  perform tests.assert_eq('somebody else adding an option un-confirms nobody',
    (select confirmed_count from poll_status(v_poll)), 1);

  -- ---- and taking it back --------------------------------------------------

  perform tests.sign_in('voter1@example.com');
  perform unconfirm_options(v_poll);
  perform tests.assert_eq('a confirmation can be taken back while the stage runs',
    (select confirmed_count from poll_status(v_poll)), 0);
  perform unconfirm_options(v_poll);
  perform tests.assert_eq('and taking back what was never given is no error either',
    (select confirmed_count from poll_status(v_poll)), 0);
  perform confirm_options(v_poll);

  -- ---- the last one in opens the poll --------------------------------------

  perform tests.sign_in('voter2@example.com');
  perform confirm_options(v_poll);

  select * into v_status from poll_status(v_poll);
  perform tests.assert_eq('the last confirmation opens the poll',
    v_status.soliciting, false);
  perform tests.assert_eq('and it counts everybody', v_status.confirmed_count, 2);
  perform tests.assert_eq('which is exactly what finalizing does',
    (select options_finalized_at is not null from polls where id = v_poll), true);

  perform tests.assert_raises('so the list is closed for good',
    format('select suggest_option(%L, %L)', v_poll, 'Ramen'),
    'settled and voting has started');
  perform tests.assert_raises('and there is nothing left to confirm',
    format('select confirm_options(%L)', v_poll),
    'settled and voting has started');
  perform tests.assert_raises('nor to take back',
    format('select unconfirm_options(%L)', v_poll),
    'settled and voting has started');

  perform tests.cast_ballot(v_poll, array[5, 3, 0]);
  perform tests.assert_eq('a poll that opened itself takes votes like any other',
    (select voted_count from poll_status(v_poll)), 1);

  -- ---- a poll with nothing to vote on stays put ----------------------------

  perform tests.sign_in('creator@example.com');
  v_short := create_poll('Dinner', null, array[]::text[],
                         array['voter1@example.com'],
                         'invite', true, false, null, true);

  perform tests.sign_in('voter1@example.com');
  perform suggest_option(v_short, 'Only one');
  perform confirm_options(v_short);

  -- The floor finalize_options applies is applied here as a reason to wait
  -- rather than as an error: refusing the button would fail one person for a
  -- rule about a list they had finished with.
  select * into v_status from poll_status(v_short);
  perform tests.assert_eq('everybody done and one option is not an election',
    v_status.soliciting, true);
  perform tests.assert_eq('but the confirmation was still taken',
    v_status.confirmed_count, 1);

  perform suggest_option(v_short, 'And another');
  perform tests.assert_eq('a second option does not open it by itself',
    (select soliciting from poll_status(v_short)), true);
  -- Nothing re-checks until somebody confirms again, which is what the
  -- creator's own Open poll button is for. Confirming again is idempotent on
  -- the row and is what re-asks the question.
  perform confirm_options(v_short);
  perform tests.assert_eq('and confirming again, now that there is a ballot, opens it',
    (select soliciting from poll_status(v_short)), false);

  -- ---- the last person to wait on can also leave ---------------------------

  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Offsite', null, array['Beach', 'Mountains'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false, null, true);

  perform tests.sign_in('voter1@example.com');
  perform confirm_options(v_poll);
  perform tests.assert_eq('one of two, so it waits',
    (select soliciting from poll_status(v_poll)), true);

  perform tests.sign_in('creator@example.com');
  delete from invited_voters where poll_id = v_poll and email = 'voter2@example.com';

  perform tests.assert_eq('removing the last person it was waiting on opens it too',
    (select soliciting from poll_status(v_poll)), false);

  -- A confirmation leaves with the person who gave it, so re-inviting them
  -- asks again rather than counting an answer they gave to another list.
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Retro', null, array['Keep', 'Drop'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false, null, true);

  perform tests.sign_in('voter1@example.com');
  perform confirm_options(v_poll);

  perform tests.sign_in('creator@example.com');
  delete from invited_voters where poll_id = v_poll and email = 'voter1@example.com';
  insert into invited_voters (poll_id, email) values (v_poll, 'voter1@example.com');

  select * into v_status from poll_status(v_poll);
  perform tests.assert_eq('an uninvited confirmation goes with its author',
    v_status.confirmed_count, 0);
  perform tests.assert_eq('and the poll is still collecting', v_status.soliciting, true);

  -- ---- a poll of several questions is confirmed question by question -------

  perform tests.sign_in('creator@example.com');
  -- Created and then read back in two statements rather than one: the helper
  -- is stable, so nested inside the call it would run against the snapshot
  -- taken before the group existed.
  v_q1 := create_poll_group(
    'Party', null,
    jsonb_build_array(
      jsonb_build_object('title', 'Where?',
        'options', jsonb_build_array(jsonb_build_object('name', 'Park'),
                                     jsonb_build_object('name', 'Hall'))),
      jsonb_build_object('title', 'When?',
        'options', jsonb_build_array(jsonb_build_object('name', 'Friday'),
                                     jsonb_build_object('name', 'Saturday')))),
    array['voter1@example.com', 'voter2@example.com'],
    'invite', true, false, true);

  v_questions := tests.group_questions(v_q1);
  v_q1 := v_questions[1];
  v_q2 := v_questions[2];

  perform tests.sign_in('voter1@example.com');
  perform confirm_options(v_q1);
  perform confirm_options(v_q2);
  perform tests.sign_in('voter2@example.com');
  perform confirm_options(v_q1);

  perform tests.assert_eq('every question of a group is confirmed on its own',
    (select confirmed_count from poll_status(v_q1)), 2);
  perform tests.assert_eq('so a question everybody has finished with still waits',
    (select soliciting from poll_status(v_q1)), true);

  perform confirm_options(v_q2);

  perform tests.assert_eq('the last question finished opens the whole poll',
    (select soliciting from poll_status(v_q1)), false);
  perform tests.assert_eq('every question of it at once',
    (select soliciting from poll_status(v_q2)), false);
  perform tests.assert_eq('on one timestamp, because opening is one act',
    (select count(distinct options_finalized_at)::int from polls where id = any(v_questions)),
    1);

  -- ---- a poll whose options its creator wrote has nothing to confirm -------

  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Fixed', null, array['Apple', 'Banana'],
                        array['voter1@example.com'], 'invite', true, false);

  perform tests.sign_in('voter1@example.com');
  perform tests.assert_raises('a poll that never collected options takes no confirmation',
    format('select confirm_options(%L)', v_poll),
    'were set when it was created');

  -- ---- the same stage behind a share link ----------------------------------

  perform tests.sign_in('creator@example.com');
  v_open := create_poll('Movie night', null, array['Dune', 'Arrival'],
                        array[]::text[], 'open', true, false, null, true);

  perform tests.assert_raises('an open poll is not confirmed through the invite path',
    format('select confirm_options(%L)', v_open),
    'confirmed through that link');

  perform tests.assert_raises('and a name is what the link has instead of an account',
    format('select open_poll_confirm_options(%L, %L)', v_open, 'key-1'),
    'Enter your name');

  perform open_poll_confirm_options(v_open, 'key-1', 'Ana');

  v_view := open_poll_view(v_open, 'key-1');
  perform tests.assert_eq('a confirmation behind the link is counted',
    (v_view ->> 'confirmed_count')::int, 1);
  perform tests.assert_eq('and handed back to the browser that gave it',
    (v_view ->> 'confirmed')::boolean, true);
  perform tests.assert_eq('under the name it was given',
    v_view ->> 'your_confirmed_name', 'Ana');
  perform tests.assert_eq('and named to everybody, on a poll that shows respondents',
    v_view -> 'confirmations', '["Ana"]'::jsonb);
  -- An open poll has no invite list to count off, so the count is of the
  -- confirmations themselves; counting them the invite way would report zero
  -- for every open poll there is.
  perform tests.sign_in('creator@example.com');
  perform tests.assert_eq('an open poll counts its confirmations, not its invitees',
    (select confirmed_count from list_polls(10, 0) where id = v_open), 1);
  perform tests.assert_eq('another browser sees the roster and not its own mark',
    (open_poll_view(v_open, 'key-2') ->> 'confirmed')::boolean, false);

  perform tests.assert_raises('two people cannot confirm under one name',
    format('select open_poll_confirm_options(%L, %L, %L)', v_open, 'key-2', 'ana'),
    'has already confirmed');

  perform open_poll_confirm_options(v_open, 'key-1', 'Ana');
  perform tests.assert_eq('confirming twice from one browser is one confirmation',
    (open_poll_view(v_open) ->> 'confirmed_count')::int, 1);

  perform open_poll_confirm_options(v_open, 'key-2', 'Ben');
  perform tests.assert_eq('an open poll has no list of people to have all confirmed',
    (open_poll_view(v_open) ->> 'soliciting')::boolean, true);

  perform open_poll_unconfirm_options(v_open, 'key-2');
  perform tests.assert_eq('and a confirmation given behind the link can be taken back',
    (open_poll_view(v_open) ->> 'confirmed_count')::int, 1);

  perform tests.sign_in('creator@example.com');
  perform finalize_options(v_open);
  perform tests.assert_raises('the creator still ends the stage, and it stays ended',
    format('select open_poll_confirm_options(%L, %L, %L)', v_open, 'key-3', 'Chloe'),
    'settled and voting has started');

  -- ---- and an open poll that names nobody stores no name -------------------

  v_hidden := create_poll('Anonymous night', null, array['Dune', 'Arrival'],
                          array[]::text[], 'open', false, false, null, true);

  perform open_poll_confirm_options(v_hidden, 'key-1', 'Ana');

  v_view := open_poll_view(v_hidden, 'key-1');
  perform tests.assert_eq('a poll that hides respondents still counts them',
    (v_view ->> 'confirmed_count')::int, 1);
  perform tests.assert_eq('and still tells this browser it has confirmed',
    (v_view ->> 'confirmed')::boolean, true);
  perform tests.assert_null('but the name it was sent is discarded',
    v_view ->> 'your_confirmed_name');
  -- JSON's null rather than SQL's, which is what a jsonb-returning view has
  -- to say "no roster" with; the same shape `voters` has always had.
  perform tests.assert_eq('and there is no roster to read',
    v_view -> 'confirmations', 'null'::jsonb);
  perform tests.assert_eq('nothing was stored, whatever the client sent',
    (select count(*)::int from option_confirmations
      where poll_id = v_hidden and voter_name is not null), 0);

  perform open_poll_confirm_options(v_hidden, 'key-2', 'Ana');
  perform tests.assert_eq('so two people may confirm under one name, having stored neither',
    (open_poll_view(v_hidden) ->> 'confirmed_count')::int, 2);

  -- ---- an invite poll that hides respondents names nobody either -----------

  v_hidden := create_poll('Quiet lunch', null, array['Pizza', 'Sushi'],
                          array['voter1@example.com', 'voter2@example.com'],
                          'invite', false, false, null, true);

  perform tests.sign_in('voter1@example.com');
  perform confirm_options(v_hidden);

  perform tests.sign_in('creator@example.com');
  perform tests.assert_null('the creator of a hidden poll gets the list with no state on it',
    (select has_confirmed from poll_invitees(v_hidden) where email = 'voter1@example.com'));
  perform tests.assert_eq('the count is not withheld, because it names nobody',
    (select confirmed_count from poll_status(v_hidden)), 1);

  perform tests.sign_in('voter2@example.com');
  perform tests.assert_raises('and nobody else reads the roster at all',
    format('select * from poll_invitees(%L)', v_hidden),
    'does not show who has responded');
  perform confirm_options(v_hidden);
  perform tests.assert_eq('a hidden poll still opens itself when everybody is done',
    (select soliciting from poll_status(v_hidden)), false);
end $$;

rollback;

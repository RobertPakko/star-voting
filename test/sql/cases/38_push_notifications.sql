-- Who a push notification would go to, and the settings that decide it.
--
-- Like the emails (cases 21 and 23), the sending cannot be tested here: there
-- is no pg_net in this database, so send_push returns without doing anything.
-- What can be tested is everything the database decides before that -- which
-- browsers, about which poll, saying what -- and the doors a browser uses to
-- put itself on those lists.

begin;

do $$
declare
  v_creator uuid;
  v_voter1 uuid;
  v_voter2 uuid;
  v_poll uuid;
  v_open uuid;
  v_group uuid[];
  v_row polls;
  v_settings jsonb;
  v_message jsonb;
  -- Endpoints and keys in the shapes a browser hands out.
  c_fcm constant text := 'https://fcm.googleapis.com/fcm/send/voter1-phone';
  c_moz constant text := 'https://updates.push.services.mozilla.com/wpush/v2/voter2-laptop';
  c_apple constant text := 'https://web.push.apple.com/creator-phone';
  c_anon constant text := 'https://fcm.googleapis.com/fcm/send/somebody-anonymous';
  c_key constant text := 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
  c_auth constant text := 'tBHItJI5svbpez7KI4CCXg';
begin
  -- ---------------------------------------------------------------------
  -- Settings. Nobody has a row until they change something, and no row is
  -- both channels on.
  -- ---------------------------------------------------------------------
  v_voter1 := tests.sign_in('voter1@example.com');

  v_settings := my_notification_settings();
  perform tests.assert_eq('an account starts with email on', (v_settings ->> 'email')::boolean, true);
  perform tests.assert_eq('and push on', (v_settings ->> 'push')::boolean, true);
  perform tests.assert_eq('and no device', (v_settings ->> 'this_device')::boolean, false);

  perform tests.assert_eq('an address with no account is always emailed',
    wants_email('stranger@example.com'), true);

  v_voter2 := tests.sign_in('voter2@example.com');
  perform set_notification_settings(false, false);
  v_settings := my_notification_settings();
  perform tests.assert_eq('turning email off is kept', (v_settings ->> 'email')::boolean, false);
  perform tests.assert_eq('and so is turning push off', (v_settings ->> 'push')::boolean, false);
  perform tests.assert_eq('an address whose account turned email off is not emailed',
    wants_email('voter2@example.com'), false);
  perform tests.assert_eq('whatever case it arrives in',
    wants_email('Voter2@Example.com'), false);
  perform tests.assert_eq('and one that did not still is',
    wants_email('voter1@example.com'), true);

  perform tests.assert_raises('the settings cannot be set to nothing',
    'select set_notification_settings(null, true)',
    'Say whether you want each kind of notification');

  -- ---------------------------------------------------------------------
  -- Devices. Only a real push service's endpoint is taken.
  -- ---------------------------------------------------------------------
  perform tests.assert_raises('an endpoint that is not a push service is refused',
    format('select save_push_subscription(%L, %L, %L)',
           'https://example.com/steal', c_key, c_auth),
    'This browser''s push subscription is not one this app can send to');
  perform tests.assert_raises('and so is plain http, even to one',
    format('select save_push_subscription(%L, %L, %L)',
           'http://fcm.googleapis.com/fcm/send/x', c_key, c_auth),
    'This browser''s push subscription is not one this app can send to');
  perform tests.assert_raises('and a host that only ends in a push service''s name',
    format('select save_push_subscription(%L, %L, %L)',
           'https://evilfcm.googleapis.com.example.com/x', c_key, c_auth),
    'This browser''s push subscription is not one this app can send to');
  perform tests.assert_raises('and keys of the wrong shape',
    format('select save_push_subscription(%L, %L, %L)', c_moz, 'short', c_auth),
    'This browser''s push subscription is not one this app can send to');

  perform save_push_subscription(c_moz, c_key, c_auth);

  perform tests.sign_in('voter1@example.com');
  perform save_push_subscription(c_fcm, c_key, c_auth);
  perform tests.assert_eq('a device is bound to the account that saved it',
    (my_notification_settings(c_fcm) ->> 'this_device')::boolean, true);
  perform tests.assert_eq('and another account''s device is not this one''s business',
    (my_notification_settings(c_moz) ->> 'this_device')::boolean, false);

  -- ---------------------------------------------------------------------
  -- An invite poll: its audience by push is its audience by email, on the
  -- devices of whoever has push on.
  -- ---------------------------------------------------------------------
  v_creator := tests.sign_in('creator@example.com');
  perform save_push_subscription(c_apple, c_key, c_auth);

  v_poll := create_poll('Lunch', null, array['Pizza', 'Sushi'],
                        array['voter1@example.com', 'voter2@example.com', 'voter3@example.com'],
                        'invite', true, false);
  select * into v_row from polls where id = v_poll;

  perform tests.assert_eq('a push reaches the devices of the addresses given, where push is on',
    array(select endpoint from poll_push_targets(v_row,
            array['voter1@example.com', 'voter2@example.com', 'voter3@example.com'],
            false, v_creator)),
    array[c_fcm]);

  perform tests.assert_eq('and the results audience, pushed, is the results audience',
    array(select endpoint from poll_push_targets(v_row,
            array(select * from poll_results_audience(v_row, null)), false, null)),
    array[c_fcm, c_apple]);

  -- A shared browser that somebody else signs in to becomes theirs.
  perform tests.sign_in('voter3@example.com');
  perform save_push_subscription(c_fcm, c_key, c_auth);
  perform tests.assert_eq('a device saved again under another account moves to it',
    (select user_id from push_subscriptions where endpoint = c_fcm),
    (select id from auth.users where email = 'voter3@example.com'));
  perform tests.assert_eq('and leaves the first account',
    array(select endpoint from poll_push_targets(v_row, array['voter1@example.com'], false, null)),
    array[]::text[]);

  -- Signing out forgets the device, and only the signed-in account's own.
  perform forget_push_subscription(c_apple);
  perform tests.assert_eq('nobody can forget somebody else''s device',
    (select count(*)::int from push_subscriptions where endpoint = c_apple), 1);
  perform forget_push_subscription(c_fcm);
  perform tests.assert_eq('and forgetting your own takes it off the list',
    (select count(*)::int from push_subscriptions where endpoint = c_fcm), 0);

  -- ---------------------------------------------------------------------
  -- The message. The poll's title is the title; the body says which moment.
  -- ---------------------------------------------------------------------
  v_message := push_message(v_row, 'results');
  perform tests.assert_eq('a notification is titled with its poll', v_message ->> 'title', 'Lunch');
  perform tests.assert_eq('and says what happened', v_message ->> 'body', 'The results are ready.');
  perform tests.assert_eq('and opens the poll''s own address',
    v_message ->> 'path', '#/polls/' || short_poll_id(v_poll));
  perform tests.assert_eq('and replaces an earlier notification about the same poll',
    v_message ->> 'tag', short_poll_id(v_poll));
  perform tests.assert_eq('an invitation to a poll with a ballot asks for a vote',
    push_message(v_row, 'invite_vote') ->> 'body', 'You''ve been invited to vote in this poll.');
  perform tests.assert_eq('and to one still collecting, for options',
    push_message(v_row, 'invite_options') ->> 'body',
    'You''ve been invited to add options to this poll.');
  perform tests.assert_eq('a reopened poll says it is taking votes again',
    push_message(v_row, 'reopened_vote') ->> 'body',
    'This poll has been reopened and is taking votes again.');
  perform tests.assert_eq('or options, when it was closed while collecting them',
    push_message(v_row, 'reopened_options') ->> 'body',
    'This poll has been reopened and is collecting options again.');

  -- Every email says where to turn them off.
  perform tests.assert_eq('every email links to the notification settings',
    poll_email_html('Heading', 'Body', 'https://example.com/poll')
      like '%https://choicelab.app/star-voting/#/settings%', true);
  perform tests.assert_eq('and the notice of a reopen is as internal as the rest',
    has_function_privilege('authenticated', 'public.notify_poll_reopened(uuid)', 'execute'),
    false);

  -- ---------------------------------------------------------------------
  -- Watching an open poll through its link: no account, and one-shot.
  -- ---------------------------------------------------------------------
  v_group := tests.seed_group(array[
    row('Which film', array['Dune', 'Arrival'])::tests.question,
    row('Which snack', array['Popcorn', 'Nachos'])::tests.question
  ], array[]::text[], 'Film night', 'open');
  v_open := v_group[1];

  update auth._session set user_id = null, email = null where id;

  perform tests.assert_raises('an invite poll cannot be watched through a link',
    format('select open_poll_watch(%L, %L, %L, %L)', v_poll, c_anon, c_key, c_auth),
    'Poll not found');
  perform tests.assert_raises('nor with an endpoint that is not a push service',
    format('select open_poll_watch(%L, %L, %L, %L)',
           v_open, 'https://example.com/x', c_key, c_auth),
    'This browser''s push subscription is not one this app can send to');

  -- Watched from the second question: filed against the first, which is the
  -- question every notice about a group is filed against.
  perform open_poll_watch(v_group[2], c_anon, c_key, c_auth);
  perform open_poll_watch(v_group[2], c_anon, c_key, c_auth);
  perform tests.assert_eq('a watch is filed against the group''s first question, once',
    (select count(*)::int from poll_push_watches where poll_id = v_open), 1);

  -- The creator watches too, from their phone, which is bound to their
  -- account -- and it is their own Close that is about to finish the poll.
  perform open_poll_watch(v_open, c_apple, c_key, c_auth);

  select * into v_row from polls where id = v_open;
  perform tests.assert_eq('a watching browser is pushed to',
    array(select endpoint from poll_push_targets(v_row, array[]::text[], true, null)),
    array[c_anon, c_apple]);
  perform tests.assert_eq('except the actor''s own, where it is bound to their account',
    array(select endpoint from poll_push_targets(v_row, array[]::text[], true, v_creator)),
    array[c_anon]);
  perform tests.assert_eq('and watchers are only asked where the moment is theirs',
    array(select endpoint from poll_push_targets(v_row, array[]::text[], false, null)),
    array[]::text[]);

  perform open_poll_unwatch(v_open, c_apple);
  perform tests.assert_eq('a watch can be taken back',
    array(select endpoint from poll_push_watches where poll_id = v_open),
    array[c_anon]);

  -- A ballot, and then the creator's Close: the results are announced, and
  -- the watch has done its job.
  perform open_poll_submit(v_open, tests.open_scores(v_open, array[5, 2]), 'voter-key-1', 'Sam');
  perform tests.sign_in('creator@example.com');
  perform close_poll(v_open);

  perform tests.assert_eq('once the results are announced the watches are gone',
    (select count(*)::int from poll_push_watches where poll_id = v_open), 0);

  update auth._session set user_id = null, email = null where id;
  perform tests.assert_raises('and a closed poll takes no new ones',
    format('select open_poll_watch(%L, %L, %L, %L)', v_open, c_anon, c_key, c_auth),
    'This poll has closed, so there is nothing left to tell you about it');

  -- A poll closed with nothing in it announces nothing, and lets its watches
  -- go all the same.
  perform tests.sign_in('creator@example.com');
  v_open := create_poll('Empty', null, array['A', 'B'], array[]::text[], 'open', true, false);
  update auth._session set user_id = null, email = null where id;
  perform open_poll_watch(v_open, c_anon, c_key, c_auth);
  perform tests.sign_in('creator@example.com');
  perform close_poll(v_open);
  perform tests.assert_eq('a poll closed with no votes lets its watches go too',
    (select count(*)::int from poll_push_watches where poll_id = v_open), 0);

  -- ---------------------------------------------------------------------
  -- A dead endpoint, as the Edge Function reports it, leaves everywhere.
  -- ---------------------------------------------------------------------
  v_open := create_poll('Later', null, array['A', 'B'], array[]::text[], 'open', true, false);
  update auth._session set user_id = null, email = null where id;
  perform open_poll_watch(v_open, c_moz, c_key, c_auth);
  perform forget_push_endpoints(array[c_moz]);
  perform tests.assert_eq('a gone endpoint is dropped from accounts',
    (select count(*)::int from push_subscriptions where endpoint = c_moz), 0);
  perform tests.assert_eq('and from watches',
    (select count(*)::int from poll_push_watches where endpoint = c_moz), 0);

  -- ---------------------------------------------------------------------
  -- The doors, and who holds them.
  -- ---------------------------------------------------------------------
  perform tests.assert_eq('anybody holding a link can watch an open poll',
    has_function_privilege('anon', 'public.open_poll_watch(uuid, text, text, text)', 'execute'),
    true);
  perform tests.assert_eq('and stop watching it',
    has_function_privilege('anon', 'public.open_poll_unwatch(uuid, text)', 'execute'), true);
  perform tests.assert_eq('but binding a device needs an account',
    has_function_privilege('anon', 'public.save_push_subscription(text, text, text)', 'execute'),
    false);
  perform tests.assert_eq('and so do the settings',
    has_function_privilege('anon', 'public.set_notification_settings(boolean, boolean)', 'execute'),
    false);
  perform tests.assert_eq('only the sender may drop endpoints',
    has_function_privilege('authenticated', 'public.forget_push_endpoints(text[])', 'execute'),
    false);
  perform tests.assert_eq('which it may',
    has_function_privilege('service_role', 'public.forget_push_endpoints(text[])', 'execute'),
    true);
  perform tests.assert_eq('nobody reads the subscriptions directly',
    has_table_privilege('authenticated', 'public.push_subscriptions', 'select'), false);
  perform tests.assert_eq('nor the watches',
    has_table_privilege('anon', 'public.poll_push_watches', 'select'), false);
  perform tests.assert_eq('nor anybody''s settings',
    has_table_privilege('authenticated', 'public.notification_settings', 'select'), false);
  perform tests.assert_eq('and the targets are internal',
    has_function_privilege('authenticated',
      'public.poll_push_targets(public.polls, text[], boolean, uuid)', 'execute'), false);

  update auth._session set user_id = null, email = null where id;
  perform tests.assert_raises('the settings need somebody signed in',
    'select my_notification_settings()',
    'Sign in to change your notification settings');
end $$;

rollback;

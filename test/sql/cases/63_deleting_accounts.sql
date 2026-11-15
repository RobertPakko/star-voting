-- An account can be deleted, and anonymous accounts nobody is using are.
--
-- Deleting an account takes its polls with it and leaves its ballots in
-- other people's polls counted. The nightly purge deletes an anonymous
-- account only when that loses nothing: older than a poll can be, and with
-- no poll, link ballot or confirmation to its name.

begin;

-- ---- deleting an account ---------------------------------------------------

do $$
declare
  v_theirs uuid;
  v_others uuid;
  v_collecting uuid;
  v_leaver uuid;
begin
  -- A poll the leaver made, and a finished poll of somebody else's they
  -- voted in: Apple 5 + 1, Banana 1 + 4, and Apple preferred by one voter
  -- each, so Apple wins the level runoff on its higher total.
  perform tests.sign_in('voter1@example.com');
  v_theirs := create_poll('Theirs', null, array['Tea', 'Coffee'],
    array['friend@example.com'], 'invite', true, false);

  v_others := tests.seed_poll(
    array['Apple', 'Banana'],
    array[[5, 1],
          [1, 4]],
    'Somebody else''s');

  v_collecting := create_poll('Collecting', null, array['One'],
    array['voter1@example.com', 'voter2@example.com'], 'invite', true, false,
    null, true);
  v_leaver := tests.sign_in('voter1@example.com');
  perform confirm_options(v_collecting);

  perform tests.assert_eq('before: the winner',
    tests.winner(get_poll_results(v_others)), 'Apple');

  delete from auth.users where id = v_leaver;

  perform tests.assert_eq('the polls they made went with them',
    (select count(*)::int from polls where id = v_theirs), 0);
  perform tests.assert_eq('with their invite lists',
    (select count(*)::int from invited_voters where poll_id = v_theirs), 0);

  perform tests.assert_eq('their ballot in somebody else''s poll is still there',
    (select count(*)::int from ballots where poll_id = v_others), 2);
  perform tests.assert_eq('and belongs to nobody',
    (select count(*)::int from ballots where poll_id = v_others and voter_id is null), 1);

  perform tests.sign_in('creator@example.com');
  perform tests.assert_eq('so the result somebody read has not moved',
    tests.winner(get_poll_results(v_others)), 'Apple');
  perform tests.assert_eq('nor its totals',
    tests.total_score(get_poll_results(v_others), 'Apple'), 6);

  perform tests.assert_eq('their confirmation went',
    (select count(*)::int from option_confirmations where poll_id = v_collecting), 0);
end $$;

-- ---- the nightly purge of anonymous accounts --------------------------------

do $$
declare
  v_idle uuid;
  v_fresh uuid;
  v_maker uuid;
  v_voter uuid;
  v_confirmer uuid;
  v_poll uuid;
  v_collecting uuid;
  v_deleted int;
begin
  -- Old and idle: the one that should go.
  v_idle := tests.sign_in_anonymously();
  -- New and idle: somebody who pressed the button this week.
  v_fresh := tests.sign_in_anonymously();

  -- Old, and still the owner of a poll.
  v_maker := tests.sign_in_anonymously();
  v_poll := create_poll('Lunch', null, array['Pizza', 'Salad'], null, 'open', true, false);
  v_collecting := create_poll('Dinner', null, array['Curry'], null, 'open', true, false,
    null, true);

  -- Old, with a ballot cast through a link, and one with a confirmation.
  v_voter := tests.sign_in_anonymously();
  perform open_poll_submit(v_poll, tests.open_scores(v_poll, array[5, 1]), 'voter-key', 'Ada');
  v_confirmer := tests.sign_in_anonymously();
  perform open_poll_confirm_options(v_collecting, 'confirmer-key', 'Bea');

  -- An account with an address, as old as any of them.
  perform tests.sign_in('old-timer@example.com');

  update auth.users set created_at = now() - interval '7 months'
  where id in (v_idle, v_maker, v_voter, v_confirmer) or email = 'old-timer@example.com';

  insert into invitations_sent (account_id, day, sent) values (v_idle, current_date, 1);

  v_deleted := purge_stale_anonymous_accounts();

  perform tests.assert_eq('one account was old, anonymous and owned nothing', v_deleted, 1);
  perform tests.assert_eq('and it is gone',
    (select count(*)::int from auth.users where id = v_idle), 0);
  perform tests.assert_eq('with the count that only pointed at it',
    (select count(*)::int from invitations_sent where account_id = v_idle), 0);
  perform tests.assert_eq('a new one is left alone',
    (select count(*)::int from auth.users where id = v_fresh), 1);
  perform tests.assert_eq('so is one that still has a poll',
    (select count(*)::int from auth.users where id = v_maker), 1);
  perform tests.assert_eq('one with a ballot',
    (select count(*)::int from auth.users where id = v_voter), 1);
  perform tests.assert_eq('one with a confirmation',
    (select count(*)::int from auth.users where id = v_confirmer), 1);
  perform tests.assert_eq('and every account with an address',
    (select count(*)::int from auth.users where email = 'old-timer@example.com'), 1);

  perform tests.assert_eq('the purge is nobody''s to call',
    has_function_privilege('authenticated', 'public.purge_stale_anonymous_accounts()', 'execute')
      or has_function_privilege('anon', 'public.purge_stale_anonymous_accounts()', 'execute'),
    false);
end $$;

do $$
begin
  perform tests.assert_eq('the purge is scheduled, nightly',
    (select schedule from cron.job where jobname = 'purge-stale-anonymous-accounts'),
    '47 4 * * *');
  perform tests.assert_eq('and it runs the purge',
    (select command from cron.job where jobname = 'purge-stale-anonymous-accounts'),
    'select public.purge_stale_anonymous_accounts()');
end $$;

rollback;

-- Every invitation is an email from this app's domain, so how many one poll
-- and one account can send is bounded, in guard_invitee_changes:
--
--   * a poll invites at most 500 people;
--   * an account sends at most 1000 invitations a day, counted as they are
--     made, so taking an address off a list and putting it back counts
--     twice; a poll of several questions counts its list once.

begin;

do $$
declare
  v_poll uuid;
  v_questions uuid[];
  v_me uuid;
  i int;
begin
  perform tests.sign_in('creator@example.com');
  v_me := auth.uid();

  -- 500 on one poll, and not one more.
  v_poll := create_poll('Big', null, array['Apple', 'Banana'],
    array(select 'guest' || g || '@example.com' from generate_series(1, 500) g));
  perform tests.assert_eq('a poll may invite 500 people',
    (select count(*)::int from invited_voters where poll_id = v_poll), 500);
  perform tests.assert_raises('and not a 501st',
    format('insert into invited_voters (poll_id, email) values (%L, %L)', v_poll, 'late@example.com'),
    'A poll can invite 500 people');
  perform tests.assert_raises('nor 501 at once',
    $q$select create_poll('Bigger', null, array['Apple', 'Banana'],
         array(select 'guest' || g || '@example.com' from generate_series(1, 501) g))$q$,
    'A poll can invite 500 people');

  perform tests.assert_eq('the day''s count is the invitations made',
    (select sent from invitations_sent where account_id = v_me and day = current_date), 500);

  -- A group carries its list on every question and emails it once.
  v_questions := tests.seed_group(array[
    row('Lunch', array['Pizza', 'Salad'])::tests.question,
    row('Time', array['Noon', 'One'])::tests.question
  ], array(select 'friend' || g || '@example.com' from generate_series(1, 10) g));
  perform tests.assert_eq('each question holds the list',
    (select count(*)::int from invited_voters where poll_id = any(v_questions)), 20);
  perform tests.assert_eq('and the group counts it once',
    (select sent from invitations_sent where account_id = v_me and day = current_date), 510);

  -- An address taken off and put back is invited again each time.
  for i in 1 .. 5 loop
    delete from invited_voters where poll_id = v_poll and email = 'guest1@example.com';
    insert into invited_voters (poll_id, email) values (v_poll, 'guest1@example.com');
  end loop;
  perform tests.assert_eq('inviting one address again counts each time',
    (select sent from invitations_sent where account_id = v_me and day = current_date), 515);

  -- The ceiling is the account's, across its polls.
  perform create_poll('Second', null, array['Apple', 'Banana'],
    array(select 'other' || g || '@example.com' from generate_series(1, 485) g));
  perform tests.assert_eq('1000 in a day',
    (select sent from invitations_sent where account_id = v_me and day = current_date), 1000);
  perform tests.assert_raises('and the next is refused',
    $q$select create_poll('Third', null, array['Apple', 'Banana'], array['one@example.com'])$q$,
    'That is as many invitations as one account can send in a day');
  perform tests.assert_raises('by the list''s own door too',
    format('insert into invited_voters (poll_id, email) values (%L, %L)',
      v_questions[1], 'late@example.com'),
    'That is as many invitations as one account can send in a day');

  -- Somebody else is counted on their own.
  perform tests.sign_in('voter1@example.com');
  perform create_poll('Theirs', null, array['Apple', 'Banana'], array['one@example.com']);
  perform tests.assert_eq('another account has its own count',
    (select sent from invitations_sent where account_id = auth.uid() and day = current_date), 1);

  -- Tomorrow starts again, and yesterday's row goes as today's is written.
  update invitations_sent set day = current_date - 1 where account_id = v_me;
  perform tests.sign_in('creator@example.com');
  perform create_poll('Next day', null, array['Apple', 'Banana'], array['one@example.com']);
  perform tests.assert_eq('a new day starts from nothing, and the old day''s row is dropped',
    (select array_agg(sent order by day) from invitations_sent where account_id = v_me), array[1]);

  -- Nobody reads the count.
  perform tests.assert_eq('the count is no table of anybody''s',
    has_table_privilege('authenticated', 'invitations_sent', 'select')
      or has_table_privilege('anon', 'invitations_sent', 'select'), false);
end $$;

rollback;

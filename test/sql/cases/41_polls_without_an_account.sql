-- A poll made without an account, and what signing in does with it.
--
-- The rules under test (0079): an anonymous account is an account -- it makes
-- an open poll, finds it on its list and runs it like any creator -- with no
-- address, so the poll records none and the audience never writes to one. It
-- cannot make an invite poll, which would be a way to email any address, by
-- either create path; it makes at most twenty polls a day, a group counting
-- once. Its empty email claim invites it to nothing, and an invite list can
-- no longer hold an address that is not one. Signing in carries what it made
-- over: polls, link ballots, confirmations and removals, once, by a ticket only
-- it could take out -- and moving a ballot is not a late vote.

begin;

do $$
declare
  v_anon uuid;
  v_other_anon uuid;
  v_mine uuid;
  v_theirs uuid;
  v_invite uuid;
  v_both uuid;
  v_ticket text;
  v_row polls;
  v_ballot uuid;
  i int;
begin
  -- ------------------------------------------------------------------
  -- An anonymous account makes an open poll and runs it.
  -- ------------------------------------------------------------------
  v_anon := tests.sign_in_anonymously();
  v_mine := create_poll('Pizza', null, array['Margherita', 'Funghi'],
                        array[]::text[], 'open', true, false);

  select * into v_row from polls where id = v_mine;
  perform tests.assert_eq('the poll is the anonymous account''s',
    v_row.created_by, v_anon);
  perform tests.assert_null('and records no address for it, rather than an empty one',
    v_row.created_by_email);
  perform tests.assert_eq('it is on that account''s list',
    (select array_agg(id) from list_polls(10, 0)), array[v_mine]);
  perform tests.assert_eq('and its page is the creator''s',
    poll_page(v_mine, null) ->> 'kind', 'account');

  perform close_poll(v_mine);
  perform reopen_poll(v_mine);
  perform tests.assert_null('its creator can close and reopen it',
    (select closed_at from polls where id = v_mine));

  perform close_poll(v_mine);
  select * into v_row from polls where id = v_mine;
  perform tests.assert_eq('nobody is written to about it: there is no address to write to',
    (select count(*)::int from poll_email_audience(v_row, true, null)), 0);
  perform reopen_poll(v_mine);

  -- ------------------------------------------------------------------
  -- It cannot make a poll that sends email.
  -- ------------------------------------------------------------------
  perform tests.assert_raises('an invite poll is refused',
    format('select create_poll(%L, null, array[%L, %L], array[%L], %L)',
           'Spam', 'A', 'B', 'victim@example.com', 'invite'),
    'Sign in to invite people by email');
  perform tests.assert_raises('by the group path too',
    format('select create_poll_group(%L, null, %L::jsonb, array[%L], %L)',
           'Spam',
           '[{"title":"Q1","options":[{"name":"A"},{"name":"B"}]},'
           || '{"title":"Q2","options":[{"name":"A"},{"name":"B"}]}]',
           'victim@example.com', 'invite'),
    'Sign in to invite people by email');
  perform tests.assert_eq('and nothing was emailed, because nothing was made',
    (select count(*)::int from invited_voters where email = 'victim@example.com'), 0);

  -- ------------------------------------------------------------------
  -- Its empty email claim reaches no invite poll.
  -- ------------------------------------------------------------------
  perform tests.sign_in('creator@example.com');
  v_invite := create_poll('Team lunch', null, array['A', 'B'],
                          array['friend@example.com'], 'invite', true, false);
  perform tests.assert_raises('an invite list holds addresses and nothing else',
    format('insert into invited_voters (poll_id, email) values (%L, %L)', v_invite, ''),
    'invited_voters_email_ck');
  perform tests.assert_raises('whichever way a row arrives',
    format('insert into invited_voters (poll_id, email) values (%L, %L)', v_invite, 'not-an-address'),
    'invited_voters_email_ck');

  perform tests.sign_in_anonymously(v_anon);
  perform tests.assert_eq('an anonymous account is invited to nothing',
    is_invited_to_poll(v_invite), false);
  perform tests.assert_eq('so an invite poll is unreadable to it',
    poll_page(v_invite, null) ->> 'kind', 'unreadable');
  perform tests.assert_raises('and it cannot vote in one',
    format('select submit_ballot(%L, %L::jsonb)', v_invite, tests.open_scores(v_invite, array[5, 0])),
    'You are not invited to this poll');
  perform tests.assert_eq('nor is it on its list',
    (select count(*)::int from list_polls(10, 0) where id = v_invite), 0);

  -- ------------------------------------------------------------------
  -- Twenty polls a day.
  -- ------------------------------------------------------------------
  v_other_anon := tests.sign_in_anonymously();
  perform create_poll_group('Movie night', null,
    ('[{"title":"When","options":[{"name":"Fri"},{"name":"Sat"}]},'
     || '{"title":"What","options":[{"name":"A"},{"name":"B"}]}]')::jsonb,
    array[]::text[], 'open');
  for i in 2..20 loop
    perform create_poll('Poll ' || i, null, array['A', 'B'], array[]::text[], 'open', true, false);
  end loop;
  perform tests.assert_raises('the twenty-first in a day is refused, a group having counted once',
    format('select create_poll(%L, null, array[%L, %L], array[]::text[], %L)', 'One more', 'A', 'B', 'open'),
    'as many polls as can be made without an account');

  perform tests.sign_in('creator@example.com');
  for i in 1..21 loop
    perform create_poll('Mine ' || i, null, array['A', 'B'], array[]::text[], 'open', true, false);
  end loop;
  perform tests.assert_eq('an account has no such ceiling',
    (select count(*)::int from polls where created_by = auth.uid() and title like 'Mine %'), 21);

  -- ------------------------------------------------------------------
  -- Signing in carries it over.
  -- ------------------------------------------------------------------
  -- Somebody else's open poll, which the anonymous account answers, and which
  -- is then closed, revealed and reopened -- so any write to its ballot that
  -- counted as a vote would mark it.
  v_theirs := create_poll('Their poll', null, array['A', 'B'], array[]::text[], 'open', true, false);
  -- And one both the anonymous account and the account it signs in to answer.
  v_both := create_poll('Both', null, array['A', 'B'], array[]::text[], 'open', true, false);

  perform tests.sign_in('reader@example.com');
  perform open_poll_submit(v_both, tests.open_scores(v_both, array[0, 5]), 'reader-key', 'Reader');

  perform tests.sign_in_anonymously(v_anon);
  perform open_poll_submit(v_theirs, tests.open_scores(v_theirs, array[5, 1]), 'anon-key', 'Anon');
  perform open_poll_submit(v_both, tests.open_scores(v_both, array[5, 0]), 'anon-key-2', 'Anon');
  perform remove_polls(array[v_theirs]);

  perform tests.sign_in('creator@example.com');
  perform close_poll(v_theirs);
  perform reopen_poll(v_theirs);

  perform tests.sign_in_anonymously(v_anon);
  v_ticket := begin_account_carry_over();
  perform tests.assert_eq('a second ticket replaces the first',
    (select count(*)::int from account_carry_overs where anon_id = v_anon), 1);
  perform tests.assert_raises('an anonymous account cannot redeem a ticket',
    format('select finish_account_carry_over(%L)', v_ticket),
    'Sign in to an account');

  perform tests.sign_in('reader@example.com');
  perform tests.assert_raises('and an account cannot take one out',
    'select begin_account_carry_over()', 'Only an account made without signing in');
  perform tests.assert_eq('a ticket nobody took out moves nothing',
    finish_account_carry_over('not-a-ticket'), 0);

  perform tests.forget_signals();
  perform tests.assert_eq('redeeming it moves the polls the anonymous account made',
    finish_account_carry_over(v_ticket), 1);
  select * into v_row from polls where id = v_mine;
  perform tests.assert_eq('to the account that signed in',
    v_row.created_by, (select id from auth.users where email = 'reader@example.com'));
  perform tests.assert_eq('with its address now on them',
    v_row.created_by_email, 'reader@example.com');
  perform tests.assert_eq('and the account''s list is told',
    tests.signals(tests.user_topic('reader@example.com')) > 0, true);

  select id into v_ballot from ballots where poll_id = v_theirs;
  perform tests.assert_eq('the ballot it cast through a link follows',
    (select account_id from ballots where id = v_ballot), auth.uid());
  perform tests.assert_eq('without being taken for a vote cast after the reveal',
    (select votes_after_reveal from polls where id = v_theirs), false);
  perform tests.assert_eq('a poll both had answered keeps the account''s own ballot',
    (select voter_name from ballots where poll_id = v_both and account_id = auth.uid()), 'Reader');
  perform tests.assert_eq('and leaves the anonymous one where it was, still counted',
    (select count(*)::int from ballots where poll_id = v_both and account_id = v_anon), 1);
  perform tests.assert_eq('a poll it removed stays removed',
    poll_is_removed(v_theirs), true);
  perform tests.assert_eq('so the list holds what it made and what it answered, and not that',
    (select array_agg(id order by title) from list_polls(10, 0)), array[v_both, v_mine]);

  perform tests.assert_eq('a ticket is spent once',
    finish_account_carry_over(v_ticket), 0);

  perform tests.sign_in_anonymously(v_anon);
  perform tests.assert_eq('the anonymous account is left with only the ballot that could not move',
    (select array_agg(id) from list_polls(10, 0)), array[v_both]);

  -- ------------------------------------------------------------------
  -- Grants.
  -- ------------------------------------------------------------------
  perform tests.assert_eq('nobody reads the tickets directly',
    has_table_privilege('authenticated', 'public.account_carry_overs', 'select'), false);
  perform tests.assert_eq('taking one out is not open to a link',
    has_function_privilege('anon', 'public.begin_account_carry_over()', 'execute'), false);
  perform tests.assert_eq('nor is redeeming one',
    has_function_privilege('anon', 'public.finish_account_carry_over(text)', 'execute'), false);
  perform tests.assert_eq('both are an account''s',
    has_function_privilege('authenticated', 'public.finish_account_carry_over(text)', 'execute'), true);
  perform tests.assert_eq('the session test is internal',
    has_function_privilege('authenticated', 'public.is_anonymous_session()', 'execute'), false);
end $$;

rollback;

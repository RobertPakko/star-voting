-- An open poll answered signed in is answered by the account, on every device.
--
-- A share-link ballot used to be identified by the browser key that cast it
-- and nothing else, so a vote cast on the laptop was nowhere to be found on
-- the phone: a blank ballot, no ticks, no way to change it. Signed in, the
-- ballot now carries the account as well, and every open-poll door finds it
-- by either. Each "device" below is a different voter key; each person is a
-- tests.sign_in.
--
-- What must not move is everything that never depended on an account: a
-- browser that cast a ballot signed out still reaches it by its key, signed
-- in or not; nothing claims such a ballot for an account after the fact; a
-- key one account voted with is not a way into that ballot for another
-- account on the same browser; and nothing about the account reaches any
-- read.

begin;

do $$
declare
  v_ada uuid;
  v_bo uuid;
  v_questions uuid[];
  v_q1 uuid;
  v_q2 uuid;
  v_view jsonb;
  v_group jsonb;
  v_ballot uuid;
  v_published uuid;
  v_collect uuid;
begin
  v_questions := tests.seed_group(
    array[
      row('Where should we eat?', array['Pizza', 'Salad'])::tests.question,
      row('What time?',           array['Noon', 'One'])::tests.question
    ],
    array[]::text[], 'Lunch', 'open');
  v_q1 := v_questions[1];
  v_q2 := v_questions[2];

  -- ---- a ballot cast on one device is the account's on another ------------

  v_ada := tests.sign_in('ada@example.com');
  perform open_poll_submit(v_q1, tests.open_scores(v_q1, array[5, 1]), 'laptop-q1', 'Ada');

  select id into v_ballot from ballots where poll_id = v_q1;
  perform tests.assert_eq('a ballot cast signed in carries the account',
    (select account_id from ballots where id = v_ballot), v_ada);
  perform tests.assert_null('and is not an invite ballot',
    (select voter_id from ballots where id = v_ballot));

  v_view := open_poll_view(v_q1, 'phone-q1');
  perform tests.assert_eq('the phone, holding no key for it, is told the vote is in',
    (v_view ->> 'voted')::boolean, true);
  perform tests.assert_eq('under the name it was cast under',
    v_view ->> 'your_name', 'Ada');
  perform tests.assert_eq('and is handed the ballot back to change',
    v_view -> 'your_scores',
    (select jsonb_object_agg(s.candidate_id::text, s.score) from scores s where s.ballot_id = v_ballot));
  perform tests.assert_eq('with no key at all, too',
    (open_poll_view(v_q1) ->> 'voted')::boolean, true);

  perform tests.assert_raises('so the phone cannot cast a second ballot for the account',
    format('select open_poll_submit(%L, %s, %L, %L)',
           v_q1, quote_literal(tests.open_scores(v_q1, array[0, 5])) || '::jsonb',
           'phone-q1', 'Ada Again'),
    'You have already voted in this poll');

  perform open_poll_revise(v_q1, tests.open_scores(v_q1, array[2, 4]), 'phone-q1');
  perform tests.assert_eq('the phone changes the ballot the laptop cast',
    (select count(*)::int from ballots where poll_id = v_q1), 1);
  perform tests.assert_eq('and the laptop reads the change back',
    open_poll_view(v_q1, 'laptop-q1') -> 'your_scores',
    jsonb_build_object(
      (select id from candidates where poll_id = v_q1 and name = 'Pizza')::text, 2,
      (select id from candidates where poll_id = v_q1 and name = 'Salad')::text, 4));

  -- ---- and the strip knows, on every device -------------------------------

  v_group := open_poll_group(v_q2);
  perform tests.assert_eq('the group marks the question the account answered',
    (v_group -> 0 ->> 'voted')::boolean, true);
  perform tests.assert_eq('and not the one it has not',
    (v_group -> 1 ->> 'voted')::boolean, false);
  perform tests.assert_eq('nor any it has not confirmed',
    (v_group -> 0 ->> 'confirmed')::boolean, false);

  -- ---- signed out, the key is what it always was ---------------------------

  perform tests.sign_out();

  perform tests.assert_eq('the laptop signed out still reaches the ballot it cast',
    (open_poll_view(v_q1, 'laptop-q1') ->> 'voted')::boolean, true);
  perform tests.assert_eq('the phone signed out does not',
    (open_poll_view(v_q1, 'phone-q1') ->> 'voted')::boolean, false);
  perform tests.assert_eq('and the group says nothing about anybody signed out',
    open_poll_group(v_q1) -> 0 ? 'voted', false);

  -- A stranger on this browser, voting on question 2 with nobody signed in.
  perform open_poll_submit(v_q2, tests.open_scores(v_q2, array[5, 0]), 'laptop-q2', 'Cy');
  perform tests.assert_null('a ballot cast signed out carries no account',
    (select account_id from ballots where poll_id = v_q2 and voter_key = 'laptop-q2'));

  -- ---- a ballot this browser cast signed out stays unlinked ----------------

  perform tests.sign_in('ada@example.com');
  perform tests.assert_eq('signed in on the browser that cast it, it is still this browser''s',
    (open_poll_view(v_q2, 'laptop-q2') ->> 'voted')::boolean, true);
  perform open_poll_revise(v_q2, tests.open_scores(v_q2, array[4, 1]), 'laptop-q2');
  perform tests.assert_null('changing it signed in does not claim it for the account',
    (select account_id from ballots where poll_id = v_q2));
  perform tests.assert_eq('so the account has not answered question 2 anywhere else',
    (open_poll_view(v_q2, 'phone-q2') ->> 'voted')::boolean, false);
  perform tests.assert_eq('and the group says so',
    (open_poll_group(v_q1) -> 1 ->> 'voted')::boolean, false);

  -- ---- one browser, two accounts -------------------------------------------

  v_bo := tests.sign_in('bo@example.com');
  perform tests.assert_eq('a key another account voted with is not a way into its ballot',
    (open_poll_view(v_q1, 'laptop-q1') ->> 'voted')::boolean, false);
  perform tests.assert_eq('nor into its scores',
    open_poll_view(v_q1, 'laptop-q1') -> 'your_scores', 'null'::jsonb);

  perform open_poll_submit(v_q1, tests.open_scores(v_q1, array[0, 5]), 'laptop-q1', 'Bo');
  perform tests.assert_eq('so the next person on that browser casts their own',
    (select count(*)::int from ballots where poll_id = v_q1), 2);
  perform tests.assert_null('under their account, with the key left on the ballot that has it',
    (select voter_key from ballots where poll_id = v_q1 and account_id = v_bo));
  perform tests.assert_eq('and reads it back as theirs',
    open_poll_view(v_q1, 'laptop-q1') ->> 'your_name', 'Bo');

  perform tests.sign_in('ada@example.com');
  perform tests.assert_eq('while the first account still reads its own',
    open_poll_view(v_q1, 'laptop-q1') ->> 'your_name', 'Ada');

  -- ---- the account reaches no read -----------------------------------------

  perform tests.assert_eq('the roster is the names typed, nothing more',
    open_poll_view(v_q1) -> 'voters', '["Ada", "Bo"]'::jsonb);

  perform tests.sign_in('creator@example.com');
  v_published := create_poll('Film', null, array['Dune', 'Arrival'],
                             array[]::text[], 'open', false, true);
  perform tests.sign_in('ada@example.com');
  perform open_poll_submit(v_published, tests.open_scores(v_published, array[5, 1]), 'laptop-f', null);
  perform tests.sign_in('creator@example.com');
  perform close_poll(v_published);
  perform tests.assert_eq('a published sheet of an anonymous poll names nobody',
    open_poll_ballots(v_published)::text like '%@%', false);
  perform tests.assert_null('and its ballot has no name to give',
    open_poll_ballots(v_published) -> 'ballots' -> 0 ->> 'voter');

  -- ---- the creator's own page, through poll_group ---------------------------

  perform open_poll_submit(v_q2, tests.open_scores(v_q2, array[1, 5]), 'creator-q2', 'Host');
  perform tests.assert_eq('the creator''s own page marks what they voted through the link',
    (poll_group(v_q1) -> 1 ->> 'voted')::boolean, true);
  perform tests.assert_eq('and not what they did not',
    (poll_group(v_q1) -> 0 ->> 'voted')::boolean, false);

  -- ---- a confirmation follows the account the same way ---------------------

  v_collect := create_poll('Offsite', null, array['Beach', 'Mountains'],
                           array[]::text[], 'open', true, false, null, true);

  perform tests.sign_in('ada@example.com');
  perform open_poll_confirm_options(v_collect, 'laptop-c', 'Ada');
  perform tests.assert_eq('a confirmation given on the laptop is the phone''s too',
    (open_poll_view(v_collect, 'phone-c') ->> 'confirmed')::boolean, true);
  perform tests.assert_eq('under the name it was given under',
    open_poll_view(v_collect, 'phone-c') ->> 'your_confirmed_name', 'Ada');

  perform open_poll_confirm_options(v_collect, 'phone-c', 'Ada');
  perform tests.assert_eq('confirming again from the phone is the same confirmation',
    (open_poll_view(v_collect) ->> 'confirmed_count')::int, 1);

  perform open_poll_unconfirm_options(v_collect, 'phone-c');
  perform tests.assert_eq('and taking it back from the phone takes it back on the laptop',
    (open_poll_view(v_collect, 'laptop-c') ->> 'confirmed')::boolean, false);

  -- Confirmed signed out on the laptop, then signed in on the phone: two rows,
  -- and taking it back signed in on the laptop takes both.
  perform tests.sign_out();
  perform open_poll_confirm_options(v_collect, 'laptop-c', 'Ada L');
  perform tests.sign_in('ada@example.com');
  perform open_poll_confirm_options(v_collect, 'phone-c', 'Ada P');
  perform tests.assert_eq('two confirmations, one signed out and one signed in',
    (open_poll_view(v_collect) ->> 'confirmed_count')::int, 2);
  perform open_poll_unconfirm_options(v_collect, 'laptop-c');
  perform tests.assert_eq('taking it back leaves nothing that still reads as this reader''s',
    (open_poll_view(v_collect, 'laptop-c') ->> 'confirmed')::boolean, false);

  -- ---- nothing internal is exposed -----------------------------------------

  perform tests.assert_eq('the lookup behind all of it is granted to nobody',
    has_function_privilege('anon', 'public.open_ballot_of(uuid, text)', 'execute')
      or has_function_privilege('authenticated', 'public.open_ballot_of(uuid, text)', 'execute')
      or has_function_privilege('anon', 'public.open_confirmation_of(uuid, text)', 'execute')
      or has_function_privilege('authenticated', 'public.open_confirmation_of(uuid, text)', 'execute'),
    false);

  perform tests.assert_raises('and a ballot cannot be both an invitee''s and an account''s',
    format('insert into ballots (poll_id, voter_id, account_id) values (%L, %L, %L)',
           v_q1, v_ada, v_ada),
    'ballots_one_owner_ck');
end $$;

rollback;

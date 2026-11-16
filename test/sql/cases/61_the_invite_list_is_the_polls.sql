-- The invite list belongs to the poll, not to one question of it.
--
-- Every question of a group carries the whole list, and the list is changed
-- after creation through invite_voter and uninvite_voter, which walk the
-- group. What is under test: a voter added late is on every question, is
-- invited once, and can answer all of it; one removed leaves all of it; and
-- neither can be done one question at a time by anybody.

begin;

do $$
declare
  v_questions uuid[];
  v_q1 uuid;
  v_q2 uuid;
  v_single uuid;
  v_group jsonb;
begin
  v_questions := tests.seed_group(
    array[
      row('Where should we eat?', array['Pizza', 'Salad'])::tests.question,
      row('What time?',           array['Noon', 'One'])::tests.question
    ],
    array['voter1@example.com']);

  v_q1 := v_questions[1];
  v_q2 := v_questions[2];

  -- ---- adding, from the second question's page ------------------------------

  perform tests.sign_in('creator@example.com');
  perform invite_voter(v_q2, '  Late@Example.com ');

  perform tests.assert_eq('a voter added on one question is on every question',
    (select count(*)::int from invited_voters
      where poll_id = any(v_questions) and email = 'late@example.com'), 2);

  -- Two so far today: voter1 when the poll was made, and this one. Each is
  -- counted on the first question only, which is the one that is emailed.
  perform tests.assert_eq('and counts as one invitation, not one per question',
    (select sent from invitations_sent where account_id = auth.uid()), 2);

  perform invite_voter(v_q1, 'late@example.com');
  perform tests.assert_eq('inviting them again changes nothing',
    (select count(*)::int from invited_voters
      where poll_id = any(v_questions) and email = 'late@example.com'), 2);
  perform tests.assert_eq('and is not counted as an invitation',
    (select sent from invitations_sent where account_id = auth.uid()), 2);

  perform tests.assert_raises('an address has to look like one',
    format('select invite_voter(%L, %L)', v_q1, 'not-an-address'),
    'does not look like an email address');

  perform tests.sign_in('late@example.com');
  perform tests.assert_eq('they can read the first question',
    poll_page(v_q1) ->> 'kind', 'account');
  perform tests.assert_eq('and the poll is on their list',
    (select count(*)::int from list_polls(10, 0)), 1);

  -- ---- the poll waits for them, on every question ---------------------------

  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_q1, array[5, 0]);
  perform tests.cast_ballot(v_q2, array[5, 0]);
  perform tests.assert_eq('one of two voters is not the results',
    (select results_available from poll_status(v_q1)), false);

  v_group := poll_group(v_q1);
  perform tests.assert_eq('each question says how many ballots it holds',
    (select array_agg((q ->> 'voted_count')::int order by (q ->> 'question_position')::int)
       from jsonb_array_elements(v_group) q),
    array[1, 1]);

  -- ---- only the creator ------------------------------------------------------

  perform tests.assert_raises('an invitee cannot add anybody',
    format('select invite_voter(%L, %L)', v_q1, 'friend@example.com'),
    'Poll not found');
  perform tests.assert_raises('or remove anybody',
    format('select uninvite_voter(%L, %L)', v_q1, 'late@example.com'),
    'Poll not found');

  perform tests.assert_eq('nobody writes the list directly: no insert',
    has_table_privilege('authenticated', 'public.invited_voters', 'insert'), false);
  perform tests.assert_eq('and no delete',
    has_table_privilege('authenticated', 'public.invited_voters', 'delete'), false);
  perform tests.assert_eq('the two doors are not open to a link',
    has_function_privilege('anon', 'public.invite_voter(uuid, text, text)', 'execute')
      or has_function_privilege('anon', 'public.uninvite_voter(uuid, text)', 'execute'), false);

  -- ---- removing --------------------------------------------------------------

  perform tests.sign_in('late@example.com');
  perform tests.cast_ballot(v_q2, array[1, 2]);

  perform tests.sign_in('creator@example.com');
  perform tests.assert_raises('somebody who has voted in any question stays on all of them',
    format('select uninvite_voter(%L, %L)', v_q1, 'late@example.com'),
    'Cannot remove someone who has already voted');
  perform tests.assert_eq('and the refusal took them off none',
    (select count(*)::int from invited_voters
      where poll_id = any(v_questions) and email = 'late@example.com'), 2);

  perform invite_voter(v_q1, 'third@example.com');
  perform uninvite_voter(v_q2, 'third@example.com');
  perform tests.assert_eq('somebody who has not voted leaves every question',
    (select count(*)::int from invited_voters
      where poll_id = any(v_questions) and email = 'third@example.com'), 0);

  -- ---- a question everybody has answered is not the poll's results ----------

  -- Question 2 now has both its ballots and question 1 has one of two: the
  -- results are not out, so the list can still grow.
  perform tests.assert_eq('question 2 is at full turnout',
    (select is_complete from poll_status(v_q2)), true);
  perform invite_voter(v_q2, 'fourth@example.com');
  perform tests.assert_eq('and a voter can still be added to the poll',
    (select count(*)::int from invited_voters
      where poll_id = any(v_questions) and email = 'fourth@example.com'), 2);
  perform uninvite_voter(v_q1, 'fourth@example.com');

  perform tests.sign_in('late@example.com');
  perform tests.cast_ballot(v_q1, array[1, 2]);
  perform tests.assert_eq('the last ballot owed brings the results out',
    (select results_available from poll_status(v_q1)), true);

  perform tests.sign_in('creator@example.com');
  perform tests.assert_raises('and then nobody is added',
    format('select invite_voter(%L, %L)', v_q1, 'fifth@example.com'),
    'Cannot invite people once the results have been revealed');

  -- ---- a poll that asks one question ----------------------------------------

  v_single := tests.seed_poll(array['Apple', 'Banana'], array[[5, 1]]);
  perform tests.sign_in('creator@example.com');
  perform tests.assert_raises('full turnout still closes its list',
    format('select invite_voter(%L, %L)', v_single, 'late@example.com'),
    'Cannot invite people once the results have been revealed');
end $$;

rollback;

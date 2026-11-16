-- An invite poll that shows its voters can show them by name.
--
-- The creator gives every invitee a name when making the poll, or none of
-- them one. A poll whose invitees have names shows them by name to everybody
-- but its creator, who alone still sees the addresses; an invitee can change
-- the name they are shown under. The published sheet names ballots the same
-- way. A poll without names shows addresses, as it always did.

begin;

do $$
declare
  v_poll uuid;
  v_plain uuid;
  v_first uuid;
  v_questions uuid[];
  v_options jsonb := jsonb_build_array(
    jsonb_build_object('name', 'Pizza'), jsonb_build_object('name', 'Salad'));
  v_roster jsonb;
  v_sheet jsonb;
begin
  perform tests.sign_in('creator@example.com');

  -- ---- making one ------------------------------------------------------------

  v_poll := create_poll('Dinner', null, array['Pizza', 'Salad'],
    array['ann@example.com', 'ben@example.com'], 'invite', true, true,
    p_invitee_names => jsonb_build_object(
      'ann@example.com', 'Ann', 'Ben@Example.com', '  Ben  '));

  perform tests.assert_eq('every invitee carries the name the creator gave',
    (select array_agg(name order by email) from invited_voters where poll_id = v_poll),
    array['Ann', 'Ben']);

  perform tests.assert_raises('every invitee needs one, or none does',
    format('select create_poll(%L, null, %L, %L, %L, true, false, p_invitee_names => %L)',
      'Dinner', array['Pizza', 'Salad'], array['ann@example.com', 'ben@example.com'], 'invite',
      jsonb_build_object('ann@example.com', 'Ann')),
    'Give every voter a name: ben@example.com has none');

  perform tests.assert_raises('two people cannot share a name',
    format('select create_poll(%L, null, %L, %L, %L, true, false, p_invitee_names => %L)',
      'Dinner', array['Pizza', 'Salad'], array['ann@example.com', 'ben@example.com'], 'invite',
      jsonb_build_object('ann@example.com', 'Sam', 'ben@example.com', 'sam')),
    'already called "sam"');

  perform tests.assert_raises('a poll that hides its voters gives them no names',
    format('select create_poll(%L, null, %L, %L, %L, false, false, p_invitee_names => %L)',
      'Dinner', array['Pizza', 'Salad'], array['ann@example.com'], 'invite',
      jsonb_build_object('ann@example.com', 'Ann')),
    'Only a poll that shows its voters gives them names');

  v_first := create_poll_group('Evening', null,
    jsonb_build_array(
      jsonb_build_object('title', 'Where?', 'options', v_options),
      jsonb_build_object('title', 'What?', 'options', v_options)),
    array['ann@example.com', 'ben@example.com'], 'invite', true, false, false,
    jsonb_build_object('ann@example.com', 'Ann', 'ben@example.com', 'Ben'));
  v_questions := tests.group_questions(v_first);

  perform tests.assert_eq('a poll of several questions names them on every question',
    (select count(*)::int from invited_voters
      where poll_id = any(v_questions) and name is not null), 4);

  -- ---- who sees what -----------------------------------------------------------

  v_roster := (select jsonb_agg(to_jsonb(i)) from poll_invitees(v_poll) i);
  perform tests.assert_eq('the creator sees names and addresses',
    (select array_agg((r ->> 'name') || ' ' || (r ->> 'email')) from jsonb_array_elements(v_roster) r),
    array['Ann ann@example.com', 'Ben ben@example.com']);

  perform tests.sign_in('ann@example.com');
  v_roster := (select jsonb_agg(to_jsonb(i)) from poll_invitees(v_poll) i);
  perform tests.assert_eq('an invitee sees names',
    (select array_agg(r ->> 'name') from jsonb_array_elements(v_roster) r),
    array['Ann', 'Ben']);
  perform tests.assert_eq('and no address at all',
    (select count(*)::int from jsonb_array_elements(v_roster) r where r ->> 'email' is not null), 0);
  perform tests.assert_eq('and knows which row is theirs',
    (select r ->> 'name' from jsonb_array_elements(v_roster) r where (r ->> 'is_you')::boolean),
    'Ann');
  perform tests.assert_eq('the page carries the same roster',
    (select count(*)::int from jsonb_array_elements(poll_page(v_poll) -> 'invitees') r
      where r ->> 'email' is not null), 0);

  -- ---- an invitee names themselves --------------------------------------------

  perform tests.forget_signals();
  perform set_voter_name(v_questions[2], 'Annie');
  perform tests.assert_eq('and every question''s page is told',
    array[tests.signals(tests.poll_topic(v_questions[1])),
          tests.signals(tests.poll_topic(v_questions[2]))], array[1, 1]);
  perform tests.forget_signals();
  perform set_voter_name(v_questions[1], 'Annie');
  perform tests.assert_eq('the same name again tells nobody anything',
    tests.signalled(), array[]::text[]);
  perform tests.assert_eq('a name of their own replaces the creator''s, on every question',
    (select array_agg(coalesce(voter_name, name) order by poll_id = v_questions[1])
       from invited_voters where poll_id = any(v_questions) and email = 'ann@example.com'),
    array['Annie', 'Annie']);
  perform tests.assert_raises('but not with somebody else''s',
    format('select set_voter_name(%L, %L)', v_questions[1], 'BEN'), 'already called "BEN"');
  perform tests.assert_raises('or with none',
    format('select set_voter_name(%L, %L)', v_questions[1], '  '), 'Enter your name');

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('somebody not invited cannot name themselves into it',
    format('select set_voter_name(%L, %L)', v_poll, 'Stranger'), 'Poll not found');

  -- ---- inviting somebody later ---------------------------------------------------

  perform tests.sign_in('creator@example.com');
  perform tests.assert_raises('somebody invited later needs a name too',
    format('select invite_voter(%L, %L)', v_poll, 'cat@example.com'), 'Give cat@example.com a name');
  perform tests.assert_raises('one nobody else has',
    format('select invite_voter(%L, %L, %L)', v_poll, 'cat@example.com', 'ann'),
    'already called "ann"');
  perform invite_voter(v_poll, 'cat@example.com', 'Cat');
  perform tests.assert_eq('and gets it',
    (select name from invited_voters where poll_id = v_poll and email = 'cat@example.com'), 'Cat');

  -- ---- a poll that shows addresses --------------------------------------------

  v_plain := create_poll('Lunch', null, array['Soup', 'Bread'],
    array['ann@example.com', 'ben@example.com'], 'invite', true, true);
  perform tests.assert_raises('gives nobody a name later',
    format('select invite_voter(%L, %L, %L)', v_plain, 'cat@example.com', 'Cat'),
    'shows its voters by email address');

  perform tests.sign_in('ann@example.com');
  perform tests.assert_eq('and shows the group its addresses, as it always did',
    (select array_agg(i.email) from poll_invitees(v_plain) i),
    array['ann@example.com', 'ben@example.com']);
  perform tests.assert_raises('nor lets an invitee name themselves',
    format('select set_voter_name(%L, %L)', v_plain, 'Ann'), 'shows its voters by email address');

  -- ---- the published sheet -------------------------------------------------------

  perform set_voter_name(v_poll, 'Annie');
  perform tests.cast_ballot(v_poll, array[5, 0]);
  perform tests.sign_in('ben@example.com');
  perform tests.cast_ballot(v_poll, array[0, 5]);
  perform tests.sign_in('creator@example.com');
  perform close_poll(v_poll);

  perform tests.sign_in('ben@example.com');
  v_sheet := poll_ballots(v_poll);
  perform tests.assert_eq('the sheet names each ballot as the roster does',
    (select array_agg(b ->> 'voter') from jsonb_array_elements(v_sheet -> 'ballots') b),
    array['Annie', 'Ben']);
  perform tests.assert_raises('and once the poll has finished, names stay put',
    format('select set_voter_name(%L, %L)', v_poll, 'Benjamin'), 'has finished');
end $$;

rollback;

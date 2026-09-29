-- Removing a poll from your list takes it off the list and out of your
-- notifications, and does nothing else.
--
-- The rules under test (0077): a removed poll is left out of list_polls
-- *before* the page is taken, so pages stay full and the total counts only
-- what can be shown; p_removed lists the removed ones instead; every row
-- carries how many are removed, and removed_poll_count answers the same for a
-- list with no rows. A group is removed whole, by whichever question. Only a
-- poll on the reader's list can be removed, and only by them for them -- the
-- next account's list is untouched. A removed poll's audience leaves the
-- account out, which is what stops both its emails and its pushes, whichever
-- of the three ways the account was in it. Restoring undoes all of it. The
-- reader's list is told; the poll is not; a deleted poll takes its rows.

begin;

do $$
declare
  v_polls uuid[] := array[]::uuid[];
  v_invite uuid;
  v_open uuid;
  v_group uuid;
  v_questions uuid[];
  v_other uuid;
  v_row polls;
  i int;
begin
  -- ------------------------------------------------------------------
  -- Twelve polls of the reader's own: a page of ten and a page of two.
  -- ------------------------------------------------------------------
  perform tests.sign_in('reader@example.com');
  for i in 1..12 loop
    v_polls := v_polls || create_poll('Poll ' || i, null, array['A', 'B'],
                                      array[]::text[], 'open', true, false);
  end loop;

  perform tests.assert_eq('the list starts with all twelve',
    (select max(total_count) from list_polls(10, 0)), 12);
  perform tests.assert_eq('and nothing removed',
    (select max(removed_count) from list_polls(10, 0)), 0);

  -- ------------------------------------------------------------------
  -- Removing ten: the page closes up rather than coming back empty.
  -- ------------------------------------------------------------------
  perform tests.forget_signals();
  perform tests.assert_eq('removing says how many went',
    remove_polls(v_polls[1:10]), 10);
  perform tests.assert_eq('and tells the reader''s list, once',
    tests.signals(tests.user_topic('reader@example.com')), 1);
  perform tests.assert_eq('and nothing else: the polls themselves did not change',
    tests.signalled(), array[tests.user_topic('reader@example.com')]);

  perform tests.assert_eq('the first page holds what is left rather than nothing',
    (select array_agg(id order by id) from list_polls(10, 0)),
    (select array_agg(x order by x) from unnest(v_polls[11:12]) x));
  perform tests.assert_eq('and the total counts only the polls that can be shown',
    (select max(total_count) from list_polls(10, 0)), 2);
  perform tests.assert_eq('every row says how many are removed',
    (select min(removed_count) from list_polls(10, 0)), 10);

  perform tests.assert_eq('the removed view lists the removed polls',
    (select max(total_count) from list_polls(10, 0, true)), 10);
  perform tests.assert_eq('and none of the others',
    (select count(*)::int from list_polls(10, 0, true) where id = any(v_polls[11:12])), 0);

  perform tests.assert_eq('removing again changes nothing',
    remove_polls(v_polls[1:2]), 0);

  perform remove_polls(v_polls[11:12]);
  perform tests.assert_eq('with everything removed the list is empty',
    (select count(*)::int from list_polls(10, 0)), 0);
  perform tests.assert_eq('which leaves no row to carry the count, so it can be asked',
    removed_poll_count(), 12);
  perform tests.assert_eq('two pages of the removed view hold every removed poll once',
    (select array_agg(id order by id) from (
       select id from list_polls(10, 0, true)
       union all
       select id from list_polls(10, 10, true)) s),
    (select array_agg(x order by x) from unnest(v_polls) x));

  -- ------------------------------------------------------------------
  -- Restoring puts them back.
  -- ------------------------------------------------------------------
  perform tests.forget_signals();
  perform tests.assert_eq('restoring says how many came back',
    restore_polls(v_polls), 12);
  perform tests.assert_eq('and tells the reader''s list',
    tests.signals(tests.user_topic('reader@example.com')), 1);
  perform tests.assert_eq('and the list is whole again',
    (select max(total_count) from list_polls(10, 0)), 12);
  perform tests.assert_eq('with nothing removed',
    removed_poll_count(), 0);

  -- ------------------------------------------------------------------
  -- A group is one poll, whichever question it is removed by.
  -- ------------------------------------------------------------------
  v_group := create_poll_group('Picnic', null,
    '[{"title":"Where","options":[{"name":"Park"},{"name":"Beach"}]},
      {"title":"When","options":[{"name":"Noon"},{"name":"One"}]}]'::jsonb,
    array[]::text[], 'open', true, false);
  v_questions := tests.group_questions(v_group);

  perform tests.assert_eq('a group is removed by its second question',
    remove_polls(array[v_questions[2]]), 1);
  perform tests.assert_eq('and every question of it says it is removed',
    poll_is_removed(v_questions[1]) and poll_is_removed(v_questions[2]), true);
  perform tests.assert_eq('and it is the group''s row that comes off the list',
    (select count(*)::int from list_polls(20, 0) where id = v_questions[1]), 0);
  perform tests.assert_eq('and the group''s row that is in the removed view',
    (select array_agg(id) from list_polls(20, 0, true)), array[v_questions[1]]);
  perform tests.assert_eq('restored by its second question too',
    restore_polls(array[v_questions[2]]), 1);

  -- ------------------------------------------------------------------
  -- Only a poll on the reader's list, and only for the reader.
  -- ------------------------------------------------------------------
  perform tests.sign_in('stranger@example.com');
  v_other := create_poll('Not yours', null, array['A', 'B'], array[]::text[], 'open', true, false);

  perform tests.sign_in('reader@example.com');
  perform tests.assert_eq('a poll that is not on the list cannot be removed from it',
    remove_polls(array[v_other]), 0);
  perform tests.assert_eq('and a poll that does not exist is skipped, not refused',
    remove_polls(array[gen_random_uuid(), v_polls[1]]), 1);

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_eq('one reader removing a poll takes nothing off another''s list',
    (select count(*)::int from list_polls(10, 0) where id = v_other), 1);
  perform tests.assert_eq('nor can they undo somebody else''s removal',
    restore_polls(array[v_polls[1]]), 0);

  perform tests.sign_out();
  perform tests.assert_raises('removing needs an account',
    'select remove_polls(array[''' || v_polls[1] || '''::uuid])',
    'Sign in to change your poll list');

  -- ------------------------------------------------------------------
  -- Nobody is told about a poll they removed.
  -- ------------------------------------------------------------------
  perform tests.sign_in('creator@example.com');
  v_invite := create_poll('Budget', null, array['More', 'Less'],
                          array['reader@example.com', 'other@example.com'],
                          'invite', true, false);
  v_open := create_poll('Movie night', null, array['Dune', 'Arrival'],
                        array[]::text[], 'open', true, false);

  perform tests.sign_in('reader@example.com');
  perform open_poll_submit(v_open, tests.open_scores(v_open, array[5, 1]), 'reader-open', 'Reader');

  select * into v_row from polls where id = v_invite;
  perform tests.assert_eq('an invitee is told about a poll on their list',
    (select array_agg(a order by a) from poll_email_audience(v_row, true, null) a),
    array['creator@example.com', 'other@example.com', 'reader@example.com']);

  perform tests.assert_eq('a poll on the list is not removed',
    poll_is_removed(v_invite), false);
  perform remove_polls(array[v_invite, v_open]);
  perform tests.assert_eq('and says so once it is',
    poll_is_removed(v_invite), true);

  -- The audience is what the push goes to as well as the email: push_poll is
  -- handed these addresses, so leaving one out here is leaving it out of both.
  perform tests.assert_eq('and not once they have removed it',
    (select array_agg(a order by a) from poll_email_audience(v_row, true, null) a),
    array['creator@example.com', 'other@example.com']);
  perform tests.assert_eq('which is the results audience too',
    (select array_agg(a order by a) from poll_results_audience(v_row, null) a),
    array['creator@example.com', 'other@example.com']);

  select * into v_row from polls where id = v_open;
  perform tests.assert_eq('an account that answered an open poll is left out once it is removed',
    (select count(*)::int from poll_email_audience(v_row, false, null) a
      where a = 'reader@example.com'), 0);

  -- Still in the poll, which is the difference between this and leaving.
  perform tests.assert_eq('a removed poll is still one the reader is invited to',
    is_invited_to_poll(v_invite), true);
  perform tests.cast_ballot(v_invite, array[5, 0]);
  perform tests.assert_eq('and can still vote in',
    (select count(*)::int from ballots b
      where b.poll_id = v_invite
        and b.voter_id = (select id from auth.users where email = 'reader@example.com')), 1);

  -- The creator removing their own poll stops their own letters, too.
  perform tests.sign_in('creator@example.com');
  perform tests.assert_eq('one account''s removal is not another''s',
    poll_is_removed(v_invite), false);
  perform remove_polls(array[v_invite]);
  select * into v_row from polls where id = v_invite;
  perform tests.assert_eq('a creator who removed their own poll is not told about it',
    (select array_agg(a order by a) from poll_email_audience(v_row, true, null) a),
    array['other@example.com']);
  perform restore_polls(array[v_invite]);

  perform tests.sign_in('reader@example.com');
  perform restore_polls(array[v_invite]);
  select * into v_row from polls where id = v_invite;
  perform tests.assert_eq('restoring a poll puts the reader back in its audience',
    (select array_agg(a order by a) from poll_email_audience(v_row, true, null) a),
    array['creator@example.com', 'other@example.com', 'reader@example.com']);

  -- ------------------------------------------------------------------
  -- A deleted poll takes its rows with it.
  -- ------------------------------------------------------------------
  perform remove_polls(array[v_polls[3]]);
  delete from polls where id = v_polls[3];
  perform tests.assert_eq('deleting a removed poll leaves nothing of it behind',
    (select count(*)::int from removed_polls where poll_id = v_polls[3]), 0);

  -- ------------------------------------------------------------------
  -- Grants.
  -- ------------------------------------------------------------------
  perform tests.assert_eq('nobody reads the table directly',
    has_table_privilege('authenticated', 'public.removed_polls', 'select'), false);
  perform tests.assert_eq('nor writes it',
    has_table_privilege('authenticated', 'public.removed_polls', 'insert'), false);
  perform tests.assert_eq('removing is not open to a link',
    has_function_privilege('anon', 'public.remove_polls(uuid[])', 'execute'), false);
  perform tests.assert_eq('and is to an account',
    has_function_privilege('authenticated', 'public.remove_polls(uuid[])', 'execute'), true);
  perform tests.assert_eq('restoring likewise',
    has_function_privilege('anon', 'public.restore_polls(uuid[])', 'execute'), false);
  perform tests.assert_eq('the count likewise',
    has_function_privilege('anon', 'public.removed_poll_count()', 'execute'), false);
  perform tests.assert_eq('whether a poll is removed is asked by an account',
    has_function_privilege('authenticated', 'public.poll_is_removed(uuid)', 'execute'), true);
  perform tests.assert_eq('and not by a link',
    has_function_privilege('anon', 'public.poll_is_removed(uuid)', 'execute'), false);
  perform tests.assert_eq('the list row lookup is internal',
    has_function_privilege('authenticated', 'public.poll_list_row(uuid)', 'execute'), false);
end $$;

rollback;

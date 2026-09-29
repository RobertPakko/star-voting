-- The poll list carries the open polls an account has answered, and tells
-- their readers nothing a link would not.
--
-- An open poll somebody else made is on your list when your account has a
-- ballot or a confirmation in any question of it -- cast through the link
-- while signed in, which is what records the account (0074). Nothing the
-- browser remembers enters into it any more. The rules under test: that is
-- the only way an open poll gets on, answering signed out does not count, a
-- group is one row whichever question was answered, and a row that is here
-- only because it was answered does not name its creator -- the promise
-- 15_share_link_names_no_email holds open_poll_view() to.
--
-- And that the list is told: every account that has answered a poll hears
-- about it on its `user:<id>` topic, like its creator and its invitees, so the
-- page watches that topic and nothing else.

begin;

do $$
declare
  v_open uuid;
  v_invite uuid;
  v_mine uuid;
  v_group uuid;
  v_questions uuid[];
  v_collect uuid;
  v_unanswered uuid;
  v_row record;
begin
  perform tests.sign_in('creator@example.com');
  v_open := create_poll('Movie night', null, array['Dune', 'Arrival'],
                        array[]::text[], 'open', true, false);
  v_unanswered := create_poll('Karaoke', null, array['Yes', 'No'],
                              array[]::text[], 'open', true, false);
  v_invite := create_poll('Budget', null, array['More', 'Less'],
                          array['someone@example.com'], 'invite', true, false);
  v_group := create_poll_group('Picnic', null,
    '[{"title":"Where","options":[{"name":"Park"},{"name":"Beach"}]},
      {"title":"When","options":[{"name":"Noon"},{"name":"One"}]}]'::jsonb,
    array[]::text[], 'open', true, false);
  -- A statement of its own: group_questions is STABLE, and asked in the same
  -- statement as the insert it would read the table from before it.
  v_questions := tests.group_questions(v_group);
  v_collect := create_poll('Offsite', null, array['Beach', 'Mountains'],
                           array[]::text[], 'open', true, false, null, true);

  -- Somebody who made none of them and is invited to none of them.
  perform tests.sign_in('reader@example.com');
  v_mine := create_poll('Mine', null, array['A', 'B'], array[]::text[], 'open', true, false);

  -- ------------------------------------------------------------------
  -- Before answering anything, the list is what it always was.
  -- ------------------------------------------------------------------

  perform tests.assert_eq('the list starts as what the reader made',
    (select array_agg(id) from list_polls(10, 0)), array[v_mine]);

  -- Answered signed out, from this very browser: no account on the ballot,
  -- so nothing for the list to find.
  perform tests.sign_out();
  perform open_poll_submit(v_unanswered, tests.open_scores(v_unanswered, array[5, 0]),
                           'reader-karaoke', 'Reader');
  perform tests.sign_in('reader@example.com');
  perform tests.assert_eq('a poll answered signed out is not listed',
    (select count(*)::int from list_polls(10, 0) where id = v_unanswered), 0);

  -- ------------------------------------------------------------------
  -- Answered signed in, it is on the list like any other.
  -- ------------------------------------------------------------------

  perform open_poll_submit(v_open, tests.open_scores(v_open, array[5, 1]), 'reader-open', 'Reader');

  perform tests.assert_eq('an open poll the account voted in is listed',
    (select count(*)::int from list_polls(10, 0) where id = v_open), 1);
  perform tests.assert_eq('and counted in the total the pager reads',
    (select max(total_count)::int from list_polls(10, 0)), 2);

  select * into v_row from list_polls(10, 0) where id = v_open;
  perform tests.assert_eq('it carries the poll''s own terms',
    v_row.title, 'Movie night');
  perform tests.assert_eq('and says the reader has voted in it',
    v_row.voted, true);
  perform tests.assert_null('but not the address of whoever made it',
    v_row.created_by_email);
  perform tests.assert_null('nor their account',
    v_row.created_by);

  -- The reader's own open poll, answered as well, is still their own poll:
  -- listed once, and still saying who made it.
  perform open_poll_submit(v_mine, tests.open_scores(v_mine, array[1, 1]), 'reader-mine', 'Reader');
  perform tests.assert_eq('a poll the reader made is listed once, answered or not',
    (select count(*)::int from list_polls(10, 0) where id = v_mine), 1);
  perform tests.assert_eq('and still names its creator',
    (select created_by_email from list_polls(10, 0) where id = v_mine),
    'reader@example.com');

  -- ------------------------------------------------------------------
  -- A poll of several questions is one row, by its first question.
  -- ------------------------------------------------------------------

  -- Answered in its second question only: the row is still the first.
  perform open_poll_submit(v_questions[2], tests.open_scores(v_questions[2], array[0, 5]),
                           'reader-when', 'Reader');
  perform tests.assert_eq('a group answered in a later question is listed by its first',
    (select array_agg(id) from list_polls(10, 0) where id = any(v_questions)),
    array[v_questions[1]]);
  perform tests.assert_eq('with its question count',
    (select question_count from list_polls(10, 0) where id = v_questions[1]), 2);
  perform open_poll_submit(v_questions[1], tests.open_scores(v_questions[1], array[5, 0]),
                           'reader-where', 'Reader');
  perform tests.assert_eq('and answering another question does not put it on twice',
    (select count(*)::int from list_polls(10, 0) where id = any(v_questions)), 1);

  -- ------------------------------------------------------------------
  -- A confirmation counts too, and taking it back takes the poll off.
  -- ------------------------------------------------------------------

  perform open_poll_confirm_options(v_collect, 'reader-offsite', 'Reader');
  perform tests.assert_eq('an open poll the account confirmed the options of is listed',
    (select count(*)::int from list_polls(10, 0) where id = v_collect), 1);

  perform tests.forget_signals();
  perform open_poll_unconfirm_options(v_collect, 'reader-offsite');
  perform tests.assert_eq('taking the confirmation back takes it off',
    (select count(*)::int from list_polls(10, 0) where id = v_collect), 0);
  perform tests.assert_eq('and tells the list it has gone from, though it is no longer on it',
    tests.signals(tests.user_topic('reader@example.com')), 1);

  -- ------------------------------------------------------------------
  -- Only what this account answered, and only open polls.
  -- ------------------------------------------------------------------

  perform tests.sign_in('someone@example.com');
  perform tests.assert_eq('somebody else''s ballots put nothing on this list',
    (select count(*)::int from list_polls(10, 0) where id in (v_open, v_mine)), 0);

  -- ------------------------------------------------------------------
  -- The list is told about the polls on it.
  -- ------------------------------------------------------------------

  -- A stranger's vote in a poll the reader answered reaches the reader's
  -- list, beside the poll's own topic and its creator's list.
  perform tests.sign_out();
  perform tests.forget_signals();
  perform open_poll_submit(v_open, tests.open_scores(v_open, array[0, 5]), 'stranger-open', 'Stranger');
  perform tests.assert_eq('a vote reaches every list the poll is on',
    tests.signalled(), tests.sorted(array[
      tests.poll_topic(v_open),
      tests.user_topic('creator@example.com'),
      tests.user_topic('reader@example.com')]));

  -- A vote in the group's second question reaches a reader who answered the
  -- first, since the row on their list is the whole group.
  perform tests.forget_signals();
  perform open_poll_submit(v_questions[2], tests.open_scores(v_questions[2], array[5, 5]),
                           'stranger-when', 'Stranger');
  perform tests.assert_eq('and a vote in any question reaches it',
    tests.signals(tests.user_topic('reader@example.com')), 1);

  -- The poll the reader answered only signed out tells them nothing.
  perform tests.forget_signals();
  perform open_poll_submit(v_unanswered, tests.open_scores(v_unanswered, array[0, 5]),
                           'stranger-karaoke', 'Stranger');
  perform tests.assert_eq('a poll not on the list does not wake it',
    tests.signals(tests.user_topic('reader@example.com')), 0);

  -- Deleting one tells the lists it was on, the answering account's included.
  perform tests.sign_in('creator@example.com');
  perform tests.forget_signals();
  delete from polls where id = v_open;
  perform tests.assert_eq('a deleted poll tells the lists of those who answered it',
    tests.signals(tests.user_topic('reader@example.com')), 1);

  -- ------------------------------------------------------------------
  -- Still an account's list, and no longer the browser's.
  -- ------------------------------------------------------------------

  -- Recreated rather than replaced, since the argument list changed, and a
  -- function created fresh is executable by PUBLIC until somebody says not.
  perform tests.assert_eq('the list is not callable without an account',
    has_function_privilege('anon', 'public.list_polls(integer, integer, boolean)', 'execute'),
    false);
  perform tests.assert_eq('and is with one',
    has_function_privilege('authenticated', 'public.list_polls(integer, integer, boolean)', 'execute'),
    true);
  perform tests.assert_eq('and takes no ids from the browser any more',
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'list_polls'),
    1);
  perform tests.assert_eq('the audience it is told through is internal',
    has_function_privilege('authenticated', 'public.poll_answering_accounts(uuid)', 'execute'),
    false);
end $$;

rollback;

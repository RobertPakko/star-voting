-- The poll list carries the open polls a browser has opened, and tells their
-- readers nothing a link would not.
--
-- The browser remembers which open polls it has opened and hands their ids to
-- list_polls() as p_open_ids. Holding an open poll's id is already the whole
-- of the right to read it, so the rule under test is that the list shows no
-- more than that right does: only an open poll qualifies, and a row that is
-- on the list only because its id was handed in does not name its creator --
-- the same promise 15_share_link_names_no_email holds open_poll_view() to.

begin;

do $$
declare
  v_open uuid;
  v_invite uuid;
  v_mine uuid;
  v_group uuid;
  v_questions uuid[];
  v_row record;
begin
  perform tests.sign_in('creator@example.com');
  v_open := create_poll('Movie night', null, array['Dune', 'Arrival'],
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

  -- Somebody who made none of them and is invited to none of them.
  perform tests.sign_in('reader@example.com');
  v_mine := create_poll('Mine', null, array['A', 'B'], array[]::text[], 'open', true, false);

  -- ------------------------------------------------------------------
  -- Without the ids, the list is what it always was.
  -- ------------------------------------------------------------------

  perform tests.assert_eq('a two-argument call lists only what the reader made',
    (select array_agg(id) from list_polls(10, 0)), array[v_mine]);

  -- ------------------------------------------------------------------
  -- With them, an opened open poll is on the list like any other.
  -- ------------------------------------------------------------------

  perform tests.assert_eq('an open poll this browser opened is listed',
    (select count(*)::int from list_polls(10, 0, array[v_open]) where id = v_open), 1);
  perform tests.assert_eq('and counted in the total the pager reads',
    (select max(total_count)::int from list_polls(10, 0, array[v_open])), 2);

  select * into v_row from list_polls(10, 0, array[v_open]) where id = v_open;
  perform tests.assert_eq('it carries the poll''s own terms',
    v_row.title, 'Movie night');
  perform tests.assert_null('but not the address of whoever made it',
    v_row.created_by_email);
  perform tests.assert_null('nor their account',
    v_row.created_by);

  -- The reader's own poll handed in as well is still their own poll: listed
  -- once, and still saying who made it.
  perform tests.assert_eq('a poll the reader made is listed once, however it is asked for',
    (select count(*)::int from list_polls(10, 0, array[v_mine, v_mine]) where id = v_mine), 1);
  perform tests.assert_eq('and still names its creator',
    (select created_by_email from list_polls(10, 0, array[v_mine]) where id = v_mine),
    'reader@example.com');

  -- ------------------------------------------------------------------
  -- Only an open poll.
  -- ------------------------------------------------------------------

  -- An invite poll's id is not a link to it, however it was come by.
  perform tests.assert_eq('an invite poll''s id lists nothing',
    (select count(*)::int from list_polls(10, 0, array[v_invite]) where id = v_invite), 0);
  perform tests.assert_eq('and counts for nothing either',
    (select max(total_count)::int from list_polls(10, 0, array[v_invite])), 1);

  -- An id that names no poll is simply nothing: a remembered poll that has
  -- since been deleted.
  perform tests.assert_eq('an id naming no poll lists nothing',
    (select max(total_count)::int from list_polls(10, 0, array[gen_random_uuid()])), 1);

  -- ------------------------------------------------------------------
  -- A poll of several questions is one row, by its first question.
  -- ------------------------------------------------------------------

  -- The browser hands in the first question's id whichever it opened, which
  -- is the id the list's row for a group carries; see openedPolls.ts.
  perform tests.assert_eq('a group is listed once, by its first question',
    (select array_agg(id) from list_polls(10, 0, array[v_questions[1]])
      where id = any(v_questions)),
    array[v_questions[1]]);
  perform tests.assert_eq('with its question count',
    (select question_count from list_polls(10, 0, array[v_questions[1]])
      where id = v_questions[1]), 2);
  perform tests.assert_eq('and a later question''s id does not put it on twice',
    (select count(*)::int from list_polls(10, 0, array[v_questions[1], v_questions[2]])
      where id = any(v_questions)), 1);

  -- ------------------------------------------------------------------
  -- Still an account's list.
  -- ------------------------------------------------------------------

  -- Recreated rather than replaced, since the argument list changed, and a
  -- function created fresh is executable by PUBLIC until somebody says not.
  perform tests.assert_eq('the list is not callable without an account',
    has_function_privilege('anon', 'public.list_polls(integer, integer, uuid[])', 'execute'),
    false);
  perform tests.assert_eq('and is with one',
    has_function_privilege('authenticated', 'public.list_polls(integer, integer, uuid[])', 'execute'),
    true);
end $$;

rollback;

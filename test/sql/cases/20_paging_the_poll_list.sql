-- The poll list is paged in the database, and a page is a page of the same
-- list every time.
--
-- The list used to be read whole and sliced in the browser, so "which rows
-- are on page two" was a question nobody asked the database. Now it is, and
-- offset paging has a failure that a single whole-list read cannot have: if
-- two requests disagree about the order, a row can appear on both pages or on
-- neither, and the reader is never told. That is what most of this case is
-- about.
--
-- And it bites harder here than in the app. A case is one transaction, and
-- `created_at` defaults to the transaction's clock, so all twelve polls below
-- share a timestamp to the microsecond -- there is no way to write this case
-- without that being true. Ordering by `created_at` alone would leave the tie
-- for the planner to break however it liked, differently per query, and these
-- assertions would pass or fail by luck. The `id` tiebreak in list_polls() is
-- what makes them mean anything.
--
-- In the app polls are created one at a time and their timestamps differ, so
-- there the tiebreak is insurance rather than the load-bearing part. Nothing
-- enforces that they differ, which is why it is there at all.

begin;

do $$
declare
  v_ids uuid[] := '{}'::uuid[];
  v_page1 uuid[];
  v_page2 uuid[];
  v_past uuid[];
  i int;
begin
  perform tests.sign_in('creator@example.com');

  -- Open polls, so no invite list is needed to make twelve of them.
  for i in 1 .. 12 loop
    v_ids := v_ids || create_poll('Poll ' || i, null, array['Yes', 'No'],
                                  array[]::text[], 'open', true, false);
  end loop;

  -- ------------------------------------------------------------------
  -- A page.
  -- ------------------------------------------------------------------

  perform tests.assert_eq('a page holds the limit it was given',
    (select count(*)::int from list_polls(10, 0)), 10);
  perform tests.assert_eq('and the last page holds what is left over',
    (select count(*)::int from list_polls(10, 10)), 2);

  -- The count is of the list, not of the page: it is what the pager counts
  -- pages from, so a page-sized answer would leave the reader with one page
  -- and no way to reach the rest.
  perform tests.assert_eq('the total is the whole list, not the page',
    (select max(total_count)::int from list_polls(10, 0)), 12);
  perform tests.assert_eq('and it is the same on every row of the page',
    (select count(distinct total_count)::int from list_polls(10, 0)), 1);

  -- ------------------------------------------------------------------
  -- Two pages partition one list: nothing on both, nothing on neither.
  -- ------------------------------------------------------------------

  select array_agg(id order by id) into v_page1 from list_polls(10, 0);
  select array_agg(id order by id) into v_page2 from list_polls(10, 10);

  perform tests.assert_eq('no poll is on both pages',
    (select count(*)::int
     from (select unnest(v_page1) intersect select unnest(v_page2)) both_pages), 0);
  perform tests.assert_eq('and between them they account for every poll',
    (select count(distinct u)::int from unnest(v_page1 || v_page2) u), 12);

  -- ------------------------------------------------------------------
  -- Asking past the end.
  --
  -- A poll deleted from page three must leave its reader on page three, or on
  -- the last page there is if that was it -- never on a blank one. The
  -- database clamps rather than the browser, so an empty answer means an
  -- empty list and the browser needs no separate way to tell the two apart.
  -- ------------------------------------------------------------------

  select array_agg(id order by id) into v_past from list_polls(10, 500);
  perform tests.assert_eq('a page past the end is the last page there is',
    v_past, v_page2);

  -- ------------------------------------------------------------------
  -- Newest first, which is the order the whole thing is paged in.
  -- ------------------------------------------------------------------

  perform tests.age_poll(v_ids[1], interval '1 day');
  perform tests.assert_eq('a poll a day older sorts to the very end',
    (select id from list_polls(1, 11)), v_ids[1]);
  perform tests.assert_eq('and is not on the first page',
    (select count(*)::int from list_polls(10, 0) where id = v_ids[1]), 0);

  -- ------------------------------------------------------------------
  -- Somebody else's list is still their own.
  --
  -- Paging changes which rows come back; it must not change which rows exist
  -- to come back. The visibility test runs before the page is taken.
  -- ------------------------------------------------------------------

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_eq('a stranger sees none of them',
    (select count(*)::int from list_polls(10, 0)), 0);
  perform tests.assert_eq('and asking for a later page of nothing is still nothing',
    (select count(*)::int from list_polls(10, 30)), 0);
end $$;

rollback;

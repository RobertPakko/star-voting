-- How many options a poll can hold, and both ways in agreeing about it.
--
-- The ceiling used to be fifty, and it used to be a ceiling on how long a
-- list a person will read to the end before scoring any of it. That is the
-- right question to ask of a list of options and the wrong one to ask of a
-- calendar -- a working week of half-hour starts is over a hundred windows,
-- and nobody reads a grid, they scan it. So it is five hundred now, for every
-- poll, and it is a ceiling on what the tally can be asked to do while a
-- voter waits for it.
--
-- The number matches MAX_OPTIONS in src/lib/limits.ts.
--
-- The half of this that is new is `insert_poll_row`. It inserts into
-- `candidates` directly and checked nothing, so a poll created over the cap
-- up front was accepted while the same poll built one option at a time was
-- refused. Both paths are checked here, because a cap enforced on one of two
-- doors is a cap on nothing.

begin;

do $$
declare
  v_poll uuid;
  v_names text[];
begin
  perform tests.sign_in('creator@example.com');

  -- ---- one at a time, through insert_option -------------------------------

  select array_agg('Option ' || g) into v_names from generate_series(1, 500) g;
  v_poll := create_poll('Everything', null, v_names, array['voter1@example.com']);

  perform tests.assert_eq('five hundred options go in',
    (select count(*)::int from candidates where poll_id = v_poll), 500);

  perform tests.assert_raises('and the five hundred and first does not',
    format('select creator_add_option(%L, %L)', v_poll, 'One more'),
    'as many options as it can hold');

  -- ---- and all at once, through insert_poll_row ---------------------------

  select array_agg('Option ' || g) into v_names from generate_series(1, 501) g;

  perform tests.assert_raises('a poll cannot be created over the cap either',
    format('select create_poll(%L, null, %L::text[], array[%L])',
           'Too much', v_names::text, 'voter1@example.com'),
    'can hold 500 options');

  -- The gap this closes was real: the two paths disagreeing meant the number
  -- in limits.ts was enforced or not depending on which door a poll came
  -- through, and the calendar is the first thing that can produce a list long
  -- enough to find out.
  select array_agg('Option ' || g) into v_names from generate_series(1, 500) g;
  v_poll := create_poll('Exactly enough', null, v_names, array['voter1@example.com']);
  perform tests.assert_eq('and one created at exactly the cap is fine',
    (select count(*)::int from candidates where poll_id = v_poll), 500);
end $$;

rollback;

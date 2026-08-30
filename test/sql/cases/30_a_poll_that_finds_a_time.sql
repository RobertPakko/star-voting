-- A poll that finds a time is stored exactly like a poll that chooses an
-- option, plus two columns.
--
-- The whole design rests on that: `poll_tally`, `star_round`, `settle_winner`
-- and the RLS policies never learn what an option means, so a time poll
-- reaches them as sixty rows in `candidates` and a score per row. What the
-- database does gain is `kind` and `schedule` -- and this case is about the
-- rules holding those two together, and about them surviving the reads the
-- front end draws its calendar from.

begin;

do $$
declare
  v_poll uuid;
  v_open uuid;
  v_plain uuid;
  v_page jsonb;
  v_view jsonb;
  v_schedule jsonb := '{"timezone":"-07:00","window":{"start":"08:00","end":"22:00"},"desired_slots":3,"granularity":60}'::jsonb;
  v_windows text[] := array[
    '2026-09-01T08:00:00-07:00',
    '2026-09-01T09:00:00-07:00',
    '2026-09-01T10:00:00-07:00'];
begin
  perform tests.sign_in('creator@example.com');

  -- ---- the two columns are tied together ---------------------------------

  -- Written against the table rather than through create_poll, because what
  -- is being checked here is the constraint itself: create_poll refuses these
  -- combinations earlier and in better words, and a constraint that only ever
  -- fires behind a function that has already refused is a constraint nobody
  -- ever finds out is missing.
  perform tests.assert_raises('a time poll without a schedule has a grid nobody can draw',
    format('insert into polls (title, created_by, kind) values (%L, %L, %L)',
           'Standup', auth.uid(), 'time'),
    'polls_schedule_ck');

  perform tests.assert_raises('and an option poll with one is carrying a ballot it does not have',
    format('insert into polls (title, created_by, schedule) values (%L, %L, %L)',
           'Lunch', auth.uid(), v_schedule::text),
    'polls_schedule_ck');

  perform tests.assert_raises('a poll is one of the two kinds there are',
    format('insert into polls (title, created_by, kind) values (%L, %L, %L)',
           'Lunch', auth.uid(), 'vibes'),
    'polls_kind_ck');

  -- ---- what create_poll will accept as a schedule ------------------------

  perform tests.assert_raises('a timezone is a fixed offset, never a named zone',
    format('select create_poll(%L, null, %L::text[], array[%L], %L, true, false, null, false, %L, %L::jsonb)',
           'Standup', v_windows::text, 'voter1@example.com', 'invite', 'time',
           jsonb_set(v_schedule, '{timezone}', '"America/Los_Angeles"')::text),
    'fixed UTC offset');

  perform tests.assert_raises('a daily window ends after it starts',
    format('select create_poll(%L, null, %L::text[], array[%L], %L, true, false, null, false, %L, %L::jsonb)',
           'Standup', v_windows::text, 'voter1@example.com', 'invite', 'time',
           jsonb_set(v_schedule, '{window,end}', '"07:00"')::text),
    'end after it starts');

  -- The calendar draws a row per granule; one that does not divide the hour
  -- draws grid lines that do not line up with the labels beside them.
  perform tests.assert_raises('a granularity divides the hour',
    format('select create_poll(%L, null, %L::text[], array[%L], %L, true, false, null, false, %L, %L::jsonb)',
           'Standup', v_windows::text, 'voter1@example.com', 'invite', 'time',
           jsonb_set(v_schedule, '{granularity}', '25')::text),
    'divides an hour evenly');

  -- A voter "adding Thursday" adds a dozen options, one per window start, and
  -- the suggestion path inserts them one at a time -- so a run that failed
  -- halfway would leave a Thursday with morning windows and no afternoon.
  -- Refused here rather than only hidden in the form.
  perform tests.assert_raises('a time poll does not collect its times from voters',
    format('select create_poll(%L, null, %L::text[], array[%L], %L, true, false, null, true, %L, %L::jsonb)',
           'Standup', v_windows::text, 'voter1@example.com', 'invite', 'time', v_schedule::text),
    'cannot collect its times');

  perform tests.assert_raises('and an ordinary poll is not handed a schedule',
    format('select create_poll(%L, null, array[%L, %L], array[%L], %L, true, false, null, false, %L, %L::jsonb)',
           'Lunch', 'Pizza', 'Sushi', 'voter1@example.com', 'invite', 'option', v_schedule::text),
    'Only a time poll has a schedule');

  -- ---- and one that is made, read back ------------------------------------

  v_poll := create_poll('Standup', null, v_windows, array['voter1@example.com'],
                        'invite', true, false, null, false, 'time', v_schedule);

  perform tests.assert_eq('a time poll is stored as one',
    (select kind from polls where id = v_poll), 'time');
  perform tests.assert_eq('with the grid its ballot is drawn on',
    (select schedule from polls where id = v_poll), v_schedule);
  perform tests.assert_eq('and its windows as ordinary options',
    (select count(*)::int from candidates where poll_id = v_poll), 3);

  -- An ordinary poll is unchanged, and says so rather than being assumed to
  -- be: `kind` has a default, and a default nobody asserts is a default that
  -- can quietly become something else.
  v_plain := create_poll('Lunch', null, array['Pizza', 'Sushi'], array['voter1@example.com']);
  perform tests.assert_eq('a poll made the old way is still an option poll',
    (select kind from polls where id = v_plain), 'option');
  perform tests.assert_null('and has no grid to draw',
    (select schedule from polls where id = v_plain));

  -- The read that opens a poll page carries the whole row, so both columns
  -- arrive with it; this is what the calendar on the ballot is drawn from.
  v_page := poll_page(v_poll);
  perform tests.assert_eq('the read that opens the page says which kind it is',
    v_page #>> '{poll,kind}', 'time');
  perform tests.assert_eq('and carries the schedule with it',
    v_page #> '{poll,schedule}', v_schedule);

  -- The share-link reading builds its poll object a field at a time, so it is
  -- the one that can silently lose them.
  v_open := create_poll('Standup, publicly', null, v_windows, array[]::text[],
                        'open', true, false, null, false, 'time', v_schedule);
  v_view := open_poll_view(v_open);
  perform tests.assert_eq('a link holder is told the same thing',
    v_view #>> '{poll,kind}', 'time');
  perform tests.assert_eq('and handed the same grid',
    v_view #> '{poll,schedule}', v_schedule);

  -- The poll list card needs them too: a finished time poll's winner_name is
  -- a timestamp, and a card that was not told so would print it raw.
  perform tests.assert_eq('and so is the card on the poll list',
    (select kind from list_polls(20, 0) where id = v_poll), 'time');
  perform tests.assert_eq('with the grid, so the card can say how long the window is',
    (select schedule from list_polls(20, 0) where id = v_poll), v_schedule);

  -- ---- its options are its windows, and stay that way ---------------------

  -- A hand-typed name among generated ones is not a window: the calendar
  -- cannot draw it and the minimum rule cannot score it.
  perform tests.assert_raises('a creator cannot type an option into a calendar',
    format('select creator_add_option(%L, %L)', v_poll, 'Whenever suits'),
    'options are its windows');

  perform creator_add_option(v_plain, 'Curry');
  perform tests.assert_eq('while an ordinary poll takes one as it always did',
    (select count(*)::int from candidates where poll_id = v_plain), 3);
end $$;

rollback;

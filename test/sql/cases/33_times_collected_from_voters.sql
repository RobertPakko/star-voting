-- A time poll can collect its times, and can be one question among several.
--
-- Both were refused until 0056, and the first was refused for a reason: a
-- voter "adding Thursday afternoon" adds a handful of options -- one per
-- window start -- and the suggestion path inserted one at a time, so a run
-- that failed halfway left a Thursday with morning windows and no afternoon.
-- What unblocks it is `insert_options`, which takes the whole painting in one
-- statement, and the three plural doors onto it.
--
-- The second was refused only because `create_poll_group` took no kind. It
-- now reads one off each question, so a poll may ask "what are we watching?"
-- and "when?" in one sitting.

begin;

do $$
declare
  v_poll uuid;
  v_open uuid;
  v_first uuid;
  v_when uuid;
  v_schedule jsonb := '{"timezone":"-07:00","window":{"start":"08:00","end":"22:00"},"desired_slots":2,"granularity":60}'::jsonb;
begin
  perform tests.sign_in('creator@example.com');

  -- ---- an invite poll that collects its times -----------------------------

  -- With none at all, which is the state the whole feature is for: the
  -- creator says how long the meeting is and where in the world it is, and
  -- the group says when.
  v_poll := create_poll('When are we all free?', null, array[]::text[],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false, null, true, 'time', v_schedule);

  perform tests.assert_eq('a time poll may collect its times',
    (select solicit_options from polls where id = v_poll), true);
  perform tests.assert_eq('and starts with no windows on it',
    (select count(*)::int from candidates where poll_id = v_poll), 0);

  perform tests.sign_in('voter1@example.com');
  perform tests.assert_eq('a voter paints an afternoon and it arrives as windows',
    suggest_options(v_poll, '[{"name":"2026-09-01T13:00:00-07:00"},'
                            '{"name":"2026-09-01T14:00:00-07:00"},'
                            '{"name":"2026-09-01T15:00:00-07:00"}]'::jsonb), 3);

  -- The rule that makes a batch a sensible thing to send at all. Two voters
  -- painting overlapping afternoons are not making a mistake, and there is
  -- nothing the second of them could do about being told so.
  perform tests.sign_in('voter2@example.com');
  perform tests.assert_eq('and an overlapping one adds only what is new',
    suggest_options(v_poll, '[{"name":"2026-09-01T14:00:00-07:00"},'
                            '{"name":"2026-09-01T16:00:00-07:00"}]'::jsonb), 1);
  perform tests.assert_eq('so the list is the union of the two paintings',
    (select count(*)::int from candidates where poll_id = v_poll), 4);

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('somebody outside the poll paints nothing',
    format('select suggest_options(%L, %L::jsonb)', v_poll,
           '[{"name":"2026-09-01T17:00:00-07:00"}]'),
    'Poll not found');

  -- The stage is the same one a list of options has, refused in the same
  -- words: a list that is already a ballot has stopped growing.
  perform tests.sign_in('creator@example.com');
  perform finalize_options(v_poll);
  perform tests.assert_raises('and nobody adds a time once the ballot is settled',
    format('select suggest_options(%L, %L::jsonb)', v_poll,
           '[{"name":"2026-09-01T17:00:00-07:00"}]'),
    'settled and voting has started');

  -- ---- and one behind a link ---------------------------------------------

  v_open := create_poll('When, publicly', null, array[]::text[], array[]::text[],
                        'open', true, false, null, true, 'time', v_schedule);

  perform tests.sign_in('nobody@example.com');
  perform tests.assert_eq('a link holder paints the same way',
    open_poll_suggest_options(v_open, '[{"name":"2026-09-02T09:00:00-07:00"},'
                                      '{"name":"2026-09-02T10:00:00-07:00"}]'::jsonb), 2);

  -- The invite door says so rather than pretending not to exist, and it is
  -- the creator who is told: to anybody else an open poll they are not in is
  -- a poll they have not been shown, which is the same 'not found' as ever.
  perform tests.sign_in('creator@example.com');
  perform tests.assert_raises('and the invite door is not the one to come in by',
    format('select suggest_options(%L, %L::jsonb)', v_open,
           '[{"name":"2026-09-02T11:00:00-07:00"}]'),
    'suggested through that link');

  -- ---- a time poll among several questions --------------------------------

  perform tests.sign_in('creator@example.com');
  v_first := create_poll_group('Offsite', null,
    ('[{"title":"Where?","options":[{"name":"The barn"},{"name":"The lake"}]},'
     '{"title":"When?","kind":"time","schedule":' || v_schedule::text || ','
     '"options":[{"name":"2026-09-01T09:00:00-07:00"},'
                '{"name":"2026-09-01T10:00:00-07:00"}]}]')::jsonb,
    array['voter1@example.com'], 'invite', true, false, false);

  select id into v_when from polls
  where group_id = (select group_id from polls where id = v_first) and question_position = 2;

  perform tests.assert_eq('the first question is an ordinary one',
    (select kind from polls where id = v_first), 'option');
  perform tests.assert_eq('and the second is a calendar',
    (select kind from polls where id = v_when), 'time');
  perform tests.assert_eq('carrying the grid it is drawn on',
    (select schedule from polls where id = v_when), v_schedule);

  -- The same two rules `create_poll` applies to its own arguments, said again
  -- on this path because it is the other way into `insert_poll_row`.
  perform tests.assert_raises('a time question without a grid is refused here too',
    format('select create_poll_group(%L, null, %L::jsonb, array[%L], %L, true, false, false)',
           'Offsite', '[{"title":"Where?","options":[{"name":"A"},{"name":"B"}]},'
                      '{"title":"When?","kind":"time","options":[{"name":"x"},{"name":"y"}]}]',
           'voter1@example.com', 'invite'),
    'A time poll needs a schedule');

  perform tests.assert_raises('and an ordinary question is not handed one',
    format('select create_poll_group(%L, null, %L::jsonb, array[%L], %L, true, false, false)',
           'Offsite', '[{"title":"Where?","options":[{"name":"A"},{"name":"B"}],"schedule":'
                      || v_schedule::text || '},'
                      '{"title":"When?","options":[{"name":"x"},{"name":"y"}]}]',
           'voter1@example.com', 'invite'),
    'Only a time question has a schedule');

  -- ---- the plural doors are no wider than the singular ones ---------------

  -- `anon` reaches PostgREST as a member of PUBLIC, and this app grants it
  -- nothing outside the open_poll_* functions. A newly created function is
  -- executable by PUBLIC until told otherwise, which is easy to leave out and
  -- invisible when you do.
  perform tests.assert_eq('adding a batch of options is not something anyone can do',
    (select bool_or(a::text like '=%')
       from pg_proc p, unnest(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.pronamespace = 'public'::regnamespace and p.proname = 'suggest_options'),
    false);
  perform tests.assert_eq('nor the row behind all three of them',
    (select bool_or(a::text like '=%')
       from pg_proc p, unnest(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.pronamespace = 'public'::regnamespace and p.proname = 'insert_options'),
    false);
  perform tests.assert_eq('and the internal one is reachable by nobody outside',
    has_function_privilege('anon', 'public.insert_options(public.polls, jsonb)', 'execute'),
    false);
  perform tests.assert_eq('while a link holder can still paint one',
    has_function_privilege('anon', 'public.open_poll_suggest_options(uuid, jsonb)', 'execute'),
    true);
end $$;

rollback;

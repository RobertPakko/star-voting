-- A calendar is a ballot, not a kind: any question but a proportional budget
-- may be asked of painted meeting windows, and the tally says which it was.
--
-- Here three interview slots, back to back (a step as long as the meeting),
-- one place each, for three candidates:
--
--              09:00 10:00 11:00
--   voter 1      5     4     0
--   voter 2      5     0     0
--   voter 3      0     2     5
--
-- Voter 2 can only make 09:00, so voter 1 gives it up for 10:00:
-- 5 x 4 x 5 = 100, where voter 1 at 09:00 leaves voter 2 nothing.

begin;

do $$
declare
  v_schedule jsonb := '{"timezone":"-07:00","window":{"start":"09:00","end":"12:00"},'
                      '"desired_slots":2,"granularity":30,"step":60,"places":1}'::jsonb;
  v_emails text[] := array['voter1@example.com', 'voter2@example.com', 'voter3@example.com'];
  v_ballots int[][] := array[[5, 4, 0], [5, 0, 0], [0, 2, 5]];
  v_poll uuid;
  v_list uuid;
  t jsonb;
  a jsonb;
  i int;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Interviews', null,
    array['2026-09-01T09:00:00-07:00', '2026-09-01T10:00:00-07:00', '2026-09-01T11:00:00-07:00'],
    v_emails, 'invite', true, true, null, false, 'assignment', v_schedule, null, null,
    array[1, 1, 1]);
  v_list := create_poll('Lunch', null, array['Pizza', 'Sushi'], v_emails);

  perform tests.assert_eq('an assignment of times is an assignment with a schedule',
    (select kind || ' ' || (schedule is not null) from polls where id = v_poll), 'assignment true');
  perform tests.assert_eq('each window carries its places',
    (select array_agg(kind_value order by name) from candidates where poll_id = v_poll),
    array[1, 1, 1]::numeric[]);

  -- A window suggested later is given the places by whoever paints it; the
  -- schedule is where they read how many.
  perform tests.assert_eq('the schedule keeps the step and the places',
    (select schedule ->> 'step' || ' ' || (schedule ->> 'places') from polls where id = v_poll), '60 1');

  for i in 1 .. 3 loop
    perform tests.sign_in(v_emails[i]);
    perform tests.cast_ballot(v_poll, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
    perform tests.cast_ballot(v_list, array[5, 0]);
  end loop;
  perform tests.sign_in('creator@example.com');
  perform close_poll(v_poll);
  perform close_poll(v_list);

  t := get_poll_results(v_poll);
  perform tests.assert_eq('the tally says the options are a calendar''s', t ->> 'calendar', 'true');
  perform tests.assert_eq('and of a written list that they are not',
    get_poll_results(v_list) ->> 'calendar', 'false');

  a := t -> 'kind_result';
  perform tests.assert_eq('voter 2 gets the one slot they can make',
    (select o ->> 'name' from jsonb_array_elements(a -> 'options') o,
                              jsonb_array_elements(o -> 'voters') v
      where v ->> 'name' = 'voter2@example.com'),
    '2026-09-01T09:00:00-07:00');
  perform tests.assert_eq('so voter 1 takes the next',
    (select o ->> 'name' from jsonb_array_elements(a -> 'options') o,
                              jsonb_array_elements(o -> 'voters') v
      where v ->> 'name' = 'voter1@example.com'),
    '2026-09-01T10:00:00-07:00');
  perform tests.assert_eq('and voter 3 the last',
    (select o ->> 'name' from jsonb_array_elements(a -> 'options') o,
                              jsonb_array_elements(o -> 'voters') v
      where v ->> 'name' = 'voter3@example.com'),
    '2026-09-01T11:00:00-07:00');
  perform tests.assert_null('an assignment names no one winner',
    (select winner_settled_at from polls where id = v_poll));
end $$;

rollback;

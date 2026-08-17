-- The full ranking re-runs the whole STAR round on the options that are left,
-- over and over. Whatever it decides, every option has to come out of it
-- exactly once: a duplicate or a dropped option would corrupt the list the
-- results page renders.

begin;

do $$
declare
  v_poll uuid;
  t jsonb;
  v_places int;
  v_listed int;
  v_distinct int;
begin
  v_poll := tests.seed_poll(
    array['Apple', 'Banana', 'Cherry', 'Date'],
    array[
      [5, 4, 3, 2],
      [5, 4, 3, 1],
      [4, 5, 2, 0]
    ]);

  t := poll_tally(v_poll);

  perform tests.assert_eq('Apple wins the runoff', tests.winner(t), 'Apple');
  perform tests.assert_eq('first',  tests.placed_at(t, 1), array['Apple']);
  perform tests.assert_eq('second', tests.placed_at(t, 2), array['Banana']);
  perform tests.assert_eq('third',  tests.placed_at(t, 3), array['Cherry']);
  perform tests.assert_eq('fourth', tests.placed_at(t, 4), array['Date']);

  select count(*) into v_places from jsonb_array_elements(t->'ranking');

  select count(*), count(distinct o->>'id')
  into v_listed, v_distinct
  from jsonb_array_elements(t->'ranking') r,
       jsonb_array_elements(r->'options') o;

  perform tests.assert_eq('four options produce four places', v_places, 4);
  perform tests.assert_eq('every option is placed', v_listed::int, 4);
  perform tests.assert_eq('and none is placed twice', v_distinct::int, 4);

  -- Each place beyond the first also carries the round that produced it, so
  -- the page can explain why an option landed where it did.
  perform tests.assert_eq('the second-place round shows its runoff',
    (t #>> '{ranking,1,runoff,resolved_by}'), 'preference');
end $$;

rollback;

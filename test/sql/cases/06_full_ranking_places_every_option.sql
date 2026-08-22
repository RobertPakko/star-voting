-- The full ranking re-runs the whole STAR round on the options that are left,
-- over and over. Whatever it decides, every option has to come out of it
-- exactly once: a duplicate or a dropped option would corrupt the list the
-- results page renders.
--
-- It is asked for separately from the tally, and has to agree with it: the
-- option poll_tally() elects is the option poll_ranking() places first.

begin;

do $$
declare
  v_poll uuid;
  t jsonb;
  r jsonb;
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
  r := poll_ranking(v_poll);

  perform tests.assert_eq('Apple wins the runoff', tests.winner(t), 'Apple');
  perform tests.assert_eq('first',  tests.placed_at(r, 1), array['Apple']);
  perform tests.assert_eq('second', tests.placed_at(r, 2), array['Banana']);
  perform tests.assert_eq('third',  tests.placed_at(r, 3), array['Cherry']);
  perform tests.assert_eq('fourth', tests.placed_at(r, 4), array['Date']);

  -- The two calls are separate; the winner of one is first place in the
  -- other, or the modal contradicts the card that opened it.
  perform tests.assert_eq('and the ranking agrees with the tally about first',
    tests.placed_at(r, 1), array[tests.winner(t)]);

  select count(*) into v_places from jsonb_array_elements(r);

  select count(*), count(distinct o->>'id')
  into v_listed, v_distinct
  from jsonb_array_elements(r) place,
       jsonb_array_elements(place->'options') o;

  perform tests.assert_eq('four options produce four places', v_places, 4);
  perform tests.assert_eq('every option is placed', v_listed::int, 4);
  perform tests.assert_eq('and none is placed twice', v_distinct::int, 4);

  -- Each place beyond the first also carries the round that produced it, so
  -- the page can explain why an option landed where it did.
  perform tests.assert_eq('the second-place round shows its runoff',
    (r #>> '{1,runoff,resolved_by}'), 'preference');
end $$;

rollback;

-- When every rule is exhausted the app reports the tie instead of inventing a
-- winner. Two options scored identically by everyone are level on preference,
-- on points and on five-star ballots, which is the one case with no answer.

begin;

do $$
declare
  v_poll uuid;
  t jsonb;
begin
  v_poll := tests.seed_poll(
    array['Apple', 'Banana'],
    array[
      [3, 3],
      [3, 3]
    ]);

  t := poll_tally(v_poll);

  perform tests.assert_eq('the two are level on points',
    tests.total_score(t, 'Apple'), tests.total_score(t, 'Banana'));
  perform tests.assert_eq('nobody preferred either one', tests.prefers(t, 'Apple'), 0);
  perform tests.assert_eq('both voters scored them equally',
    (t #>> '{runoff,ties}')::int, 2);
  perform tests.assert_eq('neither has a five-star ballot',
    tests.five_stars(t, 'Apple'), 0);

  perform tests.assert_eq('the runoff gives up',
    t #>> '{runoff,resolved_by}', 'unresolved');
  perform tests.assert_null('and names no winner', t->>'winner_id');

  -- The results page shows "a genuine tie" on exactly this shape: no winner,
  -- but two finalists to name. Losing either half would turn the tie into a
  -- blank panel.
  perform tests.assert_eq('while still naming both finalists',
    jsonb_array_length(t->'finalists'), 2);

  perform tests.assert_eq('the ranking puts them level in first',
    tests.placed_at(poll_ranking(v_poll), 1), array['Apple', 'Banana']);
  perform tests.assert_eq('and there is no second place',
    jsonb_array_length(poll_ranking(v_poll)), 1);
end $$;

rollback;

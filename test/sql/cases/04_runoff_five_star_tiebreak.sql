-- The runoff tie-break added in 0018_runoff_five_star_tiebreak.sql.
--
-- Two finalists split the preference vote evenly and finish on identical
-- totals, so neither preference nor points can call it. Before that migration
-- the election was reported as a tie here; now the five-star count gets the
-- last word.

begin;

do $$
declare
  v_poll uuid;
  t jsonb;
begin
  -- Both end on 5 points, and each is preferred by exactly one voter. Apple
  -- is the only one anybody gave five stars.
  v_poll := tests.seed_poll(
    array['Apple', 'Banana'],
    array[
      [5, 4],
      [0, 1]
    ]);

  t := poll_tally(v_poll);

  perform tests.assert_eq('the finalists are level on points',
    tests.total_score(t, 'Apple'), tests.total_score(t, 'Banana'));
  perform tests.assert_eq('one voter prefers Apple',  tests.prefers(t, 'Apple'), 1);
  perform tests.assert_eq('one prefers Banana',       tests.prefers(t, 'Banana'), 1);
  perform tests.assert_eq('and nobody scored them equally',
    (t #>> '{runoff,ties}')::int, 0);

  perform tests.assert_eq('Apple has the only five-star ballot',
    tests.five_stars(t, 'Apple'), 1);
  perform tests.assert_eq('Banana has none', tests.five_stars(t, 'Banana'), 0);

  perform tests.assert_eq('so the five-star count decides the runoff',
    t #>> '{runoff,resolved_by}', 'five_star_votes');
  perform tests.assert_eq('and Apple wins rather than the poll tying',
    tests.winner(t), 'Apple');

  perform tests.assert_eq('no score-round tie-break was involved',
    jsonb_array_length(t->'tiebreaks'), 0);
  perform tests.assert_eq('Banana is second',
    tests.placed_at(poll_ranking(v_poll), 2), array['Banana']);
end $$;

rollback;

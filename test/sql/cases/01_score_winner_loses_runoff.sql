-- The point of STAR: leading the score round does not win the election.
--
-- Apple is scored far higher in total, but only two voters actually prefer it
-- to Banana, and the runoff asks that question rather than the points one.

begin;

do $$
declare
  v_poll uuid;
  t jsonb;
begin
  v_poll := tests.seed_poll(
    array['Apple', 'Banana', 'Cherry'],
    array[
      [5, 0, 0],   -- two voters love Apple
      [5, 0, 0],
      [1, 2, 0],   -- three mildly prefer Banana
      [1, 2, 0],
      [1, 2, 0]
    ]);

  t := poll_tally(v_poll);

  perform tests.assert_eq('Apple leads the score round', tests.total_score(t, 'Apple'), 13);
  perform tests.assert_eq('Banana trails on points',    tests.total_score(t, 'Banana'), 6);
  perform tests.assert_eq('options are listed high to low',
    tests.option_order(t), array['Apple', 'Banana', 'Cherry']);

  perform tests.assert_eq('the two highest scorers are the finalists',
    tests.finalists(t), array['Apple', 'Banana']);

  perform tests.assert_eq('two voters prefer Apple',  tests.prefers(t, 'Apple'), 2);
  perform tests.assert_eq('three prefer Banana',      tests.prefers(t, 'Banana'), 3);
  perform tests.assert_eq('the runoff is decided on preference',
    t #>> '{runoff,resolved_by}', 'preference');
  perform tests.assert_eq('Banana wins despite the lower score', tests.winner(t), 'Banana');

  perform tests.assert_eq('no tie-break was needed', jsonb_array_length(t->'tiebreaks'), 0);
  perform tests.assert_eq('the score leader takes second',  tests.placed_at(t, 2), array['Apple']);
  perform tests.assert_eq('Cherry takes third',             tests.placed_at(t, 3), array['Cherry']);

  perform tests.assert_eq('every voter is counted', (t->>'voter_count')::int, 5);
  perform tests.assert_eq('the poll ran its course', (t->>'closed_early')::boolean, false);
end $$;

rollback;

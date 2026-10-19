-- Three options tied for two finalist slots. A tie of three or more is not
-- settled head to head at all: the count of five-star ballots is its first
-- rule. Here head-to-head would have advanced Banana, and five-star votes
-- advance Cherry instead.

begin;

do $$
declare
  v_poll uuid;
  t jsonb;
  tb jsonb;
begin
  -- All three finish on 15 points. A majority of three voters ranks
  -- Apple > Banana > Cherry, but nobody gives Banana five stars, while the
  -- other two voters give them to Cherry.
  v_poll := tests.seed_poll(
    array['Apple', 'Banana', 'Cherry'],
    array[
      [5, 4, 2],
      [5, 4, 2],
      [5, 4, 1],
      [0, 2, 5],
      [0, 1, 5]
    ]);

  t := poll_tally(v_poll);
  tb := t #> '{tiebreaks,0}';

  perform tests.assert_eq('Apple ties on points',  tests.total_score(t, 'Apple'), 15);
  perform tests.assert_eq('Banana ties on points', tests.total_score(t, 'Banana'), 15);
  perform tests.assert_eq('Cherry ties on points', tests.total_score(t, 'Cherry'), 15);

  perform tests.assert_eq('it is a tie at 15 points', (tb->>'tied_at')::int, 15);
  perform tests.assert_eq('for two finalist slots',   (tb->>'slots')::int, 2);
  perform tests.assert_eq('between all three options', jsonb_array_length(tb->'tied'), 3);

  perform tests.assert_eq('five-star votes settle it',
    tb->>'resolved_by', 'five_star_votes');
  perform tests.assert_eq('it is the only rule shown', jsonb_array_length(tb->'steps'), 1);
  perform tests.assert_eq('and it is the five-star count',
    tb #>> '{steps,0,rule}', 'five_star_votes');
  perform tests.assert_eq('marked decisive',
    (tb #>> '{steps,0,decisive}')::boolean, true);
  perform tests.assert_eq('Apple has the most five-star ballots',
    tb #>> '{steps,0,results,0,name}', 'Apple');
  perform tests.assert_eq('three of them',
    (tb #>> '{steps,0,results,0,value}')::int, 3);
  perform tests.assert_eq('Cherry has the next most',
    tb #>> '{steps,0,results,1,name}', 'Cherry');

  perform tests.assert_eq('so Apple and Cherry advance',
    tests.finalists(t), array['Apple', 'Cherry']);
  perform tests.assert_eq('three voters prefer Apple in the runoff',
    tests.prefers(t, 'Apple'), 3);
  perform tests.assert_eq('Apple wins', tests.winner(t), 'Apple');

  -- The ladder below first place is its own runoff: Banana and Cherry, level
  -- on points, are the two left and meet head to head, where Banana is
  -- preferred three to two. Missing the finalists' runoff does not stop an
  -- option placing above the one that took its slot.
  perform tests.assert_eq('Banana is second',
    tests.placed_at(poll_ranking(v_poll), 2), array['Banana']);
  perform tests.assert_eq('Cherry is third',
    tests.placed_at(poll_ranking(v_poll), 3), array['Cherry']);
end $$;

rollback;

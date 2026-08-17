-- Three options tied for two finalist slots. The first tie-break rule is
-- head-to-head preference, and here it separates them outright, so the
-- five-star count is never consulted.

begin;

do $$
declare
  v_poll uuid;
  t jsonb;
  tb jsonb;
begin
  -- All three finish on 15 points. A majority of three voters ranks
  -- Apple > Banana > Cherry; the other two rank it the other way round but
  -- score generously enough to level the totals.
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

  perform tests.assert_eq('the three-way tie is reported', jsonb_array_length(t->'tiebreaks'), 1);
  perform tests.assert_eq('the tie is flagged for the results page',
    (t->>'tie')::boolean, true);
  perform tests.assert_eq('it is a tie at 15 points', (tb->>'tied_at')::int, 15);
  perform tests.assert_eq('for two finalist slots',   (tb->>'slots')::int, 2);
  perform tests.assert_eq('between all three options', jsonb_array_length(tb->'tied'), 3);

  perform tests.assert_eq('head-to-head settles it',
    tb->>'resolved_by', 'head_to_head');
  perform tests.assert_eq('so only the head-to-head step is shown',
    jsonb_array_length(tb->'steps'), 1);
  perform tests.assert_eq('and it is marked as the decisive one',
    (tb #>> '{steps,0,decisive}')::boolean, true);
  perform tests.assert_eq('Apple beats both of the others',
    (tb #>> '{steps,0,results,0,value}')::int, 2);

  perform tests.assert_eq('Apple and Banana advance',
    tests.finalists(t), array['Apple', 'Banana']);
  perform tests.assert_eq('three voters prefer Apple in the runoff',
    tests.prefers(t, 'Apple'), 3);
  perform tests.assert_eq('Apple wins', tests.winner(t), 'Apple');

  -- Cherry lost the tie-break, so it cannot place above the option it lost to.
  perform tests.assert_eq('Banana is second', tests.placed_at(t, 2), array['Banana']);
  perform tests.assert_eq('Cherry is third',  tests.placed_at(t, 3), array['Cherry']);
end $$;

rollback;

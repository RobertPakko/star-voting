-- The second tie-break rule. Three options tied on points again, but this
-- time head-to-head cannot separate the two that matter -- the option holding
-- the last finalist slot and the one that would take it -- so the count of
-- five-star ballots decides which of them advances.

begin;

do $$
declare
  v_poll uuid;
  t jsonb;
  tb jsonb;
begin
  -- Everyone finishes on 10 points. Apple wins both its head-to-heads on the
  -- strength of a flat 2 everywhere. Banana and Cherry split theirs two votes
  -- each, so neither has a head-to-head win to show.
  v_poll := tests.seed_poll(
    array['Apple', 'Banana', 'Cherry'],
    array[
      [2, 1, 0],
      [2, 0, 1],
      [2, 1, 1],
      [2, 3, 4],
      [2, 5, 4]
    ]);

  t := poll_tally(v_poll);
  tb := t #> '{tiebreaks,0}';

  perform tests.assert_eq('Apple ties on points',  tests.total_score(t, 'Apple'), 10);
  perform tests.assert_eq('Banana ties on points', tests.total_score(t, 'Banana'), 10);
  perform tests.assert_eq('Cherry ties on points', tests.total_score(t, 'Cherry'), 10);

  perform tests.assert_eq('it is a tie at 10 points', (tb->>'tied_at')::int, 10);
  perform tests.assert_eq('five-star votes settle it',
    tb->>'resolved_by', 'five_star_votes');

  perform tests.assert_eq('both rules are shown', jsonb_array_length(tb->'steps'), 2);
  perform tests.assert_eq('head-to-head is shown first',
    tb #>> '{steps,0,rule}', 'head_to_head');
  perform tests.assert_eq('but it did not decide anything',
    (tb #>> '{steps,0,decisive}')::boolean, false);
  perform tests.assert_eq('the five-star count did',
    tb #>> '{steps,1,rule}', 'five_star_votes');
  perform tests.assert_eq('and is marked decisive',
    (tb #>> '{steps,1,decisive}')::boolean, true);
  perform tests.assert_eq('Banana has the one five-star ballot',
    tb #>> '{steps,1,results,0,name}', 'Banana');

  perform tests.assert_eq('so Banana takes the second slot',
    tests.finalists(t), array['Apple', 'Banana']);
  perform tests.assert_eq('Apple wins the runoff', tests.winner(t), 'Apple');
  perform tests.assert_eq('Cherry, having lost the tie-break, is third',
    tests.placed_at(t, 3), array['Cherry']);
end $$;

rollback;

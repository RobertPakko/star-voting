-- Two options tied for the last finalist slot. The first tie-break rule for a
-- two-way tie is head-to-head preference, and here it separates them, so the
-- five-star count is never consulted -- even though it would have gone the
-- other way.

begin;

do $$
declare
  v_poll uuid;
  t jsonb;
  tb jsonb;
  m jsonb;
begin
  -- Apple takes the first slot on 15 points. Banana and Cherry tie at 8 for
  -- the second. Two voters score Banana above Cherry and one the other way
  -- round, but that one gives Cherry the only five-star ballot either has.
  v_poll := tests.seed_poll(
    array['Apple', 'Banana', 'Cherry'],
    array[
      [5, 4, 0],
      [5, 4, 3],
      [5, 0, 5]
    ]);

  t := poll_tally(v_poll);
  tb := t #> '{tiebreaks,0}';
  m := tb #> '{steps,0,matchups,0}';

  perform tests.assert_eq('Apple leads on points',  tests.total_score(t, 'Apple'), 15);
  perform tests.assert_eq('Banana ties on points', tests.total_score(t, 'Banana'), 8);
  perform tests.assert_eq('Cherry ties on points', tests.total_score(t, 'Cherry'), 8);

  perform tests.assert_eq('the two-way tie is reported', jsonb_array_length(t->'tiebreaks'), 1);
  perform tests.assert_eq('the tie is flagged for the results page',
    (t->>'tie')::boolean, true);
  perform tests.assert_eq('it is a tie at 8 points', (tb->>'tied_at')::int, 8);
  perform tests.assert_eq('for one finalist slot',  (tb->>'slots')::int, 1);
  perform tests.assert_eq('between two options',    jsonb_array_length(tb->'tied'), 2);

  perform tests.assert_eq('head-to-head settles it',
    tb->>'resolved_by', 'head_to_head');
  perform tests.assert_eq('so only the head-to-head step is shown',
    jsonb_array_length(tb->'steps'), 1);
  perform tests.assert_eq('and it is marked as the decisive one',
    (tb #>> '{steps,0,decisive}')::boolean, true);

  -- The one pair, named alphabetically.
  perform tests.assert_eq('exactly one matchup is reported',
    jsonb_array_length(tb #> '{steps,0,matchups}'), 1);
  perform tests.assert_eq('Banana against Cherry',
    (m->>'a_name') || ' vs ' || (m->>'b_name'), 'Banana vs Cherry');
  perform tests.assert_eq('two voters preferred Banana', (m->>'prefers_a')::int, 2);
  perform tests.assert_eq('one preferred Cherry',        (m->>'prefers_b')::int, 1);
  perform tests.assert_eq('nobody scored them the same', (m->>'ties')::int, 0);

  perform tests.assert_eq('Apple and Banana advance',
    tests.finalists(t), array['Apple', 'Banana']);
  perform tests.assert_eq('Apple wins', tests.winner(t), 'Apple');

  perform tests.assert_eq('Banana is second',
    tests.placed_at(poll_ranking(v_poll), 2), array['Banana']);
  perform tests.assert_eq('Cherry is third',
    tests.placed_at(poll_ranking(v_poll), 3), array['Cherry']);
end $$;

rollback;

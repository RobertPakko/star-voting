-- The head-to-head tie-break carries the pairs it compared.
--
-- Two options tied for the last runoff slot, and tied head to head as well:
-- one voter prefers each and a third scores them the same. The win counts
-- are 0 and 0 -- true, and on its own unreadable -- so the step also carries
-- the matchup those zeros came out of.

begin;

do $$
declare
  v_poll uuid;
  t jsonb;
  tb jsonb;
  m jsonb;
begin
  -- Apple takes the first slot on 10 points. Banana and Cherry tie at 8 for
  -- the second: one voter scores Banana above Cherry, one the other way,
  -- and the third scores them level.
  v_poll := tests.seed_poll(
    array['Apple', 'Banana', 'Cherry'],
    array[
      [4, 5, 3],
      [4, 2, 4],
      [2, 1, 1]
    ]);

  t := poll_tally(v_poll);
  tb := t #> '{tiebreaks,0}';
  m := tb #> '{steps,0,matchups,0}';

  perform tests.assert_eq('Banana ties Cherry on points', tests.total_score(t, 'Banana'), 8);
  perform tests.assert_eq('Cherry ties Banana on points', tests.total_score(t, 'Cherry'), 8);
  perform tests.assert_eq('one slot is being contested', (tb->>'slots')::int, 1);

  perform tests.assert_eq('head-to-head is tried first',
    tb #>> '{steps,0,rule}', 'head_to_head');
  perform tests.assert_eq('and settles nothing',
    (tb #>> '{steps,0,decisive}')::boolean, false);
  perform tests.assert_eq('neither option won a matchup',
    (tb #>> '{steps,0,results,0,value}')::int, 0);
  perform tests.assert_eq('neither of them',
    (tb #>> '{steps,0,results,1,value}')::int, 0);

  -- The pair behind those two zeros, which is the whole point of this case.
  perform tests.assert_eq('the one matchup between them is reported',
    jsonb_array_length(tb #> '{steps,0,matchups}'), 1);
  perform tests.assert_eq('named alphabetically', m->>'a_name', 'Banana');
  perform tests.assert_eq('and so is its other half', m->>'b_name', 'Cherry');
  perform tests.assert_eq('one voter preferred Banana', (m->>'prefers_a')::int, 1);
  perform tests.assert_eq('one preferred Cherry',       (m->>'prefers_b')::int, 1);
  perform tests.assert_eq('and one scored them equally', (m->>'ties')::int, 1);

  perform tests.assert_eq('so five-star votes decide it',
    tb->>'resolved_by', 'five_star_votes');
  perform tests.assert_eq('Banana advances', tests.finalists(t), array['Apple', 'Banana']);
  perform tests.assert_eq('Apple wins the runoff', tests.winner(t), 'Apple');
end $$;

rollback;

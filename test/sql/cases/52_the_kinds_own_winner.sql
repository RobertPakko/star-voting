-- The winner kept with a question (the badge on every screen) is the one its
-- own kind elects: the consensus option on a consensus question, nobody on a
-- question whose answer is several options (left unsettled, so the badge
-- says *Results ready*), and STAR's winner otherwise.
--
--            A  B  C
--   voter 1  5  2  0
--   voter 2  5  3  1
--   voter 3  0  3  5
--
-- STAR elects A (totals 10, 8, 6; A wins the runoff two to one). The
-- consensus is B: its floor is 2, A's and C's are 0.

begin;

do $$
declare
  v_emails text[] := array['v1@example.com', 'v2@example.com', 'v3@example.com'];
  v_ballots int[][] := array[[5, 2, 0], [5, 3, 1], [0, 3, 5]];
  v_kinds text[] := array['option', 'consensus', 'ranking', 'multiple', 'fractional'];
  v_polls uuid[] := '{}';
  v_two uuid;
  v_poll uuid;
  i int;
  k int;
begin
  perform tests.sign_in('creator@example.com');
  for k in 1 .. array_length(v_kinds, 1) loop
    v_polls := v_polls || create_poll('Dinner', null, array['A', 'B', 'C'], v_emails,
      p_kind => v_kinds[k]);
  end loop;
  -- Too small to rank: the tally carries no ranking, and the page shows STAR's winner.
  v_two := create_poll('Dinner', null, array['A', 'B'], v_emails, p_kind => 'ranking');

  foreach v_poll in array v_polls loop
    for i in 1 .. 3 loop
      perform tests.sign_in(v_emails[i]);
      perform tests.cast_ballot(v_poll, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
    end loop;
  end loop;
  for i in 1 .. 3 loop
    perform tests.sign_in(v_emails[i]);
    perform tests.cast_ballot(v_two, array[v_ballots[i][1], v_ballots[i][2]]);
  end loop;
  perform tests.sign_in('creator@example.com');

  -- Every invitee has voted, so each poll has finished on its own.
  perform tests.assert_eq('the best option keeps STAR''s winner',
    (select winner_name from poll_status(v_polls[1])), 'A');
  perform tests.assert_eq('a consensus question keeps the consensus option',
    (select winner_name from poll_status(v_polls[2])), 'B');
  perform tests.assert_eq('settled',
    (select winner_settled from poll_status(v_polls[2])), true);

  for k in 3 .. 5 loop
    perform tests.assert_eq(format('a %s question has results', v_kinds[k]),
      (select results_available from poll_status(v_polls[k])), true);
    perform tests.assert_eq(format('but keeps no single winner (%s)', v_kinds[k]),
      (select winner_settled from poll_status(v_polls[k])), false);
  end loop;

  perform tests.assert_eq('a ranking of two keeps STAR''s winner',
    (select winner_name from poll_status(v_two)), 'A');

  -- The list reads the same columns.
  perform tests.assert_eq('the list names the consensus too',
    (select winner_name from list_polls(50, 0) where id = v_polls[2]), 'B');
  perform tests.assert_eq('and leaves a multiple-winners question unsettled',
    (select winner_settled from list_polls(50, 0) where id = v_polls[4]), false);
end $$;

rollback;

-- An open question takes a bounded number of ballots.
--
-- An invite poll is bounded by its list; an open one is bounded by this, so
-- that it never holds more votes than its results can be worked out from:
-- 2000 ballots (the option assignment refuses more outright), or fewer on a
-- long list -- 250,000 scores, which is the largest invite poll there can be.

begin;

do $$
declare
  v_poll uuid;
  v_options uuid[];
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Lunch', null, array['Pizza', 'Salad'], null, 'open', false, false);

  select array_agg(id order by sort_order) into v_options
  from candidates where poll_id = v_poll;

  perform tests.sign_out();
  perform open_poll_submit(v_poll, tests.open_scores(v_poll, array[5, 1]), 'first-key');

  -- The one place this case writes rows itself: 1998 strangers each pressing
  -- Submit is 1998 calls that prove nothing the first did not. Each is a
  -- whole ballot -- a key and a score for every option -- as the function
  -- would have left it.
  insert into ballots (poll_id, voter_key)
  select v_poll, 'stranger-' || g from generate_series(1, 1998) g;

  insert into scores (ballot_id, candidate_id, score)
  select b.id, o, 3
  from ballots b, unnest(v_options) o
  where b.poll_id = v_poll and b.voter_key like 'stranger-%';

  perform open_poll_submit(v_poll, tests.open_scores(v_poll, array[0, 5]), 'last-key');
  perform tests.assert_eq('the two-thousandth ballot is taken',
    (select count(*)::int from ballots where poll_id = v_poll), 2000);

  perform tests.assert_raises('and the next is not',
    format('select open_poll_submit(%L, %L::jsonb, %L)',
      v_poll, tests.open_scores(v_poll, array[5, 5]), 'one-too-many'),
    'as many votes as it can count');

  perform tests.assert_raises('somebody who has voted is told that instead',
    format('select open_poll_submit(%L, %L::jsonb, %L)',
      v_poll, tests.open_scores(v_poll, array[5, 5]), 'first-key'),
    'You have already voted in this poll');

  perform open_poll_revise(v_poll, tests.open_scores(v_poll, array[1, 5]), 'first-key');
  perform tests.assert_eq('and can still change their vote',
    (select s.score::int from scores s
      join ballots b on b.id = s.ballot_id
      where b.poll_id = v_poll and b.voter_key = 'first-key' and s.candidate_id = v_options[1]),
    1);

  -- A full poll still counts. After the revision above, Pizza has 1 from the
  -- first voter, 3 from each of the 1998 and 0 from the last: 5995. Salad has
  -- 5 + 5994 + 5 = 6004, and is preferred by the only two voters who scored
  -- the pair differently.
  perform tests.sign_in('creator@example.com');
  perform close_poll(v_poll);
  perform tests.assert_eq('a full poll still elects a winner',
    tests.winner(get_poll_results(v_poll)), 'Salad');
  perform tests.assert_eq('on every ballot in it',
    tests.total_score(get_poll_results(v_poll), 'Salad'), 6004);
end $$;

-- ---- a long list takes fewer -------------------------------------------------

do $$
declare
  v_poll uuid;
  v_names text[];
  v_scores jsonb;
begin
  -- 500 options, the most a poll can hold, as a calendar of windows would be:
  -- 250,000 scores is 500 ballots of them.
  select array_agg('Option ' || g order by g) into v_names from generate_series(1, 500) g;

  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Long', null, v_names, null, 'open', false, false);

  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 3)) into v_scores
  from candidates where poll_id = v_poll;

  -- Bare ballots, with no scores under them: the ceiling counts ballots, this
  -- poll is never tallied, and a quarter of a million score rows would say
  -- nothing more about it.
  perform tests.sign_out();
  insert into ballots (poll_id, voter_key)
  select v_poll, 'stranger-' || g from generate_series(1, 499) g;

  perform open_poll_submit(v_poll, v_scores, 'last-key');
  perform tests.assert_eq('500 options take a five-hundredth ballot',
    (select count(*)::int from ballots where poll_id = v_poll), 500);

  perform tests.assert_raises('and not another',
    format('select open_poll_submit(%L, %L::jsonb, %L)', v_poll, v_scores, 'one-too-many'),
    'as many votes as it can count');
end $$;

rollback;

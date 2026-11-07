-- Fractional winners: a share for every option, chosen to make the product of
-- every voter's average stars largest (the Nash welfare). Options the reader
-- leaves out are left off the ballot entirely, and only the ten options with
-- the most stars are shared between.
--
-- The shares are checked two ways. Where voters split into groups that each
-- like one option, the answer is known by hand: each option's share is its
-- group's size. Elsewhere the shares are checked against what makes them the
-- maximum (the KKT conditions), written out below and computed from the
-- ballots, not from the solver: with N voters who starred something and u_i
-- voter i's average stars, every option with a share has
-- sum_i s_ij / u_i = N, and every option without one at most N. Any shares
-- passing that are the maximum, since the log of the product is concave.

begin;

-- How far `m`'s shares are from the maximum: the largest breach of the
-- conditions above, over every option in `m`.
create function tests.nash_gap(p_poll uuid, m jsonb) returns numeric
language sql as $$
  with shares as (
    select (x->>'id')::uuid as cid, (x->>'share')::numeric as share
    from jsonb_array_elements(m) x
  ),
  u as (
    select b.id as ballot, sum(coalesce(s.score, 0) * sh.share) as u
    from ballots b
    cross join shares sh
    left join scores s on s.ballot_id = b.id and s.candidate_id = sh.cid
    where b.poll_id = p_poll
    group by b.id
    having sum(coalesce(s.score, 0)) > 0
  ),
  g as (
    select sh.cid, sh.share, sum(coalesce(s.score, 0) / u.u) as g
    from shares sh
    cross join u
    left join scores s on s.ballot_id = u.ballot and s.candidate_id = sh.cid
    group by sh.cid, sh.share
  )
  select max(case when share > 0 then abs(g - (select count(*) from u))
                  else greatest(g - (select count(*) from u), 0) end)
  from g
$$;

create function tests.share(m jsonb, p_name text) returns numeric
language sql as $$
  select (x->>'share')::numeric from jsonb_array_elements(m) x where x->>'name' = p_name
$$;

create function tests.share_total(m jsonb) returns numeric
language sql as $$
  select round(sum((x->>'share')::numeric), 4) from jsonb_array_elements(m) x
$$;

-- Groups that each like only their own option: two voters for Apple, one for
-- Banana, nobody for Cherry. Maximising 2 log(5a) + log(5b) with a + b = 1
-- gives a = 2/3.
do $$
declare
  v_poll uuid;
  m jsonb;
begin
  v_poll := tests.seed_poll(
    array['Apple', 'Banana', 'Cherry'],
    array[[5, 0, 0],
          [5, 0, 0],
          [0, 5, 0]]);
  perform close_poll(v_poll);

  m := get_poll_fractional_winners(v_poll, '{}');
  perform tests.assert_eq('every option is listed', jsonb_array_length(m), 3);
  perform tests.assert_eq('Apple gets its group''s two thirds',
    round(tests.share(m, 'Apple'), 4), 0.6667);
  perform tests.assert_eq('Banana its one third', round(tests.share(m, 'Banana'), 4), 0.3333);
  perform tests.assert_eq('Cherry, starred by nobody, nothing', tests.share(m, 'Cherry'), 0::numeric);
  perform tests.assert_eq('largest first', m #>> '{0,name}', 'Apple');
end $$;

-- Two options every voter scored alike can split their joint share any way;
-- they split it evenly. The pair's half is the half of the voters who like
-- them.
do $$
declare
  v_poll uuid;
  m jsonb;
begin
  v_poll := tests.seed_poll(
    array['Apple', 'Banana', 'Cherry'],
    array[[5, 5, 0],
          [0, 0, 5]]);
  perform close_poll(v_poll);

  m := get_poll_fractional_winners(v_poll, '{}');
  perform tests.assert_eq('Cherry gets its voter''s half', round(tests.share(m, 'Cherry'), 4), 0.5);
  perform tests.assert_eq('Apple a quarter', round(tests.share(m, 'Apple'), 4), 0.25);
  perform tests.assert_eq('and Banana the same', round(tests.share(m, 'Banana'), 4), 0.25);
end $$;

-- /extensions' six friends, whose shares the page works out in the browser
-- (sharesOf in Learn.tsx) and prints as tacos 73%, sushi 17%, pizza 10%:
--
--            pizza tacos sushi
--   friend 1   5     4     0
--   friend 2   5     4     1
--   friend 3   5     2     0
--   friend 4   0     3     3
--   friend 5   0     3     5
--   friend 6   1     1     5
--
-- At the maximum (0.102, 0.726, 0.172) every option's mean of stars over
-- satisfaction is exactly 1, which is what tests.nash_gap checks.
do $$
declare
  v_poll uuid;
  v_pizza uuid;
  v_tacos uuid;
  m jsonb;
begin
  v_poll := tests.seed_poll(
    array['pizza', 'tacos', 'sushi'],
    array[[5, 4, 0],
          [5, 4, 1],
          [5, 2, 0],
          [0, 3, 3],
          [0, 3, 5],
          [1, 1, 5]]);
  perform close_poll(v_poll);

  select id into v_pizza from candidates where poll_id = v_poll and name = 'pizza';
  select id into v_tacos from candidates where poll_id = v_poll and name = 'tacos';

  m := get_poll_fractional_winners(v_poll, '{}');
  perform tests.assert_eq('the shares sum to 1', tests.share_total(m), 1::numeric);
  perform tests.assert_eq('and are the maximum', tests.nash_gap(v_poll, m) < 0.001, true);
  perform tests.assert_eq('tacos 73%', round(tests.share(m, 'tacos'), 2), 0.73);
  perform tests.assert_eq('sushi 17%', round(tests.share(m, 'sushi'), 2), 0.17);
  perform tests.assert_eq('pizza 10%, though it won the runoff',
    round(tests.share(m, 'pizza'), 2), 0.10);
  perform tests.assert_eq('tacos first', m #>> '{0,name}', 'tacos');

  -- Leaving pizza out shares the meals as though it had never been on the
  -- ballot.
  m := get_poll_fractional_winners(v_poll, array[v_pizza]);
  perform tests.assert_eq('without pizza, two options', jsonb_array_length(m), 2);
  perform tests.assert_eq('summing to 1', tests.share_total(m), 1::numeric);
  perform tests.assert_eq('the maximum without it', tests.nash_gap(v_poll, m) < 0.001, true);
  perform tests.assert_eq('tacos still ahead', m #>> '{0,name}', 'tacos');

  -- And again: leaving out options one after another.
  m := get_poll_fractional_winners(v_poll, array[v_pizza, v_tacos]);
  perform tests.assert_eq('without both, sushi alone', jsonb_array_length(m), 1);
  perform tests.assert_eq('and all of it', tests.share(m, 'sushi'), 1::numeric);

  -- An id that is not one of this poll's options is ignored.
  m := get_poll_fractional_winners(v_poll, array[gen_random_uuid()]);
  perform tests.assert_eq('a stranger id leaves nothing out', jsonb_array_length(m), 3);
end $$;

-- A mixed field, with options at 0 at the maximum: the shares still meet the
-- conditions, including the ones the solver had to drop along the way.
do $$
declare
  v_poll uuid;
  m jsonb;
begin
  v_poll := tests.seed_poll(
    array['A', 'B', 'C', 'D', 'E'],
    array[[5, 4, 1, 0, 2],
          [5, 3, 0, 1, 2],
          [0, 4, 5, 1, 2],
          [1, 0, 5, 2, 2],
          [2, 5, 3, 0, 1],
          [4, 4, 4, 4, 4],
          [0, 0, 0, 5, 1]]);
  perform close_poll(v_poll);

  m := get_poll_fractional_winners(v_poll, '{}');
  perform tests.assert_eq('summing to 1', tests.share_total(m), 1::numeric);
  perform tests.assert_eq('at the maximum', tests.nash_gap(v_poll, m) < 0.001, true);
  -- E is everybody's middling second choice; every voter does better with
  -- the options they like themselves.
  perform tests.assert_eq('a compromise nobody loves gets nothing', tests.share(m, 'E'), 0::numeric);
end $$;

-- Nobody starred anything: there is nothing to share.
do $$
declare
  v_poll uuid;
  m jsonb;
begin
  v_poll := tests.seed_poll(array['Apple', 'Banana'], array[[0, 0], [0, 0]]);
  perform close_poll(v_poll);

  m := get_poll_fractional_winners(v_poll, '{}');
  perform tests.assert_eq('both listed', jsonb_array_length(m), 2);
  perform tests.assert_eq('at nothing', tests.share_total(m), 0::numeric);
end $$;

-- Only the ten options with the most stars are shared between; leaving one
-- out lets the next one in.
do $$
declare
  v_poll uuid;
  v_a uuid;
  m jsonb;
begin
  -- A to E 10 stars each, F to J 8, L 3, K 1.
  v_poll := tests.seed_poll(
    array['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'],
    array[[5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 1, 0],
          [5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 0, 3]]);
  perform close_poll(v_poll);
  select id into v_a from candidates where poll_id = v_poll and name = 'A';

  m := get_poll_fractional_winners(v_poll, '{}');
  perform tests.assert_eq('twelve options, ten shared', jsonb_array_length(m), 10);
  perform tests.assert_null('K is not among them', tests.share(m, 'K'));
  perform tests.assert_null('nor L', tests.share(m, 'L'));

  m := get_poll_fractional_winners(v_poll, array[v_a]);
  perform tests.assert_eq('still ten without A', jsonb_array_length(m), 10);
  perform tests.assert_eq('L, next on stars, comes in', tests.share(m, 'L') is not null, true);
  perform tests.assert_null('K does not', tests.share(m, 'K'));
end $$;

-- Gated exactly as the ranking is.
do $$
declare
  v_poll uuid;
  v_scores jsonb;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Lunch', null,
                        array['Apple', 'Banana', 'Cherry'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false);
  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_poll, (
    select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 3))
    from candidates where poll_id = v_poll));

  perform tests.assert_raises('an unfinished invite poll keeps its shares',
    format('select get_poll_fractional_winners(%L, ''{}'')', v_poll),
    'Results are not available until everyone has voted');

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('a stranger is told no such poll',
    format('select get_poll_fractional_winners(%L, ''{}'')', v_poll),
    'Poll not found');

  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Movie night', null,
                        array['Dune', 'Arrival', 'Solaris'],
                        array[]::text[], 'open', true, true);
  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 3))
  into v_scores from candidates where poll_id = v_poll;
  perform open_poll_submit(v_poll, v_scores, 'voter-key-1', 'Robin');

  perform tests.assert_raises('an open poll keeps them until it closes',
    format('select open_poll_fractional_winners(%L, ''{}'')', v_poll),
    'Results are not available until the poll is closed');

  perform close_poll(v_poll);
  perform tests.assert_eq('and gives them once it has',
    tests.share_total(open_poll_fractional_winners(v_poll, '{}')), 1::numeric);

  perform tests.assert_eq('the count itself is nobody''s to call',
    has_function_privilege('anon', 'public.poll_fractional_winners(uuid, uuid[])', 'execute')
      or has_function_privilege('authenticated', 'public.poll_fractional_winners(uuid, uuid[])', 'execute'),
    false);
  perform tests.assert_eq('nor the welfare it climbs',
    has_function_privilege('authenticated',
      'public.nash_log_welfare(double precision[], double precision[], double precision[])',
      'execute'),
    false);
end $$;

rollback;

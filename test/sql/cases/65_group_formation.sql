-- Group formation: the voters split into groups as even in size as can be,
-- as alike as possible (`groups`) or as mixed as possible (`mixed_groups`).
-- Two voters are the sum of the squares of their score differences apart,
-- and a grouping is the sum of that over every two voters in one group.
--
-- The ballots are /choices' six friends (55_option_assignment's):
--
--            pizza tacos sushi
--   friend 1   5     4     0
--   friend 2   5     4     1
--   friend 3   5     2     0
--   friend 4   0     3     3
--   friend 5   0     3     5
--   friend 6   1     1     5
--
-- Worked by hand, every two friends apart:
--
--        2   3   4   5   6
--   1    1   4  35  51  50
--   2        5  30  42  41
--   3           35  51  42
--   4                4   9
--   5                    5
--
-- Two groups of three, alike: {1,2,3} (1+4+5) and {4,5,6} (4+9+5), 28 in
-- all; any other split puts one of 1-3 with two of 4-6, which costs at least
-- 30 more. Mixed: of the ten splits, {1,4,6} (35+50+9) and {2,3,5}
-- (5+42+51) are furthest apart within, 192; the next is {1,3,5} and
-- {2,4,6}, 186.
--
-- Three pairs, alike: {1,3} 4, {2,4} 30, {5,6} 5, 39 in all; the next best
-- pairing is {1,2} {3,4} {5,6}, 41.

begin;

create function pg_temp.names(p_group jsonb) returns text[] language sql as $$
  select coalesce(array_agg(v ->> 'name' order by ord), '{}')
  from jsonb_array_elements(p_group -> 'voters') with ordinality t(v, ord)
$$;

-- An invite poll asking for two groups, whose seventh invitee does not vote.
create function pg_temp.friends(p_kind text, p_groups int, p_show_ballots boolean) returns uuid
language plpgsql as $$
declare
  v_poll uuid;
  v_ballots int[][] := array[[5, 4, 0], [5, 4, 1], [5, 2, 0], [0, 3, 3], [0, 3, 5], [1, 1, 5]];
  i int;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Dinner', null, array['pizza', 'tacos', 'sushi'],
    array['voter1@example.com', 'voter2@example.com', 'voter3@example.com', 'voter4@example.com',
          'voter5@example.com', 'voter6@example.com', 'voter7@example.com'],
    'invite', true, p_show_ballots, p_kind => p_kind, p_kind_value => p_groups);
  for i in 1 .. 6 loop
    perform tests.sign_in('voter' || i || '@example.com');
    perform tests.cast_ballot(v_poll, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
  end loop;
  perform tests.sign_in('creator@example.com');
  perform close_poll(v_poll);
  return v_poll;
end $$;

do $$
declare
  v_poll uuid;
  g jsonb;
begin
  v_poll := pg_temp.friends('groups', 2, true);

  g := get_poll_groups(v_poll);
  perform tests.assert_eq('two groups, as the question asked', (g ->> 'group_count')::int, 2);
  perform tests.assert_eq('kept alike', (g ->> 'similar')::boolean, true);
  perform tests.assert_eq('friends 1-3 together',
    pg_temp.names(g -> 'groups' -> 0),
    array['voter1@example.com', 'voter2@example.com', 'voter3@example.com']);
  perform tests.assert_eq('friends 4-6 together',
    pg_temp.names(g -> 'groups' -> 1),
    array['voter4@example.com', 'voter5@example.com', 'voter6@example.com']);
  perform tests.assert_eq('six voters grouped', (g ->> 'voter_count')::int, 6);
  perform tests.assert_eq('the invitee who did not vote is named apart',
    (select array_agg(v ->> 'name') from jsonb_array_elements(g -> 'not_grouped') v),
    array['voter7@example.com']);
  perform tests.assert_eq('and the same on every read', g, get_poll_groups(v_poll));
  perform tests.assert_eq('the tally carries it', poll_tally(v_poll) -> 'kind_result', g);
  perform tests.assert_eq('and names no one winner', poll_names_one_winner(v_poll), false);

  -- Mixed instead.
  g := get_poll_groups(v_poll, 2, false);
  perform tests.assert_eq('mixed, friends 1, 4 and 6',
    pg_temp.names(g -> 'groups' -> 0),
    array['voter1@example.com', 'voter4@example.com', 'voter6@example.com']);
  perform tests.assert_eq('and friends 2, 3 and 5',
    pg_temp.names(g -> 'groups' -> 1),
    array['voter2@example.com', 'voter3@example.com', 'voter5@example.com']);

  -- Three pairs.
  g := get_poll_groups(v_poll, 3, true);
  perform tests.assert_eq('three pairs: 1 with 3',
    pg_temp.names(g -> 'groups' -> 0), array['voter1@example.com', 'voter3@example.com']);
  perform tests.assert_eq('2 with 4',
    pg_temp.names(g -> 'groups' -> 1), array['voter2@example.com', 'voter4@example.com']);
  perform tests.assert_eq('5 with 6',
    pg_temp.names(g -> 'groups' -> 2), array['voter5@example.com', 'voter6@example.com']);

  -- Sizes as even as can be, larger first.
  g := get_poll_groups(v_poll, 4, true);
  perform tests.assert_eq('four groups of six are two, two, one and one',
    (select array_agg(jsonb_array_length(x -> 'voters') order by ord)
       from jsonb_array_elements(g -> 'groups') with ordinality t(x, ord)),
    array[2, 2, 1, 1]);

  -- More groups than voters leaves some empty, at the end.
  g := get_poll_groups(v_poll, 8, false);
  perform tests.assert_eq('eight groups of six voters: six of one and two empty',
    (select array_agg(jsonb_array_length(x -> 'voters') order by ord)
       from jsonb_array_elements(g -> 'groups') with ordinality t(x, ord)),
    array[1, 1, 1, 1, 1, 1, 0, 0]);

  perform tests.assert_raises('at least two groups',
    format('select get_poll_groups(%L, 1)', v_poll), 'Choose from 2 to 10 groups');
  perform tests.assert_raises('at most ten',
    format('select get_poll_groups(%L, 11)', v_poll), 'Choose from 2 to 10 groups');
end $$;

-- A group's own counts, on a poll that publishes its ballots.
do $$
declare
  v_poll uuid;
  v_alone uuid;
  r jsonb;
begin
  v_poll := pg_temp.friends('mixed_groups', 2, true);
  perform tests.assert_eq('a mixed question opens mixed',
    (poll_tally(v_poll) #>> '{kind_result,similar}')::boolean, false);

  -- Friends 4-6, the second group when kept alike.
  r := get_poll_group_count(v_poll, 2, true, 2, 'results');
  perform tests.assert_eq('the group''s tally counts its three ballots', (r ->> 'voter_count')::int, 3);
  perform tests.assert_eq('sushi wins for friends 4-6', tests.winner(r), 'sushi');
  perform tests.assert_eq('on 13 stars', tests.total_score(r, 'sushi'), 13);
  perform tests.assert_null('and carries no grouping of its own', r ->> 'kind_result');

  r := get_poll_group_count(v_poll, 2, true, 1, 'results');
  perform tests.assert_eq('pizza wins for friends 1-3', tests.winner(r), 'pizza');

  perform tests.assert_eq('nothing is left filtered after',
    coalesce(current_setting('app.counted_ballots', true), ''), '');
  perform tests.assert_eq('so the whole poll still counts six', (poll_tally(v_poll) ->> 'voter_count')::int, 6);

  -- A group's count is the count of a poll holding only its ballots.
  v_alone := tests.seed_poll(array['pizza', 'tacos', 'sushi'],
    array[[0, 3, 3], [0, 3, 5], [1, 1, 5]], p_show_ballots => true);
  perform close_poll(v_alone);

  perform tests.assert_eq('the consensus of the group is the consensus of its ballots alone',
    get_poll_group_count(v_poll, 2, true, 2, 'consensus', '{"p_excluded": []}') #>> '{winner,name}',
    get_poll_consensus(v_alone) #>> '{winner,name}');
  perform tests.assert_eq('and its scores',
    (select jsonb_agg(o - 'id' order by o ->> 'name')
       from jsonb_array_elements(get_poll_group_count(v_poll, 2, true, 2, 'scores') -> 'options') o),
    (select jsonb_agg(o - 'id' order by o ->> 'name')
       from jsonb_array_elements(get_poll_scores(v_alone) -> 'options') o));
  perform tests.assert_eq('and its ranking',
    (select array_agg(e ->> 'name' order by (e ->> 'place')::int, e ->> 'name')
       from jsonb_array_elements(get_poll_group_count(v_poll, 2, true, 2, 'ranking')) e),
    (select array_agg(e ->> 'name' order by (e ->> 'place')::int, e ->> 'name')
       from jsonb_array_elements(get_poll_ranking(v_alone)) e));
  perform tests.assert_eq('and its proportional winners',
    (select array_agg(e ->> 'name' order by (e ->> 'place')::int, e ->> 'name')
       from jsonb_array_elements(get_poll_group_count(v_poll, 2, true, 2, 'multiple_winners')) e),
    (select array_agg(e ->> 'name' order by (e ->> 'place')::int, e ->> 'name')
       from jsonb_array_elements(get_poll_multiple_winners(v_alone)) e));
  perform tests.assert_eq('and its fractional winners',
    (select jsonb_agg(e - 'id' order by e ->> 'name')
       from jsonb_array_elements(get_poll_group_count(v_poll, 2, true, 2, 'fractional_winners')) e),
    (select jsonb_agg(e - 'id' order by e ->> 'name')
       from jsonb_array_elements(get_poll_fractional_winners(v_alone)) e));

  perform tests.assert_eq('and its consensus winners, two of the three',
    jsonb_array_length(get_poll_group_count(v_poll, 2, true, 2, 'consensus_winners',
                                            '{"p_winners": 2}') -> 'winners'), 2);
  perform tests.assert_eq('and a budget over its ballots, which buys sushi first',
    get_poll_group_count(v_poll, 2, true, 2, 'budget',
      jsonb_build_object('p_costs', (select jsonb_object_agg(id, 1) from candidates where poll_id = v_poll),
                         'p_budget', 1, 'p_choice', 'ranking')) #>> '{spots,0,options,0,name}',
    'sushi');
  perform tests.assert_eq('and an assignment of its three voters',
    (get_poll_group_count(v_poll, 2, true, 2, 'assignment') ->> 'voter_count')::int, 3);

  perform tests.assert_raises('a group must be one of the grouping''s',
    format('select get_poll_group_count(%L, 2, true, 3, %L)', v_poll, 'results'), 'There is no such group');
  perform tests.assert_raises('and a count one of the menu''s',
    format('select get_poll_group_count(%L, 2, true, 1, %L)', v_poll, 'sheet'), 'Unknown count');
  perform tests.assert_raises('an empty group has nothing to count',
    format('select get_poll_group_count(%L, 8, true, 8, %L)', v_poll, 'results'), 'Nobody is in this group');
end $$;

-- Private ballots: the groups, any way, but no group's count.
do $$
declare
  v_poll uuid;
begin
  v_poll := pg_temp.friends('groups', 2, false);

  perform tests.assert_eq('a private poll may be grouped another way',
    jsonb_array_length(get_poll_groups(v_poll, 3, false) -> 'groups'), 3);
  perform tests.assert_raises('but not count a group',
    format('select get_poll_group_count(%L, 2, true, 1, %L)', v_poll, 'results'),
    'This poll keeps its ballots private, so a group''s ballots cannot be counted on their own');
end $$;

-- What may be made, and the gates.
do $$
declare
  v_poll uuid;
begin
  perform tests.sign_in('creator@example.com');

  perform tests.assert_raises('never on a poll that hides its voters',
    $q$select create_poll('t', null, array['a', 'b'], array['x@example.com'], 'invite', false, false,
                          p_kind => 'groups', p_kind_value => 2)$q$,
    'Group formation says who is in which group, so it must show who voted');
  perform tests.assert_raises('the number of groups must be given',
    $q$select create_poll('t', null, array['a', 'b'], array['x@example.com'], 'invite', true, false,
                          p_kind => 'mixed_groups')$q$,
    'Say how many groups to form');
  perform tests.assert_raises('and is two to ten',
    $q$select create_poll('t', null, array['a', 'b'], array['x@example.com'], 'invite', true, false,
                          p_kind => 'groups', p_kind_value => 11)$q$,
    'Choose from 2 to 10 groups');

  -- Asked of a poll that hides its voters, nothing.
  v_poll := create_poll('t', null, array['a', 'b'], array['voter1@example.com'], 'invite', false, false);
  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);
  perform tests.assert_raises('a poll hiding its voters is not grouped',
    format('select get_poll_groups(%L, 2)', v_poll),
    'This poll hides who voted, so it cannot be split into groups');

  -- Nor before the results are out.
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('t', null, array['a', 'b'], array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, true, p_kind => 'groups', p_kind_value => 2);
  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);
  perform tests.assert_raises('the groups wait for the results',
    format('select get_poll_groups(%L)', v_poll), 'Results are not available until everyone has voted');
  perform tests.assert_raises('and so does a group''s count',
    format('select get_poll_group_count(%L, 2, true, 1, %L)', v_poll, 'results'),
    'Results are not available until everyone has voted');
end $$;

-- The search against trying every split, on eight voters scoring six options
-- by a hash: the best two groups of four, kept alike and kept mixed.
create function pg_temp.dist(a uuid, b uuid) returns int language sql as $$
  select sum((sa.score - sb.score) * (sa.score - sb.score))::int
  from scores sa join scores sb on sb.candidate_id = sa.candidate_id
  where sa.ballot_id = a and sb.ballot_id = b
$$;

do $$
declare
  v_poll uuid;
  v_ids uuid[];
  v_options uuid[];
  v_got bigint;
  v_best bigint;
  v_w bigint;
  v_similar boolean;
  v_seed int;
  v_mask int;
  i int;
  j int;
begin
  for v_seed in 1 .. 4 loop
    perform tests.sign_in('creator@example.com');
    v_poll := create_poll('t', null, array['a', 'b', 'c', 'd', 'e', 'f'], '{}', 'open', true, true);
    select array_agg(id order by sort_order) into v_options from candidates where poll_id = v_poll;
    perform tests.sign_out();
    for i in 1 .. 8 loop
      perform open_poll_submit(v_poll,
        (select jsonb_agg(jsonb_build_object('candidate_id', v_options[q.o],
                                             'score', abs(hashtext(v_seed || ':' || i || ':' || q.o)) % 6))
           from generate_series(1, 6) q(o)),
        'key-' || v_seed || '-' || i, 'voter ' || i);
    end loop;
    perform tests.sign_in('creator@example.com');
    perform close_poll(v_poll);

    select array_agg(id order by id) into v_ids from ballots where poll_id = v_poll;

    foreach v_similar in array array[true, false] loop
      select sum(pg_temp.dist(a.ballot_id, b.ballot_id)) into v_got
      from voter_groups(v_poll, 2, v_similar) a
      join voter_groups(v_poll, 2, v_similar) b on b.grp = a.grp and b.ballot_id > a.ballot_id;

      -- Every split into four and four, voter 1 always in the first.
      v_best := null;
      for v_mask in 0 .. 127 loop
        continue when bit_count(v_mask::bit(7)) <> 3;
        v_w := 0;
        for i in 1 .. 7 loop
          for j in i + 1 .. 8 loop
            if (i = 1 or (v_mask >> (i - 2)) & 1 = 1) = ((v_mask >> (j - 2)) & 1 = 1) then
              v_w := v_w + pg_temp.dist(v_ids[i], v_ids[j]);
            end if;
          end loop;
        end loop;
        if v_best is null or (v_similar and v_w < v_best) or (not v_similar and v_w > v_best) then
          v_best := v_w;
        end if;
      end loop;

      perform tests.assert_eq(format('the search finds the best split (ballots %s, %s)', v_seed,
                                     case when v_similar then 'alike' else 'mixed' end), v_got, v_best);
    end loop;
  end loop;
end $$;

rollback;

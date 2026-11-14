-- Fractional winners with a budget: every option can be funded in part, up to
-- its cost, a voter being served the stars they gave each option times the
-- fraction of it funded, and the amounts chosen to make the product of what
-- every voter is served as large as possible.
--
-- Three groups each starring only their own option: three voters give A 5,
-- two give B 5, one gives C 5. A costs 60, B 40, C 10. A group's product term
-- is its size times ln(stars x amount / cost), so at the best amounts every
-- option not at its cost has the same size / amount, and the money is shared
-- in proportion to the groups:
--
--   budget 50:  A 25, B 16.67, C 8.33: A and B each 5/12 funded, C 5/6;
--               C's 8.33 is under its cost, so nothing is capped.
--   budget 100: in proportion C would get 16.67, more than it costs, so C is
--               funded in full (10) and the other 90 goes 3 : 2, A 54 and
--               B 36, each 9/10 funded. C's 1/10 per unit beats A's 3/54,
--               so it would take more if it could.
--   budget 200: everything costs 110, so everything is funded and 90 is
--               left over.
--
-- One voter giving A and B 5 each, at costs 60 and 40 and a budget of 50, is
-- served 5 x (a / 60 + b / 40), so every unit buys more on B: B is funded in
-- full and the last 10 go to A.

begin;

do $$
declare
  v_poll uuid;
  v_one uuid;
  v_stored uuid;
  v_a uuid;
  v_b uuid;
  v_c uuid;
  v_d uuid;
  v_costs jsonb;
  v_schedule jsonb := '{"timezone":"-07:00","window":{"start":"09:00","end":"12:00"},'
                      '"desired_slots":1,"granularity":60}'::jsonb;
  v_emails text[] := array['voter1@example.com', 'voter2@example.com', 'voter3@example.com',
                           'voter4@example.com', 'voter5@example.com', 'voter6@example.com'];
  v_ballots int[][] := array[[5, 0, 0], [5, 0, 0], [5, 0, 0], [0, 5, 0], [0, 5, 0], [0, 0, 5]];
  b jsonb;
  i int;
begin
  v_poll := tests.seed_poll(
    array['A', 'B', 'C', 'D'],
    array[[5, 0, 0, 0],
          [5, 0, 0, 0],
          [5, 0, 0, 0],
          [0, 5, 0, 0],
          [0, 5, 0, 0],
          [0, 0, 5, 0]]);
  perform close_poll(v_poll);

  select id into v_a from candidates where poll_id = v_poll and name = 'A';
  select id into v_b from candidates where poll_id = v_poll and name = 'B';
  select id into v_c from candidates where poll_id = v_poll and name = 'C';
  select id into v_d from candidates where poll_id = v_poll and name = 'D';
  v_costs := jsonb_build_object(v_a, 60, v_b, 40, v_c, 10, v_d, 5);

  b := get_poll_budget(v_poll, '{}', v_costs, 50, 'fractional');
  perform tests.assert_eq('in proportion to the groups: A',
    round((b #>> '{options,0,amount}')::numeric, 3), 25.000);
  perform tests.assert_eq('B',
    round((b #>> '{options,1,amount}')::numeric, 3), 16.667);
  perform tests.assert_eq('C',
    round((b #>> '{options,2,amount}')::numeric, 3), 8.333);
  perform tests.assert_eq('A and B the same fraction funded',
    round((b #>> '{options,1,funded}')::numeric, 4), round((b #>> '{options,0,funded}')::numeric, 4));
  perform tests.assert_eq('5/12',
    round((b #>> '{options,0,funded}')::numeric, 4), round(5 / 12.0, 4));
  perform tests.assert_eq('the whole budget spent', (b ->> 'left')::numeric, 0::numeric);
  perform tests.assert_eq('an option nobody starred gets nothing',
    (select array_agg(o ->> 'name') from jsonb_array_elements(b -> 'unfunded') o), array['D']);

  b := get_poll_budget(v_poll, '{}', v_costs, 100, 'fractional');
  perform tests.assert_eq('C is held to its cost',
    (select (o ->> 'amount')::numeric from jsonb_array_elements(b -> 'options') o
     where o ->> 'name' = 'C'), 10::numeric);
  perform tests.assert_eq('and so funded in full',
    (select (o ->> 'funded')::numeric from jsonb_array_elements(b -> 'options') o
     where o ->> 'name' = 'C'), 1::numeric);
  perform tests.assert_eq('the rest goes 3 : 2, A 54',
    round((b #>> '{options,0,amount}')::numeric, 3), 54.000);
  perform tests.assert_eq('and B 36',
    round((b #>> '{options,1,amount}')::numeric, 3), 36.000);
  perform tests.assert_eq('nothing left over', (b ->> 'left')::numeric, 0::numeric);

  b := get_poll_budget(v_poll, '{}', v_costs, 200, 'fractional');
  perform tests.assert_eq('with room for everything, everything starred is funded',
    (select array_agg(o ->> 'name' order by o ->> 'name') from jsonb_array_elements(b -> 'options') o
     where (o ->> 'funded')::numeric = 1), array['A', 'B', 'C']);
  perform tests.assert_eq('and the rest is left over', (b ->> 'left')::numeric, 90::numeric);
  perform tests.assert_eq('spent is what was funded', (b ->> 'spent')::numeric, 110::numeric);
  perform tests.assert_eq('D still gets nothing',
    (select array_agg(o ->> 'name') from jsonb_array_elements(b -> 'unfunded') o), array['D']);

  b := get_poll_budget(v_poll, array[v_b], v_costs, 100, 'fractional');
  perform tests.assert_eq('with B left out, A and C both fit',
    (select array_agg((o ->> 'amount')::numeric order by o ->> 'name')
     from jsonb_array_elements(b -> 'options') o), array[60, 10]::numeric[]);
  perform tests.assert_eq('leaving 30', (b ->> 'left')::numeric, 30::numeric);

  b := get_poll_budget(v_poll, '{}', jsonb_build_object(v_a, 60, v_b, 40), 50, 'fractional');
  perform tests.assert_eq('an option given no cost is left out, and said to be',
    (select array_agg(o ->> 'name' order by o ->> 'name') from jsonb_array_elements(b -> 'uncosted') o),
    array['C', 'D']);
  perform tests.assert_eq('the groups that are left share it 3 : 2',
    round((b #>> '{options,0,amount}')::numeric, 3), 30.000);

  perform tests.assert_raises('the count is named',
    format('select get_poll_budget(%L, ''{}'', %L, 50, %L)', v_poll, v_costs, 'consensus'),
    'A budget counts proportional, multiple or fractional winners');

  -- Every unit buys more on the cheaper option.
  v_one := tests.seed_poll(array['A', 'B'], array[[5, 5]]);
  perform close_poll(v_one);
  b := get_poll_budget(v_one, '{}',
    (select jsonb_object_agg(id, case name when 'A' then 60 else 40 end)
     from candidates where poll_id = v_one), 50, 'fractional');
  perform tests.assert_eq('B, the cheaper, is funded in full',
    (select (o ->> 'amount')::numeric from jsonb_array_elements(b -> 'options') o
     where o ->> 'name' = 'B'), 40::numeric);
  perform tests.assert_eq('and A gets the last 10',
    round((select (o ->> 'amount')::numeric from jsonb_array_elements(b -> 'options') o
           where o ->> 'name' = 'A'), 3), 10.000);

  -- A kind of its own, budgeted and costed.
  perform tests.sign_in('creator@example.com');
  v_stored := create_poll('Fund', null, array['A', 'B', 'C'], v_emails,
    'invite', true, false, null, false, 'fractional_budget', null, 100, null, array[60, 40, 10]);
  perform tests.assert_eq('the budget is the question''s number',
    (select kind || ' ' || kind_value from polls where id = v_stored), 'fractional_budget 100');
  for i in 1 .. 6 loop
    perform tests.sign_in(v_emails[i]);
    perform tests.cast_ballot(v_stored, array[v_ballots[i][1], v_ballots[i][2], v_ballots[i][3]]);
  end loop;
  perform tests.sign_in('creator@example.com');

  b := get_poll_results(v_stored) -> 'kind_result';
  perform tests.assert_eq('the tally carries the count', b,
    get_poll_budget(v_stored, '{}', null, null, 'fractional'));
  perform tests.assert_eq('at the stored costs and budget',
    round((b #>> '{options,0,amount}')::numeric, 3), 54.000);
  perform tests.assert_eq('it names no one winner',
    (select winner_name from polls where id = v_stored), null::text);

  perform tests.assert_raises('it needs the budget',
    format('select create_poll(%L, null, array[%L, %L], %L, %L, true, false, null, false, %L, null, null, null, array[1, 2])',
      'x', 'a', 'b', array['voter1@example.com'], 'invite', 'fractional_budget'),
    'Give the budget');
  perform tests.assert_raises('and a cost on every option',
    format('select create_poll(%L, null, array[%L, %L], %L, %L, true, false, null, false, %L, null, 10, null, null)',
      'x', 'a', 'b', array['voter1@example.com'], 'invite', 'fractional_budget'),
    'Give "a" a cost');
  perform tests.assert_raises('and is never a calendar',
    format('select create_poll(%L, null, array[]::text[], %L, %L, true, false, null, true, %L, %L, 10)',
      'x', array['voter1@example.com'], 'invite', 'fractional_budget', v_schedule),
    'A budget poll cannot be a time poll');

  perform tests.assert_eq('the count itself is not callable',
    has_function_privilege('authenticated', 'poll_fractional_budget(uuid, uuid[], jsonb, numeric)', 'execute'), false);
  perform tests.assert_eq('nor the solver',
    has_function_privilege('anon', 'nash_capped_shares(double precision[], double precision[], double precision[])', 'execute'), false);
end $$;

rollback;

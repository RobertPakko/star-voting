-- Poll variants. A question asks for one result (its kind) and may take at
-- most one variant on top: a calendar (a schedule), a sequence (carried
-- weights) or a budget. Variants do not combine, so a sequential question can
-- no longer be a calendar; a budget already could not be either.
--
-- A budget is a variant of three kinds, so each has a stored kind of its own:
--
--   budget             proportional winners with a budget, counted as before
--   ranking_budget     multiple winners with a budget: STAR again and again
--                      over the options that still fit, funding each winner,
--                      until nothing does. Nobody is charged, so it funds by
--                      popularity, skipping whatever no longer fits.
--   fractional_budget  fractional winners with a budget: every option funded
--                      in part, up to its cost, so that the product of what
--                      every voter is served (their stars times the fraction
--                      of each option funded) is as large as it can be
--                      (poll_fractional_budget, nash_capped_shares).
--
-- On each, the question's number (kind_value) is its budget and every option
-- carries a cost (candidates.kind_value).
--
-- poll_proportional_budget becomes poll_budget, with p_proportional saying
-- which of its two counts to run. Its doors become get_poll_budget and
-- open_poll_budget, whose p_choice names any of the three
-- (poll_budget_count).
--
-- A finished question whose ballots are published with names on them can be
-- counted as though it had been sequential (get_poll_sequential /
-- open_poll_sequential), with an N given for each ballot of the sheet, in the
-- sheet's order. The sheet already shows every ballot by name, so weighing
-- one discloses nothing. The N reach the count through ballot_given, which
-- reads a transaction-local setting the sequential count sets and clears.
-- poll_tally carries ballots_shown, so the menu knows when to offer it.
-- The sheet's order gains the ballot id as a last key, so two voters typing
-- one name are always in the same order, and it reads each ballot's N through
-- ballot_given, so a sheet read during a sequential count shows its weights.
--
-- Every function that names the budget kind is restated from its latest
-- definition, changed only there.

ALTER TABLE "public"."polls"
  DROP CONSTRAINT "polls_kind_ck",
  DROP CONSTRAINT "polls_schedule_ck",
  DROP CONSTRAINT "polls_kind_value_ck";

ALTER TABLE "public"."polls"
  ADD CONSTRAINT "polls_kind_ck"
    CHECK (("kind" = ANY (ARRAY['option'::"text", 'ranking'::"text", 'multiple'::"text", 'fractional'::"text", 'consensus'::"text", 'budget'::"text", 'ranking_budget'::"text", 'fractional_budget'::"text", 'assignment'::"text", 'consensus_winners'::"text"]))),
  ADD CONSTRAINT "polls_schedule_ck"
    CHECK ((("schedule" IS NULL) OR ("kind" <> ALL (ARRAY['budget'::"text", 'ranking_budget'::"text", 'fractional_budget'::"text"])))),
  ADD CONSTRAINT "polls_kind_value_ck"
    CHECK ((("kind_value" IS NULL) OR (("kind_value" = "trunc"("kind_value")) AND ((("kind" = ANY (ARRAY['ranking'::"text", 'multiple'::"text", 'consensus_winners'::"text"])) AND ("kind_value" >= (2)::numeric)) OR (("kind" = ANY (ARRAY['budget'::"text", 'ranking_budget'::"text", 'fractional_budget'::"text", 'assignment'::"text"])) AND ("kind_value" >= (1)::numeric))))));

COMMENT ON COLUMN "public"."polls"."kind" IS 'What the question asks for, and so which result it opens on: ''option'' (the best option), ''ranking'' (multiple winners: STAR run again without each winner), ''multiple'' (proportional winners), ''fractional'' (fractional winners), ''consensus'' (the consensus option), ''budget'' (proportional winners with a budget, its options costed), ''ranking_budget'' (multiple winners with a budget, its options costed), ''fractional_budget'' (fractional winners with a budget, each option funded up to its cost), ''assignment'' (an option assignment, which shows who voted) or ''consensus_winners'' (consensus winners). Whether the ballot is a calendar is whether the question has a schedule, which no budget may. The other results are still offered. A setting, frozen at creation like mode.';


-- Each ballot's N: the one it was cast with, or, while a sequential count is
-- running on this poll, the one the reader gave it. Null on a ballot that
-- carries none.
CREATE OR REPLACE FUNCTION "public"."ballot_given"("p_poll_id" "uuid") RETURNS TABLE("ballot_id" "uuid", "given" numeric)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select b.id,
         case when o.j ->> 'poll' = p_poll_id::text
              then (o.j -> 'given' ->> b.id::text)::numeric
              else b.given end
  from ballots b,
       (select nullif(current_setting('app.sequential_given', true), '')::jsonb as j) o
  where b.poll_id = p_poll_id
$$;

ALTER FUNCTION "public"."ballot_given"("uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."ballot_given"("uuid") FROM PUBLIC;


CREATE OR REPLACE FUNCTION "public"."poll_is_weighted"("p_poll_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (select 1 from ballot_given(p_poll_id) where given is not null)
$$;


CREATE OR REPLACE FUNCTION "public"."poll_ballot_weights"("p_poll_id" "uuid") RETURNS TABLE("ballot_id" "uuid", "weight" numeric)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select g.ballot_id, (5 + m.low) / (5 + coalesce(g.given, 0))
  from ballot_given(p_poll_id) g,
       (select coalesce(min(given), 0) as low from ballot_given(p_poll_id)) m
$$;


CREATE OR REPLACE FUNCTION "public"."poll_multiple_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[])
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_ballots uuid[];
  v_given numeric[];
  v_weights numeric[];
  v_scale numeric;
  v_pool uuid[];
  v_round jsonb;
  v_finalists uuid[];
  v_winner uuid;
  v_placed uuid[];
  v_placed_json jsonb;
  v_finalist_names jsonb;
  v_spots jsonb := '[]'::jsonb;
  v_place int := 1;
begin
  -- A poll has at most a few hundred options; anything longer is not a list
  -- a reader built by pressing buttons.
  if coalesce(array_length(p_excluded, 1), 0) > 1000 then
    raise exception 'Too many options left out';
  end if;

  -- The stars each ballot has given the winners so far, in v_ballots' order:
  -- those it was cast with, on a sequential question, and nothing otherwise.
  select coalesce(array_agg(id order by id), '{}'::uuid[]),
         coalesce(array_agg(coalesce(given, 0) order by id), '{}'::numeric[]),
         5 + coalesce(min(given), 0)
  into v_ballots, v_given, v_scale
  from ballot_given(p_poll_id) g(id, given);

  if coalesce(array_length(v_ballots, 1), 0) = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into v_pool
  from candidates
  where poll_id = p_poll_id
    and not (id = any(coalesce(p_excluded, '{}'::uuid[])));

  while coalesce(array_length(v_pool, 1), 0) > 0 and v_place <= poll_results_rows() loop
    select array_agg(v_scale / (5 + g) order by ord) into v_weights
    from unnest(v_given) with ordinality u(g, ord);

    v_round := weighted_star_round(p_poll_id, v_pool, v_ballots, v_weights);

    select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_finalists
    from jsonb_array_elements_text(v_round->'finalists') x;

    v_winner := (v_round->>'winner_id')::uuid;

    if v_winner is null then
      v_placed := v_finalists;
    else
      v_placed := array[v_winner];
    end if;

    exit when coalesce(array_length(v_placed, 1), 0) = 0;

    -- Each placed option at the weighted total it was elected on.
    select jsonb_agg(jsonb_build_object('id', r.cid, 'name', r.name, 'total_score', r.total)
                     order by r.total desc, r.name)
    into v_placed_json
    from _wround r where r.cid = any(v_placed);

    select coalesce(jsonb_agg(t.name order by f.ord), '[]'::jsonb)
    into v_finalist_names
    from unnest(v_finalists) with ordinality f(cid, ord)
    join candidates t on t.id = f.cid;

    v_spots := v_spots || jsonb_build_array(jsonb_build_object(
      'place', v_place,
      'options', v_placed_json,
      'finalists', v_round->'finalists',
      'finalist_names', v_finalist_names,
      'runoff', v_round->'runoff',
      'tiebreaks', v_round->'tiebreaks'));

    v_place := v_place + array_length(v_placed, 1);

    -- Every ballot is charged the stars it gave whatever was placed.
    select array_agg(u.g + coalesce((
             select sum(s.score) from scores s
             where s.ballot_id = v_ballots[u.ord::int] and s.candidate_id = any(v_placed)), 0)
           order by u.ord)
    into v_given
    from unnest(v_given) with ordinality u(g, ord);

    select coalesce(array_agg(x), '{}'::uuid[]) into v_pool
    from unnest(v_pool) x
    where not (x = any(v_placed));
  end loop;

  return v_spots;
end;
$$;


-- Funds options out of a budget, by either count; see the header.
CREATE OR REPLACE FUNCTION "public"."poll_budget"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[], "p_costs" "jsonb", "p_budget" numeric, "p_proportional" boolean)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_budget numeric;
  v_left numeric;
  v_average numeric;
  v_ballots uuid[];
  v_lost numeric[];
  v_weights numeric[];
  v_pool uuid[];
  v_scales numeric[];
  v_round jsonb;
  v_finalists uuid[];
  v_winner uuid;
  v_placed uuid[];
  v_placed_json jsonb;
  v_finalist_names jsonb;
  v_spots jsonb := '[]'::jsonb;
  v_tied jsonb;
  v_unfunded jsonb;
  v_uncosted jsonb;
  v_funded uuid[] := '{}';
  v_place int := 1;
  v_key text;
  v_value jsonb;
begin
  if coalesce(array_length(p_excluded, 1), 0) > 1000 then
    raise exception 'Too many options left out';
  end if;

  if poll_is_weighted(p_poll_id) then
    raise exception 'A sequential poll''s ballots carry weights a budget would ignore';
  end if;

  p_costs := coalesce(p_costs, '{}'::jsonb);
  if jsonb_typeof(p_costs) <> 'object' then
    raise exception 'Give the costs as an object';
  end if;

  -- Every cost a reader sends is held to the rules a stored one is.
  for v_key, v_value in select key, value from jsonb_each(p_costs) loop
    continue when v_value = 'null'::jsonb;
    if jsonb_typeof(v_value) <> 'number' then
      raise exception 'A cost is not a number';
    end if;
    perform validate_amount((v_value #>> '{}')::numeric, 'A cost');
  end loop;

  select coalesce(p_budget, kind_value) into v_budget from polls where id = p_poll_id;
  if v_budget is null then
    raise exception 'Give the budget';
  end if;
  perform validate_amount(v_budget, 'The budget');
  v_left := v_budget;

  select coalesce(array_agg(id order by id), '{}'::uuid[]) into v_ballots
  from ballots where poll_id = p_poll_id;

  if coalesce(array_length(v_ballots, 1), 0) = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  -- Every option on the ballot, with the cost it is counted at.
  drop table if exists _bcost;
  create temp table _bcost on commit drop as
  select c.id as cid, c.name,
         case when p_costs ? c.id::text then (p_costs ->> c.id::text)::numeric
              else c.kind_value end as cost
  from candidates c
  where c.poll_id = p_poll_id
    and not (c.id = any(coalesce(p_excluded, '{}'::uuid[])));

  select coalesce(jsonb_agg(jsonb_build_object('id', cid, 'name', name) order by name), '[]'::jsonb)
  into v_uncosted
  from _bcost where cost is null;

  delete from _bcost where cost is null;

  if not exists (select 1 from _bcost) then
    raise exception 'Give at least one option a cost';
  end if;

  select avg(cost) into v_average from _bcost;

  -- What each ballot has spent of its influence, in v_ballots' order.
  v_lost := array_fill(0::numeric, array[array_length(v_ballots, 1)]);

  loop
    select coalesce(array_agg(cid order by cid), '{}'::uuid[]),
           coalesce(array_agg(case when p_proportional then v_average / cost else 1 end order by cid),
                    '{}'::numeric[])
    into v_pool, v_scales
    from _bcost
    where not (cid = any(v_funded)) and cost <= v_left;

    exit when coalesce(array_length(v_pool, 1), 0) = 0;

    select array_agg(5::numeric / (5 + l) order by ord) into v_weights
    from unnest(v_lost) with ordinality u(l, ord);

    v_round := scaled_star_round(p_poll_id, v_pool, v_ballots, v_weights, v_scales);

    select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_finalists
    from jsonb_array_elements_text(v_round->'finalists') x;

    v_winner := (v_round->>'winner_id')::uuid;

    if v_winner is not null then
      v_placed := array[v_winner];
    elsif (select sum(cost) from _bcost where cid = any(v_finalists)) <= v_left then
      v_placed := v_finalists;
    else
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'cost', cost) order by name)
      into v_tied
      from _bcost where cid = any(v_finalists);
      exit;
    end if;

    v_left := v_left - (select sum(cost) from _bcost where cid = any(v_placed));

    select jsonb_agg(jsonb_build_object('id', r.cid, 'name', r.name, 'cost', b.cost,
                                        'total_score', r.total)
                     order by r.total desc, r.name)
    into v_placed_json
    from _wround r join _bcost b on b.cid = r.cid
    where r.cid = any(v_placed);

    select coalesce(jsonb_agg(t.name order by f.ord), '[]'::jsonb)
    into v_finalist_names
    from unnest(v_finalists) with ordinality f(cid, ord)
    join candidates t on t.id = f.cid;

    v_spots := v_spots || jsonb_build_array(jsonb_build_object(
      'place', v_place,
      'options', v_placed_json,
      'finalists', v_round->'finalists',
      'finalist_names', v_finalist_names,
      'runoff', v_round->'runoff',
      'tiebreaks', v_round->'tiebreaks',
      'left', v_left));

    v_place := v_place + array_length(v_placed, 1);
    v_funded := v_funded || v_placed;

    -- Every ballot is charged the stars it gave whatever was funded, each
    -- star at that option's cost over the average. Funding by popularity
    -- charges nobody, so every round is plain STAR over what still fits.
    continue when not p_proportional;

    select array_agg(u.l + coalesce((
             select sum(s.score * b.cost / v_average) from scores s
             join _bcost b on b.cid = s.candidate_id
             where s.ballot_id = v_ballots[u.ord::int] and s.candidate_id = any(v_placed)), 0)
           order by u.ord)
    into v_lost
    from unnest(v_lost) with ordinality u(l, ord);
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'cost', cost)
                            order by cost, name), '[]'::jsonb)
  into v_unfunded
  from _bcost where not (cid = any(v_funded));

  return jsonb_build_object(
    'budget', v_budget,
    'spent', v_budget - v_left,
    'left', v_left,
    'average_cost', round(v_average, 6),
    'spots', v_spots,
    'unfunded', v_unfunded,
    'uncosted', v_uncosted,
    'tied', v_tied);
end;
$$;

ALTER FUNCTION "public"."poll_budget"("uuid", "uuid"[], "jsonb", numeric, boolean) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_budget"("uuid", "uuid"[], "jsonb", numeric, boolean) FROM PUBLIC;

DROP FUNCTION "public"."get_poll_proportional_budget"("uuid", "uuid"[], "jsonb", numeric);
DROP FUNCTION "public"."open_poll_proportional_budget"("uuid", "uuid"[], "jsonb", numeric);
DROP FUNCTION "public"."poll_proportional_budget"("uuid", "uuid"[], "jsonb", numeric);


-- The shares that make the product of every pattern's average stars as large
-- as possible, as poll_fractional_winners finds them, with share j held to at
-- most p_caps[j] (a cap of 1 or more holds nothing). Pattern i's score for
-- option j is p_scores[(i - 1) * k + j], k being the number of options. The
-- shares sum to 1, unless every option somebody starred fits under its cap
-- with room to spare, when each is at its cap. An option nobody starred stays
-- at 0.
--
-- Newton's method on the shares strictly between their bounds (the free
-- set), each step kept to the sum the free shares hold, cut short where a
-- share would reach 0 or its cap (it then leaves the set), and halved until
-- the welfare rises. When no step helps, the gradient of every free share is
-- the same, lambda; an option at 0 whose gradient beats lambda, or one at its
-- cap whose gradient falls short of it, rejoins the set (the worst first);
-- otherwise the shares are the answer.
CREATE OR REPLACE FUNCTION "public"."nash_capped_shares"(
    "p_scores" double precision[], "p_counts" double precision[], "p_caps" double precision[])
    RETURNS double precision[]
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_k int := coalesce(array_length(p_caps, 1), 0);
  v_m int := coalesce(array_length(p_counts, 1), 0);
  v_live boolean[];
  v_state int[];     -- 0 at 0, 1 free, 2 at its cap
  v_p float8[];
  v_try float8[];
  v_u float8[];
  v_g float8[];
  v_idx int[];
  v_n int;
  v_h float8[];
  v_w int;
  v_x float8[];
  v_y float8[];
  v_d float8[];
  v_lambda float8;
  v_decrement float8;
  v_trace float8;
  v_alpha float8;
  v_alpha_max float8;
  v_hit int;
  v_hit_state int;
  v_f0 float8;
  v_best int;
  v_worst float8;
  v_total float8 := 0;
  v_rest float8;
  v_open int;
  v_fixed boolean;
  v_t float8;
  v_sum float8;
  v_tmp float8;
  v_pivot int;
  v_step int := 0;
  i int;
  j int;
  a int;
  b int;
  c int;
begin
  v_p := array_fill(0::float8, array[v_k]);
  if v_k = 0 or v_m = 0 then
    return v_p;
  end if;

  for i in 1..v_m loop
    v_total := v_total + p_counts[i];
  end loop;

  v_live := array_fill(false, array[v_k]);
  v_sum := 0;
  for j in 1..v_k loop
    for i in 1..v_m loop
      if p_scores[(i - 1) * v_k + j] > 0 then
        v_live[j] := true;
        v_sum := v_sum + p_caps[j];
        exit;
      end if;
    end loop;
  end loop;

  -- Everything anybody starred fits: each is at its cap.
  if v_sum <= 1 + 1e-12 then
    for j in 1..v_k loop
      if v_live[j] then
        v_p[j] := p_caps[j];
      end if;
    end loop;
    return v_p;
  end if;

  -- Start from equal shares, any share above its cap held there and the rest
  -- shared equally between the others (filling to a level).
  v_state := array_fill(0, array[v_k]);
  for j in 1..v_k loop
    if v_live[j] then
      v_state[j] := 1;
    end if;
  end loop;
  v_rest := 1;
  loop
    v_open := 0;
    for j in 1..v_k loop
      if v_state[j] = 1 then
        v_open := v_open + 1;
      end if;
    end loop;
    v_t := v_rest / v_open;
    v_fixed := false;
    for j in 1..v_k loop
      if v_state[j] = 1 and p_caps[j] <= v_t then
        v_state[j] := 2;
        v_p[j] := p_caps[j];
        v_rest := v_rest - p_caps[j];
        v_fixed := true;
      end if;
    end loop;
    exit when not v_fixed;
  end loop;
  for j in 1..v_k loop
    if v_state[j] = 1 then
      v_p[j] := v_t;
    end if;
  end loop;

  loop
    v_step := v_step + 1;
    exit when v_step > 200;

    v_u := array_fill(0::float8, array[v_m]);
    for i in 1..v_m loop
      v_sum := 0;
      for j in 1..v_k loop
        v_sum := v_sum + v_p[j] * p_scores[(i - 1) * v_k + j];
      end loop;
      v_u[i] := v_sum;
    end loop;

    v_g := array_fill(0::float8, array[v_k]);
    for j in 1..v_k loop
      if v_live[j] then
        v_sum := 0;
        for i in 1..v_m loop
          v_sum := v_sum + p_counts[i] * p_scores[(i - 1) * v_k + j] / v_u[i];
        end loop;
        v_g[j] := v_sum;
      end if;
    end loop;

    v_idx := '{}';
    for j in 1..v_k loop
      if v_state[j] = 1 then
        v_idx := v_idx || j;
      end if;
    end loop;
    v_n := coalesce(array_length(v_idx, 1), 0);
    v_d := array_fill(0::float8, array[v_k]);
    v_decrement := 0;

    if v_n > 0 then
      v_w := v_n + 2;

      -- [H | g | 1], H minus the Hessian on the free set, with a whisker on
      -- its diagonal so that options scored alike still solve.
      v_h := array_fill(0::float8, array[v_n * v_w]);
      v_trace := 0;
      for a in 1..v_n loop
        for b in a..v_n loop
          v_sum := 0;
          for i in 1..v_m loop
            v_sum := v_sum + p_counts[i]
                     * p_scores[(i - 1) * v_k + v_idx[a]] * p_scores[(i - 1) * v_k + v_idx[b]]
                     / (v_u[i] * v_u[i]);
          end loop;
          v_h[(a - 1) * v_w + b] := v_sum;
          v_h[(b - 1) * v_w + a] := v_sum;
        end loop;
        v_trace := v_trace + v_h[(a - 1) * v_w + a];
        v_h[(a - 1) * v_w + v_n + 1] := v_g[v_idx[a]];
        v_h[(a - 1) * v_w + v_n + 2] := 1;
      end loop;
      for a in 1..v_n loop
        v_h[(a - 1) * v_w + a] := v_h[(a - 1) * v_w + a] + 1e-10 * v_trace / v_n;
      end loop;

      for c in 1..v_n loop
        v_pivot := c;
        for a in c + 1..v_n loop
          if abs(v_h[(a - 1) * v_w + c]) > abs(v_h[(v_pivot - 1) * v_w + c]) then
            v_pivot := a;
          end if;
        end loop;
        if v_pivot <> c then
          for b in 1..v_w loop
            v_tmp := v_h[(c - 1) * v_w + b];
            v_h[(c - 1) * v_w + b] := v_h[(v_pivot - 1) * v_w + b];
            v_h[(v_pivot - 1) * v_w + b] := v_tmp;
          end loop;
        end if;
        for a in c + 1..v_n loop
          v_tmp := v_h[(a - 1) * v_w + c] / v_h[(c - 1) * v_w + c];
          for b in c..v_w loop
            v_h[(a - 1) * v_w + b] := v_h[(a - 1) * v_w + b] - v_tmp * v_h[(c - 1) * v_w + b];
          end loop;
        end loop;
      end loop;

      v_x := array_fill(0::float8, array[v_n]);
      v_y := array_fill(0::float8, array[v_n]);
      for a in reverse v_n..1 loop
        v_sum := v_h[(a - 1) * v_w + v_n + 1];
        v_tmp := v_h[(a - 1) * v_w + v_n + 2];
        for b in a + 1..v_n loop
          v_sum := v_sum - v_h[(a - 1) * v_w + b] * v_x[b];
          v_tmp := v_tmp - v_h[(a - 1) * v_w + b] * v_y[b];
        end loop;
        v_x[a] := v_sum / v_h[(a - 1) * v_w + a];
        v_y[a] := v_tmp / v_h[(a - 1) * v_w + a];
      end loop;

      v_sum := 0;
      v_tmp := 0;
      for a in 1..v_n loop
        v_sum := v_sum + v_x[a];
        v_tmp := v_tmp + v_y[a];
      end loop;
      v_lambda := v_sum / v_tmp;

      for a in 1..v_n loop
        v_d[v_idx[a]] := v_x[a] - v_lambda * v_y[a];
        v_decrement := v_decrement + v_g[v_idx[a]] * v_d[v_idx[a]];
      end loop;
    end if;

    if v_decrement < 1e-12 * v_total then
      -- Nothing left to gain inside the set: the worst option on a bound
      -- that the gradients say should not be there rejoins it.
      v_best := null;
      v_worst := 1e-9;
      if v_n > 0 then
        v_sum := 0;
        v_tmp := 0;
        for a in 1..v_n loop
          v_sum := v_sum + v_p[v_idx[a]] * v_g[v_idx[a]];
          v_tmp := v_tmp + v_p[v_idx[a]];
        end loop;
        v_lambda := v_sum / v_tmp;
        for j in 1..v_k loop
          if v_live[j] and v_state[j] = 0 and v_g[j] / v_lambda - 1 > v_worst then
            v_best := j;
            v_worst := v_g[j] / v_lambda - 1;
          elsif v_state[j] = 2 and 1 - v_g[j] / v_lambda > v_worst then
            v_best := j;
            v_worst := 1 - v_g[j] / v_lambda;
          end if;
        end loop;
      else
        -- Every share on a bound: the capped option with the lowest
        -- gradient comes free if an option at 0 beats it.
        v_tmp := null;
        v_sum := null;
        for j in 1..v_k loop
          if v_state[j] = 2 and (v_tmp is null or v_g[j] < v_tmp) then
            v_tmp := v_g[j];
            v_best := j;
          elsif v_live[j] and v_state[j] = 0 and (v_sum is null or v_g[j] > v_sum) then
            v_sum := v_g[j];
          end if;
        end loop;
        if v_tmp is null or v_sum is null or v_sum <= v_tmp * (1 + 1e-9) then
          v_best := null;
        end if;
      end if;
      exit when v_best is null;
      v_state[v_best] := 1;
      continue;
    end if;

    -- As far as the step goes before a share reaches 0 or its cap.
    v_alpha_max := 1;
    v_hit := null;
    for a in 1..v_n loop
      j := v_idx[a];
      if v_d[j] < 0 and -v_p[j] / v_d[j] < v_alpha_max then
        v_alpha_max := -v_p[j] / v_d[j];
        v_hit := j;
        v_hit_state := 0;
      elsif v_d[j] > 0 and (p_caps[j] - v_p[j]) / v_d[j] < v_alpha_max then
        v_alpha_max := (p_caps[j] - v_p[j]) / v_d[j];
        v_hit := j;
        v_hit_state := 2;
      end if;
    end loop;

    -- A share already on the bound it is heading for leaves the set.
    if v_alpha_max < 1e-14 then
      v_p[v_hit] := case when v_hit_state = 2 then p_caps[v_hit] else 0 end;
      v_state[v_hit] := v_hit_state;
      continue;
    end if;

    v_f0 := nash_log_welfare(v_p, p_scores, p_counts);
    v_alpha := v_alpha_max;
    loop
      v_try := v_p;
      for a in 1..v_n loop
        j := v_idx[a];
        v_try[j] := least(p_caps[j], greatest(0, v_p[j] + v_alpha * v_d[j]));
      end loop;
      exit when nash_log_welfare(v_try, p_scores, p_counts) >= v_f0 + 1e-4 * v_alpha * v_decrement
             or v_alpha < 1e-12;
      v_alpha := v_alpha / 2;
    end loop;

    exit when v_alpha < 1e-12;

    v_p := v_try;
    if v_alpha = v_alpha_max and v_hit is not null then
      v_p[v_hit] := case when v_hit_state = 2 then p_caps[v_hit] else 0 end;
      v_state[v_hit] := v_hit_state;
    end if;
  end loop;

  return v_p;
end;
$$;

ALTER FUNCTION "public"."nash_capped_shares"(double precision[], double precision[], double precision[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."nash_capped_shares"(double precision[], double precision[], double precision[]) FROM PUBLIC;


-- Fractional winners with a budget: every option can be funded in part, up
-- to its cost, and a voter is served by the stars they gave each option times
-- the fraction of it funded. The amounts maximise the product of what every
-- voter is served (the Nash welfare), so a group of voters wanting only their
-- own option gets it funded in proportion to the group's size, where it does
-- not cost less than that, and a cheaper option buys its voters more per unit
-- spent. With a budget of B and an option j costing C, its share of the
-- budget x is held to C / B, and voter i is served the sum of S * B / C * x;
-- scaled by the average cost A instead of B, that is nash_capped_shares on
-- the scores S * A / C.
--
-- The whole budget is spent unless every option somebody starred is funded
-- in full. Only the poll_results_rows() costed options with the most stars
-- are funded, as fractional winners shares between that many (`outside`).
CREATE OR REPLACE FUNCTION "public"."poll_fractional_budget"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[], "p_costs" "jsonb", "p_budget" numeric)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_budget numeric;
  v_average float8;
  v_pool uuid[];
  v_costs float8[];
  v_caps float8[];
  v_k int;
  v_counts float8[];
  v_scores float8[];
  v_p float8[];
  v_uncosted jsonb;
  v_outside jsonb;
  v_left numeric;
  v_key text;
  v_value jsonb;
begin
  if coalesce(array_length(p_excluded, 1), 0) > 1000 then
    raise exception 'Too many options left out';
  end if;

  if poll_is_weighted(p_poll_id) then
    raise exception 'A sequential poll''s ballots carry weights a budget would ignore';
  end if;

  p_costs := coalesce(p_costs, '{}'::jsonb);
  if jsonb_typeof(p_costs) <> 'object' then
    raise exception 'Give the costs as an object';
  end if;

  for v_key, v_value in select key, value from jsonb_each(p_costs) loop
    continue when v_value = 'null'::jsonb;
    if jsonb_typeof(v_value) <> 'number' then
      raise exception 'A cost is not a number';
    end if;
    perform validate_amount((v_value #>> '{}')::numeric, 'A cost');
  end loop;

  select coalesce(p_budget, kind_value) into v_budget from polls where id = p_poll_id;
  if v_budget is null then
    raise exception 'Give the budget';
  end if;
  perform validate_amount(v_budget, 'The budget');

  if not exists (select 1 from ballots where poll_id = p_poll_id) then
    raise exception 'No votes were cast in this poll';
  end if;

  drop table if exists _fcost;
  create temp table _fcost on commit drop as
  select c.id as cid, c.name,
         case when p_costs ? c.id::text then (p_costs ->> c.id::text)::numeric
              else c.kind_value end as cost,
         coalesce((select sum(s.score) from scores s where s.candidate_id = c.id), 0) as total,
         (select count(*) from scores s where s.candidate_id = c.id and s.score = 5) as five_stars
  from candidates c
  where c.poll_id = p_poll_id
    and not (c.id = any(coalesce(p_excluded, '{}'::uuid[])));

  select coalesce(jsonb_agg(jsonb_build_object('id', cid, 'name', name) order by name), '[]'::jsonb)
  into v_uncosted
  from _fcost where cost is null;

  delete from _fcost where cost is null;

  if not exists (select 1 from _fcost) then
    raise exception 'Give at least one option a cost';
  end if;

  -- The pool, chosen as fractional winners chooses it.
  select array_agg(cid order by total desc, five_stars desc, cid),
         array_agg(cost::float8 order by total desc, five_stars desc, cid)
  into v_pool, v_costs
  from (select * from _fcost order by total desc, five_stars desc, cid
        limit poll_results_rows()) top;

  v_k := array_length(v_pool, 1);

  select coalesce(jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'cost', cost)
                            order by total desc, name), '[]'::jsonb)
  into v_outside
  from _fcost where not (cid = any(v_pool));

  select avg(x) into v_average from unnest(v_costs) x;
  select array_agg(x / v_budget::float8 order by ord) into v_caps
  from unnest(v_costs) with ordinality u(x, ord);

  -- Every ballot's scores for the pool, each scaled by the average cost over
  -- the option's cost, folded into distinct patterns; all zeros dropped.
  select coalesce(array_agg(n::float8 order by pattern), '{}'),
         coalesce(array_agg(pattern order by pattern), '{}')
  into v_counts, v_scores
  from (
    select pattern, count(*) as n
    from (
      select bl.id,
             array_agg(coalesce(s.score, 0)::float8 * v_average / v_costs[o.ord::int]
                       order by o.ord) as pattern
      from ballots bl
      cross join unnest(v_pool) with ordinality o(cid, ord)
      left join scores s on s.ballot_id = bl.id and s.candidate_id = o.cid
      where bl.poll_id = p_poll_id
      group by bl.id
    ) per_ballot
    where pattern <> array_fill(0::float8, array[v_k])
    group by pattern
  ) patterns;

  select coalesce(array_agg(x), '{}') into v_scores from unnest(v_scores) x;

  v_p := nash_capped_shares(v_scores, v_counts, v_caps);

  -- Amounts, an option within a millionth of the budget of its cost funded
  -- in full and one within a millionth of nothing given nothing.
  drop table if exists _ffund;
  create temp table _ffund on commit drop as
  select f.cid, f.name, f.cost,
         case when p * v_budget::float8 >= f.cost::float8 - 1e-6 * v_budget::float8 then f.cost
              when p < 1e-6 then 0
              else round((p * v_budget::float8)::numeric, 6) end as amount
  from unnest(v_pool, v_p) u(cid, p)
  join _fcost f on f.cid = u.cid;

  -- Left over only where everything starred is funded in full.
  v_left := case when exists (
                   select 1 from _ffund where amount > 0 and amount < cost)
                 then 0
                 else v_budget - (select coalesce(sum(amount), 0) from _ffund) end;
  v_left := greatest(v_left, 0);

  return jsonb_build_object(
    'budget', v_budget,
    'spent', v_budget - v_left,
    'left', v_left,
    'options', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', cid, 'name', name, 'cost', cost, 'amount', amount,
                  'funded', round(amount / cost, 6))
                  order by amount desc, name), '[]'::jsonb)
                from _ffund where amount > 0),
    'unfunded', (select coalesce(jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'cost', cost)
                   order by cost, name), '[]'::jsonb)
                 from _ffund where amount = 0),
    'outside', v_outside,
    'uncosted', v_uncosted);
end;
$$;

ALTER FUNCTION "public"."poll_fractional_budget"("uuid", "uuid"[], "jsonb", numeric) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_fractional_budget"("uuid", "uuid"[], "jsonb", numeric) FROM PUBLIC;


-- Which count a budget runs: 'multiple' (proportional winners), 'ranking'
-- (multiple winners) or 'fractional' (fractional winners).
CREATE OR REPLACE FUNCTION "public"."poll_budget_count"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[], "p_costs" "jsonb", "p_budget" numeric, "p_choice" "text")
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if coalesce(p_choice, 'multiple') not in ('multiple', 'ranking', 'fractional') then
    raise exception 'A budget counts proportional, multiple or fractional winners';
  end if;
  return case coalesce(p_choice, 'multiple')
    when 'multiple' then poll_budget(p_poll_id, p_excluded, p_costs, p_budget, true)
    when 'ranking' then poll_budget(p_poll_id, p_excluded, p_costs, p_budget, false)
    else poll_fractional_budget(p_poll_id, p_excluded, p_costs, p_budget)
  end;
end;
$$;

ALTER FUNCTION "public"."poll_budget_count"("uuid", "uuid"[], "jsonb", numeric, "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_budget_count"("uuid", "uuid"[], "jsonb", numeric, "text") FROM PUBLIC;


-- The doors, gated exactly as multiple winners' are. p_choice is the count.
CREATE OR REPLACE FUNCTION "public"."get_poll_budget"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}', "p_costs" "jsonb" DEFAULT NULL, "p_budget" numeric DEFAULT NULL, "p_choice" "text" DEFAULT 'multiple')
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_budget_count(p_poll_id, p_excluded, p_costs, p_budget, p_choice);
end;
$$;

ALTER FUNCTION "public"."get_poll_budget"("uuid", "uuid"[], "jsonb", numeric, "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."get_poll_budget"("uuid", "uuid"[], "jsonb", numeric, "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_budget"("uuid", "uuid"[], "jsonb", numeric, "text") TO "authenticated";


CREATE OR REPLACE FUNCTION "public"."open_poll_budget"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}', "p_costs" "jsonb" DEFAULT NULL, "p_budget" numeric DEFAULT NULL, "p_choice" "text" DEFAULT 'multiple')
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_budget_count(p_poll_id, p_excluded, p_costs, p_budget, p_choice);
end;
$$;

ALTER FUNCTION "public"."open_poll_budget"("uuid", "uuid"[], "jsonb", numeric, "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."open_poll_budget"("uuid", "uuid"[], "jsonb", numeric, "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_budget"("uuid", "uuid"[], "jsonb", numeric, "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_budget"("uuid", "uuid"[], "jsonb", numeric, "text") TO "authenticated";


-- A finished question counted as though it had been sequential: `p_given`
-- holds an N for every ballot, in the published sheet's order (ballot_sheet),
-- and `p_kind` is the result STAR decides that is wanted: 'option' and
-- 'ranking' answer the ranking (the best option is its first place),
-- 'multiple' proportional winners, each ballot starting from its N.
--
-- Only on a question whose ballots are published with names on them, where
-- every ballot is on the sheet already, so weighing one discloses nothing;
-- and not on a calendar, since a question takes one variant at most.
CREATE OR REPLACE FUNCTION "public"."poll_sequential"("p_poll_id" "uuid", "p_kind" "text", "p_given" numeric[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_ballots uuid[];
  v_map jsonb;
  v_result jsonb;
begin
  select * into v_poll from polls where id = p_poll_id;

  if not (v_poll.show_voters and v_poll.show_ballots) then
    raise exception 'Only a poll that publishes its ballots with names on them can be counted as a sequential poll';
  end if;

  if v_poll.schedule is not null then
    raise exception 'A time poll cannot be counted as a sequential poll';
  end if;

  if p_kind is null or p_kind not in ('option', 'ranking', 'multiple') then
    raise exception 'Only the best option, multiple winners or proportional winners can be counted as a sequential poll';
  end if;

  -- The sheet's order, which is how the reader gave the N.
  select coalesce(array_agg(b.id order by lower(coalesce(b.voter_name, u.email)), b.id), '{}'::uuid[])
  into v_ballots
  from ballots b
  left join auth.users u on u.id = b.voter_id
  where b.poll_id = p_poll_id;

  if cardinality(v_ballots) = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if coalesce(cardinality(p_given), 0) <> cardinality(v_ballots) then
    raise exception 'Give every ballot the stars its voter gave earlier winners';
  end if;

  if exists (select 1 from unnest(p_given) g where g is null or g < 0 or g > 10000) then
    raise exception 'Stars given to previous winners must be from 0 to 10000';
  end if;

  select jsonb_object_agg(u.b::text, u.g) into v_map
  from unnest(v_ballots, p_given) u(b, g);

  perform set_config('app.sequential_given',
                     jsonb_build_object('poll', p_poll_id, 'given', v_map)::text, true);

  v_result := case when p_kind = 'multiple'
                   then poll_multiple_winners(p_poll_id, '{}')
                   else poll_ranking(p_poll_id) end;

  perform set_config('app.sequential_given', '', true);

  return v_result;
end;
$$;

ALTER FUNCTION "public"."poll_sequential"("uuid", "text", numeric[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_sequential"("uuid", "text", numeric[]) FROM PUBLIC;


CREATE OR REPLACE FUNCTION "public"."get_poll_sequential"("p_poll_id" "uuid", "p_kind" "text", "p_given" numeric[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_sequential(p_poll_id, p_kind, p_given);
end;
$$;

ALTER FUNCTION "public"."get_poll_sequential"("uuid", "text", numeric[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."get_poll_sequential"("uuid", "text", numeric[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_sequential"("uuid", "text", numeric[]) TO "authenticated";


CREATE OR REPLACE FUNCTION "public"."open_poll_sequential"("p_poll_id" "uuid", "p_kind" "text", "p_given" numeric[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_sequential(p_poll_id, p_kind, p_given);
end;
$$;

ALTER FUNCTION "public"."open_poll_sequential"("uuid", "text", numeric[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."open_poll_sequential"("uuid", "text", numeric[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_sequential"("uuid", "text", numeric[]) TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_sequential"("uuid", "text", numeric[]) TO "authenticated";


CREATE OR REPLACE FUNCTION public.validate_kind(p_kind text, p_value numeric, p_question integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  v_which text := case when p_question is null then '' else format(' on question %s', p_question) end;
begin
  if p_kind is null or p_kind not in ('option', 'ranking', 'multiple', 'fractional', 'consensus', 'budget', 'ranking_budget', 'fractional_budget', 'assignment', 'consensus_winners') then
    raise exception 'Unknown poll kind%', v_which;
  end if;

  if p_kind in ('budget', 'ranking_budget', 'fractional_budget') then
    if p_value is null then
      raise exception 'Give the budget%', v_which;
    end if;
    perform validate_amount(p_value, 'The budget' || v_which);
    return;
  end if;

  if p_kind = 'consensus_winners' then
    if p_value is null then
      raise exception 'Say how many winners to choose%', v_which;
    end if;
    perform validate_winner_count(p_value, v_which);
    return;
  end if;

  if p_value is null then
    return;
  end if;

  if p_kind = 'assignment' then
    perform validate_per_voter(p_value, v_which);
    return;
  end if;

  if p_kind not in ('ranking', 'multiple') then
    raise exception 'Only multiple winners, proportional winners, consensus winners, a budget poll or an option assignment takes a number%', v_which;
  end if;

  if p_value <> trunc(p_value) or p_value < 2 or p_value > poll_results_rows() then
    raise exception '%', format('Choose a number from 2 to %s%s', poll_results_rows(), v_which);
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."option_cost"("p_kind" "text", "p_cost" "jsonb", "p_name" "text") RETURNS numeric
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_cost numeric;
begin
  if p_cost is null or p_cost = 'null'::jsonb then
    if p_kind in ('budget', 'ranking_budget', 'fractional_budget') then
      raise exception 'Give "%" a cost', p_name;
    end if;
    return null;
  end if;

  if p_kind = 'assignment' then
    if jsonb_typeof(p_cost) <> 'number' then
      raise exception 'The places for "%" are not a number', p_name;
    end if;
    v_cost := (p_cost #>> '{}')::numeric;
    perform validate_amount(v_cost, format('The places for "%s"', p_name));
    return v_cost;
  end if;

  if p_kind is null or p_kind not in ('budget', 'ranking_budget', 'fractional_budget') then
    raise exception 'Only a budget poll gives its options a cost';
  end if;

  if jsonb_typeof(p_cost) <> 'number' then
    raise exception 'The cost of "%" is not a number', p_name;
  end if;

  v_cost := (p_cost #>> '{}')::numeric;
  perform validate_amount(v_cost, format('The cost of "%s"', p_name));
  return v_cost;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."validate_calendar_kind"("p_kind" "text", "p_question" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
begin
  if p_kind in ('budget', 'ranking_budget', 'fractional_budget') then
    raise exception 'A budget poll cannot be a time poll%',
      case when p_question is null then '' else format(' (question %s)', p_question) end;
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."open_poll_view"("p_poll_id" "uuid", "p_voter_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted int;
  v_options jsonb;
  v_voters jsonb;
  v_ballot_id uuid;
  v_confirmation_id uuid;
  v_your_name text;
  v_your_scores jsonb;
  v_voted_already boolean;
  v_confirmations jsonb;
  v_confirmed_count int;
  v_confirmed boolean;
  v_your_confirmed_name text;
  v_sequential boolean;
  v_carried_names jsonb;
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  select count(*)::int into v_voted from ballots where poll_id = v_poll.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'poll_id', c.poll_id,
    'name', c.name,
    'description', c.description,
    'sort_order', c.sort_order,
    'cost', case when v_poll.kind in ('budget', 'ranking_budget', 'fractional_budget') then c.kind_value end,
    'places', case when v_poll.kind = 'assignment' then c.kind_value end
  ) order by c.sort_order, c.name), '[]'::jsonb)
  into v_options
  from candidates c where c.poll_id = v_poll.id;

  -- Names are visible while voting is still open on purpose: knowing whose
  -- vote is outstanding is the point of a named poll. Ballots are not, in
  -- either setting -- those wait for the close, like the results.
  if v_poll.show_voters then
    select coalesce(jsonb_agg(b.voter_name order by lower(b.voter_name)), '[]'::jsonb)
    into v_voters
    from ballots b
    where b.poll_id = v_poll.id and b.voter_name is not null;
  else
    v_voters := null;
  end if;

  -- Who is done adding options, on the same setting and with none of the
  -- embargo the ballot roster carries: what that embargo protects is the
  -- order ballots arrived in, and while a poll is collecting options there
  -- are no ballots to attach an order to. Alphabetical, like the other one.
  if v_poll.show_voters then
    select coalesce(jsonb_agg(oc.voter_name order by lower(oc.voter_name)), '[]'::jsonb)
    into v_confirmations
    from option_confirmations oc
    where oc.poll_id = v_poll.id and oc.voter_name is not null;
  else
    v_confirmations := null;
  end if;

  -- Through the shared function rather than counted here, so the number the
  -- share link reads and the number an account reads are one number.
  v_confirmed_count := poll_confirmed_count(v_poll.id);

  -- Your own ballot comes back with it, so "change my vote" can hand it to
  -- you filled in without a second request. Reaching it needs the voter_key
  -- that cast it, or the account that did -- which is what lets the phone
  -- hand back a ballot the laptop cast. Nobody else's ballot is readable here
  -- at any stage of any poll. See open_ballot_of.
  v_ballot_id := open_ballot_of(v_poll.id, p_voter_key);
  v_voted_already := v_ballot_id is not null;
  if v_voted_already then
    select
      b.voter_name,
      coalesce(
        (select jsonb_object_agg(s.candidate_id::text, s.score)
         from scores s where s.ballot_id = b.id),
        '{}'::jsonb)
    into v_your_name, v_your_scores
    from ballots b
    where b.id = v_ballot_id;
  end if;

  -- And your own confirmation, reached the same way and for the same reason:
  -- the page has to be able to draw the button you already pressed.
  v_confirmation_id := open_confirmation_of(v_poll.id, p_voter_key);
  v_confirmed := v_confirmation_id is not null;
  if v_confirmed then
    select oc.voter_name into v_your_confirmed_name
    from option_confirmations oc
    where oc.id = v_confirmation_id;
  end if;

  v_sequential := exists (select 1 from carried_weights where poll_id = v_poll.id);

  -- The names still to vote, on the setting that already shows who has.
  if v_sequential and v_poll.show_voters then
    select coalesce(jsonb_agg(cw.voter order by lower(cw.voter)), '[]'::jsonb)
    into v_carried_names
    from carried_weights cw
    where cw.poll_id = v_poll.id and not cw.claimed;
  end if;

  return jsonb_build_object(
    'poll', jsonb_build_object(
      'id', v_poll.id,
      'title', v_poll.title,
      'description', v_poll.description,
      'mode', v_poll.mode,
      'show_voters', v_poll.show_voters,
      'show_ballots', v_poll.show_ballots,
      'solicit_options', v_poll.solicit_options,
      'closed_at', v_poll.closed_at,
      -- When the poll was made, which the poll list needs to know where an
      -- opened poll will fall before it reads: it is ordered newest first,
      -- and the browser remembers the date beside the id (see
      -- src/lib/openedPolls.ts). A date anybody holding the link could already
      -- see the poll exist on, and fixed for its whole life.
      'created_at', v_poll.created_at,
      -- Null on a poll that asks one question, which is what tells the page
      -- to render no question strip rather than a strip of one.
      'group_id', v_poll.group_id,
      'question_position', v_poll.question_position,
      'question_title', v_poll.question_title,
      -- What the ballot is: an ordinary list of options, or a calendar and
      -- the grid to draw it on. Both readings of a poll page need them, and
      -- the account branch of poll_page gets them free from to_jsonb.
      'kind', v_poll.kind,
      'schedule', v_poll.schedule
    ),
    'options', v_options,
    'voted_count', v_voted,
    'is_closed', v_poll.closed_at is not null,
    -- Still gathering options: no ballot yet, and nothing to reveal.
    'soliciting', v_poll.solicit_options
                  and v_poll.options_finalized_at is null
                  and v_poll.closed_at is null,
    -- Open polls reveal only on close, so early votes can never steer late
    -- ones. This is the same promise the invite mode makes, and it is now
    -- the same function answering for both.
    'results_available', poll_results_revealed(v_poll),
    'voted', v_voted_already,
    'your_name', v_your_name,
    'your_scores', v_your_scores,
    'voters', v_voters,
    'confirmed', v_confirmed,
    'your_confirmed_name', v_your_confirmed_name,
    'confirmed_count', v_confirmed_count,
    'confirmations', v_confirmations,
    -- Withheld until the results are out by settle_winner rather than by a
    -- condition here: the column is empty while the poll is still taking
    -- votes, so there is nothing to leak to an early reader.
    'winner_name', v_poll.winner_name,
    'winner_settled', v_poll.winner_settled_at is not null,
    'sequential', v_sequential,
    'carried_names', v_carried_names
  );
end;
$$;

CREATE OR REPLACE FUNCTION "public"."poll_page"("p_poll_id" "uuid", "p_voter_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_creator boolean;
  v_revealed boolean;
begin
  select p.* into v_poll from polls p where p.id = p_poll_id;

  if not found then
    return jsonb_build_object('kind', 'unreadable');
  end if;

  v_creator := is_poll_creator(v_poll.id);
  v_revealed := poll_results_revealed(v_poll);

  if v_creator or is_invited_to_poll(v_poll.id) then
    return jsonb_build_object(
      'kind', 'account',
      'poll', to_jsonb(v_poll),
      'options', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id,
          'poll_id', c.poll_id,
          'name', c.name,
          'description', c.description,
          'sort_order', c.sort_order,
          'cost', case when v_poll.kind in ('budget', 'ranking_budget', 'fractional_budget') then c.kind_value end,
          'places', case when v_poll.kind = 'assignment' then c.kind_value end
        ) order by c.sort_order, c.name), '[]'::jsonb)
        from candidates c where c.poll_id = v_poll.id
      ),
      'status', (select to_jsonb(s) from poll_status(v_poll.id) s),
      'questions', poll_group(v_poll.id),
      'view', case
        when v_poll.mode = 'open' then open_poll_view(v_poll.id, p_voter_key)
        else null
      end,
      'results', case when v_revealed then get_poll_results(v_poll.id) else null end,
      'ballots', case
        when v_revealed and v_poll.show_ballots then poll_ballots(v_poll.id)
        else null
      end,
      'invitees', case
        when v_poll.mode = 'invite' and (v_creator or v_poll.show_voters) then (
          select coalesce(jsonb_agg(to_jsonb(i) order by i.email), '[]'::jsonb)
          from poll_invitees(v_poll.id) i
        )
        else null
      end,
      'your_scores', case
        when v_revealed
          and v_poll.mode = 'invite'
          and not v_poll.show_ballots
          and exists (
            select 1 from ballots b
            where b.poll_id = v_poll.id and b.voter_id = auth.uid()
          )
        then poll_ballot_scores(v_poll.id)
        else null
      end,
      'removed', poll_is_removed(v_poll.id)
    );
  end if;

  if v_poll.mode = 'open' then
    return jsonb_build_object(
      'kind', 'open',
      'view', open_poll_view(v_poll.id, p_voter_key),
      'questions', open_poll_group(v_poll.id),
      'results', case when v_revealed then open_poll_results(v_poll.id) else null end,
      'ballots', case
        when v_revealed and v_poll.show_ballots then open_poll_ballots(v_poll.id)
        else null
      end,
      'removed', poll_is_removed(v_poll.id)
    );
  end if;

  return jsonb_build_object('kind', 'unreadable');
end;
$$;

CREATE OR REPLACE FUNCTION public.poll_names_one_winner(p_poll_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_kind text;
  v_options int;
begin
  select kind into v_kind from polls where id = p_poll_id;
  select count(*)::int into v_options from candidates where poll_id = p_poll_id;

  return case
    when v_kind in ('ranking', 'multiple', 'consensus_winners') then v_options < 3
    when v_kind in ('fractional', 'budget', 'ranking_budget', 'fractional_budget', 'assignment') then v_options < 2
    else true
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.poll_tally(p_poll_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invited int;
  v_voted int;
  v_closed boolean;
  v_mode text;
  v_edited boolean;
  v_late boolean;
  v_kind text;
  v_kind_value numeric;
  v_kind_result jsonb;
  v_options jsonb;
  v_option_count int;
  v_pool uuid[];
  v_head jsonb;
  v_head_finalists uuid[];
  v_weighted boolean;
  v_strength numeric;
  v_voters_shown boolean;
  v_calendar boolean;
  v_ballots_shown boolean;
begin
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  select closed_at is not null, mode, options_edited_after_votes, votes_after_reveal,
         kind, kind_value, show_voters, schedule is not null, show_ballots
  into v_closed, v_mode, v_edited, v_late, v_kind, v_kind_value, v_voters_shown, v_calendar,
       v_ballots_shown
  from polls where id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  v_weighted := poll_is_weighted(p_poll_id);

  -- What an average is taken over: the ballots, or their total weight.
  select sum(weight) into v_strength from poll_ballot_weights(p_poll_id);

  -- Names and totals for the whole poll, for the score-round list. The round
  -- recomputes its own pool-scoped copy; these two never disagree, since a
  -- total is a per-option sum that no elimination can change.
  drop table if exists _tally;
  create temp table _tally on commit drop as
  select
    c.id as cid,
    c.name,
    c.description,
    case when v_weighted
         then trim_scale(round(coalesce(sum(s.score * w.weight), 0), 6))
         else coalesce(sum(s.score), 0) end as total
  from candidates c
  left join scores s on s.candidate_id = c.id
  left join poll_ballot_weights(p_poll_id) w on w.ballot_id = s.ballot_id
  where c.poll_id = p_poll_id
  group by c.id, c.name, c.description;

  select coalesce(array_agg(cid), '{}'::uuid[]), count(*)::int
  into v_pool, v_option_count
  from _tally;

  -- The head round is the whole of STAR: the score round, its tie-breaks and
  -- the runoff. Everything below first place is poll_ranking's, and is not
  -- computed here unless the question asked for it.
  v_head := poll_round(p_poll_id, v_pool);

  select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_head_finalists
  from jsonb_array_elements_text(v_head->'finalists') x;

  -- Order the score list so a tie-break winner sits above the option it
  -- beat, rather than falling alphabetically below it. That ordering is also
  -- what makes the cut safe: the two finalists are always the first two rows,
  -- so every option the page names is in the list.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cid,
    'name', name,
    -- Null on nearly every option ever created; the results page shows
    -- nothing at all for those rather than an empty affordance.
    'description', description,
    'total_score', total,
    'average_score', round(total::numeric / v_strength, 2)
  ) order by rn), '[]'::jsonb)
  into v_options
  from (
    select *, row_number() over (
      order by total desc, (case when cid = any(v_head_finalists) then 0 else 1 end), name) as rn
    from _tally
  ) t
  where rn <= poll_results_rows();

  -- Last, since the functions below build temp tables of their own.
  v_kind_result := case
    when v_kind = 'ranking' and v_option_count >= 3 then poll_ranking(p_poll_id)
    when v_kind = 'multiple' and v_option_count >= 3 then poll_multiple_winners(p_poll_id, '{}')
    when v_kind = 'fractional' and v_option_count >= 2 then poll_fractional_winners(p_poll_id, '{}')
    when v_kind = 'consensus' and v_option_count >= 2 then poll_consensus(p_poll_id, '{}')
    when v_kind = 'budget' and v_option_count >= 2 then poll_budget(p_poll_id, '{}', null, null, true)
    when v_kind = 'ranking_budget' and v_option_count >= 2 then poll_budget(p_poll_id, '{}', null, null, false)
    when v_kind = 'fractional_budget' and v_option_count >= 2 then poll_fractional_budget(p_poll_id, '{}', null, null)
    else null
  end;

  -- Refused only for size (or a poll somebody made sequential by hand); the
  -- page then opens on STAR's winner, and *More results* says why.
  -- Refused only for size, as the assignment is.
  if v_kind = 'consensus_winners' and v_option_count >= 3 then
    begin
      v_kind_result := poll_consensus_winners(p_poll_id, '{}', null);
    exception when raise_exception then
      v_kind_result := null;
    end;
  end if;

  if v_kind = 'assignment' and v_option_count >= 2 and v_voters_shown then
    begin
      v_kind_result := poll_assignment(p_poll_id, '{}', null);
    exception when raise_exception then
      v_kind_result := null;
    end;
  end if;

  return jsonb_build_object(
    'options', v_options,
    -- The size of the field the list above was cut from.
    'option_count', v_option_count,
    'finalists', case when jsonb_array_length(v_head->'finalists') = 2
                      then v_head->'finalists'
                      else '[]'::jsonb end,
    'tie', jsonb_array_length(v_head->'tiebreaks') > 0,
    'tiebreaks', v_head->'tiebreaks',
    'runoff', v_head->'runoff',
    'winner_id', v_head->'winner_id',
    'voter_count', v_voted,
    'invited_count', v_invited,
    'mode', v_mode,
    'closed_early', v_closed and v_voted < v_invited,
    -- The two caveats, travelling with the tally they are about. Everyone who
    -- can read the result reads them, through whichever door they came in by:
    -- get_poll_results and open_poll_results are two gates over this one
    -- function.
    'options_edited_after_votes', coalesce(v_edited, false),
    'votes_after_reveal', coalesce(v_late, false),
    'kind', v_kind,
    -- Whether the options are a calendar's windows, which the results name
    -- as times and which a budget is never offered on.
    'calendar', v_calendar,
    'kind_value', v_kind_value,
    'kind_result', v_kind_result,
    'weighted', v_weighted,
    'voters_shown', v_voters_shown,
    -- Whether the ballots are published, so a sheet names every ballot and
    -- *More results* may offer to weigh them (poll_sequential).
    'ballots_shown', v_ballots_shown
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.insert_carried_weights(p_poll_id uuid, p_carried jsonb, p_question integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_which text := case when p_question is null then '' else format(' on question %s', p_question) end;
  v_poll polls;
  v_item jsonb;
  v_voter text;
  v_given numeric;
begin
  if p_carried is null or p_carried = 'null'::jsonb then
    return;
  end if;

  if jsonb_typeof(p_carried) <> 'array' then
    raise exception 'The earlier voters must be a list%', v_which;
  end if;

  if jsonb_array_length(p_carried) = 0 then
    return;
  end if;

  select * into v_poll from polls where id = p_poll_id;

  if v_poll.kind not in ('option', 'ranking', 'multiple') then
    raise exception 'Only a question decided by STAR can be a sequential poll%', v_which;
  end if;

  -- A question takes one variant at most: a calendar, a sequence or a budget.
  if v_poll.schedule is not null then
    raise exception 'A sequential poll cannot also be a time poll%', v_which;
  end if;

  if v_poll.show_voters <> v_poll.show_ballots then
    raise exception 'A sequential poll shows both who voted and the ballots, or neither';
  end if;

  if jsonb_array_length(p_carried) > 500 then
    raise exception 'A sequential poll can carry 500 earlier voters%', v_which;
  end if;

  for v_item in select * from jsonb_array_elements(p_carried) loop
    v_voter := nullif(trim(coalesce(v_item ->> 'voter', '')), '');

    if v_voter is null then
      raise exception 'Every earlier voter needs a name%', v_which;
    end if;

    if jsonb_typeof(v_item -> 'given') is distinct from 'number' then
      raise exception 'Stars given to previous winners must be a number%', v_which;
    end if;

    v_given := (v_item ->> 'given')::numeric;

    if v_given < 0 or v_given > 10000 then
      raise exception 'Stars given to previous winners must be from 0 to 10000%', v_which;
    end if;

    if v_poll.mode = 'invite' then
      v_voter := lower(v_voter);
      if not exists (select 1 from invited_voters where poll_id = p_poll_id and email = v_voter) then
        raise exception '% is not on the invite list', v_voter;
      end if;
    elsif length(v_voter) > 60 then
      raise exception 'That name is too long: %', v_voter;
    end if;

    if exists (select 1 from carried_weights where poll_id = p_poll_id and lower(voter) = lower(v_voter)) then
      raise exception '"%" is listed twice%', v_voter, v_which;
    end if;

    insert into carried_weights (poll_id, voter, given) values (p_poll_id, v_voter, v_given);
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."ballot_sheet"("p_poll_id" "uuid", "p_named" boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_options jsonb;
  v_ballots jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)
                            order by c.sort_order, c.name), '[]'::jsonb)
  into v_options
  from candidates c
  where c.poll_id = p_poll_id;

  select coalesce(jsonb_agg(x.ballot order by x.sort_key, x.id), '[]'::jsonb)
  into v_ballots
  from (
    select
      jsonb_build_object(
        -- No ballot id in the payload: on an unnamed sheet it would be the
        -- one field that could be correlated with anything else, and the
        -- client only ever needs a row's position.
        'voter', case when p_named then coalesce(b.voter_name, lower(u.email)) end,
        'scores', coalesce(
          (select jsonb_object_agg(s.candidate_id::text, s.score)
           from scores s where s.ballot_id = b.id),
          '{}'::jsonb)
      ) || case when p_named and g.given is not null
                then jsonb_build_object('given', trim_scale(g.given))
                else '{}'::jsonb end as ballot,
      case
        when p_named then lower(coalesce(b.voter_name, u.email))
        else md5(b.id::text)
      end as sort_key,
      b.id
    from ballots b
    -- Invite ballots carry a voter_id and no name; open ones the reverse.
    left join auth.users u on u.id = b.voter_id
    -- The N each ballot is counted at, which a sequential count may have set.
    join ballot_given(p_poll_id) g on g.ballot_id = b.id
    where b.poll_id = p_poll_id
  ) x;

  return jsonb_build_object(
    'voters_named', p_named,
    'options', v_options,
    'ballots', v_ballots
  );
end;
$$;

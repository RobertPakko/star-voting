-- Fractional winners: a share for every option rather than a place, chosen to
-- make the product of every voter's average stars as large as possible (the
-- Nash welfare). A voter's average stars under shares p is
-- u = p1 * s1 + p2 * s2 + ...; the shares chosen maximise u1 * u2 * ... * un.
--
-- Only the poll_results_rows() options with the most stars are shared
-- between, as the results and the full ranking stop at that many, so the cost
-- is bounded by the poll's voters and not its options: a time poll can have
-- hundreds. Taking an option out lets the next one in.
--
-- The reader can take options out (`p_excluded`), as for multiple winners, and
-- the shares are worked out again as though they had never been on the
-- ballot. Nothing is stored.


-- The log of the Nash welfare under shares `p`: the sum over score patterns
-- of count * log(u), u being the pattern's average stars. -Infinity where a
-- pattern is left with nothing, which no step is allowed to reach.
CREATE OR REPLACE FUNCTION "public"."nash_log_welfare"(
    "p" double precision[], "p_scores" double precision[], "p_counts" double precision[])
    RETURNS double precision
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_k int := array_length(p, 1);
  v_f float8 := 0;
  v_u float8;
  i int;
  j int;
begin
  for i in 1..coalesce(array_length(p_counts, 1), 0) loop
    v_u := 0;
    for j in 1..v_k loop
      v_u := v_u + p[j] * p_scores[(i - 1) * v_k + j];
    end loop;
    if v_u <= 0 then
      return '-Infinity'::float8;
    end if;
    v_f := v_f + p_counts[i] * ln(v_u);
  end loop;
  return v_f;
end;
$$;

ALTER FUNCTION "public"."nash_log_welfare"(double precision[], double precision[], double precision[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."nash_log_welfare"(double precision[], double precision[], double precision[]) FROM PUBLIC;


-- The shares, largest first: [{ id, name, share }], every share a fraction of
-- 1 and the shares summing to 1 (or every share 0, where no voter gave any of
-- the options a star).
--
-- The log of the product is concave in the shares, so its maximum is found
-- by Newton's method on the shares still above 0 (the active set): each step
-- kept to a sum of 1, cut short where a share would go below 0 (that option
-- leaves the set), and halved until the welfare rises. When no step helps, an
-- option outside the set comes back in if a little of it would raise the
-- welfare (its gradient beats the rest's); otherwise the shares are the
-- answer. With at most ten options a step is a ten-by-ten solve and a handful
-- of steps is enough, where the simpler multiplicative update
-- (p <- p * mean(s / u)) takes thousands on ordinary ballots.
--
-- Ballots are folded first into distinct score patterns with a count, since
-- only a ballot's scores matter. A voter who gave every option in the pool 0
-- is satisfied by no shares, so is left out rather than holding the product
-- at 0. Two options every voter scored alike can split their joint share any
-- way at all; starting from equal shares, they split it evenly.
CREATE OR REPLACE FUNCTION "public"."poll_fractional_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[])
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_pool uuid[];
  v_k int;
  v_m int;
  v_counts float8[];
  v_scores float8[];
  v_total float8;
  v_live boolean[];
  v_active boolean[];
  v_p float8[];
  v_try float8[];
  v_u float8[];
  v_g float8[];
  v_idx int[];
  v_n int;
  v_h float8[];      -- the augmented system [H | g | 1]: n rows of n + 2
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
  v_f0 float8;
  v_best int;
  v_best_g float8;
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
  -- A poll has at most a few hundred options; anything longer is not a list
  -- a reader built by pressing buttons.
  if coalesce(array_length(p_excluded, 1), 0) > 1000 then
    raise exception 'Too many options left out';
  end if;

  if not exists (select 1 from ballots where poll_id = p_poll_id) then
    raise exception 'No votes were cast in this poll';
  end if;

  -- The pool: the options with the most stars, ties on stars going to more
  -- five-star votes, then by id, so the same ballots give the same pool.
  select coalesce(array_agg(cid order by total desc, five_stars desc, cid), '{}'::uuid[])
  into v_pool
  from (
    select cand.id as cid,
           coalesce(sum(s.score), 0) as total,
           count(s.score) filter (where s.score = 5) as five_stars
    from candidates cand
    left join scores s on s.candidate_id = cand.id
    where cand.poll_id = p_poll_id
      and not (cand.id = any(coalesce(p_excluded, '{}'::uuid[])))
    group by cand.id
    order by total desc, five_stars desc, cand.id
    limit poll_results_rows()
  ) top;

  v_k := coalesce(array_length(v_pool, 1), 0);
  if v_k = 0 then
    return '[]'::jsonb;
  end if;

  -- Every ballot's scores for the pool, in the pool's order (a missing score
  -- is 0), folded into distinct patterns. A pattern of all zeros is dropped.
  select coalesce(array_agg(n::float8 order by pattern), '{}'),
         coalesce(array_agg(pattern order by pattern), '{}')
  into v_counts, v_scores
  from (
    select pattern, count(*) as n
    from (
      select bl.id,
             array_agg(coalesce(s.score, 0)::float8 order by o.ord) as pattern
      from ballots bl
      cross join unnest(v_pool) with ordinality o(cid, ord)
      left join scores s on s.ballot_id = bl.id and s.candidate_id = o.cid
      where bl.poll_id = p_poll_id
      group by bl.id
    ) per_ballot
    where pattern <> array_fill(0::float8, array[v_k])
    group by pattern
  ) patterns;

  -- array_agg of arrays makes a two-dimensional array; flatten it, so that
  -- pattern i's score for option j is v_scores[(i - 1) * k + j].
  select coalesce(array_agg(x), '{}') into v_scores from unnest(v_scores) x;
  v_m := coalesce(array_length(v_counts, 1), 0);

  -- Nobody starred any of them: there is nothing to share.
  if v_m = 0 then
    return (
      select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'share', 0)
                       order by o.name, o.id)
      from candidates o where o.id = any(v_pool));
  end if;

  select sum(x) into v_total from unnest(v_counts) x;

  -- Start every option somebody starred at an equal share. An option nobody
  -- starred adds nothing to anybody, so stays at 0 throughout.
  v_live := array_fill(false, array[v_k]);
  for j in 1..v_k loop
    for i in 1..v_m loop
      if v_scores[(i - 1) * v_k + j] > 0 then
        v_live[j] := true;
        exit;
      end if;
    end loop;
  end loop;
  v_active := v_live;
  v_n := (select count(*) from unnest(v_live) x where x);
  v_p := array_fill(0::float8, array[v_k]);
  for j in 1..v_k loop
    if v_live[j] then
      v_p[j] := 1.0 / v_n;
    end if;
  end loop;

  loop
    v_step := v_step + 1;
    exit when v_step > 100;

    -- Every pattern's average stars, and the gradient of the log welfare.
    v_u := array_fill(0::float8, array[v_m]);
    for i in 1..v_m loop
      v_sum := 0;
      for j in 1..v_k loop
        v_sum := v_sum + v_p[j] * v_scores[(i - 1) * v_k + j];
      end loop;
      v_u[i] := v_sum;
    end loop;

    v_g := array_fill(0::float8, array[v_k]);
    for j in 1..v_k loop
      if v_live[j] then
        v_sum := 0;
        for i in 1..v_m loop
          v_sum := v_sum + v_counts[i] * v_scores[(i - 1) * v_k + j] / v_u[i];
        end loop;
        v_g[j] := v_sum;
      end if;
    end loop;

    v_idx := '{}';
    for j in 1..v_k loop
      if v_active[j] then
        v_idx := v_idx || j;
      end if;
    end loop;
    v_n := coalesce(array_length(v_idx, 1), 0);
    v_w := v_n + 2;

    -- [H | g | 1], H being minus the Hessian on the active set, with a
    -- whisker added to its diagonal so that options scored alike (which make
    -- it singular) still solve.
    v_h := array_fill(0::float8, array[v_n * v_w]);
    v_trace := 0;
    for a in 1..v_n loop
      for b in a..v_n loop
        v_sum := 0;
        for i in 1..v_m loop
          v_sum := v_sum + v_counts[i]
                   * v_scores[(i - 1) * v_k + v_idx[a]] * v_scores[(i - 1) * v_k + v_idx[b]]
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

    -- Gaussian elimination with partial pivoting, both right-hand sides at
    -- once.
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

    -- The Newton step kept to a sum of 1: d = H^-1 (g - lambda), lambda
    -- chosen so that d sums to 0.
    v_sum := 0;
    v_tmp := 0;
    for a in 1..v_n loop
      v_sum := v_sum + v_x[a];
      v_tmp := v_tmp + v_y[a];
    end loop;
    v_lambda := v_sum / v_tmp;

    v_d := array_fill(0::float8, array[v_k]);
    v_decrement := 0;
    for a in 1..v_n loop
      v_d[v_idx[a]] := v_x[a] - v_lambda * v_y[a];
      v_decrement := v_decrement + v_g[v_idx[a]] * v_d[v_idx[a]];
    end loop;

    if v_decrement < 1e-12 * v_total then
      -- Nothing left to gain inside the set. At the optimum every share
      -- above 0 has gradient v_total and every other at most that; an option
      -- beating it comes back in.
      v_best := null;
      v_best_g := v_total * (1 + 1e-9);
      for j in 1..v_k loop
        if v_live[j] and not v_active[j] and v_g[j] > v_best_g then
          v_best := j;
          v_best_g := v_g[j];
        end if;
      end loop;
      exit when v_best is null;
      v_active[v_best] := true;
      continue;
    end if;

    -- As far as the step goes before a share reaches 0.
    v_alpha_max := 1;
    v_hit := null;
    for a in 1..v_n loop
      j := v_idx[a];
      if v_d[j] < 0 and -v_p[j] / v_d[j] < v_alpha_max then
        v_alpha_max := -v_p[j] / v_d[j];
        v_hit := j;
      end if;
    end loop;

    -- Halved until the welfare rises enough (Armijo's rule).
    v_f0 := nash_log_welfare(v_p, v_scores, v_counts);
    v_alpha := v_alpha_max;
    loop
      v_try := v_p;
      for a in 1..v_n loop
        j := v_idx[a];
        v_try[j] := greatest(0, v_p[j] + v_alpha * v_d[j]);
      end loop;
      exit when nash_log_welfare(v_try, v_scores, v_counts) >= v_f0 + 1e-4 * v_alpha * v_decrement
             or v_alpha < 1e-12;
      v_alpha := v_alpha / 2;
    end loop;

    exit when v_alpha < 1e-12;

    v_p := v_try;
    if v_alpha = v_alpha_max and v_hit is not null then
      v_p[v_hit] := 0;
      v_active[v_hit] := false;
    end if;

    v_sum := 0;
    for j in 1..v_k loop
      v_sum := v_sum + v_p[j];
    end loop;
    for j in 1..v_k loop
      v_p[j] := v_p[j] / v_sum;
    end loop;
  end loop;

  -- Shares too small to matter are 0, and the rest are scaled back up to sum
  -- to 1.
  v_sum := 0;
  for j in 1..v_k loop
    if v_p[j] < 1e-6 then
      v_p[j] := 0;
    end if;
    v_sum := v_sum + v_p[j];
  end loop;

  return (
    select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name,
                                        'share', round((s.share / v_sum)::numeric, 6))
                     order by s.share desc, o.name, o.id)
    from unnest(v_pool, v_p) s(cid, share)
    join candidates o on o.id = s.cid);
end;
$$;

ALTER FUNCTION "public"."poll_fractional_winners"("uuid", "uuid"[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_fractional_winners"("uuid", "uuid"[]) FROM PUBLIC;


-- The two doors, gated exactly as the full ranking is: the shares disclose at
-- least as much as the tally.
CREATE OR REPLACE FUNCTION "public"."get_poll_fractional_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}')
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_fractional_winners(p_poll_id, p_excluded);
end;
$$;

ALTER FUNCTION "public"."get_poll_fractional_winners"("uuid", "uuid"[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."get_poll_fractional_winners"("uuid", "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_fractional_winners"("uuid", "uuid"[]) TO "authenticated";


CREATE OR REPLACE FUNCTION "public"."open_poll_fractional_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}')
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_fractional_winners(p_poll_id, p_excluded);
end;
$$;

ALTER FUNCTION "public"."open_poll_fractional_winners"("uuid", "uuid"[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."open_poll_fractional_winners"("uuid", "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_fractional_winners"("uuid", "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_fractional_winners"("uuid", "uuid"[]) TO "authenticated";

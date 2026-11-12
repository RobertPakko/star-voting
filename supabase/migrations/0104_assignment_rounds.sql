-- Option assignment, several options to a voter: the question's own number
-- (polls.kind_value) is the most options a voter can be given, none meaning
-- one, and the count hands options out in rounds until every place is filled
-- or every voter is at that cap.
--
-- Each round gives each voter at most one more option, solved exactly by
-- the same Hungarian method, on the gain in the Nash product over what each
-- voter already holds (see poll_assignment). One round is the one-option
-- count unchanged; more rounds are not guaranteed to find the best product,
-- which would take an integer solver.
--
-- An option a voter gave 0 is now handed out too, last: options are given
-- out while there are places, so a voter who wanted nothing left takes what
-- is left rather than nobody taking it.


ALTER TABLE "public"."polls"
  DROP CONSTRAINT "polls_kind_value_ck";

ALTER TABLE "public"."polls"
  ADD CONSTRAINT "polls_kind_value_ck"
    CHECK ((("kind_value" IS NULL) OR (("kind_value" = "trunc"("kind_value")) AND ((("kind" = ANY (ARRAY['ranking'::"text", 'multiple'::"text"])) AND ("kind_value" >= (2)::numeric)) OR (("kind" = ANY (ARRAY['budget'::"text", 'assignment'::"text"])) AND ("kind_value" >= (1)::numeric))))));

COMMENT ON COLUMN "public"."polls"."kind_value" IS 'A number whose meaning belongs to the kind: the places to rank, the winners to choose, the budget, or the most options an option assignment gives one voter. Null where the kind takes none, or to show as many as the results hold (poll_results_rows()), or on an assignment for one option each; never null on a budget. Readers may look at a ranking or several winners with another number, or count an assignment with another cap; this is where it opens.';


-- An assignment takes a number of its own: the most options per voter, from
-- 1 to as many places as the results show.
CREATE OR REPLACE FUNCTION "public"."validate_kind"("p_kind" "text", "p_value" numeric, "p_question" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_which text := case when p_question is null then '' else format(' on question %s', p_question) end;
begin
  if p_kind is null or p_kind not in ('option', 'time', 'ranking', 'multiple', 'fractional', 'consensus', 'consensus_time', 'budget', 'assignment') then
    raise exception 'Unknown poll kind%', v_which;
  end if;

  if p_kind = 'budget' then
    if p_value is null then
      raise exception 'Give the budget%', v_which;
    end if;
    perform validate_amount(p_value, 'The budget' || v_which);
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
    raise exception 'Only an option ranking, multiple winners, a proportional budget or an option assignment takes a number%', v_which;
  end if;

  if p_value <> trunc(p_value) or p_value < 2 or p_value > poll_results_rows() then
    raise exception '%', format('Choose a number from 2 to %s%s', poll_results_rows(), v_which);
  end if;
end;
$$;


-- The most options one voter can be given, stored or sent.
CREATE OR REPLACE FUNCTION "public"."validate_per_voter"("p_value" numeric, "p_which" "text" DEFAULT ''::"text") RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
begin
  if p_value <> trunc(p_value) or p_value < 1 or p_value > poll_results_rows() then
    raise exception '%', format('Choose from 1 to %s options per voter%s', poll_results_rows(), p_which);
  end if;
end;
$$;

ALTER FUNCTION "public"."validate_per_voter"(numeric, "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."validate_per_voter"(numeric, "text") FROM PUBLIC;


-- A new argument, so the count and its two doors are dropped and made again,
-- grants restated.
DROP FUNCTION "public"."get_poll_assignment"("uuid", "uuid"[], "jsonb");
DROP FUNCTION "public"."open_poll_assignment"("uuid", "uuid"[], "jsonb");
DROP FUNCTION "public"."poll_assignment"("uuid", "uuid"[], "jsonb");


-- The assignment. Answers
--
--   { options, unplaced, short, received, places, per_voter, voter_count,
--     stars_shown }
--
-- `options` is every option counted, each with its `places` and the
-- `voters` it went to (by name, alphabetically; each with the `stars` they
-- gave it where the poll publishes its ballots), the fullest first.
-- `unplaced` is every voter given nothing, by name, and `short` every voter
-- given something but fewer than `per_voter`, with their `count`.
-- `received` counts the options handed out by the stars their voter gave
-- them ({ "5": 3, ... }), which is all a private ballot gives away about how
-- well the assignment went. `places` is every place counted, so a reader can
-- see there were too few.
--
-- Places are the options' own (candidates.kind_value, 1 where it has none),
-- with `p_places` ({ id: places }) over them, a key holding null putting an
-- option back to one. `p_excluded` leaves options off the ballot, as for
-- multiple winners. The most options a voter is given is `p_per_voter`, or
-- the question's own number on an assignment question, or 1.
--
-- Options are handed out in rounds, each voter given at most one more
-- option a round, never one they already hold, until no place is left that
-- a voter under the cap can take. Each round chooses, in order:
--
--   1. the most voters given their first star: a voter holding no star so
--      far, given an option they gave at least one;
--   2. the largest gain in the product of every voter's stars -- maximum Nash
--      welfare, one round at a time: ln(stars) for a voter's first star, and
--      ln((held + stars) / held) for a voter already holding `held` stars;
--   3. the most stars in total;
--   4. at random, the same way every time: each voter-option pair carries a
--      number hashed from the poll, the ballot and the option.
--
-- An option given 0 gains nothing on any of the first three, so it goes to
-- a voter only when nothing they starred has a place left; but it is handed
-- out rather than left empty.
--
-- With one option per voter the product's gain is a sum of one term per
-- voter, so a round is an assignment problem with capacities, solved exactly
-- by the Hungarian method: ballots are taken one at a time, each by the
-- cheapest path through the options to one with a place free, or to going
-- without (a column with room for everybody, worth nothing). Costs are pairs
-- of bigints compared in order, which is a total order Dijkstra is happy
-- with:
--
--   * the first is -(K + ln(stars) x 10^12) for a first star and
--     -(ln((held + stars) / held) x 10^12) otherwise, rounded, with K larger
--     than every voter's logarithms together, so a first star outweighs any
--     gain;
--   * the second is -(stars x S + r), r a 28-bit hash and S larger than every
--     voter's r together, so the total outweighs the draw.
--
-- A gain is always rounded to the same integer, so two rounds whose gains
-- are equal cost exactly the same and the tie falls through to the total and
-- the draw. One round is exact; several are not guaranteed to find the
-- largest product, since a round cannot see what a later one will want.
CREATE FUNCTION "public"."poll_assignment"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[], "p_places" "jsonb", "p_per_voter" integer DEFAULT NULL)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_ballots uuid[];
  v_names text[];
  v_options uuid[];
  v_cap int[];
  v_left int[];     -- each option's places still free
  v_stars int[];
  v_draw bigint[];
  v_per_voter int;
  n int;
  m int;
  w int;            -- the options and going without
  v_none int;       -- the column for going without
  v_big bigint := 9223372036854775807;
  v_log bigint[] := array[0,
    round(ln(2::numeric) * 1e12)::bigint, round(ln(3::numeric) * 1e12)::bigint,
    round(ln(4::numeric) * 1e12)::bigint, round(ln(5::numeric) * 1e12)::bigint];
  v_gain bigint[];  -- ln((held + stars) / held) x 10^12, at (held - 1) x 5 + stars
  k bigint;
  s bigint;
  -- Across rounds, by voter.
  v_held_stars int[];
  v_count int[];
  v_holds boolean[];  -- by (voter - 1) x m + option
  -- One round, by the round's own voter numbering.
  v_who int[];
  na int;
  e_hi bigint[];
  e_lo bigint[];
  u_hi bigint[];
  u_lo bigint[];
  v_hi bigint[];
  v_lo bigint[];
  d_hi bigint[];
  d_lo bigint[];
  way int[];
  done boolean[];
  col int[];
  cnt int[];
  nd_hi bigint;
  nd_lo bigint;
  v_given int;
  r int;
  i int;
  j int;
  h int;
  t int;
  g int;
  best int;
  v_score int;
  v_key text;
  v_value jsonb;
  v_result_options jsonb;
  v_unplaced jsonb;
  v_short jsonb;
  v_received jsonb;
begin
  if coalesce(array_length(p_excluded, 1), 0) > 1000 then
    raise exception 'Too many options left out';
  end if;

  select * into v_poll from polls where id = p_poll_id;

  -- The answer is a list of who gets what, so it is only for a poll that
  -- already says who voted.
  if not v_poll.show_voters then
    raise exception 'This poll does not show who voted, so it cannot say who gets which option';
  end if;

  if poll_is_weighted(p_poll_id) then
    raise exception 'A sequential poll''s ballots carry weights an assignment would ignore';
  end if;

  if p_per_voter is not null then
    perform validate_per_voter(p_per_voter);
  end if;
  v_per_voter := coalesce(p_per_voter,
    case when v_poll.kind = 'assignment' then v_poll.kind_value::int end, 1);

  p_places := coalesce(p_places, '{}'::jsonb);
  if jsonb_typeof(p_places) <> 'object' then
    raise exception 'Give the places as an object';
  end if;

  -- Every number a reader sends is held to the rules a stored one is.
  for v_key, v_value in select key, value from jsonb_each(p_places) loop
    continue when v_value = 'null'::jsonb;
    if jsonb_typeof(v_value) <> 'number' then
      raise exception 'A number of places is not a number';
    end if;
    perform validate_amount((v_value #>> '{}')::numeric, 'A number of places');
  end loop;

  -- The voters, by ballot id so the order is the same on every count.
  select coalesce(array_agg(b.id order by b.id), '{}'::uuid[]),
         coalesce(array_agg(coalesce(b.voter_name, lower(u.email), 'A voter') order by b.id), '{}'::text[])
  into v_ballots, v_names
  from ballots b
  -- Invite ballots carry a voter_id and no name; open ones the reverse.
  left join auth.users u on u.id = b.voter_id
  where b.poll_id = p_poll_id;

  n := coalesce(array_length(v_ballots, 1), 0);
  if n = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if n > 2000 then
    raise exception 'This poll has too many votes to assign options to them';
  end if;

  -- The options counted and their places.
  select coalesce(array_agg(c.id order by c.sort_order, c.name), '{}'::uuid[]),
         coalesce(array_agg((case when p_places ? c.id::text
                                  then coalesce((p_places ->> c.id::text)::numeric, 1)
                                  else coalesce(c.kind_value, 1) end)::int
                            order by c.sort_order, c.name), '{}'::int[])
  into v_options, v_cap
  from candidates c
  where c.poll_id = p_poll_id
    and not (c.id = any(coalesce(p_excluded, '{}'::uuid[])));

  m := coalesce(array_length(v_options, 1), 0);
  if m = 0 then
    raise exception 'There are no options left to assign';
  end if;

  -- Bounded by the work the count does: about voters x voters x options for
  -- the first round, each later one cheaper as the options fill (measured at
  -- about half), so a reader waits a few seconds at most -- Supabase's
  -- statement timeout, not CPU, is the ceiling that matters.
  if n::bigint * n * (m + 1) * (least(v_per_voter, m) + 1) / 2 > 15000000 then
    raise exception 'This poll has too many votes and options to assign them';
  end if;

  w := m + 1;
  v_none := w;

  -- Every voter's stars for every option, a row per voter, and the draw
  -- that settles an exact tie, from ids nobody chose.
  select array_agg(coalesce(sc.score, 0) order by b.ord, o.ord),
         array_agg(('x' || substr(md5(p_poll_id::text || b.id::text || o.id::text), 1, 7))::bit(28)::bigint
                   order by b.ord, o.ord)
  into v_stars, v_draw
  from unnest(v_ballots) with ordinality b(id, ord)
  cross join unnest(v_options) with ordinality o(id, ord)
  left join scores sc on sc.ballot_id = b.id and sc.candidate_id = o.id;

  -- ln 6 is the largest gain a round can give a voter already holding a
  -- star (1 held, 5 more), and ln 5 the largest first star.
  k := (n + 1)::bigint * 1800000000000;
  s := (n + 1)::bigint * 268435456;

  v_gain := array_fill(0::bigint, array[5 * v_per_voter * 5]);
  for g in 1 .. 5 * v_per_voter loop
    for v_score in 1 .. 5 loop
      v_gain[(g - 1) * 5 + v_score] := round(ln((g + v_score)::numeric / g) * 1e12)::bigint;
    end loop;
  end loop;

  v_left := v_cap;
  v_held_stars := array_fill(0, array[n]);
  v_count := array_fill(0, array[n]);
  v_holds := array_fill(false, array[n * m]);

  loop
    -- The voters in this round: under the cap, with an option they do not
    -- hold still having a place.
    select coalesce(array_agg(g.v order by g.v), '{}'::int[]) into v_who
    from generate_series(1, n) g(v)
    where v_count[g.v] < v_per_voter
      and exists (select 1 from generate_series(1, m) o(h)
                  where v_left[o.h] > 0 and not v_holds[(g.v - 1) * m + o.h]);
    na := coalesce(array_length(v_who, 1), 0);
    exit when na = 0;

    -- Every edge's cost this round, by the round's voter; v_big where the
    -- voter cannot take the option.
    e_hi := array_fill(v_big, array[na * w]);
    e_lo := array_fill(v_big, array[na * w]);
    for r in 1 .. na loop
      i := v_who[r];
      e_hi[(r - 1) * w + v_none] := 0;
      e_lo[(r - 1) * w + v_none] := 0;
      for h in 1 .. m loop
        continue when v_left[h] = 0 or v_holds[(i - 1) * m + h];
        v_score := v_stars[(i - 1) * m + h];
        e_hi[(r - 1) * w + h] := case
          when v_score = 0 then 0
          when v_held_stars[i] = 0 then -(k + v_log[v_score])
          else -v_gain[(v_held_stars[i] - 1) * 5 + v_score]
        end;
        e_lo[(r - 1) * w + h] := -(v_score * s + v_draw[(i - 1) * m + h]);
      end loop;
    end loop;

    u_hi := array_fill(0::bigint, array[na]);
    u_lo := array_fill(0::bigint, array[na]);
    v_hi := array_fill(0::bigint, array[w]);
    v_lo := array_fill(0::bigint, array[w]);
    col := array_fill(0, array[na]);
    cnt := array_fill(0, array[w]);

    for r in 1 .. na loop
      d_hi := array_fill(v_big, array[w]);
      d_lo := array_fill(v_big, array[w]);
      way := array_fill(0, array[w]);
      done := array_fill(false, array[w]);

      -- From the new voter, at a potential of nothing, to every column.
      for h in 1 .. w loop
        continue when e_hi[(r - 1) * w + h] = v_big;
        d_hi[h] := e_hi[(r - 1) * w + h] - v_hi[h];
        d_lo[h] := e_lo[(r - 1) * w + h] - v_lo[h];
        way[h] := r;
      end loop;

      loop
        -- The nearest column not yet settled. Going without is always
        -- reachable, so there is one.
        best := 0;
        for h in 1 .. w loop
          continue when done[h] or d_hi[h] = v_big;
          if best = 0 or (d_hi[h], d_lo[h]) < (d_hi[best], d_lo[best]) then
            best := h;
          end if;
        end loop;

        done[best] := true;

        if best = v_none or cnt[best] < v_left[best] then
          t := best;
          exit;
        end if;

        -- A full option: each voter in it could move on, at no cost to
        -- reach, since the edge that holds them there is tight.
        for i in 1 .. r - 1 loop
          continue when col[i] <> best;
          for h in 1 .. w loop
            continue when done[h] or e_hi[(i - 1) * w + h] = v_big;
            nd_hi := d_hi[best] + e_hi[(i - 1) * w + h] - u_hi[i] - v_hi[h];
            nd_lo := d_lo[best] + e_lo[(i - 1) * w + h] - u_lo[i] - v_lo[h];
            if (nd_hi, nd_lo) < (d_hi[h], d_lo[h]) then
              d_hi[h] := nd_hi;
              d_lo[h] := nd_lo;
              way[h] := i;
            end if;
          end loop;
        end loop;
      end loop;

      -- Potentials, so every edge stays non-negative and the path just found
      -- is tight: a settled column comes down by how far short of the sink
      -- it was, and each voter reached through one goes up by the same.
      for h in 1 .. w loop
        continue when not done[h] or h = t;
        for i in 1 .. r - 1 loop
          continue when col[i] <> h;
          u_hi[i] := u_hi[i] + (d_hi[t] - d_hi[h]);
          u_lo[i] := u_lo[i] + (d_lo[t] - d_lo[h]);
        end loop;
        v_hi[h] := v_hi[h] - (d_hi[t] - d_hi[h]);
        v_lo[h] := v_lo[h] - (d_lo[t] - d_lo[h]);
      end loop;
      u_hi[r] := d_hi[t];
      u_lo[r] := d_lo[t];

      -- Along the path, back from the sink: each voter on it moves into the
      -- column after it, and the new voter takes the first.
      cnt[t] := cnt[t] + 1;
      h := t;
      loop
        i := way[h];
        j := col[i];
        col[i] := h;
        exit when i = r;
        h := j;
      end loop;
    end loop;

    -- What the round handed out. A round that hands out nothing is the end:
    -- nobody under the cap could take a place.
    v_given := 0;
    for r in 1 .. na loop
      continue when col[r] = v_none;
      i := v_who[r];
      h := col[r];
      v_holds[(i - 1) * m + h] := true;
      v_held_stars[i] := v_held_stars[i] + v_stars[(i - 1) * m + h];
      v_count[i] := v_count[i] + 1;
      v_left[h] := v_left[h] - 1;
      v_given := v_given + 1;
    end loop;
    exit when v_given = 0;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id,
           'name', c.name,
           'places', v_cap[o.ord],
           'voters', coalesce((
             select jsonb_agg(
                      jsonb_build_object('name', v_names[g.v])
                      || case when v_poll.show_ballots
                              then jsonb_build_object('stars', v_stars[(g.v - 1) * m + o.ord])
                              else '{}'::jsonb end
                      order by lower(v_names[g.v]), g.v)
             from generate_series(1, n) g(v)
             where v_holds[(g.v - 1) * m + o.ord]), '[]'::jsonb))
           order by v_cap[o.ord] - v_left[o.ord] desc, o.ord), '[]'::jsonb)
  into v_result_options
  from unnest(v_options) with ordinality o(id, ord)
  join candidates c on c.id = o.id;

  select coalesce(jsonb_agg(jsonb_build_object('name', v_names[g.v])
                            order by lower(v_names[g.v]), g.v), '[]'::jsonb)
  into v_unplaced
  from generate_series(1, n) g(v)
  where v_count[g.v] = 0;

  select coalesce(jsonb_agg(jsonb_build_object('name', v_names[g.v], 'count', v_count[g.v])
                            order by lower(v_names[g.v]), g.v), '[]'::jsonb)
  into v_short
  from generate_series(1, n) g(v)
  where v_count[g.v] between 1 and v_per_voter - 1;

  select coalesce(jsonb_object_agg(x.stars, x.handed), '{}'::jsonb)
  into v_received
  from (
    select v_stars[(g.v - 1) * m + o.h] as stars, count(*) as handed
    from generate_series(1, n) g(v)
    cross join generate_series(1, m) o(h)
    where v_holds[(g.v - 1) * m + o.h]
    group by 1
  ) x;

  return jsonb_build_object(
    'options', v_result_options,
    'unplaced', v_unplaced,
    'short', v_short,
    'received', v_received,
    'places', (select sum(p::bigint) from unnest(v_cap) p),
    'per_voter', v_per_voter,
    'voter_count', n,
    'stars_shown', v_poll.show_ballots);
end;
$$;

ALTER FUNCTION "public"."poll_assignment"("uuid", "uuid"[], "jsonb", integer) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_assignment"("uuid", "uuid"[], "jsonb", integer) FROM PUBLIC;


-- The two doors, gated exactly as the budget's are.
CREATE FUNCTION "public"."get_poll_assignment"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}', "p_places" "jsonb" DEFAULT NULL,
    "p_per_voter" integer DEFAULT NULL)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_assignment(p_poll_id, p_excluded, p_places, p_per_voter);
end;
$$;

ALTER FUNCTION "public"."get_poll_assignment"("uuid", "uuid"[], "jsonb", integer) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."get_poll_assignment"("uuid", "uuid"[], "jsonb", integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_assignment"("uuid", "uuid"[], "jsonb", integer) TO "authenticated";


CREATE FUNCTION "public"."open_poll_assignment"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}', "p_places" "jsonb" DEFAULT NULL,
    "p_per_voter" integer DEFAULT NULL)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_assignment(p_poll_id, p_excluded, p_places, p_per_voter);
end;
$$;

ALTER FUNCTION "public"."open_poll_assignment"("uuid", "uuid"[], "jsonb", integer) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."open_poll_assignment"("uuid", "uuid"[], "jsonb", integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_assignment"("uuid", "uuid"[], "jsonb", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_assignment"("uuid", "uuid"[], "jsonb", integer) TO "authenticated";

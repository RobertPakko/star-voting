-- Consensus winners / times: several options chosen together so that the
-- voter they serve worst is served as well as possible. Each voter is
-- served by the option in the set they gave the most stars; the set whose
-- worst-served voter has the most stars wins, and sets level on that are
-- compared on the next worst-served voter, and so on (leximin, as the
-- consensus compares options). This is the egalitarian Chamberlin-Courant
-- rule; with one winner it is the consensus option.
--
--   consensus_winners  on a written list
--   consensus_times    on a calendar ballot
--
-- The question's number (polls.kind_value) is how many to choose, from 2 to
-- poll_results_rows(), and must be given: unlike multiple winners, the best
-- three need not include the best two, so there is no "as many as there
-- are" to count once and cut.
--
-- `consensus_times` is the third kind with a calendar ballot, so every rule
-- that asked about the two calendars by name now asks is_calendar_kind():
-- the schedule constraint, create_poll, create_poll_group, and the two
-- creator doors that refuse a typed name. Their definitions are copied from
-- the latest migration that wrote them, changed only there.

ALTER TABLE "public"."polls"
  DROP CONSTRAINT "polls_kind_ck",
  DROP CONSTRAINT "polls_schedule_ck",
  DROP CONSTRAINT "polls_kind_value_ck";

ALTER TABLE "public"."polls"
  ADD CONSTRAINT "polls_kind_ck"
    CHECK (("kind" = ANY (ARRAY['option'::"text", 'time'::"text", 'ranking'::"text", 'multiple'::"text", 'fractional'::"text", 'consensus'::"text", 'consensus_time'::"text", 'budget'::"text", 'assignment'::"text", 'consensus_winners'::"text", 'consensus_times'::"text"]))),
  ADD CONSTRAINT "polls_schedule_ck"
    CHECK (((("kind" <> ALL (ARRAY['time'::"text", 'consensus_time'::"text", 'consensus_times'::"text"])) AND ("schedule" IS NULL)) OR (("kind" = ANY (ARRAY['time'::"text", 'consensus_time'::"text", 'consensus_times'::"text"])) AND ("schedule" IS NOT NULL)))),
  ADD CONSTRAINT "polls_kind_value_ck"
    CHECK ((("kind_value" IS NULL) OR (("kind_value" = "trunc"("kind_value")) AND ((("kind" = ANY (ARRAY['ranking'::"text", 'multiple'::"text", 'consensus_winners'::"text", 'consensus_times'::"text"])) AND ("kind_value" >= (2)::numeric)) OR (("kind" = ANY (ARRAY['budget'::"text", 'assignment'::"text"])) AND ("kind_value" >= (1)::numeric))))));

COMMENT ON COLUMN "public"."polls"."kind" IS 'What the question asks for, and so which result it opens on: ''option'' (the best option), ''time'' (the best time, on a calendar ballot whose options are the starts of meeting windows), ''ranking'' (the option ranking), ''multiple'' (multiple winners), ''fractional'' (fractional winners), ''consensus'' (the consensus option), ''consensus_time'' (the consensus time, on a calendar ballot), ''budget'' (a proportional budget, its options costed), ''assignment'' (an option assignment, which shows who voted), ''consensus_winners'' (consensus winners) or ''consensus_times'' (consensus times, on a calendar ballot). Every kind but the three times is a written list. The other results are still offered. A setting, frozen at creation like mode.';

COMMENT ON COLUMN "public"."polls"."kind_value" IS 'A number whose meaning belongs to the kind: the places to rank, the winners to choose (multiple winners, or consensus winners, which must have one), the budget, or the most options an option assignment gives one voter. Null where the kind takes none, or to show as many as the results hold (poll_results_rows()), or on an assignment for one option each; never null on a budget or consensus winners. Readers may look at the result with another number; this is where it opens.';


-- Whether a kind's ballot is a calendar, whose options are the starts of
-- meeting windows and which carries a schedule. isCalendar in
-- src/lib/choices.ts holds the same list.
CREATE OR REPLACE FUNCTION "public"."is_calendar_kind"("p_kind" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select p_kind in ('time', 'consensus_time', 'consensus_times')
$$;

ALTER FUNCTION "public"."is_calendar_kind"("text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."is_calendar_kind"("text") FROM PUBLIC;


-- How many consensus winners, stored or sent.
CREATE OR REPLACE FUNCTION "public"."validate_winner_count"("p_value" numeric, "p_which" "text" DEFAULT ''::"text") RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
begin
  if p_value <> trunc(p_value) or p_value < 2 or p_value > poll_results_rows() then
    raise exception '%', format('Choose from 2 to %s winners%s', poll_results_rows(), p_which);
  end if;
end;
$$;

ALTER FUNCTION "public"."validate_winner_count"(numeric, "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."validate_winner_count"(numeric, "text") FROM PUBLIC;


-- The kinds a question may be, and consensus winners' number.
CREATE OR REPLACE FUNCTION "public"."validate_kind"("p_kind" "text", "p_value" numeric, "p_question" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_which text := case when p_question is null then '' else format(' on question %s', p_question) end;
begin
  if p_kind is null or p_kind not in ('option', 'time', 'ranking', 'multiple', 'fractional', 'consensus', 'consensus_time', 'budget', 'assignment', 'consensus_winners', 'consensus_times') then
    raise exception 'Unknown poll kind%', v_which;
  end if;

  if p_kind = 'budget' then
    if p_value is null then
      raise exception 'Give the budget%', v_which;
    end if;
    perform validate_amount(p_value, 'The budget' || v_which);
    return;
  end if;

  if p_kind in ('consensus_winners', 'consensus_times') then
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
    raise exception 'Only an option ranking, multiple winners, consensus winners, a proportional budget or an option assignment takes a number%', v_which;
  end if;

  if p_value <> trunc(p_value) or p_value < 2 or p_value > poll_results_rows() then
    raise exception '%', format('Choose a number from 2 to %s%s', poll_results_rows(), v_which);
  end if;
end;
$$;


-- The search under poll_consensus_winners: the k options, of those in
-- _consensus_masks (o 1..m, each with its five masks and its tie-break
-- number `second`), that leave the voters best off, compared as
-- poll_consensus_winners describes. Answers their o's, smallest first.
--
-- Each voter's standing is the highest score the set gives them, and a set
-- is worth sum over voters of u(standing), u(s) = B^4 + B^3 + ... over the s
-- levels reached, B = voters + 1: one voter lifted a level outweighs every
-- voter lifted at every level above it, so comparing the sums compares the
-- sets leximin. Mask m_t of an option has a bit set for each voter who gave
-- it t stars or more, so what an option adds is, level by level, a bit count.
--
-- Choosing the sets is NP-hard in general, so this is branch and bound over
-- combinations: at each node the options still open are sorted by what they
-- would add, and a child is cut off where even its best case cannot beat
-- the set already held. Each voter's gain only shrinks as the set grows
-- (the worth is submodular), which is what makes each bound safe. Work is
-- counted in options looked at, and past p_budget the search refuses rather
-- than answer with a set it has not shown to be best.
CREATE OR REPLACE FUNCTION "public"."consensus_set_search"(
  "p_voters" integer, "p_second" bigint[], "p_k" integer, "p_budget" bigint DEFAULT 450000
) RETURNS integer[]
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  n int := p_voters;
  m int := cardinality(p_second);
  k int := least(p_k, cardinality(p_second));
  w bigint[] := array_fill(0::bigint, array[5]);
  open_ bit varying[];
  cov bigint[];
  sec bigint[];
  pool int[];
  gain bigint[];
  cnt int[];
  rch int[];
  topc int[];
  plen int[];
  pos int[];
  topsec bigint[];
  chosen int[];
  inc int[] := '{}';
  inc_cov bigint := -1;
  inc_sec bigint := -1;
  work bigint := 0;
  d int;
  r int;
  p int;
  i int;
  j int;
  t int;
  g bigint;
  bound bigint;
  levels bigint;
  need bigint;
  top bigint[];
  row_ record;
  expanding boolean := true;
  base int;
  o1 bit varying;
  o2 bit varying;
  o3 bit varying;
  o4 bit varying;
  o5 bit varying;
  q int;
  tc1 int[];
  tc2 int[];
  tc3 int[];
  tc4 int[];
  tc5 int[];
begin
  if k <= 0 then
    return '{}';
  end if;
  if k = m then
    return array(select generate_series(1, m));
  end if;

  for t in 1 .. 5 loop
    w[t] := (n + 1)::bigint ^ (5 - t);
  end loop;

  open_ := array_fill(repeat('1', n)::bit varying, array[k * 5]);
  cov := array_fill(0::bigint, array[k]);
  sec := array_fill(0::bigint, array[k]);
  pool := array_fill(0, array[k * m]);
  gain := array_fill(0::bigint, array[k * m]);
  cnt := array_fill(0, array[k * m * 5]);
  rch := array_fill(0, array[k * m * 5]);
  topc := array_fill(0, array[k * 5]);
  plen := array_fill(0, array[k]);
  pos := array_fill(0, array[k]);
  topsec := array_fill(0::bigint, array[k]);
  chosen := array_fill(0, array[k]);

  for i in 1 .. m loop
    pool[i] := i;
  end loop;
  plen[1] := m;
  d := 0;

  <<search>>
  loop
    if expanding then
      expanding := false;
      r := k - d;
      base := d * m;
      work := work + plen[d + 1] + 20;
      if work > p_budget then
        raise exception 'This poll is too large to choose that many consensus winners; try fewer, or remove some options';
      end if;

      o1 := open_[d * 5 + 1];
      o2 := open_[d * 5 + 2];
      o3 := open_[d * 5 + 3];
      o4 := open_[d * 5 + 4];
      o5 := open_[d * 5 + 5];

      if r = 1 then
        -- The last choice: every option open here finishes a set.
        select x.o,
               w[1] * bit_count(k.m1 & o1) + w[2] * bit_count(k.m2 & o2) + w[3] * bit_count(k.m3 & o3)
             + w[4] * bit_count(k.m4 & o4) + w[5] * bit_count(k.m5 & o5) as add
        into row_
        from unnest(pool[base + 1 : base + plen[d + 1]]) as x(o)
        join _consensus_masks k on k.o = x.o
        order by 2 desc, k.second desc, x.o
        limit 1;

        g := cov[d + 1] + row_.add;
        if g > inc_cov or (g = inc_cov and sec[d + 1] + p_second[row_.o] > inc_sec) then
          inc_cov := g;
          inc_sec := sec[d + 1] + p_second[row_.o];
          inc := chosen[1:d] || row_.o;
        end if;

        if d = 0 then exit search; end if;
        d := d - 1;
        continue search;
      end if;

      -- What each option open here would add, most first, so the first set
      -- reached is the greedy one and the weighted bound below only falls
      -- along the list. Beside it, level by level, how many voters it would
      -- lift to that many stars, and how many everything from it down the
      -- list could lift together.
      i := 0;
      top := array_fill(0::bigint, array[r]);
      tc1 := '{}'; tc2 := '{}'; tc3 := '{}'; tc4 := '{}'; tc5 := '{}';
      for row_ in
        select x.o, x.c1, x.c2, x.c3, x.c4, x.c5, x.add, x.second,
               bit_count(bit_or(x.m1) over rest & o1)::int as r1,
               bit_count(bit_or(x.m2) over rest & o2)::int as r2,
               bit_count(bit_or(x.m3) over rest & o3)::int as r3,
               bit_count(bit_or(x.m4) over rest & o4)::int as r4,
               bit_count(bit_or(x.m5) over rest & o5)::int as r5
        from (
          select c.*, w[1] * c.c1 + w[2] * c.c2 + w[3] * c.c3 + w[4] * c.c4 + w[5] * c.c5 as add
          from (
            select y.o, k.second, k.m1, k.m2, k.m3, k.m4, k.m5,
                   bit_count(k.m1 & o1)::int as c1,
                   bit_count(k.m2 & o2)::int as c2,
                   bit_count(k.m3 & o3)::int as c3,
                   bit_count(k.m4 & o4)::int as c4,
                   bit_count(k.m5 & o5)::int as c5
            from unnest(pool[base + 1 : base + plen[d + 1]]) as y(o)
            join _consensus_masks k on k.o = y.o
          ) c
        ) x
        window rest as (order by x.add, x.second, x.o desc rows between unbounded preceding and current row)
        order by x.add desc, x.second desc, x.o
      loop
        i := i + 1;
        pool[base + i] := row_.o;
        gain[base + i] := row_.add;
        q := (base + i - 1) * 5;
        cnt[q + 1] := row_.c1;
        cnt[q + 2] := row_.c2;
        cnt[q + 3] := row_.c3;
        cnt[q + 4] := row_.c4;
        cnt[q + 5] := row_.c5;
        rch[q + 1] := row_.r1;
        rch[q + 2] := row_.r2;
        rch[q + 3] := row_.r3;
        rch[q + 4] := row_.r4;
        rch[q + 5] := row_.r5;
        tc1 := tc1 || row_.c1;
        tc2 := tc2 || row_.c2;
        tc3 := tc3 || row_.c3;
        tc4 := tc4 || row_.c4;
        tc5 := tc5 || row_.c5;
        g := row_.second;
        if g > top[r] then
          t := r;
          while t > 1 and top[t - 1] < g loop
            top[t] := top[t - 1];
            t := t - 1;
          end loop;
          top[t] := g;
        end if;
      end loop;
      topsec[d + 1] := 0;
      foreach g in array top loop
        topsec[d + 1] := topsec[d + 1] + g;
      end loop;

      -- The most voters any r - 1 of the options here could lift to each
      -- level, as though none of them overlapped.
      topc[d * 5 + 1] := (select coalesce(sum(c), 0) from (select c from unnest(tc1) c order by c desc limit r - 1) s);
      topc[d * 5 + 2] := (select coalesce(sum(c), 0) from (select c from unnest(tc2) c order by c desc limit r - 1) s);
      topc[d * 5 + 3] := (select coalesce(sum(c), 0) from (select c from unnest(tc3) c order by c desc limit r - 1) s);
      topc[d * 5 + 4] := (select coalesce(sum(c), 0) from (select c from unnest(tc4) c order by c desc limit r - 1) s);
      topc[d * 5 + 5] := (select coalesce(sum(c), 0) from (select c from unnest(tc5) c order by c desc limit r - 1) s);
      pos[d + 1] := 0;
    end if;

    r := k - d;
    base := d * m;
    pos[d + 1] := pos[d + 1] + 1;
    p := pos[d + 1];

    -- Every voter's gain only shrinks as the set grows, so a set through
    -- this child adds at most the r largest gains from here down the list.
    -- That falls along the list, so the first child it cuts off cuts off
    -- the rest.
    if p + r - 1 > plen[d + 1] then
      bound := -1;
    else
      bound := cov[d + 1];
      for i in p .. p + r - 1 loop
        bound := bound + gain[base + i];
      end loop;
    end if;
    if bound < inc_cov or (bound = inc_cov and sec[d + 1] + topsec[d + 1] <= inc_sec) then
      if d = 0 then exit search; end if;
      d := d - 1;
      continue search;
    end if;

    -- Level by level, no set through this child lifts more voters than this
    -- option and the best r - 1 others would apart, nor more than all of
    -- them from here down could together.
    levels := cov[d + 1];
    for t in 1 .. 5 loop
      levels := levels + w[t] * least(rch[(base + p - 1) * 5 + t],
                                     cnt[(base + p - 1) * 5 + t] + topc[d * 5 + t]);
    end loop;
    if levels < inc_cov or (levels = inc_cov and sec[d + 1] + topsec[d + 1] <= inc_sec) then
      continue search;
    end if;

    j := pool[base + p];
    cov[d + 2] := cov[d + 1] + gain[base + p];
    sec[d + 2] := sec[d + 1] + p_second[j];
    plen[d + 2] := plen[d + 1] - p;

    if d + 2 = k then
      -- One choice left: an option can only finish a set as good as the
      -- one held if it adds at least the difference, and it adds no more
      -- below than it does here, where the list is sorted. So only the head
      -- of the list is worth asking about.
      need := inc_cov - cov[d + 2];
      i := 0;
      while i < plen[d + 2] and gain[base + p + i + 1] >= need loop
        i := i + 1;
      end loop;
      plen[d + 2] := i;
      if i = 0 then
        continue search;
      end if;
    end if;

    chosen[d + 1] := j;
    select open_[d * 5 + 1] & ~k.m1, open_[d * 5 + 2] & ~k.m2, open_[d * 5 + 3] & ~k.m3,
           open_[d * 5 + 4] & ~k.m4, open_[d * 5 + 5] & ~k.m5
    into o1, o2, o3, o4, o5
    from _consensus_masks k where k.o = j;
    open_[(d + 1) * 5 + 1] := o1;
    open_[(d + 1) * 5 + 2] := o2;
    open_[(d + 1) * 5 + 3] := o3;
    open_[(d + 1) * 5 + 4] := o4;
    open_[(d + 1) * 5 + 5] := o5;
    for i in 1 .. plen[d + 2] loop
      pool[base + m + i] := pool[base + p + i];
    end loop;
    d := d + 1;
    expanding := true;
  end loop;

  return array(select x from unnest(inc) x order by x);
end;
$$;


ALTER FUNCTION "public"."consensus_set_search"(integer, bigint[], integer, bigint) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."consensus_set_search"(integer, bigint[], integer, bigint) FROM PUBLIC;


-- Consensus winners. Answers
--
--   { winners, winner_count, floor, served, single_floor, option_count,
--     voter_count }
--
-- `winners` is the set chosen, each option with its total stars and
-- `best_for`: how many voters it serves, that is, gave it the most stars of
-- any option in the set (a voter serving several options counts for each;
-- one who gave every option in the set 0 for none), most first. `floor` is
-- the stars the worst-served voter gives their option. `served` counts the
-- voters by the stars their option has, [at 0, at 1, ..., at 5], which is
-- the whole of what the comparison reads. `single_floor` is the consensus
-- option's own floor -- the best any one option could do -- for comparison.
--
-- The set chosen is the one that, in order:
--
--   1. leaves the fewest voters on 0 stars; then the fewest on 1 or fewer;
--      and so on to 4 (leximin on what each voter is served);
--   2. has the most stars in total;
--   3. is chosen at random, the same way every time: each option carries a
--      number hashed from the poll and the option, and the set with the
--      largest sum wins.
--
-- p_winners is how many to choose: the question's own number where null
-- (consensus winners has one), else 2. Asking for as many as there are
-- options, or more, chooses them all. `p_excluded` leaves options off the
-- ballot, as for multiple winners. Nothing is stored.
--
-- A ballot giving every option 0 leaves its voter on 0 whatever is chosen,
-- so it pulls the floor to 0 but changes nothing else: every set leaves it
-- where it is.
CREATE OR REPLACE FUNCTION "public"."poll_consensus_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[], "p_winners" integer)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_kind text;
  v_kind_value numeric;
  v_k int;
  v_voters int;
  v_options int;
  v_second bigint[];
  v_pick int[];
  v_chosen uuid[];
  v_served int[];
  v_floor int;
  v_single int;
  v_winners jsonb;
begin
  -- A poll has at most a few hundred options; anything longer is not a list
  -- a reader built by pressing buttons.
  if coalesce(array_length(p_excluded, 1), 0) > 1000 then
    raise exception 'Too many options left out';
  end if;

  select kind, kind_value into v_kind, v_kind_value from polls where id = p_poll_id;

  v_k := coalesce(
    p_winners,
    case when v_kind in ('consensus_winners', 'consensus_times') then v_kind_value::int end,
    2);
  perform validate_winner_count(v_k);

  select count(*) into v_voters from ballots where poll_id = p_poll_id;
  if v_voters = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  -- The search's weights are powers of the number of voters, and must fit a
  -- bigint summed over every voter.
  if v_voters > 5000 then
    raise exception 'This poll has too many ballots to choose its consensus winners';
  end if;

  -- Every option counted, numbered in the order the search starts from (most
  -- stars first), with one mask per star level over the ballots in a fixed
  -- order. A missing score reads as 0, as the tally reads it.
  drop table if exists _consensus_masks;
  create temp table _consensus_masks on commit drop as
  select
    (row_number() over (order by t.total desc, t.name, t.id))::int as o,
    t.id,
    t.name,
    t.total,
    (t.total::bigint << 32) + ('x' || substr(md5(p_poll_id::text || t.id::text), 1, 7))::bit(28)::bigint as second,
    t.m1, t.m2, t.m3, t.m4, t.m5
  from (
    select
      c.id,
      c.name,
      coalesce(sum(s.score), 0)::int as total,
      string_agg(case when coalesce(s.score, 0) >= 1 then '1' else '0' end, '' order by b.id)::bit varying as m1,
      string_agg(case when coalesce(s.score, 0) >= 2 then '1' else '0' end, '' order by b.id)::bit varying as m2,
      string_agg(case when coalesce(s.score, 0) >= 3 then '1' else '0' end, '' order by b.id)::bit varying as m3,
      string_agg(case when coalesce(s.score, 0) >= 4 then '1' else '0' end, '' order by b.id)::bit varying as m4,
      string_agg(case when coalesce(s.score, 0) >= 5 then '1' else '0' end, '' order by b.id)::bit varying as m5
    from candidates c
    join ballots b on b.poll_id = p_poll_id
    left join scores s on s.ballot_id = b.id and s.candidate_id = c.id
    where c.poll_id = p_poll_id
      and not (c.id = any(coalesce(p_excluded, '{}'::uuid[])))
    group by c.id, c.name
  ) t;

  alter table _consensus_masks add primary key (o);

  select count(*)::int, array_agg(second order by o) into v_options, v_second from _consensus_masks;

  if v_options = 0 then
    raise exception 'Every option has been left out';
  end if;

  v_pick := consensus_set_search(v_voters, v_second, v_k);

  select array_agg(id) into v_chosen from _consensus_masks where o = any(v_pick);

  -- What each voter is served: the most stars they gave any option chosen.
  drop table if exists _consensus_served;
  create temp table _consensus_served on commit drop as
  select b.id as bid, coalesce(max(s.score), 0)::int as served
  from ballots b
  left join scores s on s.ballot_id = b.id and s.candidate_id = any(v_chosen)
  where b.poll_id = p_poll_id
  group by b.id;

  select min(served) into v_floor from _consensus_served;

  select array_agg((select count(*)::int from _consensus_served where served = level) order by level)
  into v_served
  from generate_series(0, 5) level;

  -- The consensus option's floor: the best one option alone could do.
  select max(f) into v_single
  from (
    select min(coalesce(s.score, 0)) as f
    from _consensus_masks c
    join ballots b on b.poll_id = p_poll_id
    left join scores s on s.ballot_id = b.id and s.candidate_id = c.id
    group by c.id
  ) floors;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', w.id,
    'name', w.name,
    'total_score', w.total,
    'best_for', w.best_for
  ) order by w.best_for desc, w.total desc, w.name, w.id), '[]'::jsonb)
  into v_winners
  from (
    select c.id, c.name, c.total,
           (select count(*)::int
              from _consensus_served v
              join scores s on s.ballot_id = v.bid and s.candidate_id = c.id
             where v.served > 0 and s.score = v.served) as best_for
    from _consensus_masks c
    where c.id = any(v_chosen)
  ) w;

  return jsonb_build_object(
    'winners', v_winners,
    'winner_count', cardinality(v_chosen),
    'floor', v_floor,
    'served', to_jsonb(v_served),
    'single_floor', v_single,
    'option_count', v_options,
    'voter_count', v_voters
  );
end;
$$;

ALTER FUNCTION "public"."poll_consensus_winners"("uuid", "uuid"[], integer) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_consensus_winners"("uuid", "uuid"[], integer) FROM PUBLIC;


-- The two doors, gated exactly as the consensus is: what each voter is
-- served discloses more than the tally does.
CREATE OR REPLACE FUNCTION "public"."get_poll_consensus_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}', "p_winners" integer DEFAULT NULL)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_consensus_winners(p_poll_id, p_excluded, p_winners);
end;
$$;

ALTER FUNCTION "public"."get_poll_consensus_winners"("uuid", "uuid"[], integer) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."get_poll_consensus_winners"("uuid", "uuid"[], integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_consensus_winners"("uuid", "uuid"[], integer) TO "authenticated";


CREATE OR REPLACE FUNCTION "public"."open_poll_consensus_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}', "p_winners" integer DEFAULT NULL)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_consensus_winners(p_poll_id, p_excluded, p_winners);
end;
$$;

ALTER FUNCTION "public"."open_poll_consensus_winners"("uuid", "uuid"[], integer) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."open_poll_consensus_winners"("uuid", "uuid"[], integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_consensus_winners"("uuid", "uuid"[], integer) TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_consensus_winners"("uuid", "uuid"[], integer) TO "authenticated";


-- The calendar ballot is asked of every time kind, at both ways in.
CREATE OR REPLACE FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_option_descriptions" "text"[] DEFAULT NULL::"text"[], "p_solicit_options" boolean DEFAULT false, "p_kind" "text" DEFAULT 'option'::"text", "p_schedule" "jsonb" DEFAULT NULL::"jsonb", "p_kind_value" numeric DEFAULT NULL::numeric, "p_carried" "jsonb" DEFAULT NULL::"jsonb", "p_option_costs" numeric[] DEFAULT NULL::numeric[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_opts jsonb;
  v_mails text[];
  v_kind text := coalesce(p_kind, 'option');
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_mode is null or p_mode not in ('invite', 'open') then
    raise exception 'Unknown poll mode';
  end if;

  perform validate_kind(v_kind, p_kind_value);

  if coalesce(trim(p_title), '') = '' then
    raise exception 'Title is required';
  end if;

  if is_calendar_kind(v_kind) then
    -- A time poll collecting its times starts with whatever its creator
    -- painted, which may be nothing at all: insert_poll_row applies the
    -- two-option floor only to a poll that is not collecting, and
    -- finalize_options applies it again when the list becomes a ballot.
    perform validate_schedule(p_schedule);
  elsif p_schedule is not null then
    raise exception 'Only a time poll has a schedule';
  end if;

  if p_mode = 'invite' then
    v_mails := normalize_invite_emails(p_emails);
  end if;

  -- Paired by position, so a description can only ever belong to the option
  -- it was written for; insert_poll_row drops the blanks from the pairs.
  select coalesce(jsonb_agg(
           jsonb_build_object('name', o, 'description', p_option_descriptions[ord],
                              case when v_kind = 'assignment' then 'places' else 'cost' end,
                              p_option_costs[ord])
           order by ord), '[]'::jsonb)
  into v_opts
  from unnest(coalesce(p_options, array[]::text[])) with ordinality as t(o, ord);

  v_id := insert_poll_row(
    trim(p_title),
    nullif(trim(coalesce(p_description, '')), ''),
    null,
    v_opts,
    v_mails,
    p_mode,
    coalesce(p_show_voters, true),
    coalesce(p_show_ballots, false),
    coalesce(p_solicit_options, false),
    null,
    null,
    v_kind,
    case when is_calendar_kind(v_kind) then p_schedule else null end,
    p_kind_value
  );

  perform insert_carried_weights(v_id, p_carried);

  return v_id;
end;
$$;



CREATE OR REPLACE FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_solicit_options" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_group_id uuid := gen_random_uuid();
  v_mails text[];
  v_first uuid;
  v_id uuid;
  v_question jsonb;
  v_question_title text;
  v_kind text;
  v_kind_value numeric;
  v_schedule jsonb;
  v_count int;
  i int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_mode is null or p_mode not in ('invite', 'open') then
    raise exception 'Unknown poll mode';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'Title is required';
  end if;

  if p_questions is null or jsonb_typeof(p_questions) <> 'array' then
    raise exception 'A poll needs a list of questions';
  end if;

  v_count := jsonb_array_length(p_questions);

  -- One question is a poll, not a group of one: creating it as a group would
  -- give it a question title nothing shows and a next link pointing nowhere.
  if v_count < 2 then
    raise exception 'A multi-question poll needs at least two questions';
  end if;

  if v_count > 20 then
    raise exception 'A poll can ask 20 questions; this one asks %', v_count;
  end if;

  if p_mode = 'invite' then
    v_mails := normalize_invite_emails(p_emails);
  end if;

  for i in 0 .. v_count - 1 loop
    v_question := p_questions -> i;
    v_question_title := nullif(trim(coalesce(v_question ->> 'title', '')), '');

    -- Every question is titled, because the title is the only thing telling
    -- the two apart on screen: the poll's own title is shared across them.
    if v_question_title is null then
      raise exception 'Question % needs a title', i + 1;
    end if;

    -- Bounded like the poll's own title, and named by number rather than
    -- raised from insert_poll_row, because here there is a question to name.
    if length(v_question_title) > 100 then
      raise exception 'The title of question % is too long', i + 1;
    end if;

    -- What this question asks for, question by question: a group may ask
    -- "which film?" (the best option), "when?" (the best time) and "which
    -- three snacks?" (multiple winners). The checks are `create_poll`'s,
    -- said again here because this is the other way into `insert_poll_row`
    -- and the two must not disagree about what a kind or a schedule is.
    v_kind := coalesce(nullif(trim(coalesce(v_question ->> 'kind', '')), ''), 'option');
    if jsonb_typeof(v_question -> 'kind_value') not in ('number', 'null') then
      raise exception 'The number on question % is not a number', i + 1;
    end if;
    v_kind_value := (v_question ->> 'kind_value')::numeric;
    perform validate_kind(v_kind, v_kind_value, i + 1);

    v_schedule := nullif(v_question -> 'schedule', 'null'::jsonb);
    if is_calendar_kind(v_kind) then
      perform validate_schedule(v_schedule);
    elsif v_schedule is not null then
      raise exception 'Only a time question has a schedule; question % is not one', i + 1;
    end if;

    v_id := insert_poll_row(
      trim(p_title),
      nullif(trim(coalesce(p_description, '')), ''),
      v_question_title,
      v_question -> 'options',
      v_mails,
      p_mode,
      coalesce(p_show_voters, true),
      coalesce(p_show_ballots, false),
      coalesce(p_solicit_options, false),
      v_group_id,
      i + 1,
      v_kind,
      case when is_calendar_kind(v_kind) then v_schedule else null end,
      v_kind_value
    );

    -- Each question is its own sequence: one voter can have given the
    -- winning films a lot of stars and the winning times none.
    perform insert_carried_weights(v_id, v_question -> 'carried', i + 1);

    if i = 0 then
      v_first := v_id;
    end if;
  end loop;

  return v_first;
end;
$$;



-- A typed name is refused on every calendar.
CREATE OR REPLACE FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted boolean;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  -- The same 'not found' a poll that exists but isn't yours gets everywhere
  -- else: whether a given id is a real poll is not something an outsider
  -- needs to learn.
  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  -- An invite poll everybody has answered shows its results without anybody
  -- closing it, so the close alone is not where the window ends. Past the
  -- reveal no ballot can be revised to answer a changed list, and the winner
  -- settled from the list as it was is never elected again.
  if poll_results_revealed(v_poll) then
    raise exception 'The results are out, so the options can no longer be changed';
  end if;

  if is_calendar_kind(v_poll.kind) then
    raise exception 'A time poll''s options are its windows; change its schedule instead';
  end if;

  select exists (select 1 from ballots where poll_id = p_poll_id) into v_voted;

  -- The creator's own door, so it opens on a poll with votes in it exactly as
  -- creator_edit_options does, says so to the guard, and leaves the same mark.
  perform set_config('app.editing_options', p_poll_id::text, true);
  perform insert_option(v_poll, p_name, p_description);
  perform set_config('app.editing_options', '', true);

  if v_voted then
    update polls set options_edited_after_votes = true
    where id = p_poll_id and not options_edited_after_votes;
  end if;
end;
$$;



CREATE OR REPLACE FUNCTION "public"."creator_edit_options"("p_poll_id" "uuid", "p_options" "jsonb" DEFAULT '[]'::"jsonb", "p_remove" "uuid"[] DEFAULT '{}'::"uuid"[], "p_correct" "jsonb" DEFAULT '[]'::"jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_added int := 0;
  v_removed int := 0;
  v_corrected int := 0;
  v_voted boolean;
  v_left int;
  v_item jsonb;
  v_name text;
  v_description text;
  v_clash text;
  i int;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  -- The same 'not found' a poll that exists but isn't yours gets everywhere
  -- else: whether a given id is a real poll is not something an outsider
  -- needs to learn.
  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  -- An invite poll everybody has answered shows its results without anybody
  -- closing it, so the close alone is not where the window ends. Past the
  -- reveal no ballot can be revised to answer a changed list, and the winner
  -- settled from the list as it was is never elected again.
  if poll_results_revealed(v_poll) then
    raise exception 'The results are out, so the options can no longer be changed';
  end if;

  p_correct := coalesce(p_correct, '[]'::jsonb);
  if jsonb_typeof(p_correct) <> 'array' then
    raise exception 'Give the corrections as a list';
  end if;

  -- A typed correction is a typed name, and a time poll's names are windows
  -- the calendar draws and the window rule scores: the same refusal
  -- creator_add_option gives the typed-name path.
  if jsonb_array_length(p_correct) > 0 and is_calendar_kind(v_poll.kind) then
    raise exception 'A time poll''s options are its windows; change its schedule instead';
  end if;

  -- The field rules insert_option applies to a new option, applied to a
  -- corrected one, before anything is written.
  for i in 0 .. jsonb_array_length(p_correct) - 1 loop
    v_item := p_correct -> i;
    v_name := nullif(trim(coalesce(v_item ->> 'name', '')), '');
    v_description := nullif(trim(coalesce(v_item ->> 'description', '')), '');

    if (v_item ->> 'id') is null then
      raise exception 'Say which option is being corrected';
    end if;
    if v_name is null then
      raise exception 'Give the option a name';
    end if;
    if length(v_name) > 150 then
      raise exception 'That option name is too long';
    end if;
    if length(v_description) > 900 then
      raise exception 'That description is too long';
    end if;
    perform option_cost(v_poll.kind, option_number(v_poll.kind, v_item), v_name);
  end loop;

  -- One row, one correction: an UPDATE joined to two rows for the same id
  -- applies whichever it meets first, which is not an answer.
  if (select count(*) <> count(distinct (x ->> 'id')::uuid)
        from jsonb_array_elements(p_correct) x) then
    raise exception 'An option can only be corrected once in an edit';
  end if;

  -- Whether this edit is a late one, asked before it is made. What it changes
  -- is not whether the edit is allowed -- it is, and the creator was shown
  -- what it costs before they pressed anything -- but what the poll says about
  -- itself afterwards.
  select exists (select 1 from ballots where poll_id = p_poll_id) into v_voted;

  -- Transaction-local, and held across every part of the edit: it names this
  -- poll as the one whose list its own creator is correcting, which is what
  -- lifts the per-row guard and the per-row floor off it for exactly as long
  -- as the list is part-way between two states. See guard_options_frozen.
  perform set_config('app.editing_options', p_poll_id::text, true);

  -- Removals first, so an edit that swaps one option for another cannot trip
  -- over the 500-option ceiling on its way through the middle. Scoped to this
  -- poll, so an id from somewhere else is a no-op rather than a delete: the
  -- caller has been shown to own this poll and nothing more.
  delete from candidates
  where poll_id = p_poll_id and id = any (coalesce(p_remove, '{}'::uuid[]));

  get diagnostics v_removed = row_count;

  -- Corrections in place, so the option keeps its id and every score given
  -- to it. Scoped to this poll like the delete, and counting only the rows
  -- that actually moved: the card sends what it holds, not a diff.
  update candidates c
  set name = w.name, description = w.description, kind_value = w.cost
  from (
    select (x ->> 'id')::uuid as id,
           nullif(trim(coalesce(x ->> 'name', '')), '') as name,
           nullif(trim(coalesce(x ->> 'description', '')), '') as description,
           option_cost(v_poll.kind, option_number(v_poll.kind, x), trim(x ->> 'name')) as cost
    from jsonb_array_elements(p_correct) x
  ) w
  where c.id = w.id
    and c.poll_id = p_poll_id
    and (c.name, c.description, c.kind_value) is distinct from (w.name, w.description, w.cost);

  get diagnostics v_corrected = row_count;

  -- The duplicate rule insert_option applies, over the list as the
  -- corrections left it rather than one row at a time.
  if v_corrected > 0 then
    select min(name) into v_clash
    from candidates
    where poll_id = p_poll_id
    group by lower(name)
    having count(*) > 1
    limit 1;

    if v_clash is not null then
      raise exception '"%" is already on the list', v_clash;
    end if;
  end if;

  if p_options is not null and jsonb_array_length(p_options) > 0 then
    v_added := insert_options(v_poll, p_options);
  end if;

  perform set_config('app.editing_options', '', true);

  -- The floor the trigger would have applied a row at a time, applied once to
  -- the list the creator actually asked for. A list still being collected has
  -- none, exactly as it has none there: its checkpoint is finalize_options.
  if not (v_poll.solicit_options and v_poll.options_finalized_at is null) then
    select count(*)::int into v_left from candidates where poll_id = p_poll_id;

    if v_left < 2 then
      raise exception 'A poll needs at least two options';
    end if;
  end if;

  -- The mark is for an edit that actually moved something.
  if v_voted and (v_added > 0 or v_removed > 0 or v_corrected > 0) then
    update polls set options_edited_after_votes = true
    where id = p_poll_id and not options_edited_after_votes;
  end if;

  return v_added;
end;
$$;



-- The tally carries consensus winners where the question asked for them,
-- from three options (with two, the two winners are both of them).
CREATE OR REPLACE FUNCTION "public"."poll_tally"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
begin
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  select closed_at is not null, mode, options_edited_after_votes, votes_after_reveal,
         kind, kind_value, show_voters
  into v_closed, v_mode, v_edited, v_late, v_kind, v_kind_value, v_voters_shown
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
    when v_kind in ('consensus', 'consensus_time') and v_option_count >= 2 then poll_consensus(p_poll_id, '{}')
    when v_kind = 'budget' and v_option_count >= 2 then poll_proportional_budget(p_poll_id, '{}', null, null)
    else null
  end;

  -- Refused only for size (or a poll somebody made sequential by hand); the
  -- page then opens on STAR's winner, and *More results* says why.
  -- Refused only for size, as the assignment is.
  if v_kind in ('consensus_winners', 'consensus_times') and v_option_count >= 3 then
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
    'kind_value', v_kind_value,
    'kind_result', v_kind_result,
    'weighted', v_weighted,
    'voters_shown', v_voters_shown
  );
end;
$$;



-- Consensus winners name no one winner, from the three options they are
-- offered at.
CREATE OR REPLACE FUNCTION "public"."poll_names_one_winner"("p_poll_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_kind text;
  v_options int;
begin
  select kind into v_kind from polls where id = p_poll_id;
  select count(*)::int into v_options from candidates where poll_id = p_poll_id;

  return case
    when v_kind in ('ranking', 'multiple', 'consensus_winners', 'consensus_times') then v_options < 3
    when v_kind in ('fractional', 'budget', 'assignment') then v_options < 2
    else true
  end;
end;
$$;


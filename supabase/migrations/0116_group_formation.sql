-- Group formation: the voters split into a number of groups of as even a
-- size as can be, so that each group's ballots are as alike as possible
-- (`groups`) or as different as possible (`mixed_groups`). The question's
-- number (polls.kind_value) is how many groups, from 2 to
-- poll_results_rows(), and must be given. More groups than voters leaves
-- some empty.
--
-- Two voters are as far apart as the squares of the differences between the
-- stars they gave each option, summed over every option; a grouping is
-- worth the distances between every two voters in one group, summed, which
-- `groups` makes as small as it can and `mixed_groups` as large. Finding the
-- best grouping is NP-hard, so voter_groups searches: seeded starts, then
-- swapping and moving voters between groups while that improves the total,
-- from a few starts, keeping the best. Every step is fixed by the ballots, so
-- every reader is given the same groups.
--
-- A grouping names its voters, so the kind is never made on a poll that
-- hides them (insert_poll_row), and a reader may change the number of groups
-- and the direction on any poll that shows them: groups say only who voted
-- more alike than whom, never how anybody scored. Counting one group's
-- ballots on their own (*Make choice*) does say how they scored, so that is
-- for polls that publish their ballots (poll_group_count).
--
-- One group's counts are every other count run over that group's ballots
-- alone. Each count reads its ballots and their scores through
-- counted_ballots and counted_scores, which answer every ballot unless
-- poll_group_count has named the group's in `app.counted_ballots` for the
-- length of its call, as poll_sequential names weights in
-- `app.sequential_given`. The counts' definitions are copied from the latest
-- migration that wrote them, changed only in what they read.

ALTER TABLE "public"."polls" DROP CONSTRAINT "polls_kind_ck";
ALTER TABLE "public"."polls" ADD CONSTRAINT "polls_kind_ck" CHECK (("kind" = ANY (ARRAY['option'::"text", 'ranking'::"text", 'multiple'::"text", 'fractional'::"text", 'consensus'::"text", 'budget'::"text", 'ranking_budget'::"text", 'fractional_budget'::"text", 'assignment'::"text", 'consensus_winners'::"text", 'groups'::"text", 'mixed_groups'::"text"])));

ALTER TABLE "public"."polls" DROP CONSTRAINT "polls_kind_value_ck";
ALTER TABLE "public"."polls" ADD CONSTRAINT "polls_kind_value_ck" CHECK ((("kind_value" IS NULL) OR (("kind_value" = "trunc"("kind_value")) AND ((("kind" = ANY (ARRAY['ranking'::"text", 'multiple'::"text", 'consensus_winners'::"text", 'groups'::"text", 'mixed_groups'::"text"])) AND ("kind_value" >= (2)::numeric)) OR (("kind" = ANY (ARRAY['budget'::"text", 'ranking_budget'::"text", 'fractional_budget'::"text", 'assignment'::"text"])) AND ("kind_value" >= (1)::numeric))))));


-- The ballots a count reads: every one of the poll's, unless
-- poll_group_count has named a group's for the length of its call. Plain SQL
-- with no SET, so the planner inlines it into the query that reads it and it
-- costs a filter, not a call.
CREATE OR REPLACE FUNCTION "public"."counted_ballots"("p_poll_id" "uuid") RETURNS SETOF "public"."ballots"
    LANGUAGE "sql" STABLE
    AS $$
  select b.*
  from public.ballots b
  where b.poll_id = p_poll_id
    and (nullif(current_setting('app.counted_ballots', true), '') is null
         or b.id = any (nullif(current_setting('app.counted_ballots', true), '')::uuid[]))
$$;

ALTER FUNCTION "public"."counted_ballots"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."counted_ballots"("uuid") FROM PUBLIC;


-- The scores on the ballots a count reads.
CREATE OR REPLACE FUNCTION "public"."counted_scores"("p_poll_id" "uuid") RETURNS SETOF "public"."scores"
    LANGUAGE "sql" STABLE
    AS $$
  select s.*
  from public.scores s
  join public.counted_ballots(p_poll_id) b on b.id = s.ballot_id
$$;

ALTER FUNCTION "public"."counted_scores"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."counted_scores"("uuid") FROM PUBLIC;


-- Whether a count is reading one group's ballots rather than the poll's.
CREATE OR REPLACE FUNCTION "public"."counting_a_group"() RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select nullif(current_setting('app.counted_ballots', true), '') is not null
$$;

ALTER FUNCTION "public"."counting_a_group"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."counting_a_group"() FROM PUBLIC;


-- How many groups, stored or sent.
CREATE OR REPLACE FUNCTION "public"."validate_group_count"("p_value" numeric, "p_which" "text" DEFAULT ''::"text") RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
begin
  if p_value <> trunc(p_value) or p_value < 2 or p_value > poll_results_rows() then
    raise exception '%', format('Choose from 2 to %s groups%s', poll_results_rows(), p_which);
  end if;
end;
$$;

ALTER FUNCTION "public"."validate_group_count"(numeric, "text") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."validate_group_count"(numeric, "text") FROM PUBLIC;


-- The kinds a question may be, and how many groups group formation takes.
CREATE OR REPLACE FUNCTION "public"."validate_kind"("p_kind" "text", "p_value" numeric, "p_question" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_which text := case when p_question is null then '' else format(' on question %s', p_question) end;
begin
  if p_kind is null or p_kind not in ('option', 'ranking', 'multiple', 'fractional', 'consensus', 'budget', 'ranking_budget', 'fractional_budget', 'assignment', 'consensus_winners', 'groups', 'mixed_groups') then
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

  if p_kind in ('groups', 'mixed_groups') then
    if p_value is null then
      raise exception 'Say how many groups to form%', v_which;
    end if;
    perform validate_group_count(p_value, v_which);
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
    raise exception 'Only multiple winners, proportional winners, consensus winners, a budget poll, an option assignment or group formation takes a number%', v_which;
  end if;

  if p_value <> trunc(p_value) or p_value < 2 or p_value > poll_results_rows() then
    raise exception '%', format('Choose a number from 2 to %s%s', poll_results_rows(), v_which);
  end if;
end;
$$;


-- Group formation names its voters, as an assignment does.
CREATE OR REPLACE FUNCTION "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid" DEFAULT NULL::"uuid", "p_question_position" integer DEFAULT NULL::integer, "p_kind" "text" DEFAULT 'option'::"text", "p_schedule" "jsonb" DEFAULT NULL::"jsonb", "p_kind_value" numeric DEFAULT NULL::numeric) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll_id uuid;
  v_opts jsonb;
  v_item jsonb;
  i int;
begin
  -- A title is a line at the top of a card, and a description is the
  -- paragraph under it. Both callers have trimmed by the time they arrive.
  if length(p_title) > 100 then
    raise exception 'That title is too long';
  end if;

  if length(p_description) > 500 then
    raise exception 'That description is too long';
  end if;

  if p_kind = 'assignment' and not p_show_voters then
    raise exception 'An option assignment says who gets which option, so it must show who voted';
  end if;

  if p_kind in ('groups', 'mixed_groups') and not p_show_voters then
    raise exception 'Group formation says who is in which group, so it must show who voted';
  end if;

  -- Drop blanks but keep the author's ordering, carrying each option's
  -- description along with it.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'name', trim(o ->> 'name'),
             'description', nullif(trim(coalesce(o ->> 'description', '')), ''),
             'cost', option_number(p_kind, o)
           ) order by ord), '[]'::jsonb)
  into v_opts
  from jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) with ordinality as t(o, ord)
  where trim(coalesce(o ->> 'name', '')) <> '';

  -- A poll collecting its options is allowed to start with none; the same
  -- minimum is applied by finalize_options, when the list becomes a ballot.
  if not p_solicit_options and jsonb_array_length(v_opts) < 2 then
    raise exception 'Add at least two options';
  end if;

  -- The ceiling insert_option applies, applied here too. This path inserts
  -- into `candidates` directly and checked nothing, so a poll created over
  -- the cap up front was accepted while the same poll built one option at a
  -- time was refused -- and the calendar is the first thing that can produce
  -- a list long enough to find that gap.
  if jsonb_array_length(v_opts) > 500 then
    raise exception 'A poll can hold 500 options; this one has %', jsonb_array_length(v_opts);
  end if;

  insert into polls (
    title, description, created_by, mode, show_voters, show_ballots,
    solicit_options, group_id, question_position, question_title, kind, schedule, kind_value
  )
  values (
    p_title, p_description, auth.uid(), p_mode, p_show_voters, p_show_ballots,
    p_solicit_options, p_group_id, p_question_position, p_question_title, p_kind, p_schedule,
    p_kind_value
  )
  returning id into v_poll_id;

  for i in 0 .. jsonb_array_length(v_opts) - 1 loop
    v_item := v_opts -> i;
    insert into candidates (poll_id, name, description, sort_order, kind_value)
    values (v_poll_id, v_item ->> 'name', v_item ->> 'description', i,
            option_cost(p_kind, v_item -> 'cost', v_item ->> 'name'));
  end loop;

  -- Every question carries the whole invite list, because that list is what
  -- the row-level security on this question's options and ballots reads.
  if p_mode = 'invite' then
    for i in 1 .. coalesce(array_length(p_emails, 1), 0) loop
      insert into invited_voters (poll_id, email) values (v_poll_id, p_emails[i]);
    end loop;
  end if;

  return v_poll_id;
end;
$$;


-- Groups name no one winner.
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
    -- Groups are an answer about voters, with no option in it.
    when v_kind in ('groups', 'mixed_groups') then false
    when v_kind in ('ranking', 'multiple', 'consensus_winners') then v_options < 3
    when v_kind in ('fractional', 'budget', 'ranking_budget', 'fractional_budget', 'assignment') then v_options < 2
    else true
  end;
end;
$$;


-- The search under group formation: every counted ballot of the poll and the
-- group it is put in, 1 to p_groups, numbered as the groups are shown --
-- largest first, then by the first of their voters' names. Groups are as
-- even as can be: their sizes differ by one at most, the larger ones first.
--
-- Voters are taken in an order hashed from the poll and each ballot, so the
-- search starts from no voter's place on the list. Two voters are
-- sum((a - b)^2) apart over every option, and a group's worth is the sum of
-- that over every two of its voters. p_similar makes the total as small as
-- it can, otherwise as large.
--
-- Each start lays out a grouping and then improves it until nothing
-- improves it: two voters in different groups swap if that helps, and a
-- voter moves from a group one larger to a group one smaller if that helps
-- (which keeps the sizes even). To keep groups alike, a start seeds each
-- group with a voter as far as possible from the seeds before it, beginning
-- from the start's own voter, and fills the groups nearest seed first. To
-- mix them, a start deals the voters round in its own hashed order. The best
-- start is kept, the earlier on a tie. Only a strict improvement is taken and
-- voters are visited in a fixed order, so the answer is the same on every
-- read.
--
-- Work grows with the voters squared times the options (the distances) and
-- with the voters squared on each pass of the search; past the budgets it
-- refuses rather than take longer than a request may, and fewer starts are
-- made as polls grow.
CREATE OR REPLACE FUNCTION "public"."voter_groups"("p_poll_id" "uuid", "p_groups" integer, "p_similar" boolean)
    RETURNS TABLE("ballot_id" "uuid", "grp" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_ids uuid[];
  n int;
  m int;
  k int := p_groups;
  v_filled int;
  v_d int[];
  v_size int[];
  v_g int[];
  v_cnt int[];
  v_c bigint[];
  v_seeds int[];
  v_best int[];
  v_best_w bigint;
  v_w bigint;
  v_starts int;
  v_sign int := case when p_similar then 1 else -1 end;
  v_delta bigint;
  v_far bigint;
  v_near bigint;
  v_pick int;
  v_improved boolean;
  v_passes int;
  r int; t int; i int; j int; x int; a int; b int;
  v_di int; v_dj int;
  v_pair record;
begin
  perform validate_group_count(p_groups);

  select coalesce(array_agg(cb.id order by md5(p_poll_id::text || cb.id::text), cb.id), '{}'::uuid[])
  into v_ids
  from counted_ballots(p_poll_id) cb;

  n := cardinality(v_ids);
  if n = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  -- The distances compare every voter with every voter over every option,
  -- and each pass of the search every two voters, so the work grows with the
  -- voters squared and, more slowly, with the options. Measured locally, the
  -- largest polls allowed answer in under two seconds: 500 voters on
  -- up to 150 options, or 400 on 500.
  select count(*)::int into m from candidates where poll_id = p_poll_id;
  if n > 500 or n::bigint * n * (m + 50) > 90000000 then
    raise exception 'This poll has too many ballots to form groups from';
  end if;

  -- Each voter's ballot as five masks over the options, mask t holding the
  -- options they gave t stars or more. Two voters differ by d stars on an
  -- option exactly when d of their masks differ there, so with x_t the
  -- options where mask t differs, the sum over options of d squared is
  -- sum(|x_t|) + 2 * sum over t < u of |x_t & x_u|: a few bit counts a pair
  -- rather than a sum over every option.
  drop table if exists _gvoter;
  create temp table _gvoter on commit drop as
  select v.bid, v.i::int as i from unnest(v_ids) with ordinality v(bid, i);

  drop table if exists _gscore;
  create temp table _gscore on commit drop as
  select s.ballot_id, s.candidate_id, s.score
  from scores s
  where s.ballot_id = any(v_ids);

  analyze _gvoter;
  analyze _gscore;

  drop table if exists _gmask;
  create temp table _gmask on commit drop as
  select v.i,
         string_agg(case when coalesce(s.score, 0) >= 1 then '1' else '0' end, '' order by c.id)::varbit as t1,
         string_agg(case when coalesce(s.score, 0) >= 2 then '1' else '0' end, '' order by c.id)::varbit as t2,
         string_agg(case when coalesce(s.score, 0) >= 3 then '1' else '0' end, '' order by c.id)::varbit as t3,
         string_agg(case when coalesce(s.score, 0) >= 4 then '1' else '0' end, '' order by c.id)::varbit as t4,
         string_agg(case when coalesce(s.score, 0) >= 5 then '1' else '0' end, '' order by c.id)::varbit as t5
  from _gvoter v
  cross join candidates c
  left join _gscore s on s.ballot_id = v.bid and s.candidate_id = c.id
  where c.poll_id = p_poll_id
  group by v.i;

  -- Each pair once, then both ways round.
  drop table if exists _gdist;
  create temp table _gdist on commit drop as
  select p.i, p.j,
         (bit_count(p.x1) + bit_count(p.x2) + bit_count(p.x3) + bit_count(p.x4) + bit_count(p.x5)
          + 2 * (bit_count(p.x1 & p.x2) + bit_count(p.x1 & p.x3) + bit_count(p.x1 & p.x4)
                 + bit_count(p.x1 & p.x5) + bit_count(p.x2 & p.x3) + bit_count(p.x2 & p.x4)
                 + bit_count(p.x2 & p.x5) + bit_count(p.x3 & p.x4) + bit_count(p.x3 & p.x5)
                 + bit_count(p.x4 & p.x5)))::int as d
  from (
    select a1.i, a2.i as j,
           a1.t1 # a2.t1 as x1, a1.t2 # a2.t2 as x2, a1.t3 # a2.t3 as x3,
           a1.t4 # a2.t4 as x4, a1.t5 # a2.t5 as x5
    from _gmask a1 join _gmask a2 on a2.i > a1.i
  ) p;

  select array_agg(w.d order by w.a, w.b)
  into v_d
  from (
    select gd.i as a, gd.j as b, gd.d from _gdist gd
    union all select gd.j, gd.i, gd.d from _gdist gd
    union all select g, g, 0 from generate_series(1, n) g
  ) w;

  -- As even as can be, larger first; more groups than voters leaves some empty.
  select array_agg(n / k + case when g <= n % k then 1 else 0 end order by g)
  into v_size
  from generate_series(1, k) g;
  v_filled := least(k, n);

  -- Fewer starts as the search grows, and never more than there are voters.
  v_starts := least(n, 8, greatest(1, 400000 / (n * n)));

  for r in 1 .. v_starts loop
    v_g := array_fill(0, array[n]);
    v_cnt := array_fill(0, array[k]);

    if p_similar then
      -- Seeds as far apart as can be, beginning from this start's voter.
      v_seeds := array[r];
      for t in 2 .. v_filled loop
        v_pick := null;
        v_far := -1;
        for i in 1 .. n loop
          continue when i = any(v_seeds);
          v_near := null;
          foreach x in array v_seeds loop
            v_di := v_d[(i - 1) * n + x];
            if v_near is null or v_di < v_near then
              v_near := v_di;
            end if;
          end loop;
          if v_near > v_far then
            v_far := v_near;
            v_pick := i;
          end if;
        end loop;
        v_seeds := v_seeds || v_pick;
      end loop;

      for t in 1 .. v_filled loop
        v_g[v_seeds[t]] := t;
        v_cnt[t] := 1;
      end loop;

      -- Everybody else to the nearest seed with room, nearest first.
      for v_pair in
        select p.i, q.t
        from generate_series(1, n) p(i)
        cross join generate_series(1, v_filled) q(t)
        order by v_d[(p.i - 1) * n + v_seeds[q.t]], p.i, q.t
      loop
        i := v_pair.i;
        t := v_pair.t;
        continue when v_g[i] <> 0 or v_cnt[t] >= v_size[t];
        v_g[i] := t;
        v_cnt[t] := v_cnt[t] + 1;
      end loop;
    else
      -- Dealt round in this start's own order, so the first groups get the
      -- one extra voter each, as v_size says.
      t := 0;
      for v_pair in
        select v.i::int as i
        from unnest(v_ids) with ordinality v(bid, i)
        order by md5(r::text || p_poll_id::text || v.bid::text), v.bid
      loop
        v_g[v_pair.i] := t % k + 1;
        v_cnt[t % k + 1] := v_cnt[t % k + 1] + 1;
        t := t + 1;
      end loop;
    end if;

    -- How far each voter is from each group, all told.
    v_c := array_fill(0::bigint, array[n * k]);
    for i in 1 .. n loop
      for j in 1 .. n loop
        x := (i - 1) * k + v_g[j];
        v_c[x] := v_c[x] + v_d[(i - 1) * n + j];
      end loop;
    end loop;

    v_passes := 0;
    loop
      v_improved := false;
      v_passes := v_passes + 1;

      for i in 1 .. n - 1 loop
        for j in i + 1 .. n loop
          a := v_g[i];
          b := v_g[j];
          continue when a = b;
          v_delta := v_c[(i - 1) * k + b] - v_c[(i - 1) * k + a]
                   + v_c[(j - 1) * k + a] - v_c[(j - 1) * k + b]
                   - 2 * v_d[(i - 1) * n + j];
          if v_sign * v_delta < 0 then
            for x in 1 .. n loop
              v_di := v_d[(x - 1) * n + i];
              v_dj := v_d[(x - 1) * n + j];
              v_c[(x - 1) * k + a] := v_c[(x - 1) * k + a] + v_dj - v_di;
              v_c[(x - 1) * k + b] := v_c[(x - 1) * k + b] + v_di - v_dj;
            end loop;
            v_g[i] := b;
            v_g[j] := a;
            v_improved := true;
          end if;
        end loop;
      end loop;

      for i in 1 .. n loop
        for b in 1 .. k loop
          a := v_g[i];
          continue when a = b or v_cnt[a] <> v_cnt[b] + 1;
          v_delta := v_c[(i - 1) * k + b] - v_c[(i - 1) * k + a];
          if v_sign * v_delta < 0 then
            for x in 1 .. n loop
              v_di := v_d[(x - 1) * n + i];
              v_c[(x - 1) * k + a] := v_c[(x - 1) * k + a] - v_di;
              v_c[(x - 1) * k + b] := v_c[(x - 1) * k + b] + v_di;
            end loop;
            v_g[i] := b;
            v_cnt[a] := v_cnt[a] - 1;
            v_cnt[b] := v_cnt[b] + 1;
            v_improved := true;
          end if;
        end loop;
      end loop;

      exit when not v_improved or v_passes >= 30;
    end loop;

    v_w := 0;
    for i in 1 .. n loop
      v_w := v_w + v_c[(i - 1) * k + v_g[i]];
    end loop;

    if r = 1 or v_sign * (v_w - v_best_w) < 0 then
      v_best := v_g;
      v_best_w := v_w;
    end if;
  end loop;

  -- Numbered as shown: largest first, then by the first voter's name.
  return query
  with placed as (
    select v.bid, v_best[v.i::int] as g, lower(coalesce(ballot_voter_label(bl), 'A voter')) as label
    from unnest(v_ids) with ordinality v(bid, i)
    join ballots bl on bl.id = v.bid
  ),
  ranked as (
    select g, row_number() over (order by count(*) desc, min(label), g)::int as shown
    from placed
    group by g
  )
  select p.bid, r2.shown
  from placed p
  join ranked r2 on r2.g = p.g;
end;
$$;

ALTER FUNCTION "public"."voter_groups"("uuid", integer, boolean) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."voter_groups"("uuid", integer, boolean) FROM PUBLIC;


-- Group formation. Answers
--
--   { groups, group_count, similar, voter_count, not_grouped }
--
-- `groups` is every group in the order voter_groups numbers them, each
-- `{ voters: [{ name }] }` with its voters by name, and an empty group for
-- every one there were too few voters to fill. `not_grouped` is the invitees
-- of an invite poll who did not vote, by name, so the creator can see who
-- was left out; an open poll has no list to say that from.
--
-- p_groups and p_similar default to the question's own where it asked for
-- group formation, else 2 groups and alike. Names are the roster's
-- (ballot_voter_label). It says nothing of how far apart anybody is: on a
-- poll whose ballots are private, a group of two's distance would be the
-- distance between two ballots.
CREATE OR REPLACE FUNCTION "public"."poll_groups"("p_poll_id" "uuid", "p_groups" integer DEFAULT NULL::integer, "p_similar" boolean DEFAULT NULL::boolean)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_groups int;
  v_similar boolean;
  v_voters int;
  v_out jsonb;
  v_left jsonb;
begin
  select * into v_poll from polls where id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  if not v_poll.show_voters then
    raise exception 'This poll hides who voted, so it cannot be split into groups';
  end if;

  if poll_is_weighted(p_poll_id) then
    raise exception 'A sequential poll''s ballots carry weights a grouping would ignore';
  end if;

  v_groups := coalesce(p_groups,
                       case when v_poll.kind in ('groups', 'mixed_groups') then v_poll.kind_value::int end,
                       2);
  v_similar := coalesce(p_similar, v_poll.kind <> 'mixed_groups');

  perform validate_group_count(v_groups);

  drop table if exists _formed;
  create temp table _formed on commit drop as
  select vg.ballot_id, vg.grp, coalesce(ballot_voter_label(b), 'A voter') as name
  from voter_groups(p_poll_id, v_groups, v_similar) vg
  join ballots b on b.id = vg.ballot_id;

  select count(*)::int into v_voters from _formed;

  select jsonb_agg(jsonb_build_object(
           'voters', coalesce((
             select jsonb_agg(jsonb_build_object('name', f.name) order by lower(f.name), f.name)
             from _formed f where f.grp = g), '[]'::jsonb))
         order by g)
  into v_out
  from generate_series(1, v_groups) g;

  -- Invitees with no ballot, named as the roster names them.
  select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(iv.voter_name, iv.name, iv.email))
                            order by lower(coalesce(iv.voter_name, iv.name, iv.email))), '[]'::jsonb)
  into v_left
  from invited_voters iv
  where iv.poll_id = p_poll_id
    and not counting_a_group()
    and not exists (
      select 1 from ballots b
      join auth.users u on u.id = b.voter_id
      where b.poll_id = p_poll_id and lower(u.email) = iv.email);

  return jsonb_build_object(
    'groups', v_out,
    'group_count', v_groups,
    'similar', v_similar,
    'voter_count', v_voters,
    'not_grouped', v_left
  );
end;
$$;

ALTER FUNCTION "public"."poll_groups"("uuid", integer, boolean) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."poll_groups"("uuid", integer, boolean) FROM PUBLIC;


-- The two doors, gated as the tally is. Any poll that shows its voters may
-- be grouped any way: groups say who voted more alike than whom, not how.
CREATE OR REPLACE FUNCTION "public"."get_poll_groups"("p_poll_id" "uuid", "p_groups" integer DEFAULT NULL::integer, "p_similar" boolean DEFAULT NULL::boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_groups(p_poll_id, p_groups, p_similar);
end;
$$;

ALTER FUNCTION "public"."get_poll_groups"("uuid", integer, boolean) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."get_poll_groups"("uuid", integer, boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_groups"("uuid", integer, boolean) TO "authenticated";


CREATE OR REPLACE FUNCTION "public"."open_poll_groups"("p_poll_id" "uuid", "p_groups" integer DEFAULT NULL::integer, "p_similar" boolean DEFAULT NULL::boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_groups(p_poll_id, p_groups, p_similar);
end;
$$;

ALTER FUNCTION "public"."open_poll_groups"("uuid", integer, boolean) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."open_poll_groups"("uuid", integer, boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_groups"("uuid", integer, boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_groups"("uuid", integer, boolean) TO "authenticated";


-- One group's count (*Make choice*): any of the counts *More results*
-- offers, run over that group's ballots alone. The group is named by the
-- grouping's number, direction and place, and worked out again here, so a
-- reader can count only a group the grouping makes, never a set of ballots
-- of their choosing. A count of a group's ballots says how its voters
-- scored -- a group of two's best option is nearly a ballot -- so it is
-- only for a poll whose ballots are published, where the sheet says as much.
--
-- p_count names the count and p_args carries what its door would take, by
-- the door's own argument names:
--
--   results            poll_tally (the group's STAR, carrying no kind_result)
--   ranking            poll_ranking
--   multiple_winners   poll_multiple_winners   p_excluded
--   fractional_winners poll_fractional_winners p_excluded
--   consensus          poll_consensus          p_excluded
--   consensus_winners  poll_consensus_winners  p_excluded, p_winners
--   budget             poll_budget_count       p_excluded, p_costs, p_budget, p_choice
--   assignment         poll_assignment         p_excluded, p_places, p_per_voter
--   scores             poll_scores
CREATE OR REPLACE FUNCTION "public"."poll_group_count"("p_poll_id" "uuid", "p_groups" integer, "p_similar" boolean, "p_group" integer, "p_count" "text", "p_args" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_ballots uuid[];
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_excluded uuid[];
  v_result jsonb;
begin
  select * into v_poll from polls where id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  if not (v_poll.show_voters and v_poll.show_ballots) then
    raise exception 'This poll keeps its ballots private, so a group''s ballots cannot be counted on their own';
  end if;

  if p_count is null or p_count not in ('results', 'ranking', 'multiple_winners', 'fractional_winners',
                                        'consensus', 'consensus_winners', 'budget', 'assignment', 'scores') then
    raise exception 'Unknown count';
  end if;

  perform validate_group_count(p_groups);

  if p_group is null or p_group < 1 or p_group > p_groups then
    raise exception 'There is no such group';
  end if;

  select coalesce(array_agg(vg.ballot_id), '{}'::uuid[]) into v_ballots
  from voter_groups(p_poll_id, p_groups, p_similar) vg
  where vg.grp = p_group;

  if cardinality(v_ballots) = 0 then
    raise exception 'Nobody is in this group';
  end if;

  select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_excluded
  from jsonb_array_elements_text(coalesce(v_args -> 'p_excluded', '[]'::jsonb)) x;

  perform set_config('app.counted_ballots', v_ballots::text, true);

  v_result := case p_count
    when 'results' then poll_tally(p_poll_id)
    when 'ranking' then poll_ranking(p_poll_id)
    when 'multiple_winners' then poll_multiple_winners(p_poll_id, v_excluded)
    when 'fractional_winners' then poll_fractional_winners(p_poll_id, v_excluded)
    when 'consensus' then poll_consensus(p_poll_id, v_excluded)
    when 'consensus_winners' then
      poll_consensus_winners(p_poll_id, v_excluded, (v_args ->> 'p_winners')::int)
    when 'budget' then
      poll_budget_count(p_poll_id, v_excluded, v_args -> 'p_costs', (v_args ->> 'p_budget')::numeric,
                        coalesce(v_args ->> 'p_choice', 'multiple'))
    when 'assignment' then
      poll_assignment(p_poll_id, v_excluded, v_args -> 'p_places', (v_args ->> 'p_per_voter')::int)
    when 'scores' then poll_scores(p_poll_id)
  end;

  perform set_config('app.counted_ballots', '', true);

  return v_result;
end;
$$;

ALTER FUNCTION "public"."poll_group_count"("uuid", integer, boolean, integer, "text", "jsonb") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."poll_group_count"("uuid", integer, boolean, integer, "text", "jsonb") FROM PUBLIC;


CREATE OR REPLACE FUNCTION "public"."get_poll_group_count"("p_poll_id" "uuid", "p_groups" integer, "p_similar" boolean, "p_group" integer, "p_count" "text", "p_args" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_group_count(p_poll_id, p_groups, p_similar, p_group, p_count, p_args);
end;
$$;

ALTER FUNCTION "public"."get_poll_group_count"("uuid", integer, boolean, integer, "text", "jsonb") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."get_poll_group_count"("uuid", integer, boolean, integer, "text", "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_group_count"("uuid", integer, boolean, integer, "text", "jsonb") TO "authenticated";


CREATE OR REPLACE FUNCTION "public"."open_poll_group_count"("p_poll_id" "uuid", "p_groups" integer, "p_similar" boolean, "p_group" integer, "p_count" "text", "p_args" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_group_count(p_poll_id, p_groups, p_similar, p_group, p_count, p_args);
end;
$$;

ALTER FUNCTION "public"."open_poll_group_count"("uuid", integer, boolean, integer, "text", "jsonb") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."open_poll_group_count"("uuid", integer, boolean, integer, "text", "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_group_count"("uuid", integer, boolean, integer, "text", "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_group_count"("uuid", integer, boolean, integer, "text", "jsonb") TO "authenticated";

-- The counts, reading only the counted ballots. Copied from the latest
-- migration that wrote each, changed only in what they read, and in
-- poll_tally carrying group formation's result.

CREATE OR REPLACE FUNCTION "public"."ballot_given"("p_poll_id" "uuid") RETURNS TABLE("ballot_id" "uuid", "given" numeric)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select b.id,
         case when o.j ->> 'poll' = p_poll_id::text
              then (o.j -> 'given' ->> b.id::text)::numeric
              else b.given end
  from counted_ballots(p_poll_id) b,
       (select nullif(current_setting('app.sequential_given', true), '')::jsonb as j) o
  where b.poll_id = p_poll_id
$$;


CREATE OR REPLACE FUNCTION "public"."star_round"("p_poll_id" "uuid", "p_pool" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_finalists uuid[] := '{}';
  v_pick uuid[];
  v_tiebreaks jsonb := '[]'::jsonb;
  v_need int := 2;
  v_score int;
  v_group uuid[];
  v_grp_size int;
  v_tied jsonb;
  v_h2h jsonb;
  v_matchup jsonb;
  v_fs jsonb;
  v_steps jsonb;
  v_advanced jsonb;
  v_resolved text;
  v_fn int; v_fn1 int;
  v_a uuid; v_b uuid;
  v_ta int; v_tb int;
  v_fa int; v_fb int;
  v_prefers_a int; v_prefers_b int; v_ties int;
  v_winner uuid;
  v_runoff_by text;
begin
  drop table if exists _round;
  create temp table _round on commit drop as
  select
    c.id as cid,
    c.name,
    coalesce(sum(s.score), 0)::int as total,
    (count(*) filter (where s.score = 5))::int as five_stars
  from candidates c
  left join counted_scores(p_poll_id) s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
    and c.id = any(p_pool)
  group by c.id, c.name;

  -- Walk score groups high to low, filling the two finalist slots. A group
  -- that would overfill the remaining slots is the tie that needs breaking.
  for v_score in select distinct total from _round order by total desc loop
    exit when v_need <= 0;

    select array_agg(cid order by cid) into v_group from _round where total = v_score;
    v_grp_size := coalesce(array_length(v_group, 1), 0);

    if v_grp_size <= v_need then
      v_finalists := v_finalists || v_group;
      v_need := v_need - v_grp_size;
    else
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'total_score', total) order by name)
        into v_tied from _round where cid = any(v_group);
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', five_stars) order by five_stars desc, name)
        into v_fs from _round where cid = any(v_group);

      if v_grp_size = 2 then
        -- Two options for one slot: the single comparison between them, then
        -- five-star votes, then the arbitrary-but-stable order by id. The pair
        -- is named in alphabetical order, as the results page reads it.
        select cid into v_a from _round where cid = any(v_group) order by name, cid limit 1;
        select cid into v_b from _round where cid = any(v_group) and cid <> v_a;

        select
          (count(*) filter (where a_score > b_score))::int,
          (count(*) filter (where b_score > a_score))::int,
          (count(*) filter (where a_score = b_score))::int
        into v_prefers_a, v_prefers_b, v_ties
        from (
          select
            coalesce((select score from scores where ballot_id = bal.id and candidate_id = v_a), 0) as a_score,
            coalesce((select score from scores where ballot_id = bal.id and candidate_id = v_b), 0) as b_score
          from counted_ballots(p_poll_id) bal
          where bal.poll_id = p_poll_id
        ) v;

        select jsonb_build_object(
                 'a', v_a, 'a_name', ca.name,
                 'b', v_b, 'b_name', cb.name,
                 'prefers_a', v_prefers_a,
                 'prefers_b', v_prefers_b,
                 'ties', v_ties)
          into v_matchup
        from _round ca, _round cb
        where ca.cid = v_a and cb.cid = v_b;

        drop table if exists _tb;
        create temp table _tb on commit drop as
        with w as (
          select
            t.cid,
            t.name,
            t.five_stars,
            case
              when t.cid = v_a then (v_prefers_a > v_prefers_b)::int
              else (v_prefers_b > v_prefers_a)::int
            end as h2h_wins
          from _round t
          where t.cid = any(v_group)
        )
        select w.*, row_number() over (order by h2h_wins desc, five_stars desc, cid) as rn
        from w;

        select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', h2h_wins) order by h2h_wins desc, name)
          into v_h2h from _tb;

        if v_prefers_a <> v_prefers_b then
          v_resolved := 'head_to_head';
        elsif (select max(five_stars) <> min(five_stars) from _tb) then
          v_resolved := 'five_star_votes';
        else
          v_resolved := 'random';
        end if;

        v_steps := jsonb_build_array(jsonb_build_object(
          'rule', 'head_to_head',
          'results', v_h2h,
          'matchups', jsonb_build_array(v_matchup),
          'decisive', v_resolved = 'head_to_head'));

        if v_resolved <> 'head_to_head' then
          v_steps := v_steps || jsonb_build_array(jsonb_build_object(
            'rule', 'five_star_votes', 'results', v_fs, 'decisive', v_resolved = 'five_star_votes'));
        end if;
      else
        -- Three or more for the slots left: five-star votes, then the
        -- arbitrary-but-stable order by id.
        drop table if exists _tb;
        create temp table _tb on commit drop as
        select
          t.cid,
          t.name,
          t.five_stars,
          row_number() over (order by t.five_stars desc, t.cid) as rn
        from _round t
        where t.cid = any(v_group);

        -- Whatever separates the last advancing option from the first
        -- eliminated one is what actually decided the tie.
        select five_stars into v_fn from _tb where rn = v_need;
        select five_stars into v_fn1 from _tb where rn = v_need + 1;

        v_resolved := case when v_fn > v_fn1 then 'five_star_votes' else 'random' end;

        v_steps := jsonb_build_array(jsonb_build_object(
          'rule', 'five_star_votes', 'results', v_fs, 'decisive', v_resolved = 'five_star_votes'));
      end if;

      select array_agg(cid order by rn) into v_pick from _tb where rn <= v_need;
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name) order by rn)
        into v_advanced from _tb where rn <= v_need;

      v_tiebreaks := v_tiebreaks || jsonb_build_array(jsonb_build_object(
        'tied_at', v_score,
        'tied', v_tied,
        'slots', v_need,
        'steps', v_steps,
        'resolved_by', v_resolved,
        'advanced', v_advanced));

      v_finalists := v_finalists || v_pick;
      v_need := 0;
    end if;
  end loop;

  -- Highest scorer first, so finalists[0] is the one the runoff labels as A.
  select coalesce(array_agg(cid order by total desc, cid), '{}'::uuid[]) into v_finalists
  from _round where cid = any(v_finalists);

  -- A pool of one has nobody to run off against: it takes the place unopposed.
  if array_length(v_finalists, 1) is distinct from 2 then
    return jsonb_build_object(
      'finalists', to_jsonb(v_finalists),
      'tiebreaks', v_tiebreaks,
      'runoff', null,
      'winner_id', v_finalists[1]
    );
  end if;

  v_a := v_finalists[1];
  v_b := v_finalists[2];

  select
    count(*) filter (where a_score > b_score),
    count(*) filter (where b_score > a_score),
    count(*) filter (where a_score = b_score)
  into v_prefers_a, v_prefers_b, v_ties
  from (
    select
      bal.id,
      coalesce((select score from scores where ballot_id = bal.id and candidate_id = v_a), 0) as a_score,
      coalesce((select score from scores where ballot_id = bal.id and candidate_id = v_b), 0) as b_score
    from counted_ballots(p_poll_id) bal
    where bal.poll_id = p_poll_id
  ) t;

  -- Read unconditionally: these ride along in the payload whether or not
  -- they were needed, so a reader can check the tie-break that was not used.
  select total, five_stars into v_ta, v_fa from _round where cid = v_a;
  select total, five_stars into v_tb, v_fb from _round where cid = v_b;

  if v_prefers_a > v_prefers_b then
    v_winner := v_a; v_runoff_by := 'preference';
  elsif v_prefers_b > v_prefers_a then
    v_winner := v_b; v_runoff_by := 'preference';
  else
    -- A tied runoff goes to the higher total score.
    if v_ta > v_tb then
      v_winner := v_a; v_runoff_by := 'higher_score';
    elsif v_tb > v_ta then
      v_winner := v_b; v_runoff_by := 'higher_score';
    -- Level on preference and on points alike, so fall through to the same
    -- five-star count that settles a tie in the score round. Points come
    -- first in both rounds; the narrower measure of enthusiasm is the last
    -- word before the result is called a true tie.
    elsif v_fa > v_fb then
      v_winner := v_a; v_runoff_by := 'five_star_votes';
    elsif v_fb > v_fa then
      v_winner := v_b; v_runoff_by := 'five_star_votes';
    else
      v_winner := null; v_runoff_by := 'unresolved';
    end if;
  end if;

  return jsonb_build_object(
    'finalists', to_jsonb(v_finalists),
    'tiebreaks', v_tiebreaks,
    'runoff', jsonb_build_object(
      'prefers_a', v_prefers_a,
      'prefers_b', v_prefers_b,
      'ties', v_ties,
      'five_stars_a', v_fa,
      'five_stars_b', v_fb,
      'resolved_by', v_runoff_by
    ),
    'winner_id', v_winner
  );
end;
$$;


CREATE OR REPLACE FUNCTION "public"."poll_ranking"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_voted int;
  v_pool uuid[];
  v_round jsonb;
  v_finalists uuid[];
  v_winner uuid;
  v_placed uuid[];
  v_placed_json jsonb;
  v_finalist_names jsonb;
  v_ranking jsonb := '[]'::jsonb;
  v_place int := 1;
  v_weighted boolean;
begin
  select count(*) into v_voted from counted_ballots(p_poll_id) where poll_id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  v_weighted := poll_is_weighted(p_poll_id);

  -- Names and totals, for labelling the places. Scores are absolute sums, so
  -- eliminating an option never changes anyone else's total and this is read
  -- once for the whole ladder rather than per round.
  drop table if exists _ranking_tally;
  create temp table _ranking_tally on commit drop as
  select
    c.id as cid,
    c.name,
    case when v_weighted
         then trim_scale(round(coalesce(sum(s.score * w.weight), 0), 6))
         else coalesce(sum(s.score), 0) end as total
  from candidates c
  left join counted_scores(p_poll_id) s on s.candidate_id = c.id
  left join poll_ballot_weights(p_poll_id) w on w.ballot_id = s.ballot_id
  where c.poll_id = p_poll_id
  group by c.id, c.name;

  select coalesce(array_agg(cid), '{}'::uuid[]) into v_pool from _ranking_tally;

  -- Every place is a whole STAR round over every ballot, so the ladder stops
  -- once the top places are filled. A place shared by a tied runoff can take
  -- the last round one past the cut; it is kept whole rather than split.
  while coalesce(array_length(v_pool, 1), 0) > 0 and v_place <= poll_results_rows() loop
    v_round := poll_round(p_poll_id, v_pool);

    select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_finalists
    from jsonb_array_elements_text(v_round->'finalists') x;

    v_winner := (v_round->>'winner_id')::uuid;

    -- A runoff level on preference, points and five-star votes alike elects
    -- nobody, and both finalists take the place together.
    if v_winner is null then
      v_placed := v_finalists;
    else
      v_placed := array[v_winner];
    end if;

    -- Belt and braces: a round that places nobody would loop forever.
    exit when coalesce(array_length(v_placed, 1), 0) = 0;

    select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'total_score', total)
                     order by total desc, name)
    into v_placed_json
    from _ranking_tally where cid = any(v_placed);

    -- The runoff's two names, in the order of `finalists`. The option a place
    -- beat may never be placed itself before the ladder stops, so the browser
    -- cannot look it up anywhere else.
    select coalesce(jsonb_agg(t.name order by f.ord), '[]'::jsonb)
    into v_finalist_names
    from unnest(v_finalists) with ordinality f(cid, ord)
    join _ranking_tally t on t.cid = f.cid;

    v_ranking := v_ranking || jsonb_build_array(jsonb_build_object(
      'place', v_place,
      'options', v_placed_json,
      'finalists', v_round->'finalists',
      'finalist_names', v_finalist_names,
      'runoff', v_round->'runoff',
      'tiebreaks', v_round->'tiebreaks'));

    v_place := v_place + array_length(v_placed, 1);

    select coalesce(array_agg(x), '{}'::uuid[]) into v_pool
    from unnest(v_pool) x
    where not (x = any(v_placed));
  end loop;

  return v_ranking;
end;
$$;


CREATE OR REPLACE FUNCTION "public"."poll_fractional_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[]) RETURNS "jsonb"
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

  if not exists (select 1 from counted_ballots(p_poll_id) where poll_id = p_poll_id) then
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
    left join counted_scores(p_poll_id) s on s.candidate_id = cand.id
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
      from counted_ballots(p_poll_id) bl
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


CREATE OR REPLACE FUNCTION "public"."poll_consensus"("p_poll_id" "uuid", "p_excluded" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_pool uuid[];
  v_voters int;
  v_top record;
  v_second record;
  v_level uuid[];
  v_level_names jsonb := '[]'::jsonb;
  v_tied int;
  v_winner uuid;
  v_at int;
  v_runner_up jsonb;
  v_options jsonb;
begin
  -- A poll has at most a few hundred options; anything longer is not a list
  -- a reader built by pressing buttons.
  if coalesce(array_length(p_excluded, 1), 0) > 1000 then
    raise exception 'Too many options left out';
  end if;

  select count(*) into v_voters from counted_ballots(p_poll_id) where poll_id = p_poll_id;
  if v_voters = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into v_pool
  from candidates
  where poll_id = p_poll_id
    and not (id = any(coalesce(p_excluded, '{}'::uuid[])));

  if cardinality(v_pool) = 0 then
    raise exception 'Every option has been left out';
  end if;

  -- Each option's scores, lowest first. Arrays of one length compare element
  -- by element, so ordering by `ladder desc` is the whole comparison. One
  -- score per option per ballot is an invariant (fill_scores_for_new_option),
  -- but a missing score reads as 0, as the tally reads it.
  drop table if exists _consensus;
  create temp table _consensus on commit drop as
  select
    c.id as cid,
    c.name,
    array_agg(coalesce(s.score, 0)::int order by coalesce(s.score, 0)) as ladder,
    coalesce(sum(s.score), 0)::int as total
  from candidates c
  join counted_ballots(p_poll_id) b on b.poll_id = p_poll_id
  left join scores s on s.ballot_id = b.id and s.candidate_id = c.id
  where c.id = any(v_pool)
  group by c.id, c.name;

  alter table _consensus add column rn bigint;
  update _consensus t set rn = o.rn
  from (select cid, row_number() over (order by ladder desc, name, cid) as rn from _consensus) o
  where o.cid = t.cid;

  select * into v_top from _consensus where rn = 1;
  select * into v_second from _consensus where rn = 2;

  select count(*)::int into v_tied from _consensus where ladder[1] = v_top.ladder[1];

  select array_agg(cid order by rn) into v_level from _consensus where ladder = v_top.ladder;

  if cardinality(v_level) > 1 then
    -- Level on every score: nothing left to compare.
    select jsonb_agg(name order by rn) into v_level_names from _consensus where ladder = v_top.ladder;
  else
    v_winner := v_top.cid;
    v_level := '{}';

    if v_second.cid is not null then
      -- The first position the two differ at; they differ somewhere, or they
      -- would be level.
      v_at := 1;
      while v_top.ladder[v_at] = v_second.ladder[v_at] loop
        v_at := v_at + 1;
      end loop;

      v_runner_up := jsonb_build_object(
        'id', v_second.cid,
        'name', v_second.name,
        'score', v_second.ladder[v_at]
      );
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cid,
    'name', name,
    'floor', ladder[1],
    'total_score', total
  ) order by rn), '[]'::jsonb)
  into v_options
  from _consensus
  where rn <= poll_results_rows();

  return jsonb_build_object(
    'winner_id', v_winner,
    'floor', v_top.ladder[1],
    'option_count', cardinality(v_pool),
    'tied_count', v_tied,
    'voter_count', v_voters,
    'decided_at', v_at,
    'winner_score', case when v_at is not null then v_top.ladder[v_at] end,
    'runner_up', v_runner_up,
    'level_ids', to_jsonb(v_level),
    'level_names', v_level_names,
    'options', v_options
  );
end;
$$;


CREATE OR REPLACE FUNCTION "public"."poll_consensus_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[], "p_winners" integer) RETURNS "jsonb"
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
    case when v_kind = 'consensus_winners' then v_kind_value::int end,
    2);
  perform validate_winner_count(v_k);

  select count(*) into v_voters from counted_ballots(p_poll_id) where poll_id = p_poll_id;
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
    join counted_ballots(p_poll_id) b on b.poll_id = p_poll_id
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
  from counted_ballots(p_poll_id) b
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
    join counted_ballots(p_poll_id) b on b.poll_id = p_poll_id
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


CREATE OR REPLACE FUNCTION "public"."poll_budget"("p_poll_id" "uuid", "p_excluded" "uuid"[], "p_costs" "jsonb", "p_budget" numeric, "p_proportional" boolean) RETURNS "jsonb"
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
  from counted_ballots(p_poll_id) where poll_id = p_poll_id;

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


CREATE OR REPLACE FUNCTION "public"."poll_fractional_budget"("p_poll_id" "uuid", "p_excluded" "uuid"[], "p_costs" "jsonb", "p_budget" numeric) RETURNS "jsonb"
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

  if not exists (select 1 from counted_ballots(p_poll_id) where poll_id = p_poll_id) then
    raise exception 'No votes were cast in this poll';
  end if;

  drop table if exists _fcost;
  create temp table _fcost on commit drop as
  select c.id as cid, c.name,
         case when p_costs ? c.id::text then (p_costs ->> c.id::text)::numeric
              else c.kind_value end as cost,
         coalesce((select sum(s.score) from counted_scores(p_poll_id) s where s.candidate_id = c.id), 0) as total,
         (select count(*) from counted_scores(p_poll_id) s where s.candidate_id = c.id and s.score = 5) as five_stars
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
      from counted_ballots(p_poll_id) bl
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


CREATE OR REPLACE FUNCTION "public"."assignment_count"("p_poll_id" "uuid", "p_excluded" "uuid"[], "p_places" "jsonb", "p_per_voter" integer DEFAULT NULL::integer) RETURNS "jsonb"
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
         coalesce(array_agg(coalesce(ballot_voter_label(b), 'A voter') order by b.id), '{}'::text[])
  into v_ballots, v_names
  from counted_ballots(p_poll_id) b
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


CREATE OR REPLACE FUNCTION "public"."poll_scores"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_voted int;
  v_weighted boolean;
  v_strength numeric;
begin
  select count(*) into v_voted from counted_ballots(p_poll_id) where poll_id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  v_weighted := poll_is_weighted(p_poll_id);
  select sum(weight) into v_strength from poll_ballot_weights(p_poll_id);

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'name', name,
      'total_score', total,
      'average_score', round(total::numeric / v_strength, 2)
    ) order by total desc, name), '[]'::jsonb)
    from (
      select c.id, c.name,
             case when v_weighted
                  then trim_scale(round(coalesce(sum(s.score * w.weight), 0), 6))
                  else coalesce(sum(s.score), 0) end as total
      from candidates c
      left join counted_scores(p_poll_id) s on s.candidate_id = c.id
      left join poll_ballot_weights(p_poll_id) w on w.ballot_id = s.ballot_id
      where c.poll_id = p_poll_id
      group by c.id, c.name
    ) t
  );
end;
$$;


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
  v_calendar boolean;
  v_ballots_shown boolean;
begin
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from counted_ballots(p_poll_id) where poll_id = p_poll_id;

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
  left join counted_scores(p_poll_id) s on s.candidate_id = c.id
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

  -- Last, since the functions below build temp tables of their own. A
  -- group's own tally (poll_group_count) carries none: it is one group's
  -- STAR, read to draw that group's results, and the question's result is
  -- about everybody.
  v_kind_result := case
    when counting_a_group() then null
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

  -- Group formation names voters, so it is never made without them shown,
  -- and refused only for size.
  if v_kind in ('groups', 'mixed_groups') and v_voters_shown and not counting_a_group() then
    begin
      v_kind_result := poll_groups(p_poll_id, v_kind_value::int, v_kind = 'groups');
    exception when raise_exception then
      v_kind_result := null;
    end;
  end if;

  if v_kind = 'assignment' and v_option_count >= 2 and v_voters_shown and not counting_a_group() then
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
$$;


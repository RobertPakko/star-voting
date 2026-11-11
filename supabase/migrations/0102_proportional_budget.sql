-- Proportional budget: a kind of its own, and a result any list can be asked
-- for once its options are given costs.
--
-- Every option has a cost and the question a budget. The count is multiple
-- winners with the cost let in twice:
--
--   * each option's stars are scaled by A / C (the average cost of the
--     options counted over its own), in the scores and in the runoff alike,
--     so a cheaper option's stars count for more;
--   * a ballot that starred a funded option is charged N x C / A for it, so
--     its strength is 5 / (5 + SUM(N x C / A)) over everything funded so far
--     -- multiple winners' divisor when every option costs the same.
--
-- Each round is STAR over the options that still fit in what is left; the
-- count stops when nothing does. Options are funded whole or not at all, so
-- some of the budget can be left over.
--
-- Where the costs live:
--
--   * polls.kind_value is the budget, on a 'budget' question (required);
--   * candidates.kind_value is an option's cost, on a 'budget' question
--     (required there, and refused anywhere else). Suggestions carry one.
--
-- On any other written list a reader can type costs and a budget into the
-- *More results* modal and count; those are sent with the request
-- (`p_costs`, `p_budget`) and never stored, like the options a reader takes
-- out. Costs reach the browser beside each option (open_poll_view,
-- poll_page); a ballot does not draw them.
--
-- The cost scale is a scale on a STAR round, so weighted_star_round becomes
-- scaled_star_round at a scale of one: the same rules, the same rounding, the
-- same answer to every tally that already used it.


ALTER TABLE "public"."polls"
  DROP CONSTRAINT "polls_kind_ck",
  DROP CONSTRAINT "polls_kind_value_ck";

ALTER TABLE "public"."polls"
  ADD CONSTRAINT "polls_kind_ck"
    CHECK (("kind" = ANY (ARRAY['option'::"text", 'time'::"text", 'ranking'::"text", 'multiple'::"text", 'fractional'::"text", 'consensus'::"text", 'consensus_time'::"text", 'budget'::"text"]))),
  ADD CONSTRAINT "polls_kind_value_ck"
    CHECK ((("kind_value" IS NULL) OR (("kind_value" = "trunc"("kind_value")) AND ((("kind" = ANY (ARRAY['ranking'::"text", 'multiple'::"text"])) AND ("kind_value" >= (2)::numeric)) OR (("kind" = 'budget'::"text") AND ("kind_value" >= (1)::numeric))))));

ALTER TABLE "public"."candidates"
  ADD CONSTRAINT "candidates_kind_value_ck"
    CHECK ((("kind_value" IS NULL) OR (("kind_value" = "trunc"("kind_value")) AND ("kind_value" >= (1)::numeric))));

COMMENT ON COLUMN "public"."polls"."kind" IS 'What the question asks for, and so which result it opens on: ''option'' (the best option), ''time'' (the best time, on a calendar ballot whose options are the starts of meeting windows), ''ranking'' (the option ranking), ''multiple'' (multiple winners), ''fractional'' (fractional winners), ''consensus'' (the consensus option), ''consensus_time'' (the consensus time, on a calendar ballot) or ''budget'' (a proportional budget, its options costed). Every kind but the two times is a written list. The other results are still offered. A setting, frozen at creation like mode.';

COMMENT ON COLUMN "public"."polls"."kind_value" IS 'A number whose meaning belongs to the kind: the places to rank, the winners to choose, or the budget. Null where the kind takes none, or to show as many as the results hold (poll_results_rows()); never null on a budget. Readers may look at a ranking or several winners with another number; this is where it opens.';

COMMENT ON COLUMN "public"."candidates"."kind_value" IS 'An option''s cost, on a proportional budget question, where every option has one; null on every other kind.';


-- The rules on a kind and its number. A budget must have one: a count with
-- nothing to spend funds nothing.
CREATE OR REPLACE FUNCTION "public"."validate_kind"("p_kind" "text", "p_value" numeric, "p_question" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_which text := case when p_question is null then '' else format(' on question %s', p_question) end;
begin
  if p_kind is null or p_kind not in ('option', 'time', 'ranking', 'multiple', 'fractional', 'consensus', 'consensus_time', 'budget') then
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

  if p_kind not in ('ranking', 'multiple') then
    raise exception 'Only an option ranking, multiple winners or a proportional budget takes a number%', v_which;
  end if;

  if p_value <> trunc(p_value) or p_value < 2 or p_value > poll_results_rows() then
    raise exception '%', format('Choose a number from 2 to %s%s', poll_results_rows(), v_which);
  end if;
end;
$$;


-- A budget or a cost: a whole number from 1 to a billion, the ceiling only
-- there to catch a typo of extra zeros. `p_what` begins the refusal.
CREATE OR REPLACE FUNCTION "public"."validate_amount"("p_value" numeric, "p_what" "text") RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
begin
  if p_value is null or p_value <> trunc(p_value) or p_value < 1 or p_value > 1000000000 then
    raise exception '% must be a whole number from 1 to 1,000,000,000', p_what;
  end if;
end;
$$;

ALTER FUNCTION "public"."validate_amount"(numeric, "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."validate_amount"(numeric, "text") FROM PUBLIC;


-- The cost an option is stored with, from whatever arrived (a JSON number or
-- nothing): required on a budget, refused anywhere else, so a cost is never
-- stored where nothing reads it.
CREATE OR REPLACE FUNCTION "public"."option_cost"("p_kind" "text", "p_cost" "jsonb", "p_name" "text") RETURNS numeric
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_cost numeric;
begin
  if p_cost is null or p_cost = 'null'::jsonb then
    if p_kind = 'budget' then
      raise exception 'Give "%" a cost', p_name;
    end if;
    return null;
  end if;

  if p_kind is distinct from 'budget' then
    raise exception 'Only a proportional budget gives its options a cost';
  end if;

  if jsonb_typeof(p_cost) <> 'number' then
    raise exception 'The cost of "%" is not a number', p_name;
  end if;

  v_cost := (p_cost #>> '{}')::numeric;
  perform validate_amount(v_cost, format('The cost of "%s"', p_name));
  return v_cost;
end;
$$;

ALTER FUNCTION "public"."option_cost"("text", "jsonb", "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."option_cost"("text", "jsonb", "text") FROM PUBLIC;


-- Each option carries its cost into the poll.
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

  -- Drop blanks but keep the author's ordering, carrying each option's
  -- description along with it.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'name', trim(o ->> 'name'),
             'description', nullif(trim(coalesce(o ->> 'description', '')), ''),
             'cost', o -> 'cost'
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


-- create_poll takes the costs, paired by position as the descriptions are and
-- appended with a default so every existing call means what it meant. Drop
-- and create; its grant is restated.
DROP FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb");

CREATE FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_option_descriptions" "text"[] DEFAULT NULL::"text"[], "p_solicit_options" boolean DEFAULT false, "p_kind" "text" DEFAULT 'option'::"text", "p_schedule" "jsonb" DEFAULT NULL::"jsonb", "p_kind_value" numeric DEFAULT NULL::numeric, "p_carried" "jsonb" DEFAULT NULL::"jsonb", "p_option_costs" numeric[] DEFAULT NULL::numeric[]) RETURNS "uuid"
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

  if v_kind in ('time', 'consensus_time') then
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
                              'cost', p_option_costs[ord])
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
    case when v_kind in ('time', 'consensus_time') then p_schedule else null end,
    p_kind_value
  );

  perform insert_carried_weights(v_id, p_carried);

  return v_id;
end;
$$;

ALTER FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb", "p_option_costs" numeric[]) OWNER TO "postgres";

COMMENT ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb", "p_option_costs" numeric[]) IS 'Creates one poll with its options and its invitees. A time poll carries a schedule and options its creator''s browser enumerated from a painted calendar; the database stores it exactly as it stores any other poll. A time poll may collect its times from voters, through suggest_options. The kind also says which result the poll opens on; see polls.kind. p_carried makes it a sequential poll: see carried_weights. p_option_costs are a budget''s costs, paired by position with the options.';

REVOKE ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb", "p_option_costs" numeric[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb", "p_option_costs" numeric[]) TO "authenticated";


-- One option, with its cost. Drop and create; it was granted to nobody, and
-- is again. Every caller that sends no cost means what it meant, and is
-- refused on a budget, which needs one.
DROP FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text");

CREATE OR REPLACE FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text", "p_cost" "jsonb" DEFAULT NULL::"jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_next int;
  v_count int;
  v_cost numeric;
begin
  if v_name is null then
    raise exception 'Give the option a name';
  end if;

  -- A name is a label on a ballot and a description is a couple of lines
  -- under it. Neither cap is near what a real option needs; they are here
  -- because the suggestion path lets a whole group write to this table.
  if length(v_name) > 150 then
    raise exception 'That option name is too long';
  end if;

  if length(v_description) > 900 then
    raise exception 'That description is too long';
  end if;

  v_cost := option_cost(p_poll.kind, p_cost, v_name);

  if exists (
    select 1 from candidates c
    where c.poll_id = p_poll.id and lower(c.name) = lower(v_name)
  ) then
    raise exception '"%" is already on the list', v_name;
  end if;

  select count(*)::int, coalesce(max(sort_order), -1) + 1
  into v_count, v_next
  from candidates where poll_id = p_poll.id;

  -- The ceiling is a ceiling on what the tally can be asked to do in the time
  -- a voter is waiting for it, rather than on what a reader will put up with.
  if v_count >= 500 then
    raise exception 'This poll already has as many options as it can hold';
  end if;

  -- Arrival order, which is the order everyone watching the page has been
  -- reading the list in already.
  insert into candidates (poll_id, name, description, sort_order, kind_value)
  values (p_poll.id, v_name, v_description, v_next, v_cost);
end;
$$;

ALTER FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text", "p_cost" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text", "p_cost" "jsonb") IS 'The field rules for one option -- name, description, cost, duplicates, the 500-option ceiling -- shared by the suggestion path and the creator''s own. Internal: the caller has already decided it may write to this poll.';

REVOKE ALL ON FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text", "p_cost" "jsonb") FROM PUBLIC;


-- A list of options, each with its cost.
CREATE OR REPLACE FUNCTION "public"."insert_options"("p_poll" "public"."polls", "p_options" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_item jsonb;
  v_name text;
  v_added int := 0;
  v_seen text[] := array[]::text[];
  i int;
begin
  if p_options is null or jsonb_typeof(p_options) <> 'array' then
    raise exception 'Give the options as a list';
  end if;

  -- Bounded before anything is inserted, so an over-long batch is one message
  -- rather than four hundred rows and then a message. The real ceiling is
  -- insert_option's, which counts what is already there.
  if jsonb_array_length(p_options) > 500 then
    raise exception 'A poll can hold 500 options; that is %', jsonb_array_length(p_options);
  end if;

  for i in 0 .. jsonb_array_length(p_options) - 1 loop
    v_item := p_options -> i;
    v_name := nullif(trim(coalesce(v_item ->> 'name', '')), '');
    if v_name is null then
      continue;
    end if;

    -- Against the batch as well as against the table: a list with the same
    -- name twice in it would otherwise insert the first and raise on the
    -- second, which is the half-applied run this function exists to prevent.
    if lower(v_name) = any (v_seen) then
      continue;
    end if;
    v_seen := v_seen || lower(v_name);

    if exists (
      select 1 from candidates c
      where c.poll_id = p_poll.id and lower(c.name) = lower(v_name)
    ) then
      continue;
    end if;

    perform insert_option(p_poll, v_name, v_item ->> 'description', v_item -> 'cost');
    v_added := v_added + 1;
  end loop;

  return v_added;
end;
$$;


-- The creator's correction can change a cost, in place like a name.
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
  if jsonb_array_length(p_correct) > 0 and v_poll.kind in ('time', 'consensus_time') then
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
    perform option_cost(v_poll.kind, v_item -> 'cost', v_name);
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
           option_cost(v_poll.kind, x -> 'cost', trim(x ->> 'name')) as cost
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


-- weighted_star_round, with a scale on every option: a vote for an option,
-- in the scores, the tie-breaks and the runoff, counts its ballot's weight
-- times that option's scale. Voters scoring two options equally are counted
-- unscaled, since they voted for neither.
CREATE OR REPLACE FUNCTION "public"."scaled_star_round"(
    "p_poll_id" "uuid", "p_pool" "uuid"[], "p_ballots" "uuid"[], "p_weights" numeric[], "p_scales" numeric[])
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_finalists uuid[] := '{}';
  v_pick uuid[];
  v_tiebreaks jsonb := '[]'::jsonb;
  v_need int := 2;
  v_score numeric;
  v_group uuid[];
  v_grp_size int;
  v_tied jsonb;
  v_h2h jsonb;
  v_matchup jsonb;
  v_fs jsonb;
  v_steps jsonb;
  v_advanced jsonb;
  v_resolved text;
  v_fn numeric; v_fn1 numeric;
  v_a uuid; v_b uuid;
  v_ta numeric; v_tb numeric;
  v_fa numeric; v_fb numeric;
  v_prefers_a numeric; v_prefers_b numeric; v_ties numeric;
  v_winner uuid;
  v_runoff_by text;
begin
  drop table if exists _wweights;
  create temp table _wweights on commit drop as
  select b.ballot_id, b.weight
  from unnest(p_ballots, p_weights) as b(ballot_id, weight);

  -- Each option's scale, paired with the pool by position.
  drop table if exists _wscale;
  create temp table _wscale on commit drop as
  select x.cid, x.scale
  from unnest(p_pool, p_scales) as x(cid, scale);

  -- Every ballot's score for every option in the pool, at its strength, and
  -- the option's scale beside it.
  drop table if exists _wscores;
  create temp table _wscores on commit drop as
  select s.ballot_id, s.candidate_id, s.score, w.weight, x.scale
  from scores s
  join _wweights w on w.ballot_id = s.ballot_id
  join _wscale x on x.cid = s.candidate_id
  where s.candidate_id = any(p_pool);

  drop table if exists _wround;
  create temp table _wround on commit drop as
  select
    c.id as cid,
    c.name,
    round(coalesce(sum(s.score * s.weight * s.scale), 0), 6) as total,
    round(coalesce(sum(s.weight * s.scale) filter (where s.score = 5), 0), 6) as five_stars
  from candidates c
  left join _wscores s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
    and c.id = any(p_pool)
  group by c.id, c.name;

  for v_score in select distinct total from _wround order by total desc loop
    exit when v_need <= 0;

    select array_agg(cid order by cid) into v_group from _wround where total = v_score;
    v_grp_size := coalesce(array_length(v_group, 1), 0);

    if v_grp_size <= v_need then
      v_finalists := v_finalists || v_group;
      v_need := v_need - v_grp_size;
    else
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'total_score', total) order by name)
        into v_tied from _wround where cid = any(v_group);
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', five_stars) order by five_stars desc, name)
        into v_fs from _wround where cid = any(v_group);

      if v_grp_size = 2 then
        select cid into v_a from _wround where cid = any(v_group) order by name, cid limit 1;
        select cid into v_b from _wround where cid = any(v_group) and cid <> v_a;

        select
          round(coalesce(sum(weight) filter (where a_score > b_score), 0)
                * (select scale from _wscale where cid = v_a), 6),
          round(coalesce(sum(weight) filter (where b_score > a_score), 0)
                * (select scale from _wscale where cid = v_b), 6),
          round(coalesce(sum(weight) filter (where a_score = b_score), 0), 6)
        into v_prefers_a, v_prefers_b, v_ties
        from (
          select
            w.weight,
            coalesce((select score from _wscores where ballot_id = w.ballot_id and candidate_id = v_a), 0) as a_score,
            coalesce((select score from _wscores where ballot_id = w.ballot_id and candidate_id = v_b), 0) as b_score
          from _wweights w
        ) v;

        select jsonb_build_object(
                 'a', v_a, 'a_name', ca.name,
                 'b', v_b, 'b_name', cb.name,
                 'prefers_a', v_prefers_a,
                 'prefers_b', v_prefers_b,
                 'ties', v_ties)
          into v_matchup
        from _wround ca, _wround cb
        where ca.cid = v_a and cb.cid = v_b;

        drop table if exists _wtb;
        create temp table _wtb on commit drop as
        with w as (
          select
            t.cid,
            t.name,
            t.five_stars,
            case
              when t.cid = v_a then (v_prefers_a > v_prefers_b)::int
              else (v_prefers_b > v_prefers_a)::int
            end as h2h_wins
          from _wround t
          where t.cid = any(v_group)
        )
        select w.*, row_number() over (order by h2h_wins desc, five_stars desc, cid) as rn
        from w;

        select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', h2h_wins) order by h2h_wins desc, name)
          into v_h2h from _wtb;

        if v_prefers_a <> v_prefers_b then
          v_resolved := 'head_to_head';
        elsif (select max(five_stars) <> min(five_stars) from _wtb) then
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
        drop table if exists _wtb;
        create temp table _wtb on commit drop as
        select
          t.cid,
          t.name,
          t.five_stars,
          row_number() over (order by t.five_stars desc, t.cid) as rn
        from _wround t
        where t.cid = any(v_group);

        select five_stars into v_fn from _wtb where rn = v_need;
        select five_stars into v_fn1 from _wtb where rn = v_need + 1;

        v_resolved := case when v_fn > v_fn1 then 'five_star_votes' else 'random' end;

        v_steps := jsonb_build_array(jsonb_build_object(
          'rule', 'five_star_votes', 'results', v_fs, 'decisive', v_resolved = 'five_star_votes'));
      end if;

      select array_agg(cid order by rn) into v_pick from _wtb where rn <= v_need;
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name) order by rn)
        into v_advanced from _wtb where rn <= v_need;

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

  select coalesce(array_agg(cid order by total desc, cid), '{}'::uuid[]) into v_finalists
  from _wround where cid = any(v_finalists);

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
    round(coalesce(sum(weight) filter (where a_score > b_score), 0)
          * (select scale from _wscale where cid = v_a), 6),
    round(coalesce(sum(weight) filter (where b_score > a_score), 0)
          * (select scale from _wscale where cid = v_b), 6),
    round(coalesce(sum(weight) filter (where a_score = b_score), 0), 6)
  into v_prefers_a, v_prefers_b, v_ties
  from (
    select
      w.weight,
      coalesce((select score from _wscores where ballot_id = w.ballot_id and candidate_id = v_a), 0) as a_score,
      coalesce((select score from _wscores where ballot_id = w.ballot_id and candidate_id = v_b), 0) as b_score
    from _wweights w
  ) t;

  select total, five_stars into v_ta, v_fa from _wround where cid = v_a;
  select total, five_stars into v_tb, v_fb from _wround where cid = v_b;

  if v_prefers_a > v_prefers_b then
    v_winner := v_a; v_runoff_by := 'preference';
  elsif v_prefers_b > v_prefers_a then
    v_winner := v_b; v_runoff_by := 'preference';
  elsif v_ta > v_tb then
    v_winner := v_a; v_runoff_by := 'higher_score';
  elsif v_tb > v_ta then
    v_winner := v_b; v_runoff_by := 'higher_score';
  elsif v_fa > v_fb then
    v_winner := v_a; v_runoff_by := 'five_star_votes';
  elsif v_fb > v_fa then
    v_winner := v_b; v_runoff_by := 'five_star_votes';
  else
    v_winner := null; v_runoff_by := 'unresolved';
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

ALTER FUNCTION "public"."scaled_star_round"("uuid", "uuid"[], "uuid"[], numeric[], numeric[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."scaled_star_round"("uuid", "uuid"[], "uuid"[], numeric[], numeric[]) FROM PUBLIC;

-- The weighted round is the scaled one at a scale of one, so nothing that
-- already counted with it can move.
CREATE OR REPLACE FUNCTION "public"."weighted_star_round"(
    "p_poll_id" "uuid", "p_pool" "uuid"[], "p_ballots" "uuid"[], "p_weights" numeric[])
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  return scaled_star_round(p_poll_id, p_pool, p_ballots, p_weights,
                           array_fill(1::numeric, array[coalesce(cardinality(p_pool), 0)]));
end;
$$;


-- The count. Answers
--
--   { budget, spent, left, average_cost, spots, unfunded, uncosted, tied }
--
-- `spots` is in multiple winners' shape (place, options, finalists,
-- finalist_names, runoff, tiebreaks), each option with its `cost` and every
-- count a scaled, weighted one, plus `left`: the budget still unspent after
-- it. `unfunded` is every counted option left out, with its cost; `uncosted`
-- the options left out for having no cost. A runoff level on every rule funds
-- both finalists where both fit, sharing the spot; where they do not, it
-- funds neither and the count stops there, naming them in `tied`.
--
-- Costs are the options' own (candidates.kind_value), with `p_costs`
-- ({ id: cost }) over them, a key holding null taking an option's cost away;
-- the budget is the question's own unless `p_budget` is given. `p_excluded`
-- leaves options off the ballot, as for multiple winners. The average cost is
-- over the options counted, so a removed option counts as though it was never
-- on the ballot.
--
-- A sequential question's ballots carry weights a budget would ignore, so it
-- is refused there, as the menu leaves it out.
CREATE OR REPLACE FUNCTION "public"."poll_proportional_budget"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[], "p_costs" "jsonb", "p_budget" numeric)
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
           coalesce(array_agg(v_average / cost order by cid), '{}'::numeric[])
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
    -- star at that option's cost over the average.
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

ALTER FUNCTION "public"."poll_proportional_budget"("uuid", "uuid"[], "jsonb", numeric) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_proportional_budget"("uuid", "uuid"[], "jsonb", numeric) FROM PUBLIC;


-- The two doors, gated exactly as multiple winners' are.
CREATE OR REPLACE FUNCTION "public"."get_poll_proportional_budget"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}', "p_costs" "jsonb" DEFAULT NULL, "p_budget" numeric DEFAULT NULL)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_proportional_budget(p_poll_id, p_excluded, p_costs, p_budget);
end;
$$;

ALTER FUNCTION "public"."get_poll_proportional_budget"("uuid", "uuid"[], "jsonb", numeric) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."get_poll_proportional_budget"("uuid", "uuid"[], "jsonb", numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_proportional_budget"("uuid", "uuid"[], "jsonb", numeric) TO "authenticated";


CREATE OR REPLACE FUNCTION "public"."open_poll_proportional_budget"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}', "p_costs" "jsonb" DEFAULT NULL, "p_budget" numeric DEFAULT NULL)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_proportional_budget(p_poll_id, p_excluded, p_costs, p_budget);
end;
$$;

ALTER FUNCTION "public"."open_poll_proportional_budget"("uuid", "uuid"[], "jsonb", numeric) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."open_poll_proportional_budget"("uuid", "uuid"[], "jsonb", numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_proportional_budget"("uuid", "uuid"[], "jsonb", numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_proportional_budget"("uuid", "uuid"[], "jsonb", numeric) TO "authenticated";


-- A budget, like the other kinds that answer with several options, names no
-- one winner, from the two options it is offered at.
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
    when v_kind in ('ranking', 'multiple') then v_options < 3
    when v_kind in ('fractional', 'budget') then v_options < 2
    else true
  end;
end;
$$;


-- The tally carries the budget's count on a budget question.
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
begin
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  select closed_at is not null, mode, options_edited_after_votes, votes_after_reveal,
         kind, kind_value
  into v_closed, v_mode, v_edited, v_late, v_kind, v_kind_value
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
    'weighted', v_weighted
  );
end;
$$;


-- An option's cost travels beside it, through both reads a page is drawn
-- from.
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
    'cost', c.kind_value
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
          'cost', c.kind_value
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

-- Option assignment: a kind of its own, and a result any list that shows who
-- voted can be asked for.
--
-- Every voter is given at most one option, and every option goes to at most
-- its number of places (1 unless it says otherwise), choosing the assignment
-- that maximises the product of the stars each voter gave their own option:
-- maximum Nash welfare, after placing as many voters as possible on an option
-- they gave a star. See poll_assignment.
--
-- Where the places live:
--
--   * candidates.kind_value is an option's places, on an 'assignment'
--     question (optional there: an option with none has one place). A
--     suggestion or a correction carries them as `places`, where a budget's
--     option carries `cost`;
--   * the question takes no number of its own.
--
-- On any other written list that shows who voted, a reader can type places
-- into the *More results* modal and count; those are sent with the request
-- (`p_places`) and never stored. Places reach the browser beside each option
-- as `places` (open_poll_view, poll_page), as a cost does.
--
-- The answer names who gets what, so an assignment question must show who
-- voted (insert_poll_row refuses one that does not), and the count refuses a
-- poll that hides them.


ALTER TABLE "public"."polls"
  DROP CONSTRAINT "polls_kind_ck";

ALTER TABLE "public"."polls"
  ADD CONSTRAINT "polls_kind_ck"
    CHECK (("kind" = ANY (ARRAY['option'::"text", 'time'::"text", 'ranking'::"text", 'multiple'::"text", 'fractional'::"text", 'consensus'::"text", 'consensus_time'::"text", 'budget'::"text", 'assignment'::"text"])));

COMMENT ON COLUMN "public"."polls"."kind" IS 'What the question asks for, and so which result it opens on: ''option'' (the best option), ''time'' (the best time, on a calendar ballot whose options are the starts of meeting windows), ''ranking'' (the option ranking), ''multiple'' (multiple winners), ''fractional'' (fractional winners), ''consensus'' (the consensus option), ''consensus_time'' (the consensus time, on a calendar ballot), ''budget'' (a proportional budget, its options costed) or ''assignment'' (an option assignment, which shows who voted). Every kind but the two times is a written list. The other results are still offered. A setting, frozen at creation like mode.';

COMMENT ON COLUMN "public"."candidates"."kind_value" IS 'A number whose meaning belongs to the question''s kind: an option''s cost on a proportional budget, where every option has one, or its places on an option assignment, where none means one. Null on every other kind.';


-- The rules on a kind and its number: an assignment is one more kind that
-- takes no number of its own.
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

  if p_kind not in ('ranking', 'multiple') then
    raise exception 'Only an option ranking, multiple winners or a proportional budget takes a number%', v_which;
  end if;

  if p_value <> trunc(p_value) or p_value < 2 or p_value > poll_results_rows() then
    raise exception '%', format('Choose a number from 2 to %s%s', poll_results_rows(), v_which);
  end if;
end;
$$;


-- Which field of an option as sent holds its number on this kind: a budget's
-- `cost`, an assignment's `places`. Every other kind reads `cost`, so a cost
-- sent where none belongs is still refused by option_cost.
CREATE OR REPLACE FUNCTION "public"."option_number"("p_kind" "text", "p_option" "jsonb") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select case when p_kind = 'assignment' then p_option -> 'places' else p_option -> 'cost' end;
$$;

ALTER FUNCTION "public"."option_number"("text", "jsonb") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."option_number"("text", "jsonb") FROM PUBLIC;


-- The number an option is stored with, from whatever arrived (a JSON number
-- or nothing): a cost, required on a budget; places, optional on an
-- assignment; refused anywhere else, so a number is never stored where
-- nothing reads it.
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

  if p_kind = 'assignment' then
    if jsonb_typeof(p_cost) <> 'number' then
      raise exception 'The places for "%" are not a number', p_name;
    end if;
    v_cost := (p_cost #>> '{}')::numeric;
    perform validate_amount(v_cost, format('The places for "%s"', p_name));
    return v_cost;
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


-- A budget, an assignment and the other kinds that answer with several
-- options name no one winner, from the two options they are offered at.
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
    when v_kind in ('fractional', 'budget', 'assignment') then v_options < 2
    else true
  end;
end;
$$;


-- Each option carries its number into the poll: a budget's cost or an
-- assignment's places. An assignment names who gets what, so it is only
-- made on a question that shows who voted; both ways into a poll arrive here.
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


-- create_poll's p_option_costs carry each option's number, paired by
-- position: a budget's costs, or an assignment's places. Same arguments, so
-- its grant stands.
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
    case when v_kind in ('time', 'consensus_time') then p_schedule else null end,
    p_kind_value
  );

  perform insert_carried_weights(v_id, p_carried);

  return v_id;
end;
$$;

COMMENT ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb", "p_option_costs" numeric[]) IS 'Creates one poll with its options and its invitees. A time poll carries a schedule and options its creator''s browser enumerated from a painted calendar; the database stores it exactly as it stores any other poll. A time poll may collect its times from voters, through suggest_options. The kind also says which result the poll opens on; see polls.kind. p_carried makes it a sequential poll: see carried_weights. p_option_costs are each option''s number, paired by position with the options: a budget''s costs or an assignment''s places.';


-- A list of options, each with its number.
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

    perform insert_option(p_poll, v_name, v_item ->> 'description', option_number(p_poll.kind, v_item));
    v_added := v_added + 1;
  end loop;

  return v_added;
end;
$$;


-- The creator's correction can change an option's number, in place like a
-- name: a budget's cost or an assignment's places.
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


-- The assignment. Answers
--
--   { options, unplaced, received, places, voter_count, stars_shown }
--
-- `options` is every option counted, each with its `places` and the
-- `voters` it went to (by name, alphabetically; each with the `stars` they
-- gave it where the poll publishes its ballots), the fullest first.
-- `unplaced` is every voter given nothing, by name. `received` counts the
-- voters placed by the stars they gave their own option ({ "5": 3, ... }),
-- which is all a private ballot gives away about how well the assignment
-- went. `places` is every place counted, so a reader can see there were too
-- few.
--
-- Places are the options' own (candidates.kind_value, 1 where it has none),
-- with `p_places` ({ id: places }) over them, a key holding null putting an
-- option back to one. `p_excluded` leaves options off the ballot, as for
-- multiple winners.
--
-- The assignment is the one that, in order:
--
--   1. places the most voters, each on an option they gave at least one star
--      (a voter is never given an option they gave 0);
--   2. makes the product of the stars the placed voters gave their own
--      option as large as possible -- maximum Nash welfare;
--   3. gives the most stars in total;
--   4. is chosen at random, the same way every time: each voter-option pair
--      carries a number hashed from the poll, the ballot and the option.
--
-- With one option per voter the product is a sum of logarithms, one per
-- voter, so this is an assignment problem with capacities, solved exactly by
-- the Hungarian method: ballots are taken one at a time, each by the
-- cheapest path through the options to one with a place free, or to going
-- without (a column with room for everybody, worth nothing). Costs are pairs
-- of bigints compared in order, which is a total order Dijkstra is happy
-- with:
--
--   * the first is -(K + ln(stars) x 10^12, rounded), with K larger than every
--     voter's logarithms together, so a voter placed outweighs any product;
--   * the second is -(stars x S + r), r a 28-bit hash and S larger than every
--     voter's r together, so the total outweighs the draw.
--
-- A star level is always rounded to the same integer, so two assignments
-- whose products are equal cost exactly the same and the tie falls through
-- to the total and the draw; two whose products differ are far further apart
-- than the rounding.
CREATE OR REPLACE FUNCTION "public"."poll_assignment"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[], "p_places" "jsonb")
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
  v_stars int[];
  v_draw bigint[];
  n int;
  m int;
  w int;            -- the width of a row of v_stars: the options and going without
  v_none int;       -- the column for going without
  v_big bigint := 9223372036854775807;
  v_log bigint[] := array[0,
    round(ln(2::numeric) * 1e12)::bigint, round(ln(3::numeric) * 1e12)::bigint,
    round(ln(4::numeric) * 1e12)::bigint, round(ln(5::numeric) * 1e12)::bigint];
  k bigint;
  s bigint;
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
  c_hi bigint;
  c_lo bigint;
  r int;
  i int;
  j int;
  h int;
  t int;
  best int;
  v_score int;
  nd_hi bigint;
  nd_lo bigint;
  v_key text;
  v_value jsonb;
  v_result_options jsonb;
  v_unplaced jsonb;
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

  -- Bounded by the work the count does (about voters x voters x options),
  -- so a reader waits seconds at most.
  if n > 1000 then
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

  if n::bigint * n * (m + 1) > 4000000 then
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

  k := (n + 1)::bigint * 1700000000000;
  s := (n + 1)::bigint * 268435456;

  u_hi := array_fill(0::bigint, array[n]);
  u_lo := array_fill(0::bigint, array[n]);
  v_hi := array_fill(0::bigint, array[w]);
  v_lo := array_fill(0::bigint, array[w]);
  col := array_fill(0, array[n]);
  cnt := array_fill(0, array[w]);

  for r in 1 .. n loop
    d_hi := array_fill(v_big, array[w]);
    d_lo := array_fill(v_big, array[w]);
    way := array_fill(0, array[w]);
    done := array_fill(false, array[w]);

    -- From the new voter, at a potential of nothing, to every column.
    for h in 1 .. w loop
      if h = v_none then
        c_hi := 0; c_lo := 0;
      else
        v_score := v_stars[(r - 1) * m + h];
        continue when v_score = 0;
        c_hi := -(k + v_log[v_score]);
        c_lo := -(v_score * s + v_draw[(r - 1) * m + h]);
      end if;
      d_hi[h] := c_hi - v_hi[h];
      d_lo[h] := c_lo - v_lo[h];
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

      if best = v_none or cnt[best] < v_cap[best] then
        t := best;
        exit;
      end if;

      -- A full option: each voter in it could move on, at no cost to reach,
      -- since the edge that holds them there is tight.
      for i in 1 .. r - 1 loop
        continue when col[i] <> best;
        for h in 1 .. w loop
          continue when done[h];
          if h = v_none then
            c_hi := 0; c_lo := 0;
          else
            v_score := v_stars[(i - 1) * m + h];
            continue when v_score = 0;
            c_hi := -(k + v_log[v_score]);
            c_lo := -(v_score * s + v_draw[(i - 1) * m + h]);
          end if;
          nd_hi := d_hi[best] + c_hi - u_hi[i] - v_hi[h];
          nd_lo := d_lo[best] + c_lo - u_lo[i] - v_lo[h];
          if (nd_hi, nd_lo) < (d_hi[h], d_lo[h]) then
            d_hi[h] := nd_hi;
            d_lo[h] := nd_lo;
            way[h] := i;
          end if;
        end loop;
      end loop;
    end loop;

    -- Potentials, so every edge stays non-negative and the path just found
    -- is tight: a settled column comes down by how far short of the sink it
    -- was, and each voter reached through one goes up by the same.
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
             where col[g.v] = o.ord), '[]'::jsonb))
           order by cnt[o.ord] desc, o.ord), '[]'::jsonb)
  into v_result_options
  from unnest(v_options) with ordinality o(id, ord)
  join candidates c on c.id = o.id;

  select coalesce(jsonb_agg(jsonb_build_object('name', v_names[g.v])
                            order by lower(v_names[g.v]), g.v), '[]'::jsonb)
  into v_unplaced
  from generate_series(1, n) g(v)
  where col[g.v] = v_none;

  select coalesce(jsonb_object_agg(x.stars, x.voters), '{}'::jsonb)
  into v_received
  from (
    select v_stars[(g.v - 1) * m + col[g.v]] as stars, count(*) as voters
    from generate_series(1, n) g(v)
    where col[g.v] <> v_none
    group by 1
  ) x;

  return jsonb_build_object(
    'options', v_result_options,
    'unplaced', v_unplaced,
    'received', v_received,
    'places', (select sum(p::bigint) from unnest(v_cap) p),
    'voter_count', n,
    'stars_shown', v_poll.show_ballots);
end;
$$;

ALTER FUNCTION "public"."poll_assignment"("uuid", "uuid"[], "jsonb") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_assignment"("uuid", "uuid"[], "jsonb") FROM PUBLIC;


-- The two doors, gated exactly as the budget's are.
CREATE OR REPLACE FUNCTION "public"."get_poll_assignment"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}', "p_places" "jsonb" DEFAULT NULL)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_assignment(p_poll_id, p_excluded, p_places);
end;
$$;

ALTER FUNCTION "public"."get_poll_assignment"("uuid", "uuid"[], "jsonb") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."get_poll_assignment"("uuid", "uuid"[], "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_assignment"("uuid", "uuid"[], "jsonb") TO "authenticated";


CREATE OR REPLACE FUNCTION "public"."open_poll_assignment"(
    "p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}', "p_places" "jsonb" DEFAULT NULL)
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_assignment(p_poll_id, p_excluded, p_places);
end;
$$;

ALTER FUNCTION "public"."open_poll_assignment"("uuid", "uuid"[], "jsonb") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."open_poll_assignment"("uuid", "uuid"[], "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_assignment"("uuid", "uuid"[], "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_assignment"("uuid", "uuid"[], "jsonb") TO "authenticated";


-- The tally carries the assignment on an assignment question, and says
-- whether the poll shows who voted, which is what decides whether an
-- assignment can be offered at all. An assignment too large to count leaves
-- the page on STAR's winner rather than taking the tally down with it.
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


-- An option's number travels beside it, through both reads a page is drawn
-- from: `cost` on a budget, `places` on an assignment.
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
    'cost', case when v_poll.kind = 'budget' then c.kind_value end,
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
          'cost', case when v_poll.kind = 'budget' then c.kind_value end,
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

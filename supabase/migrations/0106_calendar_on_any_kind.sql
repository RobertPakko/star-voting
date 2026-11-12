-- A calendar is a ballot, not a kind of question. A question's kind says
-- only which result it opens on; whether its options are the windows of a
-- painted calendar is whether it has a schedule. So the three time kinds fold
-- into the kinds they were the calendar copies of:
--
--   time             -> option
--   consensus_time   -> consensus
--   consensus_times  -> consensus_winners
--
-- and every kind may now be a calendar except a proportional budget, whose
-- options are bought, which a meeting time is not. An option ranking of
-- times, several winning times, a fractional split of meetings and an
-- assignment of interview slots become things a question can ask for.
--
-- Two new keys in a schedule, both optional, so every existing schedule is
-- still valid and means what it did:
--
--   step    minutes between one window's start and the next, a whole number
--           of granules no longer than the meeting. Missing means every
--           granule. The browser enumerates the windows, so this is where it
--           reads how far apart to start them.
--   places  on an option assignment, the places each window is given.
--
-- Every function that named the time kinds is restated from its latest
-- definition, changed only there; is_calendar_kind goes, since every caller
-- now asks the schedule.

ALTER TABLE "public"."polls"
  DROP CONSTRAINT "polls_kind_ck",
  DROP CONSTRAINT "polls_schedule_ck",
  DROP CONSTRAINT "polls_kind_value_ck";

UPDATE "public"."polls"
SET "kind" = CASE "kind"
               WHEN 'time' THEN 'option'
               WHEN 'consensus_time' THEN 'consensus'
               WHEN 'consensus_times' THEN 'consensus_winners'
             END
WHERE "kind" IN ('time', 'consensus_time', 'consensus_times');

ALTER TABLE "public"."polls"
  ADD CONSTRAINT "polls_kind_ck"
    CHECK (("kind" = ANY (ARRAY['option'::"text", 'ranking'::"text", 'multiple'::"text", 'fractional'::"text", 'consensus'::"text", 'budget'::"text", 'assignment'::"text", 'consensus_winners'::"text"]))),
  ADD CONSTRAINT "polls_schedule_ck"
    CHECK ((("schedule" IS NULL) OR ("kind" <> 'budget'::"text"))),
  ADD CONSTRAINT "polls_kind_value_ck"
    CHECK ((("kind_value" IS NULL) OR (("kind_value" = "trunc"("kind_value")) AND ((("kind" = ANY (ARRAY['ranking'::"text", 'multiple'::"text", 'consensus_winners'::"text"])) AND ("kind_value" >= (2)::numeric)) OR (("kind" = ANY (ARRAY['budget'::"text", 'assignment'::"text"])) AND ("kind_value" >= (1)::numeric))))));

COMMENT ON COLUMN "public"."polls"."kind" IS 'What the question asks for, and so which result it opens on: ''option'' (the best option), ''ranking'' (the option ranking), ''multiple'' (multiple winners), ''fractional'' (fractional winners), ''consensus'' (the consensus option), ''budget'' (a proportional budget, its options costed), ''assignment'' (an option assignment, which shows who voted) or ''consensus_winners'' (consensus winners). Whether the ballot is a calendar is whether the question has a schedule, which every kind but a budget may. The other results are still offered. A setting, frozen at creation like mode.';

COMMENT ON COLUMN "public"."polls"."schedule" IS 'Present exactly when the ballot is a calendar, whose options are the starts of meeting windows: the UTC offset, the axis, the meeting length in granules, the granularity, and optionally the step between window starts and an assignment''s places per window. See validate_schedule.';

DROP FUNCTION "public"."is_calendar_kind"("text");


-- The one kind a calendar cannot be.
CREATE OR REPLACE FUNCTION "public"."validate_calendar_kind"("p_kind" "text", "p_question" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
begin
  if p_kind = 'budget' then
    raise exception 'A proportional budget cannot be a time poll%',
      case when p_question is null then '' else format(' (question %s)', p_question) end;
  end if;
end;
$$;

ALTER FUNCTION "public"."validate_calendar_kind"("text", integer) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."validate_calendar_kind"("text", integer) FROM PUBLIC;


CREATE OR REPLACE FUNCTION public.create_poll(p_title text, p_description text, p_options text[], p_emails text[], p_mode text DEFAULT 'invite'::text, p_show_voters boolean DEFAULT true, p_show_ballots boolean DEFAULT false, p_option_descriptions text[] DEFAULT NULL::text[], p_solicit_options boolean DEFAULT false, p_kind text DEFAULT 'option'::text, p_schedule jsonb DEFAULT NULL::jsonb, p_kind_value numeric DEFAULT NULL::numeric, p_carried jsonb DEFAULT NULL::jsonb, p_option_costs numeric[] DEFAULT NULL::numeric[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- A schedule is what makes a question a calendar, whatever it asks for.
  -- A time poll collecting its times starts with whatever its creator
  -- painted, which may be nothing at all: insert_poll_row applies the
  -- two-option floor only to a poll that is not collecting, and
  -- finalize_options applies it again when the list becomes a ballot.
  if p_schedule is not null then
    perform validate_calendar_kind(v_kind);
    perform validate_schedule(p_schedule);
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
    p_schedule,
    p_kind_value
  );

  perform insert_carried_weights(v_id, p_carried);

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_poll_group(p_title text, p_description text, p_questions jsonb, p_emails text[], p_mode text DEFAULT 'invite'::text, p_show_voters boolean DEFAULT true, p_show_ballots boolean DEFAULT false, p_solicit_options boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- "which film?" (the best option), "when?" (the best option on a
    -- calendar) and "which three snacks?" (multiple winners). The checks are `create_poll`'s,
    -- said again here because this is the other way into `insert_poll_row`
    -- and the two must not disagree about what a kind or a schedule is.
    v_kind := coalesce(nullif(trim(coalesce(v_question ->> 'kind', '')), ''), 'option');
    if jsonb_typeof(v_question -> 'kind_value') not in ('number', 'null') then
      raise exception 'The number on question % is not a number', i + 1;
    end if;
    v_kind_value := (v_question ->> 'kind_value')::numeric;
    perform validate_kind(v_kind, v_kind_value, i + 1);

    v_schedule := nullif(v_question -> 'schedule', 'null'::jsonb);
    if v_schedule is not null then
      perform validate_calendar_kind(v_kind, i + 1);
      perform validate_schedule(v_schedule);
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
      v_schedule,
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
$function$;

CREATE OR REPLACE FUNCTION public.creator_add_option(p_poll_id uuid, p_name text, p_description text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if v_poll.schedule is not null then
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
$function$;

CREATE OR REPLACE FUNCTION public.creator_edit_options(p_poll_id uuid, p_options jsonb DEFAULT '[]'::jsonb, p_remove uuid[] DEFAULT '{}'::uuid[], p_correct jsonb DEFAULT '[]'::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if jsonb_array_length(p_correct) > 0 and v_poll.schedule is not null then
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

CREATE OR REPLACE FUNCTION public.poll_consensus_winners(p_poll_id uuid, p_excluded uuid[], p_winners integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

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
    when v_kind in ('fractional', 'budget', 'assignment') then v_options < 2
    else true
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.poll_winner_name(p_poll_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pool uuid[];
  v_winner uuid;
  v_kind text;
begin
  -- No ballots, no election. The caller checks this first anyway; the point
  -- of repeating it is that star_round() would otherwise elect the
  -- highest-scoring option of an empty tally.
  if not exists (select 1 from ballots where poll_id = p_poll_id) then
    return null;
  end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into v_pool
  from candidates where poll_id = p_poll_id;

  if coalesce(array_length(v_pool, 1), 0) = 0 then
    return null;
  end if;

  select kind into v_kind from polls where id = p_poll_id;

  if v_kind = 'consensus' and array_length(v_pool, 1) >= 2 then
    -- The same answer the tally carries as `kind_result`, so the badge and
    -- the green bar never disagree.
    v_winner := (poll_consensus(p_poll_id, '{}') ->> 'winner_id')::uuid;
  else
    -- The head round is the whole of STAR: the score round, its tie-breaks
    -- and the runoff, at the ballots' weights on a sequential question.
    v_winner := (poll_round(p_poll_id, v_pool) ->> 'winner_id')::uuid;
  end if;

  if v_winner is null then
    -- A runoff level on preference, on points and on five-star votes alike.
    -- The app reports the tie rather than inventing a winner.
    return null;
  end if;

  return (select name from candidates where id = v_winner);
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
begin
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  select closed_at is not null, mode, options_edited_after_votes, votes_after_reveal,
         kind, kind_value, show_voters, schedule is not null
  into v_closed, v_mode, v_edited, v_late, v_kind, v_kind_value, v_voters_shown, v_calendar
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
    when v_kind = 'budget' and v_option_count >= 2 then poll_proportional_budget(p_poll_id, '{}', null, null)
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
    'voters_shown', v_voters_shown
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.validate_kind(p_kind text, p_value numeric, p_question integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  v_which text := case when p_question is null then '' else format(' on question %s', p_question) end;
begin
  if p_kind is null or p_kind not in ('option', 'ranking', 'multiple', 'fractional', 'consensus', 'budget', 'assignment', 'consensus_winners') then
    raise exception 'Unknown poll kind%', v_which;
  end if;

  if p_kind = 'budget' then
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
    raise exception 'Only an option ranking, multiple winners, consensus winners, a proportional budget or an option assignment takes a number%', v_which;
  end if;

  if p_value <> trunc(p_value) or p_value < 2 or p_value > poll_results_rows() then
    raise exception '%', format('Choose a number from 2 to %s%s', poll_results_rows(), v_which);
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.validate_schedule(p_schedule jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  v_start text := p_schedule #>> '{window,start}';
  v_end text := p_schedule #>> '{window,end}';
  v_slots int;
  v_granularity int;
  v_step int;
begin
  if p_schedule is null or jsonb_typeof(p_schedule) <> 'object' then
    raise exception 'A time poll needs a schedule';
  end if;

  -- A fixed offset, never a named zone. A named zone spanning a DST
  -- transition gives one day 23 or 25 hours and a 1am that happens twice or
  -- not at all, which makes the generated option names ambiguous in precisely
  -- the way declaring a timezone was meant to prevent.
  if coalesce(p_schedule ->> 'timezone', '') !~ '^[+-][0-9]{2}:[0-9]{2}$' then
    raise exception 'A schedule''s timezone is a fixed UTC offset, like -07:00';
  end if;

  -- 24:00 is allowed as a time of day here, and only ever as the end: a
  -- window that runs to midnight is an ordinary thing to want, and '00:00'
  -- would say the day before's midnight. The v_end > v_start check below is
  -- what keeps it out of the start.
  if coalesce(v_start, '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
     or coalesce(v_end, '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' then
    raise exception 'A schedule''s daily window is two times, like 08:00 and 22:00';
  end if;

  if v_end <= v_start then
    raise exception 'A schedule''s daily window has to end after it starts';
  end if;

  -- jsonb_typeof rather than a cast, because `'"3"'::jsonb ->> …` casts
  -- happily and a string where a number belongs is exactly the kind of drift
  -- this is here to catch.
  if jsonb_typeof(p_schedule -> 'granularity') <> 'number'
     or jsonb_typeof(p_schedule -> 'desired_slots') <> 'number' then
    raise exception 'A schedule''s granularity and desired_slots are numbers';
  end if;

  v_granularity := (p_schedule ->> 'granularity')::int;
  v_slots := (p_schedule ->> 'desired_slots')::int;

  -- The calendar draws a row per granule, and a granule that does not divide
  -- the hour draws a grid whose lines do not line up with the labels beside
  -- it. The same rule @mantine/schedule applies to intervalMinutes.
  if v_granularity < 1 or (60 % v_granularity <> 0 and v_granularity % 60 <> 0) then
    raise exception 'A schedule''s granularity divides an hour evenly, or is a whole number of hours';
  end if;

  if v_slots < 1 then
    raise exception 'A meeting is at least one granule long';
  end if;

  -- How far apart the windows start. Missing is every granule, which is
  -- every poll made before the step could be chosen. A step longer than the
  -- meeting would leave painted hours no window covers.
  if p_schedule ? 'step' then
    if jsonb_typeof(p_schedule -> 'step') <> 'number' then
      raise exception 'A schedule''s step is a number';
    end if;
    v_step := (p_schedule ->> 'step')::int;
    if v_step::numeric <> (p_schedule ->> 'step')::numeric
       or v_step < v_granularity or v_step % v_granularity <> 0
       or v_step > v_slots * v_granularity then
      raise exception 'A schedule''s step is a whole number of granules, no longer than the meeting';
    end if;
  end if;

  -- The places each window has on an option assignment, given to every
  -- window painted or suggested later. The windows carry their own (as
  -- candidates.kind_value); this is what a new one is given.
  if p_schedule ? 'places' then
    if jsonb_typeof(p_schedule -> 'places') <> 'number' then
      raise exception 'A schedule''s places are a number';
    end if;
    perform validate_amount((p_schedule ->> 'places')::numeric, 'The places per time');
  end if;
end;
$function$;

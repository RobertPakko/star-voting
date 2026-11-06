-- Consensus option / time: the option whose lowest score is as high as it can
-- be (maximin), with STAR run between the options that share that score.
--
--   consensus       the consensus option, on a written list
--   consensus_time  the consensus time, on a calendar ballot
--
-- `consensus_time` is the second kind with a calendar ballot, so every rule
-- that asked `kind = 'time'` about the ballot now asks about both: the
-- schedule constraint, create_poll, create_poll_group, and the two creator
-- doors that refuse a typed name on a calendar. Their definitions are copied
-- from the latest migration that wrote them, changed only there.
--
-- A ballot that gives every option 0 stars is left out of the count. It
-- prefers nothing, and kept in it would hold every option's lowest score at 0
-- and hand the choice to plain STAR: on a time poll, anybody who opened the
-- calendar and painted nothing would do that.

ALTER TABLE "public"."polls"
  DROP CONSTRAINT "polls_kind_ck",
  DROP CONSTRAINT "polls_schedule_ck";

ALTER TABLE "public"."polls"
  ADD CONSTRAINT "polls_kind_ck"
    CHECK (("kind" = ANY (ARRAY['option'::"text", 'time'::"text", 'ranking'::"text", 'multiple'::"text", 'fractional'::"text", 'consensus'::"text", 'consensus_time'::"text"]))),
  ADD CONSTRAINT "polls_schedule_ck"
    CHECK (((("kind" <> ALL (ARRAY['time'::"text", 'consensus_time'::"text"])) AND ("schedule" IS NULL)) OR (("kind" = ANY (ARRAY['time'::"text", 'consensus_time'::"text"])) AND ("schedule" IS NOT NULL))));

COMMENT ON COLUMN "public"."polls"."kind" IS 'What the question asks for, and so which result it opens on: ''option'' (the best option), ''time'' (the best time, on a calendar ballot whose options are the starts of meeting windows), ''ranking'' (the option ranking), ''multiple'' (multiple winners), ''fractional'' (fractional winners), ''consensus'' (the consensus option) or ''consensus_time'' (the consensus time, on a calendar ballot). Every kind but the two times is a written list. The other results are still offered. A setting, frozen at creation like mode.';


-- The consensus: every option judged by the fewest stars any counted ballot
-- gave it (its floor), the highest floor wins, and options sharing it go to
-- STAR between themselves (star_round over just those, so a runoff level on
-- every rule leaves no winner, as STAR's does).
--
-- Answers { winner_id, floor, option_count, tied_count, voter_count,
-- blank_ballots, finalists, finalist_names, runoff, options }: `options` is
-- the poll_results_rows() options with the highest floors, the winner first
-- and the finalists next among those that share it, then by total stars and
-- name. `finalists`, `finalist_names` and `runoff` are the STAR round's
-- among the tied, and empty or null where one option had the highest floor.
--
-- The reader can take options out (`p_excluded`), as for multiple winners:
-- the count runs as though they had never been on the ballot, which also
-- decides which ballots are blank. Nothing is stored.
CREATE OR REPLACE FUNCTION "public"."poll_consensus"("p_poll_id" "uuid", "p_excluded" "uuid"[])
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_pool uuid[];
  v_all int;
  v_counted int;
  v_blank int;
  v_floor int;
  v_tied uuid[];
  v_round jsonb;
  v_winner uuid;
  v_finalists uuid[] := '{}';
  v_finalist_names jsonb;
  v_options jsonb;
begin
  -- A poll has at most a few hundred options; anything longer is not a list
  -- a reader built by pressing buttons.
  if coalesce(array_length(p_excluded, 1), 0) > 1000 then
    raise exception 'Too many options left out';
  end if;

  select count(*) into v_all from ballots where poll_id = p_poll_id;
  if v_all = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into v_pool
  from candidates
  where poll_id = p_poll_id
    and not (id = any(coalesce(p_excluded, '{}'::uuid[])));

  if cardinality(v_pool) = 0 then
    raise exception 'Every option has been left out';
  end if;

  -- The ballots that count: those giving some option still in the pool a star.
  drop table if exists _consensus_ballots;
  create temp table _consensus_ballots on commit drop as
  select b.id as bid
  from ballots b
  where b.poll_id = p_poll_id
    and exists (
      select 1 from scores s
      where s.ballot_id = b.id and s.candidate_id = any(v_pool) and s.score > 0
    );

  select count(*) into v_counted from _consensus_ballots;
  v_blank := v_all - v_counted;

  -- Nobody gave anything a star: every floor is 0 whichever ballots count,
  -- so count them all and leave nobody out.
  if v_counted = 0 then
    insert into _consensus_ballots select id from ballots where poll_id = p_poll_id;
    v_counted := v_all;
    v_blank := 0;
  end if;

  -- One score per option per ballot is an invariant (fill_scores_for_new_option),
  -- but a missing score reads as 0 rather than as no opinion, as the tally reads it.
  drop table if exists _consensus;
  create temp table _consensus on commit drop as
  select
    c.id as cid,
    c.name,
    (select min(coalesce(s.score, 0))
       from _consensus_ballots cb
       left join scores s on s.ballot_id = cb.bid and s.candidate_id = c.id)::int as floor,
    (select coalesce(sum(s.score), 0) from scores s where s.candidate_id = c.id)::int as total
  from candidates c
  where c.id = any(v_pool);

  select max(floor) into v_floor from _consensus;
  select array_agg(cid) into v_tied from _consensus where floor = v_floor;

  if cardinality(v_tied) = 1 then
    v_winner := v_tied[1];
  else
    v_round := star_round(p_poll_id, v_tied);
    v_winner := (v_round ->> 'winner_id')::uuid;
    select coalesce(array_agg(x::uuid order by ord), '{}'::uuid[]) into v_finalists
    from jsonb_array_elements_text(v_round -> 'finalists') with ordinality f(x, ord);
  end if;

  select coalesce(jsonb_agg(c.name order by f.ord), '[]'::jsonb) into v_finalist_names
  from unnest(v_finalists) with ordinality f(id, ord)
  join _consensus c on c.cid = f.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cid,
    'name', name,
    'floor', floor,
    'total_score', total
  ) order by rn), '[]'::jsonb)
  into v_options
  from (
    select *, row_number() over (
      order by floor desc,
               (case when cid = v_winner then 0 else 1 end),
               (case when cid = any(v_finalists) then 0 else 1 end),
               total desc, name, cid) as rn
    from _consensus
  ) t
  where rn <= poll_results_rows();

  return jsonb_build_object(
    'winner_id', v_winner,
    'floor', v_floor,
    'option_count', cardinality(v_pool),
    'tied_count', cardinality(v_tied),
    'voter_count', v_counted,
    'blank_ballots', v_blank,
    'finalists', to_jsonb(v_finalists),
    'finalist_names', v_finalist_names,
    'runoff', case when cardinality(v_finalists) = 2 then v_round -> 'runoff' else null end,
    'options', v_options
  );
end;
$$;

ALTER FUNCTION "public"."poll_consensus"("uuid", "uuid"[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_consensus"("uuid", "uuid"[]) FROM PUBLIC;


-- The two doors, gated exactly as the full ranking is: the floors disclose
-- more than the tally (one voter's lowest score on each option).
CREATE OR REPLACE FUNCTION "public"."get_poll_consensus"("p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}')
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_consensus(p_poll_id, p_excluded);
end;
$$;

ALTER FUNCTION "public"."get_poll_consensus"("uuid", "uuid"[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."get_poll_consensus"("uuid", "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_consensus"("uuid", "uuid"[]) TO "authenticated";


CREATE OR REPLACE FUNCTION "public"."open_poll_consensus"("p_poll_id" "uuid", "p_excluded" "uuid"[] DEFAULT '{}')
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_consensus(p_poll_id, p_excluded);
end;
$$;

ALTER FUNCTION "public"."open_poll_consensus"("uuid", "uuid"[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."open_poll_consensus"("uuid", "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_consensus"("uuid", "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_consensus"("uuid", "uuid"[]) TO "authenticated";


-- The kinds a question may be.
CREATE OR REPLACE FUNCTION "public"."validate_kind"("p_kind" "text", "p_value" numeric, "p_question" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_which text := case when p_question is null then '' else format(' on question %s', p_question) end;
begin
  if p_kind is null or p_kind not in ('option', 'time', 'ranking', 'multiple', 'fractional', 'consensus', 'consensus_time') then
    raise exception 'Unknown poll kind%', v_which;
  end if;

  if p_value is null then
    return;
  end if;

  if p_kind not in ('ranking', 'multiple') then
    raise exception 'Only an option ranking or multiple winners takes a number%', v_which;
  end if;

  if p_value <> trunc(p_value) or p_value < 2 or p_value > poll_results_rows() then
    raise exception '%', format('Choose a number from 2 to %s%s', poll_results_rows(), v_which);
  end if;
end;
$$;


-- The calendar ballot is asked of both time kinds, at both ways in.
CREATE OR REPLACE FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_option_descriptions" "text"[] DEFAULT NULL::"text"[], "p_solicit_options" boolean DEFAULT false, "p_kind" "text" DEFAULT 'option'::"text", "p_schedule" "jsonb" DEFAULT NULL::"jsonb", "p_kind_value" numeric DEFAULT NULL::numeric) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_opts jsonb;
  v_mails text[];
  v_kind text := coalesce(p_kind, 'option');
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
           jsonb_build_object('name', o, 'description', p_option_descriptions[ord])
           order by ord), '[]'::jsonb)
  into v_opts
  from unnest(coalesce(p_options, array[]::text[])) with ordinality as t(o, ord);

  return insert_poll_row(
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
    if v_kind in ('time', 'consensus_time') then
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
      case when v_kind in ('time', 'consensus_time') then v_schedule else null end,
      v_kind_value
    );

    if i = 0 then
      v_first := v_id;
    end if;
  end loop;

  return v_first;
end;
$$;


-- A typed name is refused on both calendars.
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

  if v_poll.kind in ('time', 'consensus_time') then
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
  set name = w.name, description = w.description
  from (
    select (x ->> 'id')::uuid as id,
           nullif(trim(coalesce(x ->> 'name', '')), '') as name,
           nullif(trim(coalesce(x ->> 'description', '')), '') as description
    from jsonb_array_elements(p_correct) x
  ) w
  where c.id = w.id
    and c.poll_id = p_poll_id
    and (c.name, c.description) is distinct from (w.name, w.description);

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


-- The tally carries the consensus where the question asked for it, from
-- two options (with two, the consensus can still differ from STAR's winner).
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

  -- Names and totals for the whole poll, for the score-round list. star_round
  -- recomputes its own pool-scoped copy; these two never disagree, since a
  -- total is a per-option sum that no elimination can change.
  drop table if exists _tally;
  create temp table _tally on commit drop as
  select
    c.id as cid,
    c.name,
    c.description,
    coalesce(sum(s.score), 0)::int as total
  from candidates c
  left join scores s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
  group by c.id, c.name, c.description;

  select coalesce(array_agg(cid), '{}'::uuid[]), count(*)::int
  into v_pool, v_option_count
  from _tally;

  -- The head round is the whole of STAR: the score round, its tie-breaks and
  -- the runoff. Everything below first place is poll_ranking's, and is not
  -- computed here unless the question asked for it.
  v_head := star_round(p_poll_id, v_pool);

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
    'average_score', round(total::numeric / v_voted, 2)
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
    'kind_result', v_kind_result
  );
end;
$$;

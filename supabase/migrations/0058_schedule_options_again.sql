-- Everything 0056 was meant to say, said again at a version the integration
-- has not seen.
--
-- **Nothing here is new.** Every definition below is copied verbatim out of
-- `0056_baseline.sql`, which is the schema this repository already claims to
-- have. On a database that is up to date this migration is a no-op that
-- replaces seven functions with the definitions they already hold. It exists
-- because the live project is *not* up to date, and the reason it is not is
-- worth writing down.
--
-- **Two migrations were numbered 0056, and a version is applied once.** The
-- integration records the number in front of a migration's name, not its
-- filename: `0056_schedule_day_windows.sql` reached `main` first and was
-- applied, which put `0056` in `supabase_migrations.schema_migrations`.
-- `0056_schedule_options.sql` replaced it in the very next commit -- a
-- different migration wearing the same number -- and was skipped as already
-- applied. So was `0056_baseline.sql`, the squash, for the same reason: a
-- third file at 0056. Only `0057_scheduled_jobs.sql` got through, being the
-- one file in that squash with a number nobody had used.
--
-- The symptom was a poll that could not be created: `suggest_options` did not
-- exist on the live project, and `create_poll` still carried the refusal
-- 0056_schedule_options lifted -- `A time poll cannot collect its times from
-- voters` -- so a time poll collecting its times was rejected by a database
-- the repository, the tests and the front end all agreed should accept it.
-- The tests could not see it: `test/build-db.sh` builds a fresh database from
-- every file in `supabase/migrations/`, so the baseline is always applied
-- there and the suite has always run against the schema this file is now
-- restoring.
--
-- **The rule this leaves behind: a version number is used once, ever.** Not
-- once per name -- once. A migration replaced before it is applied does not
-- give its number back, because the record of what has run is a list of
-- numbers, and there is no way to say "that 0056, not this one". Renumber
-- instead, even when the file it replaces has never left your branch.
--
-- The seven functions are the six `0056_schedule_options.sql` wrote plus
-- `validate_schedule`, which 0056_schedule_day_windows replaced with a version
-- that also accepts `day_windows` and `timezone_label`. Those two keys are
-- gone from the app and from the baseline, and a schedule carrying either has
-- always been stored and ignored, so restoring the stricter definition takes
-- nothing away from any poll that exists.
--
-- There is no down file. What it would restore is the state this repairs.



-- --------------------------------------------------------------------------
-- The grid a poll can be drawn on, without the two keys 0056_schedule_day_windows added.

CREATE OR REPLACE FUNCTION "public"."validate_schedule"("p_schedule" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $_$
declare
  v_start text := p_schedule #>> '{window,start}';
  v_end text := p_schedule #>> '{window,end}';
  v_slots int;
  v_granularity int;
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
end;
$_$;

ALTER FUNCTION "public"."validate_schedule"("p_schedule" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."validate_schedule"("p_schedule" "jsonb") IS 'Raises unless the jsonb handed in is a schedule a calendar can be drawn from. The front end enumerates the options, so nothing here can check that they agree with it; what it can check is that the grid itself is describable. Internal.';


-- --------------------------------------------------------------------------
-- A list of options added in one statement, which is what makes a painted afternoon atomic.

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

    perform insert_option(p_poll, v_name, v_item ->> 'description');
    v_added := v_added + 1;
  end loop;

  return v_added;
end;
$$;

ALTER FUNCTION "public"."insert_options"("p_poll" "public"."polls", "p_options" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."insert_options"("p_poll" "public"."polls", "p_options" "jsonb") IS 'Adds a list of options to a poll in one go, skipping the names already on it, and answers how many were added. Internal: the caller has already decided it may write to this poll. The atomicity is the point -- a voter painting an afternoon of a time poll adds a dozen windows, and a run that stopped halfway would leave the ballot offering a day nobody meant.';

REVOKE ALL ON FUNCTION "public"."insert_options"("p_poll" "public"."polls", "p_options" "jsonb") FROM PUBLIC;


-- --------------------------------------------------------------------------
-- A voter adding times to a poll that is collecting them.

CREATE OR REPLACE FUNCTION "public"."suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  -- Same "not found" for a poll that exists but isn't yours: whether a given
  -- id is a real poll is not something an outsider needs to learn.
  if not (
    v_poll.created_by = auth.uid()
    or exists (
      select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email
    )
  ) then
    raise exception 'Poll not found';
  end if;

  if v_poll.mode <> 'invite' then
    raise exception 'This poll is open to anyone with the link, so its options are suggested through that link';
  end if;

  perform assert_collecting_options(v_poll);
  return insert_options(v_poll, p_options);
end;
$$;

ALTER FUNCTION "public"."suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") IS 'Suggests several options at once to a poll that is collecting them, from inside the poll. One transaction; names already on the list are skipped. This is how a voter adds times to a time poll, where one gesture is a dozen windows.';

REVOKE ALL ON FUNCTION "public"."suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") TO "authenticated";


-- --------------------------------------------------------------------------
-- The same, through an open poll’s link.

CREATE OR REPLACE FUNCTION "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  perform assert_collecting_options(v_poll);
  return insert_options(v_poll, p_options);
end;
$$;

ALTER FUNCTION "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") IS 'The same, through an open poll''s link. Reachable by anon, like every other open_poll_ function, and refused on any poll that is not open or is no longer collecting.';

REVOKE ALL ON FUNCTION "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") TO "authenticated";


-- --------------------------------------------------------------------------
-- The creator’s correction to a list that is already a ballot.

CREATE OR REPLACE FUNCTION "public"."creator_add_options"("p_poll_id" "uuid", "p_options" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  -- The trigger says this too, and would refuse the insert on its own. Saying
  -- it here is what makes the message the one the creator can act on.
  if exists (select 1 from ballots where poll_id = p_poll_id) then
    raise exception 'Cannot change the options of a poll that already has votes';
  end if;

  return insert_options(v_poll, p_options);
end;
$$;

ALTER FUNCTION "public"."creator_add_options"("p_poll_id" "uuid", "p_options" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."creator_add_options"("p_poll_id" "uuid", "p_options" "jsonb") IS 'The creator''s correction to an option list that is already a ballot, applied in one go rather than one option per request. Allowed on a time poll, where the names come from a painted calendar; the singular creator_add_option is the typed-name path and still refuses one.';

REVOKE ALL ON FUNCTION "public"."creator_add_options"("p_poll_id" "uuid", "p_options" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."creator_add_options"("p_poll_id" "uuid", "p_options" "jsonb") TO "authenticated";


-- --------------------------------------------------------------------------
-- Which drops the refusal that started all this: a time poll may collect its times.

CREATE OR REPLACE FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_option_descriptions" "text"[] DEFAULT NULL::"text"[], "p_solicit_options" boolean DEFAULT false, "p_kind" "text" DEFAULT 'option'::"text", "p_schedule" "jsonb" DEFAULT NULL::"jsonb") RETURNS "uuid"
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

  if v_kind not in ('option', 'time') then
    raise exception 'Unknown poll kind';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'Title is required';
  end if;

  if v_kind = 'time' then
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
    case when v_kind = 'time' then p_schedule else null end
  );
end;
$$;

ALTER FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb") IS 'Creates one poll with its options and its invitees. A time poll carries a schedule and options its creator''s browser enumerated from a painted calendar; the database stores it exactly as it stores any other poll. A time poll may collect its times from voters, through suggest_options.';

REVOKE ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb") TO "authenticated";


-- --------------------------------------------------------------------------
-- And a group may hold a calendar among its questions.

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

    -- What this question is choosing between, question by question: a group
    -- may ask "what are we watching?" and "when?" and the two are not the
    -- same shape of ballot. The checks are `create_poll`'s, said again here
    -- because this is the other way into `insert_poll_row` and the two must
    -- not disagree about what a schedule is.
    v_kind := coalesce(nullif(trim(coalesce(v_question ->> 'kind', '')), ''), 'option');
    if v_kind not in ('option', 'time') then
      raise exception 'Question % is of an unknown kind', i + 1;
    end if;

    v_schedule := nullif(v_question -> 'schedule', 'null'::jsonb);
    if v_kind = 'time' then
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
      case when v_kind = 'time' then v_schedule else null end
    );

    if i = 0 then
      v_first := v_id;
    end if;
  end loop;

  return v_first;
end;
$$;

ALTER FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) OWNER TO "postgres";

COMMENT ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) IS 'Creates a poll that asks several questions: one poll row per question, sharing a group, a title, a description, an invite list and their settings. One transaction. A question may be a time poll, by carrying a kind and a schedule of its own. A soliciting group collects options question by question and opens all of them at once; see finalize_options.';

REVOKE ALL ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) TO "authenticated";

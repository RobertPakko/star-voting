-- Collecting times from voters, and a time poll among several questions.
--
-- Three things were refused on a `time` poll and are not any more, and one new
-- operation is what unblocks the first of them:
--
--   * **Options collected from voters.** `create_poll` refused
--     `solicit_options` on a time poll for one reason: a voter "adding
--     Thursday" adds a dozen options -- one per window start -- and the
--     suggestion path inserted one at a time, so a run that failed halfway
--     left a Thursday with morning windows and no afternoon. `insert_options`
--     below is that insertion made atomic, and the three ways into
--     `candidates` each gain a plural door onto it.
--
--   * **A time poll in a group.** `create_poll_group` took no kind, so every
--     question it made was an ordinary one. It now reads `kind` and
--     `schedule` off each question, exactly as `create_poll` reads them off
--     its arguments, and hands them to the same `insert_poll_row`. A poll may
--     therefore ask "what are we watching?" and "when?" in one sitting.
--
--   * **The creator correcting a time poll's options.** `creator_add_option`
--     still refuses -- it is the typed-name path, and a hand-typed name is one
--     the calendar cannot draw and the window rule cannot score. Its plural
--     sibling does not, because the names it is given come from a painted
--     calendar rather than from a text box.
--
-- Nothing about the tally, the policies or the reads changes. A time poll is
-- still a poll whose options happen to be the start of a meeting window.


-- ---------------------------------------------------------------------------
-- 1. Adding options in one go
-- ---------------------------------------------------------------------------

-- The whole point of it: a run of `insert_option` calls inside one function is
-- one statement to the caller, so it commits whole or not at all. A voter who
-- marks Thursday afternoon on a three-hour poll is adding five options, and
-- five separate round trips could stop after two -- leaving a Thursday the
-- ballot would offer and the voter never meant.
--
-- **A name already on the list is skipped rather than refused.** That is the
-- one rule here that `insert_option` does not already apply, and it is what
-- makes a batch a sensible thing to send: two voters painting overlapping
-- afternoons are not making a mistake, and there is nothing the second of them
-- could do about being told so. The singular path still refuses a duplicate by
-- name, because there the duplicate *is* the whole of what was asked for and
-- the message is the answer.
--
-- Returns how many were actually added, which is what the caller says on
-- screen: "added 5 times" against a painting that asked for eight is the
-- difference between a batch that worked and one that mostly didn't.
create or replace function "public"."insert_options"("p_poll" "public"."polls", "p_options" jsonb) returns int
    language plpgsql security definer
    set "search_path" to 'public'
    as $$
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

alter function "public"."insert_options"("p_poll" "public"."polls", "p_options" jsonb) owner to "postgres";

revoke all on function "public"."insert_options"("p_poll" "public"."polls", "p_options" jsonb) from public;

comment on function "public"."insert_options"("p_poll" "public"."polls", "p_options" jsonb) is
  'Adds a list of options to a poll in one go, skipping the names already on it, and answers how many were added. Internal: the caller has already decided it may write to this poll. The atomicity is the point -- a voter painting an afternoon of a time poll adds a dozen windows, and a run that stopped halfway would leave the ballot offering a day nobody meant.';


-- ---------------------------------------------------------------------------
-- 2. The three doors onto it
-- ---------------------------------------------------------------------------

-- Each mirrors its singular sibling exactly -- same lookup, same "not found",
-- same stage check -- and differs only in taking a list. They are separate
-- functions rather than a default argument on the old ones because a name and
-- a list of names are two shapes, and PostgREST resolves an overload by the
-- arguments it is given.

create or replace function "public"."suggest_options"("p_poll_id" "uuid", "p_options" jsonb) returns int
    language plpgsql security definer
    set "search_path" to 'public'
    as $$
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

alter function "public"."suggest_options"("p_poll_id" "uuid", "p_options" jsonb) owner to "postgres";

revoke all on function "public"."suggest_options"("p_poll_id" "uuid", "p_options" jsonb) from public;
grant all on function "public"."suggest_options"("p_poll_id" "uuid", "p_options" jsonb) to "authenticated";

comment on function "public"."suggest_options"("p_poll_id" "uuid", "p_options" jsonb) is
  'Suggests several options at once to a poll that is collecting them, from inside the poll. One transaction; names already on the list are skipped. This is how a voter adds times to a time poll, where one gesture is a dozen windows.';


create or replace function "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" jsonb) returns int
    language plpgsql security definer
    set "search_path" to 'public'
    as $$
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

alter function "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" jsonb) owner to "postgres";

revoke all on function "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" jsonb) from public;
grant all on function "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" jsonb) to "anon";
grant all on function "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" jsonb) to "authenticated";

comment on function "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" jsonb) is
  'The same, through an open poll''s link. Reachable by anon, like every other open_poll_ function, and refused on any poll that is not open or is no longer collecting.';


-- The creator's own correction to a list that is already a ballot, on a poll
-- nobody has voted in yet. Unlike `creator_add_option` this one is allowed on
-- a time poll: what it is handed comes from a painted calendar rather than
-- from a text box, so the names are window starts the grid can draw and the
-- window rule can score. That is the whole of the difference, and it is why
-- the singular still refuses.
create or replace function "public"."creator_add_options"("p_poll_id" "uuid", "p_options" jsonb) returns int
    language plpgsql security definer
    set "search_path" to 'public'
    as $$
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

alter function "public"."creator_add_options"("p_poll_id" "uuid", "p_options" jsonb) owner to "postgres";

revoke all on function "public"."creator_add_options"("p_poll_id" "uuid", "p_options" jsonb) from public;
grant all on function "public"."creator_add_options"("p_poll_id" "uuid", "p_options" jsonb) to "authenticated";

comment on function "public"."creator_add_options"("p_poll_id" "uuid", "p_options" jsonb) is
  'The creator''s correction to an option list that is already a ballot, applied in one go rather than one option per request. Allowed on a time poll, where the names come from a painted calendar; the singular creator_add_option is the typed-name path and still refuses one.';


-- ---------------------------------------------------------------------------
-- 3. A time poll may now collect its times
-- ---------------------------------------------------------------------------

-- The only change is the paragraph that is gone: the refusal of
-- `p_solicit_options` on a time poll. Everything else is 0055's body
-- unchanged, restated because a CREATE OR REPLACE has to be.
create or replace function "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_option_descriptions" "text"[] DEFAULT NULL::"text"[], "p_solicit_options" boolean DEFAULT false, "p_kind" "text" DEFAULT 'option'::"text", "p_schedule" "jsonb" DEFAULT NULL::"jsonb") returns "uuid"
    language plpgsql security definer
    set "search_path" to 'public'
    as $$
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

comment on function "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb") is
  'Creates one poll with its options and its invitees. A time poll carries a schedule and options its creator''s browser enumerated from a painted calendar; the database stores it exactly as it stores any other poll. A time poll may collect its times from voters, through suggest_options.';


-- ---------------------------------------------------------------------------
-- 4. A question of a group may be a time poll
-- ---------------------------------------------------------------------------

-- A CREATE OR REPLACE with the same signature, because the two new answers
-- ride inside `p_questions` -- which is already jsonb, and already the place a
-- question says what it is. So no grant to restate and no overload to
-- resolve: what changes is what two keys of each element mean.
create or replace function "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_solicit_options" boolean DEFAULT false) returns "uuid"
    language plpgsql security definer
    set "search_path" to 'public'
    as $$
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

comment on function "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) is
  'Creates a poll that asks several questions: one poll row per question, sharing a group, a title, a description, an invite list and their settings. One transaction. A question may be a time poll, by carrying a kind and a schedule of its own. A soliciting group collects options question by question and opens all of them at once; see finalize_options.';

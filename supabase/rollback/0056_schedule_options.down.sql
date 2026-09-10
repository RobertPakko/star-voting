-- Undo 0056_schedule_options.sql.
--
-- Deliberately NOT in supabase/migrations/: everything in that directory is
-- applied, in order, by the Supabase GitHub integration. This is a file you
-- run by hand, at a psql prompt, when 0056 is already committed on a database
-- and you want it gone.
--
--     psql -d <database> -f supabase/rollback/0056_schedule_options.down.sql
--
-- On a database where nothing has been committed yet you do not need this;
-- see the note at the top of 0055's rollback for the transactional loop that
-- is the answer nearly every time.
--
-- What it does: drop the four functions 0056 added, and restore the two it
-- replaced -- `create_poll` to its 0055 definition and `create_poll_group` to
-- its 0053 one, both verbatim.
--
-- **It is not lossless.** A time poll created with `solicit_options` on, or a
-- group with a time question in it, is a poll this schema can no longer make
-- and can still hold. Nothing breaks: `kind` and `schedule` are columns, and
-- the ballot draws from them whatever created them. What goes is the ability
-- to add to such a poll's list, since the plural functions are what the
-- calendar's suggestion path calls.


begin;

-- ---------------------------------------------------------------------------
-- What 0056 added
-- ---------------------------------------------------------------------------

drop function if exists "public"."creator_add_options"("p_poll_id" "uuid", "p_options" jsonb);
drop function if exists "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" jsonb);
drop function if exists "public"."suggest_options"("p_poll_id" "uuid", "p_options" jsonb);
drop function if exists "public"."insert_options"("p_poll" "public"."polls", "p_options" jsonb);


-- ---------------------------------------------------------------------------
-- What 0056 replaced, put back
-- ---------------------------------------------------------------------------

-- `create_poll` as 0055 left it: a time poll refuses to collect its times.
-- Copied from supabase/migrations/0055_schedule_polls.sql and not edited.

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
    perform validate_schedule(p_schedule);

    -- Off for now, and refused here rather than only hidden in the form.
    -- A voter "adding Thursday" adds a dozen options -- one per window start
    -- -- and the suggestion path inserts one at a time, so a run that fails
    -- halfway leaves a Thursday with morning windows and no afternoon.
    -- Turning it on means making that insertion atomic first.
    if coalesce(p_solicit_options, false) then
      raise exception 'A time poll cannot collect its times from voters';
    end if;
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
  'Creates one poll with its options and its invitees. A time poll carries a schedule and options its creator''s browser enumerated from it; the database stores it exactly as it stores any other poll.';


-- And `create_poll_group` as 0053 left it: every question it makes is an
-- ordinary one. Copied from supabase/migrations/0053_baseline.sql and not
-- edited; if 0053 is ever squashed away, regenerate this from whatever the new
-- baseline says rather than trusting this copy.

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
      i + 1
    );

    if i = 0 then
      v_first := v_id;
    end if;
  end loop;

  return v_first;
end;
$$;

COMMENT ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) IS 'Creates a poll that asks several questions: one poll row per question, sharing a group, a title, a description, an invite list and their settings. One transaction. A soliciting group collects options question by question and opens all of them at once; see finalize_options.';

-- Both were CREATE OR REPLACE in 0056 and are again here, so the grants 0053
-- and 0055 put on them have never moved and there is nothing to restate.

commit;

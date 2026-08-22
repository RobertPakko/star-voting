


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";





SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."polls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_email" "text" DEFAULT "lower"(("auth"."jwt"() ->> 'email'::"text")) NOT NULL,
    "closed_at" timestamp with time zone,
    "mode" "text" DEFAULT 'invite'::"text" NOT NULL,
    "show_voters" boolean DEFAULT true NOT NULL,
    "public_token" "text",
    "show_ballots" boolean DEFAULT false NOT NULL,
    "solicit_options" boolean DEFAULT false NOT NULL,
    "options_finalized_at" timestamp with time zone,
    "group_id" "uuid",
    "question_position" integer,
    "question_title" "text",
    CONSTRAINT "polls_mode_ck" CHECK (("mode" = ANY (ARRAY['invite'::"text", 'open'::"text"]))),
    CONSTRAINT "polls_options_finalized_ck" CHECK ((("options_finalized_at" IS NULL) OR "solicit_options")),
    CONSTRAINT "polls_public_token_ck" CHECK ((("mode" = 'open'::"text") = ("public_token" IS NOT NULL))),
    CONSTRAINT "polls_question_ck" CHECK (((("group_id" IS NULL) AND ("question_position" IS NULL) AND ("question_title" IS NULL)) OR (("group_id" IS NOT NULL) AND ("question_position" >= 1) AND ("question_title" IS NOT NULL))))
);


ALTER TABLE "public"."polls" OWNER TO "postgres";


COMMENT ON COLUMN "public"."polls"."show_ballots" IS 'Publish individual ballots once results unlock. Independent of show_voters, which decides whether a name is attached to each one.';



COMMENT ON COLUMN "public"."polls"."solicit_options" IS 'The options were collected from respondents rather than written by the creator. A setting, frozen at creation like mode, show_voters and show_ballots.';



COMMENT ON COLUMN "public"."polls"."options_finalized_at" IS 'When the creator closed the option list and opened voting. Null on a poll still collecting options; never set on a poll that did not solicit them.';



COMMENT ON COLUMN "public"."polls"."group_id" IS 'The multi-question poll this question belongs to, or null on a poll that asks one question. Every question in a group shares its title, description, mode and settings; what differs is question_title, the options and the ballots.';



COMMENT ON COLUMN "public"."polls"."question_position" IS 'Where this question sits in its group, from 1. The poll list shows position 1 and hides the rest, and the invite email is sent for it alone.';



COMMENT ON COLUMN "public"."polls"."question_title" IS 'What this one question asks. The poll''s own title is shared across the group, so that the set reads as one poll and this is the part that varies.';



CREATE OR REPLACE FUNCTION "public"."add_suggested_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not p_poll.solicit_options then
    raise exception 'The options for this poll were set when it was created';
  end if;

  if p_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  if p_poll.options_finalized_at is not null then
    raise exception 'The options for this poll are settled and voting has started';
  end if;

  perform insert_option(p_poll, p_name, p_description);
end;
$$;


ALTER FUNCTION "public"."add_suggested_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_results_readable"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_voted int;
begin
  select p.* into v_poll
  from polls p
  where p.id = p_poll_id
    and (
      p.created_by = auth.uid()
      or exists (select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email)
    );

  if not found then
    raise exception 'Poll not found';
  end if;

  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  -- Before the reveal rather than through it: a poll closed with nothing in
  -- it is not "not out yet", it is a poll with no results, and saying it is
  -- waiting on votes that can no longer be cast would be worse than useless.
  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if not poll_results_revealed(v_poll) then
    -- The two ways in, so the reader is told which one this poll has not
    -- reached. An open poll has only the close; an invite poll has the
    -- completion as well, and being told to wait for the close on a poll
    -- that will unlock itself would send its reader to a button they may
    -- not have.
    if v_poll.mode = 'open' then
      raise exception 'Results are not available until the poll is closed';
    end if;
    raise exception 'Results are not available until everyone has voted';
  end if;
end;
$$;


ALTER FUNCTION "public"."assert_results_readable"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ballot_sheet"("p_poll_id" "uuid", "p_named" boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_options jsonb;
  v_ballots jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)
                            order by c.sort_order, c.name), '[]'::jsonb)
  into v_options
  from candidates c
  where c.poll_id = p_poll_id;

  select coalesce(jsonb_agg(x.ballot order by x.sort_key), '[]'::jsonb)
  into v_ballots
  from (
    select
      jsonb_build_object(
        -- No ballot id in the payload: on an unnamed sheet it would be the
        -- one field that could be correlated with anything else, and the
        -- client only ever needs a row's position.
        'voter', case when p_named then coalesce(b.voter_name, lower(u.email)) end,
        'scores', coalesce(
          (select jsonb_object_agg(s.candidate_id::text, s.score)
           from scores s where s.ballot_id = b.id),
          '{}'::jsonb)
      ) as ballot,
      case
        when p_named then lower(coalesce(b.voter_name, u.email))
        else md5(b.id::text)
      end as sort_key
    from ballots b
    -- Invite ballots carry a voter_id and no name; open ones the reverse.
    left join auth.users u on u.id = b.voter_id
    where b.poll_id = p_poll_id
  ) x;

  return jsonb_build_object(
    'voters_named', p_named,
    'options', v_options,
    'ballots', v_ballots
  );
end;
$$;


ALTER FUNCTION "public"."ballot_sheet"("p_poll_id" "uuid", "p_named" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."broadcast_invites_sent"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll uuid;
  v_user uuid;
begin
  for v_poll in select distinct poll_id from new_rows loop
    perform broadcast_poll_change(v_poll);
  end loop;

  for v_user in
    select distinct u.id
    from new_rows n
    join auth.users u on lower(u.email) = lower(n.email)
  loop
    perform realtime.send('{}'::jsonb, 'polls_changed', 'user:' || v_user::text, false);
  end loop;

  return null;
end;
$$;


ALTER FUNCTION "public"."broadcast_invites_sent"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_token text;
begin
  if p_poll_id is null then
    return;
  end if;

  -- A poll that is on its way out has nobody left to tell, and its rows are
  -- following it: without this, every cascade delete would send one message
  -- per child row for a poll that no longer exists. It is also what keeps
  -- the nightly purge silent.
  select public_token into v_token from polls where id = p_poll_id;
  if not found then
    return;
  end if;

  perform realtime.send('{}'::jsonb, 'poll_changed', 'poll:' || p_poll_id::text, false);

  -- An open poll's voters arrive holding a share token and do not learn the
  -- poll's id until they have read it once. Announcing the token as well is
  -- what lets the public page subscribe before its first read rather than
  -- after -- which is what makes that first read the only one it needs.
  if v_token is not null then
    perform realtime.send('{}'::jsonb, 'poll_changed', 'poll:' || v_token, false);
  end if;
end;
$$;


ALTER FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") IS 'Tells anyone watching this poll that it moved, without saying how. Internal: called from the triggers in 0030, never by a client.';



CREATE OR REPLACE FUNCTION "public"."broadcast_poll_updated"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform broadcast_poll_change(NEW.id);
  return null;
end;
$$;


ALTER FUNCTION "public"."broadcast_poll_updated"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."broadcast_polls_emptied"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll uuid;
begin
  for v_poll in select distinct poll_id from old_rows loop
    perform broadcast_poll_change(v_poll);
  end loop;
  return null;
end;
$$;


ALTER FUNCTION "public"."broadcast_polls_emptied"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."broadcast_polls_touched"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll uuid;
begin
  for v_poll in select distinct poll_id from new_rows loop
    perform broadcast_poll_change(v_poll);
  end loop;
  return null;
end;
$$;


ALTER FUNCTION "public"."broadcast_polls_touched"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."close_poll"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Only the poll creator can close this poll';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll is already closed';
  end if;

  -- One timestamp for the group: the questions stopped at the same moment,
  -- because closing is one act.
  update polls set closed_at = now()
  where id in (select q.id from poll_group_members(v_poll) q)
    and closed_at is null;
end;
$$;


ALTER FUNCTION "public"."close_poll"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_option_descriptions" "text"[] DEFAULT NULL::"text"[], "p_solicit_options" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_opts jsonb;
  v_mails text[];
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
    null
  );
end;
$$;


ALTER FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean) OWNER TO "postgres";


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


ALTER FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) IS 'Creates a poll that asks several questions: one poll row per question, sharing a group, a title, a description, an invite list and their settings. One transaction. A soliciting group collects options question by question and opens all of them at once; see finalize_options.';



CREATE OR REPLACE FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
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

  -- The trigger says this too, and would refuse the insert on its own. Saying
  -- it here is what makes the message the one the creator can act on.
  if exists (select 1 from ballots where poll_id = p_poll_id) then
    raise exception 'Cannot change the options of a poll that already has votes';
  end if;

  perform insert_option(v_poll, p_name, p_description);
end;
$$;


ALTER FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") IS 'Adds an option to the creator''s own poll while it still has no votes. The window is "no ballots" and nothing else; where the options came from does not enter into it.';



CREATE OR REPLACE FUNCTION "public"."finalize_options"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_short record;
begin
  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Only the poll creator can finalize these options';
  end if;

  if not v_poll.solicit_options then
    raise exception 'The options for this poll were set when it was created';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  -- Asked of this question, which is enough: the group is opened in one
  -- statement below, so its questions are finalized together or not at all
  -- and can never disagree about whether they have been.
  if v_poll.options_finalized_at is not null then
    raise exception 'The options for this poll have already been finalized';
  end if;

  -- The same floor create_poll puts on a poll whose creator wrote the
  -- options: one option is not an election. Every question is checked
  -- *before* any is opened -- a poll half-opened would be taking votes on
  -- some questions while others were still gathering, which is the state
  -- opening the poll in one act exists to prevent.
  select q.question_title, count(c.id)::int as options
  into v_short
  from poll_group_members(v_poll) q
  left join candidates c on c.poll_id = q.id
  group by q.id, q.question_position, q.question_title
  having count(c.id) < 2
  order by min(q.question_position)
  limit 1;

  if found then
    -- Named, because on a poll of several questions "add two options" leaves
    -- the creator to find which of five is short. A poll asking one question
    -- has no name to give and says what it always said.
    if v_short.question_title is null then
      raise exception 'Add at least two options before opening the poll for voting';
    end if;
    raise exception 'Add at least two options to "%" before opening the poll for voting',
      v_short.question_title;
  end if;

  update polls set options_finalized_at = now()
  where id in (select q.id from poll_group_members(v_poll) q);
end;
$$;


ALTER FUNCTION "public"."finalize_options"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."finalize_options"("p_poll_id" "uuid") IS 'Turns a collected option list into a ballot, for every question of the poll at once. Refuses until each of them has two options, naming the one that is short.';



CREATE OR REPLACE FUNCTION "public"."get_poll_ranking"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_ranking(p_poll_id);
end;
$$;


ALTER FUNCTION "public"."get_poll_ranking"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_poll_results"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_results_readable(p_poll_id);
  return poll_tally(p_poll_id);
end;
$$;


ALTER FUNCTION "public"."get_poll_results"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_invitee_changes"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll_id uuid;
  v_invited int;
  v_voted int;
begin
  if tg_op = 'DELETE' then
    v_poll_id := old.poll_id;
  else
    v_poll_id := new.poll_id;
  end if;

  -- Parent poll already gone => cascade from deleting the poll itself.
  if not exists (select 1 from polls where id = v_poll_id) then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'INSERT' then
    if exists (select 1 from polls where id = v_poll_id and mode <> 'invite') then
      raise exception 'This poll is open to anyone with the link, so it has no invitee list';
    end if;

    if exists (select 1 from polls where id = v_poll_id and closed_at is not null) then
      raise exception 'Cannot invite people to a poll that has been closed';
    end if;

    select count(*) into v_invited from invited_voters where poll_id = v_poll_id;
    select count(*) into v_voted from ballots where poll_id = v_poll_id;

    if v_invited > 0 and v_voted >= v_invited then
      raise exception 'Cannot invite people once the results have been revealed';
    end if;

    return new;
  end if;

  if exists (
    select 1
    from ballots b
    join auth.users u on u.id = b.voter_id
    where b.poll_id = v_poll_id and lower(u.email) = old.email
  ) then
    raise exception 'Cannot remove someone who has already voted';
  end if;

  return old;
end;
$$;


ALTER FUNCTION "public"."guard_invitee_changes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_options_frozen"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_poll_id uuid;
  v_remaining int;
begin
  if tg_op = 'DELETE' then
    v_poll_id := old.poll_id;
  else
    v_poll_id := new.poll_id;
  end if;

  select * into v_poll from polls where id = v_poll_id;

  -- Parent poll already gone => this is a cascade from deleting the poll
  -- itself, which is allowed.
  if not found then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if exists (select 1 from ballots where poll_id = v_poll_id) then
    raise exception 'Cannot change the options of a poll that already has votes';
  end if;

  if tg_op = 'DELETE' then
    -- Only once the list is a ballot. While it is still being collected there
    -- is a later checkpoint -- finalize_options -- and pruning back to one
    -- option, or to none, is a normal thing to do on the way there.
    if not (v_poll.solicit_options and v_poll.options_finalized_at is null) then
      select count(*)::int into v_remaining
      from candidates where poll_id = v_poll_id and id <> old.id;

      if v_remaining < 2 then
        raise exception 'A poll needs at least two options';
      end if;
    end if;

    return old;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."guard_options_frozen"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_next int;
  v_count int;
begin
  if v_name is null then
    raise exception 'Give the option a name';
  end if;

  -- A name is a label on a ballot and a description is a couple of lines
  -- under it. Neither cap is near what a real option needs; they are here
  -- because the suggestion path lets a whole group write to this table.
  if length(v_name) > 100 then
    raise exception 'That option name is too long';
  end if;

  if length(v_description) > 500 then
    raise exception 'That description is too long';
  end if;

  if exists (
    select 1 from candidates c
    where c.poll_id = p_poll.id and lower(c.name) = lower(v_name)
  ) then
    raise exception '"%" is already on the list', v_name;
  end if;

  select count(*)::int, coalesce(max(sort_order), -1) + 1
  into v_count, v_next
  from candidates where poll_id = p_poll.id;

  -- A ballot is a list somebody has to read to the end before scoring any of
  -- it, and a shared list with nothing stopping it grows until nobody does.
  if v_count >= 50 then
    raise exception 'This poll already has as many options as it can hold';
  end if;

  -- Arrival order, which is the order everyone watching the page has been
  -- reading the list in already.
  insert into candidates (poll_id, name, description, sort_order)
  values (p_poll.id, v_name, v_description, v_next);
end;
$$;


ALTER FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") IS 'The field rules for one option -- name, description, duplicates, the 50-option ceiling -- shared by the suggestion path and the creator''s own. Internal: the caller has already decided it may write to this poll.';



CREATE OR REPLACE FUNCTION "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid" DEFAULT NULL::"uuid", "p_question_position" integer DEFAULT NULL::integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll_id uuid;
  v_token text;
  v_opts jsonb;
  v_item jsonb;
  i int;
begin
  -- Drop blanks but keep the author's ordering, carrying each option's
  -- description along with it.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'name', trim(o ->> 'name'),
             'description', nullif(trim(coalesce(o ->> 'description', '')), '')
           ) order by ord), '[]'::jsonb)
  into v_opts
  from jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) with ordinality as t(o, ord)
  where trim(coalesce(o ->> 'name', '')) <> '';

  -- A poll collecting its options is allowed to start with none; the same
  -- minimum is applied by finalize_options, when the list becomes a ballot.
  if not p_solicit_options and jsonb_array_length(v_opts) < 2 then
    raise exception 'Add at least two options';
  end if;

  if p_mode = 'open' then
    -- 122 bits from a v4 UUID, hex digits only, so it needs no escaping in
    -- a URL. Every question gets its own: a token is what reaches one
    -- ballot, and there is one ballot per question.
    v_token := replace(gen_random_uuid()::text, '-', '');
  end if;

  insert into polls (
    title, description, created_by, mode, show_voters, show_ballots,
    solicit_options, public_token, group_id, question_position, question_title
  )
  values (
    p_title, p_description, auth.uid(), p_mode, p_show_voters, p_show_ballots,
    p_solicit_options, v_token, p_group_id, p_question_position, p_question_title
  )
  returning id into v_poll_id;

  for i in 0 .. jsonb_array_length(v_opts) - 1 loop
    v_item := v_opts -> i;
    insert into candidates (poll_id, name, description, sort_order)
    values (v_poll_id, v_item ->> 'name', v_item ->> 'description', i);
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


ALTER FUNCTION "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid", "p_question_position" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid", "p_question_position" integer) IS 'One poll row with its options and its invitees, for the two functions that create polls. Internal: it checks the option list and nothing else, because its callers have checked the rest.';



CREATE OR REPLACE FUNCTION "public"."is_invited_to_poll"("p_poll_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from invited_voters
    where poll_id = p_poll_id and email = lower(auth.jwt() ->> 'email')
  );
$$;


ALTER FUNCTION "public"."is_invited_to_poll"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_poll_creator"("p_poll_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from polls where id = p_poll_id and created_by = auth.uid()
  );
$$;


ALTER FUNCTION "public"."is_poll_creator"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_polls"() RETURNS TABLE("id" "uuid", "title" "text", "description" "text", "created_by" "uuid", "created_by_email" "text", "created_at" timestamp with time zone, "closed_at" timestamp with time zone, "mode" "text", "show_voters" boolean, "show_ballots" boolean, "solicit_options" boolean, "options_finalized_at" timestamp with time zone, "public_token" "text", "invited_count" integer, "voted_count" integer, "option_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean, "group_id" "uuid", "question_position" integer, "question_title" "text", "question_count" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with visible as (
    -- The whole row alongside its columns, so the aggregates below can be
    -- handed a poll rather than rebuilding one.
    select p.*, p as poll_row
    from polls p
    where (p.group_id is null or p.question_position = 1)
      and (
        p.created_by = auth.uid()
        or exists (
          select 1 from invited_voters iv
          where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
        )
      )
  ), tallied as (
    select
      v.id as poll_id,
      -- Per question, and the question is the first one: the invite list is
      -- the same on every question, and a turnout that differs between them
      -- is not a number this list has room to reconcile. The card shows the
      -- question count in its place on a grouped poll.
      (select count(*)::int from invited_voters iv where iv.poll_id = v.id) as invited_count,
      (select count(*)::int from ballots b where b.poll_id = v.id) as voted_count,
      (select count(*)::int from candidates c where c.poll_id = v.id) as option_count,
      (select count(*)::int from poll_group_members(v.poll_row)) as question_count,
      -- Asked of every question: a poll is answered when all of it is.
      (select bool_and(
                exists (select 1 from ballots b where b.poll_id = q.id and b.voter_id = auth.uid()))
         from poll_group_members(v.poll_row) q) as voted,
      (select bool_and(
                (select count(*) from invited_voters iv where iv.poll_id = q.id) > 0
                and (select count(*) from ballots b where b.poll_id = q.id)
                    >= (select count(*) from invited_voters iv where iv.poll_id = q.id))
         from poll_group_members(v.poll_row) q) as is_complete,
      (select bool_and(q.closed_at is not null)
         from poll_group_members(v.poll_row) q) as is_closed
    from visible v
  )
  select
    v.id,
    v.title,
    v.description,
    v.created_by,
    v.created_by_email,
    v.created_at,
    v.closed_at,
    v.mode,
    v.show_voters,
    v.show_ballots,
    v.solicit_options,
    v.options_finalized_at,
    v.public_token,
    t.invited_count,
    t.voted_count,
    t.option_count,
    t.is_complete,
    t.voted,
    t.is_closed,
    poll_results_revealed(v.poll_row),
    v.solicit_options and v.options_finalized_at is null and v.closed_at is null,
    v.group_id,
    v.question_position,
    v.question_title,
    t.question_count
  from visible v
  join tallied t on t.poll_id = v.id
  order by v.created_at desc;
$$;


ALTER FUNCTION "public"."list_polls"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_invite_emails"("p_emails" "text"[]) RETURNS "text"[]
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $_$
declare
  v_mails text[];
  v_bad text;
begin
  -- Normalize and dedupe invitees the same way every lookup does.
  select array_agg(distinct lower(trim(e)))
  into v_mails
  from unnest(p_emails) e
  where trim(coalesce(e, '')) <> '';

  if coalesce(array_length(v_mails, 1), 0) < 1 then
    raise exception 'Invite at least one voter';
  end if;

  select m into v_bad
  from unnest(v_mails) m
  where m !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  limit 1;

  if v_bad is not null then
    raise exception '"%" is not a valid email address', v_bad;
  end if;

  return v_mails;
end;
$_$;


ALTER FUNCTION "public"."normalize_invite_emails"("p_emails" "text"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."normalize_invite_emails"("p_emails" "text"[]) IS 'The invite list as it is stored: trimmed, lowercased, deduped, and every address checked. Internal: shared by create_poll and create_poll_group so one poll and one group cannot disagree about what an invite list is.';



CREATE OR REPLACE FUNCTION "public"."normalize_invited_email"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$;


ALTER FUNCTION "public"."normalize_invited_email"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_poll_ballots"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted int;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if not v_poll.show_ballots then
    raise exception 'This poll does not publish individual ballots';
  end if;

  if v_poll.closed_at is null then
    raise exception 'Ballots are not available until the poll is closed';
  end if;

  select count(*) into v_voted from ballots where poll_id = v_poll.id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  return ballot_sheet(v_poll.id, v_poll.show_voters);
end;
$$;


ALTER FUNCTION "public"."open_poll_ballots"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_poll_group"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.group_id is null then
    return '[]'::jsonb;
  end if;

  -- The sibling tokens, to whoever already holds one of them. They are one
  -- poll: a link to a multi-question poll is a link to all of its questions,
  -- and this is what makes the next one reachable.
  --
  -- **No "voted" here, unlike poll_group.** An open ballot is identified by
  -- a voter_key that is minted per share token precisely so that one
  -- browser's ballots cannot be joined to each other, and answering this
  -- would mean taking every key at once and doing that join on the server.
  -- The browser already knows which questions it has answered; it is the one
  -- place entitled to, and it needs no help from here.
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'token', q.public_token,
      'question_position', q.question_position,
      'question_title', q.question_title
    ) order by q.question_position), '[]'::jsonb)
    from poll_group_members(v_poll) q
  );
end;
$$;


ALTER FUNCTION "public"."open_poll_group"("p_token" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_poll_group"("p_token" "text") IS 'The questions of an open poll, with the share token of each, to a caller already holding one of them. Says nothing about who has answered what: an open poll''s voter keys are scoped per question so they cannot be joined, and this function is not the place that undoes it.';



CREATE OR REPLACE FUNCTION "public"."open_poll_ranking"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  return poll_ranking(open_results_poll_id(p_token));
end;
$$;


ALTER FUNCTION "public"."open_poll_ranking"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_poll_results"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  return poll_tally(open_results_poll_id(p_token));
end;
$$;


ALTER FUNCTION "public"."open_poll_results"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_poll_revise"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_ballot_id uuid;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  -- An open poll reveals on close and only on close, so the line above has
  -- already caught every poll this could catch. It is here because the rule
  -- being kept is "not while the results are out", and a rule worth stating
  -- is worth stating on both paths rather than left implied by another one.
  if poll_results_revealed(v_poll) then
    raise exception 'The results are out, so votes can no longer be changed';
  end if;

  select id into v_ballot_id
  from ballots where poll_id = v_poll.id and voter_key = p_voter_key;

  if not found then
    raise exception 'You have not voted in this poll yet';
  end if;

  perform replace_scores(v_ballot_id, v_poll.id, p_scores);

  update ballots set revised_at = now() where id = v_ballot_id;
end;
$$;


ALTER FUNCTION "public"."open_poll_revise"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_poll_revise"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text") IS 'Replaces the scores on the ballot this voter_key cast, until the poll closes. The voter''s name is not revisable: it is on the roster other people are already reading.';



CREATE OR REPLACE FUNCTION "public"."open_poll_submit"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_name text;
  v_ballot_id uuid;
  v_option_count int;
  v_item jsonb;
  v_candidate_id uuid;
  v_score int;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  if v_poll.solicit_options and v_poll.options_finalized_at is null then
    raise exception 'This poll is still collecting options, so voting has not started';
  end if;

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  if v_poll.show_voters then
    v_name := nullif(trim(coalesce(p_voter_name, '')), '');
    if v_name is null then
      raise exception 'Enter your name so the group can see who has voted';
    end if;
    if length(v_name) > 60 then
      raise exception 'That name is too long';
    end if;
  else
    -- A poll that hides respondents must not store one, whatever the client
    -- sends.
    v_name := null;
  end if;

  if exists (select 1 from ballots where poll_id = v_poll.id and voter_key = p_voter_key) then
    raise exception 'You have already voted in this poll';
  end if;

  select count(*) into v_option_count from candidates where poll_id = v_poll.id;

  if jsonb_array_length(p_scores) is distinct from v_option_count then
    raise exception 'Must submit a score for every option';
  end if;

  begin
    insert into ballots (poll_id, voter_id, voter_name, voter_key)
    values (v_poll.id, null, v_name, p_voter_key)
    returning id into v_ballot_id;
  exception when unique_violation then
    -- Either the name is taken, or this browser raced itself (double-click,
    -- double-submit) past the voter_key check above.
    if v_name is null then
      raise exception 'You have already voted in this poll';
    end if;
    raise exception '"%" has already voted in this poll. Add a last initial if that is not you.', v_name;
  end;

  for v_item in select * from jsonb_array_elements(p_scores)
  loop
    v_candidate_id := (v_item ->> 'candidate_id')::uuid;
    v_score := (v_item ->> 'score')::int;

    if v_score < 0 or v_score > 5 then
      raise exception 'Score must be between 0 and 5';
    end if;

    if not exists (select 1 from candidates where id = v_candidate_id and poll_id = v_poll.id) then
      raise exception 'Invalid option for this poll';
    end if;

    insert into scores (ballot_id, candidate_id, score) values (v_ballot_id, v_candidate_id, v_score);
  end loop;
end;
$$;


ALTER FUNCTION "public"."open_poll_submit"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_poll_suggest_option"("p_token" "text", "p_name" "text", "p_description" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  perform add_suggested_option(v_poll, p_name, p_description);
end;
$$;


ALTER FUNCTION "public"."open_poll_suggest_option"("p_token" "text", "p_name" "text", "p_description" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_poll_view"("p_token" "text", "p_voter_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted int;
  v_options jsonb;
  v_voters jsonb;
  v_your_name text;
  v_your_scores jsonb;
  v_voted_already boolean;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  select count(*)::int into v_voted from ballots where poll_id = v_poll.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'poll_id', c.poll_id,
    'name', c.name,
    'description', c.description,
    'sort_order', c.sort_order
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

  -- Your own ballot comes back with it, so "change my vote" can hand it to
  -- you filled in without a second request. Reaching it needs the voter_key,
  -- which is the same thing that had to be held to cast it; nobody else's
  -- ballot is readable here at any stage of any poll.
  if p_voter_key is null or trim(p_voter_key) = '' then
    v_voted_already := false;
  else
    select
      true,
      b.voter_name,
      coalesce(
        (select jsonb_object_agg(s.candidate_id::text, s.score)
         from scores s where s.ballot_id = b.id),
        '{}'::jsonb)
    into v_voted_already, v_your_name, v_your_scores
    from ballots b
    where b.poll_id = v_poll.id and b.voter_key = p_voter_key;
    v_voted_already := coalesce(v_voted_already, false);
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
      -- Null on a poll that asks one question, which is what tells the page
      -- to render no question strip rather than a strip of one.
      'group_id', v_poll.group_id,
      'question_position', v_poll.question_position,
      'question_title', v_poll.question_title
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
    'voters', v_voters
  );
end;
$$;


ALTER FUNCTION "public"."open_poll_view"("p_token" "text", "p_voter_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_results_poll_id"("p_token" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted int;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  -- Closed first: on a poll still taking votes that is the accurate answer,
  -- and "no votes were cast" would be a confusing thing to say about a poll
  -- people can still vote in.
  if not (select bool_and(poll_gate_open(q.*)) from poll_group_members(v_poll) q) then
    raise exception 'Results are not available until the poll is closed';
  end if;

  select count(*) into v_voted from ballots where poll_id = v_poll.id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  return v_poll.id;
end;
$$;


ALTER FUNCTION "public"."open_results_poll_id"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."poll_ballot_scores"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_ballot_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select id into v_ballot_id
  from ballots where poll_id = p_poll_id and voter_id = auth.uid();

  if not found then
    raise exception 'You have not voted in this poll yet';
  end if;

  return coalesce(
    (select jsonb_object_agg(s.candidate_id::text, s.score)
     from scores s where s.ballot_id = v_ballot_id),
    '{}'::jsonb);
end;
$$;


ALTER FUNCTION "public"."poll_ballot_scores"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_ballot_scores"("p_poll_id" "uuid") IS 'The caller''s own scores in an invite poll, keyed by option id, for filling their ballot back in. Reads nobody else''s ballot at any stage of any poll.';



CREATE OR REPLACE FUNCTION "public"."poll_ballots"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_invited int;
  v_voted int;
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
    raise exception 'This poll is open to anyone with the link, so its ballots are read through that link';
  end if;

  -- Deliberately before the creator has been given any special treatment,
  -- because they get none. See rule 2 at the top of this file.
  if not v_poll.show_ballots then
    raise exception 'This poll does not publish individual ballots';
  end if;

  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if v_poll.closed_at is null and (v_invited = 0 or v_voted < v_invited) then
    raise exception 'Ballots are not available until everyone has voted';
  end if;

  return ballot_sheet(p_poll_id, v_poll.show_voters);
end;
$$;


ALTER FUNCTION "public"."poll_ballots"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."poll_expires_at"("p_poll" "public"."polls") RETURNS timestamp with time zone
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  -- Nothing that happens in the poll afterwards moves this: not a vote, not
  -- the option list being settled, not the creator closing it. The date a
  -- poll will be deleted is fixed on the day it is created, which is what
  -- lets the poll page state it from that day on and never revise it.
  select p_poll.created_at + poll_retention_window();
$$;


ALTER FUNCTION "public"."poll_expires_at"("p_poll" "public"."polls") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."poll_gate_open"("p_poll" "public"."polls") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p_poll.closed_at is not null
      or (p_poll.mode = 'invite' and counted.invited > 0 and counted.voted >= counted.invited)
  from (
    select
      (select count(*) from ballots where poll_id = p_poll.id) as voted,
      (select count(*) from invited_voters where poll_id = p_poll.id) as invited
  ) counted;
$$;


ALTER FUNCTION "public"."poll_gate_open"("p_poll" "public"."polls") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_gate_open"("p_poll" "public"."polls") IS 'Whether this one question has stopped taking votes: closed, or an invite question everyone invited has answered. Internal: the per-question half of poll_results_revealed, which asks it of every question in the group.';



CREATE OR REPLACE FUNCTION "public"."poll_group"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
begin
  -- The same visibility test the rest of the invite side applies: the poll
  -- is yours, or you were invited to it. Every question in a group carries
  -- the same invite list, so seeing one is seeing all of them.
  select p.* into v_poll
  from polls p
  where p.id = p_poll_id
    and (
      p.created_by = auth.uid()
      or exists (select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email)
    );

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.group_id is null then
    return '[]'::jsonb;
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', q.id,
      'question_position', q.question_position,
      'question_title', q.question_title,
      -- What the creator's "Open poll" button needs to apply the floor
      -- finalize_options applies, rather than offering a button that is
      -- refused: opening is one act over every question, so the button has
      -- to know about every question's list and not just this one's.
      'option_count', (select count(*)::int from candidates c where c.poll_id = q.id),
      -- Which questions this reader has already answered. Free on this side:
      -- an invite ballot carries the voter's account, so nothing has to be
      -- linked to find them. The share-link side deliberately cannot ask
      -- this; see open_poll_group below.
      'voted', exists (select 1 from ballots b where b.poll_id = q.id and b.voter_id = auth.uid())
    ) order by q.question_position), '[]'::jsonb)
    from poll_group_members(v_poll) q
  );
end;
$$;


ALTER FUNCTION "public"."poll_group"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_group"("p_poll_id" "uuid") IS 'The questions of the poll this one belongs to, in order, with whether the reader has answered each; empty for a poll that asks one question.';



CREATE OR REPLACE FUNCTION "public"."poll_group_members"("p_poll" "public"."polls") RETURNS SETOF "public"."polls"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p.*
  from polls p
  where p.id = p_poll.id
     or (p_poll.group_id is not null and p.group_id = p_poll.group_id)
  order by p.question_position nulls first;
$$;


ALTER FUNCTION "public"."poll_group_members"("p_poll" "public"."polls") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_group_members"("p_poll" "public"."polls") IS 'Every question in this poll''s group, in order; the poll itself alone when it has no group. Internal: it answers about rows the caller has already established it may read.';



CREATE OR REPLACE FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") RETURNS TABLE("email" "text", "has_voted" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_is_creator boolean;
  v_is_invited boolean;
  v_show boolean;
  v_mode text;
begin
  select
    p.created_by = auth.uid(),
    p.show_voters,
    p.mode
  into v_is_creator, v_show, v_mode
  from polls p where p.id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  -- auth.uid() is null for an unauthenticated caller, which would make the
  -- comparison above NULL and every `not v_is_creator` test below NULL --
  -- i.e. not true, but not false either. EXECUTE is revoked from anon, so
  -- this is belt and braces; it is also exactly the shape of mistake 0010
  -- was written about.
  v_is_creator := coalesce(v_is_creator, false);

  select exists (
    select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email
  ) into v_is_invited;

  if not v_is_creator and not v_is_invited then
    raise exception 'Poll not found';
  end if;

  if v_mode <> 'invite' then
    raise exception 'This poll is open to anyone with the link, so it has no invitee list';
  end if;

  if not v_is_creator and not v_show then
    raise exception 'This poll does not show who has responded';
  end if;

  return query
  select
    iv.email,
    case when v_show then exists (
      select 1 from ballots b
      join auth.users u on u.id = b.voter_id
      where b.poll_id = p_poll_id and lower(u.email) = iv.email
    ) else null::boolean end
  from invited_voters iv
  where iv.poll_id = p_poll_id
  order by iv.email;
end;
$$;


ALTER FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."poll_is_first_question"("p_poll_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  -- coalesce, not "is null or = 1": a poll with no group is the only
  -- question there is, and answering "yes" for it is what keeps every
  -- single-question poll behaving exactly as it did.
  select coalesce(question_position, 1) = 1 from polls where id = p_poll_id;
$$;


ALTER FUNCTION "public"."poll_is_first_question"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_is_first_question"("p_poll_id" "uuid") IS 'Whether this poll is the one an invitation should name: the first question of a group, or a poll that asks only one. Internal: read by the invite-email trigger.';



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
  v_ranking jsonb := '[]'::jsonb;
  v_place int := 1;
begin
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  -- Names and totals, for labelling the places. Scores are absolute sums, so
  -- eliminating an option never changes anyone else's total and this is read
  -- once for the whole ladder rather than per round.
  drop table if exists _ranking_tally;
  create temp table _ranking_tally on commit drop as
  select
    c.id as cid,
    c.name,
    coalesce(sum(s.score), 0)::int as total
  from candidates c
  left join scores s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
  group by c.id, c.name;

  select coalesce(array_agg(cid), '{}'::uuid[]) into v_pool from _ranking_tally;

  while coalesce(array_length(v_pool, 1), 0) > 0 loop
    v_round := star_round(p_poll_id, v_pool);

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

    v_ranking := v_ranking || jsonb_build_array(jsonb_build_object(
      'place', v_place,
      'options', v_placed_json,
      'finalists', v_round->'finalists',
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


ALTER FUNCTION "public"."poll_ranking"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."poll_results_revealed"("p_poll" "public"."polls") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select (select count(*) from ballots where poll_id = p_poll.id) > 0
     and (select bool_and(poll_gate_open(q.*)) from poll_group_members(p_poll) q);
$$;


ALTER FUNCTION "public"."poll_results_revealed"("p_poll" "public"."polls") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_results_revealed"("p_poll" "public"."polls") IS 'Whether this poll has shown anybody its tally: it has taken at least one ballot, and every question in its poll has stopped taking votes. The window for changing a vote and for changing the invitee list both close here.';



CREATE OR REPLACE FUNCTION "public"."poll_retention_window"() RETURNS interval
    LANGUAGE "sql" IMMUTABLE
    AS $$ select interval '6 months' $$;


ALTER FUNCTION "public"."poll_retention_window"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_retention_window"() IS 'How long a poll is kept after it is created. The one place the retention period is written down.';



CREATE OR REPLACE FUNCTION "public"."poll_status"("p_poll_id" "uuid") RETURNS TABLE("invited_count" integer, "voted_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean, "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_invited int;
  v_voted int;
begin
  -- The whole row now, since poll_expires_at() takes one. The visibility
  -- test is unchanged: the poll is yours, or you were invited to it.
  select p.* into v_poll
  from polls p
  where p.id = p_poll_id
    and (
      p.created_by = auth.uid()
      or exists (select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email)
    );

  if not found then
    raise exception 'Poll not found';
  end if;

  select count(*)::int into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*)::int into v_voted from ballots where poll_id = p_poll_id;

  return query select
    v_invited,
    v_voted,
    v_invited > 0 and v_voted >= v_invited,
    exists (select 1 from ballots where poll_id = p_poll_id and voter_id = auth.uid()),
    v_poll.closed_at is not null,
    poll_results_revealed(v_poll),
    v_poll.solicit_options and v_poll.options_finalized_at is null and v_poll.closed_at is null,
    poll_expires_at(v_poll);
end;
$$;


ALTER FUNCTION "public"."poll_status"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."poll_tally"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_invited int;
  v_voted int;
  v_closed boolean;
  v_mode text;
  v_options jsonb;
  v_pool uuid[];
  v_head jsonb;
  v_head_finalists uuid[];
begin
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;
  select closed_at is not null, mode into v_closed, v_mode from polls where id = p_poll_id;

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

  select coalesce(array_agg(cid), '{}'::uuid[]) into v_pool from _tally;

  -- The head round is the whole of STAR: the score round, its tie-breaks and
  -- the runoff. Everything below first place is poll_ranking's, and is not
  -- computed here.
  v_head := star_round(p_poll_id, v_pool);

  select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_head_finalists
  from jsonb_array_elements_text(v_head->'finalists') x;

  -- Order the score list so a tie-break winner sits above the option it
  -- beat, rather than falling alphabetically below it.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cid,
    'name', name,
    -- Null on nearly every option ever created; the results page shows
    -- nothing at all for those rather than an empty affordance.
    'description', description,
    'total_score', total,
    'average_score', round(total::numeric / v_voted, 2)
  ) order by total desc, (case when cid = any(v_head_finalists) then 0 else 1 end), name), '[]'::jsonb)
  into v_options
  from _tally;

  return jsonb_build_object(
    'options', v_options,
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
    'closed_early', v_closed and v_voted < v_invited
  );
end;
$$;


ALTER FUNCTION "public"."poll_tally"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."poll_winner_name"("p_poll_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_pool uuid[];
  v_winner uuid;
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

  -- The head round is the whole of STAR: the score round, its tie-breaks and
  -- the runoff. The full ranking below it is this function again on what is
  -- left, and a list row wants none of that.
  v_winner := (star_round(p_poll_id, v_pool)->>'winner_id')::uuid;

  if v_winner is null then
    -- A runoff level on preference, on points and on five-star votes alike.
    -- The app reports the tie rather than inventing a winner, so this stays
    -- null and the list says the results are ready instead.
    return null;
  end if;

  return (select name from candidates where id = v_winner);
end;
$$;


ALTER FUNCTION "public"."poll_winner_name"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."poll_winners"("p_poll_ids" "uuid"[]) RETURNS TABLE("poll_id" "uuid", "winner_name" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_ids uuid[] := coalesce(p_poll_ids, '{}'::uuid[]);
  v_id uuid;
  v_poll polls;
  v_invited int;
  v_voted int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- One election per id, so the list of ids is bounded. The page asks about
  -- what is on screen, which is ten; this is well clear of that and still
  -- refuses to be handed the whole database.
  if coalesce(array_length(v_ids, 1), 0) > 200 then
    raise exception 'Too many polls in one request';
  end if;

  foreach v_id in array v_ids loop
    -- Visibility, on exactly the terms list_polls() uses: the polls you
    -- created and the polls you were invited to. An id the caller cannot see
    -- produces no row at all rather than a null one -- "not yours" and "no
    -- winner" are different answers and must not arrive looking alike.
    select * into v_poll from polls p
    where p.id = v_id
      and (
        p.created_by = auth.uid()
        or exists (
          select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email
        )
      );

    continue when not found;

    -- Aliased because this function's own OUT column is called poll_id, and
    -- an unqualified one in here means that rather than the table's.
    select count(*)::int into v_invited from invited_voters iv where iv.poll_id = v_id;
    select count(*)::int into v_voted from ballots b where b.poll_id = v_id;

    poll_id := v_id;
    -- Results unlock on the same terms everywhere: an open poll on close, an
    -- invite poll on close or on completion. Until then there is no winner
    -- to report, and reporting one would be telling a voter how it is going
    -- while they can still vote.
    winner_name := case
      when v_voted > 0 and (
        v_poll.closed_at is not null
        or (v_poll.mode = 'invite' and v_invited > 0 and v_voted >= v_invited)
      )
      then poll_winner_name(v_id)
    end;
    return next;
  end loop;
end;
$$;


ALTER FUNCTION "public"."poll_winners"("p_poll_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_old_polls"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deleted int;
begin
  with expired as (
    delete from polls p
    -- The same test poll_expires_at() states, rearranged onto the bare
    -- column so the index above can answer it. The second half is that
    -- function itself, kept as the authority: whatever date the poll page
    -- showed a reader is the date this acts on, and a rewrite of one that
    -- drifted from the other would delete a poll the app promised was safe.
    where p.created_at <= now() - poll_retention_window()
      and poll_expires_at(p) <= now()
    returning 1
  )
  select count(*)::int into v_deleted from expired;

  return v_deleted;
end;
$$;


ALTER FUNCTION "public"."purge_old_polls"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."purge_old_polls"() IS 'Deletes every poll past its retention window, cascading to its options, invitees and ballots. Returns how many polls went. Scheduled nightly by pg_cron.';



CREATE OR REPLACE FUNCTION "public"."replace_scores"("p_ballot_id" "uuid", "p_poll_id" "uuid", "p_scores" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_option_count int;
  v_named int;
  v_updated int := 0;
  v_rows int;
  v_item jsonb;
  v_candidate_id uuid;
  v_score int;
begin
  select count(*) into v_option_count from candidates where poll_id = p_poll_id;

  if jsonb_array_length(p_scores) is distinct from v_option_count then
    raise exception 'Must submit a score for every option';
  end if;

  select count(distinct (e ->> 'candidate_id')) into v_named
  from jsonb_array_elements(p_scores) e;

  if v_named is distinct from v_option_count then
    raise exception 'Must submit a score for every option';
  end if;

  for v_item in select * from jsonb_array_elements(p_scores)
  loop
    v_candidate_id := (v_item ->> 'candidate_id')::uuid;
    v_score := (v_item ->> 'score')::int;

    if v_score < 0 or v_score > 5 then
      raise exception 'Score must be between 0 and 5';
    end if;

    if not exists (select 1 from candidates where id = v_candidate_id and poll_id = p_poll_id) then
      raise exception 'Invalid option for this poll';
    end if;

    update scores set score = v_score
    where ballot_id = p_ballot_id and candidate_id = v_candidate_id;

    get diagnostics v_rows = row_count;
    v_updated := v_updated + v_rows;
  end loop;

  -- A ballot carries exactly one score per option, so a payload that matched
  -- the option list must have moved every one of them. Anything else means
  -- the ballot and the option list have come apart, and half-rewriting a
  -- ballot is worse than refusing to.
  if v_updated is distinct from v_option_count then
    raise exception 'Invalid option for this poll';
  end if;
end;
$$;


ALTER FUNCTION "public"."replace_scores"("p_ballot_id" "uuid", "p_poll_id" "uuid", "p_scores" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."replace_scores"("p_ballot_id" "uuid", "p_poll_id" "uuid", "p_scores" "jsonb") IS 'Overwrites every score on one ballot, in place. Internal: called from revise_ballot and open_poll_revise, which decide whose ballot it is and whether the poll will take a change.';



CREATE OR REPLACE FUNCTION "public"."reset_poll"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Only the poll creator can reset this poll';
  end if;

  -- scores cascade from ballots (0001), so this clears the whole tally.
  -- It also frees the per-poll unique names and voter keys that open-poll
  -- ballots hold, so the same people can vote again under the same names.
  delete from ballots
  where poll_id in (select q.id from poll_group_members(v_poll) q);

  update polls set closed_at = null
  where id in (select q.id from poll_group_members(v_poll) q);
end;
$$;


ALTER FUNCTION "public"."reset_poll"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."revise_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_ballot_id uuid;
begin
  if v_email is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_poll from polls where id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  -- The same "not found" for a poll that exists but is none of yours, as
  -- poll_ballots() gives: whether a given id is a real poll is not something
  -- an outsider needs to learn here either.
  if not (
    v_poll.created_by = auth.uid()
    or exists (select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email)
  ) then
    raise exception 'Poll not found';
  end if;

  if v_poll.mode <> 'invite' then
    raise exception 'This poll is open to anyone with the link, so its votes are changed through that link';
  end if;

  -- Closed first, and separately from the reveal. A closed poll with votes in
  -- it is both, and "it has been closed" is the more useful of the two things
  -- to say; a poll closed before anybody voted is only the first, and the
  -- reveal below would let it straight through -- it has no results to be out.
  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  if poll_results_revealed(v_poll) then
    raise exception 'The results are out, so votes can no longer be changed';
  end if;

  select id into v_ballot_id
  from ballots where poll_id = p_poll_id and voter_id = auth.uid();

  if not found then
    raise exception 'You have not voted in this poll yet';
  end if;

  perform replace_scores(v_ballot_id, p_poll_id, p_scores);

  update ballots set revised_at = now() where id = v_ballot_id;
end;
$$;


ALTER FUNCTION "public"."revise_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."revise_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") IS 'Replaces the scores on the caller''s own ballot in an invite poll, until the results are out. Sends no live signal: nothing visible before the reveal is derived from a score.';



CREATE OR REPLACE FUNCTION "public"."send_invite_email"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_api_key text;
  v_poll_title text;
  v_poll_mode text;
  v_title_html text;
  v_link text;
  v_html text;
begin
  if to_regnamespace('net') is null or to_regnamespace('vault') is null then
    return new;
  end if;

  select decrypted_secret into v_api_key
  from vault.decrypted_secrets
  where name = 'resend_api_key'
  limit 1;

  if v_api_key is null then
    return new;
  end if;

  select title, mode into v_poll_title, v_poll_mode
  from polls
  where id = new.poll_id;

  -- guard_invitee_changes already refuses an insert against a non-invite
  -- poll; this is just defensive.
  if v_poll_mode is distinct from 'invite' then
    return new;
  end if;

  v_title_html := replace(replace(replace(coalesce(v_poll_title, 'a poll'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  v_link := 'https://choicelab.app/star-voting/#/polls/' || new.poll_id::text;

  v_html := $html$<!doctype html>
<html>
  <body style="margin:0; padding:0; background-color:#f2eefc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2eefc; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(126,20,255,0.12);">
            <tr>
              <td align="center" style="background-color:#ffffff; padding:40px 24px 24px; border-bottom:1px solid #f0edf7;">
                <img src="https://choicelab.app/star-voting/logo.png" width="72" height="72" alt="STAR Voting"
                     style="display:block; width:72px; height:72px; border-radius:16px;">
                <div style="margin-top:16px; font-size:20px; font-weight:700; color:#1a1523; letter-spacing:0.2px;">
                  STAR Voting
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px 28px;">
                <h1 style="margin:0 0 12px; font-size:22px; line-height:1.3; color:#1a1523; font-weight:700;">
                  You're invited to vote
                </h1>
                <p style="margin:0 0 28px; font-size:15px; line-height:1.6; color:#5b5468;">
                  You've been invited to vote in&nbsp;<strong>$html$ || v_title_html || $html$</strong>. Sign in with this
                  email address to see the options and cast your ballot.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td align="center" style="border-radius:10px; background:linear-gradient(135deg,#7e14ff,#47bfff); background-color:#7e14ff;">
                      <a href="$html$ || v_link || $html$"
                         style="display:inline-block; padding:14px 36px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:10px;">
                        View poll &rarr;
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:28px 0 0; font-size:13px; line-height:1.6; color:#9691a3;">
                  Button not working? Paste this link into your browser:<br>
                  <a href="$html$ || v_link || $html$" style="color:#7e14ff; word-break:break-all;">$html$ || v_link || $html$</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px; border-top:1px solid #f0edf7;">
                <p style="margin:0; font-size:12px; line-height:1.6; color:#b3aec0; text-align:center;">
                  Sent by ChoiceLab.app
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
$html$;

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_api_key
    ),
    body := jsonb_build_object(
      'from', 'STAR Voting <noreply@choicelab.app>',
      'to', jsonb_build_array(new.email),
      'subject', 'You''re invited to vote: ' || coalesce(v_poll_title, 'a poll'),
      'html', v_html
    ),
    timeout_milliseconds := 8000
  );

  return new;
end;
$_$;


ALTER FUNCTION "public"."send_invite_email"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_poll_creator_email"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  new.created_by_email := lower(auth.jwt() ->> 'email');
  return new;
end;
$$;


ALTER FUNCTION "public"."set_poll_creator_email"() OWNER TO "postgres";


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
  v_matchups jsonb;
  v_fs jsonb;
  v_steps jsonb;
  v_advanced jsonb;
  v_resolved text;
  v_wn int; v_fn int; v_wn1 int; v_fn1 int;
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
  left join scores s on s.candidate_id = c.id
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
      -- Every ordered pair in the tied group, with the ballots that scored
      -- the first above the second, the second above the first, and the two
      -- the same. Counted both ways round because the win totals below read
      -- one row per option per opponent; the payload keeps one row per pair.
      drop table if exists _tb_pairs;
      create temp table _tb_pairs on commit drop as
      with grp as (select unnest(v_group) as cid),
      pairs as (
        select g1.cid as a, g2.cid as b
        from grp g1 join grp g2 on g1.cid <> g2.cid
      )
      select
        p.a,
        p.b,
        (count(*) filter (where v.a_score > v.b_score))::int as prefers_a,
        (count(*) filter (where v.b_score > v.a_score))::int as prefers_b,
        (count(*) filter (where v.a_score = v.b_score))::int as ties
      from pairs p
      cross join lateral (
        select
          coalesce((select score from scores where ballot_id = bal.id and candidate_id = p.a), 0) as a_score,
          coalesce((select score from scores where ballot_id = bal.id and candidate_id = p.b), 0) as b_score
        from ballots bal
        where bal.poll_id = p_poll_id
      ) v
      group by p.a, p.b;

      drop table if exists _tb;
      create temp table _tb on commit drop as
      with grp as (select unnest(v_group) as cid),
      wins as (
        select m.a as cid, (count(*) filter (where m.prefers_a > m.prefers_b))::int as w
        from _tb_pairs m group by m.a
      )
      select
        g.cid,
        t.name,
        t.total,
        t.five_stars,
        coalesce(w.w, 0) as h2h_wins,
        row_number() over (order by coalesce(w.w, 0) desc, t.five_stars desc, g.cid) as rn
      from grp g
      join _round t on t.cid = g.cid
      left join wins w on w.cid = g.cid;

      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'total_score', total) order by name)
        into v_tied from _tb;
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', h2h_wins) order by h2h_wins desc, name)
        into v_h2h from _tb;
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', five_stars) order by five_stars desc, name)
        into v_fs from _tb;

      -- One row per pair rather than two: the halves of a matchup are the
      -- same comparison read from opposite ends. The id joins the name in
      -- the ordering so that two options sharing a name still pick a side.
      select jsonb_agg(jsonb_build_object(
               'a', m.a, 'a_name', ca.name,
               'b', m.b, 'b_name', cb.name,
               'prefers_a', m.prefers_a,
               'prefers_b', m.prefers_b,
               'ties', m.ties) order by ca.name, cb.name)
        into v_matchups
      from _tb_pairs m
      join _round ca on ca.cid = m.a
      join _round cb on cb.cid = m.b
      where (ca.name, m.a) < (cb.name, m.b);

      -- Whatever separates the last advancing option from the first
      -- eliminated one is what actually decided the tie.
      select h2h_wins, five_stars into v_wn, v_fn from _tb where rn = v_need;
      select h2h_wins, five_stars into v_wn1, v_fn1 from _tb where rn = v_need + 1;

      if v_wn > v_wn1 then
        v_resolved := 'head_to_head';
      elsif v_fn > v_fn1 then
        v_resolved := 'five_star_votes';
      else
        v_resolved := 'random';
      end if;

      v_steps := jsonb_build_array(jsonb_build_object(
        'rule', 'head_to_head',
        'results', v_h2h,
        'matchups', coalesce(v_matchups, '[]'::jsonb),
        'decisive', v_resolved = 'head_to_head'));

      if v_resolved <> 'head_to_head' then
        v_steps := v_steps || jsonb_build_array(jsonb_build_object(
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
    from ballots bal
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


ALTER FUNCTION "public"."star_round"("p_poll_id" "uuid", "p_pool" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_ballot_id uuid;
  v_candidate_count int;
  v_item jsonb;
  v_candidate_id uuid;
  v_score int;
begin
  if v_email is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from polls where id = p_poll_id and closed_at is not null) then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  if exists (
    select 1 from polls
    where id = p_poll_id and solicit_options and options_finalized_at is null
  ) then
    raise exception 'This poll is still collecting options, so voting has not started';
  end if;

  if not exists (
    select 1 from invited_voters where poll_id = p_poll_id and email = v_email
  ) then
    raise exception 'You are not invited to this poll';
  end if;

  if exists (
    select 1 from ballots where poll_id = p_poll_id and voter_id = auth.uid()
  ) then
    raise exception 'You have already voted in this poll';
  end if;

  select count(*) into v_candidate_count from candidates where poll_id = p_poll_id;

  if jsonb_array_length(p_scores) is distinct from v_candidate_count then
    raise exception 'Must submit a score for every option';
  end if;

  insert into ballots (poll_id, voter_id) values (p_poll_id, auth.uid())
  returning id into v_ballot_id;

  for v_item in select * from jsonb_array_elements(p_scores)
  loop
    v_candidate_id := (v_item ->> 'candidate_id')::uuid;
    v_score := (v_item ->> 'score')::int;

    if v_score < 0 or v_score > 5 then
      raise exception 'Score must be between 0 and 5';
    end if;

    if not exists (select 1 from candidates where id = v_candidate_id and poll_id = p_poll_id) then
      raise exception 'Invalid option for this poll';
    end if;

    insert into scores (ballot_id, candidate_id, score) values (v_ballot_id, v_candidate_id, v_score);
  end loop;
end;
$$;


ALTER FUNCTION "public"."submit_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text" DEFAULT NULL::"text") RETURNS "void"
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

  perform add_suggested_option(v_poll, p_name, p_description);
end;
$$;


ALTER FUNCTION "public"."suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ballots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "poll_id" "uuid" NOT NULL,
    "voter_id" "uuid",
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "voter_name" "text",
    "voter_key" "text",
    "revised_at" timestamp with time zone
);


ALTER TABLE "public"."ballots" OWNER TO "postgres";


COMMENT ON COLUMN "public"."ballots"."revised_at" IS 'When this ballot was last changed, or null if it never was. The scores are overwritten in place, so this is the only trace a revision leaves -- there is no history of what was scored before, which is the same secret ballot the poll promised when it was cast.';



CREATE TABLE IF NOT EXISTS "public"."candidates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "poll_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."candidates" OWNER TO "postgres";


COMMENT ON COLUMN "public"."candidates"."description" IS 'Optional detail shown under the option name on the ballot. Fixed at creation, like everything else about a poll.';



CREATE TABLE IF NOT EXISTS "public"."invited_voters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "poll_id" "uuid" NOT NULL,
    "email" "text" NOT NULL
);


ALTER TABLE "public"."invited_voters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ballot_id" "uuid" NOT NULL,
    "candidate_id" "uuid" NOT NULL,
    "score" smallint NOT NULL,
    CONSTRAINT "scores_score_check" CHECK ((("score" >= 0) AND ("score" <= 5)))
);


ALTER TABLE "public"."scores" OWNER TO "postgres";


ALTER TABLE ONLY "public"."ballots"
    ADD CONSTRAINT "ballots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ballots"
    ADD CONSTRAINT "ballots_poll_id_voter_id_key" UNIQUE ("poll_id", "voter_id");



ALTER TABLE ONLY "public"."candidates"
    ADD CONSTRAINT "candidates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invited_voters"
    ADD CONSTRAINT "invited_voters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invited_voters"
    ADD CONSTRAINT "invited_voters_poll_id_email_key" UNIQUE ("poll_id", "email");



ALTER TABLE ONLY "public"."polls"
    ADD CONSTRAINT "polls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scores"
    ADD CONSTRAINT "scores_ballot_id_candidate_id_key" UNIQUE ("ballot_id", "candidate_id");



ALTER TABLE ONLY "public"."scores"
    ADD CONSTRAINT "scores_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_ballots_poll_id" ON "public"."ballots" USING "btree" ("poll_id");



CREATE INDEX "idx_candidates_poll_id" ON "public"."candidates" USING "btree" ("poll_id");



CREATE INDEX "idx_invited_voters_email" ON "public"."invited_voters" USING "btree" ("email");



CREATE INDEX "idx_invited_voters_poll_id" ON "public"."invited_voters" USING "btree" ("poll_id");



CREATE INDEX "idx_polls_created_at" ON "public"."polls" USING "btree" ("created_at");



CREATE INDEX "idx_polls_group_id" ON "public"."polls" USING "btree" ("group_id") WHERE ("group_id" IS NOT NULL);



CREATE INDEX "idx_scores_ballot_id" ON "public"."scores" USING "btree" ("ballot_id");



CREATE INDEX "idx_scores_candidate_id" ON "public"."scores" USING "btree" ("candidate_id");



CREATE UNIQUE INDEX "uq_ballots_poll_voter_key" ON "public"."ballots" USING "btree" ("poll_id", "voter_key") WHERE ("voter_key" IS NOT NULL);



CREATE UNIQUE INDEX "uq_ballots_poll_voter_name" ON "public"."ballots" USING "btree" ("poll_id", "lower"("voter_name")) WHERE ("voter_name" IS NOT NULL);



CREATE UNIQUE INDEX "uq_polls_group_position" ON "public"."polls" USING "btree" ("group_id", "question_position") WHERE ("group_id" IS NOT NULL);



CREATE UNIQUE INDEX "uq_polls_public_token" ON "public"."polls" USING "btree" ("public_token");



CREATE OR REPLACE TRIGGER "ballots_broadcast_delete" AFTER DELETE ON "public"."ballots" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_emptied"();



CREATE OR REPLACE TRIGGER "ballots_broadcast_insert" AFTER INSERT ON "public"."ballots" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_touched"();



CREATE OR REPLACE TRIGGER "candidates_broadcast_delete" AFTER DELETE ON "public"."candidates" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_emptied"();



CREATE OR REPLACE TRIGGER "candidates_broadcast_insert" AFTER INSERT ON "public"."candidates" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_touched"();



CREATE OR REPLACE TRIGGER "candidates_broadcast_update" AFTER UPDATE ON "public"."candidates" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_touched"();



CREATE OR REPLACE TRIGGER "invited_voters_broadcast_delete" AFTER DELETE ON "public"."invited_voters" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_emptied"();



CREATE OR REPLACE TRIGGER "invited_voters_broadcast_insert" AFTER INSERT ON "public"."invited_voters" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_invites_sent"();



CREATE OR REPLACE TRIGGER "polls_broadcast_update" AFTER UPDATE ON "public"."polls" FOR EACH ROW EXECUTE FUNCTION "public"."broadcast_poll_updated"();



CREATE OR REPLACE TRIGGER "trg_guard_invitee_changes" BEFORE INSERT OR DELETE ON "public"."invited_voters" FOR EACH ROW EXECUTE FUNCTION "public"."guard_invitee_changes"();



CREATE OR REPLACE TRIGGER "trg_guard_options_frozen" BEFORE INSERT OR DELETE ON "public"."candidates" FOR EACH ROW EXECUTE FUNCTION "public"."guard_options_frozen"();



CREATE OR REPLACE TRIGGER "trg_normalize_invited_email" BEFORE INSERT OR UPDATE ON "public"."invited_voters" FOR EACH ROW EXECUTE FUNCTION "public"."normalize_invited_email"();



CREATE OR REPLACE TRIGGER "trg_send_invite_email" AFTER INSERT ON "public"."invited_voters" FOR EACH ROW WHEN ("public"."poll_is_first_question"("new"."poll_id")) EXECUTE FUNCTION "public"."send_invite_email"();



CREATE OR REPLACE TRIGGER "trg_set_poll_creator_email" BEFORE INSERT ON "public"."polls" FOR EACH ROW EXECUTE FUNCTION "public"."set_poll_creator_email"();



ALTER TABLE ONLY "public"."ballots"
    ADD CONSTRAINT "ballots_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ballots"
    ADD CONSTRAINT "ballots_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."candidates"
    ADD CONSTRAINT "candidates_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invited_voters"
    ADD CONSTRAINT "invited_voters_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."polls"
    ADD CONSTRAINT "polls_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."scores"
    ADD CONSTRAINT "scores_ballot_id_fkey" FOREIGN KEY ("ballot_id") REFERENCES "public"."ballots"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scores"
    ADD CONSTRAINT "scores_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE CASCADE;



ALTER TABLE "public"."ballots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ballots_select_own" ON "public"."ballots" FOR SELECT USING (("voter_id" = "auth"."uid"()));



ALTER TABLE "public"."candidates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "candidates_delete" ON "public"."candidates" FOR DELETE USING ("public"."is_poll_creator"("poll_id"));



CREATE POLICY "candidates_insert" ON "public"."candidates" FOR INSERT WITH CHECK ("public"."is_poll_creator"("poll_id"));



CREATE POLICY "candidates_select" ON "public"."candidates" FOR SELECT USING (("public"."is_poll_creator"("poll_id") OR "public"."is_invited_to_poll"("poll_id")));



ALTER TABLE "public"."invited_voters" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invited_voters_delete" ON "public"."invited_voters" FOR DELETE USING ("public"."is_poll_creator"("poll_id"));



CREATE POLICY "invited_voters_insert" ON "public"."invited_voters" FOR INSERT WITH CHECK ("public"."is_poll_creator"("poll_id"));



CREATE POLICY "invited_voters_select" ON "public"."invited_voters" FOR SELECT USING ((("email" = "lower"(("auth"."jwt"() ->> 'email'::"text"))) OR "public"."is_poll_creator"("poll_id")));



ALTER TABLE "public"."polls" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "polls_delete" ON "public"."polls" FOR DELETE USING (("created_by" = "auth"."uid"()));



CREATE POLICY "polls_insert" ON "public"."polls" FOR INSERT WITH CHECK (("created_by" = "auth"."uid"()));



CREATE POLICY "polls_select" ON "public"."polls" FOR SELECT USING ((("created_by" = "auth"."uid"()) OR "public"."is_invited_to_poll"("id")));



ALTER TABLE "public"."scores" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";








GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

















































































































































































GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."polls" TO "anon";
GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."polls" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."polls" TO "service_role";



REVOKE ALL ON FUNCTION "public"."add_suggested_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."assert_results_readable"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."ballot_sheet"("p_poll_id" "uuid", "p_named" boolean) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."close_poll"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."close_poll"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."finalize_options"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_options"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_poll_ranking"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_ranking"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_poll_results"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_results"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid", "p_question_position" integer) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."is_invited_to_poll"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_invited_to_poll"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."is_poll_creator"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_poll_creator"("p_poll_id" "uuid") TO "authenticated";



GRANT ALL ON FUNCTION "public"."list_polls"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."normalize_invite_emails"("p_emails" "text"[]) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."open_poll_ballots"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_ballots"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_ballots"("p_token" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_group"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_group"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_group"("p_token" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_ranking"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_ranking"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_ranking"("p_token" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_results"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_results"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_results"("p_token" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_revise"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_revise"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_revise"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_submit"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_submit"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_submit"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_suggest_option"("p_token" "text", "p_name" "text", "p_description" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_suggest_option"("p_token" "text", "p_name" "text", "p_description" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_suggest_option"("p_token" "text", "p_name" "text", "p_description" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_view"("p_token" "text", "p_voter_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_view"("p_token" "text", "p_voter_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_view"("p_token" "text", "p_voter_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_results_poll_id"("p_token" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_ballot_scores"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_ballot_scores"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."poll_ballots"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_ballots"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."poll_expires_at"("p_poll" "public"."polls") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_gate_open"("p_poll" "public"."polls") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_group"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_group"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."poll_group_members"("p_poll" "public"."polls") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."poll_is_first_question"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_ranking"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_results_revealed"("p_poll" "public"."polls") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_retention_window"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_status"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_status"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."poll_tally"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_winner_name"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_winners"("p_poll_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_winners"("p_poll_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."purge_old_polls"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."replace_scores"("p_ballot_id" "uuid", "p_poll_id" "uuid", "p_scores" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."reset_poll"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reset_poll"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."revise_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."revise_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."star_round"("p_poll_id" "uuid", "p_pool" "uuid"[]) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."submit_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") TO "authenticated";
























GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ballots" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ballots" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ballots" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."candidates" TO "anon";
GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."candidates" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."candidates" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."invited_voters" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."invited_voters" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."invited_voters" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."scores" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."scores" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."scores" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "service_role";
































--
-- Dumped schema changes for auth and storage
--





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
    "show_ballots" boolean DEFAULT false NOT NULL,
    "solicit_options" boolean DEFAULT false NOT NULL,
    "options_finalized_at" timestamp with time zone,
    "group_id" "uuid",
    "question_position" integer,
    "question_title" "text",
    "winner_name" "text",
    "winner_settled_at" timestamp with time zone,
    "kind" "text" DEFAULT 'option'::"text" NOT NULL,
    "schedule" "jsonb",
    "options_edited_after_votes" boolean DEFAULT false NOT NULL,
    "votes_after_reveal" boolean DEFAULT false NOT NULL,
    "reopened_after_reveal" boolean DEFAULT false NOT NULL,
    CONSTRAINT "polls_kind_ck" CHECK (("kind" = ANY (ARRAY['option'::"text", 'time'::"text"]))),
    CONSTRAINT "polls_mode_ck" CHECK (("mode" = ANY (ARRAY['invite'::"text", 'open'::"text"]))),
    CONSTRAINT "polls_options_finalized_ck" CHECK ((("options_finalized_at" IS NULL) OR "solicit_options")),
    CONSTRAINT "polls_question_ck" CHECK (((("group_id" IS NULL) AND ("question_position" IS NULL) AND ("question_title" IS NULL)) OR (("group_id" IS NOT NULL) AND ("question_position" >= 1) AND ("question_title" IS NOT NULL)))),
    CONSTRAINT "polls_schedule_ck" CHECK (((("kind" = 'option'::"text") AND ("schedule" IS NULL)) OR (("kind" = 'time'::"text") AND ("schedule" IS NOT NULL)))),
    CONSTRAINT "polls_winner_settled_ck" CHECK ((("winner_name" IS NULL) OR ("winner_settled_at" IS NOT NULL)))
);


ALTER TABLE "public"."polls" OWNER TO "postgres";


COMMENT ON COLUMN "public"."polls"."show_ballots" IS 'Publish individual ballots once results unlock. Independent of show_voters, which decides whether a name is attached to each one.';



COMMENT ON COLUMN "public"."polls"."solicit_options" IS 'The options were collected from respondents rather than written by the creator. A setting, frozen at creation like mode, show_voters and show_ballots.';



COMMENT ON COLUMN "public"."polls"."options_finalized_at" IS 'When the creator closed the option list and opened voting. Null on a poll still collecting options; never set on a poll that did not solicit them.';



COMMENT ON COLUMN "public"."polls"."group_id" IS 'The multi-question poll this question belongs to, or null on a poll that asks one question. Every question in a group shares its title, description, mode and settings; what differs is question_title, the options and the ballots.';



COMMENT ON COLUMN "public"."polls"."question_position" IS 'Where this question sits in its group, from 1. The poll list shows position 1 and hides the rest, and the invite email is sent for it alone.';



COMMENT ON COLUMN "public"."polls"."question_title" IS 'What this one question asks. The poll''s own title is shared across the group, so that the set reads as one poll and this is the part that varies.';



COMMENT ON COLUMN "public"."polls"."winner_name" IS 'The option this question elected, null for a question that elected nobody. Meaningful only where winner_settled_at is set. Maintained by settle_winner(); never written by a client.';



COMMENT ON COLUMN "public"."polls"."winner_settled_at" IS 'When this question''s result was worked out. Null means it has none yet -- it is still taking votes, or a reset took its result away.';



COMMENT ON COLUMN "public"."polls"."kind" IS 'What the poll is choosing between. ''option'' is an ordinary ballot; ''time'' is a poll whose options are the start of a meeting window and whose ballot is a calendar. A setting, frozen at creation like mode.';



COMMENT ON COLUMN "public"."polls"."schedule" IS 'How a time poll''s grid is laid out: {timezone, window: {start, end}, desired_slots, granularity}. Only what cannot be recovered from the options -- the in-bounds days are exactly the dates the options start on, so the client derives those and the two can never disagree. Null on an option poll; required on a time poll.';



COMMENT ON COLUMN "public"."polls"."options_edited_after_votes" IS 'The creator corrected this question''s option list while it already held ballots. A flag rather than a log: the banner it draws under the results says the tally rests on a list that moved, and which option moved is not something a secret ballot could be asked afterwards. Never cleared -- a poll cannot un-edit a list people have already scored.';



COMMENT ON COLUMN "public"."polls"."votes_after_reveal" IS 'A ballot was cast or changed on this question after its results had been shown. Set by the trigger on ballots, off reopened_after_reveal below, so every door into that table raises it for free.';



COMMENT ON COLUMN "public"."polls"."reopened_after_reveal" IS 'This question was reopened having already shown its tally, which is what makes the next vote a late one. Internal bookkeeping for the flag above: poll_results_revealed is computed from closed_at and turnout, so it goes false the moment the poll reopens and cannot answer "was it ever out" afterwards.';



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


CREATE OR REPLACE FUNCTION "public"."announce"("p_topic" "text", "p_event" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_told text := coalesce(current_setting('app.announced', true), '');
  -- The event is part of the key: a topic told that a poll changed has still
  -- not been told that it has gone. `|` cannot appear in either half -- a
  -- topic is a fixed prefix and a uuid, an event a fixed word.
  v_key text := '|' || p_topic || '|' || p_event || '|';
begin
  if position(v_key in v_told) > 0 then
    return;
  end if;

  -- Both halves live in the same (sub)transaction and so are undone together:
  -- a send rolled back by an exception takes the record of it with it, and
  -- the topic can be told again by whatever runs next. The setting is local,
  -- so the commit clears it with nothing to remember to do.
  perform set_config('app.announced', v_told || v_key, true);
  perform realtime.send('{}'::jsonb, p_event, p_topic, false);
end;
$$;


ALTER FUNCTION "public"."announce"("p_topic" "text", "p_event" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."announce"("p_topic" "text", "p_event" "text") IS 'Tells one topic that something happened, at most once per topic and event per transaction. Every live-update message goes through here: the payload is empty and nothing reaches a listener before the commit, so a second message from the same transaction is a wasted round trip rather than news. Internal.';



CREATE OR REPLACE FUNCTION "public"."assert_collecting_options"("p_poll" "public"."polls") RETURNS "void"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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
end;
$$;


ALTER FUNCTION "public"."assert_collecting_options"("p_poll" "public"."polls") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."assert_collecting_options"("p_poll" "public"."polls") IS 'Raises unless this poll is still collecting its options. Internal: shared by the confirm functions, in the words add_suggested_option refuses a late suggestion in.';



CREATE OR REPLACE FUNCTION "public"."assert_open_results_readable"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted int;
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

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
end;
$$;


ALTER FUNCTION "public"."assert_open_results_readable"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."assert_open_results_readable"("p_poll_id" "uuid") IS 'Raises unless this open poll''s tally may be read: it exists, it is open-mode, every question''s gate is open, and somebody voted. Internal: the two public tally functions call it and then read the tally themselves.';



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


CREATE OR REPLACE FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_creator uuid;
  v_user uuid;
begin
  if p_poll_id is null then
    return;
  end if;

  -- A poll that is on its way out has nobody left to tell, and its rows are
  -- following it: without this, every cascade delete would send one message
  -- per child row for a poll that no longer exists. It is also what keeps
  -- the nightly purge silent.
  select created_by into v_creator
  from polls where id = p_poll_id;
  if not found then
    return;
  end if;

  perform announce('poll:' || p_poll_id::text, 'poll_changed');

  -- And the same trick for the poll list, which holds no poll id at all until
  -- it has read one: everyone whose list this poll is on. Its creator, its
  -- invitees, and -- on an open poll -- every account that has answered it
  -- through the link, which is the third way onto the list since 0075.
  -- `union` rather than `union all`: a creator who invited themselves, or
  -- voted in their own open poll, is one reader with one list.
  for v_user in
    select u.id from auth.users u where u.id = v_creator
    union
    select u.id
    from invited_voters iv
    join auth.users u on lower(u.email) = lower(iv.email)
    where iv.poll_id = p_poll_id
    union
    select a from poll_answering_accounts(p_poll_id) a
  loop
    perform announce('user:' || v_user::text, 'polls_changed');
  end loop;
end;
$$;


ALTER FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") IS 'Tells anyone watching this poll that it moved, without saying how: the poll''s own topic, and the list of everyone it is on -- its creator, its invitees, and every account that has answered it through its link. Each of them once per transaction, however many statements the change took; see announce(). Internal: called from the broadcast triggers, never by a client.';



CREATE OR REPLACE FUNCTION "public"."broadcast_poll_gone"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user uuid;
begin
  -- The nightly purge stays silent, exactly as it always has. It is one
  -- statement that can take hundreds of expired polls at once, months after
  -- anybody last looked at them, and announcing each of them to everyone
  -- they were ever shared with is a burst of messages in the small hours to
  -- tell nobody about a poll they had long since finished with.
  -- purge_old_polls() sets this for its own transaction and nothing else
  -- does; see below.
  if coalesce(current_setting('app.purging_polls', true), '') = 'on' then
    return old;
  end if;

  -- Whoever has the poll itself open. Under an event of its own, because
  -- `poll_changed` means "re-read" and a re-read of a poll that has gone is a
  -- read that fails; `poll_deleted` is the answer rather than a prompt to go
  -- and find one. A group goes out question by question through this same
  -- trigger, and each question's page is watching its own topic, so each
  -- one is told.
  perform announce('poll:' || old.id::text, 'poll_deleted');

  -- The audience broadcast_poll_change() reaches, read while it can still be
  -- read -- this is a BEFORE trigger, so the invitees, the ballots and the
  -- confirmations that decide it are all still here. `union` rather than
  -- `union all`: a creator who invited themselves is one reader with one list.
  --
  -- A group goes out as several polls through this same trigger, and each
  -- question reaches the same lists. They hear once: a list re-read after the
  -- commit already has every question gone, so the second message was only
  -- ever a second round trip to show the same thing. See announce().
  for v_user in
    select u.id from auth.users u where u.id = old.created_by
    union
    select u.id
    from invited_voters iv
    join auth.users u on lower(u.email) = lower(iv.email)
    where iv.poll_id = old.id
    union
    select a from poll_answering_accounts(old.id) a
  loop
    perform announce('user:' || v_user::text, 'polls_changed');
  end loop;

  return old;
end;
$$;


ALTER FUNCTION "public"."broadcast_poll_gone"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."broadcast_poll_gone"() IS 'Tells whoever has this poll open that it has gone (poll_deleted on its own topic), and the list of everyone who can see it that it is going, while its invitee list still exists to be read. Once per topic per transaction, so a group of questions going out together reaches each list once. Silent under the nightly purge. Internal: the BEFORE DELETE trigger on polls, never called by a client.';



CREATE OR REPLACE FUNCTION "public"."broadcast_poll_updated"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if (
    NEW.winner_name is distinct from OLD.winner_name
    or NEW.winner_settled_at is distinct from OLD.winner_settled_at
  ) and to_jsonb(NEW) - 'winner_name' - 'winner_settled_at'
        is not distinct from
        to_jsonb(OLD) - 'winner_name' - 'winner_settled_at'
  then
    return null;
  end if;

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
  v_user uuid;
begin
  for v_poll in select distinct poll_id from old_rows loop
    perform broadcast_poll_change(v_poll);
  end loop;

  -- The accounts whose own rows these were. After the delete they are no
  -- longer anybody broadcast_poll_change() can find, and the poll may have
  -- just left their list with them -- a confirmation taken back was the only
  -- reason it was on it. Read off the row as json because this one trigger
  -- function serves every table that announces a delete, and only ballots and
  -- option_confirmations carry the column; everywhere else it is null and
  -- this loop is empty. A poll being deleted says nothing here either: its
  -- rows cascade after broadcast_poll_gone has already told these lists, and
  -- announce() drops the repeat.
  for v_user in
    select distinct (to_jsonb(o) ->> 'account_id')::uuid from old_rows o
    where to_jsonb(o) ->> 'account_id' is not null
      and exists (select 1 from polls p where p.id = o.poll_id)
  loop
    perform announce('user:' || v_user::text, 'polls_changed');
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


CREATE OR REPLACE FUNCTION "public"."clear_confirmation_for_uninvited"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  delete from option_confirmations oc
  using auth.users u
  where oc.voter_id = u.id
    and oc.poll_id = old.poll_id
    and lower(u.email) = old.email;

  perform open_options_when_all_confirmed(old.poll_id);
  return null;
end;
$$;


ALTER FUNCTION "public"."clear_confirmation_for_uninvited"() OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."confirm_options"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  v_poll := confirming_invitee(p_poll_id);
  perform assert_collecting_options(v_poll);

  -- Idempotent: confirming twice is one confirmation, and a double-click on a
  -- slow connection is not an error worth reporting to anybody.
  insert into option_confirmations (poll_id, voter_id)
  values (v_poll.id, auth.uid())
  on conflict do nothing;

  -- The last one in opens the poll. Nothing here is conditional on this
  -- caller being last: the function asks the whole group and shrugs unless it
  -- has run out of people to wait for.
  perform open_options_when_all_confirmed(v_poll.id);
end;
$$;


ALTER FUNCTION "public"."confirm_options"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."confirm_options"("p_poll_id" "uuid") IS 'Records that this invitee is done adding options to this question, and opens the poll for voting if that was the last confirmation it was waiting on.';



CREATE OR REPLACE FUNCTION "public"."confirming_invitee"("p_poll_id" "uuid") RETURNS "public"."polls"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
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

  if v_poll.mode <> 'invite' then
    raise exception 'This poll is open to anyone with the link, so its options are confirmed through that link';
  end if;

  -- The same list submit_ballot reads. A creator who is not on it can add
  -- options like anybody else and opens the poll with Open poll, which is
  -- their version of this and always was.
  if not exists (
    select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email
  ) then
    raise exception 'Poll not found';
  end if;

  return v_poll;
end;
$$;


ALTER FUNCTION "public"."confirming_invitee"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."confirming_invitee"("p_poll_id" "uuid") IS 'The poll behind an invite-mode confirmation, having established that the caller is on its invite list. Internal: shared by confirm_options and unconfirm_options so the two cannot disagree about who may confirm.';



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



CREATE OR REPLACE FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted boolean;
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

  if v_poll.kind = 'time' then
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


ALTER FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") IS 'Adds an option to the creator''s own poll, up until it closes. On a poll that already has ballots the addition is marked, and every ballot already cast scores the new option zero; where the options came from does not enter into it.';



CREATE OR REPLACE FUNCTION "public"."creator_add_options"("p_poll_id" "uuid", "p_options" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_added int;
  v_voted boolean;
begin
  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  select exists (select 1 from ballots where poll_id = p_poll_id) into v_voted;

  perform set_config('app.editing_options', p_poll_id::text, true);
  v_added := insert_options(v_poll, p_options);
  perform set_config('app.editing_options', '', true);

  if v_voted and v_added > 0 then
    update polls set options_edited_after_votes = true
    where id = p_poll_id and not options_edited_after_votes;
  end if;

  return v_added;
end;
$$;


ALTER FUNCTION "public"."creator_add_options"("p_poll_id" "uuid", "p_options" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."creator_add_options"("p_poll_id" "uuid", "p_options" "jsonb") IS 'The creator''s correction to an option list that is already a ballot, applied in one go rather than one option per request, and marking the poll when it lands on one with votes in it. Allowed on a time poll, where the names come from a painted calendar; the singular creator_add_option is the typed-name path and still refuses one.';



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

  p_correct := coalesce(p_correct, '[]'::jsonb);
  if jsonb_typeof(p_correct) <> 'array' then
    raise exception 'Give the corrections as a list';
  end if;

  -- A typed correction is a typed name, and a time poll's names are windows
  -- the calendar draws and the window rule scores: the same refusal
  -- creator_add_option gives the typed-name path.
  if jsonb_array_length(p_correct) > 0 and v_poll.kind = 'time' then
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


ALTER FUNCTION "public"."creator_edit_options"("p_poll_id" "uuid", "p_options" "jsonb", "p_remove" "uuid"[], "p_correct" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."creator_edit_options"("p_poll_id" "uuid", "p_options" "jsonb", "p_remove" "uuid"[], "p_correct" "jsonb") IS 'The creator''s correction to an option list in one transaction -- options to drop, options corrected in place, options to add -- answering how many were added. A correction is an update, so the option keeps its id, its place and every score given to it. The two-option floor is applied to what the edit leaves behind rather than to the states it passes through. An edit that moves something on a poll with ballots in it marks the poll, which is what the results banner is drawn from.';



CREATE OR REPLACE FUNCTION "public"."email_escape"("p_text" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select replace(replace(replace(coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;


ALTER FUNCTION "public"."email_escape"("p_text" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."email_escape"("p_text" "text") IS 'Text as it goes into an email body: the three characters that would otherwise be markup. Internal.';



CREATE OR REPLACE FUNCTION "public"."fill_scores_for_new_option"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- An option added to a poll with ballots in it lands on ballots that were
  -- cast without it, and *one score per option per ballot* is an invariant the
  -- rest of the schema reads rather than checks: replace_scores counts the
  -- rows it moved and refuses a ballot it could only half-rewrite,
  -- poll_ballots publishes a grid, and the CSV is that grid. Left to
  -- themselves those ballots would score the new option nothing at all, which
  -- the tally already reads as zero (poll_tally left-joins scores) and the
  -- other three read as a ballot that has come apart.
  --
  -- So the zero is written down. It is the same number the tally would have
  -- inferred, and it keeps a voter's ability to change their vote: without a
  -- row here, replace_scores would refuse every revision of an older ballot
  -- for the rest of the poll's life.
  --
  -- On the far commoner path -- a poll being created, a list being collected
  -- -- there are no ballots and this inserts nothing.
  insert into scores (ballot_id, candidate_id, score)
  select b.id, new.id, 0
  from ballots b
  where b.poll_id = new.poll_id
  on conflict (ballot_id, candidate_id) do nothing;

  return null;
end;
$$;


ALTER FUNCTION "public"."fill_scores_for_new_option"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."fill_scores_for_new_option"() IS 'Scores an option added to a poll that already has ballots as zero on every one of them, so that "one score per option per ballot" holds through a late correction. Internal: a trigger on candidates.';



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

  perform notify_poll_opened(v_poll.id, false);
end;
$$;


ALTER FUNCTION "public"."finalize_options"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."finalize_options"("p_poll_id" "uuid") IS 'Turns a collected option list into a ballot, for every question of the poll at once, and tells the voters. Refuses until each of them has two options, naming the one that is short.';



CREATE OR REPLACE FUNCTION "public"."forget_push_endpoints"("p_endpoints" "text"[]) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  delete from push_subscriptions where endpoint = any (p_endpoints);
  delete from poll_push_watches where endpoint = any (p_endpoints);
$$;


ALTER FUNCTION "public"."forget_push_endpoints"("p_endpoints" "text"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."forget_push_endpoints"("p_endpoints" "text"[]) IS 'Drops browsers whose push service has said they are gone (404 or 410). Called by the send-push Edge Function, which is the only thing that ever sees the answer; nothing else may call it.';



CREATE OR REPLACE FUNCTION "public"."forget_push_subscription"("p_endpoint" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    return;
  end if;

  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;


ALTER FUNCTION "public"."forget_push_subscription"("p_endpoint" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."forget_push_subscription"("p_endpoint" "text") IS 'Stops this browser hearing about the signed-in account''s polls: on turning notifications off here, and on signing out.';



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

  -- A poll with votes in it is still not something that changes underneath
  -- anybody by accident. What has changed is that there is now a door through
  -- it: the creator's own correction says so in app.editing_options, marks the
  -- poll, and is announced to every reader. Everything else -- a bare delete
  -- through the candidates_delete policy, a suggestion arriving late -- meets
  -- the rule exactly as it always did.
  if exists (select 1 from ballots where poll_id = v_poll_id)
     and coalesce(current_setting('app.editing_options', true), '') <> v_poll_id::text then
    raise exception 'Cannot change the options of a poll that already has votes';
  end if;

  if tg_op = 'DELETE' then
    -- Only once the list is a ballot. While it is still being collected there
    -- is a later checkpoint -- finalize_options -- and pruning back to one
    -- option, or to none, is a normal thing to do on the way there.
    --
    -- And only when the delete is the whole of what is happening. A creator
    -- swapping one option for two passes through two options and one on the
    -- way to three, and neither of those is a list anybody was ever offered:
    -- creator_edit_options names the poll it is mid-edit on and applies this
    -- same floor to what it leaves behind. See that function.
    if not (v_poll.solicit_options and v_poll.options_finalized_at is null)
       and coalesce(current_setting('app.editing_options', true), '') <> v_poll_id::text then
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


COMMENT ON FUNCTION "public"."guard_options_frozen"() IS 'Holds an option list still against every write but the creator''s own correction, and holds a live ballot to two options. Both step aside for the poll named in app.editing_options, whose floor and whose bookkeeping are creator_edit_options''; the floor also steps aside for a poll still collecting, whose checkpoint is finalize_options.';



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
  if length(v_name) > 150 then
    raise exception 'That option name is too long';
  end if;

  if length(v_description) > 900 then
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

  -- The ceiling is a ceiling on what the tally can be asked to do in the time
  -- a voter is waiting for it, rather than on what a reader will put up with.
  if v_count >= 500 then
    raise exception 'This poll already has as many options as it can hold';
  end if;

  -- Arrival order, which is the order everyone watching the page has been
  -- reading the list in already.
  insert into candidates (poll_id, name, description, sort_order)
  values (p_poll.id, v_name, v_description, v_next);
end;
$$;


ALTER FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") IS 'The field rules for one option -- name, description, duplicates, the 500-option ceiling -- shared by the suggestion path and the creator''s own. Internal: the caller has already decided it may write to this poll.';



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



CREATE OR REPLACE FUNCTION "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid" DEFAULT NULL::"uuid", "p_question_position" integer DEFAULT NULL::integer, "p_kind" "text" DEFAULT 'option'::"text", "p_schedule" "jsonb" DEFAULT NULL::"jsonb") RETURNS "uuid"
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
    solicit_options, group_id, question_position, question_title, kind, schedule
  )
  values (
    p_title, p_description, auth.uid(), p_mode, p_show_voters, p_show_ballots,
    p_solicit_options, p_group_id, p_question_position, p_question_title, p_kind, p_schedule
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


ALTER FUNCTION "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid", "p_question_position" integer, "p_kind" "text", "p_schedule" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid", "p_question_position" integer, "p_kind" "text", "p_schedule" "jsonb") IS 'One poll row with its options and its invitees, for the two functions that create polls. Internal: it checks the title, the description and the option list, because its callers have checked the rest.';



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


CREATE OR REPLACE FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer, "p_removed" boolean DEFAULT false) RETURNS TABLE("id" "uuid", "title" "text", "description" "text", "created_by" "uuid", "created_by_email" "text", "created_at" timestamp with time zone, "closed_at" timestamp with time zone, "mode" "text", "show_voters" boolean, "show_ballots" boolean, "solicit_options" boolean, "options_finalized_at" timestamp with time zone, "invited_count" integer, "voted_count" integer, "option_count" integer, "confirmed_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean, "group_id" "uuid", "question_position" integer, "question_title" "text", "question_count" integer, "winner_name" "text", "winner_settled" boolean, "total_count" integer, "removed_count" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  -- Left as a SQL function rather than plpgsql, as it always was. In plpgsql
  -- the names in RETURNS TABLE become variables that shadow same-named
  -- columns -- `id`, `title`, `voted`, `winner_name` and `total_count` all
  -- appear below -- and the failure is silent rather than an error. See the
  -- note on poll_winners(), which is plpgsql and has to alias around exactly
  -- that.
  with args as (
    -- Floored rather than trusted: a limit of zero or less would ask for an
    -- empty page of a list that has rows in it, and a negative offset is a
    -- syntax error rather than a page.
    select
      greatest(coalesce(p_limit, 1), 1) as lim,
      greatest(coalesce(p_offset, 0), 0) as want
  ), answered as (
    -- The open polls this account has answered through their links, by the
    -- id of the row the list carries for them: a group's first question,
    -- whichever question was answered. Read off the account's own rows by
    -- the account indexes 0075 adds, so it costs what this reader has done
    -- rather than what everybody has.
    select distinct coalesce(head.id, q.id) as id
    from (
      select b.poll_id from ballots b where b.account_id = auth.uid()
      union
      select oc.poll_id from option_confirmations oc where oc.account_id = auth.uid()
    ) a
    join polls q on q.id = a.poll_id
    left join polls head
      on q.group_id is not null and head.group_id = q.group_id and head.question_position = 1
    where q.mode = 'open'
  ), listed as (
    -- The whole row alongside its columns, so the aggregates below can be
    -- handed a poll rather than rebuilding one.
    --
    -- Written out here rather than behind a helper on purpose: a function
    -- call in this predicate is opaque to the planner unless it happens to
    -- inline, and the index 0036 added is only reachable while the
    -- comparison is written where the planner can see it.
    --
    -- The third way onto the list is an open poll this account has answered
    -- through its link. Answering it is already a right to read it, and the
    -- account on the ballot is already recorded (0074), so listing it shows
    -- the reader nothing they could not ask for and tells the database
    -- nothing it does not know.
    --
    -- `via_link` marks the rows that are here only for that reason, so the
    -- columns below can withhold what a link does not carry.
    --
    -- `removed` marks the polls this account has taken off its list (0077).
    -- They are still the reader's -- still readable, still answerable -- so
    -- they are still *here*, and split off below rather than filtered out:
    -- the same set answers both the list and the removed polls' own view,
    -- and counts both.
    select p.*, p as poll_row,
      exists (
        select 1 from removed_polls r
        where r.user_id = auth.uid() and r.poll_id = p.id
      ) as removed,
      not (
        p.created_by = auth.uid()
        or exists (
          select 1 from invited_voters iv
          where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
        )
      ) as via_link
    from polls p
    where (p.group_id is null or p.question_position = 1)
      and (
        p.created_by = auth.uid()
        or exists (
          select 1 from invited_voters iv
          where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
        )
        or p.id in (select a.id from answered a)
      )
  ), visible as (
    -- The list being asked for: the polls the reader has not removed, or --
    -- asked with p_removed -- only the ones they have. Split *before* the
    -- total and the page are taken, so the pager counts exactly the polls it
    -- can show and a page is never full of polls nobody asked to see. This is
    -- the whole of what moving removal into the database bought: when it was
    -- kept in the browser, the page was taken first and filtered after, and a
    -- page whose ten polls were all hidden came back looking empty.
    select * from listed l where l.removed = coalesce(p_removed, false)
  ), counted as (
    -- The one pass over everything the caller can see. It is the price of
    -- reporting a total at all, and it is the cheap half: one predicate and
    -- no subqueries, against that same index.
    --
    -- `removed` is how many polls the other view holds, which is what the
    -- button into it is labelled with and whether it is drawn at all.
    select
      (select count(*)::int from visible) as total,
      (select count(*)::int from listed l where l.removed) as removed
  ), bounds as (
    -- Where the requested page actually starts. Asking past the end lands on
    -- the last page there is rather than on nothing: a poll deleted from page
    -- three leaves its reader on page three, or on the last page if that was
    -- it. The browser clamps the page number it displays the same way, from
    -- the same total, so the two cannot disagree about what is on screen.
    select
      c.total,
      least(a.want, greatest(((c.total - 1) / a.lim) * a.lim, 0)) as page_start
    from counted c, args a
  ), page as (
    -- The page is taken here, before a single aggregate has run.
    --
    -- `id` breaks ties on `created_at`, because offset paging is only correct
    -- over a total order: two rows that compare equal may come back in either
    -- order, and then a row can land on two pages or on none, silently. In
    -- the app polls are made one at a time and their timestamps differ, so
    -- this is insurance -- nothing *enforces* that they differ. In the test
    -- suite it is load-bearing: a case is one transaction, so every poll a
    -- case creates shares a created_at to the microsecond.
    select v.*
    from visible v
    order by v.created_at desc, v.id desc
    limit (select a.lim from args a)
    offset (select b.page_start from bounds b)
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
      -- The same, and per question for the same reason. It is what the count
      -- badge reports while the poll is still collecting, in place of the
      -- turnout that has not started moving yet.
      poll_confirmed_count(v.id) as confirmed_count,
      (select count(*)::int from poll_group_members(v.poll_row)) as question_count,
      -- Asked of every question: a poll is answered when all of it is. By
      -- the account either way it can hold a ballot: as an invitee, or
      -- through the link.
      (select bool_and(
                exists (select 1 from ballots b
                        where b.poll_id = q.id
                          and (b.voter_id = auth.uid() or b.account_id = auth.uid())))
         from poll_group_members(v.poll_row) q) as voted,
      (select bool_and(
                (select count(*) from invited_voters iv where iv.poll_id = q.id) > 0
                and (select count(*) from ballots b where b.poll_id = q.id)
                    >= (select count(*) from invited_voters iv where iv.poll_id = q.id))
         from poll_group_members(v.poll_row) q) as is_complete,
      (select bool_and(q.closed_at is not null)
         from poll_group_members(v.poll_row) q) as is_closed
    from page v
  )
  select
    v.id,
    v.title,
    v.description,
    -- Nobody reading an open poll through its link is told who made it:
    -- `open_poll_view` does not return the address, and this list must not
    -- become the way round that. The creator's account id goes with it,
    -- since it names the same person to anybody who can match it up.
    case when v.via_link then null else v.created_by end,
    case when v.via_link then null else v.created_by_email end,
    v.created_at,
    v.closed_at,
    v.mode,
    v.show_voters,
    v.show_ballots,
    v.solicit_options,
    v.options_finalized_at,
    t.invited_count,
    t.voted_count,
    t.option_count,
    t.confirmed_count,
    t.is_complete,
    t.voted,
    t.is_closed,
    poll_results_revealed(v.poll_row),
    v.solicit_options and v.options_finalized_at is null and v.closed_at is null,
    v.group_id,
    v.question_position,
    v.question_title,
    t.question_count,
    -- A group's row here *is* its first question, so this is that question's
    -- winner rather than the poll's -- a poll of several questions has one
    -- answer each and none to put beside its title. The badge withholds it on
    -- `question_count > 1` and always did; see PollStateBadge, which decides
    -- that in one place rather than trusting three callers to remember.
    v.winner_name,
    v.winner_settled_at is not null,
    (select c.total from counted c),
    (select c.removed from counted c)
  from page v
  join tallied t on t.poll_id = v.id
  order by v.created_at desc, v.id desc;
$$;


ALTER FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer, "p_removed" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer, "p_removed" boolean) IS 'One page of the caller''s poll list, newest first, with the total on every row: the polls they made, the polls they are invited to, and the open polls their account has voted in or confirmed through the link -- which carry no creator. The polls the caller has removed are left out, or with p_removed are the only ones listed; either way every row carries how many are removed. The page is taken before the per-poll aggregates run, so the work is proportional to the rows returned rather than to everything the caller can see. An offset past the end returns the last page there is.';



CREATE OR REPLACE FUNCTION "public"."mark_votes_after_reveal"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- Every way a vote is cast or changed passes through this table -- the two
  -- submit paths insert a ballot, the two revise paths stamp revised_at on one
  -- -- so the flag is raised here rather than in four functions that would
  -- each have to remember to.
  update polls set votes_after_reveal = true
  where id = new.poll_id and reopened_after_reveal and not votes_after_reveal;

  return null;
end;
$$;


ALTER FUNCTION "public"."mark_votes_after_reveal"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."mark_votes_after_reveal"() IS 'Marks a poll whose tally has been seen and whose votes have moved since. Internal: a trigger on ballots.';



CREATE OR REPLACE FUNCTION "public"."my_notification_settings"("p_endpoint" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Sign in to change your notification settings';
  end if;

  -- `this_device` answers for the browser asking, which is the one it can
  -- honestly answer for: whether the subscription it holds is bound to this
  -- account. Another account's binding of the same endpoint is not this
  -- reader's business and reads as false.
  return jsonb_build_object(
    'email', coalesce((select email from notification_settings where user_id = v_user), true),
    'push', coalesce((select push from notification_settings where user_id = v_user), true),
    'this_device', p_endpoint is not null and exists (
      select 1 from push_subscriptions where endpoint = p_endpoint and user_id = v_user));
end;
$$;


ALTER FUNCTION "public"."my_notification_settings"("p_endpoint" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."my_notification_settings"("p_endpoint" "text") IS 'The signed-in account''s two channel settings, and whether the browser holding this endpoint is one of its subscribed devices.';



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


CREATE OR REPLACE FUNCTION "public"."notify_poll_opened"("p_poll_id" "uuid", "p_by_itself" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_first polls;
  v_email text;
  -- Read here rather than passed in, because it is the same fact at both call
  -- sites and neither has to know it: this runs inside the confirmation, the
  -- removal or the button press that opened the poll, so whoever is signed in
  -- is whoever did it.
  v_actor text := lower(auth.jwt() ->> 'email');
begin
  select * into v_poll from polls where id = p_poll_id;

  if not found then
    return;
  end if;

  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  -- One request per address rather than one request with every address in
  -- it: Resend would show every invitee every other invitee's address, which
  -- is what a poll with its respondents hidden promises not to do.
  for v_email in select * from poll_email_audience(v_first, p_by_itself, v_actor) loop
    perform send_poll_opened_email(v_first, v_email);
  end loop;

  -- The same people by push, and the browsers watching an open poll through
  -- its link -- which is the one audience an open poll has for this.
  perform push_poll(v_first, 'opened',
    array(select * from poll_email_audience(v_first, p_by_itself, v_actor)), true);
end;
$$;


ALTER FUNCTION "public"."notify_poll_opened"("p_poll_id" "uuid", "p_by_itself" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."notify_poll_opened"("p_poll_id" "uuid", "p_by_itself" boolean) IS 'Tells a poll''s voters that it has stopped collecting options and started taking votes, by email and by push, once for the group, leaving out whoever opened it. Internal: called by the two things that open a poll, which say between them whether the creator is hearing news.';



CREATE OR REPLACE FUNCTION "public"."notify_results_for_emptied"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll uuid;
begin
  for v_poll in select distinct poll_id from old_rows loop
    perform notify_results_ready(v_poll);
  end loop;
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_results_for_emptied"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_results_for_poll"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform notify_results_ready(NEW.id);
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_results_for_poll"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_results_for_touched"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll uuid;
begin
  for v_poll in select distinct poll_id from new_rows loop
    perform notify_results_ready(v_poll);
  end loop;
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_results_for_touched"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_results_ready"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_first polls;
  v_email text;
  -- The last ballot, the removal that left nobody to wait for, or the Close
  -- button: whichever of them crossed the line, it is this transaction and
  -- this is who is in it.
  v_actor text := lower(auth.jwt() ->> 'email');
begin
  select * into v_poll from polls where id = p_poll_id;

  -- A poll on its way out -- the nightly purge, or the creator's own Delete
  -- button -- has nobody left to tell, and its notice row is cascading after
  -- it either way.
  if not found then
    return;
  end if;

  -- poll_group_members orders by question_position with nulls first, so this
  -- is question 1 of a group and the poll itself when it has no group. It is
  -- the row the invitation names, so the two emails about one poll point at
  -- the same page.
  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  if not poll_results_ready(v_first) then
    -- Back to taking votes. A poll that finishes again is a second result,
    -- and the people in it are told about it again.
    delete from results_notices where poll_id = v_first.id;

    -- A poll closed with nobody having voted is finished with nothing to
    -- announce, so its watches will never be answered. Gone now rather than
    -- left on the poll until the purge.
    if v_first.closed_at is not null then
      delete from poll_push_watches where poll_id = v_first.id;
    end if;
    return;
  end if;

  -- The once-only rule, and all of it: two ballots arriving together both run
  -- this, and the primary key decides which of them is the announcement.
  insert into results_notices (poll_id) values (v_first.id)
  on conflict (poll_id) do nothing;

  if not found then
    return;
  end if;

  -- One request per address rather than one request with every address in it;
  -- see the note at the top of 0072.
  for v_email in select * from poll_results_audience(v_first, v_actor) loop
    perform send_results_ready_email(v_first, v_email);
  end loop;

  perform push_poll(v_first, 'results',
    array(select * from poll_results_audience(v_first, v_actor)), true);

  -- A watch has done its job once the results are out. Keeping it would
  -- leave a record on the poll, for the rest of its six months, of a browser
  -- that answered it.
  delete from poll_push_watches where poll_id = v_first.id;
end;
$$;


ALTER FUNCTION "public"."notify_results_ready"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."notify_results_ready"("p_poll_id" "uuid") IS 'Reconciles a poll''s results-ready announcement with whether it actually has a result: sends once when it crosses the line, by email and by push, to everybody but whoever crossed it, and forgets when a reopen takes it back. Lets the poll''s watches go once it has nothing left to announce. Internal: called from the triggers on ballots, invited_voters and polls, never by a client.';



CREATE OR REPLACE FUNCTION "public"."open_ballot_of"("p_poll_id" "uuid", "p_voter_key" "text") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  -- The account's ballot first, and the one this browser cast signed out
  -- after it: a key that cast a ballot under somebody else's account is not
  -- this account's to read, but one nobody was signed in for is this
  -- browser's, and so is its reader's. Signed out there is no account to
  -- ask, and the key is what it always was.
  select b.id
  from ballots b
  where b.poll_id = p_poll_id
    and (
      (auth.uid() is not null and b.account_id = auth.uid())
      or (b.voter_key = nullif(trim(p_voter_key), '')
          and (b.account_id is null or auth.uid() is null))
    )
  order by (b.account_id is not null) desc
  limit 1;
$$;


ALTER FUNCTION "public"."open_ballot_of"("p_poll_id" "uuid", "p_voter_key" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_ballot_of"("p_poll_id" "uuid", "p_voter_key" "text") IS 'The ballot an open poll''s reader cast in this question: the one carrying their account when they are signed in, else the one this browser''s key cast. Internal; the open_poll_* functions are the doors.';



CREATE OR REPLACE FUNCTION "public"."open_confirmation_of"("p_poll_id" "uuid", "p_voter_key" "text") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  -- The same rule as open_ballot_of, one stage earlier.
  select oc.id
  from option_confirmations oc
  where oc.poll_id = p_poll_id
    and (
      (auth.uid() is not null and oc.account_id = auth.uid())
      or (oc.voter_key = nullif(trim(p_voter_key), '')
          and (oc.account_id is null or auth.uid() is null))
    )
  order by (oc.account_id is not null) desc
  limit 1;
$$;


ALTER FUNCTION "public"."open_confirmation_of"("p_poll_id" "uuid", "p_voter_key" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_confirmation_of"("p_poll_id" "uuid", "p_voter_key" "text") IS 'The confirmation an open poll''s reader gave on this question, found the way open_ballot_of finds a ballot. Internal.';



CREATE OR REPLACE FUNCTION "public"."open_options_when_all_confirmed"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id;

  -- Gone, or on its way out behind a cascade.
  if not found then
    return;
  end if;

  if not options_confirmed_by_everyone(v_poll) then
    return;
  end if;

  -- The floor finalize_options applies, applied here as a reason to wait
  -- rather than as an error: one option is not an election, and a poll that
  -- everybody has finished adding to and that still has nothing to vote on is
  -- a poll for its creator to look at.
  if exists (
    select 1
    from poll_group_members(v_poll) q
    left join candidates c on c.poll_id = q.id
    group by q.id
    having count(c.id) < 2
  ) then
    return;
  end if;

  update polls set options_finalized_at = now()
  where id in (select q.id from poll_group_members(v_poll) q)
    and options_finalized_at is null;

  if found then
    perform notify_poll_opened(v_poll.id, true);
  end if;
end;
$$;


ALTER FUNCTION "public"."open_options_when_all_confirmed"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_options_when_all_confirmed"("p_poll_id" "uuid") IS 'Opens a soliciting poll for voting once every invitee has confirmed every question in it, telling everybody including the creator, and does nothing at all otherwise. Internal: called after a confirmation and after an invitee is removed, so it must never raise.';



CREATE OR REPLACE FUNCTION "public"."open_poll_ballots"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted int;
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if not v_poll.show_ballots then
    raise exception 'This poll does not publish individual ballots';
  end if;

  -- Closed first, in the order assert_open_results_readable asks it: on a poll
  -- still taking votes that is the accurate answer, and "no votes were cast"
  -- would be a confusing thing to say about a poll people can still vote in.
  --
  -- An open poll's questions have only one way to stop, so the group-wide
  -- reveal here reads as "every question in it is closed" -- which is what a
  -- sheet of one question's ballots would otherwise get ahead of.
  if not (select bool_and(poll_gate_open(q.*)) from poll_group_members(v_poll) q) then
    raise exception 'Ballots are not available until the poll is closed';
  end if;

  select count(*) into v_voted from ballots where poll_id = v_poll.id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  return ballot_sheet(v_poll.id, v_poll.show_voters);
end;
$$;


ALTER FUNCTION "public"."open_poll_ballots"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_poll_ballots"("p_poll_id" "uuid") IS 'Every ballot in an open poll, to anyone holding its link, once the poll publishes them and every question in its group is closed. The same gate poll_ballots applies and the same sheet it returns; the split is only about how the caller proves the right to it.';



CREATE OR REPLACE FUNCTION "public"."open_poll_confirm_options"("p_poll_id" "uuid", "p_voter_key" "text", "p_voter_name" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_name text;
  v_key text;
begin
  select * into v_poll from polls where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  perform assert_collecting_options(v_poll);

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  -- The same rule open_poll_submit applies to a ballot's name, in the same
  -- order and the same words: a poll that names its respondents needs one, and
  -- a poll that hides them stores none whatever the client sends.
  if v_poll.show_voters then
    v_name := nullif(trim(coalesce(p_voter_name, '')), '');
    if v_name is null then
      raise exception 'Enter your name so the group can see who has confirmed the options';
    end if;
    if length(v_name) > 60 then
      raise exception 'That name is too long';
    end if;
  else
    v_name := null;
  end if;

  if open_confirmation_of(v_poll.id, p_voter_key) is not null then
    -- Already done, and saying so is more use than a second row would be.
    return;
  end if;

  -- As on a ballot: the key goes on the row unless another account's
  -- confirmation already holds it.
  v_key := p_voter_key;
  if exists (
    select 1 from option_confirmations
    where poll_id = v_poll.id and voter_key = p_voter_key
  ) then
    v_key := null;
  end if;

  begin
    insert into option_confirmations (poll_id, account_id, voter_name, voter_key)
    values (v_poll.id, auth.uid(), v_name, v_key);
  exception when unique_violation then
    -- Either the name is taken, or this reader raced themselves past the
    -- check above; the same two cases open_poll_submit tells apart the same
    -- way.
    if v_name is null or open_confirmation_of(v_poll.id, p_voter_key) is not null then
      return;
    end if;
    raise exception '"%" has already confirmed the options. Add a last initial if that is not you.', v_name;
  end;
end;
$$;


ALTER FUNCTION "public"."open_poll_confirm_options"("p_poll_id" "uuid", "p_voter_key" "text", "p_voter_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_poll_confirm_options"("p_poll_id" "uuid", "p_voter_key" "text", "p_voter_name" "text") IS 'Records that this reader is done adding options to this open question, under the name they give -- against their account when they are signed in, and this browser''s key either way. Opens nothing: an open poll has no participant list to have all confirmed, so its creator ends the stage as they always did.';



CREATE OR REPLACE FUNCTION "public"."open_poll_group"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_uid uuid := auth.uid();
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.group_id is null then
    return '[]'::jsonb;
  end if;

  -- The sibling ids, to whoever already holds one of them. They are one
  -- poll: a link to a multi-question poll is a link to all of its questions,
  -- and this is what makes the next one reachable.
  --
  -- **Which ones this reader has answered, only when they are signed in.**
  -- Then their ballots carry their account, which already joins them, so
  -- nothing is linked here that the ballots themselves do not link -- and it
  -- is what ticks the strip on a device that never cast any of them. Signed
  -- out, the only thing that identifies an open ballot is a voter_key minted
  -- per question so that one browser's ballots cannot be joined; answering
  -- would mean taking every key at once and doing that join here, so the
  -- keys are not asked for and the flags are left off. The browser answers
  -- for its own keys (src/lib/questionMarks.ts).
  return (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'question_position', q.question_position,
        'question_title', q.question_title
      )
      || case
           when v_uid is null then '{}'::jsonb
           else jsonb_build_object(
             'voted', exists (
               select 1 from ballots b where b.poll_id = q.id and b.account_id = v_uid),
             'confirmed', exists (
               select 1 from option_confirmations oc
               where oc.poll_id = q.id and oc.account_id = v_uid))
         end
      order by q.question_position), '[]'::jsonb)
    from poll_group_members(v_poll) q
  );
end;
$$;


ALTER FUNCTION "public"."open_poll_group"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_poll_group"("p_poll_id" "uuid") IS 'The questions of an open poll, with the id of each, to a caller already holding one of them -- and, for a caller who is signed in, whether their account has voted in and confirmed each. Nothing about a signed-out reader: their ballots are identified by voter keys scoped per question so they cannot be joined, and this function is not the place that undoes it.';



CREATE OR REPLACE FUNCTION "public"."open_poll_ranking"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_ranking(p_poll_id);
end;
$$;


ALTER FUNCTION "public"."open_poll_ranking"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_poll_results"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_tally(p_poll_id);
end;
$$;


ALTER FUNCTION "public"."open_poll_results"("p_poll_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_ballot_id uuid;
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

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

  -- Found the way the view found it, so the ballot a reader was handed back
  -- is the ballot their change lands on -- on whichever device they cast it.
  v_ballot_id := open_ballot_of(v_poll.id, p_voter_key);

  if v_ballot_id is null then
    raise exception 'You have not voted in this poll yet';
  end if;

  perform replace_scores(v_ballot_id, v_poll.id, p_scores);

  update ballots set revised_at = now() where id = v_ballot_id;
end;
$$;


ALTER FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text") IS 'Replaces the scores on this reader''s ballot -- the one their account cast, on any device, or the one this voter_key cast -- until the poll closes. The voter''s name is not revisable: it is on the roster other people are already reading.';



CREATE OR REPLACE FUNCTION "public"."open_poll_submit"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_name text;
  v_key text;
  v_ballot_id uuid;
  v_option_count int;
  v_item jsonb;
  v_candidate_id uuid;
  v_score int;
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

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

  -- This reader's ballot, however they are known: by their account on
  -- another device, or by this browser's key. See open_ballot_of.
  if open_ballot_of(v_poll.id, p_voter_key) is not null then
    raise exception 'You have already voted in this poll';
  end if;

  -- The key goes on the ballot unless another account's ballot already holds
  -- it -- a shared browser, the next person signed in. Their ballot is found
  -- by their account, so it needs no key, and a key cannot be on two ballots.
  v_key := p_voter_key;
  if exists (select 1 from ballots where poll_id = v_poll.id and voter_key = p_voter_key) then
    v_key := null;
  end if;

  select count(*) into v_option_count from candidates where poll_id = v_poll.id;

  if jsonb_array_length(p_scores) is distinct from v_option_count then
    raise exception 'Must submit a score for every option';
  end if;

  begin
    insert into ballots (poll_id, voter_id, account_id, voter_name, voter_key)
    values (v_poll.id, null, auth.uid(), v_name, v_key)
    returning id into v_ballot_id;
  exception when unique_violation then
    -- Either the name is taken, or this reader raced themselves (a
    -- double-click, or two devices at once) past the check above.
    if v_name is null or open_ballot_of(v_poll.id, p_voter_key) is not null then
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

  -- As in submit_ballot, and for the same reason. An open poll reveals only
  -- on close, so this settles nothing today -- but the gate is read from one
  -- function and this keeps the two ballot paths saying the same thing.
  perform settle_winner(v_poll.id);
end;
$$;


ALTER FUNCTION "public"."open_poll_submit"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_poll_suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text" DEFAULT NULL::"text") RETURNS "void"
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

  perform add_suggested_option(v_poll, p_name, p_description);
end;
$$;


ALTER FUNCTION "public"."open_poll_suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") OWNER TO "postgres";


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



CREATE OR REPLACE FUNCTION "public"."open_poll_unconfirm_options"("p_poll_id" "uuid", "p_voter_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  perform assert_collecting_options(v_poll);

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  -- Every row the view could hand back as this reader's, not only the first:
  -- a reader who confirmed signed out on one device and signed in on another
  -- has two, and taking back one would leave the other drawing the button as
  -- still pressed. The predicate is open_confirmation_of's, unlimited.
  delete from option_confirmations oc
  where oc.poll_id = v_poll.id
    and (
      (auth.uid() is not null and oc.account_id = auth.uid())
      or (oc.voter_key = p_voter_key and (oc.account_id is null or auth.uid() is null))
    );
end;
$$;


ALTER FUNCTION "public"."open_poll_unconfirm_options"("p_poll_id" "uuid", "p_voter_key" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_poll_unconfirm_options"("p_poll_id" "uuid", "p_voter_key" "text") IS 'Takes back this reader''s confirmation -- by their account, or by this browser''s key -- while the poll is still collecting; the share-link half of unconfirm_options.';



CREATE OR REPLACE FUNCTION "public"."open_poll_unwatch"("p_poll_id" "uuid", "p_endpoint" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_first polls;
begin
  select * into v_poll from polls where id = p_poll_id and mode = 'open';

  if not found then
    return;
  end if;

  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  delete from poll_push_watches where poll_id = v_first.id and endpoint = p_endpoint;
end;
$$;


ALTER FUNCTION "public"."open_poll_unwatch"("p_poll_id" "uuid", "p_endpoint" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_poll_unwatch"("p_poll_id" "uuid", "p_endpoint" "text") IS 'Takes back open_poll_watch for this browser.';



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
    'winner_settled', v_poll.winner_settled_at is not null
  );
end;
$$;


ALTER FUNCTION "public"."open_poll_view"("p_poll_id" "uuid", "p_voter_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_poll_watch"("p_poll_id" "uuid", "p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_first polls;
begin
  select * into v_poll from polls where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if not push_subscription_valid(p_endpoint, p_p256dh, p_auth) then
    raise exception 'This browser''s push subscription is not one this app can send to';
  end if;

  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  -- Closing is one act over the whole group, so the first question speaks
  -- for all of them. A closed poll has announced whatever it is going to
  -- announce: its results went out, or it had none to send.
  if v_first.closed_at is not null then
    raise exception 'This poll has closed, so there is nothing left to tell you about it';
  end if;

  -- The same kind of bound as an account's twenty devices, for a door with
  -- no account behind it.
  if (select count(*) from poll_push_watches where poll_id = v_first.id) >= 1000
     and not exists (
       select 1 from poll_push_watches where poll_id = v_first.id and endpoint = p_endpoint) then
    raise exception 'This poll cannot take any more notifications';
  end if;

  insert into poll_push_watches (poll_id, endpoint, p256dh, auth)
  values (v_first.id, p_endpoint, p_p256dh, p_auth)
  on conflict (poll_id, endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth;
end;
$$;


ALTER FUNCTION "public"."open_poll_watch"("p_poll_id" "uuid", "p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."open_poll_watch"("p_poll_id" "uuid", "p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") IS 'Asks, through an open poll''s link, for this browser to be pushed a notification when the poll opens for voting and when its results are ready. Needs no account and records nothing about who asked.';



CREATE OR REPLACE FUNCTION "public"."options_confirmed_by_everyone"("p_poll" "public"."polls") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p_poll.mode = 'invite'
     and p_poll.solicit_options
     and p_poll.options_finalized_at is null
     and p_poll.closed_at is null
     and exists (select 1 from invited_voters iv where iv.poll_id = p_poll.id)
     and not exists (
       select 1
       from poll_group_members(p_poll) q
       cross join invited_voters iv
       where iv.poll_id = p_poll.id
         and not exists (
           select 1
           from option_confirmations oc
           join auth.users u on u.id = oc.voter_id
           where oc.poll_id = q.id and lower(u.email) = iv.email
         )
     );
$$;


ALTER FUNCTION "public"."options_confirmed_by_everyone"("p_poll" "public"."polls") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."options_confirmed_by_everyone"("p_poll" "public"."polls") IS 'Whether every invitee has confirmed every question in this poll''s group. The invite list is carried on each question, so it is read from this one and applied to all of them. Internal.';



CREATE OR REPLACE FUNCTION "public"."poll_answering_accounts"("p_poll_id" "uuid") RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  -- The accounts that have answered this poll through its link, in any of
  -- its questions: the list's row for a group is its first question, and a
  -- vote in the third is on that row as surely as one in the first.
  with poll as (
    select p.id, p.group_id from polls p where p.id = p_poll_id
  ), questions as (
    select q.id from polls q, poll
    where q.id = poll.id or (poll.group_id is not null and q.group_id = poll.group_id)
  )
  select b.account_id from ballots b
  where b.poll_id in (select id from questions) and b.account_id is not null
  union
  select oc.account_id from option_confirmations oc
  where oc.poll_id in (select id from questions) and oc.account_id is not null;
$$;


ALTER FUNCTION "public"."poll_answering_accounts"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_answering_accounts"("p_poll_id" "uuid") IS 'The accounts with a ballot or a confirmation cast through the link in any question of this poll''s group -- the people an open poll is on the list of, besides its creator. Internal: the broadcast functions read it.';



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

  -- Deliberately before the creator has been given any special treatment,
  -- because they get none: hiding ballots is a promise made to the people who
  -- voted, not an access level.
  if not v_poll.show_ballots then
    raise exception 'This poll does not publish individual ballots';
  end if;

  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  -- Before the reveal rather than through it, as assert_results_readable puts
  -- it: a poll closed with nothing in it is not "not out yet", it is a poll
  -- with no ballots to publish.
  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if not poll_results_revealed(v_poll) then
    -- The two ways in, so the reader is told which one this poll has not
    -- reached. An open poll has only the close; an invite poll has the
    -- completion as well, and being told to wait for the close on a poll that
    -- will unlock itself would send its reader to a button they may not have.
    if v_poll.mode = 'open' then
      raise exception 'Ballots are not available until the poll is closed';
    end if;
    raise exception 'Ballots are not available until everyone has voted';
  end if;

  return ballot_sheet(p_poll_id, v_poll.show_voters);
end;
$$;


ALTER FUNCTION "public"."poll_ballots"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_ballots"("p_poll_id" "uuid") IS 'Every ballot in a poll, to somebody in that poll, once the poll publishes them and its results are out. Gated on poll_results_revealed, the same predicate the tally is gated on and reported as results_available: on a poll of several questions the sheet waits for all of them, because the sheet is the tally in the form it can be recomputed from. Says nothing about how the reader reached the poll: an open poll''s creator gets the sheet open_poll_ballots would hand the same poll''s link, on the same terms.';



CREATE OR REPLACE FUNCTION "public"."poll_confirmed_count"("p_poll_id" "uuid") RETURNS integer
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select case
    when p.mode = 'invite' then (
      select count(*)::int
      from invited_voters iv
      where iv.poll_id = p.id
        and exists (
          select 1
          from option_confirmations oc
          join auth.users u on u.id = oc.voter_id
          where oc.poll_id = p.id and lower(u.email) = iv.email
        )
    )
    else (
      select count(*)::int from option_confirmations oc where oc.poll_id = p.id
    )
  end
  from polls p
  where p.id = p_poll_id;
$$;


ALTER FUNCTION "public"."poll_confirmed_count"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_confirmed_count"("p_poll_id" "uuid") IS 'How many people have said they are done adding options to this question: invitees who have confirmed on an invite poll, browsers that have on an open one. Internal: it answers about a poll the caller has already established it may read.';



CREATE OR REPLACE FUNCTION "public"."poll_email_audience"("p_poll" "public"."polls", "p_include_creator" boolean, "p_actor" "text") RETURNS SETOF "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with told as (
    select lower(p_poll.created_by_email) as email
    where p_poll.created_by_email is not null
    union
    select lower(iv.email)
    from invited_voters iv
    where iv.poll_id = p_poll.id
    union
    -- An open poll's signed-in voters, who are in it as surely as an invitee
    -- is in an invite poll: every account with a ballot or a confirmation in
    -- any question of its group, which is what poll_answering_accounts reads
    -- off the account those rows carry (0074). Nothing is filed for it and
    -- nothing has to be let go.
    select lower(u.email)
    from poll_answering_accounts(p_poll.id) a
    join auth.users u on u.id = a
    where u.email is not null
  ), removed as (
    -- The accounts that have taken this poll off their lists (0077), by
    -- address, since that is what the audience is made of. Asked of the
    -- poll's list row, since that is what a removal is filed against and
    -- the callers hand in whichever question they hold.
    select lower(u.email) as email
    from removed_polls r
    join auth.users u on u.id = r.user_id
    where r.poll_id = poll_list_row(p_poll.id)
      and u.email is not null
  )
  select email
  from told
  where (p_include_creator
          or email is distinct from lower(p_poll.created_by_email))
    -- Null is nobody, and nobody is dropped: an open poll's voter signs
    -- nothing and the purge runs as no one.
    and email is distinct from lower(p_actor)
    and email not in (select r.email from removed r);
$$;


ALTER FUNCTION "public"."poll_email_audience"("p_poll" "public"."polls", "p_include_creator" boolean, "p_actor" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_email_audience"("p_poll" "public"."polls", "p_include_creator" boolean, "p_actor" "text") IS 'Every address to tell about something that happened to this poll: every invitee and every account that has answered it through its link signed in, minus the creator where the thing was their own doing, minus the address whose own act caused it, and minus every account that has removed the poll from its list. Internal.';



CREATE OR REPLACE FUNCTION "public"."poll_email_html"("p_heading" "text", "p_body_html" "text", "p_link" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $_$
  select $html$<!doctype html>
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
                  $html$ || p_heading || $html$
                </h1>
                <p style="margin:0 0 28px; font-size:15px; line-height:1.6; color:#5b5468;">
                  $html$ || p_body_html || $html$
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td align="center" style="border-radius:10px; background:linear-gradient(135deg,#7e14ff,#47bfff); background-color:#7e14ff;">
                      <a href="$html$ || p_link || $html$"
                         style="display:inline-block; padding:14px 36px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:10px;">
                        Open poll &rarr;
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:28px 0 0; font-size:13px; line-height:1.6; color:#9691a3;">
                  Button not working? Paste this link into your browser:<br>
                  <a href="$html$ || p_link || $html$" style="color:#7e14ff; word-break:break-all;">$html$ || p_link || $html$</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px; border-top:1px solid #f0edf7;">
                <p style="margin:0 0 8px; font-size:12px; line-height:1.6; color:#b3aec0; text-align:center;">
                  Don&rsquo;t want these emails?
                  <a href="https://choicelab.app/star-voting/#/settings" style="color:#9691a3; text-decoration:underline;">Change your notification settings</a>.
                </p>
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
$html$
$_$;


ALTER FUNCTION "public"."poll_email_html"("p_heading" "text", "p_body_html" "text", "p_link" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_email_html"("p_heading" "text", "p_body_html" "text", "p_link" "text") IS 'The card every email this app sends is: a heading, a sentence, the button onto the poll, and a footer linking to the notification settings. Internal: the one place the letterhead is written down.';



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
      -- linked to find them -- and so does an open ballot its creator cast
      -- signed in, which is the one reader of an open poll this function
      -- serves. See open_poll_group for the share-link side.
      'voted', exists (
        select 1 from ballots b
        where b.poll_id = q.id and (b.voter_id = auth.uid() or b.account_id = auth.uid())
      ),
      -- And which they have finished adding to, which is the same mark for
      -- the stage before the ballot. Free for the same reason. False rather
      -- than null for a creator who is not on the invite list: they have no
      -- confirmation to give, and the strip draws no mark for one they could
      -- not have made.
      'confirmed', exists (
        select 1 from option_confirmations oc
        where oc.poll_id = q.id and (oc.voter_id = auth.uid() or oc.account_id = auth.uid())
      )
    ) order by q.question_position), '[]'::jsonb)
    from poll_group_members(v_poll) q
  );
end;
$$;


ALTER FUNCTION "public"."poll_group"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_group"("p_poll_id" "uuid") IS 'The questions of the poll this one belongs to, in order, with whether the reader has answered each and whether they have finished adding options to each; empty for a poll that asks one question.';



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



CREATE OR REPLACE FUNCTION "public"."poll_invite_kind"("p_poll" "public"."polls", "p_email" "text") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select case
    -- Defensive: guard_invitee_changes already refuses a list on a poll that
    -- is open to anyone with the link.
    when p_poll.mode is distinct from 'invite' then 'none'
    -- The creator set the poll up. Nothing about that is news to them.
    when lower(p_email) is not distinct from lower(p_poll.created_by_email) then 'none'
    -- Still collecting: what this person is being asked for is options, and
    -- there is nothing to vote on yet.
    when p_poll.solicit_options and p_poll.options_finalized_at is null then 'options'
    else 'vote'
  end;
$$;


ALTER FUNCTION "public"."poll_invite_kind"("p_poll" "public"."polls", "p_email" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_invite_kind"("p_poll" "public"."polls", "p_email" "text") IS 'Which invitation an address on this poll''s list is owed: "options" while the poll is still collecting them, "vote" once there is a ballot, and "none" for the creator, who set the poll up. Internal.';



CREATE OR REPLACE FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") RETURNS TABLE("email" "text", "has_voted" boolean, "has_confirmed" boolean)
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
    ) else null::boolean end,
    -- Held back on the same terms as has_voted, and that is the point of
    -- putting it here rather than anywhere else: who has confirmed is a
    -- roster, so it is the roster's setting that decides who reads it. A poll
    -- that hides its respondents gives its creator the invite list with no
    -- per-person state on it, exactly as it did before this column existed.
    case when v_show then exists (
      select 1 from option_confirmations oc
      join auth.users u on u.id = oc.voter_id
      where oc.poll_id = p_poll_id and lower(u.email) = iv.email
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



CREATE OR REPLACE FUNCTION "public"."poll_is_removed"("p_poll_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from removed_polls r
    where r.user_id = auth.uid()
      and r.poll_id = poll_list_row(p_poll_id)
  );
$$;


ALTER FUNCTION "public"."poll_is_removed"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_is_removed"("p_poll_id" "uuid") IS 'Whether the caller has removed this poll (any question of it) from their list. False for anybody not signed in.';



CREATE OR REPLACE FUNCTION "public"."poll_list_row"("p_poll_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  -- A group's first question, or the poll itself when it has none: the row
  -- list_polls draws a poll as. poll_group_members orders nulls first, so a
  -- lone poll is its own first member.
  select q.id
  from polls p, poll_group_members(p) q
  where p.id = p_poll_id
  limit 1;
$$;


ALTER FUNCTION "public"."poll_list_row"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_list_row"("p_poll_id" "uuid") IS 'The id a poll is listed under: its group''s first question, or itself. Internal.';



CREATE OR REPLACE FUNCTION "public"."poll_page"("p_poll_id" "uuid", "p_voter_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_creator boolean;
  v_revealed boolean;
begin
  -- Read without a visibility test, because which test applies is what this
  -- function is here to work out. Nothing about the row escapes below except
  -- through a branch that has earned it.
  select p.* into v_poll from polls p where p.id = p_poll_id;

  if not found then
    return jsonb_build_object('kind', 'unreadable');
  end if;

  -- Held rather than asked twice: the account door below tests it, and the
  -- roster wants the same answer for its own reason -- a creator keeps the
  -- invite list on a poll that shows nobody, because for them it is the list
  -- they manage rather than a record of who voted.
  v_creator := is_poll_creator(v_poll.id);
  -- Likewise, and it is the more expensive of the two: this walks the group.
  -- Both branches below gate the tally and the sheet on it, and it is the same
  -- predicate `poll_status` and `open_poll_view` report as
  -- `results_available` -- which is what keeps what the server carries and
  -- what the browser draws from coming apart.
  v_revealed := poll_results_revealed(v_poll);

  -- The account reading: the same door `polls_select` opens, asked with the
  -- same two functions so there is no second wording of it to keep in step.
  if v_creator or is_invited_to_poll(v_poll.id) then
    return jsonb_build_object(
      'kind', 'account',
      -- The whole row, which is exactly what `select *` through row-level
      -- security handed back a moment ago: this reader is inside the poll.
      'poll', to_jsonb(v_poll),
      'options', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id,
          'poll_id', c.poll_id,
          'name', c.name,
          'description', c.description,
          'sort_order', c.sort_order
        ) order by c.sort_order, c.name), '[]'::jsonb)
        from candidates c where c.poll_id = v_poll.id
      ),
      'status', (select to_jsonb(s) from poll_status(v_poll.id) s),
      'questions', poll_group(v_poll.id),
      -- An open poll read by its own creator is still an open poll: the panel
      -- they manage it through is the one everybody else votes in, and it
      -- wants this. Null on an invite poll, where there is no such panel and
      -- open_poll_view would refuse to answer anyway.
      'view', case
        when v_poll.mode = 'open' then open_poll_view(v_poll.id, p_voter_key)
        else null
      end,
      -- The tally, once there is one. `get_poll_results` re-establishes the
      -- reader for itself before running STAR, which is the whole of the rule
      -- and is stated in one place still.
      --
      -- One field for both readings of an open poll: the creator's page draws
      -- the same panel a stranger's does, and `open_poll_results` would hand
      -- it the same `poll_tally` this does.
      'results', case when v_revealed then get_poll_results(v_poll.id) else null end,
      -- And the sheet those numbers can be checked against, on the poll that
      -- publishes it. Same reveal, now that there is only one; `poll_ballots`
      -- applies `show_ballots` itself, and it is repeated here because this is
      -- the condition `<Ballots>` is rendered behind and asking for a sheet
      -- the page will not draw is the request this is here to save.
      'ballots', case
        when v_revealed and v_poll.show_ballots then poll_ballots(v_poll.id)
        else null
      end,
      -- And the roster, on the poll and the reader that have one to draw: an
      -- invite poll, read by its creator or showing its respondents. Anyone
      -- else on a poll that hides them has no card, so there is nothing to
      -- carry and nothing is asked for -- the same reason the browser does
      -- not make the request rather than making it and expecting it to fail.
      --
      -- `poll_invitees` decides what each row may say, including nulling the
      -- per-person columns for a creator whose poll hides respondents. It is
      -- called, not copied, so that stays true here.
      'invitees', case
        when v_poll.mode = 'invite' and (v_creator or v_poll.show_voters) then (
          select coalesce(jsonb_agg(to_jsonb(i) order by i.email), '[]'::jsonb)
          from poll_invitees(v_poll.id) i
        )
        else null
      end
    );
  end if;

  -- Outside the poll. An open one is readable by anyone holding its link, and
  -- holding its link is what being here means; anything else is not.
  if v_poll.mode = 'open' then
    return jsonb_build_object(
      'kind', 'open',
      'view', open_poll_view(v_poll.id, p_voter_key),
      -- The bare group. See the note above: no per-reader mark reaches this
      -- branch, and adding one is a change to make on purpose or not at all.
      'questions', open_poll_group(v_poll.id),
      -- The tally and the sheet on the same terms as the account branch, and
      -- through the doors this reader actually has: the poll's own link proves
      -- the right to both rather than a session. The same numbers and the same
      -- rows either way -- neither says anything about who is reading it, so
      -- there is no boundary here for them to cross.
      'results', case when v_revealed then open_poll_results(v_poll.id) else null end,
      'ballots', case
        when v_revealed and v_poll.show_ballots then open_poll_ballots(v_poll.id)
        else null
      end
    );
  end if;

  -- An invite poll somebody else is in. Answered exactly as a poll that does
  -- not exist is answered, which is the point.
  return jsonb_build_object('kind', 'unreadable');
end;
$$;


ALTER FUNCTION "public"."poll_page"("p_poll_id" "uuid", "p_voter_key" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_page"("p_poll_id" "uuid", "p_voter_key" "text") IS 'The one read that opens a poll page: what this reader may see at this address, and the whole of it. Tagged account / open / unreadable. Carries the tally, the published ballot sheet and the invitee roster where the page it describes will draw them, so a finished poll opens in one round trip; null on any of them means "not here, ask for yourself" rather than "there is none".';



CREATE OR REPLACE FUNCTION "public"."poll_push_targets"("p_poll" "public"."polls", "p_emails" "text"[], "p_watchers" boolean, "p_actor" "uuid") RETURNS TABLE("endpoint" "text", "p256dh" "text", "auth" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select distinct on (t.endpoint) t.endpoint, t.p256dh, t.auth
  from (
    -- Everybody the matching email is addressed to, on every browser they
    -- have turned notifications on in -- unless they have turned push off.
    select s.endpoint, s.p256dh, s.auth
    from push_subscriptions s
    join auth.users u on u.id = s.user_id
    where lower(u.email) = any (p_emails)
      and wants_push(s.user_id)

    union all

    -- And every browser watching the poll through its link. A watch is the
    -- one thing here with no account behind it, so the actor's address
    -- cannot leave it out the way it leaves them out of the list above; what
    -- can is their own browser, where it is bound to their account. That is
    -- the creator who pressed Open or Close, watching on the phone they
    -- pressed it on.
    select w.endpoint, w.p256dh, w.auth
    from poll_push_watches w
    where p_watchers
      and w.poll_id = p_poll.id
      and not exists (
        select 1 from push_subscriptions a
        where a.endpoint = w.endpoint and a.user_id = p_actor)
  ) t
  order by t.endpoint;
$$;


ALTER FUNCTION "public"."poll_push_targets"("p_poll" "public"."polls", "p_emails" "text"[], "p_watchers" boolean, "p_actor" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_push_targets"("p_poll" "public"."polls", "p_emails" "text"[], "p_watchers" boolean, "p_actor" "uuid") IS 'Every browser to push to about a poll: the subscribed devices of the addresses given, where push is on, and -- when asked -- the browsers watching it through its link, minus the actor''s own. Each endpoint once. Internal.';



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


CREATE OR REPLACE FUNCTION "public"."poll_results_audience"("p_poll" "public"."polls", "p_actor" "text") RETURNS SETOF "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select * from poll_email_audience(p_poll, p_poll.closed_at is null, p_actor);
$$;


ALTER FUNCTION "public"."poll_results_audience"("p_poll" "public"."polls", "p_actor" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_results_audience"("p_poll" "public"."polls", "p_actor" "text") IS 'Every address to tell that this poll has finished: every invitee, minus the creator where the poll was closed by hand rather than running out on its own, and minus whoever''s own vote or removal ended it. Internal.';



CREATE OR REPLACE FUNCTION "public"."poll_results_ready"("p_poll" "public"."polls") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
           select 1 from ballots b
           join poll_group_members(p_poll) q on q.id = b.poll_id
         )
     and (select bool_and(poll_gate_open(q.*)) from poll_group_members(p_poll) q);
$$;


ALTER FUNCTION "public"."poll_results_ready"("p_poll" "public"."polls") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_results_ready"("p_poll" "public"."polls") IS 'Whether this poll, as a whole, has a result: a ballot somewhere in the group, and every question in it stopped. The email''s question, where poll_results_revealed is the page''s. Internal.';



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



CREATE OR REPLACE FUNCTION "public"."poll_status"("p_poll_id" "uuid") RETURNS TABLE("invited_count" integer, "voted_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean, "expires_at" timestamp with time zone, "invited" boolean, "confirmed" boolean, "confirmed_count" integer, "winner_name" "text", "winner_settled" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_invited int;
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
    poll_expires_at(v_poll),
    -- Whether this reader may confirm at all, which is not the same question
    -- as whether they may read the poll: a creator who did not invite
    -- themselves reads every word of it and is not one of the people it is
    -- waiting on. The page needs the distinction to decide whether to offer
    -- the button, and only the invite list can answer it.
    exists (select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email),
    exists (
      select 1 from option_confirmations
      where poll_id = p_poll_id and voter_id = auth.uid()
    ),
    -- Not withheld on a poll that hides its respondents, on the same
    -- reasoning the vote count is not: a count names nobody. What that
    -- setting withholds is the roster, which is poll_invitees' business.
    poll_confirmed_count(p_poll_id),
    -- The two the state badge reads. `winner_settled` is what tells a poll
    -- that elected nobody from one whose answer this database has not worked
    -- out, so a tie can never be drawn as *Results ready* nor the other way
    -- about.
    v_poll.winner_name,
    v_poll.winner_settled_at is not null;
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
  v_edited boolean;
  v_late boolean;
  v_options jsonb;
  v_pool uuid[];
  v_head jsonb;
  v_head_finalists uuid[];
begin
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  select closed_at is not null, mode, options_edited_after_votes, votes_after_reveal
  into v_closed, v_mode, v_edited, v_late
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
    'closed_early', v_closed and v_voted < v_invited,
    -- The two caveats, travelling with the tally they are about. Everyone who
    -- can read the result reads them, through whichever door they came in by:
    -- get_poll_results and open_poll_results are two gates over this one
    -- function.
    'options_edited_after_votes', coalesce(v_edited, false),
    'votes_after_reveal', coalesce(v_late, false)
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
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

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

    -- Aliased through the record because this function's own OUT column is
    -- called winner_name, and now so is the table's.
    poll_id := v_id;
    winner_name := v_poll.winner_name;
    return next;
  end loop;
end;
$$;


ALTER FUNCTION "public"."poll_winners"("p_poll_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_winners"("p_poll_ids" "uuid"[]) IS 'The elected option of each poll the caller can see, read from the column settle_winner() maintains. Superseded by the winner_name/winner_settled columns on list_polls() and poll_status(); kept for browsers holding a build that predates them.';



CREATE OR REPLACE FUNCTION "public"."purge_old_polls"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deleted int;
begin
  -- Transaction-local, so it covers the delete below and is gone with the
  -- transaction rather than left on a pooled connection for whatever runs
  -- next. See broadcast_poll_gone() for what reads it.
  perform set_config('app.purging_polls', 'on', true);

  with expired as (
    delete from polls p
    -- The same test poll_expires_at() states, rearranged onto the bare
    -- column so the index on created_at can answer it. The second half is
    -- that function itself, kept as the authority: whatever date the poll page
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


COMMENT ON FUNCTION "public"."purge_old_polls"() IS 'Deletes every poll past its retention window, cascading to its options, invitees and ballots. Returns how many polls went. Scheduled nightly by pg_cron, and silent: it raises app.purging_polls over itself so the delete trigger says nothing.';



CREATE OR REPLACE FUNCTION "public"."push_message"("p_poll" "public"."polls", "p_event" "text") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  -- The poll's title is the notification's title. An email subject leaves it
  -- out because an inbox truncates a subject line to whatever fits; a
  -- notification has a line of its own for it and a body underneath, and the
  -- app's name is already drawn above both by the operating system.
  select jsonb_build_object(
    'title', coalesce(nullif(trim(p_poll.title), ''), 'A poll'),
    'body', case p_event
      when 'invite_options' then 'You''ve been invited to add options to this poll.'
      when 'invite_vote' then 'You''ve been invited to vote in this poll.'
      when 'opened' then 'The options are settled and voting is now open.'
      when 'results' then 'The results are ready.'
    end,
    -- Relative to the app's own address, which the service worker resolves
    -- against its scope, so the same message opens the right page from a
    -- local build as well as from choicelab.app.
    'path', '#/polls/' || short_poll_id(p_poll.id),
    -- One notification per poll on the screen: a later one about the same
    -- poll replaces the earlier rather than stacking under it.
    'tag', short_poll_id(p_poll.id));
$$;


ALTER FUNCTION "public"."push_message"("p_poll" "public"."polls", "p_event" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."push_message"("p_poll" "public"."polls", "p_event" "text") IS 'The notification sent about one of a poll''s three moments -- invite_options, invite_vote, opened, results. Internal.';



CREATE OR REPLACE FUNCTION "public"."push_poll"("p_poll" "public"."polls", "p_event" "text", "p_emails" "text"[], "p_watchers" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_targets jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'endpoint', t.endpoint, 'p256dh', t.p256dh, 'auth', t.auth)), '[]'::jsonb)
  into v_targets
  from poll_push_targets(p_poll, p_emails, p_watchers, auth.uid()) t;

  perform send_push(v_targets, push_message(p_poll, p_event));
end;
$$;


ALTER FUNCTION "public"."push_poll"("p_poll" "public"."polls", "p_event" "text", "p_emails" "text"[], "p_watchers" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."push_poll"("p_poll" "public"."polls", "p_event" "text", "p_emails" "text"[], "p_watchers" boolean) IS 'Pushes one of a poll''s moments to the browsers of the addresses given, and to its watchers when asked. Internal: called beside the matching email.';



CREATE OR REPLACE FUNCTION "public"."push_subscription_valid"("p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $_$
  select coalesce(
    length(p_endpoint) <= 2048
    and p_endpoint ~ '^https://([a-z0-9-]+\.)*(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)(:443)?/'
    -- An uncompressed P-256 point is 65 bytes, 87 characters of base64url;
    -- the auth secret is 16 bytes, 22 characters. A little slack either way
    -- for padding.
    and p_p256dh ~ '^[A-Za-z0-9_-]{86,88}={0,2}$'
    and p_auth ~ '^[A-Za-z0-9_-]{21,24}={0,2}$',
    false);
$_$;


ALTER FUNCTION "public"."push_subscription_valid"("p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."push_subscription_valid"("p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") IS 'Whether a browser''s push subscription is one this app will send to: an endpoint on one of the four push services, and keys of the right shape. Internal.';



CREATE OR REPLACE FUNCTION "public"."remove_polls"("p_poll_ids" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user uuid := auth.uid();
  v_count integer;
begin
  if v_user is null then
    raise exception 'Sign in to change your poll list';
  end if;

  -- Only a poll that is on this reader's list can come off it: one they
  -- made, one they are invited to, or an open poll their account has
  -- answered -- the three ways list_polls lets a poll on. Anything else is
  -- skipped rather than refused, because the ids arrive in a batch and one
  -- of them may name a poll deleted since the page was drawn; a caller is
  -- told how many went in, which is what the browser's own migration of its
  -- old hidden ids needs and all a single click needs.
  insert into removed_polls (user_id, poll_id)
  select distinct v_user, head.id
  from unnest(coalesce(p_poll_ids, array[]::uuid[])) as asked(id)
  join polls head on head.id = poll_list_row(asked.id)
  where head.created_by = v_user
     or is_invited_to_poll(head.id)
     or v_user in (select poll_answering_accounts(head.id))
  on conflict do nothing;

  get diagnostics v_count = row_count;

  -- The reader's list, on every device showing it. The poll's own topic is
  -- not told: nothing about the poll changed.
  if v_count > 0 then
    perform announce('user:' || v_user::text, 'polls_changed');
  end if;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."remove_polls"("p_poll_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."remove_polls"("p_poll_ids" "uuid"[]) IS 'Takes polls off the caller''s list and stops telling them about those polls, by email and by push. Changes nothing about the poll itself. Any question of a group removes the group. Skips ids not on the caller''s list, and returns how many were removed.';



CREATE OR REPLACE FUNCTION "public"."removed_poll_count"() RETURNS integer
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select count(*)::int
  from removed_polls r
  join polls p on p.id = r.poll_id
  where r.user_id = auth.uid()
    and (
      p.created_by = auth.uid()
      or is_invited_to_poll(p.id)
      or auth.uid() in (select poll_answering_accounts(p.id))
    );
$$;


ALTER FUNCTION "public"."removed_poll_count"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."removed_poll_count"() IS 'How many polls the caller has removed from their list that are still on it to be restored: the same count list_polls carries as removed_count, for a list with no rows to carry it.';



CREATE OR REPLACE FUNCTION "public"."reopen_poll"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Only the poll creator can reopen this poll';
  end if;

  if v_poll.closed_at is null then
    raise exception 'This poll is not closed';
  end if;

  -- Which questions actually showed a tally, asked *before* the close is
  -- lifted: poll_results_revealed is computed from closed_at and turnout, so a
  -- moment from now it answers no for all of them. A question closed with
  -- nothing in it revealed nothing and is not marked -- the votes it takes
  -- from here are its first ones, not late ones.
  update polls set reopened_after_reveal = true
  where id in (
    select q.id from poll_group_members(v_poll) q where poll_results_revealed(q.*)
  );

  -- One statement for the group, as close_poll is: the questions stopped at
  -- the same moment and they start again at the same moment. The triggers on
  -- closed_at do the rest -- settle_winner takes back a winner the poll no
  -- longer has, notify_results_ready drops the notice row so a second finish
  -- is announced like the first, and the whole group is broadcast to whoever
  -- has it open.
  --
  -- What this cannot do is take an invite poll back off full turnout: a
  -- question every invitee has answered is revealed whether or not it is
  -- closed, so reopening one leaves its results where they are. That is the
  -- same gate everything else in this schema reads, and the way to take more
  -- votes on such a poll has always been a new one.
  update polls set closed_at = null
  where id in (select q.id from poll_group_members(v_poll) q)
    and closed_at is not null;
end;
$$;


ALTER FUNCTION "public"."reopen_poll"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."reopen_poll"("p_poll_id" "uuid") IS 'Puts a closed poll back to taking votes, keeping every ballot in it, for every question at once. Marks the questions whose results were out, so that a vote cast or changed from here says so on the results.';



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



CREATE OR REPLACE FUNCTION "public"."restore_polls"("p_poll_ids" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user uuid := auth.uid();
  v_count integer;
begin
  if v_user is null then
    raise exception 'Sign in to change your poll list';
  end if;

  delete from removed_polls r
  where r.user_id = v_user
    and r.poll_id in (
      select poll_list_row(asked.id)
      from unnest(coalesce(p_poll_ids, array[]::uuid[])) as asked(id)
    );

  get diagnostics v_count = row_count;

  if v_count > 0 then
    perform announce('user:' || v_user::text, 'polls_changed');
  end if;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."restore_polls"("p_poll_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."restore_polls"("p_poll_ids" "uuid"[]) IS 'Puts removed polls back on the caller''s list, and the caller back in their notifications. Returns how many came back.';



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



CREATE OR REPLACE FUNCTION "public"."save_push_subscription"("p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Sign in to get notifications on this device';
  end if;

  if not push_subscription_valid(p_endpoint, p_p256dh, p_auth) then
    raise exception 'This browser''s push subscription is not one this app can send to';
  end if;

  -- An endpoint is one browser, and a browser is whoever is signed in to it
  -- now: saving it again under another account moves it rather than
  -- refusing, and saving it again under the same one refreshes its keys.
  insert into push_subscriptions (endpoint, user_id, p256dh, auth)
  values (p_endpoint, v_user, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;

  -- A bound on what one account can make the sender do. Twenty is more
  -- browsers than anybody uses; the oldest go first, since a browser that
  -- has been reinstalled leaves its old endpoint behind and never comes back
  -- for it.
  delete from push_subscriptions
  where user_id = v_user
    and endpoint in (
      select endpoint from push_subscriptions
      where user_id = v_user
      order by created_at desc, endpoint
      offset 20);
end;
$$;


ALTER FUNCTION "public"."save_push_subscription"("p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."save_push_subscription"("p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") IS 'Binds this browser''s push subscription to the signed-in account, so it hears about that account''s polls.';



CREATE OR REPLACE FUNCTION "public"."send_invite_email"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_kind text;
  v_title_html text;
begin
  select * into v_poll from polls where id = new.poll_id;

  if not found then
    return new;
  end if;

  v_kind := poll_invite_kind(v_poll, new.email);

  if v_kind = 'none' then
    return new;
  end if;

  v_title_html := '<strong>' || email_escape(coalesce(v_poll.title, 'a poll')) || '</strong>';

  if v_kind = 'options' then
    perform send_poll_email(
      new.poll_id,
      new.email,
      'You''ve been added to a new poll',
      'Choose the options',
      'Choose options for ' || v_title_html || '. Sign in with this email address to add '
        || 'yours, and to say when you have finished.');
  else
    perform send_poll_email(
      new.poll_id,
      new.email,
      'You''ve been added to a new poll',
      'Your ballot is ready',
      'Vote now for ' || v_title_html || '. Sign in with this email address to see the '
        || 'options and cast your ballot.');
  end if;

  -- The same invitation, to the same one address, on whichever browsers it
  -- has turned notifications on in. Nobody watches a poll through its link
  -- before it exists, so there are no watchers to ask.
  perform push_poll(v_poll, 'invite_' || v_kind, array[lower(new.email)], false);

  return new;
end;
$$;


ALTER FUNCTION "public"."send_invite_email"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."send_invite_email"() IS 'Writes to somebody added to a poll''s invite list, about whichever stage the poll is at, by email and by push as their settings say; nothing at all to the creator. Best-effort, like every notification here.';



CREATE OR REPLACE FUNCTION "public"."send_poll_email"("p_poll_id" "uuid", "p_to" "text", "p_subject" "text", "p_heading" "text", "p_body_html" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_api_key text;
  v_link text;
begin
  if not wants_email(p_to) then
    return;
  end if;

  if to_regnamespace('net') is null or to_regnamespace('vault') is null then
    return;
  end if;

  select decrypted_secret into v_api_key
  from vault.decrypted_secrets
  where name = 'resend_api_key'
  limit 1;

  if v_api_key is null then
    return;
  end if;

  v_link := 'https://choicelab.app/star-voting/#/polls/' || short_poll_id(p_poll_id);

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_api_key
    ),
    body := jsonb_build_object(
      'from', 'STAR Voting <noreply@choicelab.app>',
      'to', jsonb_build_array(p_to),
      'subject', p_subject,
      'html', poll_email_html(p_heading, p_body_html, v_link)
    ),
    timeout_milliseconds := 8000
  );
end;
$$;


ALTER FUNCTION "public"."send_poll_email"("p_poll_id" "uuid", "p_to" "text", "p_subject" "text", "p_heading" "text", "p_body_html" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."send_poll_email"("p_poll_id" "uuid", "p_to" "text", "p_subject" "text", "p_heading" "text", "p_body_html" "text") IS 'Posts one email about one poll to Resend, linking to that poll -- unless the address belongs to an account that has turned email off. Best-effort: silent where pg_net, Vault or the API key is missing. Internal: the one place this app talks to a mailer.';



CREATE OR REPLACE FUNCTION "public"."send_poll_opened_email"("p_poll" "public"."polls", "p_email" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform send_poll_email(
    p_poll.id,
    p_email,
    'Voting is now open for your poll',
    'Voting is now open',
    'Options have been finalized and voting is now open for <strong>'
      || email_escape(coalesce(p_poll.title, 'a poll')) || '</strong>.');
end;
$$;


ALTER FUNCTION "public"."send_poll_opened_email"("p_poll" "public"."polls", "p_email" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."send_poll_opened_email"("p_poll" "public"."polls", "p_email" "text") IS 'Posts one "voting is open" email to Resend. Best-effort: silent where pg_net, Vault or the API key is missing. Internal.';



CREATE OR REPLACE FUNCTION "public"."send_push"("p_targets" "jsonb", "p_message" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_url text;
  v_secret text;
begin
  if p_targets is null or jsonb_array_length(p_targets) = 0 then
    return;
  end if;

  if to_regnamespace('net') is null or to_regnamespace('vault') is null then
    return;
  end if;

  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name = 'push_function_url'
  limit 1;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'push_function_secret'
  limit 1;

  if v_url is null or v_secret is null then
    return;
  end if;

  -- One request per announcement rather than one per browser, unlike the
  -- emails: a push endpoint is a URL on a push service, never shown to
  -- anybody, so sending them all to the function together discloses nothing
  -- to anyone -- and the function is what fans them out.
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body := jsonb_build_object('message', p_message, 'targets', p_targets),
    timeout_milliseconds := 8000
  );
end;
$$;


ALTER FUNCTION "public"."send_push"("p_targets" "jsonb", "p_message" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."send_push"("p_targets" "jsonb", "p_message" "jsonb") IS 'Hands one notification and every browser it is for to the send-push Edge Function. Best-effort: silent where pg_net, Vault or either of its two secrets is missing. Internal: the one place this app talks to a push sender.';



CREATE OR REPLACE FUNCTION "public"."send_results_ready_email"("p_poll" "public"."polls", "p_email" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform send_poll_email(
    p_poll.id,
    p_email,
    'Results are available for your poll',
    'The results are in',
    'Results are available for <strong>'
      || email_escape(coalesce(p_poll.title, 'a poll')) || '</strong>.');
end;
$$;


ALTER FUNCTION "public"."send_results_ready_email"("p_poll" "public"."polls", "p_email" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."send_results_ready_email"("p_poll" "public"."polls", "p_email" "text") IS 'Posts one "the results are in" email to Resend. Best-effort: silent where pg_net, Vault or the API key is missing. Internal.';



CREATE OR REPLACE FUNCTION "public"."set_notification_settings"("p_email" boolean, "p_push" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Sign in to change your notification settings';
  end if;

  if p_email is null or p_push is null then
    raise exception 'Say whether you want each kind of notification';
  end if;

  insert into notification_settings (user_id, email, push)
  values (v_user, p_email, p_push)
  on conflict (user_id) do update
    set email = excluded.email, push = excluded.push, updated_at = now();
end;
$$;


ALTER FUNCTION "public"."set_notification_settings"("p_email" boolean, "p_push" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."set_notification_settings"("p_email" boolean, "p_push" boolean) IS 'Sets which of the two channels -- email and push -- the signed-in account hears about its polls on.';



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


CREATE OR REPLACE FUNCTION "public"."settle_winner"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_question polls;
begin
  select * into v_poll from polls where id = p_poll_id;

  -- A poll on its way out -- the nightly purge, or the creator's own Delete
  -- button -- has no row left to write to, and every ballot cascading after it
  -- arrives here. Same early return, and for the same reason, as
  -- notify_results_ready.
  if not found then
    return;
  end if;

  -- The whole group, not the question that was touched. Results unlock for a
  -- poll of several questions when *all* of them have stopped, so the last
  -- ballot cast on question three is what gives questions one and two their
  -- answers as well; settling only the question that moved would leave those
  -- two blank forever.
  for v_question in select q.* from poll_group_members(v_poll) q loop
    -- The same predicate the three reads report as `results_available`, so a
    -- poll can never say its results are available and have no settled answer
    -- to show. Two conditions written separately would be two chances to
    -- drift.
    if not poll_results_revealed(v_question) then
      -- Back to taking votes. A poll that finishes again is a second result,
      -- and it is worked out from the votes it has then.
      if v_question.winner_settled_at is not null then
        update polls
        set winner_name = null, winner_settled_at = null
        where id = v_question.id;
      end if;

      continue;
    end if;

    -- Already answered, and the answer cannot have changed: every path that
    -- could move this question's tally refuses once its results are out.
    -- revise_ballot and open_poll_revise both check poll_results_revealed;
    -- submit_ballot refuses a closed poll, and an invite poll at full turnout
    -- has nobody left to hear from; guard_invitee_changes refuses a new
    -- invitee once the results are out; and the options were frozen by
    -- guard_options_frozen on the first ballot, with no UPDATE grant on
    -- candidates to rename one afterwards. So this is a skip rather than a
    -- recount, and running the election twice for one result is the thing
    -- this whole migration is about not doing.
    continue when v_question.winner_settled_at is not null;

    update polls
    set winner_name = poll_winner_name(v_question.id),
        winner_settled_at = now()
    where id = v_question.id;
  end loop;
end;
$$;


ALTER FUNCTION "public"."settle_winner"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."settle_winner"("p_poll_id" "uuid") IS 'Reconciles every question in one poll''s group with whether it actually has a result: works the winner out once when the poll crosses the line, and forgets it when a reset takes it back. Internal: called from the vote functions and the triggers below, never by a client.';



CREATE OR REPLACE FUNCTION "public"."settle_winner_for_emptied"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll uuid;
begin
  for v_poll in select distinct poll_id from old_rows loop
    perform settle_winner(v_poll);
  end loop;
  return null;
end;
$$;


ALTER FUNCTION "public"."settle_winner_for_emptied"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_winner_for_poll"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform settle_winner(NEW.id);
  return null;
end;
$$;


ALTER FUNCTION "public"."settle_winner_for_poll"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."short_poll_id"("p_poll_id" "uuid") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $_$
      -- Sixteen bytes encode to 24 characters, well under the 76 at which
      -- `encode` would start wrapping, so there is no newline to strip.
      select rtrim(translate(encode(uuid_send($1), 'base64'), '+/', '-_'), '=')
    $_$;


ALTER FUNCTION "public"."short_poll_id"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."short_poll_id"("p_poll_id" "uuid") IS 'A poll id as it is spelled in a URL: the same sixteen bytes in base64url, 22 characters instead of 36. The app spells it the same way and reads both spellings, so older long links still resolve. Internal: used to build the link in send_poll_email.';



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
  v_ballot_id uuid;
  v_item jsonb;
  v_candidate_id uuid;
  v_score int;
  v_candidate_count int;
begin
  if auth.uid() is null then
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
    select 1 from invited_voters
    where poll_id = p_poll_id and email = lower(auth.jwt() ->> 'email')
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

  -- Here rather than in a trigger on the insert above, because the scores this
  -- ballot is made of were written after it.
  perform settle_winner(p_poll_id);
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



CREATE OR REPLACE FUNCTION "public"."unconfirm_options"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  v_poll := confirming_invitee(p_poll_id);
  -- Only while the stage is still running, which is also the only time it can
  -- mean anything: once the poll is open there is nothing left to be done
  -- adding to, and the confirmations are a record of how it got there.
  perform assert_collecting_options(v_poll);

  delete from option_confirmations
  where poll_id = v_poll.id and voter_id = auth.uid();
end;
$$;


ALTER FUNCTION "public"."unconfirm_options"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."unconfirm_options"("p_poll_id" "uuid") IS 'Takes back a confirmation while the poll is still collecting, for somebody who has thought of one more thing. Refused once the list has become a ballot, which is a door that only closes.';



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



CREATE OR REPLACE FUNCTION "public"."wants_email"("p_email" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select not exists (
    select 1
    from notification_settings ns
    join auth.users u on u.id = ns.user_id
    where lower(u.email) = lower(p_email)
      and not ns.email
  );
$$;


ALTER FUNCTION "public"."wants_email"("p_email" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wants_email"("p_email" "text") IS 'Whether an address should be emailed about a poll: true unless an account with that address has turned email off. An address with no account is always true -- the invitation is the only way it could hear of the poll. Internal.';



CREATE OR REPLACE FUNCTION "public"."wants_push"("p_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce((select push from notification_settings where user_id = p_user_id), true);
$$;


ALTER FUNCTION "public"."wants_push"("p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."wants_push"("p_user_id" "uuid") IS 'Whether an account''s subscribed browsers should be pushed to: true unless it has turned push off. Internal.';



CREATE TABLE IF NOT EXISTS "public"."ballots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "poll_id" "uuid" NOT NULL,
    "voter_id" "uuid",
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "voter_name" "text",
    "voter_key" "text",
    "revised_at" timestamp with time zone,
    "account_id" "uuid",
    CONSTRAINT "ballots_one_owner_ck" CHECK ((("voter_id" IS NULL) OR ("account_id" IS NULL)))
);


ALTER TABLE "public"."ballots" OWNER TO "postgres";


COMMENT ON COLUMN "public"."ballots"."revised_at" IS 'When this ballot was last changed, or null if it never was. The scores are overwritten in place, so this is the only trace a revision leaves -- there is no history of what was scored before, which is the same secret ballot the poll promised when it was cast.';



COMMENT ON COLUMN "public"."ballots"."account_id" IS 'The account that cast this ballot through a share link, when somebody was signed in. Null on every invite ballot (which carries voter_id instead) and on an open ballot cast signed out. Read only by the open_poll_* functions, to hand a signed-in voter their own ballot on any device.';



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


CREATE TABLE IF NOT EXISTS "public"."notification_settings" (
    "user_id" "uuid" NOT NULL,
    "email" boolean DEFAULT true NOT NULL,
    "push" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notification_settings" OWNER TO "postgres";


COMMENT ON TABLE "public"."notification_settings" IS 'Which channels an account hears on. No row means both on. Read and written only through my_notification_settings and set_notification_settings.';



CREATE TABLE IF NOT EXISTS "public"."option_confirmations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "poll_id" "uuid" NOT NULL,
    "voter_id" "uuid",
    "voter_name" "text",
    "voter_key" "text",
    "confirmed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "account_id" "uuid",
    CONSTRAINT "option_confirmations_one_owner_ck" CHECK ((("voter_id" IS NULL) OR ("account_id" IS NULL)))
);


ALTER TABLE "public"."option_confirmations" OWNER TO "postgres";


COMMENT ON TABLE "public"."option_confirmations" IS 'One row per person who has said they are done adding options to this question. Read and written only through the confirm functions: no grants and no policies, like results_notices.';



COMMENT ON COLUMN "public"."option_confirmations"."account_id" IS 'The account that confirmed through a share link, when somebody was signed in; the confirmation-stage twin of ballots.account_id.';



CREATE TABLE IF NOT EXISTS "public"."poll_push_watches" (
    "poll_id" "uuid" NOT NULL,
    "endpoint" "text" NOT NULL,
    "p256dh" "text" NOT NULL,
    "auth" "text" NOT NULL
);


ALTER TABLE "public"."poll_push_watches" OWNER TO "postgres";


COMMENT ON TABLE "public"."poll_push_watches" IS 'A browser asking, through an open poll''s link, to be told when that poll opens for voting and when its results are ready. Carries nothing that identifies a voter, not even when it was made; filed against the group''s first question and deleted once the results are announced.';



CREATE TABLE IF NOT EXISTS "public"."push_subscriptions" (
    "endpoint" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "p256dh" "text" NOT NULL,
    "auth" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_subscriptions" OWNER TO "postgres";


COMMENT ON TABLE "public"."push_subscriptions" IS 'A browser that receives push notifications for the account it is bound to. Written through save_push_subscription and forget_push_subscription; read by nobody but the functions that send.';



CREATE TABLE IF NOT EXISTS "public"."removed_polls" (
    "user_id" "uuid" NOT NULL,
    "poll_id" "uuid" NOT NULL
);


ALTER TABLE "public"."removed_polls" OWNER TO "postgres";


COMMENT ON TABLE "public"."removed_polls" IS 'The polls each account has taken off its own list. Read by list_polls, to page around them, and by poll_email_audience, to stop telling that account about them; by nothing else. The poll is keyed by its list row, a group''s first question.';



CREATE TABLE IF NOT EXISTS "public"."results_notices" (
    "poll_id" "uuid" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."results_notices" OWNER TO "postgres";


COMMENT ON TABLE "public"."results_notices" IS 'One row per poll whose results have been announced by email, keyed on the group''s first question. Internal bookkeeping: no grants, and dropped when a reset puts the poll back to taking votes.';



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



ALTER TABLE ONLY "public"."notification_settings"
    ADD CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."option_confirmations"
    ADD CONSTRAINT "option_confirmations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."poll_push_watches"
    ADD CONSTRAINT "poll_push_watches_pkey" PRIMARY KEY ("poll_id", "endpoint");



ALTER TABLE ONLY "public"."polls"
    ADD CONSTRAINT "polls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("endpoint");



ALTER TABLE ONLY "public"."removed_polls"
    ADD CONSTRAINT "removed_polls_pkey" PRIMARY KEY ("user_id", "poll_id");



ALTER TABLE ONLY "public"."results_notices"
    ADD CONSTRAINT "results_notices_pkey" PRIMARY KEY ("poll_id");



ALTER TABLE ONLY "public"."scores"
    ADD CONSTRAINT "scores_ballot_id_candidate_id_key" UNIQUE ("ballot_id", "candidate_id");



ALTER TABLE ONLY "public"."scores"
    ADD CONSTRAINT "scores_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_ballots_account_id" ON "public"."ballots" USING "btree" ("account_id") WHERE ("account_id" IS NOT NULL);



CREATE INDEX "idx_ballots_poll_id" ON "public"."ballots" USING "btree" ("poll_id");



CREATE INDEX "idx_candidates_poll_id" ON "public"."candidates" USING "btree" ("poll_id");



CREATE INDEX "idx_invited_voters_email" ON "public"."invited_voters" USING "btree" ("email");



CREATE INDEX "idx_invited_voters_poll_id" ON "public"."invited_voters" USING "btree" ("poll_id");



CREATE INDEX "idx_option_confirmations_account_id" ON "public"."option_confirmations" USING "btree" ("account_id") WHERE ("account_id" IS NOT NULL);



CREATE INDEX "idx_option_confirmations_poll_id" ON "public"."option_confirmations" USING "btree" ("poll_id");



CREATE INDEX "idx_polls_created_at" ON "public"."polls" USING "btree" ("created_at");



CREATE INDEX "idx_polls_created_by" ON "public"."polls" USING "btree" ("created_by");



CREATE INDEX "idx_polls_group_id" ON "public"."polls" USING "btree" ("group_id") WHERE ("group_id" IS NOT NULL);



CREATE INDEX "idx_scores_ballot_id" ON "public"."scores" USING "btree" ("ballot_id");



CREATE INDEX "idx_scores_candidate_id" ON "public"."scores" USING "btree" ("candidate_id");



CREATE INDEX "push_subscriptions_user_id_idx" ON "public"."push_subscriptions" USING "btree" ("user_id");



CREATE INDEX "removed_polls_poll_id_idx" ON "public"."removed_polls" USING "btree" ("poll_id");



CREATE UNIQUE INDEX "uq_ballots_poll_account" ON "public"."ballots" USING "btree" ("poll_id", "account_id") WHERE ("account_id" IS NOT NULL);



CREATE UNIQUE INDEX "uq_ballots_poll_voter_key" ON "public"."ballots" USING "btree" ("poll_id", "voter_key") WHERE ("voter_key" IS NOT NULL);



CREATE UNIQUE INDEX "uq_ballots_poll_voter_name" ON "public"."ballots" USING "btree" ("poll_id", "lower"("voter_name")) WHERE ("voter_name" IS NOT NULL);



CREATE UNIQUE INDEX "uq_option_confirmations_poll_account" ON "public"."option_confirmations" USING "btree" ("poll_id", "account_id") WHERE ("account_id" IS NOT NULL);



CREATE UNIQUE INDEX "uq_option_confirmations_poll_voter" ON "public"."option_confirmations" USING "btree" ("poll_id", "voter_id") WHERE ("voter_id" IS NOT NULL);



CREATE UNIQUE INDEX "uq_option_confirmations_poll_voter_key" ON "public"."option_confirmations" USING "btree" ("poll_id", "voter_key") WHERE ("voter_key" IS NOT NULL);



CREATE UNIQUE INDEX "uq_option_confirmations_poll_voter_name" ON "public"."option_confirmations" USING "btree" ("poll_id", "lower"("voter_name")) WHERE ("voter_name" IS NOT NULL);



CREATE UNIQUE INDEX "uq_polls_group_position" ON "public"."polls" USING "btree" ("group_id", "question_position") WHERE ("group_id" IS NOT NULL);



CREATE OR REPLACE TRIGGER "ballots_broadcast_delete" AFTER DELETE ON "public"."ballots" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_emptied"();



CREATE OR REPLACE TRIGGER "ballots_broadcast_insert" AFTER INSERT ON "public"."ballots" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_touched"();



CREATE OR REPLACE TRIGGER "ballots_mark_late_votes" AFTER INSERT OR UPDATE ON "public"."ballots" FOR EACH ROW EXECUTE FUNCTION "public"."mark_votes_after_reveal"();



CREATE OR REPLACE TRIGGER "ballots_notify_results_delete" AFTER DELETE ON "public"."ballots" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."notify_results_for_emptied"();



CREATE OR REPLACE TRIGGER "ballots_notify_results_insert" AFTER INSERT ON "public"."ballots" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."notify_results_for_touched"();



CREATE OR REPLACE TRIGGER "ballots_settle_winner_delete" AFTER DELETE ON "public"."ballots" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."settle_winner_for_emptied"();



CREATE OR REPLACE TRIGGER "candidates_broadcast_delete" AFTER DELETE ON "public"."candidates" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_emptied"();



CREATE OR REPLACE TRIGGER "candidates_broadcast_insert" AFTER INSERT ON "public"."candidates" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_touched"();



CREATE OR REPLACE TRIGGER "candidates_broadcast_update" AFTER UPDATE ON "public"."candidates" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_touched"();



CREATE OR REPLACE TRIGGER "candidates_fill_scores" AFTER INSERT ON "public"."candidates" FOR EACH ROW EXECUTE FUNCTION "public"."fill_scores_for_new_option"();



CREATE OR REPLACE TRIGGER "invited_voters_broadcast_delete" AFTER DELETE ON "public"."invited_voters" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_emptied"();



CREATE OR REPLACE TRIGGER "invited_voters_broadcast_insert" AFTER INSERT ON "public"."invited_voters" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_touched"();



CREATE OR REPLACE TRIGGER "invited_voters_notify_results_delete" AFTER DELETE ON "public"."invited_voters" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."notify_results_for_emptied"();



CREATE OR REPLACE TRIGGER "invited_voters_settle_winner_delete" AFTER DELETE ON "public"."invited_voters" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."settle_winner_for_emptied"();



CREATE OR REPLACE TRIGGER "option_confirmations_broadcast_delete" AFTER DELETE ON "public"."option_confirmations" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_emptied"();



CREATE OR REPLACE TRIGGER "option_confirmations_broadcast_insert" AFTER INSERT ON "public"."option_confirmations" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_touched"();



CREATE OR REPLACE TRIGGER "polls_broadcast_delete" BEFORE DELETE ON "public"."polls" FOR EACH ROW EXECUTE FUNCTION "public"."broadcast_poll_gone"();



CREATE OR REPLACE TRIGGER "polls_broadcast_update" AFTER UPDATE ON "public"."polls" FOR EACH ROW EXECUTE FUNCTION "public"."broadcast_poll_updated"();



CREATE OR REPLACE TRIGGER "polls_notify_results_closed" AFTER UPDATE OF "closed_at" ON "public"."polls" FOR EACH ROW WHEN (("new"."closed_at" IS DISTINCT FROM "old"."closed_at")) EXECUTE FUNCTION "public"."notify_results_for_poll"();



CREATE OR REPLACE TRIGGER "polls_settle_winner_closed" AFTER UPDATE OF "closed_at" ON "public"."polls" FOR EACH ROW WHEN (("new"."closed_at" IS DISTINCT FROM "old"."closed_at")) EXECUTE FUNCTION "public"."settle_winner_for_poll"();



CREATE OR REPLACE TRIGGER "trg_clear_confirmation_for_uninvited" AFTER DELETE ON "public"."invited_voters" FOR EACH ROW EXECUTE FUNCTION "public"."clear_confirmation_for_uninvited"();



CREATE OR REPLACE TRIGGER "trg_guard_invitee_changes" BEFORE INSERT OR DELETE ON "public"."invited_voters" FOR EACH ROW EXECUTE FUNCTION "public"."guard_invitee_changes"();



CREATE OR REPLACE TRIGGER "trg_guard_options_frozen" BEFORE INSERT OR DELETE ON "public"."candidates" FOR EACH ROW EXECUTE FUNCTION "public"."guard_options_frozen"();



CREATE OR REPLACE TRIGGER "trg_normalize_invited_email" BEFORE INSERT OR UPDATE ON "public"."invited_voters" FOR EACH ROW EXECUTE FUNCTION "public"."normalize_invited_email"();



CREATE OR REPLACE TRIGGER "trg_send_invite_email" AFTER INSERT ON "public"."invited_voters" FOR EACH ROW WHEN ("public"."poll_is_first_question"("new"."poll_id")) EXECUTE FUNCTION "public"."send_invite_email"();



CREATE OR REPLACE TRIGGER "trg_set_poll_creator_email" BEFORE INSERT ON "public"."polls" FOR EACH ROW EXECUTE FUNCTION "public"."set_poll_creator_email"();



ALTER TABLE ONLY "public"."ballots"
    ADD CONSTRAINT "ballots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ballots"
    ADD CONSTRAINT "ballots_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ballots"
    ADD CONSTRAINT "ballots_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."candidates"
    ADD CONSTRAINT "candidates_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invited_voters"
    ADD CONSTRAINT "invited_voters_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_settings"
    ADD CONSTRAINT "notification_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."option_confirmations"
    ADD CONSTRAINT "option_confirmations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."option_confirmations"
    ADD CONSTRAINT "option_confirmations_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."option_confirmations"
    ADD CONSTRAINT "option_confirmations_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."poll_push_watches"
    ADD CONSTRAINT "poll_push_watches_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."polls"
    ADD CONSTRAINT "polls_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."removed_polls"
    ADD CONSTRAINT "removed_polls_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."removed_polls"
    ADD CONSTRAINT "removed_polls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."results_notices"
    ADD CONSTRAINT "results_notices_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



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



ALTER TABLE "public"."notification_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."option_confirmations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."poll_push_watches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."polls" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "polls_delete" ON "public"."polls" FOR DELETE USING (("created_by" = "auth"."uid"()));



CREATE POLICY "polls_insert" ON "public"."polls" FOR INSERT WITH CHECK (("created_by" = "auth"."uid"()));



CREATE POLICY "polls_select" ON "public"."polls" FOR SELECT USING ((("created_by" = "auth"."uid"()) OR "public"."is_invited_to_poll"("id")));



ALTER TABLE "public"."push_subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."removed_polls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."results_notices" ENABLE ROW LEVEL SECURITY;


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



REVOKE ALL ON FUNCTION "public"."announce"("p_topic" "text", "p_event" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."assert_collecting_options"("p_poll" "public"."polls") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."assert_open_results_readable"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."assert_results_readable"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."ballot_sheet"("p_poll_id" "uuid", "p_named" boolean) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."broadcast_poll_gone"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."broadcast_poll_updated"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."clear_confirmation_for_uninvited"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."close_poll"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."close_poll"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."confirm_options"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_options"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."confirming_invitee"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."creator_add_options"("p_poll_id" "uuid", "p_options" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."creator_add_options"("p_poll_id" "uuid", "p_options" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."creator_edit_options"("p_poll_id" "uuid", "p_options" "jsonb", "p_remove" "uuid"[], "p_correct" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."creator_edit_options"("p_poll_id" "uuid", "p_options" "jsonb", "p_remove" "uuid"[], "p_correct" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."fill_scores_for_new_option"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."finalize_options"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_options"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."forget_push_endpoints"("p_endpoints" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."forget_push_endpoints"("p_endpoints" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."forget_push_subscription"("p_endpoint" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."forget_push_subscription"("p_endpoint" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_poll_ranking"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_ranking"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_poll_results"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_results"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."insert_options"("p_poll" "public"."polls", "p_options" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid", "p_question_position" integer, "p_kind" "text", "p_schedule" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."is_invited_to_poll"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_invited_to_poll"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."is_poll_creator"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_poll_creator"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer, "p_removed" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer, "p_removed" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."mark_votes_after_reveal"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."my_notification_settings"("p_endpoint" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_notification_settings"("p_endpoint" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."normalize_invite_emails"("p_emails" "text"[]) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."notify_poll_opened"("p_poll_id" "uuid", "p_by_itself" boolean) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."notify_results_for_emptied"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."notify_results_for_poll"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."notify_results_for_touched"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."notify_results_ready"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."open_ballot_of"("p_poll_id" "uuid", "p_voter_key" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."open_confirmation_of"("p_poll_id" "uuid", "p_voter_key" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."open_options_when_all_confirmed"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."open_poll_ballots"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_ballots"("p_poll_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_ballots"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_confirm_options"("p_poll_id" "uuid", "p_voter_key" "text", "p_voter_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_confirm_options"("p_poll_id" "uuid", "p_voter_key" "text", "p_voter_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_confirm_options"("p_poll_id" "uuid", "p_voter_key" "text", "p_voter_name" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_group"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_group"("p_poll_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_group"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_ranking"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_ranking"("p_poll_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_ranking"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_results"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_results"("p_poll_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_results"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_submit"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_submit"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_submit"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_unconfirm_options"("p_poll_id" "uuid", "p_voter_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_unconfirm_options"("p_poll_id" "uuid", "p_voter_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_unconfirm_options"("p_poll_id" "uuid", "p_voter_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_unwatch"("p_poll_id" "uuid", "p_endpoint" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_unwatch"("p_poll_id" "uuid", "p_endpoint" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_unwatch"("p_poll_id" "uuid", "p_endpoint" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_view"("p_poll_id" "uuid", "p_voter_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_view"("p_poll_id" "uuid", "p_voter_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_view"("p_poll_id" "uuid", "p_voter_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."open_poll_watch"("p_poll_id" "uuid", "p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_watch"("p_poll_id" "uuid", "p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_watch"("p_poll_id" "uuid", "p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."options_confirmed_by_everyone"("p_poll" "public"."polls") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_answering_accounts"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_ballot_scores"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_ballot_scores"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."poll_ballots"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_ballots"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."poll_confirmed_count"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_email_audience"("p_poll" "public"."polls", "p_include_creator" boolean, "p_actor" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_email_html"("p_heading" "text", "p_body_html" "text", "p_link" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_expires_at"("p_poll" "public"."polls") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_gate_open"("p_poll" "public"."polls") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_group"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_group"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."poll_group_members"("p_poll" "public"."polls") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_invite_kind"("p_poll" "public"."polls", "p_email" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."poll_is_first_question"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_is_removed"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_is_removed"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."poll_list_row"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_page"("p_poll_id" "uuid", "p_voter_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_page"("p_poll_id" "uuid", "p_voter_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."poll_page"("p_poll_id" "uuid", "p_voter_key" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."poll_push_targets"("p_poll" "public"."polls", "p_emails" "text"[], "p_watchers" boolean, "p_actor" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_ranking"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_results_audience"("p_poll" "public"."polls", "p_actor" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_results_ready"("p_poll" "public"."polls") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_results_revealed"("p_poll" "public"."polls") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_retention_window"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_status"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_status"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."poll_tally"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_winner_name"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."poll_winners"("p_poll_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_winners"("p_poll_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."purge_old_polls"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."push_message"("p_poll" "public"."polls", "p_event" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."push_poll"("p_poll" "public"."polls", "p_event" "text", "p_emails" "text"[], "p_watchers" boolean) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."push_subscription_valid"("p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."remove_polls"("p_poll_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."remove_polls"("p_poll_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."removed_poll_count"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."removed_poll_count"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."reopen_poll"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reopen_poll"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."replace_scores"("p_ballot_id" "uuid", "p_poll_id" "uuid", "p_scores" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."restore_polls"("p_poll_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."restore_polls"("p_poll_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."revise_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."revise_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."save_push_subscription"("p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_push_subscription"("p_endpoint" "text", "p_p256dh" "text", "p_auth" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."send_invite_email"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."send_poll_email"("p_poll_id" "uuid", "p_to" "text", "p_subject" "text", "p_heading" "text", "p_body_html" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."send_poll_opened_email"("p_poll" "public"."polls", "p_email" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."send_push"("p_targets" "jsonb", "p_message" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."send_results_ready_email"("p_poll" "public"."polls", "p_email" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."set_notification_settings"("p_email" boolean, "p_push" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_notification_settings"("p_email" boolean, "p_push" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."settle_winner"("p_poll_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."settle_winner_for_emptied"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."settle_winner_for_poll"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."star_round"("p_poll_id" "uuid", "p_pool" "uuid"[]) FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."submit_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."suggest_options"("p_poll_id" "uuid", "p_options" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."unconfirm_options"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."unconfirm_options"("p_poll_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."wants_email"("p_email" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."wants_push"("p_user_id" "uuid") FROM PUBLIC;
























GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ballots" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ballots" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."ballots" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."candidates" TO "anon";
GRANT SELECT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."candidates" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."candidates" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."invited_voters" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."invited_voters" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."invited_voters" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."notification_settings" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."option_confirmations" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."option_confirmations" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."option_confirmations" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."poll_push_watches" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."push_subscriptions" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."removed_polls" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."results_notices" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."results_notices" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."results_notices" TO "service_role";



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


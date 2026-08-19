-- Polls that collect their options from the people voting in them.
--
-- Until now a poll's options were written by its creator, in the create form,
-- and frozen the moment the poll existed. A poll created with
-- solicit_options starts one stage earlier: it has no ballot at all, only a
-- list that everyone in the poll can add to, and it stays there until the
-- creator finalizes the list. Voting opens then, and from that point the poll
-- behaves exactly like every other poll -- same ballot, same tally, same
-- rules about who may see what.
--
-- The stage is two columns rather than a status enum, because they answer two
-- different questions and only one of them is a setting. solicit_options is
-- frozen at creation like mode, show_voters and show_ballots: it says where
-- this poll's options came from, and it is still worth reading long after the
-- poll has closed. options_finalized_at is a state, like closed_at, and moves
-- exactly once. A poll is *collecting* when it solicits options, has not been
-- finalized, and has not been closed -- the same shape as the existing
-- "closed" reading, and derived rather than stored so the two can never
-- disagree.
--
-- Four rules hold it together, and each is enforced here rather than in the
-- client:
--
--   1. Nobody votes while options are being collected. Both submit paths
--      refuse, so a stale page cannot slip a ballot in against a list that is
--      still growing -- and an early ballot would be cast against a different
--      question from the one everyone else answers.
--   2. Suggestions stop the moment the list is finalized. The finalized list
--      is the one every voter is scoring, so it cannot grow underneath them.
--   3. Only the creator finalizes, and only into a real ballot: two options
--      minimum, the same floor create_poll puts on a poll whose creator wrote
--      the options.
--   4. Suggesting goes through a function in both modes, for the creator too.
--      An invitee has no INSERT grant on candidates and anon has no grant on
--      any table, so the rules above live in exactly one place and everyone
--      in a poll reaches them the same way -- the same reason the creator
--      votes in their own open poll through the anon RPC rather than a path
--      of their own.
--
-- Suggestions are not attributed to anyone. Who suggested what is a third
-- disclosure question on top of "who responded" and "how they voted", and the
-- poll's tags answer neither of those about the option list; storing a name
-- nobody displays would only be a leak waiting to happen.


ALTER TABLE "public"."polls"
  ADD COLUMN IF NOT EXISTS "solicit_options" boolean DEFAULT false NOT NULL;

ALTER TABLE "public"."polls"
  ADD COLUMN IF NOT EXISTS "options_finalized_at" timestamp with time zone;

-- A poll whose creator wrote the options has nothing to finalize, so the
-- timestamp cannot be set on one.
ALTER TABLE "public"."polls"
  ADD CONSTRAINT "polls_options_finalized_ck"
  CHECK (("options_finalized_at" IS NULL) OR "solicit_options");

COMMENT ON COLUMN "public"."polls"."solicit_options" IS 'The options were collected from respondents rather than written by the creator. A setting, frozen at creation like mode, show_voters and show_ballots.';

COMMENT ON COLUMN "public"."polls"."options_finalized_at" IS 'When the creator closed the option list and opened voting. Null on a poll still collecting options; never set on a poll that did not solicit them.';


-- ---------------------------------------------------------------------------
-- Adding one suggested option
--
-- The whole rule set for a suggestion, in one place, called by both entry
-- points below once each has established that the caller belongs to the poll.
-- It takes the poll row rather than an id because its callers have already
-- read it -- and because a caller that has not read the poll has not checked
-- who is asking.
--
-- Not granted to anybody: it trusts its caller completely, and its callers
-- are SECURITY DEFINER functions that run as the owner.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."add_suggested_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_next int;
  v_count int;
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

  if v_name is null then
    raise exception 'Give the option a name';
  end if;

  -- Lengths are capped here and nowhere else, because this is the one field
  -- in the app a whole group can write to rather than the poll's creator
  -- alone. Neither limit is near what a real suggestion needs: a name is a
  -- label on a ballot, and a description is a couple of lines under it.
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
    raise exception '"%" has already been suggested', v_name;
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


ALTER FUNCTION "public"."add_suggested_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."add_suggested_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") FROM PUBLIC;


-- ---------------------------------------------------------------------------
-- Suggesting into an invite poll
-- ---------------------------------------------------------------------------

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

REVOKE ALL ON FUNCTION "public"."suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."suggest_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") TO "authenticated";


-- ---------------------------------------------------------------------------
-- Suggesting into an open poll
--
-- The fifth open_poll_* function, and the same bargain as the other four: the
-- share token is the whole capability, and it buys access to this poll and
-- nothing else in the schema.
-- ---------------------------------------------------------------------------

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

REVOKE ALL ON FUNCTION "public"."open_poll_suggest_option"("p_token" "text", "p_name" "text", "p_description" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_suggest_option"("p_token" "text", "p_name" "text", "p_description" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_suggest_option"("p_token" "text", "p_name" "text", "p_description" "text") TO "authenticated";


-- ---------------------------------------------------------------------------
-- Closing the option list
--
-- One-way, like closing the poll itself, and for the same reason: everyone
-- who votes has to be scoring the same list.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."finalize_options"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_options int;
begin
  if not exists (select 1 from polls where id = p_poll_id and created_by = auth.uid()) then
    raise exception 'Only the poll creator can finalize these options';
  end if;

  select * into v_poll from polls where id = p_poll_id;

  if not v_poll.solicit_options then
    raise exception 'The options for this poll were set when it was created';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  if v_poll.options_finalized_at is not null then
    raise exception 'The options for this poll have already been finalized';
  end if;

  select count(*) into v_options from candidates where poll_id = p_poll_id;

  -- The same floor create_poll puts on a poll whose creator wrote the
  -- options: one option is not an election.
  if v_options < 2 then
    raise exception 'Add at least two options before opening the poll for voting';
  end if;

  update polls set options_finalized_at = now() where id = p_poll_id;
end;
$$;


ALTER FUNCTION "public"."finalize_options"("p_poll_id" "uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."finalize_options"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finalize_options"("p_poll_id" "uuid") TO "authenticated";


-- ---------------------------------------------------------------------------
-- Creating a poll that solicits its options
--
-- The only change to create_poll is the new setting and what it does to the
-- two-option minimum: a poll collecting its options may start with none at
-- all, and finalize_options applies the same floor later, when the list is
-- about to become a ballot. Seeding a few is still allowed and is the usual
-- way to start one off -- "here are three, add yours".
--
-- The old signature is dropped rather than left alongside the new one: two
-- overloads where one argument list is a prefix of the other are ambiguous to
-- PostgREST, which resolves an RPC by the arguments it is given.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[]);

CREATE OR REPLACE FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_option_descriptions" "text"[] DEFAULT NULL::"text"[], "p_solicit_options" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_poll_id uuid;
  v_token text;
  v_opts text[];
  v_descs text[];
  v_mails text[];
  v_bad text;
  v_solicit boolean := coalesce(p_solicit_options, false);
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

  -- Drop blanks but keep the author's ordering, carrying each option's
  -- description along with it so the two cannot come apart.
  select array_agg(trim(o) order by ord),
         array_agg(nullif(trim(coalesce(p_option_descriptions[ord], '')), '') order by ord)
  into v_opts, v_descs
  from unnest(p_options) with ordinality as t(o, ord)
  where trim(coalesce(o, '')) <> '';

  -- A poll collecting its options is allowed to start with none; the same
  -- minimum is applied by finalize_options, when the list becomes a ballot.
  if not v_solicit and coalesce(array_length(v_opts, 1), 0) < 2 then
    raise exception 'Add at least two options';
  end if;

  if p_mode = 'invite' then
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
  else
    -- 122 bits from a v4 UUID, hex digits only, so it needs no escaping in
    -- a URL. gen_random_uuid() is core Postgres -- no extension involved.
    v_token := replace(gen_random_uuid()::text, '-', '');
  end if;

  insert into polls (title, description, created_by, mode, show_voters, show_ballots, solicit_options, public_token)
  values (
    trim(p_title),
    nullif(trim(coalesce(p_description, '')), ''),
    auth.uid(),
    p_mode,
    coalesce(p_show_voters, true),
    coalesce(p_show_ballots, false),
    v_solicit,
    v_token
  )
  returning id into v_poll_id;

  -- coalesce, not array_length alone: a soliciting poll can legitimately
  -- arrive with an empty option list, and a null upper bound is an error
  -- rather than an empty loop.
  for i in 1 .. coalesce(array_length(v_opts, 1), 0) loop
    insert into candidates (poll_id, name, description, sort_order)
    values (v_poll_id, v_opts[i], v_descs[i], i - 1);
  end loop;

  if p_mode = 'invite' then
    for i in 1 .. array_length(v_mails, 1) loop
      insert into invited_voters (poll_id, email) values (v_poll_id, v_mails[i]);
    end loop;
  end if;

  return v_poll_id;
end;
$_$;


ALTER FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean) TO "authenticated";


-- ---------------------------------------------------------------------------
-- Nobody votes while the options are still being collected
--
-- Both submit paths, because both are reachable while a page sits open: an
-- invitee whose tab was showing a ballot before the poll was reset, or an
-- open poll's voter whose page has not refreshed. An early ballot would be
-- scoring a different question from the one everyone else answers.
-- ---------------------------------------------------------------------------

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


-- ---------------------------------------------------------------------------
-- Reporting the stage
--
-- "Collecting" is derived rather than stored -- solicits options, not
-- finalized, not closed -- so it can never disagree with the columns it is
-- read from, the same way is_closed is derived from closed_at. Every page
-- that renders a poll reads it from one of these three, and the option count
-- travels with it on the list, where "0 responses" would have been an
-- accurate but useless thing to say about a poll nobody can vote in yet.
--
-- Both functions have to be dropped rather than replaced: a new column in a
-- RETURNS TABLE is a new return type.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS "public"."poll_status"("p_poll_id" "uuid");

CREATE OR REPLACE FUNCTION "public"."poll_status"("p_poll_id" "uuid") RETURNS TABLE("invited_count" integer, "voted_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_invited int;
  v_voted int;
  v_closed boolean;
  v_mode text;
  v_soliciting boolean;
begin
  if not exists (
    select 1 from polls p
    where p.id = p_poll_id
      and (
        p.created_by = auth.uid()
        or exists (select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email)
      )
  ) then
    raise exception 'Poll not found';
  end if;

  select count(*)::int into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*)::int into v_voted from ballots where poll_id = p_poll_id;
  select closed_at is not null,
         mode,
         solicit_options and options_finalized_at is null and closed_at is null
  into v_closed, v_mode, v_soliciting
  from polls where id = p_poll_id;

  return query select
    v_invited,
    v_voted,
    v_invited > 0 and v_voted >= v_invited,
    exists (select 1 from ballots where poll_id = p_poll_id and voter_id = auth.uid()),
    v_closed,
    -- A closed poll with zero ballots has nothing to show.
    v_voted > 0 and (
      v_closed or (v_mode = 'invite' and v_invited > 0 and v_voted >= v_invited)
    ),
    v_soliciting;
end;
$$;


ALTER FUNCTION "public"."poll_status"("p_poll_id" "uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_status"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_status"("p_poll_id" "uuid") TO "authenticated";


DROP FUNCTION IF EXISTS "public"."list_polls"();

CREATE OR REPLACE FUNCTION "public"."list_polls"() RETURNS TABLE("id" "uuid", "title" "text", "description" "text", "created_by" "uuid", "created_by_email" "text", "created_at" timestamp with time zone, "closed_at" timestamp with time zone, "mode" "text", "show_voters" boolean, "show_ballots" boolean, "solicit_options" boolean, "options_finalized_at" timestamp with time zone, "public_token" "text", "invited_count" integer, "voted_count" integer, "option_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with visible as (
    select p.*
    from polls p
    where p.created_by = auth.uid()
       or exists (
         select 1 from invited_voters iv
         where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
       )
  ), tallied as (
    select
      v.id as poll_id,
      (select count(*)::int from invited_voters iv where iv.poll_id = v.id) as invited_count,
      (select count(*)::int from ballots b where b.poll_id = v.id) as voted_count,
      (select count(*)::int from candidates c where c.poll_id = v.id) as option_count,
      exists (select 1 from ballots b where b.poll_id = v.id and b.voter_id = auth.uid()) as voted
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
    t.invited_count > 0 and t.voted_count >= t.invited_count,
    t.voted,
    v.closed_at is not null,
    -- Open polls reveal only on close; invite polls keep the completion
    -- rule as well.
    t.voted_count > 0 and (
      v.closed_at is not null
      or (v.mode = 'invite' and t.invited_count > 0 and t.voted_count >= t.invited_count)
    ),
    v.solicit_options and v.options_finalized_at is null and v.closed_at is null
  from visible v
  join tallied t on t.poll_id = v.id
  order by v.created_at desc;
$$;


ALTER FUNCTION "public"."list_polls"() OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."list_polls"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_polls"() TO "authenticated";


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

  if p_voter_key is null or trim(p_voter_key) = '' then
    v_voted_already := false;
  else
    select true, b.voter_name into v_voted_already, v_your_name
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
      'closed_at', v_poll.closed_at
    ),
    'options', v_options,
    'voted_count', v_voted,
    'is_closed', v_poll.closed_at is not null,
    -- Still gathering options: no ballot yet, and nothing to reveal.
    'soliciting', v_poll.solicit_options
                  and v_poll.options_finalized_at is null
                  and v_poll.closed_at is null,
    -- Open polls reveal only on close, so early votes can never steer late
    -- ones. This is the same promise the invite mode makes.
    'results_available', v_voted > 0 and v_poll.closed_at is not null,
    'voted', v_voted_already,
    'your_name', v_your_name,
    'voters', v_voters
  );
end;
$$;

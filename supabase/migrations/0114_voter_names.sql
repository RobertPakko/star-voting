-- An invite poll that shows its voters can show them by name.
--
-- A poll that shows who has responded used to show an invite poll's voters by
-- email address, to every other voter: people who would rather not hand
-- their address round the group, and who could not tell which address was
-- whose. Now the creator chooses, when making the poll, between showing the
-- addresses and giving every invitee a name.
--
--   * invited_voters.name is the name the creator gave, and voter_name the one
--     the invitee gave themselves, which takes priority. Both are on every
--     question's row, like the address: one name per person per poll.
--   * A poll's voters are named exactly when its invitees carry names
--     (poll_names_voters). The create form gives all of them one or none of
--     them one, and invite_voter keeps it that way afterwards.
--   * poll_invitees gives a named poll's roster by name, and the address to
--     its creator alone. The published ballot sheet, its CSV, the option
--     assignment and the sequential count name invite ballots the same way
--     (ballot_voter_label).
--
-- A poll that shows addresses is unchanged, and so is every poll made before
-- this.


-- ---------------------------------------------------------------------------
-- 1. The names
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."invited_voters"
    ADD COLUMN "name" "text",
    ADD COLUMN "voter_name" "text",
    ADD CONSTRAINT "invited_voters_name_ck"
        CHECK ("name" IS NULL OR ("name" = "btrim"("name") AND "length"("name") BETWEEN 1 AND 60)),
    ADD CONSTRAINT "invited_voters_voter_name_ck"
        CHECK ("voter_name" IS NULL OR ("voter_name" = "btrim"("voter_name") AND "length"("voter_name") BETWEEN 1 AND 60));


COMMENT ON COLUMN "public"."invited_voters"."name" IS 'The name the creator gave this invitee, on a poll that shows its voters by name. Every invitee of such a poll has one; no invitee of any other poll does. See poll_names_voters.';


COMMENT ON COLUMN "public"."invited_voters"."voter_name" IS 'The name the invitee gave themselves, from the name box on the ballot or the confirmation. Shown in place of name. See set_voter_name.';



CREATE OR REPLACE FUNCTION "public"."poll_names_voters"("p_poll_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.name is not null
  );
$$;


ALTER FUNCTION "public"."poll_names_voters"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_names_voters"("p_poll_id" "uuid") IS 'Whether this invite poll shows its voters by name rather than by address: whether its invitees were given names, which is all of them or none. Internal.';



CREATE OR REPLACE FUNCTION "public"."validate_invitee_name"("p_poll_id" "uuid", "p_name" "text", "p_email" "text") RETURNS "void"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if p_name is null or p_name = '' then
    raise exception 'Give every voter a name';
  end if;

  if length(p_name) > 60 then
    raise exception 'The name "%" is too long', p_name;
  end if;

  -- A roster of two Sams cannot say which one has voted. Everybody's name
  -- as the roster shows it, apart from the person being named.
  if exists (
    select 1 from invited_voters iv
    where iv.poll_id = p_poll_id
      and iv.email <> p_email
      and lower(coalesce(iv.voter_name, iv.name)) = lower(p_name)
  ) then
    raise exception 'Somebody in this poll is already called "%". Add a last initial to tell them apart.', p_name;
  end if;
end;
$$;


ALTER FUNCTION "public"."validate_invitee_name"("p_poll_id" "uuid", "p_name" "text", "p_email" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."validate_invitee_name"("p_poll_id" "uuid", "p_name" "text", "p_email" "text") IS 'Refuses a name the roster could not show: blank, too long, or already somebody else''s in this poll. Internal: the one place the creator''s names and the invitees'' own are held to the same rules.';



CREATE OR REPLACE FUNCTION "public"."apply_invitee_names"("p_poll_id" "uuid", "p_names" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_email text;
  v_name text;
begin
  if p_names is null or p_names = 'null'::jsonb or p_names = '{}'::jsonb then
    return;
  end if;

  if jsonb_typeof(p_names) <> 'object' then
    raise exception 'Give the names as an object from address to name';
  end if;

  select * into v_poll from polls where id = p_poll_id;

  if v_poll.mode <> 'invite' then
    raise exception 'Only an invite poll gives its voters names';
  end if;

  -- A name is how the roster shows somebody, so a poll with no roster has
  -- no use for one.
  if not v_poll.show_voters then
    raise exception 'Only a poll that shows its voters gives them names';
  end if;

  -- One at a time, so each is checked against the ones already given.
  -- Addresses are compared as the list stores them, lowercased.
  for v_email in
    select iv.email from invited_voters iv where iv.poll_id = p_poll_id order by iv.email
  loop
    select nullif(trim(n.value #>> '{}'), '') into v_name
    from jsonb_each(p_names) n
    where lower(trim(n.key)) = v_email
      and jsonb_typeof(n.value) = 'string'
    limit 1;

    -- All or none: a roster with some names and some addresses shows the
    -- addresses of exactly the people it was meant to keep them for.
    if v_name is null then
      raise exception 'Give every voter a name: % has none', v_email;
    end if;

    perform validate_invitee_name(p_poll_id, v_name, v_email);

    update invited_voters
    set name = v_name
    where email = v_email
      and poll_id in (select q.id from poll_group_members(v_poll) q);
  end loop;
end;
$$;


ALTER FUNCTION "public"."apply_invitee_names"("p_poll_id" "uuid", "p_names" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."apply_invitee_names"("p_poll_id" "uuid", "p_names" "jsonb") IS 'Gives every invitee of a poll just made the name the creator chose, on every question. Internal: called by create_poll and create_poll_group, in the transaction that made the poll.';



CREATE OR REPLACE FUNCTION "public"."ballot_voter_label"("p_ballot" "public"."ballots") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    -- An open ballot carries the name it was cast under.
    p_ballot.voter_name,
    -- An invite ballot is its invitee: their own name, the creator's, or the
    -- address on a poll that shows addresses.
    (select coalesce(iv.voter_name, iv.name, iv.email)
       from auth.users u
       join invited_voters iv on iv.poll_id = p_ballot.poll_id and iv.email = lower(u.email)
      where u.id = p_ballot.voter_id),
    -- An invitee taken off the list cannot have voted, but an address that
    -- changed since is still somebody.
    (select lower(u.email) from auth.users u where u.id = p_ballot.voter_id)
  );
$$;


ALTER FUNCTION "public"."ballot_voter_label"("p_ballot" "public"."ballots") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."ballot_voter_label"("p_ballot" "public"."ballots") IS 'Who a ballot is, as the poll shows its voters: the typed name on an open poll, and on an invite poll the invitee''s own name, then the creator''s name for them, then their address. Internal: the published sheet, the option assignment and the sequential count all name ballots through this, so they cannot disagree.';



-- ---------------------------------------------------------------------------
-- 2. Making a poll with names, and inviting somebody to one later
-- ---------------------------------------------------------------------------
--
-- p_invitee_names maps each address on the list to its name. Absent, the
-- poll shows addresses as it always did.

DROP FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb", "p_option_costs" numeric[]);

CREATE OR REPLACE FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_option_descriptions" "text"[] DEFAULT NULL::"text"[], "p_solicit_options" boolean DEFAULT false, "p_kind" "text" DEFAULT 'option'::"text", "p_schedule" "jsonb" DEFAULT NULL::"jsonb", "p_kind_value" numeric DEFAULT NULL::numeric, "p_carried" "jsonb" DEFAULT NULL::"jsonb", "p_option_costs" numeric[] DEFAULT NULL::numeric[], "p_invitee_names" "jsonb" DEFAULT NULL::"jsonb") RETURNS "uuid"
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
  perform apply_invitee_names(v_id, p_invitee_names);

  return v_id;
end;
$$;


ALTER FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb", "p_option_costs" numeric[], "p_invitee_names" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb", "p_option_costs" numeric[], "p_invitee_names" "jsonb") IS 'Creates one poll with its options and its invitees. A time poll carries a schedule and options its creator''s browser enumerated from a painted calendar; the database stores it exactly as it stores any other poll. A time poll may collect its times from voters, through suggest_options. The kind also says which result the poll opens on; see polls.kind. p_carried makes it a sequential poll: see carried_weights. p_option_costs are each option''s number, paired by position with the options: a budget''s costs or an assignment''s places. p_invitee_names gives every invitee a name, from address to name, so the poll shows its voters by name rather than by address.';


REVOKE ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb", "p_option_costs" numeric[], "p_invitee_names" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb", "p_option_costs" numeric[], "p_invitee_names" "jsonb") TO "authenticated";



DROP FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean);

CREATE OR REPLACE FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_solicit_options" boolean DEFAULT false, "p_invitee_names" "jsonb" DEFAULT NULL::"jsonb") RETURNS "uuid"
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

  -- Once, after every question has its list: the names are the poll's, and
  -- apply_invitee_names writes them across the group.
  perform apply_invitee_names(v_first, p_invitee_names);

  return v_first;
end;
$$;


ALTER FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_invitee_names" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_invitee_names" "jsonb") IS 'Creates a poll that asks several questions: one poll row per question, sharing a group, a title, a description, an invite list and their settings. One transaction. Each question carries a kind of its own (and a time question a schedule, a ranking or multiple winners a number). A soliciting group collects options question by question and opens all of them at once; see finalize_options. p_invitee_names gives every invitee a name, as for create_poll.';


REVOKE ALL ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_invitee_names" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_invitee_names" "jsonb") TO "authenticated";



DROP FUNCTION "public"."invite_voter"("p_poll_id" "uuid", "p_email" "text");

CREATE OR REPLACE FUNCTION "public"."invite_voter"("p_poll_id" "uuid", "p_email" "text", "p_name" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_poll polls;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_question uuid;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  -- The same 'not found' a poll that exists but isn't yours gets everywhere
  -- else.
  if not found then
    raise exception 'Poll not found';
  end if;

  -- The shape invited_voters_email_ck holds the table to, said in words
  -- before the constraint can say it in its own.
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'That does not look like an email address';
  end if;

  -- A poll whose voters were given names gives everybody one, so the roster
  -- never shows a name beside an address; a poll that shows addresses gives
  -- nobody one, since a name would make it the other kind of poll.
  if poll_names_voters(p_poll_id) then
    if v_name is null then
      raise exception 'Give % a name: this poll shows its voters by name', v_email;
    end if;
    perform validate_invitee_name(p_poll_id, v_name, v_email);
  elsif v_name is not null then
    raise exception 'This poll shows its voters by email address, so they are not given names';
  end if;

  -- First question first, which is the one the invitation is sent about; see
  -- trg_send_invite_email. An address already on a question is left as it
  -- is, so inviting somebody again completes a list that was left lopsided
  -- rather than refusing to touch it. Everything else -- an open poll, a
  -- closed one, results that are out, the ceilings -- is
  -- guard_invitee_changes', asked of every row.
  --
  -- Asked first rather than left to `on conflict`: the guard is a BEFORE
  -- trigger, and would count an invitation for a row that was never written.
  for v_question in select q.id from poll_group_members(v_poll) q loop
    if not exists (
      select 1 from invited_voters where poll_id = v_question and email = v_email
    ) then
      insert into invited_voters (poll_id, email, name) values (v_question, v_email, v_name);
    end if;
  end loop;
end;
$_$;


ALTER FUNCTION "public"."invite_voter"("p_poll_id" "uuid", "p_email" "text", "p_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."invite_voter"("p_poll_id" "uuid", "p_email" "text", "p_name" "text") IS 'Adds one address to the creator''s own poll, on every question of it, and invites them once. The only way onto an invite list after the poll is made. A poll that shows its voters by name needs a name with the address; any other poll refuses one.';


REVOKE ALL ON FUNCTION "public"."invite_voter"("p_poll_id" "uuid", "p_email" "text", "p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."invite_voter"("p_poll_id" "uuid", "p_email" "text", "p_name" "text") TO "authenticated";



-- ---------------------------------------------------------------------------
-- 3. An invitee names themselves
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."set_voter_name"("p_poll_id" "uuid", "p_name" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_poll polls;
  v_question uuid;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id;

  if not found or v_poll.mode <> 'invite' or not exists (
    select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email
  ) then
    raise exception 'Poll not found';
  end if;

  if not poll_names_voters(p_poll_id) then
    raise exception 'This poll shows its voters by email address, so they are not given names';
  end if;

  -- The window a vote can change in, and for the same reason: a name is part
  -- of what a published sheet says, and the sheet is out with the results.
  if v_poll.closed_at is not null or poll_results_revealed(v_poll) then
    raise exception 'This poll has finished, so names can no longer be changed';
  end if;

  if v_name is null then
    raise exception 'Enter your name so the group can see who has voted';
  end if;

  perform validate_invitee_name(p_poll_id, v_name, v_email);

  -- Unchanged is nothing: no write, and no signal to everybody watching.
  if exists (
    select 1 from invited_voters iv
    where iv.poll_id = p_poll_id and iv.email = v_email
      and coalesce(iv.voter_name, iv.name) = v_name
  ) then
    return;
  end if;

  update invited_voters
  set voter_name = v_name
  where email = v_email
    and poll_id in (select q.id from poll_group_members(v_poll) q);

  -- No trigger announces an update of the list, so this does: the roster of
  -- every question shows the name.
  for v_question in select q.id from poll_group_members(v_poll) q loop
    perform broadcast_poll_change(v_question);
  end loop;
end;
$$;


ALTER FUNCTION "public"."set_voter_name"("p_poll_id" "uuid", "p_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."set_voter_name"("p_poll_id" "uuid", "p_name" "text") IS 'The caller, an invitee of a poll that shows its voters by name, gives the name they are shown under, on every question of the poll, in place of the one the creator gave. Until the poll finishes.';


REVOKE ALL ON FUNCTION "public"."set_voter_name"("p_poll_id" "uuid", "p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_voter_name"("p_poll_id" "uuid", "p_name" "text") TO "authenticated";



-- ---------------------------------------------------------------------------
-- 4. The roster
-- ---------------------------------------------------------------------------
--
-- Two columns more: the name, and whether the row is the reader's own (so
-- the ballot's name box can start from it). And on a poll that names its
-- voters, the address goes to the creator alone. `id` keys a row where there
-- is no address to key it by.

DROP FUNCTION "public"."poll_invitees"("p_poll_id" "uuid");

CREATE OR REPLACE FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") RETURNS TABLE("id" "uuid", "email" "text", "name" "text", "has_voted" boolean, "has_confirmed" boolean, "is_you" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_is_creator boolean;
  v_is_invited boolean;
  v_show boolean;
  v_mode text;
  v_named boolean;
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

  v_named := poll_names_voters(p_poll_id);

  return query
  select
    iv.id,
    -- The creator chose names so the group would not see the addresses;
    -- the creator still needs them, to manage the list.
    case when v_is_creator or not v_named then iv.email end,
    coalesce(iv.voter_name, iv.name),
    case when v_show then exists (
      select 1 from ballots b
      join auth.users u on u.id = b.voter_id
      where b.poll_id = p_poll_id and lower(u.email) = iv.email
    ) else null::boolean end,
    -- Held back on the same terms as has_voted: who has confirmed is a
    -- roster, so it is the roster's setting that decides who reads it.
    case when v_show then exists (
      select 1 from option_confirmations oc
      join auth.users u on u.id = oc.voter_id
      where oc.poll_id = p_poll_id and lower(u.email) = iv.email
    ) else null::boolean end,
    iv.email = v_email
  from invited_voters iv
  where iv.poll_id = p_poll_id
  order by lower(coalesce(iv.voter_name, iv.name, iv.email)), iv.email;
end;
$$;


ALTER FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") IS 'The invite list as the reader may see it: to the creator always, and to every invitee where the poll shows its respondents. On a poll that names its voters, everybody but the creator gets names and no addresses. has_voted and has_confirmed are null where the poll hides respondents.';


REVOKE ALL ON FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_invitees"("p_poll_id" "uuid") TO "authenticated";



-- ---------------------------------------------------------------------------
-- 5. Everything else that names a ballot
-- ---------------------------------------------------------------------------

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

  select coalesce(jsonb_agg(x.ballot order by x.sort_key, x.id), '[]'::jsonb)
  into v_ballots
  from (
    select
      jsonb_build_object(
        -- No ballot id in the payload: on an unnamed sheet it would be the
        -- one field that could be correlated with anything else, and the
        -- client only ever needs a row's position.
        'voter', case when p_named then ballot_voter_label(b) end,
        'scores', coalesce(
          (select jsonb_object_agg(s.candidate_id::text, s.score)
           from scores s where s.ballot_id = b.id),
          '{}'::jsonb)
      ) || case when p_named and g.given is not null
                then jsonb_build_object('given', trim_scale(g.given))
                else '{}'::jsonb end as ballot,
      case
        when p_named then lower(ballot_voter_label(b))
        else md5(b.id::text)
      end as sort_key,
      b.id
    from ballots b
    -- The N each ballot is counted at, which a sequential count may have set.
    join ballot_given(p_poll_id) g on g.ballot_id = b.id
    where b.poll_id = p_poll_id
  ) x;

  return jsonb_build_object(
    'voters_named', p_named,
    'options', v_options,
    'ballots', v_ballots
  );
end;
$$;


CREATE OR REPLACE FUNCTION "public"."assignment_count"("p_poll_id" "uuid", "p_excluded" "uuid"[], "p_places" "jsonb", "p_per_voter" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_ballots uuid[];
  v_names text[];
  v_options uuid[];
  v_cap int[];
  v_left int[];     -- each option's places still free
  v_stars int[];
  v_draw bigint[];
  v_per_voter int;
  n int;
  m int;
  w int;            -- the options and going without
  v_none int;       -- the column for going without
  v_big bigint := 9223372036854775807;
  v_log bigint[] := array[0,
    round(ln(2::numeric) * 1e12)::bigint, round(ln(3::numeric) * 1e12)::bigint,
    round(ln(4::numeric) * 1e12)::bigint, round(ln(5::numeric) * 1e12)::bigint];
  v_gain bigint[];  -- ln((held + stars) / held) x 10^12, at (held - 1) x 5 + stars
  k bigint;
  s bigint;
  -- Across rounds, by voter.
  v_held_stars int[];
  v_count int[];
  v_holds boolean[];  -- by (voter - 1) x m + option
  -- One round, by the round's own voter numbering.
  v_who int[];
  na int;
  e_hi bigint[];
  e_lo bigint[];
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
  nd_hi bigint;
  nd_lo bigint;
  v_given int;
  r int;
  i int;
  j int;
  h int;
  t int;
  g int;
  best int;
  v_score int;
  v_key text;
  v_value jsonb;
  v_result_options jsonb;
  v_unplaced jsonb;
  v_short jsonb;
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

  if p_per_voter is not null then
    perform validate_per_voter(p_per_voter);
  end if;
  v_per_voter := coalesce(p_per_voter,
    case when v_poll.kind = 'assignment' then v_poll.kind_value::int end, 1);

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
         coalesce(array_agg(coalesce(ballot_voter_label(b), 'A voter') order by b.id), '{}'::text[])
  into v_ballots, v_names
  from ballots b
  where b.poll_id = p_poll_id;

  n := coalesce(array_length(v_ballots, 1), 0);
  if n = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if n > 2000 then
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

  -- Bounded by the work the count does: about voters x voters x options for
  -- the first round, each later one cheaper as the options fill (measured at
  -- about half), so a reader waits a few seconds at most -- Supabase's
  -- statement timeout, not CPU, is the ceiling that matters.
  if n::bigint * n * (m + 1) * (least(v_per_voter, m) + 1) / 2 > 15000000 then
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

  -- ln 6 is the largest gain a round can give a voter already holding a
  -- star (1 held, 5 more), and ln 5 the largest first star.
  k := (n + 1)::bigint * 1800000000000;
  s := (n + 1)::bigint * 268435456;

  v_gain := array_fill(0::bigint, array[5 * v_per_voter * 5]);
  for g in 1 .. 5 * v_per_voter loop
    for v_score in 1 .. 5 loop
      v_gain[(g - 1) * 5 + v_score] := round(ln((g + v_score)::numeric / g) * 1e12)::bigint;
    end loop;
  end loop;

  v_left := v_cap;
  v_held_stars := array_fill(0, array[n]);
  v_count := array_fill(0, array[n]);
  v_holds := array_fill(false, array[n * m]);

  loop
    -- The voters in this round: under the cap, with an option they do not
    -- hold still having a place.
    select coalesce(array_agg(g.v order by g.v), '{}'::int[]) into v_who
    from generate_series(1, n) g(v)
    where v_count[g.v] < v_per_voter
      and exists (select 1 from generate_series(1, m) o(h)
                  where v_left[o.h] > 0 and not v_holds[(g.v - 1) * m + o.h]);
    na := coalesce(array_length(v_who, 1), 0);
    exit when na = 0;

    -- Every edge's cost this round, by the round's voter; v_big where the
    -- voter cannot take the option.
    e_hi := array_fill(v_big, array[na * w]);
    e_lo := array_fill(v_big, array[na * w]);
    for r in 1 .. na loop
      i := v_who[r];
      e_hi[(r - 1) * w + v_none] := 0;
      e_lo[(r - 1) * w + v_none] := 0;
      for h in 1 .. m loop
        continue when v_left[h] = 0 or v_holds[(i - 1) * m + h];
        v_score := v_stars[(i - 1) * m + h];
        e_hi[(r - 1) * w + h] := case
          when v_score = 0 then 0
          when v_held_stars[i] = 0 then -(k + v_log[v_score])
          else -v_gain[(v_held_stars[i] - 1) * 5 + v_score]
        end;
        e_lo[(r - 1) * w + h] := -(v_score * s + v_draw[(i - 1) * m + h]);
      end loop;
    end loop;

    u_hi := array_fill(0::bigint, array[na]);
    u_lo := array_fill(0::bigint, array[na]);
    v_hi := array_fill(0::bigint, array[w]);
    v_lo := array_fill(0::bigint, array[w]);
    col := array_fill(0, array[na]);
    cnt := array_fill(0, array[w]);

    for r in 1 .. na loop
      d_hi := array_fill(v_big, array[w]);
      d_lo := array_fill(v_big, array[w]);
      way := array_fill(0, array[w]);
      done := array_fill(false, array[w]);

      -- From the new voter, at a potential of nothing, to every column.
      for h in 1 .. w loop
        continue when e_hi[(r - 1) * w + h] = v_big;
        d_hi[h] := e_hi[(r - 1) * w + h] - v_hi[h];
        d_lo[h] := e_lo[(r - 1) * w + h] - v_lo[h];
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

        if best = v_none or cnt[best] < v_left[best] then
          t := best;
          exit;
        end if;

        -- A full option: each voter in it could move on, at no cost to
        -- reach, since the edge that holds them there is tight.
        for i in 1 .. r - 1 loop
          continue when col[i] <> best;
          for h in 1 .. w loop
            continue when done[h] or e_hi[(i - 1) * w + h] = v_big;
            nd_hi := d_hi[best] + e_hi[(i - 1) * w + h] - u_hi[i] - v_hi[h];
            nd_lo := d_lo[best] + e_lo[(i - 1) * w + h] - u_lo[i] - v_lo[h];
            if (nd_hi, nd_lo) < (d_hi[h], d_lo[h]) then
              d_hi[h] := nd_hi;
              d_lo[h] := nd_lo;
              way[h] := i;
            end if;
          end loop;
        end loop;
      end loop;

      -- Potentials, so every edge stays non-negative and the path just found
      -- is tight: a settled column comes down by how far short of the sink
      -- it was, and each voter reached through one goes up by the same.
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

    -- What the round handed out. A round that hands out nothing is the end:
    -- nobody under the cap could take a place.
    v_given := 0;
    for r in 1 .. na loop
      continue when col[r] = v_none;
      i := v_who[r];
      h := col[r];
      v_holds[(i - 1) * m + h] := true;
      v_held_stars[i] := v_held_stars[i] + v_stars[(i - 1) * m + h];
      v_count[i] := v_count[i] + 1;
      v_left[h] := v_left[h] - 1;
      v_given := v_given + 1;
    end loop;
    exit when v_given = 0;
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
             where v_holds[(g.v - 1) * m + o.ord]), '[]'::jsonb))
           order by v_cap[o.ord] - v_left[o.ord] desc, o.ord), '[]'::jsonb)
  into v_result_options
  from unnest(v_options) with ordinality o(id, ord)
  join candidates c on c.id = o.id;

  select coalesce(jsonb_agg(jsonb_build_object('name', v_names[g.v])
                            order by lower(v_names[g.v]), g.v), '[]'::jsonb)
  into v_unplaced
  from generate_series(1, n) g(v)
  where v_count[g.v] = 0;

  select coalesce(jsonb_agg(jsonb_build_object('name', v_names[g.v], 'count', v_count[g.v])
                            order by lower(v_names[g.v]), g.v), '[]'::jsonb)
  into v_short
  from generate_series(1, n) g(v)
  where v_count[g.v] between 1 and v_per_voter - 1;

  select coalesce(jsonb_object_agg(x.stars, x.handed), '{}'::jsonb)
  into v_received
  from (
    select v_stars[(g.v - 1) * m + o.h] as stars, count(*) as handed
    from generate_series(1, n) g(v)
    cross join generate_series(1, m) o(h)
    where v_holds[(g.v - 1) * m + o.h]
    group by 1
  ) x;

  return jsonb_build_object(
    'options', v_result_options,
    'unplaced', v_unplaced,
    'short', v_short,
    'received', v_received,
    'places', (select sum(p::bigint) from unnest(v_cap) p),
    'per_voter', v_per_voter,
    'voter_count', n,
    'stars_shown', v_poll.show_ballots);
end;
$$;


CREATE OR REPLACE FUNCTION "public"."poll_sequential"("p_poll_id" "uuid", "p_kind" "text", "p_given" numeric[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_ballots uuid[];
  v_map jsonb;
  v_result jsonb;
begin
  select * into v_poll from polls where id = p_poll_id;

  if not (v_poll.show_voters and v_poll.show_ballots) then
    raise exception 'Only a poll that publishes its ballots with names on them can be counted as a sequential poll';
  end if;

  if v_poll.schedule is not null then
    raise exception 'A time poll cannot be counted as a sequential poll';
  end if;

  if p_kind is null or p_kind not in ('option', 'ranking', 'multiple') then
    raise exception 'Only the best option, multiple winners or proportional winners can be counted as a sequential poll';
  end if;

  -- The sheet's order, which is how the reader gave the N.
  select coalesce(array_agg(b.id order by lower(ballot_voter_label(b)), b.id), '{}'::uuid[])
  into v_ballots
  from ballots b
  where b.poll_id = p_poll_id;

  if cardinality(v_ballots) = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if coalesce(cardinality(p_given), 0) <> cardinality(v_ballots) then
    raise exception 'Give every ballot the stars its voter gave earlier winners';
  end if;

  if exists (select 1 from unnest(p_given) g where g is null or g < 0 or g > 10000) then
    raise exception 'Stars given to previous winners must be from 0 to 10000';
  end if;

  select jsonb_object_agg(u.b::text, u.g) into v_map
  from unnest(v_ballots, p_given) u(b, g);

  perform set_config('app.sequential_given',
                     jsonb_build_object('poll', p_poll_id, 'given', v_map)::text, true);

  v_result := case when p_kind = 'multiple'
                   then poll_multiple_winners(p_poll_id, '{}')
                   else poll_ranking(p_poll_id) end;

  perform set_config('app.sequential_given', '', true);

  return v_result;
end;
$$;



REVOKE ALL ON FUNCTION "public"."poll_names_voters"("p_poll_id" "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."validate_invitee_name"("p_poll_id" "uuid", "p_name" "text", "p_email" "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."apply_invitee_names"("p_poll_id" "uuid", "p_names" "jsonb") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."ballot_voter_label"("p_ballot" "public"."ballots") FROM PUBLIC;

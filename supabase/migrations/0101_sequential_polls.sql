-- Sequential polls: a question that remembers how much each of its voters
-- liked the winners of earlier polls, and counts every ballot at the strength
-- multiple winners would give it, 5 / (5 + N), N being the stars it gave
-- those winners. Over a run of polls the wins are shared out between groups
-- instead of the largest group taking every one.
--
-- Nothing links one poll to the next. A question is sequential exactly when
-- it carries a list of earlier voters, each with an N, typed on the create
-- form (or filled in there from a finished poll's published ballots, which is
-- only a convenience). A ballot cast on it takes the N of the voter it
-- matches, or the newcomer's N if it matches nobody, and keeps it: the tally
-- reads the weights off the ballots, so a question with no weighted ballots
-- is counted exactly as before.
--
--   * carried_weights: the earlier voters of a question. A row is claimed by
--     the ballot that matches it, once. Readable by no client.
--   * ballots.given: the N a ballot was cast at, null on every ballot of a
--     question that is not sequential.
--
-- Only the four results STAR decides can be sequential (the best option or
-- time, the option ranking, multiple winners), and a sequential question
-- shows both who voted and the ballots, or neither: a weight on a ballot with
-- no name on it would name it.


CREATE TABLE IF NOT EXISTS "public"."carried_weights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "poll_id" "uuid" NOT NULL,
    "voter" "text" NOT NULL,
    "given" numeric NOT NULL,
    "claimed" boolean DEFAULT false NOT NULL,
    CONSTRAINT "carried_weights_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "carried_weights_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE,
    CONSTRAINT "carried_weights_given_ck" CHECK ((("given" >= (0)::numeric) AND ("given" <= (10000)::numeric))),
    CONSTRAINT "carried_weights_voter_ck" CHECK ((("length"("voter") >= 1) AND ("length"("voter") <= 320)))
);

ALTER TABLE "public"."carried_weights" OWNER TO "postgres";

COMMENT ON TABLE "public"."carried_weights" IS 'The voters a sequential question remembers from earlier polls, each with the stars it gave their winners (given). A name on an open poll, a lowercased address on an invite poll. Written only by create_poll and create_poll_group; claimed by the first ballot that matches it. RLS on, no policies, no grants: which rows are claimed would be a list of who has voted.';

CREATE UNIQUE INDEX "uq_carried_weights_poll_voter" ON "public"."carried_weights" USING "btree" ("poll_id", "lower"("voter"));

ALTER TABLE "public"."carried_weights" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."carried_weights" FROM "anon", "authenticated";


ALTER TABLE "public"."ballots"
  ADD COLUMN "given" numeric,
  ADD CONSTRAINT "ballots_given_ck" CHECK ((("given" IS NULL) OR ("given" >= (0)::numeric)));

COMMENT ON COLUMN "public"."ballots"."given" IS 'On a sequential question, the stars this ballot''s voter had given earlier winners when it was cast: the carried row it claimed, or the newcomer''s share (newcomer_given). Its weight is 5 / (5 + given). Null on every ballot of a question that is not sequential. Fixed at casting; a revision does not move it.';


-- Whether a question's ballots carry weights.
CREATE OR REPLACE FUNCTION "public"."poll_is_weighted"("p_poll_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (select 1 from ballots where poll_id = p_poll_id and given is not null)
$$;

ALTER FUNCTION "public"."poll_is_weighted"("uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_is_weighted"("uuid") FROM PUBLIC;


-- Every ballot's weight, scaled so the strongest ballot counts as one. The
-- scale changes no comparison STAR makes (every count is a sum of weights),
-- and it keeps the figures readable after many polls have shrunk every
-- ballot: the sheet shows the same weights, so its totals add up. A question
-- that is not sequential has every ballot at one.
CREATE OR REPLACE FUNCTION "public"."poll_ballot_weights"("p_poll_id" "uuid") RETURNS TABLE("ballot_id" "uuid", "weight" numeric)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select b.id, (5 + m.low) / (5 + coalesce(b.given, 0))
  from ballots b,
       (select coalesce(min(given), 0) as low from ballots where poll_id = p_poll_id) m
  where b.poll_id = p_poll_id
$$;

ALTER FUNCTION "public"."poll_ballot_weights"("uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_ballot_weights"("uuid") FROM PUBLIC;


-- One STAR round over `p_pool`: star_round, or its weighted twin where the
-- ballots carry weights. Every single-winner count goes through here.
CREATE OR REPLACE FUNCTION "public"."poll_round"("p_poll_id" "uuid", "p_pool" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_ballots uuid[];
  v_weights numeric[];
begin
  if not poll_is_weighted(p_poll_id) then
    return star_round(p_poll_id, p_pool);
  end if;

  select coalesce(array_agg(w.ballot_id order by w.ballot_id), '{}'::uuid[]),
         coalesce(array_agg(w.weight order by w.ballot_id), '{}'::numeric[])
  into v_ballots, v_weights
  from poll_ballot_weights(p_poll_id) w;

  return weighted_star_round(p_poll_id, p_pool, v_ballots, v_weights);
end;
$$;

ALTER FUNCTION "public"."poll_round"("uuid", "uuid"[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_round"("uuid", "uuid"[]) FROM PUBLIC;


-- The N a ballot matching nobody is cast at: the one that gives it the
-- average weight of the voters the question carries, so joining late neither
-- helps nor hurts. The average is of the weights, not of N, which would
-- leave a newcomer weaker than the average ballot. Fixed for the question's
-- whole life, since the carried list is. Null on a question that carries
-- nobody.
CREATE OR REPLACE FUNCTION "public"."newcomer_given"("p_poll_id" "uuid") RETURNS numeric
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select trim_scale(round(5 / avg(5 / (5 + given)) - 5, 6))
  from carried_weights
  where poll_id = p_poll_id
  having count(*) > 0
$$;

ALTER FUNCTION "public"."newcomer_given"("uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."newcomer_given"("uuid") FROM PUBLIC;


-- The N a ballot about to be cast on `p_poll_id` takes, claiming the carried
-- row it matches: by address on an invite poll, by name on an open one. A row
-- is claimed once; a second ballot under the same name (on an open poll that
-- hides names, where nothing else stops one) is a newcomer. Null on a
-- question that is not sequential. Called inside the casting transaction,
-- under its lock, so a refused ballot claims nothing.
CREATE OR REPLACE FUNCTION "public"."claim_carried_weight"("p_poll_id" "uuid", "p_voter" "text") RETURNS numeric
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_voter text := nullif(trim(coalesce(p_voter, '')), '');
  v_given numeric;
begin
  if not exists (select 1 from carried_weights where poll_id = p_poll_id) then
    return null;
  end if;

  if v_voter is not null then
    update carried_weights
    set claimed = true
    where poll_id = p_poll_id and lower(voter) = lower(v_voter) and not claimed
    returning given into v_given;

    if found then
      return v_given;
    end if;
  end if;

  return newcomer_given(p_poll_id);
end;
$$;

ALTER FUNCTION "public"."claim_carried_weight"("uuid", "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."claim_carried_weight"("uuid", "text") FROM PUBLIC;


-- The earlier voters of a question being created, from its create call.
-- `p_carried` is `[{ voter, given }]`, or null for a question that is not
-- sequential. Called after the question's invitees are in, since an invite
-- poll's earlier voters must be on its list.
CREATE OR REPLACE FUNCTION "public"."insert_carried_weights"("p_poll_id" "uuid", "p_carried" "jsonb", "p_question" integer DEFAULT NULL::integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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

  if v_poll.kind not in ('option', 'time', 'ranking', 'multiple') then
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
$$;

ALTER FUNCTION "public"."insert_carried_weights"("uuid", "jsonb", integer) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."insert_carried_weights"("uuid", "jsonb", integer) FROM PUBLIC;


-- create_poll takes the earlier voters, appended with a default so every
-- existing call means what it meant. Drop and create; its grant is restated.
DROP FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric);

CREATE FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_option_descriptions" "text"[] DEFAULT NULL::"text"[], "p_solicit_options" boolean DEFAULT false, "p_kind" "text" DEFAULT 'option'::"text", "p_schedule" "jsonb" DEFAULT NULL::"jsonb", "p_kind_value" numeric DEFAULT NULL::numeric, "p_carried" "jsonb" DEFAULT NULL::"jsonb") RETURNS "uuid"
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
           jsonb_build_object('name', o, 'description', p_option_descriptions[ord])
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

ALTER FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb") IS 'Creates one poll with its options and its invitees. A time poll carries a schedule and options its creator''s browser enumerated from a painted calendar; the database stores it exactly as it stores any other poll. A time poll may collect its times from voters, through suggest_options. The kind also says which result the poll opens on; see polls.kind. p_carried makes it a sequential poll: see carried_weights.';

REVOKE ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb", "p_kind_value" numeric, "p_carried" "jsonb") TO "authenticated";


-- create_poll_group reads each question's earlier voters from its object
-- (`carried`), so its signature, and its grants, are unchanged.
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

    -- Each question is its own sequence: one voter can have given the
    -- winning films a lot of stars and the winning times none.
    perform insert_carried_weights(v_id, v_question -> 'carried', i + 1);

    if i = 0 then
      v_first := v_id;
    end if;
  end loop;

  return v_first;
end;
$$;


-- The two ways a ballot is cast claim its carried weight. Copied from the
-- baseline, changed only where the ballot row is inserted.
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
  v_given numeric;
begin
  perform lock_poll(p_poll_id);

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

  -- An invitee is known by their address, so a sequential question finds
  -- their earlier weight without asking.
  v_given := claim_carried_weight(p_poll_id, lower(auth.jwt() ->> 'email'));

  insert into ballots (poll_id, voter_id, given) values (p_poll_id, auth.uid(), v_given)
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
  v_given numeric;
begin
  perform lock_poll(p_poll_id);

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

  -- A sequential question matches the name the reader gave, even on a poll
  -- that hides names: there the name finds the weight and is then thrown
  -- away, as every name on such a poll is.
  v_given := claim_carried_weight(v_poll.id, p_voter_name);

  begin
    insert into ballots (poll_id, voter_id, account_id, voter_name, voter_key, given)
    values (v_poll.id, null, auth.uid(), v_name, v_key, v_given)
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


-- The tally counts at the ballots' weights where they carry them, and says
-- so (`weighted`): totals are then weighted sums, and averages are over the
-- total weight rather than the number of ballots.
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
    'kind_result', v_kind_result,
    'weighted', v_weighted
  );
end;
$$;


-- The winner kept with the poll is elected at the same weights.
CREATE OR REPLACE FUNCTION "public"."poll_winner_name"("p_poll_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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

  if v_kind in ('consensus', 'consensus_time') and array_length(v_pool, 1) >= 2 then
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
$$;


-- The option ranking at the same weights: every place a round of the same
-- ballots at the same strengths, as the head round is.
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
  v_finalist_names jsonb;
  v_ranking jsonb := '[]'::jsonb;
  v_place int := 1;
  v_weighted boolean;
begin
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  v_weighted := poll_is_weighted(p_poll_id);

  -- Names and totals, for labelling the places. Scores are absolute sums, so
  -- eliminating an option never changes anyone else's total and this is read
  -- once for the whole ladder rather than per round.
  drop table if exists _ranking_tally;
  create temp table _ranking_tally on commit drop as
  select
    c.id as cid,
    c.name,
    case when v_weighted
         then trim_scale(round(coalesce(sum(s.score * w.weight), 0), 6))
         else coalesce(sum(s.score), 0) end as total
  from candidates c
  left join scores s on s.candidate_id = c.id
  left join poll_ballot_weights(p_poll_id) w on w.ballot_id = s.ballot_id
  where c.poll_id = p_poll_id
  group by c.id, c.name;

  select coalesce(array_agg(cid), '{}'::uuid[]) into v_pool from _ranking_tally;

  -- Every place is a whole STAR round over every ballot, so the ladder stops
  -- once the top places are filled. A place shared by a tied runoff can take
  -- the last round one past the cut; it is kept whole rather than split.
  while coalesce(array_length(v_pool, 1), 0) > 0 and v_place <= poll_results_rows() loop
    v_round := poll_round(p_poll_id, v_pool);

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

    -- The runoff's two names, in the order of `finalists`. The option a place
    -- beat may never be placed itself before the ladder stops, so the browser
    -- cannot look it up anywhere else.
    select coalesce(jsonb_agg(t.name order by f.ord), '[]'::jsonb)
    into v_finalist_names
    from unnest(v_finalists) with ordinality f(cid, ord)
    join _ranking_tally t on t.cid = f.cid;

    v_ranking := v_ranking || jsonb_build_array(jsonb_build_object(
      'place', v_place,
      'options', v_placed_json,
      'finalists', v_round->'finalists',
      'finalist_names', v_finalist_names,
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


-- Multiple winners starts every ballot from the stars it brought with it,
-- and charges the winners it chooses on top: the sequence carried on within
-- one poll. With nothing brought, every ballot starts at nothing, as before.
-- Weights are scaled by the strongest ballot's, as poll_ballot_weights does.
CREATE OR REPLACE FUNCTION "public"."poll_multiple_winners"("p_poll_id" "uuid", "p_excluded" "uuid"[])
    RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_ballots uuid[];
  v_given numeric[];
  v_weights numeric[];
  v_scale numeric;
  v_pool uuid[];
  v_round jsonb;
  v_finalists uuid[];
  v_winner uuid;
  v_placed uuid[];
  v_placed_json jsonb;
  v_finalist_names jsonb;
  v_spots jsonb := '[]'::jsonb;
  v_place int := 1;
begin
  -- A poll has at most a few hundred options; anything longer is not a list
  -- a reader built by pressing buttons.
  if coalesce(array_length(p_excluded, 1), 0) > 1000 then
    raise exception 'Too many options left out';
  end if;

  -- The stars each ballot has given the winners so far, in v_ballots' order:
  -- those it was cast with, on a sequential question, and nothing otherwise.
  select coalesce(array_agg(id order by id), '{}'::uuid[]),
         coalesce(array_agg(coalesce(given, 0) order by id), '{}'::numeric[]),
         5 + coalesce(min(given), 0)
  into v_ballots, v_given, v_scale
  from ballots where poll_id = p_poll_id;

  if coalesce(array_length(v_ballots, 1), 0) = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into v_pool
  from candidates
  where poll_id = p_poll_id
    and not (id = any(coalesce(p_excluded, '{}'::uuid[])));

  while coalesce(array_length(v_pool, 1), 0) > 0 and v_place <= poll_results_rows() loop
    select array_agg(v_scale / (5 + g) order by ord) into v_weights
    from unnest(v_given) with ordinality u(g, ord);

    v_round := weighted_star_round(p_poll_id, v_pool, v_ballots, v_weights);

    select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_finalists
    from jsonb_array_elements_text(v_round->'finalists') x;

    v_winner := (v_round->>'winner_id')::uuid;

    if v_winner is null then
      v_placed := v_finalists;
    else
      v_placed := array[v_winner];
    end if;

    exit when coalesce(array_length(v_placed, 1), 0) = 0;

    -- Each placed option at the weighted total it was elected on.
    select jsonb_agg(jsonb_build_object('id', r.cid, 'name', r.name, 'total_score', r.total)
                     order by r.total desc, r.name)
    into v_placed_json
    from _wround r where r.cid = any(v_placed);

    select coalesce(jsonb_agg(t.name order by f.ord), '[]'::jsonb)
    into v_finalist_names
    from unnest(v_finalists) with ordinality f(cid, ord)
    join candidates t on t.id = f.cid;

    v_spots := v_spots || jsonb_build_array(jsonb_build_object(
      'place', v_place,
      'options', v_placed_json,
      'finalists', v_round->'finalists',
      'finalist_names', v_finalist_names,
      'runoff', v_round->'runoff',
      'tiebreaks', v_round->'tiebreaks'));

    v_place := v_place + array_length(v_placed, 1);

    -- Every ballot is charged the stars it gave whatever was placed.
    select array_agg(u.g + coalesce((
             select sum(s.score) from scores s
             where s.ballot_id = v_ballots[u.ord::int] and s.candidate_id = any(v_placed)), 0)
           order by u.ord)
    into v_given
    from unnest(v_given) with ordinality u(g, ord);

    select coalesce(array_agg(x), '{}'::uuid[]) into v_pool
    from unnest(v_pool) x
    where not (x = any(v_placed));
  end loop;

  return v_spots;
end;
$$;


-- Every option's score, at the ballots' weights where they carry them.
CREATE OR REPLACE FUNCTION "public"."poll_scores"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_voted int;
  v_weighted boolean;
  v_strength numeric;
begin
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  v_weighted := poll_is_weighted(p_poll_id);
  select sum(weight) into v_strength from poll_ballot_weights(p_poll_id);

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'name', name,
      'total_score', total,
      'average_score', round(total::numeric / v_strength, 2)
    ) order by total desc, name), '[]'::jsonb)
    from (
      select c.id, c.name,
             case when v_weighted
                  then trim_scale(round(coalesce(sum(s.score * w.weight), 0), 6))
                  else coalesce(sum(s.score), 0) end as total
      from candidates c
      left join scores s on s.candidate_id = c.id
      left join poll_ballot_weights(p_poll_id) w on w.ballot_id = s.ballot_id
      where c.poll_id = p_poll_id
      group by c.id, c.name
    ) t
  );
end;
$$;


-- A published sheet carries each ballot's N (`given`) where it has one: the
-- browser draws the weight from it, and fills in the next poll of a sequence
-- from it. A sequential question publishes ballots only with names on them,
-- so a weight is never the one clue to an anonymous ballot's author.
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
      ) || case when p_named and b.given is not null
                then jsonb_build_object('given', trim_scale(b.given))
                else '{}'::jsonb end as ballot,
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


-- The earlier voters of a question who have not voted in it, for its
-- creator to carry into the next poll of the sequence: a voter who skips a
-- poll keeps their weight. Only on a question that names its voters, where
-- who has voted is already on screen.
CREATE OR REPLACE FUNCTION "public"."get_poll_carried_weights"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id;

  if not found or v_poll.created_by is distinct from auth.uid() then
    raise exception 'Poll not found';
  end if;

  if not v_poll.show_voters then
    raise exception 'This poll does not show who voted';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object('voter', voter, 'given', trim_scale(given))
                              order by lower(voter)), '[]'::jsonb)
    from carried_weights
    where poll_id = p_poll_id and not claimed
  );
end;
$$;

ALTER FUNCTION "public"."get_poll_carried_weights"("uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."get_poll_carried_weights"("uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_poll_carried_weights"("uuid") TO "authenticated";


-- The share link says whether the question is sequential, and on one that
-- names its voters, which earlier voters have yet to vote: the ballot offers
-- them as names to pick. Copied from the baseline with those two fields added.
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

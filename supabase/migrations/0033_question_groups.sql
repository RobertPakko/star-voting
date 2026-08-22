-- Polls that ask more than one question.
--
-- A multi-question poll is not a new kind of row. It is several ordinary
-- polls that know they belong together: `group_id` says which set a poll is
-- part of, `question_position` says where in that set it sits, and
-- `question_title` is what that one question asks. Everything else on each
-- row is exactly what it has always been -- its own options, its own
-- ballots, its own invitees, its own share token, its own tally.
--
-- **Nothing about the election changes.** `poll_tally`, `star_round` and
-- `poll_ranking` are handed a poll id and count the ballots against it;
-- a question is a poll, so they are untouched here, and so are their tests.
-- That is the whole reason for this shape. The alternative -- a question
-- table under `polls`, with `candidates` and `ballots` hanging off it --
-- would have moved two foreign keys and rewritten every one of those
-- functions to reach a poll through one more hop, for no difference in what
-- a voter sees.
--
-- **What the group is for.** Three things have to be true of the set rather
-- than of one question, and each is done by widening one existing rule to
-- the group instead of adding a parallel one:
--
--  1. **One invitation.** `invited_voters` is per poll, because that is what
--     the row-level security reads. So every question carries the same list,
--     and `send_invite_email` sends for the first question only -- otherwise
--     a five-question poll would send five emails to everyone in it. The
--     link in that one email lands on question 1, and the questions are
--     walked from there.
--  2. **One reveal.** `poll_results_revealed()` is already the single place
--     that decides whether a poll has shown its tally; every gate in the app
--     goes through it. It now asks that of the whole group, so question 1's
--     result cannot be read while question 5 is still taking votes. That is
--     the same promise a single-question poll already makes -- early votes
--     never steer late ones -- applied to the unit the voter thinks in.
--  3. **One lifecycle.** `close_poll` and `reset_poll` act on the group, so
--     a poll cannot end up half-closed. The creator closes the poll, not the
--     question they happen to be looking at.
--
-- **What is deliberately still per question.** Ballots, voter keys and voter
-- names. A voter gets one ballot per question and a fresh `voter_key` per
-- question, exactly as before: `voterKeyFor()` is scoped to a share token,
-- and keeping it that way is what stops one browser's ballots being joined
-- to each other across polls. The client remembers its own name and offers
-- it back on the next question; nothing on the server links the two. See
-- src/lib/voterKey.ts, which explains what that scoping buys.
--
-- **Collecting options is one stage for the whole poll.** Each question
-- gathers its own list, because suggestions land in `candidates` against a
-- poll id and that is what a question is. But `finalize_options` opens every
-- question at once, for the same reason closing does: a poll half-opened
-- would take votes on some questions while others were still gathering. The
-- floor of two options is therefore checked against every question before any
-- of them is opened, and the refusal names the question that is short.


-- ---------------------------------------------------------------------------
-- The columns
--
-- All three move together or not at all: a poll is grouped, or it is not.
-- `authenticated` still has no UPDATE grant on this table, so a question's
-- place in its group is frozen at creation like every other poll setting.
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."polls"
  ADD COLUMN IF NOT EXISTS "group_id" "uuid",
  ADD COLUMN IF NOT EXISTS "question_position" integer,
  ADD COLUMN IF NOT EXISTS "question_title" "text";

ALTER TABLE "public"."polls" DROP CONSTRAINT IF EXISTS "polls_question_ck";
ALTER TABLE "public"."polls" ADD CONSTRAINT "polls_question_ck" CHECK (
  ("group_id" IS NULL AND "question_position" IS NULL AND "question_title" IS NULL)
  OR ("group_id" IS NOT NULL AND "question_position" >= 1 AND "question_title" IS NOT NULL)
);

COMMENT ON COLUMN "public"."polls"."group_id" IS 'The multi-question poll this question belongs to, or null on a poll that asks one question. Every question in a group shares its title, description, mode and settings; what differs is question_title, the options and the ballots.';
COMMENT ON COLUMN "public"."polls"."question_position" IS 'Where this question sits in its group, from 1. The poll list shows position 1 and hides the rest, and the invite email is sent for it alone.';
COMMENT ON COLUMN "public"."polls"."question_title" IS 'What this one question asks. The poll''s own title is shared across the group, so that the set reads as one poll and this is the part that varies.';

-- Two questions cannot claim the same place in one group.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_polls_group_position"
  ON "public"."polls" USING "btree" ("group_id", "question_position")
  WHERE ("group_id" IS NOT NULL);

-- Every read of a group walks it by this.
CREATE INDEX IF NOT EXISTS "idx_polls_group_id"
  ON "public"."polls" USING "btree" ("group_id") WHERE ("group_id" IS NOT NULL);


-- ---------------------------------------------------------------------------
-- Walking a group
--
-- The one place that answers "which polls are this poll's questions". An
-- ungrouped poll is a group of one, so callers never branch on it.
-- ---------------------------------------------------------------------------

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


-- ---------------------------------------------------------------------------
-- Creating polls
--
-- `create_poll` used to hold the field rules and the inserts together. A
-- group needs the same rules applied once per question, so the two are split:
-- what is decided for the whole poll stays in the entry points, and what is
-- decided for one row moves into `insert_poll_row`. This is the same reason
-- `insert_option` exists -- one set of rules, reached from more than one
-- direction, written down once.
-- ---------------------------------------------------------------------------

-- The invite list, normalized and checked. Raises on an empty or malformed
-- list, so a caller that returns holds a list it can insert.
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


-- One poll row, with its options and its invitees.
--
-- Options arrive as jsonb rather than as two parallel arrays, so a blank row
-- and its description are dropped together and can never come apart. The
-- caller has already checked that there is a signed-in creator, that the
-- mode is one this app has, that the title is not blank, and that the emails
-- are good; what is left is the part that is true of one row.
CREATE OR REPLACE FUNCTION "public"."insert_poll_row"(
  "p_title" "text",
  "p_description" "text",
  "p_question_title" "text",
  "p_options" "jsonb",
  "p_emails" "text"[],
  "p_mode" "text",
  "p_show_voters" boolean,
  "p_show_ballots" boolean,
  "p_solicit_options" boolean,
  "p_group_id" "uuid" DEFAULT NULL::"uuid",
  "p_question_position" integer DEFAULT NULL::integer
) RETURNS "uuid"
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


-- The single-question path, unchanged from the outside: same name, same
-- arguments, same errors, same one transaction. What it no longer holds is
-- the inserts.
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


-- A poll that asks several questions, created whole.
--
-- One transaction, like `create_poll`: every question, every option list and
-- every invite lands together or not at all. Creating them one at a time
-- from the browser would mean a failure on question four leaving a real,
-- half-built poll behind -- with the invitations for it already sent.
--
-- p_questions is [{ "title": text, "options": [{ "name": text,
-- "description": text|null }] }], in the order they are to be asked.
-- Returns the first question's poll id, which is where every link into the
-- poll points.
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


-- ---------------------------------------------------------------------------
-- One invitation per poll, not one per question
--
-- The email itself is untouched. What changes is when it fires: the trigger
-- now asks first, and a question after the first never reaches it. Written
-- as a WHEN clause rather than as an early return inside `send_invite_email`
-- so that the rule about *who gets told* stays visible next to the trigger,
-- and the function stays about the letter.
-- ---------------------------------------------------------------------------

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

CREATE OR REPLACE TRIGGER "trg_send_invite_email"
  AFTER INSERT ON "public"."invited_voters"
  FOR EACH ROW
  WHEN ("public"."poll_is_first_question"("new"."poll_id"))
  EXECUTE FUNCTION "public"."send_invite_email"();


-- ---------------------------------------------------------------------------
-- One reveal for the whole poll
--
-- `poll_results_revealed()` is the single rule every gate in the app reads:
-- `poll_status`, `open_poll_view`, `assert_results_readable`, and both
-- revision paths. Widening it here is what makes a group unlock together,
-- everywhere, without a second rule to keep in step with the first.
--
-- The two halves are widened differently, and the difference matters:
--
--  * **The gate is asked of the group.** Every question must be closed, or
--    (on an invite poll) have taken every invited ballot. Otherwise reading
--    question 1's result would tell a voter something before they answered
--    question 5, which is exactly what a single-question poll refuses to do.
--  * **"Has anyone answered" is asked of the question.** A poll closed with
--    nobody having answered question 5 still has a result for question 1,
--    and question 5 says it took no votes. Asking this of the group would
--    seal the whole poll because of one question nobody got to.
-- ---------------------------------------------------------------------------

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

CREATE OR REPLACE FUNCTION "public"."poll_results_revealed"("p_poll" "public"."polls") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select (select count(*) from ballots where poll_id = p_poll.id) > 0
     and (select bool_and(poll_gate_open(q.*)) from poll_group_members(p_poll) q);
$$;

ALTER FUNCTION "public"."poll_results_revealed"("p_poll" "public"."polls") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."poll_results_revealed"("p_poll" "public"."polls") IS 'Whether this poll has shown anybody its tally: it has taken at least one ballot, and every question in its poll has stopped taking votes. The window for changing a vote and for changing the invitee list both close here.';


-- The share-link results path asks the same question in its own words, so it
-- is widened the same way. The order of the two refusals is unchanged: a
-- poll still taking votes says so, and only a finished one can be empty.
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


-- ---------------------------------------------------------------------------
-- Reading a group
--
-- What the question strip on a poll page renders: which questions there are,
-- what each asks, and where this one sits among them. Two functions for the
-- two ways into a poll, as everywhere else in this schema.
--
-- Both return `[]` for a poll that asks one question, so a caller renders
-- nothing rather than branching.
-- ---------------------------------------------------------------------------

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


-- ---------------------------------------------------------------------------
-- The poll list
--
-- A multi-question poll is one row on this list, not five. The first
-- question stands for the poll: it is what the invite email links to, what
-- the share link opens, and where the question strip starts.
--
-- Three columns are new -- the group, the first question's own title, and
-- how many questions there are -- and three that were per poll are now asked
-- of the whole group: whether it is closed, whether it is complete, and
-- whether this reader has answered it. All of them mean "every question",
-- because that is the poll the reader thinks they are looking at.
--
-- `results_available` now goes through `poll_results_revealed()` rather than
-- restating the rule. That function did not exist when this list was
-- written; a second copy of the reveal rule has been sitting here since, and
-- widening it to groups is exactly the kind of change that would have left
-- the two disagreeing.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS "public"."list_polls"();

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


-- ---------------------------------------------------------------------------
-- Opening, closing and clearing a poll
--
-- All three act on the group. The creator closes *the poll*, not the question
-- they happen to have open, and a poll that could be closed one question at
-- a time would be one whose voters were told to stop halfway. It is also
-- what keeps the reveal above reachable: a group unlocks when every question
-- has stopped, so closing has to be able to stop every question.
--
-- All three still take one poll id and are still refused to anyone but the
-- creator, who owns every question in the group by construction.
-- ---------------------------------------------------------------------------

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


-- ---------------------------------------------------------------------------
-- Grants
--
-- The three internal helpers are reachable from nothing outside this schema:
-- they decide nothing about who may see what, and their callers have already
-- established that.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION "public"."poll_group_members"("p_poll" "public"."polls") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."poll_gate_open"("p_poll" "public"."polls") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."poll_is_first_question"("p_poll_id" "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."normalize_invite_emails"("p_emails" "text"[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid", "p_question_position" integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) TO "authenticated";

REVOKE ALL ON FUNCTION "public"."poll_group"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_group"("p_poll_id" "uuid") TO "authenticated";

-- Reached by people who never sign in, like every other open_poll_* function.
REVOKE ALL ON FUNCTION "public"."open_poll_group"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_group"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_group"("p_token" "text") TO "authenticated";

GRANT ALL ON FUNCTION "public"."list_polls"() TO "authenticated";


-- ---------------------------------------------------------------------------
-- The public view of one question
--
-- Re-declared whole for three fields: which group this question belongs to,
-- where it sits, and what it asks. A share link opens one question, and
-- without these the page behind it could not say which of the poll it was
-- showing.
--
-- `results_available` is unchanged in this text and changed in effect: it
-- goes through poll_results_revealed(), which now asks the whole group.
-- ---------------------------------------------------------------------------

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

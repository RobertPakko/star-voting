-- A reminder to vote.
--
-- An invite poll's creator can nudge the people it is still waiting on, once:
-- every invitee who has not voted in every question is emailed and pushed,
-- under their own notification settings, unless they have removed the poll
-- from their list. The once is a row, for the reason results_notices is one:
-- its primary key is the whole rule, and a column on `polls` would widen every
-- `select *` and wake every watcher of the poll for bookkeeping. See "Reminding
-- the voters a poll is waiting on" in AGENTS.md.

-- ---------------------------------------------------------------------------
-- The once-only rule
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "public"."poll_reminders" (
    "poll_id" "uuid" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "poll_reminders_pkey" PRIMARY KEY ("poll_id"),
    CONSTRAINT "poll_reminders_poll_id_fkey" FOREIGN KEY ("poll_id")
      REFERENCES "public"."polls"("id") ON DELETE CASCADE
);

ALTER TABLE "public"."poll_reminders" OWNER TO "postgres";

COMMENT ON TABLE "public"."poll_reminders" IS 'One row per poll whose creator has sent its reminder to vote, keyed on the group''s first question. Never deleted while the poll stands -- reopening does not give the reminder back. Internal bookkeeping: no grants, read through poll_status.';

ALTER TABLE "public"."poll_reminders" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Who is reminded
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."poll_outstanding_invitees"("p_poll" "public"."polls") RETURNS SETOF "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  -- Every question of a group carries the whole invite list, so the list is
  -- read once; a ballot is per question, so an invitee is still owed a vote
  -- while any question has none of theirs. That is the reading a voter
  -- halfway through a poll would give "have you voted yet".
  select lower(iv.email)
  from invited_voters iv
  where iv.poll_id = p_poll.id
    and exists (
      select 1 from poll_group_members(p_poll) q
      where not exists (
        select 1 from ballots b
        join auth.users u on u.id = b.voter_id
        where b.poll_id = q.id and lower(u.email) = lower(iv.email)));
$$;

ALTER FUNCTION "public"."poll_outstanding_invitees"("p_poll" "public"."polls") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."poll_outstanding_invitees"("p_poll" "public"."polls") IS 'Every invitee who has not voted in every question of this poll''s group. Internal.';

REVOKE ALL ON FUNCTION "public"."poll_outstanding_invitees"("p_poll" "public"."polls") FROM PUBLIC;


CREATE OR REPLACE FUNCTION "public"."poll_reminder_audience"("p_poll" "public"."polls", "p_actor" "text") RETURNS SETOF "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  -- poll_email_audience is where "removed the poll" and "nobody is told what
  -- they just did" are written, so the reminder is that audience narrowed to
  -- the people still owed a vote rather than a third copy of either rule. The
  -- creator is left out: they are the one sending it.
  select a
  from poll_email_audience(p_poll, false, p_actor) a
  where a in (select * from poll_outstanding_invitees(p_poll));
$$;

ALTER FUNCTION "public"."poll_reminder_audience"("p_poll" "public"."polls", "p_actor" "text") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."poll_reminder_audience"("p_poll" "public"."polls", "p_actor" "text") IS 'Every address to remind to vote: the invitees still owed a vote in some question, minus the creator, the actor and every account that has removed the poll from its list. Internal.';

REVOKE ALL ON FUNCTION "public"."poll_reminder_audience"("p_poll" "public"."polls", "p_actor" "text") FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- What it says
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."send_reminder_email"("p_poll" "public"."polls", "p_email" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform send_poll_email(
    p_poll.id,
    p_email,
    'A reminder to vote in your poll',
    'Your vote is still needed',
    'Voting is still open for <strong>'
      || email_escape(coalesce(p_poll.title, 'a poll')) || '</strong>, and your ballot '
      || 'hasn''t been cast yet. Sign in with this email address to vote.');
end;
$$;

ALTER FUNCTION "public"."send_reminder_email"("p_poll" "public"."polls", "p_email" "text") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."send_reminder_email"("p_poll" "public"."polls", "p_email" "text") IS 'Posts one reminder-to-vote email to Resend. Best-effort: silent where pg_net, Vault or the API key is missing. Internal.';

REVOKE ALL ON FUNCTION "public"."send_reminder_email"("p_poll" "public"."polls", "p_email" "text") FROM PUBLIC;


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
      when 'reminder' then 'A reminder: your vote is still needed.'
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

COMMENT ON FUNCTION "public"."push_message"("p_poll" "public"."polls", "p_event" "text") IS 'The notification sent about one of a poll''s moments -- invite_options, invite_vote, opened, reminder, results. Internal.';

-- ---------------------------------------------------------------------------
-- Sending it
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."send_poll_reminder"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_first polls;
  v_email text;
  v_actor text := lower(auth.jwt() ->> 'email');
begin
  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Only the poll creator can send a reminder';
  end if;

  -- Filed against question 1, like every notice: a reminder is about the
  -- poll, whichever question the creator pressed it on.
  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  if v_first.mode <> 'invite' then
    raise exception 'Only a poll with an invite list can send a reminder';
  end if;

  if v_first.closed_at is not null then
    raise exception 'This poll is closed';
  end if;

  if v_first.solicit_options and v_first.options_finalized_at is null then
    raise exception 'This poll is still collecting its options';
  end if;

  if poll_results_revealed(v_first) then
    raise exception 'The results are already out';
  end if;

  -- Asked before removals are taken away, and deliberately: the creator must
  -- not be able to learn who has removed their poll from whether the button
  -- works. A reminder that reaches nobody because everybody left still spends
  -- the poll's one reminder.
  if not exists (
    select 1 from poll_outstanding_invitees(v_first) e
    where e is distinct from v_actor
  ) then
    raise exception 'Everyone invited has already voted';
  end if;

  -- The once-only rule, and all of it.
  insert into poll_reminders (poll_id) values (v_first.id)
  on conflict (poll_id) do nothing;

  if not found then
    raise exception 'A reminder has already been sent for this poll';
  end if;

  -- One request per address, so no invitee sees another's; see
  -- notify_poll_opened.
  for v_email in select * from poll_reminder_audience(v_first, v_actor) loop
    perform send_reminder_email(v_first, v_email);
  end loop;

  -- No watchers: an invite poll has none.
  perform push_poll(v_first, 'reminder',
    array(select * from poll_reminder_audience(v_first, v_actor)), false);
end;
$$;

ALTER FUNCTION "public"."send_poll_reminder"("p_poll_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."send_poll_reminder"("p_poll_id" "uuid") IS 'The creator''s one reminder: emails and pushes every invitee still owed a vote in an invite poll that is taking votes, except those who removed the poll. Once per poll, ever.';

REVOKE ALL ON FUNCTION "public"."send_poll_reminder"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."send_poll_reminder"("p_poll_id" "uuid") TO "authenticated";

-- ---------------------------------------------------------------------------
-- The page knowing it has been sent
-- ---------------------------------------------------------------------------

-- A new column on a RETURNS TABLE is a new return type, which CREATE OR
-- REPLACE refuses; dropped and recreated, with its grant restated. The body is
-- the baseline's with one field added at the end.
DROP FUNCTION IF EXISTS "public"."poll_status"("p_poll_id" "uuid");

CREATE FUNCTION "public"."poll_status"("p_poll_id" "uuid") RETURNS TABLE("invited_count" integer, "voted_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean, "expires_at" timestamp with time zone, "invited" boolean, "confirmed" boolean, "confirmed_count" integer, "winner_name" "text", "winner_settled" boolean, "reminded_at" timestamp with time zone)
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
    v_poll.winner_settled_at is not null,
    -- When the creator sent the poll's one reminder, on any question of it.
    -- Readable by its invitees too, which tells them nothing they were not
    -- emailed.
    (select r.sent_at from poll_reminders r where r.poll_id = poll_list_row(p_poll_id));
end;
$$;

ALTER FUNCTION "public"."poll_status"("p_poll_id" "uuid") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_status"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_status"("p_poll_id" "uuid") TO "authenticated";

-- Polls made without an account.
--
-- Supabase's anonymous sign-in mints a real auth.users row and a real JWT, so
-- an anonymous reader is `authenticated` with an `auth.uid()` like anybody
-- else: every rule written as `created_by = auth.uid()` -- the creator's
-- controls, the poll list, removing a poll -- works for them unchanged. What
-- they do not have is an email address, and that is the whole of what this
-- migration is about: the places where an address was assumed, and the one
-- place where lending an address-less account the power to write to
-- addresses would be a hole. See "Polls made without an account" in AGENTS.md.

-- ---------------------------------------------------------------------------
-- Telling an anonymous session apart
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."is_anonymous_session"() RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  -- The claim Supabase puts on every token; absent (and so false) on a token
  -- minted before anonymous sign-ins existed, and on no token at all.
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
$$;

ALTER FUNCTION "public"."is_anonymous_session"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."is_anonymous_session"() IS 'Whether the caller signed in without an account (Supabase anonymous sign-in): signed in, with an auth.uid(), and no email address. Internal.';

REVOKE ALL ON FUNCTION "public"."is_anonymous_session"() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- A creator with no address
-- ---------------------------------------------------------------------------

-- An anonymous token carries `"email": ""`, so the default stored an empty
-- string -- an address poll_email_audience would then try to write to -- and
-- a token with no email claim at all would have failed the insert. Null is
-- the honest value, and every reader of the column already handles it:
-- list_polls hands back null for a poll that is on a list only because it was
-- answered, and the audience skips a null creator.
ALTER TABLE "public"."polls" ALTER COLUMN "created_by_email" DROP NOT NULL;
ALTER TABLE "public"."polls" ALTER COLUMN "created_by_email"
  SET DEFAULT nullif(lower(auth.jwt() ->> 'email'), '');

CREATE OR REPLACE FUNCTION "public"."set_poll_creator_email"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  new.created_by_email := nullif(lower(auth.jwt() ->> 'email'), '');
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- What an anonymous account may make
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."guard_anonymous_polls"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_made int;
begin
  if not is_anonymous_session() then
    return new;
  end if;

  -- An invite poll emails every address on its list, from this app's
  -- domain, through its Resend key. Anybody can mint an anonymous account
  -- with no inbox behind it, so letting one make an invite poll would make
  -- this app a way to send mail to any address on earth. An open poll writes
  -- to nobody it was not given an account by, and guard_invitee_changes
  -- already refuses an invite list on one, so this is the one door.
  if new.mode <> 'open' then
    raise exception 'Sign in to invite people by email. A poll made without an account is open to anyone with its link.';
  end if;

  -- A ceiling on how fast one anonymous account can fill the database. Not a
  -- defence on its own -- a fresh account is one request away, and Supabase's
  -- per-address limit on anonymous sign-ins (and its CAPTCHA, if enabled) is
  -- what bounds those -- but it stops one session from looping create_poll.
  -- A poll of several questions is one poll: counted by group, and its own
  -- earlier questions, inserted in this same statement's transaction, are
  -- not counted against it.
  select count(distinct coalesce(group_id, id)) into v_made
  from polls
  where created_by = new.created_by
    and created_at > now() - interval '1 day'
    and (new.group_id is null or group_id is distinct from new.group_id);

  if v_made >= 20 then
    raise exception 'That is as many polls as can be made without an account in a day. Sign in to make more.';
  end if;

  return new;
end;
$$;

ALTER FUNCTION "public"."guard_anonymous_polls"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."guard_anonymous_polls"() IS 'Refuses an invite poll from an account made without signing in, which would otherwise be a way to email any address, and caps how many polls one such account makes in a day. Internal: a trigger on polls, so every way of making a poll passes it.';

REVOKE ALL ON FUNCTION "public"."guard_anonymous_polls"() FROM PUBLIC;

CREATE OR REPLACE TRIGGER "guard_anonymous_polls" BEFORE INSERT ON "public"."polls"
  FOR EACH ROW EXECUTE FUNCTION "public"."guard_anonymous_polls"();

-- ---------------------------------------------------------------------------
-- An invitee is an address
-- ---------------------------------------------------------------------------

-- Every invite test in the schema compares a stored address with the token's
-- `email` claim, and an anonymous token's claim is the empty string. Nothing
-- puts an empty address on a list today -- normalize_invite_emails checks
-- every address the create paths take -- but the creator can also insert
-- into invited_voters directly, through its grant and policy, and that path
-- only lowercases and trims. A blank row there would have invited every
-- anonymous account at once. The address rule is now the table's, so it holds
-- whichever way a row arrives. NOT VALID: it binds every row written from
-- here on and passes judgement on none already there -- except the one kind
-- of row that matters here, a blank one, which is nobody's invitation and is
-- removed. No ballot can be keyed to it, since no account has that address.
DELETE FROM "public"."invited_voters" WHERE trim("email") = '';

ALTER TABLE "public"."invited_voters"
  ADD CONSTRAINT "invited_voters_email_ck"
  CHECK ("email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') NOT VALID;

-- ---------------------------------------------------------------------------
-- A late vote is a vote, not any write to a ballot
-- ---------------------------------------------------------------------------

-- The trigger fires on every update of a ballot, and until now the only
-- update was a revision stamping revised_at. Carrying a ballot over to the
-- account its voter signed in to (below) is an update too, and is not a vote,
-- so it must not mark the poll as having taken one after its reveal.
CREATE OR REPLACE FUNCTION "public"."mark_votes_after_reveal"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- Every way a vote is cast or changed passes through this table -- the two
  -- submit paths insert a ballot, the two revise paths stamp revised_at on one
  -- -- so the flag is raised here rather than in four functions that would
  -- each have to remember to. Any other update is bookkeeping.
  if tg_op = 'UPDATE' and new.revised_at is not distinct from old.revised_at then
    return null;
  end if;

  update polls set votes_after_reveal = true
  where id = new.poll_id and reopened_after_reveal and not votes_after_reveal;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Signing in keeps what was made without an account
-- ---------------------------------------------------------------------------

-- Signing in replaces the anonymous session with the account's, and nothing
-- the anonymous account made follows on its own: the account may well exist
-- already, and even a new one is a different auth.users row. So the browser
-- asks for a ticket before it sends the sign-in email, while it can still
-- prove it is the anonymous account, and hands the ticket back once the
-- account's session arrives. The ticket is the proof: random, held only by
-- the browser that asked for it, used once, and good for a day.
CREATE TABLE IF NOT EXISTS "public"."account_carry_overs" (
    "token" "text" NOT NULL,
    "anon_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "account_carry_overs_pkey" PRIMARY KEY ("token")
);

ALTER TABLE "public"."account_carry_overs" OWNER TO "postgres";

COMMENT ON TABLE "public"."account_carry_overs" IS 'Tickets an anonymous account takes out before signing in, so that what it made can be moved to the account it signs in to. Read and written only by begin_account_carry_over and finish_account_carry_over: no grants and no policies, like results_notices.';

ALTER TABLE "public"."account_carry_overs" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."account_carry_overs" FROM "anon", "authenticated";

CREATE OR REPLACE FUNCTION "public"."begin_account_carry_over"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_token text;
begin
  if auth.uid() is null or not is_anonymous_session() then
    raise exception 'Only an account made without signing in has anything to carry over';
  end if;

  -- One live ticket per anonymous account, and nobody's expired ones.
  delete from account_carry_overs
  where anon_id = auth.uid() or created_at < now() - interval '1 day';

  -- Two uuids' worth of randomness: the same generator as every id here.
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into account_carry_overs (token, anon_id) values (v_token, auth.uid());
  return v_token;
end;
$$;

ALTER FUNCTION "public"."begin_account_carry_over"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."begin_account_carry_over"() IS 'Takes out a one-day ticket for the calling anonymous account, to be redeemed by finish_account_carry_over once the browser has signed in to a real account.';

REVOKE ALL ON FUNCTION "public"."begin_account_carry_over"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."begin_account_carry_over"() TO "authenticated";

CREATE OR REPLACE FUNCTION "public"."finish_account_carry_over"("p_token" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_me uuid := auth.uid();
  v_from uuid;
  v_moved int;
begin
  if v_me is null or is_anonymous_session() then
    raise exception 'Sign in to an account to carry polls over to it';
  end if;

  -- Used once whatever happens next, and refused once it is a day old.
  delete from account_carry_overs
  where token = p_token and created_at > now() - interval '1 day'
  returning anon_id into v_from;

  -- Only ever from an account that is still anonymous. begin_ already
  -- refuses anybody else a ticket; this is the same rule read at the other
  -- end, so a ticket cannot outlive the account it was taken out for being
  -- linked to an address of its own.
  if v_from is null
     or v_from = v_me
     or not exists (select 1 from auth.users where id = v_from and is_anonymous) then
    return 0;
  end if;

  -- The polls it made, which is what this is for. created_by_email goes with
  -- them, because the column exists to say who made the poll.
  update polls
  set created_by = v_me, created_by_email = nullif(lower(auth.jwt() ->> 'email'), '')
  where created_by = v_from;
  get diagnostics v_moved = row_count;

  -- What it answered through links, so those polls stay on the list too. A
  -- poll the account had already answered keeps the account's own ballot,
  -- and the anonymous one stays where it is: one account, one ballot.
  update ballots b set account_id = v_me
  where b.account_id = v_from
    and not exists (select 1 from ballots o where o.poll_id = b.poll_id and o.account_id = v_me);

  update option_confirmations c set account_id = v_me
  where c.account_id = v_from
    and not exists (
      select 1 from option_confirmations o where o.poll_id = c.poll_id and o.account_id = v_me);

  insert into removed_polls (user_id, poll_id)
  select v_me, poll_id from removed_polls where user_id = v_from
  on conflict do nothing;
  delete from removed_polls where user_id = v_from;

  -- The poll updates above have told every list these polls are on, the
  -- account's own included; the removals moved silently, and the list is
  -- what shows them.
  perform announce('user:' || v_me::text, 'polls_changed');

  return v_moved;
end;
$$;

ALTER FUNCTION "public"."finish_account_carry_over"("p_token" "text") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."finish_account_carry_over"("p_token" "text") IS 'Moves the polls, link ballots, confirmations and removals of the anonymous account a ticket was taken out by to the calling account, and spends the ticket. Returns how many polls moved.';

REVOKE ALL ON FUNCTION "public"."finish_account_carry_over"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finish_account_carry_over"("p_token" "text") TO "authenticated";

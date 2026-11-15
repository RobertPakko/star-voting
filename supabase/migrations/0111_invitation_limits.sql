-- Every address added to an invite list is sent an email from this app's
-- domain, through its one Resend key, carrying a title the sender wrote. Two
-- things were unbounded: how many addresses one poll may invite, and how many
-- invitations one account may send -- and taking an address off a list and
-- putting it back sent the invitation again, as often as asked. An account
-- costs one inbox, so that was a way to write to any address on earth, or to
-- one address a thousand times, and to use up the key every poll email and
-- the contact form share.
--
-- Both are now bounded where every invitation passes, whatever made it:
-- guard_invitee_changes, the BEFORE trigger on invited_voters.
--
--   * A poll invites at most 500 people (MAX_INVITEES in limits.ts).
--   * An account sends at most 1000 invitations a day. Counted as they are
--     made rather than from the rows left, since a removed invitee leaves no
--     row; and counted once for a poll of several questions, whose list is
--     copied onto every question but emailed once.

CREATE TABLE IF NOT EXISTS "public"."invitations_sent" (
    "account_id" "uuid" NOT NULL,
    "day" "date" NOT NULL,
    "sent" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "invitations_sent_pkey" PRIMARY KEY ("account_id", "day")
);

ALTER TABLE "public"."invitations_sent" OWNER TO "postgres";

COMMENT ON TABLE "public"."invitations_sent" IS 'How many invitations each account has sent on each day, for the daily ceiling in guard_invitee_changes. A count rather than the rows of invited_voters, because an invitee removed and added again is invited twice and leaves one row. An account''s earlier days are dropped as it is written. RLS on, no policies, no grants.';

ALTER TABLE "public"."invitations_sent" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."invitations_sent" FROM "anon", "authenticated";


CREATE OR REPLACE FUNCTION "public"."guard_invitee_changes"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll_id uuid;
  v_invited int;
  v_voted int;
  v_sent int;
begin
  perform lock_poll(case when tg_op = 'DELETE' then old.poll_id else new.poll_id end);

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

    if v_invited >= 500 then
      raise exception 'A poll can invite 500 people';
    end if;

    -- The day's count, for whoever is inviting. Each question of a group
    -- carries the whole list and only the first is emailed, so only the
    -- first counts. Nobody signed in is the database's own work.
    if auth.uid() is not null and poll_is_first_question(v_poll_id) then
      delete from invitations_sent
      where account_id = auth.uid() and day < current_date;

      insert into invitations_sent (account_id, day, sent)
      values (auth.uid(), current_date, 1)
      on conflict (account_id, day) do update set sent = invitations_sent.sent + 1
      returning sent into v_sent;

      if v_sent > 1000 then
        raise exception 'That is as many invitations as one account can send in a day';
      end if;
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

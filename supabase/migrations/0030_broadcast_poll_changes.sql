-- Live updates, pushed instead of polled.
--
-- Poll pages used to re-read themselves every few seconds. They now hold a
-- websocket and re-read when the database tells them something moved. What
-- follows is the telling half; src/lib/useLiveStream.ts is the listening one.
--
-- **A signal, not the data.** Every message below is empty. It says "this
-- poll changed" and nothing else; whoever hears it re-reads the poll through
-- the same RPC they would have called anyway. That is the whole reason this
-- can exist without unpicking the access rules: `anon` still has no read
-- grant on any table, an open poll's voters still reach their poll only
-- through the `open_poll_*` functions, and every rule about who may see what
-- stays where it already was. Subscribing to row changes directly would have
-- meant re-deriving all of it as RLS policy; broadcasting a knock on the door
-- means re-deriving none of it.
--
-- **The topics are public and carry nothing.** A listener needs no
-- authorization because there is nothing to authorize: the payload is `{}`,
-- and the most anyone learns by guessing a topic is that a poll whose id or
-- share token they already knew has changed at some moment. The share token
-- is what it always was -- the thing you must hold to read an open poll --
-- and it is still the RPC, not the socket, that decides what you get back.
--
-- **Every message is sent per statement, not per row.** This is about the
-- bulk writes: `reset_poll` clears a poll's ballots in one `delete`, and a
-- poll being removed cascades to all of its rows in one more. Row triggers
-- would turn each of those into one message per row, multiplied by everyone
-- connected; the transition tables below collapse each statement to one
-- message per poll. It buys nothing on `create_poll`, which inserts its
-- options and invitees one statement at a time in a loop -- but those land
-- on a poll nobody has had the chance to subscribe to yet.
--
-- Messages are written to `realtime.messages` and delivered from the
-- replication slot, so they arrive only once their transaction has
-- committed. A page that re-reads on a signal can never catch a half-written
-- ballot: `submit_ballot` inserts the ballot and then its scores, and the
-- signal lands after both.


-- One poll changed. Called by every trigger below.
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


-- Rows arrived or changed: ballots cast, options added or corrected, invites
-- sent. Reads `new_rows`, so every trigger using it must declare that name.
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


-- Rows went away: a poll reset clearing its ballots, an option or an invitee
-- taken back off. Reads `old_rows`.
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


-- The poll row itself: closed, reopened, or its option list finalized. Every
-- one of those is a single-row update by the creator, so this is a row
-- trigger and needs no transition table.
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


-- An invite is the one change that has to reach somebody who is not watching
-- the poll: they have never seen it. A poll list subscribes to the polls in
-- front of its reader, and a poll they were invited to a moment ago is not
-- one of them, so the invite is announced on a topic belonging to the person
-- receiving it instead.
--
-- Someone invited before they have an account has no topic to announce to.
-- They see the poll on the first list they load after signing in, which is
-- the same moment they could first have seen it anyway.
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


-- ---------------------------------------------------------------------------
-- The triggers
--
-- Deletes matter as much as inserts, and are easy to forget: `reset_poll`
-- clears a poll's ballots, and a creator correcting the option list takes
-- rows back off. A page that heard about arrivals only would sit there
-- showing a tally that no longer exists.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS "ballots_broadcast_insert" ON "public"."ballots";
CREATE TRIGGER "ballots_broadcast_insert"
  AFTER INSERT ON "public"."ballots"
  REFERENCING NEW TABLE AS "new_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_touched"();

DROP TRIGGER IF EXISTS "ballots_broadcast_delete" ON "public"."ballots";
CREATE TRIGGER "ballots_broadcast_delete"
  AFTER DELETE ON "public"."ballots"
  REFERENCING OLD TABLE AS "old_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_emptied"();

DROP TRIGGER IF EXISTS "candidates_broadcast_insert" ON "public"."candidates";
CREATE TRIGGER "candidates_broadcast_insert"
  AFTER INSERT ON "public"."candidates"
  REFERENCING NEW TABLE AS "new_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_touched"();

DROP TRIGGER IF EXISTS "candidates_broadcast_update" ON "public"."candidates";
CREATE TRIGGER "candidates_broadcast_update"
  AFTER UPDATE ON "public"."candidates"
  REFERENCING NEW TABLE AS "new_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_touched"();

DROP TRIGGER IF EXISTS "candidates_broadcast_delete" ON "public"."candidates";
CREATE TRIGGER "candidates_broadcast_delete"
  AFTER DELETE ON "public"."candidates"
  REFERENCING OLD TABLE AS "old_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_emptied"();

DROP TRIGGER IF EXISTS "invited_voters_broadcast_insert" ON "public"."invited_voters";
CREATE TRIGGER "invited_voters_broadcast_insert"
  AFTER INSERT ON "public"."invited_voters"
  REFERENCING NEW TABLE AS "new_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_invites_sent"();

DROP TRIGGER IF EXISTS "invited_voters_broadcast_delete" ON "public"."invited_voters";
CREATE TRIGGER "invited_voters_broadcast_delete"
  AFTER DELETE ON "public"."invited_voters"
  REFERENCING OLD TABLE AS "old_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_emptied"();

-- No trigger for INSERT on polls: a poll nobody has been told about yet has
-- nobody subscribed to it. Its invite rows carry the news instead, on the
-- topics of the people receiving them.
DROP TRIGGER IF EXISTS "polls_broadcast_update" ON "public"."polls";
CREATE TRIGGER "polls_broadcast_update"
  AFTER UPDATE ON "public"."polls"
  FOR EACH ROW EXECUTE FUNCTION "public"."broadcast_poll_updated"();

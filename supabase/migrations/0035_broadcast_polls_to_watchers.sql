-- Announce a poll's changes to the lists it appears on, not just to the poll.
--
-- The poll list used to subscribe to one topic per poll on the page in front
-- of its reader, and that set could not be known until the list had been
-- read. So the page read once to learn which polls it had, subscribed to
-- them, and -- because the first read happens on subscribe -- read a second
-- time. Two requests to draw one list, every time it was opened, and a third
-- every time a page was turned.
--
-- The circularity was never in the socket; it was in the topics. A list
-- watching *the polls it holds* has to hold them first. A list watching *its
-- own reader* does not: `user:<id>` is known from the session before anything
-- is read, so the page subscribes on mount and its first read is its only
-- read.
--
-- `user:<id>` already existed for invites, which are exactly the case the
-- per-poll topics could not cover: a poll you were invited to a moment ago is
-- not one of the polls in front of you. This widens that topic from "a poll
-- was added to your list" to "something on your list moved", which is the
-- question the list was really asking all along.
--
-- Three things that were wrong quietly stop being wrong:
--
--   * A poll on page two went stale while you sat on page one, because the
--     list only ever subscribed to the ten polls it was showing.
--   * A vote in the second question of a multi-question poll announced itself
--     on that question's topic. The list carries one row per group -- the
--     first question -- and subscribed to that row's id, so the row's
--     "everyone has answered" state moved without anybody being told.
--   * Turning a page cost a full re-subscribe and another read. It now costs
--     nothing: the topic does not depend on which polls are on screen.
--
-- The cost is stated plainly: a poll with forty invitees now writes forty-one
-- messages per change rather than one. The fan-out to *sockets* is unchanged
-- -- those forty were each already subscribed to the poll's own topic and
-- each already woke up -- so what this buys with rows in realtime.messages is
-- one round trip per reader, and correctness on the three counts above.

-- Everyone whose poll list shows this poll: its creator, and everyone invited
-- to it who has an account. The terms are list_polls()' own -- created_by, or
-- an invited_voters row matching your address -- because the whole point is
-- to wake exactly the lists that would come back different.
--
-- Invitees are matched by address the way every other lookup in this schema
-- does it, so somebody invited before they ever signed in has no row here and
-- is told nothing; there is no list of theirs to refresh yet, and signing in
-- reads one for the first time. That was already true of invites.
CREATE OR REPLACE FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_token text;
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
  select public_token, created_by into v_token, v_creator
  from polls where id = p_poll_id;
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

  -- And the same trick for the poll list, which holds no poll id at all until
  -- it has read one. `union` rather than `union all`: a creator who invited
  -- themselves is one reader with one list.
  for v_user in
    select u.id from auth.users u where u.id = v_creator
    union
    select u.id
    from invited_voters iv
    join auth.users u on lower(u.email) = lower(iv.email)
    where iv.poll_id = p_poll_id
  loop
    perform realtime.send('{}'::jsonb, 'polls_changed', 'user:' || v_user::text, false);
  end loop;
end;
$$;


ALTER FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") IS 'Tells anyone watching this poll that it moved, without saying how: the poll''s own topic, its share token, and the list of everyone who can see it. Internal: called from the broadcast triggers, never by a client.';


-- An invite is no longer a special case.
--
-- It used to be the one change that had to reach a person rather than a poll,
-- so it had a trigger function of its own that announced the poll and then
-- announced it again to whoever had just been invited. Now that every change
-- reaches every watcher's list, and the newly invited are watchers by the
-- time this runs, that second announcement is the same message sent twice --
-- and what is left is exactly broadcast_polls_touched(). So the trigger uses
-- that instead, and the special case goes away rather than being maintained.
CREATE OR REPLACE TRIGGER "invited_voters_broadcast_insert"
  AFTER INSERT ON "public"."invited_voters"
  REFERENCING NEW TABLE AS "new_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."broadcast_polls_touched"();


DROP FUNCTION IF EXISTS "public"."broadcast_invites_sent"();

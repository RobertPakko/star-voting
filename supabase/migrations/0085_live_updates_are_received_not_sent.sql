-- Live updates are received, never sent, by anybody but the database.
--
-- Every topic was a public Realtime channel, and on a public channel any
-- client holding the anon key may broadcast as well as listen. The messages
-- carry nothing, which is why the topics could be public -- but one of them
-- is the news rather than a knock on the door: `poll_deleted` puts every page
-- watching that poll onto "this poll has been deleted" without a read. So
-- anybody holding a poll's link, which on an open poll is every voter, could
-- tell everyone else's copy of it that it had gone; and anybody at all could
-- wake a poll's watchers into re-reading as often as they liked.
--
-- Three changes close it, and a fourth closes a door beside it:
--
--  * `announce()` sends on **private** channels (the last argument of
--    `realtime.send`). A private channel and a public one of the same name
--    are different channels, so a message a client sends on the public
--    `poll:<id>` reaches nobody now listening.
--  * Clients subscribe with `private: true` (useLiveStream.ts), which Realtime
--    authorizes against row-level security on `realtime.messages`.
--  * The one policy here lets `anon` and `authenticated` **receive**
--    broadcasts: on any `poll:` topic, since a poll's id is already the whole
--    of the capability to read it, and on `user:<id>` only for that user. There
--    is no INSERT policy, so no client may send on a private channel at all.
--    The database sends through `realtime.send`, as the function's owner,
--    and needs none.
--  * `broadcast_poll_change(uuid)` was callable by anybody through the API: an
--    internal SECURITY DEFINER function with no `REVOKE ... FROM PUBLIC`, the
--    one such that is not a trigger function. Calling it is the database
--    sending, so no channel permission could ever have stopped it. It is
--    called only from triggers, which run as its owner.
--
-- A policy on `realtime.messages` is outside the public schema, which a squash
-- does not dump, so the same statements are in supabase/after-squash.sql.
--
-- Optionally, with this in place, **Realtime → Settings → Allow public
-- access** can be turned off in the dashboard: nothing in the app uses a
-- public channel any more.

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
  -- Private: received under the policy on realtime.messages, and sendable by
  -- nobody but the database. See 0085.
  perform realtime.send('{}'::jsonb, p_event, p_topic, true);
end;
$$;

REVOKE ALL ON FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") FROM "authenticated";
GRANT ALL ON FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") TO "service_role";

DROP POLICY IF EXISTS "live updates are received, never sent" ON "realtime"."messages";
CREATE POLICY "live updates are received, never sent" ON "realtime"."messages"
  FOR SELECT TO "anon", "authenticated"
  USING (
    "realtime"."messages"."extension" = 'broadcast'
    AND (
      "realtime"."topic"() LIKE 'poll:%'
      OR "realtime"."topic"() = 'user:' || (SELECT "auth"."uid"())::text
    )
  );

-- The contact form's ceiling on everybody together, from a hundred an hour to
-- ten. Each message is an email through the same Resend key every poll email
-- uses, and a caller with no session is bounded by nothing else -- so a
-- hundred an hour was enough for one script to spend a free tier's day of
-- sending in an hour, and every invitation and result after it would have gone
-- nowhere, silently. Ten is still far more than real people send.
CREATE OR REPLACE FUNCTION "public"."send_contact_message"("p_email" "text", "p_message" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := btrim(coalesce(p_email, ''));
  v_message text := btrim(coalesce(p_message, ''));
  v_user uuid := auth.uid();
begin
  if v_email = '' then
    raise exception 'Enter an email address so a reply can reach you';
  end if;
  if length(v_email) > 254 then
    raise exception 'That email address is too long';
  end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'That does not look like an email address';
  end if;
  if v_message = '' then
    raise exception 'Write a message to send';
  end if;
  if length(v_message) > 5000 then
    raise exception 'Messages can be at most 5000 characters';
  end if;

  if v_user is not null and (
    select count(*) from contact_messages
    where user_id = v_user and created_at > now() - interval '1 day'
  ) >= 5 then
    raise exception 'You have sent several messages today already. Please try again tomorrow';
  end if;

  if (
    select count(*) from contact_messages where created_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'A lot of messages have arrived in the last hour. Please try again later';
  end if;

  insert into contact_messages (email, message, user_id)
  values (v_email, v_message, v_user);

  perform send_contact_email(v_email, v_message);
end;
$$;

-- A deleted poll tells its own topic that it has gone.
--
-- Until now a poll on its way out told the lists it was on and stayed silent
-- on `poll:<id>`, for a reason that was real: every message meant only
-- "re-read", a watcher answers one by re-reading, and a re-read of a poll that
-- has gone fails -- so the page would retry five times and then tell its
-- reader they were offline. Silence was the lesser wrong. It was still a
-- wrong: somebody with the poll open went on looking at a ballot for a poll
-- that no longer existed, and a vote cast on it failed with nothing to say
-- why.
--
-- The fix is to stop the message meaning "re-read". It goes under an event of
-- its own, `poll_deleted`, which useLiveStream hands to the page as the news
-- it is rather than as a prompt to ask again: the poll page says the poll has
-- been deleted, and the poll list -- which watches the open polls it carries
-- by their own topics -- re-reads and finds the card gone.
--
-- Two things change, and neither widens what anybody learns: the topic is one
-- every watcher of the poll was already subscribed to, the payload is still
-- `{}`, and the poll's deletion was already announced to every list it was on.
--
-- 1. broadcast_poll_gone() also tells `poll:<id>`. The nightly purge stays
--    silent on every topic, exactly as before.
-- 2. announce() remembers a topic *and event* as told, rather than a topic.
--    Every topic had exactly one event until now, so nothing that was sent
--    before is sent twice after. What it allows is a transaction that changes
--    a poll and then deletes it saying both, so the deletion is not swallowed
--    as a repeat of the change.

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
  perform realtime.send('{}'::jsonb, p_event, p_topic, false);
end;
$$;


COMMENT ON FUNCTION "public"."announce"("p_topic" "text", "p_event" "text") IS 'Tells one topic that something happened, at most once per topic and event per transaction. Every live-update message goes through here: the payload is empty and nothing reaches a listener before the commit, so a second message from the same transaction is a wasted round trip rather than news. Internal.';


CREATE OR REPLACE FUNCTION "public"."broadcast_poll_gone"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user uuid;
begin
  -- The nightly purge stays silent, exactly as it always has. It is one
  -- statement that can take hundreds of expired polls at once, months after
  -- anybody last looked at them, and announcing each of them to everyone
  -- they were ever shared with is a burst of messages in the small hours to
  -- tell nobody about a poll they had long since finished with.
  -- purge_old_polls() sets this for its own transaction and nothing else
  -- does; see below.
  if coalesce(current_setting('app.purging_polls', true), '') = 'on' then
    return old;
  end if;

  -- Whoever has the poll itself open. Under an event of its own, because
  -- `poll_changed` means "re-read" and a re-read of a poll that has gone is a
  -- read that fails; `poll_deleted` is the answer rather than a prompt to go
  -- and find one. A group goes out question by question through this same
  -- trigger, and each question's page is watching its own topic, so each
  -- one is told.
  perform announce('poll:' || old.id::text, 'poll_deleted');

  -- The audience broadcast_poll_change() reaches, read while it can still be
  -- read. `union` rather than `union all`: a creator who invited themselves
  -- is one reader with one list.
  --
  -- A group goes out as several polls through this same trigger, and each
  -- question reaches the same lists. They hear once: a list re-read after the
  -- commit already has every question gone, so the second message was only
  -- ever a second round trip to show the same thing. See announce().
  for v_user in
    select u.id from auth.users u where u.id = old.created_by
    union
    select u.id
    from invited_voters iv
    join auth.users u on lower(u.email) = lower(iv.email)
    where iv.poll_id = old.id
  loop
    perform announce('user:' || v_user::text, 'polls_changed');
  end loop;

  return old;
end;
$$;


COMMENT ON FUNCTION "public"."broadcast_poll_gone"() IS 'Tells whoever has this poll open that it has gone (poll_deleted on its own topic), and the list of everyone who can see it that it is going, while its invitee list still exists to be read. Once per topic per transaction, so a group of questions going out together reaches each list once. Silent under the nightly purge. Internal: the BEFORE DELETE trigger on polls, never called by a client.';

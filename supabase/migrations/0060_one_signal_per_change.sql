-- One message per topic per transaction, whatever the change was made of.
--
-- The rule the triggers were written to is *one statement, one message*: they
-- are statement-level, with transition tables, so a reset clearing twenty
-- ballots announces itself once rather than twenty times. That rule holds
-- exactly as far as the writes are one statement -- and the option paths are
-- not. `insert_options` validates each option against the list as it stands,
-- so it loops and calls `insert_option`, which is one `INSERT` per option.
-- Twelve windows painted onto a time poll is twelve statements, so twelve
-- statement-level triggers, so twelve messages, and every page watching that
-- poll re-read it twelve times.
--
-- It was not one path. Measured against the migrations, before this file:
--
--     create_poll (5 options + 2 invitees)  7 on the poll's topic, 7 on the list
--     suggest_options (5 at once)           5
--     open_poll_suggest_options (5)         5
--     creator_add_options (3)               3
--     creator_edit_options (5 in, 1 out)    6
--     create_poll_group (2 questions)       10 on the creator's list
--     submit_ballot (13 scores)             1
--
-- Only the last is what the rule promises, and it is the only one whose write
-- happens to be a single statement. Fixing them one at a time -- a flag on
-- `creator_edit_options`, say -- fixes the path that was noticed and leaves
-- the other five, and leaves the next bulk writer to rediscover this.
--
-- **So the unit moves from the statement to the transaction.** `announce()`
-- remembers the topics it has already sent to in this transaction and drops a
-- repeat. Every message goes through it, so the guarantee holds for writes
-- that have not been thought of yet: whatever a transaction does, each topic
-- hears about it once.
--
-- **It is safe because a message carries nothing.** `realtime.messages` is an
-- ordinary table, so nothing written to it is visible to the Realtime service
-- until the transaction commits -- and what is sent is `{}`, a knock on the
-- door. Two messages from one transaction cannot say more than one does:
-- both arrive after the same commit, and each means "re-read", which the
-- reader would do once anyway. Dropping the repeat drops a round trip and
-- nothing else.
--
-- **The bookkeeping is a transaction-local setting**, like `app.purging_polls`
-- and `app.editing_options` before it, so it is discarded on commit and on
-- rollback with no cleanup to forget. The topics are wrapped in the separator
-- on both sides, so `poll:<id>` cannot match inside some other topic.
--
-- What this deliberately does *not* change is which topics are told. Every
-- audience in `broadcast_poll_change` and `broadcast_poll_gone` is the same
-- audience; only the repeats are gone. One consequence is worth naming: a
-- poll group going out used to send its lists one message per question, and
-- now sends one. The audience was always right and the count never carried
-- anything -- a list re-read once already shows every question gone.
--
-- The other half of this -- that `insert_options` writes a row at a time --
-- is left alone. It loops because each option is checked against the list as
-- it stands, duplicates and the 500 ceiling included, and that is the reason
-- the function exists. Its cost is now a few statements inside one
-- transaction rather than a message to everybody connected.

-- --------------------------------------------------------------------------
-- The one place a message is sent from.

CREATE OR REPLACE FUNCTION "public"."announce"("p_topic" "text", "p_event" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_told text := coalesce(current_setting('app.announced', true), '');
  v_key text := '|' || p_topic || '|';
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


ALTER FUNCTION "public"."announce"("p_topic" "text", "p_event" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."announce"("p_topic" "text", "p_event" "text") IS 'Tells one topic that something moved, at most once per transaction. Every live-update message goes through here: the payload is empty and nothing reaches a listener before the commit, so a second message from the same transaction is a wasted round trip rather than news. Internal.';


REVOKE ALL ON FUNCTION "public"."announce"("p_topic" "text", "p_event" "text") FROM PUBLIC;


-- --------------------------------------------------------------------------
-- The two callers, unchanged apart from how they send.

CREATE OR REPLACE FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
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
  select created_by into v_creator
  from polls where id = p_poll_id;
  if not found then
    return;
  end if;

  perform announce('poll:' || p_poll_id::text, 'poll_changed');

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
    perform announce('user:' || v_user::text, 'polls_changed');
  end loop;
end;
$$;


ALTER FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."broadcast_poll_change"("p_poll_id" "uuid") IS 'Tells anyone watching this poll that it moved, without saying how: the poll''s own topic, its share token, and the list of everyone who can see it. Each of them once per transaction, however many statements the change took; see announce(). Internal: called from the broadcast triggers, never by a client.';


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

  -- The audience broadcast_poll_change() reaches, minus the poll's own topic
  -- and read while it can still be read. `union` rather than `union all`: a
  -- creator who invited themselves is one reader with one list.
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


ALTER FUNCTION "public"."broadcast_poll_gone"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."broadcast_poll_gone"() IS 'Tells the list of everyone who can see this poll that it is going, while its invitee list still exists to be read. Once per list per transaction, so a group of questions going out together is one message rather than one each. Internal: the BEFORE DELETE trigger on polls, never called by a client.';

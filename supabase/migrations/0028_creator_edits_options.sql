-- Let a poll's creator correct its option list while it still has no votes.
--
-- Until now a mistyped or missing option was permanent the moment the ballot
-- existed: the fix was to duplicate the poll and send a new link out, which
-- costs everyone who already has the old one. Nothing in the promise the
-- option list makes needs that. What the list promises is that **everyone who
-- votes scores the same list**, and a poll with no ballots in it has nobody
-- who has scored anything yet -- so changing the list there changes nothing
-- anybody has already answered.
--
-- The window is exactly "no ballots", and it is `guard_options_frozen` that
-- has always drawn it: it refuses any insert or delete on `candidates` for a
-- poll that already has votes, and it keeps doing that unchanged. A creator
-- who wants the list back after voting has started resets the votes first,
-- which is a thing everyone in the poll is asked to redo either way.
--
-- Deleting an option was already possible for the creator: the
-- `candidates_delete` policy allows it and the trigger bounds it. Adding one
-- was not, because `authenticated` has no INSERT grant on `candidates` and
-- `suggest_option` only serves a poll that is still collecting. This adds the
-- creator's own way in, as a function, for the same reason every other write
-- to that table is one.

-- The field rules for an option, in one place, so the two ways into
-- `candidates` cannot disagree about what fits. Lifted out of
-- `add_suggested_option`, which now calls it after checking the stage.
--
-- Not granted to anybody: both callers are SECURITY DEFINER and reach it
-- from inside, having already decided that this caller may write to this poll.
CREATE OR REPLACE FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_next int;
  v_count int;
begin
  if v_name is null then
    raise exception 'Give the option a name';
  end if;

  -- A name is a label on a ballot and a description is a couple of lines
  -- under it. Neither cap is near what a real option needs; they are here
  -- because the suggestion path lets a whole group write to this table.
  if length(v_name) > 100 then
    raise exception 'That option name is too long';
  end if;

  if length(v_description) > 500 then
    raise exception 'That description is too long';
  end if;

  if exists (
    select 1 from candidates c
    where c.poll_id = p_poll.id and lower(c.name) = lower(v_name)
  ) then
    raise exception '"%" is already on the list', v_name;
  end if;

  select count(*)::int, coalesce(max(sort_order), -1) + 1
  into v_count, v_next
  from candidates where poll_id = p_poll.id;

  -- A ballot is a list somebody has to read to the end before scoring any of
  -- it, and a shared list with nothing stopping it grows until nobody does.
  if v_count >= 50 then
    raise exception 'This poll already has as many options as it can hold';
  end if;

  -- Arrival order, which is the order everyone watching the page has been
  -- reading the list in already.
  insert into candidates (poll_id, name, description, sort_order)
  values (p_poll.id, v_name, v_description, v_next);
end;
$$;


ALTER FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") FROM PUBLIC;

COMMENT ON FUNCTION "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") IS 'The field rules for one option -- name, description, duplicates, the 50-option ceiling -- shared by the suggestion path and the creator''s own. Internal: the caller has already decided it may write to this poll.';


-- Unchanged in what it enforces; the field rules now live in insert_option so
-- that adding an option as the creator applies exactly the same ones. What
-- stays here is the stage: this is the suggestion path, and it serves a poll
-- that solicits its options and has not finalized them.
CREATE OR REPLACE FUNCTION "public"."add_suggested_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not p_poll.solicit_options then
    raise exception 'The options for this poll were set when it was created';
  end if;

  if p_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  if p_poll.options_finalized_at is not null then
    raise exception 'The options for this poll are settled and voting has started';
  end if;

  perform insert_option(p_poll, p_name, p_description);
end;
$$;


-- The creator's way onto the option list of a poll that already has a ballot.
--
-- Deliberately says nothing about `solicit_options` or `options_finalized_at`:
-- where the options came from is a setting frozen at creation, and it is not
-- what makes a list safe to change. What makes it safe is that nothing has
-- been scored yet, which is the one thing this checks -- and which
-- `guard_options_frozen` checks again underneath, on every write to the table
-- from any path at all.
CREATE OR REPLACE FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  -- The same 'not found' a poll that exists but isn't yours gets everywhere
  -- else: whether a given id is a real poll is not something an outsider
  -- needs to learn.
  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  -- The trigger says this too, and would refuse the insert on its own. Saying
  -- it here is what makes the message the one the creator can act on.
  if exists (select 1 from ballots where poll_id = p_poll_id) then
    raise exception 'Cannot change the options of a poll that already has votes';
  end if;

  perform insert_option(v_poll, p_name, p_description);
end;
$$;


ALTER FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") TO "authenticated";

COMMENT ON FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") IS 'Adds an option to the creator''s own poll while it still has no votes. The window is "no ballots" and nothing else; where the options came from does not enter into it.';


-- Now also holds the floor a ballot needs: two options.
--
-- A poll still collecting its options may be pruned to nothing, because
-- finalize_options applies the floor at the point the list becomes a ballot.
-- A poll that already has a ballot has no such later checkpoint, so the floor
-- is applied to the delete itself -- otherwise correcting an option list could
-- leave a live poll with one option and no election in it.
CREATE OR REPLACE FUNCTION "public"."guard_options_frozen"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_poll_id uuid;
  v_remaining int;
begin
  if tg_op = 'DELETE' then
    v_poll_id := old.poll_id;
  else
    v_poll_id := new.poll_id;
  end if;

  select * into v_poll from polls where id = v_poll_id;

  -- Parent poll already gone => this is a cascade from deleting the poll
  -- itself, which is allowed.
  if not found then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if exists (select 1 from ballots where poll_id = v_poll_id) then
    raise exception 'Cannot change the options of a poll that already has votes';
  end if;

  if tg_op = 'DELETE' then
    -- Only once the list is a ballot. While it is still being collected there
    -- is a later checkpoint -- finalize_options -- and pruning back to one
    -- option, or to none, is a normal thing to do on the way there.
    if not (v_poll.solicit_options and v_poll.options_finalized_at is null) then
      select count(*)::int into v_remaining
      from candidates where poll_id = v_poll_id and id <> old.id;

      if v_remaining < 2 then
        raise exception 'A poll needs at least two options';
      end if;
    end if;

    return old;
  end if;

  return new;
end;
$$;

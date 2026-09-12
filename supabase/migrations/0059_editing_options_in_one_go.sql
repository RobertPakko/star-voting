-- One press of *Save changes* is one edit, and the floor is applied to what
-- the edit leaves behind.
--
-- The creator's correction to a list that is already a ballot is drafted in
-- the browser and applied in one press: some options going, some coming. It
-- reached the database as two requests -- a `delete` on `candidates`, then
-- `creator_add_options` -- and `guard_options_frozen` judged the first of them
-- on its own. So a poll of two options, edited to remove one and add two,
-- was refused with *A poll needs at least two options* on the way through a
-- state the creator never asked for and never saw. Three options is not one
-- option; the list only ever dipped because the edit had been taken apart.
--
-- Two halves to the repair, and they belong together:
--
--  - **`creator_edit_options`**, which takes the whole edit -- what is going
--    and what is coming -- and applies it in one transaction. It is
--    `creator_add_options` with a list of ids to drop first, and answers the
--    same thing: how many options were added.
--  - **the floor, moved to the end of the edit.** The trigger still refuses
--    the delete that would leave a live ballot short, because that delete is
--    a grant the browser holds and the guard is the only thing standing
--    behind it. What it now skips is a delete inside an edit that says so --
--    `creator_edit_options` sets `app.editing_options` to the poll it is
--    editing, transaction-local, exactly as `purge_old_polls` sets
--    `app.purging_polls` -- and the function applies the floor itself once
--    the additions are in.
--
-- The flag names the poll rather than being a bare `on`, so an edit of one
-- poll cannot lift the floor off another in the same transaction, and it is
-- cleared as soon as the deletes are done.

-- --------------------------------------------------------------------------
-- The guard, which now knows the difference between a delete and an edit.

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
    --
    -- And only when the delete is the whole of what is happening. A creator
    -- swapping one option for two passes through two options and one on the
    -- way to three, and neither of those is a list anybody was ever offered:
    -- creator_edit_options names the poll it is mid-edit on and applies this
    -- same floor to what it leaves behind. See that function.
    if not (v_poll.solicit_options and v_poll.options_finalized_at is null)
       and coalesce(current_setting('app.editing_options', true), '') <> v_poll_id::text then
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


ALTER FUNCTION "public"."guard_options_frozen"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."guard_options_frozen"() IS 'Holds an option list still from the first ballot on, and holds a live ballot to two options. The floor steps aside for a poll still collecting, whose floor is finalize_options, and for the poll named in app.editing_options, whose floor is creator_edit_options.';


-- --------------------------------------------------------------------------
-- The whole correction, in one request.

CREATE OR REPLACE FUNCTION "public"."creator_edit_options"("p_poll_id" "uuid", "p_options" "jsonb" DEFAULT '[]'::"jsonb", "p_remove" "uuid"[] DEFAULT '{}'::"uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_added int := 0;
  v_left int;
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

  -- The trigger says this too, and would refuse the write on its own. Saying
  -- it here is what makes the message the one the creator can act on.
  if exists (select 1 from ballots where poll_id = p_poll_id) then
    raise exception 'Cannot change the options of a poll that already has votes';
  end if;

  -- Transaction-local, and cleared the moment the deletes are done: it lifts
  -- the per-row floor off this poll for exactly as long as the list is
  -- part-way between two states. See guard_options_frozen.
  perform set_config('app.editing_options', p_poll_id::text, true);

  -- Removals first, so an edit that swaps one option for another cannot trip
  -- over the 500-option ceiling on its way through the middle. Scoped to this
  -- poll, so an id from somewhere else is a no-op rather than a delete: the
  -- caller has been shown to own this poll and nothing more.
  delete from candidates
  where poll_id = p_poll_id and id = any (coalesce(p_remove, '{}'::uuid[]));

  perform set_config('app.editing_options', '', true);

  if p_options is not null and jsonb_array_length(p_options) > 0 then
    v_added := insert_options(v_poll, p_options);
  end if;

  -- The floor the trigger would have applied a row at a time, applied once to
  -- the list the creator actually asked for. A list still being collected has
  -- none, exactly as it has none there: its checkpoint is finalize_options.
  if not (v_poll.solicit_options and v_poll.options_finalized_at is null) then
    select count(*)::int into v_left from candidates where poll_id = p_poll_id;

    if v_left < 2 then
      raise exception 'A poll needs at least two options';
    end if;
  end if;

  return v_added;
end;
$$;


ALTER FUNCTION "public"."creator_edit_options"("p_poll_id" "uuid", "p_options" "jsonb", "p_remove" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."creator_edit_options"("p_poll_id" "uuid", "p_options" "jsonb", "p_remove" "uuid"[]) IS 'The creator''s correction to an option list, both halves of it -- the options to drop and the options to add -- in one transaction, answering how many were added. The two-option floor is applied to what the edit leaves behind rather than to the states it passes through, which is the whole reason it exists beside creator_add_options.';


REVOKE ALL ON FUNCTION "public"."creator_edit_options"("p_poll_id" "uuid", "p_options" "jsonb", "p_remove" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."creator_edit_options"("p_poll_id" "uuid", "p_options" "jsonb", "p_remove" "uuid"[]) TO "authenticated";

-- Correcting an option keeps the scores it has been given.
--
-- A correction used to travel as a removal and an addition: the browser sent
-- the option's id in p_remove and its corrected text in p_options, and there
-- was no other way to say it, because there is no update door into
-- candidates. On a poll nobody has voted in that is invisible. On a poll with
-- ballots in it, it is the one thing a creator fixing a typo must never do:
-- the delete cascades through scores.candidate_id, every ballot loses what it
-- gave that option, and fill_scores_for_new_option scores the "new" one zero
-- on all of them. Fixing a misspelt description quietly zeroed the option,
-- and nothing on screen said so -- the modal in front of a late edit warns
-- that the results will carry a note, not that votes will be thrown away.
--
-- So a correction is now an update. p_correct is a list of
-- {id, name, description}, applied in place: the row keeps its id, so its
-- scores stay attached to it, and keeps its sort_order, so it no longer jumps
-- to the end of the list.
--
-- Order inside the one transaction is removals, then corrections, then
-- additions, so that a name freed by a removal can be taken by a correction
-- and a name freed by a rename can be taken by an addition -- which is what
-- the card's duplicate check already assumes. The corrections go in as one
-- UPDATE and are checked for duplicate names afterwards, so two options
-- swapping their names is not refused half-way through.
--
-- A correction that actually changes something on a poll with ballots marks
-- the poll exactly as a removal or an addition does: carrying scores across a
-- rename is the point, and it is also a thing the reader of the result is
-- owed a note about, since the name those scores were given under is not the
-- one now on the list.
--
-- A different argument list is a different function, so this is a drop and a
-- create rather than a replace -- and a dropped function takes its grants
-- with it, so they are restated. See 30_a_poll_that_finds_a_time for why the
-- REVOKE matters.

drop function if exists public.creator_edit_options(uuid, jsonb, uuid[]);

create function public.creator_edit_options(
  p_poll_id uuid,
  p_options jsonb default '[]'::jsonb,
  p_remove uuid[] default '{}'::uuid[],
  p_correct jsonb default '[]'::jsonb
) returns integer
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
  v_added int := 0;
  v_removed int := 0;
  v_corrected int := 0;
  v_voted boolean;
  v_left int;
  v_item jsonb;
  v_name text;
  v_description text;
  v_clash text;
  i int;
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

  p_correct := coalesce(p_correct, '[]'::jsonb);
  if jsonb_typeof(p_correct) <> 'array' then
    raise exception 'Give the corrections as a list';
  end if;

  -- A typed correction is a typed name, and a time poll's names are windows
  -- the calendar draws and the window rule scores: the same refusal
  -- creator_add_option gives the typed-name path.
  if jsonb_array_length(p_correct) > 0 and v_poll.kind = 'time' then
    raise exception 'A time poll''s options are its windows; change its schedule instead';
  end if;

  -- The field rules insert_option applies to a new option, applied to a
  -- corrected one, before anything is written.
  for i in 0 .. jsonb_array_length(p_correct) - 1 loop
    v_item := p_correct -> i;
    v_name := nullif(trim(coalesce(v_item ->> 'name', '')), '');
    v_description := nullif(trim(coalesce(v_item ->> 'description', '')), '');

    if (v_item ->> 'id') is null then
      raise exception 'Say which option is being corrected';
    end if;
    if v_name is null then
      raise exception 'Give the option a name';
    end if;
    if length(v_name) > 150 then
      raise exception 'That option name is too long';
    end if;
    if length(v_description) > 900 then
      raise exception 'That description is too long';
    end if;
  end loop;

  -- One row, one correction: an UPDATE joined to two rows for the same id
  -- applies whichever it meets first, which is not an answer.
  if (select count(*) <> count(distinct (x ->> 'id')::uuid)
        from jsonb_array_elements(p_correct) x) then
    raise exception 'An option can only be corrected once in an edit';
  end if;

  -- Whether this edit is a late one, asked before it is made. What it changes
  -- is not whether the edit is allowed -- it is, and the creator was shown
  -- what it costs before they pressed anything -- but what the poll says about
  -- itself afterwards.
  select exists (select 1 from ballots where poll_id = p_poll_id) into v_voted;

  -- Transaction-local, and held across every part of the edit: it names this
  -- poll as the one whose list its own creator is correcting, which is what
  -- lifts the per-row guard and the per-row floor off it for exactly as long
  -- as the list is part-way between two states. See guard_options_frozen.
  perform set_config('app.editing_options', p_poll_id::text, true);

  -- Removals first, so an edit that swaps one option for another cannot trip
  -- over the 500-option ceiling on its way through the middle. Scoped to this
  -- poll, so an id from somewhere else is a no-op rather than a delete: the
  -- caller has been shown to own this poll and nothing more.
  delete from candidates
  where poll_id = p_poll_id and id = any (coalesce(p_remove, '{}'::uuid[]));

  get diagnostics v_removed = row_count;

  -- Corrections in place, so the option keeps its id and every score given
  -- to it. Scoped to this poll like the delete, and counting only the rows
  -- that actually moved: the card sends what it holds, not a diff.
  update candidates c
  set name = w.name, description = w.description
  from (
    select (x ->> 'id')::uuid as id,
           nullif(trim(coalesce(x ->> 'name', '')), '') as name,
           nullif(trim(coalesce(x ->> 'description', '')), '') as description
    from jsonb_array_elements(p_correct) x
  ) w
  where c.id = w.id
    and c.poll_id = p_poll_id
    and (c.name, c.description) is distinct from (w.name, w.description);

  get diagnostics v_corrected = row_count;

  -- The duplicate rule insert_option applies, over the list as the
  -- corrections left it rather than one row at a time.
  if v_corrected > 0 then
    select min(name) into v_clash
    from candidates
    where poll_id = p_poll_id
    group by lower(name)
    having count(*) > 1
    limit 1;

    if v_clash is not null then
      raise exception '"%" is already on the list', v_clash;
    end if;
  end if;

  if p_options is not null and jsonb_array_length(p_options) > 0 then
    v_added := insert_options(v_poll, p_options);
  end if;

  perform set_config('app.editing_options', '', true);

  -- The floor the trigger would have applied a row at a time, applied once to
  -- the list the creator actually asked for. A list still being collected has
  -- none, exactly as it has none there: its checkpoint is finalize_options.
  if not (v_poll.solicit_options and v_poll.options_finalized_at is null) then
    select count(*)::int into v_left from candidates where poll_id = p_poll_id;

    if v_left < 2 then
      raise exception 'A poll needs at least two options';
    end if;
  end if;

  -- The mark is for an edit that actually moved something.
  if v_voted and (v_added > 0 or v_removed > 0 or v_corrected > 0) then
    update polls set options_edited_after_votes = true
    where id = p_poll_id and not options_edited_after_votes;
  end if;

  return v_added;
end;
$$;

alter function public.creator_edit_options(uuid, jsonb, uuid[], jsonb) owner to postgres;

comment on function public.creator_edit_options(uuid, jsonb, uuid[], jsonb) is 'The creator''s correction to an option list in one transaction -- options to drop, options corrected in place, options to add -- answering how many were added. A correction is an update, so the option keeps its id, its place and every score given to it. The two-option floor is applied to what the edit leaves behind rather than to the states it passes through. An edit that moves something on a poll with ballots in it marks the poll, which is what the results banner is drawn from.';

revoke all on function public.creator_edit_options(uuid, jsonb, uuid[], jsonb) from public;
grant all on function public.creator_edit_options(uuid, jsonb, uuid[], jsonb) to authenticated;

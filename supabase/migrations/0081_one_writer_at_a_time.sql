-- One writer at a time per poll.
--
-- Every function that reads a poll's state and then writes on the strength of
-- it was open to a second transaction doing the same in between. Under READ
-- COMMITTED each statement sees only what had committed when it began, so two
-- transactions can each decide on a picture that is missing the other's write:
--
--  * the last two invitees voting together each see one vote still to come,
--    so neither settles the winner or announces the results, and the poll sits
--    fully voted with *Results ready* on its badge and nobody told;
--  * the last two confirmations each see one still to come, so the poll never
--    opens itself;
--  * a ballot beside Close lands in a poll that has just closed, after the
--    winner was settled without it -- and settle_winner never revisits a
--    settled question, so the badge disagrees with the tally for good;
--  * a ballot beside an option being added misses the zero score
--    fill_scores_for_new_option writes for every ballot it can see, leaving a
--    ballot short an option and unrevisable;
--  * a suggestion beside Open poll lands on a list that has just become the
--    ballot; a revision beside the last vote lands after the results are out;
--    an invitee removed while voting leaves a ballot from somebody off the
--    list.
--
-- The cure is the same for all of them: every writer takes a lock on the
-- poll's row -- the group's first question, so a poll of several questions is
-- one queue -- before it reads anything. The second transaction waits for the
-- first to commit, and the statements after its lock see what the first did.
-- FOR NO KEY UPDATE rather than FOR UPDATE, so it does not also block the
-- foreign-key checks of rows being inserted under the poll; it does block the
-- UPDATEs close_poll and reopen_poll make, which is what puts them in the queue
-- too. Reads are untouched: nothing here waits on a page being drawn.
--
-- The two doors the browser writes through without a function -- adding or
-- removing an invitee, deleting an option -- are queued by the guard triggers
-- that already stand in front of them, and the three reconcilers lock as well,
-- so a writer added later without the lock still cannot let them decide on a
-- stale picture. Each body below is the current definition with the lock put
-- first and nothing else changed.

CREATE OR REPLACE FUNCTION "public"."lock_poll"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- Nothing comes back from this and nothing is meant to: the row is taken
  -- for what is left of the transaction, and a poll that does not exist --
  -- one being deleted, or the purge -- locks nothing and stops nobody.
  perform 1 from polls where id = poll_list_row(p_poll_id) for no key update;
end;
$$;

ALTER FUNCTION "public"."lock_poll"("p_poll_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."lock_poll"("p_poll_id" "uuid") IS 'Queues this transaction behind any other writing to the same poll, by locking the group''s first question until commit. Every function that reads a poll''s state and writes on it calls this first. Internal.';

REVOKE ALL ON FUNCTION "public"."lock_poll"("p_poll_id" "uuid") FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Who writes, and the order they take their turns in
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_ballot(p_poll_id uuid, p_scores jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ballot_id uuid;
  v_item jsonb;
  v_candidate_id uuid;
  v_score int;
  v_candidate_count int;
begin
  perform lock_poll(p_poll_id);

  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from polls where id = p_poll_id and closed_at is not null) then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  if exists (
    select 1 from polls
    where id = p_poll_id and solicit_options and options_finalized_at is null
  ) then
    raise exception 'This poll is still collecting options, so voting has not started';
  end if;

  if not exists (
    select 1 from invited_voters
    where poll_id = p_poll_id and email = lower(auth.jwt() ->> 'email')
  ) then
    raise exception 'You are not invited to this poll';
  end if;

  if exists (
    select 1 from ballots where poll_id = p_poll_id and voter_id = auth.uid()
  ) then
    raise exception 'You have already voted in this poll';
  end if;

  select count(*) into v_candidate_count from candidates where poll_id = p_poll_id;

  if jsonb_array_length(p_scores) is distinct from v_candidate_count then
    raise exception 'Must submit a score for every option';
  end if;

  insert into ballots (poll_id, voter_id) values (p_poll_id, auth.uid())
  returning id into v_ballot_id;

  for v_item in select * from jsonb_array_elements(p_scores)
  loop
    v_candidate_id := (v_item ->> 'candidate_id')::uuid;
    v_score := (v_item ->> 'score')::int;

    if v_score < 0 or v_score > 5 then
      raise exception 'Score must be between 0 and 5';
    end if;

    if not exists (select 1 from candidates where id = v_candidate_id and poll_id = p_poll_id) then
      raise exception 'Invalid option for this poll';
    end if;

    insert into scores (ballot_id, candidate_id, score) values (v_ballot_id, v_candidate_id, v_score);
  end loop;

  -- Here rather than in a trigger on the insert above, because the scores this
  -- ballot is made of were written after it.
  perform settle_winner(p_poll_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.open_poll_submit(p_poll_id uuid, p_scores jsonb, p_voter_key text, p_voter_name text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
  v_name text;
  v_key text;
  v_ballot_id uuid;
  v_option_count int;
  v_item jsonb;
  v_candidate_id uuid;
  v_score int;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  if v_poll.solicit_options and v_poll.options_finalized_at is null then
    raise exception 'This poll is still collecting options, so voting has not started';
  end if;

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  if v_poll.show_voters then
    v_name := nullif(trim(coalesce(p_voter_name, '')), '');
    if v_name is null then
      raise exception 'Enter your name so the group can see who has voted';
    end if;
    if length(v_name) > 60 then
      raise exception 'That name is too long';
    end if;
  else
    -- A poll that hides respondents must not store one, whatever the client
    -- sends.
    v_name := null;
  end if;

  -- This reader's ballot, however they are known: by their account on
  -- another device, or by this browser's key. See open_ballot_of.
  if open_ballot_of(v_poll.id, p_voter_key) is not null then
    raise exception 'You have already voted in this poll';
  end if;

  -- The key goes on the ballot unless another account's ballot already holds
  -- it -- a shared browser, the next person signed in. Their ballot is found
  -- by their account, so it needs no key, and a key cannot be on two ballots.
  v_key := p_voter_key;
  if exists (select 1 from ballots where poll_id = v_poll.id and voter_key = p_voter_key) then
    v_key := null;
  end if;

  select count(*) into v_option_count from candidates where poll_id = v_poll.id;

  if jsonb_array_length(p_scores) is distinct from v_option_count then
    raise exception 'Must submit a score for every option';
  end if;

  begin
    insert into ballots (poll_id, voter_id, account_id, voter_name, voter_key)
    values (v_poll.id, null, auth.uid(), v_name, v_key)
    returning id into v_ballot_id;
  exception when unique_violation then
    -- Either the name is taken, or this reader raced themselves (a
    -- double-click, or two devices at once) past the check above.
    if v_name is null or open_ballot_of(v_poll.id, p_voter_key) is not null then
      raise exception 'You have already voted in this poll';
    end if;
    raise exception '"%" has already voted in this poll. Add a last initial if that is not you.', v_name;
  end;

  for v_item in select * from jsonb_array_elements(p_scores)
  loop
    v_candidate_id := (v_item ->> 'candidate_id')::uuid;
    v_score := (v_item ->> 'score')::int;

    if v_score < 0 or v_score > 5 then
      raise exception 'Score must be between 0 and 5';
    end if;

    if not exists (select 1 from candidates where id = v_candidate_id and poll_id = v_poll.id) then
      raise exception 'Invalid option for this poll';
    end if;

    insert into scores (ballot_id, candidate_id, score) values (v_ballot_id, v_candidate_id, v_score);
  end loop;

  -- As in submit_ballot, and for the same reason. An open poll reveals only
  -- on close, so this settles nothing today -- but the gate is read from one
  -- function and this keeps the two ballot paths saying the same thing.
  perform settle_winner(v_poll.id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.revise_ballot(p_poll_id uuid, p_scores jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_ballot_id uuid;
begin
  perform lock_poll(p_poll_id);

  if v_email is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_poll from polls where id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  -- The same "not found" for a poll that exists but is none of yours, as
  -- poll_ballots() gives: whether a given id is a real poll is not something
  -- an outsider needs to learn here either.
  if not (
    v_poll.created_by = auth.uid()
    or exists (select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email)
  ) then
    raise exception 'Poll not found';
  end if;

  if v_poll.mode <> 'invite' then
    raise exception 'This poll is open to anyone with the link, so its votes are changed through that link';
  end if;

  -- Closed first, and separately from the reveal. A closed poll with votes in
  -- it is both, and "it has been closed" is the more useful of the two things
  -- to say; a poll closed before anybody voted is only the first, and the
  -- reveal below would let it straight through -- it has no results to be out.
  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  if poll_results_revealed(v_poll) then
    raise exception 'The results are out, so votes can no longer be changed';
  end if;

  select id into v_ballot_id
  from ballots where poll_id = p_poll_id and voter_id = auth.uid();

  if not found then
    raise exception 'You have not voted in this poll yet';
  end if;

  perform replace_scores(v_ballot_id, p_poll_id, p_scores);

  update ballots set revised_at = now() where id = v_ballot_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.open_poll_revise(p_poll_id uuid, p_scores jsonb, p_voter_key text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
  v_ballot_id uuid;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed and is no longer accepting votes';
  end if;

  -- An open poll reveals on close and only on close, so the line above has
  -- already caught every poll this could catch. It is here because the rule
  -- being kept is "not while the results are out", and a rule worth stating
  -- is worth stating on both paths rather than left implied by another one.
  if poll_results_revealed(v_poll) then
    raise exception 'The results are out, so votes can no longer be changed';
  end if;

  -- Found the way the view found it, so the ballot a reader was handed back
  -- is the ballot their change lands on -- on whichever device they cast it.
  v_ballot_id := open_ballot_of(v_poll.id, p_voter_key);

  if v_ballot_id is null then
    raise exception 'You have not voted in this poll yet';
  end if;

  perform replace_scores(v_ballot_id, v_poll.id, p_scores);

  update ballots set revised_at = now() where id = v_ballot_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_options(p_poll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
begin
  perform lock_poll(p_poll_id);

  v_poll := confirming_invitee(p_poll_id);
  perform assert_collecting_options(v_poll);

  -- Idempotent: confirming twice is one confirmation, and a double-click on a
  -- slow connection is not an error worth reporting to anybody.
  insert into option_confirmations (poll_id, voter_id)
  values (v_poll.id, auth.uid())
  on conflict do nothing;

  -- The last one in opens the poll. Nothing here is conditional on this
  -- caller being last: the function asks the whole group and shrugs unless it
  -- has run out of people to wait for.
  perform open_options_when_all_confirmed(v_poll.id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.open_poll_confirm_options(p_poll_id uuid, p_voter_key text, p_voter_name text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
  v_name text;
  v_key text;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  perform assert_collecting_options(v_poll);

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  -- The same rule open_poll_submit applies to a ballot's name, in the same
  -- order and the same words: a poll that names its respondents needs one, and
  -- a poll that hides them stores none whatever the client sends.
  if v_poll.show_voters then
    v_name := nullif(trim(coalesce(p_voter_name, '')), '');
    if v_name is null then
      raise exception 'Enter your name so the group can see who has confirmed the options';
    end if;
    if length(v_name) > 60 then
      raise exception 'That name is too long';
    end if;
  else
    v_name := null;
  end if;

  if open_confirmation_of(v_poll.id, p_voter_key) is not null then
    -- Already done, and saying so is more use than a second row would be.
    return;
  end if;

  -- As on a ballot: the key goes on the row unless another account's
  -- confirmation already holds it.
  v_key := p_voter_key;
  if exists (
    select 1 from option_confirmations
    where poll_id = v_poll.id and voter_key = p_voter_key
  ) then
    v_key := null;
  end if;

  begin
    insert into option_confirmations (poll_id, account_id, voter_name, voter_key)
    values (v_poll.id, auth.uid(), v_name, v_key);
  exception when unique_violation then
    -- Either the name is taken, or this reader raced themselves past the
    -- check above; the same two cases open_poll_submit tells apart the same
    -- way.
    if v_name is null or open_confirmation_of(v_poll.id, p_voter_key) is not null then
      return;
    end if;
    raise exception '"%" has already confirmed the options. Add a last initial if that is not you.', v_name;
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.unconfirm_options(p_poll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
begin
  perform lock_poll(p_poll_id);

  v_poll := confirming_invitee(p_poll_id);
  -- Only while the stage is still running, which is also the only time it can
  -- mean anything: once the poll is open there is nothing left to be done
  -- adding to, and the confirmations are a record of how it got there.
  perform assert_collecting_options(v_poll);

  delete from option_confirmations
  where poll_id = v_poll.id and voter_id = auth.uid();
end;
$function$;

CREATE OR REPLACE FUNCTION public.open_poll_unconfirm_options(p_poll_id uuid, p_voter_key text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  perform assert_collecting_options(v_poll);

  if p_voter_key is null or trim(p_voter_key) = '' then
    raise exception 'Missing voter key';
  end if;

  -- Every row the view could hand back as this reader's, not only the first:
  -- a reader who confirmed signed out on one device and signed in on another
  -- has two, and taking back one would leave the other drawing the button as
  -- still pressed. The predicate is open_confirmation_of's, unlimited.
  delete from option_confirmations oc
  where oc.poll_id = v_poll.id
    and (
      (auth.uid() is not null and oc.account_id = auth.uid())
      or (oc.voter_key = p_voter_key and (oc.account_id is null or auth.uid() is null))
    );
end;
$function$;

CREATE OR REPLACE FUNCTION public.suggest_option(p_poll_id uuid, p_name text, p_description text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  -- Same "not found" for a poll that exists but isn't yours: whether a given
  -- id is a real poll is not something an outsider needs to learn.
  if not (
    v_poll.created_by = auth.uid()
    or exists (
      select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email
    )
  ) then
    raise exception 'Poll not found';
  end if;

  if v_poll.mode <> 'invite' then
    raise exception 'This poll is open to anyone with the link, so its options are suggested through that link';
  end if;

  perform add_suggested_option(v_poll, p_name, p_description);
end;
$function$;

CREATE OR REPLACE FUNCTION public.suggest_options(p_poll_id uuid, p_options jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  -- Same "not found" for a poll that exists but isn't yours: whether a given
  -- id is a real poll is not something an outsider needs to learn.
  if not (
    v_poll.created_by = auth.uid()
    or exists (
      select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email
    )
  ) then
    raise exception 'Poll not found';
  end if;

  if v_poll.mode <> 'invite' then
    raise exception 'This poll is open to anyone with the link, so its options are suggested through that link';
  end if;

  perform assert_collecting_options(v_poll);
  return insert_options(v_poll, p_options);
end;
$function$;

CREATE OR REPLACE FUNCTION public.open_poll_suggest_option(p_poll_id uuid, p_name text, p_description text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  perform add_suggested_option(v_poll, p_name, p_description);
end;
$function$;

CREATE OR REPLACE FUNCTION public.open_poll_suggest_options(p_poll_id uuid, p_options jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  perform assert_collecting_options(v_poll);
  return insert_options(v_poll, p_options);
end;
$function$;

CREATE OR REPLACE FUNCTION public.creator_add_option(p_poll_id uuid, p_name text, p_description text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
  v_voted boolean;
begin
  perform lock_poll(p_poll_id);

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

  if v_poll.kind = 'time' then
    raise exception 'A time poll''s options are its windows; change its schedule instead';
  end if;

  select exists (select 1 from ballots where poll_id = p_poll_id) into v_voted;

  -- The creator's own door, so it opens on a poll with votes in it exactly as
  -- creator_edit_options does, says so to the guard, and leaves the same mark.
  perform set_config('app.editing_options', p_poll_id::text, true);
  perform insert_option(v_poll, p_name, p_description);
  perform set_config('app.editing_options', '', true);

  if v_voted then
    update polls set options_edited_after_votes = true
    where id = p_poll_id and not options_edited_after_votes;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.creator_add_options(p_poll_id uuid, p_options jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
  v_added int;
  v_voted boolean;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  select exists (select 1 from ballots where poll_id = p_poll_id) into v_voted;

  perform set_config('app.editing_options', p_poll_id::text, true);
  v_added := insert_options(v_poll, p_options);
  perform set_config('app.editing_options', '', true);

  if v_voted and v_added > 0 then
    update polls set options_edited_after_votes = true
    where id = p_poll_id and not options_edited_after_votes;
  end if;

  return v_added;
end;
$function$;

CREATE OR REPLACE FUNCTION public.creator_edit_options(p_poll_id uuid, p_options jsonb DEFAULT '[]'::jsonb, p_remove uuid[] DEFAULT '{}'::uuid[], p_correct jsonb DEFAULT '[]'::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  perform lock_poll(p_poll_id);

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
$function$;

CREATE OR REPLACE FUNCTION public.finalize_options(p_poll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
  v_short record;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Only the poll creator can finalize these options';
  end if;

  if not v_poll.solicit_options then
    raise exception 'The options for this poll were set when it was created';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed';
  end if;

  -- Asked of this question, which is enough: the group is opened in one
  -- statement below, so its questions are finalized together or not at all
  -- and can never disagree about whether they have been.
  if v_poll.options_finalized_at is not null then
    raise exception 'The options for this poll have already been finalized';
  end if;

  -- The same floor create_poll puts on a poll whose creator wrote the
  -- options: one option is not an election. Every question is checked
  -- *before* any is opened -- a poll half-opened would be taking votes on
  -- some questions while others were still gathering, which is the state
  -- opening the poll in one act exists to prevent.
  select q.question_title, count(c.id)::int as options
  into v_short
  from poll_group_members(v_poll) q
  left join candidates c on c.poll_id = q.id
  group by q.id, q.question_position, q.question_title
  having count(c.id) < 2
  order by min(q.question_position)
  limit 1;

  if found then
    -- Named, because on a poll of several questions "add two options" leaves
    -- the creator to find which of five is short. A poll asking one question
    -- has no name to give and says what it always said.
    if v_short.question_title is null then
      raise exception 'Add at least two options before opening the poll for voting';
    end if;
    raise exception 'Add at least two options to "%" before opening the poll for voting',
      v_short.question_title;
  end if;

  update polls set options_finalized_at = now()
  where id in (select q.id from poll_group_members(v_poll) q);

  perform notify_poll_opened(v_poll.id, false);
end;
$function$;

CREATE OR REPLACE FUNCTION public.close_poll(p_poll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Only the poll creator can close this poll';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll is already closed';
  end if;

  -- One timestamp for the group: the questions stopped at the same moment,
  -- because closing is one act.
  update polls set closed_at = now()
  where id in (select q.id from poll_group_members(v_poll) q)
    and closed_at is null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reopen_poll(p_poll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Only the poll creator can reopen this poll';
  end if;

  if v_poll.closed_at is null then
    raise exception 'This poll is not closed';
  end if;

  -- Which questions actually showed a tally, asked *before* the close is
  -- lifted: poll_results_revealed is computed from closed_at and turnout, so a
  -- moment from now it answers no for all of them. A question closed with
  -- nothing in it revealed nothing and is not marked -- the votes it takes
  -- from here are its first ones, not late ones.
  update polls set reopened_after_reveal = true
  where id in (
    select q.id from poll_group_members(v_poll) q where poll_results_revealed(q.*)
  );

  -- One statement for the group, as close_poll is: the questions stopped at
  -- the same moment and they start again at the same moment. The triggers on
  -- closed_at do the rest -- settle_winner takes back a winner the poll no
  -- longer has, notify_results_ready drops the notice row so a second finish
  -- is announced like the first, and the whole group is broadcast to whoever
  -- has it open.
  --
  -- What this cannot do is take an invite poll back off full turnout: a
  -- question every invitee has answered is revealed whether or not it is
  -- closed, so reopening one leaves its results where they are. That is the
  -- same gate everything else in this schema reads, and the way to take more
  -- votes on such a poll has always been a new one.
  update polls set closed_at = null
  where id in (select q.id from poll_group_members(v_poll) q)
    and closed_at is not null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.open_poll_watch(p_poll_id uuid, p_endpoint text, p_p256dh text, p_auth text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
  v_first polls;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if not push_subscription_valid(p_endpoint, p_p256dh, p_auth) then
    raise exception 'This browser''s push subscription is not one this app can send to';
  end if;

  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  -- Closing is one act over the whole group, so the first question speaks
  -- for all of them. A closed poll has announced whatever it is going to
  -- announce: its results went out, or it had none to send.
  if v_first.closed_at is not null then
    raise exception 'This poll has closed, so there is nothing left to tell you about it';
  end if;

  -- The same kind of bound as an account's twenty devices, for a door with
  -- no account behind it.
  if (select count(*) from poll_push_watches where poll_id = v_first.id) >= 1000
     and not exists (
       select 1 from poll_push_watches where poll_id = v_first.id and endpoint = p_endpoint) then
    raise exception 'This poll cannot take any more notifications';
  end if;

  insert into poll_push_watches (poll_id, endpoint, p256dh, auth)
  values (v_first.id, p_endpoint, p_p256dh, p_auth)
  on conflict (poll_id, endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The reconcilers, and the two doors the browser writes through directly
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.notify_results_ready(p_poll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
  v_first polls;
  v_email text;
  -- The last ballot, the removal that left nobody to wait for, or the Close
  -- button: whichever of them crossed the line, it is this transaction and
  -- this is who is in it.
  v_actor text := lower(auth.jwt() ->> 'email');
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id;

  -- A poll on its way out -- the nightly purge, or the creator's own Delete
  -- button -- has nobody left to tell.
  if not found then
    return;
  end if;

  -- poll_group_members orders by question_position with nulls first, so this
  -- is question 1 of a group and the poll itself when it has no group. It is
  -- the row the invitation names, so the two emails about one poll point at
  -- the same page.
  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  if not poll_results_ready(v_first) then
    -- Back to taking votes. A poll that finishes again is a second result,
    -- and the people in it are told about it again.
    update polls set results_announced_at = null
    where id = v_first.id and results_announced_at is not null;

    -- A poll closed with nobody having voted is finished with nothing to
    -- announce, so its watches will never be answered. Gone now rather than
    -- left on the poll until the purge.
    if v_first.closed_at is not null then
      delete from poll_push_watches where poll_id = v_first.id;
    end if;
    return;
  end if;

  -- The once-only rule, and all of it: two ballots arriving together both run
  -- this, the second waits on the first's row lock, and finds the column set.
  update polls set results_announced_at = now()
  where id = v_first.id and results_announced_at is null;

  if not found then
    return;
  end if;

  -- One request per address rather than one request with every address in it;
  -- see notify_poll_opened.
  for v_email in select * from poll_results_audience(v_first, v_actor) loop
    perform send_results_ready_email(v_first, v_email);
  end loop;

  perform push_poll(v_first, 'results',
    array(select * from poll_results_audience(v_first, v_actor)), true);

  -- A watch has done its job once the results are out. Keeping it would
  -- leave a record on the poll, for the rest of its six months, of a browser
  -- that answered it.
  delete from poll_push_watches where poll_id = v_first.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.send_poll_reminder(p_poll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
  v_first polls;
  v_email text;
  v_actor text := lower(auth.jwt() ->> 'email');
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id and created_by = auth.uid();

  if not found then
    raise exception 'Only the poll creator can send a reminder';
  end if;

  -- Filed against question 1, like every notice: a reminder is about the
  -- poll, whichever question the creator pressed it on.
  select q.* into v_first from poll_group_members(v_poll) q limit 1;

  if v_first.mode <> 'invite' then
    raise exception 'Only a poll with an invite list can send a reminder';
  end if;

  if v_first.closed_at is not null then
    raise exception 'This poll is closed';
  end if;

  if v_first.solicit_options and v_first.options_finalized_at is null then
    raise exception 'This poll is still collecting its options';
  end if;

  if poll_results_revealed(v_first) then
    raise exception 'The results are already out';
  end if;

  -- Asked before removals are taken away, and deliberately: the creator must
  -- not be able to learn who has removed their poll from whether the button
  -- works. A reminder that reaches nobody because everybody left still spends
  -- the poll's one reminder.
  if not exists (
    select 1 from poll_outstanding_invitees(v_first) e
    where e is distinct from v_actor
  ) then
    raise exception 'Everyone invited has already voted';
  end if;

  -- The once-only rule, and all of it: only a poll with no reminder on it
  -- takes one, and a second press racing the first waits for it and finds
  -- the column set.
  update polls set reminder_sent_at = now()
  where id = v_first.id and reminder_sent_at is null;

  if not found then
    raise exception 'A reminder has already been sent for this poll';
  end if;

  -- One request per address, so no invitee sees another's; see
  -- notify_poll_opened.
  for v_email in select * from poll_reminder_audience(v_first, v_actor) loop
    perform send_reminder_email(v_first, v_email);
  end loop;

  -- No watchers: an invite poll has none.
  perform push_poll(v_first, 'reminder',
    array(select * from poll_reminder_audience(v_first, v_actor)), false);
end;
$function$;

CREATE OR REPLACE FUNCTION public.settle_winner(p_poll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
  v_question polls;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id;

  -- A poll on its way out -- the nightly purge, or the creator's own Delete
  -- button -- has no row left to write to, and every ballot cascading after it
  -- arrives here. Same early return, and for the same reason, as
  -- notify_results_ready.
  if not found then
    return;
  end if;

  -- The whole group, not the question that was touched. Results unlock for a
  -- poll of several questions when *all* of them have stopped, so the last
  -- ballot cast on question three is what gives questions one and two their
  -- answers as well; settling only the question that moved would leave those
  -- two blank forever.
  for v_question in select q.* from poll_group_members(v_poll) q loop
    -- The same predicate the three reads report as `results_available`, so a
    -- poll can never say its results are available and have no settled answer
    -- to show. Two conditions written separately would be two chances to
    -- drift.
    if not poll_results_revealed(v_question) then
      -- Back to taking votes. A poll that finishes again is a second result,
      -- and it is worked out from the votes it has then.
      if v_question.winner_settled_at is not null then
        update polls
        set winner_name = null, winner_settled_at = null
        where id = v_question.id;
      end if;

      continue;
    end if;

    -- Already answered, and the answer cannot have changed: every path that
    -- could move this question's tally refuses once its results are out.
    -- revise_ballot and open_poll_revise both check poll_results_revealed;
    -- submit_ballot refuses a closed poll, and an invite poll at full turnout
    -- has nobody left to hear from; guard_invitee_changes refuses a new
    -- invitee once the results are out; and the options were frozen by
    -- guard_options_frozen on the first ballot, with no UPDATE grant on
    -- candidates to rename one afterwards. So this is a skip rather than a
    -- recount, and running the election twice for one result is the thing
    -- this whole migration is about not doing.
    continue when v_question.winner_settled_at is not null;

    update polls
    set winner_name = poll_winner_name(v_question.id),
        winner_settled_at = now()
    where id = v_question.id;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.open_options_when_all_confirmed(p_poll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
begin
  perform lock_poll(p_poll_id);

  select * into v_poll from polls where id = p_poll_id;

  -- Gone, or on its way out behind a cascade.
  if not found then
    return;
  end if;

  if not options_confirmed_by_everyone(v_poll) then
    return;
  end if;

  -- The floor finalize_options applies, applied here as a reason to wait
  -- rather than as an error: one option is not an election, and a poll that
  -- everybody has finished adding to and that still has nothing to vote on is
  -- a poll for its creator to look at.
  if exists (
    select 1
    from poll_group_members(v_poll) q
    left join candidates c on c.poll_id = q.id
    group by q.id
    having count(c.id) < 2
  ) then
    return;
  end if;

  update polls set options_finalized_at = now()
  where id in (select q.id from poll_group_members(v_poll) q)
    and options_finalized_at is null;

  if found then
    perform notify_poll_opened(v_poll.id, true);
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.guard_invitee_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll_id uuid;
  v_invited int;
  v_voted int;
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
$function$;

CREATE OR REPLACE FUNCTION public.guard_options_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_poll polls;
  v_poll_id uuid;
  v_remaining int;
begin
  perform lock_poll(case when tg_op = 'DELETE' then old.poll_id else new.poll_id end);

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

  -- A poll with votes in it is still not something that changes underneath
  -- anybody by accident. What has changed is that there is now a door through
  -- it: the creator's own correction says so in app.editing_options, marks the
  -- poll, and is announced to every reader. Everything else -- a bare delete
  -- through the candidates_delete policy, a suggestion arriving late -- meets
  -- the rule exactly as it always did.
  if exists (select 1 from ballots where poll_id = v_poll_id)
     and coalesce(current_setting('app.editing_options', true), '') <> v_poll_id::text then
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
$function$;


-- An open poll answered signed in is answered by the account, on every device.
--
-- A ballot cast through a share link has always been identified by one thing:
-- the voter_key this browser minted for that question and keeps in
-- localStorage. That made "your vote is in" a fact about a browser. Vote on the
-- laptop, open the same link on the phone, and the phone held no key, so the
-- server had no way to know the ballot was yours: a blank ballot, a question
-- strip with nothing ticked, and no way to change the vote you had cast. The
-- strip's ticks lived in the browser for the same reason (see
-- src/lib/questionMarks.ts), which is what the question that led here was
-- about.
--
-- A reader who is signed in has something better to go on than a browser, so
-- their ballot now carries their account as well: ballots.account_id, and
-- option_confirmations.account_id for the confirmation one stage earlier.
--
-- **A new column, not voter_id.** voter_id means "an invitee's ballot" all
-- over this schema -- the rosters and the published sheet join it to
-- auth.users for an email address, ballots_select_own grants on it, and
-- poll_status reads an open poll's `voted` as false because an open ballot
-- never carries one. account_id is read by the open-poll functions below and
-- nothing else, so none of that moves and no address can reach a roster
-- through it. The check constraint says a row carries one or the other.
--
-- **Who "you" are, on an open poll.** Signed in: the ballot carrying your
-- account, and failing that the ballot this browser's key cast while nobody
-- was signed in -- which is still yours, because this browser cast it.
-- Signed out: the ballot this browser's key cast, whoever it was cast by, as
-- before. open_ballot_of and open_confirmation_of say that once, and every
-- function below asks them rather than restating it.
--
-- **Nothing is claimed after the fact.** A ballot cast signed out stays
-- unlinked when its voter signs in, even when they change it: a ballot is
-- linked to an account if and only if it was cast by one, which is a rule a
-- voter can predict.
--
-- **What it costs, plainly.** An open poll that hides its respondents used to
-- be the stronger of the two anonymity guarantees -- nothing in the database
-- said whose a ballot was. That is now true of a ballot cast signed out, and
-- not of one cast signed in, which is in the database with an account on it
-- exactly as an invite ballot is. Nothing new is shown to anybody: no read
-- returns account_id, and the published sheet still names an open ballot by
-- the name its voter typed or by nothing.
--
-- Every function restated here keeps its argument list, so these are
-- CREATE OR REPLACE and their grants stand. The two new helpers are internal
-- and granted to nobody.

-- ---------------------------------------------------------------------------
-- The columns
-- ---------------------------------------------------------------------------

alter table public.ballots
  add column if not exists account_id uuid references auth.users(id) on delete set null;

alter table public.option_confirmations
  add column if not exists account_id uuid references auth.users(id) on delete set null;

comment on column public.ballots.account_id is
  'The account that cast this ballot through a share link, when somebody was signed in. Null on every invite ballot (which carries voter_id instead) and on an open ballot cast signed out. Read only by the open_poll_* functions, to hand a signed-in voter their own ballot on any device.';

comment on column public.option_confirmations.account_id is
  'The account that confirmed through a share link, when somebody was signed in; the confirmation-stage twin of ballots.account_id.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ballots_one_owner_ck') then
    alter table public.ballots
      add constraint ballots_one_owner_ck check (voter_id is null or account_id is null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'option_confirmations_one_owner_ck') then
    alter table public.option_confirmations
      add constraint option_confirmations_one_owner_ck check (voter_id is null or account_id is null);
  end if;
end $$;

-- One ballot per account per question, which is what "the account's ballot"
-- has to be able to mean. Also the index every lookup below uses.
create unique index if not exists uq_ballots_poll_account
  on public.ballots (poll_id, account_id) where account_id is not null;

create unique index if not exists uq_option_confirmations_poll_account
  on public.option_confirmations (poll_id, account_id) where account_id is not null;

-- ---------------------------------------------------------------------------
-- Whose ballot is this reader's
-- ---------------------------------------------------------------------------

create or replace function public.open_ballot_of(p_poll_id uuid, p_voter_key text)
returns uuid
    language sql stable security definer
    set search_path to 'public'
    as $$
  -- The account's ballot first, and the one this browser cast signed out
  -- after it: a key that cast a ballot under somebody else's account is not
  -- this account's to read, but one nobody was signed in for is this
  -- browser's, and so is its reader's. Signed out there is no account to
  -- ask, and the key is what it always was.
  select b.id
  from ballots b
  where b.poll_id = p_poll_id
    and (
      (auth.uid() is not null and b.account_id = auth.uid())
      or (b.voter_key = nullif(trim(p_voter_key), '')
          and (b.account_id is null or auth.uid() is null))
    )
  order by (b.account_id is not null) desc
  limit 1;
$$;

alter function public.open_ballot_of(uuid, text) owner to "postgres";

comment on function public.open_ballot_of(uuid, text) is
  'The ballot an open poll''s reader cast in this question: the one carrying their account when they are signed in, else the one this browser''s key cast. Internal; the open_poll_* functions are the doors.';

revoke all on function public.open_ballot_of(uuid, text) from public;

create or replace function public.open_confirmation_of(p_poll_id uuid, p_voter_key text)
returns uuid
    language sql stable security definer
    set search_path to 'public'
    as $$
  -- The same rule as open_ballot_of, one stage earlier.
  select oc.id
  from option_confirmations oc
  where oc.poll_id = p_poll_id
    and (
      (auth.uid() is not null and oc.account_id = auth.uid())
      or (oc.voter_key = nullif(trim(p_voter_key), '')
          and (oc.account_id is null or auth.uid() is null))
    )
  order by (oc.account_id is not null) desc
  limit 1;
$$;

alter function public.open_confirmation_of(uuid, text) owner to "postgres";

comment on function public.open_confirmation_of(uuid, text) is
  'The confirmation an open poll''s reader gave on this question, found the way open_ballot_of finds a ballot. Internal.';

revoke all on function public.open_confirmation_of(uuid, text) from public;

-- ---------------------------------------------------------------------------
-- Casting, changing and reading a ballot
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."open_poll_submit"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text", "p_voter_name" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;

CREATE OR REPLACE FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_ballot_id uuid;
begin
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
$$;

COMMENT ON FUNCTION "public"."open_poll_revise"("p_poll_id" "uuid", "p_scores" "jsonb", "p_voter_key" "text") IS 'Replaces the scores on this reader''s ballot -- the one their account cast, on any device, or the one this voter_key cast -- until the poll closes. The voter''s name is not revisable: it is on the roster other people are already reading.';

CREATE OR REPLACE FUNCTION "public"."open_poll_view"("p_poll_id" "uuid", "p_voter_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted int;
  v_options jsonb;
  v_voters jsonb;
  v_ballot_id uuid;
  v_confirmation_id uuid;
  v_your_name text;
  v_your_scores jsonb;
  v_voted_already boolean;
  v_confirmations jsonb;
  v_confirmed_count int;
  v_confirmed boolean;
  v_your_confirmed_name text;
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  select count(*)::int into v_voted from ballots where poll_id = v_poll.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'poll_id', c.poll_id,
    'name', c.name,
    'description', c.description,
    'sort_order', c.sort_order
  ) order by c.sort_order, c.name), '[]'::jsonb)
  into v_options
  from candidates c where c.poll_id = v_poll.id;

  -- Names are visible while voting is still open on purpose: knowing whose
  -- vote is outstanding is the point of a named poll. Ballots are not, in
  -- either setting -- those wait for the close, like the results.
  if v_poll.show_voters then
    select coalesce(jsonb_agg(b.voter_name order by lower(b.voter_name)), '[]'::jsonb)
    into v_voters
    from ballots b
    where b.poll_id = v_poll.id and b.voter_name is not null;
  else
    v_voters := null;
  end if;

  -- Who is done adding options, on the same setting and with none of the
  -- embargo the ballot roster carries: what that embargo protects is the
  -- order ballots arrived in, and while a poll is collecting options there
  -- are no ballots to attach an order to. Alphabetical, like the other one.
  if v_poll.show_voters then
    select coalesce(jsonb_agg(oc.voter_name order by lower(oc.voter_name)), '[]'::jsonb)
    into v_confirmations
    from option_confirmations oc
    where oc.poll_id = v_poll.id and oc.voter_name is not null;
  else
    v_confirmations := null;
  end if;

  -- Through the shared function rather than counted here, so the number the
  -- share link reads and the number an account reads are one number.
  v_confirmed_count := poll_confirmed_count(v_poll.id);

  -- Your own ballot comes back with it, so "change my vote" can hand it to
  -- you filled in without a second request. Reaching it needs the voter_key
  -- that cast it, or the account that did -- which is what lets the phone
  -- hand back a ballot the laptop cast. Nobody else's ballot is readable here
  -- at any stage of any poll. See open_ballot_of.
  v_ballot_id := open_ballot_of(v_poll.id, p_voter_key);
  v_voted_already := v_ballot_id is not null;
  if v_voted_already then
    select
      b.voter_name,
      coalesce(
        (select jsonb_object_agg(s.candidate_id::text, s.score)
         from scores s where s.ballot_id = b.id),
        '{}'::jsonb)
    into v_your_name, v_your_scores
    from ballots b
    where b.id = v_ballot_id;
  end if;

  -- And your own confirmation, reached the same way and for the same reason:
  -- the page has to be able to draw the button you already pressed.
  v_confirmation_id := open_confirmation_of(v_poll.id, p_voter_key);
  v_confirmed := v_confirmation_id is not null;
  if v_confirmed then
    select oc.voter_name into v_your_confirmed_name
    from option_confirmations oc
    where oc.id = v_confirmation_id;
  end if;

  return jsonb_build_object(
    'poll', jsonb_build_object(
      'id', v_poll.id,
      'title', v_poll.title,
      'description', v_poll.description,
      'mode', v_poll.mode,
      'show_voters', v_poll.show_voters,
      'show_ballots', v_poll.show_ballots,
      'solicit_options', v_poll.solicit_options,
      'closed_at', v_poll.closed_at,
      -- When the poll was made, which the poll list needs to know where an
      -- opened poll will fall before it reads: it is ordered newest first,
      -- and the browser remembers the date beside the id (see
      -- src/lib/openedPolls.ts). A date anybody holding the link could already
      -- see the poll exist on, and fixed for its whole life.
      'created_at', v_poll.created_at,
      -- Null on a poll that asks one question, which is what tells the page
      -- to render no question strip rather than a strip of one.
      'group_id', v_poll.group_id,
      'question_position', v_poll.question_position,
      'question_title', v_poll.question_title,
      -- What the ballot is: an ordinary list of options, or a calendar and
      -- the grid to draw it on. Both readings of a poll page need them, and
      -- the account branch of poll_page gets them free from to_jsonb.
      'kind', v_poll.kind,
      'schedule', v_poll.schedule
    ),
    'options', v_options,
    'voted_count', v_voted,
    'is_closed', v_poll.closed_at is not null,
    -- Still gathering options: no ballot yet, and nothing to reveal.
    'soliciting', v_poll.solicit_options
                  and v_poll.options_finalized_at is null
                  and v_poll.closed_at is null,
    -- Open polls reveal only on close, so early votes can never steer late
    -- ones. This is the same promise the invite mode makes, and it is now
    -- the same function answering for both.
    'results_available', poll_results_revealed(v_poll),
    'voted', v_voted_already,
    'your_name', v_your_name,
    'your_scores', v_your_scores,
    'voters', v_voters,
    'confirmed', v_confirmed,
    'your_confirmed_name', v_your_confirmed_name,
    'confirmed_count', v_confirmed_count,
    'confirmations', v_confirmations,
    -- Withheld until the results are out by settle_winner rather than by a
    -- condition here: the column is empty while the poll is still taking
    -- votes, so there is nothing to leak to an early reader.
    'winner_name', v_poll.winner_name,
    'winner_settled', v_poll.winner_settled_at is not null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Saying you are done adding options, and taking it back
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."open_poll_confirm_options"("p_poll_id" "uuid", "p_voter_key" "text", "p_voter_name" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_name text;
  v_key text;
begin
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
$$;

COMMENT ON FUNCTION "public"."open_poll_confirm_options"("p_poll_id" "uuid", "p_voter_key" "text", "p_voter_name" "text") IS 'Records that this reader is done adding options to this open question, under the name they give -- against their account when they are signed in, and this browser''s key either way. Opens nothing: an open poll has no participant list to have all confirmed, so its creator ends the stage as they always did.';

CREATE OR REPLACE FUNCTION "public"."open_poll_unconfirm_options"("p_poll_id" "uuid", "p_voter_key" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
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
$$;

COMMENT ON FUNCTION "public"."open_poll_unconfirm_options"("p_poll_id" "uuid", "p_voter_key" "text") IS 'Takes back this reader''s confirmation -- by their account, or by this browser''s key -- while the poll is still collecting; the share-link half of unconfirm_options.';

-- ---------------------------------------------------------------------------
-- The question strip's marks
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."open_poll_group"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_uid uuid := auth.uid();
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.group_id is null then
    return '[]'::jsonb;
  end if;

  -- The sibling ids, to whoever already holds one of them. They are one
  -- poll: a link to a multi-question poll is a link to all of its questions,
  -- and this is what makes the next one reachable.
  --
  -- **Which ones this reader has answered, only when they are signed in.**
  -- Then their ballots carry their account, which already joins them, so
  -- nothing is linked here that the ballots themselves do not link -- and it
  -- is what ticks the strip on a device that never cast any of them. Signed
  -- out, the only thing that identifies an open ballot is a voter_key minted
  -- per question so that one browser's ballots cannot be joined; answering
  -- would mean taking every key at once and doing that join here, so the
  -- keys are not asked for and the flags are left off. The browser answers
  -- for its own keys (src/lib/questionMarks.ts).
  return (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'question_position', q.question_position,
        'question_title', q.question_title
      )
      || case
           when v_uid is null then '{}'::jsonb
           else jsonb_build_object(
             'voted', exists (
               select 1 from ballots b where b.poll_id = q.id and b.account_id = v_uid),
             'confirmed', exists (
               select 1 from option_confirmations oc
               where oc.poll_id = q.id and oc.account_id = v_uid))
         end
      order by q.question_position), '[]'::jsonb)
    from poll_group_members(v_poll) q
  );
end;
$$;

COMMENT ON FUNCTION "public"."open_poll_group"("p_poll_id" "uuid") IS 'The questions of an open poll, with the id of each, to a caller already holding one of them -- and, for a caller who is signed in, whether their account has voted in and confirmed each. Nothing about a signed-out reader: their ballots are identified by voter keys scoped per question so they cannot be joined, and this function is not the place that undoes it.';

CREATE OR REPLACE FUNCTION "public"."poll_group"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
begin
  -- The same visibility test the rest of the invite side applies: the poll
  -- is yours, or you were invited to it. Every question in a group carries
  -- the same invite list, so seeing one is seeing all of them.
  select p.* into v_poll
  from polls p
  where p.id = p_poll_id
    and (
      p.created_by = auth.uid()
      or exists (select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email)
    );

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.group_id is null then
    return '[]'::jsonb;
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', q.id,
      'question_position', q.question_position,
      'question_title', q.question_title,
      -- What the creator's "Open poll" button needs to apply the floor
      -- finalize_options applies, rather than offering a button that is
      -- refused: opening is one act over every question, so the button has
      -- to know about every question's list and not just this one's.
      'option_count', (select count(*)::int from candidates c where c.poll_id = q.id),
      -- Which questions this reader has already answered. Free on this side:
      -- an invite ballot carries the voter's account, so nothing has to be
      -- linked to find them -- and so does an open ballot its creator cast
      -- signed in, which is the one reader of an open poll this function
      -- serves. See open_poll_group for the share-link side.
      'voted', exists (
        select 1 from ballots b
        where b.poll_id = q.id and (b.voter_id = auth.uid() or b.account_id = auth.uid())
      ),
      -- And which they have finished adding to, which is the same mark for
      -- the stage before the ballot. Free for the same reason. False rather
      -- than null for a creator who is not on the invite list: they have no
      -- confirmation to give, and the strip draws no mark for one they could
      -- not have made.
      'confirmed', exists (
        select 1 from option_confirmations oc
        where oc.poll_id = q.id and (oc.voter_id = auth.uid() or oc.account_id = auth.uid())
      )
    ) order by q.question_position), '[]'::jsonb)
    from poll_group_members(v_poll) q
  );
end;
$$;

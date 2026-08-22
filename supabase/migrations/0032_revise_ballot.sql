-- Changing your vote, up to the moment the results are out.
--
-- A ballot used to be final the second it was cast. Nothing about this app
-- needed it to be: while the results are still sealed nobody has learned
-- anything from anybody's vote, so a voter changing their mind steers nothing
-- and is worth exactly what it costs them to click twice.
--
-- **The window is "the results are not out", and it is not "the poll is still
-- open".** Those are different windows, and the difference is the whole
-- design. An invite poll reveals itself the moment its last invitee votes,
-- with nobody closing anything; a window phrased on `closed_at` would let
-- every voter in a finished poll read the tally, the ranking and the winner
-- and then go back and re-score against it. That is the one thing a revision
-- must never be able to do. `guard_invitee_changes` already draws the line in
-- this exact place -- an invitee may be added until the results are out, not
-- until the poll is closed -- and this is the same line, so the two features
-- rest on one rule rather than two that agree by coincidence.
--
-- `poll_results_revealed()` below is that rule, written once. `poll_status`
-- and `open_poll_view`, which is where the app learns whether the results are
-- out, now answer from it rather than from their own copy of it.
--
-- **A vote can be replaced and never withdrawn.** Every revision is an
-- `update` of the scores already on the ballot: the ballot row stays, so
-- turnout does not move, an invite poll cannot be pushed back below the
-- completion that revealed it, and `is_complete`, the respondent roster and
-- the invitee guards see nothing at all. A delete would undo a reveal, and a
-- reveal in this app is one-way -- `src/lib/settled.ts` caches a finished
-- poll's tally for the life of the tab on exactly that promise.
--
-- **Nothing broadcasts.** There is deliberately no signal here and no trigger
-- on `scores`; see the note above `revise_ballot()`.


-- ---------------------------------------------------------------------------
-- When the results are out
-- ---------------------------------------------------------------------------

alter table "public"."ballots"
  add column if not exists "revised_at" timestamp with time zone;

comment on column "public"."ballots"."revised_at" is
  'When this ballot was last changed, or null if it never was. The scores are overwritten in place, so this is the only trace a revision leaves -- there is no history of what was scored before, which is the same secret ballot the poll promised when it was cast.';


-- The one definition of "the results are out", taking a poll row like
-- poll_expires_at() does.
--
-- Two ways in. Any poll reveals when its creator closes it. An invite poll
-- also reveals on its own once everyone invited has voted, which is the rule
-- that makes "still open" and "still sealed" different things. Either way a
-- poll with no ballots in it has nothing to reveal.
create or replace function "public"."poll_results_revealed"("p_poll" "public"."polls") returns boolean
    language "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select counted.voted > 0 and (
    p_poll.closed_at is not null
    or (p_poll.mode = 'invite' and counted.invited > 0 and counted.voted >= counted.invited)
  )
  from (
    select
      (select count(*) from ballots where poll_id = p_poll.id) as voted,
      (select count(*) from invited_voters where poll_id = p_poll.id) as invited
  ) counted;
$$;

ALTER FUNCTION "public"."poll_results_revealed"("p_poll" "public"."polls") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."poll_results_revealed"("p_poll" "public"."polls") IS 'Whether this poll has shown anybody its tally: closed with a vote in it, or an invite poll everyone invited has voted in. The window for changing a vote and for changing the invitee list both close here.';


-- ---------------------------------------------------------------------------
-- Replacing the scores on a ballot
-- ---------------------------------------------------------------------------

-- The scoring half of a revision, shared by both paths in the way
-- ballot_sheet() is shared by the two ways of reading a poll's ballots.
-- Whoever calls this has already established that this ballot is the
-- caller's and that the poll will accept a change.
--
-- Every score is updated where it sits. The count check and the distinctness
-- check together make the payload a one-to-one match for the option list:
-- without the second, a ballot could be sent two scores for one option and
-- keep its old score on another, which an insert-only path cannot do and an
-- update very much can.
create or replace function "public"."replace_scores"("p_ballot_id" "uuid", "p_poll_id" "uuid", "p_scores" "jsonb") returns "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_option_count int;
  v_named int;
  v_updated int := 0;
  v_rows int;
  v_item jsonb;
  v_candidate_id uuid;
  v_score int;
begin
  select count(*) into v_option_count from candidates where poll_id = p_poll_id;

  if jsonb_array_length(p_scores) is distinct from v_option_count then
    raise exception 'Must submit a score for every option';
  end if;

  select count(distinct (e ->> 'candidate_id')) into v_named
  from jsonb_array_elements(p_scores) e;

  if v_named is distinct from v_option_count then
    raise exception 'Must submit a score for every option';
  end if;

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

    update scores set score = v_score
    where ballot_id = p_ballot_id and candidate_id = v_candidate_id;

    get diagnostics v_rows = row_count;
    v_updated := v_updated + v_rows;
  end loop;

  -- A ballot carries exactly one score per option, so a payload that matched
  -- the option list must have moved every one of them. Anything else means
  -- the ballot and the option list have come apart, and half-rewriting a
  -- ballot is worse than refusing to.
  if v_updated is distinct from v_option_count then
    raise exception 'Invalid option for this poll';
  end if;
end;
$$;

ALTER FUNCTION "public"."replace_scores"("p_ballot_id" "uuid", "p_poll_id" "uuid", "p_scores" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."replace_scores"("p_ballot_id" "uuid", "p_poll_id" "uuid", "p_scores" "jsonb") IS 'Overwrites every score on one ballot, in place. Internal: called from revise_ballot and open_poll_revise, which decide whose ballot it is and whether the poll will take a change.';


-- ---------------------------------------------------------------------------
-- Changing a vote
-- ---------------------------------------------------------------------------

-- The invite poll's revision, the mirror of submit_ballot().
--
-- **This sends no live signal, on purpose.** Every trigger in 0030 exists
-- because something on somebody's screen went stale; nothing here does. What a
-- watcher can see before the results are out is the turnout, the completion
-- and the roster of who has answered, all of them read off `ballots` rows
-- that an update does not move -- and everything derived from `scores` is
-- behind the reveal, past which no revision can happen. A signal would wake
-- every subscriber to re-read a poll and hand each of them the answer they
-- already had, which is the cost 0030 is written to avoid rather than a
-- freshness it is written to buy.
create or replace function "public"."revise_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") returns "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_ballot_id uuid;
begin
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
$$;

ALTER FUNCTION "public"."revise_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."revise_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") IS 'Replaces the scores on the caller''s own ballot in an invite poll, until the results are out. Sends no live signal: nothing visible before the reveal is derived from a score.';


-- The same thing through a share link, the mirror of open_poll_submit().
--
-- The voter_key is what says which ballot is yours, exactly as it does when
-- one is cast. **The name is not revisable**: it is on other people's screens
-- from the moment the ballot lands, in the roster of who has answered, so
-- letting it change here would be the one part of a revision somebody else
-- could see -- and a name quietly becoming a different name mid-poll reads as
-- another person voting rather than as the same person having second
-- thoughts.
create or replace function "public"."open_poll_revise"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text") returns "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_ballot_id uuid;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

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

  select id into v_ballot_id
  from ballots where poll_id = v_poll.id and voter_key = p_voter_key;

  if not found then
    raise exception 'You have not voted in this poll yet';
  end if;

  perform replace_scores(v_ballot_id, v_poll.id, p_scores);

  update ballots set revised_at = now() where id = v_ballot_id;
end;
$$;

ALTER FUNCTION "public"."open_poll_revise"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."open_poll_revise"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text") IS 'Replaces the scores on the ballot this voter_key cast, until the poll closes. The voter''s name is not revisable: it is on the roster other people are already reading.';


-- ---------------------------------------------------------------------------
-- Reading your own ballot back
-- ---------------------------------------------------------------------------

-- What an invite poll's voter scored, so the ballot can be handed back to
-- them filled in rather than blank. Their own ballot and nobody else's, which
-- is why this is a function at all: `authenticated` can select the `ballots`
-- row behind `ballots_select_own` but has no read of `scores` anywhere.
--
-- Asked for only when somebody actually presses "Change my vote", so a poll
-- page still costs what it always did to open.
create or replace function "public"."poll_ballot_scores"("p_poll_id" "uuid") returns "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_ballot_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select id into v_ballot_id
  from ballots where poll_id = p_poll_id and voter_id = auth.uid();

  if not found then
    raise exception 'You have not voted in this poll yet';
  end if;

  return coalesce(
    (select jsonb_object_agg(s.candidate_id::text, s.score)
     from scores s where s.ballot_id = v_ballot_id),
    '{}'::jsonb);
end;
$$;

ALTER FUNCTION "public"."poll_ballot_scores"("p_poll_id" "uuid") OWNER TO "postgres";

COMMENT ON FUNCTION "public"."poll_ballot_scores"("p_poll_id" "uuid") IS 'The caller''s own scores in an invite poll, keyed by option id, for filling their ballot back in. Reads nobody else''s ballot at any stage of any poll.';


-- ---------------------------------------------------------------------------
-- The three places the app already decides whether the results are out
--
-- All replaced here for one reason: each carried its own copy of the rule,
-- and a revision is refused by `poll_results_revealed()` while the button
-- offering it is drawn from whatever these say. Two copies that agree today
-- are a screen offering something the database will refuse tomorrow, so there
-- is now one copy and these read it.
--
-- `assert_results_readable` arrived in 0031 for the same reason one function
-- back -- "four callers repeating a visibility rule is four places for it to
-- drift" -- and this is that argument carried one step further: the rule it
-- was lifted out of is the rule this file needs, so the two meet rather than
-- sitting a function apart. It keeps both of its messages, which say which of
-- the two ways in a poll has not reached; those are wording, and wording is
-- not the rule.
--
-- `open_results_poll_id` is deliberately left alone. Its body is not a copy of
-- this rule: it is two independent conditions in a chosen order, each with its
-- own message, and on an open poll the compound half of the rule is not
-- reachable anyway.
-- ---------------------------------------------------------------------------


CREATE OR REPLACE FUNCTION "public"."assert_results_readable"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_voted int;
begin
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

  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  -- Before the reveal rather than through it: a poll closed with nothing in
  -- it is not "not out yet", it is a poll with no results, and saying it is
  -- waiting on votes that can no longer be cast would be worse than useless.
  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if not poll_results_revealed(v_poll) then
    -- The two ways in, so the reader is told which one this poll has not
    -- reached. An open poll has only the close; an invite poll has the
    -- completion as well, and being told to wait for the close on a poll
    -- that will unlock itself would send its reader to a button they may
    -- not have.
    if v_poll.mode = 'open' then
      raise exception 'Results are not available until the poll is closed';
    end if;
    raise exception 'Results are not available until everyone has voted';
  end if;
end;
$$;


CREATE OR REPLACE FUNCTION "public"."poll_status"("p_poll_id" "uuid") RETURNS TABLE("invited_count" integer, "voted_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean, "expires_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_invited int;
  v_voted int;
begin
  -- The whole row now, since poll_expires_at() takes one. The visibility
  -- test is unchanged: the poll is yours, or you were invited to it.
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

  select count(*)::int into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*)::int into v_voted from ballots where poll_id = p_poll_id;

  return query select
    v_invited,
    v_voted,
    v_invited > 0 and v_voted >= v_invited,
    exists (select 1 from ballots where poll_id = p_poll_id and voter_id = auth.uid()),
    v_poll.closed_at is not null,
    poll_results_revealed(v_poll),
    v_poll.solicit_options and v_poll.options_finalized_at is null and v_poll.closed_at is null,
    poll_expires_at(v_poll);
end;
$$;


CREATE OR REPLACE FUNCTION "public"."open_poll_view"("p_token" "text", "p_voter_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted int;
  v_options jsonb;
  v_voters jsonb;
  v_your_name text;
  v_your_scores jsonb;
  v_voted_already boolean;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

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

  -- Your own ballot comes back with it, so "change my vote" can hand it to
  -- you filled in without a second request. Reaching it needs the voter_key,
  -- which is the same thing that had to be held to cast it; nobody else's
  -- ballot is readable here at any stage of any poll.
  if p_voter_key is null or trim(p_voter_key) = '' then
    v_voted_already := false;
  else
    select
      true,
      b.voter_name,
      coalesce(
        (select jsonb_object_agg(s.candidate_id::text, s.score)
         from scores s where s.ballot_id = b.id),
        '{}'::jsonb)
    into v_voted_already, v_your_name, v_your_scores
    from ballots b
    where b.poll_id = v_poll.id and b.voter_key = p_voter_key;
    v_voted_already := coalesce(v_voted_already, false);
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
      'closed_at', v_poll.closed_at
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
    'voters', v_voters
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- Grants
--
-- replace_scores() is deliberately absent: it decides nothing about who may
-- change what, so nothing outside this file may call it.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION "public"."poll_results_revealed"("p_poll" "public"."polls") FROM PUBLIC;

REVOKE ALL ON FUNCTION "public"."replace_scores"("p_ballot_id" "uuid", "p_poll_id" "uuid", "p_scores" "jsonb") FROM PUBLIC;

REVOKE ALL ON FUNCTION "public"."revise_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."revise_ballot"("p_poll_id" "uuid", "p_scores" "jsonb") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."open_poll_revise"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_revise"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_revise"("p_token" "text", "p_scores" "jsonb", "p_voter_key" "text") TO "authenticated";

REVOKE ALL ON FUNCTION "public"."poll_ballot_scores"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_ballot_scores"("p_poll_id" "uuid") TO "authenticated";

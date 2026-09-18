-- A poll can change its mind, and its results say so.
--
-- Three of this schema's rules were one-way doors, and all three were built
-- the same way: refuse the act, and tell the creator to duplicate the poll.
-- The option list froze on the first ballot, a closed poll stayed closed, and
-- the only way back from either was `reset_poll`, which buys the correction by
-- deleting every vote in the poll.
--
-- That is a stricter promise than this app actually needs to keep. What an
-- election has to protect is the *reader of the result*: nobody should be
-- shown a tally that quietly rests on a list that changed, or on votes cast by
-- people who had already seen the answer. Refusing the edit is one way to keep
-- that promise. Recording it is another, and it is the one that leaves the
-- group with a poll they can still use.
--
-- So both doors open, and each one leaves a mark on the poll it was walked
-- through:
--
--   options_edited_after_votes  the option list was corrected with ballots
--                               already in the box
--   votes_after_reveal          a vote was cast or changed after this poll had
--                               shown somebody its tally
--
-- The results page draws a banner for each, under the winner. They are flags
-- rather than a log on purpose: what a reader needs is to know the tally has a
-- caveat before they act on it, and *which* option was renamed is not
-- something the banner could usefully say — the ballots were secret either
-- way, and a poll keeps no history of what was scored before.
--
-- `reopen_poll` is the third piece: the way back from a close, without the
-- votes going with it. Everything a reopened poll has to forget it already
-- forgets, because closing and reopening are the same column moving and the
-- triggers on it have always reconciled rather than assumed — `settle_winner`
-- takes the winner back off a poll that is taking votes again, and
-- `notify_results_ready` drops the notice row so a second finish is announced
-- like the first.
--
-- `reset_poll` is left exactly as it is. It is no longer offered anywhere in
-- the app — Reset is gone from the Manage poll block, and Duplicate is the
-- true fresh start — but it is still the database's own way of emptying a
-- poll, and the tally suite uses it as one.


-- ---------------------------------------------------------------------------
-- What a poll now remembers about itself
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."polls"
    ADD COLUMN IF NOT EXISTS "options_edited_after_votes" boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS "votes_after_reveal" boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS "reopened_after_reveal" boolean DEFAULT false NOT NULL;


COMMENT ON COLUMN "public"."polls"."options_edited_after_votes" IS 'The creator corrected this question''s option list while it already held ballots. A flag rather than a log: the banner it draws under the results says the tally rests on a list that moved, and which option moved is not something a secret ballot could be asked afterwards. Never cleared -- a poll cannot un-edit a list people have already scored.';


COMMENT ON COLUMN "public"."polls"."votes_after_reveal" IS 'A ballot was cast or changed on this question after its results had been shown. Set by the trigger on ballots, off reopened_after_reveal below, so every door into that table raises it for free.';


COMMENT ON COLUMN "public"."polls"."reopened_after_reveal" IS 'This question was reopened having already shown its tally, which is what makes the next vote a late one. Internal bookkeeping for the flag above: poll_results_revealed is computed from closed_at and turnout, so it goes false the moment the poll reopens and cannot answer "was it ever out" afterwards.';


-- ---------------------------------------------------------------------------
-- A ballot still carries exactly one score per option
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."fill_scores_for_new_option"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- An option added to a poll with ballots in it lands on ballots that were
  -- cast without it, and *one score per option per ballot* is an invariant the
  -- rest of the schema reads rather than checks: replace_scores counts the
  -- rows it moved and refuses a ballot it could only half-rewrite,
  -- poll_ballots publishes a grid, and the CSV is that grid. Left to
  -- themselves those ballots would score the new option nothing at all, which
  -- the tally already reads as zero (poll_tally left-joins scores) and the
  -- other three read as a ballot that has come apart.
  --
  -- So the zero is written down. It is the same number the tally would have
  -- inferred, and it keeps a voter's ability to change their vote: without a
  -- row here, replace_scores would refuse every revision of an older ballot
  -- for the rest of the poll's life.
  --
  -- On the far commoner path -- a poll being created, a list being collected
  -- -- there are no ballots and this inserts nothing.
  insert into scores (ballot_id, candidate_id, score)
  select b.id, new.id, 0
  from ballots b
  where b.poll_id = new.poll_id
  on conflict (ballot_id, candidate_id) do nothing;

  return null;
end;
$$;


ALTER FUNCTION "public"."fill_scores_for_new_option"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."fill_scores_for_new_option"() IS 'Scores an option added to a poll that already has ballots as zero on every one of them, so that "one score per option per ballot" holds through a late correction. Internal: a trigger on candidates.';


CREATE OR REPLACE TRIGGER "candidates_fill_scores" AFTER INSERT ON "public"."candidates" FOR EACH ROW EXECUTE FUNCTION "public"."fill_scores_for_new_option"();


-- ---------------------------------------------------------------------------
-- The option list, corrected later than it used to be
-- ---------------------------------------------------------------------------

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
$$;


COMMENT ON FUNCTION "public"."guard_options_frozen"() IS 'Holds an option list still against every write but the creator''s own correction, and holds a live ballot to two options. Both step aside for the poll named in app.editing_options, whose floor and whose bookkeeping are creator_edit_options''; the floor also steps aside for a poll still collecting, whose checkpoint is finalize_options.';


CREATE OR REPLACE FUNCTION "public"."creator_edit_options"("p_poll_id" "uuid", "p_options" "jsonb" DEFAULT '[]'::"jsonb", "p_remove" "uuid"[] DEFAULT '{}'::"uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_added int := 0;
  v_removed int := 0;
  v_voted boolean;
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

  -- Whether this edit is a late one, asked before it is made. What it changes
  -- is not whether the edit is allowed -- it is, and the creator was shown
  -- what it costs before they pressed anything -- but what the poll says about
  -- itself afterwards.
  select exists (select 1 from ballots where poll_id = p_poll_id) into v_voted;

  -- Transaction-local, and held across both halves of the edit: it names this
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

  -- The card sends the whole list on every save, so most of what arrives here
  -- is the list as it already stands: the mark is for an edit that actually
  -- moved something.
  if v_voted and (v_added > 0 or v_removed > 0) then
    update polls set options_edited_after_votes = true
    where id = p_poll_id and not options_edited_after_votes;
  end if;

  return v_added;
end;
$$;


COMMENT ON FUNCTION "public"."creator_edit_options"("p_poll_id" "uuid", "p_options" "jsonb", "p_remove" "uuid"[]) IS 'The creator''s correction to an option list, both halves of it -- the options to drop and the options to add -- in one transaction, answering how many were added. The two-option floor is applied to what the edit leaves behind rather than to the states it passes through, which is the whole reason it exists beside creator_add_options. An edit that moves something on a poll with ballots in it marks the poll, which is what the results banner is drawn from.';


CREATE OR REPLACE FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_voted boolean;
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
$$;


COMMENT ON FUNCTION "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text") IS 'Adds an option to the creator''s own poll, up until it closes. On a poll that already has ballots the addition is marked, and every ballot already cast scores the new option zero; where the options came from does not enter into it.';


CREATE OR REPLACE FUNCTION "public"."creator_add_options"("p_poll_id" "uuid", "p_options" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
  v_added int;
  v_voted boolean;
begin
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
$$;


COMMENT ON FUNCTION "public"."creator_add_options"("p_poll_id" "uuid", "p_options" "jsonb") IS 'The creator''s correction to an option list that is already a ballot, applied in one go rather than one option per request, and marking the poll when it lands on one with votes in it. Allowed on a time poll, where the names come from a painted calendar; the singular creator_add_option is the typed-name path and still refuses one.';


-- ---------------------------------------------------------------------------
-- The way back from a close
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."reopen_poll"("p_poll_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_poll polls;
begin
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
$$;


ALTER FUNCTION "public"."reopen_poll"("p_poll_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."reopen_poll"("p_poll_id" "uuid") IS 'Puts a closed poll back to taking votes, keeping every ballot in it, for every question at once. Marks the questions whose results were out, so that a vote cast or changed from here says so on the results.';


CREATE OR REPLACE FUNCTION "public"."mark_votes_after_reveal"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- Every way a vote is cast or changed passes through this table -- the two
  -- submit paths insert a ballot, the two revise paths stamp revised_at on one
  -- -- so the flag is raised here rather than in four functions that would
  -- each have to remember to.
  update polls set votes_after_reveal = true
  where id = new.poll_id and reopened_after_reveal and not votes_after_reveal;

  return null;
end;
$$;


ALTER FUNCTION "public"."mark_votes_after_reveal"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."mark_votes_after_reveal"() IS 'Marks a poll whose tally has been seen and whose votes have moved since. Internal: a trigger on ballots.';


CREATE OR REPLACE TRIGGER "ballots_mark_late_votes" AFTER INSERT OR UPDATE ON "public"."ballots" FOR EACH ROW EXECUTE FUNCTION "public"."mark_votes_after_reveal"();


-- ---------------------------------------------------------------------------
-- What the results page is told
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."poll_tally"("p_poll_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_invited int;
  v_voted int;
  v_closed boolean;
  v_mode text;
  v_edited boolean;
  v_late boolean;
  v_options jsonb;
  v_pool uuid[];
  v_head jsonb;
  v_head_finalists uuid[];
begin
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  select closed_at is not null, mode, options_edited_after_votes, votes_after_reveal
  into v_closed, v_mode, v_edited, v_late
  from polls where id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  -- Names and totals for the whole poll, for the score-round list. star_round
  -- recomputes its own pool-scoped copy; these two never disagree, since a
  -- total is a per-option sum that no elimination can change.
  drop table if exists _tally;
  create temp table _tally on commit drop as
  select
    c.id as cid,
    c.name,
    c.description,
    coalesce(sum(s.score), 0)::int as total
  from candidates c
  left join scores s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
  group by c.id, c.name, c.description;

  select coalesce(array_agg(cid), '{}'::uuid[]) into v_pool from _tally;

  -- The head round is the whole of STAR: the score round, its tie-breaks and
  -- the runoff. Everything below first place is poll_ranking's, and is not
  -- computed here.
  v_head := star_round(p_poll_id, v_pool);

  select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_head_finalists
  from jsonb_array_elements_text(v_head->'finalists') x;

  -- Order the score list so a tie-break winner sits above the option it
  -- beat, rather than falling alphabetically below it.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cid,
    'name', name,
    -- Null on nearly every option ever created; the results page shows
    -- nothing at all for those rather than an empty affordance.
    'description', description,
    'total_score', total,
    'average_score', round(total::numeric / v_voted, 2)
  ) order by total desc, (case when cid = any(v_head_finalists) then 0 else 1 end), name), '[]'::jsonb)
  into v_options
  from _tally;

  return jsonb_build_object(
    'options', v_options,
    'finalists', case when jsonb_array_length(v_head->'finalists') = 2
                      then v_head->'finalists'
                      else '[]'::jsonb end,
    'tie', jsonb_array_length(v_head->'tiebreaks') > 0,
    'tiebreaks', v_head->'tiebreaks',
    'runoff', v_head->'runoff',
    'winner_id', v_head->'winner_id',
    'voter_count', v_voted,
    'invited_count', v_invited,
    'mode', v_mode,
    'closed_early', v_closed and v_voted < v_invited,
    -- The two caveats, travelling with the tally they are about. Everyone who
    -- can read the result reads them, through whichever door they came in by:
    -- get_poll_results and open_poll_results are two gates over this one
    -- function.
    'options_edited_after_votes', coalesce(v_edited, false),
    'votes_after_reveal', coalesce(v_late, false)
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- `anon` reaches PostgREST as a member of PUBLIC, and a newly created function
-- is executable by PUBLIC until told otherwise. Reopening is the creator's,
-- like closing; the two trigger functions are nobody's to call.

REVOKE ALL ON FUNCTION "public"."reopen_poll"("p_poll_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reopen_poll"("p_poll_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."fill_scores_for_new_option"() FROM PUBLIC;


REVOKE ALL ON FUNCTION "public"."mark_votes_after_reveal"() FROM PUBLIC;

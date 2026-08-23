-- Page the poll list in the database, and let the visibility filter use an
-- index.
--
-- The list was read whole and paged in the browser. That was defended on the
-- grounds that a poll history is "a number in the tens", which is true of the
-- people this app is for -- but it made every read cost work proportional to
-- everything you had ever been invited to, to draw ten rows. Two things made
-- that worth fixing rather than living with:
--
--   * `list_polls()` runs a pile of correlated subqueries *per poll* -- the
--     invited, voted and option counts, and a bool_and pass over every
--     question in a group for each of `voted`, `is_complete` and
--     `is_closed`. That is the expensive half, and it ran for every poll to
--     show ten of them.
--   * 0035 made the list re-read on any change to any poll on it, not just
--     the ten in front of the reader. The per-read cost started mattering
--     more often, which is what turned this from a footnote into a change.
--
-- So the page is taken *before* the aggregates run: `page` slices `visible`,
-- and `tallied` is computed from `page`. The aggregate work drops from one
-- pass per visible poll to one pass per row on screen.
--
-- What does not drop is `visible` itself, because the total has to come from
-- somewhere and a count is a count. That is the cheap half -- no subqueries,
-- one predicate -- and the index below is what keeps it from being the
-- expensive half instead.

-- The polls you created, findable without reading every poll in the table.
--
-- `created_by` had a foreign key and no index, and Postgres does not create
-- one for a foreign key. So the "mine" half of the visibility test had no
-- index to use, and an OR with an unindexable side cannot become a bitmap
-- union -- which left the planner scanning `polls` in full, every user's
-- polls included, to answer a question about one person's. That is the one
-- cost here that grew with other people's data rather than the caller's, and
-- no amount of paging would have touched it: the filter runs before the page
-- is taken.
CREATE INDEX IF NOT EXISTS "idx_polls_created_by" ON "public"."polls" USING "btree" ("created_by");


-- Dropped rather than replaced: the row type gains `total_count`, and a
-- return type cannot be changed in place.
DROP FUNCTION IF EXISTS "public"."list_polls"();


-- Both arguments are required, and there is deliberately no "all of them"
-- mode. A default page size here would be a second copy of PAGE_SIZE to keep
-- in step with the browser's, and an unlimited mode would be the whole-list
-- read this migration exists to stop being the normal path.
CREATE OR REPLACE FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer) RETURNS TABLE("id" "uuid", "title" "text", "description" "text", "created_by" "uuid", "created_by_email" "text", "created_at" timestamp with time zone, "closed_at" timestamp with time zone, "mode" "text", "show_voters" boolean, "show_ballots" boolean, "solicit_options" boolean, "options_finalized_at" timestamp with time zone, "public_token" "text", "invited_count" integer, "voted_count" integer, "option_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean, "group_id" "uuid", "question_position" integer, "question_title" "text", "question_count" integer, "total_count" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  -- Left as a SQL function rather than plpgsql, as it always was. In plpgsql
  -- the names in RETURNS TABLE become variables that shadow same-named
  -- columns -- `id`, `title`, `voted` and `total_count` all appear below --
  -- and the failure is silent rather than an error. See the note on
  -- poll_winners(), which is plpgsql and has to alias around exactly that.
  with args as (
    -- Floored rather than trusted: a limit of zero or less would ask for an
    -- empty page of a list that has rows in it, and a negative offset is a
    -- syntax error rather than a page.
    select
      greatest(coalesce(p_limit, 1), 1) as lim,
      greatest(coalesce(p_offset, 0), 0) as want
  ), visible as (
    -- The whole row alongside its columns, so the aggregates below can be
    -- handed a poll rather than rebuilding one.
    --
    -- Written out here rather than behind a helper on purpose: a function
    -- call in this predicate is opaque to the planner unless it happens to
    -- inline, and the index this migration adds is only reachable while the
    -- comparison is written where the planner can see it.
    select p.*, p as poll_row
    from polls p
    where (p.group_id is null or p.question_position = 1)
      and (
        p.created_by = auth.uid()
        or exists (
          select 1 from invited_voters iv
          where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
        )
      )
  ), counted as (
    -- The one pass over everything the caller can see. It is the price of
    -- reporting a total at all, and it is the cheap half: one predicate and
    -- no subqueries, against the index this migration adds.
    select count(*)::int as total from visible
  ), bounds as (
    -- Where the requested page actually starts. Asking past the end lands on
    -- the last page there is rather than on nothing: a poll deleted from page
    -- three leaves its reader on page three, or on the last page if that was
    -- it. The browser clamps the page number it displays the same way, from
    -- the same total, so the two cannot disagree about what is on screen.
    select
      c.total,
      least(a.want, greatest(((c.total - 1) / a.lim) * a.lim, 0)) as page_start
    from counted c, args a
  ), page as (
    -- The page is taken here, before a single aggregate has run.
    --
    -- `id` breaks ties on `created_at`, because offset paging is only correct
    -- over a total order: two rows that compare equal may come back in either
    -- order, and then a row can land on two pages or on none, silently. In
    -- the app polls are made one at a time and their timestamps differ, so
    -- this is insurance -- nothing *enforces* that they differ. In the test
    -- suite it is load-bearing: a case is one transaction, so every poll a
    -- case creates shares a created_at to the microsecond.
    select v.*
    from visible v
    order by v.created_at desc, v.id desc
    limit (select a.lim from args a)
    offset (select b.page_start from bounds b)
  ), tallied as (
    select
      v.id as poll_id,
      -- Per question, and the question is the first one: the invite list is
      -- the same on every question, and a turnout that differs between them
      -- is not a number this list has room to reconcile. The card shows the
      -- question count in its place on a grouped poll.
      (select count(*)::int from invited_voters iv where iv.poll_id = v.id) as invited_count,
      (select count(*)::int from ballots b where b.poll_id = v.id) as voted_count,
      (select count(*)::int from candidates c where c.poll_id = v.id) as option_count,
      (select count(*)::int from poll_group_members(v.poll_row)) as question_count,
      -- Asked of every question: a poll is answered when all of it is.
      (select bool_and(
                exists (select 1 from ballots b where b.poll_id = q.id and b.voter_id = auth.uid()))
         from poll_group_members(v.poll_row) q) as voted,
      (select bool_and(
                (select count(*) from invited_voters iv where iv.poll_id = q.id) > 0
                and (select count(*) from ballots b where b.poll_id = q.id)
                    >= (select count(*) from invited_voters iv where iv.poll_id = q.id))
         from poll_group_members(v.poll_row) q) as is_complete,
      (select bool_and(q.closed_at is not null)
         from poll_group_members(v.poll_row) q) as is_closed
    from page v
  )
  select
    v.id,
    v.title,
    v.description,
    v.created_by,
    v.created_by_email,
    v.created_at,
    v.closed_at,
    v.mode,
    v.show_voters,
    v.show_ballots,
    v.solicit_options,
    v.options_finalized_at,
    v.public_token,
    t.invited_count,
    t.voted_count,
    t.option_count,
    t.is_complete,
    t.voted,
    t.is_closed,
    poll_results_revealed(v.poll_row),
    v.solicit_options and v.options_finalized_at is null and v.closed_at is null,
    v.group_id,
    v.question_position,
    v.question_title,
    t.question_count,
    (select c.total from counted c)
  from page v
  join tallied t on t.poll_id = v.id
  order by v.created_at desc, v.id desc;
$$;


-- The same grants the function had before it took arguments: owned by
-- postgres, executable by authenticated. Deliberately not revoked from
-- PUBLIC, because the old one was not either -- tightening that is a
-- decision about access, and this migration is about work, so it should not
-- arrive hidden inside one. An unauthenticated caller sees no polls anyway:
-- auth.uid() is null, so neither half of the visibility test can match.
ALTER FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer) OWNER TO "postgres";
GRANT ALL ON FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer) TO "authenticated";


COMMENT ON FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer) IS 'One page of the caller''s poll list, newest first, with the total on every row. The page is taken before the per-poll aggregates run, so the work is proportional to the rows returned rather than to everything the caller can see. An offset past the end returns the last page there is.';

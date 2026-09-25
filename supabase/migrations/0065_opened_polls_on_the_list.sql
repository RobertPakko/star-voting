-- The poll list carries the open polls this browser has opened.
--
-- `list_polls` used to answer with two kinds of poll: the ones you made, and
-- the ones you were invited to. An open poll somebody else made was on
-- neither list however many times you had voted in it, so the only way back
-- to one was the link it arrived by -- a chat scrolled away, an email, a QR
-- code on a projector that has been switched off.
--
-- Which open polls a reader has opened is remembered by the browser rather
-- than stored here (src/lib/openedPolls.ts, and "Open polls you have opened"
-- in AGENTS.md for why), so the list takes them as an argument. The database
-- still decides what the list holds: only an open poll qualifies, and a row
-- that is there only because its id was handed in carries no creator.
--
-- Taking them here rather than reading each one in the browser keeps the list
-- one request, one order and one pager: an opened poll lands among the rest by
-- `created_at`, on the page it belongs on, and is counted in the total.
--
-- A new parameter is a new function -- a different argument list is a
-- different overload, and leaving the old one beside it would make every
-- two-argument call ambiguous -- so the old one is dropped, and a dropped
-- function takes its grants with it. The REVOKE from PUBLIC is restated for
-- the reason 0055 restated it on create_poll: a function created fresh is
-- executable by PUBLIC, which is `anon` through PostgREST.
--
-- The new argument defaults to nothing, so a two-argument call -- every
-- browser still holding the build before this one -- is answered exactly as
-- it was.

DROP FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer);

CREATE FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer, "p_open_ids" "uuid"[] DEFAULT '{}'::"uuid"[]) RETURNS TABLE("id" "uuid", "title" "text", "description" "text", "created_by" "uuid", "created_by_email" "text", "created_at" timestamp with time zone, "closed_at" timestamp with time zone, "mode" "text", "show_voters" boolean, "show_ballots" boolean, "solicit_options" boolean, "options_finalized_at" timestamp with time zone, "invited_count" integer, "voted_count" integer, "option_count" integer, "confirmed_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean, "group_id" "uuid", "question_position" integer, "question_title" "text", "question_count" integer, "winner_name" "text", "winner_settled" boolean, "total_count" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  -- Left as a SQL function rather than plpgsql, as it always was. In plpgsql
  -- the names in RETURNS TABLE become variables that shadow same-named
  -- columns -- `id`, `title`, `voted`, `winner_name` and `total_count` all
  -- appear below -- and the failure is silent rather than an error. See the
  -- note on poll_winners(), which is plpgsql and has to alias around exactly
  -- that.
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
    -- inline, and the index 0036 added is only reachable while the
    -- comparison is written where the planner can see it.
    --
    -- The third way onto the list is an open poll this browser has opened
    -- through its link, which the browser remembers and hands in as
    -- `p_open_ids` (see src/lib/openedPolls.ts). Holding an open poll's id is
    -- already the whole of the right to read it -- `open_poll_view` answers
    -- to nothing else -- so listing one here shows the reader nothing they
    -- could not have asked for. `mode = 'open'` is what keeps it at that: an
    -- invite poll's id in the array lists nothing, however it was come by.
    -- It is an `id = any(...)`, which the primary key serves, so the `OR`
    -- stays a bitmap union rather than a scan.
    --
    -- `via_link` marks the rows that are here only for that reason, so the
    -- columns below can withhold what a link does not carry.
    select p.*, p as poll_row,
      not (
        p.created_by = auth.uid()
        or exists (
          select 1 from invited_voters iv
          where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
        )
      ) as via_link
    from polls p
    where (p.group_id is null or p.question_position = 1)
      and (
        p.created_by = auth.uid()
        or exists (
          select 1 from invited_voters iv
          where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
        )
        or (p.mode = 'open' and p.id = any(coalesce(p_open_ids, '{}')))
      )
  ), counted as (
    -- The one pass over everything the caller can see. It is the price of
    -- reporting a total at all, and it is the cheap half: one predicate and
    -- no subqueries, against that same index.
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
      -- The same, and per question for the same reason. It is what the count
      -- badge reports while the poll is still collecting, in place of the
      -- turnout that has not started moving yet.
      poll_confirmed_count(v.id) as confirmed_count,
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
    -- Nobody reading an open poll through its link is told who made it:
    -- `open_poll_view` does not return the address, and this list must not
    -- become the way round that. The creator's account id goes with it,
    -- since it names the same person to anybody who can match it up.
    case when v.via_link then null else v.created_by end,
    case when v.via_link then null else v.created_by_email end,
    v.created_at,
    v.closed_at,
    v.mode,
    v.show_voters,
    v.show_ballots,
    v.solicit_options,
    v.options_finalized_at,
    t.invited_count,
    t.voted_count,
    t.option_count,
    t.confirmed_count,
    t.is_complete,
    t.voted,
    t.is_closed,
    poll_results_revealed(v.poll_row),
    v.solicit_options and v.options_finalized_at is null and v.closed_at is null,
    v.group_id,
    v.question_position,
    v.question_title,
    t.question_count,
    -- A group's row here *is* its first question, so this is that question's
    -- winner rather than the poll's -- a poll of several questions has one
    -- answer each and none to put beside its title. The badge withholds it on
    -- `question_count > 1` and always did; see PollStateBadge, which decides
    -- that in one place rather than trusting three callers to remember.
    v.winner_name,
    v.winner_settled_at is not null,
    (select c.total from counted c)
  from page v
  join tallied t on t.poll_id = v.id
  order by v.created_at desc, v.id desc;
$$;


ALTER FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer, "p_open_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer, "p_open_ids" "uuid"[]) IS 'One page of the caller''s poll list, newest first, with the total on every row: the polls they made, the polls they are invited to, and any open poll named in p_open_ids -- the open polls this browser has opened through their links, which carry no creator. The page is taken before the per-poll aggregates run, so the work is proportional to the rows returned rather than to everything the caller can see. An offset past the end returns the last page there is.';


REVOKE ALL ON FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer, "p_open_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer, "p_open_ids" "uuid"[]) TO "authenticated";

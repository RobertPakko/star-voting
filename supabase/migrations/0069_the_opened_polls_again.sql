-- Re-asserts the four definitions the live project never received.
--
-- 0065_opened_polls_on_the_list, 0066_a_deleted_poll_says_so and
-- 0067_open_poll_view_says_when reached main on 2026-09-25 and were never
-- applied: the Supabase integration had been refusing every run since the
-- squash at 0063 earlier the same day, with "Remote migration versions not
-- found in local migrations directory" -- the remote's history named versions
-- (0060 to 0063 at least) whose files the squash had deleted. The second
-- squash then folded all three into 0067_baseline.sql, which a remote that is
-- told 0067 is applied will never run.
--
-- So this is a repair in the sense AGENTS.md means by it ("A version number
-- is used once, ever", and 0058_schedule_options_again.sql before it): the
-- definitions are copied verbatim out of 0067_baseline.sql, grants included,
-- and on a database that already has them -- a fresh build of these
-- migrations, which is what `npm test` runs -- it changes nothing. Checked by
-- the schema fingerprint in AGENTS.md, before and after.
--
-- The one statement that is not a copy is the DROP. The live project still has
-- the two-argument list_polls, and a three-argument one created beside it
-- would make every two-argument call ambiguous between the two. On a database
-- that is already right there is no two-argument list_polls, and the DROP ...
-- IF EXISTS does nothing.
--
-- What arrives with it: open polls a browser has opened on the poll list
-- (list_polls' p_open_ids), a deleted poll telling its own topic
-- (broadcast_poll_gone, and announce keyed on topic and event), and
-- open_poll_view carrying created_at.

DROP FUNCTION IF EXISTS "public"."list_polls"("p_limit" integer, "p_offset" integer);

CREATE OR REPLACE FUNCTION "public"."list_polls"("p_limit" integer, "p_offset" integer, "p_open_ids" "uuid"[] DEFAULT '{}'::"uuid"[]) RETURNS TABLE("id" "uuid", "title" "text", "description" "text", "created_by" "uuid", "created_by_email" "text", "created_at" timestamp with time zone, "closed_at" timestamp with time zone, "mode" "text", "show_voters" boolean, "show_ballots" boolean, "solicit_options" boolean, "options_finalized_at" timestamp with time zone, "invited_count" integer, "voted_count" integer, "option_count" integer, "confirmed_count" integer, "is_complete" boolean, "voted" boolean, "is_closed" boolean, "results_available" boolean, "soliciting" boolean, "group_id" "uuid", "question_position" integer, "question_title" "text", "question_count" integer, "winner_name" "text", "winner_settled" boolean, "total_count" integer)
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

CREATE OR REPLACE FUNCTION "public"."announce"("p_topic" "text", "p_event" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_told text := coalesce(current_setting('app.announced', true), '');
  -- The event is part of the key: a topic told that a poll changed has still
  -- not been told that it has gone. `|` cannot appear in either half -- a
  -- topic is a fixed prefix and a uuid, an event a fixed word.
  v_key text := '|' || p_topic || '|' || p_event || '|';
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
COMMENT ON FUNCTION "public"."announce"("p_topic" "text", "p_event" "text") IS 'Tells one topic that something happened, at most once per topic and event per transaction. Every live-update message goes through here: the payload is empty and nothing reaches a listener before the commit, so a second message from the same transaction is a wasted round trip rather than news. Internal.';
REVOKE ALL ON FUNCTION "public"."announce"("p_topic" "text", "p_event" "text") FROM PUBLIC;

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

  -- Whoever has the poll itself open. Under an event of its own, because
  -- `poll_changed` means "re-read" and a re-read of a poll that has gone is a
  -- read that fails; `poll_deleted` is the answer rather than a prompt to go
  -- and find one. A group goes out question by question through this same
  -- trigger, and each question's page is watching its own topic, so each
  -- one is told.
  perform announce('poll:' || old.id::text, 'poll_deleted');

  -- The audience broadcast_poll_change() reaches, read while it can still be
  -- read. `union` rather than `union all`: a creator who invited themselves
  -- is one reader with one list.
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
COMMENT ON FUNCTION "public"."broadcast_poll_gone"() IS 'Tells whoever has this poll open that it has gone (poll_deleted on its own topic), and the list of everyone who can see it that it is going, while its invitee list still exists to be read. Once per topic per transaction, so a group of questions going out together reaches each list once. Silent under the nightly purge. Internal: the BEFORE DELETE trigger on polls, never called by a client.';
REVOKE ALL ON FUNCTION "public"."broadcast_poll_gone"() FROM PUBLIC;

CREATE OR REPLACE FUNCTION "public"."open_poll_view"("p_poll_id" "uuid", "p_voter_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
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
  -- you filled in without a second request. Reaching it needs the voter_key,
  -- which is the same thing that had to be held to cast it; nobody else's
  -- ballot is readable here at any stage of any poll.
  if p_voter_key is null or trim(p_voter_key) = '' then
    v_voted_already := false;
    v_confirmed := false;
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

    -- And your own confirmation, reached with the same key and for the same
    -- reason: the page has to be able to draw the button you already pressed.
    select true, oc.voter_name
    into v_confirmed, v_your_confirmed_name
    from option_confirmations oc
    where oc.poll_id = v_poll.id and oc.voter_key = p_voter_key;
    v_confirmed := coalesce(v_confirmed, false);
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

ALTER FUNCTION "public"."open_poll_view"("p_poll_id" "uuid", "p_voter_key" "text") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."open_poll_view"("p_poll_id" "uuid", "p_voter_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_poll_view"("p_poll_id" "uuid", "p_voter_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_poll_view"("p_poll_id" "uuid", "p_voter_key" "text") TO "authenticated";


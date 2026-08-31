-- Polls that find a time instead of choosing an option.
--
-- The whole of the idea is that there is no new machinery: a `time` poll is a
-- poll whose options happen to be the start of a meeting window, enumerated in
-- the browser when the poll is created and rated 0-5 like any other option.
-- `poll_tally`, `star_round`, `settle_winner`, the RLS policies, the voter-key
-- path, ballot revision and the live stream are untouched, because none of
-- them knows what an option means.
--
-- What the database gains is four things: somewhere to say that a poll is one
-- of these and how its grid is laid out, an option ceiling a day's worth of
-- windows fits under, an index the tie-break block needs once ties become the
-- common case rather than the rare one, and the two columns carried through
-- the reads the front end draws from.


-- ---------------------------------------------------------------------------
-- 1. What kind of poll this is, and how its grid is laid out
-- ---------------------------------------------------------------------------

alter table "public"."polls"
  add column if not exists "kind" text not null default 'option',
  add column if not exists "schedule" jsonb;

-- Spelled the way `mode` is, for the same reason: a column with two values in
-- it is a column the reader can enumerate, and a boolean called `is_time`
-- would have to be renamed the first time there is a third kind.
alter table "public"."polls"
  drop constraint if exists "polls_kind_ck";
alter table "public"."polls"
  add constraint "polls_kind_ck" check (("kind" = any (array['option'::text, 'time'::text])));

-- Tied together the way polls_question_ck ties the question columns together:
-- a `time` poll without a schedule has a grid nobody can draw, and an
-- `option` poll with one is carrying configuration for a ballot it does not
-- have. Neither is a state the app can produce, so neither is a state the
-- table will hold.
alter table "public"."polls"
  drop constraint if exists "polls_schedule_ck";
alter table "public"."polls"
  add constraint "polls_schedule_ck" check (
    (("kind" = 'option'::text) and ("schedule" is null))
    or (("kind" = 'time'::text) and ("schedule" is not null))
  );

comment on column "public"."polls"."kind" is
  'What the poll is choosing between. ''option'' is an ordinary ballot; ''time'' is a poll whose options are the start of a meeting window and whose ballot is a calendar. A setting, frozen at creation like mode.';

comment on column "public"."polls"."schedule" is
  'How a time poll''s grid is laid out: {timezone, window: {start, end}, desired_slots, granularity}. Only what cannot be recovered from the options -- the in-bounds days are exactly the dates the options start on, so the client derives those and the two can never disagree. Null on an option poll; required on a time poll.';


-- ---------------------------------------------------------------------------
-- 2. What a schedule has to say to be one
-- ---------------------------------------------------------------------------

create or replace function "public"."validate_schedule"("p_schedule" jsonb) returns void
    language plpgsql immutable
    set "search_path" to 'public'
    as $$
declare
  v_start text := p_schedule #>> '{window,start}';
  v_end text := p_schedule #>> '{window,end}';
  v_slots int;
  v_granularity int;
begin
  if p_schedule is null or jsonb_typeof(p_schedule) <> 'object' then
    raise exception 'A time poll needs a schedule';
  end if;

  -- A fixed offset, never a named zone. A named zone spanning a DST
  -- transition gives one day 23 or 25 hours and a 1am that happens twice or
  -- not at all, which makes the generated option names ambiguous in precisely
  -- the way declaring a timezone was meant to prevent.
  if coalesce(p_schedule ->> 'timezone', '') !~ '^[+-][0-9]{2}:[0-9]{2}$' then
    raise exception 'A schedule''s timezone is a fixed UTC offset, like -07:00';
  end if;

  -- 24:00 is allowed as a time of day here, and only ever as the end: a
  -- window that runs to midnight is an ordinary thing to want, and '00:00'
  -- would say the day before's midnight. The v_end > v_start check below is
  -- what keeps it out of the start.
  if coalesce(v_start, '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
     or coalesce(v_end, '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' then
    raise exception 'A schedule''s daily window is two times, like 08:00 and 22:00';
  end if;

  if v_end <= v_start then
    raise exception 'A schedule''s daily window has to end after it starts';
  end if;

  -- jsonb_typeof rather than a cast, because `'"3"'::jsonb ->> …` casts
  -- happily and a string where a number belongs is exactly the kind of drift
  -- this is here to catch.
  if jsonb_typeof(p_schedule -> 'granularity') <> 'number'
     or jsonb_typeof(p_schedule -> 'desired_slots') <> 'number' then
    raise exception 'A schedule''s granularity and desired_slots are numbers';
  end if;

  v_granularity := (p_schedule ->> 'granularity')::int;
  v_slots := (p_schedule ->> 'desired_slots')::int;

  -- The calendar draws a row per granule, and a granule that does not divide
  -- the hour draws a grid whose lines do not line up with the labels beside
  -- it. The same rule @mantine/schedule applies to intervalMinutes.
  if v_granularity < 1 or (60 % v_granularity <> 0 and v_granularity % 60 <> 0) then
    raise exception 'A schedule''s granularity divides an hour evenly, or is a whole number of hours';
  end if;

  if v_slots < 1 then
    raise exception 'A meeting is at least one granule long';
  end if;
end;
$$;

alter function "public"."validate_schedule"("p_schedule" jsonb) owner to "postgres";

comment on function "public"."validate_schedule"("p_schedule" jsonb) is
  'Raises unless the jsonb handed in is a schedule a calendar can be drawn from. The front end enumerates the options, so nothing here can check that they agree with it; what it can check is that the grid itself is describable. Internal.';


-- ---------------------------------------------------------------------------
-- 3. The option ceiling
-- ---------------------------------------------------------------------------

-- A day of half-hour starts inside a fourteen-hour window is twenty-five
-- options, and a working week of them is over a hundred and twenty. Fifty was
-- a ceiling on how long a list a person can read to the end before scoring
-- any of it, which is the right question to ask of a list of options and the
-- wrong one to ask of a calendar: nobody reads a grid, they scan it.
--
-- Raised for every poll rather than only for the new kind. One number is one
-- thing to keep in step -- see MAX_OPTIONS in src/lib/limits.ts -- and a
-- ballot long enough to be a problem was never going to be stopped at the
-- fiftieth option anyway.
create or replace function "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") returns void
    language plpgsql security definer
    set "search_path" to 'public'
    as $$
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
  if length(v_name) > 150 then
    raise exception 'That option name is too long';
  end if;

  if length(v_description) > 900 then
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

  -- The ceiling is a ceiling on what the tally can be asked to do in the time
  -- a voter is waiting for it, rather than on what a reader will put up with.
  if v_count >= 500 then
    raise exception 'This poll already has as many options as it can hold';
  end if;

  -- Arrival order, which is the order everyone watching the page has been
  -- reading the list in already.
  insert into candidates (poll_id, name, description, sort_order)
  values (p_poll.id, v_name, v_description, v_next);
end;
$$;

comment on function "public"."insert_option"("p_poll" "public"."polls", "p_name" "text", "p_description" "text") is
  'The field rules for one option -- name, description, duplicates, the 500-option ceiling -- shared by the suggestion path and the creator''s own. Internal: the caller has already decided it may write to this poll.';


-- ---------------------------------------------------------------------------
-- 4. The index the tie-break block needs, which is already there
-- ---------------------------------------------------------------------------

-- Nothing to add. `scores` already has a btree on (ballot_id, candidate_id) --
-- the index behind its UNIQUE constraint -- and EXPLAIN shows star_round's
-- tie-break block using it. See "A poll that finds a time" in AGENTS.md for
-- what the worst case does cost, which is the pair build rather than the
-- lookups, and for the measurements.


-- ---------------------------------------------------------------------------
-- 5. Creating one
-- ---------------------------------------------------------------------------

-- Both gain the two columns, so the old signatures go rather than sitting
-- beside the new ones as an overload nothing could resolve.
drop function if exists "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid", "p_question_position" integer);

drop function if exists "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean);

create or replace function "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid" DEFAULT NULL::"uuid", "p_question_position" integer DEFAULT NULL::integer, "p_kind" "text" DEFAULT 'option'::"text", "p_schedule" "jsonb" DEFAULT NULL::"jsonb") returns "uuid"
    language plpgsql security definer
    set "search_path" to 'public'
    as $$
declare
  v_poll_id uuid;
  v_opts jsonb;
  v_item jsonb;
  i int;
begin
  -- A title is a line at the top of a card, and a description is the
  -- paragraph under it. Both callers have trimmed by the time they arrive.
  if length(p_title) > 100 then
    raise exception 'That title is too long';
  end if;

  if length(p_description) > 500 then
    raise exception 'That description is too long';
  end if;

  -- Drop blanks but keep the author's ordering, carrying each option's
  -- description along with it.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'name', trim(o ->> 'name'),
             'description', nullif(trim(coalesce(o ->> 'description', '')), '')
           ) order by ord), '[]'::jsonb)
  into v_opts
  from jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) with ordinality as t(o, ord)
  where trim(coalesce(o ->> 'name', '')) <> '';

  -- A poll collecting its options is allowed to start with none; the same
  -- minimum is applied by finalize_options, when the list becomes a ballot.
  if not p_solicit_options and jsonb_array_length(v_opts) < 2 then
    raise exception 'Add at least two options';
  end if;

  -- The ceiling insert_option applies, applied here too. This path inserts
  -- into `candidates` directly and checked nothing, so a poll created over
  -- the cap up front was accepted while the same poll built one option at a
  -- time was refused -- and the calendar is the first thing that can produce
  -- a list long enough to find that gap.
  if jsonb_array_length(v_opts) > 500 then
    raise exception 'A poll can hold 500 options; this one has %', jsonb_array_length(v_opts);
  end if;

  insert into polls (
    title, description, created_by, mode, show_voters, show_ballots,
    solicit_options, group_id, question_position, question_title, kind, schedule
  )
  values (
    p_title, p_description, auth.uid(), p_mode, p_show_voters, p_show_ballots,
    p_solicit_options, p_group_id, p_question_position, p_question_title, p_kind, p_schedule
  )
  returning id into v_poll_id;

  for i in 0 .. jsonb_array_length(v_opts) - 1 loop
    v_item := v_opts -> i;
    insert into candidates (poll_id, name, description, sort_order)
    values (v_poll_id, v_item ->> 'name', v_item ->> 'description', i);
  end loop;

  -- Every question carries the whole invite list, because that list is what
  -- the row-level security on this question's options and ballots reads.
  if p_mode = 'invite' then
    for i in 1 .. coalesce(array_length(p_emails, 1), 0) loop
      insert into invited_voters (poll_id, email) values (v_poll_id, p_emails[i]);
    end loop;
  end if;

  return v_poll_id;
end;
$$;

alter function "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid", "p_question_position" integer, "p_kind" "text", "p_schedule" "jsonb") owner to "postgres";

-- Not decoration, and the reason it is spelled out on both of the functions
-- this migration drops: Postgres grants EXECUTE to PUBLIC on a newly created
-- function, and 0053 had revoked exactly that from both. A CREATE OR REPLACE
-- keeps the old ACL and would not have needed this -- but neither of these
-- could be replaced, because each gained defaulted parameters and would
-- otherwise have stood beside its old self as an ambiguous overload. So they
-- were dropped, and a dropped function takes its grants with it.
--
-- Without this line `anon` can reach `create_poll` through PostgREST. It is
-- refused by the `auth.uid() is null` check on the first line of the body, so
-- nothing is writable either way -- but "an internal function is not exposed"
-- and "an internal function is exposed and says no" are not the same posture,
-- and this app grants `anon` nothing but the `open_poll_*` functions.
revoke all on function "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid", "p_question_position" integer, "p_kind" "text", "p_schedule" "jsonb") from public;

comment on function "public"."insert_poll_row"("p_title" "text", "p_description" "text", "p_question_title" "text", "p_options" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean, "p_group_id" "uuid", "p_question_position" integer, "p_kind" "text", "p_schedule" "jsonb") is
  'One poll row with its options and its invitees, for the two functions that create polls. Internal: it checks the title, the description and the option list, because its callers have checked the rest.';


create or replace function "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text" DEFAULT 'invite'::"text", "p_show_voters" boolean DEFAULT true, "p_show_ballots" boolean DEFAULT false, "p_option_descriptions" "text"[] DEFAULT NULL::"text"[], "p_solicit_options" boolean DEFAULT false, "p_kind" "text" DEFAULT 'option'::"text", "p_schedule" "jsonb" DEFAULT NULL::"jsonb") returns "uuid"
    language plpgsql security definer
    set "search_path" to 'public'
    as $$
declare
  v_opts jsonb;
  v_mails text[];
  v_kind text := coalesce(p_kind, 'option');
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_mode is null or p_mode not in ('invite', 'open') then
    raise exception 'Unknown poll mode';
  end if;

  if v_kind not in ('option', 'time') then
    raise exception 'Unknown poll kind';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'Title is required';
  end if;

  if v_kind = 'time' then
    perform validate_schedule(p_schedule);

    -- Off for now, and refused here rather than only hidden in the form.
    -- A voter "adding Thursday" adds a dozen options -- one per window start
    -- -- and the suggestion path inserts one at a time, so a run that fails
    -- halfway leaves a Thursday with morning windows and no afternoon.
    -- Turning it on means making that insertion atomic first.
    if coalesce(p_solicit_options, false) then
      raise exception 'A time poll cannot collect its times from voters';
    end if;
  elsif p_schedule is not null then
    raise exception 'Only a time poll has a schedule';
  end if;

  if p_mode = 'invite' then
    v_mails := normalize_invite_emails(p_emails);
  end if;

  -- Paired by position, so a description can only ever belong to the option
  -- it was written for; insert_poll_row drops the blanks from the pairs.
  select coalesce(jsonb_agg(
           jsonb_build_object('name', o, 'description', p_option_descriptions[ord])
           order by ord), '[]'::jsonb)
  into v_opts
  from unnest(coalesce(p_options, array[]::text[])) with ordinality as t(o, ord);

  return insert_poll_row(
    trim(p_title),
    nullif(trim(coalesce(p_description, '')), ''),
    null,
    v_opts,
    v_mails,
    p_mode,
    coalesce(p_show_voters, true),
    coalesce(p_show_ballots, false),
    coalesce(p_solicit_options, false),
    null,
    null,
    v_kind,
    case when v_kind = 'time' then p_schedule else null end
  );
end;
$$;

alter function "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb") owner to "postgres";

comment on function "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb") is
  'Creates one poll with its options and its invitees. A time poll carries a schedule and options its creator''s browser enumerated from it; the database stores it exactly as it stores any other poll.';

-- Revoked from PUBLIC before it is granted to anybody, for the reason spelled
-- out on insert_poll_row above. The order matters only for readability: this
-- is the same pair of statements 0053 has for the old signature.
revoke all on function "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb") from public;

grant all on function "public"."create_poll"("p_title" "text", "p_description" "text", "p_options" "text"[], "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_option_descriptions" "text"[], "p_solicit_options" boolean, "p_kind" "text", "p_schedule" "jsonb") to "authenticated";


-- A group is a set of questions sharing one invite list and one set of
-- settings, and a time poll's ballot is a calendar of its own; the two are
-- not yet a combination the front end can draw. `create_poll_group` takes no
-- kind, so every question it makes is an ordinary one -- this says so where
-- somebody reading it would otherwise have to work it out from the absence.
comment on function "public"."create_poll_group"("p_title" "text", "p_description" "text", "p_questions" "jsonb", "p_emails" "text"[], "p_mode" "text", "p_show_voters" boolean, "p_show_ballots" boolean, "p_solicit_options" boolean) is
  'Creates a poll that asks several questions: one poll row per question, sharing a group, a title, a description, an invite list and their settings. One transaction. A soliciting group collects options question by question and opens all of them at once; see finalize_options. Every question is an option poll -- a time poll asks one question.';


-- The creator's own correction to an option list, which on a time poll would
-- be a hand-typed name among generated ones: not a window, not scoreable by
-- the calendar, and not something the grid can draw. The form hides the
-- control; this is what makes it true.
create or replace function "public"."creator_add_option"("p_poll_id" "uuid", "p_name" "text", "p_description" "text" DEFAULT NULL::"text") returns void
    language plpgsql security definer
    set "search_path" to 'public'
    as $$
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

  if v_poll.kind = 'time' then
    raise exception 'A time poll''s options are its windows; change its schedule instead';
  end if;

  -- The trigger says this too, and would refuse the insert on its own. Saying
  -- it here is what makes the message the one the creator can act on.
  if exists (select 1 from ballots where poll_id = p_poll_id) then
    raise exception 'Cannot change the options of a poll that already has votes';
  end if;

  perform insert_option(v_poll, p_name, p_description);
end;
$$;


-- ---------------------------------------------------------------------------
-- 6. Carrying the two columns through the reads
-- ---------------------------------------------------------------------------

-- `poll_page`'s account branch hands back `to_jsonb(v_poll)`, so it carries
-- them already. These two build their poll object a field at a time.

create or replace function "public"."open_poll_view"("p_poll_id" "uuid", "p_voter_key" "text" DEFAULT NULL::"text") returns "jsonb"
    language plpgsql security definer
    set "search_path" to 'public'
    as $$
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


-- The poll list is deliberately not here. Its card draws a winner's name, and
-- on a finished time poll that name is an ISO timestamp -- but formatting a
-- timestamp is presentation, and `winnerLabel` in src/lib/schedule.ts does it
-- from the name alone. Carrying `kind` and `schedule` through `list_polls` so
-- the browser could be *told* what it can already see would have meant
-- restating that function whole: adding a column to a `RETURNS TABLE` is a new
-- return type, which `CREATE OR REPLACE` refuses, so it is a DROP, a hundred
-- and thirty lines of unchanged body, and the grant again. For one label.
--
-- `poll_status` is absent for the same reason, and so is anything else that
-- carries `winner_name`. Only the two reads a *ballot* is drawn from need the
-- schedule, because only they need the grid.

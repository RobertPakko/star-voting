-- The link to an open poll is the poll's id. There is no share token.
--
-- An open poll used to carry a `public_token` alongside its primary key, and
-- the token was the capability: `#/p/<token>` was the link you handed out,
-- every anon RPC took `p_token`, and holding the token was the whole of the
-- authorization. The id and the token were the same thing twice --
-- `insert_poll_row` minted the token as `replace(gen_random_uuid()::text,
-- '-', '')`, so both were 122 bits out of the same generator -- and the
-- separation bought exactly one thing: the token could be rotated and the id
-- could not.
--
-- The price of two identifiers was paid on every screen. A poll had two
-- addresses, `#/p/<token>` for a voter and `#/polls/<id>` for its creator, so
-- a creator who copied what was in front of them handed out a link that sent
-- the recipient to a sign-in screen and then to "poll not found". Every
-- change on the open-poll side had to decide which of the two it was holding.
-- `broadcast_poll_change` announced each poll on two realtime topics, purely
-- because a voter arriving on a share link had no way to know the id to
-- listen on until they had already read the poll once.
--
-- **Nothing about who can reach an open poll changes here.** For an open
-- poll the id was never wider than the token: `polls_select` is `created_by =
-- auth.uid() or is_invited_to_poll(id)` and an open poll has no invitees, so
-- only its creator could learn the id without holding the link -- and
-- `open_poll_view` has always returned the id to anyone presenting the token.
-- The set of people who can vote is the same set it was.
--
-- **What is given up, plainly.** A leaked link can no longer be replaced. The
-- id is referenced by candidates, ballots, invited_voters and polls.group_id,
-- so there is no rotating it; "send me a new link for the same poll" now has
-- no answer but to duplicate the poll and lose its votes. And a primary key
-- travels where a single-purpose secret does not -- this schema already puts
-- poll ids into email bodies (`trg_send_invite_email`, the results-ready
-- notice), and every future thing that logs, exports or reports an id is now
-- handling a ballot.
--
-- **Links already sent stop working.** There is no compatibility shim: the
-- column goes in this migration, so an `#/p/<token>` link that is out in the
-- world has nothing left to resolve against.

-- Every anon entry point takes the poll it is about. The bodies below are
-- the bodies that were there, with the lookup changed from the token column
-- to the primary key; a parameter's type cannot be changed in place, so each
-- is dropped and recreated rather than replaced.
drop function if exists public.open_poll_view(text, text);
drop function if exists public.open_poll_group(text);
drop function if exists public.open_poll_ballots(text);
drop function if exists public.open_poll_submit(text, jsonb, text, text);
drop function if exists public.open_poll_revise(text, jsonb, text);
drop function if exists public.open_poll_suggest_option(text, text, text);

create function public.open_poll_view(p_poll_id uuid, p_voter_key text default null) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
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
      'closed_at', v_poll.closed_at,
      -- Null on a poll that asks one question, which is what tells the page
      -- to render no question strip rather than a strip of one.
      'group_id', v_poll.group_id,
      'question_position', v_poll.question_position,
      'question_title', v_poll.question_title
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

create function public.open_poll_group(p_poll_id uuid) returns jsonb
    language plpgsql stable security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
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
  -- **No "voted" here, unlike poll_group.** An open ballot is identified by
  -- a voter_key that is minted per question precisely so that one
  -- browser's ballots cannot be joined to each other, and answering this
  -- would mean taking every key at once and doing that join on the server.
  -- The browser already knows which questions it has answered; it is the one
  -- place entitled to, and it needs no help from here.
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', q.id,
      'question_position', q.question_position,
      'question_title', q.question_title
    ) order by q.question_position), '[]'::jsonb)
    from poll_group_members(v_poll) q
  );
end;
$$;

create function public.open_poll_ballots(p_poll_id uuid) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
  v_voted int;
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if not v_poll.show_ballots then
    raise exception 'This poll does not publish individual ballots';
  end if;

  if v_poll.closed_at is null then
    raise exception 'Ballots are not available until the poll is closed';
  end if;

  select count(*) into v_voted from ballots where poll_id = v_poll.id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  return ballot_sheet(v_poll.id, v_poll.show_voters);
end;
$$;

create function public.open_poll_submit(p_poll_id uuid, p_scores jsonb, p_voter_key text, p_voter_name text default null) returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
  v_name text;
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

  if exists (select 1 from ballots where poll_id = v_poll.id and voter_key = p_voter_key) then
    raise exception 'You have already voted in this poll';
  end if;

  select count(*) into v_option_count from candidates where poll_id = v_poll.id;

  if jsonb_array_length(p_scores) is distinct from v_option_count then
    raise exception 'Must submit a score for every option';
  end if;

  begin
    insert into ballots (poll_id, voter_id, voter_name, voter_key)
    values (v_poll.id, null, v_name, p_voter_key)
    returning id into v_ballot_id;
  exception when unique_violation then
    -- Either the name is taken, or this browser raced itself (double-click,
    -- double-submit) past the voter_key check above.
    if v_name is null then
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
end;
$$;

create function public.open_poll_revise(p_poll_id uuid, p_scores jsonb, p_voter_key text) returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
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

  select id into v_ballot_id
  from ballots where poll_id = v_poll.id and voter_key = p_voter_key;

  if not found then
    raise exception 'You have not voted in this poll yet';
  end if;

  perform replace_scores(v_ballot_id, v_poll.id, p_scores);

  update ballots set revised_at = now() where id = v_ballot_id;
end;
$$;

create function public.open_poll_suggest_option(p_poll_id uuid, p_name text, p_description text default null) returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  perform add_suggested_option(v_poll, p_name, p_description);
end;
$$;


-- The gate in front of a public tally, which used to be a lookup as well.
--
-- It was `open_results_poll_id(p_token) returns uuid`: resolve the token,
-- check the results are out and that somebody voted, hand back the id. The
-- caller now holds the id already, so a function whose name promises to find
-- one and whose body returns its own argument is a lie about what it is for.
-- What was always load-bearing is the checking, so that is all it does, and
-- it is named for it -- next to `assert_results_readable`, which does the
-- same job on the invite side.
drop function if exists public.open_results_poll_id(text);

create function public.assert_open_results_readable(p_poll_id uuid) returns void
    language plpgsql stable security definer
    set search_path to 'public'
    as $$
declare
  v_poll polls;
  v_voted int;
begin
  select * into v_poll from polls
  where id = p_poll_id and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  -- Closed first: on a poll still taking votes that is the accurate answer,
  -- and "no votes were cast" would be a confusing thing to say about a poll
  -- people can still vote in.
  if not (select bool_and(poll_gate_open(q.*)) from poll_group_members(v_poll) q) then
    raise exception 'Results are not available until the poll is closed';
  end if;

  select count(*) into v_voted from ballots where poll_id = v_poll.id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;
end;
$$;

drop function if exists public.open_poll_results(text);

create function public.open_poll_results(p_poll_id uuid) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_tally(p_poll_id);
end;
$$;

drop function if exists public.open_poll_ranking(text);

create function public.open_poll_ranking(p_poll_id uuid) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
begin
  perform assert_open_results_readable(p_poll_id);
  return poll_ranking(p_poll_id);
end;
$$;


comment on function public.open_poll_group(uuid) is 'The questions of an open poll, with the id of each, to a caller already holding one of them. Says nothing about who has answered what: an open poll''s voter keys are scoped per question so they cannot be joined, and this function is not the place that undoes it.';

comment on function public.open_poll_revise(uuid, jsonb, text) is 'Replaces the scores on the ballot this voter_key cast, until the poll closes. The voter''s name is not revisable: it is on the roster other people are already reading.';

comment on function public.assert_open_results_readable(uuid) is 'Raises unless this open poll''s tally may be read: it exists, it is open-mode, every question''s gate is open, and somebody voted. Internal: the two public tally functions call it and then read the tally themselves.';


-- The grants the dropped functions took with them. `anon` is the whole point
-- of this set: an open poll is voted by people who never sign in.
-- `authenticated` as well, because a creator votes in their own poll through
-- the same code path everybody else does.
revoke all on function public.open_poll_view(uuid, text) from public;
grant all on function public.open_poll_view(uuid, text) to anon;
grant all on function public.open_poll_view(uuid, text) to authenticated;

revoke all on function public.open_poll_group(uuid) from public;
grant all on function public.open_poll_group(uuid) to anon;
grant all on function public.open_poll_group(uuid) to authenticated;

revoke all on function public.open_poll_results(uuid) from public;
grant all on function public.open_poll_results(uuid) to anon;
grant all on function public.open_poll_results(uuid) to authenticated;

revoke all on function public.open_poll_ranking(uuid) from public;
grant all on function public.open_poll_ranking(uuid) to anon;
grant all on function public.open_poll_ranking(uuid) to authenticated;

revoke all on function public.open_poll_ballots(uuid) from public;
grant all on function public.open_poll_ballots(uuid) to anon;
grant all on function public.open_poll_ballots(uuid) to authenticated;

revoke all on function public.open_poll_submit(uuid, jsonb, text, text) from public;
grant all on function public.open_poll_submit(uuid, jsonb, text, text) to anon;
grant all on function public.open_poll_submit(uuid, jsonb, text, text) to authenticated;

revoke all on function public.open_poll_revise(uuid, jsonb, text) from public;
grant all on function public.open_poll_revise(uuid, jsonb, text) to anon;
grant all on function public.open_poll_revise(uuid, jsonb, text) to authenticated;

revoke all on function public.open_poll_suggest_option(uuid, text, text) from public;
grant all on function public.open_poll_suggest_option(uuid, text, text) to anon;
grant all on function public.open_poll_suggest_option(uuid, text, text) to authenticated;

-- Internal, like the gate it replaces: reached only through the two tally
-- functions above, which are security definer and do the asking themselves.
revoke all on function public.assert_open_results_readable(uuid) from public;

-- Nothing to mint. The row's own id is the link, and it is a v4 UUID from
-- the column default -- which is exactly what the token was, minus the
-- hyphens. Every question still gets its own, because a question is a poll
-- row: a link reaches one ballot, and there is one ballot per question.
create or replace function public.insert_poll_row(p_title text, p_description text, p_question_title text, p_options jsonb, p_emails text[], p_mode text, p_show_voters boolean, p_show_ballots boolean, p_solicit_options boolean, p_group_id uuid default null, p_question_position integer default null) returns uuid
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_poll_id uuid;
  v_opts jsonb;
  v_item jsonb;
  i int;
begin
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

  insert into polls (
    title, description, created_by, mode, show_voters, show_ballots,
    solicit_options, group_id, question_position, question_title
  )
  values (
    p_title, p_description, auth.uid(), p_mode, p_show_voters, p_show_ballots,
    p_solicit_options, p_group_id, p_question_position, p_question_title
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


-- One topic per poll, where there were two.
--
-- The second existed because an open poll's voters arrived holding a share
-- token and did not learn the poll's id until they had read it once, so the
-- poll had to be announced under the token as well for the public page to be
-- able to subscribe before its first read. A voter now arrives holding the
-- id, which is the topic, so there is nothing left to bridge.
create or replace function public.broadcast_poll_change(p_poll_id uuid) returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_creator uuid;
  v_user uuid;
begin
  if p_poll_id is null then
    return;
  end if;

  -- A poll that is on its way out has nobody left to tell, and its rows are
  -- following it: without this, every cascade delete would send one message
  -- per child row for a poll that no longer exists. It is also what keeps
  -- the nightly purge silent.
  select created_by into v_creator
  from polls where id = p_poll_id;
  if not found then
    return;
  end if;

  perform realtime.send('{}'::jsonb, 'poll_changed', 'poll:' || p_poll_id::text, false);

  -- And the same trick for the poll list, which holds no poll id at all until
  -- it has read one. `union` rather than `union all`: a creator who invited
  -- themselves is one reader with one list.
  for v_user in
    select u.id from auth.users u where u.id = v_creator
    union
    select u.id
    from invited_voters iv
    join auth.users u on lower(u.email) = lower(iv.email)
    where iv.poll_id = p_poll_id
  loop
    perform realtime.send('{}'::jsonb, 'polls_changed', 'user:' || v_user::text, false);
  end loop;
end;
$$;


-- The list stops carrying a token it no longer has.
--
-- Dropped and recreated rather than replaced: the column is named in RETURNS
-- TABLE, so this is a change of return type. It is also the one function here
-- written in SQL rather than plpgsql, which means Postgres tracks its
-- dependency on the column for real -- so it has to go before the column can.
drop function if exists public.list_polls(integer, integer);

create function public.list_polls(p_limit integer, p_offset integer) returns table(id uuid, title text, description text, created_by uuid, created_by_email text, created_at timestamp with time zone, closed_at timestamp with time zone, mode text, show_voters boolean, show_ballots boolean, solicit_options boolean, options_finalized_at timestamp with time zone, invited_count integer, voted_count integer, option_count integer, is_complete boolean, voted boolean, is_closed boolean, results_available boolean, soliciting boolean, group_id uuid, question_position integer, question_title text, question_count integer, total_count integer)
    language sql stable security definer
    set search_path to 'public'
    as $$
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

comment on function public.list_polls(integer, integer) is 'One page of the caller''s poll list, newest first, with the total on every row. The page is taken before the per-poll aggregates run, so the work is proportional to the rows returned rather than to everything the caller can see. An offset past the end returns the last page there is.';

revoke all on function public.list_polls(integer, integer) from public;
grant all on function public.list_polls(integer, integer) to authenticated;


-- And the column itself, last, once nothing names it any more. Dropping it
-- takes `uq_polls_public_token` and `polls_public_token_ck` with it, which is
-- Postgres doing what those two were for: the uniqueness of a value that no
-- longer exists, and the rule that an open poll has one and an invite poll
-- does not. What tells the two modes apart is `mode`, which is what it always
-- said it was.
alter table public.polls drop column public_token;

-- Two new per-poll settings, both chosen at creation time and immutable
-- afterwards.
--
--   mode = 'invite'  (unchanged) Access is by email address. Only invited
--                    people can see or vote in the poll. Results unlock
--                    when everyone invited has voted, or when the creator
--                    closes it early.
--   mode = 'open'    (new) Access is by an unguessable link. Anyone holding
--                    it votes without signing in. Results unlock ONLY when
--                    the creator closes the poll -- there is no fixed
--                    roster, so "everyone has voted" has no meaning here.
--
--   show_voters = true   Participants can see who has responded so far.
--   show_voters = false  Nobody sees who responded, only how many.
--
-- Open polls trade ballot-box integrity for convenience, deliberately:
-- clearing site data or opening a second browser buys another vote. That is
-- an accepted property of the mode, not an oversight -- it exists for
-- "which movie tonight", not for anything that matters. Every guard below
-- is about keeping that trade contained to polls that opted into it.
--
-- Neither setting ever exposes how someone voted. show_voters controls the
-- roster of *who responded*; individual scores remain unreadable through
-- the API in every mode, exactly as before.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table polls
  add column if not exists mode text not null default 'invite',
  add column if not exists show_voters boolean not null default true,
  add column if not exists public_token text;

alter table polls drop constraint if exists polls_mode_ck;
alter table polls add constraint polls_mode_ck check (mode in ('invite', 'open'));

-- An open poll is reachable only through its token, so it must have one. An
-- invite poll must not have one, so a stray token can never quietly become
-- a second way in to a poll whose whole point is the email gate.
alter table polls drop constraint if exists polls_public_token_ck;
alter table polls add constraint polls_public_token_ck
  check ((mode = 'open') = (public_token is not null));

create unique index if not exists uq_polls_public_token on polls(public_token);

-- Existing polls become mode='invite', show_voters=true. True is the
-- behaviour-preserving choice for the creator, who can already see
-- voted/pending badges today. Note it is a widening for everyone else on
-- those polls: invitees will now see that roster too. Flip any poll with
--   update polls set show_voters = false where id = '...';

-- Open-poll ballots have no auth.users row behind them.
--
-- The existing `unique (poll_id, voter_id)` from 0001 keeps working
-- untouched: Postgres treats NULLs as distinct, so any number of anonymous
-- ballots coexist while invite ballots stay strictly one per user.
alter table ballots alter column voter_id drop not null;

alter table ballots
  add column if not exists voter_name text,
  add column if not exists voter_key text;

-- voter_key is a random id the browser keeps in localStorage. It exists to
-- stop accidental double-submits (refresh, double-click, back button) and
-- to drive the "your vote is in" screen. It is NOT a vote guard: clearing
-- site data mints a new one, which is precisely the trade this mode makes.
create unique index if not exists uq_ballots_poll_voter_key
  on ballots (poll_id, voter_key) where voter_key is not null;

-- In a named open poll the roster of names IS the feature, so two "Rob"
-- rows would make it useless -- you could no longer tell whose vote you are
-- still waiting on. One ballot per name per poll.
create unique index if not exists uq_ballots_poll_voter_name
  on ballots (poll_id, lower(voter_name)) where voter_name is not null;

-- ---------------------------------------------------------------------------
-- guard_invitee_changes: same rules as 0012, plus a mode check.
--
-- Nothing in the app invites people to an open poll, but RLS would still
-- allow the creator to insert one directly. That row would be counted by
-- invited_count while its owner votes anonymously (voter_id null, so the
-- auth.users join never matches), permanently wedging the poll between
-- "not everyone has voted" and "nobody left to vote".
-- ---------------------------------------------------------------------------

create or replace function guard_invitee_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll_id uuid;
  v_invited int;
  v_voted int;
begin
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
$$;

-- ---------------------------------------------------------------------------
-- create_poll: gains the two settings. Signature changes, so drop first.
-- ---------------------------------------------------------------------------

drop function if exists create_poll(text, text, text[], text[]);

create function create_poll(
  p_title text,
  p_description text,
  p_options text[],
  p_emails text[],
  p_mode text default 'invite',
  p_show_voters boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll_id uuid;
  v_token text;
  v_opts text[];
  v_mails text[];
  v_bad text;
  i int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if p_mode is null or p_mode not in ('invite', 'open') then
    raise exception 'Unknown poll mode';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'Title is required';
  end if;

  -- Drop blanks but keep the author's ordering.
  select array_agg(trim(o) order by ord)
  into v_opts
  from unnest(p_options) with ordinality as t(o, ord)
  where trim(coalesce(o, '')) <> '';

  if coalesce(array_length(v_opts, 1), 0) < 2 then
    raise exception 'Add at least two options';
  end if;

  if p_mode = 'invite' then
    -- Normalize and dedupe invitees the same way every lookup does.
    select array_agg(distinct lower(trim(e)))
    into v_mails
    from unnest(p_emails) e
    where trim(coalesce(e, '')) <> '';

    if coalesce(array_length(v_mails, 1), 0) < 1 then
      raise exception 'Invite at least one voter';
    end if;

    select m into v_bad
    from unnest(v_mails) m
    where m !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    limit 1;

    if v_bad is not null then
      raise exception '"%" is not a valid email address', v_bad;
    end if;
  else
    -- 128 bits, URL-safe. translate() drops '=' (no replacement given).
    v_token := translate(encode(gen_random_bytes(16), 'base64'), '+/=', '-_');
  end if;

  insert into polls (title, description, created_by, mode, show_voters, public_token)
  values (
    trim(p_title),
    nullif(trim(coalesce(p_description, '')), ''),
    auth.uid(),
    p_mode,
    coalesce(p_show_voters, true),
    v_token
  )
  returning id into v_poll_id;

  for i in 1 .. array_length(v_opts, 1) loop
    insert into candidates (poll_id, name, sort_order) values (v_poll_id, v_opts[i], i - 1);
  end loop;

  if p_mode = 'invite' then
    for i in 1 .. array_length(v_mails, 1) loop
      insert into invited_voters (poll_id, email) values (v_poll_id, v_mails[i]);
    end loop;
  end if;

  return v_poll_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- poll_tally: the STAR count, extracted verbatim from 0011's
-- get_poll_results so the invite path and the open path can share it.
--
-- It deliberately performs NO authorization and NO availability check --
-- both callers below do their own, and they differ (invite polls unlock on
-- completion or close, open polls only on close). Internal only: EXECUTE is
-- revoked from every client role at the bottom of this file, and the
-- SECURITY DEFINER callers reach it as the owner regardless.
-- ---------------------------------------------------------------------------

create or replace function poll_tally(p_poll_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invited int;
  v_voted int;
  v_closed boolean;
  v_mode text;
  v_options jsonb;
  v_finalists uuid[] := '{}';
  v_pick uuid[];
  v_tiebreaks jsonb := '[]'::jsonb;
  v_need int := 2;
  v_score int;
  v_group uuid[];
  v_grp_size int;
  v_tied jsonb;
  v_h2h jsonb;
  v_fs jsonb;
  v_steps jsonb;
  v_advanced jsonb;
  v_resolved text;
  v_wn int; v_fn int; v_wn1 int; v_fn1 int;
  v_a uuid; v_b uuid;
  v_ta int; v_tb int;
  v_prefers_a int; v_prefers_b int; v_ties int;
  v_winner uuid;
  v_runoff_by text;
begin
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;
  select closed_at is not null, mode into v_closed, v_mode from polls where id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  drop table if exists _tally;
  create temp table _tally on commit drop as
  select
    c.id as cid,
    c.name,
    coalesce(sum(s.score), 0)::int as total,
    (count(*) filter (where s.score = 5))::int as five_stars
  from candidates c
  left join scores s on s.candidate_id = c.id
  where c.poll_id = p_poll_id
  group by c.id, c.name;

  -- Walk score groups high to low, filling the two finalist slots. A group
  -- that would overfill the remaining slots is the tie that needs breaking.
  for v_score in select distinct total from _tally order by total desc loop
    exit when v_need <= 0;

    select array_agg(cid order by cid) into v_group from _tally where total = v_score;
    v_grp_size := coalesce(array_length(v_group, 1), 0);

    if v_grp_size <= v_need then
      v_finalists := v_finalists || v_group;
      v_need := v_need - v_grp_size;
    else
      drop table if exists _tb;
      create temp table _tb on commit drop as
      with grp as (select unnest(v_group) as cid),
      pairs as (
        select g1.cid as a, g2.cid as b
        from grp g1 join grp g2 on g1.cid <> g2.cid
      ),
      matchups as (
        select
          p.a,
          p.b,
          (select count(*) from ballots bal
            where bal.poll_id = p_poll_id
              and coalesce((select score from scores where ballot_id = bal.id and candidate_id = p.a), 0)
                > coalesce((select score from scores where ballot_id = bal.id and candidate_id = p.b), 0)
          ) as ap,
          (select count(*) from ballots bal
            where bal.poll_id = p_poll_id
              and coalesce((select score from scores where ballot_id = bal.id and candidate_id = p.b), 0)
                > coalesce((select score from scores where ballot_id = bal.id and candidate_id = p.a), 0)
          ) as bp
        from pairs p
      ),
      wins as (
        select m.a as cid, (count(*) filter (where m.ap > m.bp))::int as w
        from matchups m group by m.a
      )
      select
        g.cid,
        t.name,
        t.total,
        t.five_stars,
        coalesce(w.w, 0) as h2h_wins,
        row_number() over (order by coalesce(w.w, 0) desc, t.five_stars desc, g.cid) as rn
      from grp g
      join _tally t on t.cid = g.cid
      left join wins w on w.cid = g.cid;

      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'total_score', total) order by name)
        into v_tied from _tb;
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', h2h_wins) order by h2h_wins desc, name)
        into v_h2h from _tb;
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name, 'value', five_stars) order by five_stars desc, name)
        into v_fs from _tb;

      -- Whatever separates the last advancing option from the first
      -- eliminated one is what actually decided the tie.
      select h2h_wins, five_stars into v_wn, v_fn from _tb where rn = v_need;
      select h2h_wins, five_stars into v_wn1, v_fn1 from _tb where rn = v_need + 1;

      if v_wn > v_wn1 then
        v_resolved := 'head_to_head';
      elsif v_fn > v_fn1 then
        v_resolved := 'five_star_votes';
      else
        v_resolved := 'random';
      end if;

      v_steps := jsonb_build_array(jsonb_build_object(
        'rule', 'head_to_head', 'results', v_h2h, 'decisive', v_resolved = 'head_to_head'));

      if v_resolved <> 'head_to_head' then
        v_steps := v_steps || jsonb_build_array(jsonb_build_object(
          'rule', 'five_star_votes', 'results', v_fs, 'decisive', v_resolved = 'five_star_votes'));
      end if;

      select array_agg(cid order by rn) into v_pick from _tb where rn <= v_need;
      select jsonb_agg(jsonb_build_object('id', cid, 'name', name) order by rn)
        into v_advanced from _tb where rn <= v_need;

      v_tiebreaks := v_tiebreaks || jsonb_build_array(jsonb_build_object(
        'tied_at', v_score,
        'tied', v_tied,
        'slots', v_need,
        'steps', v_steps,
        'resolved_by', v_resolved,
        'advanced', v_advanced));

      v_finalists := v_finalists || v_pick;
      v_need := 0;
    end if;
  end loop;

  -- Highest scorer first, so finalists[0] is the one the runoff labels as A.
  select array_agg(cid order by total desc, cid) into v_finalists
  from _tally where cid = any(v_finalists);

  -- Order the score list so a tie-break winner sits above the option it
  -- beat, rather than falling alphabetically below it.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cid,
    'name', name,
    'total_score', total,
    'average_score', round(total::numeric / v_voted, 2)
  ) order by total desc, (case when cid = any(v_finalists) then 0 else 1 end), name), '[]'::jsonb)
  into v_options
  from _tally;

  if coalesce(array_length(v_finalists, 1), 0) < 2 then
    return jsonb_build_object(
      'options', v_options,
      'finalists', '[]'::jsonb,
      'tie', false,
      'tiebreaks', v_tiebreaks,
      'runoff', null,
      'winner_id', v_finalists[1],
      'voter_count', v_voted,
      'invited_count', v_invited,
      'mode', v_mode,
      'closed_early', v_closed and v_voted < v_invited
    );
  end if;

  v_a := v_finalists[1];
  v_b := v_finalists[2];

  select
    count(*) filter (where a_score > b_score),
    count(*) filter (where b_score > a_score),
    count(*) filter (where a_score = b_score)
  into v_prefers_a, v_prefers_b, v_ties
  from (
    select
      bal.id,
      coalesce((select score from scores where ballot_id = bal.id and candidate_id = v_a), 0) as a_score,
      coalesce((select score from scores where ballot_id = bal.id and candidate_id = v_b), 0) as b_score
    from ballots bal
    where bal.poll_id = p_poll_id
  ) t;

  if v_prefers_a > v_prefers_b then
    v_winner := v_a; v_runoff_by := 'preference';
  elsif v_prefers_b > v_prefers_a then
    v_winner := v_b; v_runoff_by := 'preference';
  else
    -- Official STAR: a tied runoff goes to the higher total score.
    select total into v_ta from _tally where cid = v_a;
    select total into v_tb from _tally where cid = v_b;
    if v_ta > v_tb then
      v_winner := v_a; v_runoff_by := 'higher_score';
    elsif v_tb > v_ta then
      v_winner := v_b; v_runoff_by := 'higher_score';
    else
      v_winner := null; v_runoff_by := 'unresolved';
    end if;
  end if;

  return jsonb_build_object(
    'options', v_options,
    'finalists', jsonb_build_array(v_a, v_b),
    'tie', jsonb_array_length(v_tiebreaks) > 0,
    'tiebreaks', v_tiebreaks,
    'runoff', jsonb_build_object(
      'prefers_a', v_prefers_a,
      'prefers_b', v_prefers_b,
      'ties', v_ties,
      'resolved_by', v_runoff_by
    ),
    'winner_id', v_winner,
    'voter_count', v_voted,
    'invited_count', v_invited,
    'mode', v_mode,
    'closed_early', v_closed and v_voted < v_invited
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- get_poll_results: unchanged rules for invite polls (unlock on completion
-- or close), now just authorizing and delegating the count.
--
-- Open polls are excluded from this path entirely: their audience is not
-- authenticated, so they read results through open_poll_results below.
-- ---------------------------------------------------------------------------

create or replace function get_poll_results(p_poll_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_mode text;
  v_invited int;
  v_voted int;
  v_closed boolean;
begin
  if not exists (
    select 1 from polls p
    where p.id = p_poll_id
      and (
        p.created_by = auth.uid()
        or exists (select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email)
      )
  ) then
    raise exception 'Poll not found';
  end if;

  select mode, closed_at is not null into v_mode, v_closed from polls where id = p_poll_id;
  select count(*) into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if v_mode = 'open' then
    if not v_closed then
      raise exception 'Results are not available until the poll is closed';
    end if;
  elsif not v_closed and (v_invited = 0 or v_voted < v_invited) then
    raise exception 'Results are not available until everyone has voted';
  end if;

  return poll_tally(p_poll_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- poll_invitees: who is invited, and -- when the poll shows respondents --
-- who has voted.
--
-- Previously creator-only. Now any participant can call it on a poll with
-- show_voters, because "whose vote are we waiting on" is useful to the
-- whole group, not just the organizer. On a poll without show_voters only
-- the creator can call it, and even they get has_voted as NULL: they still
-- need the address list to add and remove people, but the roster of who has
-- responded is not theirs to see either.
--
-- One residual leak, accepted: the 0008 rule "cannot remove someone who has
-- already voted" still fires, so a creator who tries to remove a specific
-- person on a hidden-respondent poll learns from the error that they voted.
-- Closing that would mean either dropping the removal guard (which exists to
-- stop invited_count falling below voted_count) or silently pretending the
-- removal worked. Neither is worth it -- and it reveals participation only,
-- never a single score.
--
-- has_voted stays `boolean` so the return signature is unchanged.
-- ---------------------------------------------------------------------------

create or replace function poll_invitees(p_poll_id uuid)
returns table (email text, has_voted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_is_creator boolean;
  v_is_invited boolean;
  v_show boolean;
  v_mode text;
begin
  select
    p.created_by = auth.uid(),
    p.show_voters,
    p.mode
  into v_is_creator, v_show, v_mode
  from polls p where p.id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  -- auth.uid() is null for an unauthenticated caller, which would make the
  -- comparison above NULL and every `not v_is_creator` test below NULL --
  -- i.e. not true, but not false either. EXECUTE is revoked from anon, so
  -- this is belt and braces; it is also exactly the shape of mistake 0010
  -- was written about.
  v_is_creator := coalesce(v_is_creator, false);

  select exists (
    select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email
  ) into v_is_invited;

  if not v_is_creator and not v_is_invited then
    raise exception 'Poll not found';
  end if;

  if v_mode <> 'invite' then
    raise exception 'This poll is open to anyone with the link, so it has no invitee list';
  end if;

  if not v_is_creator and not v_show then
    raise exception 'This poll does not show who has responded';
  end if;

  return query
  select
    iv.email,
    case when v_show then exists (
      select 1 from ballots b
      join auth.users u on u.id = b.voter_id
      where b.poll_id = p_poll_id and lower(u.email) = iv.email
    ) else null::boolean end
  from invited_voters iv
  where iv.poll_id = p_poll_id
  order by iv.email;
end;
$$;

-- ---------------------------------------------------------------------------
-- Open-poll surface. These three are the ONLY things the `anon` role can
-- reach, and each is scoped to a single poll by a token the caller must
-- already hold. No table grants are added for anon anywhere -- 0010's rule
-- that anon reaches nothing by default still stands for everything else.
-- ---------------------------------------------------------------------------

-- open_poll_view: everything the public voting page renders, in one call.
-- Never returns scores, and never returns results before the poll closes.
create or replace function open_poll_view(p_token text, p_voter_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll polls;
  v_voted int;
  v_options jsonb;
  v_voters jsonb;
  v_your_name text;
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
  -- vote is outstanding is the point of a named poll.
  if v_poll.show_voters then
    select coalesce(jsonb_agg(b.voter_name order by lower(b.voter_name)), '[]'::jsonb)
    into v_voters
    from ballots b
    where b.poll_id = v_poll.id and b.voter_name is not null;
  else
    v_voters := null;
  end if;

  if p_voter_key is null or trim(p_voter_key) = '' then
    v_voted_already := false;
  else
    select true, b.voter_name into v_voted_already, v_your_name
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
      'closed_at', v_poll.closed_at
    ),
    'options', v_options,
    'voted_count', v_voted,
    'is_closed', v_poll.closed_at is not null,
    -- Open polls reveal only on close, so early votes can never steer late
    -- ones. This is the same promise the invite mode makes.
    'results_available', v_voted > 0 and v_poll.closed_at is not null,
    'voted', v_voted_already,
    'your_name', v_your_name,
    'voters', v_voters
  );
end;
$$;

-- open_poll_submit: the only write path for an unauthenticated ballot.
-- Mirrors submit_ballot's validation, with the identity checks replaced by
-- the token and the browser's voter_key.
create or replace function open_poll_submit(
  p_token text,
  p_scores jsonb,
  p_voter_key text,
  p_voter_name text default null
)
returns void
language plpgsql
security definer
set search_path = public
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
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  if v_poll.closed_at is not null then
    raise exception 'This poll has been closed and is no longer accepting votes';
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

-- open_poll_results: the tally, once the creator has closed the poll.
create or replace function open_poll_results(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll polls;
  v_voted int;
begin
  select * into v_poll from polls
  where public_token = p_token and mode = 'open';

  if not found then
    raise exception 'Poll not found';
  end if;

  -- Closed first: on a poll still taking votes that is the accurate answer,
  -- and "no votes were cast" would be a confusing thing to say about a poll
  -- people can still vote in.
  if v_poll.closed_at is null then
    raise exception 'Results are not available until the poll is closed';
  end if;

  select count(*) into v_voted from ballots where poll_id = v_poll.id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  return poll_tally(v_poll.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- list_polls: adds mode and show_voters so the list can say "7 responses"
-- instead of "7/0 voted", plus the token for the creator's share link.
--
-- public_token is safe to include: only open polls have one, and an open
-- poll has no invitees, so the `visible` CTE hands it to nobody but its
-- creator. Return signature changes, so this needs a drop.
-- ---------------------------------------------------------------------------

drop function if exists list_polls();

create function list_polls()
returns table (
  id uuid,
  title text,
  description text,
  created_by uuid,
  created_by_email text,
  created_at timestamptz,
  closed_at timestamptz,
  mode text,
  show_voters boolean,
  public_token text,
  invited_count int,
  voted_count int,
  is_complete boolean,
  voted boolean,
  is_closed boolean,
  results_available boolean
)
language sql
security definer
set search_path = public
stable
as $$
  with visible as (
    select p.*
    from polls p
    where p.created_by = auth.uid()
       or exists (
         select 1 from invited_voters iv
         where iv.poll_id = p.id and iv.email = lower(auth.jwt() ->> 'email')
       )
  ), tallied as (
    select
      v.id as poll_id,
      (select count(*)::int from invited_voters iv where iv.poll_id = v.id) as invited_count,
      (select count(*)::int from ballots b where b.poll_id = v.id) as voted_count,
      exists (select 1 from ballots b where b.poll_id = v.id and b.voter_id = auth.uid()) as voted
    from visible v
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
    v.public_token,
    t.invited_count,
    t.voted_count,
    t.invited_count > 0 and t.voted_count >= t.invited_count,
    t.voted,
    v.closed_at is not null,
    -- Open polls reveal only on close; invite polls keep the completion
    -- rule as well.
    t.voted_count > 0 and (
      v.closed_at is not null
      or (v.mode = 'invite' and t.invited_count > 0 and t.voted_count >= t.invited_count)
    )
  from visible v
  join tallied t on t.poll_id = v.id
  order by v.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- poll_status: same addition of the open-poll rule, so the detail page and
-- the list page can never disagree about whether results are out.
-- ---------------------------------------------------------------------------

drop function if exists poll_status(uuid);

create function poll_status(p_poll_id uuid)
returns table (
  invited_count int,
  voted_count int,
  is_complete boolean,
  voted boolean,
  is_closed boolean,
  results_available boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_invited int;
  v_voted int;
  v_closed boolean;
  v_mode text;
begin
  if not exists (
    select 1 from polls p
    where p.id = p_poll_id
      and (
        p.created_by = auth.uid()
        or exists (select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email)
      )
  ) then
    raise exception 'Poll not found';
  end if;

  select count(*)::int into v_invited from invited_voters where poll_id = p_poll_id;
  select count(*)::int into v_voted from ballots where poll_id = p_poll_id;
  select closed_at is not null, mode into v_closed, v_mode from polls where id = p_poll_id;

  return query select
    v_invited,
    v_voted,
    v_invited > 0 and v_voted >= v_invited,
    exists (select 1 from ballots where poll_id = p_poll_id and voter_id = auth.uid()),
    v_closed,
    -- A closed poll with zero ballots has nothing to show.
    v_voted > 0 and (
      v_closed or (v_mode = 'invite' and v_invited > 0 and v_voted >= v_invited)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Postgres hands EXECUTE to PUBLIC on every new function, so each
-- one has to be revoked before the intended grant means anything (0010).
-- ---------------------------------------------------------------------------

revoke execute on function poll_tally(uuid) from public, anon, authenticated;

revoke execute on function create_poll(text, text, text[], text[], text, boolean) from public, anon;
revoke execute on function list_polls() from public, anon;
revoke execute on function poll_status(uuid) from public, anon;
revoke execute on function poll_invitees(uuid) from public, anon;
revoke execute on function get_poll_results(uuid) from public, anon;

grant execute on function create_poll(text, text, text[], text[], text, boolean) to authenticated;
grant execute on function list_polls() to authenticated;
grant execute on function poll_status(uuid) to authenticated;
grant execute on function poll_invitees(uuid) to authenticated;
grant execute on function get_poll_results(uuid) to authenticated;

-- The open-poll surface, and only this, is reachable without a session.
-- `authenticated` gets it too, so a creator can vote in their own open poll
-- from the poll page without signing out.
revoke execute on function open_poll_view(text, text) from public;
revoke execute on function open_poll_submit(text, jsonb, text, text) from public;
revoke execute on function open_poll_results(text) from public;

grant execute on function open_poll_view(text, text) to anon, authenticated;
grant execute on function open_poll_submit(text, jsonb, text, text) to anon, authenticated;
grant execute on function open_poll_results(text) to anon, authenticated;

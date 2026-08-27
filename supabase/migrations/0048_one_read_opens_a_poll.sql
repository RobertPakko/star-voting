-- One read opens a poll, whoever is reading it.
--
-- A poll page used to be assembled from four requests and then, on an open
-- poll, a fifth behind them:
--
--   * `polls` and `candidates`, read straight through row-level security;
--   * `poll_status`, for the counts and the stage;
--   * `poll_group`, for the question strip;
--   * and then `open_poll_view`, which could not be asked for until the first
--     four came back, because nothing before them said the poll was open.
--
-- The first four run together and cost one round trip between them. The fifth
-- costs a second one, and it is a second one every reader of every open poll
-- pays, for a fact -- `mode` -- that the server knew before the first request
-- was answered.
--
-- Worse is the reader nobody designed for: somebody signed in, holding the
-- link to an open poll that is not theirs. `PollPage` sends every address to
-- the account reading first, so they spend a round trip on four queries that
-- row-level security answers with nothing, get handed to the public reading,
-- and start again. Three round trips and a discarded page render to open a
-- poll that was public all along.
--
-- So: one function, asked before the route has decided anything, which
-- answers the question the route is actually asking -- *what may this reader
-- see here* -- and returns the page with it.
--
-- **It returns a tagged union, not a superset, and that is the whole design.**
-- `open_poll_group` deliberately answers less than `poll_group`: no `voted`,
-- no `confirmed`, because an open poll's ballots are identified by a
-- voter_key minted per question precisely so one browser's cannot be joined
-- to each other (see 0039 and 0042, which both say so at length). A single
-- flat shape with those fields left null would put the joining one careless
-- `coalesce` away, and the person who wrote it would think they were filling
-- in a gap. Under a tag they have to build a different branch to do it, which
-- is a decision somebody makes rather than a field somebody fills.
--
-- The three answers:
--
--   * `account`  -- the reader is the creator or on the invite list. Carries
--                   the poll row, its options, its status and its group with
--                   every per-reader mark on it. On an *open* poll it carries
--                   `view` as well, because the creator's page draws the open
--                   poll's own panel and needed both.
--   * `open`     -- the poll is open and the reader is outside it. Carries
--                   the curated view and the bare group, and nothing that
--                   could say who has answered what.
--   * `unreadable` -- no such poll, or an invite poll this reader is not in.
--                   One answer for both on purpose: which it is, is itself
--                   worth knowing, and this function will not say.
--
-- **Nothing here is a new privilege.** Each branch returns what the caller
-- could already have asked for one request at a time, from the functions
-- that already decide it: `poll_status`, `poll_group`, `open_poll_view` and
-- `open_poll_group` are called rather than reimplemented, so there is one
-- copy of every rule and this cannot drift from it. The visibility test is
-- `is_poll_creator` / `is_invited_to_poll` -- the same two functions
-- `polls_select` is written in terms of -- rather than a third hand-written
-- copy of `created_by = auth.uid() or exists (...)`, which is what
-- `poll_status` and `poll_group` each carry today.
--
-- **It does not replace them.** This is the *first* read. The live tick stays
-- deliberately narrow -- `poll_status` alone on an invite poll, plus
-- `open_poll_view` on an open one -- because a poll's title, its terms and
-- the questions it asks are frozen at creation and re-reading them on every
-- signal would be a bigger waste than the round trip this saves.
create or replace function public.poll_page(p_poll_id uuid, p_voter_key text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
begin
  -- Read without a visibility test, because which test applies is what this
  -- function is here to work out. Nothing about the row escapes below except
  -- through a branch that has earned it.
  select p.* into v_poll from polls p where p.id = p_poll_id;

  if not found then
    return jsonb_build_object('kind', 'unreadable');
  end if;

  -- The account reading: the same door `polls_select` opens, asked with the
  -- same two functions so there is no second wording of it to keep in step.
  if is_poll_creator(v_poll.id) or is_invited_to_poll(v_poll.id) then
    return jsonb_build_object(
      'kind', 'account',
      -- The whole row, which is exactly what `select *` through row-level
      -- security handed back a moment ago: this reader is inside the poll.
      'poll', to_jsonb(v_poll),
      'options', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id,
          'poll_id', c.poll_id,
          'name', c.name,
          'description', c.description,
          'sort_order', c.sort_order
        ) order by c.sort_order, c.name), '[]'::jsonb)
        from candidates c where c.poll_id = v_poll.id
      ),
      'status', (select to_jsonb(s) from poll_status(v_poll.id) s),
      'questions', poll_group(v_poll.id),
      -- An open poll read by its own creator is still an open poll: the panel
      -- they manage it through is the one everybody else votes in, and it
      -- wants this. Null on an invite poll, where there is no such panel and
      -- open_poll_view would refuse to answer anyway.
      'view', case
        when v_poll.mode = 'open' then open_poll_view(v_poll.id, p_voter_key)
        else null
      end
    );
  end if;

  -- Outside the poll. An open one is readable by anyone holding its link, and
  -- holding its link is what being here means; anything else is not.
  if v_poll.mode = 'open' then
    return jsonb_build_object(
      'kind', 'open',
      'view', open_poll_view(v_poll.id, p_voter_key),
      -- The bare group. See the note above: no per-reader mark reaches this
      -- branch, and adding one is a change to make on purpose or not at all.
      'questions', open_poll_group(v_poll.id)
    );
  end if;

  -- An invite poll somebody else is in. Answered exactly as a poll that does
  -- not exist is answered, which is the point.
  return jsonb_build_object('kind', 'unreadable');
end;
$$;

alter function public.poll_page(uuid, text) owner to postgres;
revoke all on function public.poll_page(uuid, text) from public;
-- Both roles, unlike every function it calls: this is asked before the app
-- knows which kind of reader it has, which is the entire saving. `anon` gets
-- `open` or `unreadable` out of it and never reaches the account branch,
-- because auth.uid() and auth.jwt() are empty for it and both doors below
-- test against them.
grant execute on function public.poll_page(uuid, text) to anon;
grant execute on function public.poll_page(uuid, text) to authenticated;

comment on function public.poll_page(uuid, text) is
  'Everything the first paint of a poll page needs, in one request, tagged with which reading the caller is entitled to: account, open, or unreadable. Composed from poll_status, poll_group, open_poll_view and open_poll_group rather than duplicating them; grants no access none of those would.';

-- One gate over everything a finished poll shows, so the ballot sheet opens
-- in the same read as the rest of it.
--
-- 0050 folded the tally and the roster into `poll_page` and deliberately left
-- the published ballot sheet out, because its gate was written differently and
-- a call that raised inside `poll_page` would take the whole page down rather
-- than one card. This reconciles the gate. It is not only plumbing: the two
-- gates did not merely differ in wording, they differed in what they let out.
--
-- `poll_results_revealed(poll)` -- what every read reports as
-- `results_available`, and what `assert_results_readable` and
-- `assert_open_results_readable` both refuse under -- is *group-wide*: at
-- least one ballot, and `poll_gate_open` true of **every question in the
-- group**. That is the whole point of it. A poll of five questions that
-- revealed question one's result while question three was still taking votes
-- would let the early answers steer the late ones, which is the promise both
-- modes make and the reason the predicate walks the group at all.
--
-- Both ballot functions asked their own question only:
--
--   * `poll_ballots`      -- `closed_at is null and (invited = 0 or voted <
--                            invited)`, which is `poll_gate_open` of this row
--                            and no other (the `mode = 'invite'` clause makes
--                            no difference: an open poll never has invitees).
--   * `open_poll_ballots` -- `closed_at is null`, likewise.
--
-- So on a multi-question poll, a question that had finished handed out every
-- ballot cast in it while `get_poll_results` on that same question refused --
-- and the sheet *is* the tally, in the form it can be recomputed from. The
-- app never asked (both cards render behind `results_available`), so nothing
-- leaked through the pages; the door was open all the same, and these are
-- functions any participant may call directly.
--
-- Both now refuse under `poll_results_revealed`. It is the same per-question
-- condition they already applied, and-ed across the group, so this can only
-- ever refuse where they used to answer -- never the reverse -- and on a poll
-- of one question, which is nearly all of them, nothing moves at all.
--
-- The wording stays each function's own. One predicate does not mean one
-- sentence: what is being refused here is the sheet, not the tally, and the
-- reader is told which. The branch that picks the sentence is now `mode`
-- rather than a second count of the invite list, which is the same answer said
-- once -- `poll_gate_open` requires `invited > 0`, so an invite poll with
-- nobody on its list can only ever be unlocked by being closed, exactly as an
-- open one is, and it is the same branch `assert_results_readable` takes.
create or replace function public.poll_ballots(p_poll_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_poll polls;
  v_voted int;
begin
  select * into v_poll from polls where id = p_poll_id;

  if not found then
    raise exception 'Poll not found';
  end if;

  -- Same "not found" for a poll that exists but isn't yours: whether a given
  -- id is a real poll is not something an outsider needs to learn.
  if not (
    v_poll.created_by = auth.uid()
    or exists (
      select 1 from invited_voters iv where iv.poll_id = p_poll_id and iv.email = v_email
    )
  ) then
    raise exception 'Poll not found';
  end if;

  -- Deliberately before the creator has been given any special treatment,
  -- because they get none: hiding ballots is a promise made to the people who
  -- voted, not an access level.
  if not v_poll.show_ballots then
    raise exception 'This poll does not publish individual ballots';
  end if;

  select count(*) into v_voted from ballots where poll_id = p_poll_id;

  -- Before the reveal rather than through it, as assert_results_readable puts
  -- it: a poll closed with nothing in it is not "not out yet", it is a poll
  -- with no ballots to publish.
  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  if not poll_results_revealed(v_poll) then
    -- The two ways in, so the reader is told which one this poll has not
    -- reached. An open poll has only the close; an invite poll has the
    -- completion as well, and being told to wait for the close on a poll that
    -- will unlock itself would send its reader to a button they may not have.
    if v_poll.mode = 'open' then
      raise exception 'Ballots are not available until the poll is closed';
    end if;
    raise exception 'Ballots are not available until everyone has voted';
  end if;

  return ballot_sheet(p_poll_id, v_poll.show_voters);
end;
$$;

alter function public.poll_ballots(uuid) owner to postgres;
revoke all on function public.poll_ballots(uuid) from public;
grant all on function public.poll_ballots(uuid) to authenticated;

comment on function public.poll_ballots(uuid) is
  'Every ballot in a poll, to somebody in that poll, once the poll publishes them and its results are out. Gated on poll_results_revealed, the same predicate the tally is gated on and reported as results_available: on a poll of several questions the sheet waits for all of them, because the sheet is the tally in the form it can be recomputed from. Says nothing about how the reader reached the poll: an open poll''s creator gets the sheet open_poll_ballots would hand the same poll''s link, on the same terms.';


create or replace function public.open_poll_ballots(p_poll_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
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

  -- Closed first, in the order assert_open_results_readable asks it: on a poll
  -- still taking votes that is the accurate answer, and "no votes were cast"
  -- would be a confusing thing to say about a poll people can still vote in.
  --
  -- An open poll's questions have only one way to stop, so the group-wide
  -- reveal here reads as "every question in it is closed" -- which is what a
  -- sheet of one question's ballots would otherwise get ahead of.
  if not (select bool_and(poll_gate_open(q.*)) from poll_group_members(v_poll) q) then
    raise exception 'Ballots are not available until the poll is closed';
  end if;

  select count(*) into v_voted from ballots where poll_id = v_poll.id;

  if v_voted = 0 then
    raise exception 'No votes were cast in this poll';
  end if;

  return ballot_sheet(v_poll.id, v_poll.show_voters);
end;
$$;

alter function public.open_poll_ballots(uuid) owner to postgres;
revoke all on function public.open_poll_ballots(uuid) from public;
grant all on function public.open_poll_ballots(uuid) to anon;
grant all on function public.open_poll_ballots(uuid) to authenticated;

comment on function public.open_poll_ballots(uuid) is
  'Every ballot in an open poll, to anyone holding its link, once the poll publishes them and every question in its group is closed. The same gate poll_ballots applies and the same sheet it returns; the split is only about how the caller proves the right to it.';


-- And with one gate over all three, the sheet rides along with the tally and
-- the roster. Same shape as 0050: carried on exactly the polls whose page
-- draws it -- `show_ballots` and the reveal, which is what `<Ballots>` is
-- rendered behind -- and null everywhere else, meaning "not carried, ask for
-- yourself" rather than "there is none".
--
-- This is the last of the four requests a finished poll used to cost.
create or replace function public.poll_page(p_poll_id uuid, p_voter_key text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
  v_creator boolean;
  v_revealed boolean;
begin
  -- Read without a visibility test, because which test applies is what this
  -- function is here to work out. Nothing about the row escapes below except
  -- through a branch that has earned it.
  select p.* into v_poll from polls p where p.id = p_poll_id;

  if not found then
    return jsonb_build_object('kind', 'unreadable');
  end if;

  -- Held rather than asked twice: the account door below tests it, and the
  -- roster wants the same answer for its own reason -- a creator keeps the
  -- invite list on a poll that shows nobody, because for them it is the list
  -- they manage rather than a record of who voted.
  v_creator := is_poll_creator(v_poll.id);
  -- Likewise, and it is the more expensive of the two: this walks the group.
  -- Both branches below gate the tally and the sheet on it, and it is the same
  -- predicate `poll_status` and `open_poll_view` report as
  -- `results_available` -- which is what keeps what the server carries and
  -- what the browser draws from coming apart.
  v_revealed := poll_results_revealed(v_poll);

  -- The account reading: the same door `polls_select` opens, asked with the
  -- same two functions so there is no second wording of it to keep in step.
  if v_creator or is_invited_to_poll(v_poll.id) then
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
      end,
      -- The tally, once there is one. `get_poll_results` re-establishes the
      -- reader for itself before running STAR, which is the whole of the rule
      -- and is stated in one place still.
      --
      -- One field for both readings of an open poll: the creator's page draws
      -- the same panel a stranger's does, and `open_poll_results` would hand
      -- it the same `poll_tally` this does.
      'results', case when v_revealed then get_poll_results(v_poll.id) else null end,
      -- And the sheet those numbers can be checked against, on the poll that
      -- publishes it. Same reveal, now that there is only one; `poll_ballots`
      -- applies `show_ballots` itself, and it is repeated here because this is
      -- the condition `<Ballots>` is rendered behind and asking for a sheet
      -- the page will not draw is the request this is here to save.
      'ballots', case
        when v_revealed and v_poll.show_ballots then poll_ballots(v_poll.id)
        else null
      end,
      -- And the roster, on the poll and the reader that have one to draw: an
      -- invite poll, read by its creator or showing its respondents. Anyone
      -- else on a poll that hides them has no card, so there is nothing to
      -- carry and nothing is asked for -- the same reason the browser does
      -- not make the request rather than making it and expecting it to fail.
      --
      -- `poll_invitees` decides what each row may say, including nulling the
      -- per-person columns for a creator whose poll hides respondents. It is
      -- called, not copied, so that stays true here.
      'invitees', case
        when v_poll.mode = 'invite' and (v_creator or v_poll.show_voters) then (
          select coalesce(jsonb_agg(to_jsonb(i) order by i.email), '[]'::jsonb)
          from poll_invitees(v_poll.id) i
        )
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
      'questions', open_poll_group(v_poll.id),
      -- The tally and the sheet on the same terms as the account branch, and
      -- through the doors this reader actually has: the poll's own link proves
      -- the right to both rather than a session. The same numbers and the same
      -- rows either way -- neither says anything about who is reading it, so
      -- there is no boundary here for them to cross.
      'results', case when v_revealed then open_poll_results(v_poll.id) else null end,
      'ballots', case
        when v_revealed and v_poll.show_ballots then open_poll_ballots(v_poll.id)
        else null
      end
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
  'The one read that opens a poll page: what this reader may see at this address, and the whole of it. Tagged account / open / unreadable. Carries the tally, the published ballot sheet and the invitee roster where the page it describes will draw them, so a finished poll opens in one round trip; null on any of them means "not here, ask for yourself" rather than "there is none".';

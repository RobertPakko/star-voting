-- A finished poll opens in one read, like every other poll.
--
-- 0048 folded the four-or-five requests a poll page was assembled from into
-- `poll_page`, and stopped there because that is what the *route* needs: what
-- may this reader see here, and the page to draw with it. It is not what the
-- page draws. A poll whose results are out draws two more cards, and each of
-- them went and asked for itself the moment it mounted -- which it could not
-- do until `poll_page` came back, because nothing before that answer said the
-- poll was finished or that the reader was inside it.
--
-- So opening a completed poll cost `poll_page`, and then, one round trip
-- behind it, `get_poll_results` and `poll_invitees` together. Two round trips
-- for a page every part of which the server could have assembled in one, and
-- the second one lands on a skeleton the reader is already looking at.
--
-- Both are folded in here, on exactly the terms 0048 set:
--
-- **Only when the page will draw them.** The tally rides along when the
-- results are out and not otherwise -- `poll_results_revealed` is the same
-- predicate the three reads already report as `results_available`, which is
-- the same predicate the two cards are rendered behind, so what the server
-- carries and what the browser draws cannot come apart. A poll still taking
-- votes pays nothing: STAR does not run, and the roster is not read. The
-- roster is a poll-and-reader question rather than a stage question, so its
-- own condition is the client's, exactly: an invite poll, read by its creator
-- or showing its respondents.
--
-- **Nothing here is a new privilege.** `get_poll_results`, `open_poll_results`
-- and `poll_invitees` are called rather than reimplemented, so every rule
-- about who may read a tally or a roster stays in the one function that
-- states it, and each still re-checks the reader for itself. That the branch
-- has already established the same thing is belt and braces, not a shortcut:
-- there is no path here that hands anything to a reader who could not have
-- asked for it a request at a time.
--
-- **Null means "ask for yourself", not "there is none".** These three fields
-- are a handoff of work already done, not a second way of finding out whether
-- results exist -- `results_available` on the status and on the view is still
-- the only thing that says so, and is what the pages branch on. The cards
-- fall back to their own read whenever the field is null, which is what keeps
-- them working where no `poll_page` read is in hand: a poll that finishes
-- while somebody is watching it (the live tick is deliberately narrow and
-- carries neither of these), a crossing between two questions, and the About
-- page's sample, which is answered out of a file.
--
-- **What is deliberately not folded in is the published ballot sheet.**
-- `poll_ballots` gates on this poll's own close -- `closed_at is null and
-- (v_invited = 0 or v_voted < v_invited)` -- where `results_available` gates
-- on every question in the group having stopped. On a poll of one question
-- those agree; on a group they need not, and a `poll_ballots` call that
-- raised inside this function would take the whole page down with it rather
-- than one card. Reconciling the two gates is a change to make on purpose,
-- and this is not it.
create or replace function public.poll_page(p_poll_id uuid, p_voter_key text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_poll polls;
  v_creator boolean;
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
      -- The tally, once there is one. `poll_results_revealed` is the status's
      -- own `results_available`, so this is non-null on exactly the polls
      -- whose page draws a tally -- and `get_poll_results` re-establishes the
      -- reader for itself before running STAR, which is the whole of the rule
      -- and is stated in one place still.
      --
      -- One field for both readings of an open poll: the creator's page draws
      -- the same panel a stranger's does, and `open_poll_results` would hand
      -- it the same `poll_tally` this does.
      'results', case
        when poll_results_revealed(v_poll) then get_poll_results(v_poll.id)
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
      -- The tally on the same terms as the account branch, through the door
      -- this reader actually has: `open_poll_results` proves the right with
      -- the poll's own link rather than with a session. Same `poll_tally`
      -- underneath, and it says nothing per-reader, so there is no boundary
      -- here for it to cross.
      'results', case
        when poll_results_revealed(v_poll) then open_poll_results(v_poll.id)
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
  'The one read that opens a poll page: what this reader may see at this address, and the whole of it. Tagged account / open / unreadable. Carries the tally and the invitee roster where the page it describes will draw them, so a finished poll opens in one round trip; null on either means "not here, ask for yourself" rather than "there is none".';

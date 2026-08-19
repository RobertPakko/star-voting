-- What a finished poll decided, asked for by the page that wants it.
--
-- The poll list says how each poll ended rather than that it ended, which
-- means it needs the elected option's name. That name is derived rather than
-- stored: a winner column would be a second copy of an answer the ballots
-- already hold, and every path that changes the ballots -- submit, reset, a
-- late invite -- would have to remember to keep it true. poll_winner_name()
-- runs the same star_round() the results page runs, so the badge on the list
-- and the winner on the poll page cannot disagree. There is one
-- implementation of the method and this is a second caller of it.
--
-- Running an election is not free, though, and the list refreshes itself
-- every few seconds for as long as it is on screen. So the winners are a
-- separate call rather than a column on list_polls():
--
--   * list_polls() stays exactly what it was -- one cheap STABLE query, once
--     per refresh tick, with no election in it. Had the name been a column
--     there, every tick would have re-run every finished poll's election,
--     for an answer that cannot change.
--   * poll_winners() is asked only for the polls the browser cannot already
--     name -- which is the ones on the page being looked at, the first time
--     it is looked at, and nothing at all after that. A settled poll has
--     taken its last vote, so one answer lasts as long as the tab does.
--
-- It also fails better. An app deployed ahead of its migrations (the build
-- ships on push; migrations land when they merge) calls a poll_winners()
-- that isn't there yet, and gets a list with no winners named on it rather
-- than no list at all.

CREATE OR REPLACE FUNCTION "public"."poll_winner_name"("p_poll_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_pool uuid[];
  v_winner uuid;
begin
  -- No ballots, no election. The caller checks this first anyway; the point
  -- of repeating it is that star_round() would otherwise elect the
  -- highest-scoring option of an empty tally.
  if not exists (select 1 from ballots where poll_id = p_poll_id) then
    return null;
  end if;

  select coalesce(array_agg(id), '{}'::uuid[]) into v_pool
  from candidates where poll_id = p_poll_id;

  if coalesce(array_length(v_pool, 1), 0) = 0 then
    return null;
  end if;

  -- The head round is the whole of STAR: the score round, its tie-breaks and
  -- the runoff. The full ranking below it is this function again on what is
  -- left, and a list row wants none of that.
  v_winner := (star_round(p_poll_id, v_pool)->>'winner_id')::uuid;

  if v_winner is null then
    -- A runoff level on preference, on points and on five-star votes alike.
    -- The app reports the tie rather than inventing a winner, so this stays
    -- null and the list says the results are ready instead.
    return null;
  end if;

  return (select name from candidates where id = v_winner);
end;
$$;


ALTER FUNCTION "public"."poll_winner_name"("p_poll_id" "uuid") OWNER TO "postgres";

-- Not callable on its own: it answers for any poll id it is handed, with no
-- check that the caller may see that poll. poll_winners() below is the only
-- thing that calls it, and does that check first.
REVOKE ALL ON FUNCTION "public"."poll_winner_name"("p_poll_id" "uuid") FROM PUBLIC;


CREATE OR REPLACE FUNCTION "public"."poll_winners"("p_poll_ids" "uuid"[]) RETURNS TABLE("poll_id" "uuid", "winner_name" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_ids uuid[] := coalesce(p_poll_ids, '{}'::uuid[]);
  v_id uuid;
  v_poll polls;
  v_invited int;
  v_voted int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- One election per id, so the list of ids is bounded. The page asks about
  -- what is on screen, which is ten; this is well clear of that and still
  -- refuses to be handed the whole database.
  if coalesce(array_length(v_ids, 1), 0) > 200 then
    raise exception 'Too many polls in one request';
  end if;

  foreach v_id in array v_ids loop
    -- Visibility, on exactly the terms list_polls() uses: the polls you
    -- created and the polls you were invited to. An id the caller cannot see
    -- produces no row at all rather than a null one -- "not yours" and "no
    -- winner" are different answers and must not arrive looking alike.
    select * into v_poll from polls p
    where p.id = v_id
      and (
        p.created_by = auth.uid()
        or exists (
          select 1 from invited_voters iv where iv.poll_id = p.id and iv.email = v_email
        )
      );

    continue when not found;

    -- Aliased because this function's own OUT column is called poll_id, and
    -- an unqualified one in here means that rather than the table's.
    select count(*)::int into v_invited from invited_voters iv where iv.poll_id = v_id;
    select count(*)::int into v_voted from ballots b where b.poll_id = v_id;

    poll_id := v_id;
    -- Results unlock on the same terms everywhere: an open poll on close, an
    -- invite poll on close or on completion. Until then there is no winner
    -- to report, and reporting one would be telling a voter how it is going
    -- while they can still vote.
    winner_name := case
      when v_voted > 0 and (
        v_poll.closed_at is not null
        or (v_poll.mode = 'invite' and v_invited > 0 and v_voted >= v_invited)
      )
      then poll_winner_name(v_id)
    end;
    return next;
  end loop;
end;
$$;


ALTER FUNCTION "public"."poll_winners"("p_poll_ids" "uuid"[]) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."poll_winners"("p_poll_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."poll_winners"("p_poll_ids" "uuid"[]) TO "authenticated";

-- Sixty windows, tied sixty ways, tallied inside a timeout -- and the one
-- shape of time poll that elects nobody.
--
-- A time poll hands the tally the worst shape it has ever been given. A voter
-- paints a calendar rather than reading a list, so contiguous windows come
-- back with the same score or very nearly it, and the score round ends in one
-- enormous tie rather than a handful of small ones. `star_round` then builds
-- every ordered pair in the tied group and cross-joins each against every
-- ballot: sixty tied windows is 3,540 ordered pairs.
--
-- Both of the paths a person waits on run that. `poll_tally` runs on every
-- read of the results, and `poll_winner_name` -- through `settle_winner` --
-- runs inside the transaction of the deciding ballot, so the last voter to
-- submit waits for it before their vote returns. The timeout here is the
-- ceiling those two are allowed to cost. It is generous against what was
-- measured when this landed (about a second for the deciding ballot at twelve
-- ballots, about 2.4s for the tally at sixty) so that an ordinary slow machine
-- does not fail the suite; what it catches is the tally becoming an order of
-- magnitude worse, which is what a re-planned join or a lost index looks like.
-- See section 4 of 0055_schedule_polls.sql for what makes it as fast as it is.

begin;

-- The five days of hourly window starts every case below votes on, as ISO
-- timestamps in the poll's fixed offset -- which is exactly what the browser
-- enumerates from a schedule and sends as option names.
create or replace function pg_temp.windows() returns text[] language sql immutable as $$
  select array_agg(format('2026-09-%sT%s:00:00-07:00',
                          lpad(d::text, 2, '0'), lpad(h::text, 2, '0'))
                   order by d, h)
  from generate_series(1, 5) d, generate_series(8, 19) h;
$$;

create or replace function pg_temp.voters(p_count int) returns text[] language sql immutable as $$
  select array_agg('voter' || g || '@example.com' order by g) from generate_series(1, p_count) g;
$$;

do $$
declare
  v_poll uuid;
  v_names text[] := pg_temp.windows();
  v_emails text[] := pg_temp.voters(12);
  v_cands uuid[];
  v_scores jsonb;
  v_tally jsonb;
  v_started timestamptz;
  -- One voter's week, twelve hours of it, and every voter is handed the same
  -- week rotated by one. Every window then carries the same total -- so the
  -- score round ties all sixty at once, which is the expensive shape -- while
  -- no two windows have the same ballots behind them, which is what a real
  -- calendar looks like once voters disagree about the edges of a day.
  v_pattern int[] := array[5, 5, 4, 3, 3, 2, 2, 1, 1, 0, 0, 4];
  i int; j int;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Standup', null, v_names, v_emails, 'invite', true, false, null, false,
                        'time',
                        '{"timezone":"-07:00","window":{"start":"08:00","end":"22:00"},
                          "desired_slots":3,"granularity":60}'::jsonb);

  perform tests.assert_eq('a working week of hourly starts is sixty options',
    (select count(*)::int from candidates where poll_id = v_poll), 60);

  select array_agg(id order by sort_order) into v_cands from candidates where poll_id = v_poll;

  for i in 1 .. 11 loop
    perform tests.sign_in(v_emails[i]);
    v_scores := '[]'::jsonb;
    for j in 1 .. 60 loop
      v_scores := v_scores || jsonb_build_array(jsonb_build_object(
        'candidate_id', v_cands[j], 'score', v_pattern[((i + j) % 12) + 1]));
    end loop;
    perform submit_ballot(v_poll, v_scores);
  end loop;

  -- The twelfth ballot completes the poll, so this one statement carries
  -- settle_winner -- and star_round with it -- inside its own transaction.
  -- It is the only wait in the app a voter cannot walk away from.
  perform tests.sign_in(v_emails[12]);
  v_scores := '[]'::jsonb;
  for j in 1 .. 60 loop
    v_scores := v_scores || jsonb_build_array(jsonb_build_object(
      'candidate_id', v_cands[j], 'score', v_pattern[((12 + j) % 12) + 1]));
  end loop;

  set local statement_timeout = '20s';
  v_started := clock_timestamp();
  perform submit_ballot(v_poll, v_scores);
  raise notice '    ..  the deciding ballot took %',
    (clock_timestamp() - v_started)::interval(0);

  perform tests.sign_in('creator@example.com');

  perform tests.assert_eq('the last vote in settles a winner without timing out',
    (select winner_settled_at is not null from polls where id = v_poll), true);
  perform tests.assert_eq('and the winner is one of the windows',
    (select winner_name = any(v_names) from polls where id = v_poll), true);

  v_started := clock_timestamp();
  v_tally := poll_tally(v_poll);
  raise notice '    ..  the tally took %', (clock_timestamp() - v_started)::interval(0);

  perform tests.assert_eq('the results page tallies all sixty',
    jsonb_array_length(v_tally -> 'options'), 60);

  -- This is the assertion the whole case is built around: one tied group of
  -- sixty, which is the tie-break block's worst input and the one a calendar
  -- produces as a matter of course rather than by accident.
  perform tests.assert_eq('with all sixty tied in the score round',
    jsonb_array_length(v_tally #> '{tiebreaks,0,tied}'), 60);
  perform tests.assert_eq('and nothing to separate them but the draw',
    v_tally #>> '{tiebreaks,0,resolved_by}', 'random');
  perform tests.assert_eq('the runoff still decides between the two it drew',
    v_tally #>> '{runoff,resolved_by}', 'preference');
end $$;

-- ---------------------------------------------------------------------------
-- The shape that elects nobody
-- ---------------------------------------------------------------------------

-- Worth a case of its own, because it is not an edge: it is what a poll looks
-- like when everybody paints the same whole days, which is the gesture the
-- calendar most encourages. Windows inside one painted block get *identical*
-- score vectors from every ballot -- so the two that reach the runoff are
-- identical too, and the runoff has no draw to fall back on the way the score
-- round does. It is level on preference, on points and on five-star votes
-- alike, which is `unresolved`: the app reports the tie rather than inventing
-- a winner, and there is no winner to put on the card.
--
-- The plan this feature was built from assumed the opposite -- that two
-- shifted copies of one good slot taking both finalist slots was harmless,
-- since either would be a fine answer. Either would be; neither is what comes
-- back. Asserted here so that the day somebody decides to give the runoff a
-- last resort, this case is what tells them the behaviour changed.

do $$
declare
  v_poll uuid;
  v_names text[] := pg_temp.windows();
  v_emails text[] := pg_temp.voters(6);
  v_cands uuid[];
  v_scores jsonb;
  v_tally jsonb;
  i int; j int;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Retro', null, v_names, v_emails, 'invite', true, false, null, false,
                        'time',
                        '{"timezone":"-07:00","window":{"start":"08:00","end":"22:00"},
                          "desired_slots":3,"granularity":60}'::jsonb);
  select array_agg(id order by sort_order) into v_cands from candidates where poll_id = v_poll;

  -- Everybody is free all week and says so: one flat painting each. The
  -- options are numbered 1-60 in day-major order, so this is "every window,
  -- same rating" -- the whole calendar painted in one drag.
  for i in 1 .. 6 loop
    perform tests.sign_in(v_emails[i]);
    v_scores := '[]'::jsonb;
    for j in 1 .. 60 loop
      v_scores := v_scores || jsonb_build_array(
        jsonb_build_object('candidate_id', v_cands[j], 'score', 4));
    end loop;
    perform submit_ballot(v_poll, v_scores);
  end loop;
  perform tests.sign_in('creator@example.com');

  v_tally := poll_tally(v_poll);

  perform tests.assert_eq('sixty identical windows still reach a runoff',
    jsonb_array_length(v_tally -> 'finalists'), 2);
  perform tests.assert_eq('which is level on every measure there is',
    v_tally #>> '{runoff,resolved_by}', 'unresolved');
  perform tests.assert_eq('so the poll reports a tie',
    (v_tally ->> 'tie')::boolean, true);
  perform tests.assert_null('and elects nobody',
    v_tally ->> 'winner_id');
  perform tests.assert_null('leaving the card with no time to name',
    (select winner_name from polls where id = v_poll));
  perform tests.assert_eq('though the results are out, and say so',
    (select winner_settled_at is not null from polls where id = v_poll), true);
end $$;

rollback;

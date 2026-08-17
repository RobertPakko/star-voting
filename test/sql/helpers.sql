-- Assertions and seeding for the tally tests.
--
-- Seeding deliberately goes through create_poll() and submit_ballot() rather
-- than inserting into the tables directly, so a case exercises the same write
-- path the app uses and cannot set up a state the app could never produce.

create schema if not exists tests;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------

create or replace function tests.assert_eq(p_label text, p_actual anyelement, p_expected anyelement)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception E'%\n    expected: %\n    actual:   %',
      p_label,
      coalesce(p_expected::text, '<null>'),
      coalesce(p_actual::text, '<null>');
  end if;
  raise notice '    ok  %', p_label;
end $$;

create or replace function tests.assert_null(p_label text, p_actual anyelement)
returns void language plpgsql as $$
begin
  if p_actual is not null then
    raise exception E'%\n    expected: <null>\n    actual:   %', p_label, p_actual::text;
  end if;
  raise notice '    ok  %', p_label;
end $$;

-- Asserts that evaluating p_sql fails, and that the message contains p_expected.
create or replace function tests.assert_raises(p_label text, p_sql text, p_expected text)
returns void language plpgsql as $$
declare
  v_message text;
begin
  begin
    execute p_sql;
  exception when others then
    v_message := sqlerrm;
  end;

  if v_message is null then
    raise exception E'%\n    expected an error containing: %\n    actual:   no error raised',
      p_label, p_expected;
  end if;

  if position(p_expected in v_message) = 0 then
    raise exception E'%\n    expected an error containing: %\n    actual:   %',
      p_label, p_expected, v_message;
  end if;

  raise notice '    ok  %', p_label;
end $$;

-- ---------------------------------------------------------------------------
-- Seeding
-- ---------------------------------------------------------------------------

create or replace function tests.sign_in(p_email text)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  select id into v_id from auth.users where email = p_email;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (id, email) values (v_id, p_email);
  end if;
  update auth._session set user_id = v_id, email = p_email where id;
  return v_id;
end $$;

-- Creates a poll and casts every ballot in it.
--
-- p_ballots is one row per voter and one column per option, in the same order
-- as p_options, holding that voter's 0-5 score. So
--
--   tests.seed_poll(array['Apple', 'Banana'], array[[5, 4], [0, 1]])
--
-- is two voters: the first scored Apple 5 and Banana 4, the second 0 and 1.
--
-- Every option gets an explicit score on every ballot, which is what
-- submit_ballot() requires of the app as well.
create or replace function tests.seed_poll(
  p_options text[],
  p_ballots int[][],
  p_title text default 'Test poll',
  p_mode text default 'invite'
)
returns uuid language plpgsql as $$
declare
  v_poll_id uuid;
  v_voters int := array_length(p_ballots, 1);
  v_options int := array_length(p_options, 1);
  v_emails text[];
  v_candidates uuid[];
  v_scores jsonb;
  i int;
  j int;
begin
  if array_length(p_ballots, 2) is distinct from v_options then
    raise exception 'seed_poll: each ballot needs one score per option (% options, % columns)',
      v_options, array_length(p_ballots, 2);
  end if;

  select array_agg('voter' || g || '@example.com' order by g)
  into v_emails
  from generate_series(1, v_voters) g;

  perform tests.sign_in('creator@example.com');
  v_poll_id := create_poll(p_title, null, p_options, v_emails, p_mode, true, false);

  -- create_poll preserves the author's ordering in sort_order, so this lines
  -- the candidate ids back up with the columns of p_ballots.
  select array_agg(id order by sort_order, name)
  into v_candidates
  from candidates where poll_id = v_poll_id;

  for i in 1 .. v_voters loop
    perform tests.sign_in(v_emails[i]);

    v_scores := '[]'::jsonb;
    for j in 1 .. v_options loop
      v_scores := v_scores || jsonb_build_array(jsonb_build_object(
        'candidate_id', v_candidates[j],
        'score', p_ballots[i][j]));
    end loop;

    perform submit_ballot(v_poll_id, v_scores);
  end loop;

  perform tests.sign_in('creator@example.com');
  return v_poll_id;
end $$;

-- ---------------------------------------------------------------------------
-- Reading a tally by option name
--
-- Ids are random per run, so cases name options instead. Where two options
-- share a total score the tally orders them by id, which is the documented
-- random tie-break -- so which finalist gets labelled "a" is not stable and
-- must not be asserted on directly.
-- ---------------------------------------------------------------------------

create or replace function tests.option_name(p_tally jsonb, p_id text)
returns text language sql stable as $$
  select o->>'name' from jsonb_array_elements(p_tally->'options') o where o->>'id' = p_id
$$;

create or replace function tests.winner(p_tally jsonb)
returns text language sql stable as $$
  select tests.option_name(p_tally, p_tally->>'winner_id')
$$;

-- The options in the score-round list, in the order the results page shows them.
create or replace function tests.option_order(p_tally jsonb)
returns text[] language sql stable as $$
  select array_agg(o->>'name') from jsonb_array_elements(p_tally->'options') o
$$;

create or replace function tests.total_score(p_tally jsonb, p_name text)
returns int language sql stable as $$
  select (o->>'total_score')::int
  from jsonb_array_elements(p_tally->'options') o where o->>'name' = p_name
$$;

create or replace function tests.finalists(p_tally jsonb)
returns text[] language sql stable as $$
  select array_agg(tests.option_name(p_tally, f #>> '{}') order by tests.option_name(p_tally, f #>> '{}'))
  from jsonb_array_elements(p_tally->'finalists') f
$$;

-- How many voters preferred p_name over the other finalist, regardless of
-- which side of the runoff it was labelled.
create or replace function tests.prefers(p_tally jsonb, p_name text)
returns int language sql stable as $$
  select case
    when tests.option_name(p_tally, p_tally #>> '{finalists,0}') = p_name
      then (p_tally #>> '{runoff,prefers_a}')::int
    else (p_tally #>> '{runoff,prefers_b}')::int
  end
$$;

create or replace function tests.five_stars(p_tally jsonb, p_name text)
returns int language sql stable as $$
  select case
    when tests.option_name(p_tally, p_tally #>> '{finalists,0}') = p_name
      then (p_tally #>> '{runoff,five_stars_a}')::int
    else (p_tally #>> '{runoff,five_stars_b}')::int
  end
$$;

-- The options placed at p_place in the full ranking, alphabetically. More than
-- one name means the ranking could not separate them.
create or replace function tests.placed_at(p_tally jsonb, p_place int)
returns text[] language sql stable as $$
  select array_agg(o->>'name' order by o->>'name')
  from jsonb_array_elements(p_tally->'ranking') r,
       jsonb_array_elements(r->'options') o
  where (r->>'place')::int = p_place
$$;

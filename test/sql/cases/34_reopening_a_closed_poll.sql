-- A closed poll can be opened again, and says so afterwards.
--
-- Closing used to be one-way: the only path back was `reset_poll`, which buys
-- it by deleting every vote. `reopen_poll` is the other way -- the votes stay,
-- the results go back under their gate, and the poll takes more.
--
-- What has to hold is what a reader of the result is owed. A poll that showed
-- its tally and then took another vote is a different thing from one that
-- never did, so the second kind marks itself and the tally carries the mark.
-- And everything a reopened poll has to forget -- its winner, its
-- results-ready notice -- it already forgets, because closing and reopening
-- are the same column moving.

begin;

-- ---------------------------------------------------------------------------
-- A poll closed early, and opened again
-- ---------------------------------------------------------------------------

do $$
declare
  v_poll uuid;
  v_row polls;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Lunch', null, array['Pizza', 'Sushi'],
                        array['voter1@example.com', 'voter2@example.com',
                              'voter3@example.com'],
                        'invite', true, false);

  -- Two of the three, so the poll is closed by hand rather than by turnout.
  -- A poll everyone invited has answered is revealed whether or not it is
  -- closed, and reopening cannot take it off full turnout; closing early is
  -- the state this is for.
  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);
  perform tests.sign_in('voter2@example.com');
  perform tests.cast_ballot(v_poll, array[4, 1]);

  perform tests.sign_in('creator@example.com');
  perform close_poll(v_poll);

  select * into v_row from polls where id = v_poll;
  perform tests.assert_eq('a closed poll has its results out',
    poll_results_revealed(v_row), true);
  perform tests.assert_eq('and an answer worked out',
    v_row.winner_name, 'Pizza');
  perform tests.assert_eq('with nothing to warn anybody about yet',
    (poll_tally(v_poll)->>'votes_after_reveal')::boolean, false);

  -- The same two rules every other lifecycle button is under: it is the
  -- creator's, and whether a given id is a real poll is not something an
  -- outsider learns from the message.
  perform tests.sign_in('voter1@example.com');
  perform tests.assert_raises('only the creator reopens a poll',
    format('select reopen_poll(%L)', v_poll),
    'Only the poll creator can reopen this poll');

  perform tests.sign_in('creator@example.com');
  perform reopen_poll(v_poll);

  select * into v_row from polls where id = v_poll;
  perform tests.assert_eq('reopening puts the poll back to taking votes',
    v_row.closed_at is null, true);
  perform tests.assert_eq('with its results back under the gate',
    poll_results_revealed(v_row), false);
  perform tests.assert_eq('and no ballot lost',
    (select count(*)::int from ballots where poll_id = v_poll), 2);

  -- settle_winner reconciles rather than assumes, so the answer goes back to
  -- "not worked out" on its own: a poll that finishes again is a second
  -- result, worked out from the votes it has then. See 25.
  perform tests.assert_null('the winner is forgotten while it votes again',
    v_row.winner_name);
  perform tests.assert_eq('and so is the moment it was settled',
    v_row.winner_settled_at is null, true);

  perform tests.assert_eq('the poll remembers that its tally has been seen',
    v_row.reopened_after_reveal, true);
  perform tests.assert_eq('though nothing has moved since',
    v_row.votes_after_reveal, false);

  perform tests.assert_raises('a poll that is open is not reopened',
    format('select reopen_poll(%L)', v_poll),
    'This poll is not closed');

  -- ---- the vote that the banner is about ----------------------------------

  perform tests.sign_in('voter3@example.com');
  perform tests.cast_ballot(v_poll, array[0, 5]);

  select * into v_row from polls where id = v_poll;
  perform tests.assert_eq('a vote cast after the reveal marks the poll',
    v_row.votes_after_reveal, true);

  -- Full turnout now, so the results are out again without anybody closing
  -- anything -- and this time they come with a caveat.
  perform tests.assert_eq('and the tally carries it to the results page',
    (poll_tally(v_poll)->>'votes_after_reveal')::boolean, true);
  perform tests.assert_eq('which is not the other caveat',
    (poll_tally(v_poll)->>'options_edited_after_votes')::boolean, false);
  perform tests.assert_eq('the second result counts the vote that came late',
    (poll_tally(v_poll)->>'voter_count')::int, 3);
  perform tests.assert_eq('and is the answer the results page now names',
    (select winner_name from polls where id = v_poll), tests.winner(poll_tally(v_poll)));
end $$;

-- ---------------------------------------------------------------------------
-- A changed vote is a late vote too
-- ---------------------------------------------------------------------------
--
-- Four functions write to ballots -- two that cast one and two that change one
-- -- and the flag is raised by a trigger on the table rather than by each of
-- them, so that no door into it can be added without it.

do $$
declare
  v_poll uuid;
  v_scores jsonb;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Dinner', null, array['Ramen', 'Curry'],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false);

  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);

  perform tests.sign_in('creator@example.com');
  perform close_poll(v_poll);
  perform reopen_poll(v_poll);

  perform tests.assert_eq('a reopened poll starts with nothing to report',
    (select votes_after_reveal from polls where id = v_poll), false);

  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 2))
  into v_scores from candidates where poll_id = v_poll;

  perform tests.sign_in('voter1@example.com');
  perform revise_ballot(v_poll, v_scores);

  perform tests.assert_eq('changing a vote after the reveal marks the poll too',
    (select votes_after_reveal from polls where id = v_poll), true);
end $$;

-- ---------------------------------------------------------------------------
-- A poll that closed with nothing in it revealed nothing
-- ---------------------------------------------------------------------------

do $$
declare
  v_poll uuid;
begin
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Empty', null, array['Yes', 'No'],
                        array['voter1@example.com'], 'invite', true, false);

  perform close_poll(v_poll);
  perform reopen_poll(v_poll);

  perform tests.assert_eq('a poll closed with no votes in it is not marked',
    (select reopened_after_reveal from polls where id = v_poll), false);

  -- Which is the whole point of asking rather than assuming: these are the
  -- poll's first votes, not late ones.
  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_poll, array[5, 0]);

  perform tests.assert_eq('so the votes it takes afterwards are ordinary ones',
    (select votes_after_reveal from polls where id = v_poll), false);
end $$;

-- ---------------------------------------------------------------------------
-- One act over the whole group
-- ---------------------------------------------------------------------------

do $$
declare
  v_questions uuid[];
  v_q1 uuid;
  v_q2 uuid;
begin
  v_questions := tests.seed_group(
    array[
      row('Where should we eat?', array['Pizza', 'Salad'])::tests.question,
      row('What time?',           array['Noon', 'One'])::tests.question
    ],
    array['voter1@example.com', 'voter2@example.com']);

  v_q1 := v_questions[1];
  v_q2 := v_questions[2];

  -- One question answered, the other left blank, and the poll closed over
  -- both of them.
  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_q1, array[5, 0]);

  perform tests.sign_in('creator@example.com');
  perform close_poll(v_q1);
  perform reopen_poll(v_q2);

  perform tests.assert_eq('reopening one question reopens the group',
    (select count(*)::int from polls
      where id = any(v_questions) and closed_at is null), 2);

  -- Marked per question, because the caveat belongs to a tally and a group
  -- has one per question. The question nobody answered showed nobody
  -- anything.
  perform tests.assert_eq('the question whose tally was out is marked',
    (select reopened_after_reveal from polls where id = v_q1), true);
  perform tests.assert_eq('the question that had no tally is not',
    (select reopened_after_reveal from polls where id = v_q2), false);
end $$;

-- ---------------------------------------------------------------------------
-- And the new door is no wider than the ones beside it
-- ---------------------------------------------------------------------------
--
-- `anon` reaches PostgREST as a member of PUBLIC, and a newly created function
-- is executable by PUBLIC until told otherwise -- which is easy to leave out
-- and invisible when you do.

do $$
begin
  perform tests.assert_eq('reopening is not something anyone can do',
    (select bool_or(a::text like '=%')
       from pg_proc p, unnest(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.pronamespace = 'public'::regnamespace and p.proname = 'reopen_poll'),
    false);
  perform tests.assert_eq('while an account can reopen its own poll',
    has_function_privilege('authenticated', 'public.reopen_poll(uuid)', 'execute'),
    true);

  -- The two triggers behind the flags are nobody's to call by hand.
  perform tests.assert_eq('and the bookkeeping behind it is reachable by nobody',
    (select bool_or(a::text like '=%')
       from pg_proc p, unnest(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('mark_votes_after_reveal', 'fill_scores_for_new_option')),
    false);
end $$;

rollback;

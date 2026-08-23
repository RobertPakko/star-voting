-- A poll's creator can correct its option list until somebody votes.
--
-- The option list makes one promise -- everyone who votes scores the same
-- list -- and a poll with no ballots in it has nobody who has scored
-- anything, so nothing is broken by changing it there. The window is exactly
-- "no ballots": it opens at creation, closes on the first vote, and reopens
-- if the creator resets. Where the options came from does not enter into it.

begin;

do $$
declare
  v_creator uuid;
  v_poll uuid;
  v_soliciting uuid;
  v_scores jsonb;
  v_extra uuid;
begin
  v_creator := tests.sign_in('creator@example.com');

  v_poll := create_poll('Lunch', null, array['Pizza', 'Sushi'],
                        array['voter1@example.com'], 'invite', true, false);

  -- Adding goes through a function, like every other write to candidates:
  -- authenticated has no INSERT grant on the table.
  perform creator_add_option(v_poll, 'Tacos', 'from the truck');

  perform tests.assert_eq('the creator can add to a poll nobody has voted in',
    (select count(*)::int from candidates where poll_id = v_poll), 3);
  perform tests.assert_eq('and the option carries its description',
    (select description from candidates where poll_id = v_poll and name = 'Tacos'),
    'from the truck');
  perform tests.assert_eq('landing at the end of the list',
    (select sort_order from candidates where poll_id = v_poll and name = 'Tacos'), 2);

  -- The same field rules the suggestion path applies, because both now go
  -- through insert_option.
  perform tests.assert_raises('the list holds no duplicates',
    format('select creator_add_option(%L, %L)', v_poll, 'tacos'),
    'is already on the list');
  perform tests.assert_raises('an option name is a label, not an essay',
    format('select creator_add_option(%L, %L)', v_poll, repeat('x', 251)),
    'too long');
  -- The ceiling itself, not just some length above it: it moved from 100 to
  -- 250 because real options ran past 100, and a case that only asserts a
  -- refusal would have passed before the move as well as after it.
  perform creator_add_option(v_poll, repeat('y', 250));
  perform tests.assert_eq('but 250 characters of one is still a name',
    (select count(*)::int from candidates where poll_id = v_poll and length(name) = 250), 1);
  delete from candidates where poll_id = v_poll and length(name) = 250;
  perform tests.assert_raises('and it needs a name at all',
    format('select creator_add_option(%L, %L)', v_poll, '   '),
    'Give the option a name');

  -- Nobody else's poll, and nobody else's business whether the id is real.
  perform tests.sign_in('voter1@example.com');
  perform tests.assert_raises('only the creator adds this way',
    format('select creator_add_option(%L, %L)', v_poll, 'Curry'),
    'Poll not found');

  perform tests.sign_in('creator@example.com');
  delete from candidates where poll_id = v_poll and name = 'Tacos';
  perform tests.assert_eq('and can take one back off again',
    (select count(*)::int from candidates where poll_id = v_poll), 2);

  -- But never below what an election needs. finalize_options applies this
  -- floor to a list on its way to becoming a ballot; this is the same floor
  -- applied to a list that already is one.
  perform tests.assert_raises('two options is the floor of a live poll',
    format('delete from candidates where poll_id = %L and name = %L', v_poll, 'Sushi'),
    'at least two options');

  -- ------------------------------------------------------------------
  -- The first vote closes the window, and a reset reopens it.
  -- ------------------------------------------------------------------

  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 5))
  into v_scores from candidates where poll_id = v_poll;

  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_poll, v_scores);

  perform tests.sign_in('creator@example.com');
  perform tests.assert_raises('a poll with a vote in it takes no more options',
    format('select creator_add_option(%L, %L)', v_poll, 'Curry'),
    'already has votes');
  perform tests.assert_raises('and loses none either',
    format('delete from candidates where poll_id = %L and name = %L', v_poll, 'Pizza'),
    'already has votes');

  perform reset_poll(v_poll);
  perform creator_add_option(v_poll, 'Curry');
  perform tests.assert_eq('clearing the votes opens the list again',
    (select count(*)::int from candidates where poll_id = v_poll), 3);

  perform close_poll(v_poll);
  perform tests.assert_raises('a closed poll is not corrected, it is duplicated',
    format('select creator_add_option(%L, %L)', v_poll, 'Ramen'),
    'has been closed');

  -- ------------------------------------------------------------------
  -- A poll still collecting its options is untouched by any of it.
  -- ------------------------------------------------------------------

  v_soliciting := create_poll('Dinner', null, array['Only one'],
                              array['voter1@example.com'],
                              'invite', true, false, null, true);

  select id into v_extra from candidates where poll_id = v_soliciting;
  delete from candidates where id = v_extra;
  perform tests.assert_eq('a list still being collected may be pruned to nothing',
    (select count(*)::int from candidates where poll_id = v_soliciting), 0);
  perform tests.assert_raises('because the floor is applied when it becomes a ballot',
    format('select finalize_options(%L)', v_soliciting),
    'at least two options');
end $$;

rollback;

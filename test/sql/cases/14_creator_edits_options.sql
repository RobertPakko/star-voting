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
  v_pizza uuid;
  v_other uuid;
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
    format('select creator_add_option(%L, %L)', v_poll, repeat('x', 151)),
    'too long');
  perform tests.assert_raises('and a description is a note, not a chapter',
    format('select creator_add_option(%L, %L, %L)', v_poll, 'Curry', repeat('x', 901)),
    'too long');
  -- The ceilings themselves, not just some length above them: they moved
  -- because real options ran past the old ones, and a case that only asserts
  -- a refusal would have passed before the move as well as after it.
  perform creator_add_option(v_poll, repeat('y', 150), repeat('z', 900));
  perform tests.assert_eq('but 150 characters of name and 900 of description fit',
    (select count(*)::int from candidates
      where poll_id = v_poll and length(name) = 150 and length(description) = 900), 1);
  delete from candidates where poll_id = v_poll and length(name) = 150;
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
  -- A correction is one edit, and the floor is applied to where it lands.
  -- ------------------------------------------------------------------
  --
  -- Taken apart into a delete and an insert, a swap is judged on a list
  -- nobody asked for: two options, remove one, and the floor refuses a poll
  -- that was on its way to three. creator_edit_options takes both halves.

  select id into v_pizza from candidates where poll_id = v_poll and name = 'Pizza';

  perform tests.assert_eq('removing one option and adding two is one edit',
    creator_edit_options(v_poll,
      jsonb_build_array(jsonb_build_object('name', 'Ramen'),
                        jsonb_build_object('name', 'Curry')),
      array[v_pizza]),
    2);
  perform tests.assert_eq('and lands where the creator aimed it',
    (select count(*)::int from candidates where poll_id = v_poll), 3);
  perform tests.assert_eq('with the option it dropped gone',
    (select count(*)::int from candidates where poll_id = v_poll and name = 'Pizza'), 0);

  -- The floor did not go away; it moved to the end of the edit.
  perform tests.assert_raises('an edit that ends below two options is refused',
    format('select creator_edit_options(%L, %L, %L)', v_poll, '[]'::jsonb,
           (select array_agg(id) from candidates
             where poll_id = v_poll and name in ('Ramen', 'Curry'))),
    'at least two options');
  perform tests.assert_eq('and takes none of its removals with it',
    (select count(*)::int from candidates where poll_id = v_poll), 3);

  -- Which is the same floor a bare delete still meets a row at a time: the
  -- browser holds that grant, and lifting the check inside an edit is not
  -- lifting it outside one.
  delete from candidates where poll_id = v_poll and name = 'Curry';
  perform tests.assert_raises('a bare delete is still judged on its own',
    format('delete from candidates where poll_id = %L and name = %L', v_poll, 'Ramen'),
    'at least two options');

  -- Nobody else's poll, as everywhere else, and nobody else's options: an id
  -- from another list is not a row this poll's creator may reach through.
  perform tests.sign_in('voter1@example.com');
  perform tests.assert_raises('only the creator edits this way',
    format('select creator_edit_options(%L)', v_poll),
    'Poll not found');
  perform tests.sign_in('creator@example.com');

  v_other := create_poll('Elsewhere', null, array['Here', 'There'],
                         array['voter1@example.com'], 'invite', true, false);
  select id into v_extra from candidates where poll_id = v_other and name = 'Here';
  perform creator_edit_options(v_poll, '[]'::jsonb, array[v_extra]);
  perform tests.assert_eq('an id from another poll is a no-op, not a delete',
    (select count(*)::int from candidates where poll_id = v_other), 2);

  -- Back to the two it started with, which is a shrink and a growth in one
  -- press as well.
  perform creator_edit_options(v_poll, jsonb_build_array(jsonb_build_object('name', 'Pizza')),
    (select array_agg(id) from candidates where poll_id = v_poll and name = 'Ramen'));
  perform tests.assert_eq('and an edit may land exactly on the floor',
    (select count(*)::int from candidates where poll_id = v_poll), 2);

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
  perform tests.assert_raises('however the two halves arrive',
    format('select creator_edit_options(%L, %L)', v_poll,
           jsonb_build_array(jsonb_build_object('name', 'Curry'))),
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

  -- And an edit of one is under the same rule as a delete from one: there is
  -- no floor to land on yet, whichever way the list is being pruned.
  perform creator_edit_options(v_soliciting,
    jsonb_build_array(jsonb_build_object('name', 'Ramen')));
  perform tests.assert_eq('an edit of a list still being collected has no floor either',
    (select count(*)::int from candidates where poll_id = v_soliciting), 1);

  -- ------------------------------------------------------------------
  -- And the new door is no wider than the ones beside it.
  -- ------------------------------------------------------------------
  --
  -- `anon` reaches PostgREST as a member of PUBLIC, and a newly created
  -- function is executable by PUBLIC until told otherwise -- which is easy to
  -- leave out and invisible when you do.

  perform tests.assert_eq('editing a list is not something anyone can do',
    (select bool_or(a::text like '=%')
       from pg_proc p, unnest(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.pronamespace = 'public'::regnamespace and p.proname = 'creator_edit_options'),
    false);
  perform tests.assert_eq('while an account can still correct its own poll',
    has_function_privilege('authenticated',
      'public.creator_edit_options(uuid, jsonb, uuid[])', 'execute'),
    true);
end $$;

rollback;

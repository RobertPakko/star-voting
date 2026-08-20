-- A poll can collect its own options before anyone votes.
--
-- The stage has one promise to keep, and it is the reason the rules live in
-- the database rather than the client: everyone who votes scores the same
-- list. That means no ballot while the list is still growing, and no growth
-- once the list has been finalized. Everything else here -- who may suggest,
-- who may finalize, and the two-option floor a list has to clear before it
-- can become a ballot -- exists to hold that promise up.

begin;

do $$
declare
  v_poll uuid;
  v_fixed uuid;
  v_open uuid;
  v_token text;
  v_scores jsonb;
begin
  perform tests.sign_in('creator@example.com');

  -- An invite poll that collects its options can be created with none at all.
  v_poll := create_poll('Lunch', null, array[]::text[],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false, null, true);

  perform tests.assert_eq('a soliciting poll can start with no options',
    (select count(*)::int from candidates where poll_id = v_poll), 0);
  perform tests.assert_eq('and reports itself as collecting',
    (select soliciting from poll_status(v_poll)), true);

  -- Everyone in the poll adds to the list through the same function, the
  -- creator included -- an invitee has no INSERT grant on candidates, so one
  -- path is the only way the rules can be stated once.
  perform suggest_option(v_poll, 'Pizza', 'From the place on the corner');
  perform tests.sign_in('voter1@example.com');
  perform suggest_option(v_poll, 'Sushi');

  perform tests.assert_eq('anyone in the poll can suggest an option',
    (select count(*)::int from candidates where poll_id = v_poll), 2);
  perform tests.assert_eq('and a suggestion carries its description',
    (select description from candidates where poll_id = v_poll and name = 'Pizza'),
    'From the place on the corner');

  perform tests.assert_raises('the same option cannot be suggested twice',
    format('select suggest_option(%L, %L)', v_poll, 'pizza'),
    'is already on the list');

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('somebody outside the poll cannot suggest at all',
    format('select suggest_option(%L, %L)', v_poll, 'Tacos'),
    'Poll not found');

  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 5))
  into v_scores from candidates where poll_id = v_poll;

  perform tests.sign_in('voter1@example.com');
  perform tests.assert_raises('nobody votes while the list is still growing',
    format('select submit_ballot(%L, %L::jsonb)', v_poll, v_scores),
    'still collecting options');
  perform tests.assert_raises('and nobody but the creator settles it',
    format('select finalize_options(%L)', v_poll),
    'Only the poll creator');

  perform tests.sign_in('creator@example.com');
  perform finalize_options(v_poll);

  perform tests.assert_eq('finalizing ends the collecting stage',
    (select soliciting from poll_status(v_poll)), false);
  perform tests.assert_raises('and closes the list for good',
    format('select suggest_option(%L, %L)', v_poll, 'Tacos'),
    'settled and voting has started');
  perform tests.assert_raises('so there is nothing left to finalize twice',
    format('select finalize_options(%L)', v_poll),
    'already been finalized');

  perform tests.sign_in('voter1@example.com');
  perform submit_ballot(v_poll, v_scores);
  perform tests.assert_eq('a finalized poll takes votes like any other',
    (select voted_count from poll_status(v_poll)), 1);

  -- The floor create_poll puts on a poll whose creator wrote the options is
  -- applied here instead, at the point the list becomes a ballot.
  perform tests.sign_in('creator@example.com');
  v_poll := create_poll('Dinner', null, array['Only one'],
                        array['voter1@example.com'],
                        'invite', true, false, null, true);

  perform tests.assert_eq('a soliciting poll may be seeded with options',
    (select count(*)::int from candidates where poll_id = v_poll), 1);
  perform tests.assert_raises('but one option is not a ballot',
    format('select finalize_options(%L)', v_poll),
    'at least two options');

  -- And a poll whose creator wrote the options is untouched by any of it.
  v_fixed := create_poll('Fixed', null, array['Apple', 'Banana'],
                         array['voter1@example.com'],
                         'invite', true, false);

  perform tests.assert_eq('an ordinary poll is not collecting anything',
    (select soliciting from poll_status(v_fixed)), false);
  perform tests.assert_raises('and takes no suggestions',
    format('select suggest_option(%L, %L)', v_fixed, 'Cherry'),
    'were set when it was created');
  perform tests.assert_raises('nor has it anything to finalize',
    format('select finalize_options(%L)', v_fixed),
    'were set when it was created');
  perform tests.assert_raises('while it still needs two options to exist',
    'select create_poll(''Dinner'', null, array[''Only one'']::text[],'
    || ' array[''voter1@example.com'']::text[], ''invite'', true, false)',
    'Add at least two options');

  -- ------------------------------------------------------------------
  -- The same stage on an open poll, reached through the share token.
  -- ------------------------------------------------------------------

  v_open := create_poll('Movie night', null, array[]::text[], array[]::text[],
                        'open', false, false, null, true);
  select public_token into v_token from polls where id = v_open;

  perform open_poll_suggest_option(v_token, 'Dune');
  perform open_poll_suggest_option(v_token, 'Arrival', 'the good one');

  perform tests.assert_eq('an open poll collects options through its link',
    (select count(*)::int from candidates where poll_id = v_open), 2);
  perform tests.assert_eq('and says so in the view its voters read',
    (open_poll_view(v_token) ->> 'soliciting')::boolean, true);
  perform tests.assert_raises('a suggestion is a label, not an essay',
    format('select open_poll_suggest_option(%L, %L)', v_token, repeat('x', 101)),
    'too long');

  select jsonb_agg(jsonb_build_object('candidate_id', id, 'score', 5))
  into v_scores from candidates where poll_id = v_open;

  perform tests.assert_raises('nobody votes in it until the list is settled',
    format('select open_poll_submit(%L, %L::jsonb, %L)', v_token, v_scores, 'voter-key-1'),
    'still collecting options');

  perform finalize_options(v_open);
  perform open_poll_submit(v_token, v_scores, 'voter-key-1');

  perform tests.assert_eq('then it votes like any other open poll',
    (open_poll_view(v_token) ->> 'voted_count')::int, 1);
  perform tests.assert_eq('and has stopped collecting',
    (open_poll_view(v_token) ->> 'soliciting')::boolean, false);
end $$;

rollback;

-- Collecting a list is drafted in the browser and applied in one press.
--
-- The card that collects a poll's options used to send every edit as it was
-- made: one request per option typed, per row corrected, per row struck out.
-- It now holds all three and applies them when the reader says they are done
-- adding -- which is the same thing the creator's *Done* has always meant on a
-- list that is already a ballot.
--
-- Nothing in the database changed for it. What changed is which functions the
-- browser leans on, and this is the case that says so, because each of them
-- was reachable before and none of them was carrying this:
--
--  * the **plural** suggestion doors, `suggest_options` and
--    `open_poll_suggest_options`, now carry a typed option's description --
--    they existed for a painted calendar, whose windows have names and nothing
--    else, so a description had only ever gone through the singular pair.
--  * `creator_edit_options` now applies the creator's pruning of a list that
--    is *still being collected*, removals included, where the browser used to
--    send a bare delete per row.
--
-- The rules those doors apply are the rules they already applied; see
-- 09_solicited_options for who may reach them and 14_creator_edits_options for
-- the floor. What is under test here is that the whole of one press goes
-- through them intact.

begin;

do $$
declare
  v_poll uuid;
  v_open uuid;
  v_pizza uuid;
  v_sushi uuid;
begin
  perform tests.sign_in('creator@example.com');

  v_poll := create_poll('Lunch', null, array[]::text[],
                        array['voter1@example.com', 'voter2@example.com'],
                        'invite', true, false, null, true);

  -- ------------------------------------------------------------------
  -- One press of *Confirm options*, from somebody who only adds
  -- ------------------------------------------------------------------
  --
  -- Which is every voter in the poll: correcting and removing are the
  -- creator's, so a voter's whole draft is the options they typed.

  perform tests.sign_in('voter1@example.com');
  perform tests.assert_eq('a voter''s whole draft goes in as one list',
    suggest_options(v_poll, jsonb_build_array(
      jsonb_build_object('name', 'Pizza', 'description', 'From the place on the corner'),
      jsonb_build_object('name', 'Sushi'),
      jsonb_build_object('name', 'Tacos', 'description', 'from the truck'))),
    3);
  perform tests.assert_eq('and every description with it',
    (select count(*)::int from candidates
      where poll_id = v_poll and description is not null), 2);
  perform tests.assert_eq('said as it was typed',
    (select description from candidates where poll_id = v_poll and name = 'Pizza'),
    'From the place on the corner');
  perform tests.assert_null('while an option with nothing to say says nothing',
    (select description from candidates where poll_id = v_poll and name = 'Sushi'));

  -- A name the list already holds is skipped rather than refused, which is
  -- the one rule the plural door adds over the singular one it replaced. It
  -- is the right rule for a press that means a whole list: the only way to
  -- reach it is for somebody else to have suggested the same name since this
  -- reader typed theirs, and there is nothing they could do about being told.
  perform tests.sign_in('voter2@example.com');
  perform tests.assert_eq('a name somebody else got to first is skipped, not refused',
    suggest_options(v_poll, jsonb_build_array(
      jsonb_build_object('name', 'pizza', 'description', 'a second opinion'),
      jsonb_build_object('name', 'Ramen'))),
    1);
  perform tests.assert_eq('so the list grew by the options it did not already hold',
    (select count(*)::int from candidates where poll_id = v_poll), 4);
  perform tests.assert_eq('and the option that was already there is untouched',
    (select description from candidates where poll_id = v_poll and name = 'Pizza'),
    'From the place on the corner');

  -- The field rules are insert_option's either way, so a draft with a bad
  -- option in it is refused whole -- there is no half of a press.
  perform tests.assert_raises('one bad option refuses the press it arrived in',
    format('select suggest_options(%L, %L::jsonb)', v_poll,
           jsonb_build_array(jsonb_build_object('name', 'Curry'),
                             jsonb_build_object('name', repeat('x', 151)))),
    'too long');
  perform tests.assert_eq('and takes the rest of it with it',
    (select count(*)::int from candidates where poll_id = v_poll and name = 'Curry'), 0);

  -- ------------------------------------------------------------------
  -- And one press from the creator, who prunes as well as adds
  -- ------------------------------------------------------------------

  perform tests.sign_in('creator@example.com');
  select id into v_pizza from candidates where poll_id = v_poll and name = 'Pizza';
  select id into v_sushi from candidates where poll_id = v_poll and name = 'Sushi';

  -- Pizza is removed and added back under the same name, which is the
  -- correction an update door into `candidates` would have been needed for
  -- and is not: the removals go in before the additions and in the same
  -- transaction, so the name is never briefly held twice.
  perform tests.assert_eq('the creator''s corrections and removals are one edit',
    creator_edit_options(v_poll,
      jsonb_build_array(jsonb_build_object('name', 'Pizza',
                                           'description', 'the good one')),
      array[v_pizza, v_sushi]),
    1);
  perform tests.assert_eq('the row struck out is gone',
    (select count(*)::int from candidates where poll_id = v_poll and name = 'Sushi'), 0);
  perform tests.assert_eq('the row corrected is still there',
    (select count(*)::int from candidates where poll_id = v_poll and name = 'Pizza'), 1);
  perform tests.assert_eq('saying what it was corrected to',
    (select description from candidates where poll_id = v_poll and name = 'Pizza'),
    'the good one');
  perform tests.assert_eq('and the list is what the press asked for',
    (select count(*)::int from candidates where poll_id = v_poll), 3);

  -- And the floor a live ballot has is not this list's: it arrives with
  -- finalize_options, when the list becomes a ballot. See
  -- 14_creator_edits_options.
  perform tests.assert_eq('a list still being collected has no floor to fall through',
    creator_edit_options(v_poll, '[]'::jsonb,
      (select array_agg(id) from candidates where poll_id = v_poll)),
    0);
  perform tests.assert_eq('so one press may empty it outright',
    (select count(*)::int from candidates where poll_id = v_poll), 0);

  -- ------------------------------------------------------------------
  -- The same press behind a share link
  -- ------------------------------------------------------------------

  v_open := create_poll('Movie night', null, array[]::text[], array[]::text[],
                        'open', false, false, null, true);

  perform tests.assert_eq('an open poll''s draft goes in through its link',
    open_poll_suggest_options(v_open, jsonb_build_array(
      jsonb_build_object('name', 'Dune'),
      jsonb_build_object('name', 'Arrival', 'description', 'the good one'))),
    2);
  perform tests.assert_eq('carrying the descriptions typed under the names',
    (select description from candidates where poll_id = v_open and name = 'Arrival'),
    'the good one');

  -- Which is the door anon reaches, unlike the creator's own: a share link
  -- carries no account, and the browser only ever asks creator_edit_options
  -- of a poll whose creator is signed in and reading it.
  perform tests.assert_eq('suggesting through a link is reachable without an account',
    has_function_privilege('anon',
      'public.open_poll_suggest_options(uuid, jsonb)', 'execute'),
    true);
  perform tests.assert_eq('while correcting the list is not',
    has_function_privilege('anon',
      'public.creator_edit_options(uuid, jsonb, uuid[])', 'execute'),
    false);
end $$;

rollback;

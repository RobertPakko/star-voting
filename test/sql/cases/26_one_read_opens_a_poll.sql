-- One read opens a poll, and says which reading the reader is entitled to.
--
-- poll_page() is a new door onto everything a poll page draws, so the case
-- for it is mostly a case about what it refuses. Three answers, and the whole
-- point is which reader gets which:
--
--   * `account`     -- the creator, or somebody on the invite list.
--   * `open`        -- an open poll, to anyone else holding its link.
--   * `unreadable`  -- everything else, said the same way for a poll that
--                      does not exist and one that is simply not yours.
--
-- The shapes matter as much as the tags. `open` must not carry a per-reader
-- mark: an open poll's ballots are identified by a voter_key minted per
-- question so they cannot be joined to each other, and a `voted` flag on the
-- group would join them on the server. That is asserted here as the absence
-- of the key rather than as a null, because a null is something a later
-- `coalesce` fills in.

begin;

do $$
declare
  v_poll uuid;
  v_questions uuid[];
  v_open uuid;
  v_page jsonb;
  v_q jsonb;
begin
  -- ---- the account reading -------------------------------------------------

  -- Two voters, both of whom have voted; seed_poll leaves the creator signed
  -- in.
  v_poll := tests.seed_poll(array['Apple', 'Banana'], array[[5, 4], [0, 1]]);

  v_page := poll_page(v_poll);
  perform tests.assert_eq('the creator gets the account reading',
    v_page ->> 'kind', 'account');
  perform tests.assert_eq('with the poll itself on it',
    v_page -> 'poll' ->> 'title', 'Test poll');
  perform tests.assert_eq('its options, in one request rather than a second',
    jsonb_array_length(v_page -> 'options'), 2);
  perform tests.assert_eq('and in the order they were written',
    v_page -> 'options' -> 0 ->> 'name', 'Apple');
  perform tests.assert_eq('the status the page is derived from',
    (v_page -> 'status' ->> 'voted_count')::int, 2);
  perform tests.assert_eq('a poll of one question has an empty group',
    v_page -> 'questions', '[]'::jsonb);
  perform tests.assert_null('and an invite poll has no open view to carry',
    v_page ->> 'view');

  -- An invitee reads the same poll the same way. They are not its creator,
  -- which is the other half of what polls_select allows.
  perform tests.sign_in('voter1@example.com');
  v_page := poll_page(v_poll);
  perform tests.assert_eq('an invited voter gets it too',
    v_page ->> 'kind', 'account');
  perform tests.assert_eq('and their own ballot is on the status',
    (v_page -> 'status' ->> 'voted')::boolean, true);

  -- ---- the closed door -----------------------------------------------------

  perform tests.sign_in('stranger@example.com');
  perform tests.assert_eq('somebody outside an invite poll is told nothing',
    poll_page(v_poll) ->> 'kind', 'unreadable');

  -- The same word for a poll that was never there. These two assertions are
  -- the point of the third tag: an account that could tell them apart could
  -- ask this function whether any given id is a poll.
  perform tests.assert_eq('and a poll that does not exist is refused the same way',
    poll_page(gen_random_uuid()) ->> 'kind', 'unreadable');

  -- Signed out entirely, which is what the anon role reaches this with.
  update auth._session set user_id = null, email = null where id;
  perform tests.assert_eq('a signed-out reader is refused an invite poll',
    poll_page(v_poll) ->> 'kind', 'unreadable');

  -- ---- the open reading ----------------------------------------------------

  v_questions := tests.seed_group(
    array[
      row('Where should we eat?', array['Pizza', 'Salad', 'Curry'])::tests.question,
      row('What time?',           array['Noon', 'One'])::tests.question
    ],
    array[]::text[], 'Team lunch', 'open');
  v_open := v_questions[1];

  -- Its creator is inside it, so they get the account reading -- and on an
  -- open poll that reading carries the open view as well, because the panel
  -- they manage the poll through is the one everybody else votes in.
  v_page := poll_page(v_open);
  perform tests.assert_eq('the creator of an open poll still reads it as an account',
    v_page ->> 'kind', 'account');
  perform tests.assert_eq('and the open view comes with it, not behind it',
    v_page -> 'view' -> 'poll' ->> 'title', 'Team lunch');
  perform tests.assert_eq('their group carries the marks an account can be told',
    (v_page -> 'questions' -> 0 ->> 'option_count')::int, 3);

  -- Anybody else holding the link.
  update auth._session set user_id = null, email = null where id;
  v_page := poll_page(v_open);
  perform tests.assert_eq('a stranger holding the link gets the open reading',
    v_page ->> 'kind', 'open');
  perform tests.assert_eq('which is the poll, curated',
    v_page -> 'view' -> 'poll' ->> 'title', 'Team lunch');
  perform tests.assert_eq('and the strip, in the same request',
    jsonb_array_length(v_page -> 'questions'), 2);
  perform tests.assert_eq('naming the questions in order',
    v_page -> 'questions' -> 1 ->> 'question_title', 'What time?');

  -- The part this door could quietly get wrong.
  v_q := v_page -> 'questions' -> 0;
  perform tests.assert_eq('the open group says nothing about who has answered',
    v_q ? 'voted', false);
  perform tests.assert_eq('nor about who has finished adding options',
    v_q ? 'confirmed', false);
  perform tests.assert_eq('nor how many options a question holds',
    v_q ? 'option_count', false);
  perform tests.assert_eq('it says only which questions there are',
    (select array_agg(k order by k) from jsonb_object_keys(v_q) k),
    array['id', 'question_position', 'question_title']);

  -- And the boundary 15_share_link_names_no_email draws around
  -- open_poll_view, redrawn here because this is a second way to reach it.
  perform tests.assert_null('the open reading names no email address',
    v_page -> 'view' -> 'poll' ->> 'created_by_email');

  -- ---- the voter key travels with it ---------------------------------------

  -- The key is the whole reason "your vote is in" can be said to somebody
  -- with no account, and it had to survive being passed one function deeper.
  perform open_poll_submit(v_open, tests.open_scores(v_open, array[5, 3, 0]), 'key-one', 'Robin');

  perform tests.assert_eq('the key that cast the ballot is handed it back',
    (poll_page(v_open, 'key-one') -> 'view' ->> 'voted')::boolean, true);
  perform tests.assert_eq('another browser is told only that somebody voted',
    (poll_page(v_open, 'key-two') -> 'view' ->> 'voted')::boolean, false);
  perform tests.assert_eq('and asking with no key at all is the same answer',
    (poll_page(v_open) -> 'view' ->> 'voted')::boolean, false);

  -- The count is the poll's, not the reader's, so it is said either way.
  perform tests.assert_eq('while the vote itself is counted for everyone',
    (poll_page(v_open, 'key-two') -> 'view' ->> 'voted_count')::int, 1);

  -- ---- a question of the group is reached the same way ---------------------

  -- Every question of a poll is a poll, so the second one answers for itself
  -- and returns the same group: that is what makes crossing between them free.
  v_page := poll_page(v_questions[2]);
  perform tests.assert_eq('the second question is readable in its own right',
    v_page ->> 'kind', 'open');
  perform tests.assert_eq('and answers with the whole strip, not its own row',
    jsonb_array_length(v_page -> 'questions'), 2);
end $$;

rollback;

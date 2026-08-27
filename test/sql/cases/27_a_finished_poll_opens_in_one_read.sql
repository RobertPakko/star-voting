-- A finished poll opens in one read.
--
-- 0048 made `poll_page` answer what the route asks. 0050 makes it answer what
-- the page then draws: the tally and the invitee roster used to be two
-- requests fired the moment their cards mounted, which could not happen until
-- `poll_page` had come back, so a completed poll cost two round trips where
-- one would do.
--
-- What this case is really about is the *conditions*, because both fields are
-- a handoff rather than a new door. Each rides along on exactly the polls
-- whose page will draw it and is null everywhere else, and null means "not
-- carried, ask for yourself" rather than "there is none" -- so the thing that
-- would actually hurt is a field arriving where its card is not drawn, or
-- STAR running on a poll nobody may read the result of yet.

begin;

do $$
declare
  v_poll uuid;
  v_pending uuid;
  v_hidden uuid;
  v_open uuid;
  v_page jsonb;
begin
  -- ---- a finished invite poll ----------------------------------------------

  -- Two invitees, both of whom have voted, which is what unlocks an invite
  -- poll's results without anybody closing it.
  v_poll := tests.seed_poll(array['Apple', 'Banana'], array[[5, 1], [4, 0]]);

  v_page := poll_page(v_poll);
  perform tests.assert_eq('the poll reads as an account',
    v_page ->> 'kind', 'account');
  perform tests.assert_eq('and its results are out',
    (v_page -> 'status' ->> 'results_available')::boolean, true);
  perform tests.assert_eq('so the tally comes with the page, not behind it',
    tests.winner(v_page -> 'results'), 'Apple');
  perform tests.assert_eq('carrying the score round the page draws',
    tests.total_score(v_page -> 'results', 'Apple'), 9);
  perform tests.assert_eq('and the runoff under it',
    tests.prefers(v_page -> 'results', 'Apple'), 2);

  perform tests.assert_eq('the roster comes with it too',
    jsonb_array_length(v_page -> 'invitees'), 2);
  perform tests.assert_eq('in the order the card draws them',
    v_page -> 'invitees' -> 0 ->> 'email', 'voter1@example.com');
  perform tests.assert_eq('saying who has voted',
    (v_page -> 'invitees' -> 0 ->> 'has_voted')::boolean, true);

  -- Not the creator's privilege: an invitee draws both cards and is handed
  -- both, which is the same page seen from the other side of the invite list.
  perform tests.sign_in('voter1@example.com');
  v_page := poll_page(v_poll);
  perform tests.assert_eq('an invited voter is handed the same tally',
    tests.winner(v_page -> 'results'), 'Apple');
  perform tests.assert_eq('and the same roster',
    jsonb_array_length(v_page -> 'invitees'), 2);

  -- ---- a poll that is not finished -----------------------------------------

  -- The condition that matters most, because getting it wrong would run STAR
  -- on every read of every poll -- and would hand a tally to somebody the
  -- database is deliberately keeping it from until the last vote is in.
  perform tests.sign_in('creator@example.com');
  v_pending := create_poll('Still voting', null, array['Pizza', 'Salad'],
                           array['one@example.com', 'two@example.com'], 'invite', true, false);

  perform tests.sign_in('one@example.com');
  perform tests.cast_ballot(v_pending, array[5, 0]);

  perform tests.sign_in('creator@example.com');
  v_page := poll_page(v_pending);
  perform tests.assert_eq('a poll still waiting on a vote says so',
    (v_page -> 'status' ->> 'results_available')::boolean, false);
  perform tests.assert_null('and no tally is run for it',
    v_page ->> 'results');
  -- The roster is not a stage question: it is the invite list, and it is what
  -- the creator is looking at while they wait.
  perform tests.assert_eq('while the roster is carried at every stage',
    jsonb_array_length(v_page -> 'invitees'), 2);
  perform tests.assert_eq('marking the vote that is in',
    (v_page -> 'invitees' -> 0 ->> 'has_voted')::boolean, true);
  perform tests.assert_eq('and the one that is not',
    (v_page -> 'invitees' -> 1 ->> 'has_voted')::boolean, false);

  -- ---- a poll that hides its respondents -----------------------------------

  perform tests.sign_in('creator@example.com');
  v_hidden := create_poll('Hidden', null, array['Here', 'There'],
                          array['one@example.com', 'two@example.com'], 'invite', false, false);

  v_page := poll_page(v_hidden);
  perform tests.assert_eq('its creator still gets the invite list they manage',
    jsonb_array_length(v_page -> 'invitees'), 2);
  -- poll_invitees decides this, not the branch that calls it: a poll that
  -- hides its respondents nulls the per-person columns for everybody, its
  -- creator included, and calling the function rather than copying it is what
  -- keeps that true here.
  perform tests.assert_eq('with nothing said about who has voted',
    v_page -> 'invitees' -> 0 -> 'has_voted', 'null'::jsonb);

  perform tests.sign_in('one@example.com');
  v_page := poll_page(v_hidden);
  perform tests.assert_eq('an invitee reads the poll as an account',
    v_page ->> 'kind', 'account');
  perform tests.assert_null('and is carried no roster, because they draw none',
    v_page ->> 'invitees');

  -- ---- an open poll --------------------------------------------------------

  perform tests.sign_in('creator@example.com');
  v_open := create_poll('Team lunch', null, array['Pizza', 'Salad'],
                        array[]::text[], 'open', true, false);

  perform tests.assert_null('an open poll has no invitee list to carry',
    poll_page(v_open) ->> 'invitees');

  -- Somebody holding the link, before the poll is closed. An open poll
  -- reveals only on close, so this is the read that must not carry a tally.
  update auth._session set user_id = null, email = null where id;
  perform open_poll_submit(v_open, tests.open_scores(v_open, array[5, 1]), 'key-one', 'Robin');

  v_page := poll_page(v_open);
  perform tests.assert_eq('a stranger holding the link gets the open reading',
    v_page ->> 'kind', 'open');
  perform tests.assert_eq('which is still taking votes',
    (v_page -> 'view' ->> 'results_available')::boolean, false);
  perform tests.assert_null('so it carries no tally either',
    v_page ->> 'results');
  perform tests.assert_null('and never a roster: an open poll has no list',
    v_page ->> 'invitees');

  perform tests.sign_in('creator@example.com');
  perform close_poll(v_open);

  v_page := poll_page(v_open);
  perform tests.assert_eq('closed, its creator reads the tally off the account branch',
    tests.winner(v_page -> 'results'), 'Pizza');

  update auth._session set user_id = null, email = null where id;
  v_page := poll_page(v_open);
  perform tests.assert_eq('and a stranger off the open branch',
    v_page ->> 'kind', 'open');
  perform tests.assert_eq('the same tally, through the door they actually have',
    tests.winner(v_page -> 'results'), 'Pizza');
  perform tests.assert_null('with still no roster on it',
    v_page ->> 'invitees');

  -- ---- and nothing at all to a reader who is refused -----------------------

  -- Belt and braces on the tag that exists to say nothing: an invite poll
  -- whose results are out is exactly the poll somebody outside it would most
  -- like a tally of.
  perform tests.sign_in('stranger@example.com');
  v_page := poll_page(v_poll);
  perform tests.assert_eq('an outsider is refused the finished invite poll',
    v_page ->> 'kind', 'unreadable');
  perform tests.assert_null('with no tally on the refusal',
    v_page ->> 'results');
  perform tests.assert_null('and no roster',
    v_page ->> 'invitees');
end $$;

rollback;

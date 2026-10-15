-- Your own private ballot, and whether you removed the poll, come with the page.
--
-- 0083 puts on `poll_page` the two things a poll page used to ask for
-- separately once it had opened: `your_scores`, which the card under a
-- finished invite poll's tally read through `poll_ballot_scores`, and
-- `removed`, which the card after voting read through `poll_is_removed`.
--
-- Like the tally and the roster before them, they are a handoff rather than a
-- new door, so this case is mostly about the conditions. `your_scores` is the
-- caller's own ballot and nobody else's, carried on exactly the polls whose
-- page draws that card and null everywhere else; `removed` is the caller's
-- own row, on both readings.

begin;

do $$
declare
  v_poll uuid;
  v_published uuid;
  v_pending uuid;
  v_open uuid;
  v_page jsonb;
  v_apple text;
  v_banana text;
begin
  -- ---- a finished invite poll that keeps its ballots private ---------------

  -- seed_poll's polls show their respondents and do not publish ballots, and
  -- both invitees voting is what unlocks the results.
  v_poll := tests.seed_poll(array['Apple', 'Banana'], array[[5, 1], [4, 0]]);
  select id::text into v_apple from candidates where poll_id = v_poll and name = 'Apple';
  select id::text into v_banana from candidates where poll_id = v_poll and name = 'Banana';

  perform tests.sign_in('voter1@example.com');
  v_page := poll_page(v_poll);
  perform tests.assert_eq('the results are out',
    (v_page -> 'status' ->> 'results_available')::boolean, true);
  perform tests.assert_eq('so the voter''s own ballot comes with the page',
    (v_page -> 'your_scores' ->> v_apple)::int, 5);
  perform tests.assert_eq('every score of it',
    (v_page -> 'your_scores' ->> v_banana)::int, 1);
  perform tests.assert_eq('the same answer the card used to ask for by itself',
    v_page -> 'your_scores', poll_ballot_scores(v_poll));

  perform tests.sign_in('voter2@example.com');
  perform tests.assert_eq('each voter is handed their own and nobody else''s',
    (poll_page(v_poll) -> 'your_scores' ->> v_apple)::int, 4);

  -- The creator did not invite themselves, so has no ballot to hand back --
  -- and poll_ballot_scores raises for that rather than answering empty, which
  -- is why the gate asks first rather than calling it and seeing.
  perform tests.sign_in('creator@example.com');
  v_page := poll_page(v_poll);
  perform tests.assert_eq('the creator reads the finished poll',
    v_page ->> 'kind', 'account');
  perform tests.assert_null('and is handed no ballot, having cast none',
    v_page ->> 'your_scores');

  -- ---- a poll that publishes its ballots ------------------------------------

  -- The reader's row is already on the sheet the page draws instead.
  v_published := create_poll('Published', null, array['Pizza', 'Salad'],
                             array['one@example.com'], 'invite', true, true);
  perform tests.sign_in('one@example.com');
  perform tests.cast_ballot(v_published, array[5, 0]);

  v_page := poll_page(v_published);
  perform tests.assert_eq('a published poll whose results are out',
    (v_page -> 'status' ->> 'results_available')::boolean, true);
  perform tests.assert_eq('carries the sheet',
    jsonb_array_length(v_page -> 'ballots' -> 'ballots'), 1);
  perform tests.assert_null('and not a second copy of the reader''s row',
    v_page ->> 'your_scores');

  -- ---- a poll still taking votes ---------------------------------------------

  -- Edit vote reads the ballot fresh on the press, on purpose; the page does
  -- not carry it while it can still change.
  perform tests.sign_in('creator@example.com');
  v_pending := create_poll('Still voting', null, array['Pizza', 'Salad'],
                           array['one@example.com', 'two@example.com'], 'invite', true, false);
  perform tests.sign_in('one@example.com');
  perform tests.cast_ballot(v_pending, array[5, 0]);

  v_page := poll_page(v_pending);
  perform tests.assert_eq('a poll still waiting on a vote',
    (v_page -> 'status' ->> 'results_available')::boolean, false);
  perform tests.assert_null('carries no ballot, though this reader has cast one',
    v_page ->> 'your_scores');

  -- ---- removed from the list -------------------------------------------------

  perform tests.sign_in('voter1@example.com');
  perform tests.assert_eq('a poll on the list says it is not removed',
    (poll_page(v_poll) ->> 'removed')::boolean, false);
  perform remove_polls(array[v_poll]);
  perform tests.assert_eq('and says so once it is',
    (poll_page(v_poll) ->> 'removed')::boolean, true);

  perform tests.sign_in('voter2@example.com');
  perform tests.assert_eq('which is the reader''s alone',
    (poll_page(v_poll) ->> 'removed')::boolean, false);

  perform tests.sign_in('voter1@example.com');
  perform restore_polls(array[v_poll]);
  perform tests.assert_eq('and restoring it takes that back',
    (poll_page(v_poll) ->> 'removed')::boolean, false);

  -- ---- an open poll, through its link -----------------------------------------

  perform tests.sign_in('creator@example.com');
  v_open := create_poll('Team lunch', null, array['Pizza', 'Salad'],
                        array[]::text[], 'open', true, false);

  perform tests.sign_out();
  v_page := poll_page(v_open);
  perform tests.assert_eq('a stranger holding the link reads the open branch',
    v_page ->> 'kind', 'open');
  perform tests.assert_eq('which says nothing is removed, with nobody to have removed it',
    (v_page ->> 'removed')::boolean, false);
  perform tests.assert_eq('and carries no ballot of the account kind',
    v_page ? 'your_scores', false);

  -- An account that answers through the link has the poll on its list, and so
  -- can take it off again.
  perform tests.sign_in('linkvoter@example.com');
  perform open_poll_submit(v_open, tests.open_scores(v_open, array[5, 1]), 'key-one', 'Robin');
  perform tests.assert_eq('a signed-in voter through the link starts with it on their list',
    (poll_page(v_open, 'key-one') ->> 'removed')::boolean, false);
  perform remove_polls(array[v_open]);
  v_page := poll_page(v_open, 'key-one');
  perform tests.assert_eq('still the open branch once they remove it',
    v_page ->> 'kind', 'open');
  perform tests.assert_eq('which now says it is removed',
    (v_page ->> 'removed')::boolean, true);
end $$;

rollback;

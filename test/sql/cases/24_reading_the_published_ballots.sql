-- Published ballots are read on the poll's terms, not on the reader's route.
--
-- A poll that publishes its ballots hands every one of them back as a grid
-- once the results unlock, which is what makes the tally checkable rather
-- than something to be trusted. There are two functions that do it --
-- `poll_ballots` for an account, `open_poll_ballots` for a link -- and the
-- rules they apply have to be the same rules, because they are the same
-- promise made to the same voters.
--
-- `poll_ballots` used to refuse an open poll outright, which read like a rule
-- and was not one: the only account that can reach an open poll through it is
-- the creator's, `show_ballots` and the reveal gate were already deciding
-- everything, and the creator's own poll page asked anyway and drew the
-- refusal in red under the grid the panel above it had just shown. What is
-- asserted here is what is left once that is gone -- that the two doors open
-- onto the same sheet, and that none of the gates around them moved.

begin;

do $$
declare
  v_open uuid;
  v_private uuid;
  v_invite uuid;
begin
  perform tests.sign_in('creator@example.com');

  -- ------------------------------------------------------------------
  -- An open poll, whose creator is the one person who can reach it as an
  -- account at all.
  -- ------------------------------------------------------------------

  v_open := create_poll('Movie night', null, array['Dune', 'Arrival'],
                        array[]::text[], 'open', true, true);
  perform open_poll_submit(v_open, tests.open_scores(v_open, array[5, 1]),
                           'voter-key-1', 'Robin');

  -- The wording matters as much as the refusal. An open poll has no invite
  -- list to be waiting on; it is closed by hand, which is what it is waiting
  -- for and what the sentence has to say.
  perform tests.assert_raises('an open poll''s ballots wait for it to be closed',
    format('select poll_ballots(%L)', v_open),
    'until the poll is closed');

  perform close_poll(v_open);

  perform tests.assert_eq('and then both doors open onto the same sheet',
    poll_ballots(v_open), open_poll_ballots(v_open));
  perform tests.assert_eq('which names the voter, because the poll shows its voters',
    poll_ballots(v_open) -> 'ballots' -> 0 ->> 'voter', 'Robin');

  -- The visibility test in front of all of this is untouched, and it is the
  -- one that was ever doing the work: an account that is not in the poll is
  -- not told whether the id is a real poll.
  perform tests.sign_in('stranger@example.com');
  perform tests.assert_raises('an account outside the poll learns nothing through this door',
    format('select poll_ballots(%L)', v_open),
    'Poll not found');
  perform tests.assert_eq('while the link, which is an open poll''s whole access rule, answers',
    jsonb_array_length(open_poll_ballots(v_open) -> 'ballots'), 1);

  -- ------------------------------------------------------------------
  -- And the creator still gets no exception to the setting itself.
  -- ------------------------------------------------------------------

  perform tests.sign_in('creator@example.com');
  v_private := create_poll('Quiet', null, array['Yes', 'No'],
                           array[]::text[], 'open', true, false);
  perform open_poll_submit(v_private, tests.open_scores(v_private, array[5, 0]),
                           'voter-key-1', 'Robin');
  perform close_poll(v_private);

  perform tests.assert_raises('a poll that does not publish its ballots refuses its creator',
    format('select poll_ballots(%L)', v_private),
    'does not publish individual ballots');

  -- ------------------------------------------------------------------
  -- An invite poll, which unlocks on the other of the two terms: the last
  -- person on the list voting, rather than the creator closing it.
  -- ------------------------------------------------------------------

  v_invite := create_poll('Lunch', null, array['Pizza', 'Sushi'],
                          array['voter1@example.com', 'voter2@example.com'],
                          'invite', true, true);

  perform tests.sign_in('voter1@example.com');
  perform tests.cast_ballot(v_invite, array[5, 0]);

  perform tests.assert_raises('an invite poll still waits for everyone on its list',
    format('select poll_ballots(%L)', v_invite),
    'until everyone has voted');

  perform tests.sign_in('voter2@example.com');
  perform tests.cast_ballot(v_invite, array[0, 5]);

  perform tests.assert_eq('and hands back one row per voter once they have',
    jsonb_array_length(poll_ballots(v_invite) -> 'ballots'), 2);
  perform tests.assert_eq('to a voter in the poll, not only to its creator',
    poll_ballots(v_invite) ->> 'voters_named', 'true');
end $$;

rollback;
